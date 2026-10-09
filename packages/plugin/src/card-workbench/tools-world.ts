/**
 * 写卡工作台 · 世界书域工具（决策 2026-10-09-dedup-refactor 自 agent.ts 拆分）。
 *
 * 世界书读改删与方案执行（提案 0013 P2 世界书面板化同构扩展 + 2026-10-08
 * worldbook-full-editing）：world_plan_propose / world_list / world_get / world_put /
 * world_create / world_delete / world_rename / world_bind / world_copy 九件工具，
 * 声明式 WORLD_ENTRY_FIELDS 表驱动 schema / 校验 / 写映射 / 摘要，执行核
 * executeWorldPlan 供对话内 planId 路径与面板 decision 路由共用。
 */

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { normalizeEntry, type LoreEntry } from '../../../tavern-format/src/index.js'
import { dshHomePath } from '../dsh-home.js'
import { limitText, stringArg } from '../tool-args.js'
import { applyPlan, getPlan, proposeWorldPlan, type WorldPlan, type WorldPlanValue } from './plans.js'
import {
  CONFIRMATION_ERROR,
  objectOutput,
  requireCharacter,
  tavernStore,
  titleArg,
  tool,
  type ToolDefinition,
} from './shared.js'

/* --------------- 世界书条目可编辑字段表（单一事实源） --------------- */

/**
 * ST LoreEntry 条目的 Agent 可编辑白名单（提案 0013 世界书完整扩展）：
 * 工具 schema、入参校验、写映射与摘要输出全部由这张表驱动。enabled 在
 * LoreEntry 上以 disable 反值存储；fallback 是 normalizeEntry 的缺省值，
 * 摘要只上报偏离缺省的高级字段。outletName 不开放（ST EM 出口钩子，
 * 非写卡场景，需要时走面板/JSON）。
 */
interface WorldEntryFieldSpec {
  type: 'string' | 'stringArray' | 'boolean' | 'integer' | 'nullableBoolean' | 'nullableInteger'
  /** LoreEntry 目标键；缺省与字段同名（enabled → disable）。 */
  loreKey?: string
  /** 与 LoreEntry 存储值取反（enabled → disable）。 */
  invert?: boolean
  maxLength?: number
  maxItems?: number
  min?: number
  max?: number
  /** normalizeEntry 缺省值（数组以「空数组」语义比较）。 */
  fallback: unknown
  hint: string
}

const WORLD_ENTRY_FIELDS = {
  key: { type: 'stringArray', maxItems: 16, fallback: [], hint: 'Replacement primary key list (max 16 non-empty strings).' },
  keysecondary: { type: 'stringArray', maxItems: 16, fallback: [], hint: 'Replacement secondary key list (max 16 non-empty strings; combines per selectiveLogic).' },
  comment: { type: 'string', maxLength: 2000, fallback: '', hint: 'Entry title/memo shown in editors (max 2000 characters).' },
  content: { type: 'string', maxLength: 32000, fallback: '', hint: 'Replacement entry content (max 32000 characters).' },
  enabled: { type: 'boolean', loreKey: 'disable', invert: true, fallback: false, hint: 'false disables the entry without deleting it.' },
  constant: { type: 'boolean', fallback: false, hint: 'true always injects the entry (blue light), ignoring key matches.' },
  order: { type: 'integer', min: 0, max: 100000, fallback: 100, hint: 'Insertion order among activated entries.' },
  position: { type: 'integer', min: 0, max: 100, fallback: 0, hint: 'Injection position: 0 before char, 1 after char, 2/3 author note top/bottom, 4 at depth, 5/6 example messages top/bottom.' },
  depth: { type: 'integer', min: 0, max: 100, fallback: 4, hint: 'Depth for at-depth positions (4).' },
  probability: { type: 'integer', min: 0, max: 100, fallback: 100, hint: 'Activation chance in percent.' },
  useProbability: { type: 'boolean', fallback: true, hint: 'false makes the entry ignore probability.' },
  selective: { type: 'boolean', fallback: true, hint: 'Evaluate secondary keys per selectiveLogic.' },
  selectiveLogic: { type: 'integer', min: 0, max: 3, fallback: 0, hint: 'Secondary key logic: 0 ANY, 1 NOT ALL, 2 NOT ANY, 3 ALL.' },
  group: { type: 'string', maxLength: 200, fallback: '', hint: 'Inclusion group name; group entries activate as one unit.' },
  groupOverride: { type: 'boolean', fallback: false, hint: 'Group entry wins over non-group entries.' },
  groupWeight: { type: 'integer', min: 0, max: 1000, fallback: 100, hint: 'Relative weight inside the inclusion group.' },
  scanDepth: { type: 'nullableInteger', min: 0, max: 100, fallback: null, hint: 'Per-entry scan depth override; null uses the global setting.' },
  caseSensitive: { type: 'nullableBoolean', fallback: null, hint: 'Per-entry case-sensitive matching override; null uses the global setting.' },
  matchWholeWords: { type: 'nullableBoolean', fallback: null, hint: 'Per-entry whole-word matching override; null uses the global setting.' },
  useGroupScoring: { type: 'nullableBoolean', fallback: null, hint: 'Per-entry group-scoring override; null uses the global setting.' },
  vectorized: { type: 'boolean', fallback: false, hint: 'Mark the entry as vectorized (excluded from key matching).' },
  addMemo: { type: 'boolean', fallback: false, hint: 'Append the entry to the chat memo when it activates.' },
  ignoreBudget: { type: 'boolean', fallback: false, hint: 'Entry bypasses the world info token budget.' },
  excludeRecursion: { type: 'boolean', fallback: false, hint: 'This entry never activates through recursion.' },
  preventRecursion: { type: 'boolean', fallback: false, hint: 'This entry\'s content does not trigger further recursion scans.' },
  delayUntilRecursion: { type: 'integer', min: 0, max: 100, fallback: 0, hint: 'Only activate from this recursion pass on.' },
  sticky: { type: 'nullableInteger', min: 0, max: 100000, fallback: null, hint: 'Once triggered, keep the entry active for N further generations.' },
  cooldown: { type: 'nullableInteger', min: 0, max: 100000, fallback: null, hint: 'After triggering, block the entry for N generations.' },
  delay: { type: 'nullableInteger', min: 0, max: 100000, fallback: null, hint: 'Block the entry for the first N generations of a chat.' },
  triggers: { type: 'stringArray', maxItems: 16, fallback: [], hint: 'Additional automation trigger phrases (max 16).' },
  automationId: { type: 'string', maxLength: 200, fallback: '', hint: 'Automation hook id used by ST extensions/quick replies.' },
  role: { type: 'integer', min: 0, max: 2, fallback: 0, hint: 'Chat role for at-depth positions: 0 system, 1 user, 2 assistant.' },
  matchPersonaDescription: { type: 'boolean', fallback: false, hint: 'Also scan the active persona description for this entry\'s keys.' },
  matchCharacterDescription: { type: 'boolean', fallback: false, hint: 'Also scan the character description.' },
  matchCharacterPersonality: { type: 'boolean', fallback: false, hint: 'Also scan the character personality.' },
  matchCharacterDepthPrompt: { type: 'boolean', fallback: false, hint: 'Also scan the character depth prompt.' },
  matchScenario: { type: 'boolean', fallback: false, hint: 'Also scan the scenario.' },
  matchCreatorNotes: { type: 'boolean', fallback: false, hint: 'Also scan the creator notes.' },
} satisfies Record<string, WorldEntryFieldSpec>

