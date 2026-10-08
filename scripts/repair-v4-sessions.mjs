/**
 * Repair DSH session artifacts poisoned by dsh-tavern ≤0.3.9's pre-compat
 * writers (the 0.2.0-rc.2 admission failures):
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
 *   D. 裸 plugin source 归一化为 producer-owned kind。
 *   E. surface 无受保护头：v4 的 surface 首个节点必须是 system/message（宿主
 *      foldSurface 只在 system/message 追加到空 surface 时建立 protectedHead），
 *      否则后续 system/message 追加——最典型的是 live loop 首轮的 system prompt
 *      提交——判整份日志损坏：`system/message requires a protected first surface
 *      head`。≤0.3.9 的历史导入先写历史 surface 节点、不写头，必然踩中。修复
 *      方式：在第一个 surface 事件之前、当前打开的 step 内插入一个空 system
 *      头（surfaceOp append），并重编号其后事件；headSeq 之外的 seq 引用
 *      （sourceEventSeqs / surfaceOp 范围 / headerSeq / messageSeqs /
 *      sourceEventSeq / throughSeq）随映射一并重写。
 *
 * A-E 只作用于 version 4 工件。version 0 工件走同族的 turn 坐标修复
 * （scripts/lib/session-turn-repair.mjs：孤儿 turn-0 导入包裹、重复/跳号
 * turn/start 校正、密集重编号 + sourceEventSeqs/messageSeqs 引用重写）——
 * v0 的 chunk/settlement/source 语义不同（v4 专属成员会毒化老工件），其余
 * 修复类不适用。v0 修复后必须通过真实宿主 observe（持久化 open+read，
 * 即 "failed to observe session" 的原生链路）与客户端会话折叠验证；
 * 验证失败自动回滚备份。
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
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
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
        base,
        assertRelationships: v3to4.assertReleasedV4Relationships,
        assertRow: v3to4.assertV4RowAdmission,
        known: dshSession.KNOWN_SESSION_EVENT_TYPES,
      }
    }
  }
  throw new Error('cannot locate @deepseek-ai/dsh-session-format-v3-to-v4 + dsh-session — pass --runtime <node_modules> (gates cache: pnpm check installs .npm-cache/dsh-runtime)')
}

/**
 * v0 turn 修复引擎（scripts/lib/session-turn-repair.mjs）是懒加载的：该文件曾因
 * .gitignore 的全局 `lib/` 规则被静默挡在 git 之外（48f3f74 的提交引用到孤儿
 * 模块），本检出可能缺失。缺失时 v4 修复（本文件的主用途）不受影响，v0 工件
 * 如实跳过并给出可执行的错误信息。
 */
let v0Engine
async function loadV0Engine() {
  if (v0Engine !== undefined) return v0Engine
  try {
    v0Engine = await import('./lib/session-turn-repair.mjs')
  } catch (error) {
    v0Engine = null
    console.warn(`warn: v0 repair engine unavailable (${error.message}); version 0 artifacts will be skipped`)
  }
  return v0Engine
}

/**
 * v0 工件的硬验证：通过真实宿主持久化栈 open+read 整个工件——这正是
 * "failed to observe session … refuses this format v2 Session" 的原生链路
 * （v0→v1→v2→v3→v4 代际迁移 + 解码）。0.2.0-rc.2 的 jsonl 持久化包只导出
 * default；老宿主是具名导出，两种形状都接。
 */
async function loadObserveValidator(base) {
  const require2 = createRequire(join(base, '@deepseek-ai', 'dsh-session', 'lib', 'index.js'))
  const { Context } = require2('@deepseek-ai/cordis')
  const { SessionStore } = require2('@deepseek-ai/dsh-session')
  const persistenceModule = require2('@deepseek-ai/dsh-session-persistence-jsonl')
  const JsonlSessionPersistence = persistenceModule.JsonlSessionPersistence ?? persistenceModule.default
  return async (artifact, sessionId) => {
    const context = new Context()
    new SessionStore(context)
    const persistence = new JsonlSessionPersistence(context, {
      // <sessions-root>/<encoded-workspace>/<session-dir>/session.jsonl.zstd
      root: dirname(dirname(dirname(resolve(artifact)))),
      compression: 'zstd',
    })
    const handle = await persistence.open(sessionId, 'read')
    const result = await handle.read()
    if (handle.id !== sessionId) throw new Error(`observed ${handle.id} for ${sessionId}`)
    return result.events.length
  }
}

