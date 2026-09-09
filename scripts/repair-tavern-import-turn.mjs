import { constants, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHistoryValidator, createHostPersistenceValidator, readSessionRecords } from './verify-tavern-history.mjs'

/**
 * Convert the legacy synthetic import turn into session-level messages.
 * The imported assistant message is retained and all synthetic boundaries
 * are removed. Sequence references are remapped after the deletion.
 */
export function repairImportedPrelude(events) {
  const start = events.findIndex((event) => event.type === 'turn/start'
    && (event.data?.turn === 0 || event.data?.turn === 1))
  if (start < 0) throw new Error('Session has no legacy imported turn to repair')
  const turn = events[start].data.turn
  const end = events.findIndex((event, index) => index > start
    && event.type === 'turn/end' && event.data?.turn === turn)
  if (end < 0) throw new Error(`Imported turn ${turn} has no matching turn/end`)

  const prelude = events.slice(start, end + 1)
  const assistants = prelude.filter((event) => event.type === 'assistant/message')
  if (assistants.length !== 1) throw new Error(`Expected one imported assistant; received ${assistants.length}`)
  const assistant = assistants[0]
  const source = assistant.data?.message?.source
  if (source?.kind !== 'model' || source.plugin !== 'dsh-tavern'
    || source.provider !== 'dsh-tavern' || source.model !== 'agent-tavern-import') {
    throw new Error(`Assistant at seq ${assistant.seq} is not an AgentTavern import`)
  }

  for (const event of prelude) {
    if (event.type === 'user/message') {
      if (event.data?.source?.kind === 'plugin' && event.data.source.plugin === 'dsh-tavern') continue
      throw new Error(`Unexpected non-imported user message at seq ${event.seq}`)
    }
    if (!['turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end'].includes(event.type)
      || event.data?.turn !== turn) {
      throw new Error(`Unexpected event ${event.type} at seq ${event.seq}`)
    }
  }
  if (events.some((event) => event.type === 'turn/start'
    && event.seq > events[end].seq && event.data?.turn === 0)) {
    throw new Error('Found another zero-valued turn after the imported prelude')
  }

  const removed = new Set(prelude.filter((event) => event !== assistant).map((event) => event.seq))
  const removedBefore = (seq) => [...removed].filter((removedSeq) => removedSeq < seq).length
  const remapSeq = (seq) => {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`Invalid referenced sequence ${seq}`)
    if (removed.has(seq)) throw new Error(`A retained event references removed sequence ${seq}`)
    return seq - removedBefore(seq)
  }

  return events
    .filter((event) => !removed.has(event.seq))
    .map((event) => {
      const next = structuredClone(event)
      next.seq = remapSeq(event.seq)
      if (event === assistant) {
        delete next.data.turn
        delete next.data.step
      }
      if (Array.isArray(next.sourceEventSeqs)) {
        next.sourceEventSeqs = next.sourceEventSeqs.map(remapSeq)
      }
      if (next.type === 'session/title' && Array.isArray(next.data?.messageSeqs)) {
        next.data.messageSeqs = next.data.messageSeqs.map(remapSeq)
      }
      return next
    })
}

function decodeEvents(records, decodeStorageRecord) {
  return records.filter((record) => record.type !== 'session')
    .flatMap((record) => decodeStorageRecord(record))
}

function validateEvents(events, adoptSessionEvent, validateHistory) {
  for (const event of events) adoptSessionEvent(structuredClone(event))
  validateHistory(events)
}

function encodeArtifact(headerRecord, events) {
  const header = `${JSON.stringify(headerRecord)}\n`
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(header, 'utf8')),
    zstdCompressSync(Buffer.from(body, 'utf8')),
  ])
  return { bytes, plaintext: `${header}${body}` }
}

function decodeFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let index = 0; index <= buffer.length - magic.length; index += 1) {
    if (buffer.subarray(index, index + magic.length).equals(magic)) starts.push(index)
  }
  if (starts[0] !== 0) throw new Error('Repaired artifact has no initial zstd frame')
  return starts.map((start, index) => zstdDecompressSync(
    buffer.subarray(start, starts[index + 1] ?? buffer.length),
  )).join('')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dependencyRoot, artifactArgument] = process.argv.slice(2)
  if (!dependencyRoot || !artifactArgument) {
    throw new Error('Usage: node scripts/repair-tavern-import-turn.mjs <host-node-modules> <session.jsonl.zstd>')
  }

  const artifact = resolve(artifactArgument)
  const original = readFileSync(artifact)
  const storedBefore = readSessionRecords(artifact)
  const header = storedBefore.find((record) => record.type === 'session')
  if (!header) throw new Error('Session artifact has no header')

  const { adoptSessionEvent, decodeStorageRecord } = await import(pathToFileURL(
    resolve(dependencyRoot, '@deepseek-ai/dsh-session/lib/index.js'),
  ).href)
  const validateHistory = createHistoryValidator(dependencyRoot)
  const validateHostPersistence = createHostPersistenceValidator(
    dependencyRoot,
    dirname(dirname(dirname(artifact))),
  )
  const before = decodeEvents(storedBefore, decodeStorageRecord)
  const after = repairImportedPrelude(before)
  validateEvents(after, adoptSessionEvent, validateHistory)

  const encoded = encodeArtifact(header, after)
  if (decodeFrames(encoded.bytes) !== encoded.plaintext) {
    throw new Error('Repaired artifact failed compressed round-trip validation')
  }
  if (!readFileSync(artifact).equals(original)) {
    throw new Error('Session changed during validation; stop DSH before repairing')
  }

  const stamp = `${Date.now()}-${process.pid}`
  const backup = `${artifact}.bak-import-session-level-${stamp}`
  const temporary = `${artifact}.${stamp}.tmp`
  copyFileSync(artifact, backup, constants.COPYFILE_EXCL)
  writeFileSync(temporary, encoded.bytes, { flag: 'wx' })
  if (!readFileSync(artifact).equals(original)) {
    throw new Error(`Session changed before replacement; original backup: ${backup}`)
  }
  renameSync(temporary, artifact)

  const persistedStored = readSessionRecords(artifact)
  const persisted = decodeEvents(persistedStored, decodeStorageRecord)
  validateEvents(persisted, adoptSessionEvent, validateHistory)
  const inspection = await validateHostPersistence(header.id)
  if (JSON.stringify(persisted) !== JSON.stringify(after)) {
    throw new Error(`Post-write verification failed; original backup: ${backup}`)
  }
  if (inspection.events.length !== after.length) {
    throw new Error(`Host persistence verification returned ${inspection.events.length} events; expected ${after.length}`)
  }
  console.log(JSON.stringify({
    artifact,
    backup,
    beforeEvents: before.length,
    afterEvents: after.length,
    removedEvents: before.length - after.length,
    hostInspectionEvents: inspection.events.length,
    validated: true,
  }, null, 2))
}
