import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type MemoryScope = 'turn' | 'chat' | 'character' | 'agent' | 'global'
export type MemoryKind = 'semantic' | 'episodic'

export interface MemorySource {
  kind: string
  id?: string
  sessionId?: string
  turn?: number
  [key: string]: unknown
}

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  scopeId: string
  kind: MemoryKind
  content: string
  tags: string[]
  importance: number
  confidence: number
  source: MemorySource
  createdAt: string
  updatedAt: string
  lastAccessedAt?: string
  expiresAt?: string
  deletedAt?: string
  revision: string
}

export interface MemoryWrite {
  id?: string
  scope: MemoryScope
  scopeId: string
  kind: MemoryKind
  content: string
  tags?: string[]
  importance?: number
  confidence?: number
  source: MemorySource
  expiresAt?: string
}

export interface MemoryQuery {
  query?: string
  scope?: MemoryScope
  scopeId?: string
  tags?: readonly string[]
  limit?: number
  maxTokens?: number
  includeDeleted?: boolean
}

export interface MemoryHit {
  record: MemoryRecord
  score: number
  truncated: boolean
}

export class MemoryRevisionConflictError extends Error {
  readonly code = 'MEMORY_REVISION_CONFLICT'

  constructor(readonly id: string, readonly expectedRevision?: string, readonly actualRevision?: string) {
    super(`Memory '${id}' changed in another operation.`)
    this.name = 'MemoryRevisionConflictError'
  }
}

const SCOPES = new Set<MemoryScope>(['turn', 'chat', 'character', 'agent', 'global'])
const KINDS = new Set<MemoryKind>(['semantic', 'episodic'])
const MAX_CONTENT = 64 * 1024
const MAX_TAGS = 32
const MAX_RESULTS = 50
const DEFAULT_RESULTS = 10

export class MemoryStore {
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<MemoryStore> {
    await fs.mkdir(path.join(root, 'memories'), { recursive: true })
    await fs.mkdir(path.join(root, 'memory-audit'), { recursive: true })
    return new MemoryStore(root)
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    const normalized = normalizeQuery(query)
    const records = await this.listRecords(normalized)
    const tokens = tokenize(normalized.query)
    const now = Date.now()
    const hits = records.map((record) => {
      const haystack = `${record.content}\n${record.tags.join(' ')}`.toLocaleLowerCase()
      const matched = tokens.filter((token) => haystack.includes(token)).length
      const lexical = tokens.length === 0 ? 0 : matched / tokens.length
      const freshness = freshnessScore(record, now)
      const score = lexical * 100 + record.importance * 10 + record.confidence * 5 + freshness
      return { record, score, truncated: false }
    }).filter((hit) => tokens.length === 0 || hit.score >= 0)
    hits.sort((left, right) => right.score - left.score
      || right.record.updatedAt.localeCompare(left.record.updatedAt)
      || left.record.id.localeCompare(right.record.id))

    const result: MemoryHit[] = []
    let usedTokens = 0
    for (const hit of hits.slice(0, normalized.limit)) {
      const budget = normalized.maxTokens
      if (budget === undefined) {
        result.push(hit)
        continue
      }
      const words = roughTokens(hit.record.content)
      if (usedTokens >= budget) break
      if (usedTokens + words <= budget) {
        usedTokens += words
        result.push(hit)
        continue
      }
      const remaining = Math.max(0, budget - usedTokens)
      if (remaining === 0) break
      result.push({
        ...hit,
        record: { ...hit.record, content: truncateByTokens(hit.record.content, remaining) },
        truncated: true,
      })
      break
    }
    return result
  }

  async read(id: string, scope: MemoryScope, scopeId: string, includeDeleted = false): Promise<MemoryRecord | undefined> {
    validateScope(scope, scopeId)
    const record = await this.readRecord(id, scope, scopeId)
    if (record === undefined || (!includeDeleted && isInactive(record))) return undefined
    return structuredClone(record)
  }

  async put(input: MemoryWrite, expectedRevision?: string): Promise<MemoryRecord> {
    validateWrite(input)
    return this.mutate(async () => {
      const id = input.id ?? randomUUID()
      const previous = await this.readRecord(id, input.scope, input.scopeId)
      if (previous !== undefined) {
        if (expectedRevision === undefined || previous.revision !== expectedRevision) {
          throw new MemoryRevisionConflictError(id, expectedRevision, previous.revision)
        }
      } else if (expectedRevision !== undefined) {
        throw new MemoryRevisionConflictError(id, expectedRevision)
      }
      const now = new Date().toISOString()
      const nextBase: Omit<MemoryRecord, 'revision'> = {
        id,
        scope: input.scope,
        scopeId: input.scopeId,
        kind: input.kind,
        content: input.content,
        tags: normalizeTags(input.tags),
        importance: normalizeScore(input.importance),
        confidence: normalizeScore(input.confidence, 1),
        source: structuredClone(input.source),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        ...(input.expiresAt === undefined ? {} : { expiresAt: validateDate(input.expiresAt, 'expiresAt') }),
      }
      const record = withRevision(nextBase)
      await this.writeRecord(record)
      await this.audit(previous === undefined ? 'put' : 'update', record)
      return structuredClone(record)
    })
  }

  async forget(id: string, scope: MemoryScope, scopeId: string, expectedRevision?: string): Promise<void> {
    validateScope(scope, scopeId)
    await this.mutate(async () => {
      const previous = await this.readRecord(id, scope, scopeId)
      if (previous === undefined) return
      if (expectedRevision === undefined || previous.revision !== expectedRevision) {
        throw new MemoryRevisionConflictError(id, expectedRevision, previous.revision)
      }
      const next = withRevision({
        ...previous,
        updatedAt: new Date().toISOString(),
        deletedAt: new Date().toISOString(),
      })
      await this.writeRecord(next)
      await this.audit('forget', next)
    })
  }

