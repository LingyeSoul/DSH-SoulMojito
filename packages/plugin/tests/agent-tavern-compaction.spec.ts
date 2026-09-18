import { describe, expect, it } from 'vitest'
import {
  CURATOR_CONFIG_KEYS,
  DEFAULT_USAGE_THRESHOLD_RATIO,
  RP_COMPACTION_INSTRUCTION,
  SUMMARY_OPEN_TAG,
  isStorySessionBinding,
  mergeSummarizerTarget,
  projectedPressureTokens,
  splitCuratorConfig,
  usagePressureDecision,
  type UsagePressureState,
} from '../src/compaction/shared.js'

describe('AgentTavern compaction curator shared contract', () => {
  it('keeps every RP checkpoint section in order and never drops one silently', () => {
    const sections = [...RP_COMPACTION_INSTRUCTION.matchAll(/^## (.+)$/gm)].map((match) => match[1])
    expect(sections).toEqual([
      'Story So Far',
      'Characters',
      'World Canon',
      'Open Threads',
      'Current Scene',
      'Memory Maintenance',
      'Critical Context',
    ])
    expect(RP_COMPACTION_INSTRUCTION).toContain('never drop a section')
    expect(RP_COMPACTION_INSTRUCTION).toContain('Write in the same language as the conversation.')
  })

  it('teaches the summarizer to merge prior checkpoints under the host framing tag', () => {
    expect(RP_COMPACTION_INSTRUCTION).toContain(SUMMARY_OPEN_TAG)
    expect(RP_COMPACTION_INSTRUCTION).toContain('PRIOR checkpoint')
    expect(RP_COMPACTION_INSTRUCTION).toContain('do not call any tool or take any other action')
  })

  it('keeps the memory maintenance bridge so duties survive compaction', () => {
    expect(RP_COMPACTION_INSTRUCTION).toContain('## Memory Maintenance')
    expect(RP_COMPACTION_INSTRUCTION).toContain('still unrecorded')
  })

  it('separates curator-only keys from the host basic config', () => {
    const { curator, basic } = splitCuratorConfig({
      curatorProvider: 'siliconflow',
      curatorModel: 'deepseek-ai/DeepSeek-V4-Flash',
      curatorMaxTokens: 4096,
      thresholdRatio: 0.9,
      auto: false,
    })
    expect(curator).toEqual({
      curatorProvider: 'siliconflow',
      curatorModel: 'deepseek-ai/DeepSeek-V4-Flash',
      curatorMaxTokens: 4096,
    })
    expect(basic).toEqual({ thresholdRatio: 0.9, auto: false })
  })

  it('drops malformed curator values and forwards everything else untouched', () => {
    const { curator, basic } = splitCuratorConfig({
      curatorProvider: '   ',
      curatorModel: 42,
      curatorMaxTokens: 0,
      unknownHostKey: 'kept',
    })
    expect(curator).toEqual({})
    expect(basic).toEqual({ unknownHostKey: 'kept' })
  })

  it('keeps a legal usageThresholdRatio in the curator bucket and drops malformed ones', () => {
    const legal = splitCuratorConfig({ usageThresholdRatio: 0.7, thresholdRatio: 0.2 })
    expect(legal.curator).toEqual({ usageThresholdRatio: 0.7 })
    expect(legal.basic).toEqual({ thresholdRatio: 0.2 })
    for (const malformed of [0, 1.5, -0.1, Number.NaN, '0.7']) {
      const dropped = splitCuratorConfig({ usageThresholdRatio: malformed })
      expect(dropped.curator).toEqual({})
      expect(dropped.basic).toEqual({})
    }
    expect(CURATOR_CONFIG_KEYS).toEqual(['curatorProvider', 'curatorModel', 'curatorMaxTokens', 'usageThresholdRatio'])
  })

  it('returns an empty split for an empty row config', () => {
    expect(splitCuratorConfig({})).toEqual({ curator: {}, basic: {} })
  })
})

describe('usage-anchored pressure gate (proposal 0006 §4.1)', () => {
  /** 真机故障样本：真实 517,759 vs 启发式 265,912，窗口 512,000。 */
  const failedRunState: UsagePressureState = {
    pressureTokens: 517_759,
    surfaceTokens: 265_912,
    sampledSurfaceTokens: 265_026,
    contextWindow: 512_000,
  }

  it('mirrors the host wire view projection formula exactly', () => {
    expect(projectedPressureTokens(failedRunState)).toBe(517_759 + 265_912 - 265_026)
    expect(projectedPressureTokens({ pressureTokens: 100, sampledSurfaceTokens: 50, surfaceTokens: 10, contextWindow: 1000 })).toBe(60)
    // 负增量 clamp 到 0（压缩后表面小于采样点）。
    expect(projectedPressureTokens({ pressureTokens: 100, sampledSurfaceTokens: 200, surfaceTokens: 10 })).toBe(0)
  })

  it('degrades to the bare sample when surfaceTokens is absent', () => {
    expect(projectedPressureTokens({ pressureTokens: 400, sampledSurfaceTokens: 300, contextWindow: 512_000 })).toBe(400)
  })

  it('cannot anchor without a usage sample or its sampling point', () => {
    expect(projectedPressureTokens({})).toBeUndefined()
    expect(projectedPressureTokens({ pressureTokens: 400 })).toBeUndefined()
    expect(projectedPressureTokens({ sampledSurfaceTokens: 300, contextWindow: 512_000 })).toBeUndefined()
  })

  it('delegates when projected pressure reaches the ratio of the context window', () => {
    // 故障会话：projected 518,645 ≥ 0.7 × 512,000 —— 若当时有此闸门即已触发。
    expect(usagePressureDecision(failedRunState, 0.7)).toEqual({ kind: 'delegate' })
    expect(usagePressureDecision({ pressureTokens: 358_400, sampledSurfaceTokens: 100, surfaceTokens: 100, contextWindow: 512_000 }, 0.7))
      .toEqual({ kind: 'delegate' })
  })

  it('blocks the heuristic trigger while real pressure stays below the gate', () => {
    expect(usagePressureDecision({ pressureTokens: 358_399, sampledSurfaceTokens: 100, surfaceTokens: 100, contextWindow: 512_000 }, 0.7))
      .toEqual({ kind: 'block' })
    // 启发式高估场景：真实样本远低于闸门时拦截，防过早压缩。
    expect(usagePressureDecision({ pressureTokens: 10_000, sampledSurfaceTokens: 400_000, surfaceTokens: 400_000, contextWindow: 512_000 }, 0.7))
      .toEqual({ kind: 'block' })
  })

  it('passes through cold sessions, missing projections, and malformed windows', () => {
    expect(usagePressureDecision(undefined, DEFAULT_USAGE_THRESHOLD_RATIO)).toEqual({ kind: 'passthrough' })
    expect(usagePressureDecision({}, DEFAULT_USAGE_THRESHOLD_RATIO)).toEqual({ kind: 'passthrough' })
    expect(usagePressureDecision({ pressureTokens: 400, sampledSurfaceTokens: 100 }, DEFAULT_USAGE_THRESHOLD_RATIO))
      .toEqual({ kind: 'passthrough' })
    for (const contextWindow of [0, -512_000, Number.NaN]) {
      expect(usagePressureDecision({ ...failedRunState, contextWindow }, DEFAULT_USAGE_THRESHOLD_RATIO))
        .toEqual({ kind: 'passthrough' })
    }
  })
})

describe('story session routing (proposal 0006 §6)', () => {
  it('routes AgentTavern non-group sessions to the RP checkpoint', () => {
    expect(isStorySessionBinding({ architecture: 'agent-tavern' })).toBe(true)
    expect(isStorySessionBinding({ architecture: 'agent-tavern', group: false })).toBe(true)
    expect(isStorySessionBinding({ architecture: 'agent-tavern', group: true })).toBe(false)
  })

  it('routes fully-bound AgentNovel author sessions and rejects incomplete bindings', () => {
    expect(isStorySessionBinding({ architecture: 'agent-novel', novelId: 'novel-1' })).toBe(true)
    expect(isStorySessionBinding({ architecture: 'agent-novel', novelId: '  ' })).toBe(false)
    expect(isStorySessionBinding({ architecture: 'agent-novel' })).toBe(false)
    expect(isStorySessionBinding({ architecture: 'agent-novel', novelId: 42 })).toBe(false)
  })

  it('leaves every other session on the host default summarizer', () => {
    expect(isStorySessionBinding(undefined)).toBe(false)
    expect(isStorySessionBinding({})).toBe(false)
    expect(isStorySessionBinding({ architecture: 'st' })).toBe(false)
    expect(isStorySessionBinding({ architecture: 'group', group: true })).toBe(false)
  })
})

describe('story summarizer target resolution (proposal 0006 §4.3 runtime override)', () => {
  const routed = { provider: 'minimax-cn', model: 'MiniMax-M3' }

  it('prefers the panel runtime override over deployment config and the session route', () => {
    expect(mergeSummarizerTarget({
      runtime: { curatorProvider: 'siliconflow', curatorModel: 'zai-org/GLM-5.2' },
      config: { curatorProvider: 'other', curatorModel: 'other-model' },
      routed,
    })).toEqual({ provider: 'siliconflow', model: 'zai-org/GLM-5.2' })
  })

  it('falls back to deployment config, then the session route, then agent options', () => {
    expect(mergeSummarizerTarget({ config: { curatorProvider: 'siliconflow', curatorModel: 'GLM-5.2' }, routed }))
      .toEqual({ provider: 'siliconflow', model: 'GLM-5.2' })
    expect(mergeSummarizerTarget({ routed }))
      .toEqual({ provider: 'minimax-cn', model: 'MiniMax-M3' })
    expect(mergeSummarizerTarget({ agentOptions: { provider: 'deepseek', model: 'chat' } }))
      .toEqual({ provider: 'deepseek', model: 'chat' })
  })

  it('ignores half-empty or malformed pairs at every layer', () => {
    for (const runtime of [
      { curatorProvider: 'siliconflow' },
      { curatorModel: 'GLM-5.2' },
      { curatorProvider: '', curatorModel: 'GLM-5.2' },
      { curatorProvider: 'siliconflow', curatorModel: '  ' },
      { curatorProvider: 42, curatorModel: 'GLM-5.2' },
    ]) {
      expect(mergeSummarizerTarget({ runtime, config: { curatorProvider: 'cfg', curatorModel: 'cfg-model' } }))
        .toEqual({ provider: 'cfg', model: 'cfg-model' })
    }
    expect(mergeSummarizerTarget({})).toBeUndefined()
    expect(mergeSummarizerTarget({ routed: { provider: '', model: 'm' }, agentOptions: { provider: 'p' } })).toBeUndefined()
  })
})
