/**
 * Client-side source checks for the AgentTavern body-operations surface
 * (proposal 0021 §7): the body cache and assistant-actions entry, the anchor
 * hidden/text override, the synthetic turn-trigger hiding, i18n copy, and the
 * client fragment manifest ordering. Follows the source-check pattern of
 * agent-tavern-display-client.spec.ts but reads client-src fragments directly:
 * client/main.js is a build product and this slice does not rebuild it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(here, '../client-src')
const bodySource = readFileSync(join(sourceDir, '89b-ui-body.js'), 'utf8')
const stylesSource = readFileSync(join(sourceDir, '95-ui-styles.js'), 'utf8')
const assistantSource = readFileSync(join(sourceDir, '89-ui-assistant.js'), 'utf8')
const zh = readFileSync(join(sourceDir, '41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(sourceDir, '40-i18n-en.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')) as { fragments: string[] }

describe('AgentTavern body client source checks', () => {
  it('registers the body action list slot with a stable id and owner message id', () => {
    expect(bodySource).toContain("ctx.slots.inject('conversation.chat.assistant-actions'")
    expect(bodySource).toContain("name: 'conversation.chat.assistant-actions'")
    expect(bodySource).toContain("id: 'tavern-body-actions'")
    expect(bodySource).toContain('props.messageId')
  })

  it('caches one body lookup per message and revision and dedupes inflight requests', () => {
    expect(bodySource).toContain('function tavernBodyCacheKey(sessionId, messageId, revision)')
    expect(bodySource).toContain('function loadTavernBody(sessionId, messageId, revision)')
    expect(bodySource).toContain('bodyInflight.has(key)')
    expect(bodySource).toContain('bodyInflight.set(key, pending)')
    expect(bodySource).toContain('function useTavernBody(sessionId, messageId)')
    expect(bodySource).toContain('function bumpTavernBodyRevision(sessionId, messageId)')
  })

  it('calls the four body endpoints through the plugin api helper', () => {
    expect(bodySource).toContain('body?sessionId=')
    expect(bodySource).toContain('&messageId=')
    expect(bodySource).toContain("api('body', {")
    expect(bodySource).toContain("method: 'PUT'")
    expect(bodySource).toContain("api('body/regenerate'")
    expect(bodySource).toContain("api('body/select'")
    expect(bodySource).toContain("method: 'POST'")
    // Every mutation carries the ledger group + anchor/index CAS fields from
    // proposal 0021 §9.1 so the server route can reach body-runtime unchanged.
    expect(bodySource.match(/groupId: body\.groupId/g)).toHaveLength(3)
    expect(bodySource.match(/expectedAnchorId,/g)).toHaveLength(3)
    expect(bodySource).toContain('...(trimmed === \'\' ? {} : { feedback: trimmed })')
  })

  it('ships the five stable action test ids', () => {
    for (const testId of [
      'tavern-body-edit',
      'tavern-body-regenerate',
      'tavern-body-swipe-prev',
      'tavern-body-swipe-next',
      'tavern-body-swipe-count',
    ]) {
      expect(bodySource).toContain(`'data-testid': '${testId}'`)
    }
  })

  it('renders actions only for AgentTavern single-character sessions with a capability', () => {
    expect(bodySource).toContain("binding.architecture === 'agent-tavern'")
    expect(bodySource).toContain('binding.group !== true')
    expect(bodySource).toContain('body.canEdit === true')
    expect(bodySource).toContain('body.canRegenerate === true')
    expect(bodySource).toContain('body.canSelect === true')
    expect(bodySource).toContain('body.hidden === true')
  })

  it('pins both body dialog textareas to a fixed height with internal scrolling', () => {
    // Only these two dialogs opt into the fixed-height classes; EditorDialog and
    // EditorField keep their shared semantics and 108px resizable default.
    expect(bodySource).toContain("className: 'dt-body-dialog dt-body-dialog-edit'")
    expect(bodySource).toContain("className: 'dt-body-dialog dt-body-dialog-regenerate'")
    expect(bodySource).toContain("className: 'dt-editor-wide dt-body-textarea dt-body-textarea-edit'")
    expect(bodySource).toContain("className: 'dt-editor-wide dt-body-textarea dt-body-textarea-feedback'")

    const baseRule = stylesSource.indexOf('.dt-editor-field textarea{min-height:108px;resize:vertical;white-space:pre-wrap}')
    expect(baseRule).toBeGreaterThanOrEqual(0)
    // The override must come after the shared default and outrank it by class
    // count, otherwise the textarea stays half-fixed and still drag-resizable.
    expect(stylesSource.indexOf('.dt-editor-field.dt-body-textarea textarea{resize:none;overflow-y:auto}')).toBeGreaterThan(baseRule)
    expect(stylesSource).toContain('.dt-editor-field.dt-body-textarea-edit textarea{height:280px;min-height:280px;max-height:280px}')
    expect(stylesSource).toContain('.dt-editor-field.dt-body-textarea-feedback textarea{height:180px;min-height:180px;max-height:180px}')
    expect(stylesSource).toContain('@media(max-width:700px){.dt-editor-field.dt-body-textarea-edit textarea{height:220px;min-height:220px;max-height:220px}.dt-editor-field.dt-body-textarea-feedback textarea{height:150px;min-height:150px;max-height:150px}}')
  })

  it('parses the body response fields used by the action row', () => {
    for (const field of [
      'body.count',
      'body.selectedIndex',
      'body.anchorMessageId',
      'body.reason',
      'body.canEdit',
      'body.canRegenerate',
      'body.canSelect',
      'body.hidden',
      'body.text',
    ]) {
      expect(bodySource).toContain(field)
    }
  })

  it('keeps the display lookup as the fallback and hides body-hidden nodes', () => {
    expect(assistantSource).toContain('useTavernDisplayText(tavernBinding, messageId)')
    expect(assistantSource).toContain('useTavernBody(tavernBinding ? props.tavernSessionId : undefined, messageId)')
    expect(assistantSource).toContain('bodyState.body?.hidden === true')
    expect(assistantSource).toContain('withTavernDisplayText(props.node, bodyText !== undefined ? bodyText : displayText)')
  })

  it('hides synthetic body turn triggers and context rows, reusing host renderers otherwise', () => {
    expect(assistantSource).toContain("key: 'turn-trigger'")
    expect(assistantSource).toContain('source.form')
    expect(assistantSource).toContain("form === 'body-regenerate' || form === 'body-restore'")
    expect(assistantSource).toContain('findHostTurnTriggerEntry')
    expect(assistantSource).toContain('entry.component !== TavernTurnTriggerNode')
    expect(assistantSource).toContain("key: 'context'")
    expect(assistantSource).toContain("form === 'body-hide'")
    expect(assistantSource).toContain('findHostContextEntry')
    expect(assistantSource).toContain('entry.component !== TavernContextNode')
    expect(assistantSource).toContain('registerTavernBodyActions(ctx)')
  })

  it('ships the body copy in both dictionaries with matching placeholders', () => {
    const keys = [
      'body.edit', 'body.regenerate', 'body.swipe', 'body.saving', 'body.generating',
      'body.failed', 'body.busy', 'body.compacted', 'body.notLast',
    ]
    for (const key of keys) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
    expect(zh).toContain("'body.failed': '正文操作失败：{message}'")
    expect(en).toContain("'body.failed': 'Body operation failed: {message}'")
    expect(zh).toContain("'body.swipe': '候选 {index}/{count}'")
    expect(en).toContain("'body.swipe': 'Candidate {index} of {count}'")
  })

  it('lists the body fragment after the assistant fragment and registers every source fragment', () => {
    const assistantIndex = manifest.fragments.indexOf('89-ui-assistant.js')
    const bodyIndex = manifest.fragments.indexOf('89b-ui-body.js')
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(bodyIndex).toBe(assistantIndex + 1)
    for (const name of readdirSync(sourceDir)) {
      if (!name.endsWith('.js')) continue
      expect(manifest.fragments).toContain(name)
    }
  })

  it('stays a shared-scope fragment without module syntax', () => {
    expect(bodySource).not.toMatch(/^\s*import\b/m)
    expect(bodySource).not.toMatch(/^\s*export\b/m)
  })
})