/**
 * AgentTavern JSONL projection for body log records (proposal 0021).
 *
 * This module owns the body-only half of the projector: the
 * `plugin:dsh-soulmojito/body` event branch, the checkpoint-scoped handling of
 * candidate / select / edit / restore records, the ledger fold that resolves
 * anchor and candidate slots, the trigger-turn skip that keeps a regeneration
 * or restore turn from adding a second floor, and the candidate text +
 * provider metadata extraction with the same save-layer regex rule as the
 * generic message projection.
 *
 * All JSONL writes go through `getChatSnapshot` + `saveChat(expectedRevision)`
 * with the same four-attempt `ChatRevisionConflictError` retry as the generic
 * floor append. The module never owns a lock of its own: the caller runs it on
 * the session's `KeyedMutationTails` queue, so the projector stays the single
 * writer.
 */

import { ChatRevisionConflictError, type ChatScriptsFile, type TavernSessionBinding, type TavernState } from '../../../tavern-store/src/index.js'
import { RegexPlacement, type CharacterCardIR, type ChatLogIR } from '../../../tavern-format/src/index.js'
import { applyRegexScripts } from '../../../tavern-script/src/index.js'
import { sessionEvents, type HostSessionLog } from '../../../bind/src/index.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { mvuReceiptsForBody, recordMvuTurnReceipt, snapshotChatVariables } from '../mvu.js'
import {
  applyUpdateVariableToChat,
  cardUsesJsrMvu,
  ensureChatVariables,
  messageStatVariables,
  seedJsrMvuVariables,
} from './mvu-compat.js'
import {
  BODY_EVENT_TYPE,
  BodyLedgerError,
  foldBodyLedger,
  type BodyEventData,
  type BodyLedger,
  type BodySessionEvent,
} from './body.js'
import {
  BodyJsonlProjectionError,
  applyCandidateToChat,
  applyFloorAdoptionToChat,
  applyRestoreToChat,
  applySelectToChat,
  findBodyFloorIndexByGroupId,
  findBodyFloorIndexByMessageId,
  type BodyJsonlCandidateInput,
  type BodyJsonlUsage,
} from './body-jsonl.js'
import { applyCandidateEditToChat, candidatePreserveKeys } from './body-candidate-receipts.js'
import { isTavernSessionMarker } from './body-session.js'

/** State slice the body projection needs from the tavern store. */
export type BodyProjectionState = Pick<
  TavernState,
  'sessionBindings' | 'regexScripts' | 'regexScriptOwners' | 'regexScriptPresetOwners' | 'activePreset'
>

/** Store surface consumed by the body projection; `ProjectorStore` extends it. */
export interface BodyProjectionStore {
  getState(): Promise<BodyProjectionState>
  getCharacter(name: string): Promise<{ card: CharacterCardIR } | undefined>
  getChatSnapshot(character: string, chatId: string): Promise<{ chat: ChatLogIR; revision: string } | undefined>
  saveChat(character: string, chatId: string, chat: ChatLogIR, expectedRevision?: string): Promise<string>
  getChatJsrOverlay(characterName: string, chatId: string): Promise<ChatScriptsFile | undefined>
}

/**
 * Structural view of one native session event. `NativeSessionEvent` from
 * `projector.ts` and the host event log both satisfy it.
 */
export interface BodyProjectionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
}

/* ------------------------------- entry points ------------------------------ */

/** Whether a session event type is the body log record type. */
export function isBodyLogEvent(eventType: string): boolean {
  return eventType === BODY_EVENT_TYPE
}

/**
 * Project one `plugin:dsh-soulmojito/body` record into the saved chat.
 *
 * `op-start` / `op-finish` are bookkeeping only. The four write ops fold the
 * shared body ledger at `event.seq` first, then apply the matching pure JSONL
 * transform; a missing ledger slot or a watermark mismatch throws a typed
 * error instead of writing a wrong slot, and the caller records a pending
 * checkpoint so the event can be replayed after repair.
 */
