/* B-5a 受控中文记忆检索评测 runner。
 *
 * 用法：node scripts/retrieval-eval/run.mjs                       # 词法基线（零网络）
 *       node scripts/retrieval-eval/run.mjs --dense \
 *         --base-url https://api.example.com/v1 --model <embed-model> \
 *         [--api-key-env MY_EMBED_KEY] [--dims 1536]              # 词法 vs 混合 A/B
 * 依赖：packages/tavern-store/lib 已构建（pnpm build / tsc -b）。runner 走构建产物，
 * 门槛 spec（packages/tavern-store/tests/retrieval-matrix.spec.ts）走 src 源码——
 * 两条路径共用同一语料与同一指标实现，互相锚定。
 *
 * 评测面：MemoryStore.search（tavern_history_search 的分级匹配闭包在 plugin 内部
 * 不可 import，v1 不覆盖，见 decision 文档边界记录）。
 *
 * --dense（提案 0016 §评测计划）：真实端点的离线 A/B——语料全量嵌入
 * MemoryVectorStore，逐用例嵌入查询串后按提案 0016 §5 的融合契约（词法池
 * limit=50、cosine 降序、双通道 RRF k=60、rrf→词法名次→id 排序）重排，输出
 * 词法/混合两张矩阵与逐维度 Δ。需要真实 embed 服务，不入 CI；融合逻辑是
 * plugin/src/memory-hybrid.ts 的忠实子集（无回填/熔断——离线一次性嵌入）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const libEntry = join(here, '..', '..', 'packages', 'tavern-store', 'lib', 'index.js')

if (!existsSync(libEntry)) {
  console.error(`构建产物缺失：${libEntry}\n先执行 pnpm build（tsc -b）。`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const denseMode = argv.includes('--dense')
const flag = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

const tavernStoreLib = await import(`file://${libEntry.replaceAll('\\', '/')}`)
const { MemoryStore, MemoryVectorStore, memoryContentDigest, encodeVector, decodeVector } = tavernStoreLib
const { buildCorpus, corpusHash, corpusStats, DIMENSIONS } = await import('./corpus.mjs')
const { runMatrix, aggregate } = await import('./metrics.mjs')
const { seedStore } = await import('./seed.mjs')

const corpus = buildCorpus()
const stats = corpusStats(corpus)
const hash = corpusHash(corpus)

const root = await mkdtemp(join(tmpdir(), 'retrieval-eval-'))
try {
  await seedStore(corpus, root)
  const store = await MemoryStore.open(root)
  const search = async (query) => {
    const hits = await store.search({ query, limit: 50 })
    return hits.map((hit) => ({ id: hit.record.id, score: hit.score }))
  }
  const rows = await runMatrix(corpus, search)
  const agg = aggregate(rows)
  printReport({ corpus, stats, hash, agg, rows })

  if (denseMode) await runDenseComparison({ corpus, store, root, lexicalAgg: agg })
} finally {
  await rm(root, { recursive: true, force: true })
}

/* ------------------------- --dense：混合检索 A/B（提案 0016） ------------------------- */

const DENSE_BATCH = 16
const DENSE_TIMEOUT_MS = 30_000
const RRF_K = 60

