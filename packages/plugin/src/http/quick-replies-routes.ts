// Quick Replies (ST Quick Replies; contract 2026-11-12 §2.6) asset routes.
// One state slice, full replacement on write: the panel owns the list, so a
// partial-patch API would only add a second source of truth for deletions.

import type { QuickReplySet, TavernStore } from '../../../tavern-store/src/index.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, sendRouteNotFound, type HttpRequest, type HttpResponse } from './io.js'

const MAX_COMMAND_LINES = 500
const MAX_COMMAND_LENGTH = 8000

/**
 * `commands` 是逐行 STscript：这里只校验「是字符串且非空」，不解析语法——
 * 语法错误由执行期的 `runScript` 报（错误要带行号才有意义，写接口提前解析
 * 只会把同一段报错说两遍）。
 */
function parseQuickReplySet(value: unknown, index: number): QuickReplySet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, `quickReplies[${index}] must be an object`)
  }
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') throw new HttpError(400, `quickReplies[${index}].name is required`)
  const id = typeof record.id === 'string' && record.id.trim() !== '' ? record.id.trim() : `qr-${name}`
  if (!Array.isArray(record.commands)) {
    throw new HttpError(400, `quickReplies[${index}].commands must be an array of script lines`)
  }
  if (record.commands.length > MAX_COMMAND_LINES) {
    throw new HttpError(400, `quickReplies[${index}].commands exceeds ${MAX_COMMAND_LINES} lines`)
  }
  const commands: string[] = []
  for (const [lineIndex, line] of record.commands.entries()) {
    if (typeof line !== 'string') {
      throw new HttpError(400, `quickReplies[${index}].commands[${lineIndex}] must be a string`)
    }
    if (line.length > MAX_COMMAND_LENGTH) {
      throw new HttpError(400, `quickReplies[${index}].commands[${lineIndex}] exceeds ${MAX_COMMAND_LENGTH} characters`)
    }
    // 保留行内空白（STscript 的引号参数可能带前导空格），只丢纯空行。
    if (line.trim() !== '') commands.push(line)
  }
  const automationId = typeof record.automationId === 'string' ? record.automationId.trim() : ''
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new HttpError(400, `quickReplies[${index}].enabled must be a boolean`)
  }
  if (record.isGlobal !== undefined && typeof record.isGlobal !== 'boolean') {
    throw new HttpError(400, `quickReplies[${index}].isGlobal must be a boolean`)
  }
  return {
    id,
    name,
    enabled: record.enabled === true,
    isGlobal: record.isGlobal === true,
    ...(automationId === '' ? {} : { automationId }),
    commands,
  }
}

/**
 * 全量集合校验：id 与 name 都必须唯一——`/qr <name>` 与面板按钮都按两者定位，
 * 重复条目会让「执行哪一组」变成数组顺序的副作用，因此在写入口直接拒绝。
 */
export function parseQuickReplySets(value: unknown): QuickReplySet[] {
  if (!Array.isArray(value)) throw new HttpError(400, 'expected { quickReplies: [...] }')
  const sets = value.map((item, index) => parseQuickReplySet(item, index))
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const set of sets) {
    const lowerName = set.name.toLowerCase()
    if (ids.has(set.id)) throw new HttpError(400, `duplicate quick reply id '${set.id}'`)
    if (names.has(lowerName)) throw new HttpError(400, `duplicate quick reply name '${set.name}'`)
    ids.add(set.id)
    names.add(lowerName)
  }
  return sets
}

export async function handleQuickRepliesRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  method: string,
): Promise<void> {
  if (method === 'GET') {
    const state = await db.getState()
    return sendJson(res, 200, {
      ok: true,
      quickReplies: state.quickReplies ?? [],
      quickRepliesEnabled: state.quickRepliesEnabled !== false,
    })
  }
  if (method === 'PUT') {
    const body = await readJson(req)
    const quickReplies = parseQuickReplySets(body.quickReplies)
    if (body.quickRepliesEnabled !== undefined && typeof body.quickRepliesEnabled !== 'boolean') {
      throw new HttpError(400, 'quickRepliesEnabled must be a boolean')
    }
    const enabled = body.quickRepliesEnabled === undefined
      ? (await db.getState()).quickRepliesEnabled !== false
      : body.quickRepliesEnabled === true
    const state = await db.patchState({ quickReplies, quickRepliesEnabled: enabled })
    return sendJson(res, 200, {
      ok: true,
      quickReplies: state.quickReplies ?? [],
      quickRepliesEnabled: state.quickRepliesEnabled !== false,
    })
  }
  return sendRouteNotFound(res, method, 'quick-replies')
}