type WorldEditableField = keyof typeof WORLD_ENTRY_FIELDS
const WORLD_EDITABLE_FIELDS = Object.keys(WORLD_ENTRY_FIELDS) as WorldEditableField[]
const WORLD_EDITABLE_FIELD_LIST = WORLD_EDITABLE_FIELDS.join(', ')

/* ------------------------------ output schemas ------------------------------ */

const worldPlanProposeOutput = objectOutput({
  planId: { type: 'string' }, world: { type: 'string' }, op: { type: 'string' }, title: { type: 'string' },
  status: { type: 'string' }, createdAt: { type: 'string' },
  entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const worldSummaryOutput = objectOutput({
  found: { type: 'boolean' }, world: { type: 'string' }, entryCount: { type: 'number' }, nextUid: { type: 'number' },
  entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, truncated: { type: 'boolean' },
  missingUids: { type: 'array', items: { type: 'number' }, description: 'Requested uids that do not exist (uids-filtered reads only).' },
}, ['missingUids'])
const worldPutOutput = objectOutput({
  world: { type: 'string' }, entryCount: { type: 'number' }, nextUid: { type: 'number' },
  planId: { type: 'string', description: 'Present when a recorded plan was applied: its id.' },
  planStatus: { type: 'string', description: 'Present when a recorded plan was applied: the plan status after execution.' },
  entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
}, ['planId', 'planStatus'])
const worldListOutput = objectOutput({
  count: { type: 'number' },
  worlds: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const worldCreateOutput = objectOutput({
  created: { type: 'boolean' }, world: { type: 'string' }, entryCount: { type: 'number' }, nextUid: { type: 'number' },
  planId: { type: 'string', description: 'Present when a recorded plan was applied: its id.' },
  planStatus: { type: 'string', description: 'Present when a recorded plan was applied: the plan status after execution.' },
}, ['planId', 'planStatus'])
const worldDeleteOutput = objectOutput({
  deleted: { type: 'boolean' }, world: { type: 'string' },
  wasActive: { type: 'boolean', description: 'True when the book was in the session activeWorlds list and has been removed from it.' },
})
const worldRenameOutput = objectOutput({
  world: { type: 'string' }, renamedFrom: { type: 'string' }, entryCount: { type: 'number' },
  reboundCards: { type: 'array', items: { type: 'string' }, description: 'Character cards whose world link was re-pointed to the new name.' },
  wasActive: { type: 'boolean', description: 'True when activeWorlds followed the rename.' },
})
const worldBindOutput = objectOutput({
  character: { type: 'string' }, world: { type: 'string' },
  bound: { type: 'boolean', description: 'true after attaching, false after detaching.' },
  previousWorld: { type: 'string', description: 'Book the card linked before this bind switched it.' },
  alreadyBound: { type: 'boolean', description: 'true when the card already linked this exact book (no write happened).' },
}, ['previousWorld', 'alreadyBound'])
const worldCopyOutput = objectOutput({
  copied: { type: 'boolean' }, from: { type: 'string' }, to: { type: 'string' }, entryCount: { type: 'number' },
})

/* -------------------------------- 工具定义 -------------------------------- */

export const worldTools: ToolDefinition[] = [
  tool('world_plan_propose', 'Record a pending world book plan (confirmation protocol, same flow as card plans): per-entry field replacements, new entries or removals for an existing book, or the initial entries of a book to create. The CURRENT values are snapshotted from the live book so the diff shown to the user is truthful. Entries take the same shape as world_put edits (or world_create seeds when create: true). Returns a planId — the user then approves the plan in the workbench panel, or confirms in conversation and you call world_put (edit) / world_create (create) with that planId and confirmed: true. Proposing does not write the book.', {
    world: { type: 'string', required: true, description: 'World book name the plan targets (the name of the book to create when create is true).' },
    title: { type: 'string', required: true, description: 'Short human-readable plan title shown in the workbench panel (max 200 characters).' },
    create: { type: 'boolean', description: 'True plans the creation of a new book with the given seed entries (uids in array order); false (default) plans edits to the existing book named world.' },
    entries: {
      type: 'array', required: true,
      description: `Up to 32 entries of { uid, <editable field>…, remove?, note? } for edits (uid required per entry), or { <editable field>…, note? } seeds for creation (uids follow array order). Editable fields: ${WORLD_EDITABLE_FIELD_LIST}.`,
      items: {
        type: 'object',
        properties: {
          uid: { type: 'integer', minimum: 0 },
          remove: { type: 'boolean', description: 'Delete the entry (existing uids only); cannot be combined with other fields.' },
          note: { type: 'string', description: 'Why this entry change serves the user intent (max 500 characters).' },
          ...worldEditableProperties(),
        },
        additionalProperties: false,
      },
    },
  }, worldPlanProposeOutput, async (args, exec) => {
    const world = worldNameArg(args.world)
    const title = titleArg(args.title)
    const create = args.create === true
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const book = await db.getWorld(world)
    if (create && book !== undefined) {
      throw new Error(`world '${world}' already exists; propose edits to it instead (drop create) or pick a different name (world_list)`)
    }
    if (!create && book === undefined) {
      throw new Error(`world '${world}' not found; set create: true to plan a new book, or world_list shows the library`)
    }
    if (!Array.isArray(args.entries) || args.entries.length === 0) throw new Error('entries must be a non-empty array')
    // note 不在条目白名单里，解析前剥离单独校验（长度上限对齐方案存储层）
    const noteAt = (index: number): string | undefined => {
      const raw = args.entries[index]
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
      const note = (raw as Record<string, unknown>).note
      if (note === undefined) return undefined
      if (typeof note !== 'string' || note.length > 500) throw new Error(`note for entry ${index + 1} must be a string of at most 500 characters`)
      return note
    }
    const cleaned = args.entries.map((raw, index) => {
      const note = noteAt(index)
      if (note === undefined) return raw
      const { note: _drop, ...rest } = raw as Record<string, unknown>
      return rest
    })
    const byUid = new Map((book?.entries ?? []).map((entry) => [entry.uid, entry]))
    const proposed = create ? parseWorldSeedEntries(cleaned) : parseWorldEdits(cleaned)
    const entries = proposed.map((edit, index) => {
      const note = noteAt(index)
      if (create) {
        // 建书方案：全部 create 动作，uid 按数组顺序（与 world_create 同款分配）
        return {
          uid: index,
          action: 'create' as const,
          fields: Object.entries(edit.values).map(([field, newValue]) => ({ field, newValue: newValue as WorldPlanValue })),
          ...(note !== undefined ? { note } : {}),
        }
      }
      const existing = byUid.get(edit.uid)
      if (edit.remove) {
        if (existing === undefined) throw new Error(`uid ${edit.uid} not found in world '${world}'; removal matches existing entries only (see world_get)`)
        return { uid: edit.uid, action: 'remove' as const, fields: [], ...(note !== undefined ? { note } : {}) }
      }
      // currentValue 一律以活书为准（不信任模型复述），diff 面向用户保真
      const fields = edit.fields.map((field) => ({
        field,
        ...(existing !== undefined ? { currentValue: worldLiveValue(existing, field as WorldEditableField) } : {}),
        newValue: edit.values[field] as WorldPlanValue,
      }))
      return { uid: edit.uid, action: existing === undefined ? 'create' as const : 'update' as const, fields, ...(note !== undefined ? { note } : {}) }
    })
    const plan = await proposeWorldPlan(dshHomePath('tavern'), world, {
      op: create ? 'create' : 'edit',
      title,
      entries,
    })
    return {
      planId: plan.id,
      world: plan.world,
      op: plan.op,
      title: plan.title,
      status: plan.status,
      createdAt: plan.createdAt,
      entries: plan.entries.map((entry) => ({
        uid: entry.uid,
        action: entry.action,
        fields: entry.fields.map((field) => ({
          field: field.field,
          ...(field.currentValue !== undefined ? { currentValue: previewWorldPlanValue(field.currentValue) } : {}),
          newValue: previewWorldPlanValue(field.newValue),
        })),
        ...(entry.note !== undefined ? { note: entry.note } : {}),
      })),
    }
  }),
  tool('world_list', 'List the Tavern world-book library: every stored book name with its entry count and the character cards linking it (extensions.world). Call it before world_create to pick a free name, before world_delete/world_rename to check linked cards, or when the user refers to a world book and you are not sure of its exact name.', {}, worldListOutput, async (_args, exec) => {
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const bindings = new Map<string, string[]>()
    for (const characterName of await db.listCharacters()) {
      const file = await db.getCharacter(characterName)
      const bound = file?.card.data.extensions['world']
      if (typeof bound !== 'string' || bound.trim() === '') continue
      const list = bindings.get(bound) ?? []
      list.push(characterName)
      bindings.set(bound, list)
    }
    const worlds: Array<{ name: string; entryCount: number; linkedCards: string[] }> = []
    for (const name of await db.listWorlds()) {
      const book = await db.getWorld(name)
      worlds.push({ name, entryCount: book?.entries.length ?? 0, linkedCards: bindings.get(name) ?? [] })
    }
    return { count: worlds.length, worlds }
  }),
  tool('world_get', 'Read the summary of a Tavern world book: entries keyed by uid (trigger keys, comment, content preview, enabled flag, constant/order/position/depth plus any advanced ST field deviating from its default), entry count and the next free uid. Content previews are capped at 500 characters — pass uids to fetch specific entries with their FULL content (needed before rewriting or moving long text verbatim); missing uids are reported. Call it before proposing any world book change. A missing book is an error — use world_list to find the right name or world_create to start a new one.', {
    world: { type: 'string', required: true, description: 'World book name from the conversation.' },
    uids: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'Optional uid filter (at most 32): matching entries return with full content; missing uids are reported.' },
  }, worldSummaryOutput, async (args, exec) => {
    const world = stringArg(args.world)
    const selected = args.uids === undefined ? undefined : parseWorldUids(args.uids)
    exec?.signal?.throwIfAborted()
    const book = await (await tavernStore()).getWorld(world)
    if (book === undefined) throw new Error(`world '${world}' not found; world_list shows the library and world_create can start a new book`)
    const summary = worldSummary(world, book.entries, selected)
    if (selected !== undefined) {
      const foundUids = new Set(book.entries.map((entry) => entry.uid))
      const missing = selected.filter((uid) => !foundUids.has(uid))
      if (missing.length > 0) summary.missingUids = missing
    }
    return summary
  }),
  tool('world_put', 'Apply confirmed edits to a world book, either from a recorded plan (planId from world_plan_propose — the recorded entries are applied exactly and any direct entries argument is ignored) or as direct edits matched by uid: existing entries get only the provided fields replaced (full ST entry whitelist — key, keysecondary, comment, content, enabled plus advanced fields like constant, order, position, depth, probability, selective logic, groups, recursion and timed effects); unmentioned fields are preserved verbatim. Unknown uids create new entries (use nextUid from world_get), and remove: true deletes an existing entry. Present the per-entry before/after plan to the user FIRST; rejected without confirmed: true. The book itself must already exist: world_create starts new books and world_list shows the library.', {
    world: { type: 'string', required: true, description: 'World book name to edit; must match the plan when planId is given.' },
    planId: { type: 'string', description: 'ID of a world edit plan recorded by world_plan_propose; applies the recorded entries exactly and marks it applied.' },
    entries: {
      type: 'array', description: 'Ignored when planId is given. Otherwise up to 32 edits, each { uid, <editable field>…, remove? }: existing uids get only the provided fields replaced, unknown uids create entries, remove: true deletes the entry (exclusive with other fields). At least one editable field or remove per entry.',
      items: {
        type: 'object',
        properties: {
          uid: { type: 'integer', minimum: 0 },
          remove: { type: 'boolean', description: 'Delete the entry (existing uids only); cannot be combined with other fields.' },
          ...worldEditableProperties(),
        },
        required: ['uid'],
        additionalProperties: false,
      },
    },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the presented plan.' },
  }, worldPutOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const world = stringArg(args.world)
    exec?.signal?.throwIfAborted()
    if (args.planId !== undefined) {
      const planId = stringArg(args.planId)
      const plan = await getPlan(dshHomePath('tavern'), planId)
      if (plan === undefined) throw new Error(`plan '${planId}' not found`)
      if (plan.kind !== 'world' || plan.op !== 'edit') throw new Error(`plan '${planId}' is not a world edit plan; book creations go through world_create and card plans through card_put`)
      if (plan.world !== world) throw new Error(`plan '${planId}' belongs to world '${plan.world}', not '${world}'`)
      const executed = await executeWorldPlan(plan)
      return {
        world: executed.world,
        entryCount: executed.entryCount,
        nextUid: executed.nextUid,
        entries: executed.touched,
        planId,
        planStatus: executed.plan.status,
      }
    }
    const edits = parseWorldEdits(args.entries)
    const db = await tavernStore()
    const book = await db.getWorld(world)
    if (book === undefined) throw new Error(`world '${world}' not found; create it with world_create first (world_list shows the library)`)
    const { entries, touched } = applyWorldEdits(world, book, edits)
    await db.putWorld({ ...book, entries })
    const summary = worldSummary(world, entries)
    return { world, entryCount: summary.entryCount, nextUid: summary.nextUid, entries: touched }
  }),
  tool('world_create', 'Create a new Tavern world book, either from a recorded creation plan (planId from world_plan_propose with create: true — the recorded seed entries are applied exactly and any direct entries argument is ignored) or directly with optional initial entries: uids are assigned in array order (0, 1, …) and every entry takes the full world_put whitelist (key, keysecondary, comment, content, enabled plus advanced ST fields) with the same limits. Present the book name and the full initial entry plan to the user FIRST; rejected without confirmed: true. Refuses when a book with the same name already exists — world_create never overwrites, and existing books are edited through world_put. Creation binds nothing; attach the book to a card with world_bind.', {
    name: { type: 'string', required: true, description: 'Name of the new world book (max 120 characters); must not collide with an existing book (see world_list) and must match the plan when planId is given.' },
    planId: { type: 'string', description: 'ID of a world creation plan recorded by world_plan_propose (create: true); applies the recorded book exactly and marks it applied.' },
    entries: {
      type: 'array', description: 'Ignored when planId is given. Otherwise optional initial entries (at most 32), each { <editable field>… } with at least one field; uid assignment follows array order.',
      items: {
        type: 'object',
        properties: worldEditableProperties(),
        additionalProperties: false,
      },
    },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the presented book plan.' },
  }, worldCreateOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const name = worldNameArg(args.name)
    exec?.signal?.throwIfAborted()
    if (args.planId !== undefined) {
      const planId = stringArg(args.planId)
      const plan = await getPlan(dshHomePath('tavern'), planId)
      if (plan === undefined) throw new Error(`plan '${planId}' not found`)
      if (plan.kind !== 'world' || plan.op !== 'create') throw new Error(`plan '${planId}' is not a world creation plan; edit plans go through world_put and card plans through card_put`)
      if (plan.world !== name) throw new Error(`plan '${planId}' belongs to world '${plan.world}', not '${name}'`)
      const executed = await executeWorldPlan(plan)
      return {
        created: true,
        world: executed.world,
        entryCount: executed.entryCount,
        nextUid: executed.nextUid,
        planId,
        planStatus: executed.plan.status,
      }
    }
    const seeds = parseWorldSeedEntries(args.entries)
    const db = await tavernStore()
    if ((await db.getWorld(name)) !== undefined) {
      throw new Error(`world '${name}' already exists; world_create never overwrites — edit it with world_put or pick a different name`)
    }
    const entries = seeds.map((seed, uid) => worldEntryFromValues(uid, seed.values))
    await db.putWorld({ name, entries })
    return { created: true, world: name, entryCount: entries.length, nextUid: entries.length }
  }),
  tool('world_delete', 'Delete a world book permanently. Worlds have NO original snapshot — deletion is irreversible, so present the full entry list (world_get) and call with confirmed: true only after the user explicitly approves. Refuses while any character card still links the book (world_list shows linkedCards): unbind those cards with world_bind first. The book is also removed from the session activeWorlds list.', {
    world: { type: 'string', required: true, description: 'World book name to delete.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the irreversible deletion.' },
  }, worldDeleteOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const world = stringArg(args.world)
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const book = await db.getWorld(world)
    if (book === undefined) throw new Error(`world '${world}' not found (world_list shows the library)`)
    const linked = await worldLinkedCards(db, world)
    if (linked.length > 0) {
      throw new Error(`world '${world}' is linked by character card(s) ${linked.join(', ')}; unbind them with world_bind first — deletion is irreversible`)
    }
    const active = (await db.getState()).activeWorlds.includes(world)
    await db.deleteWorld(world)
    if (active) {
      await db.updateState((current) => ({ activeWorlds: current.activeWorlds.filter((name) => name !== world) }))
    }
    return { deleted: true, world, wasActive: active }
  }),
  tool('world_rename', 'Rename a world book and carry every reference along: character cards linking the book (extensions.world) are re-pointed to the new name and the session activeWorlds list follows — no card is left pointing at the old name (the panel import route does not re-point links; this tool does). Refuses when the target name already exists. Entries and uids are untouched.', {
    world: { type: 'string', required: true, description: 'Current world book name.' },
    name: { type: 'string', required: true, description: 'New world book name (max 120 characters); must not collide with an existing book.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the rename.' },
  }, worldRenameOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const world = stringArg(args.world)
    const next = worldNameArg(args.name)
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const book = await db.getWorld(world)
    if (book === undefined) throw new Error(`world '${world}' not found (world_list shows the library)`)
    if (next === world) throw new Error(`world '${world}' is already named '${next}'`)
    // safeFileName 撞名时 getWorld(next) 读到的就是旧书本身，同样落进这里
    if ((await db.getWorld(next)) !== undefined) {
      throw new Error(`world '${next}' already exists; world_rename never overwrites — pick a different name`)
    }
    const linked = await worldLinkedCards(db, world)
    await db.putWorld({ ...book, name: next })
    await db.deleteWorld(world)
    for (const characterName of linked) {
      const found = await requireCharacter(characterName)
      const extensions: Record<string, unknown> = { ...found.card.data.extensions, world: next }
      await db.updateCharacter(characterName, {
        spec: found.card.spec,
        specVersion: found.card.specVersion,
        data: { ...found.card.data, extensions },
      })
    }
    const active = (await db.getState()).activeWorlds.includes(world)
    if (active) {
      await db.updateState((current) => ({ activeWorlds: current.activeWorlds.map((name) => name === world ? next : name) }))
    }
    return { world: next, renamedFrom: world, entryCount: book.entries.length, reboundCards: linked, wasActive: active }
  }),
  tool('world_bind', 'Attach a world book to a character card — writes the card\'s world link (extensions.world), so the book joins every play with that card. Binding switches an existing link to another book (the previous book is reported); unbind: true detaches instead and requires the card to currently link THIS book. The book must exist (world_list); book creation never auto-binds.', {
    world: { type: 'string', required: true, description: 'World book name to attach or detach.' },
    character: { type: 'string', required: true, description: 'Character name the book attaches to.' },
    unbind: { type: 'boolean', description: 'true detaches the book from the card instead of attaching it.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the bind/unbind.' },
  }, worldBindOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const world = stringArg(args.world)
    const character = stringArg(args.character)
    const unbind = args.unbind === true
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const found = await requireCharacter(character)
    if (!unbind && (await db.getWorld(world)) === undefined) {
      throw new Error(`world '${world}' not found (world_list shows the library)`)
    }
    const current = found.card.data.extensions['world']
    const extensions: Record<string, unknown> = { ...found.card.data.extensions }
    if (unbind) {
      if (current !== world) {
        throw new Error(`character '${character}' does not link world '${world}'${typeof current === 'string' && current.trim() !== '' ? ` (currently links '${current}')` : ''}`)
      }
      delete extensions['world']
      await db.updateCharacter(character, { spec: found.card.spec, specVersion: found.card.specVersion, data: { ...found.card.data, extensions } })
      return { character, world, bound: false }
    }
    if (current === world) return { character, world, bound: true, alreadyBound: true }
    extensions['world'] = world
    await db.updateCharacter(character, { spec: found.card.spec, specVersion: found.card.specVersion, data: { ...found.card.data, extensions } })
    return {
      character, world, bound: true,
      ...(typeof current === 'string' && current.trim() !== '' ? { previousWorld: current } : {}),
    }
  }),
  tool('world_copy', 'Duplicate an existing world book under a new name — entries and uids are copied verbatim, the lossless way to fork a book for a new card (world_get previews truncate content, so recomposing a copy through world_create is lossy). Refuses when the target name already exists; the copy binds nothing (use world_bind).', {
    world: { type: 'string', required: true, description: 'Existing world book to copy.' },
    name: { type: 'string', required: true, description: 'Name of the new copy (max 120 characters); must not collide with an existing book.' },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the copy.' },
  }, worldCopyOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const world = stringArg(args.world)
    const target = worldNameArg(args.name)
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const book = await db.getWorld(world)
    if (book === undefined) throw new Error(`world '${world}' not found (world_list shows the library)`)
    if (target === world) throw new Error(`target name '${target}' equals the source; world_copy needs a new name`)
    if ((await db.getWorld(target)) !== undefined) {
      throw new Error(`world '${target}' already exists; world_copy never overwrites — pick a different name`)
    }
    await db.putWorld({ ...book, name: target })
    return { copied: true, from: world, to: target, entryCount: book.entries.length }
  }),
]

