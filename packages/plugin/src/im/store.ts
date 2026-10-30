/**
 * IM 通道存储（提案 0024 §4.2）：账号清单、密钥袋、24h 去重日志与拉取游标。
 *
 * ```text
 * im/
 * ├── accounts.json                      # { version: 1, accounts }
 * ├── secrets/<channel>-<accountId>.json # ImSecretRecord，POSIX 0600
 * ├── dedupe.log                         # NDJSON { key, at }，24h 窗口
 * └── cursors/<accountId>.json           # { cursor }
 * ```
 *
 * 密钥不进 state.json：那份状态会被面板、Mod 与工作台读取，而提案 §4.2 要求
 * 凭据只有适配器可见；0600 是第二道边界，权限不符直接报错关停账号，不降级。
 *
 * 并发纪律：accounts.json 的读改写与 dedupe.log 的读追加都在实例内串行——登录、
 * 重连与多个 peer 同时回包都会撞上同一份文件；其余文件按账号分片，互不干扰。
 * 写入一律 tmp + rename；去重日志是每消息一次的热路径，只有压缩时才整文件重写。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { ImAccountRef, ImChannelId } from './types.js'

/** 密钥袋：键由通道自定（appId/appSecret、botToken/baseUrl…），值统一为字符串。 */
export interface ImSecretRecord {
  channel: ImChannelId
  accountId: string
  /** 不透明凭据袋：键按通道自定（appId/appSecret、botToken/baseUrl…）。 */
  secret: Record<string, string>
  createdAt: string
}

export type ImStoreErrorCode = 'BAD_ACCOUNT_ID' | 'SECRET_PERMISSION' | 'CORRUPT_FILE' | 'IO'

/**
 * 存储层错误。code 供上层决定关停账号或提示面板，path 指向出问题的具体文件，
 * message 同时带原因——排障时不必回到调用点反推路径。
 */
export class ImStoreError extends Error {
  readonly code: ImStoreErrorCode
  /** 出问题的文件或目录；纯校验错误还没有落盘路径时为 undefined。 */
  readonly path: string | undefined

  constructor(code: ImStoreErrorCode, message: string, path: string | undefined) {
    super(message)
    this.name = 'ImStoreError'
    this.code = code
    this.path = path
  }
}

/** 当前清单格式；未知版本直接报损坏，不做静默迁移。 */
const ACCOUNTS_VERSION = 1
const CHANNEL_IDS: readonly ImChannelId[] = ['qq', 'weixin', 'onebot']
/** accountId 同时是文件名片段：只放开安全字符，从根上挡掉路径穿越。 */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const SECRET_FILE_MODE = 0o600
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000
/** 内存条目超过该值就把文件压一遍，避免日志随在线时长无限增长。 */
const DEDUPE_COMPACT_THRESHOLD = 5000

interface ImAccountsFile {
  version: 1
  accounts: ImAccountRef[]
}

interface ImCursorFile {
  cursor: string
}

interface ImDedupeEntry {
  key: string
  at: number
}

export class ImStore {
  static open(root: string): ImStore {
    return new ImStore(root)
  }

  readonly root: string
  /** accounts.json 读改写的串行链；某个任务失败也不能掐断后面的任务。 */
  private accountsTail: Promise<void> = Promise.resolve()
  /** dedupe.log 读追加的串行链；同一 key 的并发回包只允许一次未命中。 */
  private dedupeTail: Promise<void> = Promise.resolve()
  /**
   * dedupe.log 的进程内镜像，首次 seenDedupe 时装载并回收过期条目。
   * 同一 root 只应有一个长期存活的实例（插件单例）：多实例并存时各自只看到
   * 自己 append 的 key，去重会退化——重启与测试里的短暂并存不受影响。
   */
  private dedupeEntries: Map<string, number> | undefined

  private constructor(root: string) {
    // 错误信息里的路径要能直接粘贴到终端；相对 root 会随进程 cwd 漂移。
    this.root = resolve(root)
  }

  /** 清单按 channel、accountId 排序；排序稳定，面板顺序不随写入先后跳动。 */
  async accounts(): Promise<ImAccountRef[]> {
    const entries = await this.readAccountsFile()
    return [...entries].sort(imStoreCompareAccounts)
  }

