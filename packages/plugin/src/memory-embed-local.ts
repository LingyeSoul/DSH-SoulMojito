/**
 * 本地 ONNX embed 运行时（提案 0017）：transformers.js
 * （@huggingface/transformers）feature-extraction 管线，Node 下经
 * onnxruntime-node 原生执行（transformers.js 在 Node 环境硬绑该后端，
 * onnx.js 源码：IS_NODE_ENV ⇒ ONNX = ONNX_NODE）。执行后端只此一条——
 * onnxruntime-web（WASM）路线已评估并否决（2026-10-12 用户决策：Node 内
 * WASM 后端需绕开 transformers.js 会话层自维护胶水，复杂度不划算；证据与
 * 否决理由留档提案 0017 §否决项）。
 *
 * 零打包依赖：@huggingface/transformers 不随插件 bundle、也不静态 import，
 * 运行时从「本 bundle 真实位置 → 宿主安装锚」链解析后按 URL 动态 import
 * （compaction curator 的 importHostPackage 同款纪律；这里多了更优先的锚：
 * profile 物理安装下 bundle 位于 `<profile>/node_modules/dsh-tavern/*.mjs`，
 * 从它 parent 解析才能命中用户装在 profile 根 node_modules 里的运行时——
 * 宿主锚 process.argv[1] 只覆盖宿主自带包）。运行时未安装 ⇒ 明确报错（含
 * 安装指引），熔断/降级矩阵照常兜底。
 *
 * 跨 bundle 注意：与 memory-embed.ts 的模块级状态同理，本模块被 index.mjs 与
 * agent.mjs 各内联一份——模型会话缓存按 bundle 各自生效（最坏代价是同进程内
 * 同一模型被加载两份内存，可接受；状态一致性仍由 status.json sidecar 承担）。
 *
 * 离线纪律：env.allowRemoteModels=false——tokenizer/权重只从本地目录加载，
 * 插件永不替用户发起模型下载（网络面保持提案 0016 的「用户自配端点之外零
 * 网络」约束）。
 *
 * 向量空间身份：localModelIdentity = `local-onnx:<basename>@<指纹>:<池化>:<精度>`，
 * 指纹是模型目录两层文件清单（名/大小/mtime）的 SHA-256 前 16 位，精度是
 * resolveLocalDtype 的解析结果（auto 落具体档）——模型文件被替换或换池化/换
 * 精度档 ⇒ 身份变化 ⇒ 与已存向量的 model/digest 不匹配 ⇒ stale ⇒ 懒重嵌
 * （与换远程 model 同款收敛语义，无需用户手动清缓存）。
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importHostPackage } from '../../bind/src/index.js'
import type { LocalEmbedPrecision, MemoryEmbeddingLocalSettings } from '../../tavern-store/src/index.js'

/** 本地 embed 运行时包名（pnpm add 的目标；其依赖自带 onnxruntime-node）。 */
export const TRANSFORMERS_PACKAGE = '@huggingface/transformers'

/** 未安装时的安装指引（报错文案与 README 同源语义，勿单边漂移）。特别强调
 *  「不是插件源码仓库」——2026-10-12 实况：用户按提示在源码仓库根执行了
 *  pnpm add，污染 lockfile/node_modules 并触发 pnpm allowBuilds 改写。 */
export const TRANSFORMERS_INSTALL_HINT =
  `local ONNX embed requires '${TRANSFORMERS_PACKAGE}' (not bundled with the plugin):`
  + ` run "pnpm add ${TRANSFORMERS_PACKAGE}" in the DSH profile root`
  + ` (the directory whose node_modules contains the installed dsh-tavern,`
  + ` NOT the dsh-tavern source repository), then restart DSH`

/** 模型会话缓存上限（同进程常驻一个模型是常态；第二个容忍并发切换窗口）。 */
const SESSION_CACHE_LIMIT = 2

/** 已加载的本地嵌入模型（会话缓存条目）。 */
export interface LocalEmbedModel {
  embed(texts: readonly string[]): Promise<number[][]>
}

/** 运行时注入口（测试用假运行时替换真实 transformers.js 栈）。 */
export interface LocalEmbedRuntime {
  load(modelDir: string, options?: { pooling?: 'cls' | 'mean'; dtype?: string }): Promise<LocalEmbedModel>
}

/* --------------------------- 目录指纹与身份 --------------------------- */

