import { describe, expect, it } from 'vitest'
import type { CharacterCardIR, ChatLogIR, ChatMessage } from '../../tavern-format/src/index.js'
import type { BodyLedger } from '../src/agent-tavern/body.js'
import {
  CandidateReceiptError,
  applyCandidateEditToChat,
  candidatePreserveKeys,
  candidateReceiptKey,
  classifyBodyReceiptKey,
  inspectCandidateReceipts,
  migrateLegacyCandidateReceipts,
  type CandidateReceiptErrorCode,
  type CandidateReceiptRef,
} from '../src/agent-tavern/body-candidate-receipts.js'
import {
  MVU_RECEIPTS_LIMIT,
  mvuReceiptsForBody,
  readMvuReceipts,
  redoMvuReceipts,
  undoMvuReceipts,
  type MvuReceipt,
} from '../src/mvu.js'
import { assertReceiptCoverage } from '../src/agent-tavern/body-rollback-receipts.js'

const CARD = 'Candidate Receipt Character'
const GROUP_ID = 'group-1'
const MESSAGE_ID = 'group-1'
const SEND_DATE = '2026-10-28T00:00:00.000Z'
const AT_ONE = '2026-10-28T00:00:01.000Z'
const AT_TWO = '2026-10-28T00:00:02.000Z'

function cardData(jsrMvu: boolean): CharacterCardIR {
  return {
    spec: 'chara_card_v2',
    specVersion: '2.0',
    data: {
      name: CARD,
      description: '',
      personality: '',
      scenario: '',
      firstMes: '',
      mesExample: '',
      creatorNotes: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      tags: [],
      creator: '',
      characterVersion: '',
      extensions: jsrMvu
        ? { tavern_helper: { scripts: [{ type: 'script', content: "import 'https://example.invalid/MagVarUpdate/bundle.js'" }] } }
        : {},
    },
    raw: {},
  }
}

const mvuCard = cardData(true)
const plainCard = cardData(false)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function baseVariables(favor: number): Record<string, unknown> {
  return { initialized_lorebooks: true, stat_data: { mvu: { favor } } }
}

function mvuChat(text: string, variables: Record<string, unknown>): ChatLogIR {
  return {
    header: { user_name: 'User', character_name: CARD, chat_metadata: { variables } },
    messages: [
      { name: 'User', is_user: true, is_system: false, send_date: SEND_DATE, mes: 'Hello' },
      {
        name: CARD,
        is_user: false,
        is_system: false,
        send_date: SEND_DATE,
        mes: text,
        swipes: [text],
        swipe_id: 0,
        swipe_info: [{ send_date: SEND_DATE, extra: { provider: 'test-provider', model: 'test-model' } }],
        extra: { agentTavern: { bodyGroupId: GROUP_ID, anchorMessageId: MESSAGE_ID } },
      },
    ],
  }
}

function ledgerOf(text: string): BodyLedger {
  return {
    groupId: GROUP_ID,
    candidates: [{ messageId: MESSAGE_ID, index: 0, text }],
    selectedIndex: 0,
    anchorMessageId: MESSAGE_ID,
    edits: new Map(),
  }
}

/** Ledger with one candidate per text; candidate N uses `<groupId>-N` after slot 0. */
function candidateLedgerOf(texts: readonly string[]): BodyLedger {
  return {
    groupId: GROUP_ID,
    candidates: texts.map((text, index) => ({
      messageId: index === 0 ? MESSAGE_ID : `${MESSAGE_ID}-${index}`,
      index,
      text,
    })),
    selectedIndex: 0,
    anchorMessageId: MESSAGE_ID,
    edits: new Map(),
  }
}

/** One body floor carrying every text as a projected swipe. */
function swipeChat(texts: readonly string[], variables: Record<string, unknown>): ChatLogIR {
  const chat = mvuChat(texts[0] ?? '', variables)
  const floor = chat.messages[1]!
  chat.messages[1] = {
    ...floor,
    swipes: [...texts],
    swipe_id: 0,
    swipe_info: texts.map(() => ({ send_date: SEND_DATE, extra: { provider: 'test-provider', model: 'test-model' } })),
  }
  return chat
}

