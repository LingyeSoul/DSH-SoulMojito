/**
 * B-5a 受控中文记忆检索评测矩阵 —— 质量门槛 spec（决策 2026-10-11-retrieval-eval-matrix）。
 *
 * 与 scripts/retrieval-eval/run.mjs 共用同一语料生成器（corpus.mjs）与同一指标实现
 * （metrics.mjs），但本 spec 从 src 直接 import MemoryStore（不走构建产物），
 * 两条路径互相锚定。基线数字写死于下方 BASELINE：未来任何检索改动（含 B-2 dense
 * 检索）使总体 recall/MRR 退化即本测试红；语料本身任何改动先撞 CORPUS_HASH 冻结
 * 门槛——改语料必须重跑 runner、更新哈希与基线，避免「调语料凑数字」的静默漂移。
 *
 * v1 覆盖面：MemoryStore.search（词法 bigram + 先验）。tavern_history_search 的
 * 分级匹配在 plugin 内部闭包、不可独立 import，不在本矩阵内（见 decision 文档边界）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/index.js'
import { ANCHOR_TIME, DIMENSIONS, buildCorpus, corpusHash, corpusStats } from '../../../scripts/retrieval-eval/corpus.mjs'
import { seedStore } from '../../../scripts/retrieval-eval/seed.mjs'
import { aggregate, runMatrix } from '../../../scripts/retrieval-eval/metrics.mjs'

/** 语料规范哈希（冻结）。改动语料 = 有意重基线：重跑 run.mjs，更新此值与 BASELINE。 */
const CORPUS_HASH = '3419b1badafe343fd6d9959b1c81675529a399a94887d302d6c1d9897f1ffa7f'

/**
 * 基线（生成于 2026-10-11，B-1 CJK 分词 @ commit 0bac59a，node scripts/retrieval-eval/run.mjs）。
 * 阈值取实测值下取整（系统确定性，实测可精确复现；留 ≤0.01 余量防浮点抖动）。
 */
const BASELINE = {
  overall: { recall3: 0.9, recall10: 0.97, mrr: 0.87 },
  byWorld: {
    modern: { recall10: 0.97, mrr: 0.87 },
    fantasy: { recall10: 0.96, mrr: 0.87 },
  },
  /** B-1 的核心承诺：自然语言中文查询必召回直接事实记忆（实测 1.0000，零余量）。 */
  directFactRecall10: 1,
}

describe('语料生成器：确定性与结构自检', () => {
  it('零随机：两次构建逐字节一致，且哈希等于冻结值', () => {
    const first = buildCorpus()
    const second = buildCorpus()
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(corpusHash(second)).toBe(CORPUS_HASH)
  })

  it('结构自检：11 维 × 2 世界 × ≥3 例，期望 id 全部存在，时间戳全部钉在锚点', () => {
    const corpus = buildCorpus()
    const stats = corpusStats(corpus)
    expect(stats.records).toBe(130)
    expect(stats.cases).toBe(66)
    expect(Object.keys(DIMENSIONS)).toHaveLength(11)
    for (const world of corpus.worlds) {
      expect(world.cases).toHaveLength(33)
      for (const dimension of Object.keys(DIMENSIONS)) {
        expect(world.cases.filter((item: { dimension: string }) => item.dimension === dimension).length).toBeGreaterThanOrEqual(3)
      }
    }
    for (const record of corpus.records) {
      expect(record.createdAt).toBe(ANCHOR_TIME)
      expect(record.updatedAt).toBe(ANCHOR_TIME)
    }
  })
})

describe('检索质量门槛：MemoryStore.search 对受控中文矩阵（基线 2026-10-11）', () => {
  let dir: string
  let aggregateResult: ReturnType<typeof aggregate>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'retrieval-matrix-'))
    const corpus = buildCorpus()
    await seedStore(corpus, dir)
    const store = await MemoryStore.open(dir)
    const rows = await runMatrix(corpus, async (query: string) => {
      const hits = await store.search({ query, limit: 50 })
      return hits.map((hit) => ({ id: hit.record.id, score: hit.score }))
    })
    aggregateResult = aggregate(rows)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('总体 recall@3 / recall@10 / MRR 不低于基线', () => {
    expect(aggregateResult.overall.scoredCases).toBe(64)
    expect(aggregateResult.overall.abstainCases).toBe(2)
    expect(aggregateResult.overall.recall3).toBeGreaterThanOrEqual(BASELINE.overall.recall3)
    expect(aggregateResult.overall.recall10).toBeGreaterThanOrEqual(BASELINE.overall.recall10)
    expect(aggregateResult.overall.mrr).toBeGreaterThanOrEqual(BASELINE.overall.mrr)
  })

  it('两世界分别不低于各自基线（防单世界塌陷被总体均值掩盖）', () => {
    for (const [world, baseline] of Object.entries(BASELINE.byWorld) as [string, { recall10: number; mrr: number }][]) {
      const summary = aggregateResult.byWorld[world]
      expect(summary, `世界 ${world} 缺少汇总`).toBeDefined()
      expect(summary!.recall10).toBeGreaterThanOrEqual(baseline.recall10)
      expect(summary!.mrr).toBeGreaterThanOrEqual(baseline.mrr)
    }
  })

  it('直接事实维度 recall@10 = 1：B-1 分词修复的核心承诺', () => {
    for (const world of ['modern', 'fantasy']) {
      const summary = aggregateResult.byWorldDimension[`${world}/direct-fact`]
      expect(summary!.recall10).toBe(BASELINE.directFactRecall10)
    }
  })
})