/* ------------------------- 世界书方案执行核 ------------------------- */

export interface WorldPlanExecution {
  plan: WorldPlan
  world: string
  entryCount: number
  nextUid: number
  touched: Array<{ uid: number; created: boolean; removed?: boolean; fields: string[] }>
}

/**
 * 按已落库的世界书方案执行（对话内 world_put/world_create(planId) 与面板
 * decision 路由共用）：先做过期检测——update 逐字段核对 currentValue 仍在
 * 活条目上、create 的 uid 尚不存在、remove 的条目仍在、建书名仍空闲（防
 * 覆盖并发编辑），再经白名单/范围复检写入，成功才把方案标记 applied。
 */
export async function executeWorldPlan(plan: WorldPlan): Promise<WorldPlanExecution> {
  if (plan.status === 'rejected') throw new Error(`plan '${plan.id}' was rejected and cannot be applied`)
  if (plan.status === 'applied') throw new Error(`plan '${plan.id}' was already applied`)
  if (plan.entries.length === 0) throw new Error(`plan '${plan.id}' has no entries`)
  const db = await tavernStore()
  if (plan.op === 'create') {
    if ((await db.getWorld(plan.world)) !== undefined) {
      throw new Error(`plan '${plan.id}' is stale: world '${plan.world}' already exists; re-propose the plan`)
    }
    const seeds = plan.entries.map((entry) => {
      const values: Record<string, unknown> = {}
      for (const field of entry.fields) values[editableWorldField(field.field)] = worldFieldValue(editableWorldField(field.field), field.newValue, ` for uid ${entry.uid}`)
      return values
    })
    const entries = seeds.map((values, uid) => worldEntryFromValues(uid, values))
    await db.putWorld({ name: plan.world, entries })
    const applied = await applyPlan(dshHomePath('tavern'), plan.id)
    return {
      plan: applied as WorldPlan,
      world: plan.world,
      entryCount: entries.length,
      nextUid: entries.length,
      touched: entries.map((_entry, uid) => ({ uid, created: true, fields: plan.entries[uid].fields.map((field) => field.field) })),
    }
  }
  const book = await db.getWorld(plan.world)
  if (book === undefined) throw new Error(`plan '${plan.id}' is stale: world '${plan.world}' no longer exists; re-propose the plan`)
  const byUid = new Map(book.entries.map((entry) => [entry.uid, entry]))
  const edits: WorldEntryEdit[] = plan.entries.map((entry) => {
    const existing = byUid.get(entry.uid)
    if (entry.action === 'remove') {
      if (existing === undefined) throw new Error(`plan '${plan.id}' is stale: uid ${entry.uid} no longer exists in world '${plan.world}'; re-propose the plan`)
      return { uid: entry.uid, remove: true, values: {}, fields: [] }
    }
    if (entry.action === 'update' && existing === undefined) {
      throw new Error(`plan '${plan.id}' is stale: uid ${entry.uid} no longer exists in world '${plan.world}'; re-propose the plan`)
    }
    if (entry.action === 'create' && existing !== undefined) {
      throw new Error(`plan '${plan.id}' is stale: uid ${entry.uid} already exists in world '${plan.world}'; re-propose the plan`)
    }
    const values: Record<string, unknown> = {}
    const fields: string[] = []
    for (const fieldChange of entry.fields) {
      const field = editableWorldField(fieldChange.field)
      if (entry.action === 'update') {
        const live = worldLiveValue(existing as LoreEntry, field)
        if (fieldChange.currentValue === undefined || !worldPlanValueMatches(live, fieldChange.currentValue)) {
          throw new Error(`plan '${plan.id}' is stale: field '${field}' on uid ${entry.uid} changed since the plan was proposed; re-propose the plan`)
        }
      }
      values[field] = worldFieldValue(field, fieldChange.newValue, ` for uid ${entry.uid}`)
      fields.push(field)
    }
    return { uid: entry.uid, remove: false, values, fields }
  })
  const { entries, touched } = applyWorldEdits(plan.world, book, edits)
  await db.putWorld({ ...book, entries })
  const applied = await applyPlan(dshHomePath('tavern'), plan.id)
  return {
    plan: applied as WorldPlan,
    world: plan.world,
    entryCount: entries.length,
    nextUid: entries.reduce((max, entry) => Math.max(max, entry.uid), -1) + 1,
    touched,
  }
}

