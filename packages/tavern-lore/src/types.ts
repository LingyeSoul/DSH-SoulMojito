/**
 * @dsh-tavern/lore — World Info (lorebook) activation engine with SillyTavern semantics.
 *
 * 类型层。算法语义对照 SillyTavern `public/scripts/world-info.js`（release 分支）：
 * - 世界书条目字段/默认值 ← `newWorldInfoEntryDefinition`
 * - 扫描算法 ← `checkWorldInfo` / `WorldInfoBuffer` / `WorldInfoTimedEffects` / `filterByInclusionGroups`
 */

/* ------------------------------ 常量枚举 ------------------------------ */

/** 插入位置（world_info_position；7=Outlet 为 ST 文档位，本引擎按 docs/exploration §2.3 实现）。 */
export const WI_POSITION = {
  /** Before Char Defs */
  BEFORE: 0,
  /** After Char Defs */
  AFTER: 1,
  /** Top of Author's Note */
  AN_TOP: 2,
  /** Bottom of Author's Note */
  AN_BOTTOM: 3,
  /** In-chat @Depth（配 depth + role） */
  AT_DEPTH: 4,
  /** Before Example Messages */
  EM_TOP: 5,
  /** After Example Messages */
  EM_BOTTOM: 6,
  /** Named outlet（配 outletName，不自动注入） */
  OUTLET: 7,
} as const

export type EntryPosition = (typeof WI_POSITION)[keyof typeof WI_POSITION]

/** 副键逻辑（world_info_logic）。 */
export const WI_LOGIC = {
  /** 任一副键命中即激活 */
  AND_ANY: 0,
  /** 任一副键未命中即激活 */
  NOT_ALL: 1,
  /** 全部副键未命中才激活 */
  NOT_ANY: 2,
  /** 全部副键命中才激活 */
  AND_ALL: 3,
} as const

export type SecondaryLogic = (typeof WI_LOGIC)[keyof typeof WI_LOGIC]

/** @Depth 消息角色（extension_prompt_roles）。 */
export const ENTRY_ROLE = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
} as const

export type EntryRole = (typeof ENTRY_ROLE)[keyof typeof ENTRY_ROLE]

/** 生成类型（GENERATION_TYPE_TRIGGERS，条目 triggers 过滤用）。 */
export const GENERATION_TRIGGERS = [
  'normal',
  'continue',
  'impersonate',
  'swipe',
  'regenerate',
  'quiet',
] as const

export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number]

/** 消息边界哨兵字符：ST 缓冲以 \x01 分隔消息，键以 \x01 开头 = 仅匹配消息起始（角色名匹配）。 */
export const MESSAGE_BOUNDARY = '\x01'

/** ST MAX_SCAN_DEPTH。 */
export const MAX_SCAN_DEPTH = 1000

/* ------------------------------ 条目输入 ------------------------------ */

/**
 * SillyTavern 原生 camelCase 世界书条目（字段与默认值对照 §2.2 / newWorldInfoEntryDefinition）。
 * 除 uid 外全部可省略；未知字段原样透传到结果。
 */
export interface LoreEntry {
  uid: number
  /** 主键；`/…/flags` 为正则键；`\x01` 前缀 = 仅匹配消息起始 */
  key?: string[]
  /** 副键（配 selective + selectiveLogic） */
  keysecondary?: string[]
  /** Memo，不进 prompt */
  comment?: string
  /** 激活后插入文本 */
  content?: string
  /** 蓝灯：无条件激活（预算内按 order 优先占位） */
  constant?: boolean
  /** 向量检索（本引擎不实现激活，仅透传） */
  vectorized?: boolean
  /** 是否启用副键逻辑（ST: 所有条目默认 selective） */
  selective?: boolean
  selectiveLogic?: SecondaryLogic
  addMemo?: boolean
  /** 插入顺序，越大越靠近上下文末端；候选按 order 降序竞争预算 */
  order?: number
  position?: EntryPosition
  disable?: boolean
  /** 不计入 token 预算 */
  ignoreBudget?: boolean
  /** 不可被递归激活 */
  excludeRecursion?: boolean
  /** 激活后内容不进入递归扫描缓冲 */
  preventRecursion?: boolean
  /** 仅递归第 N 层可激活（true = 1） */
  delayUntilRecursion?: number | boolean
  probability?: number
  useProbability?: boolean
  /** position=4 时的深度（0 = prompt 最底部） */
  depth?: number
  /** position=7 时的具名出口 */
  outletName?: string
  /** Inclusion Group（逗号分隔可属多组） */
  group?: string
  /** 组内优先胜出（按 order 降序取第一） */
  groupOverride?: boolean
  groupWeight?: number
  /** 组内按匹配键数计分取胜（null = 跟随全局） */
  useGroupScoring?: boolean | null
  /** 条目级扫描深度覆盖（null = 跟随书/全局） */
  scanDepth?: number | null
  caseSensitive?: boolean | null
  matchWholeWords?: boolean | null
  /** 与 Quick Reply 同 ID 触发 STscript（不实现，仅透传） */
  automationId?: string
  /** position=4 的消息角色 */
  role?: EntryRole
  /** 激活后保持 N 条消息（timed effects） */
  sticky?: number | null
  /** 激活后冷却 N 条消息 */
  cooldown?: number | null
  /** 聊天满 N 条消息前不可激活 */
  delay?: number | null
  /** 限定生成类型 */
  triggers?: GenerationTrigger[]
  /* 额外匹配源开关 */
  matchPersonaDescription?: boolean
  matchCharacterDescription?: boolean
  matchCharacterPersonality?: boolean
  matchCharacterDepthPrompt?: boolean
  matchScenario?: boolean
  matchCreatorNotes?: boolean
  /* 角色过滤（不实现过滤逻辑，仅透传） */
  characterFilterNames?: string[]
  characterFilterTags?: string[]
  characterFilterExclude?: boolean
  /** 未知字段透传 */
  [key: string]: unknown
}

