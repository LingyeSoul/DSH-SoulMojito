/**
 * 宿主 systemPrompt 文本安全化（DSH AgentLoop 装配层）。
 *
 * 根因（0.4.1 线上故障）：宿主 @deepseek-ai/dsh-system-prompt 的 interpolate()
 * 把 section/context 文本里的 {{name}} 当宿主模板变量渲染，注册表只有
 * provider/model/cwd——任何 {{...}} 组都会让装配抛错中止本轮运行：
 * 未注册的宏名 → "unknown prompt variable"；大写/含空格/含冒号的名字
 * → "malformed prompt variable"。角色卡、会话指引、剧本名是 ST 宏
 * （{{user}}/{{char}}/...）的高频来源，以原文进上下文必然踩雷。
 *
 * 处置：先按 ST 语义展开宏（与历史导入、快照预载通道一致），再把产物里
 * 残留的连续 { 括号拆开——宿主只扫描相邻的 "{{"，单括号与落单的 }}
 * 都是散文。宿主变量（{{model}} 等）也被一并中性化：这些通道不需要宿主
 * 变量；若未来某段文本真需要，显式拼接值而不是依赖宿主插值。
 */

import { createMacroEngine } from '../../tavern-macros/src/index.js'

/** ST 宏展开器：{{char}}=char、{{user}}=user（大小写不敏感，对齐 ST）；未知宏保留原样。 */
export function createHostPromptExpander(char: string, user: string): (text: string) => string {
  const macros = createMacroEngine({ char, user })
  return (text) => macros.expand(text)
}

/** 展开 ST 宏并保证产物不含任何相邻 "{{"，可直接交给宿主的 section/context。 */
export function hostPromptSafe(text: string, expand: (text: string) => string = (value) => value): string {
  // 括号成组拆开（{{ -> { {、{{{ -> { { {），一次扫描到底，杜绝三括号残留。
  return expand(text).replace(/\{+/g, (run) => run.split('').join(' '))
}