/* --------------- 世界书条目可编辑字段表的消费面（校验 / 写映射 / 摘要） --------------- */

/** 条目可编辑字段的 JSON Schema（world_put 编辑项 / world_create 种子共用）。 */
function worldEditableProperties(): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const name of WORLD_EDITABLE_FIELDS) {
    const spec = WORLD_ENTRY_FIELDS[name]
    const hint = { description: spec.hint }
    const range = {
      ...(spec.min !== undefined ? { minimum: spec.min } : {}),
      ...(spec.max !== undefined ? { maximum: spec.max } : {}),
    }
    switch (spec.type) {
      case 'string':
        properties[name] = { type: 'string', ...hint }
        break
      case 'stringArray':
        properties[name] = { type: 'array', items: { type: 'string' }, ...hint }
        break
      case 'boolean':
        properties[name] = { type: 'boolean', ...hint }
        break
      case 'integer':
        properties[name] = { type: 'integer', ...range, ...hint }
        break
      case 'nullableBoolean':
        properties[name] = { type: ['boolean', 'null'], ...hint }
        break
      case 'nullableInteger':
        properties[name] = { type: ['integer', 'null'], ...range, ...hint }
        break
    }
  }
  return properties
}

function worldFieldValue(name: WorldEditableField, raw: unknown, label: string): unknown {
  const spec = WORLD_ENTRY_FIELDS[name]
  const at = `${name}${label}`
  switch (spec.type) {
    case 'string':
      if (typeof raw !== 'string') throw new Error(`${at} must be a string`)
      if (raw.length > (spec.maxLength ?? Number.POSITIVE_INFINITY)) {
        throw new Error(`${at} exceeds the ${spec.maxLength}-character limit (got ${raw.length})`)
      }
      return raw
    case 'stringArray':
      if (!Array.isArray(raw) || raw.length > (spec.maxItems ?? Number.POSITIVE_INFINITY) || raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw new Error(`${at} must be an array of at most ${spec.maxItems} non-empty strings`)
      }
      return raw as string[]
    case 'boolean':
      if (typeof raw !== 'boolean') throw new Error(`${at} must be a boolean`)
      return raw
    case 'integer':
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < (spec.min ?? Number.NEGATIVE_INFINITY) || raw > (spec.max ?? Number.POSITIVE_INFINITY)) {
        throw new Error(`${at} must be an integer between ${spec.min} and ${spec.max}`)
      }
      return raw
    case 'nullableBoolean':
      if (raw === null) return null
      if (typeof raw !== 'boolean') throw new Error(`${at} must be a boolean or null`)
      return raw
    case 'nullableInteger':
      if (raw === null) return null
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < (spec.min ?? Number.NEGATIVE_INFINITY) || raw > (spec.max ?? Number.POSITIVE_INFINITY)) {
        throw new Error(`${at} must be an integer between ${spec.min} and ${spec.max}, or null`)
      }
      return raw
  }
}

