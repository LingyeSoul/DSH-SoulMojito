/**
 * Confirmable host-session write 协议单元回归（D-2，决策
 * 2026-10-11-confirmable-session-writes）。
 *
 * 协议三条腿各自锁定：
 * 1. 写后读回在场即成功，不重写（append-only 日志零重复）；
 * 2. 首读缺席 → 重写一次 → 在场：成功 + 一行 warn（退化宿主可观测）；
 * 3. 两次尝试均缺席：一行 error（含写入点标识与两次结果）+ 返回 false，
 *    静默吞是被消灭的行为；
 * 4. landedPlanAppends 的批量对齐：干净前缀 / 全落地 / 错位残渣三类判定的
 *    边界（残渣时调用方必须放弃重放，否则重复边界事件即损坏形状）。
 */
import { describe, expect, it } from 'vitest'
import { confirmSessionAppend, landedPlanAppends, type ConfirmableWriteLogger } from '../src/index.js'

function makeLogger(): { logger: ConfirmableWriteLogger; warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  return {
    warns,
    errors,
    logger: {
      warn: (message: string) => { warns.push(message) },
      error: (message: string) => { errors.push(message) },
    },
  }
}

/** 可编程吞写宿主：append 正常返回，但按谓词丢弃事件（LWB 静默不保存形状）。 */
function makeSession(drop?: (type: string, data: unknown) => boolean) {
  const events: Array<{ type: string; data: unknown }> = []
  const swallowed: Array<{ type: string; data: unknown }> = []
  return {
    events,
    swallowed,
    session: {
      events,
      append: (type: string, data: unknown) => {
        if (drop?.(type, data)) {
          swallowed.push({ type, data })
          return undefined
        }
        events.push({ type, data })
        return { type, data }
      },
    },
  }
}

function markerPresent(events: readonly { type?: string; data?: unknown }[]): boolean {
  return events.some((event) => event.type === 'user/message'
    && (event.data as { summary?: unknown } | undefined)?.summary === 'Tavern: 露西')
}

describe('confirmSessionAppend', () => {
  it('confirms on first read-back without rewriting', () => {
    const { logger, warns, errors } = makeLogger()
    const host = makeSession()
    let appends = 0
    const confirmed = confirmSessionAppend({
      session: host.session,
      label: 'Tavern activation marker (露西)',
      logger,
      append: () => { appends += 1; host.session.append('user/message', { summary: 'Tavern: 露西' }) },
      present: markerPresent,
    })
    expect(confirmed).toBe(true)
    expect(appends).toBe(1)
    expect(host.events).toHaveLength(1)
    expect(warns).toEqual([])
    expect(errors).toEqual([])
  })

  it('rewrites once when the first append is silently swallowed, and stays observable', () => {
    const { logger, warns, errors } = makeLogger()
    const events: Array<{ type: string; data: unknown }> = []
    // 只吞第一次 marker 写入：重写落账，模拟「等锁超时后恢复」的宿主。
    let swallowFirstMarker = true
    const session = {
      events,
      append: (type: string, data: unknown) => {
        if (swallowFirstMarker && (data as { summary?: unknown })?.summary === 'Tavern: 露西') {
          swallowFirstMarker = false
          return undefined
        }
        events.push({ type, data })
      },
    }
    const confirmed = confirmSessionAppend({
      session,
      label: 'Tavern activation marker (露西)',
      logger,
      append: () => session.append('user/message', { summary: 'Tavern: 露西' }),
      present: markerPresent,
    })
    expect(confirmed).toBe(true)
    expect(events).toHaveLength(1)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('Tavern activation marker')
    expect(warns[0]).toContain('rewrite')
    expect(errors).toEqual([])
  })

  it('fails honestly with one error line naming the write point and both attempts', () => {
    const { logger, warns, errors } = makeLogger()
    const host = makeSession(() => true)
    let appends = 0
    const confirmed = confirmSessionAppend({
      session: host.session,
      label: 'Tavern close marker (session-a)',
      logger,
      append: () => { appends += 1; host.session.append('user/message', { summary: 'Tavern closed' }) },
      present: (events) => events.some((event) => event.type === 'user/message'
        && (event.data as { summary?: unknown })?.summary === 'Tavern closed'),
    })
    expect(confirmed).toBe(false)
    expect(appends).toBe(2)
    expect(host.swallowed).toHaveLength(2)
    expect(warns).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('Tavern close marker (session-a)')
    expect(errors[0]).toContain('attempt 1: absent')
    expect(errors[0]).toContain('attempt 2: absent')
  })

  it('cannot confirm a session whose log shape is unreadable', () => {
    const { logger, errors } = makeLogger()
    let appends = 0
    const confirmed = confirmSessionAppend({
      // 无 events/snapshotEvents/log：readSessionEvents 返回 undefined → 空日志。
      session: { append: () => { appends += 1 } },
      label: 'unreadable marker',
      logger,
      append: () => { appends += 1 },
      present: (events) => events.length > 0,
    })
    expect(confirmed).toBe(false)
    expect(appends).toBe(2)
    expect(errors[0]).toContain('unreadable marker')
  })
})

describe('landedPlanAppends', () => {
  const plan = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'user/message', data: { id: 'u1' } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  it('returns 0 when nothing landed and the log is unchanged', () => {
    const host = makeSession()
    expect(landedPlanAppends(host.session, plan, 0)).toBe(0)
  })

  it('counts a clean contiguous prefix', () => {
    const host = makeSession()
    for (const item of plan.slice(0, 3)) host.session.append(item.type, item.data)
    expect(landedPlanAppends(host.session, plan, 0)).toBe(3)
  })

  it('returns the full plan length when everything landed', () => {
    const host = makeSession()
    for (const item of plan) host.session.append(item.type, item.data)
    expect(landedPlanAppends(host.session, plan, 0)).toBe(plan.length)
  })

  it('aligns after pre-existing events via baseLength', () => {
    const host = makeSession()
    host.session.append('agent-preset/selected', { agentPreset: 'agent-tavern' })
    const base = host.events.length
    for (const item of plan.slice(0, 2)) host.session.append(item.type, item.data)
    expect(landedPlanAppends(host.session, plan, base)).toBe(2)
  })

  it('breaks alignment on the first data mismatch so callers refuse to replay', () => {
    const host = makeSession()
    host.session.append('turn/start', { turn: 1 })
    // 第二条 data 与计划不同（错位残渣形态）：对齐必须停在 1，且日志长度超过
    // baseLength + 1，调用方据此放弃重放。
    host.session.append('step/start', { turn: 9, step: 9 })
    expect(landedPlanAppends(host.session, plan, 0)).toBe(1)
    expect(host.events.length).toBe(2)
  })

  it('treats an out-of-range baseLength as nothing landed', () => {
    const host = makeSession()
    for (const item of plan) host.session.append(item.type, item.data)
    expect(landedPlanAppends(host.session, plan, 99)).toBe(0)
  })
})
