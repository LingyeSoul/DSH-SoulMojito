/**
 * Tavern 数据存储：数据根（新装 `$DSH_HOME/soulmojito/`，旧装 `$DSH_HOME/tavern/`，
 * 由 `dsh-home.ts` 的 tavernDataRoot() 解析）下的目录布局与 CRUD。
 *
 * ```text
 * soulmojito/
 * ├── characters/<name>.png|<name>.json   # PNG 原样存（保留图像与双 chunk）
 * ├── worlds/<name>.json                  # ST 世界书文件形态
 * ├── presets/<name>.json                 # ST preset 形态（chat completion / context / instruct / textgen）
 * ├── chats/<character>/<timestamp>.jsonl # ST 聊天文件形态（character 为角色名或群名）
 * ├── chats/<character>/<timestamp>.jsonl.worlds.json   # 会话世界书副本（脚本写入的覆盖层）
 * ├── chats/<character>/<timestamp>.jsonl.scripts.json  # 会话脚本树副本（卡脚本改写，不回写角色卡）
 * ├── personas/<name>.json                # persona 定义
 * ├── personas/avatars/<name>.png         # persona 头像
 * ├── groups/<name>.json                  # ST 群组文件形态（members 为角色名）
 * └── state.json                          # 运行时状态（当前卡/书/预设/persona/regex/TC）
 * ```
 *
 * 写操作原子（tmp + rename）。Node-only（插件 Node half 使用）。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
// 原子写统一实现（fs-atomic.ts）：唯一 tmp 名 + Windows 瞬态 rename 重试
// （2290eb0 的重试逻辑原样迁入，全包自建 writeAtomic 的收敛点）。
import { writeAtomicBytes } from './fs-atomic.js'
import {
  decodeCharacterCard,
  decodeCharx,
  decodeCharxAsset,
  encodeCharx,
  encodeCharacterCardJson,
  encodeCharacterCardPng,
  listRegexScriptEntries,
  parseCharacterBook,
  parseChatLog,
  parseGroupFile,
  parseRegexScript,
  parseRegexScripts,
  parseWorldInfoFile,
  normalizeEntry,
  serializeChatLog,
  serializeGroupFile,
  serializeWorldInfoFile,
  type CharacterCardIR,
  type ChatLogIR,
  type GroupIR,
  type RegexScriptIR,
  type WorldBookIR,
} from '@dsh-soulmojito/format'

export type TavernArchitecture = 'agent-tavern' | 'st' | 'agent-novel'
export type TavernContextMode = 'dsh-native' | 'agent-managed'

interface TavernSessionBase {
  character: string
  chatId: string
  /** 群聊绑定时为 true；character 字段承载群名。 */
  group?: boolean
}

export type TavernSessionBinding =
  | (TavernSessionBase & {
      architecture: 'agent-tavern'
      contextMode: TavernContextMode
      /** 客户端已预绑定，等待内部命令完成 AgentTavern 初始化。 */
      initializationPending?: true
    })
  | (TavernSessionBase & {
      architecture: 'st'
    })
  | (TavernSessionBase & {
      /** AgentNovel project binding (proposal 0005 §4.2): identity is novelId
       *  alone; the legacy character/chatId string fields are kept as empty
       *  strings for schema compatibility and carry no meaning. */
      architecture: 'agent-novel'
      novelId: string
    })
  | (TavernSessionBase & {
    /** CardWorkbench session binding（提案 0013）：写卡 Agent 会话。与
     *  agent-novel 同理不绑角色/聊天，character/chatId 为空串；来源聊天身份
     *  存 sourceCharacter/sourceChatId——聊天侧「交给工作台」时每个聊天对应
     *  一个写卡工作会话，面板自由拉起时两者为空串。createdCard 记录该会话
     *  最近一次 card_create 产出的卡名（空串 = 尚未出卡），会话标题与侧边栏
     *  分组据此改名为卡名。title 是用户在侧边栏显式改的名（对齐酒馆聊天的
     *  改名/删除能力）：一旦存在即压过 createdCard 与来源身份派生标签，
     *  出卡自动改名不再覆盖它；缺失 = 未显式改名。 */
    architecture: 'card-workbench'
    sourceCharacter: string
    sourceChatId: string
    createdCard: string
    title?: string
  })

/** 一个 DSH session 的模型选择；缺省回落 agentDefaultModel。 */
export interface TavernModelSelection {
  provider: string
  model: string
    reasoningEffort?: string
}

export interface TavernState {
  activeCharacter?: string
  /** 启用的世界书名列表；角色绑定的世界书（extensions.world）在使用该角色时自动并入 */
  activeWorlds: string[]
  activePreset?: string
  activePersona?: string
  /** 将当前角色人格注入普通 DSH Agent 会话；默认关闭。 */
  nativeAgentPersona?: boolean
  /** DSH session 到 Tavern 角色/聊天的持久绑定。 */
  sessionBindings: Record<string, TavernSessionBinding>
  /** 新建会话的架构默认值；不影响已有 binding。 */
  defaultArchitecture: TavernArchitecture
  /** 新建 AgentTavern 会话的上下文模式；不影响已有 binding。 */
  defaultContextMode: TavernContextMode
  /** 新建 AgentTavern 会话初始化时预注入角色信息与常驻世界书条目。 */
  agentTavernPreloadAssets: boolean
  /** 允许 AgentTavern 工具写入 global 作用域的记忆/变量；默认关闭。 */
  agentTavernAllowGlobalWrites: boolean
  /**
   * 美化前端右栏 tab 的自动展开（2026-10-20 用户需求「自动展开 tab 做成设置
   * 开关」）：开启时本聊天出现完整 HTML 楼层即自动打开 tab（每聊天一次，
   * 用户关掉后不抢焦点）；关闭时只经标题栏按钮/右栏「+」手动进入。默认关闭，
   * 与「不打断写作」的默认纪律一致。
   */
  frontendAutoOpen: boolean
  /**
   * 卡脚本自动运行（2026-10-21 用户需求）：开启后进入酒馆聊天时自动展开
   * 「卡脚本」tab，并把卡内全部启用脚本按顺序注入同一个沙箱 iframe 自动执行。
   * 默认关闭——脚本共享同一 iframe 的 DOM/全局，拥有当前聊天的变量、消息与
   * 会话世界书/脚本树副本写权限；只应由用户对信任的卡显式开启。
   */
  cardScriptsAutoRun: boolean
  /**
   * 允许美化前端加载外部资源（2026-10-21 用户需求）：开启后 iframe 的 CSP
   * 放行任意 HTTPS 脚本/样式（sourcemap 走 connect-src 也一并放行），并允许
   * fetch/XHR。默认关闭——外部脚本能读取前端可见的聊天内容并外发，属于用户
   * 显式授权的信任扩展，设置页展示风险警告。
   */
  frontendAllowExternalResources: boolean
  /** 禁用游戏投降（2026-10-14 用户需求；面板「游戏」分区开关）：开启后两个
   *  动作入口（人类棋盘/Agent game_move）对 {type:'resign'} 一律拒绝；默认关闭
   *  （投降可用，与既有行为一致）。 */
  gamesDisableResign: boolean
  /**
   * 写卡工作台会话投影激活聊天预设（提示词堆栈，引用式；默认关闭）。RP 预设
   * 的风格/越狱条目无条件注入会劫持编辑内核，因此显式开关（面板「预设」分区）。
   * 采样参数与卡覆盖不投影，见 plugin src/preset-mount.ts。
   */
  cardWorkbenchPresetEnabled: boolean
  /** AgentNovel 作者会话投影激活聊天预设（跟随式风格栈；默认关闭，同上）。 */
  agentNovelPresetEnabled: boolean
  /**
   * 世界书跟随角色卡激活（默认开启）：切换/导入/会话绑定角色时自动并入其绑定的
   * 世界书（extensions.world），生成时也始终注入该书与卡内嵌书兜底；关闭后角色
   * 绑定的世界书完全由 activeWorlds 显式控制，不再随角色注入。
   */
  worldFollowsCharacter?: boolean
  /** DSH session 到模型选择的持久映射；随 bindings/prune 一同清理。 */
  modelSelections: Record<string, TavernModelSelection>
  /** 每聊天元数据（最后激活时间、swipe 指针等自由袋） */
  chats: Record<string, Record<string, unknown>>
  /** 全局 regex 脚本（ST regex 扩展形态）。 */
  regexScripts: RegexScriptIR[]
  /** STscript 全局变量。 */
  scriptGlobals: Record<string, string | number | boolean>
  /**
   * Frontend-written character-scope variable overlay (2026-10-22).
   *
   * JSR cards treat `{ type: 'character' }` as a writable table (portrait
   * preferences, mirror snapshots). The card file stays read-only; writes land
   * here and are merged ahead of the card's `extensions.variables` on read.
   * Delete the key for one character to reset that overlay.
   */
  characterVariables?: Record<string, Record<string, unknown>>
  /**
   * 美化前端 localStorage 的持久层（2026-10-22）：按角色隔离的键值表。
   * 沙箱 iframe 没有同源存储，卡前端（示例卡3）把 API 源/UI 设置写 localStorage；
   * 插件把小型设置写回宿主状态，重启/刷新后由 srcdoc 同步播种。大资源包仍由卡
   * 自己的 IndexedDB 处理，不进入 state.json。
   */
  frontendStorage?: Record<string, Record<string, string>>
  /**
   * 压缩总结模型的运行时覆盖（提案 0006 §4.3）：剧情会话（AgentTavern 非分组、
   * AgentNovel）压缩检查点的摘要目标。解析顺序：本覆盖 > 部署层 curator 行配置
   * （profile patch）> 会话路由。undefined 表示未覆盖。
   */
  compaction?: TavernCompactionOverride
  /**
   * Mod 全局开关（提案 0015 §3.2 三层开关的第二层）：默认 false。与逐 Mod 的
   * mods.enabled.<id>（第三层 env 硬关之外的两层 state 开关）同时开启才会装载。
   */
  modsEnabled?: boolean
  /** 逐 Mod 启用表（提案 0015 §3.2）：键是 mod id，值为 true 才算启用。 */
  mods?: { enabled?: Record<string, boolean> }
  /**
   * 记忆语义检索 embed 配置（提案 0016；提案 0017 扩为 provider 判别联合）：
   * 缺省 = 远程 OpenAI 兼容端点（三件套），provider='local' = 本地 ONNX 模型
   * 目录。缺省/非法 ⇒ 混合检索整体关闭，memory_search 保持纯词法（golden 行为）。
   * key 只存 env 变量名引用（对齐宿主 dsh-credentials 的 CredentialRef 风格），
   * 明文永不入库。
   */
  memoryEmbedding?: MemoryEmbeddingSettings
}

