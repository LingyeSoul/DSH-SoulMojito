import { describe, expect, it } from 'vitest'
import {
  IM_CHUNK_DEFAULTS,
  ImSettingsError,
  applyImSettingsPatch,
  imAccessAllows,
  imChunkLimit,
  weixinSendIntervalOf,
} from '../src/im/settings.js'
import { DEFAULT_IM_SETTINGS, WEIXIN_SEND_INTERVAL_DEFAULT_MS } from '../src/im/types.js'
import { normalizeImSettings } from '../../tavern-store/src/index.js'

const base = { ...DEFAULT_IM_SETTINGS }

describe('imAccessAllows', () => {
  it('denies everyone by default (allowlist with an empty list)', () => {
    expect(imAccessAllows(base, 'private', 'peer-a')).toBe(false)
    expect(imAccessAllows(base, 'group', 'group-a')).toBe(false)
  })

  it('honours open and disabled modes before the list', () => {
    expect(imAccessAllows({ ...base, privateMode: 'open' }, 'private', 'anyone')).toBe(true)
    expect(imAccessAllows({ ...base, privateMode: 'disabled', privateAllow: ['peer-a'] }, 'private', 'peer-a')).toBe(false)
  })

  it('separates group and private allowlists', () => {
    const settings = { ...base, privateAllow: ['peer-a'], groupAllow: ['group-a'] }
    expect(imAccessAllows(settings, 'private', 'peer-a')).toBe(true)
    expect(imAccessAllows(settings, 'private', 'group-a')).toBe(false)
    expect(imAccessAllows(settings, 'group', 'group-a')).toBe(true)
  })
})

describe('imChunkLimit', () => {
  it('falls back to channel defaults and lets the user override', () => {
    expect(imChunkLimit('qq', base)).toBe(IM_CHUNK_DEFAULTS.qq)
    expect(imChunkLimit('weixin', { ...base, chunkLimit: 900 })).toBe(900)
  })
})

describe('weixin send interval', () => {
  it('defaults to 3s and falls back to it when the setting is cleared', () => {
    expect(WEIXIN_SEND_INTERVAL_DEFAULT_MS).toBe(3_000)
    expect(weixinSendIntervalOf(base)).toBe(WEIXIN_SEND_INTERVAL_DEFAULT_MS)
    expect(weixinSendIntervalOf({ ...base, weixinSendIntervalMs: 900 })).toBe(900)
  })

  it('accepts an in-range integer and clears the field with null', () => {
    const next = applyImSettingsPatch(base, { weixinSendIntervalMs: 2_500 })
    expect(next.weixinSendIntervalMs).toBe(2_500)
    const cleared = applyImSettingsPatch(next, { weixinSendIntervalMs: null })
    expect(cleared.weixinSendIntervalMs).toBeUndefined()
    expect(weixinSendIntervalOf(cleared)).toBe(WEIXIN_SEND_INTERVAL_DEFAULT_MS)
  })

  it('rejects out-of-range or non-integer values instead of clamping', () => {
    expect(() => applyImSettingsPatch(base, { weixinSendIntervalMs: 499 })).toThrow(/weixinSendIntervalMs/)
    expect(() => applyImSettingsPatch(base, { weixinSendIntervalMs: 60_001 })).toThrow(/weixinSendIntervalMs/)
    expect(() => applyImSettingsPatch(base, { weixinSendIntervalMs: 1_000.5 })).toThrow(/weixinSendIntervalMs/)
  })

  it('normalizes a hand-edited state file and drops out-of-range values', () => {
    expect(normalizeImSettings({ ...base, weixinSendIntervalMs: 1_200 }).weixinSendIntervalMs).toBe(1_200)
    expect(normalizeImSettings({ ...base, weixinSendIntervalMs: 499 }).weixinSendIntervalMs).toBeUndefined()
    expect(normalizeImSettings({ ...base, weixinSendIntervalMs: 1_000.5 }).weixinSendIntervalMs).toBeUndefined()
  })
})

describe('applyImSettingsPatch', () => {
  it('keeps untouched fields and normalises allowlists', () => {
    const next = applyImSettingsPatch(
      base,
      { privateAllow: [' peer-a ', 'peer-a', 'peer-b', ''], groupRequireMention: false },
    )
    expect(next.privateAllow).toEqual(['peer-a', 'peer-b'])
    expect(next.groupRequireMention).toBe(false)
  })

  it('rejects an unknown access mode instead of guessing', () => {
    expect(() => applyImSettingsPatch(base, { privateMode: 'sometimes' })).toThrow(ImSettingsError)
  })

  it('rejects a non-integer chunk limit', () => {
    expect(() => applyImSettingsPatch(base, { chunkLimit: 1.5 })).toThrow(/chunkLimit/)
  })
})
