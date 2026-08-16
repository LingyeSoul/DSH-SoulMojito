import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export type VariableScope = 'turn' | 'chat' | 'character' | 'agent' | 'global'
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface VariableSnapshot {
  scope: VariableScope
  scopeId: string
  name: string
  value: JsonValue
  revision: string
  updatedAt: string
}

export interface VariableChange {
  name: string
  value: JsonValue
  expectedRevision?: string
}

export class VariableRevisionConflictError extends Error {
  readonly code = 'VARIABLE_REVISION_CONFLICT'

  constructor(readonly name: string, readonly expectedRevision?: string, readonly actualRevision?: string) {
    super(`Variable '${name}' changed in another operation.`)
    this.name = 'VariableRevisionConflictError'
  }
}

const SCOPES = new Set<VariableScope>(['turn', 'chat', 'character', 'agent', 'global'])
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/
const MAX_VALUE_BYTES = 32 * 1024
const MAX_SCOPE_BYTES = 256 * 1024
const MAX_LIST = 100

interface VariableFile {
  version: 1
  scope: VariableScope
  scopeId: string
  values: Record<string, JsonValue>
  revisions: Record<string, string>
  updatedAt: string
}

export class VariableStore {
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<VariableStore> {
    await fs.mkdir(path.join(root, 'variables'), { recursive: true })
    return new VariableStore(root)
  }

  async get(scope: VariableScope, scopeId: string, name: string): Promise<VariableSnapshot | undefined> {
    validateScope(scope, scopeId)
    validateName(name)
    const file = await this.readFile(scope, scopeId)
    if (file === undefined || !Object.prototype.hasOwnProperty.call(file.values, name)) return undefined
    return snapshot(file, name)
  }

  async set(scope: VariableScope, scopeId: string, name: string, value: JsonValue, expectedRevision?: string): Promise<VariableSnapshot> {
    validateScope(scope, scopeId)
    validateName(name)
    validateValue(value)
    return this.mutate(async () => {
      const file = await this.readFile(scope, scopeId) ?? emptyFile(scope, scopeId)
      const actual = file.revisions[name]
      if (actual !== expectedRevision) throw new VariableRevisionConflictError(name, expectedRevision, actual)
      const next = applyChanges(file, [{ name, value }])
      await this.writeFile(next)
      return snapshot(next, name)
    })
  }

  async patch(scope: VariableScope, scopeId: string, changes: readonly VariableChange[], expectedRevision?: string): Promise<VariableSnapshot[]> {
    validateScope(scope, scopeId)
    if (!Array.isArray(changes) || changes.length === 0) throw new Error('variable patch requires changes')
    const normalized = changes.map((change) => {
      validateName(change.name)
      validateValue(change.value)
      return change
    })
    return this.mutate(async () => {
      const file = await this.readFile(scope, scopeId) ?? emptyFile(scope, scopeId)
      const fileRevision = revisionOfFile(file)
      if (expectedRevision !== undefined && expectedRevision !== fileRevision) {
        throw new VariableRevisionConflictError('*', expectedRevision, fileRevision)
      }
      for (const change of normalized) {
        const actual = file.revisions[change.name]
        if (change.expectedRevision !== undefined && change.expectedRevision !== actual) {
          throw new VariableRevisionConflictError(change.name, change.expectedRevision, actual)
        }
      }
      const next = applyChanges(file, normalized)
      await this.writeFile(next)
      return normalized.map((change) => snapshot(next, change.name))
    })
  }

  async delete(scope: VariableScope, scopeId: string, name: string, expectedRevision?: string): Promise<void> {
    validateScope(scope, scopeId)
    validateName(name)
    await this.mutate(async () => {
      const file = await this.readFile(scope, scopeId)
      if (file === undefined || !Object.prototype.hasOwnProperty.call(file.values, name)) return
      const actual = file.revisions[name]
      if (actual !== expectedRevision) throw new VariableRevisionConflictError(name, expectedRevision, actual)
      const next = structuredClone(file)
      delete next.values[name]
      delete next.revisions[name]
      next.updatedAt = new Date().toISOString()
      await this.writeFile(next)
    })
  }

