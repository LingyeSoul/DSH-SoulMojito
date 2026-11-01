import { describe, expect, it } from 'vitest'
import { createLazyProjection } from '../src/lazy-projection.js'
import type { TavernState } from '../../tavern-store/src/index.js'

/**
 * `lazy-projection` 的写穿面（2026-11-01，标准 DSH Agent 会话预设投影的连带
 * 加固）：`refreshAll` / `preheatAll` 对 N 个 agent 只读一次 state，并把同一份
 * 快照交给每个装载——`store.getState()` 每次都读盘，逐 agent 读会让一次面板
 * 开关翻转退化成 N 次读盘（「开关不跟手，要卡一会」）。
 */

const STATE = { activeWorlds: [], sessionBindings: {} } as unknown as TavernState

function settleMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('lazy projection write-through', () => {
  it('refreshAll reads state once and hands the snapshot to every load', async () => {
    let reads = 0
    const snapshots: Array<TavernState | undefined> = []
    const projection = createLazyProjection<string>({
      getState: async () => { reads += 1; return STATE },
      load: async (agentId, settle, state) => { snapshots.push(state); settle(agentId) },
    })
    // 首装配的懒装载（各自读一次 state）
    projection.valueOf('agent-a')
    projection.valueOf('agent-b')
    await settleMicrotasks()

    reads = 0
    snapshots.length = 0
    await projection.refreshAll()

    expect(reads).toBe(1)
    expect(snapshots).toEqual([STATE, STATE])
  })

  it('preheatAll marks the given agents and reads state once', async () => {
    let reads = 0
    const loaded: string[] = []
    const projection = createLazyProjection<string>({
      getState: async () => { reads += 1; return STATE },
      load: async (agentId, settle, state) => {
        expect(state).toBe(STATE)
        loaded.push(agentId)
        settle(agentId)
      },
    })
    await projection.preheatAll(['agent-a', 'agent-b', 'agent-c'])

    expect(reads).toBe(1)
    expect(loaded.sort()).toEqual(['agent-a', 'agent-b', 'agent-c'])
    // 预热后是已装载状态：懒读取直接拿缓存，不再触发装载
    expect(projection.valueOf('agent-a')).toBe('agent-a')
  })
})
