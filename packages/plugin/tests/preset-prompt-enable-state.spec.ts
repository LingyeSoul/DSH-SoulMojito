/**
 * Preset prompt enablement is owned by the prompt order table (decision
 * 2026-10-09): `system_prompt` is a classification flag and never gates
 * assembly. The read-only view used to render "Disabled" from that flag, and
 * the editor had no entry-level enable switch, so both surfaces now resolve
 * `prompt_order[].enabled` through the same helpers.
 *
 * The client half is a single ModuleLoader factory with no module exports, so
 * the pure helpers are lifted out of the built bundle and exercised in a VM
 * instead of being re-implemented here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')

interface OrderSlot {
  identifier: string
  enabled?: boolean
}

interface PromptEntry {
  identifier: string
  enabled?: boolean
  system_prompt?: boolean
}

interface PresetDraft {
  prompts: PromptEntry[]
  prompt_order: Array<{ character_id: number; order: OrderSlot[] }>
}

type EntryState = 'enabled' | 'disabled' | 'missing'

interface PresetHelpers {
  resolveOrderEntries: (sets: PresetDraft['prompt_order']) => OrderSlot[]
  orderEntryState: (entries: OrderSlot[], prompt: PromptEntry) => EntryState
  applyOrderEnabled: (current: PresetDraft, identifier: string, enabled: boolean) => PresetDraft
}

function functionBlock(name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} must exist in the client bundle`).toBeGreaterThan(-1)
  const next = source.indexOf('\n    function ', start + 10)
  return source.slice(start, next === -1 ? undefined : next)
}

function loadHelpers(): PresetHelpers {
  const constant = /const NEW_ORDER_GROUP_ID = \d+/.exec(source)?.[0]
  if (constant === undefined) throw new Error('client bundle must define NEW_ORDER_GROUP_ID')
  const code = [
    constant,
    ...['resolveOrderIndex', 'resolveOrderEntries', 'orderEntryState', 'applyOrderEnabled'].map(functionBlock),
    'this.helpers = { resolveOrderEntries, orderEntryState, applyOrderEnabled }',
  ].join('\n')
  const sandbox: { helpers?: PresetHelpers } = {}
  vm.runInNewContext(code, sandbox)
  if (sandbox.helpers === undefined) throw new Error('preset helpers did not install into the VM context')
  return sandbox.helpers
}

const helpers = loadHelpers()

describe('preset prompt enablement follows the order table', () => {
  it('resolves state from the active order group, not the system_prompt flag', () => {
    const entries = helpers.resolveOrderEntries([
      { character_id: 100000, order: [{ identifier: 'legacy' }] },
      { character_id: 100001, order: [{ identifier: 'main' }, { identifier: 'style', enabled: false }, { identifier: 'plain' }] },
    ])
    expect(entries.map((entry) => entry.identifier)).toEqual(['main', 'style', 'plain'])
    expect(helpers.orderEntryState(entries, { identifier: 'main', system_prompt: false })).toBe('enabled')
    expect(helpers.orderEntryState(entries, { identifier: 'style' })).toBe('disabled')
    expect(helpers.orderEntryState(entries, { identifier: 'outside' })).toBe('missing')
  })

  it('falls back to prompt.enabled only when the slot omits the boolean', () => {
    const entries = [{ identifier: 'fallback' }]
    expect(helpers.orderEntryState(entries, { identifier: 'fallback', enabled: false })).toBe('disabled')
    expect(helpers.orderEntryState(entries, { identifier: 'fallback' })).toBe('enabled')
  })

  it('writes the same table for existing, missing and group-less drafts', () => {
    const base: PresetDraft = {
      prompts: [{ identifier: 'main' }, { identifier: 'style' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: true }] }],
    }
    const off = helpers.applyOrderEnabled(base, 'main', false)
    expect(off.prompt_order[0].order).toEqual([{ identifier: 'main', enabled: false }, { identifier: 'style', enabled: true }])
    expect(base.prompt_order[0].order[0].enabled).toBe(true)
    // Read side and write side agree on the same table.
    expect(helpers.orderEntryState(off.prompt_order[0].order, { identifier: 'main' })).toBe('disabled')

    const appended = helpers.applyOrderEnabled(base, 'outside', true)
    expect(appended.prompt_order[0].order.map((entry) => entry.identifier)).toEqual(['main', 'style', 'outside'])
    expect(helpers.applyOrderEnabled(base, 'outside', false)).toBe(base)

    const empty: PresetDraft = { prompts: [{ identifier: 'main' }], prompt_order: [] }
    expect(helpers.applyOrderEnabled(empty, 'main', true).prompt_order).toEqual([
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    ])
    expect(helpers.applyOrderEnabled(empty, 'main', false)).toBe(empty)
  })

  it('renders the view pills from the order table, not the system_prompt flag', () => {
    const view = functionBlock('PresetView')
    expect(view).toContain('const orderEntries = resolveOrderEntries(data?.prompt_order)')
    expect(view).toContain('orderEntryState(orderEntries, prompt)')
    expect(view).toContain("state === 'missing' ? h(Pill, null, t('panel.presets.notInOrder')) : null")
    expect(view).toContain("state === 'disabled' ? h(Pill, null, t('panel.presets.disabled')) : null")
    expect(view).not.toContain('prompt.system_prompt === false')
  })

  it('gives the editor an entry-level switch writing the same order table', () => {
    const editor = functionBlock('PresetEditor')
    expect(editor).toContain('const orderEntries = resolvedOrder(draft).order')
    expect(editor).toContain("h(ToggleField, { label: t('panel.presets.enabled'), checked: orderEntryState(orderEntries, prompt) === 'enabled', onChange: (value) => setOrderEnabled(prompt.identifier, value) })")
    expect(editor).toContain('const setOrderEnabled = (identifier, enabled) => setDraft((current) => applyOrderEnabled(current, identifier, enabled))')
    // The order row and the entry switch must share the writer.
    expect(editor).toContain('onChange: (value) => setOrderEnabled(entry.identifier, value)')
    // system_prompt stays a classification flag.
    expect(editor).toContain("t('panel.presets.systemPromptFlag')")
  })

  it('ships the not-assembled label in both dictionaries', () => {
    expect(zh).toContain("'panel.presets.notInOrder'")
    expect(en).toContain("'panel.presets.notInOrder'")
  })
})