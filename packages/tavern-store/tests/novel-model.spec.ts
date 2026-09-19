import { describe, expect, it } from 'vitest'
import {
  countEffectiveCharacters,
  finishGuardViolations,
  lengthWithinBudget,
  requirementWatermark,
  validateCreateConfig,
  type BodyCommit,
  type LengthBudget,
  type NovelCreateConfig,
  type NovelSnapshot,
  type RequirementRecord,
} from '../src/novel-model.js'

function baseConfig(overrides?: Partial<NovelCreateConfig>): NovelCreateConfig {
  return {
    title: 'Test Novel',
    requirement: '写一个关于灯塔看守人的短篇',
    language: 'zh',
    genre: 'literary',
    narrativePerspective: 'third-person',
    styleNotes: '',
    lengthBudget: { kind: 'unbounded' },
    maxChapters: null,
    approvalMode: 'automatic',
    characterNames: [],
    worldNames: [],
    budgets: {
      maxTurns: 100,
      maxDurationMs: 3_600_000,
      stallThresholdTurns: 10,
      consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 2, backoffMs: 500 },
      maxDeduceRuns: 5,
    },
    ...overrides,
  }
}

function requirement(sequence: number, status: RequirementRecord['status']): RequirementRecord {
  return {
    requirementId: `req-${sequence}`,
    hostMessageId: `msg-${sequence}`,
    sequence,
    text: `directive ${sequence}`,
    receivedAt: '2026-09-16T00:00:00.000Z',
    receivedUnitId: null,
    status,
    appliedRevision: null,
    effectiveLocation: null,
    blockedReason: null,
    supersededBy: null,
  }
}

function commit(id: string, effectiveCharacters: number): BodyCommit {
  return {
    commitId: id,
    unitId: `unit-${id}`,
    chapterId: 'ch-1',
    attempt: 1,
    bodyHash: `hash-${id}`,
    paragraphCount: 1,
    effectiveCharacters,
    sceneCompleted: true,
    completionBasis: 'done',
    outstandingGoals: [],
    canonChanges: [],
    outlineRevision: 'ol-1',
    requirementSequence: 1,
    committedAt: '2026-09-16T00:00:00.000Z',
  }
}

function snapshot(parts?: Partial<NovelSnapshot>): NovelSnapshot {
  return {
    novelId: 'nvl-test',
    revision: 'r1',
    schemaVersion: 1,
    createdAt: '2026-09-16T00:00:00.000Z',
    updatedAt: '2026-09-16T00:00:00.000Z',
    config: baseConfig(),
    assets: [],
    outline: null,
    requirements: [],
    units: [],
    commits: [],
    completedChapters: [],
    premiseNote: null,
    run: {
      status: 'active',
      phase: 'writing',
      pauseReason: null,
      pauseDetail: null,
      resumeHint: null,
      currentUnitId: null,
      turnsRun: 0,
      deduceRuns: 0,
      writerRuns: 0,
      startedAt: null,
      completedAt: null,
      lastProgressSignature: null,
      stalledTurns: 0,
      consecutiveFailures: 0,
      lastError: null,
      inFlightIntent: null,
      awaitingApprovalRevision: null,
      usageSamples: [],
    },
    contentRevision: 'c1',
    countPolicyVersion: 1,
    ...parts,
  }
}

describe('countEffectiveCharacters (countPolicyVersion 1, §7.1)', () => {
  it('英文按字母计数，空白不计', () => {
    expect(countEffectiveCharacters('Hello World')).toBe(10)
    expect(countEffectiveCharacters('a-b_c')).toBe(3)
  })

  it('汉字逐字计入，标点与排版符号忽略', () => {
    expect(countEffectiveCharacters('你好，世界！')).toBe(4)
    expect(countEffectiveCharacters('第1章 “引子”……')).toBe(5) // 第 1 章 引 子（数字计入）
  })

  it('中英混排只计字母数字与汉字', () => {
    expect(countEffectiveCharacters('AI替身文学2.0版')).toBe(9) // A I 替 身 文 学 2 0 版
  })

  it('emoji 按码点处理且不计入（代理对/ZWJ 序列不重复计数）', () => {
    expect(countEffectiveCharacters('👍')).toBe(0)
    expect(countEffectiveCharacters('👨‍👩‍👧')).toBe(0) // family sequence: all non letter/number code points
    expect(countEffectiveCharacters('好👍的')).toBe(2)
    expect(countEffectiveCharacters('a👍b')).toBe(2)
  })

  it('星形区字母按单个码点计入', () => {
    expect(countEffectiveCharacters('\u{1D54F}')).toBe(1) // MATHEMATICAL DOUBLE-STRUCK X
    expect(countEffectiveCharacters('\u{1D54F}\u{1D54F}')).toBe(2)
  })

  it('空串与全空白为 0', () => {
    expect(countEffectiveCharacters('')).toBe(0)
    expect(countEffectiveCharacters(' \n\t\u3000')).toBe(0)
  })
})

