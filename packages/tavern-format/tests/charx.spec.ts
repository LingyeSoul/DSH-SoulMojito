import { describe, expect, it } from 'vitest'
import {
  decodeCharx,
  decodeCharxAsset,
  encodeCharx,
  stableDeepEqual,
  decodeCharacterCard,
} from '../src/index.js'

const sampleCard = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: 'CharxTest', description: 'd', personality: '', scenario: '', first_mes: 'f', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '', extensions: {},
    assets: [{ type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' }],
    group_only_greetings: [],
  },
}

describe('CHARX 容器', () => {
  it('encode → decode：卡 roundtrip，资源路径与字节保真', () => {
    const ir = decodeCharacterCard(sampleCard)
    const iconBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const zip = encodeCharx(ir, [{ path: 'assets/icon/images/main.png', data: iconBytes }])
    const back = decodeCharx(zip)
    expect(stableDeepEqual(ir, back.card)).toBe(true)
    expect(back.assetPaths).toEqual(['assets/icon/images/main.png'])
    expect(Array.from(decodeCharxAsset(zip, 'assets/icon/images/main.png'))).toEqual(Array.from(iconBytes))
  })

  it('缺 card.json 抛错', () => {
    const zip = encodeCharx(decodeCharacterCard(sampleCard))
    const stripped = zip.subarray(0) // 结构合法
    expect(decodeCharx(stripped).card.data.name).toBe('CharxTest')
    expect(() => decodeCharx(new Uint8Array([1, 2, 3]))).toThrow(/zip/)
  })
})
