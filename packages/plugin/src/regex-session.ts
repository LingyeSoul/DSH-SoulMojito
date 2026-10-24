import { parseRegexScript, type RegexScriptIR } from '../../tavern-format/src/index.js'
import type { ChatRegexScriptsFile, ChatScriptsFile } from '../../tavern-store/src/index.js'
import { collectRegexScripts } from './tavern-assets.js'

/** JSR regex sources. Session writes keep the same three scopes as ST. */
export const REGEX_SCOPES = ['global', 'character', 'preset'] as const
export type RegexScope = typeof REGEX_SCOPES[number]

/** Parsed per-scope overlay. A present scope has been explicitly rewritten. */
export interface SessionRegexScripts {
  global?: RegexScriptIR[]
  character?: RegexScriptIR[]
  preset?: RegexScriptIR[]
}

/** Overlay reader seam shared by the production store and projector test stores. */
export interface SessionRegexSource {
  getChatJsrOverlay: (characterName: string, chatId: string) => Promise<ChatScriptsFile | undefined>
}

type RegexState = Parameters<typeof collectRegexScripts>[0]
type RegexCharacter = Parameters<typeof collectRegexScripts>[1]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalDepth(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function trimStringsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  if (typeof value === 'string' && value !== '') return [value]
  return []
}

/**
 * JSR `TavernRegex` uses snake_case source/destination flags while the host
 * persists `RegexScriptIR` (camelCase). Writes from card code arrive in the JSR
 * shape, so normalize both shapes through the same IR constructor.
 */
