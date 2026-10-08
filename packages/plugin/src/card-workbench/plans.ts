/**
 * Card Workbench 方案存储（提案 0013 §2，P2：确认协议；世界书面板化为同构
 * 扩展，见 decisions/2026-10-08-worldbook-plan-protocol.md）。
 *
 * 写入工具必须携带 planId：修改方案先经 card_plan_propose / world_plan_propose
 * 落库为 pending，用户在面板（GET card-workbench/plans + POST decision）或对话里
 * 确认后，card_put(planId) / world_put(planId) / world_create(planId) 才生效。
 * 存储层只管方案生命周期，不管执行——执行核在 card-workbench/agent.ts
 * （executeCardPlan / executeWorldPlan），成功后回写 applied。
 *
 * ```text
 * tavern/
 * └── card-workbench/
 *     └── plans/<planId>.json   # 一个方案一个文件（原子写，人可读可 diff）
 * ```
 *
 * 方案按 kind 判别联合：卡方案（kind: 'card'，按卡字段建模）与世界书方案
 * （kind: 'world'，按条目动作建模）。存量卡方案文件没有 kind 字段，读取边界
 * 归一化为 'card'。写纪律对齐 tavern-store/originals.ts：tmp+rename 原子，
 * tmp 名带 pid+随机后缀防并发踩踏；一个方案一个文件使决定/应用状态推进
 * 天然无读-改-写竞争。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type CardPlanStatus = 'pending' | 'approved' | 'rejected' | 'applied'

/** 卡方案字段值：文本字段为字符串；tags/alternateGreetings 整组替换为字符串数组。 */
export type CardPlanValue = string | string[]

export interface CardPlanChange {
  /** 卡字段名（白名单校验在 agent 工具层，存储层只保证值形状） */
  field: string
  /** 方案提出时的现行值（agent 工具层从活卡快照，执行前用作过期检测） */
  currentValue: CardPlanValue
  newValue: CardPlanValue
  /** 给用户看的变更理由（可选） */
  note?: string
}

export interface CardPlan {
  kind: 'card'
  id: string
  character: string
  title: string
  changes: CardPlanChange[]
  createdAt: string
  status: CardPlanStatus
  decidedAt?: string
  appliedAt?: string
}

/** 世界书方案字段值：条目白名单六类字段的原生 JSON 形态（含可空 null）。 */
export type WorldPlanValue = string | number | boolean | string[] | null

export interface WorldPlanFieldChange {
  /** 世界书条目字段名（白名单校验在 agent 工具层，存储层只保证值形状） */
  field: string
  /** 方案提出时的现行值；新建条目无现行值（省略），执行前用作过期检测 */
  currentValue?: WorldPlanValue
  newValue: WorldPlanValue
}

export interface WorldPlanEntryChange {
  uid: number
  action: 'update' | 'create' | 'remove'
  /** remove 动作为空数组；update/create 至少一个字段 */
  fields: WorldPlanFieldChange[]
  /** 给用户看的变更理由（可选） */
  note?: string
}

export interface WorldPlan {
  kind: 'world'
  id: string
  /** edit 修改既有书；create 建新书（执行时书名必须仍空闲） */
  op: 'edit' | 'create'
  world: string
  title: string
  entries: WorldPlanEntryChange[]
  createdAt: string
  status: CardPlanStatus
  decidedAt?: string
  appliedAt?: string
}

export type WorkbenchPlan = CardPlan | WorldPlan

/** 与 card_put / world_put 的单次写入面一致（提案 0013 P1 / 世界书工具面）。 */
const MAX_PLAN_CHANGES = 16
const MAX_PLAN_ENTRIES = 32
const MAX_ENTRY_FIELDS = 64
/** 单字段值上限取白名单最大档（description/content 32000），存储层不重复分档逻辑。 */
const MAX_VALUE_LENGTH = 32000
const MAX_TITLE_LENGTH = 200
const MAX_NOTE_LENGTH = 500
const MAX_WORLD_NAME_LENGTH = 200
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function plansDir(dir: string): string {
  return path.join(dir, 'card-workbench', 'plans')
}

function planFile(dir: string, planId: string): string {
  return path.join(plansDir(dir), `${planId}.json`)
}

