/**
 * IM 设置的读写边界（提案 0024 §4.3）。
 *
 * 持久化形状在 tavern-store 的 `im-state.ts`（`state.json` 容错读取在那里）。
 * 这里只做三件事：面板 patch 的严格校验、访问控制判定、渠道默认切分上限。
 * 所有函数是纯函数——调用方负责落库。
 */

import type { ImChannelId, ImScope, ImSettings } from './types.js'
import { DEFAULT_IM_SETTINGS } from './types.js'

/** 单条消息的默认上限：QQ 保守取 4500（平台约 5000），微信按段落阅读习惯取 1800。 */
export const IM_CHUNK_DEFAULTS: Readonly<Record<ImChannelId, number>> = {
  qq: 4500,
  weixin: 1800,
  onebot: 2000,
}

export class ImSettingsError extends Error {
  readonly code = 'IM_SETTINGS_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ImSettingsError'
  }
}

export function imChunkLimit(channel: ImChannelId, settings: ImSettings): number {
  return settings.chunkLimit ?? IM_CHUNK_DEFAULTS[channel]
}

/**
 * 访问控制：`disabled` 一律拒绝；`open` 全放行；`allowlist` 只放行名单内 peer。
 * 名单为空的白名单等价于「拒绝所有人」——这是刻意的安全默认。
 */
export function imAccessAllows(settings: ImSettings, scope: ImScope, peerId: string): boolean {
  const mode = scope === 'group' ? settings.groupMode : settings.privateMode
  if (mode === 'disabled') return false
  if (mode === 'open') return true
  const allow = scope === 'group' ? settings.groupAllow : settings.privateAllow
  return allow.includes(peerId)
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ImSettingsError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function parseAccessMode(value: unknown, label: string): 'open' | 'allowlist' | 'disabled' {
  if (value === 'open' || value === 'allowlist' || value === 'disabled') return value
  throw new ImSettingsError(`${label} must be one of 'open' | 'allowlist' | 'disabled'`)
}

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new ImSettingsError(`${label} must be an array of strings`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new ImSettingsError(`${label} must contain only strings`)
    const trimmed = entry.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

function parseChatRef(value: unknown, label: string): { character: string; chatId: string } | undefined {
  if (value === null || value === undefined) return undefined
  const record = asRecord(value, label)
  const character = record['character']
  const chatId = record['chatId']
  if (typeof character !== 'string' || character.trim() === '') {
    throw new ImSettingsError(`${label}.character must be a non-empty string`)
  }
  if (typeof chatId !== 'string' || chatId.trim() === '') {
    throw new ImSettingsError(`${label}.chatId must be a non-empty string`)
  }
  return { character, chatId }
}

/**
 * 面板 patch → 新设置。未出现的键保持原值；出现但非法的值一律抛错，
 * 不做「猜一个最接近的」——静默纠正会让面板与真实生效值悄悄分叉。
 */
export function applyImSettingsPatch(current: ImSettings, patch: unknown): ImSettings {
  const record = asRecord(patch, 'im settings patch')
  const next: ImSettings = {
    ...current,
    privateAllow: [...current.privateAllow],
    groupAllow: [...current.groupAllow],
  }
  if (record['bindingMode'] !== undefined) {
    const value = record['bindingMode']
    if (value !== 'manual' && value !== 'independent' && value !== 'shared') {
      throw new ImSettingsError("bindingMode must be one of 'manual' | 'independent' | 'shared'")
    }
    next.bindingMode = value
  }
  if ('sourceChat' in record) {
    const parsed = parseChatRef(record['sourceChat'], 'sourceChat')
    if (parsed === undefined) delete next.sourceChat
    else next.sourceChat = parsed
  }
  if ('sharedChat' in record) {
    const parsed = parseChatRef(record['sharedChat'], 'sharedChat')
    if (parsed === undefined) delete next.sharedChat
    else next.sharedChat = parsed
  }
  if (record['groupRequireMention'] !== undefined) {
    if (typeof record['groupRequireMention'] !== 'boolean') {
      throw new ImSettingsError('groupRequireMention must be a boolean')
    }
    next.groupRequireMention = record['groupRequireMention']
  }
  if (record['privateMode'] !== undefined) next.privateMode = parseAccessMode(record['privateMode'], 'privateMode')
  if (record['groupMode'] !== undefined) next.groupMode = parseAccessMode(record['groupMode'], 'groupMode')
  if (record['privateAllow'] !== undefined) next.privateAllow = parseStringList(record['privateAllow'], 'privateAllow')
  if (record['groupAllow'] !== undefined) next.groupAllow = parseStringList(record['groupAllow'], 'groupAllow')
  if ('chunkLimit' in record) {
    const value = record['chunkLimit']
    if (value === null) delete next.chunkLimit
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) next.chunkLimit = value
    else throw new ImSettingsError('chunkLimit must be a positive integer or null')
  }
  assertImSettingsUsable(next)
  return next
}

/** 模式与配置必须自洽：缺来源聊天就无法建独立会话，缺共享聊天就无法复用。 */
export function assertImSettingsUsable(settings: ImSettings): void {
  if (settings.bindingMode === 'independent' && settings.sourceChat === undefined) {
    throw new ImSettingsError('bindingMode independent requires sourceChat (the character template chat)')
  }
  if (settings.bindingMode === 'shared' && settings.sharedChat === undefined) {
    throw new ImSettingsError('bindingMode shared requires sharedChat (the conversation every peer reuses)')
  }
}

/** 面板首屏投影：只读副本，避免调用方改到 state 里的同一份对象。 */
export function imSettingsView(settings: ImSettings): ImSettings {
  return structuredClone(settings ?? DEFAULT_IM_SETTINGS)
}
