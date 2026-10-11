/**
 * 记忆向量 sidecar 存储（提案 0016：混合记忆检索）。
 *
 * 与 MemoryStore 同根目录的纯持久化层（`<tavern>/memory-vectors/<scope>/<scopeId>.json`），
 * 不做任何网络调用——embed 编排与熔断在插件层（plugin/src/memory-embed.ts）。
 * 每条目记录来源摘要 digest = SHA-256(JSON.stringify([model, content]))（LWB
 * vector-cache 的等价语义，Apache-2.0 参考仅取机制不抄代码）：content 或 model
 * 变更 ⇒ digest 不匹配 ⇒ stale ⇒ 由插件层懒重嵌。向量本体 base64 float32 LE。
 *
 * 损坏容错：这是可重建的缓存而非权威数据，文件解析失败按空缓存处理（记忆检索
 * 回落纯词法，写路径重新嵌入），不抛错阻断任何调用方。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { writeAtomicText } from './fs-atomic.js'
import type { MemoryScope } from './memory.js'

export interface MemoryVectorEntry {
  id: string
  scope: MemoryScope
  scopeId: string
  /** 来源摘要：嵌入时使用的 model 与 content 的 SHA-256，stale 判定依据。 */
  digest: string
  /** 生成该向量的嵌入模型名（与 digest 一同构成向量空间身份）。 */
  model: string
  /** float32 little-endian 的 base64 编码。 */
  vector: string
}

interface VectorFile {
  version: 1
  scope: MemoryScope
  scopeId: string
  entries: Record<string, { digest: string; model: string; vector: string }>
  updatedAt: string
}

/** 嵌入输入摘要（LWB 同款语义）：[model, content] 的 JSON 数组 SHA-256 hex。 */
export function memoryContentDigest(model: string, content: string): string {
  return createHash('sha256').update(JSON.stringify([model, content])).digest('hex')
}

/** number[] → base64 float32 LE。非有限值与范围外值按 0 处理（Float32Array 语义）。 */
export function encodeVector(values: readonly number[]): string {
  return Buffer.from(new Float32Array(values).buffer).toString('base64')
}

/** base64 float32 LE → number[]；输入非法返回空数组。 */
export function decodeVector(base64: string): number[] {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length === 0 || bytes.length % 4 !== 0) return []
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
}

/* ---- 融合原语（提案 0016 §5）：生产检索（plugin/src/memory-hybrid.ts）与
 * 离线评测（scripts/retrieval-eval/run.mjs --dense）同源导入，评测不与生产
 * 漂移——这是本节存在的理由，勿在调用侧内联重写。 ---- */

/** RRF 常数（标准 k=60，两通道等权）。 */
export const RRF_K = 60

/** 双通道 RRF：按各通道名次累加 1/(k+rank)，rank 从 1 起。 */
export function rrfFuse(lexicalOrder: readonly string[], denseOrder: readonly string[], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>()
  const add = (id: string, rank: number) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
  }
  lexicalOrder.forEach((id, index) => add(id, index + 1))
  denseOrder.forEach((id, index) => add(id, index + 1))
  return scores
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }
  if (normLeft === 0 || normRight === 0) return 0
  return dot / (Math.sqrt(normLeft) * Math.sqrt(normRight))
}

const SCOPES = new Set<MemoryScope>(['turn', 'chat', 'character', 'agent', 'global'])

export class MemoryVectorStore {
  private mutationTail: Promise<void> = Promise.resolve()

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<MemoryVectorStore> {
    await fs.mkdir(path.join(root, 'memory-vectors'), { recursive: true })
    return new MemoryVectorStore(root)
  }

  async get(id: string, scope: MemoryScope, scopeId: string): Promise<MemoryVectorEntry | undefined> {
    const file = await this.readFile(scope, scopeId)
    const entry = file?.entries[safeSegment(id)]
    if (file === undefined || entry === undefined) return undefined
    return { id, scope, scopeId, ...structuredClone(entry) }
  }

  /** 批量写入（同 scope 聚合成单文件原子替换；跨 scope 顺序写）。 */
  async put(entries: readonly MemoryVectorEntry[]): Promise<void> {
    if (entries.length === 0) return
    const byFile = new Map<string, MemoryVectorEntry[]>()
    for (const entry of entries) {
      validate(entry)
      const key = vectorPathKey(entry.scope, entry.scopeId)
      const bucket = byFile.get(key) ?? []
      bucket.push(entry)
      byFile.set(key, bucket)
    }
    return this.mutate(async () => {
      for (const [key, bucket] of byFile) {
        const [scope, scopeId] = key.split('\u0000') as [MemoryScope, string]
        const file = await this.readFile(scope, scopeId) ?? emptyFile(scope, scopeId)
        for (const entry of bucket) {
          file.entries[safeSegment(entry.id)] = { digest: entry.digest, model: entry.model, vector: entry.vector }
        }
        file.updatedAt = new Date().toISOString()
        await this.writeFile(file)
      }
    })
  }