/** 物理首行（{type:'session',...}）转逻辑 header：去掉物理 framing 成员。 */
function logicalHeader(physicalRow) {
  const { type, ...header } = physicalRow
  return header
}

function verifyAdmission(admission, headerRow, rows) {
  const events = rows.map((row, index) => ({ ...row, seq: index }))
  const artifact = {
    header: logicalHeader(headerRow),
    events,
    inheritedEventCount: 0,
  }
  // 与宿主加载路径同序：先逐行物理准入（codec decodeRow），再整份关系折叠。
  for (const row of events) admission.assertRow(row, admission.known)
  admission.assertRelationships(artifact, admission.known)
}

/**
 * v4 容器契约：第一帧必须恰好一行 header，body 单独成帧——读取器对首帧
 * 行长严格（`first frame is not exactly one header line`）。历史单帧写回
 * 产物能过内容准入却过不了宿主读取，故写回统一走两帧。
 */
function encodeV4Artifact(rows) {
  return Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(rows[0])}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${rows.slice(1).map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')),
  ])
}

/** 写回前的容器 round-trip：帧切分正确、首帧单行、解码内容与行序逐字节一致。 */
function assertV4Container(buffer, rows) {
  const frames = scanZstdFrames(buffer)
  if (frames.length < 2) throw new Error('repaired artifact must keep the header frame separate from the body')
  const first = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  if (first !== `${JSON.stringify(rows[0])}\n`) throw new Error('repaired artifact first frame is not exactly one header line')
  const decoded = frames
    .map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
    .join('')
  if (decoded !== `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`) {
    throw new Error('repaired artifact failed compressed round-trip validation')
  }
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

/* ----------------------- protected surface head (E) ------------------------ */

/** 宿主 foldSurface 的 surface 事件集合（v4 词汇表）。 */
const SURFACE_EVENT_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result'])

/**
 * 探测「surface 无受保护头」损坏并给出修复计划（null = 干净或超出本修复类）。
 * 与宿主 foldSurface 同语义：只在 system/message 追加到空 surface 时建立
 * protectedHead；surface 非空且头未建立时的 system/message 追加判损坏。
 *
 * 修复位置固定在第一个 surface 事件之前（头必须是 surface 首节点）：
 *  - 该处有打开的 step → 头插进打开的 step，坐标即该 step，不引入重编号；
 *  - 只有打开的 turn（老 user 先行导入的形状）→ 新开一个 step
 *    （step = 该 turn 的 nextStep）承接头并立即闭合；其后同 turn 的 step 坐标
 *    整体 +1——step/start 必须匹配 nextStep，留出跳号即损坏。
 */
function planProtectedHead(events) {
  let surfaceLength = 0
  let protectedHead = false
  let firstSurfaceIndex = -1
  let violation = false
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    // surfaceOp 非 append 的替换语义超出本修复类：交给人工。
    if (event.surfaceOp !== 'append') return null
    if (firstSurfaceIndex === -1) firstSurfaceIndex = index
    if (event.type === 'system/message' && surfaceLength > 0 && !protectedHead) {
      violation = true
      break
    }
    if (event.type === 'system/message' && surfaceLength === 0) protectedHead = true
    surfaceLength += 1
  }
  if (!violation) return null

  let turn = null
  let nextStep = 1
  let openStep = null
  let turnStartIndex = -1
  for (let index = 0; index < firstSurfaceIndex; index += 1) {
    const event = events[index]
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) {
      turn = event.data.turn
      nextStep = 1
      openStep = null
      turnStartIndex = index
    } else if (event.type === 'turn/end') {
      turn = null
      openStep = null
      turnStartIndex = -1
    } else if (event.type === 'step/start' && Number.isSafeInteger(event.data?.step)) {
      openStep = { turn: event.data.turn, step: event.data.step }
    } else if (event.type === 'step/end') {
      if (openStep !== null) nextStep = openStep.step + 1
      openStep = null
    }
  }
  if (turn === null || turnStartIndex === -1) return null
  if (openStep !== null && openStep.turn === turn) {
    return { insertAt: firstSurfaceIndex, wrapInStep: false, turn, step: openStep.step, shiftSteps: null }
  }
  return {
    insertAt: turnStartIndex + 1,
    wrapInStep: true,
    turn,
    step: nextStep,
    shiftSteps: { turn, from: nextStep },
  }
}

