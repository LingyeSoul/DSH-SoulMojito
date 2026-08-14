/**
 * 角色卡解析/导出：PNG（chara/ccv3 tEXt chunk）、JSON 对象、V1 提升、V2/V3 归一 IR。
 * ST 导出行为对齐：导出 PNG 时同时写 chara（V2 数据）与 ccv3（V3 数据）。
 */

import {
  base64ToUtf8,
  extractCardJson,
  isPng,
  utf8ToBase64,
  writeTextChunks,
  CARD_CHUNK_V2,
  CARD_CHUNK_V3,
} from './png.js'
import type { CardAsset, CardDataIR, CardSpec, CharacterCardIR, RawCardData } from './types.js'

export class CardFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardFormatError'
  }
}

/* ------------------------------ 解析 ------------------------------ */

export type CardInput = Uint8Array | ArrayBuffer | object

/**
 * 解析角色卡：PNG 字节（chara/ccv3）或已解析的 JSON 对象。
 * V1（顶层平铺、无 spec）提升为 chara_card_v2 形态。
 */
export function decodeCharacterCard(input: CardInput): CharacterCardIR {
  let obj: unknown
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
    if (!isPng(bytes)) throw new CardFormatError('binary input is not a PNG file')
    const json = extractCardJson(bytes)
    if (json === null) throw new CardFormatError('PNG has no chara/ccv3 tEXt chunk')
    obj = parseJson(json)
  } else {
    obj = input
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new CardFormatError('card root is not an object')
  }
  return fromCardObject(obj as Record<string, unknown>)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new CardFormatError(`card chunk JSON is invalid: ${String(cause)}`)
  }
}

function fromCardObject(root: Record<string, unknown>): CharacterCardIR {
  const spec = typeof root['spec'] === 'string' ? root['spec'] : undefined
  let data: Record<string, unknown>
  let specName: CardSpec
  let specVersion: string

  if (spec === 'chara_card_v2' || spec === 'chara_card_v3') {
    const raw = root['data']
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new CardFormatError(`spec ${spec} present but 'data' is not an object`)
    }
    data = raw as Record<string, unknown>
    specName = spec
    specVersion = typeof root['spec_version'] === 'string' ? root['spec_version'] : spec === 'chara_card_v3' ? '3.0' : '2.0'
  } else if (spec !== undefined) {
    // 未知 spec 版本：浮点比较语义下更高的未知版本按 V3 容忍读取（忽略未知字段原则）
    data = (root['data'] as Record<string, unknown>) ?? {}
    specName = 'chara_card_v3'
    specVersion = typeof root['spec_version'] === 'string' ? root['spec_version'] : '3.0'
  } else {
    // V1：六字段平铺在顶层
    data = root
    specName = 'chara_card_v2'
    specVersion = '1.0'
  }

  if (typeof data['name'] !== 'string' || data['name'].length === 0) {
    throw new CardFormatError("card data has no 'name' string")
  }

  return {
    spec: specName,
    specVersion,
    data: toCardDataIR(data),
    // ST 导出的真实卡顶层并存 V1 兼容字段与 spec/data 三层——raw 必须存整个对象
    raw: structuredClone(root) as Record<string, unknown>,
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function toCardDataIR(data: Record<string, unknown>): CardDataIR {
  const book = data['character_book']
  const ir: CardDataIR = {
    name: str(data['name']),
    description: str(data['description']),
    personality: str(data['personality']),
    scenario: str(data['scenario']),
    firstMes: str(data['first_mes']),
    mesExample: str(data['mes_example']),
    creatorNotes: str(data['creator_notes']),
    systemPrompt: str(data['system_prompt']),
    postHistoryInstructions: str(data['post_history_instructions']),
    alternateGreetings: strArray(data['alternate_greetings']),
    tags: strArray(data['tags']),
    creator: str(data['creator']),
    characterVersion: str(data['character_version']),
    extensions: (typeof data['extensions'] === 'object' && data['extensions'] !== null
      ? (data['extensions'] as Record<string, unknown>)
      : {}),
  }
  if (isCharacterBook(book)) ir.characterBook = book
  if (Array.isArray(data['assets'])) ir.assets = data['assets'].filter((a): a is CardAsset => typeof a === 'object' && a !== null)
  if (typeof data['nickname'] === 'string') ir.nickname = data['nickname']
  if (isStringRecord(data['creator_notes_multilingual'])) ir.creatorNotesMultilingual = data['creator_notes_multilingual'] as Record<string, string>
  if (strArray(data['source']).length > 0) ir.source = strArray(data['source'])
  if (Array.isArray(data['group_only_greetings'])) ir.groupOnlyGreetings = strArray(data['group_only_greetings'])
  if (typeof data['creation_date'] === 'number') ir.creationDate = data['creation_date']
  if (typeof data['modification_date'] === 'number') ir.modificationDate = data['modification_date']
  return ir
}

function isCharacterBook(value: unknown): value is CardDataIR['characterBook'] {
  return typeof value === 'object' && value !== null && Array.isArray((value as { entries?: unknown }).entries)
}

function isStringRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ------------------------------ 导出 ------------------------------ */

/** 结构化字段重建 data 对象（以 raw 为底覆盖已知键——未知字段零丢失）。 */
export function cardDataToRaw(ir: CharacterCardIR): RawCardData {
  const rawBase = (typeof ir.raw['data'] === 'object' && ir.raw['data'] !== null
    ? structuredClone(ir.raw['data'])
    : {}) as RawCardData
  const data: RawCardData = { ...rawBase }
  const d = ir.data
  data['name'] = d.name
  data['description'] = d.description
  data['personality'] = d.personality
  data['scenario'] = d.scenario
  data['first_mes'] = d.firstMes
  data['mes_example'] = d.mesExample
  data['creator_notes'] = d.creatorNotes
  data['system_prompt'] = d.systemPrompt
  data['post_history_instructions'] = d.postHistoryInstructions
  data['alternate_greetings'] = d.alternateGreetings
  data['tags'] = d.tags
  data['creator'] = d.creator
  data['character_version'] = d.characterVersion
  data['extensions'] = d.extensions
  if (d.characterBook === undefined) delete data['character_book']
  else data['character_book'] = d.characterBook
  for (const [irKey, jsonKey] of V3_FIELDS) {
    const value = (d as unknown as Record<string, unknown>)[irKey]
    if (value === undefined) delete data[jsonKey]
    else data[jsonKey] = value
  }
  return data
}

const V3_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['assets', 'assets'],
  ['nickname', 'nickname'],
  ['creatorNotesMultilingual', 'creator_notes_multilingual'],
  ['source', 'source'],
  ['groupOnlyGreetings', 'group_only_greetings'],
  ['creationDate', 'creation_date'],
  ['modificationDate', 'modification_date'],
]

