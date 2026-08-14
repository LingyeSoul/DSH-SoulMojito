import { ScanBuffer, type ScanState } from './buffer.js'
import { bookRef, normalizeEntry, sortCandidates, toScanEntry, type ScanEntry } from './entry.js'
import { filterByInclusionGroups } from './groups.js'
import { cloneTimedState, TimedEffects } from './timed.js'
import {
  WI_LOGIC,
  WI_POSITION,
  type ActivatedEntry,
  type ActivationInput,
  type ActivationReason,
  type ActivationResult,
  type DepthEntryGroup,
  type EntryDiagnostics,
  type EntryGroup,
  type SkipReason,
} from './types.js'

const DEFAULT_CONTEXT = 4096
const DEFAULT_SCAN_DEPTH = 2
const DEFAULT_BUDGET_PERCENT = 25

interface MatchResult {
  matched: boolean
  matchedKeys: string[]
  reason: ActivationReason | SkipReason
}

/** SillyTavern-compatible World Info activation main loop. */
export function activateWorldInfo(input: ActivationInput): ActivationResult {
  const settings = input.settings ?? {}
  const scanDepth = Math.max(0, settings.scanDepth ?? DEFAULT_SCAN_DEPTH)
  const contextSize = Math.max(0, input.contextSize ?? DEFAULT_CONTEXT)
  const percentBudget = Math.max(0, Math.floor(contextSize * (settings.budgetPercent ?? DEFAULT_BUDGET_PERCENT) / 100))
  const cap = settings.budgetCap ?? 0
  const budgetLimit = cap > 0 ? Math.min(percentBudget, cap) : percentBudget
  const countTokens = input.countTokens ?? ((text: string) => Math.round(text.length / 3.5))
  const rng = input.rng ?? Math.random
  const trigger = input.trigger ?? 'normal'
  const messageCount = input.messageCount ?? input.chat.length

  const prepared: Array<Omit<ScanEntry, 'candidateIndex'>> = []
  for (let bookIndex = 0; bookIndex < input.books.length; bookIndex++) {
    const book = input.books[bookIndex]!
    const ref = bookRef(book, bookIndex)
    for (const raw of book.entries) prepared.push(toScanEntry(normalizeEntry(raw), ref))
  }
  const entries = sortCandidates(prepared.map((entry) => ({ ...entry, candidateIndex: 0 })))
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]))

  const includeNames = settings.includeNames !== false
  const newestFirst = [...input.chat].reverse().map((message) => {
    if (!includeNames || !message.name) return message.content
    return `${message.name}: ${message.content}`
  })
  const buffer = new ScanBuffer(newestFirst, input.scanSources ?? {}, {
    scanDepth,
    caseSensitive: settings.caseSensitive ?? false,
    matchWholeWords: settings.matchWholeWords ?? false,
  })

  const diagnostics: Record<string, EntryDiagnostics> = {}
  const timed = new TimedEffects(cloneTimedState(input.timedState), entries, messageCount)
  const activated = new Map<string, ScanEntry>()
  const activatedMeta = new Map<string, { matchedKeys: string[]; reason: ActivationReason }>()
  const failedProbability = new Set<string>()
  const bookUsed = new Map<number, number>()
  let budgetUsed = 0
  let budgetExceeded = false
  let scanRounds = 0
  let recursionRounds = 0

  function diag(entry: ScanEntry, reason: ActivationReason | SkipReason, extra: Partial<EntryDiagnostics> = {}): void {
    if (activated.has(entry.entryId) && !isActivationReason(reason)) return
    diagnostics[entry.entryId] = { activated: isActivationReason(reason), reason, ...extra }
  }

  function evaluate(entry: ScanEntry, state: ScanState, recursionLevel: number): MatchResult {
    if (entry.disable) return { matched: false, matchedKeys: [], reason: 'disabled' }
    if (entry.triggers.length > 0 && !entry.triggers.includes(trigger)) return { matched: false, matchedKeys: [], reason: 'trigger-filter' }
    // ST timed group/scanner semantics: sticky forces activation even when the same entry also
    // has a concurrently recorded cooldown; cooldown takes over after sticky expires.
    if (timed.isStickyActive(entry)) return { matched: true, matchedKeys: [], reason: 'sticky' }
    if (timed.isCooldownActive(entry)) return { matched: false, matchedKeys: [], reason: 'cooldown' }
    if (timed.isDelayActive(entry)) return { matched: false, matchedKeys: [], reason: 'delayed' }
    if (failedProbability.has(entry.entryId)) return { matched: false, matchedKeys: [], reason: 'probability' }
    if (state === 'RECURSION' && entry.excludeRecursion) return { matched: false, matchedKeys: [], reason: entry.bookRecursive ? 'exclude-recursion' : 'exclude-recursion-book' }
    if (entry.delayUntilRecursion > 0) {
      if (state !== 'RECURSION') return { matched: false, matchedKeys: [], reason: 'delay-until-recursion' }
      if (recursionLevel < entry.delayUntilRecursion) return { matched: false, matchedKeys: [], reason: 'delay-until-recursion-level' }
    }
    if (entry.decorators.some((d) => d.startsWith('@@dont_activate'))) return { matched: false, matchedKeys: [], reason: 'decorator-suppressed' }
    if (entry.decorators.some((d) => d.startsWith('@@activate'))) return { matched: true, matchedKeys: [], reason: 'decorator' }
    if (entry.constant) return { matched: true, matchedKeys: [], reason: 'constant' }
    if (entry.key.length === 0) return { matched: false, matchedKeys: [], reason: 'no-keys' }

    const text = buffer.get(entry, state)
    const matchedKeys = entry.key.filter((key) => buffer.matchKeys(text, key, entry))
    if (matchedKeys.length === 0) return { matched: false, matchedKeys, reason: 'primary-key-no-match' }
    if (entry.selective && entry.keysecondary.length > 0) {
      const secondary = entry.keysecondary.map((key) => buffer.matchKeys(text, key, entry))
      const any = secondary.some(Boolean)
      const all = secondary.every(Boolean)
      const satisfied =
        entry.selectiveLogic === WI_LOGIC.AND_ANY ? any :
        entry.selectiveLogic === WI_LOGIC.NOT_ALL ? !all :
        entry.selectiveLogic === WI_LOGIC.NOT_ANY ? !any : all
      if (!satisfied) return { matched: false, matchedKeys, reason: 'secondary-keys-not-satisfied' }
    }
    return { matched: true, matchedKeys, reason: entry.selective && entry.keysecondary.length > 0 ? 'primary-and-secondary' : 'primary-key' }
  }

  function runRound(state: ScanState, recursionLevel: number): ScanEntry[] {
    scanRounds++
    const candidates: ScanEntry[] = []
    const matchById = new Map<string, MatchResult>()
    for (const entry of entries) {
      if (activated.has(entry.entryId)) {
        diag(entry, 'already-activated')
        continue
      }
      const match = evaluate(entry, state, recursionLevel)
      if (!match.matched) {
        diag(entry, match.reason, { matchedKeys: match.matchedKeys })
        continue
      }
      if (!timed.isStickyActive(entry) && entry.useProbability) {
        const roll = rng() * 100
        if (roll > entry.probability) {
          failedProbability.add(entry.entryId)
          diag(entry, 'probability', { matchedKeys: match.matchedKeys, probabilityRoll: roll })
          continue
        }
      }
      candidates.push(entry)
      matchById.set(entry.entryId, match)
    }

    const removed = new Map<string, SkipReason>()
    filterByInclusionGroups(candidates, {
      buffer,
      scanState: state,
      timed,
      activated,
      rng,
      useGroupScoring: settings.useGroupScoring ?? false,
      onRemove: (entry, reason) => {
        removed.set(entry.entryId, reason)
        diag(entry, reason)
      },
    })

    const accepted: ScanEntry[] = []
    for (const entry of candidates) {
      if (removed.has(entry.entryId)) continue
      const tokens = entry.ignoreBudget ? 0 : Math.max(0, countTokens(entry.content))
      const usedByBook = bookUsed.get(entry.bookIndex) ?? 0
      if (!entry.ignoreBudget && entry.bookBudget !== null && usedByBook + tokens > entry.bookBudget) {
        diag(entry, 'budget-book')
        budgetExceeded = true
        continue
      }
      if (!entry.ignoreBudget && budgetUsed + tokens > budgetLimit) {
        diag(entry, 'budget')
        budgetExceeded = true
        // ST stops accepting subsequent candidates after the global budget is exhausted.
        for (const later of candidates.slice(candidates.indexOf(entry) + 1)) {
          if (!removed.has(later.entryId) && !activated.has(later.entryId)) diag(later, 'budget')
        }
        break
      }
      budgetUsed += tokens
      if (!entry.ignoreBudget) bookUsed.set(entry.bookIndex, usedByBook + tokens)
      activated.set(entry.entryId, entry)
      const match = matchById.get(entry.entryId)!
      activatedMeta.set(entry.entryId, { matchedKeys: match.matchedKeys, reason: match.reason as ActivationReason })
      diag(entry, match.reason, { matchedKeys: match.matchedKeys })
      accepted.push(entry)
    }
    return accepted
  }

  const initial = runRound('INITIAL', 0)
  let recursiveSeed = initial.filter((entry) => !entry.preventRecursion && entry.content.length > 0)
  let recursionLevel = 0
  const recursiveEnabled = settings.recursive === true
  while (recursiveEnabled && recursiveSeed.length > 0) {
    if ((settings.maxRecursionSteps ?? 0) > 0 && recursionRounds >= (settings.maxRecursionSteps ?? 0)) break
    for (const entry of recursiveSeed) buffer.addRecurse(entry.content)
    recursionLevel++
    recursionRounds++
    const next = runRound('RECURSION', recursionLevel)
    recursiveSeed = next.filter((entry) => !entry.preventRecursion && entry.content.length > 0)
  }

  const minActivations = Math.max(0, settings.minActivations ?? 0)
  const maxDepth = settings.minActivationsDepthMax && settings.minActivationsDepthMax > 0
    ? Math.min(input.chat.length, settings.minActivationsDepthMax)
    : input.chat.length
  while (activated.size < minActivations && buffer.getDepth() < maxDepth) {
    buffer.advanceScan()
    const added = runRound('MIN_ACTIVATIONS', recursionLevel)
    if (added.length === 0 && buffer.getDepth() >= maxDepth) break
  }

  timed.setFromActivation([...activated.values()])
  const activatedRows = [...activated.values()].map((entry): ActivatedEntry => {
    const meta = activatedMeta.get(entry.entryId)!
    return {
      uid: entry.uid,
      book: entry.bookLabel,
      entryId: entry.entryId,
      order: entry.order,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      outletName: entry.outletName,
      content: entry.content,
      matchedKeys: meta.matchedKeys,
      activationReason: meta.reason,
      entry: entry.raw,
    }
  })

  return assembleResult(activatedRows, {
    budgetLimit,
    budgetUsed,
    budgetExceeded,
    scanRounds,
    recursionRounds,
    scanSkew: buffer.getSkew(),
    entries: diagnostics,
  }, timed.getTimedState())
}