/**
 * 模型目录指纹：顶层 + 一层子目录（HF onnx 布局的 onnx/）文件清单
 * `相对路径:大小:mtimeMs` 排序拼接后 SHA-256 前 16 位。目录不可读 ⇒
 * 'unreadable'（身份恒变 ⇒ 向量恒 stale ⇒ 回填失败走熔断，与目录缺失同款降级）。
 * 只用 stat 不读内容：几十 MB 的模型文件不做全量哈希，mtime 粒度噪声的代价
 * 仅是一次多余重嵌。
 */
export function localModelFingerprint(modelDir: string): string {
  try {
    const parts: string[] = []
    for (const entry of readdirSync(modelDir).sort()) {
      const full = join(modelDir, entry)
      const info = statSync(full)
      if (info.isFile()) {
        parts.push(`${entry}:${info.size}:${Math.round(info.mtimeMs)}`)
      } else if (info.isDirectory()) {
        for (const child of readdirSync(full).sort()) {
          const childInfo = statSync(join(full, child))
          if (childInfo.isFile()) parts.push(`${entry}/${child}:${childInfo.size}:${Math.round(childInfo.mtimeMs)}`)
        }
      }
    }
    if (parts.length === 0) return 'unreadable'
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
  } catch {
    return 'unreadable'
  }
}

/** 本地形态的向量空间身份（digest/model 字段共用，见文件头）。pooling 与量化
 *  精度都必须进身份：cls/mean、fp16/q8 各是不同的向量空间（不同量化档的权重
 *  数值不同、嵌入随之偏移），换档不换身份会把旧档存量向量误判为新鲜、与新查询
 *  向量混空间排序。精度段是 resolveLocalDtype 的解析结果——auto 也落具体档，
 *  未检出（链式兜底路径）时为 'auto'。 */
export function localModelIdentity(config: Pick<MemoryEmbeddingLocalSettings, 'modelDir' | 'pooling' | 'precision'>): string {
  return `local-onnx:${basename(config.modelDir)}@${localModelFingerprint(config.modelDir)}:${config.pooling ?? 'cls'}:${resolveLocalDtype(config) ?? 'auto'}`
}

/* ------------------------ 量化精度识别与解析 ------------------------ */

/** 目录里检出的量化档位（面板下拉选项与检测端点共用形状）。 */
export interface LocalQuantizationInfo {
  precision: Exclude<LocalEmbedPrecision, 'auto'>
  /** 权重文件相对 modelDir 的路径（onnx/model_fp16.onnx 形态）。 */
  file: string
  sizeBytes: number
}

/**
 * dtype → 文件后缀，镜像 transformers.js 4.x 的 DEFAULT_DTYPE_SUFFIX_MAPPING
 * （源码级核对：用户实装 4.3.1 src/utils/dtypes.js——q8 是 '_quantized'、fp32
 * 无后缀；bnb4 排除，见 LocalEmbedPrecision 注释）。文件名 = `model${后缀}.onnx`，
 * 只在 onnx/ 子目录（modeling_utils.js from_pretrained 的 subfolder 恒 'onnx'，
 * 顶层散装 .onnx 运行时不读）。
 */
const DTYPE_FILE_SUFFIXES: ReadonlyArray<readonly [Exclude<LocalEmbedPrecision, 'auto'>, string]> = [
  ['fp32', ''],
  ['fp16', '_fp16'],
  ['q8', '_quantized'],
  ['int8', '_int8'],
  ['uint8', '_uint8'],
  ['q4', '_q4'],
  ['q4f16', '_q4f16'],
  ['q2', '_q2'],
  ['q2f16', '_q2f16'],
  ['q1', '_q1'],
  ['q1f16', '_q1f16'],
]

/** auto 档的优先链（2026-10-12 用户决策默认 FP16 的延伸）：精度损失小的在
 *  前，fp32 兜底（质量最高但体积/内存翻倍）。exotic 尾部（q2/q1 系）排在
 *  fp32 前——用户放了极端量化文件意图明确是省资源。 */
export const AUTO_DTYPE_PRIORITY: readonly string[] = ['fp16', 'q8', 'q4', 'q4f16', 'int8', 'uint8', 'q2', 'q2f16', 'q1', 'q1f16', 'fp32']

/**
 * 扫描模型目录识别可用的量化档位（2026-10-13 需求：本地模型智能识别量化精度）：
 * 只认 onnx/ 子目录下的 `model${后缀}.onnx`（运行时实际读取的布局，见
 * DTYPE_FILE_SUFFIXES 注释），返回按 AUTO_DTYPE_PRIORITY 排序、含文件大小供
 * 面板下拉展示。目录不可读 / 无 onnx 子目录 / 无匹配文件 ⇒ []（调用方回落）。
 */
