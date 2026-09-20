/**
 * Repair DSH session artifacts poisoned by dsh-tavern's pre-0.3.9 message
 * sources (the class behind the 2026-09-20 history-load outage:
 * "@deepseek-ai/dsh-session-format-v0-to-v1 refuses this format v0 Session:
 * agent/inbox/spliced N inserted message source has unexpected member
 * \"novelId\""). The released-v0 dispositions admit only {kind, plugin,
 * form, sections, summary} on plugin sources (form limited to instructions |
 * catalog | snapshot | notice | relay | recall), {kind, provider, model,
 * replayState} on model sources; the plugin shipped novelId/intentId,
 * tavernState, turn and the forms novel-notice/context/history/greeting/
 * tavern-anchor/tavern-opening, so v0 artifacts fail the v0→v1 migration
 * edge and history loading dies.
 *
 * Rewrites applied (identity data is preserved in summary text / message
 * ids / content tags, matching the fixed 0.3.9 writers):
 *   plugin novel-notice {novelId,intentId} -> notice + summary
 *     "AgentNovel work notice (novel <id>, intent <id>)"
 *   plugin form 'context' (preload)       -> form 'notice' (summary kept)
 *   plugin 'notice' + extra members       -> extras dropped
 *   plugin 'history'/'tavern-anchor'/'tavern-opening' (+turn) -> members dropped
 *   model + plugin/form members            -> extras dropped
 *
 * Usage:
 *   node scripts/repair-session-sources.mjs <session.jsonl.zstd | sessions-root> [--apply] [--runtime <node_modules>]
 *
 * Default is a dry-run report; --apply rewrites in place after writing a
 * .bak-<timestamp> backup next to each artifact. Every rewritten artifact is
 * re-verified through the real released-v0 codec + v0→v1 migration stage
 * (resolved from --runtime, .npm-cache/dsh-runtime/node_modules, or
 * node_modules); a failing verification aborts before any byte is written.
 * Quit `dsh web` first: a concurrently appended frame would be lost.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const runtimeIndex = args.indexOf('--runtime')
const runtimeArg = runtimeIndex === -1 ? undefined : args[runtimeIndex + 1]
const positional = args.filter((arg, index) => !arg.startsWith('--') && (runtimeIndex === -1 || (index !== runtimeIndex && index !== runtimeIndex + 1)))
const target = positional[0]
if (target === undefined) {
  console.error('usage: node scripts/repair-session-sources.mjs <session.jsonl.zstd | sessions-root> [--apply] [--runtime <node_modules>]')
  process.exit(2)
}
const root = resolve(target)
if (!existsSync(root)) throw new Error(`target not found: ${root}`)

/* ---------------------------- v0 frame container ---------------------------- */

const ZSTD_MAGIC = 4247762216

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`torn frame at byte ${start}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn frame at byte ${start}`)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/* ------------------------------ source repair ------------------------------ */

const PLUGIN_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall'])

function repairPluginSource(source, report) {
  const before = JSON.stringify(source)
  let next = { ...source }
  if (next.form === 'novel-notice') {
    next = {
      kind: 'plugin',
      plugin: 'dsh-tavern',
      form: 'notice',
      summary: `AgentNovel work notice (novel ${typeof next.novelId === 'string' ? next.novelId : 'unknown'}, intent ${typeof next.intentId === 'string' ? next.intentId : 'unknown'})`,
    }
  } else if (next.form === 'context') {
    next.form = 'notice'
  } else if (next.form === 'history' || next.form === 'tavern-anchor' || next.form === 'tavern-opening') {
    delete next.form
    delete next.turn
  }
  if (next.form === 'notice' || next.form === undefined) {
    for (const member of Object.keys(next)) {
      if (!['kind', 'plugin', 'form', 'sections', 'summary'].includes(member)) delete next[member]
    }
  }
  if (JSON.stringify(next) === before) return source
  report.push(before)
  return next
}

function repairModelSource(source, report) {
  if (source.plugin === undefined && source.form === undefined) return source
  const next = { ...source }
  delete next.plugin
  delete next.form
  report.push(JSON.stringify(source))
  return next
}

function repairMessage(message, report) {
  if (message === null || typeof message !== 'object' || message.source === null || typeof message.source !== 'object') return message
  const source = message.source
  let next = source
  if (source.kind === 'plugin' && source.plugin === 'dsh-tavern') next = repairPluginSource(source, report)
  else if (source.kind === 'model') next = repairModelSource(source, report)
  return next === source ? message : { ...message, source: next }
}

function repairRow(row, report) {
  if (row?.type === 'user/message') return { ...row, data: repairMessage(row.data, report) }
  if (row?.type === 'assistant/message') {
    return { ...row, data: { ...row.data, message: repairMessage(row.data?.message, report) } }
  }
  if (row?.type === 'agent/inbox/spliced' && Array.isArray(row.data?.inserted)) {
    return { ...row, data: { ...row.data, inserted: row.data.inserted.map((message) => repairMessage(message, report)) } }
  }
  return row
}

