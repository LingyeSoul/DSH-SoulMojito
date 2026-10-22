/**
 * Per-character virtual localStorage persistence.
 *
 * The iframe shim keeps a memory table and debounces writes into the
 * `storage.set` helper op; the host half validates the table and stores it in
 * the tavern state. Limits are counted in characters (key + value), which is
 * what the card author can reason about without knowing UTF-8 widths.
 */
import type { TavernState, TavernStore } from '@dsh-soulmojito/store'

export const FRONTEND_STORAGE_TOTAL_LIMIT = 512 * 1024
export const FRONTEND_STORAGE_KEY_LIMIT = 512

type FrontendStorageState = Pick<TavernState, 'frontendStorage'>

export function frontendStorageFor(state: FrontendStorageState, character: string): Record<string, string> {
  const storage = state.frontendStorage?.[character]
  return storage === undefined ? {} : { ...storage }
}

export function parseFrontendStorageValue(character: string, value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('storage must be an object of string values')
  }
  const storage: Record<string, string> = {}
  let total = 0
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`storage["${key}"] must be a string`)
    if (key === '' || key.length > FRONTEND_STORAGE_KEY_LIMIT) {
      throw new Error(`storage keys must be 1-${FRONTEND_STORAGE_KEY_LIMIT} characters (got ${key.length})`)
    }
    total += key.length + entry.length
    if (total > FRONTEND_STORAGE_TOTAL_LIMIT) {
      throw new Error(`frontend storage for '${character}' exceeds ${FRONTEND_STORAGE_TOTAL_LIMIT} characters`)
    }
    storage[key] = entry
  }
  return storage
}

export async function putFrontendStorage(
  db: Pick<TavernStore, 'updateState'>,
  character: string,
  value: unknown,
): Promise<{ storage: Record<string, string> }> {
  const storage = parseFrontendStorageValue(character, value)
  const next = await db.updateState((state) => ({
    frontendStorage: { ...(state.frontendStorage ?? {}), [character]: storage },
  }))
  return { storage: frontendStorageFor(next, character) }
}

export async function resetFrontendStorage(
  db: Pick<TavernStore, 'updateState'>,
  character: string,
): Promise<{ storage: Record<string, string>; reset: true }> {
  const next = await db.updateState((state) => {
    const all = { ...(state.frontendStorage ?? {}) }
    delete all[character]
    return { frontendStorage: all }
  })
  return { storage: frontendStorageFor(next, character), reset: true }
}
