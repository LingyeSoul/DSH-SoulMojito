/**
 * Variable Gateway: the single policy owner for variable read/merge/write
 * semantics (decision 2026-11-02-variable-gateway). It is not a fourth store;
 * `chat_metadata.variables`, the flat chat-scope `VariableStore` and
 * `state.json` remain the adapters. Undo lands in Phase 2.
 */
import type { JsonValue, TavernSessionBinding, TavernStore, VariableStore } from '../../tavern-store/src/index.js'
import { isChatRevisionConflict } from '../../tavern-store/src/index.js'
import { overlayChatScopedVariables, readChatVariables } from './mvu.js'
import {
  normalizeVariableTree,
  variableEntriesForMirror,
  type VariableTree,
} from './variable-merge.js'

export type { VariableTree } from './variable-merge.js'

export type VariableRef =
  | { readonly kind: 'chat'; readonly character: string; readonly chatId: string }
  | { readonly kind: 'character'; readonly character: string }
  | { readonly kind: 'global' }

export type MirrorOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'degraded'; readonly reason: string }
  | { readonly status: 'not-applicable' }

export interface VariableWriteReceipt {
  /** Chat save revision; absent for character/global state writes. */
  readonly revision?: string
  /** Chat floor count at the save; absent for character/global state writes. */
  readonly floorCount?: number
  readonly mirror: MirrorOutcome
}

export interface VariableGatewayLogger {
  readonly warn: (message: string, fields: Record<string, JsonValue>) => void
}

export interface VariableGatewayDeps {
  readonly store: () => Promise<TavernStore>
  readonly variables: () => Promise<VariableStore>
  readonly bindingOf: (character: string, chatId: string) => Promise<TavernSessionBinding | undefined>
  readonly logger: VariableGatewayLogger
}

export interface VariableGateway {
  read(ref: VariableRef): Promise<VariableTree>
  replace(ref: VariableRef, tree: VariableTree): Promise<VariableWriteReceipt>
  mirror(ref: Extract<VariableRef, { readonly kind: 'chat' }>, tree: VariableTree): Promise<MirrorOutcome>
}

export function createVariableGateway(deps: VariableGatewayDeps): VariableGateway {
  return {
    async read(ref: VariableRef): Promise<VariableTree> {
      if (ref.kind === 'chat') return readChat(deps, ref.character, ref.chatId)
      if (ref.kind === 'character') return readCharacter(deps, ref.character)
      return readGlobal(deps)
    },
    async replace(ref: VariableRef, tree: VariableTree): Promise<VariableWriteReceipt> {
      if (ref.kind === 'chat') return replaceChat(deps, ref.character, ref.chatId, tree)
      if (ref.kind === 'character') return replaceCharacter(deps, ref.character, tree)
      return replaceGlobal(deps, tree)
    },
    async mirror(ref: Extract<VariableRef, { readonly kind: 'chat' }>, tree: VariableTree): Promise<MirrorOutcome> {
      const normalized = normalizeVariableTree(tree, `mirror variables for '${ref.character}/${ref.chatId}'`)
      try {
        const snapshot = await (await deps.store()).getChatSnapshot(ref.character, ref.chatId)
        if (snapshot === undefined) return { status: 'degraded', reason: `chat '${ref.chatId}' not found` }
        return await mirrorChat(deps, ref.character, ref.chatId, normalized, upsertMirrorWrite)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        deps.logger.warn('variable gateway chat probe failed', { character: ref.character, chatId: ref.chatId, reason })
        return { status: 'degraded', reason }
      }
    },
  }
}

/**
 * The gateway owns the trust boundary, so a binding only counts when it names
 * the same character AND chatId. This is the helper.ts:816 regression fix; an
 * injected `bindingOf` that returns a chatId-only match is still rejected.
 */
async function isAgentTavernBound(deps: VariableGatewayDeps, character: string, chatId: string): Promise<boolean> {
  const binding = await deps.bindingOf(character, chatId)
  return binding !== undefined
    && binding.architecture === 'agent-tavern'
    && binding.character === character
    && binding.chatId === chatId
}

async function readChat(deps: VariableGatewayDeps, character: string, chatId: string): Promise<VariableTree> {
  const snapshot = await (await deps.store()).getChatSnapshot(character, chatId)
  if (snapshot === undefined) throw new Error(`chat '${chatId}' not found`)
  const base = normalizeVariableTree(readChatVariables(snapshot.chat), `chat_metadata.variables for '${character}/${chatId}'`)
  if (!await isAgentTavernBound(deps, character, chatId)) return base
  const scoped = await (await deps.variables()).listAll('chat', chatId)
  return normalizeVariableTree(
    overlayChatScopedVariables(base, scoped.map((entry) => ({ name: entry.name, value: entry.value }))),
    `overlaid chat variables for '${character}/${chatId}'`,
  )
}

async function readCharacter(deps: VariableGatewayDeps, character: string): Promise<VariableTree> {
  const store = await deps.store()
  const state = await store.getState()
  const overlays = state.characterVariables ?? {}
  if (Object.prototype.hasOwnProperty.call(overlays, character)) {
    return normalizeVariableTree(overlays[character], `characterVariables['${character}']`)
  }
  const file = await store.getCharacter(character)
  if (file === undefined) return {}
  const cardVariables = file.card.data.extensions?.['variables']
  if (cardVariables === undefined || cardVariables === null) return {}
  return normalizeVariableTree(cardVariables, `card extensions.variables for '${character}'`)
}