/* -------------------------- converter verification ------------------------- */

async function loadConverter() {
  const candidates = [
    runtimeArg,
    join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.npm-cache', 'dsh-runtime', 'node_modules'),
    join(process.cwd(), '.npm-cache', 'dsh-runtime', 'node_modules'),
    join(process.cwd(), 'node_modules'),
  ].filter((candidate) => typeof candidate === 'string')
  for (const base of candidates) {
    const entry = join(base, '@deepseek-ai', 'dsh-session-format-v0-to-v1', 'lib', 'index.js')
    if (existsSync(entry)) return import(pathToFileURL(entry).href)
  }
  throw new Error(`cannot locate @deepseek-ai/dsh-session-format-v0-to-v1 — pass --runtime <node_modules> (gates cache: pnpm check installs .npm-cache/dsh-runtime)`)
}

function verifyThroughMigration(pkg, rows) {
  const decoder = pkg.releasedV0SessionFormatCodec.createDecoder(rows[0], 'strict')
  const decoded = []
  const decodeContext = { emitEvent: (event) => decoded.push(event), emitRun: (run) => decoded.push(...run.expand()) }
  for (const row of rows.slice(1)) decoder.decodeRow(row, decodeContext)
  const inherited = decoder.finish(decodeContext)
  const targetHeader = pkg.sessionFormatV0ToV1.migrateHeader(decoder.header)
  const stage = pkg.sessionFormatV0ToV1.createStage({
    sourceHeader: decoder.header,
    targetHeader,
    sourceInheritedEventCount: inherited,
    sourceKind: 'decoded',
  })
  const migrated = []
  const stageContext = { emitEvent: (event) => migrated.push(event), emitRun: (run) => migrated.push(...run.expand()) }
  for (const event of decoded) stage.transformEvent(event, stageContext)
  stage.finish(stageContext)
  return migrated.length
}

/* ------------------------------- driver ------------------------------------ */

const artifactPaths = statSync(root).isDirectory()
  ? (() => {
      const found = []
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          if (statSync(path).isDirectory()) walk(path)
          else if (name === 'session.jsonl.zstd') found.push(path)
        }
      }
      walk(root)
      return found
    })()
  : [root]

const pkg = await loadConverter()
let touched = 0
let clean = 0
let failed = 0
for (const path of artifactPaths) {
  const buffer = readFileSync(path)
  let frames
  try {
    frames = scanZstdFrames(buffer)
  } catch (error) {
    console.error(`SKIP (undecodable container) ${path}: ${error.message}`)
    failed += 1
    continue
  }
  const frameTexts = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
  const frameLines = frameTexts.map((text) => text.split('\n').filter((line) => line.trim() !== ''))
  const rows = frameLines.flat().map((line) => JSON.parse(line))
  if (rows[0]?.type !== 'session' || rows[0].version !== 0) {
    console.log(`SKIP (not a v0 artifact) ${path}`)
    clean += 1
    continue
  }
  const report = []
  const repairedFrames = frameLines.map((lines) => lines.map((line) => repairRow(JSON.parse(line), report)))
  const repairedRows = repairedFrames.flat()
  if (report.length === 0) {
    try {
      verifyThroughMigration(pkg, rows)
      console.log(`clean ${path}`)
    } catch (error) {
      console.error(`DIRTY-BUT-UNRECOGNIZED ${path}: ${error.message} — manual inspection needed`)
      failed += 1
    }
    clean += 1
    continue
  }
  try {
    const migratedCount = verifyThroughMigration(pkg, repairedRows)
    const suffix = apply ? '' : ' (dry-run)'
    console.log(`repair${suffix} ${path}: ${report.length} source(s) normalized, v0->v1 migration passes (${migratedCount} events)`)
    for (const sample of [...new Set(report)].slice(0, 3)) console.log(`   ${sample}`)
    if (apply) {
      const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(path, backup)
      const out = repairedFrames.map((lines) => zstdCompressSync(Buffer.from(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')))
      const temporary = `${path}.repair-${process.pid}.tmp`
      writeFileSync(temporary, Buffer.concat(out))
      renameSync(temporary, path)
      console.log(`   backup: ${backup}`)
    }
    touched += 1
  } catch (error) {
    console.error(`FAILED verification ${path}: ${error.message} — artifact left untouched`)
    failed += 1
  }
}
console.log(`\n${apply ? 'applied' : 'dry-run'}: ${artifactPaths.length} artifact(s), ${touched} repaired, ${clean} clean/skipped, ${failed} failed`)
if (!apply && touched > 0) console.log('re-run with --apply to write repairs')
if (failed > 0) process.exit(1)
