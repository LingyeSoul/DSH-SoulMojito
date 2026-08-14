/**
 * Timed effects（sticky / cooldown / delay），语义对照 ST world-info.js `WorldInfoTimedEffects`：
 * - 状态存于 chat_metadata.timedWorldInfo.{sticky|cooldown}，按 `book.uid` 全局键索引；
 * - checkTimedEffects：消息数未推进且未受保护 → 清除；条目缺失/不再配置 → 清除；
 *   到期 → 清除，sticky 到期且条目带 cooldown → 立即写入受保护 cooldown 并当轮生效；
 * - delay 不落盘：消息数 < delay 即压制；
 * - setTimedEffects：激活条目若带 sticky/cooldown 且无在案记录 → 写入 {start, end}。
 */

import type { TimedEffectRecord, TimedEffectsState } from './types.js'
import type { ScanEntry } from './entry.js'

type EffectType = 'sticky' | 'cooldown'

export function cloneTimedState(state: TimedEffectsState | undefined): TimedEffectsState {
  const sticky: Record<string, TimedEffectRecord> = {}
  const cooldown: Record<string, TimedEffectRecord> = {}
  for (const [key, value] of Object.entries(state?.sticky ?? {})) {
    if (value && typeof value === 'object') sticky[key] = { ...value }
  }
  for (const [key, value] of Object.entries(state?.cooldown ?? {})) {
    if (value && typeof value === 'object') cooldown[key] = { ...value }
  }
  return { sticky, cooldown }
}

export class TimedEffects {
  private readonly stickyActive = new Set<string>()
  private readonly cooldownActive = new Set<string>()
  private readonly delayActive = new Set<string>()
  private readonly state: TimedEffectsState
  private readonly entriesByUid: Map<string, ScanEntry>
  private readonly messageCount: number

  constructor(state: TimedEffectsState, entries: readonly ScanEntry[], messageCount: number) {
    this.state = state
    this.messageCount = messageCount
    this.entriesByUid = new Map(entries.map((entry) => [entry.entryId, entry]))
    this.check()
  }

  /** 入口：校验在案记录并计算本轮生效集合（verified vs WorldInfoTimedEffects.checkTimedEffects）。 */
  private check(): void {
    for (const type of ['sticky', 'cooldown'] as const) {
      this.checkOfType(type)
    }
    // delay：按当前消息数即时判定（verified vs WorldInfoTimedEffects.#checkDelayEffect）
    for (const entry of this.entriesByUid.values()) {
      if (entry.delay !== null && this.messageCount < entry.delay) {
        this.delayActive.add(entry.entryId)
      }
    }
  }

  private checkOfType(type: EffectType): void {
    const bucket = this.state[type] ?? {}
    for (const key of Object.keys(bucket)) {
      const record = bucket[key]
      if (!record) continue
      const entry = this.entriesByUid.get(key)

      // 消息数未推进：未受保护的记录视为无效（重扫/重掷保护，verified vs #checkTimedEffectOfType）
      if (this.messageCount <= record.start && !record.protected) {
        delete bucket[key]
        continue
      }

      // 条目已不存在：到期即清理，否则保留在案但不生效
      if (!entry) {
        if (this.messageCount >= record.end) delete bucket[key]
        continue
      }

      // 条目不再配置该效果：清理
      if (entry[type] === null || entry[type] === undefined) {
        delete bucket[key]
        continue
      }

      // 到期：清理 + onEnded（sticky 结束 → 立即落入受保护 cooldown）
      if (this.messageCount >= record.end) {
        delete bucket[key]
        if (type === 'sticky' && entry.cooldown !== null) {
          const effect: TimedEffectRecord = {
            start: this.messageCount,
            end: this.messageCount + entry.cooldown,
            protected: true,
          }
          const cooldownBucket = (this.state.cooldown ??= {})
          cooldownBucket[key] = effect
          this.cooldownActive.add(key)
        }
        continue
      }

      if (type === 'sticky') this.stickyActive.add(key)
      else this.cooldownActive.add(key)
    }
  }

  isStickyActive(entry: ScanEntry): boolean {
    return this.stickyActive.has(entry.entryId)
  }

  isCooldownActive(entry: ScanEntry): boolean {
    return this.cooldownActive.has(entry.entryId)
  }

  isDelayActive(entry: ScanEntry): boolean {
    return this.delayActive.has(entry.entryId)
  }

  /** 激活收尾：为带 sticky/cooldown 的激活条目落盘（已存在则不覆盖，verified vs setTimedEffects）。 */
  setFromActivation(activated: readonly ScanEntry[]): void {
    for (const entry of activated) {
      for (const type of ['sticky', 'cooldown'] as const) {
        const value = entry[type]
        if (value === null || value === undefined) continue
        const bucket = (this.state[type] ??= {})
        const key = entry.entryId
        if (!bucket[key]) {
          bucket[key] = { start: this.messageCount, end: this.messageCount + value, protected: false }
        }
      }
    }
  }

  getTimedState(): TimedEffectsState {
    return { sticky: { ...(this.state.sticky ?? {}) }, cooldown: { ...(this.state.cooldown ?? {}) } }
  }
}
