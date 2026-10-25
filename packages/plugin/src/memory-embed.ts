/**
 * 记忆语义检索 embed 运行时（提案 0016；提案 0017 扩本地 ONNX provider）：
 * 远程 OpenAI 兼容 /embeddings 客户端 + 本地 transformers.js 分发 + 熔断 +
 * 运行状态 sidecar。零新增打包依赖（global fetch + 运行时动态 import）。
 *
 * 跨 bundle 注意：index.mjs（HTTP 管理路由）与 agent.mjs（记忆工具）是两个
 * 独立 esbuild bundle，本模块会被内联两份——模块级内存（查询 memo/本地模型
 * 会话）只在各自 bundle 内生效，可共享的运行时状态（lastError/lastSuccessAt/
 * dims/熔断窗口）一律走 `<tavern>/memory-vectors/status.json` 文件 sidecar，
 * 原子写，最后写者胜（对熔断语义最坏影响是另一 bundle 多做一次注定失败的尝试）。
 *
 * key 纪律：配置只存 env 变量名（apiKeyEnv），解析时读 process.env；空值/未设
 * ⇒ 免密反代（不发送 Authorization 头）。key 永不写入日志、审计或接口响应。
 *
 * 失败纪律（LWB 参考语义，不抄代码）：429/5xx/网络错误/超时 → 短退避后重试
 * 一次；整体失败 → lastError + 熔断 60s（期间检索自动纯词法）；成功即复位。
 * 本地 provider 失败（运行时未装/模型不可加载/推理异常）同走熔断与 lastError，
 * 不重试（失败是确定性的，重试只白费模型加载时间）。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { writeAtomicText, type MemoryEmbeddingLocalSettings, type MemoryEmbeddingSettings } from '../../tavern-store/src/index.js'
import { defaultLocalEmbedRuntime, loadLocalEmbedModel, localModelIdentity, type LocalEmbedRuntime } from './memory-embed-local.js'

/** 熔断窗口：一次整体失败后 60s 内不再尝试任何 embed 请求。 */
export const EMBED_BREAKER_MS = 60_000
/** 重试退避（单次，固定短退避；重试至多一次）。 */
export const EMBED_RETRY_BACKOFF_MS = 250
/** 嵌入输入截断上限：memory content 可达 64KB，主流 embed 端点输入上限约 8k
 * token；截断只影响向量输入，digest 仍按全文计算（stale 判定不受影响）。 */
export const EMBED_INPUT_MAX_CHARS = 6000
/** 探针固定串（POST …/memory/embed/test）。 */
export const EMBED_PROBE_TEXT = 'dsh-soulmojito embed probe'
/** 查询向量进程内 memo 上限（LRU 式 FIFO 淘汰）。 */
const QUERY_MEMO_LIMIT = 32

export interface EmbedRuntimeStatus {
  version: 1
  /** 最近一次成功时的配置 model（dims 归属的向量空间身份）。 */
  model?: string
  /** 首次成功观察到的维度（config.dims 缺省时的一致性基准）。 */
  dims?: number
  lastError?: string
  lastErrorAt?: string
  lastSuccessAt?: string
  /** epoch ms；Date.now() < breakerUntil 视为熔断打开。 */
  breakerUntil: number
}

export type EmbedFailureKind = 'timeout' | 'network' | 'http' | 'payload' | 'dims' | 'runtime'

function emptyStatus(): EmbedRuntimeStatus {
  return { version: 1, breakerUntil: 0 }
}

export class EmbedHttpError extends Error {
  constructor(
    readonly kind: EmbedFailureKind,
    message: string,
    /** HTTP 状态码（kind=http 时存在）。 */
    readonly status?: number,
    /** 该失败是否值得重试（429/5xx/网络/超时）。 */
    readonly retriable: boolean = false,
  ) {
    super(message)
    this.name = 'EmbedHttpError'
  }
}

/** 状态 sidecar 路径（与 MemoryVectorStore 同目录）。 */
export function embedStatusPath(root: string): string {
  return path.join(root, 'memory-vectors', 'status.json')
}

