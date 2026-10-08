import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply as applyPlugin } from '../src/index.js'
import { apply, type AgentContextLike } from '../src/card-workbench/agent.js'
import {
  applyPlan,
  decidePlan,
  getPlan,
  listPlans,
  proposeCardPlan,
  type WorldPlan,
} from '../src/card-workbench/plans.js'
import { TavernStore, readOriginalSnapshot, saveOriginalSnapshot } from '../../tavern-store/src/index.js'

const CHARACTER = 'Plan Card'
const OTHER_CHARACTER = 'Bystander Card'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<any>
}

function makeRequest(body: unknown, url: string, method: 'POST' | 'PUT' | 'DELETE' = 'POST') {
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
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
    expect((await getPlan(tavern, plan.id))!.title).toBe('Soften the personality')
  })

  it('listPlans filters by character/status and decides transitions round-trip', async () => {
    const keep = await proposeCardPlan(tavern, CHARACTER, { title: 'keep pending', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'y' }] })
    const approve = await proposeCardPlan(tavern, CHARACTER, { title: 'to approve', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'z' }] })
    const reject = await proposeCardPlan(tavern, OTHER_CHARACTER, { title: 'to reject', changes: [{ field: 'scenario', currentValue: 'x', newValue: 'w' }] })

    expect((await listPlans(tavern)).map((plan) => plan.id)).toContain(keep.id)
    expect((await listPlans(tavern, { status: 'pending' })).map((plan) => plan.id)).toEqual(
      expect.arrayContaining([keep.id, approve.id, reject.id]),
    )
    expect((await listPlans(tavern, { character: OTHER_CHARACTER })).map((plan) => plan.id)).toEqual([reject.id])

    const approved = await decidePlan(tavern, approve.id, true)
    expect(approved.status).toBe('approved')
    expect(approved.decidedAt).toBeDefined()
    const rejected = await decidePlan(tavern, reject.id, false)
    expect(rejected.status).toBe('rejected')
    // 状态过滤生效
    expect((await listPlans(tavern, { character: OTHER_CHARACTER, status: 'rejected' })).map((plan) => plan.id)).toEqual([reject.id])
    // 非pending不可再决定
    await expect(decidePlan(tavern, approve.id, false)).rejects.toThrow('already approved')
    await expect(decidePlan(tavern, 'plan-missing')).rejects.toThrow('not found')

    const applied = await applyPlan(tavern, approve.id)
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).toBeDefined()
    await expect(applyPlan(tavern, approve.id)).rejects.toThrow('already applied')
    await expect(applyPlan(tavern, reject.id)).rejects.toThrow('was rejected')
    await expect(decidePlan(tavern, keep.id, true)).resolves.toMatchObject({ status: 'approved' })
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
    expect(await getPlan(tavern, '../../etc/passwd')).toBeUndefined()
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
    expect((await getPlan(tavern, proposed.planId))!.status).toBe('pending')
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
    expect((await getPlan(tavern, proposed.planId))!.status).toBe('pending')
  })

  it('card_put refuses a rejected plan', async () => {
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'will be rejected',
      changes: [{ field: 'personality', newValue: 'nope' }],
    })
    await decidePlan(tavern, proposed.planId, false)
    await expect(tools.get('card_put')!.execute({ character: OTHER_CHARACTER, planId: proposed.planId, confirmed: true }))
      .rejects.toThrow('was rejected')
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.personality).toBe('Calm.')
  })

  /* ------------------- 卡能力完整扩展（2026-10-08） ------------------- */

  it('card_get exposes the full editable surface and fetches long fields untruncated via full', async () => {
    const summary = await tools.get('card_get')!.execute({ character: CHARACTER })
    expect(summary).toMatchObject({
      found: true, character: CHARACTER,
      mesExample: '', systemPrompt: '', postHistoryInstructions: '',
      creator: '', characterVersion: '', tags: '',
      alternateGreetingsCount: 0, alternateGreetingsPreviews: [],
      fieldLengths: expect.objectContaining({ mesExample: 0, systemPrompt: 0, tags: 0 }),
    })
    // 新文本字段直写 + 摘要截断与全文读取
    const long = 'D'.repeat(2600)
    await tools.get('card_put')!.execute({
      character: CHARACTER, confirmed: true,
      changes: [
        { field: 'description', value: long },
        { field: 'mesExample', value: 'User: hi\nChar: hey there.' },
      ],
    })
    const after = await tools.get('card_get')!.execute({ character: CHARACTER })
    expect((after as Record<string, unknown>).description).toHaveLength(2000)
    expect(after).toMatchObject({ truncated: true, fieldLengths: expect.objectContaining({ description: 2600 }) })
    const full = await tools.get('card_get')!.execute({ character: CHARACTER, full: ['description', 'mesExample'] })
    expect(full.fullValues).toEqual({ description: long, mesExample: 'User: hi\nChar: hey there.' })
    await expect(tools.get('card_get')!.execute({ character: CHARACTER, full: ['bogus'] }))
      .rejects.toThrow('is not a card field')
  })

  it('card_put edits array fields whole-group and the plan protocol round-trips array values', async () => {
    // 整组替换:空白项丢弃,元数据/提示字段直写
    const edited = await tools.get('card_put')!.execute({
      character: OTHER_CHARACTER, confirmed: true,
      changes: [
        { field: 'tags', value: ['  fantasy ', '', 'tavern'] },
        { field: 'alternateGreetings', value: ['Second opening.', '   ', 'Third opening.'] },
        { field: 'systemPrompt', value: 'Speak as the narrator.' },
        { field: 'postHistoryInstructions', value: 'Keep it tight.' },
        { field: 'creator', value: 'Workbench Author' },
        { field: 'characterVersion', value: '1.1' },
      ],
    })
    const saved = (await store.getCharacter(OTHER_CHARACTER))!.card.data
    expect(saved.tags).toEqual(['fantasy', 'tavern'])
    expect(saved.alternateGreetings).toEqual(['Second opening.', 'Third opening.'])
    expect(saved.systemPrompt).toBe('Speak as the narrator.')
    expect(saved.postHistoryInstructions).toBe('Keep it tight.')
    expect(saved.creator).toBe('Workbench Author')
    expect(saved.characterVersion).toBe('1.1')
    expect(edited.changes[0]).toMatchObject({ field: 'tags', length: 'fantasy\ntavern'.length })

    // 数组字段进方案协议:currentValue 以数组快照,执行按方案原样落库
    const proposed = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'Rewrite greetings',
      changes: [{ field: 'alternateGreetings', newValue: ['Rewritten A.', 'Rewritten B.'], note: 'punchier openings' }],
    })
    expect(proposed.changes[0]).toMatchObject({
      field: 'alternateGreetings',
      currentValue: ['Second opening.', 'Third opening.'],
      newValue: ['Rewritten A.', 'Rewritten B.'],
    })
    await tools.get('card_put')!.execute({ character: OTHER_CHARACTER, planId: proposed.planId, confirmed: true })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.alternateGreetings).toEqual(['Rewritten A.', 'Rewritten B.'])

    // 数组过期检测:方案后卡被并发改 → stale 而不是覆盖
    const second = await tools.get('card_plan_propose')!.execute({
      character: OTHER_CHARACTER,
      title: 'stale tags',
      changes: [{ field: 'tags', newValue: ['from-plan'] }],
    })
    await tools.get('card_put')!.execute({ character: OTHER_CHARACTER, confirmed: true, changes: [{ field: 'tags', value: ['mutated'] }] })
    await expect(tools.get('card_put')!.execute({ character: OTHER_CHARACTER, planId: second.planId, confirmed: true }))
      .rejects.toThrow('stale')

    // 数组校验:非数组拒绝;项数超限拒绝(空白项丢弃后计)
    await expect(tools.get('card_put')!.execute({
      character: OTHER_CHARACTER, confirmed: true, changes: [{ field: 'tags', value: 'fantasy' }],
    })).rejects.toThrow('tags must be an array')
    await expect(tools.get('card_put')!.execute({
      character: OTHER_CHARACTER, confirmed: true, changes: [{ field: 'alternateGreetings', value: Array(17).fill('g') }],
    })).rejects.toThrow('at most 16')
  })

  it('card_delete is double-gated and cleans chats, groups, state bindings and the original snapshot', async () => {
    await store.importCharacter(cardPayload('Doomed Card'))
    const doomed = (await store.getCharacter('Doomed Card'))!.card
    await store.createChat('Doomed Card', { user_name: 'User', character_name: 'Doomed Card', chat_metadata: {} }, [
      { is_user: true, is_system: false, send_date: '2026-01-01T00:00:00Z', mes: 'hello' },
    ])
    await store.putGroup({
      id: 'group-doomed', name: 'Doomed Party', members: ['Doomed Card', CHARACTER], allowSelfResponses: false,
      activationStrategy: 1, disabledMembers: [], chatId: '', chats: [], autoModeDelay: 3,
    })
    expect(await saveOriginalSnapshot(tavern, 'Doomed Card', doomed)).toBe(true)
    // patchState 浅合并:保留既有绑定,只追加专用 solo 绑定
    const beforeDelete = await store.getState()
    await store.patchState({
      activeCharacter: 'Doomed Card',
      sessionBindings: { ...beforeDelete.sessionBindings, 'wb-doomed': { character: 'Doomed Card' } as never },
    })

    // 第一重闸门:无确认
    await expect(tools.get('card_delete')!.execute({ character: 'Doomed Card' })).rejects.toThrow('confirmation required')
    // 第二重闸门:有聊天时 confirmed 仍拒绝,报聊天数
    await expect(tools.get('card_delete')!.execute({ character: 'Doomed Card', confirmed: true }))
      .rejects.toThrow('1 chat log(s)')
    // 二次确认后:卡/聊天/群组成员/状态/快照全清
    const deleted = await tools.get('card_delete')!.execute({ character: 'Doomed Card', confirmed: true, deleteChats: true })
    expect(deleted).toMatchObject({
      deleted: true, character: 'Doomed Card', deletedChats: 1,
      removedFromGroups: ['Doomed Party'], snapshotRemoved: true,
    })
    expect(await store.getCharacter('Doomed Card')).toBeUndefined()
    expect(await store.listChats('Doomed Card')).toEqual([])
    expect((await store.getGroup('Doomed Party'))!.members).toEqual([CHARACTER])
    const state = await store.getState()
    expect(state.activeCharacter).toBeUndefined()
    expect(state.sessionBindings['wb-doomed']).toBeUndefined()
    expect(await readOriginalSnapshot(tavern, 'Doomed Card')).toBeUndefined()
    // 无聊天卡的删除不需要 deleteChats
    await store.importCharacter(cardPayload('Quiet Card'))
    const quiet = await tools.get('card_delete')!.execute({ character: 'Quiet Card', confirmed: true })
    expect(quiet).toMatchObject({ deleted: true, deletedChats: 0, removedFromGroups: [], snapshotRemoved: false })
    await expect(tools.get('card_delete')!.execute({ character: 'Doomed Card', confirmed: true, deleteChats: true }))
      .rejects.toThrow('not found')
  })

  it('panel DELETE character route cleans the original snapshot so same-name re-imports stay truthful', async () => {
    await store.importCharacter(cardPayload('Route Snapshot Card'))
    const card = (await store.getCharacter('Route Snapshot Card'))!.card
    expect(await saveOriginalSnapshot(tavern, 'Route Snapshot Card', card)).toBe(true)
    const res = makeResponse()
    await apiHandler({ method: 'DELETE', url: '/api/dsh-tavern/character?name=Route%20Snapshot%20Card', on: () => undefined, destroy: () => {} }, res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.chunks[0]!).ok).toBe(true)
    expect(await store.getCharacter('Route Snapshot Card')).toBeUndefined()
    // 面板删卡清快照：同名再导入拿到的是新快照，而不是「首个胜出」保住的陈旧旧卡
    expect(await readOriginalSnapshot(tavern, 'Route Snapshot Card')).toBeUndefined()
    const reimported = await store.importCharacter(cardPayload('Route Snapshot Card'))
    expect(await saveOriginalSnapshot(tavern, 'Route Snapshot Card', reimported.card)).toBe(true)
  })

  it('renames carry the original snapshot along (panel PUT and card_put); restore moves it back', async () => {
    await store.importCharacter(cardPayload('Snapshot Rename Card'))
    const card = (await store.getCharacter('Snapshot Rename Card'))!.card
    await saveOriginalSnapshot(tavern, 'Snapshot Rename Card', card)
    // 面板 PUT 改名 → 快照跟卡走，旧名不留幽灵
    const put = makeResponse()
    await apiHandler(makeRequest({ card: { ...card, data: { ...card.data, name: 'Renamed Once' } } }, '/api/dsh-tavern/character/Snapshot%20Rename%20Card', 'PUT'), put)
    expect(put.statusCode).toBe(200)
    expect(JSON.parse(put.chunks[0]!).card.data.name).toBe('Renamed Once')
    expect(await readOriginalSnapshot(tavern, 'Snapshot Rename Card')).toBeUndefined()
    expect((await readOriginalSnapshot(tavern, 'Renamed Once'))!.data.name).toBe('Snapshot Rename Card')
    // card_put 再改名（工具面路径）→ 同样迁移
    const renamed = await tools.get('card_put')!.execute({ character: 'Renamed Once', confirmed: true, changes: [{ field: 'name', value: 'Renamed Twice' }] })
    expect(renamed).toMatchObject({ character: 'Renamed Twice', renamedFrom: 'Renamed Once' })
    expect(await readOriginalSnapshot(tavern, 'Renamed Once')).toBeUndefined()
    expect((await readOriginalSnapshot(tavern, 'Renamed Twice'))!.data.name).toBe('Snapshot Rename Card')
    // 恢复原版：工作版整体替换回原名，快照跟着回原名（按当前卡名寻址的不变量）
    const restored = await tools.get('card_restore_original')!.execute({ character: 'Renamed Twice', confirmed: true })
    expect(restored.character).toBe('Snapshot Rename Card')
    expect(await readOriginalSnapshot(tavern, 'Renamed Twice')).toBeUndefined()
    expect((await readOriginalSnapshot(tavern, 'Snapshot Rename Card'))!.data.name).toBe('Snapshot Rename Card')
    await tools.get('card_delete')!.execute({ character: 'Snapshot Rename Card', confirmed: true })
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
    expect((await getPlan(tavern, stalePlan.planId))!.status).toBe('pending')
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
    // 白名单:未知字段拒绝（order 已是合法高级字段,用真未知字段验核）
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true,
      entries: [{ uid: 0, bogus: 5 }],
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

    // 高级字段:全白名单写入 + 未提及字段原样保留（uid0 的 disable 保持 true）
    const advanced = await tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true,
      entries: [{
        uid: 0,
        comment: 'scene memo', keysecondary: ['north'], constant: true, order: 250, position: 1,
        depth: 8, probability: 60, selectiveLogic: 3, group: 'scene-group', groupWeight: 40,
        sticky: 5, cooldown: 2, scanDepth: 10, caseSensitive: true, matchWholeWords: false,
        triggers: ['dawn'], excludeRecursion: true,
      }],
    })
    expect(advanced.entries).toMatchObject([
      { uid: 0, created: false, fields: expect.arrayContaining(['comment', 'constant', 'order', 'position', 'sticky']) },
    ])
    const advancedAfter = await store.getWorld('Panel Lore')
    expect(advancedAfter!.entries[0]).toMatchObject({
      comment: 'scene memo', keysecondary: ['north'], constant: true, order: 250, position: 1,
      depth: 8, probability: 60, selectiveLogic: 3, group: 'scene-group', groupWeight: 40,
      sticky: 5, cooldown: 2, scanDepth: 10, caseSensitive: true, matchWholeWords: false,
      triggers: ['dawn'], excludeRecursion: true, disable: true,
    })
    // world_get 摘要只上报偏离缺省的高级字段
    const advancedSummary = await tools.get('world_get')!.execute({ world: 'Panel Lore' })
    expect((advancedSummary.entries as Array<Record<string, unknown>>)[0]).toMatchObject({
      uid: 0, enabled: false, constant: true, order: 250, position: 1, depth: 8,
      probability: 60, selectiveLogic: 3, group: 'scene-group', groupWeight: 40,
      sticky: 5, cooldown: 2, scanDepth: 10, caseSensitive: true, matchWholeWords: false,
      triggers: ['dawn'], excludeRecursion: true,
    })
    expect((advancedSummary.entries as Array<Record<string, unknown>>)[2]).not.toHaveProperty('probability')

    // 字段表校验:范围/类型/可空按表拒绝
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, probability: 101 }],
    })).rejects.toThrow('probability for uid 0')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, selectiveLogic: 4 }],
    })).rejects.toThrow('selectiveLogic for uid 0')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, sticky: -1 }],
    })).rejects.toThrow('sticky for uid 0')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, key: ['a', '  '] }],
    })).rejects.toThrow('key for uid 0')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, comment: 'x'.repeat(2001) }],
    })).rejects.toThrow('comment for uid 0')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, caseSensitive: 'yes' }],
    })).rejects.toThrow('caseSensitive for uid 0')

    // remove:删除既有条目;与其它字段互斥;不存在的 uid 不能删
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 0, remove: true, content: 'x' }],
    })).rejects.toThrow('cannot be combined')
    await expect(tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 99, remove: true }],
    })).rejects.toThrow('uid 99 not found in world')
    const removed = await tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true,
      entries: [{ uid: 1, remove: true }, { uid: 3, key: ['bell'], content: 'A bell tower.' }],
    })
    expect(removed).toMatchObject({
      world: 'Panel Lore', entryCount: 3, nextUid: 4,
      entries: [
        { uid: 1, created: false, removed: true, fields: [] },
        { uid: 3, created: true, fields: ['key', 'content'] },
      ],
    })
    const afterRemove = await store.getWorld('Panel Lore')
    expect(afterRemove!.entries.map((entry) => entry.uid)).toEqual([0, 2, 3])

    // uids 过滤:命中条目全文返回,缺失 uid 上报;默认摘要仍是 500 字符预览
    await tools.get('world_put')!.execute({
      world: 'Panel Lore', confirmed: true, entries: [{ uid: 2, content: 'L'.repeat(600) }],
    })
    const preview = await tools.get('world_get')!.execute({ world: 'Panel Lore' })
    expect((preview.entries as Array<Record<string, unknown>>).find((entry) => entry.uid === 2)!.content).toHaveLength(500)
    const full = await tools.get('world_get')!.execute({ world: 'Panel Lore', uids: [2, 404] })
    expect((full.entries as Array<Record<string, unknown>>).find((entry) => entry.uid === 2)!.content).toHaveLength(600)
    expect(full.missingUids).toEqual([404])

    await expect(tools.get('world_put')!.execute({
      world: 'No Such World', confirmed: true, entries: [{ uid: 0, content: 'x' }],
    })).rejects.toThrow('not found')
  })

  it('world_list reports the library with linked cards and world_create seeds a new book behind the confirmation gate', async () => {
    const listed = await tools.get('world_list')!.execute({})
    expect(listed.worlds).toContainEqual({ name: 'Panel Lore', entryCount: 3, linkedCards: [] })

    // 确认闸门与白名单核与 world_put 同款
    await expect(tools.get('world_create')!.execute({ name: 'Harbor Lore', entries: [{ content: 'x' }] }))
      .rejects.toThrow('confirmation required')
    await expect(tools.get('world_create')!.execute({
      name: 'Harbor Lore', confirmed: true, entries: [{ uid: 0, content: 'x' }],
    })).rejects.toThrow('unknown entry field')
    await expect(tools.get('world_create')!.execute({
      name: 'Harbor Lore', confirmed: true, entries: [{}],
    })).rejects.toThrow('has no editable field')
    await expect(tools.get('world_create')!.execute({ name: '   ', confirmed: true })).rejects.toThrow('must not be blank')
    await expect(tools.get('world_create')!.execute({ name: 'x'.repeat(121), confirmed: true })).rejects.toThrow('120-character limit')
    // 重名拒绝：world_create 从不覆盖
    await expect(tools.get('world_create')!.execute({ name: 'Panel Lore', confirmed: true }))
      .rejects.toThrow('already exists')

    const blank = await tools.get('world_create')!.execute({ name: 'Blank Lore', confirmed: true })
    expect(blank).toEqual({ created: true, world: 'Blank Lore', entryCount: 0, nextUid: 0 })

    // 种子条目：uid 按数组顺序分配，默认字段来自 normalizeEntry
    const seeded = await tools.get('world_create')!.execute({
      name: 'Harbor Lore',
      confirmed: true,
      entries: [
        { key: ['harbor'], content: 'A quiet harbor.' },
        { key: ['sea'], content: 'Storm season.', enabled: false },
      ],
    })
    expect(seeded).toEqual({ created: true, world: 'Harbor Lore', entryCount: 2, nextUid: 2 })
    const book = await store.getWorld('Harbor Lore')
    expect(book!.entries.map((entry) => [entry.uid, entry.key, entry.content, entry.disable])).toEqual([
      [0, ['harbor'], 'A quiet harbor.', false],
      [1, ['sea'], 'Storm season.', true],
    ])
    expect(book!.entries[0]).toMatchObject({ constant: false, order: 100, position: 0 })

    // 种子条目带高级字段:建书白名单与 world_put 同表
    const rich = await tools.get('world_create')!.execute({
      name: 'Deep Lore', confirmed: true,
      entries: [{ key: ['abyss'], content: 'Deep down.', constant: true, order: 50, probability: 80, sticky: 3 }],
    })
    expect(rich).toEqual({ created: true, world: 'Deep Lore', entryCount: 1, nextUid: 1 })
    expect((await store.getWorld('Deep Lore'))!.entries[0]).toMatchObject({ uid: 0, constant: true, order: 50, probability: 80, sticky: 3 })

    // 创建后照常走 world_put，world_list/world_get 反映最新条目数与卡链接
    await tools.get('world_put')!.execute({
      world: 'Harbor Lore', confirmed: true, entries: [{ uid: 2, key: ['lighthouse'], content: 'It blinks.' }],
    })
    expect(await tools.get('world_get')!.execute({ world: 'Harbor Lore' })).toMatchObject({ entryCount: 3, nextUid: 3 })
    expect((await tools.get('world_list')!.execute({})).worlds).toContainEqual({ name: 'Harbor Lore', entryCount: 3, linkedCards: [] })
  })

  it('world_bind attaches/detaches books on cards and reports switches', async () => {
    await expect(tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: OTHER_CHARACTER }))
      .rejects.toThrow('confirmation required')
    await expect(tools.get('world_bind')!.execute({ world: 'No Book', character: OTHER_CHARACTER, confirmed: true }))
      .rejects.toThrow('not found')
    await expect(tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: 'Ghost Card', confirmed: true }))
      .rejects.toThrow('not found')

    const bound = await tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: OTHER_CHARACTER, confirmed: true })
    expect(bound).toEqual({ character: OTHER_CHARACTER, world: 'Harbor Lore', bound: true })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.extensions['world']).toBe('Harbor Lore')
    expect((await tools.get('world_list')!.execute({})).worlds).toContainEqual({ name: 'Harbor Lore', entryCount: 3, linkedCards: [OTHER_CHARACTER] })

    // 重复绑定幂等;换绑回报旧书
    const again = await tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: OTHER_CHARACTER, confirmed: true })
    expect(again).toEqual({ character: OTHER_CHARACTER, world: 'Harbor Lore', bound: true, alreadyBound: true })
    const switched = await tools.get('world_bind')!.execute({ world: 'Blank Lore', character: OTHER_CHARACTER, confirmed: true })
    expect(switched).toEqual({ character: OTHER_CHARACTER, world: 'Blank Lore', bound: true, previousWorld: 'Harbor Lore' })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.extensions['world']).toBe('Blank Lore')

    // 解绑错书报当前链接;解绑正确书后链接键消失
    await expect(tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: OTHER_CHARACTER, unbind: true, confirmed: true }))
      .rejects.toThrow("currently links 'Blank Lore'")
    const unbound = await tools.get('world_bind')!.execute({ world: 'Blank Lore', character: OTHER_CHARACTER, unbind: true, confirmed: true })
    expect(unbound).toEqual({ character: OTHER_CHARACTER, world: 'Blank Lore', bound: false })
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.extensions['world']).toBeUndefined()
  })

  it('world_delete refuses linked books, then removes the book and clears activeWorlds', async () => {
    await store.patchState({ activeWorlds: ['Harbor Lore', 'Blank Lore'] })
    await tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: CHARACTER, confirmed: true })
    await expect(tools.get('world_delete')!.execute({ world: 'Harbor Lore' })).rejects.toThrow('confirmation required')
    await expect(tools.get('world_delete')!.execute({ world: 'Harbor Lore', confirmed: true }))
      .rejects.toThrow(`linked by character card(s) ${CHARACTER}`)
    await tools.get('world_bind')!.execute({ world: 'Harbor Lore', character: CHARACTER, unbind: true, confirmed: true })

    const deleted = await tools.get('world_delete')!.execute({ world: 'Harbor Lore', confirmed: true })
    expect(deleted).toEqual({ deleted: true, world: 'Harbor Lore', wasActive: true })
    expect(await store.getWorld('Harbor Lore')).toBeUndefined()
    expect((await store.getState()).activeWorlds).toEqual(['Blank Lore'])
    await expect(tools.get('world_delete')!.execute({ world: 'Harbor Lore', confirmed: true })).rejects.toThrow('not found')
  })

  it('world_rename re-points card links and activeWorlds; collisions are refused', async () => {
    await store.patchState({ activeWorlds: ['Blank Lore'] })
    await tools.get('world_bind')!.execute({ world: 'Blank Lore', character: OTHER_CHARACTER, confirmed: true })
    await expect(tools.get('world_rename')!.execute({ world: 'Blank Lore', name: 'Panel Lore' })).rejects.toThrow('confirmation required')
    await expect(tools.get('world_rename')!.execute({ world: 'Blank Lore', name: 'Panel Lore', confirmed: true }))
      .rejects.toThrow('already exists')
    await expect(tools.get('world_rename')!.execute({ world: 'Blank Lore', name: 'Blank Lore', confirmed: true }))
      .rejects.toThrow('already named')
    await expect(tools.get('world_rename')!.execute({ world: 'No Book', name: 'X Lore', confirmed: true }))
      .rejects.toThrow('not found')

    const renamed = await tools.get('world_rename')!.execute({ world: 'Blank Lore', name: 'Renamed Lore', confirmed: true })
    expect(renamed).toEqual({
      world: 'Renamed Lore', renamedFrom: 'Blank Lore', entryCount: 0,
      reboundCards: [OTHER_CHARACTER], wasActive: true,
    })
    expect(await store.getWorld('Blank Lore')).toBeUndefined()
    expect((await store.getWorld('Renamed Lore'))!.entries).toEqual([])
    // 卡链接与 activeWorlds 都指到新名（面板 PUT 路由不回写卡链接,工具面补齐）
    expect((await store.getCharacter(OTHER_CHARACTER))!.card.data.extensions['world']).toBe('Renamed Lore')
    expect((await store.getState()).activeWorlds).toEqual(['Renamed Lore'])
  })

  it('world_copy forks a book verbatim and never overwrites', async () => {
    await expect(tools.get('world_copy')!.execute({ world: 'Panel Lore', name: 'Renamed Lore' })).rejects.toThrow('confirmation required')
    await expect(tools.get('world_copy')!.execute({ world: 'Panel Lore', name: 'Renamed Lore', confirmed: true })).rejects.toThrow('already exists')
    await expect(tools.get('world_copy')!.execute({ world: 'Panel Lore', name: 'Panel Lore', confirmed: true })).rejects.toThrow('needs a new name')
    await expect(tools.get('world_copy')!.execute({ world: 'No Book', name: 'Any Lore', confirmed: true })).rejects.toThrow('not found')

    const copied = await tools.get('world_copy')!.execute({ world: 'Panel Lore', name: 'Panel Lore Copy', confirmed: true })
    expect(copied).toEqual({ copied: true, from: 'Panel Lore', to: 'Panel Lore Copy', entryCount: 3 })
    const source = await store.getWorld('Panel Lore')
    const fork = await store.getWorld('Panel Lore Copy')
    expect(fork!.entries).toEqual(source!.entries)
    expect(fork!.name).toBe('Panel Lore Copy')
  })

  /* ---------------------- 世界书方案协议（面板化 diff） ---------------------- */

  it('world_plan_propose snapshots live values for edit plans and refuses missing books / create-on-existing', async () => {
    await store.importWorldFile('Plan Lore', {
      entries: {
        0: { uid: 0, key: ['alpha'], content: 'Alpha content.', disable: false },
        1: { uid: 1, key: ['beta'], content: 'Beta content.', disable: true },
      },
    })
    const proposed = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore',
      title: 'rewrite beta, drop alpha, add gamma',
      entries: [
        { uid: 0, remove: true },
        { uid: 1, content: 'Beta content, revised.', enabled: true },
        { uid: 5, key: ['gamma'], content: 'Gamma entry.', note: 'background lore' },
      ],
    })
    expect(proposed).toMatchObject({ world: 'Plan Lore', op: 'edit', title: 'rewrite beta, drop alpha, add gamma', status: 'pending' })
    const stored = (await getPlan(tavern, proposed.planId)) as WorldPlan
    expect(stored).toMatchObject({ kind: 'world', op: 'edit', world: 'Plan Lore', status: 'pending' })
    // currentValue 一律从活书快照：disable:true → enabled:false；新 uid 无 currentValue
    expect(stored.entries).toEqual([
      { uid: 0, action: 'remove', fields: [] },
      {
        uid: 1, action: 'update',
        fields: [
          { field: 'content', currentValue: 'Beta content.', newValue: 'Beta content, revised.' },
          { field: 'enabled', currentValue: false, newValue: true },
        ],
      },
      { uid: 5, action: 'create', fields: [{ field: 'key', newValue: ['gamma'] }, { field: 'content', newValue: 'Gamma entry.' }], note: 'background lore' },
    ])
    // 只提案不落盘
    expect((await store.getWorld('Plan Lore'))!.entries).toHaveLength(2)
    await expect(tools.get('world_plan_propose')!.execute({ world: 'No Such Book', title: 'x', entries: [{ uid: 0, content: 'y' }] })).rejects.toThrow('not found')
    await expect(tools.get('world_plan_propose')!.execute({ world: 'Plan Lore', create: true, title: 'x', entries: [{ content: 'y' }] })).rejects.toThrow('already exists')
  })

  it('world_put with planId applies the recorded entries exactly, ignores direct edits and marks applied', async () => {
    const proposed = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore', title: 'apply me',
      entries: [{ uid: 1, content: 'Applied content.' }],
    })
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: proposed.planId, entries: [{ uid: 1, content: 'x' }] })).rejects.toThrow('confirmation required')
    await expect(tools.get('world_put')!.execute({ world: 'Somewhere Else', planId: proposed.planId, confirmed: true })).rejects.toThrow('belongs to world')
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: 'plan-none', confirmed: true })).rejects.toThrow('not found')
    // 卡方案不能经 world_put 执行（kind 分派）
    const cardPlan = await tools.get('card_plan_propose')!.execute({ character: CHARACTER, title: 'wrong kind', changes: [{ field: 'personality', newValue: 'Nope.' }] })
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: cardPlan.planId, confirmed: true })).rejects.toThrow('not a world edit plan')

    const applied = await tools.get('world_put')!.execute({
      world: 'Plan Lore', planId: proposed.planId, confirmed: true,
      entries: [{ uid: 1, content: 'direct edits are ignored' }],
    })
    expect(applied).toMatchObject({
      world: 'Plan Lore', planId: proposed.planId, planStatus: 'applied',
      entries: [{ uid: 1, created: false, fields: ['content'] }],
    })
    expect((await store.getWorld('Plan Lore'))!.entries.find((entry) => entry.uid === 1)!.content).toBe('Applied content.')
    expect((await getPlan(tavern, proposed.planId))!.status).toBe('applied')
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: proposed.planId, confirmed: true })).rejects.toThrow('already applied')
  })

  it('world_put rejects a stale world plan instead of clobbering concurrent edits', async () => {
    const proposed = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore', title: 'stale me',
      entries: [{ uid: 1, order: 42 }],
    })
    // 并发直写同一字段 → currentValue 失配，方案拒绝且保持 pending
    await tools.get('world_put')!.execute({ world: 'Plan Lore', confirmed: true, entries: [{ uid: 1, order: 7 }] })
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: proposed.planId, confirmed: true })).rejects.toThrow('stale')
    expect((await getPlan(tavern, proposed.planId))!.status).toBe('pending')
    // remove 目标在提案后被并发删除 → 执行时同样过期
    const removePlan = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore', title: 'remove the removed',
      entries: [{ uid: 0, remove: true }],
    })
    await tools.get('world_put')!.execute({ world: 'Plan Lore', confirmed: true, entries: [{ uid: 0, remove: true }] })
    await expect(tools.get('world_put')!.execute({ world: 'Plan Lore', planId: removePlan.planId, confirmed: true })).rejects.toThrow('stale')
    expect((await getPlan(tavern, removePlan.planId))!.status).toBe('pending')
  })

  it('world_plan_propose create + world_create planId builds the recorded book; late name collisions refuse as stale', async () => {
    const proposed = await tools.get('world_plan_propose')!.execute({
      world: 'Fresh Lore', create: true, title: 'new book plan',
      entries: [
        { key: ['one'], content: 'First.', note: 'opener' },
        { key: ['two'], content: 'Second.', constant: true },
      ],
    })
    const stored = (await getPlan(tavern, proposed.planId)) as WorldPlan
    expect(stored).toMatchObject({ kind: 'world', op: 'create', world: 'Fresh Lore' })
    expect(stored.entries.map((entry) => [entry.uid, entry.action])).toEqual([[0, 'create'], [1, 'create']])
    expect(stored.entries[0].fields.find((field) => field.field === 'key')).toEqual({ field: 'key', newValue: ['one'] })

    await expect(tools.get('world_create')!.execute({ name: 'Fresh Lore', planId: proposed.planId })).rejects.toThrow('confirmation required')
    await expect(tools.get('world_create')!.execute({ name: 'Elsewhere Lore', planId: proposed.planId, confirmed: true })).rejects.toThrow('belongs to world')
    // 卡方案不能经 world_create 执行（kind 分派）
    const cardPlan = await tools.get('card_plan_propose')!.execute({ character: CHARACTER, title: 'wrong kind for worlds', changes: [{ field: 'personality', newValue: 'Nope.' }] })
    await expect(tools.get('world_create')!.execute({ name: 'Fresh Lore', planId: cardPlan.planId, confirmed: true })).rejects.toThrow('is not a world creation plan')
    const created = await tools.get('world_create')!.execute({
      name: 'Fresh Lore', planId: proposed.planId, confirmed: true,
      entries: [{ key: ['ignored'], content: 'ignored' }],
    })
    expect(created).toMatchObject({ created: true, world: 'Fresh Lore', entryCount: 2, planId: proposed.planId, planStatus: 'applied' })
    const book = await store.getWorld('Fresh Lore')
    expect(book!.entries.map((entry) => [entry.uid, entry.content, entry.key])).toEqual([[0, 'First.', ['one']], [1, 'Second.', ['two']]])
    expect(book!.entries[1].constant).toBe(true)

    // 提案后书名被占 → 执行时按过期拒绝，不留半成品
    const late = await tools.get('world_plan_propose')!.execute({
      world: 'Late Lore', create: true, title: 'too late',
      entries: [{ key: ['x'], content: 'y' }],
    })
    await tools.get('world_create')!.execute({ name: 'Late Lore', confirmed: true, entries: [{ key: ['z'], content: 'occupied' }] })
    await expect(tools.get('world_create')!.execute({ name: 'Late Lore', planId: late.planId, confirmed: true })).rejects.toThrow('stale')
    expect((await getPlan(tavern, late.planId))!.status).toBe('pending')
    expect((await store.getWorld('Late Lore'))!.entries[0].content).toBe('occupied')
  })

  it('panel routes list world plans and dispatch decisions by kind', async () => {
    const proposed = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore', title: 'panel approve me',
      entries: [{ uid: 1, comment: 'Set by panel.' }],
    })
    const list = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/card-workbench/plans?status=all'), list)
    const plans = JSON.parse(list.chunks[0]!).plans
    expect(plans.some((plan: { id: string; kind: string; op: string }) => plan.id === proposed.planId && plan.kind === 'world' && plan.op === 'edit')).toBe(true)

    const approved = makeResponse()
    await apiHandler(makeRequest({ approve: true }, `/api/dsh-tavern/card-workbench/plans/${proposed.planId}/decision`), approved)
    expect(approved.statusCode).toBe(200)
    const body = JSON.parse(approved.chunks[0]!)
    expect(body.plan).toMatchObject({ id: proposed.planId, kind: 'world', status: 'applied' })
    expect(body.applied).toMatchObject({ world: 'Plan Lore' })
    expect((await store.getWorld('Plan Lore'))!.entries.find((entry) => entry.uid === 1)!.comment).toBe('Set by panel.')

    const toReject = await tools.get('world_plan_propose')!.execute({
      world: 'Plan Lore', title: 'panel reject me',
      entries: [{ uid: 1, comment: 'Never.' }],
    })
    const rejected = makeResponse()
    await apiHandler(makeRequest({ approve: false }, `/api/dsh-tavern/card-workbench/plans/${toReject.planId}/decision`), rejected)
    expect(JSON.parse(rejected.chunks[0]!).plan).toMatchObject({ status: 'rejected' })
    expect((await store.getWorld('Plan Lore'))!.entries.find((entry) => entry.uid === 1)!.comment).toBe('Set by panel.')

    // kind 过滤：只列世界书方案；非法 kind 拒绝
    const worldOnly = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/card-workbench/plans?status=all&kind=world'), worldOnly)
    const filtered = JSON.parse(worldOnly.chunks[0]!).plans
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.every((plan: { kind: string }) => plan.kind === 'world')).toBe(true)
    const badKind = makeResponse()
    await apiHandler(makeGetRequest('/api/dsh-tavern/card-workbench/plans?kind=nope'), badKind)
    expect(badKind.statusCode).toBe(400)
  })

  it('legacy plan files without kind normalize as card plans', async () => {
    const legacy = {
      id: 'plan-legacy-01', character: CHARACTER, title: 'legacy shape',
      changes: [{ field: 'personality', currentValue: 'Calm.', newValue: 'Legacy.' }],
      createdAt: '2026-10-08T00:00:00.000Z', status: 'pending',
    }
    writeFileSync(join(tavern, 'card-workbench', 'plans', 'plan-legacy-01.json'), JSON.stringify(legacy))
    expect((await getPlan(tavern, 'plan-legacy-01'))!.kind).toBe('card')
    expect((await listPlans(tavern, { status: 'all' })).some((plan) => plan.id === 'plan-legacy-01')).toBe(true)
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
