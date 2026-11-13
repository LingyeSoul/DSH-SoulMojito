/**
 * 快速回复（ST Quick Replies；施工契约 2026-11-12 §2.6）的读取口径。
 *
 * ST 的 Quick Reply 是「一组逐行 STscript + 一个自动化 id」的资产：composer
 * 按钮行按名执行、世界书条目 `automationId` 命中时在生成装配阶段自动执行一次。
 * 数据落在 `TavernState.quickReplies`（tavern-store），本模块只做三件事：
 *
 * - 名字匹配（`/qr <name>`、`/run <name>` 与 composer 按钮共用同一口径）；
 * - 自动化触发筛选（启用 + `automationId` 命中）；
 * - 把集合展开成一条可提交脚本（行序即执行序；同一个脚本作用域里跑，所以
 *   多行 `/setvar` 这类局部变量能跨行生效）。
 *
 * 架构边界：只在 ST 架构（`generation/pipeline.ts` 的 `runTavernScript`）里
 * 可执行。AgentTavern 的生成走 AgentLoop，没有 STscript 通道——`/qr` 在
 * Agent 会话里由调用方报错，不静默忽略。
 */

import type { QuickReplySet, TavernState } from '../../tavern-store/src/index.js'

/** 状态里的集合形态就是 store 的类型；此处转出供插件侧统一引用。 */
export type { QuickReplySet } from '../../tavern-store/src/index.js'

/**
 * 按名查集合：去空白、大小写不敏感（ST `/qr` 的命令匹配口径）。
 *
 * 只看名字不看 `enabled`——手动 `/qr` 与面板按钮是同一个执行面，ST 里停用
 * 集合只影响按钮行展示，不阻止用户显式调用它。
 */
export function findQuickReplySet(
  state: Pick<TavernState, 'quickReplies'>,
  name: string,
): QuickReplySet | undefined {
  const target = name.trim().toLowerCase()
  if (target === '') return undefined
  return (state.quickReplies ?? []).find((set) => set.name.trim().toLowerCase() === target)
}

/**
 * 世界书 `automationId` 命中的启用集合（ST 的 Quick Reply 自动执行）。
 *
 * 只由集合自身的 `enabled` 门控：`quickRepliesEnabled` 是 composer 按钮行的
 * 显示开关，不改变已经挂到条目上的自动化语义。
 */
export function quickReplySetsForAutomation(
  state: Pick<TavernState, 'quickReplies'>,
  automationId: string,
): QuickReplySet[] {
  const target = automationId.trim()
  if (target === '') return []
  return (state.quickReplies ?? []).filter(
    (set) => set.enabled && (set.automationId ?? '').trim() === target,
  )
}

/**
 * 集合展开成一条可提交脚本（每个 `commands` 项一行，行序即执行序）。
 * 空集合返回 undefined——调用方据此区分「无内容」与「执行失败」。
 */
export function quickReplyScript(set: QuickReplySet): string | undefined {
  const lines = set.commands.map((line) => line.trim()).filter((line) => line !== '')
  return lines.length === 0 ? undefined : lines.join('\n')
}
