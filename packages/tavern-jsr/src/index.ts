/**
 * JS-Slash-Runner (TavernHelper) compatibility vocabulary.
 *
 * The iframe runtime is built from source text by `./client.ts`; this module
 * owns the values shared by both halves of the bridge: postMessage channels,
 * the event names the host can actually observe, the public surface the shim
 * installs, and the CDN globals injected before card code runs. The host-side
 * domain adapter (snapshot, variables, chat messages, lorebooks) stays in the
 * plugin because it is bound to the tavern store; this package only owns the
 * sandbox runtime contract.
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
export const HELPER_BUTTONS_MESSAGE = 'dsh-soulmojito:script-buttons'

export const HELPER_CHANNELS: HelperChannels = {
  message: HELPER_MESSAGE,
  result: HELPER_RESULT_MESSAGE,
  snapshot: HELPER_SNAPSHOT_MESSAGE,
  event: HELPER_EVENT_MESSAGE,
}

/**
 * Compatibility level this shim advertises. It tracks the JSR API generation
 * the shim implements (synchronous variable writes, script container, preset
 * reads), not the plugin release. Functions outside the implemented set still
 * throw instead of acting as silent no-ops.
 */
export const HELPER_VERSION = '4.11.3'

/**
 * No SillyTavern server sits behind the sandbox. A semver-shaped value keeps
 * `compare-versions` call sites from throwing while feature gates that need a
 * real ST host stay off.
 */
export const TAVERN_VERSION = '0.0.0'

/** Extension id JSR cards pass to the extension management helpers. */
export const HELPER_EXTENSION_ID = 'JS-Slash-Runner'

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
 * Full `tavern_events` vocabulary (JSR 4.11.3). Names are declared so card code
 * never registers `undefined`; only the subset the host can observe is ever
 * emitted (see the compat document). Declaring the rest keeps "listen for X"
 * code inert instead of throwing at registration time.
 */
export const TAVERN_EVENTS: Record<string, string> = {
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
  OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  FORCE_SET_BACKGROUND: 'force_set_background',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
  SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  OPEN_CHARACTER_LIBRARY: 'open_character_library',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  IMAGE_SWIPED: 'image_swiped',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
  SECRET_WRITTEN: 'secret_written',
  SECRET_DELETED: 'secret_deleted',
  SECRET_ROTATED: 'secret_rotated',
  SECRET_EDITED: 'secret_edited',
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_RENAMED_BEFORE: 'preset_renamed_before',
  MAIN_API_CHANGED: 'main_api_changed',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
}

export const IFRAME_EVENTS: Record<string, string> = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_REQUESTED: 'js_generation_requested',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  REASONING_TOKEN_RECEIVED_FULLY: 'js_reasoning_token_received_fully',
  REASONING_TOKEN_RECEIVED_INCREMENTALLY: 'js_reasoning_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
}

/**
 * Public `window` surface of JSR 4.11.3 (179 names: TavernHelper members plus
 * the `_bind` helpers JSR forwards to `window` with the leading underscore
 * stripped). The shim installs every implementable name and mirrors the result
 * on `window.TavernHelper`; the runtime smoke test asserts this list so the
 * surface cannot silently regress.
 */
