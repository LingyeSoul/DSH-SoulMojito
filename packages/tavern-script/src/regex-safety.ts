/**
 * Conservative pre-execution safety gate for card-authored regex scripts.
 *
 * JavaScript RegExp is a synchronous backtracking engine, so a pathological
 * pattern can block the event loop before any timer or AbortSignal can fire.
 * This module rejects structural shapes that are known to cause catastrophic
 * or super-linear backtracking. It is a heuristic gate, not a formal ReDoS
 * proof; callers must also cap the input length.
 */

/** Patterns longer than this are rejected before parsing. */
export const MAX_SCRIPT_REGEX_PATTERN_LENGTH = 100_000

/** Repeating a group this many times (or unbounded) can amplify ambiguity. */
const REPEAT_HAZARD_MAX = 10

/** Guards the recursive parser against hostile nesting. */
const MAX_REGEX_NESTING_DEPTH = 100

/** Above this, alternation pairs are not checked individually. */
const MAX_PAIRWISE_ALTERNATION_BRANCHES = 64

/** Coarser character sets are represented as "any" to keep analysis linear. */
const MAX_CHARSET_RANGES = 1024

export type RegexSafetyReason =
  | 'pattern-too-long'
  | 'nesting-too-deep'
  | 'nested-quantifier'
  | 'ambiguous-alternation'
  | 'overlapping-repeat'
  | 'nullable-repeat'
  | 'backreference-repeat'
  | 'unparsable-pattern'

export type RegexSafetyVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: RegexSafetyReason; readonly detail: string }

type CharRange = readonly [start: number, end: number]

type CharSet =
  | { readonly kind: 'any' }
  | { readonly kind: 'ranges'; readonly ranges: readonly CharRange[] }

interface RegexNode {
  readonly minLength: number
  readonly maxLength: number
  readonly nullable: boolean
  readonly first: CharSet | null
  readonly literalPrefix: string | null
  readonly hasQuantifier: boolean
  readonly hasBackreference: boolean
  readonly hasAmbiguousAlternation: boolean
  /** True when this node itself is quantified with an unbounded maximum. */
  readonly unboundedRepeat: boolean
}

interface ParseState {
  readonly source: string
  index: number
  caseInsensitive: boolean
}

const ANY_CHAR: CharSet = { kind: 'any' }
const DIGIT_RANGES: readonly CharRange[] = [[48, 57]]
const WORD_RANGES: readonly CharRange[] = [[48, 57], [65, 90], [95, 95], [97, 122]]
// ECMAScript WhiteSpace + LineTerminator. Kept exact so disjointness proofs
// against other classes stay sound.
const WHITESPACE_RANGES: readonly CharRange[] = [
  [9, 13],
  [32, 32],
  [160, 160],
  [5760, 5760],
  [8192, 8202],
  [8232, 8233],
  [8239, 8239],
  [8287, 8287],
  [12288, 12288],
  [65279, 65279],
]

function unsafeError(reason: RegexSafetyReason, detail: string): never {
  throw Object.assign(new Error(detail), { reason })
}

function isUnsafeError(value: unknown): value is Error & { readonly reason: RegexSafetyReason } {
  return value instanceof Error && typeof (value as { reason?: unknown }).reason === 'string'
}

function mergeRanges(ranges: readonly CharRange[]): readonly CharRange[] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  const merged: CharRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range[0] <= last[1] + 1) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], range[1])]
    } else {
      merged.push(range)
    }
  }
  return merged
}

function rangesSet(ranges: readonly CharRange[]): CharSet {
  const merged = mergeRanges(ranges)
  if (merged.length > MAX_CHARSET_RANGES) return ANY_CHAR
  return { kind: 'ranges', ranges: merged }
}

function rangesIntersect(left: readonly CharRange[], right: readonly CharRange[]): boolean {
  return left.some((a) => right.some((b) => a[0] <= b[1] && b[0] <= a[1]))
}

function firstSetsOverlap(left: CharSet | null, right: CharSet | null): boolean {
  if (left === null || right === null) return false
  if (left.kind === 'any' || right.kind === 'any') return true
  return rangesIntersect(left.ranges, right.ranges)
}

