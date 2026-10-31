import { describe, expect, it } from 'vitest'
import { createImLog, wrapImLogger } from '../src/im/log.js'

describe('im runtime log', () => {
  it('keeps the newest entries within capacity and keeps seq monotonic', () => {
    let now = 0
    const log = createImLog({ capacity: 3, now: () => (now += 1) })
    for (let index = 0; index < 5; index += 1) log.note('info', `entry ${index}`)
    const snapshot = log.read({ limit: 10 })
    expect(snapshot.entries.map((entry) => entry.text)).toEqual(['entry 2', 'entry 3', 'entry 4'])
    expect(snapshot.entries.map((entry) => entry.seq)).toEqual([3, 4, 5])
    expect(snapshot.nextSeq).toBe(5)
  })

  it('reads incrementally after a seq', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    log.note('info', 'first')
    const mark = log.read({ limit: 10 }).nextSeq
    log.note('info', 'second')
    const page = log.read({ limit: 10, afterSeq: mark })
    expect(page.entries.map((entry) => entry.text)).toEqual(['second'])
    expect(page.nextSeq).toBe(2)
  })

  it('filters by minimum level', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    log.note('debug', 'noise')
    log.note('info', 'ok')
    log.note('warn', 'careful')
    log.note('error', 'boom')
    expect(log.read({ limit: 10, minLevel: 'warn' }).entries.map((entry) => entry.text)).toEqual(['careful', 'boom'])
  })

  it('drops blank entries and truncates very long ones', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    log.note('info', '   ')
    log.note('error', 'x'.repeat(5_000))
    const entries = log.read({ limit: 10 }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]!.text.length).toBeLessThanOrEqual(2_001)
    expect(entries[0]!.text.endsWith('…')).toBe(true)
  })

  it('mirrors every level into the host logger', () => {
    const seen: Array<{ level: string; message: string; meta: unknown }> = []
    const base = {
      debug: (message: unknown, meta?: unknown) => seen.push({ level: 'debug', message: String(message), meta }),
      info: (message: unknown, meta?: unknown) => seen.push({ level: 'info', message: String(message), meta }),
      warn: (message: unknown, meta?: unknown) => seen.push({ level: 'warn', message: String(message), meta }),
      error: (message: unknown, meta?: unknown) => seen.push({ level: 'error', message: String(message), meta }),
    }
    const log = createImLog({ capacity: 10, now: () => 1 })
    const logger = wrapImLogger(base, log)
    logger.info?.('channel online', { accountId: 'a1' })
    logger.warn?.('send failed')
    expect(seen.map((entry) => entry.level)).toEqual(['info', 'warn'])
    expect(seen[0]?.meta).toEqual({ accountId: 'a1' })
    expect(log.read({ limit: 10 }).entries.map((entry) => entry.text)).toEqual(['channel online', 'send failed'])
  })

  it('redacts absolute paths before they reach the browser', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    log.note('warn', 'could not load C:\\Users\\alice\\.dsh\\soulmojito\\im\\secrets\\weixin-a.json')
    log.note('warn', 'failed to read /home/alice/.dsh/tavern/im/runtime/index.js')
    log.note('info', 'QR ready (https://ilinkai.weixin.qq.com)')
    const texts = log.read({ limit: 10 }).entries.map((entry) => entry.text)
    expect(texts[0]).toBe('could not load <path>')
    expect(texts[1]).toBe('failed to read <path>')
    // URL 不是文件路径：斜杠前是冒号，原样保留。
    expect(texts[2]).toBe('QR ready (https://ilinkai.weixin.qq.com)')
  })

  it('redacts quoted, forward-slash and UNC paths too', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    log.note('warn', "open '/home/user/.dsh/soulmojito/im-media/weixin-a/1.png' failed")
    log.note('warn', 'cannot read C:/Users/user/secret.txt')
    log.note('warn', 'network share //server/share/secret.txt is unavailable')
    log.note('warn', 'the file "C:\\Program Files\\App\\secret.txt" is gone')
    const texts = log.read({ limit: 10 }).entries.map((entry) => entry.text)
    expect(texts[0]).toBe("open '<path>' failed")
    expect(texts[1]).toBe('cannot read <path>')
    expect(texts[2]).toBe('network share <path> is unavailable')
    expect(texts[3]).toBe('the file "<path>" is gone')
  })

  it('works without a host logger', () => {
    const log = createImLog({ capacity: 10, now: () => 1 })
    const logger = wrapImLogger(undefined, log)
    expect(() => logger.error?.('only the panel sees this')).not.toThrow()
    expect(log.read({ limit: 10 }).entries).toHaveLength(1)
  })
})