  /**
   * 登记或替换账号。密钥先落盘再改清单：登记成功的账号一定有可读密钥；
   * 反过来只会留下一个无人引用的孤儿文件（下次 putAccount 覆盖），不会对外
   * 宣告一个没有凭据的半残账号。两步同在一把锁里，与同账号的注销线性化。
   */
  async putAccount(account: ImAccountRef, secret: Record<string, string>): Promise<void> {
    imStoreAssertAccount(account)
    imStoreAssertSecretBag(secret)
    const record: ImSecretRecord = {
      channel: account.channel,
      accountId: account.accountId,
      secret: { ...secret },
      // 凭据被替换过就重盖时间戳：这个字段回答的是「当前密钥何时写入」。
      createdAt: new Date().toISOString(),
    }
    await this.serialAccounts(async () => {
      await imStoreWriteSecret(this.secretPath(account.channel, account.accountId), record)
      const accounts = await this.readAccountsFile()
      const next = accounts.filter((entry) => !imStoreSameAccount(entry, account.channel, account.accountId))
      next.push(imStoreSnapshotAccount(account))
      next.sort(imStoreCompareAccounts)
      await imStoreWriteJson(this.accountsPath(), { version: ACCOUNTS_VERSION, accounts: next } satisfies ImAccountsFile)
    })
  }

  /** 未知账号返回 undefined；文件存在但内容坏了必须报错，不能当成没配置。 */
  async readSecret(channel: ImChannelId, accountId: string): Promise<Record<string, string> | undefined> {
    imStoreAssertChannel(channel)
    imStoreAssertAccountId(accountId)
    const file = this.secretPath(channel, accountId)
    const value = await imStoreReadJson(file)
    if (value === undefined) return undefined
    return { ...imStoreParseSecretRecord(value, file, channel, accountId).secret }
  }

  /**
   * 注销账号：先摘清单再删密钥。反过来若清单写失败，会留下一个「已登记但
   * 没凭据」的账号，适配器会以空配置启动；先摘清单只可能留下孤儿密钥。
   * 两步与 putAccount 共用一把锁，同账号的「登录中删号」不会留下半残记录。
   * 已不在清单时仍清理同名密钥（幂等），凭据不应比账号活得更久。
   */
  async deleteAccount(channel: ImChannelId, accountId: string): Promise<boolean> {
    imStoreAssertChannel(channel)
    imStoreAssertAccountId(accountId)
    return this.serialAccounts(async () => {
      const accounts = await this.readAccountsFile()
      const next = accounts.filter((entry) => !imStoreSameAccount(entry, channel, accountId))
      const removed = next.length !== accounts.length
      if (removed) {
        await imStoreWriteJson(this.accountsPath(), { version: ACCOUNTS_VERSION, accounts: next } satisfies ImAccountsFile)
      }
      await imStoreRemoveFile(this.secretPath(channel, accountId))
      return removed
    })
  }

  /** true 表示该 key 已在 24h 窗口内记录过；未记录时顺带记下。 */
  async seenDedupe(dedupeKey: string, now: number): Promise<boolean> {
    if (dedupeKey === '') throw new TypeError('dedupeKey 不能为空')
    if (!Number.isFinite(now)) throw new TypeError(`now 必须是有限时间戳，实际为 ${String(now)}`)
    return this.serialDedupe(async () => {
      const entries = await this.loadDedupe()
      imStorePruneDedupe(entries, now)
      if (entries.has(dedupeKey)) return true
      entries.set(dedupeKey, now)
      const file = this.dedupePath()
      await imStoreEnsureDir(this.root)
      try {
        // 每条消息只追加一行；命中时不写，日志只在重置/压缩时变小。
        await fs.appendFile(file, `${JSON.stringify({ key: dedupeKey, at: now } satisfies ImDedupeEntry)}\n`, 'utf8')
      } catch (cause) {
        entries.delete(dedupeKey)
        throw new ImStoreError('IO', `追加失败: ${file}: ${imStoreReason(cause)}`, file)
      }
      if (entries.size > DEDUPE_COMPACT_THRESHOLD) {
        await imStoreWriteText(file, imStoreSerializeDedupe(entries))
      }
      return false
    })
  }

  async readCursor(accountId: string): Promise<string | undefined> {
    imStoreAssertAccountId(accountId)
    const file = this.cursorPath(accountId)
    const value = await imStoreReadJson(file)
    if (value === undefined) return undefined
    return imStoreParseCursor(value, file)
  }

  async writeCursor(accountId: string, value: string): Promise<void> {
    imStoreAssertAccountId(accountId)
    if (typeof value !== 'string') throw new TypeError(`cursor 必须是字符串，实际为 ${typeof value}`)
    await imStoreWriteJson(this.cursorPath(accountId), { cursor: value } satisfies ImCursorFile)
  }

