/**
 * AgentTavern compaction curator 的纯数据部分：不依赖任何宿主包，
 * 可被单元测试直接导入。宿主 dsh-compaction-basic 的摘要是编码助手导向的
 * （Files and Code / Pending Jobs），会把角色扮演状态摘要掉；这里提供
 * RP 检查点模板与其余配置切分。
 */

/** 与宿主 basic 包相同的 checkpoint 包裹标签；摘要规则需要引用它识别旧检查点。 */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'

export const RP_COMPACTION_INSTRUCTION = [
  'You are now acting as the compaction curator for this AgentTavern roleplay session. Condense the conversation ABOVE into a structured checkpoint that lets the same character resume the story with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Story So Far',
  "- [the plot in order: key events, turning points, and what changed for the user's character]",
  '',
  '## Characters',
  "- [per recurring character: identity, relationship to the user's character, current location, state (health, possessions, mood), promises and debts]",
  '',
  '## World Canon',
  '- [established facts from world books and narration: places, factions, powers, items, history. Only what was established; never invent.]',
  '',
  '## Open Threads',
  '- [unresolved situations, unanswered questions, foreshadowing, pending decisions]',
  '',
  '## Current Scene',
  '- [time, place, who is present, the exact situation at this checkpoint]',
  '',
  '## Memory Maintenance',
  '- [what was recorded with the memory or variable tools, and which significant facts above are still unrecorded and should be written next]',
  '',
  '## Critical Context',
  '- [user instructions about style, pacing, content boundaries, and anything the user asked to remember]',
  '',
  'Rules:',
  '- Write in the same language as the conversation.',
  '- Preserve names, titles, numbers, and quoted phrases verbatim.',
  '- Record only what the conversation established; do not add interpretation or invent facts.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** curator 专属配置键；不属于宿主 dsh-compaction-basic 的配置契约。 */
export const CURATOR_CONFIG_KEYS = ['curatorProvider', 'curatorModel', 'curatorMaxTokens'] as const

export interface CuratorOptions {
  curatorProvider?: string
  curatorModel?: string
  curatorMaxTokens?: number
}

/** 从整行配置中分离 curator 专属键与其余宿主 basic 配置；非法值静默丢弃。 */
export function splitCuratorConfig(config: Record<string, unknown>): { curator: CuratorOptions; basic: Record<string, unknown> } {
  const curator: CuratorOptions = {}
  const basic: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (key === 'curatorProvider') {
      if (typeof value === 'string' && value.trim() !== '') curator.curatorProvider = value
    } else if (key === 'curatorModel') {
      if (typeof value === 'string' && value.trim() !== '') curator.curatorModel = value
    } else if (key === 'curatorMaxTokens') {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) curator.curatorMaxTokens = value
    } else {
      basic[key] = value
    }
  }
  return { curator, basic }
}
