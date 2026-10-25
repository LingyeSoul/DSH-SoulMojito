/**
 * Panel asset editors open in a dedicated modal (2026-10-25 user request).
 *
 * The client half is a single ModuleLoader factory with no module exports, so
 * this source-witness spec locks the dialog shell and the four editor mount
 * points: character card, world book, preset and regex script.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')

const EDITOR_DIALOG_RETURN = "return h(EditorDialog, { title, onClose: cancel, closeLabel: t('panel.close'), footer: toolbar"

describe('panel asset editors use a modal dialog', () => {
  it('renders the shared editor dialog shell through the host Modal', () => {
    expect(source).toContain("function EditorDialog({ title, onClose, closeLabel, children, footer, className = '' })")
    expect(source).toContain('className: `dt-editor-modal ${className}`.trim()')
    expect(source).toContain("h('div', { className: 'dt-editor-modal-head' }")
    expect(source).toContain("h('div', { className: 'dt-editor-modal-body' }, children)")
    // The dialog wraps the dirty guard so overlay/Escape cannot discard drafts.
    expect(source).toContain(EDITOR_DIALOG_RETURN)
  })

  it('mounts the character, world book, preset, regex and persona editors in dialogs', () => {
    const editorDialogs = source.split(EDITOR_DIALOG_RETURN).length - 1
    expect(editorDialogs).toBe(5)
    expect(source).toContain("title: t('settings.regexEdit', { name: editingScript.scriptName })")
    expect(source).toContain("title: t('settings.regexCreate')")
    expect(source).toContain("h(RegexScriptEditor, {\n            key: editingScript.id,")
    expect(source).toContain('function PersonaEditor({ persona, existingNames, onSave, onCancel })')
    expect(source).toContain('setEditor({ persona: null })')
    expect(source).toContain('setEditor({ persona })')
  })

  it('keeps editor actions in a fixed footer instead of a sticky overlay', () => {
    expect(source).toContain("h('div', { className: 'dt-editor-modal-foot' }, footer)")
    expect(source).not.toContain('.dt-editor-modal .dt-editor-toolbar{position:sticky')
  })

  it('no longer mounts editors inline in the card grid, preset row or regex item', () => {
    expect(source).not.toContain("h('div', { key: 'new', className: 'dt-regex-editor-wrap' }")
    expect(source).not.toContain("h('div', { className: 'dt-regex-editor-wrap' },")
    expect(source).not.toContain("className: 'dt-preset-editor-wrap' }, presets[name]")
    expect(source).not.toContain("className: `dt-card ${editing === name ? 'dt-card-editing' : ''}`")
    expect(source).not.toContain("window.prompt(t('settings.personaNamePrompt')")
    expect(source).not.toContain("window.prompt(t('settings.personaDescPrompt')")
  })

  it('ships the dialog title keys in both dictionaries', () => {
    for (const key of [
      'panel.characters.editTitle',
      'panel.worlds.editTitle',
      'panel.presets.editTitle',
      'settings.personaEditTitle',
      'settings.personaNameFixed',
      'settings.personaNameRequired',
      'settings.personaDuplicate',
    ]) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
  })
})
