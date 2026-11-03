// Global variable and regex-script management routes lifted out of `handleApi`.
// Both surfaces read and replace state slices owned by the Tavern store.

import { parseRegexScripts } from '../../../tavern-format/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'

export async function handleVariablesReadRoute(
  db: TavernStore,
  res: HttpResponse,
): Promise<void> {
  const state = await db.getState()
  return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
}

export async function handleVariablesUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  const body = await readJson(req)
  if (body.globals === null || typeof body.globals !== 'object' || Array.isArray(body.globals)) {
    throw new Error('expected { globals }')
  }
  const globals: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(body.globals)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`global '${key}' must be a string, number or boolean`)
    }
    globals[key] = value
  }
  const state = await db.updateState(() => ({ scriptGlobals: globals }))
  return sendJson(res, 200, { ok: true, globals: state.scriptGlobals })
}

export async function handleRegexReadRoute(
  db: TavernStore,
  res: HttpResponse,
): Promise<void> {
  await db.ensureRegexScriptOwners()
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    scripts: state.regexScripts,
    regexScriptOwners: state.regexScriptOwners ?? {},
    regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
  })
}

export async function handleRegexUpdateRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  await db.ensureRegexScriptOwners()
  // Card frontends may keep large HTML/state regex replacements (multi-MB).
  // The default 2 MiB body cap rejected the panel's full-list save with a
  // connection reset while the request was still streaming.
  const body = await readJson(req, 25 * 1024 * 1024)
  const scripts = Array.isArray(body.scripts) ? parseRegexScripts(body.scripts) : undefined
  if (scripts === undefined) throw new Error('expected { scripts }')
  const state = await db.replaceRegexScripts(scripts)
  return sendJson(res, 200, {
    ok: true,
    scripts: state.regexScripts,
    regexScriptOwners: state.regexScriptOwners ?? {},
    regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
  })
}

export async function handleRegexImportRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
): Promise<void> {
  await db.ensureRegexScriptOwners()
  const body = await readJson(req, 25 * 1024 * 1024)
  if (!Array.isArray(body.data) && typeof body.data !== 'object') throw new Error('expected { data }')
  const imported = await db.importRegexScripts(body.data)
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    imported,
    scripts: state.regexScripts,
    regexScriptOwners: state.regexScriptOwners ?? {},
    regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
  })
}

// 存量卡回填：导入时自动物化只覆盖此后导入的卡，旧卡需显式同步一次。
export async function handleRegexSyncCardsRoute(
  db: TavernStore,
  res: HttpResponse,
): Promise<void> {
  await db.ensureRegexScriptOwners()
  const result = await db.backfillRegexScriptsFromCharacters()
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    ...result,
    scripts: state.regexScripts,
    regexScriptOwners: state.regexScriptOwners ?? {},
    regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
  })
}

// 存量预设回填：预设内嵌 regex 的导入期物化同样只覆盖此后导入的预设。
export async function handleRegexSyncPresetsRoute(
  db: TavernStore,
  res: HttpResponse,
): Promise<void> {
  await db.ensureRegexScriptOwners()
  const result = await db.backfillRegexScriptsFromPresets()
  const state = await db.getState()
  return sendJson(res, 200, {
    ok: true,
    ...result,
    scripts: state.regexScripts,
    regexScriptOwners: state.regexScriptOwners ?? {},
    regexScriptPresetOwners: state.regexScriptPresetOwners ?? {},
  })
}