export function parseSessionRegexEntry(raw: unknown, label: string): RegexScriptIR {
  if (!isRecord(raw)) throw new Error(`${label} must be a regex script object`)
  const looksLikeTavernRegex = 'find_regex' in raw || 'script_name' in raw || 'source' in raw || 'destination' in raw
  if (!looksLikeTavernRegex) {
    try {
      return parseRegexScript(raw)
    } catch (cause) {
      throw new Error(`${label} is not a valid regex script: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }
  const findRegex = stringField(raw['find_regex']) || stringField(raw['findRegex'])
  if (findRegex === '') throw new Error(`${label} has an empty find_regex`)
  const source = isRecord(raw['source']) ? raw['source'] : undefined
  let placement: number[] = []
  if (source !== undefined) {
    const bits: Array<[string, number]> = [
      ['user_input', 1],
      ['ai_output', 2],
      ['slash_command', 3],
      ['world_info', 5],
      ['reasoning', 6],
    ]
    for (const [key, bit] of bits) if (source[key] === true) placement.push(bit)
  } else if (Array.isArray(raw['placement'])) {
    placement = raw['placement'].filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry))
  }
  // The IR executor treats an empty placement list as "no source"; JSR cards
  // almost always mean AI output when they omit source flags.
  if (placement.length === 0) placement = [2]
  const destination = isRecord(raw['destination']) ? raw['destination'] : undefined
  try {
    return parseRegexScript({
      id: stringField(raw['id']),
      scriptName: stringField(raw['script_name']) || stringField(raw['scriptName']) || `Script ${label}`,
      findRegex,
      replaceString: stringField(raw['replace_string']) || stringField(raw['replaceString']),
      trimStrings: trimStringsOf(raw['trim_strings'] ?? raw['trimStrings']),
      placement,
      disabled: raw['enabled'] === false || raw['disabled'] === true,
      markdownOnly: destination === undefined ? raw['markdownOnly'] === true : destination['display'] === false,
      promptOnly: destination === undefined ? raw['promptOnly'] === true : destination['prompt'] === false,
      runOnEdit: raw['run_on_edit'] === true || raw['runOnEdit'] === true,
      substituteRegex: raw['substitute_regex'] === true || raw['substituteRegex'] === true,
      minDepth: optionalDepth(raw['min_depth'] ?? raw['minDepth']),
      maxDepth: optionalDepth(raw['max_depth'] ?? raw['maxDepth']),
    })
  } catch (cause) {
    throw new Error(`${label} is not a valid regex script: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/** Validate a helper write payload and return canonical IR entries. */
export function parseSessionRegexList(value: unknown, label: string): RegexScriptIR[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array of regex scripts`)
  return value.map((entry, index) => parseSessionRegexEntry(entry, `${label}[${index}]`))
}

/** Parse the persisted overlay. Unknown scopes and malformed entries fail loudly. */
export function parseSessionRegexScripts(raw: ChatRegexScriptsFile | undefined): SessionRegexScripts | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) throw new Error('chat regex overlay must be an object')
  const parsed: SessionRegexScripts = {}
  for (const [scope, list] of Object.entries(raw)) {
    if (scope !== 'global' && scope !== 'character' && scope !== 'preset') {
      throw new Error(`chat regex overlay has an unsupported scope '${scope}' (expected global, character, preset)`)
    }
    if (!Array.isArray(list)) throw new Error(`chat regex overlay.${scope} must be an array of regex scripts`)
    const scripts = list.map((entry, index) => parseSessionRegexEntry(entry, `chat regex overlay.${scope}[${index}]`))
    if (scope === 'global') parsed.global = scripts
    else if (scope === 'character') parsed.character = scripts
    else parsed.preset = scripts
  }
  return parsed
}

/**
 * Overlay semantics: session entries replace base entries with the same
 * `scriptName` in place; session-only names are appended. Base scripts that the
 * session did not mention stay active (the base assets stay read-only).
 */
export function mergeRegexScriptsByName(base: readonly RegexScriptIR[], overlay: readonly RegexScriptIR[]): RegexScriptIR[] {
  const merged = [...base]
  for (const script of overlay) {
    const index = merged.findIndex((candidate) => candidate.scriptName === script.scriptName)
    if (index >= 0) merged[index] = script
    else merged.push(script)
  }
  return merged
}

/** Merge every present overlay scope over the effective base list. */
export function mergeSessionRegexScripts(base: readonly RegexScriptIR[], overlay: SessionRegexScripts | undefined): RegexScriptIR[] {
  if (overlay === undefined) return [...base]
  let merged = [...base]
  for (const scope of REGEX_SCOPES) {
    const scripts = overlay[scope]
    if (scripts !== undefined) merged = mergeRegexScriptsByName(merged, scripts)
  }
  return merged
}

/** Read and parse this chat's regex overlay (undefined when it was never written). */
export async function readSessionRegexScripts(
  db: SessionRegexSource,
  characterName: string,
  chatId: string,
): Promise<SessionRegexScripts | undefined> {
  // No chat means no session scope: callers fall back to the base assets. Every
  // bound helper/generation/display call passes a real chatId.
  if (chatId === '') return undefined
  const overlay = await db.getChatJsrOverlay(characterName, chatId)
  return parseSessionRegexScripts(overlay?.regexScripts)
}

/**
 * Effective regex list for generation/display: base ownership filtering plus
 * the session overlay. `characterName` addresses the chat directory (a group
 * name in group chats), while `character` is the speaker's card.
 */
export async function collectSessionRegexScripts(
  db: SessionRegexSource,
  state: RegexState,
  characterName: string,
  chatId: string,
  character?: RegexCharacter,
): Promise<RegexScriptIR[]> {
  const base = collectRegexScripts(state, character)
  const overlay = await readSessionRegexScripts(db, characterName, chatId)
  return mergeSessionRegexScripts(base, overlay)
}

/** JSR `TavernRegex` view (snake_case) used by the helper read surface. */
export function toTavernRegexEntry(script: RegexScriptIR): Record<string, unknown> {
  const has = (placement: number): boolean => script.placement.length === 0 || script.placement.includes(placement)
  return {
    id: script.id,
    script_name: script.scriptName,
    enabled: !script.disabled,
    run_on_edit: script.runOnEdit,
    find_regex: script.findRegex,
    replace_string: script.replaceString,
    trim_strings: [...script.trimStrings],
    source: {
      user_input: has(1),
      ai_output: has(2),
      slash_command: has(3),
      world_info: has(5),
      reasoning: has(6),
    },
    destination: {
      display: !script.promptOnly,
      prompt: !script.markdownOnly,
    },
    min_depth: script.minDepth,
    max_depth: script.maxDepth,
    substitute_regex: script.substituteRegex,
  }
}