async function readGlobal(deps: VariableGatewayDeps): Promise<VariableTree> {
  const state = await (await deps.store()).getState()
  return normalizeVariableTree(state.scriptGlobals, 'state.scriptGlobals')
}

/**
 * Chat JSONL stays authoritative. A missing snapshot fails; a CAS conflict
 * re-reads and reapplies the whole tree (never a blind write). The flat mirror
 * runs after the save and degrades to an observable receipt instead of
 * failing the primary write.
 */
async function replaceChat(
  deps: VariableGatewayDeps,
  character: string,
  chatId: string,
  tree: VariableTree,
): Promise<VariableWriteReceipt> {
  const normalized = normalizeVariableTree(tree, `variables for '${character}/${chatId}'`)
  const saved = await saveChatWithRetry(await deps.store(), character, chatId, normalized)
  const mirror = await mirrorChat(deps, character, chatId, normalized, replaceMirrorWrite)
  return { revision: saved.revision, floorCount: saved.floorCount, mirror }
}

async function saveChatWithRetry(
  store: TavernStore,
  character: string,
  chatId: string,
  tree: VariableTree,
): Promise<{ readonly revision: string; readonly floorCount: number }> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await store.getChatSnapshot(character, chatId)
    if (snapshot === undefined) throw new Error(`chat '${chatId}' not found`)
    if (Object.keys(tree).length > 0) snapshot.chat.header.chat_metadata.variables = tree
    else delete snapshot.chat.header.chat_metadata.variables
    try {
      const revision = await store.saveChat(character, chatId, snapshot.chat, snapshot.revision)
      return { revision, floorCount: snapshot.chat.messages.length }
    } catch (error) {
      if (!isChatRevisionConflict(error)) throw error
      lastError = error
      await delay(10 * (attempt + 1))
    }
  }
  throw lastError
}

async function replaceCharacter(
  deps: VariableGatewayDeps,
  character: string,
  tree: VariableTree,
): Promise<VariableWriteReceipt> {
  const normalized = normalizeVariableTree(tree, `character variables for '${character}'`)
  const store = await deps.store()
  await store.updateState((current) => ({
    characterVariables: {
      ...(current.characterVariables ?? {}),
      [character]: normalized,
    },
  }))
  return { mirror: { status: 'not-applicable' } }
}

async function replaceGlobal(deps: VariableGatewayDeps, tree: VariableTree): Promise<VariableWriteReceipt> {
  const normalized = normalizeVariableTree(tree, 'global variables')
  // TavernHelper's global scope accepts JSON trees even though the state field
  // is declared scalar-only for the macro engine; the compatibility surface
  // persists the tree verbatim (same contract as the old helper branch).
  const store = await deps.store()
  await store.updateState(() => ({
    scriptGlobals: normalized as unknown as Record<string, string | number | boolean>,
  }))
  return { mirror: { status: 'not-applicable' } }
}

type MirrorWriter = (store: VariableStore, chatId: string, tree: VariableTree) => Promise<void>

async function mirrorChat(
  deps: VariableGatewayDeps,
  character: string,
  chatId: string,
  tree: VariableTree,
  write: MirrorWriter,
): Promise<MirrorOutcome> {
  let bound: boolean
  try {
    bound = await isAgentTavernBound(deps, character, chatId)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    deps.logger.warn('variable gateway binding probe failed', { character, chatId, reason })
    return { status: 'degraded', reason }
  }
  if (!bound) return { status: 'not-applicable' }
  return mirrorChatWithRetry(deps, character, chatId, tree, write)
}

async function mirrorChatWithRetry(
  deps: VariableGatewayDeps,
  character: string,
  chatId: string,
  tree: VariableTree,
  write: MirrorWriter,
): Promise<MirrorOutcome> {
  let reason = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await write(await deps.variables(), chatId, tree)
      return { status: 'ok' }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      await delay(10 * (attempt + 1))
    }
  }
  deps.logger.warn('variable gateway chat mirror degraded', {
    character,
    chatId,
    attempts: 3,
    reason,
  })
  return { status: 'degraded', reason }
}

async function replaceMirrorWrite(store: VariableStore, chatId: string, tree: VariableTree): Promise<void> {
  const entries = variableEntriesForMirror(tree)
  const nextNames = new Set(entries.map((entry) => entry.name))
  for (const entry of await store.listAll('chat', chatId)) {
    if (nextNames.has(entry.name) || entry.name.startsWith('$')) continue
    await store.delete('chat', chatId, entry.name, entry.revision)
  }
  if (entries.length > 0) {
    await store.patch('chat', chatId, entries.map((entry) => ({ name: entry.name, value: entry.value })))
  }
}

async function upsertMirrorWrite(store: VariableStore, chatId: string, tree: VariableTree): Promise<void> {
  const entries = variableEntriesForMirror(tree)
  if (entries.length > 0) {
    await store.patch('chat', chatId, entries.map((entry) => ({ name: entry.name, value: entry.value })))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
