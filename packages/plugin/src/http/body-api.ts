// AgentTavern body routes lifted out of `handleApi`: `GET body` display
// reads, `PUT body` edits, `POST body/regenerate` and `POST body/select`.
// The runtime owns the per-session mutation lock; this module only maps the
// HTTP request onto it.

import type { ChatLogIR, RegexScriptIR } from '../../../tavern-format/src/index.js'
import type { TavernStore } from '../../../tavern-store/src/index.js'
import { BodyJsonlProjectionError, locateBodyFloorForRead } from '../agent-tavern/body-jsonl.js'
import { applyBodyEdit, bodyRuntimeError, selectBodyCandidate, startRegenerate } from '../agent-tavern/body-runtime.js'
import { createBodySessionFactsSource, errorMessage } from '../agent-tavern/body-session.js'
import { IM_BODY_MUTATION_DISABLED_CODE, bodyEditDetailOf, imBodyMutationDisabledOf } from '../agent-tavern/body-view.js'
import {
  bodyBindingEligible,
  bodyFailureOf,
  bodyHistoricalMvuStateOf,
  bodyMutationSafetyOf,
  bodyStateSafetyOf,
  bodyStateUnsafeMessage,
  bodyWiringContext,
  buildBodyView,
  createBodyDeps,
  pendingOperationOf,
  resolveBodyBinding,
  resolveLiveAgent,
  retryPendingBodyRecovery,
  type BodyMutationAction,
  type BodyProjectedFloor,
  type BodyStateSafety,
  type BodyStateUnsafeDetail,
  type BodyView,
} from '../agent-tavern/body-wiring.js'
import { stripFrontendDocuments } from '../frontend-documents.js'
import type { PluginContext } from '../host-contract.js'
import { displayTextForMessage } from '../prompt-context.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { asRecord } from './json-records.js'

/**
 * AgentTavern body routes (proposal 0021 §7.3).
 *
 * GET never throws for missing projection: a cold or not-yet-projected session
 * gets the stable empty body so the native row still renders. Mutations reject
 * with the proposal §11 code and the HTTP status mapped by `bodyFailureOf`.
 * The runtime functions own the per-session mutation lock; taking a second
 * `withBodyLock` here would deadlock the same key.
 */