/**
 * 记忆 embed 端点设置（提案 0016 §配置面；提案 0017 扩为 provider 判别联合）。
 * provider 缺省 = 远程端点形态（历史配置无该字段，行为不变）；'local' = 本地
 * ONNX 形态（提案 0017）。两种形态都要求核心字段齐备才算已配置。
 */
export type MemoryEmbeddingSettings = MemoryEmbeddingEndpointSettings | MemoryEmbeddingLocalSettings

/**
 * 远程端点形态（提案 0016 原状）：baseURL/model/apiKeyEnv 三者齐备才算已配置；
 * apiKeyEnv 为空串表示免密反代（不发送 Authorization 头）。key 只存 env 变量名
 * 引用（对齐宿主 dsh-credentials 的 CredentialRef 风格），明文永不入库。
 */
export interface MemoryEmbeddingEndpointSettings {
  /** 形态判别；缺省（undefined）等价 'openai'（历史配置兼容）。 */
  provider?: 'openai'
  /** OpenAI 兼容端点前缀，实际请求 POST {baseURL}/embeddings。 */
  baseURL: string
  /** 解析 API key 的 POSIX 环境变量名；空串 = 免密。不存明文 key。 */
  apiKeyEnv: string
  model: string
  dims?: number
  /** 单请求批量上限，默认 16。 */
  batchSize?: number
  /** 单次请求超时毫秒，默认 10000。 */
  timeoutMs?: number
}

/**
 * 本地 ONNX 形态（提案 0017）：transformers.js（@huggingface/transformers）
 * 运行时加载用户自备的本地模型目录（HF onnx 布局：tokenizer.json + onnx/*.onnx
 * + config.json）。零网络（模型只从磁盘加载）；运行时不随插件打包，按需解析
 * （见 plugin/src/memory-embed-local.ts）。modelDir 存绝对路径（PUT 时 resolve）。
 */
/**
 * 本地 embed 量化精度（2026-10-13）：'auto' = 按模型目录识别可用权重档位后取
 * 优先链最高档（fp16 → q8 → q4 → … → fp32，目录缺哪档跳哪档）；其余值与
 * transformers.js 4.x 的 DATA_TYPES 对齐（q8 对应 Xenova 布局的
 * model_quantized.onnx；bnb4 排除——bitsandbytes JIT 量化不是文件加载路径，
 * node CPU EP 装不了）。显式值钉死单档：加载失败不回退（确定性失败如实报错）。
 */
export type LocalEmbedPrecision =
  | 'auto' | 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8'
  | 'q4' | 'q4f16' | 'q2' | 'q2f16' | 'q1' | 'q1f16'

/** LocalEmbedPrecision 的合法值集合（normalize 静默过滤手改 state.json 的废值）。 */
export const LOCAL_EMBED_PRECISIONS: readonly LocalEmbedPrecision[] = [
  'auto', 'fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'q4f16', 'q2', 'q2f16', 'q1', 'q1f16',
]

export interface MemoryEmbeddingLocalSettings {
  provider: 'local'
  /** 本地模型目录绝对路径（含 tokenizer.json 与 onnx/*.onnx）。 */
  modelDir: string
  /** 池化策略；缺省 cls（BERT/bge 家族标准；MiniLM 等 mean 池化模型需显式配置）。 */
  pooling?: 'cls' | 'mean'
  /** 量化精度；缺省等价 'auto'（按目录识别优先链）。显式值钉死单档不回退。 */
  precision?: LocalEmbedPrecision
  dims?: number
  /** 单次嵌入批量上限（分批顺序嵌入），默认 16。 */
  batchSize?: number
}

/** 面板可写的压缩设置；provider/model 必须成对出现，空串视为未设置。 */
export interface TavernCompactionOverride {
  curatorProvider: string
  curatorModel: string
}

export interface Persona {
  name: string
  description: string
  /** 描述注入位置：0=IN_PROMPT（默认），4=AT_DEPTH（配 depth/role） */
  position?: number
  depth?: number
  role?: number
  title?: string
  /** 存在 avatars/<name>.png 头像文件时为 true */
  hasAvatar?: boolean
  [key: string]: unknown
}

export interface CharacterFile {
  fileName: string
  kind: 'png' | 'json' | 'charx'
  card: CharacterCardIR
}

export interface ChatSnapshot {
  chat: ChatLogIR
  revision: string
}

export class ChatRevisionConflictError extends Error {
  readonly code = 'CHAT_REVISION_CONFLICT'

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision?: string,
  ) {
    super('Chat changed in another tab. Reloaded the latest version; review it before retrying.')
    this.name = 'ChatRevisionConflictError'
  }
}

const DEFAULT_STATE: TavernState = {
  activeWorlds: [],
  sessionBindings: {},
  defaultArchitecture: 'agent-tavern',
  defaultContextMode: 'dsh-native',
  agentTavernPreloadAssets: false,
  agentTavernAllowGlobalWrites: false,
  frontendAutoOpen: false,
  cardScriptsAutoRun: false,
  frontendAllowExternalResources: false,
  gamesDisableResign: false,
  cardWorkbenchPresetEnabled: false,
  agentNovelPresetEnabled: false,
  worldFollowsCharacter: true,
  modelSelections: {},
  chats: {},
  regexScripts: [],
  scriptGlobals: {},
  characterVariables: {},
  frontendStorage: {},
  modsEnabled: false,
  mods: { enabled: {} },
}

/** characterVariables keeps only per-character plain objects; hand edits are tolerant. */
function normalizeCharacterVariables(value: unknown): Record<string, Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, Record<string, unknown>> = {}
  for (const [character, tree] of Object.entries(value)) {
    if (typeof tree !== 'object' || tree === null || Array.isArray(tree)) continue
    const entries: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(tree)) entries[key] = entry
    if (Object.keys(entries).length > 0) result[character] = entries
  }
  return result
}

/** frontendStorage 只保留字符→字符串的表；手改 state.json 的容错。 */
function normalizeFrontendStorage(value: unknown): Record<string, Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, Record<string, string>> = {}
  for (const [character, entries] of Object.entries(value)) {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) continue
    const storage: Record<string, string> = {}
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry === 'string') storage[key] = entry
    }
    if (Object.keys(storage).length > 0) result[character] = storage
  }
  return result
}