export function detectLocalQuantizations(modelDir: string): LocalQuantizationInfo[] {
  let names: string[]
  try {
    names = readdirSync(join(modelDir, 'onnx'))
  } catch {
    return []
  }
  const found: LocalQuantizationInfo[] = []
  for (const [dtype, suffix] of DTYPE_FILE_SUFFIXES) {
    const file = `onnx/model${suffix}.onnx`
    try {
      const info = statSync(join(modelDir, file))
      if (info.isFile()) found.push({ precision: dtype, file, sizeBytes: info.size })
    } catch {
      // 该档位文件不存在 ⇒ 跳过。
    }
  }
  return found.sort((a, b) => AUTO_DTYPE_PRIORITY.indexOf(a.precision) - AUTO_DTYPE_PRIORITY.indexOf(b.precision))
}

/**
 * 把配置里的 precision 解析成单档 dtype：显式值（非 'auto'）原样返回——用户钉
 * 死的档位不猜不改，文件缺失让加载如实报错；'auto'/缺省按目录识别取优先链
 * 最高档；目录检不出任何档位返回 undefined（调用方保留旧的逐档 try 链兜底，
 * 覆盖扫描面之外的非标准布局）。
 */
export function resolveLocalDtype(config: Pick<MemoryEmbeddingLocalSettings, 'modelDir' | 'precision'>): Exclude<LocalEmbedPrecision, 'auto'> | undefined {
  if (config.precision !== undefined && config.precision !== 'auto') return config.precision
  return detectLocalQuantizations(config.modelDir)[0]?.precision
}

