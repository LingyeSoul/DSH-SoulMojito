/**
 * 写卡工作台 · 库存列举（2026-11-17 全能工作台）。
 *
 * `card_list` 是角色卡侧的库存读取面，与 `world_list` 对称：Agent 在用户只
 * 说「那张卡」或询问库存时先列出已导入卡，拿到 card_get/card_put 认识的
 * 库存名，而不是让用户手打卡名。逐卡读取与 world_list 同款；库存量级下
 * 不引入缓存投影。
 */

import { objectOutput, tavernStore, tool, type ToolDefinition } from './shared.js'

const cardListOutput = objectOutput({
  count: { type: 'number' },
  cards: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Stored character name (the identity card_get and card_put take).' },
        creator: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        world: { type: 'string', description: 'Linked world-book name from extensions.world; empty when none.' },
        alternateGreetings: { type: 'number' },
      },
      required: ['name', 'creator', 'tags', 'world', 'alternateGreetings'],
      additionalProperties: false,
    },
  },
})

export const cardListTool: ToolDefinition = tool(
  'card_list',
  'List every imported character card in the Tavern library with its creator, tags, linked world book and alternate-greeting count. Call it when the user refers to a card but you are not sure of its exact name, when they ask what the library contains, or before opening work on an existing card. Names are the stored identities that card_get, card_put, card_original_get and card_delete take.',
  {},
  cardListOutput,
  async (_args, exec) => {
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const cards: Array<{ name: string; creator: string; tags: string[]; world: string; alternateGreetings: number }> = []
    for (const characterName of await db.listCharacters()) {
      const file = await db.getCharacter(characterName)
      if (file === undefined) continue
      const data = file.card.data
      const world = data.extensions['world']
      cards.push({
        name: characterName,
        creator: data.creator,
        tags: [...data.tags],
        world: typeof world === 'string' ? world : '',
        alternateGreetings: data.alternateGreetings.length,
      })
    }
    return { count: cards.length, cards }
  },
)