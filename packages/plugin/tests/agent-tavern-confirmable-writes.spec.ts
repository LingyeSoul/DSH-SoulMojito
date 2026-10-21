/**
 * D-2 confirmable session writes 集成回归（决策 2026-10-11-confirmable-session-writes）。
 *
 * 用「吞写宿主」驱动真实的激活/关闭桥接命令：append 正常返回但事件不进日志
 * （LWB saveChatConditional 吞异常/等锁超时静默不保存的形状，见
 * docs/exploration/2026-10-11-jsr-lwb-reference.md §3.3）。每个「必须成立」
 * 写入点都要证明三件事：
 *
 * 1. 吞写被读回验证发现，重试发生（重写恰好一次）；
 * 2. 重试仍失败时如实上抛/降级，宿主日志一行 error 可观测（含写入点标识与
 *    两次尝试结果），绝不静默吞；
 * 3. 轮次基线只推进到读回确认的轮号——旧行为会把基线推进到计划轮号，吞写
 *    宿主上 live 首轮撞号，v4 关系准入把整个会话判损坏
 *    （agent-tavern-session-admission.spec.ts 的 stale 负向对照即该形状）。
 *
 * 正常路径行为不变的回归由 tavern-command.spec.ts 全量持有（43 用例）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = '露西'

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/**
 * 可编程吞写宿主 agent。`drop` 返回 true 的事件被静默丢弃（append 照常返回），
 * 丢弃记录进 `swallowed` 供断言重试次数；其余事件进 `events`（rc.6 形状，
 * sessionEvents 兼容层直接可读）。`headerVersion` 提供 v4 header 以触发
 * 受保护头 + settlement 的导入形状。
 */
function makeAgent(
  id: string,
  drop?: (type: string, data: unknown) => boolean,
  headerVersion?: number,
) {
  const events: Array<{ type: string; data: unknown; opts?: unknown }> = []
  const swallowed: Array<{ type: string; data: unknown }> = []
  const injections: unknown[] = []
  const agent = {
    id,
    ctx: { id },
    injections,
    swallowed,
    events,
    phase: { kind: 'idle', lastTurn: 0 },
    inject: (message: unknown) => { injections.push(message) },
    session: {
      ...(headerVersion === undefined ? {} : { header: { version: headerVersion } }),
      events,
      append: (type: string, data: unknown, opts?: unknown) => {
        if (drop?.(type, data)) {
          swallowed.push({ type, data })
          return undefined
        }
        events.push(opts === undefined ? { type, data } : { type, data, opts })
        return events.at(-1)
      },
    },
  }
  return agent
}

function lastLoggedTurn(agent: ReturnType<typeof makeAgent>): number | undefined {
  let last: number | undefined
  for (const event of agent.session.events) {
    if (event.type !== 'turn/start') continue
    const value = (event.data as { turn?: unknown }).turn
    if (typeof value === 'number' && Number.isSafeInteger(value) && (last === undefined || value > last)) last = value
  }
  return last
}

