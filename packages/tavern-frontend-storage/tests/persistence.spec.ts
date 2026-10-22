/**
 * Per-character virtual localStorage persistence against the real store.
 *
 * The validation rules are part of the card-facing contract (512 KB, key
 * length), so they are exercised through a real TavernStore rather than a
 * hand-written fake.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TavernStore } from '@dsh-soulmojito/store'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FRONTEND_STORAGE_TOTAL_LIMIT,
  frontendStorageFor,
  putFrontendStorage,
  resetFrontendStorage,
} from '../src/index.js'

const CHARACTER = 'Storage Probe'
let root = ''
let store: TavernStore

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-storage-'))
  store = await TavernStore.open(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('virtual localStorage persistence', () => {
  it('writes, reads back and resets one character without touching others', async () => {
    expect(await putFrontendStorage(store, CHARACTER, { theme: 'dark', volume: '0.4' }))
      .toEqual({ storage: { theme: 'dark', volume: '0.4' } })
    expect(await putFrontendStorage(store, 'Other Card', { theme: 'light' }))
      .toEqual({ storage: { theme: 'light' } })

    const state = await store.getState()
    expect(frontendStorageFor(state, CHARACTER)).toEqual({ theme: 'dark', volume: '0.4' })
    expect(frontendStorageFor(state, 'Other Card')).toEqual({ theme: 'light' })

    expect(await resetFrontendStorage(store, CHARACTER))
      .toEqual({ storage: {}, reset: true })
    const next = await store.getState()
    expect(frontendStorageFor(next, CHARACTER)).toEqual({})
    expect(frontendStorageFor(next, 'Other Card')).toEqual({ theme: 'light' })
  })

  it('rejects non-string values, empty keys and oversized tables', async () => {
    await expect(putFrontendStorage(store, CHARACTER, { bad: 1 })).rejects.toThrow('must be a string')
    await expect(putFrontendStorage(store, CHARACTER, { '': 'x' })).rejects.toThrow('1-512')
    await expect(putFrontendStorage(store, CHARACTER, { huge: 'x'.repeat(FRONTEND_STORAGE_TOTAL_LIMIT) }))
      .rejects.toThrow('exceeds')
  })
})
