/**
 * AgentTavern body write rollback port (proposal 0022 §5, §8, §9, §10).
 *
 * Public facade: `prepare` / `restore` / `commit` orchestration, chat and
 * binding reads, plan validation and the factory. The journal engine lives in
 * `body-rollback-journal.ts` / `body-rollback-writes.ts`; the MVU receipt split
 * lives in `body-rollback-receipts.ts`. Shared public types live in
 * `body-rollback-support.ts` and are re-exported here so existing imports keep
 * the same path.
 */

import type { CharacterCardIR, ChatLogIR } from '../../../tavern-format/src/index.js'
import { ChatRevisionConflictError } from '../../../tavern-store/src/index.js'
import {
  BodyRollbackError,
  errorMessage,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  log,
  readAgentTavernBinding,
  requireNonEmptyString,
  requireNonNegativeInteger,
  type BodyRollbackBinding,
  type BodyRollbackErrorCode,
  type BodyRollbackPlan,
  type BodyRollbackStage,
  type BodyRollbackStore,
  type BodyRollbackUnsafeDetail,
  type BodyWriteRollbackDeps,
  type BodyWriteRollbackPort,
} from './body-rollback-support.js'
import {
  applyJournalWrites,
  compensateJournal,
  type CompensationResult,
  type JournalApplyResult,
} from './body-rollback-writes.js'
import {
  asJournalError,
  assertJournalCoverage,
  buildJournalDiagnostics,
  loadTurnJournal,
  rollbackTurnWritesImpl,
} from './body-rollback-journal.js'
import {
  applyReceiptRollback,
  assertReceiptCoverage,
  readBodyReceipts,
  type ReceiptRollbackResult,
} from './body-rollback-receipts.js'

export { BodyRollbackError } from './body-rollback-support.js'
export type {
  BodyNewTurnRollback,
  BodyRollbackBinding,
  BodyRollbackDiagnostic,
  BodyRollbackDiagnosticCode,
  BodyRollbackErrorCode,
  BodyRollbackErrorOptions,
  BodyRollbackJournalWrite,
  BodyRollbackLogger,
  BodyRollbackMemoryStore,
  BodyRollbackMemoryVectors,
  BodyRollbackMemoryWrite,
  BodyRollbackPlan,
  BodyRollbackSessionEvents,
  BodyRollbackStage,
  BodyRollbackStore,
  BodyRollbackUnsafeDetail,
  BodyRollbackVariableStore,
  BodyRollbackVariableWrite,
  BodyTurnRollbackFailure,
  BodyTurnRollbackTool,
  BodyWriteRollbackDeps,
  BodyWriteRollbackPort,
} from './body-rollback-support.js'

/* -------------------------------- factory ---------------------------------- */

/** Build the rollback port around injected stores, session events and logging. */
export function createBodyWriteRollbackPort(deps: BodyWriteRollbackDeps): BodyWriteRollbackPort {
  return {
    plan: (agentId: string, turn: number, previousMessageId: string) =>
      planBodyRollback(deps, agentId, turn, previousMessageId),
    apply: (plan: BodyRollbackPlan) => applyBodyRollback(deps, plan),
    prepare: (agentId: string, turn: number, previousMessageId: string) =>
      prepareBodyRollback(deps, agentId, turn, previousMessageId),
    restore: (plan: BodyRollbackPlan) => restoreBodyRollback(deps, plan),
    commit: (plan: BodyRollbackPlan): Promise<void> => {
      // Proposal 0022 §5: commit is a no-op for now; journal and receipts stay.
      void plan
      return Promise.resolve()
    },
    rollbackTurnWrites: (agentId: string, turn: number) => rollbackTurnWritesImpl(deps, agentId, turn),
  }
}

/* -------------------------------- prepare ---------------------------------- */

/**
 * `prepare` = `plan` + `apply`, kept for callers that do not need the durable
 * `op-prepare` boundary between the two steps (proposal 0022 §10).
 */