export async function readEmbedStatus(root: string): Promise<EmbedRuntimeStatus> {
  try {
    const parsed = JSON.parse(await fs.readFile(embedStatusPath(root), 'utf8')) as Partial<EmbedRuntimeStatus>
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStatus()
    return {
      version: 1,
      ...(typeof parsed.model === 'string' && parsed.model !== '' ? { model: parsed.model } : {}),
      ...(typeof parsed.dims === 'number' && Number.isFinite(parsed.dims) && parsed.dims > 0 ? { dims: parsed.dims } : {}),
      ...(typeof parsed.lastError === 'string' && parsed.lastError !== '' ? { lastError: parsed.lastError } : {}),
      ...(typeof parsed.lastErrorAt === 'string' ? { lastErrorAt: parsed.lastErrorAt } : {}),
      ...(typeof parsed.lastSuccessAt === 'string' ? { lastSuccessAt: parsed.lastSuccessAt } : {}),
      breakerUntil: typeof parsed.breakerUntil === 'number' && Number.isFinite(parsed.breakerUntil) ? parsed.breakerUntil : 0,
    }
  } catch {
    return emptyStatus()
  }
}

export async function writeEmbedStatus(root: string, status: EmbedRuntimeStatus): Promise<void> {
  await fs.mkdir(path.dirname(embedStatusPath(root)), { recursive: true })
  await writeAtomicText(embedStatusPath(root), `${JSON.stringify(status)}\n`)
}

export function embedBreakerOpen(status: EmbedRuntimeStatus, now = Date.now()): boolean {
  return now < status.breakerUntil
}

/** 失败落账：lastError + 熔断开窗（读改写，跨 bundle 最后写者胜）。 */
export async function recordEmbedFailure(root: string, message: string): Promise<void> {
  const status = await readEmbedStatus(root)
  await writeEmbedStatus(root, {
    ...status,
    lastError: message.slice(0, 300),
    lastErrorAt: new Date().toISOString(),
    breakerUntil: Date.now() + EMBED_BREAKER_MS,
  })
}

/** 成功复位：熔断关闭、记录 lastSuccessAt 与观察到的 model/dims；lastError
 *  保留为历史诊断信息（GET 状态接口带 lastErrorAt 一并展示）。 */
export async function recordEmbedSuccess(root: string, info: { model: string; dims: number }): Promise<void> {
  const status = await readEmbedStatus(root)
  await writeEmbedStatus(root, {
    ...status,
    model: info.model,
    dims: info.dims,
    lastSuccessAt: new Date().toISOString(),
    breakerUntil: 0,
  })
}

/** 配置变更（PUT memory/embed）后清空运行状态：新端点/新模型的 dims 基准与
 *  熔断窗口不再沿用旧配置的观察值。 */
export async function clearEmbedStatus(root: string): Promise<void> {
  await fs.rm(embedStatusPath(root), { force: true })
}

/** 免密语义：apiKeyEnv 为空、未设或 env 值为空/空白 ⇒ 不发送 Authorization。
 *  本地 provider 无 key 概念，恒 undefined。 */
export function resolveApiKey(config: MemoryEmbeddingSettings): string | undefined {
  if (config.provider === 'local') return undefined
  if (config.apiKeyEnv === '') return undefined
  const value = process.env[config.apiKeyEnv]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 向量空间身份：远程形态 = 配置 model；本地形态 = `local-onnx:<basename>@<指纹>`
 *  （提案 0017——目录内容变化 ⇒ 身份变化 ⇒ 向量 stale ⇒ 懒重嵌）。 */
export function embedModelIdentity(config: MemoryEmbeddingSettings): string {
  if (config.provider === 'local') return localModelIdentity(config)
  return config.model
}

/** 维度一致性基准：配置 dims 优先，缺省回落首次成功记录的 dims。 */
export function expectedDims(config: MemoryEmbeddingSettings, status: EmbedRuntimeStatus): number | undefined {
  return config.dims ?? status.dims
}

export interface EmbedTextsOptions {
  /** 与响应比对的一致性维度（缺省不比对，仅要求批内一致）。 */
  expectedDims?: number
  /** 测试注入口；缺省 global fetch（仅远程 provider 使用）。 */
  fetchImpl?: typeof fetch
  /** 测试注入口；缺省懒解析 transformers.js（仅本地 provider 使用）。 */
  localRuntime?: LocalEmbedRuntime
}

/**
 * 批量嵌入（provider 分发）：远程形态按 batchSize 分批顺序请求，每批超时
 * timeoutMs、429/5xx/网络错/超时重试一次（短退避），响应校验 data[].embedding
 * 维度一致且等于期望维度；本地形态按 batchSize 分批顺序推理（无网络语义：
 * 不重试不超时），输出校验与远程同款。任何一批最终失败即整体抛 EmbedHttpError
 * （调用方负责熔断落账）。
 */
export async function embedTexts(
  config: MemoryEmbeddingSettings,
  texts: readonly string[],
  options: EmbedTextsOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return []
  if (config.provider === 'local') return embedTextsLocal(config, texts, options)
  const batchSize = config.batchSize ?? 16
  const timeoutMs = config.timeoutMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? fetch
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize)
    vectors.push(...await embedBatchWithRetry(config, batch, { ...options, timeoutMs, fetchImpl }))
  }
  return vectors
}