/** mods.enabled 只保留显式 true 的项（手改 state.json 的容错）。 */
function normalizeModEnables(value: unknown): Record<string, boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const enabled = (value as { enabled?: unknown }).enabled
  if (typeof enabled !== 'object' || enabled === null || Array.isArray(enabled)) return {}
  const result: Record<string, boolean> = {}
  for (const [id, flag] of Object.entries(enabled)) {
    if (flag === true) result[id] = true
  }
  return result
}

/** POSIX env 变量名（提案 0016，对齐宿主 dsh-credentials 的 CredentialRef 风格）。
 *  PUT memory/embed 的前置校验复用同一模式（给出比 normalize 落空更可操作的
 *  报错文案），两处不得漂移。 */
export const MEMORY_EMBED_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/

/** 记忆 embed baseURL 规整：去首尾空白与尾部斜杠。normalizeMemoryEmbedding
 *  与 PUT memory/embed 的「三件套全空=清除」判定共用同一形状。 */
export function normalizeEmbedBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * 记忆 embed 设置读取容错（提案 0016 §配置面；提案 0017 扩 provider 判别）：
 * provider='local' 走本地形态（modelDir 非空、无 NUL、≤1024 字符）；缺省/
 * 'openai' 走远程形态——baseURL 必须是 http(s) URL、model 非空、apiKeyEnv 是
 * 合法 POSIX env 名或空串（免密）；数值字段夹取到合法区间。任何硬性字段缺失/
 * 非法 ⇒ 整体 undefined（手改 state.json 时功能安全回落纯词法）。本地形态只做
 * 形状校验不做磁盘校验（state 读取保持纯函数；目录实存校验在 PUT 路由做）。
 */
export function normalizeMemoryEmbedding(value: unknown): MemoryEmbeddingSettings | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.provider === 'local') return normalizeLocalMemoryEmbedding(record)
  if (record.provider !== undefined && record.provider !== '' && record.provider !== 'openai') return undefined
  const baseURL = typeof record.baseURL === 'string' ? normalizeEmbedBaseURL(record.baseURL) : ''
  const model = typeof record.model === 'string' ? record.model.trim().slice(0, 200) : ''
  const apiKeyEnv = typeof record.apiKeyEnv === 'string' ? record.apiKeyEnv.trim() : ''
  if (baseURL === '' || model === '' || !/^https?:\/\//.test(baseURL)) return undefined
  if (apiKeyEnv !== '' && !MEMORY_EMBED_ENV_NAME.test(apiKeyEnv)) return undefined
  const dims = clampOptionalInt(record.dims, 1, 8192)
  const batchSize = clampOptionalInt(record.batchSize, 1, 64)
  const timeoutMs = clampOptionalInt(record.timeoutMs, 200, 120000)
  return {
    baseURL,
    apiKeyEnv,
    model,
    ...(dims !== undefined ? { dims } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }
}

function normalizeLocalMemoryEmbedding(record: Record<string, unknown>): MemoryEmbeddingLocalSettings | undefined {
  const modelDir = typeof record.modelDir === 'string' ? record.modelDir.trim() : ''
  if (modelDir === '' || modelDir.length > 1024 || modelDir.includes('\0')) return undefined
  const dims = clampOptionalInt(record.dims, 1, 8192)
  const batchSize = clampOptionalInt(record.batchSize, 1, 64)
  const precision = LOCAL_EMBED_PRECISIONS.includes(record.precision as LocalEmbedPrecision)
    ? record.precision as LocalEmbedPrecision
    : undefined
  return {
    provider: 'local',
    modelDir,
    ...(record.pooling === 'cls' || record.pooling === 'mean' ? { pooling: record.pooling } : {}),
    ...(precision !== undefined ? { precision } : {}),
    ...(dims !== undefined ? { dims } : {}),
    ...(batchSize !== undefined ? { batchSize } : {}),
  }
}

function clampOptionalInt(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, Math.round(value)))
}

export class TavernStore {
  private chatMutationTail: Promise<void> = Promise.resolve()
  private stateMutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<TavernStore> {
    for (const dir of ['characters', 'worlds', 'presets', 'chats', 'personas', 'groups', 'personas/avatars']) {
      await fs.mkdir(path.join(root, dir), { recursive: true })
    }
    return new TavernStore(root)
  }

  /* ---------------------------- 变更水位 ---------------------------- */

  /**
   * 资产变更水位：characters/worlds/presets/personas(+avatars)/groups 的目录项
   * 名、size 与 mtimeMs 的 sha256 摘要。写卡 Agent 等后台路径直接落盘、没有
   * 推送通道，客户端面板靠轮询这个水位感知变化并重取 bootstrap；摘要只读目录
   * 元数据而不是文件内容，保证按秒级轮询足够便宜。chats/ 有各自的 CAS revision、
   * state.json 由面板写路径自行刷新，都不参与。
   */
  async storeRevision(): Promise<string> {
    const hash = createHash('sha256')
    for (const dir of ['characters', 'worlds', 'presets', 'personas', 'personas/avatars', 'groups']) {
      hash.update(`${dir}\n`)
      for (const name of (await this.listDir(dir)).sort()) {
        const stat = await fs.stat(path.join(this.root, dir, name)).catch(() => undefined)
        hash.update(`${name}\u0000${stat === undefined ? 'missing' : `${stat.size}\u0000${stat.mtimeMs}`}\n`)
      }
    }
    return hash.digest('base64url')
  }

  /* ------------------------------ 角色 ------------------------------ */

  /** 导入角色卡：PNG/CHARX 原字节落盘保留资源；JSON 对象序列化落盘。重名覆盖。
   *  卡内嵌角色书自动物化为世界书文件并写回 extensions.world 链接（对齐 ST 导入语义）。
   *  卡内嵌 regex_scripts 物化为全局脚本（按 scriptName 合并）。 */
  async importCharacter(source: Uint8Array | object): Promise<{ fileName: string; card: CharacterCardIR; importedWorld?: string; importedRegex: number }> {
    let bytes: Uint8Array
    let kind: 'png' | 'json' | 'charx'
    let card: CharacterCardIR
    let charxAssets: Array<{ path: string; data: Uint8Array }> | undefined
    if (source instanceof Uint8Array) {
      if (source[0] === 0x89 && source[1] === 0x50) {
        bytes = source
        kind = 'png'
        card = decodeCharacterCard(bytes)
      } else if (source[0] === 0x50 && source[1] === 0x4b) {
        bytes = source
        kind = 'charx'
        const decoded = decodeCharx(bytes)
        card = decoded.card
        charxAssets = decoded.assetPaths.map((assetPath) => ({ path: assetPath, data: decodeCharxAsset(bytes, assetPath) }))
      } else {
        card = decodeCharacterCard(JSON.parse(Buffer.from(source).toString('utf8')))
        bytes = jsonBytes(encodeCharacterCardJson(card))
        kind = 'json'
      }
    } else {
      card = decodeCharacterCard(source)
      bytes = jsonBytes(encodeCharacterCardJson(card))
      kind = 'json'
    }
    const importedWorld = await this.materializeEmbeddedBook(card)
    const importedRegex = await this.importEmbeddedRegex(card)
    if (importedWorld !== undefined) {
      // 链接写回了卡数据，容器需重编码以携带新 extensions.world（图像等资源经模板/资产保留）
      bytes = kind === 'png'
        ? encodeCharacterCardPng(card, bytes)
        : kind === 'charx'
          ? encodeCharx(card, charxAssets!)
          : jsonBytes(encodeCharacterCardJson(card))
    }
    const stem = safeFileName(card.data.name)
    const fileName = `${stem}.${kind}`
    await this.writeAtomic(path.join(this.root, 'characters', fileName), bytes)
    await Promise.all((['png', 'json', 'charx'] as const)
      .filter((other) => other !== kind)
      .map((other) => fs.rm(path.join(this.root, 'characters', `${stem}.${other}`), { force: true })))
    return { fileName, card, importedWorld, importedRegex }
  }