export async function projectBodyEvent(
  store: BodyProjectionStore,
  session: HostSessionLog,
  state: BodyProjectionState,
  binding: Extract<TavernSessionBinding, { architecture: 'agent-tavern' }>,
  event: BodyProjectionEvent,
): Promise<void> {
  const record = plainObjectRecord(event.data)
  if (record === undefined) {
    throw new BodyLedgerError('invalid-body-event', `body event seq ${event.seq} must carry an object data payload`)
  }
  const op = record['op']
  if (op === 'op-start' || op === 'op-finish') return
  if (op !== 'candidate' && op !== 'select' && op !== 'edit' && op !== 'restore') {
    throw new BodyLedgerError('invalid-body-op', `body event seq ${event.seq} has unknown op '${String(op)}'`)
  }

  // foldBodyLedger validates every field of this event at the watermark, so
  // this cast is checked at runtime by the fold before any JSONL write.
  const data = record as unknown as Extract<
    BodyEventData,
    { op: 'candidate' } | { op: 'select' } | { op: 'edit' } | { op: 'restore' }
  >
  const ledger = foldBodyLedger(bodySessionEvents(session), data.groupId, event.seq)

  if (data.op === 'candidate') {
    const projected = requireProjectedLedger(ledger, event.seq, data.groupId)
    const slot = requireProjectedCandidate(projected, data, event.seq)
    const resolved = resolveBodyCandidateMessage(session, data.messageId, event.seq)
    const character = await store.getCharacter(binding.character)
    const scripts = await collectSessionRegexScripts(store, state, binding.character, binding.chatId, character)
    // Same save-layer rule as the generic projection: non promptOnly, non markdownOnly.
    const saveScripts = scripts.filter((script) => !script.promptOnly && !script.markdownOnly)
    const text = saveScripts.length > 0
      ? applyRegexScripts(resolved.text, saveScripts, RegexPlacement.AI_OUTPUT)
      : resolved.text
    const input: BodyJsonlCandidateInput = {
      groupId: data.groupId,
      messageId: data.messageId,
      index: slot.index,
      text,
      sendDate: resolved.at,
      ...(resolved.provider === undefined ? {} : { provider: resolved.provider }),
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      ...(resolved.usage === undefined ? {} : { usage: resolved.usage }),
      ...(data.feedback === undefined ? {} : { feedback: data.feedback }),
    }
    await mutateBodyChat(store, binding, { seq: event.seq, groupId: data.groupId }, (chat) => {
      const adopted = adoptImportedAnchorFloor(chat, session, data.groupId, projected.anchorMessageId)
      return projectCandidateToChat(adopted, character?.card, input, projected)
    })
    return
  }

  if (data.op === 'select') {
    assertSelectPreState(session, data, event.seq)
    const projected = requireProjectedLedger(ledger, event.seq, data.groupId)
    await mutateBodyChat(store, binding, { seq: event.seq, groupId: data.groupId }, (chat) => applySelectToChat(
      adoptImportedAnchorFloor(chat, session, data.groupId, projected.anchorMessageId),
      {
        groupId: data.groupId,
        index: data.index,
        anchorMessageId: projected.anchorMessageId,
      },
    ))
    return
  }

  if (data.op === 'edit') {
    const projected = requireProjectedLedger(ledger, event.seq, data.groupId)
    // No post-fold comparison here: the fold applies this edit at `eventSeq`, so
    // `edits.get(index) === data.text` is true by construction. The pre-event
    // witness (`previousText`) is checked by `assertEditPreviousText` instead.
    const candidate = projected.candidates[data.index]
    if (candidate === undefined) {
      throw new BodyLedgerError(
        'invalid-body-index',
        `body event seq ${event.seq} edit index ${data.index} is out of range for group '${data.groupId}' with ${projected.candidates.length} candidates`,
      )
    }
    assertEditPreviousText(session, data, event.seq)
    const character = await store.getCharacter(binding.character)
    if (character === undefined) {
      throw new BodyLedgerError(
        'invalid-body-event',
        `body event seq ${event.seq} edit for group '${data.groupId}' cannot resolve character '${binding.character}' to apply candidate receipts`,
      )
    }
    const at = eventDate(event.time, event.seq, event.type)
    await mutateBodyChat(store, binding, { seq: event.seq, groupId: data.groupId }, (chat) => applyCandidateEditToChat(
      adoptImportedAnchorFloor(chat, session, data.groupId, projected.anchorMessageId),
      character.card,
      {
        ledger: projected,
        groupId: data.groupId,
        index: data.index,
        messageId: candidate.messageId,
        previousText: data.previousText,
        text: data.text,
        at,
        eventSeq: event.seq,
      },
    ))
    return
  }

  assertRestorePreState(session, data, event.seq)
  const projected = requireProjectedLedger(ledger, event.seq, data.groupId)
  await mutateBodyChat(store, binding, { seq: event.seq, groupId: data.groupId }, (chat) => applyRestoreToChat(
    adoptImportedAnchorFloor(chat, session, data.groupId, projected.anchorMessageId),
    {
      groupId: data.groupId,
      index: data.index,
      messageId: data.messageId,
    },
  ))
}