function repeatsOverlap(left: CharSet | null, right: CharSet | null): boolean {
  if (left === null || right === null) return false
  if (left.kind === 'any' || right.kind === 'any') {
    // A wildcard repeated next to a narrower unbounded repeat is left alone:
    // `.*\s+` is common and usually scans forward. Two wildcards (`.*.*`) or
    // two overlapping concrete classes are the dangerous adjacent shapes.
    return left.kind === 'any' && right.kind === 'any'
  }
  return rangesIntersect(left.ranges, right.ranges)
}

function addLength(left: number, right: number): number {
  if (left === Infinity || right === Infinity) return Infinity
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function multiplyLength(length: number, factor: number): number {
  if (length === 0 || factor === 0) return 0
  if (length === Infinity || factor === Infinity) return Infinity
  return Math.min(Number.MAX_SAFE_INTEGER, length * factor)
}

function zeroWidthNode(): RegexNode {
  return {
    minLength: 0,
    maxLength: 0,
    nullable: true,
    first: null,
    literalPrefix: '',
    hasQuantifier: false,
    hasBackreference: false,
    hasAmbiguousAlternation: false,
    unboundedRepeat: false,
  }
}

function backreferenceNode(): RegexNode {
  return {
    minLength: 0,
    maxLength: Infinity,
    nullable: true,
    first: ANY_CHAR,
    literalPrefix: null,
    hasQuantifier: false,
    hasBackreference: true,
    hasAmbiguousAlternation: false,
    unboundedRepeat: false,
  }
}

function literalFirstSet(value: string, caseInsensitive: boolean): CharSet {
  const codePoint = value.codePointAt(0)
  if (codePoint === undefined || codePoint > 0xffff) return ANY_CHAR
  if (!caseInsensitive) return rangesSet([[codePoint, codePoint]])
  if (codePoint > 0x7f) return ANY_CHAR
  const ranges: CharRange[] = [[codePoint, codePoint]]
  if (codePoint >= 65 && codePoint <= 90) ranges.push([codePoint + 32, codePoint + 32])
  if (codePoint >= 97 && codePoint <= 122) ranges.push([codePoint - 32, codePoint - 32])
  return rangesSet(ranges)
}

function literalNode(value: string, caseInsensitive: boolean): RegexNode {
  return {
    minLength: value.length,
    maxLength: value.length,
    nullable: value.length === 0,
    first: value.length === 0 ? null : literalFirstSet(value, caseInsensitive),
    literalPrefix: caseInsensitive || value.length === 0 ? null : value,
    hasQuantifier: false,
    hasBackreference: false,
    hasAmbiguousAlternation: false,
    unboundedRepeat: false,
  }
}

function charClassNode(first: CharSet): RegexNode {
  return {
    minLength: 1,
    maxLength: 1,
    nullable: false,
    first,
    literalPrefix: null,
    hasQuantifier: false,
    hasBackreference: false,
    hasAmbiguousAlternation: false,
    unboundedRepeat: false,
  }
}

function commonLiteralPrefix(branches: readonly RegexNode[]): string | null {
  const first = branches[0]
  if (first === undefined || first.literalPrefix === null) return null
  let prefix = first.literalPrefix
  for (const branch of branches.slice(1)) {
    if (branch.literalPrefix === null) return null
    let shared = 0
    const limit = Math.min(prefix.length, branch.literalPrefix.length)
    while (shared < limit && prefix[shared] === branch.literalPrefix[shared]) shared += 1
    prefix = prefix.slice(0, shared)
    if (prefix === '') return ''
  }
  return prefix
}

function branchesOverlap(left: RegexNode, right: RegexNode): boolean {
  if (left.maxLength === 0 || right.maxLength === 0) return true
  const leftPrefix = left.literalPrefix
  const rightPrefix = right.literalPrefix
  if (leftPrefix !== null && rightPrefix !== null) {
    const limit = Math.min(leftPrefix.length, rightPrefix.length)
    for (let index = 0; index < limit; index += 1) {
      if (leftPrefix[index] !== rightPrefix[index]) return false
    }
    // Same literal prefix (or one is a prefix of the other) can match a
    // common string, so repetition has more than one way to split the input.
    return true
  }
  if (left.first === null || right.first === null) return true
  return firstSetsOverlap(left.first, right.first)
}

function makeAlternation(branches: readonly RegexNode[]): RegexNode {
  if (branches.length === 1) return branches[0]!
  let nullable = false
  let hasQuantifier = false
  let hasBackreference = false
  let hasAmbiguousAlternation = false
  let minLength = Infinity
  let maxLength = 0
  const consumingFirsts: CharSet[] = []
  for (const branch of branches) {
    nullable = nullable || branch.nullable
    hasQuantifier = hasQuantifier || branch.hasQuantifier
    hasBackreference = hasBackreference || branch.hasBackreference
    hasAmbiguousAlternation = hasAmbiguousAlternation || branch.hasAmbiguousAlternation
    minLength = Math.min(minLength, branch.minLength)
    maxLength = branch.maxLength === Infinity ? Infinity : Math.max(maxLength, branch.maxLength)
    if (branch.maxLength > 0 && branch.first !== null) consumingFirsts.push(branch.first)
  }
  let ambiguous = hasAmbiguousAlternation || nullable
  if (!ambiguous && branches.length > MAX_PAIRWISE_ALTERNATION_BRANCHES) {
    // Too many alternatives to verify cheaply; treat as ambiguous so an
    // outer repetition is rejected without spending quadratic analysis time.
    ambiguous = true
  }
  if (!ambiguous) {
    for (let left = 0; left < branches.length && !ambiguous; left += 1) {
      for (let right = left + 1; right < branches.length; right += 1) {
        if (branchesOverlap(branches[left]!, branches[right]!)) {
          ambiguous = true
          break
        }
      }
    }
  }
  let first: CharSet | null
  if (consumingFirsts.length === 0) {
    first = null
  } else if (consumingFirsts.some((entry) => entry.kind === 'any')) {
    first = ANY_CHAR
  } else {
    const ranges = consumingFirsts.flatMap((entry) => entry.kind === 'ranges' ? entry.ranges : [])
    first = rangesSet(ranges)
  }
  return {
    minLength: minLength === Infinity ? 0 : minLength,
    maxLength,
    nullable,
    first,
    literalPrefix: commonLiteralPrefix(branches),
    hasQuantifier,
    hasBackreference,
    hasAmbiguousAlternation: ambiguous,
    unboundedRepeat: false,
  }
}

function makeSequence(atoms: readonly RegexNode[]): RegexNode {
  let minLength = 0
  let maxLength = 0
  let nullable = true
  let hasQuantifier = false
  let hasBackreference = false
  let hasAmbiguousAlternation = false
  let first: CharSet | null = null
  let literalPrefix: string | null = ''
  let previousRepeat: RegexNode | null = null

  for (const atom of atoms) {
    minLength = addLength(minLength, atom.minLength)
    maxLength = addLength(maxLength, atom.maxLength)
    nullable = nullable && atom.nullable
    hasQuantifier = hasQuantifier || atom.hasQuantifier
    hasBackreference = hasBackreference || atom.hasBackreference
    hasAmbiguousAlternation = hasAmbiguousAlternation || atom.hasAmbiguousAlternation

    if (atom.maxLength > 0) {
      if (first === null) first = atom.first ?? ANY_CHAR
      if (previousRepeat !== null && previousRepeat.unboundedRepeat && atom.unboundedRepeat) {
        if (repeatsOverlap(previousRepeat.first, atom.first)) {
          unsafeError(
            'overlapping-repeat',
            'adjacent unbounded quantifiers can consume the same characters',
          )
        }
      }
      previousRepeat = atom
    }

    if (literalPrefix === null) continue
    if (atom.maxLength === 0) continue
    if (atom.literalPrefix === null) {
      literalPrefix = null
      continue
    }
    literalPrefix += atom.literalPrefix
    if (atom.minLength !== atom.maxLength || atom.maxLength !== atom.literalPrefix.length) break
  }

  return {
    minLength,
    maxLength,
    nullable,
    first,
    literalPrefix,
    hasQuantifier,
    hasBackreference,
    hasAmbiguousAlternation,
    unboundedRepeat: false,
  }
}

function quantify(body: RegexNode, min: number, max: number): RegexNode {
  const repeatsEnough = max === Infinity || max >= REPEAT_HAZARD_MAX
  if (repeatsEnough && body.hasQuantifier) {
    unsafeError('nested-quantifier', 'a repeated group contains another quantifier')
  }
  if (repeatsEnough && body.hasAmbiguousAlternation) {
    unsafeError('ambiguous-alternation', 'a repeated group has overlapping alternatives')
  }
  if (max === Infinity && body.nullable) {
    unsafeError('nullable-repeat', 'an unbounded quantifier can repeat an empty match')
  }
  if (max === Infinity && body.hasBackreference) {
    unsafeError('backreference-repeat', 'an unbounded quantifier repeats a backreference')
  }
  return {
    minLength: multiplyLength(body.minLength, min),
    maxLength: multiplyLength(body.maxLength, max),
    nullable: min === 0 || body.nullable,
    first: body.first,
    literalPrefix: min > 0 ? body.literalPrefix : null,
    hasQuantifier: true,
    hasBackreference: body.hasBackreference,
    hasAmbiguousAlternation: body.hasAmbiguousAlternation,
    unboundedRepeat: max === Infinity,
  }
}

function peek(state: ParseState): string | undefined {
  return state.source[state.index]
}

function parseAlternation(state: ParseState, depth: number): RegexNode {
  const branches = [parseSequence(state, depth)]
  while (peek(state) === '|') {
    state.index += 1
    branches.push(parseSequence(state, depth))
  }
  return makeAlternation(branches)
}

function parseSequence(state: ParseState, depth: number): RegexNode {
  const atoms: RegexNode[] = []
  for (;;) {
    const next = peek(state)
    if (next === undefined || next === '|' || next === ')') break
    const atom = parseAtom(state, depth)
    atoms.push(parseQuantifier(state, atom))
  }
  return makeSequence(atoms)
}

function parseAtom(state: ParseState, depth: number): RegexNode {
  const char = peek(state)
  if (char === undefined) throw new Error('unexpected end of pattern')
  if (char === '^' || char === '$') {
    state.index += 1
    return zeroWidthNode()
  }
  if (char === '\\') return parseEscape(state)
  if (char === '[') return parseCharacterClass(state)
  if (char === '.') {
    state.index += 1
    return charClassNode(ANY_CHAR)
  }
  if (char === '(') return parseGroup(state, depth)
  if (char === '*' || char === '+' || char === '?') {
    throw new Error('quantifier without a preceding atom')
  }
  state.index += 1
  return literalNode(char, state.caseInsensitive)
}

function parseQuantifier(state: ParseState, atom: RegexNode): RegexNode {
  const char = peek(state)
  let min: number
  let max: number
  if (char === '*') {
    min = 0
    max = Infinity
    state.index += 1
  } else if (char === '+') {
    min = 1
    max = Infinity
    state.index += 1
  } else if (char === '?') {
    min = 0
    max = 1
    state.index += 1
  } else if (char === '{') {
    const match = /^\{(\d+)(?:,(\d*))?\}/.exec(state.source.slice(state.index))
    if (match === null) return atom
    min = Number(match[1])
    max = match[2] === undefined
      ? min
      : match[2] === ''
        ? Infinity
        : Number(match[2])
    state.index += match[0].length
  } else {
    return atom
  }
  if (peek(state) === '?') state.index += 1
  return quantify(atom, min, max)
}

function isHex(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-fA-F]$/.test(value)
}

