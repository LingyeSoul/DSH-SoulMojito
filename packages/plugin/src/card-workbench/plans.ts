/**
 * Card Workbench 方案存储（提案 0013 §2，P2：确认协议）。
 *
 * 写入工具必须携带 planId：修改方案先经 card_plan_propose 落库为 pending，
 * 用户在面板（GET card-workbench/plans + POST decision）或对话里确认后，
 * card_put(planId) 才逐字段生效。存储层只管方案生命周期，不管执行——
 * 执行核在 card-workbench/agent.ts（executeCardPlan），成功后回写 applied。
 *
 * ```text
 * tavern/
 * └── card-workbench/
 *     └── plans/<planId>.json   # 一个方案一个文件（原子写，人可读可 diff）
 * ```
 *
 * 写纪律对齐 tavern-store/originals.ts：tmp+rename 原子，tmp 名带 pid+随机
 * 后缀防并发踩踏；一个方案一个文件使决定/应用状态推进天然无读-改-写竞争。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type CardPlanStatus = 'pending' | 'approved' | 'rejected' | 'applied'

export interface CardPlanChange {
  /** 卡字段名（白名单校验在 agent 工具层，存储层只保证非空字符串） */
  field: string
  /** 方案提出时的现行值（agent 工具层从活卡快照，执行前用作过期检测） */
  currentValue: string
  newValue: string
  /** 给用户看的变更理由（可选） */
  note?: string
}

export interface CardPlan {
  id: string
  character: string
  title: string
  changes: CardPlanChange[]
  createdAt: string
  status: CardPlanStatus
  decidedAt?: string
  appliedAt?: string
}

/** 与 card_put 的单次写入面一致（提案 0013 P1 的 16 条上限）。 */
const MAX_PLAN_CHANGES = 16
/** 单字段值上限取白名单最大档（description 32000），存储层不重复分档逻辑。 */
const MAX_VALUE_LENGTH = 32000
const MAX_TITLE_LENGTH = 200
const MAX_NOTE_LENGTH = 500
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

function normalizePlan(raw: unknown): CardPlan | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.character !== 'string' || typeof record.title !== 'string'
    || !Array.isArray(record.changes) || typeof record.createdAt !== 'string') return undefined
  const status = record.status
  if (status !== 'pending' && status !== 'approved' && status !== 'rejected' && status !== 'applied') return undefined
  const changes: CardPlanChange[] = []
  for (const entry of record.changes) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const change = entry as Record<string, unknown>
    if (typeof change.field !== 'string' || typeof change.currentValue !== 'string' || typeof change.newValue !== 'string') return undefined
    if (change.note !== undefined && typeof change.note !== 'string') return undefined
    changes.push(change.note === undefined
      ? { field: change.field, currentValue: change.currentValue, newValue: change.newValue }
      : { field: change.field, currentValue: change.currentValue, newValue: change.newValue, note: change.note })
  }
  return {
    id: record.id,
    character: record.character,
    title: record.title,
    changes,
    createdAt: record.createdAt,
    status,
    ...(typeof record.decidedAt === 'string' ? { decidedAt: record.decidedAt } : {}),
    ...(typeof record.appliedAt === 'string' ? { appliedAt: record.appliedAt } : {}),
  }
}

