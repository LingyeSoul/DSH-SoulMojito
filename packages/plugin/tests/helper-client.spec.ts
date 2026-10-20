/**
 * 酒馆助手兼容层与自动展开开关的客户端源码检查（2026-10-20）：iframe 侧
 * shim 的 TavernHelper 面、宿主侧代理的 token/绑定纪律、事件广播数据源，
 * 以及「自动展开 tab」必须由设置开关门控（默认关闭、无开关时不轮询）。
 * 复用 games-client.spec.ts 的 main.js source-check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../client/main.js'), 'utf8')
const zh = readFileSync(join(here, '../client-src/41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(here, '../client-src/40-i18n-en.js'), 'utf8')
const store = readFileSync(join(here, '../../tavern-store/src/store.ts'), 'utf8')
const compatDoc = readFileSync(join(here, '../../../docs/frontend/tavern-helper-compat.md'), 'utf8')

describe('TavernHelper compatibility layer (main.js source check)', () => {
  it('defines the iframe-side TavernHelper surface', () => {
    for (const marker of [
      "const HELPER_MESSAGE = 'dsh-soulmojito:helper'",
      "const HELPER_RESULT_MESSAGE = 'dsh-soulmojito:helper-result'",
      "const HELPER_SNAPSHOT_MESSAGE = 'dsh-soulmojito:helper-snapshot'",
      'function frontendHelperScript(token)',
      'window.getVariables = function',
      'window.replaceVariables = function',
      'window.updateVariablesWith = function',
      'window.insertOrAssignVariables = function',
      'window.deleteVariable = function',
      'window.getChatMessages = function',
      'window.setChatMessages = function',
      'window.createChatMessages = function',
      'window.deleteChatMessages = function',
      'window.eventOn = function',
      'window.tavern_events =',
      'window.SillyTavern = {',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('keeps the sandbox and proxies through the host binding', () => {    expect(source).toContain("sandbox: 'allow-scripts'")
    expect(source).toContain("connect-src 'none'")
    expect(source).toContain('function useHelperBridge(frameRef, token, binding, refreshKey)')
    expect(source).toContain("if (event.source !== frameRef.current?.contentWindow) return")
    expect(source).toContain("data.token !== token")
    expect(source).toContain('this frontend is not bound to a Tavern chat')
    // 绑定只能来自宿主侧 sessionBindings，iframe 报什么都不能改身份
    expect(source).toContain("op: data.op,\n              character: current.character,\n              chatId: current.chatId")
  })

  it('broadcasts only signals the host can actually observe', () => {
    expect(source).toContain('const HELPER_TAVERN_EVENTS = {')
    expect(source).toContain('const HELPER_IFRAME_EVENTS = {')
    expect(source).toContain('HELPER_TAVERN_EVENTS.MESSAGE_RECEIVED')
    expect(source).toContain('HELPER_TAVERN_EVENTS.MESSAGE_EDITED')
    expect(source).toContain('HELPER_TAVERN_EVENTS.CHAT_CHANGED')
    expect(source).toContain('HELPER_IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED')
    expect(source).toContain("const HELPER_EVENT_MESSAGE = 'dsh-soulmojito:helper-event'")
  })

  it('gates auto-open behind the frontendAutoOpen setting', () => {
    expect(source).toContain('function useFrontendAutoOpen(sessionId, binding, architecture, enabled)')
    expect(source).toContain("if (!enabled || !binding || architecture !== 'agent-tavern') return undefined")
    expect(source).toContain('useFrontendAutoOpen(sessionId, binding, architecture, state.bootstrap.state.frontendAutoOpen === true)')
    expect(source).toContain('checked: bootstrap.state.frontendAutoOpen === true')
    expect(store).toContain('frontendAutoOpen: boolean')
    expect(store).toContain('frontendAutoOpen: false')
    expect(store).toContain('frontendAutoOpen: parsed.frontendAutoOpen === true')
  })

  it('ships the setting label in both dictionaries', () => {
    expect(zh).toContain("'settings.frontendAutoOpen'")
    expect(en).toContain("'settings.frontendAutoOpen'")
  })

  it('documents every exported helper with an availability verdict', () => {
    // 文档必须覆盖实现的每个出口：加函数不改文档 = 文档立刻过期。
    const exported = [
      'getVariables', 'replaceVariables', 'updateVariablesWith', 'insertOrAssignVariables',
      'insertVariables', 'deleteVariable', 'getChatMessages', 'getLastMessageId',
      'setChatMessages', 'createChatMessages', 'deleteChatMessages', 'eventOn', 'eventOnce',
      'eventEmit', 'eventEmitAndWait', 'eventMakeFirst', 'eventMakeLast',
      'eventRemoveListener', 'eventClearEvent', 'eventClearListener', 'eventClearAll',
      'getLorebook', 'getWorldbook', 'getLorebookNames', 'getWorldbookNames',
      'getGlobalWorldbookNames', 'getCharNames', 'getCharacterNames',
      'getChatWorldbookNames', 'getTavernRegexes', 'formatAsTavernRegexedString',
      'triggerSlash', 'substitudeMacros', 'getTavernHelperVersion', 'getTavernVersion',
      'getButtonEvent', 'getScriptId', 'waitGlobalInitialized',
    ]
    for (const name of exported) {
      expect(source).toContain(`window.${name}`)
      expect(compatDoc).toContain(`\`${name}`)
    }
    // 文档必须同时给出可用与不可用的判定，不能只写好消息。
    for (const verdict of ['✅', '⚠️', '❌', '🧱']) expect(compatDoc).toContain(verdict)
    // 结构性不可用的三件事必须点明。
    for (const blocked of ['connect-src', 'frame-src', 'allow-same-origin']) expect(compatDoc).toContain(blocked)
  })

  it('documents that only observable events fire, with the exact set', () => {
    for (const event of [
      'app_ready', 'message_sent', 'message_received', 'message_edited',
      'message_deleted', 'chat_id_changed', 'message_iframe_render_started',
      'message_iframe_render_ended',
    ]) {
      expect(compatDoc).toContain(event)
    }
    expect(compatDoc).toContain('永远不会被触发')
  })
})
