import { describe, expect, it } from 'vitest'
import {
  IM_CHUNK_DEFAULTS,
  ImSettingsError,
  applyImSettingsPatch,
  imAccessAllows,
  imChunkLimit,
} from '../src/im/settings.js'
import { DEFAULT_IM_SETTINGS } from '../src/im/types.js'

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

describe('applyImSettingsPatch', () => {
  it('keeps untouched fields and normalises allowlists', () => {
    const next = applyImSettingsPatch(
      { ...base, bindingMode: 'manual' },
      { privateAllow: [' peer-a ', 'peer-a', 'peer-b', ''], groupRequireMention: false },
    )
    expect(next.bindingMode).toBe('manual')
    expect(next.privateAllow).toEqual(['peer-a', 'peer-b'])
    expect(next.groupRequireMention).toBe(false)
  })

  it('rejects an unknown access mode instead of guessing', () => {
    expect(() => applyImSettingsPatch(base, { privateMode: 'sometimes' })).toThrow(ImSettingsError)
  })

  it('requires sourceChat for independent mode', () => {
    expect(() => applyImSettingsPatch(base, { bindingMode: 'independent' }))
      .toThrow(/independent requires sourceChat/)
  })

  it('requires sharedChat for shared mode', () => {
    expect(() => applyImSettingsPatch(base, { bindingMode: 'shared' }))
      .toThrow(/shared requires sharedChat/)
  })

  it('can clear a chat reference with null once the mode no longer needs it', () => {
    const withSource = applyImSettingsPatch(base, {
      bindingMode: 'independent',
      sourceChat: { character: 'Example', chatId: 'chat.jsonl' },
    })
    expect(withSource.sourceChat).toEqual({ character: 'Example', chatId: 'chat.jsonl' })
    const cleared = applyImSettingsPatch(withSource, { bindingMode: 'manual', sourceChat: null })
    expect(cleared.sourceChat).toBeUndefined()
  })

  it('rejects a non-integer chunk limit', () => {
    expect(() => applyImSettingsPatch(base, { chunkLimit: 1.5 })).toThrow(/chunkLimit/)
  })
})
