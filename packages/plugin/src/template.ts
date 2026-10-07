/**
 * Prompt Template 生成链路接线（提案 0008，ST-Prompt-Template 功能复刻）。
 *
 * 职责：把 `@dsh-tavern/template` 运行时挂进 ST 兼容生成（runGeneration）——
 * 激活结果分区（特殊条目剔除）、InitialVariables、装配前文本预渲染（EJS → 宏）、
 * 装配后 GENERATE/@INJECT 消息注入、输出渲染与变量持久化。
 * 开关关闭时调用方跳过本模块（直通链路不变）。
 */

import {
  applyGenerateInjections,
  applyInjectEntries,
  applyRenderInjections,
  classifySpecialEntry,
  createTemplateRuntime,
  deepMerge,
  type SpecialEntry,
  type TemplateHost,
  type TemplateMessage,
  type TemplateRuntime,
} from '../../tavern-template/src/index.js'
import type { ActivatedEntry, ActivationResult, Lorebook, LoreEntry } from '../../tavern-lore/src/index.js'
import type { CharacterCardIR, ChatMessage, PresetIR } from '../../tavern-format/src/index.js'

const INITIAL_VARIABLES_KEY = 'initial_variables'

/** 激活结果分区：特殊条目按类别抽出，普通条目留在原通道。 */
export interface SpecialLorePartition {
  generate: SpecialEntry[]
  render: SpecialEntry[]
  inject: SpecialEntry[]
  /** InitialVariables 候选（活动书内未禁用条目）。 */
  initial: SpecialEntry[]
  normalBefore: ActivatedEntry[]
  normalAfter: ActivatedEntry[]
  normalBeforeExamples: ActivatedEntry[]
  normalAfterExamples: ActivatedEntry[]
  normalAtDepth: Array<{ depth: number; role: number; text: string }>
}

function toSpecialEntry(
  kind: SpecialEntry['kind'],
  arg: string | undefined,
  content: string,
  ifCondition: string | undefined,
  source: { book: string; uid: number; comment?: string; order?: number; probability?: number; useProbability?: boolean },
): SpecialEntry {
  const entry: SpecialEntry = {
    kind,
    book: source.book,
    uid: source.uid,
    comment: source.comment ?? '',
    content,
    order: source.order ?? 100,
    ...(source.probability !== undefined ? { probability: source.probability } : {}),
    ...(source.useProbability !== undefined ? { useProbability: source.useProbability } : {}),
  }
  if (arg !== undefined) entry.arg = arg
  if (ifCondition !== undefined) entry.ifCondition = ifCondition
  return entry
}

function classifyRawEntry(raw: { comment?: string; content?: string }): {
  kind: SpecialEntry['kind']
  arg?: string
  content: string
  ifCondition?: string
} | null {
  if ((raw.comment ?? '') === '' && (raw.content ?? '') === '') return null
  return classifySpecialEntry({ comment: raw.comment, content: raw.content ?? '' })
}

/**
 * 分区：激活条目中的 GENERATE/RENDER 条目抽走（activation 语义保留）；
 * 全量书条目中的 @INJECT（无视激活）与 [InitialVariables]（未禁用）抽走；
 * 特殊条目从普通通道（before/after/examples/atDepth）剔除。
 */
