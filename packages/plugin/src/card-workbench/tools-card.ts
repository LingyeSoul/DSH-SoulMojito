/**
 * 写卡工作台 · 卡片域工具（决策 2026-10-09-dedup-refactor 自 agent.ts 拆分）。
 *
 * 角色卡读改删与制卡/转 MVU（提案 0013 P1-P3）：card_get / card_put /
 * card_original_get / card_restore_original / card_delete / card_plan_propose 六件
 * 核心工具，加上穿插在总工具序里的 card_create 与 card_apply_mvu（聚合顺序见
 * agent.ts 的 createTools）。写入核（saveCardValues）与方案执行核
 * （executeCardPlan，面板 decision 路由与对话内 planId 路径共用）同在本模块。
 */

import {
  deleteOriginalSnapshot,
  moveOriginalSnapshot,
  readOriginalSnapshot,
  restoreOriginal,
  saveOriginalSnapshot,
  type CharacterFile,
} from '../../../tavern-store/src/index.js'
import type { CardDataIR, CharacterCardIR } from '../../../tavern-format/src/index.js'
import { dshHomePath } from '../dsh-home.js'
import { limitText, stringArg } from '../tool-args.js'
import { applyPlan, getPlan, proposeCardPlan, type CardPlan, type CardPlanValue } from './plans.js'
import {
  CONFIRMATION_ERROR,
  objectOutput,
  requireCharacter,
  tavernStore,
  titleArg,
  tool,
  type ToolDefinition,
  type ToolExecution,
  type WorkbenchExecAgent,
} from './shared.js'

/* --------------------------- editable field gate --------------------------- */

type CardTextField =
  | 'name' | 'nickname' | 'description' | 'personality' | 'scenario' | 'firstMes' | 'creatorNotes'
  | 'mesExample' | 'systemPrompt' | 'postHistoryInstructions' | 'creator' | 'characterVersion'
type CardArrayField = 'tags' | 'alternateGreetings'
type CardField = CardTextField | CardArrayField

/** 文本字段白名单 + 逐字段长度上限（提案 0013 P1 确认协议的写入面，2026-10-08 完整扩展）。 */
const CARD_FIELDS: Record<CardTextField, number> = {
  name: 120,
  nickname: 120,
  description: 32000,
  personality: 8000,
  scenario: 8000,
  firstMes: 16000,
  creatorNotes: 8000,
  mesExample: 32000,
  systemPrompt: 16000,
  postHistoryInstructions: 16000,
  creator: 500,
  characterVersion: 100,
}

/** 数组字段（整组替换语义，对齐面板编辑器）：空白项丢弃，项数与单项上限硬校验。 */
const CARD_ARRAY_FIELDS: Record<CardArrayField, { maxItems: number; itemMax: number }> = {
  tags: { maxItems: 32, itemMax: 100 },
  alternateGreetings: { maxItems: 16, itemMax: 16000 },
}

const CARD_FIELD_KEYS = [...Object.keys(CARD_FIELDS), ...Object.keys(CARD_ARRAY_FIELDS)] as CardField[]
const CARD_FIELD_LIST = CARD_FIELD_KEYS.join(', ')

/* ------------------------------ output schemas ------------------------------ */

