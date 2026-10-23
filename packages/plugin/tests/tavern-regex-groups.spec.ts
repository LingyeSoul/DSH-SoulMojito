/**
 * 正则脚本按来源分区 + 整段删除（2026-10-23 用户需求）。
 *
 * client half 是宿主 ModuleLoader 的 IIFE，没有模块出口；分区是纯呈现层派生，
 * 这里沿既有 source-witness 纪律锁住三件事：
 * 1. 分区键取 `regexScriptOwners` / `regexScriptPresetOwners`，无归属落到全局；
 * 2. 段头条数用该来源的全部脚本，不是过滤后的可见脚本；
 * 3. 「清空分区」把该段全部 id 从脚本列表剔除后整表保存，服务端
 *    `replaceRegexScripts` 会同步剪掉归属表。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

describe('regex script source groups', () => {
  it('groups scripts by card owner, preset owner or global fallback', () => {
    expect(source).toContain("const kind = cardOwner !== undefined ? 'character' : presetOwner !== undefined ? 'preset' : 'global'")
    expect(source).toContain("const key = `${kind}:${name}`")
    expect(source).toContain('const rank = { global: 0, character: 1, preset: 2 }')
    expect(source).toContain("const visibleGroups = regexGroups()")
  })

  it('keeps the group count and delete scope on every script of that source', () => {
    // 过滤只收窄 visible；段头条数与删除集合都必须走 group.scripts。
    expect(source).toContain('const count = group.scripts.length')
    expect(source).toContain("const removed = new Set(group.scripts.map((script) => script.id))")
    expect(source).toContain('run(saveRegexScripts(scripts.filter((script) => !removed.has(script.id))).then(() => {')
    expect(source).toContain("t('settings.regexGroupCount', { count: group.scripts.length })")
  })

  it('renders a labelled group header with an active marker and a clear action', () => {
    expect(source).toContain("className: 'dt-regex-groups'")
    expect(source).toContain("className: 'dt-regex-group-head'")
    expect(source).toContain("t('settings.regexGroupActive')")
    expect(source).toContain("t('settings.regexGroupInactive')")
    expect(source).toContain('.dt-regex-group-inactive{')
    expect(source).toContain("t('settings.regexDeleteGroupConfirm', { scope, count })")
    expect(source).toContain("t('settings.regexDeleteGroupDone', { scope, count: removed.size })")
    expect(source).toContain('.dt-regex-group-delete:hover:not(:disabled)')
    expect(source).toContain("className: 'dt-toggle dt-regex-group-toggle'")
    expect(source).toContain('.dt-regex-group-toggle input:disabled')
  })

  it('toggles a whole group from the header with an indeterminate mixed state', () => {
    // 三态：全开勾选、全停空、部分启用 indeterminate；点击全开→全停，其余→全开。
    expect(source).toContain('function RegexGroupToggle({ label, checked, mixed, disabled, onChange })')
    expect(source).toContain('ref.current.indeterminate = mixed')
    expect(source).toContain("const groupEnabledCount = (group) => group.scripts.filter((script) => !script.disabled).length")
    expect(source).toContain('const toggleGroup = (group) => {')
    expect(source).toContain('const nextDisabled = groupEnabledCount(group) === total')
    // 写入范围是该分区全部脚本（含过滤隐藏行），与「清空分区」同口径。
    expect(source).toContain('const ids = new Set(group.scripts.map((script) => script.id))')
    expect(source).toContain('const next = scripts.map((script) => (ids.has(script.id) ? { ...script, disabled: nextDisabled } : script))')
    expect(source).toContain("'settings.regexGroupEnableAll'")
    expect(source).toContain("'settings.regexGroupDisableAll'")
    expect(source).toContain("'settings.regexGroupToggleDone'")
    expect(source).toContain("'settings.regexGroupToggleInactive'")
    expect(source).toContain('mixed: enabled > 0 && enabled < total')
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("const key = `${kind}:${name}X`".includes('const key = `${kind}:${name}`')).toBe(false)
    expect("t('settings.regexGroupCount', { count: group.visible.length })".includes("t('settings.regexGroupCount', { count: group.scripts.length })")).toBe(false)
    expect("!removed.hasX(script.id)".includes('!removed.has(script.id)')).toBe(false)
  })
})