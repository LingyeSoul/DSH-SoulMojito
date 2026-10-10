/**
 * ST 生成管线 hook 总线（提案 0015 §3.4，P0 空总线）。
 *
 * runGeneration 的五个既有变换点升格为总线相位（行号为提案写作时实测）：
 *   user-input   USER_INPUT regex 旁（regex 之前，mod 看到用户原文）
 *   pre-assemble assemblePrompt 前（装配输入 draft；群聊 nudge 已在 draft 末尾，
 *                mod 可见可改写——决策 2026-10-10-group-nudge-and-regex-slash）
 *   pre-llm      llm.stream 前（最终请求 {messages, system, params}）
 *   post-output  AI_OUTPUT regex 旁（regex/renderOutput 之前，mod 看到模型原文）
 *   post-save    saveChat 后（只读观察，返回值被丢弃）
 *
 * P0 纪律：总线恒空时生成路径行为逐字节不变。本文件交付骨架机制：
 * 顺序 waterfall + 单 hook 10s 超时/抛错降级跳过（renderText 失败保原文同款
 * 纪律，template.ts:304-311——hook 失败不中断生成，进入该 hook 前的值继续）。
 * P2（提案 0015 §4）开放注册面 api.hooks.on（mods/host.ts 适配层）：注册带
 * owner 归因（mod id），降级经 onDegradation 订阅进审计线与面板计数。
 */

/** 五个相位。key 字符串是 P1 api.hooks.on 的契约，不得变更。 */
export type GenerationHookPhase =
  | 'user-input'
  | 'pre-assemble'
  | 'pre-llm'
  | 'post-output'
  | 'post-save'

/** 生成轮次的只读元信息（与 payload 分离，hook 不改写它）。 */
export interface GenerationHookContext {
  phase: GenerationHookPhase
  mode: 'send' | 'regenerate' | 'trigger'
  character: string
  chatId: string
  group: boolean
}

/** 各相位的 payload 形状（P1 api.hooks.on 的类型基座）。 */
export interface GenerationHookPayloads {
  /** 用户输入原文（send 模式；regex 变换之前）。 */
  'user-input': string
  /** assemblePrompt 的装配输入 draft（字段同 AssembleInput）。 */
  'pre-assemble': Record<string, unknown>
  /** 进 llm.stream 的最终请求（messages 已是 LlmMessage 形状）。 */
  'pre-llm': { messages: unknown[]; system: string | undefined; params: Record<string, unknown> }
  /** 模型输出原文（AI_OUTPUT regex 与模板输出渲染之前）。 */
  'post-output': string
  /** 落盘后的只读观察（handler 返回值被丢弃）。 */
  'post-save': { chat: unknown; revision: number; speaker: string; finalText: string }
}

export type GenerationHookHandler<P extends keyof GenerationHookPayloads = keyof GenerationHookPayloads> = (
  payload: GenerationHookPayloads[P],
  context: GenerationHookContext,
) => GenerationHookPayloads[P] | Promise<GenerationHookPayloads[P]>

export interface HookDegradation {
  phase: GenerationHookPhase
  order: number
  reason: 'error' | 'timeout' | 'no-return'
  detail?: string
  /** P2（提案 0015 §3.3 api.hooks.on）：注册方归因——mod 宿主传 mod id，
   *  降级审计据此落到对应 Mod 的审计线；非 mod 注册方（宿主内部/测试）为
   *  undefined。仅观察用，不影响 waterfall 语义。 */
  owner?: unknown
}

interface Registration {
  id: number
  order: number
  handler: GenerationHookHandler
  owner?: unknown
}

/** 单 hook 超时（提案 §3.4：10s，Promise.race 降级）。测试经 options.timeoutMs 注入短值。 */
export const GENERATION_HOOK_TIMEOUT_MS = 10_000

export interface GenerationHookBusOptions {
  timeoutMs?: number
  /** 降级回调（P1 接日志与审计线）；P0 默认静默，计数仍累计。 */
  onDegradation?: (degradation: HookDegradation) => void
}