  /**
   * 卡内嵌角色书 → worlds/ 下的世界书文件（重名覆盖，导入以卡内嵌书为准），
   * 并把 extensions.world 链接写回卡数据。返回物化的世界书名；无内嵌书时为 undefined。
   * 命名：已有链接名 > 内嵌书自身名 > 角色名。
   */
  private async materializeEmbeddedBook(card: CharacterCardIR): Promise<string | undefined> {
    const book = card.data.characterBook
    if (!book) return undefined
    const rawLinked = card.data.extensions['world']
    const linkedName = typeof rawLinked === 'string' ? rawLinked.trim() : ''
    const bookName = linkedName !== ''
      ? linkedName
      : (typeof book.name === 'string' && book.name.trim() !== '' ? book.name.trim() : card.data.name)
    await this.putWorld({ ...parseCharacterBook(book), name: bookName })
    if (linkedName === '') {
      card.data.extensions = { ...card.data.extensions, world: bookName }
    }
    return bookName
  }

  /** 卡内嵌 regex_scripts 物化为全局脚本；脚本格式非法时整体跳过，不阻断角色导入。 */
  private async importEmbeddedRegex(card: CharacterCardIR): Promise<number> {
    const embedded = card.data.extensions['regex_scripts']
    if (embedded === undefined || embedded === null) return 0
    try {
      return await this.importRegexScripts(embedded)
    } catch {
      return 0
    }
  }

  /** 预设扩展袋里的 regex_scripts 物化为全局脚本；非法脚本整批跳过，不阻断预设导入。 */
  private async importEmbeddedPresetRegex(preset: Record<string, unknown>): Promise<number> {
    const embedded = presetExtensions(preset)['regex_scripts']
    if (embedded === undefined || embedded === null) return 0
    try {
      return await this.importRegexScripts(embedded)
    } catch {
      return 0
    }
  }

  /** 导出角色卡 PNG（带模板图）；无图像模板时导出 JSON。 */
  async exportCharacter(name: string, template?: Uint8Array): Promise<Uint8Array> {
    const file = await this.getCharacter(name)
    if (file === undefined) throw new Error(`character '${name}' not found`)
    if (file.kind === 'png') {
      const bytes = await fs.readFile(path.join(this.root, 'characters', file.fileName))
      if (template === undefined) return bytes
      return encodeCharacterCardPng(file.card, bytes)
    }
    if (file.kind === 'charx' && template === undefined) {
      return new Uint8Array(await fs.readFile(path.join(this.root, 'characters', file.fileName)))
    }
    if (template !== undefined) return encodeCharacterCardPng(file.card, template)
    return new Uint8Array(Buffer.from(JSON.stringify(encodeCharacterCardJson(file.card), null, 2), 'utf8'))
  }

  /**
   * 保存已编辑的角色卡，并尽量保留原始容器：PNG 继续写回原图的 chunks，
   * CHARX 继续保留 zip 内全部资源；名称变更时同步迁移文件名。
   */
  async updateCharacter(name: string, source: object): Promise<CharacterFile> {
    const current = await this.getCharacter(name)
    if (current === undefined) throw new Error(`character '${name}' not found`)
    const incomingData = (source as { data?: unknown }).data
    const card = typeof incomingData === 'object' && incomingData !== null && !Array.isArray(incomingData)
      && Object.prototype.hasOwnProperty.call(incomingData, 'firstMes')
      ? {
          ...current.card,
          spec: (source as { spec?: CharacterCardIR['spec'] }).spec ?? current.card.spec,
          specVersion: typeof (source as { specVersion?: unknown }).specVersion === 'string'
            ? (source as { specVersion: string }).specVersion
            : current.card.specVersion,
          data: { ...current.card.data, ...(incomingData as Partial<CharacterCardIR['data']>) },
          raw: structuredClone(current.card.raw),
        }
      : decodeCharacterCard(source)
    if (typeof card.data.name !== 'string' || card.data.name.trim() === '') {
      throw new Error('character name cannot be empty')
    }
    const nextStem = safeFileName(card.data.name)
    const currentStem = safeFileName(name)
    const collision = await this.getCharacter(card.data.name)
    if (collision !== undefined && nextStem !== currentStem) {
      throw new Error(`character '${card.data.name}' already exists`)
    }
    let bytes: Uint8Array
    let kind: 'png' | 'charx' | 'json' = current.kind
    const original = new Uint8Array(await fs.readFile(path.join(this.root, 'characters', current.fileName)))
    if (current.kind === 'png') {
      bytes = encodeCharacterCardPng(card, original)
    } else if (current.kind === 'charx') {
      const decoded = decodeCharx(original)
      bytes = encodeCharx(card, decoded.assetPaths.map((assetPath) => ({ path: assetPath, data: decodeCharxAsset(original, assetPath) })))
    } else {
      bytes = jsonBytes(encodeCharacterCardJson(card))
    }
    await this.writeAtomic(path.join(this.root, 'characters', `${nextStem}.${kind}`), bytes)
    if (currentStem !== nextStem || current.kind !== kind) {
      await fs.rm(path.join(this.root, 'characters', current.fileName), { force: true })
    }
    if (currentStem !== nextStem) {
      try {
        await fs.access(path.join(this.root, 'chats', nextStem))
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
        try {
          await fs.rename(path.join(this.root, 'chats', currentStem), path.join(this.root, 'chats', nextStem))
        } catch (renameCause) {
          if ((renameCause as NodeJS.ErrnoException).code !== 'ENOENT') throw renameCause
        }
      }
    }
    for (const other of (['png', 'json', 'charx'] as const).filter((other) => other !== kind)) {
      await fs.rm(path.join(this.root, 'characters', `${nextStem}.${other}`), { force: true })
    }
    const saved = await this.getCharacter(card.data.name)
    if (saved === undefined) throw new Error(`character '${card.data.name}' could not be reloaded`)
    return saved
  }

  async listCharacters(): Promise<string[]> {
    const files = await this.listDir('characters')
    return [...new Set(files
      .filter((f) => /\.(png|json|charx)$/.test(f))
      .map((f) => f.replace(/\.(png|json|charx)$/, '')))]
      .sort()
  }

