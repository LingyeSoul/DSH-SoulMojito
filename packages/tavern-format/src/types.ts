/**
 * 内部 IR（中间表示）类型。
 *
 * 设计原则：结构化字段是原始 JSON 的类型化视图；`raw` 袋保存逐字段原样拷贝。
 * 序列化时以 raw 为底、结构化字段覆盖——未知字段零丢失（ST 生态脏数据常态）。
 */

/* ------------------------------- 角色卡 ------------------------------- */

export type CardSpec = 'chara_card_v2' | 'chara_card_v3'

/** V3 assets 条目 */
export interface CardAsset {
  type: string
  uri: string
  name: string
  ext: string
  [key: string]: unknown
}

/** V2 data 层的原始 JSON 形态（宽松索引，供透传） */
export type RawCardData = Record<string, unknown>

/**
 * 结构化卡数据。V2/V3 归一：V2 缺失的 V3 字段为 undefined；
 * 未知字段经 raw 袋透传，不出现在此接口。
 */
export interface CardDataIR {
  name: string
  description: string
  personality: string
  scenario: string
  firstMes: string
  mesExample: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  alternateGreetings: string[]
  tags: string[]
  creator: string
  characterVersion: string
  extensions: Record<string, unknown>
  /** 卡内嵌角色书（原始 CharacterBook 形态，转换见 worldbook.ts） */
  characterBook?: CharacterBook
  /* ---- V3 增量字段（V2 卡上为 undefined） ---- */
  assets?: CardAsset[]
  nickname?: string
  creatorNotesMultilingual?: Record<string, string>
  source?: string[]
  groupOnlyGreetings?: string[]
  creationDate?: number
  modificationDate?: number
}

export interface CharacterCardIR {
  spec: CardSpec
  specVersion: string
  data: CardDataIR
  /**
   * 原始完整对象（深拷贝）：含顶层 V1 兼容字段（ST 导出行为：name/description/
   * avatar/chat/talkativeness/fav 等平铺在顶层）与一切未知键。
   * 序列化以此袋为底覆盖 spec/spec_version/data——未知字段零丢失。
   */
  raw: Record<string, unknown>
}

/* ------------------------------ 角色书 ------------------------------ */

/** CCv2/v3 规范的卡内嵌 CharacterBook（entries 为数组形态） */
export interface CharacterBook {
  name?: string
  description?: string
  scan_depth?: number
  token_budget?: number
  recursive_scanning?: boolean
  extensions?: Record<string, unknown>
  entries: CharacterBookEntry[]
  [key: string]: unknown
}

export interface CharacterBookEntry {
  keys: string[]
  content: string
  extensions?: Record<string, unknown>
  enabled: boolean
  insertion_order: number
  case_sensitive?: boolean
  name?: string
  priority?: number
  id?: number | string
  comment?: string
  selective?: boolean
  secondary_keys?: string[]
  constant?: boolean
  position?: 'before_char' | 'after_char'
  use_regex?: boolean
  [key: string]: unknown
}

/**
 * SillyTavern 世界书原生条目形态（worlds/*.json 的 entries 值）。
 * 与 @dsh-tavern/lore 引擎的输入形态对齐（包间无依赖、字段面对齐）。
 */
export interface LoreEntry {
  uid: number
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  vectorized: boolean
  selective: boolean
  /** 0=AND_ANY 1=NOT_ALL 2=NOT_ANY 3=AND_ALL */
  selectiveLogic: number
  addMemo: boolean
  order: number
  /** 0 beforeChar | 1 afterChar | 2 topAN | 3 bottomAN | 4 atDepth | 5 beforeEM | 6 afterEM | 7 outlet */
  position: number
  disable: boolean
  ignoreBudget: boolean
  excludeRecursion: boolean
  preventRecursion: boolean
  delayUntilRecursion: number
  probability: number
  useProbability: boolean
  depth: number
  outletName: string
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  /** atDepth 消息角色 0=system 1=user 2=assistant */
  role: number
  /** timed effects（单位=消息数，null=未启用） */
  sticky: number | null
  cooldown: number | null
  delay: number | null
  triggers: string[]
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  /** 未知/扩展字段透传袋 */
  extra?: Record<string, unknown>
}

export interface WorldBookIR {
  name: string
  /** 按 uid 升序 */
  entries: LoreEntry[]
  /** 世界书文件顶层未知键透传 */
  extra?: Record<string, unknown>
}

/* ------------------------------- 预设 ------------------------------- */

/** prompt_order 中单个条目 */
export interface PromptOrderEntry {
  identifier: string
  enabled: boolean
  [key: string]: unknown
}

export interface PromptOrderSet {
  character_id: number
  order: PromptOrderEntry[]
  [key: string]: unknown
}

/** marker 注入点类型（chatHistory 等） */
export type PromptMarker =
  | 'chatHistory'
  | 'worldInfoBefore'
  | 'worldInfoAfter'
  | 'charDescription'
  | 'charPersonality'
  | 'scenario'
  | 'personaDescription'
  | 'dialogueExamples'

/** 内容型 prompt 条目（非 marker） */
export interface ContentPrompt {
  name: string
  identifier: string
  role: 'system' | 'user' | 'assistant'
  content: string
  system_prompt: boolean
  injection_position?: number
  injection_depth?: number
  forbid_overrides?: boolean
  marker?: false
  [key: string]: unknown
}

/** marker 型 prompt 条目（注入占位） */
export interface MarkerPrompt {
  name: string
  identifier: PromptMarker | (string & {})
  marker: true
  system_prompt: boolean
  [key: string]: unknown
}

export type PresetPrompt = ContentPrompt | MarkerPrompt

/**
 * Chat Completion 预设 IR：prompts/prompt_order 结构化，
 * 其余键（采样参数、格式串、模型选择等 50+ 键）经 sampler 原样透传。
 */
export interface PresetIR {
  prompts: PresetPrompt[]
  promptOrder: PromptOrderSet[]
  /** prompts/prompt_order 之外的所有键（原样） */
  sampler: Record<string, unknown>
}

/* ------------------------------- 聊天 ------------------------------- */

export interface ChatHeader {
  user_name: string
  character_name: string
  chat_metadata: Record<string, unknown>
  [key: string]: unknown
}

export interface ChatMessage {
  name: string
  is_user: boolean
  is_system: boolean
  send_date: string
  mes: string
  extra?: Record<string, unknown>
  swipe_id?: number
  swipes?: string[]
  swipe_info?: Record<string, unknown>[]
  [key: string]: unknown
}

export interface ChatLogIR {
  header: ChatHeader
  messages: ChatMessage[]
}