function parseHexEscape(state: ParseState, digits: number): string | null {
  let value = ''
  for (let count = 0; count < digits; count += 1) {
    const char = peek(state)
    if (!isHex(char)) return null
    value += char
    state.index += 1
  }
  return String.fromCharCode(Number.parseInt(value, 16))
}

function parseUnicodeEscape(state: ParseState): string | null {
  if (peek(state) === '{') {
    state.index += 1
    let value = ''
    while (peek(state) !== '}') {
      const char = peek(state)
      if (!isHex(char)) return null
      value += char
      state.index += 1
    }
    state.index += 1
    const codePoint = Number.parseInt(value, 16)
    if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return null
    return String.fromCodePoint(codePoint)
  }
  return parseHexEscape(state, 4)
}

function parseControlEscape(state: ParseState): string | null {
  const char = peek(state)
  if (char === undefined) return null
  const codePoint = char.toUpperCase().charCodeAt(0)
  if (codePoint < 65 || codePoint > 90) return null
  state.index += 1
  return String.fromCharCode(codePoint - 64)
}

function parsePropertyEscape(state: ParseState): void {
  if (peek(state) !== '{') return
  state.index += 1
  while (peek(state) !== undefined && peek(state) !== '}') state.index += 1
  if (peek(state) === '}') state.index += 1
}