function isActivationReason(reason: ActivationReason | SkipReason): reason is ActivationReason {
  return reason === 'constant' || reason === 'sticky' || reason === 'primary-key' || reason === 'primary-and-secondary' || reason === 'decorator'
}

function group(entries: ActivatedEntry[]): EntryGroup {
  // ST unshift assembly: candidates scanned order DESC, final prompt order ASC.
  const sorted = [...entries].sort((a, b) => a.order - b.order || b.uid - a.uid)
  return { entries: sorted, text: sorted.map((entry) => entry.content).filter(Boolean).join('\n') }
}

function assembleResult(
  allActivated: ActivatedEntry[],
  diagnostics: ActivationResult['diagnostics'],
  timedState: ActivationResult['timedState'],
): ActivationResult {
  const atDepthMap = new Map<string, ActivatedEntry[]>()
  const outlets: Record<string, EntryGroup> = {}
  for (const entry of allActivated.filter((x) => x.position === WI_POSITION.AT_DEPTH)) {
    const key = `${entry.depth}:${entry.role}`
    const list = atDepthMap.get(key) ?? []
    list.push(entry)
    atDepthMap.set(key, list)
  }
  for (const entry of allActivated.filter((x) => x.position === WI_POSITION.OUTLET)) {
    const name = entry.outletName || ''
    const current = outlets[name]?.entries ?? []
    outlets[name] = group([...current, entry])
  }
  const atDepth: DepthEntryGroup[] = [...atDepthMap.entries()].map(([key, rows]) => {
    const [depth, role] = key.split(':').map(Number) as [number, number]
    const g = group(rows)
    return { depth, role: role as DepthEntryGroup['role'], ...g }
  }).sort((a, b) => a.depth - b.depth || a.role - b.role)
  const at = (position: number) => group(allActivated.filter((x) => x.position === position))
  return {
    worldInfoBefore: at(WI_POSITION.BEFORE),
    worldInfoAfter: at(WI_POSITION.AFTER),
    beforeExamples: at(WI_POSITION.EM_TOP),
    afterExamples: at(WI_POSITION.EM_BOTTOM),
    topOfAuthorsNote: at(WI_POSITION.AN_TOP),
    bottomOfAuthorsNote: at(WI_POSITION.AN_BOTTOM),
    atDepth,
    outlets,
    allActivated,
    diagnostics,
    timedState,
  }
}
