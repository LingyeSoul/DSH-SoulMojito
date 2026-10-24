/**
 * Sandbox storage shim smoke test.
 *
 * The shims are emitted as source text for a sandboxed iframe, so they cannot
 * be imported directly. Evaluating them in a Node vm with browser-like globals
 * proves the extracted blocks still install the same surfaces and reach the
 * same RPC ops.
 */
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  decodeBase64Url,
  encodeBase64Url,
  handleIdbBridge,
  indexedDbIframeSource,
  localStorageIframeSource,
  serializeFrontendStorageSeed,
} from '../src/client.js'

describe('sandbox storage shim sources', () => {
  it('escapes a localStorage seed so it cannot break the srcdoc script', () => {
    const seed = serializeFrontendStorageSeed({ card: '</script><script>alert(1)</script>', line: '\u2028' })
    expect(seed).not.toContain('</script>')
    expect(seed).toContain('\\u003c/script')
    expect(seed).toContain('\\u2028')
  })

  it('installs seeded localStorage and sessionStorage', () => {
    const sandbox: Record<string, unknown> = {
      window: {},
      console,
      setTimeout,
      clearTimeout,
      addEventListener: () => undefined,
      initialStorage: { theme: 'dark' },
      call: () => Promise.resolve({}),
      showToast: () => undefined,
    }
    vm.runInNewContext(localStorageIframeSource(), sandbox)
    const window = sandbox.window as {
      localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void }
      sessionStorage: { getItem(key: string): string | null }
    }
    expect(window.localStorage.getItem('theme')).toBe('dark')
    expect(window.sessionStorage.getItem('theme')).toBeNull()
    window.localStorage.setItem('probe', 'ok')
    expect(window.localStorage.getItem('probe')).toBe('ok')
  })

  it('installs a virtual IndexedDB that opens through the helper RPC', async () => {
    const calls: string[] = []
    const sandbox: Record<string, unknown> = {
      window: {},
      console,
      setTimeout,
      Promise,
      ArrayBuffer,
      call: (op: string) => {
        calls.push(op)
        return Promise.resolve({ version: 1, previousVersion: 0, stores: [] })
      },
      clone: <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
    }
    vm.runInNewContext(indexedDbIframeSource(), sandbox)
    const window = sandbox.window as {
      indexedDB: { open(name: string, version: number): { result?: { name: string }; onsuccess: (() => void) | null } }
    }
    const request = window.indexedDB.open('card-cache', 1)
    let opened = false
    request.onsuccess = () => { opened = true }
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['idb.open'])
    expect(opened).toBe(true)
    expect(request.result?.name).toBe('card-cache')
  })

  it('maps a 204 idb/get response to an undefined record instead of an error', async () => {
    const urls: string[] = []
    const result = await handleIdbBridge('idb.get', { db: 'db', store: 'store', key: 'k' }, 'character', '/api', async (url) => {
      urls.push(url)
      return {
        ok: true,
        status: 204,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => undefined,
      }
    })
    expect(result.transfer).toEqual([])
    expect((result.value as { record?: unknown }).record).toBeUndefined()
    expect(urls[0]).toContain('/api/frontend/idb/get?')
  })

  it('round-trips plain object rows through the virtual IndexedDB', async () => {
    const calls: Array<{ op: string; payload: Record<string, unknown> }> = []
    const rows = new Map<string, { bytes: ArrayBuffer; meta: Record<string, unknown> }>()
    const sandbox: Record<string, unknown> = {
      window: {},
      console,
      setTimeout,
      Promise,
      ArrayBuffer,
      TextEncoder,
      TextDecoder,
      call: (op: string, payload: Record<string, unknown>) => {
        calls.push({ op, payload })
        if (op === 'idb.open') return Promise.resolve({ version: 1, previousVersion: 0, stores: ['histories'], storeKeyPaths: { histories: 'chatId' } })
        if (op === 'idb.store.create') return Promise.resolve({ stores: ['histories'] })
        if (op === 'idb.put') {
          rows.set(String(payload.key), {
            bytes: payload.bytes as ArrayBuffer,
            meta: payload.meta as Record<string, unknown>,
          })
          return Promise.resolve({ key: payload.key, size: 0 })
        }
        if (op === 'idb.get') {
          const row = rows.get(String(payload.key))
          if (row === undefined) return Promise.resolve({ record: undefined })
          return Promise.resolve({ record: { key: payload.key, bytes: row.bytes, ...row.meta } })
        }
        if (op === 'idb.keys') return Promise.resolve({ keys: [...rows.keys()] })
        return Promise.resolve({})
      },
      clone: <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T,
    }
    vm.runInNewContext(indexedDbIframeSource(), sandbox)
    const window = sandbox.window as {
      indexedDB: { open(name: string, version: number): { result?: { transaction(stores: string[], mode: string): { objectStore(name: string): Record<string, unknown> } }; onsuccess: (() => void) | null } }
    }
    const opened = window.indexedDB.open('phone', 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const db = opened.result as { transaction(stores: string[], mode: string): { objectStore(name: string): Record<string, any> } }
    const store = db.transaction(['histories'], 'readwrite').objectStore('histories')
    const write = store.put({ chatId: 'chat-1', value: { messages: ['a'] } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(write.error).toBeNull()
    expect(calls.some((entry) => entry.op === 'idb.put' && entry.payload.key === 'chat-1')).toBe(true)

    const read = store.get('chat-1') as Record<string, unknown> & { onsuccess: (() => void) | null }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(read.result).toEqual({ chatId: 'chat-1', value: { messages: ['a'] } })

    const all = store.getAll() as Record<string, unknown> & { onsuccess: (() => void) | null }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(all.result).toEqual([{ chatId: 'chat-1', value: { messages: ['a'] } }])
  })

  it('round-trips binary metadata through the base64url channel helpers', () => {
    const value = JSON.stringify({ sha256: 'abc', note: '资源包' })
    expect(decodeBase64Url(encodeBase64Url(value))).toBe(value)
  })
})