interface WorldEntryEdit {
  uid: number
  remove: boolean
  values: Record<string, unknown>
  fields: string[]
}

/** 世界书条目白名单校验核（world_put / world_create 共用）；label 定位出错条目。 */
function parseWorldEntryFields(entry: Record<string, unknown>, label: string): { values: Record<string, unknown>; fields: string[] } {
  const unknown = Object.keys(entry).filter((key) => !(key in WORLD_ENTRY_FIELDS))
  if (unknown.length > 0) throw new Error(`unknown entry field(s) ${unknown.join(', ')}${label}; editable fields: ${WORLD_EDITABLE_FIELD_LIST}`)
  const values: Record<string, unknown> = {}
  const fields: string[] = []
  for (const [name, raw] of Object.entries(entry)) {
    values[name] = worldFieldValue(name as WorldEditableField, raw, label)
    fields.push(name)
  }
  return { values, fields }
}

function parseWorldEdits(value: unknown): WorldEntryEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`entries must be a non-empty array of { uid, <editable fields>, remove? }`)
  if (value.length > 32) throw new Error('entries accepts at most 32 entries; split larger edits across calls')
  const seen = new Set<number>()
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('each entry must be an object of { uid, <editable fields>, remove? }')
    const { uid, remove, ...body } = entry as Record<string, unknown>
    if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error('uid must be a non-negative integer (see world_get nextUid for a free one)')
    if (seen.has(uid as number)) throw new Error(`duplicate entry for uid ${uid}`)
    seen.add(uid as number)
    const label = ` for uid ${uid}`
    if (remove !== undefined && typeof remove !== 'boolean') throw new Error(`remove${label} must be a boolean`)
    const parsed = parseWorldEntryFields(body, label)
    if (remove === true && parsed.fields.length > 0) throw new Error(`remove${label} deletes the entry and cannot be combined with other fields`)
    if (remove !== true && parsed.fields.length === 0) throw new Error(`entry${label} has no editable field; provide at least one of ${WORLD_EDITABLE_FIELD_LIST} or remove: true`)
    return { uid: uid as number, remove: remove === true, values: parsed.values, fields: parsed.fields }
  })
}