function parseNamedBackreference(state: ParseState): void {
  if (peek(state) !== '<') return
  state.index += 1
  while (peek(state) !== undefined && peek(state) !== '>') state.index += 1
  if (peek(state) === '>') state.index += 1
}

function parseEscape(state: ParseState): RegexNode {
  state.index += 1
  const char = peek(state)
  if (char === undefined) throw new Error('trailing escape')
  if (char >= '0' && char <= '9') {
    while (peek(state) !== undefined && peek(state)! >= '0' && peek(state)! <= '9') {
      state.index += 1
    }
    return backreferenceNode()
  }
  state.index += 1
  switch (char) {
    case 'b':
    case 'B':
      return zeroWidthNode()
    case 'd':
      return charClassNode(rangesSet(DIGIT_RANGES))
    case 'D':
      return charClassNode(ANY_CHAR)
    case 'w':
      return charClassNode(rangesSet(WORD_RANGES))
    case 'W':
      return charClassNode(ANY_CHAR)
    case 's':
      return charClassNode(rangesSet(WHITESPACE_RANGES))
    case 'S':
      return charClassNode(ANY_CHAR)
    case 'p':
    case 'P':
      parsePropertyEscape(state)
      return charClassNode(ANY_CHAR)
    case 'k':
      parseNamedBackreference(state)
      return backreferenceNode()
    case 'n':
      return literalNode('\n', state.caseInsensitive)
    case 'r':
      return literalNode('\r', state.caseInsensitive)
    case 't':
      return literalNode('\t', state.caseInsensitive)
    case 'f':
      return literalNode('\f', state.caseInsensitive)
    case 'v':
      return literalNode('\v', state.caseInsensitive)
    case '0':
      return literalNode('\0', state.caseInsensitive)
    case 'x': {
      const value = parseHexEscape(state, 2)
      return literalNode(value ?? 'x', state.caseInsensitive)
    }
    case 'u': {
      const value = parseUnicodeEscape(state)
      return literalNode(value ?? 'u', state.caseInsensitive)
    }
    case 'c': {
      const value = parseControlEscape(state)
      return literalNode(value ?? 'c', state.caseInsensitive)
    }
    default:
      return literalNode(char, state.caseInsensitive)
  }
}

