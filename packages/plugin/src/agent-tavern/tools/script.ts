/** AgentTavern script tool slice (registration order 15-16) plus its progress summary projection. */

import {
  boundScriptOf,
  getScript,
  normalizeScriptProgress,
  type TavernStore,
} from '../../../../tavern-store/src/index.js'
import { dshHomePath } from '../../dsh-home.js'
import { createLazyProjection } from '../../lazy-projection.js'
import { createHostPromptExpander, hostPromptSafe } from '../../prompt-safety.js'
import { clampInt } from '../../tool-args.js'
import { DEFAULT_USER, bindingFor, objectOutput, tool, type ToolDefinition } from './shared.js'
import { tavernStore } from './stores.js'


export function scriptTools(): ToolDefinition[] {
  return [
    tool('tavern_script_read', 'Read one segment of the script bound to the current character: by default the segment at the current progress position, or the segment at chunkIndex when given. The script is a reference the player may deviate from, not a mandate. Returns found:false when no script is bound, so you can skip it gracefully.', {
      chunkIndex: { type: 'integer', description: 'Zero-based segment index; omit it to read the segment at the current progress position. Out-of-range values are clamped.' },
      maxChars: { type: 'integer', description: 'Maximum segment text characters, default 2400, capped at 4000.' },
    }, scriptReadOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const db = await tavernStore()
      const character = await db.getCharacter(binding.character)
      const scriptName = boundScriptOf(character?.card)
      if (scriptName === undefined) return { found: false }
      const script = await getScript(dshHomePath('tavern'), scriptName)
      if (script === undefined || script.chunks.length === 0) return { found: false }
      const snapshot = await db.getChatSnapshot(binding.character, binding.chatId)
      const progress = normalizeScriptProgress(snapshot?.chat.header.chat_metadata?.scriptProgress)
      const currentIndex = progress !== undefined && progress.scriptName === scriptName
        ? Math.min(progress.chunkIndex, script.chunks.length - 1)
        : 0
      const chunkIndex = clampInt(args.chunkIndex, 0, script.chunks.length - 1, currentIndex)
      const maxChars = clampInt(args.maxChars, 1, 4000, 2400)
      const chunk = script.chunks[chunkIndex]!
      return {
        found: true,
        scriptName,
        chunkIndex,
        chunkCount: script.chunks.length,
        text: chunk.text.slice(0, maxChars),
        truncated: chunk.text.length > maxChars,
      }
    }),
    tool('tavern_script_advance', 'Advance the bound script progress by exactly one segment, after the latest story actually covered the current segment (the player may deviate; do not advance on a deviation). Records alignedAt and an optional short note on the progress. Returns done:true at the final segment.', {
      note: { type: 'string', description: 'Optional alignment note recorded with the progress, capped at 200 characters.' },
    }, scriptAdvanceOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const db = await tavernStore()
      const character = await db.getCharacter(binding.character)
      const scriptName = boundScriptOf(character?.card)
      if (scriptName === undefined) return { found: false }
      const script = await getScript(dshHomePath('tavern'), scriptName)
      if (script === undefined || script.chunks.length === 0) return { found: false }
      const snapshot = await db.getChatSnapshot(binding.character, binding.chatId)
      if (!snapshot) throw new Error('bound Tavern chat not found')
      const prior = normalizeScriptProgress(snapshot.chat.header.chat_metadata?.scriptProgress)
      const priorIndex = prior !== undefined && prior.scriptName === scriptName
        ? Math.min(prior.chunkIndex, script.chunks.length - 1)
        : 0
      const done = priorIndex >= script.chunks.length - 1
      const chunkIndex = done ? priorIndex : priorIndex + 1
      const note = typeof args.note === 'string' && args.note.trim() !== '' ? args.note.trim().slice(0, 200) : undefined
      const progress = {
        scriptName,
        chunkIndex,
        alignedAt: new Date().toISOString(),
        ...(note !== undefined ? { lastNote: note } : {}),
      }
      // 读改存走 chat revision CAS：冲突抛 ChatRevisionConflictError，由 agent 重调重试。
      await db.saveChat(binding.character, binding.chatId, {
        ...snapshot.chat,
        header: {
          ...snapshot.chat.header,
          chat_metadata: { ...snapshot.chat.header.chat_metadata, scriptProgress: progress },
        },
      }, snapshot.revision)
      // 写穿：进度摘要 context 缓存即时刷新（模块内直更，见文件底部）。
      await refreshAgentScriptSummaries(binding.character, binding.chatId)
      return {
        found: true,
        scriptName,
        chunkIndex,
        chunkCount: script.chunks.length,
        done,
        alignedAt: progress.alignedAt,
        ...(note !== undefined ? { lastNote: note } : {}),
      }
    }),
  ]
}