  // ---- 内部：路径 ----

  private accountsPath(): string {
    return join(this.root, 'accounts.json')
  }

  private secretPath(channel: ImChannelId, accountId: string): string {
    return join(this.root, 'secrets', `${channel}-${accountId}.json`)
  }

  private dedupePath(): string {
    return join(this.root, 'dedupe.log')
  }

  private cursorPath(accountId: string): string {
    return join(this.root, 'cursors', `${accountId}.json`)
  }

  // ---- 内部：串行化 ----

  private serialAccounts<T>(task: () => Promise<T>): Promise<T> {
    const run = this.accountsTail.then(task, task)
    this.accountsTail = run.then(imStoreNoop, imStoreNoop)
    return run
  }

  private serialDedupe<T>(task: () => Promise<T>): Promise<T> {
    const run = this.dedupeTail.then(task, task)
    this.dedupeTail = run.then(imStoreNoop, imStoreNoop)
    return run
  }

  // ---- 内部：读取 ----

  private async readAccountsFile(): Promise<ImAccountRef[]> {
    const file = this.accountsPath()
    const value = await imStoreReadJson(file)
    // 清单缺失是全新安装，不是损坏；写坏的清单才会走 CORRUPT_FILE。
    if (value === undefined) return []
    return imStoreParseAccountsFile(value, file)
  }

  private async loadDedupe(): Promise<Map<string, number>> {
    const cached = this.dedupeEntries
    if (cached !== undefined) return cached
    const file = this.dedupePath()
    const entries = new Map<string, number>()
    let text: string
    try {
      text = await fs.readFile(file, 'utf8')
    } catch (cause) {
      if (imStoreIsErrno(cause, 'ENOENT')) {
        this.dedupeEntries = entries
        return entries
      }
      throw new ImStoreError('IO', `读取失败: ${file}: ${imStoreReason(cause)}`, file)
    }
    const lines = text.split('\n')
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim()
      if (line === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch (cause) {
        throw imStoreCorrupt(file, `第 ${index + 1} 行不是 JSON: ${imStoreReason(cause)}`)
      }
      if (!imStoreIsRecord(value)) throw imStoreCorrupt(file, `第 ${index + 1} 行不是对象`)
      const key = value['key']
      if (typeof key !== 'string' || key === '') throw imStoreCorrupt(file, `第 ${index + 1} 行 key 非法`)
      const at = value['at']
      if (typeof at !== 'number' || !Number.isFinite(at)) throw imStoreCorrupt(file, `第 ${index + 1} 行 at 非法`)
      // 同一 key 重放过两次时以较新的时间为准，避免旧记录提前把新记录判过期。
      const previous = entries.get(key)
      if (previous === undefined || at > previous) entries.set(key, at)
    }
    this.dedupeEntries = entries
    return entries
  }
}

// ---- 纯函数：校验 ----

function imStoreAssertChannel(channel: ImChannelId): void {
  if (!imStoreIsChannelId(channel)) {
    throw new ImStoreError(
      'BAD_ACCOUNT_ID',
      `未知通道 ${JSON.stringify(channel)}：只接受 ${CHANNEL_IDS.join('|')}`,
      undefined,
    )
  }
}

function imStoreAssertAccountId(accountId: string): void {
  if (!imStoreIsAccountId(accountId)) {
    throw new ImStoreError(
      'BAD_ACCOUNT_ID',
      `非法 accountId ${JSON.stringify(accountId)}：只允许 [A-Za-z0-9._-]，且不能是 . 或 ..（accountId 会拼进文件名）`,
      undefined,
    )
  }
}

function imStoreAssertAccount(account: ImAccountRef): void {
  imStoreAssertChannel(account.channel)
  imStoreAssertAccountId(account.accountId)
  if (typeof account.createdAt !== 'string' || account.createdAt === '') {
    throw new TypeError(`account.createdAt 必须是非空时间串，实际为 ${JSON.stringify(account.createdAt)}`)
  }
  if (account.label !== undefined && typeof account.label !== 'string') {
    throw new TypeError(`account.label 必须是字符串，实际为 ${JSON.stringify(account.label)}`)
  }
}

function imStoreAssertSecretBag(secret: Record<string, string>): void {
  for (const [key, value] of Object.entries(secret)) {
    if (typeof value !== 'string') throw new TypeError(`secret["${key}"] 必须是字符串，实际为 ${typeof value}`)
  }
}

