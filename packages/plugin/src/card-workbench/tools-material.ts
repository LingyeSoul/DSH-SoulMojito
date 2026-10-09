/**
 * 写卡工作台 · 素材库域工具（决策 2026-10-09-dedup-refactor 自 agent.ts 拆分）。
 *
 * material_list / material_read（提案 0014 的剧本/素材库只读面）：制卡素材的
 * 列举与逐块阅读。剧本的写入面（script_get/script_put）按决策
 * 2026-10-09-workbench-script-tools-cut 裁剪，不在此实现。
 */

import { boundScriptOf, getScript, listScripts } from '../../../tavern-store/src/index.js'
import { dshHomePath } from '../dsh-home.js'
import { stringArg } from '../tool-args.js'
import { objectOutput, tavernStore, tool, type ToolDefinition } from './shared.js'

/* ------------------------------ output schemas ------------------------------ */

const materialListOutput = objectOutput({
  count: { type: 'number' },
  scripts: { type: 'array', items: { type: 'object', additionalProperties: true } },
})
const materialReadOutput = objectOutput({
  found: { type: 'boolean' },
  script: { type: 'string' },
  chunkIndex: { type: 'number' },
  requestedChunkIndex: { type: 'number' },
  totalChunks: { type: 'number' },
  length: { type: 'number' },
  truncated: { type: 'boolean' },
  text: { type: 'string' },
}, ['chunkIndex', 'requestedChunkIndex', 'totalChunks', 'length', 'truncated', 'text'])

/* -------------------------------- 工具定义 -------------------------------- */

export const materialTools: ToolDefinition[] = [
  tool('material_list', 'List the script/material library (proposal 0014): name, format, chunk count and which cards are bound to each script (via extensions.agentTavern.scriptId). Entry point when the user wants a card made from a script or other material.', {}, materialListOutput, async (_args, exec) => {
    exec?.signal?.throwIfAborted()
    const summaries = await listScripts(dshHomePath('tavern'))
    const db = await tavernStore()
    const bindings = new Map<string, string[]>()
    for (const characterName of await db.listCharacters()) {
      const file = await db.getCharacter(characterName)
      const bound = file === undefined ? undefined : boundScriptOf(file.card)
      if (bound === undefined) continue
      const list = bindings.get(bound) ?? []
      list.push(characterName)
      bindings.set(bound, list)
    }
    return {
      count: summaries.length,
      scripts: summaries.map((summary) => ({
        name: summary.name,
        format: summary.format,
        chunkCount: summary.chunkCount,
        totalCharacters: summary.totalCharacters,
        importedAt: summary.importedAt,
        boundCards: bindings.get(summary.name) ?? [],
      })),
    }
  }),
  tool('material_read', 'Read one chunk of a script from the material library (proposal 0014). chunkIndex defaults to 0 and is clamped into [0, totalChunks-1]; maxChars defaults to 2400 and is capped at 8000 (values below 1 clamp to 1). Unknown scripts return found: false instead of throwing. Read chunk by chunk — never assume the whole script fits in one call.', {
    scriptName: { type: 'string', required: true, description: 'Script name from material_list.' },
    chunkIndex: { type: 'integer', minimum: 0, description: 'Chunk to read (0-based); out-of-range values are clamped into range.' },
    maxChars: { type: 'integer', minimum: 1, maximum: 8000, description: 'Character budget for the returned text (default 2400, max 8000); longer chunks come back truncated.' },
  }, materialReadOutput, async (args, exec) => {
    const scriptName = stringArg(args.scriptName)
    let maxChars = 2400
    if (args.maxChars !== undefined) {
      if (typeof args.maxChars !== 'number' || !Number.isInteger(args.maxChars)) throw new Error('maxChars must be an integer')
      maxChars = Math.min(8000, Math.max(1, args.maxChars))
    }
    let requested = 0
    if (args.chunkIndex !== undefined) {
      if (typeof args.chunkIndex !== 'number' || !Number.isInteger(args.chunkIndex)) throw new Error('chunkIndex must be an integer')
      requested = args.chunkIndex
    }
    exec?.signal?.throwIfAborted()
    const record = await getScript(dshHomePath('tavern'), scriptName)
    if (record === undefined || record.chunks.length === 0) return { found: false, script: scriptName }
    const chunkIndex = Math.min(Math.max(requested, 0), record.chunks.length - 1)
    const text = record.chunks[chunkIndex]!.text
    return {
      found: true,
      script: record.name,
      chunkIndex,
      ...(requested !== chunkIndex ? { requestedChunkIndex: requested } : {}),
      totalChunks: record.chunks.length,
      length: text.length,
      truncated: text.length > maxChars,
      text: text.slice(0, maxChars),
    }
  }),
]
