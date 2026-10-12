/**
 * 混合记忆检索编排（提案 0016）：dense（cosine）+ 词法双通道 RRF 融合。
 *
 * 词法通道完全复用 MemoryStore.search 现状打分（token 匹配率×100 +
 * importance×10 + confidence×5 + freshness），dense 通道只改变排序不改变打分
 * ——importance/confidence/freshness 经由词法通道继续生效。融合在插件层做
 * （MemoryStore 保持纯词法，retrieval-matrix.spec.ts 的质量门槛原样绿）。
 *
 * 降级矩阵（返回 undefined = 调用方回落现状词法路径，逐字节等价）：
 * - 无配置 / 熔断打开 / 查询 embed 失败 → undefined；
 * - 有配置但候选集无任何新鲜向量（全部 stale/缺失且回填失败）→ undefined；
 * - 部分记录无向量 → 该记录只走词法通道，其余正常融合。
 *
 * 回填纪律：检索时发现 stale/缺失向量且熔断闭合 → 请求前批量回填，单次检索
 * 最多 HYBRID_BACKFILL_LIMIT 条（防首搜卡死）；回填失败走熔断，本次检索照常
 * 用已有新鲜向量融合。
 */

import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  memoryContentDigest,
  rrfFuse,
  type MemoryEmbeddingSettings,
  type MemoryHit,
  type MemoryScope,
  type MemoryStore,
  type MemoryVectorEntry,
  type MemoryVectorStore,
} from '../../tavern-store/src/index.js'
import {
  EMBED_INPUT_MAX_CHARS,
  embedBreakerOpen,
  embedModelIdentity,
  embedTexts,
  expectedDims,
  memoizedQueryVector,
  readEmbedStatus,
  recordEmbedFailure,
  recordEmbedSuccess,
  storeMemoizedQueryVector,
} from './memory-embed.js'
import type { LocalEmbedRuntime } from './memory-embed-local.js'

/** 单次检索的懒回填上限。 */
export const HYBRID_BACKFILL_LIMIT = 32
/** 词法候选池：每 scope 取 MemoryStore 上限（MAX_RESULTS=50）。 */
export const HYBRID_POOL_PER_SCOPE = 50

// RRF_K / rrfFuse / cosineSimilarity 与离线评测（scripts/retrieval-eval）同源：
// tavern-store/src/memory-vectors.ts（提案 0016 §5 融合原语单一来源）。

export interface HybridScope {
  scope: MemoryScope
  scopeId: string
}

export interface HybridSearchInput {
  /** tavern 根目录（状态 sidecar 所在地）。 */
  root: string
  config: MemoryEmbeddingSettings
  store: MemoryStore
  vectorStore: MemoryVectorStore
  query: string
  scopes: readonly HybridScope[]
  limit: number
  maxTokens: number
  /** 测试注入口。 */
  fetchImpl?: typeof fetch
  /** 测试注入口（provider='local' 时的假运行时）。 */
  localRuntime?: LocalEmbedRuntime
}

/**
 * 混合检索主流程（见文件头降级矩阵）。返回 undefined 表示本次应回落纯词法。
 * 命中的 score 字段保持词法分（输出语义不变），排序由 RRF 接管。
 */