const cardSummaryOutput = objectOutput({
  found: { type: 'boolean' },
  character: { type: 'string' },
  name: { type: 'string' }, nickname: { type: 'string' },
  description: { type: 'string' }, personality: { type: 'string' },
  scenario: { type: 'string' }, firstMes: { type: 'string' }, creatorNotes: { type: 'string' },
  mesExample: { type: 'string' }, systemPrompt: { type: 'string' }, postHistoryInstructions: { type: 'string' },
  creator: { type: 'string' }, characterVersion: { type: 'string' }, tags: { type: 'string', description: 'Comma-joined tag preview.' },
  alternateGreetingsCount: { type: 'number' },
  alternateGreetingsPreviews: { type: 'array', items: { type: 'string' }, description: 'Per-greeting previews (200 characters each).' },
  fullValues: { type: 'object', additionalProperties: true, description: 'Full (untruncated) values of the fields requested via the full parameter; array fields return arrays.' },
  persona: { type: 'object', additionalProperties: true, description: 'Active user persona { name, description }; empty name when none is active.' },
  fieldLengths: { type: 'object', additionalProperties: true, description: 'Full character lengths of every editable field (array fields report the joined length).' },
  extensionKeys: { type: 'array', items: { type: 'string' } },
  source: { type: 'object', additionalProperties: true }, truncated: { type: 'boolean' },
}, ['name', 'nickname', 'description', 'personality', 'scenario', 'firstMes', 'creatorNotes', 'mesExample', 'systemPrompt', 'postHistoryInstructions', 'creator', 'characterVersion', 'tags', 'alternateGreetingsCount', 'alternateGreetingsPreviews', 'fullValues', 'persona', 'fieldLengths', 'extensionKeys', 'source', 'truncated'])
// planId 执行路径的回执字段（planId/planStatus）只在该路径出现，必须声明为可选——
// 宿主按 output.schema（additionalProperties:false）校验工具返回，漏声明即整次调用失败。
const cardPutOutput = objectOutput({
  character: { type: 'string' }, renamedFrom: { type: 'string' },
  planId: { type: 'string', description: 'Present when a recorded plan was applied: its id.' },
  planStatus: { type: 'string', description: 'Present when a recorded plan was applied: the plan status after execution.' },
  changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
  fieldLengths: { type: 'object', additionalProperties: true },
  source: { type: 'object', additionalProperties: true },
}, ['renamedFrom', 'planId', 'planStatus'])
const cardRestoreOutput = objectOutput({
  character: { type: 'string' }, fieldLengths: { type: 'object', additionalProperties: true },
  source: { type: 'object', additionalProperties: true },
})
const cardDeleteOutput = objectOutput({
  deleted: { type: 'boolean' }, character: { type: 'string' },
  deletedChats: { type: 'number', description: 'Chat logs removed together with the card (ST semantics).' },
  removedFromGroups: { type: 'array', items: { type: 'string' }, description: 'Groups the card was removed from.' },
  snapshotRemoved: { type: 'boolean', description: 'True when an import-time/creation-time original snapshot existed and was cleaned up.' },
})
const planProposeOutput = objectOutput({
  planId: { type: 'string' }, character: { type: 'string' }, title: { type: 'string' },
  status: { type: 'string' }, createdAt: { type: 'string' },
  changes: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const cardCreateOutput = objectOutput({
  created: { type: 'boolean' },
  character: { type: 'string' },
  fieldLengths: { type: 'object', additionalProperties: true },
  alternateGreetings: { type: 'number', description: 'Number of stored alternate greetings.' },
  snapshotTaken: { type: 'boolean', description: 'True when the as-created card was saved as its original snapshot (making card_restore_original work for hand-built cards).' },
  source: { type: 'object', additionalProperties: true },
})
const mvuApplyOutput = objectOutput({
  character: { type: 'string' },
  statusTemplateLength: { type: 'number' },
  variableKeys: { type: 'array', items: { type: 'string' } },
  snapshotTaken: { type: 'boolean', description: 'True when the pre-conversion card was saved as the original snapshot by this call.' },
  retainedAgentTavernKeys: { type: 'array', items: { type: 'string' }, description: 'Pre-existing agentTavern keys preserved untouched (e.g. scriptId).' },
  source: { type: 'object', additionalProperties: true },
}, ['retainedAgentTavernKeys'])

/* -------------------------------- 工具定义 -------------------------------- */

export const cardCoreTools: ToolDefinition[] = [
  tool('card_get', 'Read the working-copy summary of a Tavern character card: core fields (truncated previews), mesExample/systemPrompt/postHistoryInstructions previews, metadata (creator, characterVersion, tags), alternate-greeting count and previews, per-field full lengths, extension keys and the active user persona. Previews truncate long fields — pass full with field names to fetch those fields IN FULL under fullValues (array fields return arrays), which you must do before rewriting or quoting long text verbatim. Call it before proposing any card change.', {
    character: { type: 'string', required: true, description: 'Character name from the conversation.' },
    full: { type: 'array', items: { type: 'string', enum: [...CARD_FIELD_KEYS] }, description: `Optional field names to return untruncated in fullValues: ${CARD_FIELD_LIST}.` },
  }, cardSummaryOutput, async (args, exec) => {
    const character = stringArg(args.character)
    const full = args.full === undefined ? undefined : parseFullFields(args.full)
    exec?.signal?.throwIfAborted()
    const found = await requireCharacter(character)
    const persona = await activePersona(await tavernStore())
    const summary = cardSummary(character, found.card, persona)
    if (full !== undefined) {
      const data = found.card.data as unknown as Record<string, unknown>
      const fullValues: Record<string, unknown> = {}
      for (const field of full) fullValues[field] = field in CARD_ARRAY_FIELDS ? [...(data[field] as string[] ?? [])] : (data[field] ?? '')
      summary.fullValues = fullValues
    }
    return { found: true, ...summary }
  }),
  tool('card_put', 'Apply confirmed changes to a character card working copy, either from a recorded plan (planId from card_plan_propose — the recorded fields are applied exactly and any direct changes argument is ignored) or as direct per-field edits. Text fields take strings; tags and alternateGreetings take the FULL replacement array (whole-group replace, blank items dropped). Present the per-field before/after plan to the user FIRST; the call is rejected unless confirmed is true, and confirmed must only be true after the user explicitly approved the plan (in conversation or by approving the plan in the workbench panel). The import-time original snapshot is never touched.', {
    character: { type: 'string', required: true, description: 'Character name the edits apply to; must match the plan when planId is given.' },
    planId: { type: 'string', description: 'ID of a plan recorded by card_plan_propose; applies the recorded plan exactly and marks it applied.' },
    changes: {
      type: 'array', description: `Ignored when planId is given. Otherwise up to 16 entries of { field, value }. Text fields: ${Object.keys(CARD_FIELDS).join(', ')}. Array fields (whole-group replacement): ${Object.keys(CARD_ARRAY_FIELDS).join(', ')}.`,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: [...CARD_FIELD_KEYS] },
          value: { type: ['string', 'array'], items: { type: 'string' }, description: 'Replacement value: string for text fields, full string array for tags/alternateGreetings.' },
        },
        required: ['field', 'value'],
        additionalProperties: false,
      },
    },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the presented plan.' },
  }, cardPutOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const character = stringArg(args.character)
    exec?.signal?.throwIfAborted()
    if (args.planId !== undefined) {
      const planId = stringArg(args.planId)
      const plan = await getPlan(dshHomePath('tavern'), planId)
      if (plan === undefined) throw new Error(`plan '${planId}' not found`)
      if (plan.kind !== 'card') throw new Error(`plan '${planId}' is a world plan; apply it with world_put (edit) or world_create (create)`)
      if (plan.character !== character) throw new Error(`plan '${planId}' belongs to character '${plan.character}', not '${character}'`)
      const executed = await executeCardPlan(plan)
      return {
        character: executed.character,
        ...(executed.renamedFrom !== undefined ? { renamedFrom: executed.renamedFrom } : {}),
        changes: executed.changes,
        fieldLengths: executed.fieldLengths,
        source: executed.source,
        planId,
        planStatus: executed.plan.status,
      }
    }
    const changes = parseChanges(args.changes)
    const { found, saved } = await saveCardValues(character, changes)
    return formatWriteResult(found, saved, changes)
  }),
  tool('card_original_get', 'Read the import-time original snapshot summary of a character card. The snapshot is written once at import and never edited; use it to compare against the working copy or to offer a restore. found is false when no snapshot exists.', {
    character: { type: 'string', required: true, description: 'Character name from the conversation.' },
  }, cardSummaryOutput, async (args, exec) => {
    const character = stringArg(args.character)
    exec?.signal?.throwIfAborted()
    const original = await readOriginalSnapshot(dshHomePath('tavern'), character)
    if (original === undefined) return { found: false, character }
    return { found: true, ...cardSummary(character, original) }
  }),
  tool('card_restore_original', 'Overwrite a character card working copy with its import-time original snapshot. Destructive to uncommitted working edits: present what will be lost and call with confirmed: true only after the user explicitly approves. Rejected without confirmation; fails when no snapshot exists.', {
    character: { type: 'string', required: true, description: 'Character name to restore.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved losing the current working-copy edits.' },
  }, cardRestoreOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const character = stringArg(args.character)
    exec?.signal?.throwIfAborted()
    const restored = await restoreOriginal(dshHomePath('tavern'), character)
    if (restored === undefined) {
      throw new Error(`no original snapshot for '${character}'; the card was never imported through the Tavern import route`)
    }
    return {
      character: restored.card.data.name,
      fieldLengths: fieldLengthsOf(restored.card.data),
      source: { kind: 'character-card-original', id: restored.card.data.name, version: restored.card.specVersion },
    }
  }),
  tool('card_delete', 'Delete a character card PERMANENTLY together with ALL its chat logs (SillyTavern semantics: chats belong to the card). Double gate: rejected without confirmed: true, and when the card has chat logs the first confirmed call still refuses — it reports the exact chat count so you can tell the user what will be lost; call again with deleteChats: true only after they accept. Also removes the card from its groups, clears solo session bindings and the activeCharacter pointer, and deletes the original snapshot (a stale snapshot would poison a future re-created card\'s restore). Verify the card name with card_get first.', {
    character: { type: 'string', required: true, description: 'Character name to delete.' },
    deleteChats: { type: 'boolean', description: 'Acknowledge the permanent loss of every chat log of this card; required only when chats exist.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the deletion.' },
  }, cardDeleteOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const character = stringArg(args.character)
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const found = await db.getCharacter(character)
    if (found === undefined) throw new Error(`character '${character}' not found`)
    const chats = await db.listChats(character)
    if (chats.length > 0 && args.deleteChats !== true) {
      const sample = chats.slice(0, 5).join(', ') + (chats.length > 5 ? ', …' : '')
      throw new Error(`character '${character}' has ${chats.length} chat log(s) (${sample}) that would be deleted together with the card; tell the user exactly what will be lost and call again with deleteChats: true`)
    }
    await db.deleteCharacter(character)
    // 清理面对齐面板 DELETE 路由（群组成员/activeCharacter/solo 绑定），
    // 外加它没做的一步：删原版快照，防同名重建卡被陈旧快照污染 restore。
    const removedFromGroups: string[] = []
    for (const groupName of await db.listGroups()) {
      const group = await db.getGroup(groupName)
      if (group === undefined || !group.members.includes(character)) continue
      await db.putGroup({
        ...group,
        members: group.members.filter((member) => member !== character),
        disabledMembers: group.disabledMembers.filter((member) => member !== character),
      })
      removedFromGroups.push(groupName)
    }
    await db.updateState((current) => ({
      ...(current.activeCharacter === character ? { activeCharacter: undefined } : {}),
      sessionBindings: Object.fromEntries(Object.entries(current.sessionBindings)
        .filter(([, binding]) => {
          const record = binding as { character?: unknown; group?: unknown }
          return !(record.character === character && record.group !== true)
        })),
    }))
    const snapshotRemoved = await deleteOriginalSnapshot(dshHomePath('tavern'), character)
    return { deleted: true, character, deletedChats: chats.length, removedFromGroups, snapshotRemoved }
  }),
  tool('card_plan_propose', 'Record a pending card modification plan (confirmation protocol): per-field newValue plus an optional note; the CURRENT values are snapshotted from the live working copy so the diff shown to the user is truthful. Text fields take strings; tags and alternateGreetings take the full replacement array. Returns a planId — the user then approves the plan in the workbench panel, or confirms in conversation and you call card_put with that planId and confirmed: true. Proposing does not write the card.', {
    character: { type: 'string', required: true, description: 'Character name the plan targets.' },
    title: { type: 'string', required: true, description: 'Short human-readable plan title shown in the workbench panel (max 200 characters).' },
    changes: {
      type: 'array', required: true, description: `Up to 16 entries of { field, newValue, note? }. Text fields: ${Object.keys(CARD_FIELDS).join(', ')}. Array fields (whole-group replacement): ${Object.keys(CARD_ARRAY_FIELDS).join(', ')}.`,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: [...CARD_FIELD_KEYS] },
          newValue: { type: ['string', 'array'], items: { type: 'string' }, description: 'Replacement value: string for text fields, full string array for tags/alternateGreetings.' },
          note: { type: 'string', description: 'Why this change serves the user intent (max 500 characters).' },
        },
        required: ['field', 'newValue'],
        additionalProperties: false,
      },
    },
  }, planProposeOutput, async (args, exec) => {
    const character = stringArg(args.character)
    const title = titleArg(args.title)
    const proposed = parsePlanChanges(args.changes)
    exec?.signal?.throwIfAborted()
    const found = await requireCharacter(character)
    // currentValue 一律以活卡为准（不信任模型复述），diff 面向用户保真。
    const plan = await proposeCardPlan(dshHomePath('tavern'), character, {
      title,
      changes: proposed.map(({ field, newValue, note }) => ({
        field,
        currentValue: cardLiveValue(found.card.data, field),
        newValue,
        ...(note !== undefined ? { note } : {}),
      })),
    })
    return {
      planId: plan.id,
      character: plan.character,
      title: plan.title,
      status: plan.status,
      createdAt: plan.createdAt,
      changes: plan.changes.map((change) => ({
        field: change.field,
        currentValue: previewPlanValue(change.currentValue),
        newValue: previewPlanValue(change.newValue),
        ...(change.note !== undefined ? { note: change.note } : {}),
      })),
    }
  }),
]

