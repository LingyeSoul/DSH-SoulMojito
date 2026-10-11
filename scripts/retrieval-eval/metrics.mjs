/* B-5a 检索评测指标（纯函数，无状态、无随机）。
 *
 * 指标定义（对齐 LWB gold-eval lib/metrics 的口径，仅取词法检索面所需子集）：
 * - rank：search 返回列表的 1-based 序位（runner/spec 以 limit=50 上限调用，
 *   MemoryStore.search 的 MAX_RESULTS=50，rank>50 不可观测，按 miss 计）。
 * - recall@k（用例级）= |expected ∩ top-k| / |expected|；多期望用例在 k=1 时
 *   天然拿不到 1.0，属指标定义而非缺陷。
 * - MRR（用例级）= 1 / 首条期望命中的 rank；无命中记 0。
 * - 期望集为空的用例（absent-info 纯缺失例）不进 recall/MRR 均值，单列为 abstain 例。
 * 聚合：总体 + 按维度 + 按世界（均值，4 位小数）。
 */

export const K_VALUES = Object.freeze([1, 3, 10])

/**
 * 跑完整矩阵。
 * @param {object} corpus buildCorpus() 的返回值
 * @param {(query: string) => Promise<Array<{id: string, score: number}>>} search
 *   适配器：把查询变成有序命中列表（由调用方选择接 lib 产物或 src 源码）。
 * @returns {Promise<Array<object>>} 每用例一行的明细
 */
export async function runMatrix(corpus, search) {
  const rows = []
  for (const item of corpus.cases) {
    const hits = await search(item.query)
    if (hits.length > 50) throw new Error(`metrics: search 返回 ${hits.length} 条，超过 MAX_RESULTS=50`)
    const rankById = new Map(hits.map((hit, index) => [hit.id, index + 1]))
    const recallAt = (k) => {
      if (item.expected.length === 0) return null
      const hitCount = item.expected.filter((id) => (rankById.get(id) ?? Number.POSITIVE_INFINITY) <= k).length
      return hitCount / item.expected.length
    }
    const expectedRanks = item.expected.map((id) => rankById.get(id) ?? null)
    const firstRank = expectedRanks.filter((rank) => rank !== null).sort((a, b) => a - b)[0] ?? null
    rows.push({
      case: item,
      abstain: item.expected.length === 0,
      recall1: recallAt(1),
      recall3: recallAt(3),
      recall10: recallAt(10),
      mrr: item.expected.length === 0 ? null : firstRank === null ? 0 : 1 / firstRank,
      firstRank,
      hitCount: expectedRanks.filter((rank) => rank !== null).length,
    })
  }
  return rows
}

const mean = (values) => {
  const nums = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return nums.length === 0 ? null : round4(nums.reduce((a, b) => a + b, 0) / nums.length)
}

const round4 = (value) => (Number.isFinite(value) ? Math.round(value * 10000) / 10000 : null)

function summarize(rows) {
  const scored = rows.filter((row) => !row.abstain)
  return {
    cases: rows.length,
    scoredCases: scored.length,
    abstainCases: rows.length - scored.length,
    recall1: mean(scored.map((row) => row.recall1)),
    recall3: mean(scored.map((row) => row.recall3)),
    recall10: mean(scored.map((row) => row.recall10)),
    mrr: mean(scored.map((row) => row.mrr)),
  }
}

/**
 * 汇总：overall / byDimension / byWorld / byWorldDimension。
 * @param {Array<object>} rows runMatrix 的返回值
 */
export function aggregate(rows) {
  const byDimension = {}
  const byWorld = {}
  const byWorldDimension = {}
  for (const row of rows) {
    const dim = row.case.dimension
    const world = row.case.world
    ;(byDimension[dim] ??= []).push(row)
    ;(byWorld[world] ??= []).push(row)
    ;(byWorldDimension[`${world}/${dim}`] ??= []).push(row)
  }
  return {
    overall: summarize(rows),
    byDimension: Object.fromEntries(Object.entries(byDimension).map(([key, list]) => [key, summarize(list)])),
    byWorld: Object.fromEntries(Object.entries(byWorld).map(([key, list]) => [key, summarize(list)])),
    byWorldDimension: Object.fromEntries(Object.entries(byWorldDimension).map(([key, list]) => [key, summarize(list)])),
  }
}