/** tmp+rename 原子写；tmp 名带 pid+随机后缀，并发写互不踩踏（对齐 originals.ts）。 */
async function writeAtomicText(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

function newPlanId(): string {
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/* ------------------------------- 卡方案解析 ------------------------------- */

function normalizeCardPlan(raw: Record<string, unknown>): CardPlan | undefined {
  if (typeof raw.character !== 'string' || typeof raw.title !== 'string'
    || !Array.isArray(raw.changes) || typeof raw.createdAt !== 'string') return undefined
  const changes: CardPlanChange[] = []
  for (const entry of raw.changes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const change = entry as Record<string, unknown>
    if (typeof change.field !== 'string' || !isValidCardPlanValue(change.currentValue) || !isValidCardPlanValue(change.newValue)) return undefined
    if (change.note !== undefined && typeof change.note !== 'string') return undefined
    changes.push(change.note === undefined
      ? { field: change.field, currentValue: change.currentValue, newValue: change.newValue }
      : { field: change.field, currentValue: change.currentValue, newValue: change.newValue, note: change.note })
  }
  return {
    kind: 'card',
    id: raw.id as string,
    character: raw.character,
    title: raw.title,
    changes,
    createdAt: raw.createdAt,
    status: raw.status as CardPlanStatus,
    ...(typeof raw.decidedAt === 'string' ? { decidedAt: raw.decidedAt } : {}),
    ...(typeof raw.appliedAt === 'string' ? { appliedAt: raw.appliedAt } : {}),
  }
}

/** 值形状：字符串或字符串数组（数组项限字符串，项数上限防异常膨胀）。 */
function isValidCardPlanValue(value: unknown): value is CardPlanValue {
  if (typeof value === 'string') return true
  if (!Array.isArray(value) || value.length > 64) return false
  return value.every((item) => typeof item === 'string')
}

/** 值体量：字符串取长度；数组取 join 后长度（存储层只防异常膨胀，分档在工具层）。 */
function cardPlanValueLength(value: CardPlanValue): number {
  return typeof value === 'string' ? value.length : value.join('\n').length
}

function validateCardChangeShape(entry: unknown, index: number): CardPlanChange {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`changes[${index}] must be an object of { field, currentValue, newValue, note? }`)
  }
  const { field, currentValue, newValue, note } = entry as Record<string, unknown>
  if (typeof field !== 'string' || field.trim() === '') throw new Error(`changes[${index}].field must be a non-empty string`)
  if (!isValidCardPlanValue(currentValue)) throw new Error(`changes[${index}].currentValue for field '${field}' must be a string or string array`)
  if (!isValidCardPlanValue(newValue)) throw new Error(`changes[${index}].newValue for field '${field}' must be a string or string array`)
  if (cardPlanValueLength(currentValue) > MAX_VALUE_LENGTH) throw new Error(`changes[${index}].currentValue for field '${field}' exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  if (cardPlanValueLength(newValue) > MAX_VALUE_LENGTH) throw new Error(`changes[${index}].newValue for field '${field}' exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw new Error(`changes[${index}].note must be a string of at most ${MAX_NOTE_LENGTH} characters`)
  }
  return note === undefined ? { field, currentValue, newValue } : { field, currentValue, newValue, note }
}

/* ----------------------------- 世界书方案解析 ----------------------------- */

function isValidWorldPlanValue(value: unknown): value is WorldPlanValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (!Array.isArray(value) || value.length > 64) return false
  return value.every((item) => typeof item === 'string')
}

function worldPlanValueLength(value: WorldPlanValue): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.join('\n').length
  return 0
}

function validateWorldFieldShape(entry: unknown, label: string): WorldPlanFieldChange {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`fields${label} entries must be objects of { field, currentValue?, newValue }`)
  }
  const { field, currentValue, newValue } = entry as Record<string, unknown>
  if (typeof field !== 'string' || field.trim() === '') throw new Error(`field${label} must be a non-empty string`)
  if (currentValue !== undefined && !isValidWorldPlanValue(currentValue)) {
    throw new Error(`currentValue${label} must be a string, number, boolean, null or string array`)
  }
  if (!isValidWorldPlanValue(newValue)) {
    throw new Error(`newValue${label} must be a string, number, boolean, null or string array`)
  }
  if (currentValue !== undefined && worldPlanValueLength(currentValue) > MAX_VALUE_LENGTH) {
    throw new Error(`currentValue${label} exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  }
  if (worldPlanValueLength(newValue) > MAX_VALUE_LENGTH) {
    throw new Error(`newValue${label} exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  }
  return currentValue === undefined ? { field, newValue } : { field, currentValue, newValue }
}