function updateText(narrative: string, delta: number): string {
  return `${narrative}\n<UpdateVariable>\n<JSONPatch>\n[{ "op": "delta", "path": "/mvu/favor", "value": ${delta} }]\n</JSONPatch>\n</UpdateVariable>`
}

function emptyPatchText(narrative: string): string {
  return `${narrative}\n<UpdateVariable>\n<JSONPatch>\n[]\n</JSONPatch>\n</UpdateVariable>`
}

function favorChange(before: number, after: number): MvuReceipt['changes'][number] {
  return { name: 'stat_data.mvu.favor', before, after }
}

function receiptOf(
  turnKey: string,
  at: string,
  changes: MvuReceipt['changes'],
  undoneAt?: string,
): MvuReceipt {
  return {
    at,
    turnKey,
    status: changes.length > 0 ? 'updated' : 'unchanged',
    changes,
    failures: [],
    ...(undoneAt === undefined ? {} : { undoneAt }),
  }
}

function floorOf(chat: ChatLogIR): ChatMessage {
  const floor = chat.messages[1]
  if (floor === undefined) throw new Error('fixture is missing the body floor')
  return floor
}

function statDataOf(message: ChatMessage): unknown {
  const variables = message.variables
  return isRecord(variables) ? variables['stat_data'] : undefined
}

function statFavor(chat: ChatLogIR): unknown {
  const variables = chat.header.chat_metadata.variables
  if (!isRecord(variables)) return undefined
  const stat = variables['stat_data']
  if (!isRecord(stat)) return undefined
  const mvu = stat['mvu']
  return isRecord(mvu) ? mvu['favor'] : undefined
}

function attachReceipts(chat: ChatLogIR, receipts: readonly MvuReceipt[], extra: Record<string, unknown> = {}): void {
  chat.header.chat_metadata.mvu = { ...extra, receipts: [...receipts] }
}

function agentTavernOf(chat: ChatLogIR): Record<string, unknown> {
  const floor = chat.messages[1]
  const extra = floor?.extra
  if (!isRecord(extra) || !isRecord(extra['agentTavern'])) {
    throw new Error('fixture floor has no agentTavern metadata')
  }
  return extra['agentTavern']
}

function expectCandidateError(run: () => unknown, code: CandidateReceiptErrorCode): CandidateReceiptError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(CandidateReceiptError)
    expect((error as CandidateReceiptError).code).toBe(code)
    return error as CandidateReceiptError
  }
  throw new Error(`expected CandidateReceiptError '${code}', but no error was thrown`)
}

function refOf(messageId: string, index: number): CandidateReceiptRef {
  return { messageId, index }
}

describe('candidate receipt keys', () => {
  it('builds canonical keys and rejects unsafe indices', () => {
    expect(candidateReceiptKey('m0', 0)).toBe('body:m0#0')
    expect(candidateReceiptKey('m0', 12)).toBe('body:m0#12')
    expect(() => candidateReceiptKey('a#b', 0)).toThrowError(CandidateReceiptError)

    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expectCandidateError(() => candidateReceiptKey('m0', index), 'body-receipt-key-mismatch')
    }
    expectCandidateError(() => candidateReceiptKey('', 0), 'body-receipt-key-mismatch')
    expectCandidateError(() => candidateReceiptKey(' m0', 0), 'body-receipt-key-mismatch')
    expectCandidateError(() => candidateReceiptKey('m0 ', 0), 'body-receipt-key-mismatch')
    expectCandidateError(() => candidateReceiptKey('m0', 0.5), 'body-receipt-key-mismatch')
  })

  it('classifies candidate, legacy, settle and unknown keys strictly', () => {
    expect(classifyBodyReceiptKey('body:m0#0')).toEqual({ kind: 'candidate', messageId: 'm0', index: 0 })
    expect(classifyBodyReceiptKey('body:m0#12')).toEqual({ kind: 'candidate', messageId: 'm0', index: 12 })
    expect(classifyBodyReceiptKey('body:m0')).toEqual({ kind: 'legacy', messageId: 'm0' })
    expect(classifyBodyReceiptKey('7')).toEqual({ kind: 'settle', floorIndex: 7 })
    expect(classifyBodyReceiptKey('0')).toEqual({ kind: 'settle', floorIndex: 0 })

    const unknown = [
      '',
      '007',
      'settle:7',
      'body:',
      'body:#0',
      'body: m0',
      'body:m0 ',
      'body:m0 #0',
      'body:m0#',
      'body:m0#-1',
      'body:m0#01',
      'body:m0#1.5',
      'body:m0#1#2',
      'body:m0#9007199254740992',
    ]
    for (const turnKey of unknown) {
      expect(classifyBodyReceiptKey(turnKey), turnKey).toEqual({ kind: 'unknown' })
    }
  })

  it('lists every candidate key plus its legacy alias for ring retention', () => {
    const ledger = candidateLedgerOf(['first body', 'second body'])
    expect([...candidatePreserveKeys(ledger)].sort()).toEqual([
      'body:group-1',
      'body:group-1#0',
      'body:group-1-1',
      'body:group-1-1#1',
    ])
  })
})

