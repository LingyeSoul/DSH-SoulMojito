import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTavernProjector, historyImportAppends, isTavernSessionMarker, lastImportedTurn, type NativeSession, type NativeSessionEvent } from '../src/agent-tavern/projector.js'
import { imMessageRef } from '../src/im/refs.js'
import { imPeerAlias, imPeerKeyParts } from '../src/im/types.js'
import { ChatRevisionConflictError, TavernStore } from '../../tavern-store/src/index.js'
import type { ChatLogIR, RegexScriptIR } from '../../tavern-format/src/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Hand-write a checkpoint file in the projector's on-disk location. */
function writeCheckpointFile(root: string, sessionId: string, checkpoint: Record<string, unknown>): void {
  const dir = join(root, 'projections')
  mkdirSync(dir, { recursive: true })
  const name = createHash('sha256').update(sessionId).digest('hex')
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(checkpoint)}\n`, 'utf8')
}

const cardData = (extensions: Record<string, unknown> = {}) => ({
  name: 'Projector Character', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
  creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '',
  character_version: '', extensions,
})

async function fixture(sessionId = 'native-session') {
  const root = mkdtempSync(join(tmpdir(), 'agent-tavern-projector-'))
  roots.push(root)
  const store = await TavernStore.open(root)
  await store.importCharacter({
    spec: 'chara_card_v2', spec_version: '2.0',
    data: cardData(),
  })
  const chatId = await store.createChat('Projector Character', {
    user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {},
  })
  await store.updateState(() => ({
    sessionBindings: {
      [sessionId]: {
        architecture: 'agent-tavern', contextMode: 'dsh-native',
        character: 'Projector Character', chatId,
      },
    },
  }))
  return { root, store, chatId, sessionId }
}

function session(id: string): NativeSession {
  return {
    id,
    events: [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      {
        type: 'user/message', seq: 1, time: 1100,
        data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
      },
      {
        type: 'assistant/message', seq: 2, time: 1200,
        data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant-tool', role: 'assistant',
            content: [{ type: 'tool-call', callId: 'call-1', name: 'memory_search', arguments: '{}' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      },
      {
        type: 'tool/result', seq: 3, time: 1300,
        data: { turn: 1, step: 1, message: { id: 'result-1', role: 'user', content: [], source: { kind: 'tool' } } },
      },
      {
        type: 'assistant/message', seq: 4, time: 1400,
        data: {
          turn: 1, step: 2,
          message: {
            id: 'assistant-final', role: 'assistant', content: [{ type: 'text', text: 'The door opens.' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      },
    ],
  }
}

/**
 * IM 绑定夹具：在普通投影夹具上挂 `imPeers`（peerKey 的第三段决定 private/group）。
 * 只有 `sessionId` 命中的会话才会走新的 IM 投影路径。
 */
async function imFixture(sessionId: string, peerKeys: readonly string[]) {
  const base = await fixture(sessionId)
  await base.store.updateState(() => ({
    imPeers: Object.fromEntries(peerKeys.map((peerKey) => {
      const scope: 'private' | 'group' = peerKey.split(':')[2] === 'group' ? 'group' : 'private'
      return [peerKey, { sessionId, scope, boundBy: 'manual' as const, createdAt: new Date(0).toISOString() }]
    })),
  }))
  return base
}

function peerAliasOf(peerKey: string): string {
  const parts = imPeerKeyParts(peerKey)
  if (parts === undefined) throw new Error(`bad IM peer key '${peerKey}'`)
  return imPeerAlias(parts.channel, parts.scope, peerKey)
}

const imFooterOf = (alias: string): string =>
  `（这是从 IM 转发给你的消息，不是 DSH 用户输入。回复请调用 im_send，peer 参数用 ${alias}。）`

/** 单条 relay 正文：与 `router.ts` 的 `relayTextOf` 逐字同形（带 msg 引用与时间）。 */
function imRelayTextOf(body: string, alias: string, ref: string): string {
  return [
    `[IM weixin/私聊 peer=${alias} msg=${ref} time=2026-10-31T05:17:33.928Z]`,
    body,
    imFooterOf(alias),
  ].join('\n')
}

/** 合流 relay 正文：头部标条数，正文逐行带 `[msg-…]`，群昵称由正文自带。 */
function imMergedRelayTextOf(bodies: readonly string[], alias: string, refs: readonly string[]): string {
  return [
    `[IM weixin/群聊 peer=${alias}]（连续 ${bodies.length} 条消息）`,
    ...bodies.map((body, index) => `[${refs[index]}] ${body}`),
    imFooterOf(alias),
  ].join('\n')
}

function imRelayMessageOf(id: string, text: string, alias: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-soulmojito', form: 'relay', summary: `IM weixin/private message from ${alias}` },
  }
}

function imSpliceOf(seq: number, inserted: readonly unknown[]): NativeSessionEvent {
  return { type: 'agent/inbox/spliced', seq, time: 1000 + seq, data: { target: 'next-turn', start: 0, inserted } }
}

/** assistant 工具轮：一段不送达的正文 + 若干 im_send 调用（真实 v4 用 `id` 标 callId）。 */
function imSendAssistantOf(
  seq: number,
  messageId: string,
  calls: readonly { callId: string; args: Record<string, unknown> }[],
  turn: number,
  step: number,
): NativeSessionEvent {
  return {
    type: 'assistant/message', seq, time: 2000 + seq,
    data: {
      turn, step,
      message: {
        id: messageId, role: 'assistant',
        content: [
          { type: 'text', text: '（这段正文不会送达对端）' },
          ...calls.map((call) => ({ type: 'tool-call', id: call.callId, name: 'im_send', arguments: JSON.stringify(call.args) })),
        ],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    },
  }
}

/** 真实 v4 的 tool/result 形状（本机 ~/.dsh/sessions 会话日志解压取证：message.toolCallId + isError + tool source.callId）。 */
function imSendResultOf(seq: number, callId: string, ok: boolean, turn: number, step: number): NativeSessionEvent {
  const text = ok
    ? JSON.stringify({ peer: 'peer', parts: 1, sentAt: new Date(0).toISOString() })
    : JSON.stringify({ error: 'transport failed' })
  return {
    type: 'tool/result', seq, time: 2000 + seq,
    data: {
      turn, step,
      message: {
        id: `result-${callId}`, role: 'tool', toolCallId: callId, isError: !ok,
        content: [{ type: 'text', text }],
        source: { kind: 'tool', callId },
      },
    },
  }
}

describe('AgentTavern native event projector', () => {
  it('projects human and final assistant messages exactly once across replay and restart', async () => {
    const { root, store, chatId, sessionId } = await fixture()
    const native = session(sessionId)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    let snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => [message.name, message.mes])).toEqual([
      ['Alice', 'Open the door.'],
      ['Projector Character', 'The door opens.'],
    ])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).eventSeq)).toEqual([1, 4])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 4, status: 'ok' })

    const resumed = await AgentTavernProjector.open(root, store)
    const next = { ...native, events: [...native.events, {
      type: 'user/message', seq: 5, time: 1500,
      data: { id: 'user-2', role: 'user', content: [{ type: 'text', text: 'Step inside.' }], source: { kind: 'user' } },
    }] }
    await resumed.replay(next)
    snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.', 'Step inside.'])
  })

  it('writes a deterministic send_date from the event time', async () => {
    const { root, store, chatId, sessionId } = await fixture('time-projection')
    const native = session(sessionId)
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.send_date)).toEqual([
      new Date(1100).toISOString(),
      new Date(1400).toISOString(),
    ])
  })

  it.each([-1, 1.5, Number.NaN, 8.64e15 + 1])(
    'rejects an unusable event time %s instead of dating it at read time',
    async (time) => {
      const { root, store, sessionId } = await fixture(`time-invalid-${String(time)}`)
      const native = session(sessionId)
      const projector = await AgentTavernProjector.open(root, store)
      const event = {
        type: 'user/message',
        seq: 1,
        time,
        data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
      } as unknown as NativeSessionEvent

      await expect(projector.project(native, event))
        .rejects.toThrow("session event 'user/message' at seq 1 has unusable time")
    },
  )

  it('rejects a time-less historical event instead of inventing a send date', async () => {
    const { root, store, sessionId } = await fixture('time-missing')
    const native = session(sessionId)
    const projector = await AgentTavernProjector.open(root, store)
    const event = {
      type: 'user/message',
      seq: 1,
      data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
    } as unknown as NativeSessionEvent

    await expect(projector.project(native, event)).rejects.toThrow('has unusable time undefined')
  })

  it('replays a DSH 0.1.2 host session whose log rides snapshotEvents()', async () => {
    const { root, store, chatId, sessionId } = await fixture('snapshot-session')
    const native = session(sessionId)
    // DSH 0.1.2 形状：无 events 属性，事件日志经 snapshotEvents() 冻结快照暴露。
    const legacy = { id: sessionId, snapshotEvents: () => native.events } as unknown as NativeSession
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(legacy)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.'])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 4, status: 'ok' })
  })

  it('does not project dsh-soulmojito mirrored imports back into the chat', async () => {
    const { root, store, chatId, sessionId } = await fixture('import-session')
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 1010, data: { turn: 1, step: 1 } },
        {
          type: 'assistant/message', seq: 2, time: 1100,
          data: {
            turn: 1, step: 1,
            message: {
              id: 'imported-greeting', role: 'assistant',
              content: [{ type: 'text', text: 'Hello, traveler.' }],
              source: { kind: 'model', provider: 'dsh-soulmojito', model: 'agent-tavern-import' },
            },
          },
        },
        { type: 'step/end', seq: 3, time: 1110, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4, time: 1120, data: { turn: 1, reason: { kind: 'completed' } } },
        {
          type: 'user/message', seq: 5, time: 1200,
          data: { id: 'imported-user', role: 'user', content: [{ type: 'text', text: 'Imported turn.' }], source: { kind: 'plugin', plugin: 'dsh-soulmojito' } },
        },
        {
          type: 'user/message', seq: 6, time: 1300,
          data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Live message.' }], source: { kind: 'user' } },
        },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Live message.'])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 6, status: 'ok' })
  })

  it('retries a chat CAS conflict without duplicating the event', async () => {
    const { root, store, chatId, sessionId } = await fixture('cas-session')
    let conflict = true
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatSnapshot: (character, id) => store.getChatSnapshot(character, id),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      saveChat: async (character, id, chat, revision) => {
        if (conflict) {
          conflict = false
          throw new ChatRevisionConflictError(revision!, 'changed')
        }
        return store.saveChat(character, id, chat, revision)
      },
    })
    const native = session(sessionId)
    await projector.project(native, native.events[1]!)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.'])
  })

  it('records a pending checkpoint and can replay after the target is repaired', async () => {
    const { root, store, chatId, sessionId } = await fixture('repair-session')
    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: { ...state.sessionBindings[sessionId]!, chatId: 'missing.jsonl' },
      },
    }))
    const projector = await AgentTavernProjector.open(root, store)
    const native = session(sessionId)
    const error = await projector.project(native, native.events[1]!).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    if (!(error instanceof Error)) throw new Error('expected the projection to reject')
    // The failure carries the binding and the cursor so the log is actionable
    // without guessing which chat of which session broke.
    expect(error.message).toContain('target chat not found')
    expect(error.message).toContain("chat 'missing.jsonl'")
    expect(error.message).toContain("of 'Projector Character'")
    expect(error.message).toContain("session 'repair-session'")
    expect(error.message).toContain('event seq 1')
    expect(await projector.status(sessionId)).toMatchObject({ status: 'pending', lastCursor: -1, pendingCursor: 1 })

    await store.updateState((state) => ({
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: { ...state.sessionBindings[sessionId]!, chatId },
      },
    }))
    await projector.project(native, native.events[1]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 1 })
  })

  it('reprojects events skipped by a legacy v1 checkpoint that a later success overwrote', async () => {
    const { root, store, chatId, sessionId } = await fixture('legacy-ok-session')
    // The pre-pendingCursor projector stamped `{ lastCursor: seq, status: 'ok' }`
    // on every success, so a failed seq below the watermark was overwritten and
    // lost: the file claims every seq at or below 4 is projected while the chat
    // never received them. Trusting that watermark skips the hole forever.
    writeCheckpointFile(root, sessionId, {
      version: 1, sessionId, lastCursor: 4, status: 'ok', updatedAt: new Date(0).toISOString(),
    })
    const projector = await AgentTavernProjector.open(root, store)
    // The untrusted v1 watermark migrates to an unverified pending state that a
    // live event can no longer stamp over with a false `ok` watermark.
    expect(await projector.status(sessionId)).toMatchObject({
      version: 2, status: 'pending', lastCursor: -1, pendingCursor: 0,
    })

    await projector.replay(session(sessionId))

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.'])
    expect(await projector.status(sessionId)).toMatchObject({ version: 2, status: 'ok', lastCursor: 4 })
  })

  it('does not pin a pending cursor at a seq the session log does not carry', async () => {
    const { root, store, chatId, sessionId } = await fixture('sparse-seq-session')
    const truncated: NativeSession = { id: sessionId, events: session(sessionId).events.slice(0, 4) }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(truncated)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 3 })

    // A v2 pending checkpoint that lost its pendingCursor (hand-edited file)
    // normalizes to `lastCursor + 1` = 4, but the session's next events arrive
    // at seqs 5 and 6: cursor 4 can never be closed by projecting an event.
    writeCheckpointFile(root, sessionId, {
      version: 2, sessionId, lastCursor: 3, status: 'pending', updatedAt: new Date(0).toISOString(),
    })
    const sparse: NativeSession = {
      id: sessionId,
      events: [...truncated.events,
        {
          type: 'assistant/message', seq: 5, time: 1400,
          data: {
            turn: 1, step: 2,
            message: {
              id: 'assistant-final', role: 'assistant', content: [{ type: 'text', text: 'The door opens.' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
        {
          type: 'user/message', seq: 6, time: 1500,
          data: { id: 'user-2', role: 'user', content: [{ type: 'text', text: 'Step inside.' }], source: { kind: 'user' } },
        },
      ],
    }
    const reopened = await AgentTavernProjector.open(root, store)
    await reopened.replay(sparse)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['Open the door.', 'The door opens.', 'Step inside.'])
    expect(await reopened.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 6 })
  })

  it('does not let a live event interleaving with replay permanently skip a backlog seq', async () => {
    const { root, store, chatId, sessionId } = await fixture('interleave-session')
    const native: NativeSession = {
      id: sessionId,
      events: [...session(sessionId).events,
        {
          type: 'user/message', seq: 5, time: 1500,
          data: { id: 'user-2', role: 'user', content: [{ type: 'text', text: 'Step inside.' }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: 6, time: 1600,
          data: {
            turn: 1, step: 3,
            message: {
              id: 'assistant-live', role: 'assistant', content: [{ type: 'text', text: 'Live reply.' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    }
    // Live-observer seam: a live event observed while replay's task for the
    // seq-4 backlog event is mid-flight enqueues on the same session tail.
    // MutationTail chains it after the running task only, so with per-event
    // enqueueing it runs BEFORE replay's not-yet-enqueued seq-5 task, stamps
    // `lastCursor: 6` through the no-hole Math.max branch, and seq 5 is then
    // judged already projected — permanently.
    let replaying = false
    let live: Promise<void> | undefined
    // The seam closes over the projector it must enqueue on; the closure only
    // runs during replay, well after the const below is initialized.
    const projector = await AgentTavernProjector.open(root, {
      getState: () => store.getState(),
      getCharacter: (name) => store.getCharacter(name),
      getChatJsrOverlay: (character, id) => store.getChatJsrOverlay(character, id),
      getChatSnapshot: (character, id) => {
        if (replaying && live === undefined) live = projector.project(native, native.events[6]!)
        return store.getChatSnapshot(character, id)
      },
      saveChat: (character, id, chat, revision) => store.saveChat(character, id, chat, revision),
    })
    // Backlog state: seqs 0-3 were live-projected while the projector was
    // observing (seq 1 is the only one of them with a floor); seqs 4 and 5
    // arrived with nothing observing — exactly what the startup replay
    // recovers. No pendingCursor exists, so the watermark's contiguity claim
    // is the only signal.
    await projector.project(native, native.events[1]!)
    await projector.project(native, native.events[3]!)
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 3 })

    replaying = true
    await projector.replay(native)
    await live
    // A second replay proves the outcome is not self-healing: whatever the
    // first pass skipped stays skipped (idempotent otherwise).
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => [message.mes, (message.extra!.agentTavern as any).eventSeq])).toEqual([
      ['Open the door.', 1],
      ['The door opens.', 4],
      ['Step inside.', 5],
      ['Live reply.', 6],
    ])
    expect(await projector.status(sessionId)).toMatchObject({ status: 'ok', lastCursor: 6 })
  })

  it('applies USER_INPUT and non-layered AI_OUTPUT regex when projecting live messages', async () => {
    const { root, store, chatId, sessionId } = await fixture('regex-session')
    // 卡内嵌脚本经导入物化为全局脚本；collectRegexScripts 按名去重后只应用一次。
    await store.importCharacter({
      spec: 'chara_card_v2', spec_version: '2.0',
      data: cardData({
        regex_scripts: [
          { scriptName: 'Echo Input', findRegex: 'door', replaceString: 'gate', placement: [1] },
          { scriptName: 'Trim Quotes', findRegex: '"([^"]*)"', replaceString: '$1', placement: [2] },
          { scriptName: 'Display Only', findRegex: 'opens', replaceString: 'unlocks', placement: [2], markdownOnly: true },
          { scriptName: 'Prompt Only', findRegex: 'The door', replaceString: 'A door', placement: [2], promptOnly: true },
        ],
      }),
    })
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        {
          type: 'user/message', seq: 1, time: 1100,
          data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: 2, time: 1200,
          data: {
            turn: 1, step: 1,
            message: {
              id: 'assistant-1', role: 'assistant',
              content: [{ type: 'text', text: 'The door "opens".' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    // USER_INPUT 落库变换；AI_OUTPUT 只应用非 promptOnly、非 markdownOnly 脚本。
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual([
      'Open the gate.',
      'The door opens.',
    ])
  })

  it('applies the chat regex overlay when projecting live messages', async () => {
    const { root, store, chatId, sessionId } = await fixture('regex-overlay-session')
    await store.putChatJsrOverlay('Projector Character', chatId, (current) => ({
      version: 1,
      scriptTrees: current?.scriptTrees ?? [],
      regexScripts: {
        global: [
          { id: 'session-input', scriptName: 'Session Input', findRegex: 'door', replaceString: 'gate', trimStrings: [], placement: [1], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null },
          { id: 'session-trim', scriptName: 'Session Trim', findRegex: '"([^"]*)"', replaceString: '$1', trimStrings: [], placement: [2], disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false, minDepth: null, maxDepth: null },
        ],
      },
    }))
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        {
          type: 'user/message', seq: 1, time: 1100,
          data: { id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Open the door.' }], source: { kind: 'user' } },
        },
        {
          type: 'assistant/message', seq: 2, time: 1200,
          data: {
            turn: 1, step: 1,
            message: {
              id: 'assistant-1', role: 'assistant',
              content: [{ type: 'text', text: 'The door "opens".' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
          },
        },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual([
      'Open the gate.',
      'The door opens.',
    ])
  })

  it('imports history as real turn boundaries the live loop can continue after', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Greeting.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' },
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Welcome.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Continue.' },
      ],
    }
    const original = structuredClone(chat)
    const appends = historyImportAppends(chat, 'session-1', [], undefined, { header: { version: 4 } })
    // 宿主 v4 准入要求每条 assistant/message 落在「已打开的 turn + step」内：只带
    // payload 坐标（turn 0）不构成边界，`turn/start` 又必须从 1 开始连续编号，
    // 因此导入必须写出完整 turn/step 边界，再由调用方推进 live loop 的轮次基线。
    // 历史之前先写受保护 system 头（turn 1）：surface 首个节点必须是
    // system/message，否则 live loop 首轮的 system prompt 提交会触发
    // `system/message requires a protected first surface head`。
    expect(appends.map((event) => event.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      'turn/start', 'user/message', 'turn/end',
    ])
    expect(appends.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)).toEqual([1, 2, 3, 4])
    expect(appends.filter((event) => event.type === 'turn/end').map((event) => event.data)).toEqual([
      { turn: 1, reason: { kind: 'completed' } },
      { turn: 2, reason: { kind: 'completed' } },
      { turn: 3, reason: { kind: 'completed' } },
      { turn: 4, reason: { kind: 'completed' } },
    ])
    expect(appends.filter((event) => event.type === 'step/start').map((event) => [event.data.turn, event.data.step]))
      .toEqual([[1, 1], [2, 1], [3, 1]])
    expect(appends.filter((event) => event.type === 'step/end').map((event) => [event.data.turn, event.data.step]))
      .toEqual([[1, 1], [2, 1], [3, 1]])
    // 受保护头：空 system 消息、append、落在 turn 1 / step 1 内；surface 为空时
    // 追加即建立 protectedHead（宿主 foldSurface 语义）。
    const head = appends[2]
    expect(head.type).toBe('system/message')
    expect(head.surfaceOp).toBe('append')
    expect(head.data.turn).toBe(1)
    expect(head.data.step).toBe(1)
    expect(head.data.message).toMatchObject({ role: 'system', content: [] })
    expect(lastImportedTurn(appends)).toBe(4)
    // turn/step/step 边界不是 surface 事件：不能带 surfaceOp。
    expect(appends.filter((event) => ['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type))
      .every((event) => event.surfaceOp === undefined)).toBe(true)
    // 导入的 user 消息保持宿主原生形状（无坐标）。
    expect(appends.filter((event) => event.type === 'user/message').every((event) => (
      !('turn' in event.data) && !('step' in event.data)
    ))).toBe(true)
    expect(appends.filter((event) => event.type === 'user/message')).toHaveLength(2)
    expect(appends.filter((event) => event.type === 'assistant/message')).toHaveLength(2)
    // v0 Session dispositions admit no plugin/form members on model sources;
    // the synthetic provider/model pair is the mirror marker.
    for (const event of appends.filter((item) => item.type === 'assistant/message')) {
      expect((event.data.message as { source: Record<string, unknown> }).source).toEqual({
        kind: 'model', provider: 'dsh-soulmojito', model: 'agent-tavern-import',
      })
      // token-meter 的 usageOf() 在 usage/stream 双缺时抛 TypeError；导入消息必须
      // 带一个诚实的空流，否则该会话的所有投影读取都会失败。
      expect(event.data.stream).toEqual([])
    }
    for (const event of appends.filter((item) => item.type === 'user/message')) {
      expect((event.data as { source: Record<string, unknown> }).source).toEqual({
        kind: 'plugin:dsh-soulmojito',
      })
    }
    expect(chat).toEqual(original)
  })

  it('imports history with the producer-owned plugin kind on v4 sessions', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [{ name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' }],
    }
    const appends = historyImportAppends(chat, 'session-1', [], undefined, { header: { version: 4 } })
    for (const event of appends.filter((item) => item.type === 'user/message')) {
      expect((event.data as { source: Record<string, unknown> }).source).toEqual({
        kind: 'plugin:dsh-soulmojito',
      })
    }
  })

  it('imports history with real turn boundaries and settlement fields on v4 sessions', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Greeting.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' },
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Welcome.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Continue.' },
      ],
    }
    // 导入契约（与 live loop 语义一致，见 index.ts 的 advanceHostTurnBase 注释）：
    // 每条 user 消息开启一个 turn（开场白这类无 user 前导的 assistant 也自成一个
    // turn），assistant 是 turn 内的一个 step，全部 turn 完整开合并带 settlement
    // stream——v4 加载期的关系校验与 settlement 校验都不留毒（v3 时代的裸消息 +
    // turn:0 已非法）。导入只面向空白会话（激活流程保证），turn 号从 1 起步。
    const session = { header: { version: 4 } }
    const appends = historyImportAppends(chat, 'session-1', [], undefined, session)
    expect(appends.map((event) => event.type)).toEqual([
      // v4 受保护头自成 turn 1（历史之前先占 surface 首位）
      'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
      // 开场白 assistant 自成 turn 2
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      // user 'Hello.' 开 turn 3，assistant 'Welcome.' 是其 step 1
      'turn/start', 'user/message', 'step/start', 'assistant/message', 'step/end', 'turn/end',
      // user 'Continue.' 开 turn 4（空 turn 也要闭合）
      'turn/start', 'user/message', 'turn/end',
    ])
    expect(appends.filter((event) => event.type === 'turn/start').map((event) => event.data))
      .toEqual([{ turn: 1 }, { turn: 2 }, { turn: 3 }, { turn: 4 }])
    expect(appends.filter((event) => event.type === 'turn/end').map((event) => event.data))
      .toEqual([
        { turn: 1, reason: { kind: 'completed' } },
        { turn: 2, reason: { kind: 'completed' } },
        { turn: 3, reason: { kind: 'completed' } },
        { turn: 4, reason: { kind: 'completed' } },
      ])
    const assistants = appends.filter((event) => event.type === 'assistant/message')
    expect(assistants.map((event) => ({ turn: event.data.turn, step: event.data.step, stream: event.data.stream })))
      .toEqual([
        { turn: 2, step: 1, stream: [] },
        { turn: 3, step: 1, stream: [] },
      ])
    expect(appends.filter((event) => event.type === 'user/message')
      .every((event) => !('turn' in event.data) && !('step' in event.data))).toBe(true)
    // 调用方靠它推进 live loop 轮次基线（index.ts advanceHostTurnBase）。
    expect(lastImportedTurn(appends)).toBe(4)

    // 没有任何可导入消息时不开空 turn，日志保持导入前形状。
    const emptyChat: ChatLogIR = { header: chat.header, messages: [] }
    expect(historyImportAppends(emptyChat, 'session-1', [], undefined, { header: { version: 4 } })).toEqual([])
  })

  it('recognizes both plugin-source shapes as Tavern session markers', () => {
    // v4（0.2.0-rc.2+）：宿主迁移产物与新写入同为 'plugin:dsh-soulmojito'。
    expect(isTavernSessionMarker({ kind: 'plugin:dsh-soulmojito' })).toBe(true)
    expect(isTavernSessionMarker({ kind: 'plugin:dsh-soulmojito', form: 'notice', summary: 'Tavern closed' })).toBe(true)
    // v0-v3：{ kind: 'plugin', plugin } 老形状（防御直读未迁移日志）。
    expect(isTavernSessionMarker({ kind: 'plugin', plugin: 'dsh-soulmojito' })).toBe(true)
    // 预加载通知不构成「会话已启动」。
    expect(isTavernSessionMarker({ kind: 'plugin:dsh-soulmojito', summary: 'AgentTavern preload: 山河风雨' })).toBe(false)
    expect(isTavernSessionMarker({ kind: 'plugin', plugin: 'dsh-soulmojito', summary: 'AgentTavern preload: 山河风雨' })).toBe(false)
    // model 镜像标记与无关 source。
    expect(isTavernSessionMarker({ kind: 'model', provider: 'dsh-soulmojito', model: 'agent-tavern-import' })).toBe(true)
    // 改名兼容（2026-10-16）：旧名 dsh-tavern 的持久化戳双认（存量会话不丢标记）。
    expect(isTavernSessionMarker({ kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' })).toBe(true)
    expect(isTavernSessionMarker({ kind: 'plugin:dsh-tavern' })).toBe(true)
    expect(isTavernSessionMarker({ kind: 'plugin', plugin: 'dsh-tavern' })).toBe(true)
    expect(isTavernSessionMarker({ kind: 'model', provider: 'other', model: 'm' })).toBe(false)
    expect(isTavernSessionMarker({ kind: 'plugin', plugin: 'someone-else' })).toBe(false)
    expect(isTavernSessionMarker({ kind: 'user' })).toBe(false)
    expect(isTavernSessionMarker(null)).toBe(false)
  })

  it('does not import empty, system-only or already projected history', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'System', is_user: false, is_system: true, send_date: '', mes: 'System.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: ' ' },
        {
          name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'Already here.',
          extra: { agentTavern: { sessionId: 'session-1' } },
        },
      ],
    }
    expect(historyImportAppends(chat, 'session-1', [], undefined)).toEqual([])
    expect(historyImportAppends({ ...chat, messages: [] }, 'session-1', [], undefined)).toEqual([])
  })

  it('applies prompt-only regex to imported history without touching stored text', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'first word' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'second word' },
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: 'third word' },
      ],
    }
    const script = (overrides: Partial<RegexScriptIR>): RegexScriptIR => ({
      id: 's', scriptName: 's', findRegex: 'word', replaceString: '<{{match}}>', trimStrings: [], placement: [2],
      disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: false, substituteRegex: false,
      minDepth: null, maxDepth: null, ...overrides,
    })
    const appends = historyImportAppends(chat, 'session-1', [
      script({ scriptName: 'Prompt Wrap', promptOnly: true }),
      // 深度限制：depth 0（最新）之内才生效
      script({ scriptName: 'Depth Shout', promptOnly: true, maxDepth: 0, findRegex: 'third', replaceString: 'THIRD' }),
      // 非 promptOnly 脚本已含在落库文本里，导入时不得重复应用
      script({ scriptName: 'Save Wrap', replaceString: '!' }),
    ], undefined)
    const texts = appends
      .filter((item) => item.type === 'user/message' || item.type === 'assistant/message')
      .map((item) => {
        const data = item.data as { content?: Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }
        return (data.message?.content ?? data.content)?.[0]?.text
      })
    // depth 2 / 1 / 0：Depth Shout 只作用于最新一条，Prompt Wrap 作用于全部
    expect(texts).toEqual(['first <word>', 'second <word>', 'THIRD <word>'])
    expect(chat.messages.map((message) => message.mes)).toEqual(['first word', 'second word', 'third word'])
  })

  it('expands macros in the imported prompt view without touching stored text', () => {
    const chat: ChatLogIR = {
      header: { user_name: 'Alice', character_name: 'Projector Character', chat_metadata: {} },
      messages: [
        { name: 'Projector Character', is_user: false, is_system: false, send_date: '', mes: '{{char}} waves at {{user}}.' },
        { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'hello {{char}}' },
      ],
    }
    const appends = historyImportAppends(chat, 'session-1', [], (text) =>
      text.replaceAll('{{char}}', 'Nova').replaceAll('{{user}}', 'Alice'))
    const texts = appends
      .filter((item) => item.type === 'user/message' || item.type === 'assistant/message')
      .map((item) => {
        const data = item.data as { content?: Array<{ text?: string }>; message?: { content?: Array<{ text?: string }> } }
        return (data.message?.content ?? data.content)?.[0]?.text
      })
    expect(texts).toEqual(['Nova waves at Alice.', 'hello Nova'])
    expect(chat.messages.map((message) => message.mes)).toEqual(['{{char}} waves at {{user}}.', 'hello {{char}}'])
  })
})

describe('AgentTavern IM chat projection', () => {
  const privateKey = 'weixin:account:private:alice'
  const privateAlias = peerAliasOf(privateKey)
  const groupKey = 'weixin:account:group:family'
  const groupAlias = peerAliasOf(groupKey)

  it('projects an inbound relay as one clean user floor and stays replay-safe', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-inbound', [privateKey])
    const ref = imMessageRef('im-dedupe-alice-1')
    const native: NativeSession = {
      id: sessionId,
      events: [imSpliceOf(0, [imRelayMessageOf('im-1', imRelayTextOf('示例消息', privateAlias, ref), privateAlias)])],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages).toHaveLength(1)
    const message = snapshot!.chat.messages[0]!
    // 头部/尾部/msg 引用都不落库，只留正文；user 楼层沿用聊天用户名。
    expect([message.name, message.is_user, message.mes]).toEqual(['Alice', true, '示例消息'])
    expect(message.extra!.agentTavern).toMatchObject({
      sessionId,
      eventSeq: 0,
      projectionKey: `${sessionId}:0:im:im-1`,
      messageId: 'im-1',
      via: 'im-relay',
      im: { direction: 'in', peerAlias: privateAlias, ref },
    })
    expect(message.extra!.agentTavern).not.toHaveProperty('parse')
  })

  it('projects every relay inserted by one splice as separate floors', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-multi-insert', [privateKey])
    const first = imRelayMessageOf('im-1', imRelayTextOf('第一条', privateAlias, imMessageRef('im-multi-insert-1')), privateAlias)
    const second = imRelayMessageOf('im-2', imRelayTextOf('第二条', privateAlias, imMessageRef('im-multi-insert-2')), privateAlias)
    const native: NativeSession = { id: sessionId, events: [imSpliceOf(0, [first, second])] }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['第一条', '第二条'])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).projectionKey))
      .toEqual([`${sessionId}:0:im:im-1`, `${sessionId}:0:im:im-2`])
  })

  it('keeps merged group bodies in order and preserves nickname prefixes', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-merged', [groupKey])
    const text = imMergedRelayTextOf(
      ['[小明] 第一条', '[小红] 第二条'],
      groupAlias,
      [imMessageRef('im-group-1'), imMessageRef('im-group-2')],
    )
    const native: NativeSession = {
      id: sessionId,
      events: [imSpliceOf(0, [imRelayMessageOf('im-1', text, groupAlias)])],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages).toHaveLength(1)
    expect(snapshot!.chat.messages[0]!.mes).toBe('[小明] 第一条\n[小红] 第二条')
    const im = (snapshot!.chat.messages[0]!.extra!.agentTavern as any).im
    // 合流头没有单一 msg=：不伪造引用。
    expect(im).toEqual({ direction: 'in', peerAlias: groupAlias })
  })

  it('does not duplicate a relay the host also materializes as user/message', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-materialized', [privateKey])
    const text = imRelayTextOf('同一条消息', privateAlias, imMessageRef('im-dedupe-materialized'))
    const relay = imRelayMessageOf('im-1', text, privateAlias)
    const native: NativeSession = {
      id: sessionId,
      events: [
        imSpliceOf(0, [relay]),
        // 真实 v4 会话取证：splice 插入后，宿主在轮内把同 id 消息物化成 user/message。
        { type: 'user/message', seq: 1, time: 1001, data: relay },
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['同一条消息'])
  })

  it('projects a relay that exists only as user/message (legacy source shape)', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-user-message', [privateKey])
    // v0-v3 relay 头没有 msg/time，source 是 { kind: 'plugin', plugin } 老形状。
    const text = `[IM weixin/私聊 peer=${privateAlias}]\n只物化成用户消息\n${imFooterOf(privateAlias)}`
    const legacyRelay = {
      id: 'im-1',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-soulmojito', form: 'relay', summary: `IM weixin/private message from ${privateAlias}` },
    }
    const native: NativeSession = {
      id: sessionId,
      events: [{ type: 'user/message', seq: 0, time: 1000, data: legacyRelay }],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['只物化成用户消息'])
    expect(snapshot!.chat.messages[0]!.extra!.agentTavern).toMatchObject({ via: 'im-relay', im: { direction: 'in' } })
    expect((snapshot!.chat.messages[0]!.extra!.agentTavern as any).im.ref).toBeUndefined()
  })

  it('projects a successful im_send as one assistant floor after its result', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-send-ok', [privateKey])
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        imSendAssistantOf(1, 'assistant-1', [{ callId: 'call-1', args: { peer: privateAlias, text: '在的' } }], 1, 1),
        imSendResultOf(2, 'call-1', true, 1, 1),
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    // 带 tool-call 的 assistant 正文不落库，只落成功回执对应的发送文本。
    expect(snapshot!.chat.messages.map((message) => [message.name, message.is_user, message.mes])).toEqual([
      ['Projector Character', false, '在的'],
    ])
    expect(snapshot!.chat.messages[0]!.extra!.agentTavern).toMatchObject({
      sessionId,
      eventSeq: 2,
      messageId: 'assistant-1',
      via: 'im-send',
      turn: 1,
      step: 1,
      im: { direction: 'out', peerAlias: privateAlias, callId: 'call-1' },
    })
  })

  it('produces no floor for failed sends, including structured transport errors', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-send-failed', [privateKey])
    const payloadError = imSendResultOf(3, 'call-2', true, 1, 1)
    ;(payloadError.data as any).message.content = [{ type: 'text', text: JSON.stringify({ error: 'weixin throttled' }) }]
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        imSendAssistantOf(1, 'assistant-1', [
          { callId: 'call-1', args: { peer: privateAlias, text: '第一条' } },
          { callId: 'call-2', args: { peer: privateAlias, text: '第二条' } },
        ], 1, 1),
        imSendResultOf(2, 'call-1', false, 1, 1),
        payloadError,
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages).toEqual([])
  })

  it('projects every im_send of one assistant message in call/result order', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-send-many', [privateKey])
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        imSendAssistantOf(1, 'assistant-1', [
          { callId: 'call-1', args: { peer: privateAlias, text: '第一句' } },
          { callId: 'call-2', args: { peer: privateAlias, text: '第二句' } },
        ], 1, 1),
        imSendResultOf(2, 'call-1', true, 1, 1),
        imSendResultOf(3, 'call-2', true, 1, 1),
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['第一句', '第二句'])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).im.callId))
      .toEqual(['call-1', 'call-2'])
  })

  it('writes a compact marker for media-only sends and both parts for captions', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-send-media', [privateKey])
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        imSendAssistantOf(1, 'assistant-1', [
          { callId: 'call-1', args: { peer: privateAlias, mediaKind: 'image', mediaPath: 'C:/workspace/pic.png' } },
          { callId: 'call-2', args: { peer: privateAlias, text: '看这个', mediaKind: 'video', mediaUrl: 'https://example.com/a.mp4' } },
        ], 1, 1),
        imSendResultOf(2, 'call-1', true, 1, 1),
        imSendResultOf(3, 'call-2', true, 1, 1),
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['（图片）', '看这个\n（视频）'])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).im.mediaKind))
      .toEqual(['image', 'video'])
  })

  it('prefixes floors with the peer alias only in multi-peer sessions', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-multi-peer', [privateKey, groupKey])
    const native: NativeSession = {
      id: sessionId,
      events: [
        imSpliceOf(0, [imRelayMessageOf('im-1', imRelayTextOf('大家好', groupAlias, imMessageRef('im-multi-1')), groupAlias)]),
        { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
        imSendAssistantOf(2, 'assistant-1', [{ callId: 'call-1', args: { peer: privateAlias, text: '收到' } }], 1, 1),
        imSendResultOf(3, 'call-1', true, 1, 1),
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual([
      `[${groupAlias}] 大家好`,
      `[${privateAlias}] 收到`,
    ])
    expect(snapshot!.chat.messages.map((message) => (message.extra!.agentTavern as any).im.peerAlias))
      .toEqual([groupAlias, privateAlias])
  })

  it('stores the full text and marks fallback when the relay format is unrecognized', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-fallback', [privateKey])
    const broken = `[IM weixin/私聊 peer=${privateAlias}]\n原始正文还在\n（尾部被上游改掉了）`
    const native: NativeSession = {
      id: sessionId,
      events: [imSpliceOf(0, [imRelayMessageOf('im-1', broken, privateAlias)])],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages).toHaveLength(1)
    expect(snapshot!.chat.messages[0]!.mes).toBe(broken)
    expect(snapshot!.chat.messages[0]!.extra!.agentTavern).toMatchObject({
      via: 'im-relay',
      parse: 'fallback',
      im: { direction: 'in', peerAlias: privateAlias },
    })
  })

  it('rebuilds the pending im_send index after a restart between call and result', async () => {
    const { root, store, chatId, sessionId } = await imFixture('im-send-restart', [privateKey])
    const native: NativeSession = {
      id: sessionId,
      events: [
        { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
        imSendAssistantOf(1, 'assistant-1', [{ callId: 'call-1', args: { peer: privateAlias, text: '重启后仍记录' } }], 1, 1),
        imSendResultOf(2, 'call-1', true, 1, 1),
      ],
    }
    const first = await AgentTavernProjector.open(root, store)
    await first.project(native, native.events[1]!)
    expect(await first.status(sessionId)).toMatchObject({ lastCursor: 1, status: 'ok' })

    // 新实例（进程重启）没有内存索引：回填日志里的 assistant 调用后再投影结果。
    const resumed = await AgentTavernProjector.open(root, store)
    await resumed.project(native, native.events[2]!)
    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages.map((message) => message.mes)).toEqual(['重启后仍记录'])
  })

  it('resumes the backfill scan from its cursor instead of rescanning the whole log', async () => {
    const { root, store, sessionId } = await imFixture('im-send-cursor', [privateKey])
    const raw: NativeSessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
      {
        type: 'assistant/message', seq: 1, time: 1001,
        data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant-1', role: 'assistant',
            content: [{ type: 'tool-call', id: 'call-memory', name: 'memory_search', arguments: '{}' }],
            source: { kind: 'model', provider: 'test', model: 'test' },
          },
        },
      },
      imSendResultOf(2, 'call-memory', true, 1, 1),
      ...Array.from({ length: 19 }, (_, offset): NativeSessionEvent => ({
        type: 'turn/start', seq: 3 + offset, time: 1003 + offset, data: { turn: 1 },
      })),
      imSendResultOf(22, 'call-late', true, 1, 1),
    ]
    // 回填扫描对日志数组的唯一读点是 `prior.seq`；按事件对象计数即可区分
    //「第二次 miss 从 0 全量重扫」与「从上次游标继续」。
    const seqReads = raw.map(() => 0)
    const tracked = raw.map((event, index) => new Proxy(event, {
      get(target, property, receiver) {
        if (property === 'seq') seqReads[index] = (seqReads[index] ?? 0) + 1
        return Reflect.get(target, property, receiver)
      },
    }))
    const native: NativeSession = { id: sessionId, events: tracked }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.project(native, tracked[2]!)
    expect([seqReads[0], seqReads[1]]).toEqual([1, 1])

    await projector.project(native, tracked[22]!)
    // 游标 22 之后只扫新窗口：前缀 0、1 不再被读，窗口内每个事件各读一次。
    expect([seqReads[0], seqReads[1]]).toEqual([1, 1])
    expect(seqReads[3]).toBe(1)
    expect(seqReads[21]).toBe(1)
    expect(seqReads[22]).toBeGreaterThanOrEqual(2)
  })

  it('ignores relay and im_send events when the session has no IM binding', async () => {
    const { root, store, chatId, sessionId } = await fixture('im-unbound')
    const native: NativeSession = {
      id: sessionId,
      events: [
        imSpliceOf(0, [imRelayMessageOf('im-1', imRelayTextOf('没有绑定', privateAlias, imMessageRef('im-unbound')), privateAlias)]),
        { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
        imSendAssistantOf(2, 'assistant-1', [{ callId: 'call-1', args: { peer: privateAlias, text: '无绑定回复' } }], 1, 1),
        imSendResultOf(3, 'call-1', true, 1, 1),
      ],
    }
    const projector = await AgentTavernProjector.open(root, store)
    await projector.replay(native)

    const snapshot = await store.getChatSnapshot('Projector Character', chatId)
    expect(snapshot!.chat.messages).toEqual([])
    expect(await projector.status(sessionId)).toMatchObject({ lastCursor: 3, status: 'ok' })
  })
})