async function prepareBodyRollback(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
  previousMessageId: string,
): Promise<BodyRollbackPlan> {
  const draft = await planBodyRollback(deps, agentId, turn, previousMessageId)
  return applyBodyRollback(deps, draft)
}

/**
 * Read-only half of `prepare`.
 *
 * Everything that can refuse the rollback happens here: binding, card, chat,
 * floor, journal and receipt reads plus the coverage checks. The returned plan
 * is a draft: `preparedRevision` still equals `chatRevision` and no store has
 * been touched, so the caller can persist it before `apply` mutates anything.
 */
async function planBodyRollback(
  deps: BodyWriteRollbackDeps,
  agentId: string,
  turn: number,
  previousMessageId: string,
): Promise<BodyRollbackPlan> {
  requireNonEmptyString(agentId, 'agentId')
  requireNonNegativeInteger(turn, 'turn')
  requireNonEmptyString(previousMessageId, 'previousMessageId')

  const binding = await readAgentTavernBinding(deps.store, agentId)
  await readCard(deps.store, binding.character, agentId, turn)
  const snapshot = await readChatSnapshot(deps.store, binding, agentId, turn)
  const chat = snapshot.chat
  const floorIndex = locateBodyFloor(chat, previousMessageId)
  if (floorIndex === undefined) {
    throw new BodyRollbackError(
      'body-rollback-target-missing',
      `body rollback for session '${agentId}' turn ${turn} cannot find the JSONL floor of '${previousMessageId}'`,
      { stage: 'prepare', sessionId: agentId, turn },
    )
  }
  const floor = chat.messages[floorIndex]!
  const bodyText = typeof floor.mes === 'string'
    ? floor.mes
    : throwUnsafe('chat-unreadable', `body floor ${floorIndex} has a non-string mes`, agentId, turn)

  const { journal, toolNames } = await loadTurnJournal(deps, agentId, turn)
  const receipts = readBodyReceipts(chat, previousMessageId, floorIndex, agentId, turn)

  assertReceiptCoverage(bodyText, toolNames, receipts, previousMessageId, floorIndex, agentId, turn)
  await assertJournalCoverage(deps, toolNames, journal, agentId, turn)

  const diagnostics = buildJournalDiagnostics(
    journal,
    deps.logger,
    agentId,
    turn,
    deps.memoryVectors !== undefined,
  )

  const plan: BodyRollbackPlan = {
    sessionId: agentId,
    turn,
    previousMessageId,
    binding,
    floorIndex,
    bodyText,
    chatRevision: snapshot.revision,
    // The draft has not rolled anything back yet.
    preparedRevision: snapshot.revision,
    journal: journal.writes,
    mvuReceipts: structuredClone(receipts),
    diagnostics,
    preparedAt: new Date().toISOString(),
  }
  log(deps.logger, 'info', 'dsh-soulmojito body rollback: planned', {
    sessionId: agentId,
    turn,
    previousMessageId,
    floorIndex,
    journalWrites: plan.journal.length,
    mvuReceipts: plan.mvuReceipts.length,
    chatRevision: plan.chatRevision,
  })
  return plan
}

/**
 * Mutating half of `prepare`.
 *
 * The plan must be applied to the chat revision it was built from: a foreign
 * save between `plan` and `apply` means the journal, receipts and chat can no
 * longer be rolled back as one unit, so this refuses before touching a store.
 */
