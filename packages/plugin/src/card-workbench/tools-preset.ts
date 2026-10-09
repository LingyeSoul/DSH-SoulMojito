/**
 * 写卡工作台 · 预设与排错域工具（决策 2026-10-09-dedup-refactor 自 agent.ts 拆分）。
 *
 * preset_get / preset_put（白名单 role/content/enabled，enabled 同步
 * prompt_order；写入成功经 emitAgentPresetChanged 写穿 AgentTavern 预设投影）
 * 与 chat_log_read（提案 0013 P2 排错入口：读真实楼层对照 regex/美化输出）。
 */

import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { limitText, stringArg } from '../tool-args.js'
import {
  CONFIRMATION_ERROR,
  objectOutput,
  tavernStore,
  tool,
  type ToolDefinition,
} from './shared.js'

/* ------------------------------ output schemas ------------------------------ */

const presetSummaryOutput = objectOutput({
  found: { type: 'boolean' }, preset: { type: 'string' }, promptCount: { type: 'number' },
  prompts: { type: 'array', items: { type: 'object', additionalProperties: true } }, truncated: { type: 'boolean' },
})
const presetPutOutput = objectOutput({
  preset: { type: 'string' }, promptCount: { type: 'number' },
  edits: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const chatLogOutput = objectOutput({
  found: { type: 'boolean' }, character: { type: 'string' }, chatId: { type: 'string' },
  total: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' },
  messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
})

/* -------------------------------- 工具定义 -------------------------------- */

export const presetTools: ToolDefinition[] = [
  tool('preset_get', 'Read the summary of a Tavern chat completion preset: prompts with name, identifier, role, content preview/length and effective enabled state (from prompt_order). Call it before proposing any preset change.', {
    preset: { type: 'string', required: true, description: 'Preset name from the conversation.' },
  }, presetSummaryOutput, async (args, exec) => {
    const preset = stringArg(args.preset)
    exec?.signal?.throwIfAborted()
    const raw = await (await tavernStore()).getPreset(preset)
    if (raw === undefined) throw new Error(`preset '${preset}' not found`)
    return presetSummary(preset, raw)
  }),
  tool('preset_put', 'Apply confirmed edits to preset prompts, matched by name: whitelisted fields are role, content and enabled (enabled also syncs prompt_order). Present the per-prompt before/after plan to the user FIRST; rejected without confirmed: true. Marker prompts (chat history/world info placeholders) accept only enabled; new prompts cannot be created here.', {
    preset: { type: 'string', required: true, description: 'Preset name to edit.' },
    prompts: {
      type: 'array', required: true, description: 'Up to 32 entries of { name, role?, content?, enabled? }; at least one editable field per entry.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string', description: 'Replacement prompt content (max 32000 characters).' },
          enabled: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    confirmed: { type: 'boolean', required: true, description: 'True only after the user explicitly approved the presented plan.' },
  }, presetPutOutput, async (args, exec) => {
    if (args.confirmed !== true) throw new Error(CONFIRMATION_ERROR)
    const preset = stringArg(args.preset)
    const edits = parsePresetEdits(args.prompts)
    exec?.signal?.throwIfAborted()
    const db = await tavernStore()
    const raw = await db.getPreset(preset)
    if (raw === undefined) throw new Error(`preset '${preset}' not found`)
    if (!Array.isArray(raw.prompts)) throw new Error(`preset '${preset}' has no prompts array`)
    const next = { ...raw, prompts: raw.prompts.map((prompt) => ({ ...(prompt as Record<string, unknown>) })) }
    const orderSets = Array.isArray(next.prompt_order) ? next.prompt_order as Array<Record<string, unknown>> : []
    const applied: Array<{ name: string; identifiers: string[]; fields: string[] }> = []
    for (const edit of edits) {
      const matches = next.prompts.filter((prompt) => (prompt as Record<string, unknown>)?.name === edit.name)
      if (matches.length === 0) throw new Error(`prompt '${edit.name}' not found in preset '${preset}'`)
      const identifiers: string[] = []
      const fields: string[] = []
      for (const prompt of matches) {
        if ((prompt as Record<string, unknown>).marker === true && (edit.role !== undefined || edit.content !== undefined)) {
          throw new Error(`prompt '${edit.name}' is a marker placeholder; only enabled may be edited`)
        }
        if (edit.role !== undefined) prompt.role = edit.role
        if (edit.content !== undefined) prompt.content = edit.content
        if (edit.enabled !== undefined) {
          prompt.enabled = edit.enabled
          const identifier = (prompt as Record<string, unknown>).identifier
          if (typeof identifier === 'string') {
            for (const set of orderSets) {
              if (!Array.isArray(set.order)) continue
              for (const slot of set.order as Array<Record<string, unknown>>) {
                if (slot?.identifier === identifier) slot.enabled = edit.enabled
              }
            }
          }
        }
        const identifier = (prompt as Record<string, unknown>).identifier
        identifiers.push(typeof identifier === 'string' ? identifier : '')
      }
      for (const field of ['role', 'content', 'enabled'] as const) if (edit[field] !== undefined) fields.push(field)
      applied.push({ name: edit.name, identifiers, fields })
    }
    await db.putPreset(preset, next)
    // 写穿 AgentTavern 预设投影（激活预设被改动时下一次装配即时生效）。
    await emitAgentPresetChanged()
    return { preset, promptCount: next.prompts.length, edits: applied }
  }),
  tool('chat_log_read', 'Read a bounded range of floors from a stored Tavern chat log (character + chatId) — the debugging entry point: compare what the model actually produced against regex/beautification output before touching resources. At most 50 messages per call, each message body truncated to 2000 characters.', {
    character: { type: 'string', required: true, description: 'Character name the chat belongs to.' },
    chatId: { type: 'string', required: true, description: 'Chat log id, e.g. "2026-01-01@10h00m00s.jsonl" — ask the user or use the panel when unsure.' },
    from: { type: 'integer', minimum: 0, description: 'First floor index (inclusive). Defaults to a recent-tail window ending at to.' },
    to: { type: 'integer', minimum: 0, description: 'Last floor index (inclusive). Defaults to the newest floor.' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Window size when from/to are omitted or one-sided (default 20, max 50).' },
  }, chatLogOutput, async (args, exec) => {
    const character = stringArg(args.character)
    const chatId = stringArg(args.chatId)
    const limit = args.limit === undefined ? 20 : intArg(args.limit, 1, 50, 'limit')
    const from = args.from === undefined ? undefined : intArg(args.from, 0, Number.MAX_SAFE_INTEGER, 'from')
    const to = args.to === undefined ? undefined : intArg(args.to, 0, Number.MAX_SAFE_INTEGER, 'to')
    exec?.signal?.throwIfAborted()
    const snapshot = await (await tavernStore()).getChatSnapshot(character, chatId)
    if (snapshot === undefined) throw new Error(`chat '${chatId}' not found for character '${character}'`)
    const total = snapshot.chat.messages.length
    if (total === 0) {
      return { found: true, character, chatId, total, from: 0, to: -1, messages: [] }
    }
    const end = to ?? total - 1
    const start = from ?? Math.max(0, end - limit + 1)
    const cappedEnd = to === undefined && from !== undefined ? Math.min(total - 1, start + limit - 1) : end
    if (start > total - 1) throw new Error(`from (${start}) is beyond the last floor index (${total - 1})`)
    if (start > cappedEnd) throw new Error(`from (${start}) must not exceed to (${cappedEnd})`)
    if (cappedEnd - start + 1 > 50) throw new Error('range exceeds 50 messages; narrow from/to or lower limit')
    const messages = snapshot.chat.messages.slice(start, cappedEnd + 1).map((message, offset) => ({
      index: start + offset,
      is_user: message.is_user === true,
      is_system: message.is_system === true,
      name: typeof message.name === 'string' ? message.name : '',
      send_date: typeof message.send_date === 'string' ? message.send_date : '',
      content: limitText(message.mes, 2000),
      length: typeof message.mes === 'string' ? message.mes.length : 0,
      truncated: typeof message.mes === 'string' && message.mes.length > 2000,
    }))
    return { found: true, character, chatId, total, from: start, to: cappedEnd, messages }
  }),
]

/* -------------------------------- helpers -------------------------------- */

function intArg(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be an integer`)
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return value
}

interface PresetPromptEdit {
  name: string
  role?: 'system' | 'user' | 'assistant'
  content?: string
  enabled?: boolean
}

function parsePresetEdits(value: unknown): PresetPromptEdit[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('prompts must be a non-empty array of { name, role?, content?, enabled? }')
  if (value.length > 32) throw new Error('prompts accepts at most 32 entries; split larger edits across calls')
  const parsed: PresetPromptEdit[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('each prompt edit must be an object of { name, role?, content?, enabled? }')
    const { name, role, content, enabled, ...rest } = entry as Record<string, unknown>
    const unknown = Object.keys(rest)
    if (unknown.length > 0) throw new Error(`unknown prompt field(s) ${unknown.join(', ')}; editable fields are role, content and enabled`)
    if (typeof name !== 'string' || name.trim() === '') throw new Error('prompt name must be a non-empty string (see preset_get for the prompt names)')
    if (role !== undefined && role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new Error(`role for prompt '${name}' must be system, user or assistant`)
    }
    if (content !== undefined) {
      if (typeof content !== 'string') throw new Error(`content for prompt '${name}' must be a string`)
      if (content.length > 32000) throw new Error(`content for prompt '${name}' exceeds the 32000-character limit (got ${content.length})`)
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error(`enabled for prompt '${name}' must be a boolean`)
    const edit: PresetPromptEdit = { name }
    let count = 0
    if (role !== undefined) { edit.role = role; count += 1 }
    if (content !== undefined) { edit.content = content; count += 1 }
    if (enabled !== undefined) { edit.enabled = enabled; count += 1 }
    if (count === 0) throw new Error(`prompt '${name}' has no editable field; provide at least one of role, content, enabled`)
    parsed.push(edit)
  }
  return parsed
}

const PRESET_PROMPT_LIST_CAP = 100

/** 预设摘要：prompts 逐条（marker 标注、content 截断、enabled 取 prompt_order 生效值）。 */
function presetSummary(preset: string, raw: Record<string, unknown>): Record<string, unknown> {
  const prompts = Array.isArray(raw.prompts) ? raw.prompts as Array<Record<string, unknown>> : []
  const enabledByIdentifier = new Map<string, boolean>()
  if (Array.isArray(raw.prompt_order)) {
    for (const set of raw.prompt_order as Array<Record<string, unknown>>) {
      if (!Array.isArray(set.order)) continue
      for (const slot of set.order as Array<Record<string, unknown>>) {
        if (typeof slot?.identifier === 'string' && typeof slot.enabled === 'boolean') {
          enabledByIdentifier.set(slot.identifier, slot.enabled)
        }
      }
    }
  }
  const listed = prompts.slice(0, PRESET_PROMPT_LIST_CAP)
  return {
    found: true,
    preset,
    promptCount: prompts.length,
    prompts: listed.map((prompt) => {
      const marker = prompt.marker === true
      const identifier = typeof prompt.identifier === 'string' ? prompt.identifier : ''
      const content = typeof prompt.content === 'string' ? prompt.content : ''
      const role = typeof prompt.role === 'string' ? prompt.role : undefined
      const enabled = enabledByIdentifier.get(identifier) ?? prompt.enabled !== false
      return {
        name: typeof prompt.name === 'string' ? prompt.name : '',
        identifier,
        marker,
        ...(role !== undefined ? { role } : {}),
        content: limitText(content, 300),
        contentLength: content.length,
        enabled,
      }
    }),
    truncated: prompts.length > PRESET_PROMPT_LIST_CAP,
  }
}
