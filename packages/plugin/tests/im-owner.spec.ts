/**
 * 会话主人（决策 2026-10-31-im-owner-designation）的状态与纯函数检查：
 * - 发言人哈希的形状/稳定性（`snd-` + 10 位十六进制，原始 id 不可还原）；
 * - 发言人表的合并语义（窗口内不刷新、窗口外刷新、有界、纯函数）；
 * - `state.json` 的容错读取（旧文件没有两张表、坏条目丢弃）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IM_SENDERS_MAX_PER_PEER,
  TavernStore,
  normalizeImOwners,
  normalizeImSenders,
} from '../../tavern-store/src/index.js'
import {
  IM_SENDER_HASH_HEX_LENGTH,
  IM_SENDER_HASH_PREFIX,
  imSenderHash,
  isImSenderHash,
  mergeImSenderEntries,
} from '../src/im/owner.js'
import type { ImSenderEntry } from '../src/im/types.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'im-owner-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('imSenderHash', () => {
  it('is a stable, truncated snd- hash that never carries the raw sender id', () => {
    const id = imSenderHash('qq', 'acct', 'openid-alice')
    expect(id).toBe(imSenderHash('qq', 'acct', 'openid-alice'))
    expect(id.startsWith(IM_SENDER_HASH_PREFIX)).toBe(true)
    expect(id.length).toBe(IM_SENDER_HASH_PREFIX.length + IM_SENDER_HASH_HEX_LENGTH)
    expect(id).toMatch(/^snd-[0-9a-f]{10}$/)
    expect(id).not.toContain('openid-alice')
    // channel/account/sender 三段都进哈希：任一不同即不同身份。
    expect(imSenderHash('qq', 'acct', 'openid-bob')).not.toBe(id)
    expect(imSenderHash('weixin', 'acct', 'openid-alice')).not.toBe(id)
    expect(imSenderHash('qq', 'other', 'openid-alice')).not.toBe(id)
  })

  it('accepts only the snd- shape as a sender reference', () => {
    expect(isImSenderHash(imSenderHash('qq', 'acct', 'x'))).toBe(true)
    expect(isImSenderHash('snd-0123456789')).toBe(true)
    expect(isImSenderHash('0123456789')).toBe(false)
    expect(isImSenderHash('snd-012345678')).toBe(false)
    expect(isImSenderHash('snd-0123456789a')).toBe(false)
    expect(isImSenderHash('snd-01234567zz')).toBe(false)
    expect(isImSenderHash('openid-alice')).toBe(false)
  })
})

describe('mergeImSenderEntries', () => {
  const options = { maxEntries: 3, refreshWindowMs: 60_000 }
  const entry = (id: string, lastAt: number, name = ''): ImSenderEntry => ({ id, name, lastAt })

  it('prepends new senders and dedupes a batch by id without mutating inputs', () => {
    const existing = [entry('snd-aaaaaaaaaa', 1_000, 'A')]
    const next = mergeImSenderEntries(existing, [
      { id: 'snd-bbbbbbbbbb', name: 'B', lastAt: 2_000 },
      { id: 'snd-bbbbbbbbbb', name: 'B2', lastAt: 2_500 },
    ], options)
    expect(next?.map((row) => row.id)).toEqual(['snd-bbbbbbbbbb', 'snd-aaaaaaaaaa'])
    expect(next?.[0]?.name).toBe('B2')
    expect(existing).toHaveLength(1)
  })

  it('skips a refresh inside the window and refreshes after it', () => {
    const existing = [entry('snd-aaaaaaaaaa', 1_000, 'A')]
    expect(mergeImSenderEntries(existing, [{ id: 'snd-aaaaaaaaaa', name: 'A', lastAt: 1_500 }], options)).toBeUndefined()
    const next = mergeImSenderEntries(existing, [{ id: 'snd-aaaaaaaaaa', name: 'A', lastAt: 61_000 }], options)
    expect(next).toEqual([entry('snd-aaaaaaaaaa', 61_000, 'A')])
  })

  it('caps the list at the configured bound, dropping the oldest', () => {
    const existing = [
      entry('snd-aaaaaaaaaa', 3_000),
      entry('snd-bbbbbbbbbb', 2_000),
      entry('snd-cccccccccc', 1_000),
    ]
    const next = mergeImSenderEntries(existing, [{ id: 'snd-dddddddddd', name: 'D', lastAt: 4_000 }], options)
    expect(next?.map((row) => row.id)).toEqual(['snd-dddddddddd', 'snd-aaaaaaaaaa', 'snd-bbbbbbbbbb'])
  })

  it('returns undefined when there is nothing to merge', () => {
    expect(mergeImSenderEntries([], [], options)).toBeUndefined()
  })
})

describe('IM owner and sender state normalization', () => {
  it('treats a legacy state file without the maps as empty tables', async () => {
    await writeFile(join(root, 'state.json'), JSON.stringify({ activeWorlds: ['ExampleWorld'] }))
    const state = await (await TavernStore.open(root)).getState()
    expect(state.imSenders).toEqual({})
    expect(state.imOwners).toEqual({})
    expect(state.activeWorlds).toEqual(['ExampleWorld'])
  })

  it('drops malformed sender rows, dedupes ids and sorts newest first', () => {
    const rows = normalizeImSenders({
      'qq:acct:group:g1': [
        { id: 'snd-aaaaaaaaaa', name: ' A ', lastAt: 1_000 },
        { id: 'snd-aaaaaaaaaa', name: 'A2', lastAt: 2_000 },
        { id: '', name: 'blank', lastAt: 3_000 },
        { id: 'snd-bbbbbbbbbb', name: 'B', lastAt: Number.NaN },
        { id: 'snd-cccccccccc', name: 'C', lastAt: 500 },
        'junk',
        { name: 'no id', lastAt: 9_000 },
      ],
      bad: 'not-an-array',
    })
    expect(rows['qq:acct:group:g1']?.map((row) => [row.id, row.name, row.lastAt])).toEqual([
      ['snd-aaaaaaaaaa', 'A2', 2_000],
      ['snd-cccccccccc', 'C', 500],
    ])
    expect(rows['bad']).toBeUndefined()
  })

  it('caps a hand-edited sender list to the per-peer bound', () => {
    const many = Array.from({ length: IM_SENDERS_MAX_PER_PEER + 5 }, (_, index) => ({
      id: `snd-${String(index).padStart(10, '0')}`,
      name: `n${index}`,
      lastAt: 1_000 + index,
    }))
    const rows = normalizeImSenders({ key: many })
    expect(rows['key']).toHaveLength(IM_SENDERS_MAX_PER_PEER)
    expect(rows['key']?.[0]?.lastAt).toBe(1_000 + IM_SENDERS_MAX_PER_PEER + 4)
  })

  it('drops owner rows without an id and tolerates missing display fields', () => {
    const rows = normalizeImOwners({
      'qq:acct:group:g1': { id: ' snd-aaaaaaaaaa ', name: ' 小明 ', setAt: '2026-10-31T00:00:00.000Z' },
      'qq:acct:group:g2': { name: 'no id' },
      'qq:acct:group:g3': { id: 'snd-bbbbbbbbbb', name: 7, setAt: 5 },
      bad: null,
    })
    expect(rows).toEqual({
      'qq:acct:group:g1': { id: 'snd-aaaaaaaaaa', name: '小明', setAt: '2026-10-31T00:00:00.000Z' },
      'qq:acct:group:g3': { id: 'snd-bbbbbbbbbb', name: '', setAt: new Date(0).toISOString() },
    })
  })

  it('drops raw platform ids and timestamps beyond the Date range', () => {
    const senders = normalizeImSenders({
      key: [
        { id: 'openid-alice', name: 'Alice', lastAt: 1_000 },
        { id: 'snd-aaaaaaaaaa', name: 'A', lastAt: 1_000 },
        { id: 'snd-bbbbbbbbbb', name: 'B', lastAt: 1e300 },
      ],
    })
    expect(senders['key']?.map((entry) => entry.id)).toEqual(['snd-aaaaaaaaaa'])

    const owners = normalizeImOwners({
      raw: { id: 'openid-alice', name: 'Alice', setAt: '2026-10-31T00:00:00.000Z' },
      ok: { id: 'snd-cccccccccc', name: '', setAt: '2026-10-31T00:00:00.000Z' },
    })
    expect(owners).toEqual({ ok: { id: 'snd-cccccccccc', name: '', setAt: '2026-10-31T00:00:00.000Z' } })
  })

  it('normalizes a hand-written state file with bad rows instead of failing to open', async () => {
    await writeFile(join(root, 'state.json'), JSON.stringify({
      imSenders: {
        'qq:acct:group:g1': [
          { id: 'snd-aaaaaaaaaa', name: '小明', lastAt: 2_000 },
          { id: 'snd-bbbbbbbbbb', name: '坏时间', lastAt: -1 },
          null,
        ],
      },
      imOwners: {
        'qq:acct:group:g1': { id: 'snd-aaaaaaaaaa', name: '小明', setAt: '2026-10-31T00:00:00.000Z' },
        'qq:acct:group:g2': { id: '' },
      },
    }))
    const state = await (await TavernStore.open(root)).getState()
    expect(state.imSenders?.['qq:acct:group:g1']).toEqual([{ id: 'snd-aaaaaaaaaa', name: '小明', lastAt: 2_000 }])
    expect(state.imOwners?.['qq:acct:group:g1']?.id).toBe('snd-aaaaaaaaaa')
    expect(state.imOwners?.['qq:acct:group:g2']).toBeUndefined()
  })
})