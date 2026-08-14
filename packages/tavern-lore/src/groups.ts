/**
 * Inclusion Groups，语义对照 ST world-info.js `filterByInclusionGroups` /
 * `filterGroupsByTimedEffects` / `filterGroupsByScoring`：
 * - 同组（group 字符串，逗号分隔可多组）只插一条；
 * - 组内有 sticky 条目 → 非 sticky 全部落选；cooldown/delay 条目落选；
 * - 组计分模式（全局 useGroupScoring 或组内任一条目开启）：按主/副键命中数留最高分；
 * - 组内已有条目激活 → 本轮该组候选全部落选；
 * - groupOverride 按 order 降序取第一；否则按 groupWeight 加权随机。
 */

import type { ScanEntry } from './entry.js'
import type { ScanState } from './buffer.js'
import type { ScanBuffer } from './buffer.js'
import type { TimedEffects } from './timed.js'
import type { SkipReason } from './types.js'
import { DEFAULT_WEIGHT } from './entry.js'

export interface GroupFilterContext {
  buffer: ScanBuffer
  scanState: ScanState
  timed: TimedEffects
  /** 已激活条目（跨轮累计） */
  activated: Map<string, ScanEntry>
  /** 候选激活序（首轮排序后） */
  rng: () => number
  useGroupScoring: boolean
  onRemove: (entry: ScanEntry, reason: SkipReason) => void
}

export function filterByInclusionGroups(
  newEntries: ScanEntry[],
  ctx: GroupFilterContext,
): void {
  // group 字符串可逗号分隔属多组（verified vs filterByInclusionGroups 的 split(/,\s*/)）
  const grouped: Record<string, ScanEntry[]> = {}
  for (const item of newEntries) {
    if (!item.group) continue
    for (const name of item.group.split(/,\s*/)) {
      if (!name) continue
      ;(grouped[name] ??= []).push(item)
    }
  }
  if (Object.keys(grouped).length === 0) return

  const hasStickyMap = filterGroupsByTimedEffects(grouped, ctx)
  filterGroupsByScoring(grouped, hasStickyMap, ctx)

  for (const [key, group] of Object.entries(grouped)) {
    // 组内有 sticky：上面已清场
    if (hasStickyMap.get(key)) continue

    // 组内已有条目激活过 → 本轮全组候选落选（verified vs allActivatedEntries.some(x => x.group === key)）
    let alreadyActivated = false
    for (const activated of ctx.activated.values()) {
      if (activated.group === key) {
        alreadyActivated = true
        break
      }
    }
    if (alreadyActivated) {
      for (const entry of group) ctx.onRemove(entry, 'group-loser')
      continue
    }

    if (group.length <= 1) continue

    // groupOverride 优先：order 降序取第一（verified vs prios = group.filter(x => x.groupOverride).sort(sortFn)）
    const prios = group.filter((x) => x.groupOverride)
    if (prios.length > 0) {
      let winner = prios[0] as ScanEntry
      for (const candidate of prios) {
        if (
          candidate.order > winner.order ||
          (candidate.order === winner.order && candidate.uid < winner.uid)
        ) {
          winner = candidate
        }
      }
      removeAllBut(group, winner, ctx)
      continue
    }

    // 加权随机（verified vs totalWeight/rollValue/currentWeight 逻辑，rollValue <= currentWeight）
    let totalWeight = 0
    for (const entry of group) totalWeight += entry.groupWeight ?? DEFAULT_WEIGHT
    const rollValue = ctx.rng() * totalWeight
    let currentWeight = 0
    let winner: ScanEntry | undefined
    for (const entry of group) {
      currentWeight += entry.groupWeight ?? DEFAULT_WEIGHT
      if (rollValue <= currentWeight) {
        winner = entry
        break
      }
    }
    if (!winner) continue
    removeAllBut(group, winner, ctx)
  }
}

function removeAllBut(group: readonly ScanEntry[], chosen: ScanEntry | null, ctx: GroupFilterContext): void {
  for (const entry of group) {
    if (entry === chosen) continue
    ctx.onRemove(entry, 'group-loser')
  }
}

/**
 * timed effects 组内过滤（verified vs filterGroupsByTimedEffects）：
 * sticky 在组 → 非 sticky 全落选；cooldown / delay 条目落选。
 * 注：ST 的 removeEntry 用 splice(indexOf(entry), 1)，条目已被移除时 indexOf = -1
 * 会误删 newEntries 末位元素——此处按意图实现为幂等移除（见报告偏差表）。
 */
function filterGroupsByTimedEffects(
  groups: Record<string, ScanEntry[]>,
  ctx: GroupFilterContext,
): Map<string, boolean> {
  const hasStickyMap = new Map<string, boolean>()
  for (const [key, group] of Object.entries(groups)) {
    hasStickyMap.set(key, false)
    const stickyEntries = group.filter((x) => ctx.timed.isStickyActive(x))
    if (stickyEntries.length > 0) {
      for (const entry of group) {
        if (!stickyEntries.includes(entry)) ctx.onRemove(entry, 'group-sticky-loser')
      }
      hasStickyMap.set(key, true)
    }
    for (const entry of group) {
      if (ctx.timed.isCooldownActive(entry)) ctx.onRemove(entry, 'group-cooldown')
      if (ctx.timed.isDelayActive(entry)) ctx.onRemove(entry, 'group-delay')
    }
  }
  return hasStickyMap
}

/**
 * 组计分过滤（verified vs filterGroupsByScoring）：
 * 全局与组内均未开启则跳过；sticky 组跳过；仅对 isScored 条目按最高分裁汰。
 */
function filterGroupsByScoring(
  groups: Record<string, ScanEntry[]>,
  hasStickyMap: Map<string, boolean>,
  ctx: GroupFilterContext,
): void {
  for (const [key, group] of Object.entries(groups)) {
    if (!ctx.useGroupScoring && !group.some((x) => x.useGroupScoring === true)) continue
    if (hasStickyMap.get(key)) continue

    const scores = group.map((entry) => ctx.buffer.getScore(entry, ctx.scanState))
    let maxScore = scores[0] ?? 0
    for (const score of scores) maxScore = Math.max(maxScore, score)

    for (let i = 0; i < group.length; i++) {
      const entry = group[i]
      const score = scores[i] ?? 0
      const isScored = (entry?.useGroupScoring ?? null) ?? ctx.useGroupScoring
      if (!entry || !isScored) continue
      if (score < maxScore) {
        ctx.onRemove(entry, 'group-score-loser')
        // 同步裁剪组数组（ST 此处会 group.splice，verified）
        const idx = group.indexOf(entry)
        if (idx !== -1) group.splice(idx, 1)
        scores.splice(i, 1)
        i--
      }
    }
  }
}