export const TAVERN_HELPER_SURFACE: readonly string[] = [
  'appendAudioList',
  'appendInexistentScriptButtons',
  'audioEnable',
  'audioImport',
  'audioMode',
  'audioPlay',
  'audioSelect',
  'builtin',
  'builtin_prompt_default_order',
  'createCharacter',
  'createChatMessages',
  'createLorebook',
  'createLorebookEntries',
  'createLorebookEntry',
  'createOrReplaceCharacter',
  'createOrReplacePersona',
  'createOrReplacePreset',
  'createOrReplaceWorldbook',
  'createPersona',
  'createPreset',
  'createWorldbook',
  'createWorldbookEntries',
  'default_preset',
  'deleteCharacter',
  'deleteChatMessages',
  'deleteLorebook',
  'deleteLorebookEntries',
  'deleteLorebookEntry',
  'deletePersona',
  'deletePreset',
  'deleteVariable',
  'deleteWorldbook',
  'deleteWorldbookEntries',
  'errorCatched',
  'eventClearAll',
  'eventClearEvent',
  'eventClearListener',
  'eventEmit',
  'eventEmitAndWait',
  'eventMakeFirst',
  'eventMakeLast',
  'eventOn',
  'eventOnButton',
  'eventOnce',
  'eventRemoveListener',
  'formatAsDisplayedMessage',
  'formatAsTavernRegexedString',
  'generate',
  'generateRaw',
  'getAllEnabledScriptButtons',
  'getAllVariables',
  'getAudioList',
  'getAudioSettings',
  'getButtonEvent',
  'getCharacter',
  'getCharacterIds',
  'getCharacterNames',
  'getCharAvatarPath',
  'getCharData',
  'getCharLorebooks',
  'getCharWorldbookNames',
  'getChatHistoryBrief',
  'getChatHistoryDetail',
  'getChatLorebook',
  'getChatMessages',
  'getChatWorldbookName',
  'getCurrentAudio',
  'getCurrentCharacterId',
  'getCurrentCharacterName',
  'getCurrentCharPrimaryLorebook',
  'getCurrentMessageId',
  'getCurrentPersonaId',
  'getCurrentPersonaName',
  'getExtensionStatus',
  'getExtensionType',
  'getFrontendVersion',
  'getGlobalWorldbookNames',
  'getIframeName',
  'getLastMessageId',
  'getLoadedPresetName',
  'getLorebookEntries',
  'getLorebooks',
  'getLorebookSettings',
  'getMessageId',
  'getModelList',
  'getOrCreateChatLorebook',
  'getOrCreateChatWorldbook',
  'getPersona',
  'getPersonaAvatarPath',
  'getPersonaIds',
  'getPersonaNames',
  'getPreset',
  'getPresetNames',
  'getProxyPresetNames',
  'getScriptButtons',
  'getScriptId',
  'getScriptInfo',
  'getScriptName',
  'getScriptTrees',
  'getTavernHelperExtensionId',
  'getTavernHelperVersion',
  'getTavernRegexes',
  'getTavernVersion',
  'getVariables',
  'getWorldbook',
  'getWorldbookNames',
  'iframe_events',
  'importRawCharacter',
  'importRawChat',
  'importRawPreset',
  'importRawTavernRegex',
  'importRawWorldbook',
  'initializeGlobal',
  'injectPrompts',
  'insertOrAssignVariables',
  'insertVariables',
  'installExtension',
  'isAdmin',
  'isCharacterTavernRegexesEnabled',
  'isInstalledExtension',
  'isPresetNormalPrompt',
  'isPresetPlaceholderPrompt',
  'isPresetSystemPrompt',
  'loadPreset',
  'pauseAudio',
  'playAudio',
  'RawCharacter',
  'rebindCharWorldbooks',
  'rebindChatWorldbook',
  'rebindGlobalWorldbooks',
  'refreshOneMessage',
  'registerMacroLike',
  'registerVariableSchema',
  'reinstallExtension',
  'reloadIframe',
  'renamePreset',
  'replaceAudioList',
  'replaceCharacter',
  'replaceLorebookEntries',
  'replacePersona',
  'replacePreset',
  'replaceScriptButtons',
  'replaceScriptInfo',
  'replaceScriptTrees',
  'replaceTavernRegexes',
  'replaceVariables',
  'replaceWorldbook',
  'retrieveDisplayedMessage',
  'rotateChatMessages',
  'setAudioSettings',
  'setChatLorebook',
  'setChatMessage',
  'setChatMessages',
  'setCurrentCharLorebooks',
  'setLorebookEntries',
  'setLorebookSettings',
  'setPreset',
  'stopAllGeneration',
  'stopGenerationById',
  'substitudeMacros',
  'tavern_events',
  'triggerSlash',
  'triggerSlashWithResult',
  'uninjectPrompts',
  'uninstallExtension',
  'unregisterMacroLike',
  'updateCharacterWith',
  'updateExtension',
  'updateFrontendVersion',
  'updateLorebookEntriesWith',
  'updatePersonaWith',
  'updatePresetWith',
  'updateScriptButtonsWith',
  'updateScriptTreesWith',
  'updateTavernHelper',
  'updateTavernRegexesWith',
  'updateVariablesWith',
  'updateWorldbookWith',
  'waitGlobalInitialized',
]
