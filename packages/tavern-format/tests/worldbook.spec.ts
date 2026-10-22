import { describe, expect, it } from 'vitest'
import {
  normalizeEntry,
  parseCharacterBook,
  parseWorldInfoFile,
  serializeWorldInfoFile,
  stableDeepEqual,
  toCharacterBook,
} from '../src/index.js'
import { syntheticWorldRaw } from './helpers/synthetic.js'

describe('合成世界书：ExampleWorld', () => {
  it('解析得到升序 uid 条目', () => {
    const ir = parseWorldInfoFile('ExampleWorld', syntheticWorldRaw())
    expect(ir.entries.length).toBeGreaterThan(3)
    expect(ir.entries[0]!.uid).toBe(0)
    expect(ir.entries.map((e) => e.uid)).toEqual([...ir.entries.map((e) => e.uid)].sort((a, b) => a - b))
  })

  it('值保真：原对象字段值逐一保留', () => {
    const raw = syntheticWorldRaw()
    const ir = parseWorldInfoFile('ExampleWorld', raw)
    for (const [uid, rawEntry] of Object.entries(raw['entries'] as Record<string, Record<string, unknown>>)) {
      const entry = ir.entries.find((e) => e.uid === Number(uid))!
      expect(entry, `uid ${uid}`).toBeDefined()
      if (Array.isArray(rawEntry['key'])) expect(entry.key).toEqual(rawEntry['key'])
      expect(entry.content).toBe(rawEntry['content'])
      if (typeof rawEntry['order'] === 'number') expect(entry.order).toBe(rawEntry['order'])
      if (typeof rawEntry['position'] === 'number') expect(entry.position).toBe(rawEntry['position'])
      if (typeof rawEntry['constant'] === 'boolean') expect(entry.constant).toBe(rawEntry['constant'])
    }
  })

  it('序列化幂等：parse(serialize(parse(x))) ≡ parse(x)', () => {
    const once = parseWorldInfoFile('ExampleWorld', syntheticWorldRaw())
    const twice = parseWorldInfoFile('ExampleWorld', serializeWorldInfoFile(once))
    expect(stableDeepEqual(once, twice)).toBe(true)
  })

  it('序列化输出是合法 ST 文件形态（entries 为 map）', () => {
    const out = serializeWorldInfoFile(parseWorldInfoFile('ExampleWorld', syntheticWorldRaw()))
    expect(typeof out['entries']).toBe('object')
    expect(Array.isArray(out['entries'])).toBe(false)
  })
})

describe('卡内嵌书 ↔ ST 条目互转', () => {
  it('ST 自有字段经 extensions 袋往返保留（probability/depth/atDepth/递归开关）', () => {
    const ir = parseWorldInfoFile('t', {
      entries: {
        '0': {
          uid: 0, key: ['龙'], keysecondary: [], comment: '', content: 'C0',
          constant: false, selective: true, selectiveLogic: 0, order: 100, position: 4,
          depth: 7, role: 1, disable: false, probability: 60, useProbability: true,
          excludeRecursion: true, preventRecursion: false, delayUntilRecursion: 2,
          sticky: 3, cooldown: null, delay: null, triggers: ['normal'],
        },
      },
    })
    const book = toCharacterBook(ir)
    const back = parseCharacterBook(book)
    const e = back.entries[0]!
    expect(e.key).toEqual(['龙'])
    expect(e.content).toBe('C0')
    expect(e.position).toBe(4)
    expect(e.depth).toBe(7)
    expect(e.role).toBe(1)
    expect(e.probability).toBe(60)
    expect(e.excludeRecursion).toBe(true)
    expect(e.delayUntilRecursion).toBe(2)
    expect(e.sticky).toBe(3)
    expect(e.triggers).toEqual(['normal'])
  })

  it('规范原生字段映射：insertion_order↔order、enabled↔!disable、before/after_char↔position', () => {
    const book = {
      name: 'b',
      entries: [
        { keys: ['a'], content: 'A', enabled: true, insertion_order: 50, position: 'before_char', id: 3 },
        { keys: ['b'], content: 'B', enabled: false, insertion_order: 20, position: 'after_char', id: 4, constant: true, secondary_keys: ['x'], selective: true, case_sensitive: true },
      ],
    }
    const ir = parseCharacterBook(book)
    expect(ir.entries[0]!.order).toBe(50)
    expect(ir.entries[0]!.position).toBe(0)
    expect(ir.entries[0]!.uid).toBe(3)
    expect(ir.entries[1]!.disable).toBe(true)
    expect(ir.entries[1]!.position).toBe(1)
    expect(ir.entries[1]!.constant).toBe(true)
    expect(ir.entries[1]!.keysecondary).toEqual(['x'])
    expect(ir.entries[1]!.caseSensitive).toBe(true)
    // 逆向导出
    const out = toCharacterBook(ir)
    expect(out.entries[1]!.enabled).toBe(false)
    expect(out.entries[1]!.position).toBe('after_char')
    expect(out.entries[1]!.insertion_order).toBe(20)
  })

  it('未知/扩展字段进 extra 袋不丢失', () => {
    const entry = normalizeEntry({ uid: 9, key: ['k'], content: 'c', future_field: { a: 1 } })
    expect(entry.extra).toEqual({ future_field: { a: 1 } })
    const fileObj = serializeWorldInfoFile({ name: 'x', entries: [entry] })['entries'] as Record<string, Record<string, unknown>>
    expect(fileObj['9']!['future_field']).toEqual({ a: 1 })
  })
})