/** world_create 的种子条目：白名单与 world_put 相同，uid 由数组顺序分配（0 起）。 */
function parseWorldSeedEntries(value: unknown): Array<{ values: Record<string, unknown>; fields: string[] }> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('entries must be an array of { <editable fields> }')
  if (value.length > 32) throw new Error('entries accepts at most 32 entries; split larger creations across calls')
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('each entry must be an object of { <editable fields> }')
    const parsed = parseWorldEntryFields(entry as Record<string, unknown>, ` for entry ${index + 1}`)
    if (parsed.fields.length === 0) throw new Error(`entry ${index + 1} has no editable field; provide at least one of ${WORLD_EDITABLE_FIELD_LIST}`)
    return parsed
  })
}

/** 白名单字段值 → LoreEntry 目标键值对（enabled → disable 取反；其余按表映射）。 */
function worldFieldRawEntries(values: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(values).map(([name, value]) => {
    const spec = WORLD_ENTRY_FIELDS[name as WorldEditableField]
    return [spec.loreKey ?? name, spec.invert === true ? !(value as boolean) : value] as [string, unknown]
  })
}

/** 编辑既有条目：仅覆盖调用方给出的字段，其余（含 extra 袋）原样保留。 */
function applyWorldEntryFields(entry: LoreEntry, values: Record<string, unknown>): LoreEntry {
  const next: LoreEntry = { ...entry }
  const target = next as unknown as Record<string, unknown>
  for (const [key, value] of worldFieldRawEntries(values)) target[key] = value
  return next
}

