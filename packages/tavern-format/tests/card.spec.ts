import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  decodeCharacterCard,
  encodeCharacterCardJson,
  encodeCharacterCardPng,
  extractCardJson,
  readTextChunks,
  stableDeepEqual,
} from '../src/index.js'

const fixturesDir = fileURLToPath(new URL('./fixtures', import.meta.url))
const seraphinaPng = () => new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`))

describe('真实卡解析：ExampleCard.png', () => {
  it('decode 得到合法卡', () => {
    const ir = decodeCharacterCard(seraphinaPng())
    expect(ir.data.name).toBe('ExampleCard')
    expect(['chara_card_v2', 'chara_card_v3']).toContain(ir.spec)
    expect(ir.data.firstMes.length).toBeGreaterThan(0)
  })

  it('PNG roundtrip：encode → decode 与首次 decode 语义一致', () => {
    const first = decodeCharacterCard(seraphinaPng())
    const encoded = encodeCharacterCardPng(first, seraphinaPng())
    const second = decodeCharacterCard(encoded)
    expect(stableDeepEqual(first, second)).toBe(true)
  })

  it('encode 产出的 JSON 与原卡 chunk JSON 语义等价（未知字段零丢失）', () => {
    const original = JSON.parse(extractCardJson(seraphinaPng())!)
    const ir = decodeCharacterCard(seraphinaPng())
    const produced = JSON.parse(extractCardJson(encodeCharacterCardPng(ir, seraphinaPng()))!)
    expect(stableDeepEqual(original, produced)).toBe(true)
  })
})

describe('V1 提升与 V2/V3 归一', () => {
  it('V1 顶层平铺卡提升为 chara_card_v2', () => {
    const v1 = {
      name: 'Klee',
      description: 'd',
      personality: 'p',
      scenario: 's',
      first_mes: 'f',
      mes_example: 'e',
    }
    const ir = decodeCharacterCard(v1)
    expect(ir.spec).toBe('chara_card_v2')
    expect(ir.data.name).toBe('Klee')
    expect(ir.data.firstMes).toBe('f')
    const out = encodeCharacterCardJson(ir)
    expect((out['data'] as Record<string, unknown>)['first_mes']).toBe('f')
  })

  it('V3 JSON 对象 roundtrip，专有字段与未知字段保留', () => {
    const v3 = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'N',
        description: 'd',
        personality: '',
        scenario: '',
        first_mes: 'hi',
        mes_example: '',
        creator_notes: '',
        system_prompt: '{{original}}',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['x'],
        creator: 'c',
        character_version: '1',
        extensions: { 'some/frontend': { keep: true } },
        assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
        nickname: 'Nicky',
        group_only_greetings: [],
        custom_future_field: { deep: [1, 2] },
      },
    }
    const ir = decodeCharacterCard(v3)
    expect(ir.spec).toBe('chara_card_v3')
    expect(ir.data.nickname).toBe('Nicky')
    const out = encodeCharacterCardJson(ir)
    expect(stableDeepEqual(JSON.parse(JSON.stringify(v3)), out)).toBe(true)
  })

  it('name 缺失抛错', () => {
    expect(() => decodeCharacterCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { description: 'x' } })).toThrow(/name/)
  })
})

describe('V3 PNG 双 chunk 行为（对齐 ST 导出）', () => {
  it('V3 卡 encode 同时写 chara 与 ccv3，ccv3 优先读取', () => {
    const v3 = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'V3C', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {}, group_only_greetings: [] },
    }
    const ir = decodeCharacterCard(v3)
    const png = encodeCharacterCardPng(ir, new Uint8Array(readFileSync(`${fixturesDir}/ExampleCard.png`)))
    const keywords = readTextChunks(png).map((t) => t.keyword)
    expect(keywords).toContain('chara')
    expect(keywords).toContain('ccv3')
    // 再 decode 读取的是 ccv3（V3 全量），nickname 等保留
    expect(decodeCharacterCard(png).data.name).toBe('V3C')
  })
})