export async function handleAgentTavernBodyApi(
  ctx: PluginContext,
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  route: string,
  method: string,
): Promise<void> {
  const wiring = bodyWiringContext(ctx, async (sessionId) => (await db.getState()).sessionBindings[sessionId])

  if (method === 'GET') {
    const sessionId = url.searchParams.get('sessionId')
    if (sessionId === null || sessionId === '') {
      throw new HttpError(400, 'sessionId and messageId (or messageIds) are required')
    }
    const selector = parseBodyGetSelector(url.searchParams)

    const state = await db.getState()
    const binding = state.sessionBindings[sessionId]
    // Binding-based, not preset-based: an IM peer keeps receiving this
    // session's replies even after the user switches the preset back to a
    // non-IM one, so body surgery stays closed while the peer binding exists.
    const mutationsDisabledReason = imBodyMutationDisabledOf(binding, sessionId, state.imPeers)
    let characterName: string | undefined
    let chatId: string | undefined
    let character: Awaited<ReturnType<TavernStore['getCharacter']>> = undefined
    let chat: ChatLogIR | undefined
    if (binding !== undefined && bodyBindingEligible(binding)) {
      characterName = binding.character
      chatId = binding.chatId
      character = await db.getCharacter(binding.character)
      chat = (await db.getChatSnapshot(binding.character, binding.chatId))?.chat
    }
    const stateSafety: BodyStateSafety | undefined = binding === undefined || !bodyBindingEligible(binding)
      ? undefined
      : bodyStateSafetyOf(character, chat)
    const historicalMvuState = character !== undefined && chat !== undefined
      && bodyHistoricalMvuStateOf(character, chat)
    const agent = resolveLiveAgent(wiring, sessionId)
    const deps = agent === undefined ? undefined : await createBodyDeps(wiring, agent)
    const session = agent?.session
    // One parsed session log and one memoized ledger fold per group serve every
    // message id of the request: a batch never re-reads the chat and never folds
    // the same group twice, no matter how many rows it carries.
    const factsSource = session === undefined ? undefined : createBodySessionFactsSource(session)
    // Display scripts need one JSR overlay read. Resolve them lazily so a cold
    // session without a projected floor still skips that read.
    let scriptsRead: Promise<RegexScriptIR[]> | undefined
    const readScripts = (): Promise<RegexScriptIR[]> => {
      if (characterName === undefined || chatId === undefined) {
        throw new Error('body floor display scripts require a character and chat id')
      }
      scriptsRead ??= collectSessionRegexScripts(db, state, characterName, chatId, character)
      return scriptsRead
    }
    const readFloorOf = async (
      messageId: string,
      groupIdHint: string | undefined,
      selectedIndexHint: number | undefined,
    ): Promise<ProjectedBodyFloorRead | undefined> => characterName === undefined || chatId === undefined || chat === undefined
      ? undefined
      : projectedBodyFloor(chat, messageId, groupIdHint, selectedIndexHint, readScripts)
    /** Stable empty body for an item that cannot be assembled at all. */
    const stableViewOf = (messageId: string): BodyView => buildBodyView({
      messageId,
      binding,
      agent,
      hostSupported: deps !== undefined,
      stateSafety,
      historicalMvuState,
      writeRollbackAvailable: deps?.writeRollback !== undefined,
      ledger: undefined,
      messageText: undefined,
      projected: undefined,
      projectionCurrent: false,
      projectionTextCurrent: false,
      inspection: undefined,
      ...(mutationsDisabledReason === undefined ? {} : { mutationsDisabledReason }),
    })

    /**
     * Assemble one `GET body` item.
     *
     * A damaged floor binding degrades the row (ledger body + detail) instead of
     * failing the request. An unexpected failure is returned to the caller so
     * the single-id route keeps its original error while a batch degrades only
     * that item and keeps serving the rest.
     */
    const readBodyItem = async (messageId: string): Promise<BodyGetItemRead> => {
      try {
        // Fast path: the floor names the group, so the ledger folds one group only.
        const floorRead = await readFloorOf(messageId, undefined, undefined)
        const floorByMessage = floorRead?.ok === true ? floorRead.floor : undefined
        const facts = factsSource?.factsOf(messageId, floorByMessage?.groupId)
        const ledger = facts?.ledger
        // A candidate switch leaves the floor on the previous anchor; re-resolve it
        // by the ledger's group so `swipes[selectedIndex]` still carries the text.
        const selectionMoved = ledger !== undefined
          && (floorByMessage === undefined
            || floorByMessage.anchorMessageId !== ledger.anchorMessageId
            || floorByMessage.selectedIndex !== ledger.selectedIndex)
        const reread = selectionMoved
          ? await readFloorOf(messageId, ledger.groupId, ledger.selectedIndex)
          : undefined
        const projected = reread === undefined
          ? floorByMessage
          : reread.ok
            ? reread.floor
            : undefined
        // An ambiguous floor binding is damaged data, not an exception: keep the
        // stable ledger body and publish the code instead of turning the row into
        // a 500. A later group-hinted reread that succeeds clears the degradation
        // for this row — the ledger's group resolved exactly one floor, so the
        // row is servable and must not stay pinned on `projectionPending`.
        const floorDegradation = reread !== undefined
          ? reread.ok ? undefined : reread.degradation
          : floorRead !== undefined && !floorRead.ok
            ? floorRead.degradation
            : undefined
        const messageText = facts?.messageText
        const inspection = facts?.inspection
        const latestEditSeq = facts?.latestEditSeq
        if (facts?.ledgerError !== undefined) {
          ctx.logger?.warn?.('dsh-soulmojito body: ledger fold failed for GET body', {
            sessionId,
            messageId,
            error: facts.ledgerError,
          })
        }
        if (floorDegradation !== undefined) {
          ctx.logger?.warn?.('dsh-soulmojito body: body floor binding is ambiguous for GET body', {
            sessionId,
            messageId,
            code: floorDegradation.detail,
            error: floorDegradation.message,
          })
        }

        const projection = floorDegradation === undefined
          ? bodyProjectionState(projected, ledger, latestEditSeq)
          : { current: false, textCurrent: false }

        // Proposal 0023 §6.3: publish the receipt verdict the `PUT` preflight will
        // enforce, so edit is not offered for a candidate the runtime would refuse.
        // A missing ledger, card or chat snapshot keeps the 0021 optimistic answer.
        const editDetail = character === undefined || chat === undefined || ledger === undefined
          ? undefined
          : bodyEditDetailOf(character.card, chat, ledger)

        const view = buildBodyView({
          messageId,
          binding,
          agent,
          hostSupported: deps !== undefined,
          stateSafety,
          historicalMvuState,
          writeRollbackAvailable: deps?.writeRollback !== undefined,
          ledger,
          messageText,
          projected,
          projectionCurrent: projection.current,
          projectionTextCurrent: projection.textCurrent,
          inspection,
          editDetail,
          // A damaged floor binding closes edit with its own detail and keeps
          // publishing it even when a reason already gates the row.
          ...(floorDegradation === undefined ? {} : { readDetail: floorDegradation.detail }),
          ...(facts?.lastOperation === undefined ? {} : { lastOperation: facts.lastOperation }),
          ...(mutationsDisabledReason === undefined ? {} : { mutationsDisabledReason }),
        })
        return { ok: true, view }
      } catch (error) {
        // GET must not turn one damaged row into a 500. The single-id route
        // rethrows the original error; a batch keeps a stable body for it.
        ctx.logger?.warn?.('dsh-soulmojito body: GET body item failed', {
          sessionId,
          messageId,
          error: errorMessage(error),
        })
        return { ok: false, view: stableViewOf(messageId), error }
      }
    }

    if (selector.kind === 'batch') {
      const items = new Map<string, BodyView>()
      for (const messageId of selector.messageIds) {
        items.set(messageId, (await readBodyItem(messageId)).view)
      }
      // `fromEntries` defines own properties, so an id like `__proto__` cannot
      // rewrite the response prototype.
      return sendJson(res, 200, { ok: true, items: Object.fromEntries(items) })
    }
    const item = await readBodyItem(selector.messageId)
    if (!item.ok) throw item.error
    return sendJson(res, 200, item.view)
  }

  const body = await readJson(req)
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') {
    return sendBodyFailure(res, { status: 400, code: 'invalid-arguments', message: 'sessionId is required' })
  }
  const binding = await resolveBodyBinding(wiring, sessionId)
  if (binding === undefined || !bodyBindingEligible(binding)) {
    return sendBodyFailure(res, {
      status: 409,
      code: 'architecture-mismatch',
      message: 'body operations require an AgentTavern single-character binding',
    })
  }
  // IM-bound sessions deliver replies through `im_send`, so there is no body
  // ledger to edit, regenerate or switch. Reject before reading the card or
  // touching the runtime; the peer id stays server-side.
  const mutationsDisabledReason = imBodyMutationDisabledOf(binding, sessionId, (await db.getState()).imPeers)
  if (mutationsDisabledReason !== undefined) {
    return sendBodyFailure(res, {
      status: 409,
      code: IM_BODY_MUTATION_DISABLED_CODE,
      message: mutationsDisabledReason,
    })
  }
  const characterName = binding.character
  const chatId = binding.chatId
  if (characterName === undefined || chatId === undefined) {
    return sendBodyFailure(res, {
      status: 409,
      code: 'body-state-unsafe',
      message: bodyStateUnsafeMessage('chat-unreadable'),
      detail: 'chat-unreadable',
    })
  }
  // Proposal 0023 §6: readability still rejects early, and P0 keeps candidate
  // switching closed with `candidate-switch-disabled`. Editing no longer has a
  // blanket historical-MVU refusal: the runtime's candidate-receipt preflight
  // decides after the live agent and ledger are known, and its detail reaches
  // this response through `bodyFailureOf`.
  const action: BodyMutationAction = route === 'body'
    ? 'edit'
    : route === 'body/select'
      ? 'select'
      : 'regenerate'
  const character = await db.getCharacter(characterName)
  const snapshot = await db.getChatSnapshot(characterName, chatId)
  const stateSafety: BodyStateSafety = bodyMutationSafetyOf(action, character, snapshot?.chat)
  if (!stateSafety.safe) {
    return sendBodyFailure(res, {
      status: 409,
      code: stateSafety.reason,
      message: bodyStateUnsafeMessage(stateSafety.detail),
      detail: stateSafety.detail,
    })
  }
  const agent = resolveLiveAgent(wiring, sessionId)
  if (agent === undefined) {
    return sendBodyFailure(res, {
      status: 409,
      code: 'session-busy',
      message: `session '${sessionId}' has no live agent in this host process; open the chat and retry`,
    })
  }
  const deps = await createBodyDeps(wiring, agent)
  if (deps === undefined) {
    return sendBodyFailure(res, {
      status: 501,
      code: 'host-unsupported',
      message: 'this host does not expose appendPluginRecord/pluginRecordOf (DSH 0.2.1-rc.2+)',
    })
  }
  if (action === 'regenerate'
    && deps.writeRollback === undefined
    && snapshot !== undefined
    && bodyHistoricalMvuStateOf(character, snapshot.chat)) {
    return sendBodyFailure(res, {
      status: 409,
      code: 'body-state-unsafe',
      message: bodyStateUnsafeMessage('write-journal-unavailable'),
      detail: 'write-journal-unavailable',
    })
  }

  try {
    const groupId = bodyString(body, 'groupId') ?? bodyString(body, 'messageId')
    if (groupId === undefined) throw bodyRuntimeError('invalid-arguments', 'groupId or messageId is required')
    const expectedAnchorId = bodyString(body, 'expectedAnchorId') ?? groupId

    if (route === 'body') {
      const index = bodyIndex(body, 'index')
      if (typeof body.text !== 'string') {
        throw bodyRuntimeError('invalid-body-text', 'body edit requires a string text')
      }
      const state = await applyBodyEdit(deps, { groupId, index, text: body.text, expectedAnchorId })
      return sendJson(res, 200, { ok: true, state })
    }

    if (route === 'body/regenerate') {
      const expectedIndex = bodyIndex(body, 'expectedIndex')
      const feedback = typeof body.feedback === 'string' ? body.feedback : undefined
      const result = await startRegenerate(deps, {
        groupId,
        expectedAnchorId,
        expectedIndex,
        ...(feedback === undefined ? {} : { feedback }),
      })
      // The turn settles asynchronously from agent/turn-stopping; the client
      // polls GET body and unlocks when count/selectedIndex change.
      return sendJson(res, 202, { ok: true, opId: result.opId, status: 'pending' })
    }

    const index = bodyIndex(body, 'index')
    const state = await selectBodyCandidate(deps, { groupId, index, expectedAnchorId })
    return sendJson(res, 200, { ok: true, state })
  } catch (error) {
    // Review M4: a start failure whose compensation could not restore the
    // writes leaves the session locked until restart. Hand the locked op to the
    // shared recovery once here; a still-locked failure surfaces its durable
    // handle instead of hiding the lock behind a bare 500.
    const pending = pendingOperationOf(error)
    const recovered = pending === undefined
      || await retryPendingBodyRecovery(wiring, agent, pending)
    return sendBodyFailure(
      res,
      bodyFailureOf(error),
      recovered || pending === undefined ? undefined : { opId: pending.opId, status: 'pending' },
    )
  }
}