/** 新建条目：白名单字段叠加 normalizeEntry 的 ST 缺省补全。 */
function worldEntryFromValues(uid: number, values: Record<string, unknown>): LoreEntry {
  const raw: Record<string, unknown> = { uid }
  for (const [key, value] of worldFieldRawEntries(values)) raw[key] = value
  return normalizeEntry(raw)
}

/**
 * 世界书编辑应用核（world_put 直写路径与世界书方案执行核共用）：按 uid 覆盖
 * 调用方给出的字段、未知 uid 建条目、remove 删条目；返回排序后的全量条目与
 * 触碰回执。不落盘——调用方决定 putWorld。
 */
function applyWorldEdits(
  world: string,
  book: { name: string; entries: LoreEntry[] },
  edits: WorldEntryEdit[],
): { entries: LoreEntry[]; touched: Array<{ uid: number; created: boolean; removed?: boolean; fields: string[] }> } {
  const byUid = new Map(book.entries.map((entry) => [entry.uid, entry]))
  const touched: Array<{ uid: number; created: boolean; removed?: boolean; fields: string[] }> = []
  for (const edit of edits) {
    const existing = byUid.get(edit.uid)
    if (edit.remove) {
      if (existing === undefined) throw new Error(`uid ${edit.uid} not found in world '${world}'; removal matches existing entries only (see world_get)`)
      byUid.delete(edit.uid)
      touched.push({ uid: edit.uid, created: false, removed: true, fields: [] })
      continue
    }
    if (existing === undefined) {
      // 新条目：normalizeEntry 补全 ST 条目的全部默认字段，白名单之外不动
      byUid.set(edit.uid, worldEntryFromValues(edit.uid, edit.values))
      touched.push({ uid: edit.uid, created: true, fields: edit.fields })
      continue
    }
    byUid.set(edit.uid, applyWorldEntryFields(existing, edit.values))
    touched.push({ uid: edit.uid, created: false, fields: edit.fields })
  }
  return { entries: [...byUid.values()].sort((a, b) => a.uid - b.uid), touched }
}