describe('legacy candidate receipt migration', () => {
  it('rewrites the key only, preserves receipt fields, and is idempotent', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    const legacy = receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)], AT_TWO)
    attachReceipts(chat, [
      legacy,
      receiptOf('body:orphan', AT_ONE, []),
      receiptOf('4', AT_ONE, []),
    ], { note: 'keep-me' })

    const ledger = ledgerOf(oldText)
    const migrated = migrateLegacyCandidateReceipts(chat, ledger)
    expect(migrated).toEqual({ migrated: 1, unmappable: ['body:orphan'] })

    const receipts = readMvuReceipts(chat)
    expect(receipts[0]).toMatchObject({
      turnKey: `body:${MESSAGE_ID}#0`,
      at: AT_ONE,
      status: 'updated',
      undoneAt: AT_TWO,
      changes: [favorChange(10, 15)],
      failures: [],
    })
    expect(receipts[1]).toMatchObject({ turnKey: 'body:orphan' })
    expect(receipts[2]).toMatchObject({ turnKey: '4' })
    const raw = chat.header.chat_metadata.mvu
    expect(isRecord(raw) ? raw['note'] : undefined).toBe('keep-me')

    const afterFirst = structuredClone(chat)
    const again = migrateLegacyCandidateReceipts(chat, ledger)
    expect(again).toEqual({ migrated: 0, unmappable: ['body:orphan'] })
    expect(chat).toEqual(afterFirst)
  })

  it('refuses a ledger that maps one message id to two candidates', () => {
    const chat = mvuChat('body', baseVariables(10))
    attachReceipts(chat, [receiptOf('body:m0', AT_ONE, [])])
    const ledger: BodyLedger = {
      groupId: GROUP_ID,
      candidates: [
        { messageId: 'm0', index: 0, text: 'first' },
        { messageId: 'm0', index: 1, text: 'second' },
      ],
      selectedIndex: 1,
      anchorMessageId: 'm0',
      edits: new Map(),
    }
    expectCandidateError(() => migrateLegacyCandidateReceipts(chat, ledger), 'body-receipt-key-mismatch')
    expect(readMvuReceipts(chat)[0]?.turnKey).toBe('body:m0')
  })

  it('reports an unmappable legacy receipt without deleting it', () => {
    const chat = mvuChat('body', baseVariables(10))
    attachReceipts(chat, [receiptOf('body:orphan', AT_ONE, [])])
    const ledger: BodyLedger = {
      groupId: GROUP_ID,
      candidates: [],
      selectedIndex: -1,
      anchorMessageId: '',
      edits: new Map(),
    }
    expect(migrateLegacyCandidateReceipts(chat, ledger)).toEqual({ migrated: 0, unmappable: ['body:orphan'] })
    expect(readMvuReceipts(chat)[0]?.turnKey).toBe('body:orphan')
  })
})