function sendBodyFailure(
  res: HttpResponse,
  failure: { readonly status: number; readonly code: string; readonly message: string; readonly detail?: string },
  pendingOperation?: { readonly opId: string; readonly status: string },
): void {
  sendJson(res, failure.status, {
    ok: false,
    code: failure.code,
    message: failure.message,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(pendingOperation === undefined ? {} : { pendingOperation }),
  })
}

function bodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function bodyIndex(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw bodyRuntimeError('invalid-arguments', `${field} must be a non-negative safe integer`)
  }
  return value
}

/**
 * Resolve the JSONL floor for one native message id and return its display
 * layer facts. Text already carries markdownOnly regex scripts, matching the
 * existing `/display` route; the body ledger stays the fallback when a floor
 * has not been projected yet.
 *
 * The floor is resolved through `locateBodyFloorForRead`, so a group bound to
 * more than one chat floor degrades to a typed read failure instead of serving
 * the first floor. The caller keeps the response stable and logs the detail.
 * `readScripts` is memoized by the caller, so a batch pays one overlay read.
 */
async function projectedBodyFloor(
  chat: ChatLogIR,
  messageId: string,
  groupIdHint: string | undefined,
  selectedIndexHint: number | undefined,
  readScripts: () => Promise<RegexScriptIR[]>,
): Promise<ProjectedBodyFloorRead> {
  let index: number | undefined
  try {
    index = locateBodyFloorForRead(chat, {
      messageId,
      ...(groupIdHint === undefined ? {} : { groupId: groupIdHint }),
    })
  } catch (error) {
    // A duplicated group binding is damaged data, not an exception: degrade the
    // row and let a batch keep serving its other items.
    return { ok: false, degradation: bodyFloorDegradationOf(error) }
  }
  if (index === undefined) return { ok: true, floor: undefined }

  const floor = chat.messages[index]!
  const tavern = asRecord(asRecord(floor.extra)?.['agentTavern'])
  const scripts = await readScripts()
  // The floor's `mes` follows its own `swipe_id`; the ledger may already select
  // another slot. Reading `swipes[selectedIndex]` keeps the save-layer regex
  // applied to the selected candidate even before the projector catches up.
  // A missing slot means the candidate itself is not projected yet: returning
  // the floor's `mes` would show the previous anchor's text, so omit `text` and
  // let the view fall back to the ledger.
  const selectedSwipe = selectedIndexHint === undefined
    ? floor
    : Array.isArray(floor.swipes) && typeof floor.swipes[selectedIndexHint] === 'string'
      ? { ...floor, mes: floor.swipes[selectedIndexHint] }
      : undefined
  const text = selectedSwipe === undefined
    ? undefined
    : stripFrontendDocuments(displayTextForMessage(scripts, selectedSwipe, chat.messages.length - 1 - index))
  const selectedIndex = floor.swipe_id
  const count = Array.isArray(floor.swipes) && floor.swipes.length > 0 ? floor.swipes.length : 1

  const resolved: BodyProjectedFloor = {
    ...(typeof tavern?.['bodyGroupId'] === 'string' ? { groupId: tavern['bodyGroupId'] } : {}),
    ...(typeof tavern?.['anchorMessageId'] === 'string' ? { anchorMessageId: tavern['anchorMessageId'] } : {}),
    ...(typeof selectedIndex === 'number' && Number.isSafeInteger(selectedIndex) ? { selectedIndex } : {}),
    ...(typeof tavern?.['lastBodyEventSeq'] === 'number'
      && Number.isSafeInteger(tavern['lastBodyEventSeq'])
      && tavern['lastBodyEventSeq'] >= 0
      ? { lastBodyEventSeq: tavern['lastBodyEventSeq'] as number }
      : {}),
    count,
    ...(text === undefined ? {} : { text }),
  }
  return { ok: true, floor: resolved }
}