  async getCharacter(name: string): Promise<CharacterFile | undefined> {
    for (const kind of ['png', 'charx', 'json'] as const) {
      const fileName = `${safeFileName(name)}.${kind}`
      try {
        const bytes = new Uint8Array(await fs.readFile(path.join(this.root, 'characters', fileName)))
        const card = kind === 'png'
          ? decodeCharacterCard(bytes)
          : kind === 'charx'
            ? decodeCharx(bytes).card
            : decodeCharacterCard(JSON.parse(Buffer.from(bytes).toString('utf8')))
        return { fileName, kind, card }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    return undefined
  }

  async deleteCharacter(name: string): Promise<boolean> {
    let deleted = false
    for (const kind of ['png', 'json', 'charx'] as const) {
      const file = path.join(this.root, 'characters', `${safeFileName(name)}.${kind}`)
      try {
        await fs.unlink(file)
        deleted = true
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
    }
    // 对齐 ST 语义：删角色连同其聊天记录（chats/<name>/ 一并移除）。
    if (deleted) {
      await fs.rm(path.join(this.root, 'chats', safeFileName(name)), { recursive: true, force: true })
    }
    return deleted
  }

  /* ----------------------------- 世界书 ----------------------------- */

  async putWorld(book: WorldBookIR): Promise<void> {
    await this.writeAtomic(
      path.join(this.root, 'worlds', `${safeFileName(book.name)}.json`),
      jsonBytes(serializeWorldInfoFile(book)),
    )
  }

  /** 导入 ST 世界书文件对象。 */
  async importWorldFile(name: string, obj: Record<string, unknown>): Promise<WorldBookIR> {
    const ir = parseWorldInfoFile(name, obj)
    await this.putWorld(ir)
    return ir
  }

  async listWorlds(): Promise<string[]> {
    const files = await this.listDir('worlds')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async getWorld(name: string): Promise<WorldBookIR | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'worlds', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return parseWorldInfoFile(name, JSON.parse(Buffer.from(bytes).toString('utf8')))
  }

  async exportWorld(name: string): Promise<Uint8Array> {
    const book = await this.getWorld(name)
    if (book === undefined) throw new Error(`world '${name}' not found`)
    return jsonBytes(serializeWorldInfoFile(book))
  }

  async deleteWorld(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'worlds', `${safeFileName(name)}.json`), { force: true })
  }

  /* ------------------------------ 聊天 ------------------------------ */

  async createChat(characterName: string, header: ChatLogIR['header'], messages: ChatLogIR['messages'] = []): Promise<string> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      await fs.mkdir(dir, { recursive: true })
      const id = `${timestamp()}.jsonl`
      await this.writeAtomic(path.join(dir, id), chatBytes({ header, messages }))
      return id
    })
  }

  async saveChat(characterName: string, chatId: string, log: ChatLogIR, expectedRevision?: string): Promise<string> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const file = path.join(dir, safeChatFileName(chatId))
      await this.assertChatRevision(file, expectedRevision)
      const bytes = chatBytes(log)
      await this.writeAtomic(file, bytes)
      return chatRevision(bytes)
    })
  }

  async getChat(characterName: string, chatId: string): Promise<ChatLogIR | undefined> {
    return (await this.getChatSnapshot(characterName, chatId))?.chat
  }

  async getChatSnapshot(characterName: string, chatId: string): Promise<ChatSnapshot | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'chats', safeFileName(characterName), safeChatFileName(chatId)))
    if (bytes === undefined) return undefined
    return {
      chat: parseChatLog(Buffer.from(bytes).toString('utf8')),
      revision: chatRevision(bytes),
    }
  }

  async listChats(characterName: string): Promise<string[]> {
    const dir = path.join(this.root, 'chats', safeFileName(characterName))
    try {
      const files = await fs.readdir(dir)
      return files.filter((f) => f.endsWith('.jsonl')).sort()
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  async renameChat(characterName: string, chatId: string, nextChatId: string, expectedRevision?: string): Promise<void> {
    await this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const source = path.join(dir, safeChatFileName(chatId))
      const target = path.join(dir, safeChatFileName(nextChatId))
      await this.assertChatRevision(source, expectedRevision)
      if (source === target) return
      if (await this.tryRead(target)) throw new Error(`chat '${nextChatId}' already exists`)
      await fs.rename(source, target)
      // Session overlays follow the chat file; drop any stale target first because
      // Windows rename refuses an existing destination.
      await this.moveChatOverlay(this.chatWorldsFile(characterName, chatId), this.chatWorldsFile(characterName, nextChatId))
      await this.moveChatOverlay(this.chatScriptsFile(characterName, chatId), this.chatScriptsFile(characterName, nextChatId))
    })
  }

  async deleteChat(characterName: string, chatId: string, expectedRevision?: string): Promise<boolean> {
    return this.mutateChat(async () => {
      const file = path.join(this.root, 'chats', safeFileName(characterName), safeChatFileName(chatId))
      try {
        await this.assertChatRevision(file, expectedRevision)
        await fs.unlink(file)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw cause
      }
      // Inside the mutation queue so a concurrent put cannot recreate an orphan
      // overlay after the chat file is gone.
      await fs.rm(this.chatWorldsFile(characterName, chatId), { force: true })
      await fs.rm(this.chatScriptsFile(characterName, chatId), { force: true })
      return true
    })
  }

  /* ---------------------- 会话级世界书副本 ---------------------- */

  /**
   * Session world-book overlay (2026-10-21): card scripts write through
   * `lorebook.put` into a copy owned by one chat. `worlds/<name>.json` and the
   * card's embedded `character_book` stay read-only. Layout:
   * `chats/<character>/<chat>.jsonl.worlds.json`; `listChats` only collects
   * `.jsonl` entries so the copy never shows up as a chat.
   */
  async getChatWorld(characterName: string, chatId: string, worldName: string): Promise<WorldBookIR | undefined> {
    const file = this.chatWorldsFile(characterName, chatId)
    const bytes = await this.tryRead(file)
    if (bytes === undefined) return undefined
    const stored = parseChatWorldsFile(file, bytes).worlds[worldName]
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async putChatWorld(characterName: string, chatId: string, book: WorldBookIR): Promise<void> {
    if (typeof book.name !== 'string' || book.name.trim() === '') {
      throw new Error('putChatWorld requires a world book name')
    }
    await this.mutateChat(async () => {
      const file = this.chatWorldsFile(characterName, chatId)
      const current = await this.readChatWorlds(file)
      current.worlds[book.name] = structuredClone(book)
      await this.writeAtomic(file, jsonBytes({ version: 1, worlds: current.worlds }))
    })
  }

  async deleteChatWorld(characterName: string, chatId: string, worldName: string): Promise<boolean> {
    return this.mutateChat(async () => {
      const file = this.chatWorldsFile(characterName, chatId)
      const bytes = await this.tryRead(file)
      if (bytes === undefined) return false
      const current = parseChatWorldsFile(file, bytes)
      if (!Object.prototype.hasOwnProperty.call(current.worlds, worldName)) return false
      delete current.worlds[worldName]
      if (Object.keys(current.worlds).length === 0) await fs.rm(file, { force: true })
      else await this.writeAtomic(file, jsonBytes({ version: 1, worlds: current.worlds }))
      return true
    })
  }

  async listChatWorlds(characterName: string, chatId: string): Promise<string[]> {
    const file = this.chatWorldsFile(characterName, chatId)
    const bytes = await this.tryRead(file)
    if (bytes === undefined) return []
    return Object.keys(parseChatWorldsFile(file, bytes).worlds).sort()
  }

  /* ---------------------- 会话级脚本树副本 ---------------------- */

  /**
   * Session script-tree overlay (2026-10-21): GM panels persist Zod source edits
   * through `scripts.put` into a copy owned by one chat. The card's
   * `extensions.tavern_helper.scripts` and the character card file stay
   * read-only. Layout: `chats/<character>/<chat>.jsonl.scripts.json`; node
   * shapes pass through untouched (`type`, `id`, `name`, `content`, `enabled`,
   * `info`, `button`, unknown fields).
   */
  async getChatScripts(characterName: string, chatId: string): Promise<unknown[] | undefined> {
    const file = this.chatScriptsFile(characterName, chatId)
    const bytes = await this.tryRead(file)
    if (bytes === undefined) return undefined
    return structuredClone(parseChatScriptsFile(file, bytes).scriptTrees)
  }

  async putChatScripts(characterName: string, chatId: string, scriptTrees: unknown[]): Promise<void> {
    if (!Array.isArray(scriptTrees)) throw new Error('putChatScripts requires an array of script nodes')
    scriptTrees.forEach((node, index) => {
      if (!isPlainRecord(node)) throw new Error(`putChatScripts node ${index} must be an object`)
    })
    await this.mutateChat(async () => {
      await this.writeAtomic(
        this.chatScriptsFile(characterName, chatId),
        jsonBytes({ version: 1, scriptTrees: structuredClone(scriptTrees) }),
      )
    })
  }

  async deleteChatScripts(characterName: string, chatId: string): Promise<boolean> {
    return this.mutateChat(async () => {
      const file = this.chatScriptsFile(characterName, chatId)
      if (await this.tryRead(file) === undefined) return false
      await fs.rm(file, { force: true })
      return true
    })
  }

  async hasChatScripts(characterName: string, chatId: string): Promise<boolean> {
    return await this.tryRead(this.chatScriptsFile(characterName, chatId)) !== undefined
  }

  /* ------------------------------ 群组 ------------------------------ */

  async putGroup(group: GroupIR): Promise<void> {
    await this.writeAtomic(
      path.join(this.root, 'groups', `${safeFileName(group.name)}.json`),
      jsonBytes(serializeGroupFile(group)),
    )
  }

  async getGroup(name: string): Promise<GroupIR | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'groups', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return parseGroupFile(JSON.parse(Buffer.from(bytes).toString('utf8')), name)
  }

  async listGroups(): Promise<string[]> {
    const files = await this.listDir('groups')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deleteGroup(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'groups', `${safeFileName(name)}.json`), { force: true })
  }

  /* ------------------------------ 预设 ------------------------------ */

  /** 预设按原样 JSON 存取（含采样参数与 prompts/prompt_order 全量）。 */
  async putPreset(name: string, preset: Record<string, unknown>): Promise<void> {
    await this.writeAtomic(path.join(this.root, 'presets', `${safeFileName(name)}.json`), jsonBytes(preset))
  }

  /**
   * 导入预设：原样落盘后把 `extensions.regex_scripts`（ST preset-scoped regex
   * 的落盘位置）物化为全局脚本，按 scriptName 合并；脚本格式非法时整批跳过，
   * 不阻断预设导入（与角色卡内嵌脚本同语义）。
   */
  async importPreset(name: string, preset: Record<string, unknown>): Promise<{ importedRegex: number }> {
    await this.putPreset(name, preset)
    return { importedRegex: await this.importEmbeddedPresetRegex(preset) }
  }

  async getPreset(name: string): Promise<Record<string, unknown> | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'presets', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>
  }

  async exportPreset(name: string): Promise<Uint8Array> {
    const preset = await this.getPreset(name)
    if (preset === undefined) throw new Error(`preset '${name}' not found`)
    return jsonBytes(preset)
  }

  async listPresets(): Promise<string[]> {
    const files = await this.listDir('presets')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deletePreset(name: string): Promise<void> {
    await fs.rm(path.join(this.root, 'presets', `${safeFileName(name)}.json`), { force: true })
  }

  /* ----------------------------- persona ----------------------------- */

  async putPersona(persona: Persona, avatar?: Uint8Array): Promise<void> {
    await this.writeAtomic(path.join(this.root, 'personas', `${safeFileName(persona.name)}.json`), jsonBytes(persona))
    if (avatar !== undefined) {
      await this.writeAtomic(path.join(this.root, 'personas', 'avatars', `${safeFileName(persona.name)}.png`), avatar)
    }
  }

  /**
   * 导入 persona PNG：内嵌 `chara`/`ccv3` 的 description 作为人设描述
   * （ST persona 导入行为），文件名 stem 作为 persona 名；头像原字节保存。
   */
  async importPersonaPng(bytes: Uint8Array, fallbackName: string): Promise<Persona> {
    let description = ''
    try {
      const card = decodeCharacterCard(bytes)
      description = card.data.description
    } catch {
      // 无内嵌卡数据：仅头像（ST 对无数据头像的行为）
    }
    const name = safeFileName(fallbackName) || 'Persona'
    const persona: Persona = { name, description, position: 0, hasAvatar: true }
    await this.putPersona(persona, bytes)
    return persona
  }

  async getPersonaAvatar(name: string): Promise<Uint8Array | undefined> {
    return this.tryRead(path.join(this.root, 'personas', 'avatars', `${safeFileName(name)}.png`))
  }

  async getPersona(name: string): Promise<Persona | undefined> {
    const bytes = await this.tryRead(path.join(this.root, 'personas', `${safeFileName(name)}.json`))
    if (bytes === undefined) return undefined
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as Persona
  }

  async listPersonas(): Promise<string[]> {
    const files = await this.listDir('personas')
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
  }

  async deletePersona(name: string): Promise<boolean> {
    let deleted = false
    const json = path.join(this.root, 'personas', `${safeFileName(name)}.json`)
    const avatar = path.join(this.root, 'personas', 'avatars', `${safeFileName(name)}.png`)
    try {
      await fs.unlink(json)
      deleted = true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
    await fs.rm(avatar, { force: true })
    return deleted
  }

  /* ------------------------------ 分支 ------------------------------ */

  /**
   * 从 messageId（含）截断复制为新聊天；chat_metadata.bookmark_link 记录回链。
   * 分支命名 `${stem} - branch N.jsonl`（N 递增至不冲突，字符集安全）。
   */
  async branchChat(
    characterName: string,
    chatId: string,
    messageId: number,
    expectedRevision?: string,
    name?: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ chatId: string; chat: ChatLogIR }> {
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const source = path.join(dir, safeChatFileName(chatId))
      await this.assertChatRevision(source, expectedRevision)
      const bytes = await this.tryRead(source)
      if (bytes === undefined) throw new Error(`chat '${chatId}' not found`)
      const log = parseChatLog(Buffer.from(bytes).toString('utf8'))
      if (messageId < 0 || messageId >= log.messages.length) {
        throw new Error(`branch messageId ${messageId} out of range (0..${log.messages.length - 1})`)
      }
      const branchMessages = log.messages.slice(0, messageId + 1).map((m) => ({ ...m }))
      const header = structuredClone(log.header)
      header.chat_metadata = {
        ...(header.chat_metadata ?? {}),
        bookmark_link: { character: characterName, chatId, messageId },
        ...(metadata ?? {}),
      }
      const stem = (name !== undefined && name.trim() !== ''
        ? name.trim()
        : chatId.replace(/\.jsonl$/i, '')).replace(/\.jsonl$/i, '')
      const safeStem = stem.replace(/[^A-Za-z0-9@ _.-]/g, '_').slice(0, 80) || 'chat'
      let nextId = `${safeStem} - branch 1.jsonl`
      let counter = 1
      while (await this.tryRead(path.join(dir, nextId)) !== undefined) {
        counter += 1
        nextId = `${safeStem} - branch ${counter}.jsonl`
      }
      const branchLog: ChatLogIR = { header, messages: branchMessages }
      await this.writeAtomic(path.join(dir, nextId), chatBytes(branchLog))
      await this.copyChatOverlay(this.chatWorldsFile(characterName, chatId), this.chatWorldsFile(characterName, nextId))
      await this.copyChatOverlay(this.chatScriptsFile(characterName, chatId), this.chatScriptsFile(characterName, nextId))
      return { chatId: nextId, chat: branchLog }
    })
  }

  /**
   * 宿主原生会话分叉的收养物化（decisions/2026-10-11-agent-tavern-host-fork）：
   * 克隆父聊天 header（guides / MVU 回执环随行），messages 置空——楼层由
   * AgentTavern 投影器从子会话事件回放回填，不复制父 JSONL（身份幂等键是
   * (子 sessionId, eventSeq)，复制会引入第二份身份语义）。chat_metadata 写
   * `agentTavernFork` 谱系标记（收养崩溃恢复的复用判据）与 `bookmark_link`
   * 回链（复用消息分支的元数据形状，client「↩ linked from」行同款消费）。
   * 命名 `${stem} - fork N.jsonl`（branchChat 同款字符集安全与递增规则）。
   */
  async forkChat(
    characterName: string,
    parentChatId: string,
    fork: { sessionId: string; parentSessionId: string; bookmarkMessageId?: number },
  ): Promise<{ chatId: string; chat: ChatLogIR }> {
    if (typeof fork.sessionId !== 'string' || fork.sessionId === ''
      || typeof fork.parentSessionId !== 'string' || fork.parentSessionId === '') {
      throw new Error('forkChat requires sessionId and parentSessionId')
    }
    return this.mutateChat(async () => {
      const dir = path.join(this.root, 'chats', safeFileName(characterName))
      const source = path.join(dir, safeChatFileName(parentChatId))
      const bytes = await this.tryRead(source)
      if (bytes === undefined) throw new Error(`chat '${parentChatId}' not found`)
      const log = parseChatLog(Buffer.from(bytes).toString('utf8'))
      const header = structuredClone(log.header)
      const messageId = typeof fork.bookmarkMessageId === 'number' && Number.isSafeInteger(fork.bookmarkMessageId)
        && fork.bookmarkMessageId >= 0 && fork.bookmarkMessageId < log.messages.length
        ? fork.bookmarkMessageId
        : Math.max(0, log.messages.length - 1)
      header.chat_metadata = {
        ...(header.chat_metadata ?? {}),
        bookmark_link: { character: characterName, chatId: parentChatId, messageId },
        agentTavernFork: { sessionId: fork.sessionId, parentSessionId: fork.parentSessionId },
      }
      const stem = parentChatId.replace(/\.jsonl$/i, '').replace(/\.jsonl$/i, '')
      const safeStem = stem.replace(/[^A-Za-z0-9@ _.-]/g, '_').slice(0, 80) || 'chat'
      let nextId = `${safeStem} - fork 1.jsonl`
      let counter = 1
      while (await this.tryRead(path.join(dir, nextId)) !== undefined) {
        counter += 1
        nextId = `${safeStem} - fork ${counter}.jsonl`
      }
      const forkLog: ChatLogIR = { header, messages: [] }
      await this.writeAtomic(path.join(dir, nextId), chatBytes(forkLog))
      await this.copyChatOverlay(this.chatWorldsFile(characterName, parentChatId), this.chatWorldsFile(characterName, nextId))
      await this.copyChatOverlay(this.chatScriptsFile(characterName, parentChatId), this.chatScriptsFile(characterName, nextId))
      return { chatId: nextId, chat: forkLog }
    })
  }

  /* ------------------------------ 状态 ------------------------------ */

  async getState(): Promise<TavernState> {
    await this.stateMutationTail.catch(() => {})
    return this.readState()
  }

  async patchState(patch: Partial<TavernState>): Promise<TavernState> {
    return this.updateState(() => patch)
  }

  async updateState(update: (state: TavernState) => Partial<TavernState>): Promise<TavernState> {
    return this.mutateState(async () => {
      const current = await this.readState()
      const next = { ...current, ...update(structuredClone(current)) }
      await this.writeAtomic(path.join(this.root, 'state.json'), jsonBytes(next))
      return next
    })
  }

  /** 解析 regex 脚本并合并进全局状态（scriptName 相同即覆盖）；返回导入的脚本数。 */
  async importRegexScripts(input: unknown): Promise<number> {
    const imported = parseRegexScripts(input)
    if (imported.length === 0) return 0
    await this.updateState((current) => ({
      regexScripts: mergeRegexScripts(current.regexScripts, imported),
    }))
    return imported.length
  }

  /**
   * 从已导入角色卡回填卡内嵌 regex_scripts（导入时自动物化上线前的存量卡）：
   * 只补全局列表缺少的 scriptName，已存在的脚本保持原样；同名跨卡按角色名
   * 排序先到先得；单条非法只跳过该条。返回本次扫描与写入计数。
   */
  async backfillRegexScriptsFromCharacters(): Promise<RegexBackfillReceipt> {
    const names = await this.listCharacters()
    const known = new Set((await this.getState()).regexScripts.map((script) => script.scriptName))
    const counters: RegexBackfillCounters = { skipped: 0, invalid: 0 }
    const pending: RegexScriptIR[] = []
    for (const name of names) {
      let file: CharacterFile | undefined
      try {
        file = await this.getCharacter(name)
      } catch (cause) {
        throw new Error(`failed to read character '${name}' for regex backfill: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
      if (file === undefined) continue
      const embedded = file.card.data.extensions['regex_scripts']
      if (embedded === undefined || embedded === null) continue
      pending.push(...stageRegexBackfillEntries(embedded, known, counters))
    }
    return await this.commitRegexBackfill(pending, counters, names.length)
  }

  /**
   * 从已导入预设回填 extensions.regex_scripts（ST preset-scoped regex 的落盘
   * 位置）：同角色卡回填语义——只补缺、跨预设先到先得、单条容错、一次写盘。
   */
  async backfillRegexScriptsFromPresets(): Promise<RegexBackfillReceipt> {
    const names = await this.listPresets()
    const known = new Set((await this.getState()).regexScripts.map((script) => script.scriptName))
    const counters: RegexBackfillCounters = { skipped: 0, invalid: 0 }
    const pending: RegexScriptIR[] = []
    for (const name of names) {
      let preset: Record<string, unknown> | undefined
      try {
        preset = await this.getPreset(name)
      } catch (cause) {
        throw new Error(`failed to read preset '${name}' for regex backfill: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
      }
      if (preset === undefined) continue
      const embedded = presetExtensions(preset)['regex_scripts']
      if (embedded === undefined || embedded === null) continue
      pending.push(...stageRegexBackfillEntries(embedded, known, counters))
    }
    return await this.commitRegexBackfill(pending, counters, names.length)
  }

  /** 回填收口：一次写盘，只追加状态里仍缺的 scriptName（并发导入时不重复）。 */
  private async commitRegexBackfill(
    pending: RegexScriptIR[],
    counters: RegexBackfillCounters,
    scanned: number,
  ): Promise<RegexBackfillReceipt> {
    if (pending.length === 0) {
      return { imported: 0, skipped: counters.skipped, invalid: counters.invalid, scanned }
    }
    let imported = 0
    await this.updateState((current) => {
      const existing = new Set(current.regexScripts.map((script) => script.scriptName))
      const additions = pending.filter((script) => {
        if (existing.has(script.scriptName)) return false
        existing.add(script.scriptName)
        return true
      })
      imported = additions.length
      return { regexScripts: [...current.regexScripts, ...additions] }
    })
    return { imported, skipped: counters.skipped + pending.length - imported, invalid: counters.invalid, scanned }
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async readState(): Promise<TavernState> {
    const bytes = await this.tryRead(path.join(this.root, 'state.json'))
    if (bytes === undefined) return structuredClone(DEFAULT_STATE)
    // 旧 state.json 可能残留已下线的 text-completion 管线字段（pipelineMode/
    // textCompletion，含 Kobold 端点与密钥），读取时丢弃，下次写盘即清除。
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<TavernState> & {
      pipelineMode?: unknown
      textCompletion?: unknown
    }
    const { pipelineMode: _legacyPipelineMode, textCompletion: _legacyTextCompletion, ...rest } = parsed
    return {
      ...structuredClone(DEFAULT_STATE),
      ...rest,
      activeWorlds: parsed.activeWorlds ?? [],
      sessionBindings: normalizeSessionBindings(parsed.sessionBindings),
      defaultArchitecture: parsed.defaultArchitecture === 'st' ? 'st' : 'agent-tavern',
      defaultContextMode: parsed.defaultContextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
      agentTavernPreloadAssets: parsed.agentTavernPreloadAssets === true,
      agentTavernAllowGlobalWrites: parsed.agentTavernAllowGlobalWrites === true,
      frontendAutoOpen: parsed.frontendAutoOpen === true,
      cardScriptsAutoRun: parsed.cardScriptsAutoRun === true,
      frontendAllowExternalResources: parsed.frontendAllowExternalResources === true,
      gamesDisableResign: parsed.gamesDisableResign === true,
      cardWorkbenchPresetEnabled: parsed.cardWorkbenchPresetEnabled === true,
      agentNovelPresetEnabled: parsed.agentNovelPresetEnabled === true,
      worldFollowsCharacter: parsed.worldFollowsCharacter !== false,
      modelSelections: parsed.modelSelections ?? {},
      chats: parsed.chats ?? {},
      regexScripts: parsed.regexScripts ?? [],
      scriptGlobals: parsed.scriptGlobals ?? {},
      characterVariables: normalizeCharacterVariables(parsed.characterVariables),
      frontendStorage: normalizeFrontendStorage(parsed.frontendStorage),
      compaction: normalizeCompactionOverride(parsed.compaction),
      // Mod 三层开关的前两层（提案 0015 §3.2）：双默认 false，只有显式 true 才开。
      modsEnabled: parsed.modsEnabled === true,
      mods: { enabled: normalizeModEnables(parsed.mods) },
      memoryEmbedding: normalizeMemoryEmbedding(parsed.memoryEmbedding),
    }
  }

  private async assertChatRevision(file: string, expectedRevision?: string): Promise<void> {
    if (expectedRevision === undefined) return
    const current = await this.tryRead(file)
    const actualRevision = current === undefined ? undefined : chatRevision(current)
    if (actualRevision !== expectedRevision) {
      throw new ChatRevisionConflictError(expectedRevision, actualRevision)
    }
  }

  private mutateChat<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chatMutationTail.catch(() => {}).then(operation)
    this.chatMutationTail = result.then(() => {}, () => {})
    return result
  }

  private chatWorldsFile(characterName: string, chatId: string): string {
    return path.join(this.root, 'chats', safeFileName(characterName), `${safeChatFileName(chatId)}.worlds.json`)
  }

  private chatScriptsFile(characterName: string, chatId: string): string {
    return path.join(this.root, 'chats', safeFileName(characterName), `${safeChatFileName(chatId)}.scripts.json`)
  }

  private async readChatWorlds(file: string): Promise<ChatWorldsFile> {
    const bytes = await this.tryRead(file)
    return bytes === undefined ? { version: 1, worlds: {} } : parseChatWorldsFile(file, bytes)
  }

  /** Copies a session overlay file to a new chat (branch/fork inheritance). */
  private async copyChatOverlay(from: string, to: string): Promise<void> {
    const bytes = await this.tryRead(from)
    if (bytes === undefined) return
    await this.writeAtomic(to, bytes)
  }

  /** Moves a session overlay file with its chat; an existing target is dropped. */
  private async moveChatOverlay(from: string, to: string): Promise<void> {
    await fs.rm(to, { force: true })
    if (await this.tryRead(from) !== undefined) await fs.rename(from, to)
  }

  private mutateState<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateMutationTail.catch(() => {}).then(operation)
    this.stateMutationTail = result.then(() => {}, () => {})
    return result
  }

  private async listDir(dir: string): Promise<string[]> {
    try {
      return await fs.readdir(path.join(this.root, dir))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }

  private async tryRead(file: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await fs.readFile(file))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    }
  }

  private async writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    await writeAtomicBytes(file, bytes)
  }
}

