import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as applyPlugin } from '../src/index.js'
import { apply, type AgentContextLike } from '../src/card-workbench/agent.js'
import {
  applyCardPlan,
  decideCardPlan,
  getCardPlan,
  listCardPlans,
  proposeCardPlan,
} from '../src/card-workbench/plans.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Plan Card'
const OTHER_CHARACTER = 'Bystander Card'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<any>
}

function makeRequest(body: unknown, url: string) {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method: 'POST',
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeGetRequest(url: string) {
  return { method: 'GET', url, on: () => undefined, destroy: () => {} }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk)
      response.writableEnded = true
    },
    on: () => {},
  }
  return response
}

function cardPayload(name: string) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: 'A card for plan tests.',
      personality: 'Calm.',
      scenario: 'A planning room.',
      first_mes: 'Plan first.',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      extensions: {},
    },
  }
}

describe('Card Workbench plan confirmation protocol (proposal 0013 P2)', () => {
  let home: string
  let tavern: string
  let store: TavernStore
  let apiHandler: (req: unknown, res: unknown) => Promise<void>
  let tools: Map<string, RegisteredTool>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'card-workbench-plans-'))
    process.env.DSH_HOME = home
    tavern = join(home, 'tavern')
    store = await TavernStore.open(tavern)

    await applyPlugin({
      systemPrompt: { section: () => {}, context: () => {} },
      commands: { register: () => {} },
      webServer: { register: (def) => { apiHandler = def.handler; return () => {} } },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'agent-tavern' }, { id: 'agent-novel' }, { id: 'card-workbench' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: { get: () => undefined },
      effect: (fn: () => unknown) => { fn(); return () => {} },
    } as never)
    expect(apiHandler).toBeDefined()

    tools = new Map()
    apply({
      systemPrompt: { section: () => {} },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)

    await store.importCharacter(cardPayload(CHARACTER))
    await store.importCharacter(cardPayload(OTHER_CHARACTER))
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  /* ------------------------------ 存储层往返 ------------------------------ */

  it('proposeCardPlan persists a pending plan with atomic file shape', async () => {
    const plan = await proposeCardPlan(tavern, CHARACTER, {
      title: 'Soften the personality',
      changes: [
        { field: 'personality', currentValue: 'Calm.', newValue: 'Warm and curious.', note: 'user wants friendlier tone' },
        { field: 'creatorNotes', currentValue: '', newValue: 'Edited via workbench.' },
      ],
    })
    expect(plan.status).toBe('pending')
    expect(plan.changes).toEqual([
      { field: 'personality', currentValue: 'Calm.', newValue: 'Warm and curious.', note: 'user wants friendlier tone' },
      { field: 'creatorNotes', currentValue: '', newValue: 'Edited via workbench.' },
    ])
    const file = join(tavern, 'card-workbench', 'plans', `${plan.id}.json`)
    expect(existsSync(file)).toBe(true)
    // 人可读可 diff 的规范 JSON,且可原样读回。
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ id: plan.id, status: 'pending', character: CHARACTER })
    expect((await getCardPlan(tavern, plan.id))!.title).toBe('Soften the personality')
  })

  it('listCardPlans filters by character/status and decides transitions round-trip', async () => {
    const keep = await proposeCardPlan(tavern, CHARACTER, { title: 'keep pending', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'y' }] })
    const approve = await proposeCardPlan(tavern, CHARACTER, { title: 'to approve', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'z' }] })
    const reject = await proposeCardPlan(tavern, OTHER_CHARACTER, { title: 'to reject', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'w' }] })

    expect((await listCardPlans(tavern)).map((plan) => plan.id)).toContain(keep.id)
    expect((await listCardPlans(tavern, { status: 'pending' })).map((plan) => plan.id)).toEqual(
      expect.arrayContaining([keep.id, approve.id, reject.id]),
    )
    expect((await listCardPlans(tavern, { character: OTHER_CHARACTER })).map((plan) => plan.id)).toEqual([reject.id])

    const approved = await decideCardPlan(tavern, approve.id, true)
    expect(approved.status).toBe('approved')
    expect(approved.decidedAt).toBeDefined()
    const rejected = await decideCardPlan(tavern, reject.id, false)
    expect(rejected.status).toBe('rejected')
    // 状态过滤生效
    expect((await listCardPlans(tavern, { character: OTHER_CHARACTER, status: 'rejected' })).map((plan) => plan.id)).toEqual([reject.id])
    // 非pending不可再决定
    await expect(decideCardPlan(tavern, approve.id, false)).rejects.toThrow('already approved')
    await expect(decideCardPlan(tavern, 'plan-missing')).rejects.toThrow('not found')

    const applied = await applyCardPlan(tavern, approve.id)
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).toBeDefined()
    await expect(applyCardPlan(tavern, approve.id)).rejects.toThrow('already applied')
    await expect(applyCardPlan(tavern, reject.id)).rejects.toThrow('was rejected')
    await expect(decideCardPlan(tavern, keep.id, true)).resolves.toMatchObject({ status: 'approved' })
    rmSync(join(tavern, 'card-workbench', 'plans', `${keep.id}.json`))
  })

  it('proposeCardPlan validates plan shape', async () => {
    await expect(proposeCardPlan(tavern, CHARACTER, { title: '', changes: [{ field: 'personality', currentValue: '', newValue: 'x' }] }))
      .rejects.toThrow('title')
    await expect(proposeCardPlan(tavern, CHARACTER, { title: 't', changes: [] })).rejects.toThrow('non-empty')
    await expect(proposeCardPlan(tavern, CHARACTER, { title: 't', changes: [
      { field: 'personality', currentValue: '', newValue: 'x' },
      { field: 'personality', currentValue: '', newValue: 'y' },
    ] })).rejects.toThrow('duplicate change field')
    await expect(proposeCardPlan(tavern, CHARACTER, { title: 't', changes: [{ field: 'personality', currentValue: '', newValue: 'x', note: 'n'.repeat(501) }] }))
      .rejects.toThrow('note')
    // planId 注入面:非法 id 直接视为不存在,而不是拼路径
    expect(await getCardPlan(tavern, '../../etc/passwd')).toBeUndefined()
  })

  /* --------------------------- 工具层:方案执行路径 --------------------------- */

  it('card_plan_propose snapshots live current values and returns a planId', async () => {
    const result = await tools.get('card_plan_propose')!.execute({
      character: CHARACTER,
      title: 'Rewrite personality',
      changes: [
        { field: 'personality', newValue: 'Bold.', note: 'sharper voice' },
        { field: 'description', newValue: 'A rewritten card.' },
      ],
    })
    expect(result).toMatchObject({
      character: CHARACTER,
      title: 'Rewrite personality',
      status: 'pending',
      changes: [
        { field: 'personality', currentValue: 'Calm.', newValue: 'Bold.', note: 'sharper voice' },
        { field: 'description', currentValue: 'A card for plan tests.', newValue: 'A rewritten card.' },
      ],
    })
    expect(typeof result.planId).toBe('string')
    // 白名单外的字段进不了方案
    await expect(tools.get('card_plan_propose')!.execute({
      character: CHARACTER,
      title: 'bad',
      changes: [{ field: 'extensions', newValue: '{}' }],
    })).rejects.toThrow('is not editable')
    // 未知角色在 propose 阶段就失败
    await expect(tools.get('card_plan_propose')!.execute({
      character: 'No Such Card',
      title: 'bad',
      changes: [{ field: 'personality', newValue: 'x' }],
    })).rejects.toThrow('not found')
  })

  it('card_put with planId applies the recorded plan and ignores direct changes', async () => {
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: CHARACTER,
      title: 'Apply via plan',
      changes: [{ field: 'personality', newValue: 'Plan-applied personality.' }],
    })
    // 未确认:方案不动,卡不动
    await expect(tools.get('card_put')!.execute({ character: CHARACTER, planId: proposed.planId }))
      .rejects.toThrow('confirmation required')
    expect((await getCardPlan(tavern, proposed.planId))!.status).toBe('pending')
    expect((await store.getCharacter(CHARACTER))!.card.data.personality).toBe('Calm.')
    // 确认后:按方案执行,直传 changes 被忽略(这里是干扰值)
    const applied = await tools.get('card_put')!.execute({
      character: CHARACTER,
      planId: proposed.planId,
      confirmed: true,
      changes: [{ field: 'creatorNotes', value: 'direct edits ignored' }],
    })
    expect(applied).toMatchObject({ character: CHARACTER, planId: proposed.planId, planStatus: 'applied' })
    const saved = await store.getCharacter(CHARACTER)
    expect(saved!.card.data.personality).toBe('Plan-applied personality.')
    expect(saved!.card.data.creatorNotes).toBe('')
    // 方案已 applied:重复执行拒绝
    await expect(tools.get('card_put')!.execute({ character: CHARACTER, planId: proposed.planId, confirmed: true }))
      .rejects.toThrow('already applied')
    // character 与方案不符拒绝
    const other = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'wrong card',
      changes: [{ field: 'personality', newValue: 'x' }],
    })
    await expect(tools.get('card_put')!.execute({ character: CHARACTER, planId: other.planId, confirmed: true }))
      .rejects.toThrow('belongs to character')
  })

  it('card_put rejects a stale plan instead of clobbering concurrent edits', async () => {
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: CHARACTER,
      title: 'stale plan',
      changes: [{ field: 'scenario', newValue: 'Rewritten scenario.' }],
    })
    // 方案落库后卡被(面板/其他会话)改动
    const current = await store.getCharacter(CHARACTER)
    await store.updateCharacter(CHARACTER, { data: { ...current!.card.data, scenario: 'changed elsewhere' } })
    await expect(tools.get('card_put')!.execute({ character: CHARACTER, planId: proposed.planId, confirmed: true }))
      .rejects.toThrow('stale')
    // 拒绝执行时方案保持 pending,可重新提案
    expect((await getCardPlan(tavern, proposed.planId))!.status).toBe('pending')
  })

  it('card_put refuses a rejected plan', async () => {
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'will be rejected',
      changes: [{ field: 'personality', newValue: 'nope' }],
    })
    await decideCardPlan(tavern, proposed.planId, false)
    await expect(tools.get('card_put')!.execute({ character: OTHER_CHARACTER, planId: proposed.planId, confirmed: true }))
      .rejects.toThrow('was rejected')
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.personality).toBe('Calm.')
  })

  /* ------------------------------ 面板路由 ------------------------------ */

  it('GET card-workbench/plans lists pending plans by default and honours filters', async () => {
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: CHARACTER,
      title: 'panel plan',
      changes: [{ field: 'firstMes', newValue: 'Panel-approved opening.' }],
    })
    const pending = makeResponse()
    await apiHandler(makeGetRequest(`/api/dsh-tavern/card-workbench/plans?character=${encodeURIComponent(CHARACTER)}`), pending)
    expect(pending.statusCode).toBe(200)
    const body = JSON.parse(pending.chunks[0]!)
    expect(body.ok).toBe(true)
    expect(body.plans.every((plan: { status: string; character: string }) => plan.status === 'pending' && plan.character === CHARACTER)).toBe(true)
    expect(body.plans.map((plan: { id: string }) => plan.id)).toContain(proposed.planId)
    // diff 面板需要的完整 before/after 值在方案里
    expect(body.plans.find((plan: { id: string }) => plan.id === proposed.planId).changes[0]).toMatchObject({
      field: 'firstMes',
      currentValue: 'Plan first.',
      newValue: 'Panel-approved opening.',
    })
    const badStatus = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/card-workbench/plans?status=nope'), badStatus)
    expect(badStatus.statusCode).toBe(400)
    expect(JSON.parse(badStatus.chunks[0]!)).toMatchObject({ ok: false, code: 'TAVERN_WORKBENCH' })
  })

  it('POST decision approve executes the plan; reject only changes status', async () => {
    const toApply = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'approve me',
      changes: [{ field: 'personality', newValue: 'Approved via panel.' }],
    })
    const approved = makeResponse()
    await apiHandler(makeRequest({ approve: true }, `/api/dsh-tavern/card-workbench/plans/${toApply.planId}/decision`), approved)
    expect(approved.statusCode).toBe(200)
    const body = JSON.parse(approved.chunks[0]!)
    expect(body.ok).toBe(true)
    expect(body.plan).toMatchObject({ id: toApply.planId, status: 'applied' })
    expect(body.applied).toMatchObject({
      character: OTHER_CHARACTER,
      changes: [{ field: 'personality', length: 'Approved via panel.'.length, preview: 'Approved via panel.' }],
    })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.personality).toBe('Approved via panel.')

    const toReject = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'reject me',
      changes: [{ field: 'personality', newValue: 'Never applied.' }],
    })
    const rejected = makeResponse()
    await apiHandler(makeRequest({ approve: false }, `/api/dsh-tavern/card-workbench/plans/${toReject.planId}/decision`), rejected)
    expect(rejected.statusCode).toBe(200)
    expect(JSON.parse(rejected.chunks[0]!).plan).toMatchObject({ status: 'rejected' })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.personality).toBe('Approved via panel.')

    // 非pending再决定/未知方案/坏请求 → TAVERN_WORKBENCH 错误码
    const decidedAgain = makeResponse()
    await apiHandler(makeRequest({ approve: true }, `/api/dsh-tavern/card-workbench/plans/${toReject.planId}/decision`), decidedAgain)
    expect(decidedAgain.statusCode).toBe(400)
    expect(JSON.parse(decidedAgain.chunks[0]!)).toMatchObject({ ok: false, code: 'TAVERN_WORKBENCH' })
    const missing = makeResponse()
    await apiHandler(makeRequest({ approve: true }, '/api/dsh-tavern/card-workbench/plans/plan-none/decision'), missing)
    expect(missing.statusCode).toBe(404)
    expect(JSON.parse(missing.chunks[0]!)).toMatchObject({ ok: false, code: 'TAVERN_WORKBENCH' })
    const badBody = makeResponse()
    await apiHandler(makeRequest({}, '/api/dsh-tavern/card-workbench/plans/whatever/decision'), badBody)
    expect(badBody.statusCode).toBe(400)
    expect(JSON.parse(badBody.chunks[0]!)).toMatchObject({ ok: false, code: 'TAVERN_WORKBENCH' })
    // 面板批准路径与对话路径一样做过期检测
    const stalePlan = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'stale for panel',
      changes: [{ field: 'personality', newValue: 'too late' }],
    })
    const current = await store.getCharacter(OTHER_CHARACTER)
    await store.updateCharacter(OTHER_CHARACTER, { data: { ...current!.card.data, personality: 'drifted' } })
    const staleDecision = makeResponse()
    await apiHandler(makeRequest({ approve: true }, `/api/dsh-tavern/card-workbench/plans/${stalePlan.planId}/decision`), staleDecision)
    expect(staleDecision.statusCode).toBe(400)
    expect(JSON.parse(staleDecision.chunks[0]!).message).toContain('stale')
    expect((await getCardPlan(tavern, stalePlan.planId))!.status).toBe('pending')
  })

  /* ------------------------------ 世界书工具 ------------------------------ */

  it('world_get summarizes entries and world_put edits whitelisted fields with confirmation', async () => {
    await store.importWorldFile('Panel Lore', {
      entries: {
        0: { uid: 0, key: ['tavern'], content: 'The tavern never sleeps.', comment: 'scene', disable: false },
        1: { uid: 1, key: ['city'], keysecondary: ['north'], content: 'The northern city.', disable: true },
      },
    })
    const summary = await tools.get('world_get')!.execute({ world: 'Panel Lore' })
    expect(summary).toMatchObject({
      found: true, world: 'Panel Lore', entryCount: 2, nextUid: 2, truncated: false,
      entries: [
        { uid: 0, key: ['tavern'], comment: 'scene', content: 'The tavern never sleeps.', enabled: true },
        { uid: 1, key: ['city'], keysecondary: ['north'], content: 'The northern city.', enabled: false },
      ],
    })
    await expect(tools.get('world_get')!.execute({ world: 'No Such World' })).rejects.toThrow('not found')

    // 确认闸门
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore',
      entries: [{ uid: 0, content: 'nope' }],
    })).rejects.toThrow('confirmation required')
    // 白名单:未知字段拒绝
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true,
      entries: [{ uid: 0, order: 5 }],
    })).rejects.toThrow('unknown entry field')

    const edited = await tools.get('world_put')!.execute({
      world: 'Panel Lore',
      confirmed: true,
      entries: [
        { uid: 0, content: 'The tavern sleeps now.', enabled: false },
        { uid: 1, enabled: true },
        { uid: 2, key: ['harbor'], content: 'A quiet harbor.' },
      ],
    })
    expect(edited).toMatchObject({
      world: 'Panel Lore', entryCount: 3, nextUid: 3,
      entries: [
        { uid: 0, created: false, fields: ['content', 'enabled'] },
        { uid: 1, created: false, fields: ['enabled'] },
        { uid: 2, created: true, fields: ['key', 'content'] },
      ],
    })
    const after = await store.getWorld('Panel Lore')
    expect(after!.entries.map((entry) => [entry.uid, entry.content, entry.key, entry.disable])).toEqual([
      [0, 'The tavern sleeps now.', ['tavern'], true],
      [1, 'The northern city.', ['city'], false],
      // 新条目从 normalizeEntry 拿到完整默认字段,只有白名单字段来自调用方
      [2, 'A quiet harbor.', ['harbor'], false],
    ])
    expect(after!.entries[2]).toMatchObject({ constant: false, order: 100, position: 0 })
    await expect(tools.get('world_put')!.execute({
      world: 'No Such World', confirmed: true, entries: [{ uid: 0, content: 'x' }],
    })).rejects.toThrow('not found')
  })

  /* ------------------------------- 预设工具 ------------------------------- */

  it('preset_get summarizes prompts and preset_put edits whitelisted fields with confirmation', async () => {
    await store.putPreset('Panel Preset', {
      prompts: [
        { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'You are a narrator.', system_prompt: true },
        { name: 'Style', identifier: 'style', role: 'system', content: 'Write vividly.', system_prompt: true },
        { name: 'Chat History', identifier: 'chatHistory', marker: true, system_prompt: true },
      ],
      prompt_order: [{ character_id: 100001, order: [
        { identifier: 'main', enabled: true },
        { identifier: 'style', enabled: false },
        { identifier: 'chatHistory', enabled: true },
      ] }],
      temperature: 0.7,
    })
    const summary = await tools.get('preset_get')!.execute({ preset: 'Panel Preset' })
    expect(summary).toMatchObject({
      found: true, preset: 'Panel Preset', promptCount: 3, truncated: false,
      prompts: [
        { name: 'Main Prompt', identifier: 'main', role: 'system', content: 'You are a narrator.', enabled: true },
        // enabled 取 prompt_order 生效值,而不是条目缺省
        { name: 'Style', identifier: 'style', enabled: false },
        { name: 'Chat History', identifier: 'chatHistory', marker: true, enabled: true },
      ],
    })
    await expect(tools.get('preset_get')!.execute({ preset: 'No Such Preset' })).rejects.toThrow('not found')

    await expect(tools.get('preset_put')!.execute({
      preset: 'Panel Preset',
      prompts: [{ name: 'Main Prompt', content: 'nope' }],
    })).rejects.toThrow('confirmation required')
    await expect(tools.get('preset_put')!.execute({
      preset: 'Panel Preset', confirmed: true,
      prompts: [{ name: 'Main Prompt', temperature: 0.2 }],
    })).rejects.toThrow('unknown prompt field')
    await expect(tools.get('preset_put')!.execute({
      preset: 'Panel Preset', confirmed: true,
      prompts: [{ name: 'Missing Prompt', content: 'x' }],
    })).rejects.toThrow('not found')
    await expect(tools.get('preset_put')!.execute({
      preset: 'Panel Preset', confirmed: true,
      prompts: [{ name: 'Chat History', content: 'markers hold no content' }],
    })).rejects.toThrow('marker')

    const edited = await tools.get('preset_put')!.execute({
      preset: 'Panel Preset',
      confirmed: true,
      prompts: [
        { name: 'Main Prompt', role: 'user', content: 'You are the player narrator.' },
        { name: 'Style', enabled: true },
        { name: 'Chat History', enabled: false },
      ],
    })
    expect(edited).toMatchObject({
      preset: 'Panel Preset', promptCount: 3,
      edits: [
        { name: 'Main Prompt', identifiers: ['main'], fields: ['role', 'content'] },
        { name: 'Style', identifiers: ['style'], fields: ['enabled'] },
        { name: 'Chat History', identifiers: ['chatHistory'], fields: ['enabled'] },
      ],
    })
    const after = await store.getPreset('Panel Preset')
    expect(after!.prompts[0]).toMatchObject({ role: 'user', content: 'You are the player narrator.' })
    // enabled 同步 prompt_order(供 ST 生效),条目本体也带标记
    expect(after!.prompts[1]).toMatchObject({ enabled: true })
    expect(after!.prompts[2]).toMatchObject({ enabled: false })
    const order = (after!.prompt_order as Array<{ order: Array<{ identifier: string, enabled: boolean }> }>)[0]!.order
    expect(order).toEqual([
      { identifier: 'main', enabled: true },
      { identifier: 'style', enabled: true },
      { identifier: 'chatHistory', enabled: false },
    ])
    // 白名单外的采样参数原样保留
    expect(after!.temperature).toBe(0.7)
  })

  /* ------------------------------ 排错素材入口 ------------------------------ */

  it('chat_log_read reads a bounded floor range with truncation and metadata', async () => {
    const messages = Array.from({ length: 60 }, (_, index) => ({
      name: index % 2 === 0 ? 'User' : CHARACTER,
      is_user: index % 2 === 0,
      is_system: false,
      send_date: `2026-01-01T00:00:${String(index).padStart(2, '0')}Z`,
      mes: index === 59 ? 'x'.repeat(2500) : `floor ${index}`,
    }))
    const chatId = await store.createChat(CHARACTER, { user_name: 'User', character_name: CHARACTER, chat_metadata: {} }, messages)

    // 默认:最近 20 条
    const tail = await tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId })
    expect(tail).toMatchObject({ found: true, character: CHARACTER, chatId, total: 60, from: 40, to: 59 })
    expect(tail.messages).toHaveLength(20)
    expect(tail.messages[0]).toMatchObject({ index: 40, is_user: true, name: 'User', send_date: '2026-01-01T00:00:40Z', content: 'floor 40' })
    // 单条 ≤2000 字符,长度与截断标记如实
    expect(tail.messages[19]).toMatchObject({ index: 59, length: 2500, truncated: true })
    expect(tail.messages[19].content).toBe('x'.repeat(2000))

    // 显式范围 + limit 收窄
    const range = await tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId, from: 3, to: 5 })
    expect(range).toMatchObject({ from: 3, to: 5 })
    expect(range.messages.map((message: { index: number }) => message.index)).toEqual([3, 4, 5])
    const fromOnly = await tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId, from: 50, limit: 3 })
    expect(fromOnly).toMatchObject({ from: 50, to: 52 })
    const toOnly = await tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId, to: 4 })
    expect(toOnly).toMatchObject({ from: 0, to: 4 })

    // 窗口上限 50
    await expect(tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId, from: 0, to: 50 }))
      .rejects.toThrow('exceeds 50 messages')
    await expect(tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId, from: 99 }))
      .rejects.toThrow('beyond the last floor index')
    await expect(tools.get('chat_log_read')!.execute({ character: CHARACTER, chatId: 'missing.jsonl' }))
      .rejects.toThrow('not found')
  })
})