export const cardCreateTool: ToolDefinition = tool('card_create', 'Create a new Tavern character card from a blank slate, raw material or a script (proposal 0013 P3). fields accepts the card_put whitelist (name must match the top-level name argument when present), alternateGreetings and tags (full arrays) plus the metadata fields creator/characterVersion. Present the full field draft to the user FIRST; rejected without confirmed: true. Refuses when a card with the same name already exists. Creation binds no script and no world book — binding goes through the existing routes, by the user or the panel. The as-created card is saved as its original snapshot, so card_restore_original can always take the card back to the creation state.', {
  name: { type: 'string', required: true, description: 'Name of the new card (max 120 characters); must not collide with an existing card.' },
  fields: {
    type: 'object',
    description: `Optional initial field values: ${CARD_FIELD_LIST}. Text fields take strings; tags and alternateGreetings take full string arrays.`,
    properties: {
      name: { type: 'string' },
      nickname: { type: 'string' },
      description: { type: 'string' },
      personality: { type: 'string' },
      scenario: { type: 'string' },
      firstMes: { type: 'string' },
      creatorNotes: { type: 'string' },
      mesExample: { type: 'string', description: 'Example dialogue (max 32000 characters).' },
      systemPrompt: { type: 'string', description: 'Card-level system prompt override (max 16000 characters).' },
      postHistoryInstructions: { type: 'string', description: 'Card-level post-history instructions (max 16000 characters).' },
      creator: { type: 'string', description: 'Creator name (max 500 characters).' },
      characterVersion: { type: 'string', description: 'Card version string (max 100 characters).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Up to 32 non-empty tags (max 100 characters each); blank items dropped.' },
      alternateGreetings: { type: 'array', items: { type: 'string' }, description: 'Up to 16 extra first messages (stored as swipes); each max 16000 characters.' },
    },
    additionalProperties: false,
  },
  confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the presented card draft.' },
}, cardCreateOutput, async (args, exec) => {
  if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
  const name = editableValue('name', args.name)
  const fields = parseCreateFields(args.fields)
  if (typeof fields.name === 'string' && fields.name !== name) {
    throw new Error(`fields.name ('${fields.name}') must match the name argument ('${name}')`)
  }
  exec?.signal?.throwIfAborted()
  const db = await tavernStore()
  if ((await db.getCharacter(name)) !== undefined) {
    throw new Error(`character '${name}' already exists; card_create never overwrites — pick a different name`)
  }
  const data: Record<string, unknown> = {
    name,
    description: fields.description ?? '',
    personality: fields.personality ?? '',
    scenario: fields.scenario ?? '',
    first_mes: fields.firstMes ?? '',
    mes_example: fields.mesExample ?? '',
    creator_notes: fields.creatorNotes ?? '',
    system_prompt: fields.systemPrompt ?? '',
    post_history_instructions: fields.postHistoryInstructions ?? '',
    alternate_greetings: fields.alternateGreetings ?? [],
    tags: fields.tags ?? [],
    creator: fields.creator ?? '',
    character_version: fields.characterVersion ?? '',
    ...(fields.nickname !== undefined ? { nickname: fields.nickname } : {}),
    extensions: {},
  }
  const { card } = await db.importCharacter({ spec: 'chara_card_v2', spec_version: '2.0', data })
  // 出厂即快照：手工建的卡也有 restore 语义（首个胜出，绝不覆盖已有快照）
  const snapshotTaken = await saveOriginalSnapshot(dshHomePath('tavern'), card.data.name, card)
  await nameSessionAfterCreatedCard(exec, card.data.name)
  return {
    created: true,
    character: card.data.name,
    fieldLengths: fieldLengthsOf(card.data),
    alternateGreetings: card.data.alternateGreetings.length,
    snapshotTaken,
    source: { kind: 'character-card', id: card.data.name, version: card.specVersion },
  }
})

