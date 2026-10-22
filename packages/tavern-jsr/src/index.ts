/**
 * JS-Slash-Runner (TavernHelper) compatibility vocabulary.
 *
 * The iframe runtime is built from source text by `./client.ts`; this module
 * owns the values shared by both halves of the bridge: postMessage channels,
 * the event names the host can actually observe, and the CDN globals injected
 * before card code runs. The host-side domain adapter (snapshot, variables,
 * chat messages, lorebooks) stays in the plugin because it is bound to the
 * tavern store; this package only owns the sandbox runtime contract.
 */

/** The four postMessage channel names used by the iframe bridge. */
export interface HelperChannels {
  message: string
  result: string
  snapshot: string
  event: string
}

export const HELPER_MESSAGE = 'dsh-soulmojito:helper'
export const HELPER_RESULT_MESSAGE = 'dsh-soulmojito:helper-result'
export const HELPER_SNAPSHOT_MESSAGE = 'dsh-soulmojito:helper-snapshot'
export const HELPER_EVENT_MESSAGE = 'dsh-soulmojito:helper-event'

export const HELPER_CHANNELS: HelperChannels = {
  message: HELPER_MESSAGE,
  result: HELPER_RESULT_MESSAGE,
  snapshot: HELPER_SNAPSHOT_MESSAGE,
  event: HELPER_EVENT_MESSAGE,
}

// JSR's message iframe loads Vue/Vue Router before card code; Vue SFC bundles
// commonly mark Vue as external and read the global. lodash/jQuery/showdown are
// the same libraries JSR ships. Versions are pinned on purpose.
export const HELPER_LIBRARIES = [
  'https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js',
  'https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js',
  // The bundled showdown build exposes the global used by builtin.renderMarkdown.
  'https://cdn.jsdelivr.net/npm/showdown@2.1.0/dist/showdown.min.js',
  // MagVarUpdate's filter language reads a global `YAML` (parse / stringify /
  // parseDocument); yamljs is the classic-script build that exposes it before
  // card modules execute. The shim adds the parseDocument().toJS() shape.
  'https://cdn.jsdelivr.net/npm/yamljs@0.3.0/dist/yaml.min.js',
  'https://cdn.jsdelivr.net/npm/vue@3.5.40/dist/vue.runtime.global.prod.min.js',
  'https://cdn.jsdelivr.net/npm/vue-router@4.6.4/dist/vue-router.global.prod.min.js',
]

// Zod 4 has no UMD build; mirror JSR by exposing the module namespace as `z`
// (both `z.object` and the `z.z` alias used by mvu_zod.js keep working).
export const HELPER_ZOD_MODULE = '<script type="module">'
  + "import * as z from 'https://cdn.jsdelivr.net/npm/zod@4.4.3/+esm';"
  + 'window.z = z;'
  + '</script>'

/**
 * The observable subset of `tavern_events`. Names outside this set still exist
 * in the runtime so card code never registers `undefined`, but the host never
 * emits them: inventing signals would leave "wait for event" UIs stuck forever.
 */
export const TAVERN_EVENTS: Record<string, string> = {
  APP_READY: 'app_ready',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_SWIPED: 'message_swiped',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_STARTED: 'generation_started',
  GENERATION_ENDED: 'generation_ended',
  // No real token stream exists; the host sends the final text once, but keeps
  // the name so `eventOn(tavern_events.STREAM_TOKEN_RECEIVED, …)` never throws.
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
}

export const IFRAME_EVENTS: Record<string, string> = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
}
