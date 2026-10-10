/**
 * Mod 私有存储（提案 0015 §3.3 P1 的 api.storage）：`<tavern>/mods/<id>/data/
 * state.json` 的 JSON kv，writeAtomicText 落盘（tavern-store 的统一原子写：
 * 唯一 tmp 名 + Windows 瞬态 rename 重试——2026-10-10 验收打回的 ENOENT-on-
 * rename 竞态修复点，见 decisions/2026-10-10-mod-p1-loader.md）。
 *
 * 配额（VariableStore 先例）：单值 256KB / 总量 1MB——按 JSON 序列化后的 UTF-8
 * 字节数计。超限抛 Error（不静默丢数据），配额事件由注入的 onQuota 回调上报
 * 审计线。写路径经 mutation tail 串行化（读改写不自缠）；`flush()` 供宿主在
 * mod 卸载时排空在飞写（reload 旧实例 → 新实例的跨实例窗口与测试 teardown
 * 竞态都由此消除）。
 */
import { promises as fs } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeAtomicText } from '../../../tavern-store/src/fs-atomic.js'

/** 单值上限（JSON 序列化字节数）。 */
export const MOD_STORAGE_VALUE_LIMIT = 256 * 1024
/** 全部键值合計上限（state.json 文本字节数）。 */
export const MOD_STORAGE_TOTAL_LIMIT = 1024 * 1024

/** 键名与 VariableStore 同规则：Unicode 字母数字，`_.-` 标点，≤64 字符。 */
const KEY_PATTERN = /^[\p{L}_][\p{L}\p{N}_.-]{0,63}$/u

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** set 收 unknown、内部校验（mod 侧没有类型约束，非法值在这里 fail-closed）。 */

interface StorageFile {
  version: 1
  values: Record<string, JsonValue>
  updatedAt: string
}

export interface ModStorageOptions {
  /** 配额拒绝回调（审计线上报）。 */
  onQuota?: (message: string) => void
}

/**
 * 按**文件**串行化的写队列（模块级，跨实例共享）：每个 state.json 一条 tail，
 * 读改写在同一临界区内完成。串行化必须跨实例——reload 期间旧/新两个
 * ModStorage 指向同一文件，若各持私有 tail，读改写交错会整批丢键（2026-10-10
 * 验收打回的第三形态，并发回归网锁定）。条目数 = 已打开的 state.json 数
 * （每个已装载 Mod 一个），有界。
 */
const fileTails = new Map<string, Promise<void>>()

export class ModStorage {
  constructor(
    private readonly file: string,
    private readonly options: ModStorageOptions = {},
  ) {}

  async get(key: string): Promise<JsonValue | undefined> {
    validateKey(key)
    const file = await this.readFile()
    if (file === undefined || !Object.prototype.hasOwnProperty.call(file.values, key)) return undefined
    return structuredClone(file.values[key]!)
  }

  async set(key: string, value: unknown): Promise<void> {
    validateKey(key)
    const valueProblem = inspectValue(value)
    if (valueProblem !== undefined) {
      if (valueProblem.includes('exceeds the size limit')) this.options.onQuota?.(valueProblem)
      throw new Error(valueProblem)
    }
    return this.mutate(async () => {
      const file = await this.readFile() ?? { version: 1, values: {}, updatedAt: new Date(0).toISOString() }
      const next: StorageFile = {
        version: 1,
        values: { ...file.values, [key]: structuredClone(value) },
        updatedAt: new Date().toISOString(),
      }
      await this.writeFile(next)
    })
  }

  async delete(key: string): Promise<boolean> {
    validateKey(key)
    return this.mutate(async () => {
      const file = await this.readFile()
      if (file === undefined || !Object.prototype.hasOwnProperty.call(file.values, key)) return false
      const next: StorageFile = {
        version: 1,
        values: { ...file.values },
        updatedAt: new Date().toISOString(),
      }
      delete next.values[key]
      await this.writeFile(next)
      return true
    })
  }

  private async readFile(): Promise<StorageFile | undefined> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    }
    const parsed = JSON.parse(text) as StorageFile
    if (parsed.version !== 1 || typeof parsed.values !== 'object' || parsed.values === null || Array.isArray(parsed.values)) {
      throw new Error('mod storage file is corrupt (delete data/state.json to reset)')
    }
    return parsed
  }

  private async writeFile(file: StorageFile): Promise<void> {
    const text = `${JSON.stringify(file)}\n`
    const total = Buffer.byteLength(text, 'utf8')
    if (total > MOD_STORAGE_TOTAL_LIMIT) {
      const message = 'mod storage exceeds the total size limit (1MB)'
      this.options.onQuota?.(message)
      throw new Error(message)
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeAtomicText(this.file, text)
  }

  /** 排空在飞写（宿主卸载/reload 前调用）：返回时**该文件**队列上全部写
   * （含其他实例入队的）已落定——卸载后新实例装载与外部 teardown 都安全。 */
  flush(): Promise<void> {
    return (fileTails.get(this.file) ?? Promise.resolve()).catch(() => {})
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const tail = fileTails.get(this.file) ?? Promise.resolve()
    const result = tail.catch(() => {}).then(operation)
    fileTails.set(this.file, result.then(() => {}, () => {}))
    return result
  }
}

function validateKey(key: string): void {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new Error(`invalid mod storage key '${String(key)}'`)
  }
}

function inspectValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'function' || typeof value === 'symbol') {
    return 'invalid mod storage value'
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return 'mod storage numbers must be finite'
  }
  const text = JSON.stringify(value)
  if (text === undefined) return 'invalid mod storage value'
  if (Buffer.byteLength(text, 'utf8') > MOD_STORAGE_VALUE_LIMIT) {
    return 'mod storage value exceeds the size limit (256KB)'
  }
  return undefined
}