export const cardApplyMvuTool: ToolDefinition = tool('card_apply_mvu', 'Convert a character card to the MVU pattern (proposal 0012 P3): writes extensions.agentTavern.statusTemplate (rendered into the fixed right-side status panel) and initialVariables (deep-copied into chat_metadata.variables of every NEW chat). When the card has no original snapshot yet — cards that never went through the import route — the pre-conversion working copy is saved as the original first (once, never overwritten), keeping the conversion reversible via card_restore_original. Pre-existing agentTavern keys (e.g. scriptId) are preserved. The prose is NOT rewritten: offer a separate confirmed card_put to strip the old status-bar block from description/firstMes. Present the variable structure and template draft to the user FIRST; rejected without confirmed: true.', {
  character: { type: 'string', required: true, description: 'Character name to convert.' },
  statusTemplate: { type: 'string', required: true, description: 'Fixed status-panel template (EJS-style, rendered from chat variables); non-empty, max 16000 characters.' },
  initialVariables: { type: 'object', description: 'Initial variable tree seeded into every new chat for this card (plain JSON object; serialized size max 64KB). Omit to keep any existing value.' },
  confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the conversion plan.' },
}, mvuApplyOutput, async (args, exec) => {
  if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
  const character = stringArg(args.character)
  const template = statusTemplateArg(args.statusTemplate)
  const variables = args.initialVariables === undefined ? undefined : initialVariablesArg(args.initialVariables)
  exec?.signal?.throwIfAborted()
  const root = dshHomePath('tavern')
  const db = await tavernStore()
  const found = await requireCharacter(character)
  // ① 转换前补拍原版快照（P1 导入钩子未覆盖的老卡；已存在则不覆盖——
  //    saveOriginalSnapshot 自带「首个胜出」语义，转换可逆靠它）。
  let snapshotTaken = false
  if ((await readOriginalSnapshot(root, character)) === undefined) {
    snapshotTaken = await saveOriginalSnapshot(root, character, found.card)
  }
  // ② 只写 extensions.agentTavern：与既有键合并（scriptId 等原样保留），
  //    正文/开场白里的旧状态栏块不动——清理走确认后的 card_put。
  const extensions: Record<string, unknown> = { ...found.card.data.extensions }
  const previous = extensions.agentTavern
  const agentTavern: Record<string, unknown> = typeof previous === 'object' && previous !== null && !Array.isArray(previous)
    ? { ...(previous as Record<string, unknown>) }
    : {}
  agentTavern.statusTemplate = template
  if (variables !== undefined) agentTavern.initialVariables = structuredClone(variables)
  extensions.agentTavern = agentTavern
  const saved = await db.updateCharacter(character, {
    spec: found.card.spec,
    specVersion: found.card.specVersion,
    data: { ...found.card.data, extensions },
  })
  const applied = (saved.card.data.extensions.agentTavern ?? {}) as Record<string, unknown>
  const seeded = typeof applied.initialVariables === 'object' && applied.initialVariables !== null && !Array.isArray(applied.initialVariables)
    ? applied.initialVariables as Record<string, unknown>
    : undefined
  return {
    character: saved.card.data.name,
    statusTemplateLength: typeof applied.statusTemplate === 'string' ? applied.statusTemplate.length : 0,
    variableKeys: seeded === undefined ? [] : Object.keys(seeded),
    snapshotTaken,
    ...(Object.keys(agentTavern).some((key) => key !== 'statusTemplate' && key !== 'initialVariables')
      ? { retainedAgentTavernKeys: Object.keys(agentTavern).filter((key) => key !== 'statusTemplate' && key !== 'initialVariables') }
      : {}),
    source: { kind: 'character-card', id: saved.card.data.name, version: saved.card.specVersion },
  }
})

