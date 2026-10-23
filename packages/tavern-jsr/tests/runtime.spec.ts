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
import { HELPER_VERSION, IFRAME_EVENTS, TAVERN_EVENTS, TAVERN_HELPER_SURFACE } from '../src/index.js'
import * as clientEntry from '../src/client.js'
import { buildIframeScript, helperLibraryTags } from '../src/client.js'
import { iframeSources } from '../../tavern-frontend-storage/src/client.js'

interface PostedMessage {
  type: string
  token: string
  id: string
  op: string
}

interface SandboxWindow extends Record<string, unknown> {
  dispatch(event: { type: string; data?: unknown }): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

function makeSandbox(posted: PostedMessage[]): Record<string, unknown> {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const add = (type: string, listener: (event: unknown) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)?.add(listener)
  }
  const remove = (type: string, listener: (event: unknown) => void) => {
    listeners.get(type)?.delete(listener)
  }
  const dispatch = (event: { type: string; data?: unknown }) => {
    for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event)
  }
  const parent = {
    postMessage: (message: PostedMessage) => { posted.push(message) },
  }
  const document = {
    addEventListener: add,
    removeEventListener: remove,
    dispatchEvent: () => true,
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild: () => undefined, remove: () => undefined }),
    body: null,
    documentElement: null,
  }
  class TestCustomEvent {
    type: string
    detail: unknown
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type
      this.detail = init?.detail
    }
  }
  const window: SandboxWindow & Record<string, unknown> = {
    parent,
    document,
    addEventListener: add,
    removeEventListener: remove,
    dispatchEvent: dispatch,
    dispatch,
    CustomEvent: TestCustomEvent,
    Event: TestCustomEvent,
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    location: { reload: () => undefined },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    matchMedia: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({}),
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
    cancelAnimationFrame: () => undefined,
    __tests: { dispatch, listeners },
  }
  window.window = window
  return {
    window,
    parent,
    document,
    console,
    setTimeout,
    clearTimeout,
    addEventListener: add,
    removeEventListener: remove,
    dispatchEvent: dispatch,
    CustomEvent: TestCustomEvent,
    Event: TestCustomEvent,
    navigator: { language: 'zh-CN', clipboard: undefined },
  }
}

function feedSnapshot(window: SandboxWindow, token: string, snapshot: Record<string, unknown>): void {
  window.dispatch({
    type: 'message',
    data: { type: 'dsh-soulmojito:helper-snapshot', token, snapshot },
  })
}

function baseSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    characterName: 'ExampleChar',
    characterId: 0,
    userName: 'ExampleUser',
    personaDescription: '',
    chatId: 'ExampleChat.jsonl',
    chatMetadata: {},
    messages: [],
    messageCount: 0,
    lastMessageId: -1,
    variables: { global: {}, chat: {}, message: {}, character: {} },
    characterData: null,
    scriptTrees: null,
    scriptTreesByType: { character: null, preset: null, global: null },
    presets: { names: [], active: null, values: {} },
    personas: { names: [], ids: [], active: null, values: {} },
    characters: { names: ['ExampleChar'], ids: ['0'] },
    regexScripts: { global: [], character: [], preset: [] },
    scriptVariables: {},
    worlds: { names: [], active: [], char: { primary: null, additional: [] }, chat: null },
    avatar: '',
    ...overrides,
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
      iframeSources(), null)
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

  it('installs MVU merged variables, a debounce-safe SillyTavern and the host facade', () => {
    const posted: PostedMessage[] = []
    const script = buildIframeScript('probe-token', -1, '{}', iframeSources(), null)
    const sandbox = makeSandbox(posted)
    ;(sandbox.window as Record<string, unknown>).Function = Function
    vm.runInNewContext(script, sandbox)
    const window = sandbox.window as Record<string, unknown> & {
      getAllVariables(): Record<string, unknown>
      Mvu: { getAllVariables(): Record<string, unknown> }
      SillyTavern: Record<string, unknown>
      top: { Function: unknown; URL: unknown }
    }
    expect(typeof window.getAllVariables).toBe('function')
    expect(typeof window.Mvu.getAllVariables).toBe('function')
    expect(typeof window.SillyTavern.saveChat).toBe('function')
    expect(typeof window.SillyTavern.saveSettingsDebounced).toBe('function')
    expect(typeof window.SillyTavern.extensionSettings).toBe('object')
    expect(typeof window.SillyTavern.loadWorldInfo).toBe('function')
    expect(typeof (window.SillyTavern.saveChat() as Promise<unknown>).then).toBe('function')
    expect(typeof window.top.Function).toBe('function')
  })

  it('installs the YAML compatibility surface for MVU module load', () => {
    const posted: PostedMessage[] = []
    const script = buildIframeScript('probe-token', -1, '{}', iframeSources(), null)
    const sandbox = makeSandbox(posted)
    ;(sandbox.window as Record<string, unknown>).YAML = {
      parse: (text: string) => JSON.parse(text),
      stringify: (value: unknown) => JSON.stringify(value),
    }
    vm.runInNewContext(script, sandbox)
    const window = sandbox.window as Record<string, unknown> & {
      YAML: { parseDocument(text: string): { toJS(): unknown } }
    }
    expect(typeof window.YAML.parseDocument).toBe('function')
    expect(window.YAML.parseDocument('{"a":1}').toJS()).toEqual({ a: 1 })

    const fallbackSandbox = makeSandbox([])
    vm.runInNewContext(script, fallbackSandbox)
    const fallback = fallbackSandbox.window as Record<string, unknown> & {
      YAML: { parse(text: string): unknown; parseDocument(text: string): { toJS(): unknown } }
    }
    expect(typeof fallback.YAML.parseDocument).toBe('function')
    expect(fallback.YAML.parse('{"b":2}')).toEqual({ b: 2 })
  })

  it('runs window.generate without leaking module-scope event names', () => {
    const posted: PostedMessage[] = []
    const script = buildIframeScript('probe-token', -1, '{}', iframeSources(), null)
    const sandbox = makeSandbox(posted)
    vm.runInNewContext(script, sandbox)
    const window = sandbox.window as Record<string, unknown> & {
      generate(config: unknown): Promise<string>
    }
    expect(() => {
      void window.generate({
        custom_api: { apiurl: 'https://example.test/v1', model: 'probe' },
        user_input: 'ping',
      })
    }).not.toThrow()
    expect(posted.some((message) => message.op === 'generate')).toBe(true)
  })

  it('keeps the JSR globals and generation bridge in the emitted source', () => {
    const script = buildIframeScript('probe-token', -1, '{}', iframeSources(), null)
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

  function boot(identity: { scriptId: string; scriptName: string; scriptInfo: string } | null, snapshot: Record<string, unknown> | null) {
    const posted: PostedMessage[] = []
    const script = buildIframeScript('probe-token', 3, '{}', iframeSources(), identity)
    const sandbox = makeSandbox(posted)
    vm.runInNewContext(script, sandbox)
    const window = sandbox.window as SandboxWindow & Record<string, unknown> & {
      TavernHelper: Record<string, unknown>
      substitudeMacros(text: string): string
      replaceVariables(variables: Record<string, unknown>, option?: unknown): unknown
      updateVariablesWith(updater: (variables: Record<string, unknown>) => Record<string, unknown>, option?: unknown): unknown
      deleteVariable(path: string, option?: unknown): { variables: Record<string, unknown>; delete_occurred: boolean }
      getTavernRegexes(option: unknown): Array<Record<string, unknown>>
      formatAsTavernRegexedString(text: string, source: unknown, destination?: unknown, option?: unknown): string
      SillyTavern: { getContext(): Record<string, any> }
      getAllEnabledScriptButtons(): Record<string, Array<{ button_id: string; button_name: string }>>
      eventEmit(type: string, ...args: unknown[]): Promise<void>
      registerMacroLike(name: string, handler: (value?: unknown) => unknown): { unregister(): void }
    }
    if (snapshot !== null) feedSnapshot(window, 'probe-token', snapshot)
    return { window, posted }
  }

  it('installs every JSR 4.11 public name on window and TavernHelper', () => {
    const { window } = boot(null, null)
    expect(HELPER_VERSION).toBe('4.11.3')
    expect(Object.keys(TAVERN_EVENTS)).toHaveLength(82)
    expect(Object.keys(IFRAME_EVENTS)).toHaveLength(9)
    for (const name of TAVERN_HELPER_SURFACE) {
      expect(window[name], name).toBeDefined()
      expect(window.TavernHelper[name], name).toBe(window[name])
    }
  })

  it('returns variable writes synchronously with the JSR shapes', () => {
    const { window } = boot(null, baseSnapshot({ variables: { global: {}, chat: { a: 1 }, message: {}, character: {} } }))
    expect(window.replaceVariables({ b: 2 }, { type: 'chat' })).toBeUndefined()
    expect(window.updateVariablesWith((variables) => ({ ...variables, a: 5 }), { type: 'chat' })).toEqual({ b: 2, a: 5 })
    const removed = window.deleteVariable('a', { type: 'chat' })
    expect(removed.delete_occurred).toBe(true)
    expect(removed.variables).toEqual({ b: 2 })
  })

  it('expands ST macros locally, including registered macro-likes', () => {
    const { window } = boot(null, baseSnapshot({
      messages: [{ message_id: 0, name: 'ExampleChar', role: 'assistant', is_hidden: false, message: 'hi', data: {}, extra: {}, swipe_id: 0, swipes: ['hi'] }],
      variables: { global: {}, chat: { affection: 7 }, message: {}, character: {} },
      characterData: { description: 'desc', personality: 'kind' },
    }))
    expect(window.substitudeMacros('{{char}}/{{user}}/{{lastMessageId}}/{{getvar::affection}}')).toBe('ExampleChar/ExampleUser/0/7')
    expect(window.substitudeMacros('{{unknown}}')).toBe('{{unknown}}')
    window.registerMacroLike('shout', (value: string) => String(value).toUpperCase())
    expect(window.substitudeMacros('{{shout::ok}}')).toBe('OK')
  })

  it('applies the JSR regex signature synchronously with source/destination filters', () => {
    const script = (overrides: Record<string, unknown>) => ({
      id: 'r1', scriptName: 'Strip', findRegex: '/bad/gi', replaceString: 'good', trimStrings: [],
      placement: [2], disabled: false, markdownOnly: false, promptOnly: false, minDepth: null, maxDepth: null,
      runOnEdit: false, substituteRegex: false, ...overrides,
    })
    const { window } = boot(null, baseSnapshot({
      regexScripts: {
        global: [script({}), script({ id: 'r2', scriptName: 'PromptOnly', findRegex: '/good/gi', replaceString: 'PROMPT', promptOnly: true })],
        character: [],
        preset: [],
      },
    }))
    const regexes = window.getTavernRegexes({ type: 'global' })
    expect(regexes).toHaveLength(2)
    expect(regexes[0]).toMatchObject({ script_name: 'Strip', enabled: true })
    expect((regexes[0].source as Record<string, boolean>).ai_output).toBe(true)
    expect(window.formatAsTavernRegexedString('bad text', 'ai_output', 'display')).toBe('good text')
    expect(window.formatAsTavernRegexedString('bad text', 'ai_output', 'prompt')).toBe('PROMPT text')
    expect(window.formatAsTavernRegexedString('bad text', 2)).toBe('good text')
  })

  it('exposes an ST-shaped chat and eventSource through SillyTavern', async () => {
    const { window } = boot(null, baseSnapshot({
      messages: [{ message_id: 0, name: 'ExampleChar', role: 'assistant', is_hidden: false, message: 'hello', data: { mood: 'calm' }, extra: {}, swipe_id: 0, swipes: ['hello'] }],
    }))
    const context = window.SillyTavern.getContext()
    expect(context.chat[0].mes).toBe('hello')
    expect(context.chat[0].is_user).toBe(false)
    expect(context.chat[0].swipes).toEqual(['hello'])
    expect(context.eventTypes.MESSAGE_SENT).toBe('message_sent')
    let seen = 0
    context.eventSource.on('probe-event', () => { seen += 1 })
    await window.eventEmit('probe-event', 1)
    expect(seen).toBe(1)
  })

  it('gives script-container iframes an identity, info persistence and button aggregation', () => {
    const tree = [{
      type: 'script', id: 'panel', name: 'GM', content: 'void 0', enabled: true, info: '{"x":1}',
      button: { enabled: true, buttons: [{ name: '打开', visible: true }, { name: '隐藏', visible: false }] },
    }]
    const { window, posted } = boot(
      { scriptId: 'panel', scriptName: 'GM', scriptInfo: '{"x":1}' },
      baseSnapshot({ scriptTreesByType: { character: tree, preset: null, global: null }, scriptTrees: tree }),
    )
    expect(window.getScriptId()).toBe('panel')
    expect(window.getScriptName()).toBe('GM')
    expect(window.getScriptInfo()).toBe('{"x":1}')
    const buttons = window.getAllEnabledScriptButtons()
    expect(buttons.panel).toHaveLength(1)
    expect(buttons.panel[0].button_name).toBe('打开')
    window.replaceScriptInfo('{"y":2}')
    expect(window.getScriptInfo()).toBe('{"y":2}')
    expect(posted.some((message) => message.op === 'scripts.patch')).toBe(true)
  })
})