/** 自动推断结果（PUT 缺省补全用；sources 记录每项来源供面板提示）。 */
export interface InferredLocalSettings {
  dims?: number
  pooling?: 'cls' | 'mean'
  sources: { dims?: string; pooling?: string }
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 从模型目录自动推断小白项（提案 0017 §自动填充）：
 * - dims：config.json 的 hidden_size（BERT/bge/e5/gte/MiniLM 家族输出维度即
 *   hidden size；1..8192 夹取）。读不到就不填——首次探针成功仍会记录 dims
 *   基准（status sidecar），功能不依赖此推断。
 * - pooling 优先级：① sentence-transformers 官方导出的 modules.json（Pooling
 *   模块的 pooling_mode_cls/mean 旗标，权威）② config.json 的 pooling 字段
 *   （少见约定）③ 模型族启发（目录名 + _name_or_path：bge/bert → cls；
 *   minilm/mpnet/e5/gte/gtr/sentence-t5 → mean）④ 兜底 cls（BERT 家族标准，
 *   推荐模型 bge-small-zh 即 cls）。启发只影响默认值，面板/PUT 仍可显式覆盖。
 */
export function inferLocalModelSettings(modelDir: string): InferredLocalSettings {
  const result: InferredLocalSettings = { sources: {} }
  const config = readJsonFile(join(modelDir, 'config.json'))
  const configRecord = config !== null && typeof config === 'object' && !Array.isArray(config)
    ? config as Record<string, unknown>
    : undefined

  const hiddenSize = configRecord?.hidden_size
  if (typeof hiddenSize === 'number' && Number.isFinite(hiddenSize)) {
    result.dims = Math.max(1, Math.min(8192, Math.round(hiddenSize)))
    result.sources.dims = 'config.json hidden_size'
  }

  // ① sentence-transformers modules.json：[[..., 'Pooling', {flags}], ...]
  const modules = readJsonFile(join(modelDir, 'modules.json'))
  if (Array.isArray(modules)) {
    for (const entry of modules) {
      if (!Array.isArray(entry) || entry[0] !== 'sentence-transformers' || entry[1] !== 'Pooling') continue
      const flags = entry[2]
      if (flags !== null && typeof flags === 'object' && !Array.isArray(flags)) {
        const record = flags as Record<string, unknown>
        if (record.pooling_mode_cls === true) {
          result.pooling = 'cls'
          result.sources.pooling = 'modules.json'
        } else if (record.pooling_mode_mean === true) {
          result.pooling = 'mean'
          result.sources.pooling = 'modules.json'
        }
      }
      break
    }
  }
  // ② config.json pooling 字段（少见但零成本）。
  if (result.pooling === undefined && (configRecord?.pooling === 'cls' || configRecord?.pooling === 'mean')) {
    result.pooling = configRecord.pooling
    result.sources.pooling = 'config.json pooling'
  }
  // ③ 模型族启发：目录名 + _name_or_path。
  if (result.pooling === undefined) {
    const haystack = `${basename(modelDir)} ${typeof configRecord?._name_or_path === 'string' ? configRecord._name_or_path : ''}`.toLowerCase()
    if (/(^|[^a-z])(bge|bert)/.test(haystack)) {
      result.pooling = 'cls'
      result.sources.pooling = 'model family (bge/bert → cls)'
    } else if (/(minilm|mpnet|e5|gte|gtr|sentence-t5)/.test(haystack)) {
      result.pooling = 'mean'
      result.sources.pooling = 'model family (mean-pooled)'
    }
  }
  return result
}

/**
 * PUT 时的目录实存校验（fail-fast 400，比探针更早给出可操作报错）：必须是目录
 * 且含 tokenizer.json 与 onnx/ 子目录下的至少一个 .onnx——transformers.js 的
 * from_pretrained 恒从 onnx/ 子目录读权重（modeling_utils.js subfolder='onnx'，
 * 无顶层回退），顶层散装 .onnx 过校验也必然在加载期失败，所以这里直接拒绝并
 * 给出挪目录指引（2026-10-13 收紧；此前顶层布局被误放行）。返回 null 表示
 * 合法，否则返回错误文案。
 */
export function validateLocalModelDir(modelDir: string): string | null {
  let info
  try {
    info = statSync(modelDir)
  } catch {
    return `modelDir '${modelDir}' does not exist`
  }
  if (!info.isDirectory()) return `modelDir '${modelDir}' is not a directory`
  const names = readdirSync(modelDir)
  if (!names.includes('tokenizer.json')) {
    return `modelDir '${modelDir}' has no tokenizer.json (expected a Hugging Face ONNX layout: tokenizer.json + config.json + onnx/model.onnx)`
  }
  let onnxNames: string[] = []
  try {
    onnxNames = statSync(join(modelDir, 'onnx')).isDirectory() ? readdirSync(join(modelDir, 'onnx')) : []
  } catch {
    // onnx/ 子目录缺失 ⇒ 按空处理，走下面的统一报错。
  }
  const hasOnnx = onnxNames.some((name) => name.endsWith('.onnx'))
  if (!hasOnnx) {
    return names.some((name) => name.endsWith('.onnx'))
      ? `modelDir '${modelDir}' has .onnx files at the top level but no onnx/ subdirectory: transformers.js only loads weights from 'onnx/' (e.g. onnx/model_fp16.onnx) — move the weights into an onnx/ subdirectory`
      : `modelDir '${modelDir}' has no .onnx weights (expected onnx/model_fp16.onnx, onnx/model_quantized.onnx or onnx/model.onnx)`
  }
  return null
}

/* --------------------------- 包解析（多锚链） --------------------------- */

/** 解析候选锚：本 bundle 真实位置（profile 安装形态）在前，宿主锚在后。 */
function resolutionAnchors(): string[] {
  const candidates: string[] = []
  const push = (value: string | undefined): void => {
    if (typeof value !== 'string' || value === '' || candidates.includes(value)) return
    candidates.push(value)
  }
  if (import.meta.url.startsWith('file:')) {
    try {
      push(fileURLToPath(import.meta.url))
    } catch {
      // file: URL 不可转路径（虚拟路径）时跳过该锚。
    }
  }
  if (typeof process.argv[1] === 'string' && process.argv[1] !== '') {
    push(process.argv[1])
    try {
      push(realpathSync(process.argv[1]))
    } catch {
      // 锚不存在（嵌入/打包运行时）时保留原锚候选。
    }
  }
  return candidates
}

/** 仅解析不加载（installed 探测；不触发任何模块副作用）。 */
export function isLocalEmbedRuntimeInstalled(): boolean {
  for (const anchor of resolutionAnchors()) {
    try {
      createRequire(anchor).resolve(TRANSFORMERS_PACKAGE)
      return true
    } catch {
      // 该锚下不可达 ⇒ 尝试下一个。
    }
  }
  return false
}

/** transformers.js 里消费的最小类型面（pipeline + env 开关；真实形状由运行时保证）。 */
interface TransformersModule {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean }
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<TransformersPipeline>
}

interface TransformersPipeline {
  (texts: string[], options?: Record<string, unknown>): Promise<{ tolist(): number[][] }>
}