describe('candidate receipt inspection', () => {
  it('reports missing when the previous body has a patch but no receipt exists', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(10))
    const inspection = inspectCandidateReceipts(chat, refOf(MESSAGE_ID, 0), ledgerOf(oldText), oldText, mvuCard)
    expect(inspection.needsReceipt).toBe(true)
    expect(inspection.live).toEqual([])
    expect(inspection.undone).toEqual([])
    expect(inspection.detail).toBe('body-receipt-missing')
  })

  it('does not require a receipt for a previous body without a patch block', () => {
    const oldText = 'Plain body without a patch.'
    const chat = mvuChat(oldText, baseVariables(10))
    const inspection = inspectCandidateReceipts(chat, refOf(MESSAGE_ID, 0), ledgerOf(oldText), oldText, mvuCard)
    expect(inspection.needsReceipt).toBe(false)
    expect(inspection.detail).toBeUndefined()
  })

  it('reports duplicate only for multiple live receipts with changes', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [
      receiptOf(`body:${MESSAGE_ID}#0`, AT_ONE, [favorChange(10, 15)]),
      receiptOf(`body:${MESSAGE_ID}#0`, AT_TWO, [favorChange(10, 15)]),
    ])
    const inspection = inspectCandidateReceipts(chat, refOf(MESSAGE_ID, 0), ledgerOf(oldText), oldText, mvuCard)
    expect(inspection.live).toHaveLength(2)
    expect(inspection.detail).toBe('body-receipt-duplicate')

    const unchangedChat = mvuChat(oldText, baseVariables(10))
    attachReceipts(unchangedChat, [
      receiptOf(`body:${MESSAGE_ID}#0`, AT_ONE, []),
      receiptOf(`body:${MESSAGE_ID}#0`, AT_TWO, []),
    ])
    const unchanged = inspectCandidateReceipts(
      unchangedChat,
      refOf(MESSAGE_ID, 0),
      ledgerOf(oldText),
      oldText,
      mvuCard,
    )
    expect(unchanged.live).toHaveLength(2)
    expect(unchanged.detail).toBeUndefined()
  })

  it('reports legacy when the ledger cannot map the legacy key', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf('body:orphan', AT_ONE, [favorChange(10, 15)])])
    const ledger: BodyLedger = {
      groupId: GROUP_ID,
      candidates: [],
      selectedIndex: -1,
      anchorMessageId: '',
      edits: new Map(),
    }
    const inspection = inspectCandidateReceipts(chat, refOf('orphan', 0), ledger, oldText, mvuCard)
    expect(inspection.needsReceipt).toBe(true)
    expect(inspection.detail).toBe('body-receipt-legacy')
  })

  it('reports a key mismatch when a receipt claims another slot for the same message', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}#1`, AT_ONE, [favorChange(10, 15)])])
    const inspection = inspectCandidateReceipts(chat, refOf(MESSAGE_ID, 0), ledgerOf(oldText), oldText, mvuCard)
    expect(inspection.detail).toBe('body-receipt-key-mismatch')
  })
})

