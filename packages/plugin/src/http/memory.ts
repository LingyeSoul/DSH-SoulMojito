import { resolve } from 'node:path'
import {
  LOCAL_EMBED_PRECISIONS,
  MEMORY_EMBED_ENV_NAME,
  normalizeEmbedBaseURL,
  normalizeMemoryEmbedding,
  type TavernStore,
} from '../../../tavern-store/src/index.js'
import { dshHomePath } from '../dsh-home.js'
import { clearEmbedStatus, embedBreakerOpen, embedProbe, readEmbedStatus } from '../memory-embed.js'
import { detectLocalQuantizations, inferLocalModelSettings, installLocalEmbedRuntime, isLocalEmbedRuntimeInstalled, validateLocalModelDir } from '../memory-embed-local.js'
import { MaintenanceRunConflictError, memoryMaintenanceStatus, startMemoryMaintenance, type MemoryMaintenanceDeps } from '../memory-maintenance.js'
import { memories, memoryVectors } from '../runtime.js'
import { readJson, sendJson } from './io.js'
import { readGuidesSnapshot } from './panel.js'
import type { NovelApiRequest, NovelApiResponse } from './novel.js'

/* ---------- 记忆语义检索 embed 管理面（提案 0016 §配置面） ---------- */

/**
 * GET/PUT memory/embed + POST memory/embed/test。状态响应只带脱敏运行时信息
 * （configured/envResolvable/lastError/lastSuccessAt/dims/熔断窗），配置里的
 * apiKeyEnv 只是 env 变量名引用——key 明文既不落库也永不回传（解析只发生在
 * 请求发出的瞬间，且仅进 Authorization 头）。
 */
/** 面板一键安装的单飞守卫（进程内；安装是唯一写方，无需跨 bundle 共享）。 */
let localRuntimeInstallInFlight: Promise<unknown> | undefined