/** Read-side degradation of a floor lookup; the row keeps the ledger body. */
interface BodyFloorDegradation {
  readonly detail: BodyStateUnsafeDetail
  readonly message: string
}

/** Map a floor-lookup failure onto the read-side detail vocabulary. */
function bodyFloorDegradationOf(error: unknown): BodyFloorDegradation {
  if (error instanceof BodyJsonlProjectionError && error.code === 'body-group-mismatch') {
    return { detail: error.code, message: error.message }
  }
  return {
    detail: 'body-floor-unreadable',
    message: `body floor lookup failed: ${errorMessage(error)}`,
  }
}

/** `GET body` floor lookup: a degraded read never throws. */
type ProjectedBodyFloorRead =
  | { readonly ok: true; readonly floor: BodyProjectedFloor | undefined }
  | { readonly ok: false; readonly degradation: BodyFloorDegradation }

/** One `GET body` item: the view, plus the original error a batch degrades. */
type BodyGetItemRead =
  | { readonly ok: true; readonly view: BodyView }
  | { readonly ok: false; readonly view: BodyView; readonly error: unknown }

/** Upper bound for one batched `GET body` request. */
const BODY_GET_BATCH_LIMIT = 50

/**
 * `GET body` message selector.
 *
 * `messageId` keeps the 0021 single-body response shape; `messageIds` is the
 * batch form the conversation surface uses to read every visible row in one
 * request. The two are never combined: `messageIds` items are de-duplicated in
 * request order before they reach the read path.
 */