  async list(scope: VariableScope, scopeId: string, prefix = '', limit = MAX_LIST): Promise<VariableSnapshot[]> {
    validateScope(scope, scopeId)
    if (typeof prefix !== 'string' || prefix.length > 64) throw new Error('invalid variable prefix')
    if (!Number.isInteger(limit) || limit < 1) throw new Error('variable limit must be a positive integer')
    const file = await this.readFile(scope, scopeId)
    if (file === undefined) return []
    return Object.keys(file.values).filter((name) => name.startsWith(prefix)).sort().slice(0, Math.min(limit, MAX_LIST))
      .map((name) => snapshot(file, name))
  }

  private async readFile(scope: VariableScope, scopeId: string): Promise<VariableFile | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath(scope, scopeId), 'utf8')) as VariableFile
      validateFile(parsed, scope, scopeId)
      return parsed
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (cause instanceof SyntaxError || cause instanceof Error && cause.message.startsWith('invalid variable')) {
        throw new Error(`invalid variable store for scope '${scope}'`)
      }
      throw cause
    }
  }

  private async writeFile(file: VariableFile): Promise<void> {
    const target = this.filePath(file.scope, file.scopeId)
    await fs.mkdir(path.dirname(target), { recursive: true })
    const text = `${JSON.stringify(file)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_SCOPE_BYTES) throw new Error('variable scope exceeds size limit')
    await writeAtomic(target, text)
  }

  private filePath(scope: VariableScope, scopeId: string): string {
    validateScope(scope, scopeId)
    return path.join(this.root, 'variables', scope, `${safeSegment(scopeId)}.json`)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => {}).then(operation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }
}

function emptyFile(scope: VariableScope, scopeId: string): VariableFile {
  return { version: 1, scope, scopeId, values: {}, revisions: {}, updatedAt: new Date(0).toISOString() }
}

function applyChanges(file: VariableFile, changes: readonly VariableChange[]): VariableFile {
  const next = structuredClone(file)
  for (const change of changes) {
    next.values[change.name] = structuredClone(change.value)
    next.revisions[change.name] = revisionOfValue(change.value)
  }
  next.updatedAt = new Date().toISOString()
  return next
}

function snapshot(file: VariableFile, name: string): VariableSnapshot {
  return {
    scope: file.scope,
    scopeId: file.scopeId,
    name,
    value: structuredClone(file.values[name]!),
    revision: file.revisions[name]!,
    updatedAt: file.updatedAt,
  }
}

function revisionOfValue(value: JsonValue): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

function revisionOfFile(file: VariableFile): string {
  return createHash('sha256').update(JSON.stringify(file.values)).digest('hex').slice(0, 16)
}

function validateFile(file: VariableFile, scope: VariableScope, scopeId: string): void {
  if (file.version !== 1 || file.scope !== scope || file.scopeId !== scopeId || typeof file.values !== 'object' || file.values === null || typeof file.revisions !== 'object' || file.revisions === null) throw new Error('invalid variable file')
  for (const [name, value] of Object.entries(file.values)) {
    validateName(name)
    validateValue(value)
    if (typeof file.revisions[name] !== 'string' || file.revisions[name] === '') throw new Error('invalid variable revision')
  }
}

function validateScope(scope: VariableScope, scopeId: string): void {
  if (!SCOPES.has(scope)) throw new Error(`invalid variable scope '${scope}'`)
  if (typeof scopeId !== 'string' || scopeId.trim() === '') throw new Error('variable scopeId is required')
  safeSegment(scopeId)
}

function validateName(name: string): void {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`invalid variable name '${String(name)}'`)
}

function validateValue(value: JsonValue): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('invalid variable value')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('variable number must be finite')
  const text = JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) throw new Error('variable value exceeds size limit')
  if (Array.isArray(value)) value.forEach(validateValue)
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(validateValue)
}

function safeSegment(value: string): string {
  if (value === '.' || value === '..' || /[\\/\0]/.test(value)) throw new Error('invalid variable path segment')
  return encodeURIComponent(value)
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}