/** 序列化为可 JSON.stringify 的对象（保持原 spec；顶层 V1 兼容字段经 raw 袋保留）。 */
export function encodeCharacterCardJson(ir: CharacterCardIR): Record<string, unknown> {
  return {
    ...structuredClone(ir.raw),
    spec: ir.spec,
    spec_version: ir.specVersion,
    data: cardDataToRaw(ir),
  }
}

/**
 * 序列化为 PNG：以 template 为底写入 chara/ccv3 chunk。
 * V2 卡只写 chara；V3 卡按 ST 行为同时写 chara（V2 视图）与 ccv3。
 */
export function encodeCharacterCardPng(ir: CharacterCardIR, template: Uint8Array): Uint8Array {
  const entries: Array<{ keyword: string; text: string }> = [
    { keyword: CARD_CHUNK_V2, text: utf8ToBase64(JSON.stringify(toV2Json(ir))) },
  ]
  if (ir.spec === 'chara_card_v3') {
    entries.push({ keyword: CARD_CHUNK_V3, text: utf8ToBase64(JSON.stringify(encodeCharacterCardJson(ir))) })
  }
  return writeTextChunks(template, entries)
}

/**
 * V2 视图（写入 chara chunk）：以 raw 顶层为底，V1 兼容六字段从 data 镜像同步，
 * 剥除 V3 专有字段。对齐 ST 导出行为（chara chunk 是 V2 投影）。
 */
function toV2Json(ir: CharacterCardIR): Record<string, unknown> {
  const data = cardDataToRaw(ir)
  for (const jsonKey of V3_FIELDS.map((f) => f[1])) delete data[jsonKey]
  return {
    ...structuredClone(ir.raw),
    name: ir.data.name,
    description: ir.data.description,
    personality: ir.data.personality,
    scenario: ir.data.scenario,
    first_mes: ir.data.firstMes,
    mes_example: ir.data.mesExample,
    tags: ir.data.tags,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data,
  }
}
