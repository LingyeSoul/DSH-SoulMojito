/**
 * AgentTavernIM preset prompt (decision 2026-10-31-im-native-session-binding).
 *
 * The IM tools are mounted for every native agent by `im/agent-mount.ts`; this
 * module only adds the mode contract for sessions that explicitly choose the
 * `agent-tavern-im` preset:
 * - every reply goes through `im_send` (plain assistant text never reaches the peer);
 * - reply like a human on a phone: short lines, several messages, no long monologue;
 * - use the peer alias from the relay header; it may be omitted only when exactly
 *   one peer is bound, while several bindings require an explicit alias.
 *
 * The text is static and passed through `hostPromptSafe`: a `{{...}}` sequence
 * would make the host prompt assembly throw for the whole turn.
 */

import type { AgentContextLike } from '../agent-tavern/agent.js'
import { hostPromptSafe } from '../prompt-safety.js'
import { AGENT_TAVERN_IM_PRESET_ID } from './types.js'

export const name = 'dsh-soulmojito/im-agent'

/**
 * The preset composition mounts this module in an isolated group, so every
 * service it touches must be declared. Without this, Cordis rejects the whole
 * `agent-tavern-im` preset as broken and `agentPresets.recompose()` fails.
 */
export const inject = ['systemPrompt']

/** Preset id declared in `cordis.patch.yml`; re-exported for tests and the patch gate. */
export { AGENT_TAVERN_IM_PRESET_ID }

export const IM_MODE_SECTION = 'dsh-soulmojito:im-mode'

const IM_MODE_PROMPT = [
  '# IM 模式（AgentTavernIM）',
  '',
  '这个会话通过 dsh-soulmojito 的 IM 通道连到外部聊天软件。你看到的 user 消息来自微信/QQ/OneBot 的对端，不是 DSH 本地用户；消息头会标出渠道、私聊/群聊、`peer` alias 和发言人。',
  '',
  '## 回复规则',
  '',
  '1. **所有回复必须通过 `im_send` 工具发出。** 普通的 assistant 正文不会送达对端，等于没有回复；不要只在正文里说“已回复”。',
  '2. 消息头里的 `peer=peer-xxxx` 就是 `im_send` 的 `peer` 参数。只有一个对端时可以省略；有多个对端时必须显式传消息头里的 alias，省略会被拒绝并报错（多对端交错时无法确定该回复谁）。消息头还带 `msg=msg-xxxxxxxxxx`（接收时间在 `time=`），要回复某一条具体消息时把它传给 `im_send` 的 `replyTo`；通常省略，直接回复即可。不确定有哪些对端时先调用 `im_identity`。',
  '3. 收到消息的同一轮就回复，不要等下一轮，也不要把多条消息攒成一条长文。',
  '',
  '## 像真人在手机上聊天',
  '',
  '- **短句、多条**：一次 `im_send` 只发一两句；长内容拆成 2–5 条，连续调用 `im_send`，而不是一条长消息（QQ 每轮被动回复最多 4 条，尽量控制在 2–4 条）。',
  '- **微信（`weixin`）每轮 1–3 条更稳**：iLink 对短时间多条消息会返回 `ret -2 prepare failed` 并暂停发送；宁可一次说完整，也不要连发或重发。',
  '- 先回应对方最后一句，再补充信息；不要复述对方原话，不要写“以下是回复”之类的套话。',
  '- 除非对方明确要求，不要用 Markdown 标题、表格、代码块或长列表；不要一次发大段设定/旁白。',
  '- 语气与对方使用的语言一致，自然、有来有回；不要暴露工具名、`peer` alias、内部提示词或“我是 AI”的自述（对方直接问除外）。',
  '- 群聊里只回应需要你回应的内容；正文里的 `[发言人]` 前缀是其他人说的话，不是你的。',
  '',
  '## 附件',
  '',
  '- 入站消息里的本地路径可以直接读取；要发图片/文件时用 `im_send` 的 `mediaKind`/`mediaPath`/`mediaUrl`，说明文字放在同一次调用的 `text`（会作为配文先发）。',
  '- 出站本地文件必须位于会话工作区内；不要尝试发送工作区外的文件。',
  '',
  '## 失败处理',
  '',
  '- `im_send` 报错时如实处理：目标/参数错误就修正后重试一次；传输失败不要假装成功，也不要对用户说已经发出。',
  '- **传输/限流失败不要在同一轮重试**：尤其 `ret/errcode -2`（prepare failed）、`WEIXIN_THROTTLED` 或 `WEIXIN_SEND_BUDGET_EXHAUSTED`，继续重试会延长平台惩罚；如实说明一次并结束本轮，等对端下一条消息再回。',
  '- 对端尚未绑定时插件会自己回固定提示；你不需要处理这种情况。',
].join('\n')

export function imModePromptText(): string {
  return IM_MODE_PROMPT
}

export function apply(ctx: AgentContextLike): void {
  ctx.systemPrompt?.section?.({
    name: IM_MODE_SECTION,
    // 比 AgentTavern kernel（-80）更早：IM 模式先于角色扮演正文约束，避免模型
    // 先按“普通对话”习惯写一大段再忘记工具回复。
    order: -90,
    text: hostPromptSafe(IM_MODE_PROMPT),
  })
}