describe('confirmable session writes against a swallowing host', () => {
  let home: string
  let store: TavernStore
  let handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }>
  let warns: string[]
  let errors: string[]
  let chatId: string
  let greetingChatId: string

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-confirmable-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'soulmojito'))
    await store.importCharacter({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: CHARACTER, description: 'A test character', personality: '', scenario: '', first_mes: 'Hello',
        mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
        alternate_greetings: [], tags: [], creator: '', character_version: '',
      },
    })
    const meta = { user_name: 'unused', character_name: 'unused', chat_metadata: { createdAt: new Date().toISOString(), timedWorldInfo: {} } }
    chatId = await store.createChat(CHARACTER, meta, [])
    const now = new Date().toISOString()
    greetingChatId = await store.createChat(CHARACTER, meta, [
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '早上好，旅行者。' },
      { name: 'User', is_user: true, is_system: false, send_date: now, mes: '你也是早上好。' },
      { name: CHARACTER, is_user: false, is_system: false, send_date: now, mes: '今天想去哪里？' },
    ])

    let definition: { handler: (input: { agent: unknown; rawInput: string }) => Promise<{ kind: string }> } | undefined
    warns = []
    errors = []
    apply({
      logger: {
        warn: (message: string) => { warns.push(message) },
        error: (message: string) => { errors.push(message) },
      },
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: (def: unknown) => { definition = def as typeof definition } },
      webServer: { register: () => () => {} },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (agentContext: unknown, presetId: string) => ({ id: presetId, agent: agentContext }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      agents: { get: () => undefined },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never, { checkForUpdates: false })
    expect(definition).toBeDefined()
    handler = definition!.handler
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  // 日志行捕获数组跨用例共享（apply 只跑一次）；逐用例清空，断言只看本用例。
  beforeEach(() => {
    warns.length = 0
    errors.length = 0
  })

  it('fails the ST activation honestly when the host swallows every append', async () => {
    const agent = makeAgent('swallow-st', () => true)
    await expect(handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId }),
    })).rejects.toThrow(/activation marker could not be confirmed/)
    // 重试恰好发生一次：marker 与占位 turn/start 的重写也都进了 swallowed。
    expect(agent.swallowed.filter((event) => event.type === 'user/message')).toHaveLength(2)
    expect(agent.swallowed.filter((event) => event.type === 'turn/start')).toHaveLength(2)
    expect(errors.some((line) => line.includes('session occupation turn/start') && line.includes('attempt 1: absent'))).toBe(true)
    expect(errors.some((line) => line.includes('Tavern activation marker') && line.includes('attempt 2: absent'))).toBe(true)
    // 基线绝不推进到未确认的轮号：吞写宿主上推进 = live 首轮撞号 = 会话损坏。
    expect(agent.phase.lastTurn).toBe(0)
    expect(lastLoggedTurn(agent)).toBeUndefined()
    // 绑定先于 marker 落库（既有顺序）：如实半激活，比静默假激活可诊断。
    expect((await store.getState()).sessionBindings['swallow-st']).toMatchObject({ architecture: 'st', character: CHARACTER, chatId })
  })

  it('never advances the occupation base when the placeholder pair lands asymmetrically', async () => {
    // 只吞 turn/end{1}：turn/start 落账、turn/end 两次都被吞。基线绝不能推进——
    // 推进后 live 首轮会写 turn 2 而日志 nextTurn 仍是 1，v4 准入判损坏。
    const agent = makeAgent('half-occupy-st', (type, data) => type === 'turn/end' && (data as { turn?: number })?.turn === 1)
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    // 占位确认失败是既有降级（不阻断激活）；marker 照常确认成功。
    expect(result.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'turn/end')).toHaveLength(0)
    expect(agent.swallowed.filter((event) => event.type === 'turn/end')).toHaveLength(2)
    expect(errors.some((line) => line.includes('session occupation turn/end') && line.includes('attempt 2: absent'))).toBe(true)
    expect(agent.phase.lastTurn).toBe(0)
  })

  it('confirms the ST activation marker after one rewrite when the swallow is transient', async () => {
    let swallowedFirstMarker = false
    const agent = makeAgent('transient-swallow-st', (type, data) => {
      if (!swallowedFirstMarker && type === 'user/message'
        && (data as { source?: { summary?: string } }).source?.summary === `Tavern: ${CHARACTER}`) {
        swallowedFirstMarker = true
        return true
      }
      return false
    })
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    // marker 恰好一条（首写被吞、重写落账），占位 turn 正常，基线正常推进。
    expect(agent.session.events.filter((event) => event.type === 'user/message')).toHaveLength(1)
    expect(agent.session.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.phase.lastTurn).toBe(1)
    expect(warns.some((line) => line.includes('Tavern activation marker') && line.includes('rewrite'))).toBe(true)
  })

  it('heals a lost ST activation marker on re-activation even when the binding is unchanged', async () => {
    const agent = makeAgent('heal-st')
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    // 模拟 marker 此前被吞写/丢失：把 marker 从日志里抠掉，绑定保留。
    const markerIndex = agent.session.events.findIndex((event) => event.type === 'user/message')
    expect(markerIndex).toBeGreaterThanOrEqual(0)
    agent.session.events.splice(markerIndex, 1)
    const result = await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    expect(result.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'user/message')).toHaveLength(1)
  })

  it('refuses to activate silently: a swallowed AgentTavern preset marker fails the activation', async () => {
    // 只吞 agent-preset/selected：marker 先于导入与绑定写入，聚焦该写入点。
    const agent = makeAgent('swallow-preset', (type) => type === 'agent-preset/selected', 4)
    await expect(handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })).rejects.toThrow(/preset marker could not be confirmed/)
    expect(agent.swallowed.filter((event) => event.type === 'agent-preset/selected')).toHaveLength(2)
    expect(errors.some((line) => line.includes('AgentTavern preset marker') && line.includes('attempt 2: absent'))).toBe(true)
    // marker 未确认即不落绑定：会话不会带着「重载即失忆」的身份静默进入服务。
    expect((await store.getState()).sessionBindings['swallow-preset']).toBeUndefined()
  })

  it('degrades a swallowed history import to the verified prefix and never advances the turn base blindly', async () => {
    // 预设 marker 放行（验证聚焦导入），导入事件全吞——LWB 静默不保存的正主形状。
    const agent = makeAgent('swallow-import', (type) => type !== 'agent-preset/selected', 4)
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    // 导入失败按既有模式降级（不阻断绑定），但必须如实报告两次尝试。
    expect(result.kind).toBe('success')
    expect(agent.session.events.some((event) => event.type === 'turn/start')).toBe(false)
    const line = errors.find((item) => item.includes('history import could not be confirmed by read-back'))
    expect(line).toBeDefined()
    // 错误行含两次尝试的量化结果，且吞写总数 = 计划 × 2（首写 + 安全全量重放）。
    const planned = Number(/attempt 1: 0\/(\d+)/.exec(line ?? '')?.[1] ?? -1)
    expect(planned).toBeGreaterThan(0)
    expect(agent.swallowed.filter((event) => event.type !== 'agent-preset/selected')).toHaveLength(planned * 2)
    expect(line).toContain('attempt 2: 0/')
    // 基线保持 0：旧逻辑这里会推进到计划轮号 3，吞写宿主上 live 首轮撞号，
    // v4 准入（turn/start does not open the expected turn）判整个会话损坏。
    expect(agent.phase.lastTurn).toBe(0)
    expect((await store.getState()).sessionBindings['swallow-import']).toMatchObject({ architecture: 'agent-tavern', chatId: greetingChatId })
  })

  it('completes the import with one suffix retry when only the tail was swallowed', async () => {
    // 只吞最后一项（turn 3 的 turn/end）：干净前缀 15/16，后缀重试补齐，无 error。
    let swallowedTail = false
    const agent = makeAgent('tail-swallow-import', (type, data) => {
      if (!swallowedTail && type === 'turn/end' && (data as { turn?: number }).turn === 3) {
        swallowedTail = true
        return true
      }
      return false
    }, 4)
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    expect(agent.session.events.filter((event) => event.type === 'turn/end')).toHaveLength(3)
    expect(agent.session.events.at(-1)).toMatchObject({ type: 'turn/end', data: { turn: 3 } })
    expect(agent.phase.lastTurn).toBe(3)
    expect(errors.filter((item) => item.includes('history import'))).toEqual([])
  })

  it('refuses the suffix retry when the log tail holds unplanned events', async () => {
    // 吞全部 step/end：首写留下错位残渣（turn/end 越过缺失的 step/end 落账），
    // 任何重放都会重复边界事件——协议必须拒绝重试、如实报告、基线只推进到
    // 读回确认的轮号。
    const agent = makeAgent('misaligned-import', (type) => type === 'step/end', 4)
    const result = await handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId: greetingChatId, architecture: 'agent-tavern', contextMode: 'dsh-native' }),
    })
    expect(result.kind).toBe('success')
    // 重试被拒：turn/start 只有一轮（不重放），全部来自首写。
    expect(agent.session.events.filter((event) => event.type === 'turn/start')).toHaveLength(3)
    const line = errors.find((item) => item.includes('history import could not be confirmed by read-back'))
    expect(line).toContain('suffix retry refused')
    expect(line).toContain('unplanned events')
    // 基线 = 日志里实际落地的最大轮号——以日志为准，不以计划为准。
    expect(agent.phase.lastTurn).toBe(lastLoggedTurn(agent))
    expect(agent.phase.lastTurn).toBe(3)
  })

  it('fails the close command honestly when the host swallows the close marker', async () => {
    const agent = makeAgent('swallow-close')
    await handler({ agent, rawInput: base64Url({ character: CHARACTER, chatId }) })
    const before = agent.session.events.length
    // 激活完成后转为吞写：关闭 marker 无处落账。
    let swallowing = false
    const originalAppend = agent.session.append.bind(agent.session)
    agent.session.append = (type: string, data: unknown, opts?: unknown) => {
      if (swallowing) {
        agent.swallowed.push({ type, data })
        return undefined
      }
      return originalAppend(type, data, opts)
    }
    swallowing = true
    await expect(handler({
      agent,
      rawInput: base64Url({ action: 'close' }),
    })).rejects.toThrow(/close marker could not be confirmed/)
    expect(agent.swallowed.filter((event) => event.type === 'user/message')).toHaveLength(2)
    expect(errors.some((line) => line.includes('Tavern close marker') && line.includes('attempt 2: absent'))).toBe(true)
    // 绑定删除先于 marker 提交（既有顺序）；日志无新增 = 无静默痕迹。
    expect(agent.session.events).toHaveLength(before)
    expect((await store.getState()).sessionBindings['swallow-close']).toBeUndefined()
  })

  it('cannot confirm writes on a host whose session log shape is unreadable', async () => {
    // readSessionEvents 全探测失败（无 events/snapshotEvents/log）→ 读回恒空 →
    // 协议如实失败，不硬造确认：激活 marker 抛错、占位不推进、error 可观测。
    const swallowed: Array<{ type: string; data: unknown }> = []
    const agent = {
      id: 'unreadable-log-st',
      ctx: { id: 'unreadable-log-st' },
      injections: [] as unknown[],
      phase: { kind: 'idle', lastTurn: 0 },
      inject: (message: unknown) => { agent.injections.push(message) },
      session: {
        append: (type: string, data: unknown) => { swallowed.push({ type, data }) },
      },
    }
    await expect(handler({
      agent,
      rawInput: base64Url({ character: CHARACTER, chatId }),
    })).rejects.toThrow(/could not be confirmed/)
    expect(agent.phase.lastTurn).toBe(0)
    expect(errors.some((line) => line.includes('session occupation turn/start'))).toBe(true)
    expect(errors.some((line) => line.includes('Tavern activation marker'))).toBe(true)
  })
})