describe('validateCreateConfig (§7.1)', () => {
  it('合法配置无错误', () => {
    expect(validateCreateConfig(baseConfig())).toEqual([])
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 5000, toleranceRatio: 0.1, hardMaximumCharacters: null },
      maxChapters: 12,
      approvalMode: 'manual',
      characterNames: ['A', 'B'],
      worldNames: ['W'],
    }))).toEqual([])
  })

  it('目标字数必须为正整数', () => {
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 0, toleranceRatio: 0.1, hardMaximumCharacters: null },
    })).map((e) => e.field)).toContain('lengthBudget.targetCharacters')
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 2.5, toleranceRatio: 0.1, hardMaximumCharacters: null },
    })).map((e) => e.field)).toContain('lengthBudget.targetCharacters')
  })

  it('浮动比例必须在 [0, 1)', () => {
    for (const toleranceRatio of [1, 1.5, -0.1]) {
      expect(validateCreateConfig(baseConfig({
        lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio, hardMaximumCharacters: null },
      })).map((e) => e.field)).toContain('lengthBudget.toleranceRatio')
    }
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio: 0, hardMaximumCharacters: 100 },
    })).map((e) => e.field)).not.toContain('lengthBudget.toleranceRatio')
  })

  it('硬上限不得低于目标字数', () => {
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: 99 },
    })).map((e) => e.field)).toContain('lengthBudget.hardMaximumCharacters')
    expect(validateCreateConfig(baseConfig({
      lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: 100 },
    })).map((e) => e.field)).not.toContain('lengthBudget.hardMaximumCharacters')
  })

  it('运行预算必须全部为正数', () => {
    expect(validateCreateConfig(baseConfig({ budgets: { ...baseConfig().budgets, maxTurns: 0 } })).map((e) => e.field)).toContain('budgets.maxTurns')
    expect(validateCreateConfig(baseConfig({ budgets: { ...baseConfig().budgets, externalRetry: { maxAttempts: 2, backoffMs: 0 } } })).map((e) => e.field)).toContain('budgets.externalRetry')
    expect(validateCreateConfig(baseConfig({ budgets: { ...baseConfig().budgets, writerDispatchLimit: 0 } })).map((e) => e.field)).toContain('budgets.writerDispatchLimit')
    expect(validateCreateConfig(baseConfig({ budgets: { ...baseConfig().budgets, writerDispatchLimit: 1 } })).map((e) => e.field)).not.toContain('budgets.writerDispatchLimit')
    expect(validateCreateConfig(baseConfig({ maxChapters: 0 })).map((e) => e.field)).toContain('maxChapters')
    expect(validateCreateConfig(baseConfig({ title: ' ' })).map((e) => e.field)).toContain('title')
    expect(validateCreateConfig(baseConfig({ characterNames: ['A', 'A'] })).map((e) => e.field)).toContain('characterNames')
  })

  it('writerMode 只接受 inline | subagent，缺省合法（0007 §8）', () => {
    // Absent stays valid at the model layer; the store normalizes it to
    // 'inline' at creation (storage-layer default, not mode magic).
    expect(validateCreateConfig(baseConfig()).map((e) => e.field)).not.toContain('writerMode')
    expect(validateCreateConfig(baseConfig({ writerMode: 'inline' })).map((e) => e.field)).not.toContain('writerMode')
    expect(validateCreateConfig(baseConfig({ writerMode: 'subagent' })).map((e) => e.field)).not.toContain('writerMode')
    expect(validateCreateConfig(baseConfig({ writerMode: 'hybrid' as NovelCreateConfig['writerMode'] })).map((e) => e.field)).toContain('writerMode')
    expect(validateCreateConfig(baseConfig({ writerMode: 'inline' as NovelCreateConfig['writerMode'] })))
      .toEqual([])
  })
})

