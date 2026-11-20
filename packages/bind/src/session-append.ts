/**
 * 宿主 Session 的批量写入兼容层。
 *
 * DSH `0.2.2-rc.5` 的 `Session.append` 在首参不是字符串时进入批量路径：
 * 先把整批 `[type, data, opts?]` 快照与 surface 折叠全部校验完，再一次提交；
 * 任一候选或同步派发校验失败时，日志在提交前保持原状。老宿主只接受
 * `append(type, data, opts?)`，逐条写并在首个失败处留下已提交前缀。
 *
 * 批量能力没有可调用的探测方法，也不按宿主版本号分支：rc.5 的
 * `Session.surface`（公开 getter）新增 `prepareBatch`，批量 append 的提交
 * 依赖它完成 surface 折叠，因此以该函数作为宿主形状探针。探测失败时调用方
 * 明确走逐条语义，不把数组盲传给老宿主、也不在异常后重试（重试会重复写入
 * 已提交前缀）。
 */

/** 一条可批量提交的宿主事件输入（与 DSH `SessionEventInput` 的元组形状一致）。 */
export type SessionAppendInput = readonly [type: string, data: unknown, opts?: unknown]

/** `Session.append` 的最小结构面；老宿主只有三参形式。 */
export interface SessionAppendLike {
  append(type: string, data: unknown, opts?: unknown): unknown
  surface?: { prepareBatch?: unknown }
}

export type SessionAppendMode = 'batch' | 'sequential'

export interface SessionAppendResult {
  /** `batch` = 原生一次提交；`sequential` = 老宿主逐条写入。 */
  readonly mode: SessionAppendMode
  /** 宿主 append 的返回值，按输入顺序。 */
  readonly events: readonly unknown[]
}

/**
 * append 失败时携带已提交进度。批量宿主按契约在提交前失败（`committed = 0`）；
 * 老宿主在首个失败处停下，`committed` 是已落日志的前缀长度。调用方据此决定
 * 是否补关已经打开的 turn/step，而不是把所有失败都当成“全没写”。
 */
export class SessionAppendError extends Error {
  readonly mode: SessionAppendMode
  readonly committed: number
  readonly events: readonly unknown[]

  constructor(
    mode: SessionAppendMode,
    committed: number,
    events: readonly unknown[],
    cause: unknown,
  ) {
    super(
      mode === 'batch'
        ? `session batch append was rejected before commit: ${cause instanceof Error ? cause.message : String(cause)}`
        : `session append failed after ${committed} committed event(s): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'SessionAppendError'
    this.mode = mode
    this.committed = committed
    this.events = events
  }
}

/** 失败前已落日志的事件数；非 `appendSessionEvents` 抛出的错误按 0 计。 */
export function committedSessionAppends(error: unknown): number {
  return error instanceof SessionAppendError ? error.committed : 0
}

/** 宿主是否暴露 rc.5+ 的批量 append 形状。 */
export function supportsSessionBatchAppend(session: SessionAppendLike | null | undefined): boolean {
  return typeof session?.append === 'function'
    && typeof session.surface?.prepareBatch === 'function'
}

/**
 * 按宿主能力提交一组连续事件。
 *
 * - 批量宿主：一次 `append(inputs)`，全成或全不成；失败抛 `SessionAppendError`
 *   （`committed = 0`，`cause` 是宿主异常），不降级重试。
 * - 老宿主：按输入顺序逐条 `append(type, data, opts)`；首个失败抛
 *   `SessionAppendError`，`committed` 是已落日志的前缀长度。
 */
export function appendSessionEvents(
  session: SessionAppendLike,
  inputs: readonly SessionAppendInput[],
): SessionAppendResult {
  const mode: SessionAppendMode = supportsSessionBatchAppend(session) ? 'batch' : 'sequential'
  if (inputs.length === 0) return { mode, events: [] }
  if (mode === 'batch') {
    const batchSession = session as unknown as {
      append(batch: readonly SessionAppendInput[]): readonly unknown[]
    }
    try {
      return { mode, events: batchSession.append(inputs) }
    } catch (error) {
      throw new SessionAppendError(mode, 0, [], error)
    }
  }
  const events: unknown[] = []
  for (const [type, data, opts] of inputs) {
    try {
      events.push(session.append(type, data, opts))
    } catch (error) {
      throw new SessionAppendError(mode, events.length, events, error)
    }
  }
  return { mode, events }
}