async function applyBodyRollback(deps: BodyWriteRollbackDeps, plan: BodyRollbackPlan): Promise<BodyRollbackPlan> {
  requirePlan(plan, 'apply')
  const snapshot = await readPlanChatSnapshot(deps.store, plan, 'apply')
  if (snapshot.revision !== plan.chatRevision) {
    throw new BodyRollbackError(
      'body-rollback-conflict',
      `body rollback apply for session '${plan.sessionId}' turn ${plan.turn} refused: chat '${plan.binding.chatId}' of '${plan.binding.character}' is at revision '${snapshot.revision}', but the plan was built at '${plan.chatRevision}'`,
      { stage: 'chat-save', sessionId: plan.sessionId, turn: plan.turn },
    )
  }
  const chat = snapshot.chat

  let appliedJournal: JournalApplyResult
  try {
    appliedJournal = await applyJournalWrites(deps, plan.journal, 'undo')
  } catch (error) {
    const compensation = await compensateJournal(deps, plan.journal, 'replay')
    throw asJournalError(error, plan.sessionId, plan.turn, compensation)
  }

  let rolledBack: ReceiptRollbackResult
  try {
    rolledBack = await applyReceiptRollback(deps, chat, plan.mvuReceipts, 'undo', plan.binding)
  } catch (error) {
    const compensation = await compensateJournal(deps, plan.journal, 'replay')
    throw receiptUndoError(error, plan.sessionId, plan.turn, compensation)
  }

  let preparedRevision = snapshot.revision
  if (rolledBack.bodyReceipts + rolledBack.settleReceipts > 0) {
    try {
      preparedRevision = await deps.store.saveChat(plan.binding.character, plan.binding.chatId, chat, snapshot.revision)
    } catch (error) {
      const compensation = await compensateJournal(deps, plan.journal, 'replay')
      const code: BodyRollbackErrorCode = compensation.ok
        ? error instanceof ChatRevisionConflictError
          ? 'body-rollback-conflict'
          : 'body-rollback-save-failed'
        : 'body-rollback-partial'
      throw new BodyRollbackError(
        code,
        `body rollback for session '${plan.sessionId}' turn ${plan.turn} could not save the rolled-back chat: ${errorMessage(error)}${compensation.note}`,
        {
          stage: 'chat-save',
          sessionId: plan.sessionId,
          turn: plan.turn,
          compensated: compensation.ok,
          cause: error,
        },
      )
    }
  }

  const applied: BodyRollbackPlan = {
    ...plan,
    preparedRevision,
    diagnostics: [...plan.diagnostics, ...appliedJournal.diagnostics],
  }
  log(deps.logger, 'info', 'dsh-soulmojito body rollback: prepared', {
    sessionId: plan.sessionId,
    turn: plan.turn,
    previousMessageId: plan.previousMessageId,
    floorIndex: plan.floorIndex,
    journalWrites: applied.journal.length,
    mvuReceipts: applied.mvuReceipts.length,
    bodyReceipts: rolledBack.bodyReceipts,
    settleReceipts: rolledBack.settleReceipts,
    chatRevision: applied.chatRevision,
    preparedRevision: applied.preparedRevision,
  })
  return applied
}

/* --------------------------------- restore --------------------------------- */

async function restoreBodyRollback(deps: BodyWriteRollbackDeps, plan: BodyRollbackPlan): Promise<void> {
  requirePlan(plan, 'restore')
  const snapshot = await readPlanChatSnapshot(deps.store, plan, 'restore')
  const chat = snapshot.chat

  let appliedJournal: JournalApplyResult
  try {
    appliedJournal = await applyJournalWrites(deps, plan.journal, 'replay')
  } catch (error) {
    const compensation = await compensateJournal(deps, plan.journal, 'undo')
    throw restoreError(error, 'journal-replay', plan, compensation)
  }

  let redone: ReceiptRollbackResult
  try {
    redone = await applyReceiptRollback(deps, chat, plan.mvuReceipts, 'redo', plan.binding)
  } catch (error) {
    const compensation = await compensateJournal(deps, plan.journal, 'undo')
    throw restoreError(error, 'mvu-redo', plan, compensation)
  }

  if (redone.bodyReceipts + redone.settleReceipts > 0) {
    try {
      await deps.store.saveChat(plan.binding.character, plan.binding.chatId, chat, snapshot.revision)
    } catch (error) {
      const compensation = await compensateJournal(deps, plan.journal, 'undo')
      throw restoreError(error, 'chat-save', plan, compensation)
    }
  }

  log(deps.logger, 'info', 'dsh-soulmojito body rollback: restored', {
    sessionId: plan.sessionId,
    turn: plan.turn,
    previousMessageId: plan.previousMessageId,
    journalWrites: plan.journal.length,
    bodyReceipts: redone.bodyReceipts,
    settleReceipts: redone.settleReceipts,
    vectorSyncFailures: appliedJournal.diagnostics.length,
  })
}