  private async listRecords(query: MemoryQuery): Promise<MemoryRecord[]> {
    const scopes = query.scope === undefined ? [...SCOPES] : [query.scope]
    const result: MemoryRecord[] = []
    for (const scope of scopes) {
      const scopeRoot = path.join(this.root, 'memories', scope)
      for (const scopeId of await readDirectories(scopeRoot)) {
        for (const file of await readFiles(path.join(scopeRoot, scopeId))) {
          if (!file.endsWith('.json')) continue
          const record = await this.readJson(path.join(scopeRoot, scopeId, file))
          if (record === undefined || (!query.includeDeleted && isInactive(record))) continue
          if (query.scopeId !== undefined && query.scopeId !== record.scopeId) continue
          if (query.tags?.some((tag) => !record.tags.includes(tag))) continue
          result.push(record)
        }
      }
    }
    return result
  }

  private async readRecord(id: string, scope: MemoryScope, scopeId: string): Promise<MemoryRecord | undefined> {
    const file = this.recordPath(id, scope, scopeId)
    return this.readJson(file)
  }

  private async readJson(file: string): Promise<MemoryRecord | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as MemoryRecord
      validateRecord(parsed)
      return parsed
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (cause instanceof SyntaxError || cause instanceof Error && cause.message.startsWith('invalid memory')) {
        throw new Error(`invalid memory record '${path.basename(file)}'`)
      }
      throw cause
    }
  }

  private async writeRecord(record: MemoryRecord): Promise<void> {
    const file = this.recordPath(record.id, record.scope, record.scopeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeAtomic(file, `${JSON.stringify(record)}\n`)
  }

  private recordPath(id: string, scope: MemoryScope, scopeId: string): string {
    validateScope(scope, scopeId)
    return path.join(this.root, 'memories', scope, safeSegment(scopeId), `${safeSegment(id)}.json`)
  }

  private async audit(action: string, record: MemoryRecord): Promise<void> {
    const line = JSON.stringify({ action, id: record.id, scope: record.scope, scopeId: record.scopeId, revision: record.revision, at: record.updatedAt })
    await fs.appendFile(path.join(this.root, 'memory-audit', `${record.scope}.jsonl`), `${line}\n`, 'utf8')
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => {}).then(operation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }
}

function normalizeQuery(query: MemoryQuery): Required<Pick<MemoryQuery, 'limit'>> & MemoryQuery {
  if (query.scope !== undefined && !SCOPES.has(query.scope)) throw new Error(`invalid memory scope '${query.scope}'`)
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) throw new Error('memory limit must be a positive integer')
  if (query.maxTokens !== undefined && (!Number.isInteger(query.maxTokens) || query.maxTokens < 1)) throw new Error('memory maxTokens must be a positive integer')
  return { ...query, limit: Math.min(query.limit ?? DEFAULT_RESULTS, MAX_RESULTS) }
}

function validateWrite(input: MemoryWrite): void {
  validateScope(input.scope, input.scopeId)
  if (!KINDS.has(input.kind)) throw new Error(`invalid memory kind '${input.kind}'`)
  if (typeof input.content !== 'string' || input.content.trim() === '' || input.content.length > MAX_CONTENT) throw new Error('invalid memory content')
  if (typeof input.source !== 'object' || input.source === null || Array.isArray(input.source) || typeof input.source.kind !== 'string' || input.source.kind === '') throw new Error('invalid memory source')
  if (input.expiresAt !== undefined) validateDate(input.expiresAt, 'expiresAt')
  normalizeTags(input.tags)
  normalizeScore(input.importance)
  normalizeScore(input.confidence, 1)
  if (input.id !== undefined) safeSegment(input.id)
}

function validateRecord(record: MemoryRecord): void {
  validateWrite(record)
  if (typeof record.id !== 'string' || record.id === '') throw new Error('invalid memory id')
  if (typeof record.revision !== 'string' || record.revision === '') throw new Error('invalid memory revision')
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') throw new Error('invalid memory timestamps')
}

function validateScope(scope: MemoryScope, scopeId: string): void {
  if (!SCOPES.has(scope)) throw new Error(`invalid memory scope '${scope}'`)
  if (typeof scopeId !== 'string' || scopeId.trim() === '') throw new Error('memory scopeId is required')
  safeSegment(scopeId)
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags) || tags.length > MAX_TAGS || tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) throw new Error('invalid memory tags')
  return [...new Set(tags.map((tag) => tag.trim().slice(0, 100)))].sort()
}

function normalizeScore(value: number | undefined, fallback = 0): number {
  const score = value ?? fallback
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('memory importance/confidence must be between 0 and 1')
  return score
}

function validateDate(value: string, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`invalid memory ${field}`)
  return value
}

function withRevision(record: Omit<MemoryRecord, 'revision'>): MemoryRecord {
  const revision = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16)
  return { ...record, revision }
}

function isInactive(record: MemoryRecord): boolean {
  return record.deletedAt !== undefined || record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()
}

function tokenize(value: string | undefined): string[] {
  return [...new Set((value ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
}

function roughTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function truncateByTokens(value: string, tokens: number): string {
  return value.slice(0, Math.max(1, tokens * 4)).trimEnd()
}

function freshnessScore(record: MemoryRecord, now: number): number {
  const age = Math.max(0, now - Date.parse(record.updatedAt))
  return 1 / (1 + age / 86_400_000)
}

function safeSegment(value: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new Error('invalid memory path segment')
  return encodeURIComponent(value)
}

async function readDirectories(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

async function readFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}
