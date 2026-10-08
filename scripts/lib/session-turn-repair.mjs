/**
 * v0 会话工件的统一 turn 坐标修复引擎（纯函数，无 I/O）。
 *
 * 背景（2026-10 历史加载失败族）：0.2.0-rc.2 的 observe 走完整代际迁移链
 * v0→v1→v2→v3→v4。dsh-tavern ≤0.3.9 写入的 v0 工件带两类 turn 毒：
 *
 * 1. 孤儿导入：历史导入的 assistant/message 带 `{ turn: 0 }` 且没有
 *    turn/start 包裹；v2→v3 迁移以 "turn must be positive" 拒绝整份工件。
 * 2. turn/start 号重复/跳号/为零：占位空 turn 与 live loop 在
 *    advanceHostTurnBase 建立之前碰撞，turn 号不再从 1 连续稠密。
 *
 * 修复语义（与 decisions/2026-10-05-v0-session-turn-repair.md 一致）：
 * - 孤儿导入包成完整开/关的真实 turn（turn/start→step/start→assistant→
 *   step/end→turn/end{completed}）；同一包裹内连续多个导入 assistant 依次
 *   占 step 1..n；插件来源的 user/message 留在包裹内（与 v4 场景 C 同规，
 *   其余事件先闭合包裹）。
 * - 所有 turn/start 按出现顺序重编号为从 1 连续稠密，同一 turn 区间内的
 *   载荷 turn 坐标跟随，turn/end 归位到它闭合的 turn。
 * - 展开空间重编号：磁盘列压缩行（text-chunks/reasoning-chunks/
 *   tool-call-chunks：seq0 + texts/args）按成员数占展开空间
 *   [seq0, seq0+N)；重写每行携带的 seq/seq0，并把引用逐点映射重写
 *   （sourceEventSeqs 数字与 [start, end] 闭区间、surfaceOp 范围、
 *   session/title messageSeqs、command/done sourceEventSeq、
 *   delivery-accepted throughSeq、compaction shadowedSeqs/shadowedRange）。
 * - chunk 引用校正：assistant/message 的 sourceEventSeqs 收敛为「紧邻前缀
 *   的 chunk 连续段」——LLM 重试的失败组（被 llm/retry(-started) 隔断）
 *   不计入引用。
 *
 * 只读契约：不修改入参；无需修复（健康工件）时返回 null，保证
 * 「健康工件零字节改动」（2026-10-05 过度医疗事故的防线）。
 */

const PACKED_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
const CHUNK_RUN_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks', 'assistant/chunk'])

/** 行占用的展开空间宽度：列压缩行按其成员数，其余 1。 */
function payloadWidth(row) {
  if (!PACKED_TYPES.has(row.type)) return 1
  const payload = row.type === 'tool-call-chunks' ? row.data?.args : row.data?.texts
  return Array.isArray(payload) && payload.length > 0 ? payload.length : 1
}

/** 行在展开空间中的起点：列压缩行是 seq0，其余是 seq（插入的新行为 undefined）。 */
function expandedStart(row) {
  return Number.isSafeInteger(row.seq0) ? row.seq0 : row.seq
}

function isTavernPluginSource(source) {
  if (source === null || typeof source !== 'object') return false
  return (source.kind === 'plugin' && source.plugin === 'dsh-tavern') || source.kind === 'plugin:dsh-tavern'
}

function hasTurn(row, turn) {
  return row.data !== null && typeof row.data === 'object' && row.data.turn === turn
}

function flattenRefs(refs) {
  const out = []
  for (const entry of refs) {
    if (typeof entry === 'number') out.push(entry)
    else if (Array.isArray(entry) && entry.length === 2 && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1])) {
      for (let seq = entry[0]; seq <= entry[1]; seq += 1) out.push(seq)
    }
  }
  return out
}

function refsMatchRun(refs, start, end) {
  const flat = flattenRefs(refs)
  if (flat.length !== end - start + 1) return false
  for (let index = 0; index < flat.length; index += 1) if (flat[index] !== start + index) return false
  return true
}

