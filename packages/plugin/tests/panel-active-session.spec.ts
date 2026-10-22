/**
 * 管理面板「当前角色」来源（2026-10-23 用户反馈：切到 FX 战士后，世界书面板
 * 仍按上一张卡判断）。切换宿主会话/切回已有绑定不会重写全局 activeCharacter，
 * 面板必须优先读当前会话的 Tavern 绑定；没有绑定时才回落到全局指针。
 * follow behavior-settings-client.spec.ts 的 main.js source check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

describe('panel active character follows the current session binding', () => {
  it('resolves the active card from the bound session before the global pointer', () => {
    for (const marker of [
      'function useActiveTavernCharacter(useSessions)',
      'const currentSession = useSessions ? useCurrentSessionId(useSessions) : undefined',
      'state.bootstrap.state.sessionBindings?.[currentSession]',
      "return bound !== '' ? bound : state.bootstrap.state.activeCharacter || ''",
      'function useTavernCharacterCard(useSessions, character)',
      'const activeCharacter = useActiveTavernCharacter(useSessions)',
      'const activeCard = useTavernCharacterCard(useSessions, activeCharacter)',
      'const linkedWorld = follow ? activeCard?.data?.extensions?.world : undefined',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('passes the host session hook into the characters, worlds and regex sections', () => {
    expect(source).toContain("component: (host) => h(PanelCharacters, { ctx: host.ctx, useSessions: host.useSessions })")
    expect(source).toContain("component: (host) => h(PanelWorlds, { useSessions: host.useSessions })")
    expect(source).toContain("component: (host) => h(RegexBand, { useSessions: host.useSessions })")
    expect(source).toContain('function PanelCharacters({ ctx, useSessions })')
    expect(source).toContain('function PanelWorlds({ useSessions })')
    expect(source).toContain('function RegexBand({ useSessions })')
  })

  it('syncs the global pointer when reopening an existing bound chat', () => {
    expect(source).toContain('if (!group && snapshot.bootstrap.state.activeCharacter !== character)')
    expect(source).toContain('void patchState({ activeCharacter: character }).catch(() => {})')
  })

  it('normalizes card display names to file stems in panel comparisons', () => {
    expect(source).toContain('function normalizeTavernName(value)')
    expect(source).toContain("normalizeTavernName(owner) === normalizeTavernName(activeCharacter)")
    expect(source).toContain('normalizeTavernName(activeCharacter) === normalizeTavernName(name)')
  })
})