async function importTransformers(): Promise<TransformersModule> {
  for (const anchor of resolutionAnchors()) {
    try {
      const resolved = createRequire(anchor).resolve(TRANSFORMERS_PACKAGE)
      return await import(pathToFileURL(resolved).href) as TransformersModule
    } catch {
      // 该锚下解析/加载失败 ⇒ 尝试下一个。
    }
  }
  // 兜底：宿主锚 + 标准解析（importHostPackage 自带 argv[1]/realpath 候选与裸
  // import 回退，覆盖 link: 挂载下宿主全局安装运行时的形态）。
  return await importHostPackage<TransformersModule>(TRANSFORMERS_PACKAGE)
}

/** 默认运行时：懒解析 transformers.js → 本地目录加载 feature-extraction 管线。 */
export const defaultLocalEmbedRuntime: LocalEmbedRuntime = {
  async load(modelDir, options = {}) {
    let transformers: TransformersModule
    try {
      transformers = await importTransformers()
    } catch (cause) {
      throw new Error(`${TRANSFORMERS_INSTALL_HINT} (resolution failed: ${cause instanceof Error ? cause.message : String(cause)})`)
    }
    // 离线纪律（文件头）：tokenizer/权重只来自本地目录。
    transformers.env.allowRemoteModels = false
    transformers.env.allowLocalModels = true
    // dtype 路由（2026-10-13 精度可选）：调用侧已把配置解析成单档（显式钉档或
    // auto 按目录识别，见 resolveLocalDtype）——单档单次尝试，失败即错（确定性
    // 失败不静默降档：用户钉了 q8 就不该悄悄跑 fp32，auto 识别也只认扫描结果）。
    // dtype 缺席（目录检不出档位的 auto 兜底）保留旧的逐档 try 链
    // fp16 → q8 → fp32（2026-10-12 用户决策：默认 FP16；Xenova 布局的
    // onnx/model_fp16.onnx / model_quantized.onnx / model.onnx），覆盖扫描面之外
    // 的非标准布局。pooling/normalize 在调用侧显式传入，不依赖库默认值。
    let pipeline: TransformersPipeline | undefined
    if (options.dtype !== undefined) {
      pipeline = await transformers.pipeline('feature-extraction', modelDir, { dtype: options.dtype })
    } else {
      const chain = ['fp16', 'q8', 'fp32'] as const
      let lastError: unknown
      for (const dtype of chain) {
        try {
          pipeline = await transformers.pipeline('feature-extraction', modelDir, { dtype })
          break
        } catch (cause) {
          lastError = cause
        }
      }
      if (pipeline === undefined) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError))
      }
    }
    return {
      async embed(texts) {
        const output = await pipeline([...texts], {
          pooling: options.pooling ?? 'cls',
          normalize: true,
        })
        return output.tolist()
      },
    }
  },
}

/* --------------------------- 运行时安装（面板一键） --------------------------- */

/** 安装超时：与自更新链路的 DEFAULT_INSTALL_TIMEOUT_MS 同款量级（原生包体积大）。 */
export const LOCAL_RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 安装输出回传上限（pnpm 进度可控，超长截尾）。 */
const INSTALL_OUTPUT_TAIL = 8000

/** profile 根解析：插件物理安装在 `<profile>/node_modules/dsh-tavern` 时返回
 *  `<profile>`；link: 挂载（插件目录不在 node_modules 里）返回 undefined——
 *  此时「profile 根」与插件目录分离，自动安装会写错地方（2026-10-12 实况：
 *  在源码仓库根执行 pnpm add 污染 lockfile 并触发 allowBuilds 改写）。 */
export function localRuntimeProfileRoot(pluginDir: string): string | undefined {
  const parent = dirname(pluginDir)
  if (basename(parent) !== 'node_modules') return undefined
  return dirname(parent)
}

/** 子进程运行器形状（测试注入口；生产为 spawn 流式捕获，纪律镜像自更新链路
 *  apply.ts 的 runCapture：windowsHide、逐行收集、超时 kill + unref）。 */
export type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; output: string }>