type ClassAtom =
  | { readonly kind: 'single'; readonly code: number }
  | { readonly kind: 'ranges'; readonly ranges: readonly CharRange[] }
  | { readonly kind: 'any' }

function parseClassAtom(state: ParseState): ClassAtom {
  const char = peek(state)
  if (char === undefined) throw new Error('unterminated character class')
  if (char !== '\\') {
    state.index += char.length
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || codePoint > 0xffff) return { kind: 'any' }
    return { kind: 'single', code: codePoint }
  }
  state.index += 1
  const escaped = peek(state)
  if (escaped === undefined) throw new Error('trailing escape in character class')
  state.index += 1
  if (escaped === 'd') return { kind: 'ranges', ranges: DIGIT_RANGES }
  if (escaped === 'w') return { kind: 'ranges', ranges: WORD_RANGES }
  if (escaped === 's') return { kind: 'ranges', ranges: WHITESPACE_RANGES }
  if (escaped === 'D' || escaped === 'W' || escaped === 'S') return { kind: 'any' }
  if (escaped === 'p' || escaped === 'P') {
    parsePropertyEscape(state)
    return { kind: 'any' }
  }
  if (escaped === 'b') return { kind: 'single', code: 8 }
  if (escaped >= '0' && escaped <= '9') {
    while (peek(state) !== undefined && peek(state)! >= '0' && peek(state)! <= '9') state.index += 1
    return { kind: 'any' }
  }
  if (escaped === 'n') return { kind: 'single', code: 10 }
  if (escaped === 'r') return { kind: 'single', code: 13 }
  if (escaped === 't') return { kind: 'single', code: 9 }
  if (escaped === 'f') return { kind: 'single', code: 12 }
  if (escaped === 'v') return { kind: 'single', code: 11 }
  if (escaped === '0') return { kind: 'single', code: 0 }
  if (escaped === 'x') {
    const value = parseHexEscape(state, 2)
    if (value === null || value.length !== 1) return { kind: 'any' }
    return { kind: 'single', code: value.charCodeAt(0) }
  }
  if (escaped === 'u') {
    const value = parseUnicodeEscape(state)
    if (value === null || value.length !== 1) return { kind: 'any' }
    return { kind: 'single', code: value.charCodeAt(0) }
  }
  if (escaped === 'c') {
    const value = parseControlEscape(state)
    if (value === null) return { kind: 'any' }
    return { kind: 'single', code: value.charCodeAt(0) }
  }
  const codePoint = escaped.codePointAt(0)
  if (codePoint === undefined || codePoint > 0xffff) return { kind: 'any' }
  return { kind: 'single', code: codePoint }
}