/** 活条目上白名单字段的现行值（可编辑形态视角：enabled 是 disable 取反；缺失去表缺省）。 */
function worldLiveValue(entry: LoreEntry, field: WorldEditableField): WorldPlanValue {
  const spec = WORLD_ENTRY_FIELDS[field]
  const record = entry as unknown as Record<string, unknown>
  const raw = record[spec.loreKey ?? field]
  if (spec.invert === true) return typeof raw === 'boolean' ? !raw : true
  if (raw === undefined) {
    if (Array.isArray(spec.fallback)) return []
    return spec.fallback ?? null
  }
  return raw as WorldPlanValue
}

/** 方案过期检测的值等价：标量严格相等，数组逐项深比（引用不等 ≠ 值不等）。 */
function worldPlanValueMatches(live: WorldPlanValue, recorded: WorldPlanValue): boolean {
  if (Array.isArray(live) || Array.isArray(recorded)) {
    if (!Array.isArray(live) || !Array.isArray(recorded)) return false
    return live.length === recorded.length && live.every((item, index) => item === recorded[index])
  }
  return live === recorded
}

/** 方案回执里的值预览：字符串截 200，数组逐项截 200，标量原样。 */
function previewWorldPlanValue(value: WorldPlanValue): WorldPlanValue {
  if (typeof value === 'string') return limitText(value, 200)
  if (Array.isArray(value)) return value.map((item) => limitText(item, 200))
  return value
}

/** 方案字段名的白名单复检（执行核用，防手改方案文件注入未建模字段）。 */
function editableWorldField(field: string): WorldEditableField {
  if (!(WORLD_EDITABLE_FIELDS as string[]).includes(field)) {
    throw new Error(`field '${field}' is not an editable world entry field; editable fields: ${WORLD_EDITABLE_FIELD_LIST}`)
  }
  return field as WorldEditableField
}

/** world_get 的 uid 过滤参数：≤32 个非负整数，去重保序。 */
function parseWorldUids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('uids must be a non-empty array of entry uids')
  if (value.length > 32) throw new Error('uids accepts at most 32 entries')
  return [...new Set(value.map((uid) => {
    if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error('each uid must be a non-negative integer')
    return uid as number
  }))]
}

/** 反查链接到某世界书的卡（extensions.world 单链接语义，读法对齐服务端 characterLinkedWorlds）。 */
async function worldLinkedCards(db: TavernStore, world: string): Promise<string[]> {
  const linked: string[] = []
  for (const characterName of await db.listCharacters()) {
    const file = await db.getCharacter(characterName)
    const bound = file?.card.data.extensions['world']
    if (typeof bound === 'string' && bound === world) linked.push(characterName)
  }
  return linked
}

/** 世界书名上限对齐 safeFileName 的 120 字符截断，避免落盘名与调用名不一致。 */
const WORLD_NAME_MAX = 120

function worldNameArg(value: unknown): string {
  if (typeof value !== 'string') throw new Error('name must be a string')
  const name = value.trim()
  if (name === '') throw new Error('name must not be blank')
  if (name.length > WORLD_NAME_MAX) throw new Error(`name exceeds the ${WORLD_NAME_MAX}-character limit (got ${name.length})`)
  return name
}

const WORLD_ENTRY_LIST_CAP = 200

/** 摘要中的常显核心字段（其余表内字段只在偏离 normalizeEntry 缺省时上报）。 */
const WORLD_CORE_SUMMARY_FIELDS = new Set(['key', 'keysecondary', 'comment', 'content', 'enabled', 'constant', 'order', 'position', 'depth'])

/**
 * 世界书摘要：按 uid 升序的条目，nextUid 供新增条目。content 默认截 500；
 * 传 selected（uid 过滤）时只列命中条目且 content 全文返回，missingUids 由
 * 调用方补报。高级字段只在偏离缺省值时出现在条目摘要里。
 */
function worldSummary(world: string, entries: LoreEntry[], selected?: number[]): Record<string, unknown> {
  const pick = selected === undefined ? undefined : new Set(selected)
  const listed = pick === undefined
    ? entries.slice(0, WORLD_ENTRY_LIST_CAP)
    : entries.filter((entry) => pick.has(entry.uid))
  return {
    found: true,
    world,
    entryCount: entries.length,
    nextUid: entries.reduce((max, entry) => Math.max(max, entry.uid), -1) + 1,
    entries: listed.map((entry) => {
      const item: Record<string, unknown> = {
        uid: entry.uid,
        key: entry.key,
        ...(entry.keysecondary.length > 0 ? { keysecondary: entry.keysecondary } : {}),
        comment: entry.comment,
        content: pick === undefined ? limitText(entry.content, 500) : entry.content,
        contentLength: entry.content.length,
        enabled: !entry.disable,
        constant: entry.constant,
        order: entry.order,
        position: entry.position,
        depth: entry.depth,
      }
      const record = entry as unknown as Record<string, unknown>
      for (const name of WORLD_EDITABLE_FIELDS) {
        if (WORLD_CORE_SUMMARY_FIELDS.has(name)) continue
        const spec = WORLD_ENTRY_FIELDS[name]
        const value = record[spec.loreKey ?? name]
        // 数组缺省按空数组语义比较（表里的 fallback 数组是另一份引用）
        const isDefault = Array.isArray(spec.fallback)
          ? Array.isArray(value) && value.length === 0
          : value === spec.fallback
        if (value === undefined || isDefault) continue
        item[name] = value
      }
      return item
    }),
    truncated: pick === undefined && entries.length > WORLD_ENTRY_LIST_CAP,
  }
}