/* -------------------------------- helpers -------------------------------- */

/** 从 agent 作用域 ctx 探测宿主 sessionTitle 服务。运行时探针，不 inject
 *  声明——与 agent-tavern/deduce.ts 的 subagents 探测同款：get 反射通道
 *  优先（免 inject），属性通道兜底，两者都按缺失处理。 */
function sessionTitleOf(agent: WorkbenchExecAgent | undefined): { rename: (session: unknown, title: string) => unknown } | undefined {
  const ctx = agent?.ctx
  if (!ctx) return undefined
  try {
    const looked = ctx.get?.('sessionTitle')
    if (isSessionTitle(looked)) return looked
  } catch {
    // 未部署 session-title 服务时 get 可能抛错；继续试属性通道。
  }
  try {
    const direct = ctx.sessionTitle
    if (isSessionTitle(direct)) return direct
  } catch {
    // 未 inject 声明的宿主上属性访问会同步抛 without inject；按缺失处理。
  }
  return undefined
}

function isSessionTitle(candidate: unknown): candidate is { rename: (session: unknown, title: string) => unknown } {
  return typeof candidate === 'object' && candidate !== null
    && typeof (candidate as { rename?: unknown }).rename === 'function'
}

/**
 * 出卡后把本工作台会话改名为卡名（提案 0013 补充）：绑定面记 createdCard
 * （自绘侧边栏「写卡工作台」分组与复用判定据此显示卡名），宿主面经
 * sessionTitle.rename 固定会话标题（显式改名会停掉宿主的自动起名）。绑定
 * 先写——它不依赖宿主服务且是侧边栏的数据源；rename 后试。用户在侧边栏
 * 显式改过名（binding.title）时让位：createdCard 照记（数据），宿主标题与
 * 侧边栏标签保持用户的名字不被卡名覆盖。整个函数 best-effort：卡已落库，
 * 改名链路任何失败都不让 card_create 报错；非 card-workbench 绑定的会话
 * （无身份通道的老宿主、preset 挂到了别的会话）直接跳过，不劫持无关会话
 * 的标题。
 */