function validateChangeShape(entry: unknown, index: number): CardPlanChange {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`changes[${index}] must be an object of { field, currentValue, newValue, note? }`)
  }
  const { field, currentValue, newValue, note } = entry as Record<string, unknown>
  if (typeof field !== 'string' || field.trim() === '') throw new Error(`changes[${index}].field must be a non-empty string`)
  if (typeof currentValue !== 'string') throw new Error(`changes[${index}].currentValue for field '${field}' must be a string`)
  if (typeof newValue !== 'string') throw new Error(`changes[${index}].newValue for field '${field}' must be a string`)
  if (currentValue.length > MAX_VALUE_LENGTH) throw new Error(`changes[${index}].currentValue for field '${field}' exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  if (newValue.length > MAX_VALUE_LENGTH) throw new Error(`changes[${index}].newValue for field '${field}' exceeds the ${MAX_VALUE_LENGTH}-character limit`)
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw new Error(`changes[${index}].note must be a string of at most ${MAX_NOTE_LENGTH} characters`)
  }
  return note === undefined ? { field, currentValue, newValue } : { field, currentValue, newValue, note }
}

/**
 * 落库一个 pending 方案并返回完整方案（含新 planId）。
 * currentValue 由调用方（agent 工具层）从活卡快照，保证 diff 面向用户 truthful。
 */
export async function proposeCardPlan(
  dir: string,
  character: string,
  input: { title: string; changes: Array<{ field: string; currentValue: string; newValue: string; note?: string }> },
): Promise<CardPlan> {
  if (typeof character !== 'string' || character.trim() === '') throw new Error('character must be a non-empty string')
  if (typeof input.title !== 'string' || input.title.trim() === '' || input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title must be a non-empty string of at most ${MAX_TITLE_LENGTH} characters`)
  }
  if (!Array.isArray(input.changes) || input.changes.length === 0) throw new Error('changes must be a non-empty array')
  if (input.changes.length > MAX_PLAN_CHANGES) throw new Error(`changes accepts at most ${MAX_PLAN_CHANGES} entries; split larger plans`)
  const changes = input.changes.map((entry, index) => validateChangeShape(entry, index))
  const fields = new Set(changes.map((change) => change.field))
  if (fields.size !== changes.length) throw new Error('duplicate change field in plan')
  const plan: CardPlan = {
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

/** 读单个方案；planId 非法或文件不存在/损坏返回 undefined（损坏文件不拖垮列表）。 */
export async function getCardPlan(dir: string, planId: string): Promise<CardPlan | undefined> {
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

/** 列方案；可按角色与状态过滤，createdAt 降序（面板先见最新）。损坏文件跳过。 */
export async function listCardPlans(
  dir: string,
  filter: { character?: string; status?: CardPlanStatus | 'all' } = {},
): Promise<CardPlan[]> {
  let files: string[]
  try {
    files = await fs.readdir(plansDir(dir))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
  const plans: CardPlan[] = []
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
      && (filter.character === undefined || plan.character === filter.character))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
}

/**
 * 面板决定：pending → approved/rejected + decidedAt。执行不在存储层——
 * approved 只在「先批后执行」的编排里短暂存在，执行核成功后立即转 applied。
 */
export async function decideCardPlan(dir: string, planId: string, approve: boolean): Promise<CardPlan> {
  const plan = await getCardPlan(dir, planId)
  if (plan === undefined) throw new Error(`plan '${planId}' not found`)
  if (plan.status !== 'pending') throw new Error(`plan '${planId}' is already ${plan.status}`)
  const decided: CardPlan = { ...plan, status: approve ? 'approved' : 'rejected', decidedAt: new Date().toISOString() }
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(decided, null, 2)}\n`)
  return decided
}

/**
 * 标记已执行（执行成功后由执行核调用）。pending（对话内确认）与 approved
 * （面板先批）都可转 applied；rejected 不可复活，applied 不可重复。
 */
export async function applyCardPlan(dir: string, planId: string): Promise<CardPlan> {
  const plan = await getCardPlan(dir, planId)
  if (plan === undefined) throw new Error(`plan '${planId}' not found`)
  if (plan.status === 'rejected') throw new Error(`plan '${planId}' was rejected and cannot be applied`)
  if (plan.status === 'applied') throw new Error(`plan '${planId}' was already applied`)
  const applied: CardPlan = { ...plan, status: 'applied', appliedAt: new Date().toISOString() }
  await writeAtomicText(planFile(dir, plan.id), `${JSON.stringify(applied, null, 2)}\n`)
  return applied
}
