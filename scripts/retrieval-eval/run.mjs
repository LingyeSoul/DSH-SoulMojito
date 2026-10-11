/* B-5a 受控中文记忆检索评测 runner。
 *
 * 用法：node scripts/retrieval-eval/run.mjs
 * 依赖：packages/tavern-store/lib 已构建（pnpm build / tsc -b）。runner 走构建产物，
 * 门槛 spec（packages/tavern-store/tests/retrieval-matrix.spec.ts）走 src 源码——
 * 两条路径共用同一语料与同一指标实现，互相锚定。
 *
 * 评测面：MemoryStore.search（tavern_history_search 的分级匹配闭包在 plugin 内部
 * 不可独立 import，v1 不覆盖，见 decision 文档边界记录）。
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

const { MemoryStore } = await import(`file://${libEntry.replaceAll('\\', '/')}`)
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
} finally {
  await rm(root, { recursive: true, force: true })
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
