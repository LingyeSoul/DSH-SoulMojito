/**
 * IM 存储（提案 0024 §4.2）：清单/密钥/去重/游标的落盘契约。
 *
 * 全部用 mkdtemp 真目录跑真文件系统——0600、ENOENT、损坏文件这些行为只在
 * 真实 fs 上才有意义，mock 只能验证我们的假设。
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ImStore, ImStoreError, type ImSecretRecord } from '../src/im/store.js'
import type { ImAccountRef, ImChannelId } from '../src/im/types.js'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Windows 上刚 rename/unlink 的句柄可能还没完全释放，短退避重试同其它 spec。
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM')) throw cause
        await new Promise((done) => setTimeout(done, 25))
      }
    }
  }
})

async function fixture(): Promise<{ root: string; store: ImStore }> {
  const root = await mkdtemp(join(tmpdir(), 'im-store-'))
  roots.push(root)
  return { root, store: ImStore.open(root) }
}

function account(accountId: string, channel: ImChannelId = 'onebot'): ImAccountRef {
  return { channel, accountId, label: '测试账号', createdAt: '2026-10-30T00:00:00.000Z' }
}

describe('ImStore accounts and secrets', () => {
  it('registers an account and replaces it in place on a second put', async () => {
    const { root, store } = await fixture()
    expect(await store.accounts()).toEqual([])

    await store.putAccount(account('10001'), { token: 'first' })
    expect(await store.accounts()).toEqual([account('10001')])

    await store.putAccount({ ...account('10001'), label: '改名后' }, { token: 'second' })
    expect(await store.accounts()).toEqual([{ ...account('10001'), label: '改名后' }])
    expect(await store.readSecret('onebot', '10001')).toEqual({ token: 'second' })

    const file = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as {
      version: unknown
      accounts: unknown[]
    }
    expect(file.version).toBe(1)
    expect(file.accounts).toHaveLength(1)
  })

  it('reads the secret bag and reports unknown accounts as undefined', async () => {
    const { store } = await fixture()
    await store.putAccount(account('7'), { appId: '123', appSecret: 's3cret' })

    expect(await store.readSecret('onebot', '7')).toEqual({ appId: '123', appSecret: 's3cret' })
    expect(await store.readSecret('qq', '7')).toBeUndefined()
    expect(await store.readSecret('onebot', 'missing')).toBeUndefined()

    const raw = JSON.parse(await readFile(join(store.root, 'secrets', 'onebot-7.json'), 'utf8')) as ImSecretRecord
    expect(raw).toMatchObject({ channel: 'onebot', accountId: '7', secret: { appId: '123', appSecret: 's3cret' } })
    expect(typeof raw.createdAt).toBe('string')
  })

  it('deletes the entry and the secret file, then reports false', async () => {
    const { root, store } = await fixture()
    await store.putAccount(account('9'), { token: 'gone-soon' })
    const secretFile = join(root, 'secrets', 'onebot-9.json')
    expect(await readFile(secretFile, 'utf8')).toContain('gone-soon')

    expect(await store.deleteAccount('onebot', '9')).toBe(true)
    expect(await store.accounts()).toEqual([])
    await expect(readFile(secretFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await store.deleteAccount('onebot', '9')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('writes secret files with mode 0600', async () => {
    const { root, store } = await fixture()
    await store.putAccount(account('42'), { token: 'must-stay-private' })
    const stats = await stat(join(root, 'secrets', 'onebot-42.json'))
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('rejects traversal-shaped ids and invalid channels without writing anything', async () => {
    const { root, store } = await fixture()
    const error = await store.putAccount({ ...account('x'), accountId: '../escape' }, { token: 'nope' }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ImStoreError)
    expect(error).toMatchObject({ code: 'BAD_ACCOUNT_ID' })
    expect((error as Error).message).toContain('../escape')
    expect(await readdir(root)).toEqual([])

    await expect(store.readSecret('onebot', '..')).rejects.toMatchObject({ code: 'BAD_ACCOUNT_ID' })
    await expect(store.readSecret('wechat' as ImChannelId, '1')).rejects.toMatchObject({ code: 'BAD_ACCOUNT_ID' })
    await expect(store.writeCursor('a/b', 'x')).rejects.toMatchObject({ code: 'BAD_ACCOUNT_ID' })
  })

  it('serializes concurrent account writes instead of losing entries', async () => {
    const { store } = await fixture()
    const accounts: ImAccountRef[] = [
      account('b', 'qq'),
      account('a', 'onebot'),
      account('m', 'weixin'),
      account('a0', 'onebot'),
      account('a1', 'onebot'),
      account('a2', 'onebot'),
    ]
    await Promise.all(accounts.map((entry) => store.putAccount(entry, { token: entry.accountId })))

    const listed = await store.accounts()
    expect(listed).toHaveLength(accounts.length)
    expect(listed.map((entry) => `${entry.channel}/${entry.accountId}`)).toEqual([
      'onebot/a',
      'onebot/a0',
      'onebot/a1',
      'onebot/a2',
      'qq/b',
      'weixin/m',
    ])
  })

  it('refuses a corrupt accounts.json instead of falling back to an empty list', async () => {
    const { root, store } = await fixture()
    const file = join(root, 'accounts.json')
    const broken = '{ "version": 1, "accounts": ['
    await writeFile(file, broken, 'utf8')

    const error = await store.accounts().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ImStoreError)
    expect(error).toMatchObject({ code: 'CORRUPT_FILE', path: file })
    expect((error as Error).message).toContain(file)

    // 损坏文件不能被一次写入顺势覆盖成「干净的空清单」。
    await expect(store.putAccount(account('1'), { token: 'x' })).rejects.toMatchObject({ code: 'CORRUPT_FILE' })
    expect(await readFile(file, 'utf8')).toBe(broken)
  })
})

describe('ImStore dedupe log', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0)

  it('reports a key once inside the 24h window and appends it a single time', async () => {
    const { root, store } = await fixture()
    expect(await store.seenDedupe('onebot:1:msg-1', now)).toBe(false)
    expect(await store.seenDedupe('onebot:1:msg-1', now + 1_000)).toBe(true)
    expect(await store.seenDedupe('onebot:1:msg-2', now + 2_000)).toBe(false)

    const lines = (await readFile(join(root, 'dedupe.log'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '')).toEqual({ key: 'onebot:1:msg-1', at: now })
    expect(JSON.parse(lines[1] ?? '')).toEqual({ key: 'onebot:1:msg-2', at: now + 2_000 })
  })

  it('forgets keys older than 24h and tolerates a duplicate key in the log', async () => {
    const { root, store } = await fixture()
    const day = 24 * 60 * 60 * 1000
    await writeFile(
      join(root, 'dedupe.log'),
      [
        JSON.stringify({ key: 'onebot:1:old', at: now - day - 1_000 }),
        JSON.stringify({ key: 'onebot:1:old', at: now - day - 500 }),
        JSON.stringify({ key: 'onebot:1:fresh', at: now - 1_000 }),
        '',
      ].join('\n'),
      'utf8',
    )

    expect(await store.seenDedupe('onebot:1:old', now)).toBe(false)
    expect(await store.seenDedupe('onebot:1:old', now + 1)).toBe(true)
    expect(await store.seenDedupe('onebot:1:fresh', now)).toBe(true)
  })

  it('shares the log across store instances opened on the same root', async () => {
    const { root, store } = await fixture()
    expect(await store.seenDedupe('qq:1:repeat', now)).toBe(false)
    expect(await ImStore.open(root).seenDedupe('qq:1:repeat', now + 5)).toBe(true)
  })
})

describe('ImStore cursors', () => {
  it('round-trips a cursor and keeps it across store instances', async () => {
    const { root, store } = await fixture()
    expect(await store.readCursor('10001')).toBeUndefined()

    await store.writeCursor('10001', 'sync-buf-abc')
    expect(await store.readCursor('10001')).toBe('sync-buf-abc')

    const reopened = ImStore.open(root)
    expect(await reopened.readCursor('10001')).toBe('sync-buf-abc')

    await reopened.writeCursor('10001', 'sync-buf-def')
    expect(await store.readCursor('10001')).toBe('sync-buf-def')
  })
})