function imStoreIsChannelId(value: unknown): value is ImChannelId {
  return typeof value === 'string' && (CHANNEL_IDS as readonly string[]).includes(value)
}

function imStoreIsAccountId(value: unknown): value is string {
  // 正则本身会放过 "." 与 ".."（都由允许字符组成），目录引用必须单独挡掉：
  // 文件名模板一旦变化，这两个就是现成的穿越原语。
  if (value === '.' || value === '..') return false
  return typeof value === 'string' && ACCOUNT_ID_PATTERN.test(value)
}

function imStoreIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function imStoreSameAccount(entry: ImAccountRef, channel: ImChannelId, accountId: string): boolean {
  return entry.channel === channel && entry.accountId === accountId
}

/** 只抄契约字段：调用方多带的字段不落盘，清单文件始终是 ImAccountRef 的形状。 */
function imStoreSnapshotAccount(account: ImAccountRef): ImAccountRef {
  return account.label === undefined
    ? { channel: account.channel, accountId: account.accountId, createdAt: account.createdAt }
    : { channel: account.channel, accountId: account.accountId, label: account.label, createdAt: account.createdAt }
}

function imStoreCompareAccounts(a: ImAccountRef, b: ImAccountRef): number {
  if (a.channel !== b.channel) return a.channel < b.channel ? -1 : 1
  if (a.accountId !== b.accountId) return a.accountId < b.accountId ? -1 : 1
  return 0
}

// ---- 纯函数：解析 ----

function imStoreParseAccountsFile(value: unknown, file: string): ImAccountRef[] {
  if (!imStoreIsRecord(value)) throw imStoreCorrupt(file, '顶层不是对象')
  if (value['version'] !== ACCOUNTS_VERSION) {
    throw imStoreCorrupt(file, `不支持的 version ${JSON.stringify(value['version'])}（期望 ${ACCOUNTS_VERSION}）`)
  }
  const accounts = value['accounts']
  if (!Array.isArray(accounts)) throw imStoreCorrupt(file, 'accounts 不是数组')
  return accounts.map((entry, index) => imStoreParseAccountRef(entry, file, index))
}

function imStoreParseAccountRef(value: unknown, file: string, index: number): ImAccountRef {
  const at = `accounts[${index}]`
  if (!imStoreIsRecord(value)) throw imStoreCorrupt(file, `${at} 不是对象`)
  const channel = value['channel']
  if (!imStoreIsChannelId(channel)) throw imStoreCorrupt(file, `${at}.channel 非法: ${JSON.stringify(channel)}`)
  const accountId = value['accountId']
  if (!imStoreIsAccountId(accountId)) throw imStoreCorrupt(file, `${at}.accountId 非法: ${JSON.stringify(accountId)}`)
  const createdAt = value['createdAt']
  if (typeof createdAt !== 'string') throw imStoreCorrupt(file, `${at}.createdAt 必须是字符串`)
  const label = value['label']
  if (label !== undefined && typeof label !== 'string') throw imStoreCorrupt(file, `${at}.label 必须是字符串`)
  return label === undefined
    ? { channel, accountId, createdAt }
    : { channel, accountId, label, createdAt }
}

/** 文件名与记录身份必须一致：串了文件意味着凭据给错了账号，按损坏处理。 */
function imStoreParseSecretRecord(
  value: unknown,
  file: string,
  channel: ImChannelId,
  accountId: string,
): ImSecretRecord {
  if (!imStoreIsRecord(value)) throw imStoreCorrupt(file, '顶层不是对象')
  if (value['channel'] !== channel || value['accountId'] !== accountId) {
    throw imStoreCorrupt(
      file,
      `记录身份 ${JSON.stringify(value['channel'])}/${JSON.stringify(value['accountId'])} 与文件名 ${channel}/${accountId} 不符`,
    )
  }
  const createdAt = value['createdAt']
  if (typeof createdAt !== 'string') throw imStoreCorrupt(file, 'createdAt 必须是字符串')
  const secret = value['secret']
  if (!imStoreIsRecord(secret)) throw imStoreCorrupt(file, 'secret 不是对象')
  const bag: Record<string, string> = {}
  for (const [key, entry] of Object.entries(secret)) {
    if (typeof entry !== 'string') throw imStoreCorrupt(file, `secret["${key}"] 必须是字符串`)
    bag[key] = entry
  }
  return { channel, accountId, secret: bag, createdAt }
}

