/**
 * 扫描缓冲，语义对照 ST world-info.js `WorldInfoBuffer`：
 * - depthBuffer：最近消息在前（调用方反转），以 `\x01` 分隔拼接；
 * - get()：条目深度 + 额外扫描源 + 递归缓冲（MIN_ACTIVATIONS 轮不含递归缓冲）；
 * - matchKeys()：正则键覆盖一切选项，否则大小写归一 + 全词边界匹配；
 * - getScore()：inclusion group 计分（主键命中数 + AND_ANY/AND_ALL 副键加成）。
 */

import type { ExtraScanSources } from './types.js'
import { MESSAGE_BOUNDARY, MAX_SCAN_DEPTH, WI_LOGIC } from './types.js'
import type { ScanEntry } from './entry.js'
import { escapeRegex, parseRegexFromString } from './regex.js'

export type ScanState = 'INITIAL' | 'RECURSION' | 'MIN_ACTIVATIONS' | 'NONE'

const JOINER = '\n' + MESSAGE_BOUNDARY

export interface BufferGlobals {
  scanDepth: number
  caseSensitive: boolean
  matchWholeWords: boolean
}

export class ScanBuffer {
  private readonly depthBuffer: readonly string[]
  private readonly sources: ExtraScanSources
  private readonly globals: BufferGlobals
  private readonly recurseBuffer: string[] = []

  constructor(messages: readonly string[], sources: ExtraScanSources, globals: BufferGlobals) {
    // MAX_SCAN_DEPTH 截断（verified vs WorldInfoBuffer.#initDepthBuffer）
    this.depthBuffer = messages.slice(0, MAX_SCAN_DEPTH)
    this.sources = sources
    this.globals = globals
  }

  addRecurse(message: string): void {
    this.recurseBuffer.push(message)
  }

  hasRecurse(): boolean {
    return this.recurseBuffer.length > 0
  }

  /** min activations 加深扫描窗口。 */
  advanceScan(): void {
    this.globalsSkew++
  }

  private globalsSkew = 0

  /** 全局深度 + 偏移。 */
  getDepth(): number {
    return this.globals.scanDepth + this.globalsSkew
  }

  getSkew(): number {
    return this.globalsSkew
  }

  /**
   * 取条目可扫描的文本（verified vs WorldInfoBuffer.get）：
   * `\x01` + 深度窗口内消息以 `\n\x01` 拼接 + match* 额外源 + 递归缓冲
   * （MIN_ACTIVATIONS 轮不含递归缓冲——min activations 只看聊天本身）。
   */
  get(entry: ScanEntry, scanState: ScanState): string {
    let depth = entry.scanDepth ?? this.getDepth()
    if (depth <= 0) return ''
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH

    let result = MESSAGE_BOUNDARY + this.depthBuffer.slice(0, depth).join(JOINER)

    if (entry.matchPersonaDescription && this.sources.personaDescription) {
      result += JOINER + this.sources.personaDescription
    }
    if (entry.matchCharacterDescription && this.sources.characterDescription) {
      result += JOINER + this.sources.characterDescription
    }
    if (entry.matchCharacterPersonality && this.sources.characterPersonality) {
      result += JOINER + this.sources.characterPersonality
    }
    if (entry.matchCharacterDepthPrompt && this.sources.characterDepthPrompt) {
      result += JOINER + this.sources.characterDepthPrompt
    }
    if (entry.matchScenario && this.sources.scenario) {
      result += JOINER + this.sources.scenario
    }
    if (entry.matchCreatorNotes && this.sources.creatorNotes) {
      result += JOINER + this.sources.creatorNotes
    }

    if (this.recurseBuffer.length > 0 && scanState !== 'MIN_ACTIVATIONS') {
      result += JOINER + this.recurseBuffer.join(JOINER)
    }
    return result
  }

  private transformString(str: string, entry: ScanEntry): string {
    const caseSensitive = entry.caseSensitive ?? this.globals.caseSensitive
    return caseSensitive ? str : str.toLowerCase()
  }

  /**
   * 键匹配（verified vs WorldInfoBuffer.matchKeys）：
   * 1) `/…/flags` 正则键 → regex.test，覆盖大小写/全词设置；
   * 2) 大小写归一后：matchWholeWords 且键为单词 → `(?:^|\W)(key)(?:$|\W)` 边界匹配
   *    （JS \W 非 ASCII 字母数字下划线，CJK 字符属 \W，故中文键等效子串、不被破坏）；
   *    多词键直接 includes；
   * 3) 其余 includes。
   */
  matchKeys(haystack: string, needle: string, entry: ScanEntry): boolean {
    const keyRegex = parseRegexFromString(needle)
    if (keyRegex) return keyRegex.test(haystack)

    const hay = this.transformString(haystack, entry)
    const transformed = this.transformString(needle, entry)
    const matchWholeWords = entry.matchWholeWords ?? this.globals.matchWholeWords

    if (matchWholeWords) {
      const keyWords = transformed.split(/\s+/)
      if (keyWords.length > 1) return hay.includes(transformed)
      const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformed)})(?:$|\\W)`)
      return regex.test(hay)
    }
    return hay.includes(transformed)
  }

  /**
   * 组计分（verified vs WorldInfoBuffer.getScore）：主键命中数为主；
   * AND_ANY 加副键命中数；AND_ALL 全命中时加副键数，否则仅主键；
   * 无主键得 0 分。
   */
  getScore(entry: ScanEntry, scanState: ScanState): number {
    const bufferState = this.get(entry, scanState)
    let primaryScore = 0
    let secondaryScore = 0

    // 注：ST 不 trim、空串键 includes('') 恒真计 1 分——按原样镜像（verified vs getScore）
    for (const key of entry.key) {
      if (this.matchKeys(bufferState, key, entry)) primaryScore++
    }
    const numberOfSecondaryKeys = entry.keysecondary.length
    for (const key of entry.keysecondary) {
      if (this.matchKeys(bufferState, key, entry)) secondaryScore++
    }

    if (entry.key.length === 0) return 0
    if (numberOfSecondaryKeys > 0) {
      if (entry.selectiveLogic === WI_LOGIC.AND_ANY) return primaryScore + secondaryScore
      if (entry.selectiveLogic === WI_LOGIC.AND_ALL) {
        return secondaryScore === numberOfSecondaryKeys
          ? primaryScore + secondaryScore
          : primaryScore
      }
    }
    return primaryScore
  }
}