function restoreError(
  error: unknown,
  stage: BodyRollbackStage,
  plan: BodyRollbackPlan,
  compensation: CompensationResult,
): BodyRollbackError {
  if (error instanceof BodyRollbackError) {
    return new BodyRollbackError(
      compensation.ok ? error.code : 'body-rollback-partial',
      `${error.message}${compensation.note}`,
      {
        ...(error.detail === undefined ? {} : { detail: error.detail }),
        stage: error.stage ?? stage,
        sessionId: error.sessionId ?? plan.sessionId,
        turn: error.turn ?? plan.turn,
        ...(error.journalId === undefined ? {} : { journalId: error.journalId }),
        compensated: compensation.ok,
        cause: error,
      },
    )
  }
  const code: BodyRollbackErrorCode = compensation.ok
    ? error instanceof ChatRevisionConflictError
      ? 'body-rollback-conflict'
      : 'body-rollback-failed'
    : 'body-rollback-partial'
  return new BodyRollbackError(
    code,
    `body rollback restore for session '${plan.sessionId}' turn ${plan.turn} failed at ${stage}: ${errorMessage(error)}${compensation.note}`,
    { stage, sessionId: plan.sessionId, turn: plan.turn, compensated: compensation.ok, cause: error },
  )
}

function receiptUndoError(
  error: unknown,
  agentId: string,
  turn: number,
  compensation: CompensationResult,
): BodyRollbackError {
  const code: BodyRollbackErrorCode = compensation.ok
    ? error instanceof BodyRollbackError
      ? error.code
      : 'body-rollback-failed'
    : 'body-rollback-partial'
  return new BodyRollbackError(
    code,
    `body rollback for session '${agentId}' turn ${turn} could not undo the body/settle receipts: ${errorMessage(error)}${compensation.note}`,
    {
      ...(error instanceof BodyRollbackError && error.detail !== undefined ? { detail: error.detail } : {}),
      stage: error instanceof BodyRollbackError && error.stage !== undefined ? error.stage : 'mvu-undo',
      sessionId: agentId,
      turn,
      ...(error instanceof BodyRollbackError && error.journalId !== undefined ? { journalId: error.journalId } : {}),
      compensated: compensation.ok,
      cause: error,
    },
  )
}

/* ------------------------------ chat / binding ----------------------------- */

async function readCard(
  store: BodyRollbackStore,
  character: string,
  agentId: string,
  turn: number,
): Promise<{ card: CharacterCardIR }> {
  let found: { card: CharacterCardIR } | undefined
  try {
    found = await store.getCharacter(character)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback cannot read character card '${character}': ${errorMessage(error)}`,
      { detail: 'card-unreadable', stage: 'prepare', sessionId: agentId, turn, cause: error },
    )
  }
  if (found === undefined) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback requires the character card '${character}', but the store has none`,
      { detail: 'card-unreadable', stage: 'prepare', sessionId: agentId, turn },
    )
  }
  return found
}

