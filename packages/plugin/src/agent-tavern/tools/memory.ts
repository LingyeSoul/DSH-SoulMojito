/** AgentTavern memory tool slice (registration order 5-9). */

import type { MemoryHit } from '../../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../../dsh-home.js'
import { hybridMemorySearch } from '../../memory-hybrid.js'
import { clampInt, limitText, stringArg } from '../../tool-args.js'
import {
  assertWriteScopeAllowed,
  bindingFor,
  memoryScopeParameter,
  objectOutput,
  selectedMemoryScopes,
  tool,
  type ToolDefinition,
} from './shared.js'
import { embedWrittenMemory, memoryEmbeddingConfig, memoryStore, memoryVectorStore } from './stores.js'


export function memoryTools(): ToolDefinition[] {
  return [
    tool('memory_search', 'Search memories in the current chat, character, agent, or global scope with hybrid lexical and semantic retrieval (semantic requires an embedding endpoint; without one it is lexical only). Use it to recall established facts, promises, or relationship state before they matter on screen.', {
      query: { type: 'string', required: true, description: 'Lexical search query.' },
      scope: memoryScopeParameter(false),
      limit: { type: 'integer', description: 'Maximum results, capped at 20.' },
      maxTokens: { type: 'integer', description: 'Approximate content token budget.' },
    }, memorySearchOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const store = await memoryStore()
      const scopes = selectedMemoryScopes(args.scope, binding)
      const limit = clampInt(args.limit, 1, 20, 10)
      const maxTokens = clampInt(args.maxTokens, 1, 2000, 1200)
      const query = stringArg(args.query)
      // 词法通道（现状路径，提案 0016 golden）：无 embed 配置 / 熔断 / 查询嵌入
      // 失败 / 候选全部 stale 时逐字节保持本路径的行为。
      const lexicalHits = async (): Promise<MemoryHit[]> => (await Promise.all(scopes.map(({ scope, scopeId }) => store.search({
        query,
        scope,
        scopeId,
        limit,
        maxTokens,
      })))).flat()
        .sort((left, right) => right.score - left.score || left.record.id.localeCompare(right.record.id))
        .slice(0, limit)
      // 混合通道（提案 0016）：dense + 词法 RRF 融合；undefined = 降级回落词法。
      const config = await memoryEmbeddingConfig()
      const hits = config === undefined ? await lexicalHits()
        : await hybridMemorySearch({
          root: tavernDataRoot(),
          config,
          store,
          vectorStore: await memoryVectorStore(),
          query,
          scopes,
          limit,
          maxTokens,
        }) ?? await lexicalHits()
      return {
        hits: hits.map((hit) => ({
          id: hit.record.id,
          scope: hit.record.scope,
          content: hit.record.content,
          tags: hit.record.tags,
          score: Number(hit.score.toFixed(4)),
          revision: hit.record.revision,
          source: hit.record.source,
          truncated: hit.truncated,
        })),
        sourceCount: hits.length,
        truncated: hits.some((hit) => hit.truncated),
      }
    }),
    tool('memory_read', 'Read one memory with its source by stable id.', {
      id: { type: 'string', required: true },
      scope: memoryScopeParameter(false),
    }, memoryReadOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const store = await memoryStore()
      const scopes = selectedMemoryScopes(args.scope, binding)
      for (const { scope, scopeId } of scopes) {
        const record = await store.read(stringArg(args.id), scope, scopeId)
        if (record !== undefined) return memoryView(record)
      }
      return { found: false, id: stringArg(args.id) }
    }),
    tool('memory_write', 'Write a new sourced memory in the current chat, character, agent, or global scope.', {
      scope: memoryScopeParameter(true),
      kind: { type: 'string', enum: ['semantic', 'episodic'], required: true },
      content: { type: 'string', required: true, description: 'A concise fact or event.' },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: 'Salience from 0 (trivial) to 1 (critical); out-of-range values are clamped.' },
      confidence: { type: 'number', description: 'Certainty from 0 (guess) to 1 (confirmed); out-of-range values are clamped.' },
      expiresAt: { type: 'string', description: 'Optional ISO 8601 timestamp after which the memory expires; omit it when there is no expiry.' },
    }, memoryWriteOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedMemoryScopes(args.scope, binding)[0]!
      await assertWriteScopeAllowed(target.scope)
      const importance = clampScore(args.importance)
      const confidence = clampScore(args.confidence)
      const expiresAt = optionalExpiry(args.expiresAt)
      const record = await (await memoryStore()).put({
        scope: target.scope,
        scopeId: target.scopeId,
        kind: args.kind === 'episodic' ? 'episodic' : 'semantic',
        content: limitText(stringArg(args.content), 64 * 1024),
        ...(Array.isArray(args.tags) ? { tags: args.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32) } : {}),
        ...(importance === undefined ? {} : { importance }),
        ...(confidence === undefined ? {} : { confidence }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        source: { kind: 'agent-tool', sessionId: binding.agentId, chatId: binding.chatId, character: binding.character },
      })
      // 写路径嵌入（提案 0016）：同步嵌入受 timeoutMs 约束；任何失败只进
      // lastError/熔断，不阻塞工具返回（向量 stale，检索时懒补）。
      await embedWrittenMemory(record)
      return { id: record.id, scope: record.scope, revision: record.revision, source: record.source }
    }),
    tool('memory_update', 'Update an existing memory by id and expected revision; omitted fields keep their current value.', {
      id: { type: 'string', required: true },
      scope: memoryScopeParameter(true),
      expectedRevision: { type: 'string', required: true },
      content: { type: 'string', description: 'Replacement fact or event.' },
      tags: { type: 'array', items: { type: 'string' } },
      importance: { type: 'number', description: 'Salience from 0 (trivial) to 1 (critical); out-of-range values are clamped.' },
      confidence: { type: 'number', description: 'Certainty from 0 (guess) to 1 (confirmed); out-of-range values are clamped.' },
      expiresAt: { type: 'string', description: 'ISO 8601 expiry timestamp; an empty string clears the expiry, omitting it keeps the current one.' },
    }, memoryWriteOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedMemoryScopes(args.scope, binding)[0]!
      await assertWriteScopeAllowed(target.scope)
      const store = await memoryStore()
      const id = stringArg(args.id)
      const previous = await store.read(id, target.scope, target.scopeId, true)
      if (previous === undefined) throw new Error(`memory '${id}' not found in scope '${target.scope}'`)
      const importance = clampScore(args.importance) ?? previous.importance
      const confidence = clampScore(args.confidence) ?? previous.confidence
      const expiresAt = typeof args.expiresAt === 'string' ? optionalExpiry(args.expiresAt) : previous.expiresAt
      const record = await store.put({
        id,
        scope: previous.scope,
        scopeId: previous.scopeId,
        kind: previous.kind,
        content: args.content === undefined ? previous.content : limitText(stringArg(args.content), 64 * 1024),
        ...(Array.isArray(args.tags)
          ? { tags: args.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 32) }
          : { tags: previous.tags }),
        importance,
        confidence,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        source: { kind: 'agent-tool', sessionId: binding.agentId, chatId: binding.chatId, character: binding.character },
      }, stringArg(args.expectedRevision))
      // 内容可能变更 ⇒ 旧向量按 digest 失效，重嵌（同 memory_write 的失败纪律）。
      await embedWrittenMemory(record)
      return { id: record.id, scope: record.scope, revision: record.revision, source: record.source }
    }),
    tool('memory_forget', 'Soft-delete an existing memory by id and expected revision; the audit trail is kept.', {
      id: { type: 'string', required: true },
      scope: memoryScopeParameter(true),
      expectedRevision: { type: 'string', required: true },
    }, memoryForgetOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedMemoryScopes(args.scope, binding)[0]!
      await assertWriteScopeAllowed(target.scope)
      const store = await memoryStore()
      const id = stringArg(args.id)
      const previous = await store.read(id, target.scope, target.scopeId, true)
      if (previous === undefined) return { id, scope: target.scope, found: false }
      await store.forget(id, target.scope, target.scopeId, stringArg(args.expectedRevision))
      // 向量缓存随记录一并清理（best-effort：记录已软删，残留向量只占空间）。
      try {
        await (await memoryVectorStore()).delete(id, target.scope, target.scopeId)
      } catch { /* 缓存清理失败不影响 forget 结果 */ }
      return { id, scope: target.scope, found: true }
    }),
  ]
}

