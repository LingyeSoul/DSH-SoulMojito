import type { TavernStore, TavernState } from '../../../tavern-store/src/index.js'

type CharacterReader = Pick<TavernStore, 'getCharacter'>

/**
 * 切换活跃角色卡时的世界书清理（2026-10-23 用户反馈）。
 *
 * 链接世界书（`extensions.world`）只在所属角色卡的会话里自动生效，从不属于
 * 手动 `activeWorlds`。旧版本切换角色时把链接书写进过手动列表，导致换卡后
 * 上一张卡的世界书仍显示为启用、新卡的链接书却看不到勾选。这里在切换时把
 * 上一张卡的链接书从手动列表移除（仅当跟随开关开启且条目确实存在），让面板
 * 的勾选状态与会话真实生效集一致。用户显式传入 activeWorlds 时不改写。
 */
export async function activeCharacterPatch(
  db: CharacterReader,
  current: Pick<TavernState, 'activeCharacter' | 'activeWorlds' | 'worldFollowsCharacter'>,
  next: string | undefined,
): Promise<{ activeCharacter?: string; activeWorlds?: string[] }> {
  const patch: { activeCharacter?: string; activeWorlds?: string[] } = { activeCharacter: next }
  const previous = current.activeCharacter
  if (previous === undefined || previous === next || current.worldFollowsCharacter === false) return patch
  const file = await db.getCharacter(previous)
  const raw = file?.card.data.extensions['world']
  const linked = typeof raw === 'string' ? raw.trim() : ''
  if (linked === '' || !current.activeWorlds.includes(linked)) return patch
  patch.activeWorlds = current.activeWorlds.filter((name) => name !== linked)
  return patch
}