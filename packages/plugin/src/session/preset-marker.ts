/**
 * 会话日志里的 **当前** preset 标记读取。
 *
 * 0.2.1 的 session controller 在复用 blank 会话时会 `presets.select(live, target)`
 * 把会话改回请求的 preset（`reuseLive`）；请求未带 `agentPreset` 时 target 是
 * 宿主默认（`standard`），于是日志会依次出现 `agent-tavern`、`standard` 两条
 * `agent-preset/selected`。宿主的 `agentPreset` 投影取**最后一条**，而本仓库旧
 * 的幂等检查用的是 `some(agent-tavern)`——标记曾出现就让 recompose 短路，工具
 * 面停在 standard。
 *
 * 因此 preset 身份判定必须读最后一条 selected，而不是「曾经出现过」。
 */
import { sessionEvents, type HostSessionLog } from '../../../bind/src/index.js'

/** 最后一条 `agent-preset/selected` 的 preset id；无标记时返回 undefined。 */
export function lastSelectedPresetId(session: HostSessionLog | null | undefined): string | undefined {
  const events = sessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const preset = (event.data as { agentPreset?: unknown } | undefined)?.agentPreset
    if (typeof preset === 'string') return preset
  }
  return undefined
}
