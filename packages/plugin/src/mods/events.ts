/**
 * Mod 事件面（提案 0015 §3.3 P1 的 api.events）：`chat-saved` / `assets-saved` /
 * `guides-changed` 三个 kind。
 *
 * 模块级单例（generationHooks 同款）：mod 宿主只活在 index bundle，发射点
 * （HTTP 路由 / runGeneration 落盘点）与监听方同 bundle，不需要跨 bundle 锚定。
 * guides-changed 的既有总线（guides.ts，globalThis 注册表）由宿主在打开时桥接
 * 进来——不要求监听方感知两条总线。
 *
 * 监听器逐个吞错（cross-bundle-events 同纪律）：一个 mod 的事件失败不允许影响
 * 其他监听方，更不允许把宿主的落盘路径变成失败路径。错误经适配层的包装上报
 * 审计（host.ts 注入），这里只保证不抛。
 */

export type ModEventKind = 'chat-saved' | 'assets-saved' | 'guides-changed'

export interface ModEventPayloads {
  /** 聊天落盘后（PUT chat / guides 写入 / 生成两段落盘 / STscript persist）。 */
  'chat-saved': { character: string; chatId: string; revision: string }
  /** 资产保存/导入后（character/world/preset/persona/group）。 */
  'assets-saved': { kind: string; name: string }
  /** guides 变更（guides.ts 既有总线的桥接）。 */
  'guides-changed': { character: string; chatId: string }
}

export type ModEventHandler<K extends ModEventKind = ModEventKind> = (
  payload: ModEventPayloads[K],
) => void | Promise<void>

const MOD_EVENT_KINDS = new Set<ModEventKind>(['chat-saved', 'assets-saved', 'guides-changed'])

class ModEventBus {
  private readonly listeners = new Map<ModEventKind, Set<ModEventHandler>>()

  isKind(value: unknown): value is ModEventKind {
    return typeof value === 'string' && MOD_EVENT_KINDS.has(value as ModEventKind)
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