/**
 * An assistant message is merged into an existing body floor, instead of being
 * appended as a new floor, when its turn is a body-regeneration/restore trigger
 * turn or when a restore event points at this message id.
 */
export function isBodyMergedAssistant(session: HostSessionLog, event: BodyProjectionEvent): boolean {
  const data = plainObjectRecord(event.data)
  const message = data === undefined ? undefined : plainObjectRecord(data['message'])
  const messageId = message?.['id']
  if (typeof messageId === 'string' && messageId !== '' && isRestoredBodyMessage(session, messageId)) return true
  return isBodyTriggerTurn(session, data?.['turn'])
}

/* --------------------------- imported-floor adoption ----------------------- */

/**
 * Bind one imported anchor to a chat floor the body projection can write into.
 *
 * The history import deliberately does not project its mirror messages back
 * into the JSONL (decision 2026-10-20), so the opening/history floors start
 * without the body-group identity and any body event targeting them fails with
 * `body-floor-not-found`. The first such event adopts the chat's trailing
 * plugin-unaware assistant floor: the group binding is written and its ST
 * swipe surface is snapshotted and dropped, so this event's candidate
 * projection behaves exactly like the first operation on a live floor.
 *
 * Adoption runs on the caller's chat clone, inside the same CAS write as the
 * operation that triggered it: any later failure in that operation discards
 * the clone, so a dropped swipe surface can never be persisted on its own.
 *
 * Already-bound groups, non-mirror anchors and chats without an adoptable
 * floor are no-ops; the caller's projection then keeps its normal verdict
 * (including the pending checkpoint for genuinely lagging live floors).
 */
function adoptImportedAnchorFloor(
  chat: ChatLogIR,
  session: HostSessionLog,
  groupId: string,
  anchorMessageId: string | undefined,
): ChatLogIR {
  if (anchorMessageId === undefined) return chat
  const sessionId = typeof session.id === 'string' && session.id !== '' ? session.id : undefined
  if (sessionId === undefined) return chat
  const anchorText = importedMirrorAnchorText(session, anchorMessageId)
  if (anchorText === undefined) return chat

  try {
    return applyFloorAdoptionToChat(chat, { groupId, sessionId, anchorMessageId, anchorText })
  } catch (error) {
    // No plugin-unaware floor to adopt: keep the ordinary projection verdict.
    if (error instanceof BodyJsonlProjectionError
      && (error.code === 'body-floor-not-found' || error.code === 'body-group-mismatch')) {
      return chat
    }
    throw error
  }
}

/**
 * Text of the AgentTavern history-import mirror with this assistant message id.
 *
 * The text is the adoption witness: the chosen chat floor must carry the same
 * text, otherwise it is not the mirror of this anchor and adopting it would
 * bind the body group to the wrong floor.
 */
function importedMirrorAnchorText(session: HostSessionLog, anchorMessageId: string): string | undefined {
  let found: BodyProjectionEvent | undefined
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (event.type !== 'assistant/message') continue
    const message = plainObjectRecord(plainObjectRecord(event.data)?.['message'])
    if (message?.['id'] !== anchorMessageId) continue
    if (found === undefined || event.seq >= found.seq) found = event
  }
  if (found === undefined) return undefined
  const message = plainObjectRecord(plainObjectRecord(found.data)?.['message'])
  if (!isTavernSessionMarker(message?.['source'])) return undefined
  const text = messageText(message?.['content'])
  return text === '' ? undefined : text
}

