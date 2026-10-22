/**
 * TavernHelper iframe runtime smoke test.
 *
 * The runtime is emitted as source text, so the useful assertion is not a
 * marker grep: run the emitted program in a browser-like vm and check that the
 * synchronous JSR surface, event vocabulary and the injected virtual storage
 * shims are actually installed.
 */
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { IFRAME_EVENTS, TAVERN_EVENTS } from '../src/index.js'
import * as clientEntry from '../src/client.js'
import { buildIframeScript, helperLibraryTags } from '../src/client.js'
import { iframeSources } from '../../tavern-frontend-storage/src/client.js'

interface PostedMessage {
  type: string
  token: string
  id: string
  op: string
}

function makeSandbox(posted: PostedMessage[]): Record<string, unknown> {
  const parent = {
    postMessage: (message: PostedMessage) => { posted.push(message) },
  }
  const document = {
    addEventListener: () => undefined,
    createElement: () => ({ style: {}, appendChild: () => undefined, remove: () => undefined }),
  }
  const window: Record<string, unknown> = { parent, document, addEventListener: () => undefined }
  return {
    window,
    parent,
    document,
    console,
    setTimeout,
    clearTimeout,
    addEventListener: () => undefined,
  }
}

describe('TavernHelper runtime source', () => {
  it('exposes the channel and event names from the client entry', () => {
    expect(clientEntry.HELPER_MESSAGE).toBe('dsh-soulmojito:helper')
    expect(clientEntry.HELPER_RESULT_MESSAGE).toBe('dsh-soulmojito:helper-result')
    expect(clientEntry.HELPER_SNAPSHOT_MESSAGE).toBe('dsh-soulmojito:helper-snapshot')
    expect(clientEntry.HELPER_EVENT_MESSAGE).toBe('dsh-soulmojito:helper-event')
    expect(clientEntry.TAVERN_EVENTS.CHAT_CHANGED).toBe('chat_id_changed')
    expect(clientEntry.IFRAME_EVENTS.GENERATION_ENDED).toBe('js_generation_ended')
  })

  it('is syntactically valid and installs the JSR surface plus virtual storage', () => {
    const posted: PostedMessage[] = []
    const script = buildIframeScript(
      'probe-token',
      3,
      JSON.stringify({ theme: 'dark' }),
      iframeSources(),
    )
    expect(() => new Function(script)).not.toThrow()

    const sandbox = makeSandbox(posted)
    vm.runInNewContext(script, sandbox)
    const window = sandbox.window as Record<string, unknown> & {
      localStorage: { getItem(key: string): string | null }
      indexedDB: { open(name: string): unknown }
      tavern_events: Record<string, string>
      iframe_events: Record<string, string>
      TavernHelper: Record<string, unknown>
    }
    expect(typeof window.getVariables).toBe('function')
    expect(typeof window.getChatMessages).toBe('function')
    expect(typeof window.eventOn).toBe('function')
    expect(typeof window.TavernHelper).toBe('object')
    expect(window.tavern_events.MESSAGE_RECEIVED).toBe(TAVERN_EVENTS.MESSAGE_RECEIVED)
    expect(window.iframe_events.MESSAGE_IFRAME_RENDER_STARTED).toBe(IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED)
    expect(window.localStorage.getItem('theme')).toBe('dark')
    expect(typeof window.indexedDB.open).toBe('function')
    expect(posted[0]).toMatchObject({ type: 'dsh-soulmojito:helper', token: 'probe-token', op: 'snapshot' })
  })

  it('keeps the JSR globals and generation bridge in the emitted source', () => {
    const script = buildIframeScript('probe-token', -1, '{}', iframeSources())
    const libraries = helperLibraryTags()
    for (const marker of [
      'https://cdn.jsdelivr.net/npm/vue@3.5.40/dist/vue.runtime.global.prod.min.js',
    ]) {
      expect(libraries).toContain(marker)
    }
    expect(libraries).toContain('https://cdn.jsdelivr.net/npm/zod@4.4.3/+esm')
    for (const marker of [
      'window.getVariables = function',
      'window.getChatMessages = function',
      'window.setChatMessages = function',
      'window.eventOn = function',
      'window.generate = function (config)',
      "call('generate', { config: request })",
      "call('idb.put', { db: tx.db.name, store: this.name, key: key, meta: meta, bytes: bytes }, [bytes])",
      'window.__dshTavernStorage',
      'Object.defineProperty(window, \'indexedDB\'',
    ]) {
      expect(script).toContain(marker)
    }
  })
})
