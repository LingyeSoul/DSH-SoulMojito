/**
 * AgentTavern 历史导入的宿主侧准入回归（用真实宿主代码验证，不是形状断言）。
 *
 * 历史背景：会话损坏已经被"修好"过两次，每次都换了个形状踩到另一个宿主契约——
 *   0.3.1 裸 assistant/message（无 turn/step）→ 客户端折叠器 "published invalid
 *   turn undefined"，对话区空白；0.3.2 补 `turn: 0` 坐标 → 0.2.0-rc.2 原生 V4
 *   准入拒绝整个会话；补 turn/step 边界但不动 live loop 的轮次基线 → loop 首轮
 *   重复导入轮号，准入同样拒绝。所以这里直接跑宿主的校验器与投影单元：
 *
 *   1. 真实 V4 关系准入（dsh-session-format-v3-to-v4）必须接受导入计划；
 *   2. 真实 tokenUsage / contextPressure 投影单元必须能物化该计划——缺
 *      `usage` 与 `stream` 时 token-meter 的 usageOf() 读 undefined.length，抛
 *      `Cannot read properties of undefined (reading 'length')`，这会杀掉该会话
 *      之后所有 stateOf()/snapshot()（原生「新建会话」复用会话时直接报错）；
 *   3. live loop 在 `lastImportedTurn + 1` 上的下一轮必须被接受（推进基线的效果）；
 *   4. 同一个 live 轮落在 turn 1 上必须被拒绝（证明轮次基线必须推进）。
 *
 * 验证依赖仓库自带的 DSH 0.2.0-rc.2 隔离 runtime（`.npm-cache/dsh-runtime`，
 * 见 README「验证」）；缺失时跳过并打印原因，不让本地缺 runtime 变成假红灯。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { historyImportAppends, lastImportedTurn, type SessionImportAppend } from '../src/agent-tavern/projector.js'
import type { ChatLogIR } from '../../../tavern-format/src/index.js'

const RUNTIME_ROOT = new URL('../../../.npm-cache/dsh-runtime/node_modules/@deepseek-ai/', import.meta.url)
const REQUIRED = [
  'dsh-session-format-v3-to-v4/lib/index.js',
  'dsh-token-meter/lib/types/usage-projection.js',
]
const runtimeAvailable = REQUIRED.every((relative) => existsSync(new URL(relative, RUNTIME_ROOT)))

const HEADER = { version: 4, id: 'session-gate', createdAt: 0, isSeeded: false, delegationDepth: 0 }

function v4Chat(): ChatLogIR {
  return {
    header: { user_name: 'User', character_name: 'Nova', chat_metadata: {} },
    messages: [
      // 角色卡开场白：first_mes 非空是这条导入路径的触发条件。
      { name: 'Nova', is_user: false, is_system: false, send_date: '', mes: '开场白。' },
      { name: 'User', is_user: true, is_system: false, send_date: '', mes: '你好。' },
      { name: 'Nova', is_user: false, is_system: false, send_date: '', mes: '欢迎。' },
    ],
  }
}

function toEvents(appends: readonly SessionImportAppend[]) {
  return appends.map((append, seq) => ({
    type: append.type,
    seq,
    time: 1_700_000_000_000 + seq,
    data: append.data,
    ...(append.surfaceOp === undefined ? {} : { surfaceOp: append.surfaceOp }),
  }))
}

/** 宿主 AgentLoop 写在 live turn 上的事件（turn/start、step/start、用户消息、助手回复、边界）。 */
function liveTurn(turn: number) {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'step/start', data: { turn, step: 1 } },
    {
      type: 'user/message',
      surfaceOp: 'append',
      data: { id: `live-user-${turn}`, role: 'user', content: [{ type: 'text', text: 'live' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        turn,
        step: 1,
        stream: [],
        message: { id: `live-assistant-${turn}`, role: 'assistant', content: [{ type: 'text', text: 'reply' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
      },
    },
    { type: 'step/end', data: { turn, step: 1 } },
    { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
  ]
}

async function loadHost() {
  const sessionFormat = await import(fileURLToPath(new URL('dsh-session-format-v3-to-v4/lib/index.js', RUNTIME_ROOT)))
  const tokenMeter = await import(fileURLToPath(new URL('dsh-token-meter/lib/types/usage-projection.js', RUNTIME_ROOT)))
  return {
    assertReleasedV4Relationships: sessionFormat.assertReleasedV4Relationships as (
      artifact: { header: unknown; events: readonly unknown[]; inheritedEventCount: number },
      knownEventTypes: Set<string>,
    ) => void,
    units: [
      tokenMeter.tokenUsageProjectionDefinition as { key: string; init: () => unknown; apply: (state: unknown, event: unknown) => unknown },
      tokenMeter.contextPressureProjectionDefinition as { key: string; init: () => unknown; apply: (state: unknown, event: unknown) => unknown },
    ],
  }
}

function admission(validate: (artifact: { header: unknown; events: readonly unknown[]; inheritedEventCount: number }, known: Set<string>) => void, events: readonly { type: string }[]) {
  const known = new Set(events.map((event) => event.type))
  return () => validate({ header: HEADER, events, inheritedEventCount: 0 }, known)
}

describe.skipIf(!runtimeAvailable)('AgentTavern history import against the real host admission', () => {
  it('is accepted by native V4 admission, materialises every projection unit, and lets the live loop continue', async () => {
    const { assertReleasedV4Relationships, units } = await loadHost()
    const appends = historyImportAppends(v4Chat(), 'session-gate', [], undefined, { header: { version: 4 } })
    const imported = lastImportedTurn(appends)
    expect(imported).toBe(2)

    const importedEvents = toEvents(appends)
    expect(admission(assertReleasedV4Relationships, importedEvents)).not.toThrow()

    // 投影单元必须能整段物化（缺 stream/usage 时这里就是用户看到的 'length' 崩溃）。
    for (const unit of units) {
      let state = unit.init()
      for (const event of importedEvents) state = unit.apply(state, event)
      expect(state).toBeTypeOf('object')
    }

    // 推进基线后的 live turn 与导入轮次连续，准入接受。
    const continued = [...importedEvents, ...liveTurn(imported! + 1).map((event, offset) => ({ ...event, seq: importedEvents.length + offset, time: 1_700_000_000_000 + importedEvents.length + offset }))]
    expect(admission(assertReleasedV4Relationships, continued)).not.toThrow()

    // 不推进基线（宿主 AgentLoop 构造时快照的 lastTurn = 0）时 live 首轮会落在
    // turn 1 上，准入必须拒绝——这正是 index.ts 的 advanceHostTurnBase 存在的理由。
    const stale = [...importedEvents, ...liveTurn(1).map((event, offset) => ({ ...event, seq: importedEvents.length + offset, time: 1_700_000_000_000 + importedEvents.length + offset }))]
    expect(admission(assertReleasedV4Relationships, stale)).toThrow(/turn\/start does not open the expected turn/)
  })

  it('rejects the two historical shapes it replaced', async () => {
    const { assertReleasedV4Relationships } = await loadHost()
    const assistant = {
      type: 'assistant/message',
      surfaceOp: 'append',
      data: {
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: '开场白。' }],
          source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' },
        },
      },
    }
    // 0.3.2：显式 turn 0 坐标、没有边界。
    expect(admission(assertReleasedV4Relationships, [{ ...assistant, seq: 0, time: 0, data: { ...assistant.data, turn: 0, step: 1 } }]))
      .toThrow(/does not match an open turn and step/)
    // 0.3.1：完全没有坐标。
    expect(admission(assertReleasedV4Relationships, [{ ...assistant, seq: 0, time: 0 }]))
      .toThrow(/does not match an open turn and step/)
  })
})

if (!runtimeAvailable) {
  describe('AgentTavern history import against the real host admission', () => {
    it('is skipped without the vendored DSH runtime', () => {
      console.warn(`[skip] ${REQUIRED.join(', ')} not found under .npm-cache/dsh-runtime; host admission gate skipped`)
      expect(runtimeAvailable).toBe(false)
    })
  })
}
