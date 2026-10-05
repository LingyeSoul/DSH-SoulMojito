/**
 * Repair DSH format-v4 session artifacts poisoned by dsh-tavern ≤0.3.9's
 * pre-compat writers (the 0.2.0-rc.2 admission failures):
 *
 *   A. `assistant/chunk` rows — v0 vocabulary retired at the v1→v2 edge; the v4
 *      loader refuses the WHOLE artifact ("unknown to this harness and not
 *      marked ignorable"). ST generation wrote one per llm chunk.
 *   B. `assistant/message` rows without `data.stream` — append admits them, the
 *      load-boundary settlement check (`assertAssistantSettlementShape`) does
 *      not; the session dies on the next open.
 *   C. History-import mirrors with `turn: 0` and no turn boundaries — legal in
 *      v3, structurally illegal under the v4 relationship model
 *      (`turn/start` must equal nextTurn counting from 1). Rewritten into a
 *      fully opened/closed import turn; later live turns are renumbered by the
 *      number of inserted turns so nextTurn sequencing stays valid.
 *
 * Usage:
 *   node scripts/repair-v4-sessions.mjs <session.jsonl.zstd | sessions-root> [--apply] [--runtime <node_modules>]
 *
 * Default is a dry-run report; --apply rewrites in place after writing a
 * .bak-<timestamp> backup. Every rewrite is verified through the REAL released
 * v4 admission (assertReleasedV4Relationships + KNOWN_SESSION_EVENT_TYPES,
 * resolved from --runtime, .npm-cache/dsh-runtime/node_modules, or
 * node_modules); a failing verification aborts before any byte is written.
 * Quit `dsh web` first: a concurrently appended frame would be lost.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
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
  console.error('usage: node scripts/repair-v4-sessions.mjs <session.jsonl.zstd | sessions-root> [--apply] [--runtime <node_modules>]')
  process.exit(2)
}
const root = resolve(target)
if (!existsSync(root)) throw new Error(`target not found: ${root}`)

/* ---------------------------- zstd frame container ---------------------------- */

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

/* ------------------------------ host admission ------------------------------ */