/** 本地形态嵌入：失败不重试（确定性失败），dims 校验与远程同语义。 */
async function embedTextsLocal(
  config: MemoryEmbeddingLocalSettings,
  texts: readonly string[],
  options: EmbedTextsOptions,
): Promise<number[][]> {
  let model
  try {
    model = await loadLocalEmbedModel(config, options.localRuntime ?? defaultLocalEmbedRuntime)
  } catch (cause) {
    throw new EmbedHttpError(
      'runtime',
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      false,
    )
  }
  const batchSize = config.batchSize ?? 16
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize)
    let embedded: number[][]
    try {
      embedded = await model.embed(batch)
    } catch (cause) {
      throw new EmbedHttpError(
        'runtime',
        cause instanceof Error ? cause.message : String(cause),
        undefined,
        false,
      )
    }
    if (embedded.length !== batch.length) {
      throw new EmbedHttpError(
        'payload',
        `local embed returned ${embedded.length} vectors for ${batch.length} inputs`,
        undefined,
        false,
      )
    }
    vectors.push(...validateLocalVectors(embedded, options.expectedDims))
  }
  return vectors
}

/** 批内有限数值 + 维度一致 + 期望维度比对（parseEmbeddings 的本地同款纪律）。 */
function validateLocalVectors(embedded: readonly number[][], expectedDims: number | undefined): number[][] {
  if (embedded.length === 0) {
    throw new EmbedHttpError('payload', 'local embed returned no vectors', undefined, false)
  }
  const dims = embedded[0]?.length ?? 0
  if (dims === 0 || embedded.some((vector) => vector.length !== dims)) {
    throw new EmbedHttpError(
      'dims',
      `local embed dimensions inconsistent (batch dims: ${embedded.map((vector) => vector.length).join(',')})`,
      undefined,
      false,
    )
  }
  for (const vector of embedded) {
    if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbedHttpError('payload', 'local embed vector is not a finite number array', undefined, false)
    }
  }
  if (expectedDims !== undefined && dims !== expectedDims) {
    throw new EmbedHttpError('dims', `local embed has ${dims} dims, expected ${expectedDims}`, undefined, false)
  }
  return [...embedded]
}

async function embedBatchWithRetry(
  config: MemoryEmbeddingSettings,
  batch: readonly string[],
  options: { expectedDims?: number; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<number[][]> {
  let lastError: EmbedHttpError
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await embedBatchOnce(config, batch, options)
    } catch (cause) {
      const error = cause instanceof EmbedHttpError ? cause
        : new EmbedHttpError('network', cause instanceof Error ? cause.message : String(cause), undefined, true)
      lastError = error
      if (!error.retriable || attempt >= 2) throw lastError
      await delay(EMBED_RETRY_BACKOFF_MS)
    }
  }
}