describe('candidate edit transaction', () => {
  it('undoes the old receipt, applies the new patch once, and syncs swipes/mes/stat_data', () => {
    const oldText = updateText('Old body', 5)
    const newText = updateText('New body', 3)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])
    const userMessage = structuredClone(chat.messages[0])

    const next = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: newText,
      at: AT_TWO,
      eventSeq: 10,
    })

    expect(next.messages).toHaveLength(2)
    expect(next.messages[0]).toEqual(userMessage)
    expect(next.messages.map((message) => message.mes)).toEqual(['Hello', newText])
    // The caller-owned clone is mutated in place, not replaced by a detached copy.
    expect(chat.messages.map((message) => message.mes)).toEqual(['Hello', newText])
    expect(chat.messages[1]?.swipes).toEqual([newText])

    const floor = floorOf(next)
    expect(floor.swipe_id).toBe(0)
    expect(floor.swipes).toEqual([newText])
    expect(floor.swipe_info?.[0]).toMatchObject({
      send_date: SEND_DATE,
      extra: { provider: 'test-provider', model: 'test-model' },
    })
    // A second application would yield 18, not 13.
    expect(statFavor(next)).toBe(13)
    expect(statDataOf(floor)).toEqual({ mvu: { favor: 13 } })

    const receipts = readMvuReceipts(next)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      turnKey: `body:${MESSAGE_ID}#0`,
      at: AT_TWO,
      status: 'updated',
      failures: [],
    })
    expect(receipts[0]?.undoneAt).toBeUndefined()
    expect(receipts[0]?.changes).toContainEqual(favorChange(10, 13))
  })

  it('undoes the old receipt and removes it when the new text has no patch block', () => {
    const oldText = updateText('Old body', 5)
    const plainText = 'Plain replacement without a patch.'
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])

    const next = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: plainText,
      at: AT_TWO,
      eventSeq: 11,
    })

    expect(next.messages).toHaveLength(2)
    expect(floorOf(next).mes).toBe(plainText)
    expect(floorOf(next).swipes).toEqual([plainText])
    expect(statFavor(next)).toBe(10)
    expect(statDataOf(floorOf(next))).toEqual({ mvu: { favor: 10 } })
    expect(readMvuReceipts(next)).toHaveLength(0)
  })

  it('keeps one latest receipt across consecutive edits', () => {
    const textA = updateText('Body A', 5)
    const textB = updateText('Body B', 3)
    const textC = updateText('Body C', 1)
    const chat = mvuChat(textA, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])

    const first = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(textA),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: textA,
      text: textB,
      at: AT_ONE,
      eventSeq: 19,
    })
    expect(statFavor(first)).toBe(13)

    const second = applyCandidateEditToChat(first, mvuCard, {
      ledger: ledgerOf(textB),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: textB,
      text: textC,
      at: AT_TWO,
      eventSeq: 20,
    })

    // The baseline stays 10; edits must not accumulate 5 + 3 + 1.
    expect(statFavor(second)).toBe(11)
    const receipts = readMvuReceipts(second)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ turnKey: `body:${MESSAGE_ID}#0`, at: AT_TWO })
    expect(receipts[0]?.undoneAt).toBeUndefined()
    expect(receipts[0]?.changes).toContainEqual(favorChange(10, 11))
  })

  it('removes stale floor stat_data when the edited candidate leaves no patch', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, {})
    chat.messages[1] = {
      ...chat.messages[1]!,
      variables: { stat_data: { mvu: { favor: 99 } } },
    }
    // A live unchanged receipt proves the old body had a patch without owning a variable effect.
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [])])

    const next = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: 'Plain replacement without a patch.',
      at: AT_TWO,
      eventSeq: 12,
    })

    expect(readMvuReceipts(next)).toHaveLength(0)
    expect(floorOf(next).variables).toBeUndefined()
  })

  it('keeps an unchanged receipt when the new patch changes nothing', () => {
    const oldText = updateText('Old body', 5)
    const noopText = emptyPatchText('No-op body')
    const variables = {
      initialized_lorebooks: true,
      stat_data: { mvu: { favor: 15 } },
      previous_stat_data: { mvu: { favor: 10 } },
    }
    const chat = mvuChat(oldText, variables)
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])

    const next = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: noopText,
      at: AT_TWO,
      eventSeq: 12,
    })

    expect(statFavor(next)).toBe(10)
    const receipts = readMvuReceipts(next)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ turnKey: `body:${MESSAGE_ID}#0`, status: 'unchanged', changes: [] })
  })

  it('refuses an edit whose previous body has a patch but no receipt', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    const before = structuredClone(chat)

    expectCandidateError(() => applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 13,
    }), 'body-receipt-missing')

    expect(chat).toEqual(before)
  })

  it('refuses two live receipts with changes instead of picking one', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [
      receiptOf(`body:${MESSAGE_ID}#0`, AT_ONE, [favorChange(10, 15)]),
      receiptOf(`body:${MESSAGE_ID}#0`, AT_TWO, [favorChange(10, 15)]),
    ])
    const before = structuredClone(chat)

    expectCandidateError(() => applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 14,
    }), 'body-receipt-duplicate')

    expect(chat).toEqual(before)
    expect(statFavor(chat)).toBe(15)
  })

  it('refuses a stale swipe anchor and an unprojected swipe', () => {
    const oldText = updateText('Old body', 5)

    const stale = mvuChat(oldText, baseVariables(15))
    stale.messages[1]!.swipe_id = 1
    expectCandidateError(() => applyCandidateEditToChat(stale, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 15,
    }), 'stale-anchor')

    const pending = mvuChat(oldText, baseVariables(15))
    delete pending.messages[1]!.swipes
    expectCandidateError(() => applyCandidateEditToChat(pending, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 16,
    }), 'projection-pending')
  })

  it('allows a plain card to edit without any receipt', () => {
    const oldText = 'Plain body.'
    const newText = 'Plain body, edited.'
    const chat = mvuChat(oldText, baseVariables(10))

    const next = applyCandidateEditToChat(chat, plainCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: newText,
      at: AT_TWO,
      eventSeq: 17,
    })

    expect(next.messages).toHaveLength(2)
    expect(floorOf(next).mes).toBe(newText)
    expect(statFavor(next)).toBe(10)
    expect(readMvuReceipts(next)).toHaveLength(0)
  })

  it('edits a plain-card candidate whose message id carries a receipt separator', () => {
    const oldText = 'Plain body.'
    const newText = 'Plain body, edited.'
    const chat = mvuChat(oldText, baseVariables(10))
    const dividerId = 'candidate#1'
    const floor = chat.messages[1]!
    chat.messages[1] = {
      ...floor,
      extra: { agentTavern: { bodyGroupId: dividerId, anchorMessageId: dividerId } },
    }
    const ledger: BodyLedger = {
      groupId: dividerId,
      candidates: [{ messageId: dividerId, index: 0, text: oldText }],
      selectedIndex: 0,
      anchorMessageId: dividerId,
      edits: new Map(),
    }

    const next = applyCandidateEditToChat(chat, plainCard, {
      ledger,
      groupId: dividerId,
      index: 0,
      messageId: dividerId,
      previousText: oldText,
      text: newText,
      at: AT_TWO,
      eventSeq: 23,
    })

    expect(next.messages).toHaveLength(2)
    expect(floorOf(next).mes).toBe(newText)
    expect(floorOf(next).swipes).toEqual([newText])
    expect(readMvuReceipts(next)).toHaveLength(0)
    expect(agentTavernOf(next)).toMatchObject({ lastBodyEventSeq: 23, lastBodyMutation: 'edit' })
  })

  it('refuses an MVU candidate whose message id cannot form a receipt key', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(10))
    const dividerId = 'candidate#1'
    const floor = chat.messages[1]!
    chat.messages[1] = {
      ...floor,
      extra: { agentTavern: { bodyGroupId: dividerId, anchorMessageId: dividerId } },
    }
    const ledger: BodyLedger = {
      groupId: dividerId,
      candidates: [{ messageId: dividerId, index: 0, text: oldText }],
      selectedIndex: 0,
      anchorMessageId: dividerId,
      edits: new Map(),
    }
    const before = structuredClone(chat)

    const error = expectCandidateError(() => applyCandidateEditToChat(chat, mvuCard, {
      ledger,
      groupId: dividerId,
      index: 0,
      messageId: dividerId,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 24,
    }), 'body-receipt-key-mismatch')

    expect(error.message).toContain(dividerId)
    expect(error.message).toContain('cannot be encoded as a candidate receipt key')
    expect(chat).toEqual(before)
  })

  it('does not add messages or mutate the user floor', () => {    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])
    const userBefore = structuredClone(chat.messages[0])

    const next = applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 18,
    })

    expect(next.messages).toHaveLength(2)
    expect(next.messages[0]).toEqual(userBefore)
    expect(next.messages.filter((message) => message.is_user)).toHaveLength(1)
    expect(next.messages.filter((message) => !message.is_user)).toHaveLength(1)
  })

  it('records the edit watermark on the floor in the same clone', () => {
    const oldText = updateText('Old body', 5)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])

    applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: updateText('New body', 3),
      at: AT_TWO,
      eventSeq: 22,
    })

    expect(agentTavernOf(chat)).toMatchObject({
      bodyGroupId: GROUP_ID,
      anchorMessageId: MESSAGE_ID,
      lastBodyEventSeq: 22,
      lastBodyMutation: 'edit',
    })
  })

  it('replays the same edit event without a second undo or patch application', () => {
    const oldText = updateText('Old body', 5)
    const newText = updateText('New body', 3)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])
    const input = {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: newText,
      at: AT_TWO,
      eventSeq: 23,
    }

    const next = applyCandidateEditToChat(chat, mvuCard, input)
    expect(next).toBe(chat)
    expect(statFavor(chat)).toBe(13)
    const afterFirst = readMvuReceipts(chat)
    expect(afterFirst).toHaveLength(1)

    const again = applyCandidateEditToChat(chat, mvuCard, input)
    expect(again).toBe(chat)
    // A second undo/patch round would land on 10 -> 10 + 5 + 3 semantics.
    expect(statFavor(chat)).toBe(13)
    expect(readMvuReceipts(chat)).toEqual(afterFirst)
    expect(readMvuReceipts(chat).map((receipt) => receipt.turnKey)).toEqual([`body:${MESSAGE_ID}#0`])
    expect(agentTavernOf(chat)['lastBodyEventSeq']).toBe(23)
  })

  it('finds a migrated candidate receipt by message id and satisfies rollback coverage', () => {
    const oldText = updateText('Old body', 5)
    const newText = updateText('New body', 3)
    const chat = mvuChat(oldText, baseVariables(15))
    attachReceipts(chat, [receiptOf(`body:${MESSAGE_ID}`, AT_ONE, [favorChange(10, 15)])])

    applyCandidateEditToChat(chat, mvuCard, {
      ledger: ledgerOf(oldText),
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: oldText,
      text: newText,
      at: AT_TWO,
      eventSeq: 24,
    })

    const byMessage = mvuReceiptsForBody(chat, { messageId: MESSAGE_ID })
    expect(byMessage.map((receipt) => receipt.turnKey)).toEqual([`body:${MESSAGE_ID}#0`])
    expect(mvuReceiptsForBody(chat, { messageId: MESSAGE_ID, floorIndex: 1 })).toEqual(byMessage)
    expect(mvuReceiptsForBody(chat, { floorIndex: 1 })).toEqual([])

    expect(() => assertReceiptCoverage(oldText, [], byMessage, MESSAGE_ID, 1, 'agent-1', 1)).not.toThrow()
    expect(() => assertReceiptCoverage(oldText, [], byMessage, 'other-message', 1, 'agent-1', 1))
      .toThrowError(/neither a 'body:other-message' nor a 'body:other-message#<index>' receipt/)
  })
})

