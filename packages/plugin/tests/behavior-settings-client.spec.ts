/**
 * 「行为设置」分区客户端源检查（2026-10-21 用户需求「改进管理面板交互」）：
 * 此前散养的行为开关——「当前配置」架构分支里的 AgentTavern 预载 / global 写入 /
 * 前端自动展开、世界书清单顶的世界书跟随、游戏清单顶的禁用投降，连同设置页的
 * 外部资源与卡脚本自动运行——全部收编进 BehaviorSettingsBand，按行为对应关系
 * 分五组（会话 / 世界书 / 工具写入 / 前端与卡脚本 / 游戏），并注册为面板第 19 个
 * 分区（system 组置顶）。同一个 band 双挂设置页，设置页不丢开关。
 * follow games-client.spec.ts 的 main.js source check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

const BEHAVIOR_I18N_KEYS = [
  'panel.section.behavior',
  'settings.behaviorHint',
  'settings.behavior.session',
  'settings.behavior.worldInfo',
  'settings.behavior.toolWrites',
  'settings.behavior.frontend',
  'settings.behavior.games',
]

describe('behavior settings section (main.js source check)', () => {
  it('registers the behavior section at the top of the system group', () => {
    const behaviorAt = source.indexOf("{ id: 'behavior',")
    const presetsAt = source.indexOf("{ id: 'presets',")
    const regexAt = source.indexOf("{ id: 'regex',")
    expect(behaviorAt).toBeGreaterThanOrEqual(0)
    expect(presetsAt).toBeGreaterThan(behaviorAt)
    expect(regexAt).toBeGreaterThan(presetsAt)
  })

  it('renders every consolidated toggle through the band applyPatch helper', () => {
    for (const marker of [
      'function BehaviorSettingsBand(',
      'applyPatch({ defaultArchitecture: \'agent-tavern\' })',
      'applyPatch({ defaultArchitecture: \'st\' })',
      'applyPatch({ defaultContextMode: \'dsh-native\' })',
      'applyPatch({ defaultContextMode: \'agent-managed\' })',
      'applyPatch({ agentTavernPreloadAssets: event.target.checked })',
      'applyPatch({ nativeAgentPersona: event.target.checked })',
      'applyPatch({ worldFollowsCharacter: event.target.checked })',
      'applyPatch({ agentTavernAllowGlobalWrites: event.target.checked })',
      'applyPatch({ frontendAutoOpen: event.target.checked })',
      'applyPatch({ frontendAllowExternalResources: event.target.checked })',
      'applyPatch({ cardScriptsAutoRun: event.target.checked })',
      'applyPatch({ gamesDisableResign: event.target.checked })',
      "t('settings.frontendAllowExternalResourcesHint')",
      "t('settings.cardScriptsAutoRunHint')",
    ]) {
      expect(source).toContain(marker)
    }
    // 组标题键经 behaviorGroup 渲染五组。
    expect(source.split("behaviorGroup('settings.behavior.").length - 1).toBe(5)
  })

  it('carries every behavior locale key in both the zh and en tables', () => {
    for (const key of BEHAVIOR_I18N_KEYS) {
      // 键定义形态（带冒号）只在 zh/en 两张表出现；t('...') 引用不带冒号。
      expect(source.split(`'${key}':`).length - 1, key).toBe(2)
    }
  })

  it('ships the self-drawn sliders icon for the nav cell', () => {
    expect(source).toContain('function IconSlidersOutline16(')
    expect(source).toContain('icon: IconSlidersOutline16')
  })

  it('mounts the band on both the panel section and the native settings page', () => {
    // 面板分区经注册表 component 挂载；设置页与 ActiveSetupBand 同位追加。
    expect(source).toContain("component: () => h(BehaviorSettingsBand)")
    const settingsAt = source.indexOf('function TavernSettings()')
    const activeAt = source.indexOf('h(ActiveSetupBand),', settingsAt)
    const behaviorAt = source.indexOf('h(BehaviorSettingsBand),', settingsAt)
    expect(activeAt).toBeGreaterThan(settingsAt)
    expect(behaviorAt).toBeGreaterThan(activeAt)
  })

  it('no longer scatters toggles across worlds/games/active-setup surfaces', () => {
    // 旧挂点清零：世界书清单、游戏清单与「当前配置」不再携带这些开关
    // （架构/上下文分段控件 2026-10-21 二次收编，随开关一并迁走）。
    expect(source.includes("run(patchState({ worldFollowsCharacter: event.target.checked }))")).toBe(false)
    expect(source.includes('className: \'dt-frontend-resources\'')).toBe(false)
    expect(source.includes('dt-architecture-settings')).toBe(false)
  })

  it('marker does not match near-miss samples (negative sample)', () => {
    expect("{ id: 'behaviorX',".includes("{ id: 'behavior',")).toBe(false)
    expect("'panel.section.behaviorX':".includes("'panel.section.behavior':")).toBe(false)
    expect("'settings.behavior.sessionX':".includes("'settings.behavior.session':")).toBe(false)
  })
})