async function nameSessionAfterCreatedCard(exec: ToolExecution, cardName: string): Promise<void> {
  try {
    const agent = exec.agent
    const agentId = agent?.id
    if (typeof agentId !== 'string' || agentId.trim() === '') return
    const db = await tavernStore()
    const binding = (await db.getState()).sessionBindings[agentId]
    if (binding?.architecture !== 'card-workbench') return
    if (binding.createdCard !== cardName) {
      await db.updateState((state) => ({
        sessionBindings: {
          ...state.sessionBindings,
          [agentId]: { ...binding, createdCard: cardName },
        },
      }))
    }
    if (binding.title === undefined && agent.session !== undefined && agent.session !== null) {
      sessionTitleOf(agent)?.rename(agent.session, cardName)
    }
  } catch {
    // 改名是锦上添花：服务缺失、会话不活、标题被拒、状态写入冲突——全部
    // 静默放弃，出卡本身已经成功。
  }
}

function parseChanges(value: unknown): Array<{ field: CardField; value: string | string[] }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('changes must be a non-empty array of { field, value } entries')
  if (value.length > 16) throw new Error('changes accepts at most 16 entries; split larger edits across calls')
  const parsed: Array<{ field: CardField; value: string | string[] }> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('each change must be an object of { field, value }')
    const { field, value: raw } = entry as Record<string, unknown>
    if (typeof field !== 'string' || !(CARD_FIELD_KEYS as string[]).includes(field)) {
      throw new Error(`field '${String(field)}' is not editable; editable fields: ${CARD_FIELD_LIST}`)
    }
    const parsedValue = editableValue(field, raw)
    if (parsed.some((item) => item.field === field)) throw new Error(`duplicate change for field '${field}'`)
    parsed.push({ field: field as CardField, value: parsedValue })
  }
  return parsed
}

function fieldLengthsOf(data: CardDataIR): Record<string, number> {
  const record = data as unknown as Record<string, unknown>
  const lengths: Record<string, number> = {}
  for (const field of Object.keys(CARD_FIELDS) as CardTextField[]) {
    lengths[field] = typeof record[field] === 'string' ? (record[field] as string).length : 0
  }
  for (const field of Object.keys(CARD_ARRAY_FIELDS) as CardArrayField[]) {
    lengths[field] = Array.isArray(record[field]) ? (record[field] as string[]).join('\n').length : 0
  }
  return lengths
}

/* ------------------- 写入核（card_put 与方案执行共用，P2 抽出） ------------------- */

/**
 * 把白名单字段值合并进工作版并原子保存（updateCharacter：tmp+rename、保留
 * PNG/CHARX 容器，IR data 走整体合并分支，未提及字段原样保留）。
 * found 可传入已知的工作版（方案执行前做过过期检测，避免二次读）。
 * 文本字段给字符串，数组字段（tags/alternateGreetings）给整组替换数组。
 */
async function saveCardValues(
  character: string,
  values: Array<{ field: CardField; value: string | string[] }>,
  found?: CharacterFile,
): Promise<{ found: CharacterFile; saved: CharacterFile }> {
  const db = await tavernStore()
  const current = found ?? await requireCharacter(character)
  const nextData: CardDataIR = { ...current.card.data }
  const target = nextData as unknown as Record<string, unknown>
  for (const { field, value } of values) target[field] = value
  const saved = await db.updateCharacter(character, {
    spec: current.card.spec,
    specVersion: current.card.specVersion,
    data: nextData,
  })
  if (saved.card.data.name !== current.card.data.name) {
    // 改名跟卡迁移原版快照（对齐面板 PUT 路由）：旧名快照不迁移会变幽灵，
    // 污染将来同名卡的「首个胜出」导入快照。
    await moveOriginalSnapshot(dshHomePath('tavern'), character, saved.card.data.name)
  }
  return { found: current, saved }
}

function formatWriteResult(
  found: CharacterFile,
  saved: CharacterFile,
  values: Array<{ field: CardField; value: string | string[] }>,
): Record<string, unknown> {
  const renamed = saved.card.data.name !== found.card.data.name
  return {
    character: saved.card.data.name,
    ...(renamed ? { renamedFrom: found.card.data.name } : {}),
    changes: values.map(({ field, value }) => {
      const text = Array.isArray(value) ? value.join('\n') : value
      return { field, length: text.length, preview: limitText(text, 200) }
    }),
    fieldLengths: fieldLengthsOf(saved.card.data),
    source: { kind: 'character-card', id: saved.card.data.name, version: saved.card.specVersion },
  }
}

export interface CardPlanExecution {
  plan: CardPlan
  character: string
  renamedFrom?: string
  changes: Array<{ field: string; length: number; preview: string }>
  fieldLengths: Record<string, number>
  source: Record<string, unknown>
}

