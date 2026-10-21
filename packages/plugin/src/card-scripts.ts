/**
 * Card script tree reader (2026-10-21, user request: 新增右栏「卡脚本」tab).
 *
 * JSR cards keep their persistent scripts in
 * `data.extensions.tavern_helper.scripts`. This plugin still does not execute
 * the tree automatically (see decisions/2026-10-21-card-scripts-host.md): the
 * right sidebar lists the enabled scripts and runs one only when the user clicks
 * 运行, inside the existing sandboxed FrontendFrame. This module is the read-only
 * server seam behind `GET /api/dsh-soulmojito/card/scripts`.
 *
 * Since the same release a chat may own a session script-tree copy (GM-panel Zod
 * edits). Callers pass those nodes as `scriptTrees`; the shape is the raw card
 * node array, so folders and unknown fields pass through untouched.
 */
import type { CharacterCardIR } from '../../tavern-format/src/index.js'

export interface CardScript {
  id: string
  name: string
  content: string
  info: string
}

export interface CardScriptBundle {
  /** Linked world book (`extensions.world`), else the embedded book name, else null. */
  world: string | null
  scripts: CardScript[]
}

export function collectCardScripts(card: CharacterCardIR): CardScriptBundle {
  return collectCardScriptBundle(card)
}

/**
 * `scriptTrees` wins over the card when it is an array (session copy). Folders
 * are walked so scripts nested by the GM panel are still listed; an `undefined`
 * tree keeps the card-only behavior of this endpoint.
 */
export function collectCardScriptBundle(card: CharacterCardIR, scriptTrees?: unknown[]): CardScriptBundle {
  const nodes = Array.isArray(scriptTrees) ? scriptTrees : cardScriptNodes(card)
  return { world: cardWorldName(card), scripts: collectScriptsFromNodes(nodes) }
}

/** Extracts runnable scripts from raw JSR nodes, flattening folders. */
export function collectScriptsFromNodes(nodes: unknown[]): CardScript[] {
  const scripts: CardScript[] = []
  walkScriptNodes(nodes, scripts)
  return scripts
}

function walkScriptNodes(nodes: unknown[], scripts: CardScript[]): void {
  for (const node of nodes) {
    if (!isPlainObject(node)) continue
    if (node['type'] === 'folder') {
      if (Array.isArray(node['scripts'])) walkScriptNodes(node['scripts'], scripts)
      continue
    }
    // Folders carry no content; only runnable scripts are listed.
    if (node['type'] !== 'script') continue
    if (node['enabled'] === false) continue
    const content = node['content']
    if (typeof content !== 'string' || content.trim() === '') continue
    // Stable fallback id: encounter order survives reloads even without an id.
    const fallback = `script-${scripts.length}`
    const id = nonEmptyString(node['id']) ?? fallback
    const name = nonEmptyString(node['name']) ?? fallback
    scripts.push({ id, name, content, info: nonEmptyString(node['info']) ?? '' })
  }
}

function cardScriptNodes(card: CharacterCardIR): unknown[] {
  const helper = plainObject(card.data.extensions['tavern_helper'])
  return Array.isArray(helper?.['scripts']) ? helper['scripts'] : []
}

function cardWorldName(card: CharacterCardIR): string | null {
  const linked = nonEmptyString(card.data.extensions['world'])
  if (linked !== undefined) return linked
  return nonEmptyString(card.data.characterBook?.name) ?? null
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined
}