/**
 * 重编号后按 seq 映射重写宿主词汇表里的全部 seq 引用：surface 的
 * sourceEventSeqs、surfaceOp 的 startSeq/endSeq、command/done 的
 * data.sourceEventSeq、session/title 的 data.messageSeqs、developer/message 的
 * data.headerSeq、delivery 的 data.throughSeq。映射缺失（引用了被本类删除的
 * 事件）时保持原值并留给准入校验裁决。
 */
function rewriteSeqReferences(rows, seqMap) {
  const mapValue = (seq) => (Number.isSafeInteger(seq) && seqMap.has(seq) ? seqMap.get(seq) : seq)
  return rows.map((row) => {
    let next = row
    if (Array.isArray(row.sourceEventSeqs)) {
      const mapped = row.sourceEventSeqs.map(mapValue)
      if (mapped.some((seq, index) => seq !== row.sourceEventSeqs[index])) next = { ...next, sourceEventSeqs: mapped }
    }
    const op = next.surfaceOp
    if (op !== null && typeof op === 'object' && !Array.isArray(op)) {
      const startSeq = mapValue(op.startSeq)
      const endSeq = mapValue(op.endSeq)
      if (startSeq !== op.startSeq || endSeq !== op.endSeq) next = { ...next, surfaceOp: { ...op, startSeq, endSeq } }
    }
    const data = next.data
    if (data !== null && typeof data === 'object') {
      const patch = {}
      if (Number.isSafeInteger(data.headerSeq) && seqMap.has(data.headerSeq)) patch.headerSeq = seqMap.get(data.headerSeq)
      if (Number.isSafeInteger(data.sourceEventSeq) && seqMap.has(data.sourceEventSeq)) patch.sourceEventSeq = seqMap.get(data.sourceEventSeq)
      if (Number.isSafeInteger(data.throughSeq) && seqMap.has(data.throughSeq)) patch.throughSeq = seqMap.get(data.throughSeq)
      if (Array.isArray(data.messageSeqs)) {
        const mapped = data.messageSeqs.map(mapValue)
        if (mapped.some((seq, index) => seq !== data.messageSeqs[index])) patch.messageSeqs = mapped
      }
      if (Object.keys(patch).length > 0) next = { ...next, data: { ...data, ...patch } }
    }
    return next
  })
}

/**
 * 单个 v4 工件的修复（返回 null 表示干净无需改写）。五类修复互不依赖，
 * 任何一类生效才写回；改写后必须能通过真实 v4 准入校验。
 */
function repairV4Artifact(rows) {
  const headerRow = rows[0]
  const events = rows.slice(1)
  const stats = { chunksDropped: 0, streamsBackfilled: 0, importWraps: 0, turnsShifted: 0, sourcesRewritten: 0, headsInserted: 0 }
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

  // E. surface 无受保护头（见文件头与 planProtectedHead）。结构性插入放最后，
  //    使折叠模拟看到的是其余修复完成后的最终事件流。
  const head = planProtectedHead(out)
  if (head !== null) {
    const time = Math.max(
      typeof out[head.insertAt - 1]?.time === 'number' ? out[head.insertAt - 1].time : 0,
      (typeof out[head.insertAt]?.time === 'number' ? out[head.insertAt].time : 0) - 1,
    )
    const headRow = {
      type: 'system/message',
      time,
      data: {
        turn: head.turn,
        step: head.step,
        message: {
          id: randomUUID(),
          role: 'system',
          content: [],
          // 恢复校验（dsh-session assertMessageEventShape）要求 system/message
          // 的 source 恰好是 system-prompt；plugin/marker 成员会被真实 observe
          // 拒绝（行准入与关系折叠不查这一条）。
          source: { kind: 'system-prompt' },
        },
      },
      surfaceOp: 'append',
    }
    const inserted = head.wrapInStep
      ? [
          { type: 'step/start', time, data: { turn: head.turn, step: head.step } },
          headRow,
          { type: 'step/end', time, data: { turn: head.turn, step: head.step } },
        ]
      : [headRow]
    out.splice(head.insertAt, 0, ...inserted)
    if (head.shiftSteps !== null) {
      for (const event of out.slice(head.insertAt + inserted.length)) {
        if (event.data !== null && typeof event.data === 'object'
          && event.data.turn === head.shiftSteps.turn
          && Number.isSafeInteger(event.data.step)
          && event.data.step >= head.shiftSteps.from) {
          event.data = { ...event.data, step: event.data.step + 1 }
        }
      }
    }
    stats.headsInserted += 1
    dirty = true
  }

  if (!dirty) return null
  // 先按最终排位建 seq 映射，再重编号并重写引用：插入点之后的所有引用
  // （sourceEventSeqs 等）必须与行号一起平移，否则溯源链接指向错误的行。
  const seqMap = new Map()
  out.forEach((row, index) => {
    if (Number.isSafeInteger(row.seq)) seqMap.set(row.seq, index)
  })
  const repaired = [headerRow, ...out.map((row, index) => ({ ...row, seq: index }))]
  return { rows: rewriteSeqReferences(repaired, seqMap), stats }
}