function parseCharacterClass(state: ParseState): RegexNode {
  state.index += 1
  let negated = false
  if (peek(state) === '^') {
    negated = true
    state.index += 1
  }
  const ranges: CharRange[] = []
  let forceAny = negated || state.caseInsensitive
  let closed = false
  while (state.index < state.source.length) {
    if (peek(state) === ']') {
      state.index += 1
      closed = true
      break
    }
    const first = parseClassAtom(state)
    if (first.kind === 'any') {
      forceAny = true
    } else if (first.kind === 'ranges') {
      ranges.push(...first.ranges)
    } else if (peek(state) === '-' && state.source[state.index + 1] !== undefined && state.source[state.index + 1] !== ']') {
      state.index += 1
      const second = parseClassAtom(state)
      if (second.kind === 'single') {
        ranges.push([Math.min(first.code, second.code), Math.max(first.code, second.code)])
      } else {
        forceAny = true
      }
    } else {
      ranges.push([first.code, first.code])
    }
  }
  if (!closed) throw new Error('unterminated character class')
  if (forceAny || ranges.length === 0) return charClassNode(ANY_CHAR)
  return charClassNode(rangesSet(ranges))
}

function parseGroup(state: ParseState, depth: number): RegexNode {
  if (depth >= MAX_REGEX_NESTING_DEPTH) {
    unsafeError('nesting-too-deep', 'regular expression groups are nested too deeply')
  }
  state.index += 1
  let assertion = false
  if (peek(state) === '?') {
    state.index += 1
    const marker = peek(state)
    if (marker === ':') {
      state.index += 1
    } else if (marker === '=' || marker === '!') {
      state.index += 1
      assertion = true
    } else if (marker === '<') {
      state.index += 1
      const lookbehind = peek(state)
      if (lookbehind === '=' || lookbehind === '!') {
        state.index += 1
        assertion = true
      } else {
        while (peek(state) !== undefined && peek(state) !== '>') state.index += 1
        if (peek(state) !== '>') throw new Error('unterminated named group')
        state.index += 1
      }
    } else if (marker !== undefined && /[ims-]/.test(marker)) {
      let modifiers = ''
      while (peek(state) !== undefined && peek(state) !== ':') {
        modifiers += peek(state)
        state.index += 1
      }
      if (peek(state) !== ':') throw new Error('unsupported inline modifier group')
      state.index += 1
      const previous = state.caseInsensitive
      const withoutCase = /-i(?:$|[ims])/.test(modifiers)
      const withCase = /(^|[^-])i(?:$|[ims])/.test(modifiers)
      if (withoutCase) state.caseInsensitive = false
      if (withCase) state.caseInsensitive = true
      const body = parseAlternation(state, depth + 1)
      state.caseInsensitive = previous
      if (peek(state) !== ')') throw new Error('unterminated group')
      state.index += 1
      return body
    } else {
      throw new Error('unsupported group syntax')
    }
  }
  const body = parseAlternation(state, depth + 1)
  if (peek(state) !== ')') throw new Error('unterminated group')
  state.index += 1
  return assertion ? zeroWidthNode() : body
}

/**
 * Inspect a compiled pattern source. The checker accepts only patterns it can
 * prove structurally free of the known super-linear shapes; an unknown syntax
 * is rejected rather than assumed safe.
 */
export function inspectRegexSafety(source: string, flags: string): RegexSafetyVerdict {
  if (source.length > MAX_SCRIPT_REGEX_PATTERN_LENGTH) {
    return {
      safe: false,
      reason: 'pattern-too-long',
      detail: `pattern length ${source.length} exceeds ${MAX_SCRIPT_REGEX_PATTERN_LENGTH}`,
    }
  }
  const state: ParseState = {
    source,
    index: 0,
    caseInsensitive: flags.includes('i'),
  }
  try {
    parseAlternation(state, 0)
    if (state.index !== source.length) {
      return { safe: false, reason: 'unparsable-pattern', detail: 'unparsed trailing pattern syntax' }
    }
    return { safe: true }
  } catch (error) {
    if (isUnsafeError(error)) {
      return { safe: false, reason: error.reason, detail: error.message }
    }
    return {
      safe: false,
      reason: 'unparsable-pattern',
      detail: error instanceof Error ? error.message : 'unknown pattern parse failure',
    }
  }
}