describe('requirementWatermark (§9.1)', () => {
  it('空台账为 0', () => {
    expect(requirementWatermark([])).toBe(0)
  })

  it('越过 applied | superseded 的连续前缀', () => {
    expect(requirementWatermark([requirement(1, 'applied')])).toBe(1)
    expect(requirementWatermark([requirement(1, 'applied'), requirement(2, 'superseded')])).toBe(2)
    expect(requirementWatermark([requirement(1, 'applied'), requirement(2, 'applied'), requirement(3, 'pending')])).toBe(2)
  })

  it('blocked 不越过前缀', () => {
    expect(requirementWatermark([requirement(1, 'applied'), requirement(2, 'blocked'), requirement(3, 'applied')])).toBe(1)
    expect(requirementWatermark([requirement(1, 'blocked')])).toBe(0)
  })

  it('按 sequence 排序后计算，与输入顺序无关', () => {
    expect(requirementWatermark([requirement(2, 'applied'), requirement(1, 'applied')])).toBe(2)
    expect(requirementWatermark([requirement(3, 'applied'), requirement(1, 'blocked'), requirement(2, 'applied')])).toBe(0)
  })
})

describe('length / finish guards (§7.3)', () => {
  const target: LengthBudget = { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: null }

  it('target 模式落在 [target*(1-tol), target*(1+tol)] 或 hardMax 内', () => {
    expect(lengthWithinBudget(95, target)).toBe(true)
    expect(lengthWithinBudget(90, target)).toBe(true)
    expect(lengthWithinBudget(110, target)).toBe(true)
    expect(lengthWithinBudget(89, target)).toBe(false)
    expect(lengthWithinBudget(111, target)).toBe(false)
    expect(lengthWithinBudget(130, { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: 150 })).toBe(true)
    expect(lengthWithinBudget(151, { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: 150 })).toBe(false)
    expect(lengthWithinBudget(1, { kind: 'unbounded' })).toBe(true)
  })

  it('finish 守卫给出具体 violations', () => {
    const withOutline = snapshot({
      outline: {
        outlineRevision: 'ol-1',
        parentRevision: null,
        reason: 'initial',
        sourceRequirementIds: [],
        story: { premise: 'p', theme: 't', mainConflict: 'c', endingDirection: 'e', taboos: [] },
        characters: [],
        chapters: [
          { chapterId: 'ch-1', order: 1, title: '一', purpose: 'p', keyEvents: [], plannedCharacters: null, entryCondition: 'x', exitCondition: 'y' },
        ],
        currentChapterId: 'ch-1',
        scenes: [],
        foreshadowing: [{ id: 'f-1', description: 'd', plantAt: null, payoffAt: null, required: true, status: 'open' }],
      },
      requirements: [requirement(1, 'pending')],
      units: [{ unitId: 'unit-1', chapterId: 'ch-1', sceneId: 'sc-1', label: 'l', state: 'prepared', attempt: 0, claimedRevision: null, claimedRequirementSequence: null, hostTurn: null, goal: 'g', continuationAnchor: null, lastError: null, executionTokenHash: null }],
    })
    const violations = finishGuardViolations(withOutline)
    expect(violations).toContain('chapters-incomplete:ch-1')
    expect(violations).toContain('foreshadowing-unresolved:f-1')
    expect(violations).toContain('requirement-unprocessed:req-1')
    expect(violations).toContain('unit-in-flight:unit-1')

    const complete = snapshot({
      outline: withOutline.outline,
      completedChapters: [{ chapterId: 'ch-1', basis: 'b', openItems: [], completedAt: '2026-09-16T00:00:00.000Z' }],
      requirements: [requirement(1, 'applied')],
      units: [{ ...withOutline.units[0]!, state: 'committed' }],
      commits: [commit('commit-1', 100)],
    })
    const resolvedOutline = { ...complete.outline!, foreshadowing: [{ ...complete.outline!.foreshadowing[0]!, status: 'resolved' as const }] }
    const completeOnTarget = { ...complete, outline: resolvedOutline, config: baseConfig({ lengthBudget: { kind: 'target', targetCharacters: 100, toleranceRatio: 0.1, hardMaximumCharacters: null } }) }
    expect(finishGuardViolations(completeOnTarget)).toEqual([])
    expect(finishGuardViolations({ ...completeOnTarget, commits: [commit('commit-1', 10)] })).toContain('length-out-of-budget:10')
  })

  it('无大纲时给出 outline-missing', () => {
    expect(finishGuardViolations(snapshot())).toEqual(['outline-missing'])
  })
})