const memorySearchOutput = objectOutput({ hits: { type: 'array', items: { type: 'object', additionalProperties: true } }, sourceCount: { type: 'integer' }, truncated: { type: 'boolean' } })
const memoryReadOutput = objectOutput(
  {
    found: { type: 'boolean' }, id: { type: 'string' }, scope: { type: 'string' }, kind: { type: 'string' },
    content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
    importance: { type: 'number' }, confidence: { type: 'number' },
    source: { type: 'object', additionalProperties: true },
    createdAt: { type: 'string' }, updatedAt: { type: 'string' }, revision: { type: 'string' },
    expiresAt: { type: 'string' },
  },
  ['scope', 'kind', 'content', 'tags', 'importance', 'confidence', 'source', 'createdAt', 'updatedAt', 'revision', 'expiresAt'],
)
const memoryWriteOutput = objectOutput({ id: { type: 'string' }, scope: { type: 'string' }, revision: { type: 'string' }, source: { type: 'object', additionalProperties: true } })
const memoryForgetOutput = objectOutput(
  { id: { type: 'string' }, scope: { type: 'string' }, found: { type: 'boolean' } },
  [],
)
function memoryView(record: {
  id: string
  scope: string
  kind: string
  content: string
  tags: string[]
  importance: number
  confidence: number
  source: unknown
  createdAt: string
  updatedAt: string
  expiresAt?: string
  revision: string
}): Record<string, unknown> {
  return {
    found: true,
    id: record.id,
    scope: record.scope,
    kind: record.kind,
    content: record.content,
    tags: record.tags,
    importance: record.importance,
    confidence: record.confidence,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    revision: record.revision,
  }
}

function clampScore(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function optionalExpiry(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