/* ---------------------- candidate merge + MVU patch ----------------------- */

/**
 * Merge one candidate into its body floor and apply its MVU patch exactly once.
 *
 * A regenerated candidate never reaches the generic assistant append path
 * (its trigger turn is merged instead), so this function reproduces the same
 * JSR MVU sequence on the cloned chat: seed, snapshot the post-seed baseline,
 * apply `<UpdateVariable>`, record the `body:<messageId>` receipt, then merge
 * the candidate with the patched text and attach the resulting stat_data.
 *
 * Replay and CAS retries re-enter with a fresh snapshot. An existing swipe slot
 * or an existing receipt means the patch already ran, so the candidate merges
 * with its stored text and the variable tree stays untouched.
 *
 * `ledger` supplies the active group's candidate keys when (and only when) a
 * receipt is actually written, so a candidate id the receipt-key grammar cannot
 * encode never blocks a projection that needs no receipt.
 */
function projectCandidateToChat(
  chat: ChatLogIR,
  card: CharacterCardIR | undefined,
  input: BodyJsonlCandidateInput,
  ledger: BodyLedger,
): ChatLogIR {
  const existingText = existingCandidateText(chat, input.groupId, input.messageId, input.index)
  const receiptExists = mvuReceiptsForBody(chat, { messageId: input.messageId }).length > 0
  if (card === undefined
    || !cardUsesJsrMvu(card)
    || existingText !== undefined
    || receiptExists
    || !hasUpdateVariableBlock(input.text)) {
    return applyCandidateToChat(chat, {
      ...input,
      ...(existingText === undefined ? {} : { text: existingText }),
    })
  }

  seedJsrMvuVariables(card, ensureChatVariables(chat))
  const before = snapshotChatVariables(chat)
  const applied = applyUpdateVariableToChat(card, chat, input.text)
  const next = applyCandidateToChat(chat, { ...input, text: applied.text })
  if (!applied.found) return next
  // Lazy on purpose: this is the first point where a receipt is certain. An
  // unencodable message id fails closed here instead of rejecting every
  // candidate projection on the floor.
  const preserveTurnKeys = candidatePreserveKeys(ledger)
  recordMvuTurnReceipt(next, before, {
    turnKey: `body:${input.messageId}`,
    failures: applied.failures,
    preserveTurnKeys,
  })
  return attachBodyStatData(next, input.groupId)
}

/**
 * Text already stored in the candidate slot. A present slot means a previous
 * projection (or a successful CAS attempt) already merged this candidate.
 *
 * The fallback locator uses the candidate's native message id, never the group
 * id: a body group id may equal another floor's projected message id, and
 * reading that floor's swipes would project the wrong text.
 */
function existingCandidateText(
  chat: ChatLogIR,
  groupId: string,
  messageId: string,
  index: number,
): string | undefined {
  const byGroup = findBodyFloorIndexByGroupId(chat, groupId)
  const floorIndex = byGroup === undefined ? findBodyFloorIndexByMessageId(chat, messageId) : byGroup
  if (floorIndex === undefined) return undefined
  const floor = chat.messages[floorIndex]
  const swipes = floor === undefined ? undefined : floor.swipes
  if (!Array.isArray(swipes)) return undefined
  const text = swipes[index]
  return typeof text === 'string' ? text : undefined
}

/** Mirror the floor's current stat_data into the message variables like appendMessage. */
function attachBodyStatData(chat: ChatLogIR, groupId: string): ChatLogIR {
  const floorIndex = findBodyFloorIndexByGroupId(chat, groupId)
  if (floorIndex === undefined) {
    throw new BodyJsonlProjectionError(
      'body-floor-not-found',
      `body floor '${groupId}' disappeared after candidate projection`,
    )
  }
  const floor = chat.messages[floorIndex]
  if (floor === undefined) {
    throw new BodyJsonlProjectionError(
      'body-floor-not-found',
      `body floor '${groupId}' has no message at index ${floorIndex}`,
    )
  }
  chat.messages[floorIndex] = messageStatVariables(chat, floor)
  return chat
}