export function defaultSpawnRunner(command: string, args: readonly string[], options: { cwd: string; timeoutMs: number }): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // win32 下 pnpm 是 .cmd（Node 安全策略不允许无 shell 直启 .cmd）；参数是
    // 本模块写死的常量包名、路径经 cwd 传递，shell 化无注入面。
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let output = ''
    const feed = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 1_000_000) output = output.slice(-1_000_000)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`pnpm timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

export interface LocalRuntimeInstallOutcome {
  ok: boolean
  /** 已在位（快速路径，未跑 pnpm）。 */
  alreadyInstalled: boolean
  message?: string
  /** pnpm 输出尾段（诊断回显）。 */
  outputTail: string
}

/** 面板一键安装（2026-10-12 用户决策，参考自更新执行方式）：在 profile 根执行
 *  `pnpm add @huggingface/transformers`。成功即同进程生效（运行时按 URL 动态
 *  import，无需重启；探针可立刻验证）。 */
export async function installLocalEmbedRuntime(input: {
  pluginDir: string
  timeoutMs?: number
  spawnRunner?: SpawnRunner
}): Promise<LocalRuntimeInstallOutcome> {
  if (isLocalEmbedRuntimeInstalled()) {
    return { ok: true, alreadyInstalled: true, outputTail: '' }
  }
  const profileRoot = localRuntimeProfileRoot(input.pluginDir)
  if (profileRoot === undefined) {
    return {
      ok: false,
      alreadyInstalled: false,
      message: `auto-install is unavailable for link:/source mounts (plugin directory '${input.pluginDir}' is not under a node_modules install): run "pnpm add ${TRANSFORMERS_PACKAGE}" manually in the DSH profile root`,
      outputTail: '',
    }
  }
  const run = input.spawnRunner ?? defaultSpawnRunner
  try {
    const result = await run('pnpm', ['add', TRANSFORMERS_PACKAGE], {
      cwd: profileRoot,
      timeoutMs: input.timeoutMs ?? LOCAL_RUNTIME_INSTALL_TIMEOUT_MS,
    })
    const outputTail = result.output.slice(-INSTALL_OUTPUT_TAIL)
    if (result.code !== 0) {
      return { ok: false, alreadyInstalled: false, message: `pnpm exited with ${result.code}`, outputTail }
    }
    if (!isLocalEmbedRuntimeInstalled()) {
      return { ok: false, alreadyInstalled: false, message: 'pnpm succeeded but the runtime is still not resolvable (restart DSH and retry the probe)', outputTail }
    }
    return { ok: true, alreadyInstalled: false, outputTail }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      ok: false,
      alreadyInstalled: false,
      message: `pnpm add failed: ${detail}${/ENOENT|not found|not recognized/i.test(detail) ? ` (is pnpm on PATH?)` : ''}`,
      outputTail: '',
    }
  }
}

/* ----------------------------- 会话缓存 ----------------------------- */

const sessionCache = new Map<string, Promise<LocalEmbedModel>>()

function sessionKey(config: Pick<MemoryEmbeddingLocalSettings, 'modelDir' | 'pooling' | 'precision'>, options: { pooling?: 'cls' | 'mean' }): string {
  return `${config.modelDir}|${localModelFingerprint(config.modelDir)}|${options.pooling ?? 'cls'}|${resolveLocalDtype(config) ?? 'auto'}`
}

/**
 * 取或加载模型会话：同 key 在飞/已完成请求共享同一 Promise（并发触发只加载
 * 一次）；加载失败从缓存摘除（下次尝试不被失败的 Promise 卡死）；指纹与解析后
 * 的精度进 key，目录内容变化或换精度档后自动走新会话，旧会话条目按 LRU 淘汰
 * 出进程。
 */
export function loadLocalEmbedModel(
  config: Pick<MemoryEmbeddingLocalSettings, 'modelDir' | 'pooling' | 'precision'>,
  runtime: LocalEmbedRuntime = defaultLocalEmbedRuntime,
): Promise<LocalEmbedModel> {
  const options: { pooling?: 'cls' | 'mean'; dtype?: string } = {}
  if (config.pooling !== undefined) options.pooling = config.pooling
  const dtype = resolveLocalDtype(config)
  if (dtype !== undefined) options.dtype = dtype
  const key = sessionKey(config, options)
  const cached = sessionCache.get(key)
  if (cached !== undefined) return cached
  const promise = runtime.load(config.modelDir, options).catch((cause: unknown) => {
    sessionCache.delete(key)
    throw cause
  })
  sessionCache.set(key, promise)
  while (sessionCache.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionCache.keys().next().value
    if (oldest === undefined) break
    sessionCache.delete(oldest)
  }
  return promise
}

/** 测试注入口：清空会话缓存（生产代码不得调用）。 */
export function resetLocalEmbedSessionCache(): void {
  sessionCache.clear()
}
