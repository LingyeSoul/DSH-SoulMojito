import { describe, expect, it } from 'vitest'
import type { AgentContextLike } from '../src/agent-tavern/agent.js'
import { apply, IM_MODE_SECTION, imModePromptText, inject } from '../src/im/agent.js'

interface Section {
  name: string
  order: number
  text: string
}

describe('AgentTavernIM prompt', () => {
  it('declares the systemPrompt service its preset composition mounts', () => {
    // A missing inject makes Cordis reject the whole agent-tavern-im preset
    // ("cannot get property systemPrompt without inject") and every
    // recompose() call fails before the marker is written.
    expect(inject).toContain('systemPrompt')
  })

  it('registers one static IM-mode section before the AgentTavern kernel', () => {
    const sections: Section[] = []
    apply({
      systemPrompt: { section: (section: Section) => { sections.push(section) } },
    } as AgentContextLike)
    expect(sections).toHaveLength(1)
    const section = sections[0]!
    expect(section.name).toBe(IM_MODE_SECTION)
    // kernel 是 -80；IM 模式必须先于普通角色扮演对话习惯。
    expect(section.order).toBeLessThan(-80)
    expect(section.text).toBe(imModePromptText())
    // hostPromptSafe：静态提示词里不能出现宿主 {{...}} 宏，否则整轮装配会中止。
    expect(section.text).not.toContain('{{')
    expect(section.text).not.toContain('}}')
  })

  it('states the tool-only reply rule and the human-like short-message style', () => {
    const text = imModePromptText()
    expect(text).toContain('所有回复必须通过 `im_send`')
    expect(text).toContain('普通的 assistant 正文不会送达对端')
    expect(text).toContain('短句、多条')
    expect(text).toContain('2–5 条')
    expect(text).toContain('群聊')
    expect(text).toContain('mediaKind')
    expect(text).toContain('peer')
    expect(text).toContain('im_identity')
  })
})
