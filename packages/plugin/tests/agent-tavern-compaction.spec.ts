import { describe, expect, it } from 'vitest'
import {
  CURATOR_CONFIG_KEYS,
  RP_COMPACTION_INSTRUCTION,
  SUMMARY_OPEN_TAG,
  splitCuratorConfig,
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
    expect(CURATOR_CONFIG_KEYS).toEqual(['curatorProvider', 'curatorModel', 'curatorMaxTokens'])
  })

  it('returns an empty split for an empty row config', () => {
    expect(splitCuratorConfig({})).toEqual({ curator: {}, basic: {} })
  })
})