function validateWorldEntryShape(entry: unknown, index: number): WorldPlanEntryChange {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`entries[${index}] must be an object of { uid, action, fields, note? }`)
  }
  const { uid, action, fields, note } = entry as Record<string, unknown>
  if (!Number.isInteger(uid) || (uid as number) < 0) throw new Error(`entries[${index}].uid must be a non-negative integer`)
  if (action !== 'update' && action !== 'create' && action !== 'remove') {
    throw new Error(`entries[${index}].action must be 'update', 'create' or 'remove'`)
  }
  if (!Array.isArray(fields)) throw new Error(`entries[${index}].fields must be an array`)
  if (fields.length > MAX_ENTRY_FIELDS) throw new Error(`entries[${index}].fields accepts at most ${MAX_ENTRY_FIELDS} entries`)
  const label = ` for uid ${uid}`
  const parsedFields = fields.map((field, fieldIndex) => validateWorldFieldShape(field, `${label} [${fieldIndex}]`))
  if (action === 'remove' && parsedFields.length > 0) throw new Error(`entries[${index}].fields must be empty when action is 'remove'`)
  if (action !== 'remove' && parsedFields.length === 0) throw new Error(`entries[${index}].fields must have at least one entry when action is '${action}'`)
  const fieldNames = new Set(parsedFields.map((field) => field.field))
  if (fieldNames.size !== parsedFields.length) throw new Error(`duplicate field in entries[${index}]`)
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw new Error(`entries[${index}].note must be a string of at most ${MAX_NOTE_LENGTH} characters`)
  }
  const base = { uid: uid as number, action, fields: parsedFields }
  return note === undefined ? base : { ...base, note }
}

function normalizeWorldPlan(raw: Record<string, unknown>): WorldPlan | undefined {
  if (raw.op !== 'edit' && raw.op !== 'create') return undefined
  if (typeof raw.world !== 'string' || typeof raw.title !== 'string'
    || !Array.isArray(raw.entries) || typeof raw.createdAt !== 'string') return undefined
  const entries: WorldPlanEntryChange[] = []
  for (const entry of raw.entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    if (!Number.isInteger(record.uid) || record.uid === null || (record.uid as number) < 0) return undefined
    if (record.action !== 'update' && record.action !== 'create' && record.action !== 'remove') return undefined
    if (!Array.isArray(record.fields)) return undefined
    const fields: WorldPlanFieldChange[] = []
    for (const fieldEntry of record.fields) {
      if (typeof fieldEntry !== 'object' || fieldEntry === null || Array.isArray(fieldEntry)) return undefined
      const field = fieldEntry as Record<string, unknown>
      if (typeof field.field !== 'string' || !isValidWorldPlanValue(field.newValue)) return undefined
      if (field.currentValue !== undefined && !isValidWorldPlanValue(field.currentValue)) return undefined
      fields.push(field.currentValue === undefined ? { field: field.field, newValue: field.newValue } : { field: field.field, currentValue: field.currentValue, newValue: field.newValue })
    }
    entries.push(record.note === undefined
      ? { uid: record.uid as number, action: record.action, fields }
      : { uid: record.uid as number, action: record.action, fields, note: record.note })
  }
  return {
    kind: 'world',
    id: raw.id as string,
    op: raw.op,
    world: raw.world,
    title: raw.title,
    entries,
    createdAt: raw.createdAt,
    status: raw.status as CardPlanStatus,
    ...(typeof raw.decidedAt === 'string' ? { decidedAt: raw.decidedAt } : {}),
    ...(typeof raw.appliedAt === 'string' ? { appliedAt: raw.appliedAt } : {}),
  }
}

/** 读取边界归一化：按 kind 判别（存量卡方案无 kind，默认 'card'）；损坏返回 undefined。 */
function normalizePlan(raw: unknown): WorkbenchPlan | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string') return undefined
  const status = record.status
  if (status !== 'pending' && status !== 'approved' && status !== 'rejected' && status !== 'applied') return undefined
  if (record.kind === 'world') return normalizeWorldPlan({ ...record, status })
  return normalizeCardPlan({ ...record, status })
}

/* ------------------------------- 生命周期 API ------------------------------- */

/**
 * 落库一个 pending 卡方案并返回完整方案（含新 planId）。
 * currentValue 由调用方（agent 工具层）从活卡快照，保证 diff 面向用户 truthful。
 */
export async function proposeCardPlan(
  dir: string,
  character: string,
  input: { title: string; changes: Array<{ field: string; currentValue: CardPlanValue; newValue: CardPlanValue; note?: string }> },
): Promise<CardPlan> {
  if (typeof character !== 'string' || character.trim() === '') throw new Error('character must be a non-empty string')
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`)
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) throw new Error('changes must be a non-empty array')
  if (input.changes.length > MAX_PLAN_CHANGES) throw new Error(`changes accepts at most ${MAX_PLAN_CHANGES} entries; split larger plans`)
  const changes = input.changes.map((entry, index) => validateCardChangeShape(entry, index))
  const fields = new Set(changes.map((change) => change.field))
  if (fields.size !== changes.length) throw new Error('duplicate change field in plan')
  const plan: CardPlan = {
    kind: 'card',
    id: newPlanId(),
    character,
    title: input.title,
    changes,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  await fs.mkdir(plansDir(dir), { recursive: true })
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(plan, null, 2)}\n`)
  return plan
}

/**
 * 落库一个 pending 世界书方案并返回完整方案（含新 planId）。
 * currentValue 由调用方（agent 工具层）从活书快照；create 动作无 currentValue。
 */
