import { describe, expect, it } from 'vitest'
import { imAccountIdOf } from '../src/im/account-id.js'

describe('imAccountIdOf', () => {
  it('keeps an already safe platform id unchanged', () => {
    expect(imAccountIdOf('weixin', 'bot_12345.abc-XY')).toBe('bot_12345.abc-XY')
  })

  it('derives a safe id from an email-shaped WeChat ilink_bot_id', () => {
    // 实机反馈：微信的 ilink_bot_id 可能是邮箱形状，直接当文件名会让扫码在最后一步失败。
    const derived = imAccountIdOf('weixin', 'some.bot@example.invalid')
    expect(derived).toMatch(/^weixin-[0-9a-f]{12}$/)
  })

  it('is stable for the same platform id and distinct across different ids', () => {
    const first = imAccountIdOf('weixin', 'a@b.invalid')
    const second = imAccountIdOf('weixin', 'a@b.invalid')
    const other = imAccountIdOf('weixin', 'c@d.invalid')
    expect(first).toBe(second)
    expect(first).not.toBe(other)
  })

  it('rejects an empty platform id and path traversal names', () => {
    expect(() => imAccountIdOf('weixin', '   ')).toThrow(/empty id/)
    expect(() => imAccountIdOf('weixin', '..')).toThrow(/path traversal/)
  })

  it('never returns characters outside the filesystem allowlist', () => {
    for (const raw of ['a@b', '群名/带斜杠', 'a:b', 'a b', '🙂']) {
      expect(imAccountIdOf('weixin', raw)).toMatch(/^[A-Za-z0-9._-]+$/)
    }
  })
})
