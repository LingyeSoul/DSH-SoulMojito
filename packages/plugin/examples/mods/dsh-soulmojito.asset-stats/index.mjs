/**
 * 示例 Mod（提案 0015 P1 交付物）：资产只读统计。
 *
 * 演示的 P1 API 面：
 * - api.assets.*：只读快照（角色卡/世界书/预设/用户人设/群组/聊天列表）；
 * - api.http.route：GET stats 子路由（JSON 出口）；
 * - api.storage：私有 kv（统计次数与 chat-saved 计数持久化，1MB 配额内）；
 * - api.events.on：chat-saved 事件计数；
 * - setup 返回 dispose（与 api.onDispose 合并的卸载链）。
 *
 * 它同时是 e2e 测试与 mod-loader gate 的夹具：临时 DSH_HOME 里拷贝本目录后
 * 走完 扫描 → 双默认关 → 两层启用 → setup 执行 → 路由可访 → 禁用 404 → reload。
 */
export async function setup(api) {
  let fetchCount = Number((await api.storage.get('fetchCount')) ?? 0)
  let chatSaves = Number((await api.storage.get('chatSaves')) ?? 0)

  const offChatSaved = api.events.on('chat-saved', async () => {
    chatSaves += 1
    await api.storage.set('chatSaves', chatSaves)
  })

  api.http.route('GET', 'stats', async (req, reply) => {
    const [characters, worlds, presets, personas, groups] = await Promise.all([
      api.assets.listCharacters(),
      api.assets.listWorlds(),
      api.assets.listPresets(),
      api.assets.listPersonas(),
      api.assets.listGroups(),
    ])
    const chats = {}
    for (const character of characters) {
      chats[character] = (await api.assets.listChats(character)).length
    }
    fetchCount += 1
    await api.storage.set('fetchCount', fetchCount)
    reply.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      counts: { characters: characters.length, worlds: worlds.length, presets: presets.length, personas: personas.length, groups: groups.length, chats },
      fetchCount,
      chatSaves,
    })
  })

  api.logger.info(`asset-stats ready (api v${api.version})`)

  return async () => {
    offChatSaved()
    await api.storage.set('disposed', true)
    api.logger.info('asset-stats disposed')
  }
}
