/**
 * 变更串行队列：同一队列内保持入队顺序，前序失败不阻塞后续。
 * 收敛各 store 与宿主侧写入中同款的手写 `previous.catch(() => {}).then(operation)` 形状。
 */
export class MutationTail {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0

  constructor(private readonly onIdle?: () => void) {}

  /** 入队一个变更并返回其结果；后续变更在该变更落定后才执行。 */
  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(operation)
    this.tail = run.then(() => {}, () => {})
    this.pending++
    void this.tail.then(() => {
      this.pending--
      if (this.pending === 0) this.onIdle?.()
    })
    return run
  }

  /** 排空在飞变更：返回时已入队的全部变更均已落定（失败被吞掉不外抛）。 */
  drain(): Promise<void> {
    return this.tail.catch(() => {})
  }
}

/** 多键变更串行队列：键间并行、键内串行；deleteWhenIdle 时空闲键自动出表。 */
export class KeyedMutationTails<K> {
  private readonly tails = new Map<K, MutationTail>()

  constructor(private readonly deleteWhenIdle = false) {}

  enqueue<T>(key: K, operation: () => Promise<T>): Promise<T> {
    return this.tailFor(key).enqueue(operation)
  }

  /** 排空指定键的在飞变更；键不存在时立即落定。 */
  drain(key: K): Promise<void> {
    return this.tails.get(key)?.drain() ?? Promise.resolve()
  }

  private tailFor(key: K): MutationTail {
    const existing = this.tails.get(key)
    if (existing !== undefined) return existing
    const tail = new MutationTail(() => {
      if (this.deleteWhenIdle) this.tails.delete(key)
    })
    this.tails.set(key, tail)
    return tail
  }
}