function sameNumbers(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * 把展开空间旧序号映射为新序号的逐点函数。区间表按旧起点稠密排列。
 */
function createSeqMapper(intervals) {
  return (seq) => {
    let low = 0
    let high = intervals.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (intervals[middle].oldStart <= seq) low = middle + 1
      else high = middle - 1
    }
    const interval = intervals[high]
    if (interval !== undefined && seq < interval.oldStart + interval.width) {
      return interval.newStart + (seq - interval.oldStart)
    }
    throw new Error(`reference seq ${seq} does not resolve to a renumbered row`)
  }
}

/**
 * 修复 v0 工件的 turn 坐标与由插入引起的序号/引用偏移。
 *
 * @param rows - 工件行（不含 header 行），磁盘原样形状（列压缩行带 seq0）。
 * @returns { events, stats } 或 null（无需任何修复；调用方必须原样保留字节）。
 */
export function repairSessionTurns(rows) {
  const stats = { orphanWraps: 0, coercedTurnStarts: 0, shiftedEvents: 0 }
  let dirty = false
  const out = []
  let nextTurn = 1
  let activeTurn = null
  let wrap = null

  const closeWrap = () => {
    if (wrap === null) return
    out.push({ type: 'turn/end', time: wrap.time, data: { turn: wrap.turn, reason: { kind: 'completed' } } })
    wrap = null
  }

  for (const row of rows) {
    if (row === null || typeof row !== 'object') {
      out.push(row)
      continue
    }
    const time = Number.isSafeInteger(row.time) ? row.time : 0

    // 1. 孤儿导入：turn 0 的 assistant 包成完整开/关的真实 turn。
    if (row.type === 'assistant/message' && row.data?.turn === 0) {
      if (wrap === null) {
        wrap = { turn: nextTurn, step: 0, time }
        nextTurn += 1
        stats.orphanWraps += 1
        out.push({ type: 'turn/start', time, data: { turn: wrap.turn } })
      }
      wrap.step += 1
      out.push({ type: 'step/start', time, data: { turn: wrap.turn, step: wrap.step } })
      out.push({ ...row, data: { ...row.data, turn: wrap.turn, step: wrap.step } })
      out.push({ type: 'step/end', time, data: { turn: wrap.turn, step: wrap.step } })
      dirty = true
      continue
    }

    if (wrap !== null && !(row.type === 'user/message' && isTavernPluginSource(row.data?.source))) closeWrap()

    // 2. turn/start 按出现顺序重编号（重复↑、跳号↓、零↑），保持从 1 稠密。
    if (row.type === 'turn/start') {
      const assigned = nextTurn
      nextTurn += 1
      activeTurn = assigned
      if (row.data?.turn !== assigned) {
        stats.coercedTurnStarts += 1
        dirty = true
        out.push({ ...row, data: { ...row.data, turn: assigned } })
      } else {
        out.push(row)
      }
      continue
    }

    if (row.type === 'turn/end') {
      const assigned = activeTurn ?? nextTurn
      if (activeTurn === null) nextTurn += 1
      activeTurn = null
      if (row.data?.turn !== assigned) {
        dirty = true
        out.push({ ...row, data: { ...row.data, turn: assigned } })
      } else {
        out.push(row)
      }
      continue
    }

    // 3. 当前 turn 区间内的载荷 turn 坐标跟随重编号（位置重映射）。
    if (activeTurn !== null && row.data !== null && typeof row.data === 'object'
      && Number.isSafeInteger(row.data.turn) && row.data.turn !== activeTurn) {
      dirty = true
      out.push({ ...row, data: { ...row.data, turn: activeTurn } })
      continue
    }
    out.push(row)
  }
  closeWrap()

  if (!dirty) return null

  // 4. chunk 引用校正：assistant 的 sourceEventSeqs 收敛为紧邻前缀的 chunk
  //    连续段（LLM 重试的失败组被 llm/retry(-started) 隔断，不计入引用）。
  for (let index = 0; index < out.length; index += 1) {
    const row = out[index]
    if (row?.type !== 'assistant/message' || !Array.isArray(row.sourceEventSeqs)) continue
    let start = index - 1
    while (start >= 0 && CHUNK_RUN_TYPES.has(out[start]?.type)) start -= 1
    const first = start + 1
    if (first > index - 1) continue
    const runStart = expandedStart(out[first])
    const runEnd = expandedStart(out[index - 1]) + payloadWidth(out[index - 1]) - 1
    if (!Number.isSafeInteger(runStart) || !Number.isSafeInteger(runEnd)) continue
    if (refsMatchRun(row.sourceEventSeqs, runStart, runEnd)) continue
    out[index] = { ...row, sourceEventSeqs: [[runStart, runEnd]] }
  }

  // 5. 展开空间稠密重编号 + 引用逐点重映射。
  const intervals = []
  let cursor = 0
  for (let index = 0; index < out.length; index += 1) {
    const row = out[index]
    const width = payloadWidth(row)
    const oldStart = expandedStart(row)
    if (row.seq0 !== undefined ? row.seq0 !== cursor : row.seq !== cursor) {
      out[index] = row.seq0 !== undefined ? { ...row, seq0: cursor } : { ...row, seq: cursor }
    }
    if (Number.isSafeInteger(oldStart)) {
      if (oldStart !== cursor) stats.shiftedEvents += 1
      intervals.push({ oldStart, newStart: cursor, width })
    }
    cursor += width
  }

  const mapSeq = createSeqMapper(intervals)
  const mapEntry = (entry) => {
    if (typeof entry === 'number') return mapSeq(entry)
    if (Array.isArray(entry) && entry.length === 2 && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1])) {
      return [mapSeq(entry[0]), mapSeq(entry[1])]
    }
    return entry
  }

  for (let index = 0; index < out.length; index += 1) {
    const row = out[index]
    if (Array.isArray(row.sourceEventSeqs)) {
      const mapped = row.sourceEventSeqs.map(mapEntry)
      if (!mapped.every((entry, offset) => JSON.stringify(entry) === JSON.stringify(row.sourceEventSeqs[offset]))) {
        out[index] = { ...row, sourceEventSeqs: mapped }
      }
    }
    const current = out[index]
    if (current.surfaceOp !== null && typeof current.surfaceOp === 'object') {
      const operation = current.surfaceOp
      if (Number.isSafeInteger(operation.start) && Number.isSafeInteger(operation.end)) {
        out[index] = { ...current, surfaceOp: { ...operation, start: mapSeq(operation.start), end: mapSeq(operation.end) } }
      }
    }
    const data = out[index].data
    if (data === null || typeof data !== 'object') continue
    let patch = null
    if (Array.isArray(data.messageSeqs)) {
      const mapped = data.messageSeqs.filter((seq) => Number.isSafeInteger(seq)).map(mapSeq)
      if (!sameNumbers(mapped, data.messageSeqs)) patch = { ...(patch ?? {}), messageSeqs: mapped }
    }
    if (Array.isArray(data.shadowedSeqs)) {
      const mapped = data.shadowedSeqs.filter((seq) => Number.isSafeInteger(seq)).map(mapSeq)
      if (!sameNumbers(mapped, data.shadowedSeqs)) patch = { ...(patch ?? {}), shadowedSeqs: mapped }
    }
    if (Array.isArray(data.shadowedRange) && data.shadowedRange.length === 2
      && Number.isSafeInteger(data.shadowedRange[0]) && Number.isSafeInteger(data.shadowedRange[1])) {
      const mapped = [mapSeq(data.shadowedRange[0]), mapSeq(data.shadowedRange[1])]
      if (!sameNumbers(mapped, data.shadowedRange)) patch = { ...(patch ?? {}), shadowedRange: mapped }
    }
    if (Number.isSafeInteger(data.sourceEventSeq)) {
      const mapped = mapSeq(data.sourceEventSeq)
      if (mapped !== data.sourceEventSeq) patch = { ...(patch ?? {}), sourceEventSeq: mapped }
    }
    if (Number.isSafeInteger(data.throughSeq)) {
      const mapped = mapSeq(data.throughSeq)
      if (mapped !== data.throughSeq) patch = { ...(patch ?? {}), throughSeq: mapped }
    }
    if (patch !== null) out[index] = { ...out[index], data: { ...data, ...patch } }
  }

  return { events: out, stats }
}