function imStoreParseCursor(value: unknown, file: string): string {
  if (!imStoreIsRecord(value)) throw imStoreCorrupt(file, '顶层不是对象')
  const cursor = value['cursor']
  if (typeof cursor !== 'string') throw imStoreCorrupt(file, 'cursor 必须是字符串')
  return cursor
}

function imStorePruneDedupe(entries: Map<string, number>, now: number): void {
  const cutoff = now - DEDUPE_WINDOW_MS
  for (const [key, at] of entries) {
    // 恰好 24h 的条目仍算窗口内（"older than" 不含等于），只在更旧时丢弃。
    if (at < cutoff) entries.delete(key)
  }
}

function imStoreSerializeDedupe(entries: Map<string, number>): string {
  const lines: string[] = []
  for (const [key, at] of entries) lines.push(JSON.stringify({ key, at } satisfies ImDedupeEntry))
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

// ---- 内部：文件 I/O ----

function imStoreCorrupt(file: string, detail: string): ImStoreError {
  return new ImStoreError('CORRUPT_FILE', `文件损坏: ${file}: ${detail}`, file)
}

function imStoreReason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function imStoreIsErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code
}

function imStoreNoop(): void {
  // 串行链只关心「上一步已结束」，错误由各自返回的 promise 上抛。
}

async function imStoreEnsureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (cause) {
    throw new ImStoreError('IO', `创建目录失败: ${dir}: ${imStoreReason(cause)}`, dir)
  }
}

async function imStoreReadJson(file: string): Promise<unknown | undefined> {
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (cause) {
    if (imStoreIsErrno(cause, 'ENOENT')) return undefined
    throw new ImStoreError('IO', `读取失败: ${file}: ${imStoreReason(cause)}`, file)
  }
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw imStoreCorrupt(file, `JSON 解析失败: ${imStoreReason(cause)}`)
  }
}

async function imStoreRemoveFile(file: string): Promise<void> {
  try {
    await fs.unlink(file)
  } catch (cause) {
    // 目标态就是「文件不存在」，ENOENT 说明已经达成；其余失败照常上抛。
    if (imStoreIsErrno(cause, 'ENOENT')) return
    throw new ImStoreError('IO', `删除失败: ${file}: ${imStoreReason(cause)}`, file)
  }
}

/** tmp + rename：崩溃时读者只会看到旧文件或新文件，不会读到半截 JSON。 */
async function imStoreWriteFile(file: string, text: string, mode: number | undefined): Promise<void> {
  await imStoreEnsureDir(dirname(file))
  const tmp = `${file}.tmp-${randomUUID()}`
  try {
    // 密钥的 tmp 也带 0600：改名前后都不存在一个更宽松的中间态。
    await fs.writeFile(tmp, text, mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode })
    await fs.rename(tmp, file)
  } catch (cause) {
    // 清理失败不掩盖原始错误：真正要上报的是这次写失败。
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw new ImStoreError('IO', `写入失败: ${file}: ${imStoreReason(cause)}`, file)
  }
}

async function imStoreWriteText(file: string, text: string): Promise<void> {
  await imStoreWriteFile(file, text, undefined)
}

async function imStoreWriteJson(file: string, value: unknown): Promise<void> {
  await imStoreWriteText(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function imStoreWriteSecret(file: string, record: ImSecretRecord): Promise<void> {
  await imStoreWriteFile(file, `${JSON.stringify(record, null, 2)}\n`, SECRET_FILE_MODE)
  // Windows 没有 POSIX 权限位：chmod 是空操作、stat 恒报 0o666，校验只会误报；
  // 那里的边界是用户配置目录的 ACL（提案 §4.2 的 0600 只对 POSIX 生效）。
  if (process.platform === 'win32') return
  try {
    await fs.chmod(file, SECRET_FILE_MODE)
    const stats = await fs.stat(file)
    const mode = stats.mode & 0o777
    if (mode !== SECRET_FILE_MODE) {
      throw new ImStoreError(
        'SECRET_PERMISSION',
        `密钥文件权限异常: ${file}: 期望 0600，实际 0${mode.toString(8)}`,
        file,
      )
    }
  } catch (cause) {
    if (cause instanceof ImStoreError) throw cause
    throw new ImStoreError('IO', `校验密钥权限失败: ${file}: ${imStoreReason(cause)}`, file)
  }
}