/** 一本世界书（条目 + 书级扫描参数）。 */
export interface Lorebook {
  /** 书名（诊断标识；可省略） */
  name?: string
  entries: LoreEntry[]
  /** 书级扫描深度：条目 scanDepth 为 null 时的回退（ST 原生扫描无此层级，V2 character_book 扩展） */
  scanDepth?: number | null
  /** 书级 token 预算上限（V2 token_budget；0/null = 不限） */
  tokenBudget?: number | null
  /** 书级递归开关（V2 recursive_scanning；false = 本书条目不参与递归；默认 true） */
  recursiveScanning?: boolean
}

/** 聊天消息（最新在最后）。name 参与 `\x01` 角色名匹配与 includeNames 前缀。 */
export interface ChatMessage {
  name?: string
  content: string
  isUser?: boolean
  [key: string]: unknown
}

/** 条目级 match* 开关对应的额外扫描源（globalScanData）。 */
export interface ExtraScanSources {
  personaDescription?: string
  characterDescription?: string
  characterPersonality?: string
  characterDepthPrompt?: string
  scenario?: string
  creatorNotes?: string
}

/** 全局设置（ST world_info_* 模块默认值）。 */
export interface GlobalSettings {
  /** 扫描深度（最近 N 条消息），ST 默认 2 */
  scanDepth?: number
  /** 预算占上下文百分比，ST 默认 25 */
  budgetPercent?: number
  /** 预算绝对上限 token（0 = 不限），ST 默认 0 */
  budgetCap?: number
  /** 最大递归步数（0 = 不限；计数含初始轮），ST 默认 0 */
  maxRecursionSteps?: number
  /** 最少激活条数（不足则加深扫描重扫），ST 默认 0 */
  minActivations?: number
  /** min activations 加深的深度上限（0 = 不限），ST 默认 0 */
  minActivationsDepthMax?: number
  /** 全局递归开关，ST 默认 false */
  recursive?: boolean
  /** 全局大小写敏感，ST 默认 false */
  caseSensitive?: boolean
  /** 全局全词匹配，ST 默认 false */
  matchWholeWords?: boolean
  /** 全局 inclusion group 计分模式，ST 默认 false */
  useGroupScoring?: boolean
  /** 扫描时消息带 `名字: ` 前缀（world_info_include_names），ST 默认 true */
  includeNames?: boolean
}

/* ------------------------------ timed effects 状态 ------------------------------ */

/** 一条 sticky/cooldown 计时记录（chat_metadata.timedWorldInfo 语义）。 */
export interface TimedEffectRecord {
  /** 生效时的消息数 */
  start: number
  /** 失效消息数（start + N） */
  end: number
  /** 受保护记录在消息数未推进时不被清理（sticky 结束转 cooldown 时置位） */
  protected: boolean
}

/** 按 `book.uid` 全局键索引的 sticky/cooldown 状态。delay 不落盘（按消息数即时判定）。 */
export interface TimedEffectsState {
  sticky?: Record<string, TimedEffectRecord>
  cooldown?: Record<string, TimedEffectRecord>
}

/* ------------------------------ 输出 ------------------------------ */

/** 归一化条目（默认值已填充，未知字段原样保留）。 */
export type NormalizedEntry = Readonly<LoreEntry>

/** 激活原因。 */
export type ActivationReason =
  | 'constant'
  | 'sticky'
  | 'primary-key'
  | 'primary-and-secondary'
  | 'decorator'

