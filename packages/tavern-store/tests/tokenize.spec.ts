import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryStore, excerptAround, matchedTokenCount, tokenizeQuery, tokenThreshold } from '../src/index.js'

describe('tokenizeQuery：CJK 感知分词（决策 2026-10-11-cjk-tokenization）', () => {
  it('英文整词与数字段行为与旧实现一致', () => {
    expect(tokenizeQuery('brass key')).toEqual(['brass', 'key'])
    expect(tokenizeQuery('Gate9 moon-gate!')).toEqual(['gate9', 'moon', 'gate'])
    expect(tokenizeQuery('   ')).toEqual([])
  })

  it('中文连续段展开为相邻 bigram，两端均为虚词的 bigram 被停用', () => {
    // 林小雨欠的赌债还了吗（10 字）→ 9 个 bigram，其中 "还了""了吗" 两端
    // 全在虚词停用表内被丢弃，剩 7 个。
    expect(tokenizeQuery('林小雨欠的赌债还了吗')).toEqual(['林小', '小雨', '雨欠', '欠的', '的赌', '赌债', '债还'])
  })

  it('长度 1 的 CJK 段保留单字 token（单字查询语义）', () => {
    expect(tokenizeQuery('赌')).toEqual(['赌'])
    expect(tokenizeQuery('赌 债')).toEqual(['赌', '债'])
  })

  it('重复 token 去重', () => {
    // 赌债赌债 → bigram (赌债)(债赌)(赌债)，去重后两个。
    expect(tokenizeQuery('赌债赌债')).toEqual(['赌债', '债赌'])
  })

  it('中英混排按段分词，段间不产生跨脚本 token（拉丁词先入集合，顺序无语义）', () => {
    expect(tokenizeQuery('林小雨拿到了VIP卡')).toEqual(['vip', '林小', '小雨', '雨拿', '拿到', '到了', '卡'])
  })

  it('假名与谚文段同样走 bigram 展开', () => {
    expect(tokenizeQuery('よろしく')).toEqual(['よろ', 'ろし', 'しく'])
    expect(tokenizeQuery('안녕하세요')).toEqual(['안녕', '녕하', '하세', '세요'])
  })
})

describe('分级匹配与摘录（tokenize.ts 单一来源；agent-tavern / 记忆维护 / agent-novel 共用）', () => {
  it('tokenThreshold：≤3 严格 AND，>3 走 40% 上取整阈值', () => {
    expect(tokenThreshold(1)).toBe(1)
    expect(tokenThreshold(3)).toBe(3)
    expect(tokenThreshold(4)).toBe(2)
    expect(tokenThreshold(7)).toBe(3)
  })

  it('matchedTokenCount：大小写不敏感的逐 token 子串计数', () => {
    expect(matchedTokenCount('林小雨在赌场欠下赌债', ['林小', '赌债', '缺席'])).toBe(2)
    expect(matchedTokenCount('Silver KEY', ['silver', 'key'])).toBe(2)
  })

  it('excerptAround：锚定最靠前命中 token，向前留 80 字符，超宽两端省略', () => {
    const text = `${'前'.repeat(200)}林小雨欠债${'后'.repeat(200)}`
    const excerpt = excerptAround(text, ['欠债', '林小'], 100)
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt).toContain('林小雨欠债')
    // 短文本整段返回，不加省略号。
    expect(excerptAround('短文本', ['短'], 40)).toBe('短文本')
  })
})

describe('MemoryStore.search：中文 bigram 召回', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cjk-tokenize-'))
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('自然语言中文查询将目标记忆排在无关记忆之前', async () => {
    const memory = await MemoryStore.open(join(dir, 'agent'))
    const debt = await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: '林小雨在赌场欠下高额赌债，约定月底前还清。',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm1' },
    })
    const weather = await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: '镇上连日暴雨，渡口停航。',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm2' },
    })
    const hits = await memory.search({ scope: 'chat', scopeId: 'c1', query: '林小雨欠的赌债还了吗' })
    const ids = hits.map((hit) => hit.record.id)
    expect(ids[0]).toBe(debt.id)
    expect(ids.indexOf(debt.id)).toBeLessThan(ids.indexOf(weather.id))
  })

  it('纯专名中文查询精确命中专名记忆', async () => {
    const memory = await MemoryStore.open(join(dir, 'agent-2'))
    const target = await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: '林小雨是渡口酒馆的驻唱歌手。',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm1' },
    })
    const other = await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: '沈青梧经营着镇上唯一的当铺。',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm2' },
    })
    const hits = await memory.search({ scope: 'chat', scopeId: 'c1', query: '林小雨' })
    const ids = hits.map((hit) => hit.record.id)
    expect(ids[0]).toBe(target.id)
    expect(ids.indexOf(target.id)).toBeLessThan(ids.indexOf(other.id))
  })

  it('英文查询打分行为回归不变', async () => {
    const memory = await MemoryStore.open(join(dir, 'agent-3'))
    const created = await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: 'The silver key opens the west gate.',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm1' },
    })
    await memory.put({
      scope: 'chat', scopeId: 'c1', kind: 'semantic',
      content: 'The user fears deep water.',
      importance: 0.5, confidence: 0.9, source: { kind: 'user', id: 'm2' },
    })
    const hits = await memory.search({ scope: 'chat', scopeId: 'c1', query: 'silver gate' })
    expect(hits[0]?.record.id).toBe(created.id)
    expect(hits[0]?.score).toBeGreaterThan(hits[1]!.score)
  })
})
