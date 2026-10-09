/**
 * Conversation Guides（持续指引，提案 0009）：玩家为单局聊天写下的持续生效
 * 要求（节奏 / 写法 / 剧情偏好），存于 chat.header.chat_metadata.guides，
 * 请求侧注入（ST 链路 system 段末尾、AgentTavern 的 agent-guides context 段），
 * 不是楼层内容，导出纯对话不携带。
 *
 * Guide 是用户指令（untrusted-but-user-authored）：注入块自带「user directives」
 * 标注，不伪装成世界书或角色设定。本模块只做纯逻辑（校验 / 增删 / 格式化 /
 * 变更回调），不触达 store——读写持久化由 index.ts 的 guides 路由完成。
 */

export interface ConversationGuide {
  id: string
  text: string
  createdAt: string
}

/** 上限 8 条、单条 trim 后 ≤500 字符：flizzywine 未公开限制，这是防注入面失控的本地决策（提案 0009 §1）。 */
export const GUIDES_MAX_COUNT = 8
export const GUIDE_MAX_TEXT_LENGTH = 500

export const GUIDES_BLOCK_HEADER = 'Conversation guides (persistent user directives; apply to every reply):'

/** 读取 chat_metadata.guides 的原始值，过滤掉形状不合法的条目（手改 jsonl 的容错）。 */
export function normalizeGuides(value: unknown): ConversationGuide[] {
  if (!Array.isArray(value)) return []
  const guides: ConversationGuide[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { id, text, createdAt } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id === '') continue
    if (typeof text !== 'string' || text.trim() === '') continue
    if (typeof createdAt !== 'string' || createdAt === '') continue
    guides.push({ id, text: text.trim(), createdAt })
  }
  return guides
}

export type AddGuideResult =
  | { ok: true; guide: ConversationGuide; guides: ConversationGuide[] }
  | { ok: false; error: string }

/** 校验并追加一条 guide：text trim 后非空、≤500 字符，列表上限 8 条；id 用 crypto.randomUUID()，createdAt ISO。 */
export function addGuide(guides: ConversationGuide[], text: unknown): AddGuideResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'guide text is required and must be a non-empty string' }
  }
  const trimmed = text.trim()
  if (trimmed.length > GUIDE_MAX_TEXT_LENGTH) {
    return { ok: false, error: `guide text must be at most ${GUIDE_MAX_TEXT_LENGTH} characters (got ${trimmed.length})` }
  }
  if (guides.length >= GUIDES_MAX_COUNT) {
    return { ok: false, error: `guide limit reached: at most ${GUIDES_MAX_COUNT} guides per chat` }
  }
  const guide: ConversationGuide = { id: crypto.randomUUID(), text: trimmed, createdAt: new Date().toISOString() }
  return { ok: true, guide, guides: [...guides, guide] }
}

export function removeGuide(guides: ConversationGuide[], id: string): { removed: boolean; guides: ConversationGuide[] } {
  const next = guides.filter((guide) => guide.id !== id)
  return { removed: next.length !== guides.length, guides: next }
}

/**
 * 格式化为注入块：首行固定标注，每条一行 `- text`，按 createdAt 升序（新指南在后）。
 * 空列表 / 无合法条目时返回 undefined——调用方据此跳过注入，不占 system 段。
 */
export function formatGuidesBlock(guides: unknown): string | undefined {
  const normalized = normalizeGuides(guides)
  if (normalized.length === 0) return undefined
  return [
    GUIDES_BLOCK_HEADER,
    ...[...normalized].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((guide) => `- ${guide.text}`),
  ].join('\n')
}

/* ---------------- AgentTavern 缓存刷新（写穿回调） ---------------- */

import { createGlobalListenerRegistry } from './cross-bundle-events.js'

type GuidesChangedListener = (character: string, chatId: string) => void | Promise<void>

// globalThis 锚定（同学科于 agent-novel/usage.ts 与 agent-tavern/preset.ts）：
// emit 发生在 index.mjs 的 guides 路由，监听在 agent.mjs——分离 bundle 各持
// 一份模块级 Set 会互不可见，写穿必须共享同一注册表。key 逐字保留存量值。
const guidesChanged = createGlobalListenerRegistry<GuidesChangedListener>('dsh-tavern:guides-changed-listeners')

/**
 * 注册 guides 变更回调（agent.ts 模块加载时调用，按 character/chatId 反查
 * sessionBindings 里绑定的 agentId，即时刷新 agent-guides 装配缓存）。
 * 返回反注册函数。
 */
export function onGuidesChanged(listener: GuidesChangedListener): () => void {
  return guidesChanged.on(listener)
}

/**
 * guides 写路由（增/删）成功后触发缓存刷新。best-effort：聊天已落库，
 * 任何回调失败都不允许反过来把成功的写变成错误响应，所以逐个静默吞掉。
 */
export function emitGuidesChanged(character: string, chatId: string): Promise<void> {
  return guidesChanged.emit(character, chatId)
}