type BodyGetSelector =
  | { readonly kind: 'single'; readonly messageId: string }
  | { readonly kind: 'batch'; readonly messageIds: readonly string[] }

function parseBodyGetSelector(params: URLSearchParams): BodyGetSelector {
  const single = params.get('messageId')
  const batch = params.get('messageIds')
  const hasSingle = single !== null && single !== ''
  const hasBatch = batch !== null && batch !== ''

  if (hasSingle && hasBatch) {
    throw new HttpError(400, 'pass either messageId or messageIds, not both')
  }
  if (hasSingle) return { kind: 'single', messageId: single }

  if (!hasBatch) {
    throw new HttpError(400, 'sessionId and messageId (or messageIds) are required')
  }
  const messageIds: string[] = []
  const seen = new Set<string>()
  for (const raw of batch.split(',')) {
    const messageId = raw.trim()
    if (messageId === '') throw new HttpError(400, 'messageIds must not contain empty entries')
    if (seen.has(messageId)) continue
    seen.add(messageId)
    messageIds.push(messageId)
  }
  if (messageIds.length > BODY_GET_BATCH_LIMIT) {
    throw new HttpError(400, `messageIds accepts at most ${BODY_GET_BATCH_LIMIT} ids (got ${messageIds.length})`)
  }
  return { kind: 'batch', messageIds }
}

/**
 * Freshness of the JSONL floor against the ledger.
 *
 * `textCurrent` is false only when the floor's edit watermark is behind, since
 * a stale selection is already served from `swipes[selectedIndex]` (save-layer
 * text). `current` covers both and drives the client's bounded refetch.
 */
function bodyProjectionState(
  projected: BodyProjectedFloor | undefined,
  ledger: { readonly anchorMessageId: string; readonly selectedIndex: number } | undefined,
  latestEditSeq: number | undefined,
): { current: boolean; textCurrent: boolean } {
  if (projected === undefined || ledger === undefined) return { current: true, textCurrent: true }
  const textCurrent = latestEditSeq === undefined
    || (projected.lastBodyEventSeq !== undefined && projected.lastBodyEventSeq >= latestEditSeq)
  const selectionCurrent =
    (projected.anchorMessageId === undefined || projected.anchorMessageId === ledger.anchorMessageId)
    && (projected.selectedIndex === undefined || projected.selectedIndex === ledger.selectedIndex)
  return { current: textCurrent && selectionCurrent, textCurrent }
}