async function embedBatchOnce(
  config: MemoryEmbeddingSettings,
  batch: readonly string[],
  options: { expectedDims?: number; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<number[][]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  let response: Response
  if (config.provider === 'local') throw new Error('local memory embedding does not use the HTTP embeddings endpoint')
  try {
    response = await options.fetchImpl(`${config.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 免密反代：无 key 时不带 Authorization 头（不是带空串）。
        ...(resolveApiKey(config) !== undefined ? { authorization: `Bearer ${resolveApiKey(config)}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input: batch }),
      signal: controller.signal,
    })
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new EmbedHttpError('timeout', `embed request timed out after ${options.timeoutMs}ms`, undefined, true)
    }
    throw new EmbedHttpError('network', cause instanceof Error ? cause.message : String(cause), undefined, true)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const retriable = response.status === 429 || response.status >= 500
    const detail = await response.text().then((text) => text.slice(0, 200)).catch(() => '')
    throw new EmbedHttpError(
      'http',
      `embed endpoint returned ${response.status}${detail === '' ? '' : `: ${detail}`}`,
      response.status,
      retriable,
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (cause) {
    throw new EmbedHttpError('payload', `embed response is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return parseEmbeddings(payload, batch.length, options.expectedDims)
}

function parseEmbeddings(payload: unknown, count: number, expectedDims: number | undefined): number[][] {
  if (payload === null || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new EmbedHttpError('payload', 'embed response has no data array')
  }
  const data = (payload as { data: unknown[] }).data
  if (data.length !== count) {
    throw new EmbedHttpError('payload', `embed response count mismatch: sent ${count}, received ${data.length}`)
  }
  const items = data.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new EmbedHttpError('payload', 'embed response item is not an object')
    }
    return item as { index?: unknown; embedding?: unknown }
  })
  // OpenAI 兼容端点按 index 标序；全部带数字 index 时按 index 排序对齐输入序。
  const ordered = items.every((item) => typeof item.index === 'number')
    ? items.slice().sort((left, right) => (left.index as number) - (right.index as number))
    : items
  const vectors = ordered.map((item) => {
    if (!Array.isArray(item.embedding) || item.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new EmbedHttpError('payload', 'embed response embedding is not a finite number array')
    }
    return item.embedding as number[]
  })
  const dims = vectors[0]?.length ?? 0
  if (dims === 0 || vectors.some((vector) => vector.length !== dims)) {
    throw new EmbedHttpError('dims', `embed response dimensions inconsistent (batch dims: ${vectors.map((vector) => vector.length).join(',')})`)
  }
  if (expectedDims !== undefined && dims !== expectedDims) {
    throw new EmbedHttpError('dims', `embed response has ${dims} dims, expected ${expectedDims}`)
  }
  return vectors
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------- 查询向量进程内 memo ------------------------- */

const queryVectorMemo = new Map<string, number[]>()

function memoKey(config: MemoryEmbeddingSettings, query: string): string {
  // 本地形态直接以向量空间身份（目录|指纹|池化|量化精度）做 memo 锚：换模型
  // 文件（指纹变化）、换池化或换精度档（不同向量空间）后旧查询向量自动失效，
  // 不会把旧空间的 memo 喂进新空间的 cosine 排序。身份与落库 digest/model 同源
  // （localModelIdentity），单一事实来源。
  if (config.provider === 'local') {
    return `local\u0000${localModelIdentity(config)}\u0000${query}`
  }
  return `${config.baseURL}\u0000${config.model}\u0000${query}`
}

export function memoizedQueryVector(config: MemoryEmbeddingSettings, query: string): number[] | undefined {
  const key = memoKey(config, query)
  const vector = queryVectorMemo.get(key)
  if (vector === undefined) return undefined
  // 触碰顺序（FIFO 淘汰的近似 LRU）。
  queryVectorMemo.delete(key)
  queryVectorMemo.set(key, vector)
  return vector
}

export function storeMemoizedQueryVector(config: MemoryEmbeddingSettings, query: string, vector: number[]): void {
  const key = memoKey(config, query)
  queryVectorMemo.delete(key)
  queryVectorMemo.set(key, vector)
  while (queryVectorMemo.size > QUERY_MEMO_LIMIT) {
    const oldest = queryVectorMemo.keys().next().value
    if (oldest === undefined) break
    queryVectorMemo.delete(oldest)
  }
}

/* ------------------------------- 探针 ------------------------------- */

export interface EmbedProbeResult {
  dims: number
  latencyMs: number
  model: string
}

/**
 * 连通性探针（POST …/memory/embed/test）：固定串嵌入（本地形态走本地推理，
 * 首次探针含模型加载耗时）。显式用户动作——无视熔断直接尝试；成功即复位熔断，
 * 失败照常开窗（lastError 可供状态接口回显）。
 */
export async function embedProbe(
  root: string,
  config: MemoryEmbeddingSettings,
  options: EmbedTextsOptions = {},
): Promise<EmbedProbeResult> {
  const status = await readEmbedStatus(root)
  const startedAt = Date.now()
  const model = embedModelIdentity(config)
  try {
    const [vector] = await embedTexts(config, [EMBED_PROBE_TEXT], {
      ...options,
      expectedDims: expectedDims(config, status),
    })
    const dims = vector?.length ?? 0
    const result: EmbedProbeResult = { dims, latencyMs: Date.now() - startedAt, model }
    await recordEmbedSuccess(root, { model, dims })
    return result
  } catch (cause) {
    // 探针失败照常开窗落账（任何调用方都看得到 lastError/熔断状态）。
    await recordEmbedFailure(root, cause instanceof Error ? cause.message : String(cause))
    throw cause
  }
}
