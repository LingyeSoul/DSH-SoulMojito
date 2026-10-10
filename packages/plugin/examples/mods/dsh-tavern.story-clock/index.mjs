/**
 * 示例 Mod（Mod API 文档 docs/mods/mod-api.md 的配套活样例）：剧情时钟。
 *
 * 与 asset-stats（P1 面）/ mood-tracker（P2 三件套）互补，本示例演示其余能力面：
 * - api.macros.register：{{clock}} / {{clock::day}} / {{clock::time}} 宏——同步、
 *   确定性（无随机/时间源；宿主注册期静态筛查 + 运行期降级保原文双保险）。
 *   权威数据放**聊天变量** `clock`（分钟数，自第 1 天 08:00 起）：宏经
 *   engine.getVar 读，天然按聊天隔离，跨 bundle 对所有宏引擎实例生效。
 * - api.stscript.registerCommand：/clock 命令族（show / advance / set），演示
 *   位置参数、命名参数、别名、异步 handler 与 chatChanged 语义（写变量后返回
 *   changed 让宿主持久化聊天——与内置 /setvar 同款）。
 * - api.hooks.on：两个新相位——user-input（文本→文本变换位：剥离零宽字符的
 *   粘贴残留）与 post-save（只读观察位：按聊天统计落盘轮次；返回值被丢弃）。
 * - api.prompt.section：AgentTavern 侧 system prompt 分区（order 宿主钳制
 *   -50..0，本例 -40；文本不得含 {{...}}，宿主会中性化残留宏）。
 * - api.llm：capability 门控面（manifest capabilities 含 'llm' 才有该键）——
 *   POST summarize 用 api.llm.request 聚合流式输出（text/usage/finish）。
 * - api.timers.setInterval：宿主托管生命周期的定时器（心跳计数，dispose 时落盘）。
 * - api.events.on：assets-saved / guides-changed（chat-saved 已由 asset-stats 示范）。
 *
 * 卸载纪律：注册一律走 api.*，宿主持全量反注册（offRegistrations/offEvents/
 * 定时器/路由表随实例回收）——本示例刻意不手动保存 off 句柄，演示「宿主托管」
 * 这一路（mood-tracker 示范手动 off 的对称路线）。仅 setup 返回的 dispose 需要
 * 自写（flush 心跳计数）。ESM 实例驻留是已知限制：模块级副作用无法回收，注册
 * 必须走 api.* 正是为此。
 */

/** 故事起点：第 1 天 08:00（分钟偏移 0）。 */
const DAY_START_MINUTES = 8 * 60

/** 分钟数 → 「第N天 HH:MM」。纯函数：无随机、无时间源（确定性宏纪律）。 */
function formatClock(totalMinutes) {
  const shifted = Math.max(0, Math.floor(totalMinutes)) + DAY_START_MINUTES
  const day = Math.floor(shifted / 1440) + 1
  const minutesOfDay = shifted % 1440
  const hh = String(Math.floor(minutesOfDay / 60)).padStart(2, '0')
  const mm = String(minutesOfDay % 60).padStart(2, '0')
  return { day, time: `${hh}:${mm}`, full: `第${day}天 ${hh}:${mm}` }
}

/** 「30m」「2h」「1h30m」「45」→ 分钟数；解析失败返回 undefined。 */
function parseDuration(text) {
  const value = String(text ?? '').trim().toLowerCase()
  if (value === '') return undefined
  if (/^\d+$/.test(value)) return Number(value)
  const match = /^(\d+h)?(\d+m)?$/.exec(value.replace(/\s+/g, ''))
  if (match === null || (match[1] === undefined && match[2] === undefined)) return undefined
  return Number((match[1] ?? '0h').slice(0, -1)) * 60 + Number((match[2] ?? '0m').slice(0, -1))
}