async function readChatSnapshot(
  store: BodyRollbackStore,
  binding: BodyRollbackBinding,
  agentId: string,
  turn: number,
): Promise<{ chat: ChatLogIR; revision: string }> {
  let snapshot: { chat: ChatLogIR; revision: string } | undefined
  try {
    snapshot = await store.getChatSnapshot(binding.character, binding.chatId)
  } catch (error) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback cannot read chat '${binding.chatId}' of '${binding.character}': ${errorMessage(error)}`,
      { detail: 'chat-unreadable', stage: 'prepare', sessionId: agentId, turn, cause: error },
    )
  }
  if (snapshot === undefined) {
    throw new BodyRollbackError(
      'body-state-unsafe',
      `body rollback chat '${binding.chatId}' of '${binding.character}' does not exist`,
      { detail: 'chat-unreadable', stage: 'prepare', sessionId: agentId, turn },
    )
  }
  return snapshot
}

async function readPlanChatSnapshot(
  store: BodyRollbackStore,
  plan: BodyRollbackPlan,
  operation: 'apply' | 'restore',
): Promise<{ chat: ChatLogIR; revision: string }> {
  let snapshot: { chat: ChatLogIR; revision: string } | undefined
  try {
    snapshot = await store.getChatSnapshot(plan.binding.character, plan.binding.chatId)
  } catch (error) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback ${operation} cannot read chat '${plan.binding.chatId}' of '${plan.binding.character}': ${errorMessage(error)}`,
      { stage: operation === 'restore' ? 'restore' : 'prepare', sessionId: plan.sessionId, turn: plan.turn, cause: error },
    )
  }
  if (snapshot === undefined) {
    throw new BodyRollbackError(
      'body-rollback-failed',
      `body rollback ${operation} chat '${plan.binding.chatId}' of '${plan.binding.character}' does not exist`,
      { stage: operation === 'restore' ? 'restore' : 'prepare', sessionId: plan.sessionId, turn: plan.turn },
    )
  }
  return snapshot
}

function locateBodyFloor(chat: ChatLogIR, messageId: string): number | undefined {
  for (const [index, message] of chat.messages.entries()) {
    const extra = message.extra
    const tavern = isRecord(extra) ? extra['agentTavern'] : undefined
    if (!isRecord(tavern)) continue
    if (tavern['messageId'] === messageId
      || tavern['anchorMessageId'] === messageId
      || tavern['bodyGroupId'] === messageId) {
      return index
    }
  }
  return undefined
}


function throwUnsafe(
  detail: BodyRollbackUnsafeDetail,
  message: string,
  agentId: string,
  turn: number,
): never {
  throw new BodyRollbackError('body-state-unsafe', message, {
    detail,
    stage: 'prepare',
    sessionId: agentId,
    turn,
  })
}

/* ------------------------------- validation -------------------------------- */

function requirePlan(plan: BodyRollbackPlan, operation: 'apply' | 'restore'): void {
  const value: unknown = plan
  if (!isRecord(value)) throw invalidPlan(operation, 'plan must be an object')
  if (!isNonEmptyString(value['sessionId'])) throw invalidPlan(operation, 'plan.sessionId must be a non-empty string')
  if (!isNonNegativeInteger(value['turn'])) throw invalidPlan(operation, 'plan.turn must be a non-negative safe integer')
  if (!isNonEmptyString(value['previousMessageId'])) throw invalidPlan(operation, 'plan.previousMessageId must be a non-empty string')
  if (!Array.isArray(value['journal'])) throw invalidPlan(operation, 'plan.journal must be an array')
  if (!Array.isArray(value['mvuReceipts'])) throw invalidPlan(operation, 'plan.mvuReceipts must be an array')
  const binding = value['binding']
  if (!isRecord(binding)
    || !isNonEmptyString(binding['character'])
    || !isNonEmptyString(binding['chatId'])) {
    throw invalidPlan(operation, 'plan.binding must carry character and chatId')
  }
}

function invalidPlan(operation: 'apply' | 'restore', detail: string): BodyRollbackError {
  return new BodyRollbackError('invalid-arguments', `body rollback ${operation} rejected: ${detail}`, {
    stage: operation === 'restore' ? 'restore' : 'prepare',
  })
}
