import { describe, expect, it } from 'vitest'
import { activateWorldInfo, WI_LOGIC, WI_POSITION, type LoreEntry, type TimedEffectsState } from '../src/index.js'

const entry = (uid: number, over: Partial<LoreEntry> = {}): LoreEntry => ({ uid, key: [`k${uid}`], content: `C${uid}`, ...over })
const run = (entries: LoreEntry[], chat = 'k1 k2 k3', over = {}) => activateWorldInfo({
  books: [{ name: 'book', entries }], chat: [{ content: chat }],
  contextSize: 1000, settings: { scanDepth: 2, budgetPercent: 100 },
  rng: () => 0.25, countTokens: (text) => text.length, ...over,
})

describe('key matching', () => {
  it('primary case sensitivity and regex keys', () => {
    expect(run([entry(1, { key: ['Dragon'] })], 'dragon').allActivated).toHaveLength(1)
    expect(run([entry(1, { key: ['Dragon'], caseSensitive: true })], 'dragon').allActivated).toHaveLength(0)
    expect(run([entry(1, { key: ['/drag(on|oon)/i'] })], 'DRAGON').allActivated).toHaveLength(1)
  })
  it('whole-word and message-boundary char-name matching', () => {
    expect(run([entry(1, { key: ['cat'], matchWholeWords: true })], 'concatenate').allActivated).toHaveLength(0)
    expect(run([entry(1, { key: ['cat'], matchWholeWords: true })], 'a cat!').allActivated).toHaveLength(1)
    const result = activateWorldInfo({ books: [{ entries: [entry(1, { key: ['\x01Alice:'] })] }], chat: [{ name: 'Alice', content: 'hello' }], settings: { includeNames: true }, rng: () => 0 })
    expect(result.allActivated).toHaveLength(1)
  })
  it.each([
    [WI_LOGIC.AND_ANY, 'p s1', true], [WI_LOGIC.AND_ANY, 'p', false],
    [WI_LOGIC.NOT_ALL, 'p s1', true], [WI_LOGIC.NOT_ALL, 'p s1 s2', false],
    [WI_LOGIC.NOT_ANY, 'p', true], [WI_LOGIC.NOT_ANY, 'p s1', false],
    [WI_LOGIC.AND_ALL, 'p s1 s2', true], [WI_LOGIC.AND_ALL, 'p s1', false],
  ])('secondary logic %s against "%s" => %s', (logic, chat, active) => {
    const result = run([entry(1, { key: ['p'], keysecondary: ['s1', 's2'], selective: true, selectiveLogic: logic })], chat)
    expect(result.allActivated.length > 0).toBe(active)
  })
  it('extra scan sources obey match flags', () => {
    const no = activateWorldInfo({ books: [{ entries: [entry(1, { key: ['Dryad'] })] }], chat: [], scanSources: { characterDescription: 'Dryad' } })
    const yes = activateWorldInfo({ books: [{ entries: [entry(1, { key: ['Dryad'], matchCharacterDescription: true })] }], chat: [], scanSources: { characterDescription: 'Dryad' } })
    expect(no.allActivated).toHaveLength(0); expect(yes.allActivated).toHaveLength(1)
  })
})

describe('activation filters and budget', () => {
  it('disabled/trigger/probability/constant', () => {
    expect(run([entry(1, { disable: true })]).allActivated).toHaveLength(0)
    expect(run([entry(1, { triggers: ['continue'] })]).allActivated).toHaveLength(0)
    expect(run([entry(1, { probability: 10, useProbability: true })]).allActivated).toHaveLength(0)
    expect(run([entry(9, { key: [], constant: true })], '').allActivated[0]?.activationReason).toBe('constant')
  })
  it('global budget stops lower candidates; ignoreBudget bypass; book budget isolates', () => {
    const r = activateWorldInfo({
      books: [{ name: 'a', tokenBudget: 3, entries: [entry(1, { content: '1234', order: 300 }), entry(2, { content: 'xx', ignoreBudget: true, order: 200 })] }],
      chat: [{ content: 'k1 k2' }], contextSize: 10, settings: { budgetPercent: 50 }, countTokens: (t) => t.length, rng: () => 0,
    })
    expect(r.allActivated.map((x) => x.uid)).toEqual([2])
    expect(r.diagnostics.entries['a.1']?.reason).toBe('budget-book')
  })
  it('output order mirrors ST unshift assembly: low order content first', () => {
    const r = run([entry(1, { order: 200, content: 'HIGH' }), entry(2, { order: 50, content: 'LOW' })])
    expect(r.worldInfoBefore.text).toBe('LOW\nHIGH')
  })
})