/** 活卡上的字段现值（数组字段给数组拷贝，供方案过期检测与 diff 快照）。 */
function cardLiveValue(data: CardDataIR, field: CardField): string | string[] {
  const raw = (data as unknown as Record<string, unknown>)[field]
  if (field in CARD_ARRAY_FIELDS) return Array.isArray(raw) ? [...(raw as string[])] : []
  return typeof raw === 'string' ? raw : ''
}

/** 方案过期检测的值等价：字符串直接比，数组逐项深比（引用不等 ≠ 值不等）。 */
function cardPlanValueMatches(live: string | string[], recorded: string | string[]): boolean {
  if (typeof live === 'string' || typeof recorded === 'string') return live === recorded
  return live.length === recorded.length && live.every((item, index) => item === recorded[index])
}

/**
 * 按已落库方案逐字段执行（对话内 card_put(planId) 与面板 decision 路由共用）：
 * 逐字段核对 currentValue 仍在活卡上（过期方案直接拒绝，防覆盖并发编辑），
 * 白名单/长度复检后写入工作版，成功才把方案标记 applied。
 */
export async function executeCardPlan(plan: CardPlan): Promise<CardPlanExecution> {
  if (plan.status === 'rejected') throw new Error(`plan '${plan.id}' was rejected and cannot be applied`)
  if (plan.status === 'applied') throw new Error(`plan '${plan.id}' was already applied`)
  if (plan.changes.length === 0) throw new Error(`plan '${plan.id}' has no changes`)
  const values = plan.changes.map(({ field, newValue }) => ({ field: editableField(field), value: editableValue(field, newValue) }))
  const found = await requireCharacter(plan.character)
  for (const change of plan.changes) {
    const field = editableField(change.field)
    const live = cardLiveValue(found.card.data, field)
    if (!cardPlanValueMatches(live, change.currentValue)) {
      throw new Error(`plan '${plan.id}' is stale: field '${change.field}' changed since the plan was proposed; re-propose the plan`)
    }
  }
  const { found: written, saved } = await saveCardValues(plan.character, values, found)
  const formatted = formatWriteResult(written, saved, values)
  const applied = await applyPlan(dshHomePath('tavern'), plan.id)
  return {
    plan: applied as CardPlan,
    character: formatted.character as string,
    ...(formatted.renamedFrom !== undefined ? { renamedFrom: formatted.renamedFrom as string } : {}),
    changes: formatted.changes as Array<{ field: string; length: number; preview: string }>,
    fieldLengths: formatted.fieldLengths as Record<string, number>,
    source: formatted.source as Record<string, unknown>,
  }
}

/* ---------------------------- 卡域参数解析 ---------------------------- */

function editableField(field: unknown): CardField {
  if (typeof field !== 'string' || !(CARD_FIELD_KEYS as string[]).includes(field)) {
    throw new Error(`field '${String(field)}' is not editable; editable fields: ${CARD_FIELD_LIST}`)
  }
  return field as CardField
}

function editableValue(field: string, value: unknown): string | string[] {
  if (field in CARD_ARRAY_FIELDS) return arrayFieldValue(field as CardArrayField, value)
  if (!(field in CARD_FIELDS)) {
    throw new Error(`field '${field}' is not editable; editable fields: ${CARD_FIELD_LIST}`)
  }
  if (typeof value !== 'string') throw new Error(`value for field '${field}' must be a string`)
  const max = CARD_FIELDS[field as CardTextField]
  if (value.length > max) throw new Error(`value for field '${field}' exceeds the ${max}-character limit (got ${value.length})`)
  if ((field === 'name' || field === 'nickname') && value.trim() === '') throw new Error(`field '${field}' must not be blank`)
  return value
}

