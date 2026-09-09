import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import vm from 'node:vm'

/**
 * Logical region → candidate region names, probed across the available host
 * client bundles in order. Older hosts keep the assembler regions in the
 * `dsh-client-runtime` bundle under `sessions/conversation-*`; DSH 0.1.2 moved
 * them into the conversation bundle under `conversation/*` and moved the
 * surface helpers plus the conversation-node definitions into the chat bundle,
 * so every lookup tolerates a missing bundle or region where noted.
 */
const CONVERSATION_REGIONS = [
  { names: ['contract/conversation'] },
  { names: ['sessions/conversation-location-index', 'conversation/location-index'] },
  { names: ['sessions/conversation-assembler', 'conversation/assembler'] },
  { names: ['conversation/definition-registry'] },
  { names: ['conversation/event-registry'] },
  { names: ['conversation/view-registry'] },
]
const CHAT_REGIONS = [
  { names: ['../../core/session/src/surface.ts'], optional: true },
  { names: ['conversation-nodes/common'], optional: true },
  { names: ['conversation-nodes/event-projection'], optional: true },
  { names: ['conversation-nodes/assistant'], optional: true },
  { names: ['conversation-nodes/turn-error'], optional: true },
]

function bundleRegion(sources, names, { optional = false } = {}) {
  for (const source of sources) {
    for (const name of names) {
      // Region names outside lib/types/client appear verbatim in the bundle.
      const marker = name.startsWith('.')
        ? `//#region ${name}`
        : `//#region lib/types/client/${name}.js`
      const start = source.indexOf(marker)
      if (start < 0) continue
      const end = source.indexOf('//#endregion', start)
      if (end < 0) continue
      return source.slice(start, end)
    }
  }
  if (optional) return null
  throw new Error(`Host client bundle is missing source region: ${names.join(' | ')}`)
}

function readBundle(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/**
 * Replay the full event log through the installed host's actual conversation
 * assembler. Every event — not just turn boundaries — must pass through the
 * fold: the 0.1.2 "assistant-step" definition reads `{ turn, step }`
 * coordinates straight off each assistant message payload and throws
 * "published invalid turn undefined" otherwise, which kills the client's
 * event-feed subscriber and leaves the conversation empty. A window filtered
 * to turn/start events never reaches that path, which is exactly how the bare
 * import shape slipped past this validator.
 */
export function createHistoryValidator(dependencyRoot) {
  const root = resolve(dependencyRoot, '@deepseek-ai')
  const require = createRequire(resolve(root, 'index.js'))
  const cordis = require('@deepseek-ai/cordis')
  const runtime = readBundle(resolve(root, 'dsh-client-runtime/lib/client.js'))
  const conversation = readBundle(resolve(root, 'dsh-client-ui-conversation/lib/client.js'))
  const chat = readBundle(resolve(root, 'dsh-client-ui-chat/lib/client.js'))
  if (!conversation) throw new Error('Host install is missing dsh-client-ui-conversation/lib/client.js')
  const context = vm.createContext({
    _deepseek_ai_cordis: cordis,
    // Assembler regions notify subscribers through the shared client-store
    // external; a no-op relay is enough for offline folding.
    _deepseek_ai_dsh_client_store: { notifySubscribers: (listeners) => { for (const listener of [...listeners]) listener() } },
  })
  const conversationSources = [runtime, conversation].filter(Boolean)
  const chatSources = [chat].filter(Boolean)
  const statements = [
    ...CONVERSATION_REGIONS.map(({ names, ...options }) => bundleRegion(conversationSources, names, options)),
    ...CHAT_REGIONS.map(({ names, ...options }) => bundleRegion(chatSources, names, options)),
    'globalThis.registeredDefinitions = () => [',
    "  typeof assistantDefinition === 'undefined' ? null : assistantDefinition,",
    "  typeof turnErrorDefinition === 'undefined' ? null : turnErrorDefinition,",
    '].filter((definition) => definition !== null);',
    'globalThis.createAssembler = (ctx) => {',
    '  const events = new ConversationEventRegistry(ctx);',
    '  for (const definition of registeredDefinitions()) events.register(definition);',
    '  return new ConversationNodeAssembler(events, new ConversationViewRegistry(ctx));',
    '};',
  ]
  vm.runInContext(statements.join('\n'), context)
  return (events) => {
    const assembler = context.createAssembler(new cordis.Context())
    // The persisted artifact's `session` header record carries no seq/data and
    // never enters the live event feed; the fold only sees real events.
    const entries = events.filter((event) => event.type !== 'session' && event.data !== undefined)
      .map((event) => ({ event }))
    const flush = () => { if (typeof assembler.flush === 'function') assembler.flush() }
    // Full-window load plus history pagination, with the production flush in
    // between: the fold publishes Location data during flush, which is where
    // the invalid-turn rejection fires.
    assembler.replaceWindow(entries, false)
    flush()
    const split = Math.floor(entries.length / 2)
    assembler.replaceWindow(entries.slice(split), split > 0)
    flush()
    assembler.prepend(entries.slice(0, split), split > 0)
    flush()
  }
}

/** Load a persisted session through the installed host persistence stack. */
export function createHostPersistenceValidator(dependencyRoot, sessionRoot) {
  const root = resolve(dependencyRoot, '@deepseek-ai')
  const require = createRequire(resolve(root, 'index.js'))
  const { Context } = require('@deepseek-ai/cordis')
  const { SessionStore } = require('@deepseek-ai/dsh-session')
  const { JsonlSessionPersistence } = require('@deepseek-ai/dsh-session-persistence-jsonl')

  return async (sessionId) => {
    const context = new Context()
    new SessionStore(context)
    const persistence = new JsonlSessionPersistence(context, {
      root: resolve(sessionRoot),
      compression: 'zstd',
    })
    const inspection = await persistence.inspect(sessionId)
    if (inspection.meta.id !== sessionId) {
      throw new Error(`Host persistence returned session ${inspection.meta.id} for ${sessionId}`)
    }
    return inspection
  }
}

function rootFromArtifact(artifact) {
  return dirname(dirname(dirname(resolve(artifact))))
}

/** Decode the concatenated zstd frames used by the session artifact writer. */
export function readSessionRecords(artifact) {
  const buffer = readFileSync(artifact)
  const starts = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.readUInt32LE(index) === 0xfd2fb528) starts.push(index)
  }
  if (starts[0] !== 0) throw new Error(`Session artifact has no initial zstd frame: ${artifact}`)
  return starts.map((start, index) =>
    zstdDecompressSync(buffer.subarray(start, starts[index + 1] ?? buffer.length)).toString('utf8'),
  ).join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dependencyRoot, artifact] = process.argv.slice(2)
  if (!dependencyRoot || !artifact) {
    throw new Error('Usage: node scripts/verify-tavern-history.mjs <host-node-modules> <session.jsonl.zstd>')
  }
  const records = readSessionRecords(artifact)
  createHistoryValidator(dependencyRoot)(records)
  const header = records.find((record) => record.type === 'session')
  if (!header) throw new Error('Session artifact has no header')
  const inspection = await createHostPersistenceValidator(
    dependencyRoot,
    rootFromArtifact(artifact),
  )(header.id)
  console.log(`PASS: native conversation history load and pagination; host persistence inspect (${inspection.events.length} events)`)
}