/** Same block shape as the MVU parser; only gates whether the patch may run. */
function hasUpdateVariableBlock(text: string): boolean {
  return /<UpdateVariable(?:Variable)?\b[^>]*>[\s\S]*?<\/UpdateVariable(?:Variable)?\s*>/i.test(text)
}

/* -------------------------------- CAS writer ------------------------------- */

/** Location of one body event, carried into store-level failures. */
interface BodyProjectionSite {
  readonly seq: number
  readonly groupId: string
}

/**
 * CAS writer shared by the body projections.
 *
 * `mutate` receives a fresh clone of the snapshot and returns the chat to save;
 * a thrown error discards that clone, so multi-step transforms (imported-floor
 * adoption plus candidate projection) land in one write or not at all.
 */
async function mutateBodyChat(
  store: BodyProjectionStore,
  binding: Extract<TavernSessionBinding, { architecture: 'agent-tavern' }>,
  site: BodyProjectionSite,
  mutate: (chat: ChatLogIR) => ChatLogIR | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await store.getChatSnapshot(binding.character, binding.chatId)
    if (!snapshot) {
      throw new Error(
        `AgentTavern body projection target chat not found: chat '${binding.chatId}' of '${binding.character}' at body event seq ${site.seq} for group '${site.groupId}'`,
      )
    }
    const next = mutate(structuredClone(snapshot.chat))
    if (next === undefined) return
    try {
      await store.saveChat(binding.character, binding.chatId, next, snapshot.revision)
      return
    } catch (error) {
      if (!(error instanceof ChatRevisionConflictError) || attempt === 3) throw error
    }
  }
}

/* -------------------------------- ledger ---------------------------------- */

function isRestoredBodyMessage(session: HostSessionLog, messageId: string): boolean {
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (event.type !== BODY_EVENT_TYPE) continue
    const data = plainObjectRecord(event.data)
    if (data !== undefined && data['op'] === 'restore' && data['messageId'] === messageId) return true
  }
  return false
}

/** Whether the first user message of `turn` is a synthetic body trigger. */
function isBodyTriggerTurn(session: HostSessionLog, turn: unknown): boolean {
  if (typeof turn !== 'number' || !Number.isSafeInteger(turn)) return false
  let current: number | undefined
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (event.type === 'turn/start') {
      current = safeTurnNumber(plainObjectRecord(event.data)?.['turn'])
      continue
    }
    if (event.type === 'turn/end') {
      if (current === turn) return false
      current = undefined
      continue
    }
    if (current !== turn || event.type !== 'user/message') continue
    const source = plainObjectRecord(plainObjectRecord(event.data)?.['source'])
    const form = source?.['form']
    return form === 'body-regenerate' || form === 'body-restore'
  }
  return false
}

function safeTurnNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function bodySessionEvents(session: HostSessionLog): readonly BodySessionEvent[] {
  const events: BodySessionEvent[] = []
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
      throw new BodyLedgerError(
        'invalid-body-seq',
        `session event '${String(event.type)}' has invalid seq ${String(event.seq)} while folding body events`,
      )
    }
    if (typeof event.type !== 'string' || event.type === '') {
      throw new BodyLedgerError('invalid-body-event', `session event at seq ${event.seq} has no type while folding body events`)
    }
    events.push({ seq: event.seq, type: event.type, data: event.data as unknown as BodySessionEvent['data'] })
  }
  return events
}