export function partitionSpecialLore(lore: ActivationResult, books: Lorebook[]): SpecialLorePartition {
  const generate: SpecialEntry[] = []
  const render: SpecialEntry[] = []
  const inject: SpecialEntry[] = []
  const seenInject = new Set<string>()

  // 激活条目：GENERATE/RENDER/@INJECT 分类 + 通道剔除
  const isSpecial = new Set<string>()
  for (const activated of lore.allActivated) {
    const raw = activated.entry
    const classified = classifyRawEntry({ comment: raw.comment, content: raw.content })
    if (classified === null) continue
    isSpecial.add(activated.entryId)
    const source = {
      book: activated.book,
      uid: activated.uid,
      comment: raw.comment,
      order: typeof raw.order === 'number' ? raw.order : activated.order,
      probability: typeof raw.probability === 'number' ? raw.probability : undefined,
      useProbability: raw.useProbability === true ? true : undefined,
    }
    const special = toSpecialEntry(classified.kind, classified.arg, classified.content, classified.ifCondition, source)
    if (classified.kind === 'inject') {
      if (!seenInject.has(`${activated.book}#${activated.uid}`)) {
        seenInject.add(`${activated.book}#${activated.uid}`)
        inject.push(special)
      }
    } else if (classified.kind.startsWith('render')) {
      render.push(special)
    } else if (classified.kind !== 'initial') {
      generate.push(special)
    }
  }

  // 全量书条目：@INJECT（无论启停，绕过激活）与 InitialVariables（未禁用）
  const initial: SpecialEntry[] = []
  for (const book of books) {
    for (const raw of book.entries) {
      const classified = classifyRawEntry({ comment: raw.comment, content: raw.content })
      if (classified === null) continue
      if (classified.kind === 'inject' && !seenInject.has(`${book.name ?? ''}#${raw.uid}`)) {
        seenInject.add(`${book.name ?? ''}#${raw.uid}`)
        inject.push(toSpecialEntry('inject', classified.arg, classified.content, classified.ifCondition, {
          book: book.name ?? '',
          uid: raw.uid,
          comment: raw.comment,
          order: typeof raw.order === 'number' ? raw.order : 100,
          probability: typeof raw.probability === 'number' ? raw.probability : undefined,
          useProbability: raw.useProbability === true ? true : undefined,
        }))
        continue
      }
      if (classified.kind === 'initial' && raw.disable !== true) {
        initial.push(toSpecialEntry('initial', undefined, classified.content, classified.ifCondition, {
          book: book.name ?? '',
          uid: raw.uid,
          comment: raw.comment,
          order: typeof raw.order === 'number' ? raw.order : 100,
        }))
      }
    }
  }

  const normal = (entries: ActivatedEntry[]): ActivatedEntry[] => entries.filter((e) => !isSpecial.has(e.entryId))
  const joinText = (entries: ActivatedEntry[]): string =>
    entries.map((e) => e.content).filter((text) => text.length > 0).join('\n')

  return {
    generate,
    render,
    inject,
    initial,
    normalBefore: normal(lore.worldInfoBefore.entries),
    normalAfter: normal(lore.worldInfoAfter.entries),
    normalBeforeExamples: normal(lore.beforeExamples.entries),
    normalAfterExamples: normal(lore.afterExamples.entries),
    normalAtDepth: lore.atDepth
      .map((group) => {
        const entries = group.entries.filter((e) => !isSpecial.has(e.entryId))
        return { depth: group.depth, role: group.role, text: joinText(entries) }
      })
      .filter((group) => group.text !== ''),
  }
}

export interface GenerationTemplateOptions {
  /** 聊天对象（live 引用：local/initial 变量写穿 chat_metadata）。 */
  chat: { header: { chat_metadata: Record<string, unknown> } }
  /** 状态对象（live 引用：global 写穿 scriptGlobals）。 */
  state: { scriptGlobals: Record<string, string | number | boolean> }
  books: Lorebook[]
  lore: ActivationResult
  card: CharacterCardIR
  preset: PresetIR
  turnMessages: ChatMessage[]
  userName: string
  characterName: string
  chatId: string
  model?: string
  onWarning?: (message: string) => void
}

export interface GenerationTemplates {
  runtime: TemplateRuntime
  partition: SpecialLorePartition
  warnings: string[]
  /** 渲染文本；失败告警并返回原文（不中断生成）。 */
  renderText: (text: string, where?: string) => Promise<string>
  /** 模型选择确定后回填 env 常量。 */
  setModel: (model: string) => void
  /** 卡字段预渲染（description/personality/scenario/systemPrompt/postHistoryInstructions/mesExample）。 */
  preRenderCard: (card: CharacterCardIR) => Promise<CharacterCardIR>
  /** 预设 content 条目预渲染（marker 条目不动）。 */
  preRenderPreset: (preset: PresetIR) => Promise<PresetIR>
  /** GENERATE:AFTER 预渲染（须在全部字段渲染之后调用：其内容位于 prompt 末尾）。 */
  prerenderGenerateAfter: () => Promise<void>
  /** 装配后消息注入（GENERATE → @INJECT）。 */
  applyPromptInjections: (messages: TemplateMessage[]) => Promise<TemplateMessage[]>
  /** 输出渲染（runType='render'）+ RENDER 前后缀。 */
  renderOutput: (text: string) => Promise<string>
}

