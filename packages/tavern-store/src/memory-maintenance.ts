/**
 * 记忆维护状态 sidecar（B-3 记忆维护 Agent，LWB maintenance 收据体系的 dsh 化，
 * 仅取机制语义不抄代码）。
 *
 * 每 (character, chatId) scope 一份状态文件
 * `<tavern>/memory-maintenance/<encodedCharacter>/<encodedChatId>.json`：
 * - `receipts`：完成收据——某次维护 run 声明完成范围 [baseFloor, headFloor] 时，
 *   记下该楼面范围的原文指纹（floorSig）与当时 chat 作用域全部记忆记录的
 *   revision 快照（recordSnapshots）。下次 run 开始时重算两者：楼面原文被
 *   编辑/删除 ⇒ 指纹不符 ⇒ 退役；覆盖记录被后续写入改动（revision 不符或
 *   消失）⇒ 退役。待维护范围 = 全楼面 − 有效收据并集（新楼面天然无收据）。
 * - `lastRun`：最近一次 run 的真实收尾（running/done/error + 细粒度 outcome）。
 *   run 开始即落 running，进程重启后没有人会把它改成完成——读取侧发现
 *   "running 但无在跑注册" 时就地改标 error(interrupted)，不假装完成。
 *
 * 与 MemoryVectorStore 同款纪律：这是可重建的进度元数据而非权威数据（聊天
 * 与记忆本体分别在 chats/ 与 memories/），文件损坏按空状态处理——最坏代价是
 * 全楼面重新待维护一遍，不抛错阻断调用方。写入原子（fs-atomic.ts）。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { writeAtomicText } from './fs-atomic.js'

/** 完成收据：一次 CompleteMaintenance 的范围 + 退役判定依据。 */
export interface MaintenanceReceipt {
  runId: string
  baseFloor: number
  headFloor: number
  at: string
  /** 完成时该楼面范围内消息的身份指纹（编辑/删除/插入 ⇒ 不符 ⇒ 退役）。 */
  floorSig: string
  /** 完成时 chat 作用域全部活跃记录的 revision 快照（id → revision）。 */
  recordSnapshots: Record<string, string>
}

export type MaintenanceRunStatus = 'running' | 'done' | 'error'

/** run 的细粒度真实收尾（status 三态之外的事实，进 lastRun 与 summary）。 */
export type MaintenanceRunOutcome = 'completed' | 'budget-exhausted' | 'error' | 'interrupted'

export interface MaintenanceFloorRange {
  baseFloor: number
  headFloor: number
}

export interface MaintenanceRunSummary {
  /** run 的细粒度收尾（status 三态之外的事实；预算耗尽是纪律内收尾不是 error）。 */
  outcome?: MaintenanceRunOutcome
  /** run 开始时的总楼数。 */
  totalFloors: number
  /** run 开始时的待维护范围（退役后计算）。 */
  pendingRanges: MaintenanceFloorRange[]
  /** 待维护楼数（区间长度和）。 */
  pendingFloors: number
  editGroups: number
  merged: number
  corrected: number
  created: number
  deleted: number
  failedGroups: number
  /** 本次 run 开始时退役的收据数与原因（进 summary，如实报告）。 */
  retiredReceipts: number
  retiredReasons: string[]
  /** CompleteMaintenance 声明的范围（未声明则缺省）。 */
  completion?: MaintenanceFloorRange
  /** LLM 请求计数（失败也计入）与本次预算。 */
  llmRequests?: number
  budget?: number
  /** 模型最终汇报（有界）。 */
  report?: string
  error?: string
}

export interface MaintenanceRunRecord {
  runId: string
  status: MaintenanceRunStatus
  outcome?: MaintenanceRunOutcome
  startedAt: string
  finishedAt?: string
  summary: MaintenanceRunSummary
}

export interface MaintenanceStateFile {
  version: 1
  receipts: MaintenanceReceipt[]
  lastRun?: MaintenanceRunRecord
}

/** 楼面消息的最小结构面（ChatMessage 的子集，避免反向依赖 tavern-format）。 */
export interface MaintenanceFloorMessage {
  name: string
  is_user: boolean
  is_system: boolean
  mes: string
}

const MAX_RECEIPTS = 128

/**
 * 楼面指纹：[baseFloor, headFloor]（闭区间）内消息 (name, is_user, is_system,
 * mes) 序列的 SHA-256。楼层超界返回 undefined（消息被删 ⇒ 范围不再完整 ⇒ 退役）。
 * 只追加尾部楼层不影响既有区间指纹。
 */