const scriptReadOutput = objectOutput(
  {
    found: { type: 'boolean' },
    scriptName: { type: 'string' },
    chunkIndex: { type: 'integer' },
    chunkCount: { type: 'integer' },
    text: { type: 'string' },
    truncated: { type: 'boolean' },
  },
  ['scriptName', 'chunkIndex', 'chunkCount', 'text', 'truncated'],
)
const scriptAdvanceOutput = objectOutput(
  {
    found: { type: 'boolean' },
    scriptName: { type: 'string' },
    chunkIndex: { type: 'integer' },
    chunkCount: { type: 'integer' },
    done: { type: 'boolean' },
    alignedAt: { type: 'string' },
    lastNote: { type: 'string' },
  },
  ['scriptName', 'chunkIndex', 'chunkCount', 'done', 'alignedAt', 'lastNote'],
)
/** 剧本进度摘要文本通道（提案 0014 P2）：与 guides 同款 best-effort 异步装载
 *  ——首次为某 agent 装配时异步读一次绑定剧本与进度，装载完成前返回空串，
 *  失败静默留空，不阻塞装配。tavern_script_advance 落库后经
 *  refreshAgentScriptSummaries 写穿缓存，下一次装配即时生效。 */
const scriptSummaryProjection = createLazyProjection<string>({
  getState: async () => (await tavernStore()).getState(),
  load: async (agentId, settle) => {
    const db = await tavernStore()
    const state = await db.getState()
    const binding = state.sessionBindings[agentId]
    if (!binding || binding.architecture !== 'agent-tavern') return
    const text = await scriptSummaryForChat(db, binding.character, binding.chatId)
    // 剧本名是用户资产数据，可能含 {{...}}——摘要过同款安全化（prompt-safety.ts）。
    const expand = createHostPromptExpander(binding.character, state.activePersona ?? DEFAULT_USER)
    settle(hostPromptSafe(text, expand))
  },
})

export function agentScriptText(agentId: string | undefined): string {
  return scriptSummaryProjection.valueOf(agentId) ?? ''
}

/** 一行 facts 式进度摘要；未绑定剧本 / 剧本缺失 / chat 缺失返回空串（context 摘除）。 */
async function scriptSummaryForChat(
  db: TavernStore,
  character: string,
  chatId: string,
): Promise<string> {
  const found = await db.getCharacter(character)
  const scriptName = boundScriptOf(found?.card)
  if (scriptName === undefined) return ''
  const script = await getScript(dshHomePath('tavern'), scriptName)
  if (script === undefined || script.chunks.length === 0) return ''
  const snapshot = await db.getChatSnapshot(character, chatId)
  if (!snapshot) return ''
  const progress = normalizeScriptProgress(snapshot.chat.header.chat_metadata?.scriptProgress)
  const chunkIndex = progress !== undefined && progress.scriptName === scriptName
    ? Math.min(progress.chunkIndex, script.chunks.length - 1)
    : 0
  return `Bound script: ${scriptName}, progress ${chunkIndex + 1}/${script.chunks.length}; call tavern_script_read for the current segment, tavern_script_advance when the scene has covered it`
}

/** 写穿：tavern_script_advance 落库后按 character/chatId 反查绑定的 agentId 刷新
 *  进度摘要缓存（无匹配则是无人装配过的 chat，跳过）。 */
async function refreshAgentScriptSummaries(character: string, chatId: string): Promise<void> {
  await scriptSummaryProjection.refreshWhere((binding) =>
    binding.architecture === 'agent-tavern' && binding.character === character && binding.chatId === chatId)
}