/* ---------------------- ring retention (proposal 0023 §3.6) ---------------------- */

function settleReceiptOf(floorIndex: number, at: string): MvuReceipt {
  return receiptOf(String(floorIndex), at, [])
}

describe('candidate receipt retention under ring pressure', () => {
  it('keeps the active group receipts when 25 settle receipts overflow the ring', () => {
    const textA = updateText('Body A', 5)
    const textB = updateText('Body B', 2)
    const ledger = candidateLedgerOf([textA, textB])
    const secondMessageId = ledger.candidates[1]!.messageId
    const chat = swipeChat([textA, textB], baseVariables(15))
    // The group's receipts sit below a long settle history, which is exactly the
    // state where a plain ring has already evicted them.
    attachReceipts(chat, [
      receiptOf('body:old-group#0', AT_ONE, [favorChange(1, 2)]),
      receiptOf(`body:${MESSAGE_ID}#0`, AT_ONE, [favorChange(10, 15)]),
      receiptOf(`body:${secondMessageId}#1`, AT_ONE, [favorChange(10, 12)], AT_ONE),
      ...Array.from({ length: 25 }, (_, floor) => settleReceiptOf(100 + floor, `2026-10-28T01:00:00.${String(floor).padStart(3, '0')}Z`)),
    ])

    applyCandidateEditToChat(chat, mvuCard, {
      ledger,
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: textA,
      text: updateText('Body A edited', 3),
      at: AT_TWO,
      eventSeq: 40,
    })

    const keys = readMvuReceipts(chat).map((receipt) => receipt.turnKey)
    // Both active-group candidates survive; the foreign group and the oldest
    // settle receipts stay ordinary ring victims.
    expect(keys).toHaveLength(MVU_RECEIPTS_LIMIT)
    expect(keys).toContain(`body:${MESSAGE_ID}#0`)
    expect(keys).toContain(`body:${secondMessageId}#1`)
    expect(keys).not.toContain('body:old-group#0')
    expect(keys).toContain('124')
    expect(keys).not.toContain('106')
    // The edit still addressed the candidate by key and applied the patch once.
    expect(mvuReceiptsForBody(chat, { messageId: MESSAGE_ID }).map((receipt) => receipt.turnKey))
      .toEqual([`body:${MESSAGE_ID}#0`])
    expect(statFavor(chat)).toBe(13)
  })

  it('keeps every candidate receipt when the group alone exceeds the ring', () => {
    const texts = Array.from({ length: 21 }, (_, index) => updateText(`Body ${index}`, 1))
    const ledger = candidateLedgerOf(texts)
    const chat = swipeChat(texts, baseVariables(15))
    attachReceipts(chat, ledger.candidates.map((candidate, index) => receiptOf(
      candidateReceiptKey(candidate.messageId, candidate.index),
      AT_ONE,
      [favorChange(10, index === 0 ? 15 : 11)],
      index === 0 ? undefined : AT_ONE,
    )))

    applyCandidateEditToChat(chat, mvuCard, {
      ledger,
      groupId: GROUP_ID,
      index: 0,
      messageId: MESSAGE_ID,
      previousText: texts[0]!,
      text: updateText('Body 0 edited', 3),
      at: AT_TWO,
      eventSeq: 41,
    })

    const keys = readMvuReceipts(chat).map((receipt) => receipt.turnKey)
    // 21 receipts is over MVU_RECEIPTS_LIMIT on purpose: an active candidate's
    // only replayable proof outranks the ring size.
    expect(keys).toHaveLength(21)
    expect([...keys].sort()).toEqual(
      ledger.candidates.map((candidate) => candidateReceiptKey(candidate.messageId, candidate.index)).sort(),
    )
    expect(statFavor(chat)).toBe(13)
  })

  it('undoes and redoes a candidate receipt stored in an over-limit array', () => {
    const text = updateText('Body', 5)
    const chat = mvuChat(text, baseVariables(15))
    attachReceipts(chat, [
      receiptOf(`body:${MESSAGE_ID}#0`, AT_ONE, [favorChange(10, 15)]),
      ...Array.from({ length: 24 }, (_, floor) => settleReceiptOf(floor, AT_ONE)),
    ])
    expect(readMvuReceipts(chat)).toHaveLength(25)

    const [candidate] = mvuReceiptsForBody(chat, { messageId: MESSAGE_ID })
    expect(candidate?.turnKey).toBe(`body:${MESSAGE_ID}#0`)

    const undone = undoMvuReceipts(chat, [candidate!], { at: AT_TWO })
    expect(undone.receipts).toHaveLength(1)
    expect(undone.restores).toContainEqual({ path: 'stat_data.mvu.favor', value: 10 })
    expect(statFavor(chat)).toBe(10)
    expect(readMvuReceipts(chat)).toHaveLength(25)
    expect(readMvuReceipts(chat)[0]?.undoneAt).toBe(AT_TWO)

    const redone = redoMvuReceipts(chat, [candidate!])
    expect(redone.receipts).toHaveLength(1)
    expect(statFavor(chat)).toBe(15)
    expect(readMvuReceipts(chat)).toHaveLength(25)
    expect(readMvuReceipts(chat)[0]?.undoneAt).toBeUndefined()
  })
})