export function floorSignature(
  messages: readonly MaintenanceFloorMessage[],
  baseFloor: number,
  headFloor: number,
): string | undefined {
  if (!Number.isInteger(baseFloor) || !Number.isInteger(headFloor)
    || baseFloor < 0 || headFloor < baseFloor || headFloor >= messages.length) return undefined
  const identity = messages.slice(baseFloor, headFloor + 1)
    .map((message) => [message.name, message.is_user === true, message.is_system === true, message.mes])
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** 区间并集（按 baseFloor 排序合并重叠/相邻）。 */
export function unionRanges(ranges: readonly MaintenanceFloorRange[]): MaintenanceFloorRange[] {
  const sorted = ranges.filter((range) => range.headFloor >= range.baseFloor)
    .map((range) => ({ baseFloor: range.baseFloor, headFloor: range.headFloor }))
    .sort((left, right) => left.baseFloor - right.baseFloor)
  const merged: MaintenanceFloorRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && range.baseFloor <= last.headFloor + 1) {
      last.headFloor = Math.max(last.headFloor, range.headFloor)
      continue
    }
    merged.push(range)
  }
  return merged
}

/**
 * 待维护范围 = [0, totalFloors-1] − covered 并集。totalFloors 为 0 时返回空
 * （空聊天无可维护原文，但仍可能有记忆记录——run 允许零楼面范围）。
 */
export function pendingRanges(totalFloors: number, covered: readonly MaintenanceFloorRange[]): MaintenanceFloorRange[] {
  if (!Number.isInteger(totalFloors) || totalFloors <= 0) return []
  const pending: MaintenanceFloorRange[] = []
  let cursor = 0
  for (const range of unionRanges(covered)) {
    if (range.baseFloor > cursor) pending.push({ baseFloor: cursor, headFloor: Math.min(range.baseFloor - 1, totalFloors - 1) })
    cursor = Math.max(cursor, range.headFloor + 1)
    if (cursor >= totalFloors) return pending
  }
  if (cursor < totalFloors) pending.push({ baseFloor: cursor, headFloor: totalFloors - 1 })
  return pending
}

/** 追加收据并裁剪：与新区间完全重叠（被包含）的旧收据让位，总量封顶防无界增长。 */
export function appendReceipt(receipts: readonly MaintenanceReceipt[], receipt: MaintenanceReceipt): MaintenanceReceipt[] {
  const next = receipts.filter((existing) =>
    !(existing.baseFloor >= receipt.baseFloor && existing.headFloor <= receipt.headFloor))
  next.push(receipt)
  if (next.length > MAX_RECEIPTS) {
    // 最老的最先淘汰（按完成时间）；淘汰只是丢了"已完成"标记，对应范围下轮重新待维护。
    next.sort((left, right) => left.at.localeCompare(right.at) || left.runId.localeCompare(right.runId))
    return next.slice(next.length - MAX_RECEIPTS)
  }
  return next
}

export class MemoryMaintenanceStore {
  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<MemoryMaintenanceStore> {
    await fs.mkdir(path.join(root, 'memory-maintenance'), { recursive: true })
    return new MemoryMaintenanceStore(root)
  }

  /** 损坏/缺失按空状态处理（可重建的进度元数据，见文件头）。 */
  async read(character: string, chatId: string): Promise<MaintenanceStateFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file(character, chatId), 'utf8')) as MaintenanceStateFile
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState()
      return {
        version: 1,
        receipts: Array.isArray(parsed.receipts) ? parsed.receipts.filter(isReceipt) : [],
        ...(isRunRecord(parsed.lastRun) ? { lastRun: parsed.lastRun } : {}),
      }
    } catch {
      return emptyState()
    }
  }

  async write(character: string, chatId: string, state: MaintenanceStateFile): Promise<void> {
    const file = this.file(character, chatId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomicText(file, `${JSON.stringify(state)}\n`)
  }

  private file(character: string, chatId: string): string {
    return path.join(this.root, 'memory-maintenance', safeSegment(character), `${safeSegment(chatId)}.json`)
  }
}

function emptyState(): MaintenanceStateFile {
  return { version: 1, receipts: [] }
}

function isReceipt(value: unknown): value is MaintenanceReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string' && record.runId !== ''
    && Number.isInteger(record.baseFloor) && Number.isInteger(record.headFloor)
    && typeof record.at === 'string' && typeof record.floorSig === 'string' && record.floorSig !== ''
    && typeof record.recordSnapshots === 'object' && record.recordSnapshots !== null
    && !Array.isArray(record.recordSnapshots)
    && Object.values(record.recordSnapshots).every((revision) => typeof revision === 'string')
}

function isRunRecord(value: unknown): value is MaintenanceRunRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.runId === 'string' && record.runId !== ''
    && (record.status === 'running' || record.status === 'done' || record.status === 'error')
    && typeof record.startedAt === 'string'
    && typeof record.summary === 'object' && record.summary !== null && !Array.isArray(record.summary)
}

/** 与 memory.ts 同款路径段规则（encodeURIComponent 后作文件/目录名）。 */
function safeSegment(value: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error('invalid memory maintenance path segment')
  }
  return encodeURIComponent(value)
}