/** 失败原因（诊断）。 */
export type SkipReason =
  | 'disabled'
  | 'trigger-filter'
  | 'delayed'
  | 'cooldown'
  | 'delay-until-recursion'
  | 'delay-until-recursion-level'
  | 'exclude-recursion'
  | 'exclude-recursion-book'
  | 'decorator-suppressed'
  | 'no-keys'
  | 'primary-key-no-match'
  | 'secondary-keys-not-satisfied'
  | 'probability'
  | 'budget'
  | 'budget-book'
  | 'group-sticky-loser'
  | 'group-score-loser'
  | 'group-loser'
  | 'group-cooldown'
  | 'group-delay'
  | 'already-activated'

/** 结果中的激活条目。 */
export interface ActivatedEntry {
  uid: number
  /** 来源书标识（name 或 #index） */
  book: string
  /** `book.uid` 全局标识 */
  entryId: string
  order: number
  position: EntryPosition
  depth: number
  role: EntryRole
  outletName: string
  /** 装配内容（decorator 剥离后；空内容条目不进组） */
  content: string
  /** 命中的主键 */
  matchedKeys: string[]
  activationReason: ActivationReason
  /** 归一化条目（含未知字段透传） */
  entry: NormalizedEntry
}

/** 同一插入位的内容组：entries 为最终插入序（order 升序），text 为 '\n' 拼接。 */
export interface EntryGroup {
  text: string
  entries: ActivatedEntry[]
}

/** @Depth 条目按 depth+role 聚合。 */
export interface DepthEntryGroup {
  depth: number
  role: EntryRole
  entries: ActivatedEntry[]
  text: string
}

/** 单条目诊断。 */
export interface EntryDiagnostics {
  activated: boolean
  /** 激活原因或最后一次跳过原因 */
  reason: ActivationReason | SkipReason
  /** 命中的主键（激活时） */
  matchedKeys?: string[]
  /** 概率掷值（参与掷骰时） */
  probabilityRoll?: number
}

export interface ActivationDiagnostics {
  /** 全局预算上限（token，含 cap 截断后） */
  budgetLimit: number
  /** 激活条目内容实际占用 token（估算口径） */
  budgetUsed: number
  /** 预算是否耗尽（含书级） */
  budgetExceeded: boolean
  /** 主循环总轮数（INITIAL + RECURSION + MIN_ACTIVATIONS） */
  scanRounds: number
  /** 其中 RECURSION 轮数 */
  recursionRounds: number
  /** min activations 加深的档位数 */
  scanSkew: number
  /** 按条目 entryId 索引 */
  entries: Record<string, EntryDiagnostics>
}

/** activateWorldInfo 的完整输出。 */
export interface ActivationResult {
  /** position 0：Before Char Defs */
  worldInfoBefore: EntryGroup
  /** position 1：After Char Defs */
  worldInfoAfter: EntryGroup
  /** position 5：Before Example Messages */
  beforeExamples: EntryGroup
  /** position 6：After Example Messages */
  afterExamples: EntryGroup
  /** position 2：Top of Author's Note */
  topOfAuthorsNote: EntryGroup
  /** position 3：Bottom of Author's Note */
  bottomOfAuthorsNote: EntryGroup
  /** position 4：@Depth 条目（按 depth+role 分组） */
  atDepth: DepthEntryGroup[]
  /** position 7：具名出口 → 组 */
  outlets: Record<string, EntryGroup>
  /** 全部激活条目（装配序：order 降序稳定序） */
  allActivated: ActivatedEntry[]
  diagnostics: ActivationDiagnostics
  /** 本代生成后的 timed effects 状态（供下代传入） */
  timedState: TimedEffectsState
}

/** activateWorldInfo 的完整输入。 */
export interface ActivationInput {
  books: Lorebook[]
  /** 聊天历史，最新在最后（引擎内部自行反转） */
  chat: ChatMessage[]
  /** 上下文 token 上限（预算 = budgetPercent%），默认 4096 */
  contextSize?: number
  /** 当前生成类型（triggers 过滤），默认 'normal' */
  trigger?: GenerationTrigger
  /** 额外扫描源（配条目 match* 开关） */
  scanSources?: ExtraScanSources
  settings?: GlobalSettings
  /** 上一代输出的 timedState（`book.uid` 全局键索引） */
  timedState?: TimedEffectsState
  /** 当前消息数（timed effects 基准），默认 chat.length */
  messageCount?: number
  /** 可注入随机源（概率/组权重），默认 Math.random */
  rng?: () => number
  /** 可注入 token 计数器，默认 Math.round(len / 3.5) 估算 */
  countTokens?: (text: string) => number
}
