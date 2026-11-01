/**
 * Panel asset viewers open in a dedicated modal (2026-11-01 user request).
 *
 * The client half is a single ModuleLoader factory with no module exports, so
 * this source-witness spec locks the read-only dialog shell and the three mount
 * points: character card, world book and preset. It also pins the removal of
 * the inline viewers that previously expanded inside the panel lists.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')

function functionBlock(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} must exist in the client bundle`).toBeGreaterThan(-1)
  const next = source.indexOf('\n    function ', start + 10)
  return source.slice(start, next === -1 ? undefined : next)
}

describe('panel asset viewers use a modal dialog', () => {
  it('wraps every viewer in the shared editor dialog shell', () => {
    expect(source).toContain('function AssetViewFooter({ onClose, onEdit })')
    for (const name of ['CharacterCardView', 'WorldBookView', 'PresetView']) {
      const block = functionBlock(name)
      expect(block).toContain('h(EditorDialog, {')
      expect(block).toContain("className: 'dt-asset-modal'")
      expect(block).toContain('footer: h(AssetViewFooter, { onClose, onEdit })')
      expect(block).toContain("closeLabel: t('panel.closeDialog')")
    }
  })

  it('mounts the three viewers from the list rows and no longer inlines them', () => {
    expect(source).toContain('h(CharacterCardView, {')
    expect(source).toContain('h(WorldBookView, {')
    expect(source).toContain('h(PresetView, {')
    expect(source).not.toContain('h(CharacterCardFields')
    expect(source).not.toContain('const toggleBrowse')
    expect(source).not.toContain("browse !== '' ? h('section'")
    expect(source).not.toContain('setBrowse')
  })

  it('offers the view action next to edit for presets and world books', () => {
    expect(source).toContain("onClick: () => viewPreset(name) }, t('panel.view')")
    expect(source).toContain("'aria-label': t('panel.worlds.view', { name })")
    expect(source).toContain('onClick: () => viewBook(name)')
  })

  it('keeps the view-to-edit handoff in the dialog footer', () => {
    for (const name of ['CharacterCardView', 'WorldBookView', 'PresetView']) {
      expect(functionBlock(name)).toContain('onEdit')
    }
    expect(source).toContain("onClick: onEdit }, t('panel.edit')")
    expect(source).toContain('const editCard = (name) => {\n        setCreating(false)\n        setViewing(\'\')\n        setEditing(name)')
  })

  it('ships the viewer title and hint keys in both dictionaries', () => {
    for (const key of [
      'panel.view',
      'panel.closeDialog',
      'panel.characters.viewTitle',
      'panel.characters.viewHint',
      'panel.worlds.view',
      'panel.worlds.viewTitle',
      'panel.worlds.viewHint',
      'panel.worlds.empty',
      'panel.presets.viewTitle',
      'panel.presets.viewHint',
    ]) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
  })
})