  async delete(id: string, scope: MemoryScope, scopeId: string): Promise<void> {
    return this.mutate(async () => {
      const file = await this.readFile(scope, scopeId)
      if (file === undefined) return
      const key = safeSegment(id)
      if (!Object.prototype.hasOwnProperty.call(file.entries, key)) return
      delete file.entries[key]
      file.updatedAt = new Date().toISOString()
      await this.writeFile(file)
    })
  }

  /** 列出条目；scope/scopeId 缺省时全量枚举（digest/model 供 stale 判定）。 */
  async list(scope?: MemoryScope, scopeId?: string): Promise<MemoryVectorEntry[]> {
    const result: MemoryVectorEntry[] = []
    for (const file of await this.listFiles(scope, scopeId)) {
      for (const [key, entry] of Object.entries(file.entries)) {
        result.push({ id: decodeURIComponent(key), scope: file.scope, scopeId: file.scopeId, ...entry })
      }
    }
    return result
  }

  private async listFiles(scope?: MemoryScope, scopeId?: string): Promise<VectorFile[]> {
    const scopes = scope === undefined ? [...SCOPES] : [scope]
    const files: VectorFile[] = []
    for (const eachScope of scopes) {
      if (scopeId !== undefined) {
        const file = await this.readFile(eachScope, scopeId)
        if (file !== undefined) files.push(file)
        continue
      }
      // 布局是 memory-vectors/<scope>/<encodedScopeId>.json 的平铺文件（与
      // VariableStore 同款），枚举按文件名而非子目录。
      const scopeRoot = path.join(this.root, 'memory-vectors', eachScope)
      for (const name of await readFiles(scopeRoot)) {
        if (!name.endsWith('.json')) continue
        const file = await this.readFileByPath(path.join(scopeRoot, name))
        if (file !== undefined) files.push(file)
      }
    }
    return files
  }

  /** 损坏文件按空缓存处理（可重建缓存，见文件头注释）。 */
  private async readFile(scope: MemoryScope, scopeId: string): Promise<VectorFile | undefined> {
    validateScope(scope, scopeId)
    return this.readFileByPath(this.filePath(scope, scopeId))
  }

  private async readFileByPath(file: string): Promise<VectorFile | undefined> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as VectorFile
      if (parsed === null || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null || Array.isArray(parsed.entries)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  private async writeFile(file: VectorFile): Promise<void> {
    const target = this.filePath(file.scope, file.scopeId)
    // 目录创建是调用方职责（fs-atomic.ts 契约）：scope 子目录随首个条目建立。
    await fs.mkdir(path.dirname(target), { recursive: true })
    await writeAtomicText(target, `${JSON.stringify(file)}\n`)
  }

  private filePath(scope: MemoryScope, scopeId: string): string {
    return path.join(this.root, 'memory-vectors', scope, `${safeSegment(scopeId)}.json`)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.catch(() => {}).then(operation)
    this.mutationTail = result.then(() => {}, () => {})
    return result
  }
}

function vectorPathKey(scope: MemoryScope, scopeId: string): string {
  return `${scope}\u0000${scopeId}`
}

function emptyFile(scope: MemoryScope, scopeId: string): VectorFile {
  return { version: 1, scope, scopeId, entries: {}, updatedAt: new Date().toISOString() }
}

function validate(entry: MemoryVectorEntry): void {
  validateScope(entry.scope, entry.scopeId)
  if (typeof entry.id !== 'string' || entry.id === '') throw new Error('invalid memory vector id')
  if (typeof entry.digest !== 'string' || entry.digest === '' || typeof entry.model !== 'string' || entry.model === '') {
    throw new Error('invalid memory vector digest/model')
  }
  decodeVector(entry.vector)
}

function validateScope(scope: MemoryScope, scopeId: string): void {
  if (!SCOPES.has(scope)) throw new Error(`invalid memory vector scope '${scope}'`)
  if (typeof scopeId !== 'string' || scopeId.trim() === '') throw new Error('memory vector scopeId is required')
  safeSegment(scopeId)
}

/** 与 memory.ts 同款路径段规则（encodeURIComponent 后作文件名）。 */
function safeSegment(value: string): string {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error('invalid memory vector path segment')
  }
  return encodeURIComponent(value)
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
