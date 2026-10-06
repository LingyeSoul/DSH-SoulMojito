import { constants, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHistoryValidator, createHostPersistenceValidator, readSessionRecords } from './verify-tavern-history.mjs'
import { repairSessionTurns } from './lib/session-turn-repair.mjs'

/**
 * Drop `sourceEventSeqs` entries that are not earlier than the owning event.
 * Hosts before 0.1.2 wrote step-provenance runs that include the owning
 * event's own seq and same-step successors, which 0.1.2's restore validation
 * rejects as corruption (`sourceEventSeqs must reference earlier events`),
 * blocking the whole session at PersistenceCoordinator.prepareCore. Only the
 * forward entries are removed; earlier references are kept and the field is
 * dropped entirely when nothing survives.
 */
export function trimForwardSourceEventRefs(events) {
  let trimmed = 0
  const next = events.map((event) => {
    if (!Array.isArray(event.sourceEventSeqs)) return event
    const kept = event.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq) && seq < event.seq)
    if (kept.length === event.sourceEventSeqs.length) return event
    const mutated = structuredClone(event)
    if (kept.length === 0) delete mutated.sourceEventSeqs
    else mutated.sourceEventSeqs = kept
    trimmed += 1
    return mutated
  })
  return { events: next, trimmed }
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
  // 本脚本历史上的两个 turn-0 产出函数（repairImportedPrelude /
  // stampImportedTurnCoordinates）已被删除：`{ turn: 0 }` 被 0.2.0-rc.2 的
  // v2→v3 迁移拒绝（"turn must be positive"），整会话不可加载。所有 legacy
  // 导入形状（裸消息、turn-0 无边界、turn-0/重复/跳号包裹）统一由
  // scripts/lib/session-turn-repair.mjs 修复成正 turn 包裹。--stamp-only
  // 保留为兼容别名（引擎统一处理，不再有形状探测分支）。
  const stampOnly = process.argv.includes('--stamp-only')
  if (stampOnly) console.log('note: --stamp-only is accepted for compatibility; the unified engine handles all legacy import shapes')
  const positional = process.argv.slice(2).filter((argument) => argument !== '--stamp-only')
  const [dependencyRoot, artifactArgument] = positional
  if (!dependencyRoot || !artifactArgument) {
    throw new Error('Usage: node scripts/repair-tavern-import-turn.mjs <host-node-modules> <session.jsonl.zstd> [--stamp-only]')
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
  // decodeStorageRecord 把列压缩行展开成逻辑事件（seq/time 标准、宽度 1），
  // 引擎在展开空间工作；encodeArtifact 写回展开形态（v0 读取器原生词表）。
  const before = decodeEvents(storedBefore, decodeStorageRecord)
  const repaired = repairSessionTurns(before)
  const { events: after, trimmed } = trimForwardSourceEventRefs(repaired === null ? before : repaired.events)
  const stats = repaired === null ? null : repaired.stats
  if (stats === null && trimmed === 0) {
    console.log(JSON.stringify({
      artifact,
      repaired: false,
      note: 'Turn coordinates are healthy and no forward sourceEventSeqs; nothing to repair.',
    }, null, 2))
  } else {
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
      repaired: true,
      backup,
      beforeEvents: before.length,
      afterEvents: after.length,
      turnStats: stats,
      trimmedRefEvents: trimmed,
      hostInspectionEvents: inspection.events.length,
      validated: true,
    }, null, 2))
  }
}
