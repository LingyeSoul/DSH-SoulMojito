/**
 * Pure variable-tree helpers shared by the Variable Gateway and the
 * TavernHelper route. No store access and no module-level state: callers pass a
 * normalized tree in and get a fresh value out.
 */
import type { JsonValue } from '../../tavern-store/src/variable.js'

/** Normalized JSON tree persisted in chat / character / global scopes. */
export type VariableTree = Readonly<Record<string, JsonValue>>

export interface VariableMirrorEntry {
  readonly name: string
  readonly value: JsonValue
}

/** Same name contract as `VariableStore` (Unicode letters/numbers, `_.-`). */
const VARIABLE_NAME = /^[\p{L}_][\p{L}\p{N}_.-]{0,63}$/u
/** Prototype-writing keys are never valid variable names. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function assertSafeKey(key: string, path: string): void {
  if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path} is not allowed`)
}

/**
 * Validates one external JSON tree and clones it into a JSON-only shape.
 * `undefined`, functions, symbols, non-finite numbers, non-plain objects and
 * prototype-writing keys are rejected with the offending path instead of being
 * dropped or coerced.
 */
export function normalizeVariableTree(value: unknown, label: string): VariableTree {
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`)
  const tree: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, entry] of Object.entries(value)) {
    assertSafeKey(key, `${label}.${key}`)
    tree[key] = normalizeJsonValue(entry, `${label}.${key}`)
  }
  return tree
}

function normalizeJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeJsonValue(entry, `${path}[${index}]`))
  if (isPlainRecord(value)) {
    const record: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, entry] of Object.entries(value)) {
      assertSafeKey(key, `${path}.${key}`)
      record[key] = normalizeJsonValue(entry, `${path}.${key}`)
    }
    return record
  }
  throw new Error(`${path} is not a JSON value (got ${value === undefined ? 'undefined' : typeof value})`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Helper/frontend write-back tree → chat-scope flat entries.
 *
 * `stat_data` / `previous_stat_data` stay whole-tree single values: MVU card keys
 * contain `&` (e.g. `身份&职业`), which the flat `VariableStore` name contract
 * rejects; keeping the tree also makes `getvar('stat_data')` and MVU readers
 * share one source. `$` control keys are not mirrored.
 */
export function variableEntriesForMirror(tree: VariableTree): VariableMirrorEntry[] {
  const entries: VariableMirrorEntry[] = []
  collectVariableEntries(tree, '', entries)
  return entries
}

export function collectVariableEntries(tree: VariableTree, prefix: string, out: VariableMirrorEntry[]): void {
  for (const [key, entry] of Object.entries(tree)) {
    if (key.startsWith('$') || FORBIDDEN_KEYS.has(key)) continue
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (prefix === '' && (key === 'stat_data' || key === 'previous_stat_data') && isJsonRecord(entry)) {
      out.push({ name, value: entry })
      continue
    }
    if (isJsonRecord(entry)) collectVariableEntries(entry, name, out)
    else if (VARIABLE_NAME.test(name)) out.push({ name, value: entry })
  }
}
