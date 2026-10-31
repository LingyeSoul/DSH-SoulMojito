/**
 * IM 运行日志（提案 0024 §4.2 的可观测面）。
 *
 * 面板需要看见「消息到了没有、为什么没回」——宿主日志在终端里，用户在桌面端
 * 看不到。这里维护一个进程内环形缓冲：通道、绑定器、路由的关键节点都写一条，
 * HTTP 路由按序号增量读取。
 *
 * 两条纪律：
 * 1. **只存已脱敏的文本**。通道自己的日志本来就不打 token/openid（QR 只留
 *    host，peer 只留 alias），这里不再二次加工，也不接受任意对象。
 * 2. 重启即失。诊断信息是「现在发生了什么」，不是审计档案；要留档看宿主日志。
 */

import type { HostLogger } from '../host-contract.js'

export type ImLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ImLogEntry {
  /** 单调递增，跨环形淘汰继续增长：面板用 after= 取增量。 */
  seq: number
  at: number
  level: ImLogLevel
  text: string
}

export interface ImLogQuery {
  limit: number
  /** 只取序号大于它的条目；缺省从最旧一条开始。 */
  afterSeq?: number
  /** 只取不低于该等级的条目。 */
  minLevel?: ImLogLevel
}

export interface ImLogSnapshot {
  entries: ImLogEntry[]
  /** 下一条的起点；客户端下次原样带回 after。 */
  nextSeq: number
}

export interface ImLogSink {
  note(level: ImLogLevel, text: string): void
  /** 供测试与 HTTP 路由读取。 */
  read(query: ImLogQuery): ImLogSnapshot
}

/** 环形缓冲容量：一次完整排障足够，长跑进程也不会无限增长。 */
export const IM_LOG_CAPACITY = 500
/** 单条上限：异常文本可能带整段响应体，截断但不能撑爆面板。 */
const ENTRY_TEXT_LIMIT = 2_000

const LEVEL_WEIGHT: Readonly<Record<ImLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export function createImLog(options: { capacity: number; now: () => number }): ImLogSink {
  if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
    throw new Error(`IM log capacity must be a positive integer, received ${String(options.capacity)}`)
  }
  const entries: ImLogEntry[] = []
  let seq = 0

  function note(level: ImLogLevel, text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    seq += 1
    const safe = redactLogText(trimmed)
    entries.push({
      seq,
      at: options.now(),
      level,
      text: safe.length > ENTRY_TEXT_LIMIT ? `${safe.slice(0, ENTRY_TEXT_LIMIT)}…` : safe,
    })
    if (entries.length > options.capacity) entries.splice(0, entries.length - options.capacity)
  }

  function read(query: ImLogQuery): ImLogSnapshot {
    const limit = Number.isSafeInteger(query.limit) && query.limit > 0
      ? Math.min(query.limit, options.capacity)
      : options.capacity
    const minWeight = LEVEL_WEIGHT[query.minLevel ?? 'debug']
    const after = query.afterSeq ?? 0
    const selected: ImLogEntry[] = []
    for (const entry of entries) {
      if (entry.seq <= after) continue
      if (LEVEL_WEIGHT[entry.level] < minWeight) continue
      selected.push(entry)
    }
    // 增量读取取最新的 limit 条：面板刷新时最关心刚发生的事。
    const slice = selected.length > limit ? selected.slice(selected.length - limit) : selected
    return { entries: slice, nextSeq: seq }
  }

  return { note, read }
}

/**
 * 宿主日志的镜像：所有 IM 模块拿到的都是这一层，因此「终端能看到的」面板也能
 * 看到，不需要在每处同时写两份。只镜像文本，meta 仍只进宿主日志（可能含路径）。
 */
export function wrapImLogger(base: HostLogger | undefined, sink: ImLogSink): HostLogger {
  const record = (level: ImLogLevel, args: readonly unknown[]): void => {
    sink.note(level, textOfLogArgs(args))
  }
  return {
    debug: (...args) => { record('debug', args); base?.debug?.(...args) },
    info: (...args) => { record('info', args); base?.info?.(...args) },
    warn: (...args) => { record('warn', args); base?.warn?.(...args) },
    error: (...args) => { record('error', args); base?.error?.(...args) },
  }
}

/** 宿主日志的第一参数约定是消息文本；其余参数是结构化字段，不进面板。 */
function textOfLogArgs(args: readonly unknown[]): string {
  const first = args[0]
  return typeof first === 'string' ? first : String(first ?? '')
}

/**
 * 面板日志的路径脱敏：宿主日志经常带绝对路径（SDK 入口、媒体文件、token 文件），
 * 而 `GET im/logs` 是给浏览器读的。用户名与目录结构不该越过这条线，替换成
 * `<path>`；URL（`https://host/path`）不会被误伤——斜杠前是 `:`。
 *
 * 覆盖：带引号/括号前缀的 Windows 与 POSIX 路径、正反斜杠盘符、UNC（`\\host` 与
 * `//host`）、以及「引号包起来的带空格路径」（`'C:\Program Files\x.txt'`）。
 */
export function redactLogText(text: string): string {
  return text
    // 成对引号里的绝对路径：整段（含空格）替换，保留引号本身。
    .replace(/(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/\/|\/(?!\/))[^'"`]*)\1/g, (_match, quote: string) => `${quote}<path>${quote}`)
    .replace(/\b[A-Za-z]:[\\/][^\s'"`,;)]*/g, '<path>')
    .replace(/\\\\[^\s'"`,;)]+/g, '<path>')
    .replace(/(^|[\s"'`(=~])\/\/[^\s'"`,;)]+/g, (_match, prefix: string) => `${prefix}<path>`)
    .replace(/(^|[\s"'`(=~])\/(?:[^\s/'"`,;)]+\/)+[^\s/'"`,;)]*/g, (_match, prefix: string) => `${prefix}<path>`)
}