/**
 * Normalizes persisted bindings at the read seam. Bindings from before the
 * architecture split are ST sessions so an upgrade cannot silently change
 * their generation semantics. Unsupported group AgentTavern bindings also
 * fail closed to ST until actor metadata exists in the host event stream.
 */
export function normalizeTavernSessionBinding(value: unknown): TavernSessionBinding | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  // AgentNovel bindings are identified by novelId alone (proposal 0005 §4.2);
  // the legacy character/chatId fields are compatibility-only and may be
  // empty strings, so this branch must run before their presence checks.
  if (candidate.architecture === 'agent-novel') {
    if (typeof candidate.novelId !== 'string' || candidate.novelId.trim() === '') return undefined
    return {
      character: typeof candidate.character === 'string' ? candidate.character : '',
      chatId: typeof candidate.chatId === 'string' ? candidate.chatId : '',
      architecture: 'agent-novel',
      novelId: candidate.novelId,
    }
  }
  // CardWorkbench bindings（提案 0013）与 agent-novel 同理：character/chatId
  // 为空串，必须在非空存在性检查之前识别，否则会被降级成 st 绑定。
  // sourceCharacter/sourceChatId 缺失（旧数据）时补空串 = 自由工作台；
  // createdCard 同理补空串 = 尚未出卡。title 只接受非空字符串（空串/畸形
  // 视为未显式改名，回落派生标签）。
  if (candidate.architecture === 'card-workbench') {
    return {
      character: typeof candidate.character === 'string' ? candidate.character : '',
      chatId: typeof candidate.chatId === 'string' ? candidate.chatId : '',
      architecture: 'card-workbench',
      sourceCharacter: typeof candidate.sourceCharacter === 'string' ? candidate.sourceCharacter : '',
      sourceChatId: typeof candidate.sourceChatId === 'string' ? candidate.sourceChatId : '',
      createdCard: typeof candidate.createdCard === 'string' ? candidate.createdCard : '',
      ...(typeof candidate.title === 'string' && candidate.title.trim() !== '' ? { title: candidate.title } : {}),
    }
  }
  if (typeof candidate.character !== 'string' || candidate.character.trim() === '') return undefined
  if (typeof candidate.chatId !== 'string' || candidate.chatId.trim() === '') return undefined
  const base = {
    character: candidate.character,
    chatId: candidate.chatId,
    ...(candidate.group === true ? { group: true as const } : {}),
  }
  if (candidate.architecture === 'agent-tavern' && base.group !== true) {
    return {
      ...base,
      architecture: 'agent-tavern',
      contextMode: candidate.contextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
      ...(candidate.initializationPending === true ? { initializationPending: true } : {}),
    }
  }
  return { ...base, architecture: 'st' }
}

