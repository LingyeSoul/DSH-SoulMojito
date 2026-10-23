/**
 * Frontend generation world-info context (2026-10-23).
 *
 * JSR cards may pass scan-only extension prompts (`position: 'none'`,
 * `should_scan: true`). SillyTavern scans the active world books with that text
 * and injects the activated entries; this bridge previously dropped the
 * prompts, so cards that keep their response contract in a world book received
 * no format instructions. This module resolves the same chat world books
 * (session copy first) and folds the activated entries into the request as a
 * normal system inject.
 *
 * Read-only: no base world book or card asset is written. The session copy is
 * the same one normal generation reads.
 */
import { activateWorldInfo, WI_POSITION } from '../../tavern-lore/src/index.js'
import type { ActivationResult } from '../../tavern-lore/src/index.js'
import type { TavernState, TavernStore } from '../../tavern-store/src/index.js'
import { collectWorldInfoBooks } from './tavern-assets.js'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/** Scan source: explicit scanKeywords plus scan-only inject contents. */
function scanTextOf(config: JsonObject): string {
  const parts: string[] = stringsOf(config['scanKeywords'])
  const injects = Array.isArray(config['injects']) ? config['injects'] : []
  for (const raw of injects) {
    const inject = asObject(raw)
    if (inject === undefined || inject['should_scan'] !== true) continue
    const content = inject['content']
    if (typeof content === 'string' && content.trim() !== '') parts.push(content)
  }
  return [...new Set(parts.map((part) => part.trim()).filter((part) => part !== ''))].join('\n')
}

function isScanOnlyInject(value: unknown): boolean {
  const inject = asObject(value)
  return inject !== undefined && inject['should_scan'] === true && inject['position'] === 'none'
}

/** Activated entries in assembly order, excluding named outlets (never auto-injected). */
function activatedContent(lore: ActivationResult): string[] {
  const seen = new Set<string>()
  const parts: string[] = []
  for (const entry of lore.allActivated) {
    if (entry.position === WI_POSITION.OUTLET) continue
    const text = entry.content.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    parts.push(text)
  }
  return parts
}

/**
 * Resolve scan-only frontend prompts against the chat's active world books and
 * return a new GenerateConfig with the activated entries prepended as a system
 * inject. The input config is never mutated. No scan trigger, no bound card or
 * no activated entry means the config is returned unchanged.
 */
export async function applyFrontendWorldbookScan(
  db: TavernStore,
  state: TavernState,
  character: string,
  chatId: string,
  config: unknown,
): Promise<unknown> {
  const record = asObject(config)
  if (record === undefined) return config
  const scanText = scanTextOf(record)
  if (scanText === '' || chatId === '') return config
  const file = await db.getCharacter(character)
  if (file === undefined) return config
  const books = await collectWorldInfoBooks(db, state, character, file, chatId)
  if (books.length === 0) return config
  const persona = state.activePersona === undefined ? undefined : await db.getPersona(state.activePersona)
  const lore = activateWorldInfo({
    books,
    chat: [{ name: 'user', content: scanText, isUser: true }],
    contextSize: 4096,
    trigger: 'normal',
    scanSources: {
      personaDescription: typeof persona?.['description'] === 'string' ? persona['description'] : undefined,
      characterDescription: file.card.data.description,
      characterPersonality: file.card.data.personality,
      scenario: file.card.data.scenario,
      creatorNotes: file.card.data.creatorNotes,
    },
    settings: { recursive: true, scanDepth: 2, budgetPercent: 25 },
    messageCount: 1,
  })
  const content = activatedContent(lore).join('\n\n')
  if (content === '') return config
  const injects = Array.isArray(record['injects']) ? record['injects'] : []
  return {
    ...record,
    injects: [
      { role: 'system', content, position: 'in_chat', depth: 0 },
      ...injects.filter((inject) => !isScanOnlyInject(inject)),
    ],
  }
}
