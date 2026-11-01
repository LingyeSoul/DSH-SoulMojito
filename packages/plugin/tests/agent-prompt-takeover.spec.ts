/**
 * Agent system prompt 接管（决策 2026-11-02-agent-prompt-takeover）。
 *
 * 宿主 `dsh-system-prompt` 的 `complete: true` 语义：装配结果只保留**一个**
 * complete section，其余 section 全部丢弃。这里锁住 AgentTavern 侧的契约：
 * - apply 只注册一个 section，带 complete 标记（宿主侧其它 section 不再进 RP 会话）；
 * - 段文本按 prompt-parts 注册表拼装：IM 段 / kernel / preset / mod 段按 order
 *   升序、空文本摘除；`scope: 'context'` 的部件（facts 等）不进 system 头；
 * - 段文本与提示词查看器的读取面同源（agentPromptSectionsFor）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AGENT_PROMPT_SECTION,
  agentPromptSectionsFor,
  apply,
  type AgentContextLike,
} from '../src/agent-tavern/agent.js'
import { registerAgentPromptPart } from '../src/agent-tavern/prompt-parts.js'
import { clearModRegistryForTest, registerModSection } from '../src/mods/cross-bundle.js'

interface CapturedSection {
  name: string
  order: number
  complete?: boolean
  text: (assembly?: { agent?: { id?: string } }) => string
}

const UNBOUND_AGENT = 'takeover-unbound-agent'

function mountSection(): CapturedSection {
  let captured: CapturedSection | undefined
  apply({
    systemPrompt: {
      section: (section: CapturedSection) => { captured = section },
      context: () => {},
    },
    tools: { register: () => {} },
    on: () => undefined,
    effect: (fn: () => unknown) => { fn(); return () => {} },
  } as unknown as AgentContextLike)
  if (captured === undefined) throw new Error('apply() did not register the prompt section')
  return captured
}

describe('AgentTavern complete system prompt', () => {
  let home: string

  beforeAll(() => {
    // apply 的预设预热会走 TavernStore（读 $DSH_HOME/soulmojito）：指向临时目录，
    // 绝不让测试碰到真实数据。
    home = mkdtempSync(join(tmpdir(), 'agent-prompt-takeover-'))
    process.env.DSH_HOME = home
    clearModRegistryForTest()
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
    clearModRegistryForTest()
  })

  it('registers exactly one section and claims the whole system prompt', () => {
    const section = mountSection()
    expect(section.name).toBe(AGENT_PROMPT_SECTION)
    expect(section.complete).toBe(true)
  })

  it('renders system parts in order and drops empty ones', () => {
    const section = mountSection()
    const dispose = registerAgentPromptPart({
      name: 'takeover-probe-im',
      order: -90,
      scope: 'system',
      text: () => 'PROBE IM MODE TEXT',
    })
    try {
      // unbound agent：preset/facts 恒空，只剩 IM 探针 + kernel。
      const text = section.text({ agent: { id: UNBOUND_AGENT } })
      expect(text.startsWith('PROBE IM MODE TEXT\n\n')).toBe(true)
      expect(text).toContain('You are AgentTavern running inside the DSH native AgentLoop.')
      expect(text.split('PROBE IM MODE TEXT')).toHaveLength(2)
    } finally {
      dispose()
    }
  })

  it('keeps context-scoped parts out of the system header', () => {
    const section = mountSection()
    const dispose = registerAgentPromptPart({
      name: 'takeover-probe-context',
      order: -70,
      scope: 'context',
      text: () => 'PROBE CONTEXT ONLY',
    })
    try {
      expect(section.text({ agent: { id: UNBOUND_AGENT } })).not.toContain('PROBE CONTEXT ONLY')
      const piece = agentPromptSectionsFor(UNBOUND_AGENT).find((entry) => entry.name === 'takeover-probe-context')
      expect(piece?.scope).toBe('context')
    } finally {
      dispose()
    }
  })

  it('folds mod sections into the complete section with clamped order and neutralized text', () => {
    const section = mountSection()
    const dispose = registerModSection('takeover-mod', { name: 'style', order: 9999, text: 'MOD STYLE BODY {{raw}}' }, 0)
    try {
      const text = section.text({ agent: { id: UNBOUND_AGENT } })
      expect(text).toContain('MOD STYLE BODY')
      // 宿主变量语法被中性化：complete 段的文本要能安全过 assemble。
      expect(text).not.toContain('{{raw}}')
      const pieces = agentPromptSectionsFor(UNBOUND_AGENT)
      const mod = pieces.find((piece) => piece.name === 'dsh-soulmojito:mod:takeover-mod:style')!
      expect(mod.order).toBe(0)
      expect(mod.scope).toBe('system')
      // mod 段在 kernel 之后（内核是唯一更早的 system 部件）。
      const kernel = pieces.findIndex((piece) => piece.name === 'dsh-soulmojito:agent-kernel')
      expect(pieces.indexOf(mod)).toBeGreaterThan(kernel)
    } finally {
      dispose()
      clearModRegistryForTest()
    }
  })

  it('exposes the same pieces to the prompt viewer with their destination', () => {
    const pieces = agentPromptSectionsFor(UNBOUND_AGENT)
    expect(pieces.map((piece) => piece.name)).toEqual([
      'dsh-soulmojito:agent-kernel',
    ])
    expect(pieces.every((piece) => piece.scope === 'system')).toBe(true)
  })
})