async function runDenseComparison({ corpus, store, root, lexicalAgg }) {
  const baseURL = (flag('base-url') ?? '').replace(/\/+$/, '')
  const model = flag('model') ?? ''
  const apiKeyEnv = flag('api-key-env') ?? ''
  const expectedDims = flag('dims') !== undefined ? Number(flag('dims')) : undefined
  if (baseURL === '' || model === '' || !/^https?:\/\//.test(baseURL)) {
    console.error('--dense 需要 --base-url（http/https）与 --model；可选 --api-key-env NAME、--dims N。')
    process.exit(2)
  }
  const apiKey = apiKeyEnv !== '' ? process.env[apiKeyEnv]?.trim() : undefined

  const embedAll = async (texts) => {
    const vectors = []
    for (let start = 0; start < texts.length; start += DENSE_BATCH) {
      const batch = texts.slice(start, start + DENSE_BATCH)
      vectors.push(...await embedBatch(batch))
    }
    return vectors
  }
  const embedBatch = async (batch) => {
    let lastError
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DENSE_TIMEOUT_MS)
      try {
        const response = await fetch(`${baseURL}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          body: JSON.stringify({ model, input: batch }),
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`embed endpoint returned ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`)
        const payload = await response.json()
        const data = payload?.data
        if (!Array.isArray(data) || data.length !== batch.length) throw new Error('embed response count mismatch')
        const ordered = data.every((item) => typeof item?.index === 'number') ? data.slice().sort((a, b) => a.index - b.index) : data
        const vectors = ordered.map((item) => {
          if (!Array.isArray(item?.embedding)) throw new Error('embed response embedding missing')
          return item.embedding
        })
        const dims = vectors[0].length
        if (vectors.some((vector) => vector.length !== dims)) throw new Error('embed response dims inconsistent')
        if (expectedDims !== undefined && dims !== expectedDims) throw new Error(`embed response has ${dims} dims, expected ${expectedDims}`)
        return vectors
      } catch (cause) {
        lastError = cause instanceof Error ? cause.message : String(cause)
        if (attempt >= 2) throw new Error(`embed failed: ${lastError}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error(`embed failed: ${lastError}`)
  }

  console.log(`\n== 混合检索 A/B（dense：${model} @ ${baseURL}${apiKeyEnv !== '' ? `, key: env ${apiKeyEnv}${apiKey ? '' : '（未设→免密）'}` : '，免密'}）==`)
  const vectors = await MemoryVectorStore.open(root)
  const contents = corpus.records.map((record) => record.content)
  const embedded = await embedAll(contents)
  await vectors.put(corpus.records.map((record, index) => ({
    id: record.id,
    scope: record.scope,
    scopeId: record.scopeId,
    digest: memoryContentDigest(model, record.content),
    model,
    vector: encodeVector(embedded[index]),
  })))
  const entries = await vectors.list()
  const byId = new Map(entries.map((entry) => [entry.id, entry]))

  const cosine = (a, b) => {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
  }
  const rrfFuse = (lexicalOrder, denseOrder) => {
    const scores = new Map()
    const add = (id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank))
    lexicalOrder.forEach((id, index) => add(id, index + 1))
    denseOrder.forEach((id, index) => add(id, index + 1))
    return scores
  }

  const hybridSearch = async (query) => {
    const [queryVector] = await embedAll([query])
    const pool = await store.search({ query, limit: 50 })
    pool.sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
    const lexicalRank = new Map(pool.map((hit, index) => [hit.record.id, index]))
    const dense = pool
      .filter((hit) => {
        const entry = byId.get(hit.record.id)
        return entry !== undefined && entry.model === model && entry.digest === memoryContentDigest(model, hit.record.content)
      })
      .map((hit) => ({ id: hit.record.id, similarity: cosine(queryVector, decodeVector(byId.get(hit.record.id).vector)) }))
      .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
    const fused = rrfFuse(pool.map((hit) => hit.record.id), dense.map((item) => item.id))
    return pool
      .slice()
      .sort((left, right) => (fused.get(right.record.id) ?? 0) - (fused.get(left.record.id) ?? 0)
        || lexicalRank.get(left.record.id) - lexicalRank.get(right.record.id)
        || left.record.id.localeCompare(right.record.id))
      .map((hit) => ({ id: hit.record.id, score: hit.score }))
  }

  const denseRows = await runMatrix(corpus, hybridSearch)
  const denseAgg = aggregate(denseRows)
  const delta = (a, b) => (b - a >= 0 ? '+' : '') + (b - a).toFixed(4)
  const header = ['指标', '词法', '混合（RRF k=60）', 'Δ']
  const widths = [16, 10, 18, 10]
  const line = (cells) => cells.map((cell, index) => String(cell ?? '-').padEnd(widths[index])).join(' │ ')
  console.log(`┌${'─'.repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1)}┐`)
  console.log(`│ ${line(header).padEnd(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 2)}│`)
  console.log(`├${'─'.repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1)}┤`)
  for (const metric of ['recall1', 'recall3', 'recall10', 'mrr']) {
    console.log(`│ ${line([metric, lexicalAgg.overall[metric].toFixed(4), denseAgg.overall[metric].toFixed(4), delta(lexicalAgg.overall[metric], denseAgg.overall[metric])]).padEnd(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 2)}│`)
  }
  console.log(`└${'─'.repeat(widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1)}┘`)
  console.log('逐维度 MRR（词法 → 混合）：')
  for (const slug of Object.keys(DIMENSIONS)) {
    const lexical = lexicalAgg.byDimension[slug]
    const dense = denseAgg.byDimension[slug]
    if (!lexical || !dense) continue
    console.log(`  ${DIMENSIONS[slug].padEnd(24)} ${lexical.mrr.toFixed(4)} → ${dense.mrr.toFixed(4)}  ${delta(lexical.mrr, dense.mrr)}`)
  }
}