/** 数组字段（tags/alternateGreetings）整组替换：trim 后丢空白项（面板同款），项数/单项上限硬校验。 */
function arrayFieldValue(field: CardArrayField, value: unknown): string[] {
  const spec = CARD_ARRAY_FIELDS[field]
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of at most ${spec.maxItems} non-empty strings (whole-group replacement)`)
  if (value.some((item) => typeof item !== 'string')) throw new Error(`each item of ${field} must be a string`)
  const items = (value as string[]).map((item) => item.trim()).filter((item) => item !== '')
  if (items.length > spec.maxItems) throw new Error(`${field} accepts at most ${spec.maxItems} non-empty items (got ${items.length})`)
  if (items.some((item) => item.length > spec.itemMax)) throw new Error(`an item of ${field} exceeds the ${spec.itemMax}-character limit`)
  return items
}

/** 方案回执里的值预览：字符串截 200，数组逐项截 200。 */
function previewPlanValue(value: CardPlanValue): string | string[] {
  return typeof value === 'string' ? limitText(value, 200) : value.map((item) => limitText(item, 200))
}

/** card_get 的 full 参数：字段名白名单，去重保序。 */
function parseFullFields(value: unknown): CardField[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('full must be a non-empty array of field names')
  return [...new Set(value.map((field) => {
    if (typeof field !== 'string' || !(CARD_FIELD_KEYS as string[]).includes(field)) {
      throw new Error(`field '${String(field)}' is not a card field; fields: ${CARD_FIELD_LIST}`)
    }
    return field as CardField
  }))]
}

/* --------------------- 制卡 / 转 MVU（P3）参数解析 --------------------- */

/** card_create 的 fields 白名单 = card_put 白名单（文本 + 数组）。 */
const CREATE_FIELD_KEYS = CARD_FIELD_KEYS

function parseCreateFields(value: unknown): Partial<Record<CardTextField, string>> & Partial<Record<CardArrayField, string[]>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('fields must be an object of { field: value } entries')
  }
  const parsed: Partial<Record<CardTextField, string>> & Partial<Record<CardArrayField, string[]>> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (key in CARD_ARRAY_FIELDS) {
      parsed[key as CardArrayField] = arrayFieldValue(key as CardArrayField, raw)
      continue
    }
    if (!(key in CARD_FIELDS)) {
      throw new Error(`field '${key}' is not settable; settable fields: ${CREATE_FIELD_KEYS.join(', ')}`)
    }
    parsed[key as CardTextField] = editableValue(key, raw) as string
  }
  return parsed
}

const STATUS_TEMPLATE_MAX = 16000
const INITIAL_VARIABLES_MAX_BYTES = 64 * 1024

function statusTemplateArg(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('statusTemplate must be a non-empty string')
  if (value.length > STATUS_TEMPLATE_MAX) {
    throw new Error(`statusTemplate exceeds the ${STATUS_TEMPLATE_MAX}-character limit (got ${value.length})`)
  }
  return value
}

function initialVariablesArg(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('initialVariables must be a plain object of variable name to JSON value')
  }
  let serialized: string
  try {
    serialized = JSON.stringify(value) ?? ''
  } catch (cause) {
    throw new Error(`initialVariables is not JSON-serializable (${cause instanceof Error ? cause.message : String(cause)})`)
  }
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > INITIAL_VARIABLES_MAX_BYTES) {
    throw new Error(`initialVariables exceeds the 64KB serialized limit (got ${bytes} bytes)`)
  }
  return value as Record<string, unknown>
}

function parsePlanChanges(value: unknown): Array<{ field: CardField; newValue: string | string[]; note?: string }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error('changes must be a non-empty array of { field, newValue, note? } entries')
  if (value.length > 16) throw new Error('changes accepts at most 16 entries; split larger plans')
  const parsed: Array<{ field: CardField; newValue: string | string[]; note?: string }> = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('each change must be an object of { field, newValue, note? }')
    const { field, newValue, note } = entry as Record<string, unknown>
    const editable = editableField(field)
    if (parsed.some((item) => item.field === editable)) throw new Error(`duplicate change for field '${editable}'`)
    parsed.push({
      field: editable,
      newValue: editableValue(editable, newValue),
      ...(typeof note === 'string' ? { note: limitText(note, 500) } : {}),
    })
  }
  return parsed
}

/* ------------------------------ 卡域摘要 ------------------------------ */

/** 卡字段摘要：预览截断 + 全量长度 + 元数据/备选开场白计数与预览；persona 为当前活跃用户人设。 */
function cardSummary(character: string, card: CharacterCardIR, persona?: { name: string; description: string }): Record<string, unknown> {
  const data = card.data
  const greetings = data.alternateGreetings ?? []
  return {
    character,
    name: data.name,
    // 对齐 agent-tavern 摘要约定：未设置 nickname 时回退显示名；
    // fieldLengths.nickname=0 仍如实反映该字段未设置。
    nickname: data.nickname ?? data.name,
    description: limitText(data.description, 2000),
    personality: limitText(data.personality, 1000),
    scenario: limitText(data.scenario, 1000),
    firstMes: limitText(data.firstMes, 2000),
    creatorNotes: limitText(data.creatorNotes, 1000),
    mesExample: limitText(data.mesExample, 1000),
    systemPrompt: limitText(data.systemPrompt, 1000),
    postHistoryInstructions: limitText(data.postHistoryInstructions, 1000),
    creator: limitText(data.creator, 200),
    characterVersion: limitText(data.characterVersion, 100),
    tags: limitText((data.tags ?? []).join(', '), 200),
    alternateGreetingsCount: greetings.length,
    alternateGreetingsPreviews: greetings.map((greeting) => limitText(greeting, 200)),
    ...(persona !== undefined ? { persona } : {}),
    fieldLengths: fieldLengthsOf(data),
    extensionKeys: Object.keys(data.extensions ?? {}).slice(0, 50),
    source: { kind: 'character-card', id: character, version: card.specVersion },
    truncated: data.description.length > 2000 || data.personality.length > 1000
      || data.scenario.length > 1000 || data.firstMes.length > 2000 || data.creatorNotes.length > 1000
      || data.mesExample.length > 1000 || data.systemPrompt.length > 1000 || data.postHistoryInstructions.length > 1000
      || data.creator.length > 200 || data.characterVersion.length > 100 || (data.tags ?? []).join(', ').length > 200
      || greetings.some((greeting) => greeting.length > 200),
  }
}

/** 活跃用户人设（best-effort）：未设置或读取失败时名字为空串。 */
async function activePersona(db: Awaited<ReturnType<typeof tavernStore>>): Promise<{ name: string; description: string }> {
  try {
    const name = (await db.getState()).activePersona
    if (typeof name !== 'string' || name.trim() === '') return { name: '', description: '' }
    const persona = await db.getPersona(name)
    return persona === undefined
      ? { name, description: '' }
      : { name: persona.name, description: limitText(persona.description, 500) }
  } catch {
    return { name: '', description: '' }
  }
}