describe('recursion and min activations', () => {
  it('new content recursively activates another entry; prevent/exclude suppress', () => {
    const base = [entry(1, { key: ['seed'], content: 'next-key' }), entry(2, { key: ['next-key'], content: 'recursive' })]
    expect(run(base, 'seed', { settings: { recursive: true, budgetPercent: 100 } }).allActivated.map((x) => x.uid)).toEqual([1, 2])
    expect(run([entry(1, { key: ['seed'], content: 'next-key', preventRecursion: true }), base[1]!], 'seed', { settings: { recursive: true } }).allActivated.map((x) => x.uid)).toEqual([1])
    expect(run([base[0]!, entry(2, { key: ['next-key'], excludeRecursion: true })], 'seed', { settings: { recursive: true } }).allActivated.map((x) => x.uid)).toEqual([1])
  })
  it('delayUntilRecursion activates only at specified recursion level', () => {
    const r = run([
      entry(1, { key: ['seed'], content: 'level1' }),
      entry(2, { key: ['level1'], content: 'level2', delayUntilRecursion: 1 }),
      entry(3, { key: ['level2'], content: 'done', delayUntilRecursion: 2 }),
    ], 'seed', { settings: { recursive: true } })
    expect(r.allActivated.map((x) => x.uid)).toEqual([1, 2, 3])
    // 2 个产生新激活的递归轮 + 1 个终止确认轮（ST scan loop 统计口径）
    expect(r.diagnostics.recursionRounds).toBe(3)
  })
  it('minActivations deepens recent-message scan', () => {
    const r = activateWorldInfo({
      books: [{ entries: [entry(1, { key: ['old'] })] }],
      chat: [{ content: 'old' }, { content: 'middle' }, { content: 'new' }],
      settings: { scanDepth: 1, minActivations: 1, minActivationsDepthMax: 3 }, rng: () => 0,
    })
    expect(r.allActivated).toHaveLength(1)
    expect(r.diagnostics.scanSkew).toBe(2)
  })
})

describe('inclusion groups', () => {
  it('weighted group picks exactly one; override chooses highest order', () => {
    const weighted = run([entry(1, { group: 'g', groupWeight: 10 }), entry(2, { group: 'g', groupWeight: 90 })])
    expect(weighted.allActivated).toHaveLength(1)
    const override = run([entry(1, { group: 'g', order: 100, groupOverride: true }), entry(2, { group: 'g', order: 200, groupOverride: true })])
    expect(override.allActivated.map((x) => x.uid)).toEqual([2])
  })
  it('group scoring retains highest matched-key score', () => {
    const r = run([
      entry(1, { group: 'g', key: ['a'], useGroupScoring: true }),
      entry(2, { group: 'g', key: ['a', 'b'], useGroupScoring: true }),
    ], 'a b', { settings: { useGroupScoring: true } })
    expect(r.allActivated.map((x) => x.uid)).toEqual([2])
  })
})

describe('timed effects', () => {
  it('delay blocks until message count threshold', () => {
    expect(run([entry(1, { delay: 3 })], 'k1', { messageCount: 2 }).allActivated).toHaveLength(0)
    expect(run([entry(1, { delay: 3 })], 'k1', { messageCount: 3 }).allActivated).toHaveLength(1)
  })
  it('sticky survives missing keyword next generation then expires into cooldown', () => {
    const first = run([entry(1, { sticky: 2, cooldown: 2 })], 'k1', { messageCount: 1 })
    const second = run([entry(1, { sticky: 2, cooldown: 2 })], 'none', { messageCount: 2, timedState: first.timedState })
    expect(second.allActivated[0]?.activationReason).toBe('sticky')
    const third = run([entry(1, { sticky: 2, cooldown: 2 })], 'k1', { messageCount: 3, timedState: second.timedState })
    expect(third.allActivated).toHaveLength(0)
    expect(third.diagnostics.entries['book.1']?.reason).toBe('cooldown')
  })
})

describe('position dispatch', () => {
  it('routes all eight positions including depth role and named outlet', () => {
    const rows = [
      entry(0, { key: [], constant: true, position: 0 }), entry(1, { key: [], constant: true, position: 1 }),
      entry(2, { key: [], constant: true, position: 2 }), entry(3, { key: [], constant: true, position: 3 }),
      entry(4, { key: [], constant: true, position: 4, depth: 2, role: 1 }),
      entry(5, { key: [], constant: true, position: 5 }), entry(6, { key: [], constant: true, position: 6 }),
      entry(7, { key: [], constant: true, position: 7, outletName: 'named' }),
    ]
    const r = run(rows, '')
    expect(r.worldInfoBefore.entries).toHaveLength(1); expect(r.worldInfoAfter.entries).toHaveLength(1)
    expect(r.topOfAuthorsNote.entries).toHaveLength(1); expect(r.bottomOfAuthorsNote.entries).toHaveLength(1)
    expect(r.beforeExamples.entries).toHaveLength(1); expect(r.afterExamples.entries).toHaveLength(1)
    expect(r.atDepth[0]).toMatchObject({ depth: 2, role: 1 }); expect(r.outlets['named']?.entries).toHaveLength(1)
  })
})
