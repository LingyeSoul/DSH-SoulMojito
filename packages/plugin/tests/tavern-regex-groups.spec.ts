/**
 * 正则脚本按来源分区 + 整段删除（2026-10-23 用户需求）。
 *
 * client half 是宿主 ModuleLoader 的 IIFE，没有模块出口；分区是纯呈现层派生，
 * 这里沿既有 source-witness 纪律锁住三件事：
 * 1. 分区键取 `regexScriptOwners` / `regexScriptPresetOwners`，无归属落到全局；
 * 2. 段头条数用该来源的全部脚本，不是过滤后的可见脚本；
 * 3. 「清空分区」把该段全部 id 从脚本列表剔除后整表保存，服务端
 *    `replaceRegexScripts` 会同步剪掉归属表。
 * 4. 分区默认折叠，段头一行保留启停/清空；过滤或编辑中的分区强制展开。
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

  it('folds source groups by default while keeping the header actions reachable', () => {
    // 初始展开表为空 = 全部收起；段头仍是独立按钮，启停与清空不受折叠影响。
    expect(source).toContain('const [expandedGroups, setExpandedGroups] = useState({})')
    expect(source).toContain("const groupOpen = (group) => expandedGroups[group.key] === true || regexQuery !== '' || groupEditing(group)")
    expect(source).toContain("const groupFoldLocked = (group) => regexQuery !== '' || groupEditing(group)")
    expect(source).toContain('const toggleGroupOpen = (group) => setExpandedGroups((current) => ({ ...current, [group.key]: current[group.key] !== true }))')
    expect(source).toContain("'aria-expanded': open")
    expect(source).toContain("'aria-controls': listId")
    expect(source).toContain("t(open ? 'settings.regexGroupFold' : 'settings.regexGroupUnfold', { scope })")
    // 收起时列表整体不挂载，避免隐藏行仍占布局与可访问树。
    expect(source).toContain("open ? h('div', { id: listId, className: 'dt-regex-list' }, visible.map(scriptItem)) : null")
    expect(source).toContain('className: \'dt-regex-group-fold dt-regex-group-fold-static\'')
    expect(source).toContain('.dt-regex-group-fold svg.dt-chevron-open{transform:rotate(0)}')
    expect(source).toContain('.dt-regex-group-fold-static:hover{background:transparent}')
  })

  it('reveals the saved or released script group so it cannot vanish into a fold', () => {
    expect(source).toContain('const revealGroup = (key) => setExpandedGroups((current) => (current[key] === true ? current : { ...current, [key]: true }))')
    expect(source).toContain('const revealScript = (script) => {')
    expect(source).toContain('revealScript(script)')
    // 解除归属后脚本改落全局分区，服务端会剪掉旧归属。
    expect(source).toContain("revealGroup('global:')")
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("const key = `${kind}:${name}X`".includes('const key = `${kind}:${name}`')).toBe(false)
    expect("t('settings.regexGroupCount', { count: group.visible.length })".includes("t('settings.regexGroupCount', { count: group.scripts.length })")).toBe(false)
    expect("!removed.hasX(script.id)".includes('!removed.has(script.id)')).toBe(false)
  })
})