async function loadAdmission() {
  const candidates = [
    runtimeArg,
    join(resolve(fileURLToPath(new URL('..', import.meta.url))), '.npm-cache', 'dsh-runtime', 'node_modules'),
    join(process.cwd(), '.npm-cache', 'dsh-runtime', 'node_modules'),
    join(process.cwd(), 'node_modules'),
  ].filter((candidate) => typeof candidate === 'string')
  for (const base of candidates) {
    const migration = join(base, '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')
    const session = join(base, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
    if (existsSync(migration) && existsSync(session)) {
      const v3to4 = await import(pathToFileURL(migration).href)
      const dshSession = await import(pathToFileURL(session).href)
      return {
        assertRelationships: v3to4.assertReleasedV4Relationships,
        known: dshSession.KNOWN_SESSION_EVENT_TYPES,
      }
    }
  }
  throw new Error('cannot locate @deepseek-ai/dsh-session-format-v3-to-v4 + dsh-session — pass --runtime <node_modules> (gates cache: pnpm check installs .npm-cache/dsh-runtime)')
}

/** 物理首行（{type:'session',...}）转逻辑 header：去掉物理 framing 成员。 */
function logicalHeader(physicalRow) {
  const { type, ...header } = physicalRow
  return header
}

function verifyAdmission(admission, headerRow, rows) {
  const artifact = {
    header: logicalHeader(headerRow),
    events: rows.map((row, index) => ({ ...row, seq: index })),
    inheritedEventCount: 0,
  }
  admission.assertRelationships(artifact, admission.known)
}

/* -------------------------------- v4 repairs ------------------------------- */

function isTavernPluginSource(source) {
  return source?.kind === 'plugin:dsh-tavern' || (source?.kind === 'plugin' && source?.plugin === 'dsh-tavern')
}

/** v4 拒绝裸 'plugin' kind（要求 producer-owned）。与宿主 v3→v4 迁移同语义收敛。 */
function repairSourceKind(source, stats) {
  if (source?.kind !== 'plugin' || source?.plugin !== 'dsh-tavern') return source
  const { kind, plugin, ...members } = source
  stats.sourcesRewritten += 1
  return { ...members, kind: 'plugin:dsh-tavern' }
}

/**
 * 单个 v4 工件的修复（返回 null 表示干净无需改写）。四类修复互不依赖，
 * 任何一类生效才写回；改写后必须能通过真实 v4 准入校验。
 */
function repairV4Artifact(rows) {
  const headerRow = rows[0]
  const events = rows.slice(1)
  const stats = { chunksDropped: 0, streamsBackfilled: 0, importWraps: 0, turnsShifted: 0, sourcesRewritten: 0 }
  const out = []
  let dirty = false

  let liveNext = 1 // validator 的 nextTurn：随日志里每个 turn/end 递增
  let turnShift = 0 // 导入 turn 插入后，其后所有原生 turn 坐标整体后移
  let wrap = null // 进行中的导入 turn 包裹 { turn, step }

  const closeWrap = () => {
    if (wrap === null) return
    out.push({ type: 'turn/end', time: wrap.time, data: { turn: wrap.turn, reason: { kind: 'completed' } } })
    wrap = null
  }

  for (let event of events) {
    const time = typeof event.time === 'number' ? event.time : 0

    if (event.type === 'assistant/chunk') {
      stats.chunksDropped += 1
      dirty = true
      continue
    }

    // D. 裸 plugin source 归一化为 producer-owned kind（user 消息本体 / assistant
    //    消息内嵌 message.source 两个落点）。已是 producer-owned 时不置 dirty。
    if (event.type === 'user/message') {
      const nextSource = repairSourceKind(event.data?.source, stats)
      if (nextSource !== event.data?.source) {
        event = { ...event, data: { ...event.data, source: nextSource } }
        dirty = true
      }
    }
    if (event.type === 'assistant/message') {
      const nextSource = repairSourceKind(event.data?.message?.source, stats)
      if (nextSource !== event.data?.message?.source) {
        event = {
          ...event,
          data: { ...event.data, message: { ...event.data.message, source: nextSource } },
        }
        dirty = true
      }
    }

    if (event.type === 'assistant/message' && !Array.isArray(event.data?.stream)) {
      event = { ...event, data: { ...event.data, stream: [] } }
      stats.streamsBackfilled += 1
      dirty = true
    }

    // 孤儿导入镜像：turn 0 在 v4 关系模型里不可能合法（nextTurn 从 1 起）。
    const orphanImport = event.type === 'assistant/message' && event.data?.turn === 0
    if (orphanImport) {
      if (wrap === null) {
        const turn = liveNext + turnShift
        out.push({ type: 'turn/start', time, data: { turn } })
        wrap = { turn, step: 0, time }
        turnShift += 1
        stats.importWraps += 1
      }
      wrap.step += 1
      out.push({ type: 'step/start', time, data: { turn: wrap.turn, step: wrap.step } })
      out.push({ ...event, data: { ...event.data, turn: wrap.turn, step: wrap.step } })
      out.push({ type: 'step/end', time, data: { turn: wrap.turn, step: wrap.step } })
      dirty = true
      continue
    }

    // 插件导入的 user 消息留在包裹内（user/message 无 turn 关系约束）；
    // 其他任何事件先闭合包裹再原样处理。
    if (wrap !== null && !(event.type === 'user/message' && isTavernPluginSource(event.data?.source))) {
      closeWrap()
    }

    if (turnShift > 0 && event.data !== null && typeof event.data === 'object' && Number.isSafeInteger(event.data.turn)) {
      event = { ...event, data: { ...event.data, turn: event.data.turn + turnShift } }
      if (event.type === 'turn/start' || event.type === 'turn/end') stats.turnsShifted += 1
    }
    if (event.type === 'turn/end') liveNext += 1
    out.push(event)
  }
  closeWrap()

  if (!dirty) return null
  const repaired = [headerRow, ...out.map((row, index) => ({ ...row, seq: index }))]
  return { rows: repaired, stats }
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

const admission = await loadAdmission()
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
  const frameLines = frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8').split('\n').filter((line) => line.trim() !== ''))
  const rows = frameLines.flat().map((line) => JSON.parse(line))
  if (rows[0]?.type !== 'session' || rows[0].version !== 4) {
    clean += 1
    continue
  }
  let repair
  try {
    repair = repairV4Artifact(rows)
  } catch (error) {
    console.error(`SKIP (repair pass threw) ${path}: ${error.message}`)
    failed += 1
    continue
  }
  if (repair === null) {
    try {
      verifyAdmission(admission, rows[0], rows.slice(1))
      console.log(`clean ${path}`)
    } catch (error) {
      console.error(`DIRTY-BUT-UNRECOGNIZED ${path}: ${error.message} — manual inspection needed`)
      failed += 1
    }
    clean += 1
    continue
  }
  try {
    verifyAdmission(admission, repair.rows[0], repair.rows.slice(1))
    const summary = `${repair.stats.chunksDropped} chunk(s) dropped, ${repair.stats.streamsBackfilled} stream(s) backfilled, ${repair.stats.importWraps} import turn(s) wrapped, ${repair.stats.turnsShifted} live event(s) renumbered, ${repair.stats.sourcesRewritten} source(s) rewritten`
    const suffix = apply ? '' : ' (dry-run)'
    console.log(`repair${suffix} ${path}: ${summary}; real v4 admission passes`)
    if (apply) {
      const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(path, backup)
      // 单帧写回：多帧工件（追加过）合并成一个完整帧，内容不丢。
      const out = [repair.rows.map((row) => JSON.stringify(row)).join('\n') + '\n']
      const temporary = `${path}.repair-${process.pid}.tmp`
      writeFileSync(temporary, zstdCompressSync(Buffer.from(out[0], 'utf8')))
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