export async function handleMemoryEmbedApi(
  req: NovelApiRequest,
  res: NovelApiResponse,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  const root = dshHomePath('tavern')

  if (method === 'GET' && route === 'memory/embed') {
    const config = normalizeMemoryEmbedding((await db.getState()).memoryEmbedding)
    const status = await readEmbedStatus(root)
    const isLocal = config?.provider === 'local'
    const endpoint = config !== undefined && config.provider !== 'local' ? config : undefined
    const envValue = endpoint !== undefined && endpoint.apiKeyEnv !== '' ? process.env[endpoint.apiKeyEnv] : undefined
    return sendJson(res, 200, {
      ok: true,
      config: config ?? null,
      status: {
        configured: config !== undefined,
        provider: isLocal ? 'local' : 'openai',
        // 免密（apiKeyEnv 空串）是显式合法形态：envResolvable 视为满足；本地
        // provider 无 key 概念，keyless/envResolvable 恒真。
        keyless: isLocal === true || (endpoint !== undefined && endpoint.apiKeyEnv === ''),
        envResolvable: isLocal === true
          || (endpoint !== undefined
            && (endpoint.apiKeyEnv === '' || (typeof envValue === 'string' && envValue.trim() !== ''))),
        ...(isLocal === true ? { runtimeInstalled: isLocalEmbedRuntimeInstalled() } : {}),
        breakerOpen: embedBreakerOpen(status),
        ...(status.breakerUntil > 0 ? { breakerUntil: new Date(status.breakerUntil).toISOString() } : {}),
        ...(status.model !== undefined ? { model: status.model } : {}),
        ...(status.dims !== undefined ? { dims: status.dims } : {}),
        ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
        ...(status.lastErrorAt !== undefined ? { lastErrorAt: status.lastErrorAt } : {}),
        ...(status.lastSuccessAt !== undefined ? { lastSuccessAt: status.lastSuccessAt } : {}),
      },
    })
  }

  if (method === 'PUT' && route === 'memory/embed') {
    const body = await readJson(req)
    const raw: Record<string, unknown> = body === null || typeof body !== 'object' || Array.isArray(body) ? {} : body

    // 本地 ONNX 形态（提案 0017）：modelDir 实存校验 + resolve 成绝对路径存储
    // （嵌入发生在未来的任意 CWD 下，相对路径必须在此刻钉死）。空 modelDir 与
    // 三件套全空同义 = 清除配置。
    if (raw.provider === 'local') {
      const modelDirRaw = typeof raw.modelDir === 'string' ? raw.modelDir.trim() : ''
      if (modelDirRaw === '') {
        await db.patchState({ memoryEmbedding: undefined })
        await clearEmbedStatus(root)
        return sendJson(res, 200, { ok: true, config: null })
      }
      const modelDir = resolve(modelDirRaw)
      const dirProblem = validateLocalModelDir(modelDir)
      if (dirProblem !== null) {
        return sendJson(res, 400, { ok: false, message: dirProblem })
      }
      // pooling 非法值 fail-fast：normalize 会静默丢弃，用户会误以为已生效。
      if (raw.pooling !== undefined && raw.pooling !== null && raw.pooling !== 'cls' && raw.pooling !== 'mean') {
        return sendJson(res, 400, {
          ok: false,
          message: `invalid pooling '${String(raw.pooling).slice(0, 30)}': expected 'cls' or 'mean' (cls is the BERT/bge default; sentence-embedding models like MiniLM need 'mean')`,
        })
      }
      // precision 非法值同款 fail-fast（'auto' 或缺省 = 按目录识别优先链）。
      if (raw.precision !== undefined && raw.precision !== null && raw.precision !== ''
        && !(LOCAL_EMBED_PRECISIONS as readonly unknown[]).includes(raw.precision)) {
        return sendJson(res, 400, {
          ok: false,
          message: `invalid precision '${String(raw.precision).slice(0, 30)}': expected 'auto' or one of ${LOCAL_EMBED_PRECISIONS.filter((value) => value !== 'auto').join(', ')}`,
        })
      }
      // 小白项自动补全（提案 0017 §自动填充）：pooling/dims 缺省时按模型目录
      // 推断（modules.json → config.json → 模型族启发），响应回报每项来源供
      // 面板提示；显式提供的值永远优先。
      const inferred = inferLocalModelSettings(modelDir)
      const explicitPooling = raw.pooling === 'cls' || raw.pooling === 'mean'
      const explicitDims = typeof raw.dims === 'number' && Number.isFinite(raw.dims)
      const explicitPrecision = raw.precision !== undefined && raw.precision !== null && raw.precision !== ''
      const config = normalizeMemoryEmbedding({
        provider: 'local',
        modelDir,
        ...((explicitPooling ? raw.pooling : inferred.pooling) !== undefined
          ? { pooling: (explicitPooling ? raw.pooling : inferred.pooling) as 'cls' | 'mean' }
          : {}),
        ...(explicitPrecision ? { precision: raw.precision } : {}),
        ...((explicitDims ? raw.dims : inferred.dims) !== undefined
          ? { dims: (explicitDims ? raw.dims : inferred.dims) as number }
          : {}),
        ...(raw.batchSize !== undefined && raw.batchSize !== null ? { batchSize: raw.batchSize } : {}),
      })
      if (config === undefined) {
        return sendJson(res, 400, {
          ok: false,
          message: 'expected { provider: \'local\', modelDir, pooling? (\'cls\'|\'mean\'), precision? (\'auto\'|\'fp32\'|\'fp16\'|\'q8\'|…), dims?, batchSize? (1-64) }',
        })
      }
      const autoFilled: Record<string, { value: number | 'cls' | 'mean'; source: string }> = {}
      if (!explicitPooling && config.pooling !== undefined) {
        autoFilled.pooling = { value: config.pooling, source: inferred.sources.pooling ?? 'default (cls)' }
      }
      if (!explicitDims && config.dims !== undefined) {
        autoFilled.dims = { value: config.dims, source: inferred.sources.dims ?? '' }
      }
      await db.patchState({ memoryEmbedding: config })
      // 配置变更 ⇒ 旧端点观察到的 dims 基准、熔断窗口与错误记录全部作废。
      await clearEmbedStatus(root)
      return sendJson(res, 200, {
        ok: true,
        config,
        ...(Object.keys(autoFilled).length > 0 ? { inferred: autoFilled } : {}),
      })
    }

    const baseURL = typeof raw.baseURL === 'string' ? normalizeEmbedBaseURL(raw.baseURL) : ''
    const apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim() : ''
    const model = typeof raw.model === 'string' ? raw.model.trim() : ''
    // 三件套全空 = 清除配置（混合检索整体回落纯词法）。
    if (baseURL === '' && apiKeyEnv === '' && model === '') {
      await db.patchState({ memoryEmbedding: undefined })
      await clearEmbedStatus(root)
      return sendJson(res, 200, { ok: true, config: null })
    }
    // POSIX env 名前置校验（给出比 normalize 落空更可操作的报错文案；模式与
    // normalizeMemoryEmbedding 同源导出，两处不得漂移）。
    if (apiKeyEnv !== '' && !MEMORY_EMBED_ENV_NAME.test(apiKeyEnv)) {
      return sendJson(res, 400, {
        ok: false,
        message: `invalid apiKeyEnv '${apiKeyEnv.slice(0, 60)}': expected a POSIX environment variable name (letters, digits, underscore; not starting with a digit), or an empty string for a keyless endpoint`,
      })
    }
    const config = normalizeMemoryEmbedding({
      baseURL,
      apiKeyEnv,
      model,
      ...(raw.dims !== undefined && raw.dims !== null ? { dims: raw.dims } : {}),
      ...(raw.batchSize !== undefined && raw.batchSize !== null ? { batchSize: raw.batchSize } : {}),
      ...(raw.timeoutMs !== undefined && raw.timeoutMs !== null ? { timeoutMs: raw.timeoutMs } : {}),
    })
    if (config === undefined) {
      return sendJson(res, 400, {
        ok: false,
        message: 'expected { baseURL (http/https URL), model, apiKeyEnv? (env var name or empty), dims?, batchSize? (1-64), timeoutMs? (200-120000) }',
      })
    }
    await db.patchState({ memoryEmbedding: config })
    // 配置变更 ⇒ 旧端点观察到的 dims 基准、熔断窗口与错误记录全部作废。
    await clearEmbedStatus(root)
    return sendJson(res, 200, { ok: true, config })
  }

  if (method === 'POST' && route === 'memory/embed/local/install') {
    // 面板一键安装运行时（提案 0017 §安装面；2026-10-12 用户决策）：在 profile
    // 根跑 pnpm add（执行纪律镜像自更新 apply.ts 的 runCapture——流式输出、超时
    // kill）。link:/源码挂载拒绝（profile 根与插件目录分离，自动装会写错地方）。
    // 成功即同进程生效（运行时按 URL 动态 import，无需重启），探针可立即验证。
    if (localRuntimeInstallInFlight !== undefined) {
      return sendJson(res, 409, { ok: false, message: 'a local runtime install is already in progress' })
    }
    const installPromise = installLocalEmbedRuntime({ pluginDir: import.meta.dirname })
    localRuntimeInstallInFlight = installPromise
    try {
      const outcome = await installPromise
      if (!outcome.ok) {
        return sendJson(res, 400, {
          ok: false,
          message: outcome.message ?? 'install failed',
          ...(outcome.outputTail !== '' ? { outputTail: outcome.outputTail } : {}),
        })
      }
      return sendJson(res, 200, {
        ok: true,
        alreadyInstalled: outcome.alreadyInstalled,
        ...(outcome.message !== undefined ? { message: outcome.message } : {}),
        ...(outcome.outputTail !== '' ? { outputTail: outcome.outputTail } : {}),
      })
    } finally {
      localRuntimeInstallInFlight = undefined
    }
  }

  if (method === 'POST' && route === 'memory/embed/local/quantizations') {
    // 量化精度识别（2026-10-13，只读端点）：扫描模型目录的 onnx/ 子目录，回报
    // 可加载的精度档位（transformers.js 的 model${后缀}.onnx 布局，含文件大小）
    // 与 auto 推荐档。目录不存在/布局不对按 400 报可操作错误（与 PUT 同款文案）。
    const body = await readJson(req)
    const modelDirRaw = body !== null && typeof body === 'object' && !Array.isArray(body)
      && typeof (body as Record<string, unknown>).modelDir === 'string'
      ? ((body as Record<string, unknown>).modelDir as string).trim()
      : ''
    if (modelDirRaw === '') {
      return sendJson(res, 400, { ok: false, message: 'expected { modelDir }' })
    }
    const modelDir = resolve(modelDirRaw)
    const dirProblem = validateLocalModelDir(modelDir)
    if (dirProblem !== null) {
      return sendJson(res, 400, { ok: false, message: dirProblem })
    }
    const quantizations = detectLocalQuantizations(modelDir)
    return sendJson(res, 200, {
      ok: true,
      modelDir,
      quantizations,
      // auto 档会实际加载的档位（优先链最高档；目录检不出时缺省——运行时走
      // 旧 try 链兜底，面板如实显示「自动」不带推荐）。
      ...(quantizations[0] !== undefined ? { recommended: quantizations[0].precision } : {}),
    })
  }

  if (method === 'POST' && route === 'memory/embed/test') {
    const config = normalizeMemoryEmbedding((await db.getState()).memoryEmbedding)
    if (config === undefined) return sendJson(res, 400, { ok: false, message: 'embed endpoint is not configured' })
    try {
      // 探针是显式用户动作：无视熔断直接尝试；成功/失败都在 embedProbe 内落账。
      const result = await embedProbe(root, config)
      return sendJson(res, 200, { ok: true, ...result })
    } catch (cause) {
      return sendJson(res, 400, { ok: false, message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

/* ---------- B-3 记忆维护 run 管理面（LWB maintenance 的 dsh 化） ---------- */

/**
 * `POST memory/maintenance {character, chatId}` → `{ok, runId}`（wait:false 风格，
 * run 在本进程后台执行，不因浏览器断开中断）；同 scope 已有在跑 run 时 409。
 * `GET memory/maintenance?character&chatId` → `{status: 'running'|'done'|'error',
 * startedAt, finishedAt?, summary, pending, receipts}`（summary 含处理楼面范围、
 * 编辑组数、合并/修正/删除计数、失败计数与退役结果；细粒度收尾 outcome 在
 * summary 里——预算耗尽是纪律内收尾不是 error）。
 */
export async function handleMemoryMaintenanceApi(
  ctx,
  req: NovelApiRequest,
  res: NovelApiResponse,
  url: URL,
  route: string,
  method: string,
  db: TavernStore,
): Promise<void> {
  if (method === 'POST') {
    const body = await readJson(req)
    if (typeof body.character !== 'string' || typeof body.chatId !== 'string'
      || body.character === '' || body.chatId === '') {
      return sendJson(res, 400, { ok: false, message: 'expected { character, chatId }' })
    }
    // 与 guides 路由同款：store 的 chat 文件名校验错误按「聊天不存在」应答。
    const snapshot = await readGuidesSnapshot(db, body.character, body.chatId)
    if (snapshot === undefined) {
      return sendJson(res, 404, { ok: false, message: `chat '${body.character}/${body.chatId}' not found` })
    }
    try {
      const { runId } = await startMemoryMaintenance(ctx, maintenanceDeps(db), {
        character: body.character,
        chatId: body.chatId,
      })
      return sendJson(res, 200, { ok: true, runId })
    } catch (cause) {
      if (cause instanceof MaintenanceRunConflictError) {
        return sendJson(res, 409, { ok: false, message: cause.message, code: cause.code, runId: cause.runId })
      }
      throw cause
    }
  }

  if (method === 'GET') {
    const character = url.searchParams.get('character')
    const chatId = url.searchParams.get('chatId')
    if (character === null || chatId === null || character === '' || chatId === '') {
      return sendJson(res, 400, { ok: false, message: 'character and chatId query params are required' })
    }
    const view = await memoryMaintenanceStatus(maintenanceDeps(db), { character, chatId })
    return sendJson(res, 200, { ok: true, ...view })
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}

/** 维护 run 依赖面：全部走 memoized 实例（单写者纪律）。 */
function maintenanceDeps(db: TavernStore): MemoryMaintenanceDeps {
  return {
    root: dshHomePath('tavern'),
    db,
    memory: memories(),
    vectors: memoryVectors(),
  }
}