function requireProjectedLedger(ledger: BodyLedger | undefined, seq: number, groupId: string): BodyLedger {
  if (ledger === undefined) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${seq} for group '${groupId}' has no candidate, so its JSONL slot cannot be resolved`,
    )
  }
  return ledger
}

function requireProjectedCandidate(
  ledger: BodyLedger | undefined,
  data: Extract<BodyEventData, { op: 'candidate' }>,
  seq: number,
): BodyLedger['candidates'][number] {
  const projected = requireProjectedLedger(ledger, seq, data.groupId)
  if (projected.anchorMessageId !== data.messageId) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${seq} candidate '${data.messageId}' does not match ledger anchor '${projected.anchorMessageId}' for group '${data.groupId}'`,
    )
  }
  const slot = projected.candidates[data.index]
  if (slot === undefined) {
    throw new BodyLedgerError(
      'invalid-body-index',
      `body event seq ${seq} candidate index ${data.index} is out of range for group '${data.groupId}' with ${projected.candidates.length} candidates`,
    )
  }
  if (slot.messageId !== data.messageId) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${seq} candidate index ${data.index} holds '${slot.messageId}', not '${data.messageId}'`,
    )
  }
  return slot
}

/**
 * Validate `edit.previousText` against the ledger folded before the event.
 *
 * The post-edit ledger already carries the new text, so the previous body must
 * be read at `seq - 1`; a mismatch would make the receipt undo a baseline the
 * projector never saw, so it refuses before any JSONL write.
 */
function assertEditPreviousText(
  session: HostSessionLog,
  data: Extract<BodyEventData, { op: 'edit' }>,
  eventSeq: number,
): void {
  if (eventSeq === 0) {
    throw new BodyLedgerError(
      'invalid-body-event',
      'body event seq 0 cannot be an edit because no candidate exists before it',
    )
  }
  const before = foldBodyLedger(bodySessionEvents(session), data.groupId, eventSeq - 1)
  if (before === undefined) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${eventSeq} edit for group '${data.groupId}' has no candidate before its watermark`,
    )
  }
  const candidate = before.candidates[data.index]
  if (candidate === undefined) {
    throw new BodyLedgerError(
      'invalid-body-index',
      `body event seq ${eventSeq} edit index ${data.index} is out of range for group '${data.groupId}' with ${before.candidates.length} candidates`,
    )
  }
  const effective = before.edits.get(data.index) ?? candidate.text
  if (effective !== data.previousText) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${eventSeq} edit previousText does not match the effective body at index ${data.index} for group '${data.groupId}'`,
    )
  }
}

/**
 * Fold one group's ledger strictly before `eventSeq`.
 *
 * `foldBodyLedger` takes an inclusive watermark, so the state a record was
 * written against is the fold at `eventSeq - 1`. Seq 0 has no earlier state.
 */
function foldBefore(session: HostSessionLog, groupId: string, eventSeq: number): BodyLedger | undefined {
  if (eventSeq === 0) return undefined
  return foldBodyLedger(bodySessionEvents(session), groupId, eventSeq - 1)
}

/** Whether an `assistant/message` at or before `uptoSeq` carries this message id. */
function hasAssistantMessage(session: HostSessionLog, messageId: string, uptoSeq: number): boolean {
  if (messageId === '' || uptoSeq < 0) return false
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (event.type !== 'assistant/message') continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > uptoSeq) continue
    if (plainObjectRecord(plainObjectRecord(event.data)?.['message'])?.['id'] === messageId) return true
  }
  return false
}

/**
 * Pre-state guard for a `select` record.
 *
 * Comparing the folded selection with the record cannot fail: the fold applies
 * this select at the event's own watermark and rejects an out-of-range slot as
 * `invalid-body-index`, and a select never changes the candidate list. So the
 * only checkable pre-state fact is the floor the selection starts from: the
 * ledger folded at `seq - 1` must name an anchor that the session really
 * carried as an assistant message. That is not fold-guaranteed — a `restore`
 * record may rebind the anchor to any message id — and a selection that starts
 * from a phantom anchor would move the surface to a floor that never existed.
 *
 * The target index itself is guaranteed by the fold and is not re-checked.
 */
function assertSelectPreState(
  session: HostSessionLog,
  data: Extract<BodyEventData, { op: 'select' }>,
  eventSeq: number,
): void {
  const before = foldBefore(session, data.groupId, eventSeq)
  if (before === undefined) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${eventSeq} select for group '${data.groupId}' has no candidate before its watermark`,
    )
  }
  if (!hasAssistantMessage(session, before.anchorMessageId, eventSeq - 1)) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${eventSeq} select for group '${data.groupId}' cannot be explained: the pre-event anchor '${before.anchorMessageId}' has no assistant message at or before seq ${eventSeq - 1}`,
    )
  }
}

/**
 * Pre-state guard for a `restore` record.
 *
 * The fold rewrites the anchor to `data.messageId` and the selection to
 * `data.index` itself, so comparing the folded ledger with the record is a
 * tautology, and the index it accepted is already proven to be an existing
 * candidate (`invalid-body-index` otherwise). What the fold never resolves is
 * the restore *copy*: body restore appends a fresh `body-restore-<uuid>`
 * assistant message before writing the record, and only the pre-event log can
 * prove that message exists. A record naming a message the session never
 * carried would rebind the floor anchor to a phantom body and leave the
 * projection without the merged copy it expects.
 *
 * `candidates` / `edits` are append/edit-only in the fold switch, so a restore
 * cannot tamper with another candidate; that half is fold-guaranteed.
 */
function assertRestorePreState(
  session: HostSessionLog,
  data: Extract<BodyEventData, { op: 'restore' }>,
  eventSeq: number,
): void {
  if (!hasAssistantMessage(session, data.messageId, eventSeq - 1)) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `body event seq ${eventSeq} restore for group '${data.groupId}' names '${data.messageId}' at index ${data.index}, but no assistant message before seq ${eventSeq - 1} carries that id`,
    )
  }
}

/* ------------------------- candidate message lookup ------------------------ */

interface ResolvedBodyCandidate {
  readonly at: string
  readonly text: string
  readonly provider?: string
  readonly model?: string
  readonly usage?: BodyJsonlUsage
}

/** Resolve candidate text and provider metadata from the session log. */
function resolveBodyCandidateMessage(
  session: HostSessionLog,
  messageId: string,
  uptoSeq: number,
): ResolvedBodyCandidate {
  let found: BodyProjectionEvent | undefined
  for (const event of sessionEvents(session) as readonly BodyProjectionEvent[]) {
    if (event.type !== 'assistant/message') continue
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > uptoSeq) continue
    const message = plainObjectRecord(event.data)?.['message']
    if (plainObjectRecord(message)?.['id'] !== messageId) continue
    if (found === undefined || event.seq >= found.seq) found = event
  }
  if (found === undefined) {
    throw new BodyLedgerError(
      'body-candidate-message-missing',
      `body candidate '${messageId}' has no assistant/message at or before seq ${uptoSeq}`,
    )
  }

  const message = plainObjectRecord(plainObjectRecord(found.data)?.['message'])
  const source = message === undefined ? undefined : plainObjectRecord(message['source'])
  const text = messageText(message?.['content'])
  if (text === '') {
    throw new BodyJsonlProjectionError(
      'invalid-body-text',
      `body candidate '${messageId}' assistant message at seq ${found.seq} has no text`,
    )
  }
  const provider = nonEmptyStringOf(source?.['provider'])
  const model = nonEmptyStringOf(source?.['model'])
  const usage = bodyUsage(plainObjectRecord(found.data)?.['usage'], found.seq)
  return {
    at: eventDate(found.time, found.seq, found.type),
    text,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(usage === undefined ? {} : { usage }),
  }
}

/* --------------------------------- helpers --------------------------------- */

/** Keep numeric usage totals only; host detail objects are not JSONL metadata. */
function bodyUsage(value: unknown, seq: number): BodyJsonlUsage | undefined {
  if (value === undefined) return undefined
  const record = plainObjectRecord(value)
  if (record === undefined) {
    throw new BodyLedgerError('invalid-body-event', `assistant/message at seq ${seq} has non-object usage`)
  }
  const usage: Record<string, number> = {}
  for (const [key, member] of Object.entries(record)) {
    if (typeof member === 'number' && Number.isFinite(member)) usage[key] = member
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

function nonEmptyStringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function plainObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** Largest millisecond value a `Date` can represent (±100,000,000 days). */
const MAX_DATE_MILLISECONDS = 8.64e15

/**
 * ISO timestamp of a session event.
 *
 * A wall-clock fallback would make replay non-reproducible, so an unusable
 * event time is a hard error instead.
 */
function eventDate(time: number, seq: number, type: string): string {
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_DATE_MILLISECONDS) {
    throw new BodyLedgerError(
      'invalid-body-event',
      `session event '${type}' at seq ${seq} has unusable time ${String(time)}; expected a non-negative safe integer within the Date range`,
    )
  }
  return new Date(time).toISOString()
}
