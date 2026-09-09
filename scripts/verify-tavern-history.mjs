import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import vm from 'node:vm'

/** Replay turn identities with the installed host's actual conversation assembler. */
export function createHistoryValidator(dependencyRoot) {
  const root = resolve(dependencyRoot, '@deepseek-ai')
  const require = createRequire(resolve(root, 'dsh-client-runtime/package.json'))
  const cordis = require('@deepseek-ai/cordis')
  const runtime = readFileSync(resolve(root, 'dsh-client-runtime/lib/client.js'), 'utf8')
  const conversation = readFileSync(resolve(root, 'dsh-client-ui-conversation/lib/client.js'), 'utf8')
  const regions = [
    'contract/conversation',
    'sessions/conversation-location-index',
    'sessions/conversation-assembler',
    'conversation/definition-registry',
    'conversation/event-registry',
    'conversation/view-registry',
  ].map((name) => bundleRegion(runtime, name))
  const context = vm.createContext({ _deepseek_ai_cordis: cordis })
  vm.runInContext([
    ...regions,
    bundleRegion(conversation, 'conversation-nodes/turn-error'),
    'globalThis.createAssembler = (ctx) => {',
    '  const events = new ConversationEventRegistry(ctx);',
    '  events.register(turnErrorDefinition);',
    '  return new ConversationNodeAssembler(events, new ConversationViewRegistry(ctx));',
    '};',
  ].join('\n'), context)
  return (events) => {
    const assembler = context.createAssembler(new cordis.Context())
    const starts = events.filter((event) => event.type === 'turn/start').map((event) => ({ event }))
    assembler.replaceWindow(starts, false)
    // Exercise history pagination as well as the initial full-window load.
    const split = Math.floor(starts.length / 2)
    assembler.replaceWindow(starts.slice(split), split > 0)
    assembler.prepend(starts.slice(0, split), false)
  }
}

/** Load a persisted session through the installed host persistence stack. */
export function createHostPersistenceValidator(dependencyRoot, sessionRoot) {
  const root = resolve(dependencyRoot, '@deepseek-ai')
  const require = createRequire(resolve(root, 'dsh-session/package.json'))
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

function bundleRegion(source, name) {
  const marker = `//#region lib/types/client/${name}.js`
  const start = source.indexOf(marker)
  const end = source.indexOf('//#endregion', start)
  if (start < 0 || end < 0) throw new Error(`Host client bundle is missing source region: ${name}`)
  return source.slice(start, end)
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