export async function proposeWorldPlan(
  dir: string,
  world: string,
  input: { op: 'edit' | 'create'; title: string; entries: Array<{ uid: number; action: 'update' | 'create' | 'remove'; fields: Array<{ field: string; currentValue?: WorldPlanValue; newValue: WorldPlanValue }>; note?: string }> },
): Promise<WorldPlan> {
  if (typeof world !== 'string' || world.trim() === '') throw new Error('world must be a non-empty string')
  if (world.length > MAX_WORLD_NAME_LENGTH) throw new Error(`world exceeds the ${MAX_WORLD_NAME_LENGTH}-character limit`)
  if (input.op !== 'edit' && input.op !== 'create') throw new Error(`op must be 'edit' or 'create'`)
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`)
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw new Error('entries must be a non-empty array')
  if (input.entries.length > MAX_PLAN_ENTRIES) throw new Error(`entries accepts at most ${MAX_PLAN_ENTRIES} entries; split larger plans`)
  if (input.op === 'create' && input.entries.some((entry) => entry.action !== 'create')) {
    throw new Error("a 'create' plan takes only 'create' entries")
  }
  const entries = input.entries.map((entry, index) => validateWorldEntryShape(entry, index))
  const uids = new Set(entries.map((entry) => entry.uid))
  if (uids.size !== entries.length) throw new Error('duplicate uid in plan')
  const plan: WorldPlan = {
    kind: 'world',
    id: newPlanId(),
    op: input.op,
    world,
    title: input.title,
    entries,
    createdAt: new Date().toISOString(),
    status: 'pending',
  }
  await fs.mkdir(plansDir(dir), { recursive: true })
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(plan, null, 2)}\n`)
  return plan
}

/** 读单个方案；planId 非法或文件不存在/损坏返回 undefined（损坏文件不拖垮列表）。 */
export async function getPlan(dir: string, planId: string): Promise<WorkbenchPlan | undefined> {
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) return undefined
  let text: string
  try {
    text = (await fs.readFile(planFile(dir, planId))).toString('utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  return normalizePlan(JSON.parse(text))
}

/**
 * 列方案（卡与世界书同列，createdAt 降序——面板先见最新）；可按 kind、
 * 角色/世界书与状态过滤；character 过滤对世界书方案恒不命中。损坏文件跳过。
 */
export async function listPlans(
  dir: string,
  filter: { kind?: 'card' | 'world'; character?: string; world?: string; status?: CardPlanStatus | 'all' } = {},
): Promise<WorkbenchPlan[]> {
  let files: string[]
  try {
    files = await fs.readdir(plansDir(dir))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const plans: WorkbenchPlan[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const plan = normalizePlan(JSON.parse((await fs.readFile(path.join(plansDir(dir), file))).toString('utf8')))
      if (plan !== undefined) plans.push(plan)
    } catch {
      // 单个损坏方案不拖垮列表；面板仍能显示其余方案
    }
  }
  const wanted = filter.status !== undefined && filter.status !== 'all' ? filter.status : undefined
  return plans
    .filter((plan) => (wanted === undefined || plan.status === wanted)
      && (filter.kind === undefined || plan.kind === filter.kind)
      && (filter.character === undefined
        || (plan.kind === 'card' && plan.character === filter.character))
      && (filter.world === undefined
        || (plan.kind === 'world' && plan.world === filter.world)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

/**
 * 面板决定：pending → approved/rejected + decidedAt。执行不在存储层——
 * approved 只在「先批后执行」的编排里短暂存在，执行核成功后立即转 applied。
 */
export async function decidePlan(dir: string, planId: string, approve: boolean): Promise<WorkbenchPlan> {
  const plan = await getPlan(dir, planId)
  if (plan === undefined) throw new Error(`plan '${planId}' not found`)
  if (plan.status !== 'pending') throw new Error(`plan '${planId}' is already ${plan.status}`)
  const decided: WorkbenchPlan = { ...plan, status: approve ? 'approved' : 'rejected', decidedAt: new Date().toISOString() }
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(decided, null, 2)}\n`)
  return decided
}

/**
 * 标记已执行（执行成功后由执行核调用）。pending（对话内确认）与 approved
 * （面板先批）都可转 applied；rejected 不可复活，applied 不可重复。
 */
export async function applyPlan(dir: string, planId: string): Promise<WorkbenchPlan> {
  const plan = await getPlan(dir, planId)
  if (plan === undefined) throw new Error(`plan '${planId}' not found`)
  if (plan.status === 'rejected') throw new Error(`plan '${planId}' was rejected and cannot be applied`)
  if (plan.status === 'applied') throw new Error(`plan '${planId}' was already applied`)
  const applied: WorkbenchPlan = { ...plan, status: 'applied', appliedAt: new Date().toISOString() }
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(applied, null, 2)}\n`)
  return applied
}
