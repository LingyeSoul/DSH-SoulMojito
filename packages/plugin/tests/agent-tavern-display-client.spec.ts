/**
 * Client-side source checks for the AgentTavern native-conversation display
 * layer (2026-10-20): the assistant-step override is registered only while an
 * AgentTavern session is active, asks the server for one message's display
 * text, and the new-chat greeting picker carries an explicit greetingIndex.
 * Follows the frontend-client.spec.ts main.js source-check pattern.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')

describe('AgentTavern native display source checks', () => {
  it('overrides only the assistant-step node and does so only for AgentTavern sessions', () => {
    expect(source).toContain("ctx.slots.inject('conversation.chat.node'")
    expect(source).toContain("key: 'assistant-step'")
    expect(source).toContain('priority: -1')
    expect(source).toContain('const agentTavernActive = Boolean(currentBinding')
    expect(source).toContain('if (!agentTavernActive) return undefined')
  })

  it('fetches one projected message display text instead of the whole chat', () => {
    expect(source).toContain('function loadDisplayText(binding, messageId, revision)')
    expect(source).toContain("api(`display?character=")
    expect(source).toContain('&messageId=')
    expect(source).toContain('function withTavernDisplayText(node, text)')
  })

  it('asks for a greeting index when creating a chat with alternate greetings', () => {
    expect(source).toContain('async function createTavernChat(ctx, character, group = false, policyOverride, greetingIndex)')
    expect(source).toContain('greetingIndex === undefined ? {} : { greetingIndex }')
    expect(source).toContain('function TavernGreetingPicker({ picker, t, onPick, onClose })')
    expect(source).toContain('const startCharacterChat = (character) => {')
  })

  it('ships the greeting picker copy in both dictionaries', () => {
    for (const key of [
      'nav.greetingTitle', 'nav.greetingHint', 'nav.greetingFirst',
      'nav.greetingAlternate', 'nav.greetingEmpty',
    ]) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
  })
})
