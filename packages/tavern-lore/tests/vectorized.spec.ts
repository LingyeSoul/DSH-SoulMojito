/**
 * vectorized 世界书（Wave 2 契约 §2.6，Owner G）：
 * - vectorized && !constant 的条目**不参与关键词匹配**；
 * - 只有 `vectorHits`（引擎稳定 entryId 集合）命中才激活，reason 'vector'；
 * - `vectorHits` 未提供（无 embed/熔断/检索失败）⇒ 保持不激活，诊断
 *   'vector-unavailable'，绝不降级为关键词；
 * - `constant` 仍常驻（vectorized 不改变常驻语义）。
 * 全部夹具合成，不引用真实世界书素材。
 */
import { describe, expect, it } from 'vitest'
import { activateWorldInfo, type ActivationInput, type LoreEntry } from '../src/index.js'

const entry = (uid: number, over: Partial<LoreEntry> = {}): LoreEntry => ({
  uid,
  key: [`k${uid}`],
  content: `C${uid}`,
  ...over,
})

const run = (entries: LoreEntry[], over: Partial<ActivationInput> = {}) => activateWorldInfo({
  books: [{ name: 'book', entries }],
  chat: [{ content: 'k1 k2 k3' }],
  contextSize: 1000,
  settings: { scanDepth: 2, budgetPercent: 100 },
  rng: () => 0.25,
  countTokens: (text) => text.length,
  ...over,
})

describe('vectorized world info activation', () => {
  it('keyword matches do not activate a vectorized entry', () => {
    const result = run([entry(1, { vectorized: true })])
    expect(result.allActivated).toHaveLength(0)
    expect(result.diagnostics.entries['book.1']).toMatchObject({ activated: false, reason: 'vector-unavailable' })
  })

  it('vectorHits drives activation regardless of keys (reason: vector)', () => {
    const result = run([entry(1, { vectorized: true, key: ['never-mentioned'] })], {
      vectorHits: new Set(['book.1']),
    })
    expect(result.allActivated.map((activated) => activated.activationReason)).toEqual(['vector'])
    expect(result.diagnostics.entries['book.1']).toMatchObject({ activated: true, reason: 'vector' })
  })

  it('an empty hit set keeps the entry inactive (vector-miss)', () => {
    const result = run([entry(1, { vectorized: true })], { vectorHits: new Set() })
    expect(result.allActivated).toHaveLength(0)
    expect(result.diagnostics.entries['book.1']).toMatchObject({ activated: false, reason: 'vector-miss' })
  })

  it('constant vectorized entries stay resident', () => {
    const off = run([entry(1, { vectorized: true, constant: true })])
    expect(off.allActivated.map((activated) => activated.activationReason)).toEqual(['constant'])
    const miss = run([entry(1, { vectorized: true, constant: true })], { vectorHits: new Set() })
    expect(miss.allActivated.map((activated) => activated.activationReason)).toEqual(['constant'])
  })

  it('non-vectorized entries keep keyword matching untouched', () => {
    const result = run([entry(1)])
    expect(result.allActivated.map((activated) => activated.activationReason)).toEqual(['primary-key'])
  })

  it('hit ids use the engine stable id (book label + uid)', () => {
    const result = activateWorldInfo({
      books: [{ entries: [entry(1, { vectorized: true }), entry(2, { vectorized: true })] }],
      chat: [],
      contextSize: 1000,
      settings: { scanDepth: 1, budgetPercent: 100 },
      vectorHits: new Set(['#0.2']),
      countTokens: (text) => text.length,
    })
    expect(result.allActivated.map((activated) => activated.entryId)).toEqual(['#0.2'])
    expect(result.diagnostics.entries['#0.1']).toMatchObject({ activated: false, reason: 'vector-miss' })
  })
})