function normalizeSessionBindings(value: unknown): Record<string, TavernSessionBinding> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .map(([sessionId, binding]) => [sessionId, normalizeTavernSessionBinding(binding)] as const)
    .filter((entry): entry is readonly [string, TavernSessionBinding] => entry[1] !== undefined))
}

/** 压缩覆盖只接受成对的非空 provider/model；其余形状一律视为未设置。 */
function normalizeCompactionOverride(value: unknown): TavernCompactionOverride | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const provider = (value as Record<string, unknown>).curatorProvider
  const model = (value as Record<string, unknown>).curatorModel
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  if (provider.trim() === '' || model.trim() === '') return undefined
  return { curatorProvider: provider, curatorModel: model }
}

/** 从 regex 来源回填时的逐条计数（skipped = 已存在/跨来源重名）。 */
interface RegexBackfillCounters {
  skipped: number
  invalid: number
}

export interface RegexBackfillReceipt {
  imported: number
  skipped: number
  invalid: number
  scanned: number
}

/** 预设扩展袋（ST preset extension 的读写位置）；非对象按空袋处理。 */
function presetExtensions(preset: Record<string, unknown>): Record<string, unknown> {
  const extensions = preset['extensions']
  return typeof extensions === 'object' && extensions !== null && !Array.isArray(extensions)
    ? extensions as Record<string, unknown>
    : {}
}

