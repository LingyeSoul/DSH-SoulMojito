/**
 * Mod 事件面（提案 0015 §3.3 P1 的 api.events）：`chat-saved` / `assets-saved` /
 * `guides-changed` 三个落盘后 kind + `stream-delta`（A-3，流式观察）。
 *
 * 模块级单例（generationHooks 同款）：mod 宿主只活在 index bundle，发射点
 * （HTTP 路由 / runGeneration 落盘点）与监听方同 bundle，不需要跨 bundle 锚定。
 * guides-changed 的既有总线（guides.ts，globalThis 注册表）由宿主在打开时桥接
 * 进来——不要求监听方感知两条总线。
 *
 * 监听器逐个吞错（cross-bundle-events 同纪律）：一个 mod 的事件失败不允许影响
 * 其他监听方，更不允许把宿主的落盘路径变成失败路径。错误经适配层的包装上报
 * 审计（host.ts 注入），这里只保证不抛。stream-delta 是逐 chunk 高频事件，
 * 审计防洪（每流代次每 mod 首错）见文件尾部的发射面。
 */

export type ModEventKind = 'chat-saved' | 'assets-saved' | 'guides-changed' | 'stream-delta'

export interface ModEventPayloads {
  /** 聊天落盘后（PUT chat / guides 写入 / 生成两段落盘 / STscript persist）。 */
  'chat-saved': { character: string; chatId: string; revision: string }
  /** 资产保存/导入后（character/world/preset/persona/group）。 */
  'assets-saved': { kind: string; name: string }
  /** guides 变更（guides.ts 既有总线的桥接）。 */
  'guides-changed': { character: string; chatId: string }
  /**
   * ST 生成循环的流式增量（A-3，JSR 的 STREAM_TOKEN fully/incrementally 双通道
   * 合成单事件双字段）：每 text-delta chunk 发一次。v1 只覆盖 ST 循环
   * （runGeneration 的 llm.stream 消费点）——AgentTavern 生成走宿主 AgentLoop，
   * 不在此面（mod-api.md §5 如实标注）。reasoning 增量不进事件（v1 只观察正文）。
   */
  'stream-delta': {
    mode: 'send' | 'regenerate' | 'trigger'
    character: string
    chatId: string
    /** 当前累积全文（fully 通道）。 */
    text: string
    /** 本次增量（incrementally 通道）。 */
    delta: string
  }
}

export type ModEventHandler<K extends ModEventKind = ModEventKind> = (
  payload: ModEventPayloads[K],
) => void | Promise<void>

const MOD_EVENT_KINDS = new Set<ModEventKind>(['chat-saved', 'assets-saved', 'guides-changed', 'stream-delta'])

class ModEventBus {
  private readonly listeners = new Map<ModEventKind, Set<ModEventHandler>>()

  isKind(value: unknown): value is ModEventKind {
    return typeof value === 'string' && MOD_EVENT_KINDS.has(value as ModEventKind)
  }

  hasListeners(kind: ModEventKind): boolean {
    const set = this.listeners.get(kind)
    return set !== undefined && set.size > 0
  }

  on(kind: ModEventKind, handler: ModEventHandler): () => void {
    const set = this.listeners.get(kind) ?? new Set()
    set.add(handler)
    this.listeners.set(kind, set)
    return () => {
      set.delete(handler)
    }
  }

  async emit<K extends ModEventKind>(kind: K, payload: ModEventPayloads[K]): Promise<void> {
    const set = this.listeners.get(kind)
    if (set === undefined || set.size === 0) return // 快路径：无监听零开销
    for (const handler of [...set]) {
      try {
        await handler(payload)
      } catch {
        // 逐个吞错；适配层的包装已把失败记进审计线。
      }
    }
  }
}

export const modEvents = new ModEventBus()

/* ---------------- 宿主发射点用的薄封装（index.ts 调用） ---------------- */

/** 聊天落盘点发射（best-effort，与 emitGuidesChanged 同纪律）。 */
export function emitChatSaved(character: string, chatId: string, revision: string): Promise<void> {
  return modEvents.emit('chat-saved', { character, chatId, revision })
}

/** 资产保存/导入点发射。kind ∈ character|world|preset|persona|group。 */
export function emitAssetsSaved(kind: string, name: string): Promise<void> {
  return modEvents.emit('assets-saved', { kind, name })
}

/* ------------- stream-delta 发射面（A-3，2026-10-11） ------------- */

/**
 * 流代次序号：runGeneration 每次进入 llm.stream 消费前 `beginStreamEpoch()`。
 * 审计防洪的「每代次每 mod 只记首条 event-error」判据——mod 宿主的适配层
 * （host.ts events.on 包装）读 `currentStreamEpoch()` 比对，见
 * decisions/2026-10-11-mod-stream-delta.md。
 *
 * 两个变量刻意分开：`streamEpoch` 只在入队路径被读写（beginStreamEpoch 递增、
 * emitStreamDelta 捕获），投递路径换入换出的是独立的 `dispatchEpoch`——否则
 * 投递窗口内另一代生成入队会捕获到被换入的旧代次，审计归因漂移。
 */
let streamEpoch = 0
/** 正在投递的 payload 所属代次（投递串行，换入换出不交错）。 */
let dispatchEpoch = streamEpoch

/** 当前流代次（host.ts 首错审计判据；投递中返回所投 payload 的入队代次）。 */
export function currentStreamEpoch(): number {
  return dispatchEpoch
}

/** 进入一次新的流式生成时递增代次（runGeneration 消费 llm.stream 前调用）。 */
export function beginStreamEpoch(): void {
  streamEpoch += 1
}

/** stream-delta 的串行投递尾（见 emitStreamDelta）。 */
let streamDeltaTail: Promise<void> = Promise.resolve()

/**
 * 流式增量发射（runGeneration 每 text-delta chunk 一次，拼接累积全文之后）。
 *
 * 三个刻意的发射纪律（A-3 决策）：
 * - **不背压生成**：fire-and-forget，不在生成循环里 await——慢 handler 不许
 *   节流 ST 流式消费与 SSE 下行（与 chat-saved 落盘点 await 的低频语义不同）；
 * - **投递保序**：同一进程内经单一 promise 链串行投递，打字机观察不乱序；
 * - **无订阅零开销**：无监听时一次 Map 查找即返回，不碰投递链。
 *
 * handler 错误由总线逐个吞掉（不中断生成）；审计走宿主适配层的首错纪律。
 * Stop/abort 天然停发：发射点在 text-delta 分支内，finish(error/aborted) 抛出
 * 后循环退出，不再有下一次调用。
 */
export function emitStreamDelta(payload: ModEventPayloads['stream-delta']): void {
  if (!modEvents.hasListeners('stream-delta')) return
  const epoch = streamEpoch
  streamDeltaTail = streamDeltaTail
    .then(async () => {
      // 归因不漂移：投递时刻的代次以入队时为准（尾部排空晚于下一次生成开始时，
      // 审计仍归 chunk 所属的旧代次）。投递串行（单一链），换入换出不会交错；
      // 完毕后回到全局计数器当前值。
      dispatchEpoch = epoch
      try {
        await modEvents.emit('stream-delta', payload)
      } finally {
        dispatchEpoch = streamEpoch
      }
    })
    .catch(() => {
      // emit 自身逐个吞错；此处防御性兜底，投递链永不 rejected（否则后续 chunk 全部沉默）。
    })
}

/** 排空在飞的 stream-delta 投递（测试观察与进程收尾用）。 */
export function drainStreamDeltas(): Promise<void> {
  return streamDeltaTail
}