function pad(value, width) {
  const text = value ?? '-'
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function fmtMetric(value) {
  return value === null || value === undefined ? '-' : value.toFixed(4)
}

function printReport({ stats, hash, agg, rows }) {
  console.log(`受控中文记忆检索评测矩阵（语料 v1，锚定时间 2026-10-01T00:00:00.000Z）`)
  console.log(`语料哈希 sha256:${hash}`)
  console.log(`规模：${stats.worlds.join(' + ')} 两世界同库，共 ${stats.records} 条记录 / ${stats.cases} 个用例（11 维度 × 每世界 3 例）`)
  console.log(`检索面：MemoryStore.search（词法 bigram + 先验，limit=50）\n`)

  const header = ['维度', '世界', 'n', 'r@1', 'r@3', 'r@10', 'MRR']
  const widths = [30, 8, 4, 8, 8, 8, 8]
  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index])).join(' │ ')
  const totalWidth = widths.reduce((a, b) => a + b, 0) + widths.length * 3 - 1

  console.log(`┌${'─'.repeat(totalWidth)}┐`)
  console.log(`│ ${line(header).padEnd(totalWidth - 1)}│`)
  console.log(`├${'─'.repeat(totalWidth)}┤`)

  const bodyRows = []
  for (const [slug, label] of Object.entries(DIMENSIONS)) {
    for (const world of stats.worlds) {
      const summary = agg.byWorldDimension[`${world}/${slug}`]
      if (!summary) continue
      bodyRows.push([
        label,
        world,
        String(summary.cases),
        fmtMetric(summary.recall1),
        fmtMetric(summary.recall3),
        fmtMetric(summary.recall10),
        fmtMetric(summary.mrr),
      ])
    }
    const dimSummary = agg.byDimension[slug]
    bodyRows.push([`${label}（合计）`, '*', String(dimSummary.cases), fmtMetric(dimSummary.recall1), fmtMetric(dimSummary.recall3), fmtMetric(dimSummary.recall10), fmtMetric(dimSummary.mrr)])
  }
  for (const row of bodyRows) console.log(`│ ${line(row).padEnd(totalWidth - 1)}│`)

  console.log(`├${'─'.repeat(totalWidth)}┤`)
  for (const world of stats.worlds) {
    const summary = agg.byWorld[world]
    console.log(`│ ${line([`世界合计：${world}`, '*', String(summary.cases), fmtMetric(summary.recall1), fmtMetric(summary.recall3), fmtMetric(summary.recall10), fmtMetric(summary.mrr)]).padEnd(totalWidth - 1)}│`)
  }
  const overall = agg.overall
  console.log(`│ ${line([`总体（含缺席例 ${overall.abstainCases} 条）`, '*', String(overall.cases), fmtMetric(overall.recall1), fmtMetric(overall.recall3), fmtMetric(overall.recall10), fmtMetric(overall.mrr)]).padEnd(totalWidth - 1)}│`)
  console.log(`└${'─'.repeat(totalWidth)}┘\n`)

  const worst = rows
    .filter((row) => !row.abstain)
    .sort((a, b) => (a.mrr - b.mrr) || (a.recall10 - b.recall10))
    .slice(0, 6)
  console.log('最弱用例（MRR 升序，词法上限定位）：')
  for (const row of worst) {
    console.log(`  ${row.case.id.padEnd(18)} MRR=${fmtMetric(row.mrr)} r@10=${fmtMetric(row.recall10)} 首中排名=${row.firstRank ?? '-'}  ${row.case.query}`)
  }
  console.log('')

  console.log('基线数字（写门槛 spec 用）：')
  console.log(JSON.stringify({
    corpusHash: hash,
    overall: { recall1: overall.recall1, recall3: overall.recall3, recall10: overall.recall10, mrr: overall.mrr },
    byWorld: Object.fromEntries(Object.entries(agg.byWorld).map(([world, summary]) => [world, { recall10: summary.recall10, mrr: summary.mrr }])),
  }, null, 2))
}