/**
 * 展开一个来源的内嵌 regex 条目并逐条解析：已存在的 scriptName 计入 skipped，
 * 非法条目计入 invalid，不中断同源其余条目。
 */
function stageRegexBackfillEntries(
  embedded: unknown,
  known: Set<string>,
  counters: RegexBackfillCounters,
): RegexScriptIR[] {
  let entries: unknown[]
  try {
    entries = listRegexScriptEntries(embedded)
  } catch {
    counters.invalid += 1
    return []
  }
  const staged: RegexScriptIR[] = []
  entries.forEach((entry, index) => {
    let script: RegexScriptIR
    try {
      script = parseRegexScript(entry, index)
    } catch {
      counters.invalid += 1
      return
    }
    if (known.has(script.scriptName)) {
      counters.skipped += 1
      return
    }
    known.add(script.scriptName)
    staged.push(script)
  })
  return staged
}

/** 按 scriptName 合并脚本；同名覆盖，新名追加（保持既有顺序）。 */
function mergeRegexScripts(current: RegexScriptIR[], imported: RegexScriptIR[]): RegexScriptIR[] {
  const merged = [...current]
  for (const script of imported) {
    const index = merged.findIndex((item) => item.scriptName === script.scriptName)
    if (index >= 0) merged[index] = script
    else merged.push(script)
  }
  return merged
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : '_unnamed'
}

/** Session world overlay file: `{ version: 1, worlds: { [worldName]: WorldBookIR } }`. */
interface ChatWorldsFile {
  version: 1
  worlds: Record<string, WorldBookIR>
}

/**
 * Parses the per-chat world overlay. A corrupted file must fail loudly with its
 * path: silently falling back to the base world would make scripts believe their
 * writes landed while the chat keeps reading different lore.
 */
function parseChatWorldsFile(file: string, bytes: Uint8Array): ChatWorldsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (cause) {
    throw new Error(`chat world book file is not valid JSON: ${file}`, { cause })
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed['worlds'])) {
    throw new Error(`chat world book file has an invalid shape (expected { version, worlds }): ${file}`)
  }
  const worlds: Record<string, WorldBookIR> = {}
  for (const [name, raw] of Object.entries(parsed['worlds'])) {
    if (!isPlainRecord(raw) || !Array.isArray(raw['entries'])) {
      throw new Error(`chat world book '${name}' has an invalid shape (expected { name, entries: [] }): ${file}`)
    }
    const entries = raw['entries'].map((entry: unknown, index: number) => {
      if (!isPlainRecord(entry)) {
        throw new Error(`chat world book '${name}' entry ${index} must be an object: ${file}`)
      }
      return normalizeEntry(entry)
    })
    worlds[name] = {
      name,
      entries,
      ...(isPlainRecord(raw['extra']) ? { extra: raw['extra'] } : {}),
    }
  }
  return { version: 1, worlds }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Session script-tree overlay: `{ version: 1, scriptTrees: unknown[] }`. */
interface ChatScriptsFile {
  version: 1
  scriptTrees: unknown[]
}

/**
 * Parses the per-chat script-tree overlay. Corrupted JSON or a non-array node
 * list fails loudly with its path: silently falling back to the card original
 * would hide the fact that a GM-panel edit was lost.
 */
function parseChatScriptsFile(file: string, bytes: Uint8Array): ChatScriptsFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (cause) {
    throw new Error(`chat script tree file is not valid JSON: ${file}`, { cause })
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed['scriptTrees'])) {
    throw new Error(`chat script tree file has an invalid shape (expected { version, scriptTrees: [] }): ${file}`)
  }
  const scriptTrees = parsed['scriptTrees'].map((node, index) => {
    if (!isPlainRecord(node)) {
      throw new Error(`chat script tree file node ${index} must be an object: ${file}`)
    }
    return node
  })
  return { version: 1, scriptTrees }
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h ${pad(d.getMinutes())}m ${pad(d.getSeconds())}s ${pad(d.getMilliseconds(), 3)}ms`
}

function safeChatFileName(name: string): string {
  if (!/^[A-Za-z0-9@ _.-]+\.jsonl$/.test(name) || name.includes('..')) throw new Error('invalid chat id')
  return name
}

function chatBytes(log: ChatLogIR): Uint8Array {
  return new Uint8Array(Buffer.from(serializeChatLog(log), 'utf8'))
}

function chatRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url')
}

function jsonBytes(obj: unknown): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify(obj, null, 2), 'utf8'))
}