/* ------------------------------- driver ------------------------------------ */

const artifactPaths = statSync(root).isDirectory()
  ? (() => {
      const found = []
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          if (statSync(path).isDirectory()) walk(path)
          else if (name === 'session.jsonl.zstd' || name === 'session.v4.jsonl.zstd') found.push(path)
        }
      }
      walk(root)
      return found
    })()
  : [root]

const admission = await loadAdmission()
let observeValidator = undefined
let foldValidator = undefined
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
  if (rows[0]?.type !== 'session') {
    clean += 1
    continue
  }

  if (rows[0].version === 0) {
    // v0 工件：只做 turn 坐标修复（chunk/settlement/source 语义与 v4 不同，
    // 见文件头）。修复结果必须通过真实宿主 observe；--apply 写回后验证，
    // 失败回滚备份。dry-run 先 observe 现文件确认症状再报告计划。
    const engine = await loadV0Engine()
    if (engine === null) {
      console.error(`SKIP (v0 repair engine missing from this checkout) ${path}`)
      failed += 1
      continue
    }
    if (observeValidator === undefined) {
      const runtimeBase = admission.base
      if (runtimeBase === undefined) throw new Error('v0 repair needs the host runtime (pass --runtime)')
      observeValidator = await loadObserveValidator(runtimeBase)
    }
    const sessionId = rows[0].id
    if (typeof sessionId !== 'string' || basename(dirname(resolve(path))) !== sessionId) {
      // 扁平/旧版布局：目录名不是 id 的编码，当前宿主根本枚举不到这些会话，
      // 修复对加载无意义；如实跳过并提示。
      console.log(`skip ${path}: flat/legacy layout (dir ≠ session id) — invisible to the current host`)
      clean += 1
      continue
    }
    let repair = null
    try {
      repair = engine.repairSessionTurns(rows.slice(1))
    } catch (error) {
      console.error(`SKIP (turn repair threw) ${path}: ${error.message}`)
      failed += 1
      continue
    }
    if (repair === null) {
      try {
        await observeValidator(path, sessionId)
        console.log(`clean ${path}`)
      } catch (error) {
        console.error(`DIRTY-BUT-UNRECOGNIZED ${path}: observe fails (${error.message}) but no known v0 repair applies — manual inspection needed`)
        failed += 1
      }
      clean += 1
      continue
    }
    let backup = undefined
    try {
      if (foldValidator === undefined) {
        try {
          const { createHistoryValidator } = await import('./verify-tavern-history.mjs')
          foldValidator = createHistoryValidator(admission.base)
        } catch (error) {
          console.warn(`warn: client fold validator unavailable (${error.message}); host observe remains the gate`)
          foldValidator = null
        }
      }
      if (foldValidator !== null && foldValidator !== undefined) {
        foldValidator([rows[0], ...repair.events])
      }
      const summary = `${repair.stats.orphanWraps} orphan import(s) wrapped, ${repair.stats.coercedTurnStarts} turn/start(s) coerced, ${repair.stats.shiftedEvents} event(s) renumbered`
      const suffix = apply ? '' : ' (dry-run)'
      // v0 工件容器契约：第一帧必须恰好一行 header，body 随后。宿主读取器
      // 对第一帧行长严格（"first frame is not exactly one header line"）。
      const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(rows[0])}\n`, 'utf8'))
      const bodyFrame = zstdCompressSync(Buffer.from(`${repair.events.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8'))
      const encoded = Buffer.concat([headerFrame, bodyFrame])
      const decoded = scanZstdFrames(encoded)
        .map((frame) => zstdDecompressSync(encoded.subarray(frame.start, frame.end)).toString('utf8'))
        .join('')
      const expectedPlaintext = `${[rows[0], ...repair.events].map((row) => JSON.stringify(row)).join('\n')}\n`
      if (decoded !== expectedPlaintext) throw new Error('repaired artifact failed compressed round-trip validation')
      if (!apply) {
        try {
          await observeValidator(path, sessionId)
          console.log(`repair${suffix} ${path}: ${summary}; note: current artifact already passes observe — repair is preventive`)
        } catch {
          console.log(`repair${suffix} ${path}: ${summary}`)
        }
        touched += 1
        continue
      }
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(path, backup)
      const temporary = `${path}.repair-${process.pid}.tmp`
      writeFileSync(temporary, encoded)
      renameSync(temporary, path)
      const observed = await observeValidator(path, sessionId)
      console.log(`repair${suffix} ${path}: ${summary}; host observe passes (${observed} events)`)
      console.log(`   backup: ${backup}`)
      touched += 1
    } catch (error) {
      if (backup !== undefined && existsSync(backup)) {
        copyFileSync(backup, path)
        console.error(`FAILED verification ${path}: ${error.message} — original restored from backup`)
      } else {
        console.error(`FAILED verification ${path}: ${error.message} — artifact left untouched`)
      }
      failed += 1
    }
    continue
  }

  if (rows[0].version !== 4) {
    clean += 1
    continue
  }
  const sessionId = typeof rows[0].id === 'string' ? rows[0].id : undefined
  // 只有宿主可见布局（目录名 = session id）才能走原生 observe：持久化栈按
  // <root>/<workspace>/<session-dir>/ 枚举，扁平/旧布局下找不到该工件
  // （与 v0 分支同一判据）。
  const hostVisible = sessionId !== undefined && basename(dirname(resolve(path))) === sessionId
  if (hostVisible && admission.base !== undefined && observeValidator === undefined) {
    observeValidator = await loadObserveValidator(admission.base)
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
      // 内容准入可以过而容器损坏（历史单帧写回产物）：宿主可见布局下补一次
      // 真实 observe，不把"脚本认为干净"的坏容器报成 clean。
      if (hostVisible && observeValidator !== undefined) await observeValidator(path, sessionId)
      console.log(`clean ${path}`)
    } catch (error) {
      console.error(`DIRTY-BUT-UNRECOGNIZED ${path}: ${error.message} — manual inspection needed`)
      failed += 1
    }
    clean += 1
    continue
  }
  let backup
  try {
    verifyAdmission(admission, repair.rows[0], repair.rows.slice(1))
    const encoded = encodeV4Artifact(repair.rows)
    assertV4Container(encoded, repair.rows)
    const summary = `${repair.stats.chunksDropped} chunk(s) dropped, ${repair.stats.streamsBackfilled} stream(s) backfilled, ${repair.stats.importWraps} import turn(s) wrapped, ${repair.stats.turnsShifted} live event(s) renumbered, ${repair.stats.sourcesRewritten} source(s) rewritten, ${repair.stats.headsInserted} surface head(s) inserted`
    const suffix = apply ? '' : ' (dry-run)'
    console.log(`repair${suffix} ${path}: ${summary}; real v4 admission passes`)
    if (apply) {
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(path, backup)
      const temporary = `${path}.repair-${process.pid}.tmp`
      writeFileSync(temporary, encoded)
      renameSync(temporary, path)
      // 写后硬验证：宿主可见布局必须通过真实持久化 open+read；失败回滚备份。
      if (hostVisible && observeValidator !== undefined) {
        const observed = await observeValidator(path, sessionId)
        console.log(`   host observe passes (${observed} events)`)
      }
      console.log(`   backup: ${backup}`)
    }
    touched += 1
  } catch (error) {
    if (backup !== undefined && existsSync(backup)) {
      copyFileSync(backup, path)
      console.error(`FAILED verification ${path}: ${error.message} — original restored from backup`)
    } else {
      console.error(`FAILED verification ${path}: ${error.message} — artifact left untouched`)
    }
    failed += 1
  }
}
console.log(`\n${apply ? 'applied' : 'dry-run'}: ${artifactPaths.length} artifact(s), ${touched} repaired, ${clean} clean/skipped, ${failed} failed`)
if (!apply && touched > 0) console.log('re-run with --apply to write repairs')
if (failed > 0) process.exit(1)