export interface GenerationHookBus {
  register<P extends keyof GenerationHookPayloads>(
    phase: P,
    handler: GenerationHookHandler<P>,
    order?: number,
    owner?: unknown,
  ): () => void
  dispatch<P extends keyof GenerationHookPayloads>(
    phase: P,
    payload: GenerationHookPayloads[P],
    context: Omit<GenerationHookContext, 'phase'>,
  ): Promise<GenerationHookPayloads[P]>
  /** 累计降级次数（P1 审计面板数据源）。 */
  degradationCount(): number
  /** P2：降级订阅（单例总线创建时无法传 options.onDegradation，mod 宿主与
   *  测试经此追加观察者；快照遍历，订阅内部抛错被吞——观察面不许反噬生成）。 */
  onDegradation(listener: (degradation: HookDegradation) => void): () => void
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // settle 时 clearTimeout：race 赢了的分支不留悬挂 timer（否则会拖住进程退出）。
    const timer = setTimeout(() => {
      const timeoutError = new Error(`generation hook timed out after ${ms}ms`) as Error & { hookTimeout?: true }
      timeoutError.hookTimeout = true
      reject(timeoutError)
    }, ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function createGenerationHookBus(options: GenerationHookBusOptions = {}): GenerationHookBus {
  const timeoutMs = options.timeoutMs ?? GENERATION_HOOK_TIMEOUT_MS
  const table = new Map<GenerationHookPhase, Registration[]>()
  const degradationListeners = new Set<(degradation: HookDegradation) => void>()
  let nextId = 1
  let degradations = 0

  function register<P extends keyof GenerationHookPayloads>(
    phase: P,
    handler: GenerationHookHandler<P>,
    order = 100,
    owner?: unknown,
  ): () => void {
    const id = nextId++
    const list = table.get(phase) ?? []
    list.push({ id, order, handler: handler as GenerationHookHandler, ...(owner !== undefined ? { owner } : {}) })
    list.sort((a, b) => a.order - b.order || a.id - b.id)
    table.set(phase, list)
    return () => {
      const current = table.get(phase)
      if (current === undefined) return
      table.set(phase, current.filter((registration) => registration.id !== id))
    }
  }

  async function dispatch<P extends keyof GenerationHookPayloads>(
    phase: P,
    payload: GenerationHookPayloads[P],
    context: Omit<GenerationHookContext, 'phase'>,
  ): Promise<GenerationHookPayloads[P]> {
    const list = table.get(phase)
    // 空相位快路径：P0 恒走此分支，原样返回（引用不变）。
    if (list === undefined || list.length === 0) return payload
    const fullContext: GenerationHookContext = { ...context, phase }
    let current = payload
    // 快照遍历：waterfall 过程中的注册/反注册不改变本轮集合。
    for (const registration of [...list]) {
      const degrade = (reason: HookDegradation['reason'], detail?: string) => {
        degradations += 1
        const degradation: HookDegradation = {
          phase,
          order: registration.order,
          reason,
          ...(detail !== undefined ? { detail } : {}),
          ...(registration.owner !== undefined ? { owner: registration.owner } : {}),
        }
        options.onDegradation?.(degradation)
        for (const listener of [...degradationListeners]) {
          try {
            listener(degradation)
          } catch {
            // 观察者失败不许影响生成路径。
          }
        }
      }
      try {
        const outcome = await withTimeout(
          Promise.resolve(registration.handler(current, fullContext)),
          timeoutMs,
        )
        if (outcome === undefined) {
          // hook 忘了 return：按不变处理（保 current），计一次降级——坏 hook
          // 不把 payload 洗成 undefined 炸生成。
          degrade('no-return')
        } else {
          current = outcome
        }
      } catch (error) {
        const timedOut = error instanceof Error && (error as { hookTimeout?: true }).hookTimeout === true
        degrade(timedOut ? 'timeout' : 'error', error instanceof Error ? error.message : String(error))
        // 降级跳过：进入该 hook 前的值继续 waterfall（保原文纪律）。
      }
    }
    return current
  }

  return {
    register,
    dispatch,
    degradationCount: () => degradations,
    onDegradation(listener) {
      degradationListeners.add(listener)
      return () => { degradationListeners.delete(listener) }
    },
  }
}

/**
 * 进程级单例：runGeneration 直接 dispatch 它；P1 的 mod 宿主（index bundle）
 * 经它注册 hook。空注册表时 dispatch 是纯恒等。
 */
export const generationHooks = createGenerationHookBus()