export async function hybridMemorySearch(input: HybridSearchInput): Promise<MemoryHit[] | undefined> {
  const { root, config, store, vectorStore, query, scopes, limit, maxTokens, fetchImpl, localRuntime } = input
  const status = await readEmbedStatus(root)
  if (embedBreakerOpen(status)) return undefined
  // 向量空间身份（本地形态 = local-onnx:<basename>@<指纹>，提案 0017）。
  const modelId = embedModelIdentity(config)

  // 查询向量（进程内 memoize）。失败 ⇒ 熔断开窗 + 本次纯词法。
  let queryVector = memoizedQueryVector(config, query)
  if (queryVector === undefined) {
    try {
      const [vector] = await embedTexts(config, [query], { expectedDims: expectedDims(config, status), fetchImpl, localRuntime })
      if (vector === undefined) return undefined
      queryVector = vector
      storeMemoizedQueryVector(config, query, vector)
      // 成功即复位（breakerUntil=0）并记录 lastSuccessAt/dims 基准。
      await recordEmbedSuccess(root, { model: modelId, dims: vector.length })
    } catch (cause) {
      await recordEmbedFailure(root, cause instanceof Error ? cause.message : String(cause))
      return undefined
    }
  }

  // 词法候选池：每 scope 满 limit 取（无 maxTokens——预算在融合后统一施加）。
  const pool = (await Promise.all(scopes.map(({ scope, scopeId }) =>
    store.search({ query, scope, scopeId, limit: HYBRID_POOL_PER_SCOPE }),
  ))).flat()
  pool.sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
  const lexicalRank = new Map(pool.map((hit, index) => [hit.record.id, index]))

  // 向量新鲜度：entry.model + digest 与当前身份及全文 content 一致才算新鲜。
  const entries = new Map<string, MemoryVectorEntry>()
  for (const { scope, scopeId } of scopes) {
    for (const entry of await vectorStore.list(scope, scopeId)) {
      entries.set(vectorKey(entry.scope, entry.scopeId, entry.id), entry)
    }
  }
  const fresh = new Map<string, string>() // id → base64 vector
  const stale: typeof pool = []
  for (const hit of pool) {
    const entry = entries.get(vectorKey(hit.record.scope, hit.record.scopeId, hit.record.id))
    if (entry !== undefined && entry.model === modelId
      && entry.digest === memoryContentDigest(modelId, hit.record.content)) {
      fresh.set(hit.record.id, entry.vector)
    } else {
      stale.push(hit)
    }
  }

  // 懒回填（熔断闭合时）：按词法序补最前面的 HYBRID_BACKFILL_LIMIT 条。
  if (stale.length > 0) {
    const targets = stale.slice(0, HYBRID_BACKFILL_LIMIT)
    try {
      const vectors = await embedTexts(
        config,
        targets.map((hit) => hit.record.content.slice(0, EMBED_INPUT_MAX_CHARS)),
        { expectedDims: queryVector?.length, fetchImpl, localRuntime },
      )
      await vectorStore.put(targets.map((hit, index) => ({
        id: hit.record.id,
        scope: hit.record.scope,
        scopeId: hit.record.scopeId,
        digest: memoryContentDigest(modelId, hit.record.content),
        model: modelId,
        vector: encodeVector(vectors[index] ?? []),
      })))
      targets.forEach((hit, index) => {
        if (vectors[index] !== undefined) fresh.set(hit.record.id, encodeVector(vectors[index]!))
      })
    } catch (cause) {
      // 回填失败走熔断；已有新鲜向量照常参与本次融合。
      await recordEmbedFailure(root, cause instanceof Error ? cause.message : String(cause))
    }
  }

  if (fresh.size === 0) return undefined // 全部 stale/缺失 → 逐字节回落现状

  // dense 通道：新鲜向量按 cosine 降序（id 升序稳定并列）。
  const denseOrder = [...fresh.entries()]
    .map(([id, base64]) => ({ id, similarity: cosineSimilarity(queryVector!, decodeVector(base64)) }))
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
  const rrf = rrfFuse(
    pool.map((hit) => hit.record.id),
    denseOrder.map((item) => item.id),
  )

  // 融合序：rrf 降序 → 词法名次 → id（全确定性）。
  const ordered = pool.slice().sort((left, right) => {
    const rrfLeft = rrf.get(left.record.id) ?? 0
    const rrfRight = rrf.get(right.record.id) ?? 0
    if (rrfLeft !== rrfRight) return rrfRight - rrfLeft
    return (lexicalRank.get(left.record.id) ?? 0) - (lexicalRank.get(right.record.id) ?? 0)
      || left.record.id.localeCompare(right.record.id)
  }).slice(0, limit)

  return applyTokenBudget(ordered, maxTokens)
}

/** 写路径嵌入：memory_write / memory_update 落盘成功后调用。失败不抛（调用方
 *  工具返回不受阻塞），错误已落 lastError + 熔断；返回是否落盘成功。 */
export async function embedMemoryRecord(input: {
  root: string
  config: MemoryEmbeddingSettings
  vectorStore: MemoryVectorStore
  record: { id: string; scope: MemoryScope; scopeId: string; content: string }
  fetchImpl?: typeof fetch
  localRuntime?: LocalEmbedRuntime
}): Promise<boolean> {
  const { root, config, vectorStore, record, fetchImpl, localRuntime } = input
  const status = await readEmbedStatus(root)
  if (embedBreakerOpen(status)) return false
  const modelId = embedModelIdentity(config)
  try {
    const [vector] = await embedTexts(
      config,
      [record.content.slice(0, EMBED_INPUT_MAX_CHARS)],
      { expectedDims: expectedDims(config, status), fetchImpl, localRuntime },
    )
    if (vector === undefined) return false
    await recordEmbedSuccess(root, { model: modelId, dims: vector.length })
    await vectorStore.put([{
      id: record.id,
      scope: record.scope,
      scopeId: record.scopeId,
      digest: memoryContentDigest(modelId, record.content),
      model: modelId,
      vector: encodeVector(vector),
    }])
    return true
  } catch (cause) {
    await recordEmbedFailure(root, cause instanceof Error ? cause.message : String(cause))
    return false
  }
}

function vectorKey(scope: MemoryScope, scopeId: string, id: string): string {
  return `${scope}\u0000${scopeId}\u0000${id}`
}

/** 跨 scope 的 token 预算（与 MemoryStore.search 的逐条预算算法同款：装满即止，
 *  最后一条装不下按剩余预算截断）。 */
function applyTokenBudget(hits: readonly MemoryHit[], maxTokens: number): MemoryHit[] {
  const result: MemoryHit[] = []
  let used = 0
  for (const hit of hits) {
    const words = Math.max(1, Math.ceil(hit.record.content.length / 4))
    if (used + words <= maxTokens) {
      used += words
      result.push(hit)
      continue
    }
    const remaining = Math.max(0, maxTokens - used)
    if (remaining === 0) break
    result.push({
      ...hit,
      record: { ...hit.record, content: hit.record.content.slice(0, Math.max(1, remaining * 4)).trimEnd() },
      truncated: true,
    })
    break
  }
  return result
}