/** 「HH:MM」→ 当天分钟数；解析失败返回 undefined。 */
function parseTimeOfDay(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** storage 键规则：Unicode 字母/_.- 且 ≤64 字符（见 mod-api.md §storage）。 */
function storageSafeKey(text) {
  const cleaned = String(text ?? '').replace(/[^\p{L}\p{N}_.-]+/gu, '-').slice(0, 48)
  return cleaned === '' ? 'x' : cleaned
}

/** 粘贴残留的零宽字符（宏与正则的隐形杀手）：user-input 变换位的清理对象。 */
const ZERO_WIDTH_PATTERN = /[\u200B\u200C\u200D\u2060\uFEFF]/g

export async function setup(api) {
  let commandRuns = Number((await api.storage.get('commandRuns')) ?? 0)
  let timerTicks = 0
  let assetSaves = 0
  let guideChanges = 0

  // 宏：{{clock}}（参数空=完整，「day」/「time」=分面）。同步读聊天变量；
  // 未设置 → 0（第1天 08:00）。返回 null 可保原文不替换，本例恒有值。
  // 注意：handler 源码里不得出现随机/时间源（注册期静态筛查会拒绝）。
  api.macros.register('clock', (args, engine) => {
    const raw = engine.getVar('clock')
    const minutes = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
    const view = formatClock(minutes)
    const arg = String(args[0] ?? '').toLowerCase()
    if (arg === 'day') return view.day === 1 ? '第1天' : `第${view.day}天`
    if (arg === 'time') return view.time
    return view.full
  })

  // STscript：/clock（=show）、/clock advance 1h30m、/clock set 14:30、
  // /clock set day=2 time=09:30。别名 /storyclock。写变量后返回 changed
  // （chatChanged: true）让宿主把聊天（含变量）落盘——与内置 /setvar 同款。
  api.stscript.registerCommand('clock', {
    name: 'clock',
    aliases: ['storyclock'],
    run: async (cmd, env) => {
      const sub = (cmd.args[0] ?? '').toLowerCase()
      const read = () => {
        const raw = env.getVar('clock')
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      }
      const mutate = async (next) => {
        env.setVar('clock', Math.max(0, Math.floor(next)))
        commandRuns += 1
        await api.storage.set('commandRuns', commandRuns)
        return { output: formatClock(next).full, chatChanged: true }
      }
      if (sub === '' || sub === 'show') {
        return { output: formatClock(read()).full, chatChanged: false }
      }
      if (sub === 'advance') {
        const delta = parseDuration(cmd.args[1] ?? cmd.named['by'])
        if (delta === undefined) throw new Error('/clock advance requires a duration like 30m, 2h or 1h30m')
        return mutate(read() + delta)
      }
      if (sub === 'set') {
        const positionalTime = parseTimeOfDay(cmd.args[1])
        const namedTime = parseTimeOfDay(cmd.named['time'])
        const dayText = cmd.named['day']
        if (positionalTime === undefined && namedTime === undefined && dayText === undefined) {
          throw new Error('/clock set expects a time (14:30) and/or day=N')
        }
        // 变量存「自第1天08:00起的分钟」；换算成「自第1天00:00的绝对分钟」再改
        // 钟点/天数（与 formatClock 同款换算），最后钳回非负（早于故事起点=第1天
        // 08:00 的钟点收边到起点，例：/clock set 06:00 在第1天得到 08:00）。
        const shifted = read() + DAY_START_MINUTES
        let nextShifted = shifted
        const timeOfDay = positionalTime ?? namedTime
        if (timeOfDay !== undefined) nextShifted = Math.floor(nextShifted / 1440) * 1440 + timeOfDay
        if (dayText !== undefined) {
          const day = Number(dayText)
          if (!Number.isInteger(day) || day < 1 || day > 999) throw new Error('/clock set day= expects an integer 1..999')
          nextShifted = (day - 1) * 1440 + (nextShifted % 1440)
        }
        return mutate(Math.max(0, nextShifted - DAY_START_MINUTES))
      }
      throw new Error(`unknown /clock subcommand '${sub}' (expected show | advance | set)`)
    },
  })

  // 管线 hook（变换位）：user-input 在 USER_INPUT regex 之前看到用户原文。
  // 返回**修改后的文本**（忘 return 会被总线按 no-return 降级跳过）。这里剥离
  // 零宽字符——不改语义的清理变换；失败/超时由总线降级保原文，不中断生成。
  api.hooks.on('user-input', async (text) => {
    const cleaned = String(text).replace(ZERO_WIDTH_PATTERN, '')
    return cleaned
  })

  // 管线 hook（观察位）：post-save 在 saveChat 之后，返回值被丢弃——只读观察。
  // payload 含 { chat, revision, speaker, finalText }；context 含聊天归因。
  api.hooks.on('post-save', async (_payload, context) => {
    const key = `turns-${storageSafeKey(context.character)}-${storageSafeKey(context.chatId)}`
    const turns = Number((await api.storage.get(key)) ?? 0) + 1
    await api.storage.set(key, turns)
  })

  // AgentTavern 侧 system prompt 分区：order 宿主钳制 -50..0（核心占 -80..-64），
  // 文本过 hostPromptSafe 中性化——不要写 {{...}}（会被当残留宏中性化）。
  api.prompt.section({
    name: 'story-clock',
    text: 'In-fiction time is tracked in the chat variable `clock` (integer minutes since day 1, 08:00; unset means day 1, 08:00). When the passage of time matters, read it with the variable_get tool and reference it in prose as "Day N, HH:MM". The user advances the clock with the /clock command; do not invent a conflicting time.',
    order: -40,
  })

  // 事件面：assets-saved / guides-changed（逐个吞错，失败只进审计不断宿主）。
  api.events.on('assets-saved', async (payload) => {
    assetSaves += 1
    await api.storage.set('assetSaves', { count: assetSaves, last: `${payload.kind}:${payload.name}` })
  })
  api.events.on('guides-changed', async (payload) => {
    guideChanges += 1
    await api.storage.set('guideChanges', { count: guideChanges, last: `${payload.character}/${payload.chatId}` })
  })

  // 定时器：宿主托管生命周期（卸载自动 clearInterval）；handler 内同步抛错与
  // 异步拒绝都由适配层包装进审计（timer-error），不会变成进程级崩溃。
  api.timers.setInterval(() => {
    timerTicks += 1
  }, 5 * 60 * 1000)

  // HTTP 面：GET status（JSON 出口）；POST summarize（llm 能力门控——
  // api.llm 仅在 manifest capabilities 含 'llm' 时存在；请求形状对齐部署的
  // dsh-llm stream 接口：{ provider, model, messages, system?, maxTokens? }）。
  api.http.route('GET', 'status', async (_req, reply) => {
    reply.json({
      ok: true,
      apiVersion: api.version,
      macro: '{{clock}} reads chat variable "clock" (minutes since day 1, 08:00)',
      command: '/clock | /clock advance 30m | /clock set 14:30 | /clock set day=2 time=09:30',
      llm: typeof api.llm === 'object' ? 'available' : 'unavailable (declare the llm capability)',
      counters: { commandRuns, timerTicks, assetSaves, guideChanges },
    })
  })
  api.http.route('POST', 'summarize', async (req, reply) => {
    const body = await req.json()
    const character = String(body.character ?? '')
    const chatId = String(body.chatId ?? '')
    const provider = String(body.provider ?? '')
    const model = String(body.model ?? '')
    if (character === '' || chatId === '' || provider === '' || model === '') {
      // 演示 reply.json 的状态码出口；handler 抛错则由宿主兜底 500 + 审计。
      reply.json({ ok: false, message: 'expected { character, chatId, provider, model }' }, 400)
      return
    }
    const chat = await api.assets.getChat(character, chatId)
    if (chat === null) {
      reply.json({ ok: false, message: `chat '${character}/${chatId}' not found` }, 404)
      return
    }
    const turns = (chat.messages ?? [])
      .filter((message) => !message.is_system && typeof message.mes === 'string' && message.mes.trim() !== '')
      .slice(-8)
      .map((message) => ({
        role: message.is_user ? 'user' : 'assistant',
        content: [{ type: 'text', text: String(message.mes).slice(0, 2000) }],
      }))
    if (turns.length === 0) {
      reply.json({ ok: false, message: 'the chat has no message turns to summarize' }, 400)
      return
    }
    // api.llm.request：stream 的收集出口（text/reasoning/usage/finish 聚合）。
    // 用量自动进审计线（llm-call）；失败原样抛出（宿主记 llm-error 审计）。
    const result = await api.llm.request({
      provider,
      model,
      messages: turns,
      system: 'You summarize roleplay turns. Reply with 2-3 neutral sentences: what happened, where the scene stands, and any open thread. Do not invent facts.',
      maxTokens: 300,
    })
    reply.json({ ok: true, summary: result.text, usage: result.usage ?? null, finish: result.finish ?? null })
  })

  api.logger.info(`story-clock ready (api v${api.version}); type /clock in the composer to start tracking time`)

  // 卸载：注册面由宿主托管回收（api.* 的反注册/定时器/路由/事件随实例清空），
  // 这里只 flush 定时器计数。onDispose 与 setup 返回值两条挂接路线等价。
  return async () => {
    await api.storage.set('timerTicks', timerTicks)
    api.logger.info('story-clock disposed')
  }
}