function ensureMetadataObject(metadata: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = metadata[key]
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) return existing as Record<string, unknown>
  const created: Record<string, unknown> = {}
  metadata[key] = created
  return created
}

export async function createGenerationTemplates(options: GenerationTemplateOptions): Promise<GenerationTemplates> {
  const { chat, state, books, lore, card, preset, turnMessages, userName, characterName, chatId, model } = options
  const warnings: string[] = []
  const warn = (message: string) => {
    warnings.push(message)
    options.onWarning?.(message)
  }

  const partition = partitionSpecialLore(lore, books)

  const localVars = ensureMetadataObject(chat.header.chat_metadata, 'variables')
  const initialVars = ensureMetadataObject(chat.header.chat_metadata, INITIAL_VARIABLES_KEY)

  const cardName = card.data.nickname || card.data.name
  const lastUserIdx = (() => {
    for (let i = turnMessages.length - 1; i >= 0; i--) if (turnMessages[i]!.is_user) return i
    return -1
  })()
  const lastCharIdx = (() => {
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const m = turnMessages[i]!
      if (!m.is_user && !m.is_system) return i
    }
    return -1
  })()

  const host: TemplateHost = {
    runType: 'generate',
    userName,
    charName: cardName,
    chatId,
    characterId: characterName,
    model,
    charAvatar: typeof card.data.extensions['avatar'] === 'string' ? card.data.extensions['avatar'] as string : '',
    messages: turnMessages.map((m) => ({ name: m.name, mes: m.mes, is_user: m.is_user, is_system: m.is_system })),
    lastUserMessageId: lastUserIdx,
    lastCharMessageId: lastCharIdx,
    findWorldEntries: (title, book) => {
      const out: Array<{ uid: number; book: string; comment?: string; content: string; order?: number; disable?: boolean }> = []
      for (const lorebook of books) {
        if (book !== undefined && lorebook.name !== book) continue
        for (const entry of lorebook.entries as LoreEntry[]) {
          const comment = entry.comment ?? ''
          const matched = typeof title === 'number' ? entry.uid === title : comment === title
          if (!matched) continue
          out.push({
            uid: entry.uid,
            book: lorebook.name ?? '',
            comment,
            content: entry.content ?? '',
            ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
            disable: entry.disable === true,
          })
        }
      }
      return out
    },
    getCard: (name) => {
      if (name !== undefined && name !== characterName && name !== cardName) return null
        const depthPrompt = card.data.extensions['depth_prompt']
        return {
          name: cardName,
          systemPrompt: card.data.systemPrompt,
          personality: card.data.personality,
          description: card.data.description,
          scenario: card.data.scenario,
          firstMes: card.data.firstMes,
          mesExample: card.data.mesExample,
          creatorNotes: card.data.creatorNotes,
          depthPrompt: depthPrompt !== null && typeof depthPrompt === 'object'
            ? String((depthPrompt as { prompt?: unknown }).prompt ?? '')
            : '',
          data: card.data as unknown as Record<string, unknown>,
        }
    },
    findPresetPrompt: (name) => {
      for (const prompt of preset.prompts) {
        if ('marker' in prompt && prompt.marker) continue
        if (prompt.name === name) return { name: prompt.name, content: prompt.content ?? '' }
      }
      return null
    },
    renderNested: async () => '',
  }

  const runtime = createTemplateRuntime({
    host,
    stores: {
      local: localVars as unknown as Parameters<typeof createTemplateRuntime>[0]['stores']['local'],
      global: state.scriptGlobals,
      initial: initialVars as unknown as Parameters<typeof createTemplateRuntime>[0]['stores']['initial'],
    },
    onWarning: warn,
  })
  host.renderNested = (source, extra) => runtime.renderText(source, extra)

  const renderText = async (text: string, where?: string): Promise<string> => {
    try {
      return await runtime.renderText(text, undefined, where)
    } catch (err) {
      warn(`template render failed${where ? ` (${where})` : ''}: ${err instanceof Error ? err.message : String(err)} — keeping original text`)
      return text
    }
  }

  // InitialVariables：逐条渲染 → JSON/YAML 解析 → 汇总后一次性重置 initial 并重建视图
  // （须先于 GENERATE:BEFORE 预渲染，对齐 ST 顺序渲染的变量可见性）
  if (partition.initial.length > 0) {
    const initialData: Record<string, unknown> = {}
    for (const entry of partition.initial) {
      const rendered = await renderText(entry.content, `initial-variables ${entry.book}#${entry.uid}`)
      const parsed = runtime.parseInitialVariables(rendered)
      if (parsed) deepMerge(initialData as never, parsed as never)
    }
    runtime.setInitialVariables(initialData)
  }

  // GENERATE:BEFORER 预渲染：其内容在最终 prompt 最前部，先于卡/预设/历史字段
  // 执行（对齐 ST 顺序渲染的变量副作用次序）
  const prerenderGenerate = async (kinds: Array<SpecialEntry['kind']>): Promise<void> => {
    const ordered = partition.generate
      .filter((entry) => kinds.includes(entry.kind))
      .sort((a, b) => a.order - b.order || a.uid - b.uid)
    for (const entry of ordered) {
      entry.renderedContent = await renderText(entry.content, `generate ${entry.book}#${entry.uid}`)
    }
  }
  await prerenderGenerate(['generate-before'])

  const preRenderCard = async (input: CharacterCardIR): Promise<CharacterCardIR> => {
    const data = input.data
    return {
      ...input,
      data: {
        ...data,
        description: await renderText(data.description, 'card.description'),
        personality: await renderText(data.personality, 'card.personality'),
        scenario: await renderText(data.scenario, 'card.scenario'),
        systemPrompt: await renderText(data.systemPrompt, 'card.systemPrompt'),
        postHistoryInstructions: await renderText(data.postHistoryInstructions, 'card.postHistoryInstructions'),
        mesExample: await renderText(data.mesExample, 'card.mesExample'),
      },
    }
  }

  const preRenderPreset = async (input: PresetIR): Promise<PresetIR> => ({
    ...input,
    prompts: await Promise.all(input.prompts.map(async (prompt) => {
      if ('marker' in prompt && prompt.marker) return prompt
      const content = prompt.content ?? ''
      return { ...prompt, content: await renderText(content, `preset.${prompt.name}`) }
    })),
  })

  const applyPromptInjections = async (messages: TemplateMessage[]): Promise<TemplateMessage[]> => {
    let out = await runtime.applyGenerateInjections(messages, partition.generate)
    out = await runtime.applyInjectEntries(out, partition.inject)
    return out
  }

  const renderOutput = async (text: string): Promise<string> => {
    host.runType = 'render'
    try {
      const rendered = await renderText(text, 'llm-output')
      return await runtime.applyRenderInjections(rendered, partition.render)
    } finally {
      host.runType = 'generate'
    }
  }

  return {
    runtime,
    partition,
    warnings,
    renderText,
    setModel: (model: string) => {
      host.model = model
    },
    preRenderCard,
    preRenderPreset,
    prerenderGenerateAfter: () => prerenderGenerate(['generate-after']),
    applyPromptInjections,
    renderOutput,
  }
}

/**
 * 变量持久化：模板 local 写穿 chat_metadata.variables（live），宏快照（原语）
 * 后写覆盖同名键；空树删除键保持 JSONL 干净。
 */
export function mergeTemplateLocalVars(
  chat: { header: { chat_metadata: Record<string, unknown> } },
  macroLocalSnapshot: Record<string, string | number | boolean>,
): void {
  const metadata = chat.header.chat_metadata
  const existing = metadata['variables']
  const merged: Record<string, unknown> =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {}
  for (const [key, value] of Object.entries(macroLocalSnapshot)) merged[key] = value
  if (Object.keys(merged).length > 0) metadata['variables'] = merged
  else delete metadata['variables']
  if (Object.keys(ensureMetadataObject(metadata, INITIAL_VARIABLES_KEY)).length === 0) {
    delete metadata[INITIAL_VARIABLES_KEY]
  }
}
