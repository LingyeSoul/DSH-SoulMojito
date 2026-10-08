import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * repair-v4-sessions.mjs 的端到端回归：合成一个集齐四类毒化（chunk 事件、
 * settlement 缺 stream、turn:0 裸导入、裸 plugin source）的 v4 工件，跑
 * dry-run 与 --apply，修好的工件必须通过真实宿主 v4 准入（脚本内部验证），
 * 且复检 clean。宿主运行时缓存缺失的环境跳过。
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const RUNTIME = join(REPO_ROOT, '.npm-cache', 'dsh-runtime', 'node_modules')
// v4 与 v0 用独立沙箱（两组都要求宿主可见布局 <root>/<workspace>/<session>；
// workspace 目录名由 header.cwd 编码而来，分开便于各自校准）。
const SANDBOX = join(tmpdir(), `dsh-tavern-repair-v4-${process.pid}`)
// 受保护头用例的独立根：两种 surface 形态放同一根，目录模式一次处理。
const SANDBOX_HEAD = join(tmpdir(), `dsh-tavern-repair-v4-head-${process.pid}`)
const SANDBOX_V0 = join(tmpdir(), `dsh-tavern-repair-v0-${process.pid}`)

function run(args: string[]) {
  return execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'repair-v4-sessions.mjs'), ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
}

/** v4 容器契约：第一帧恰好一行 header，body 单独成帧（宿主读取器硬校验）。 */
function writeV4Artifact(path: string, rows: Array<Record<string, unknown>>) {
  const header = `${JSON.stringify(rows[0])}\n`
  const body = `${rows.slice(1).map((row) => JSON.stringify(row)).join('\n')}\n`
  writeFileSync(path, Buffer.concat([
    zstdCompressSync(Buffer.from(header, 'utf8')),
    zstdCompressSync(Buffer.from(body, 'utf8')),
  ]))
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  rmSync(SANDBOX_HEAD, { recursive: true, force: true })
  rmSync(SANDBOX_V0, { recursive: true, force: true })
})

describe.skipIf(!existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-format-v3-to-v4')))('repair-v4-sessions script', () => {
  // 三次进程外脚本调用（dry-run / --apply / 复检）走真实宿主 runtime 与原生
  // observe；全量并发下默认 5s 不够，显式放宽。
  it('repairs all four poison classes and the result passes real v4 admission', { timeout: 60_000 }, () => {
    // 宿主可见布局：<root>/<workspace>/<session-dir = session id>/，写回后的
    // 容器契约与原生 observe 才会被真实执行。
    // v4 代际文件名是 session.v4.jsonl.zstd（session.jsonl.zstd 被读取器判为
    // v0 代际；"filename identifies v0, but its header identifies v4"）。
    const artifact = join(SANDBOX, '--root-.dsh-tavern-workspace--', 'session-poisoned', 'session.v4.jsonl.zstd')
    mkdirSync(join(SANDBOX, '--root-.dsh-tavern-workspace--', 'session-poisoned'), { recursive: true })
    const rows = [
      { type: 'session', version: 4, id: 'session-poisoned', createdAt: 1700000000000, cwd: '/root/.dsh/tavern/workspace', isSeeded: false, delegationDepth: 0 },
      { type: 'assistant/message', seq: 1, time: 1700000000001, data: { turn: 0, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Greeting.' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } }, surfaceOp: 'append' },
      { type: 'user/message', seq: 2, time: 1700000000002, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } }, surfaceOp: 'append' },
      { type: 'turn/start', seq: 3, time: 1700000000003, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: 1700000000004, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 5, time: 1700000000005, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Re' } } },
      { type: 'assistant/message', seq: 6, time: 1700000000006, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Reply' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
      { type: 'step/end', seq: 7, time: 1700000000007, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 8, time: 1700000000008, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    writeV4Artifact(artifact, rows)

    const dry = run([SANDBOX, '--runtime', RUNTIME])
    expect(dry).toContain('1 chunk(s) dropped')
    expect(dry).toContain('2 stream(s) backfilled')
    expect(dry).toContain('1 import turn(s) wrapped')
    expect(dry).toContain('1 source(s) rewritten')
    expect(dry).toContain('real v4 admission passes')

    const applied = run([SANDBOX, '--apply', '--runtime', RUNTIME])
    expect(applied).toContain('applied: 1 artifact(s), 1 repaired')
    expect(applied).toContain('backup:')

    const recheck = run([SANDBOX, '--runtime', RUNTIME])
    expect(recheck).toContain('clean ')

    const repaired = decodeArtifact(artifact)
    const types = repaired.slice(1).map((row) => row.type)
    // 导入被完整包裹成 turn 1，live turn 重编号为 2，无 assistant/chunk 残留。
    expect(types).toEqual([
      'turn/start', 'step/start', 'assistant/message', 'step/end',
      'user/message', 'turn/end',
      'turn/start', 'step/start', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(repaired[5]?.data?.source).toEqual({ kind: 'plugin:dsh-tavern' })
    for (const row of repaired) {
      if (row.type === 'assistant/message') expect(Array.isArray(row.data.stream)).toBe(true)
    }
  })

  // 两种形态共用一个独立根，走目录模式的 dry-run / --apply / 复检（3 次进程外
  // 调用，而非每形态 3 次）——每次调用都加载真实宿主 runtime 与原生 observe，
  // 全量并发下默认 5s 不够，显式放宽。
  it('inserts the protected surface head and renumbers references (both surface shapes)', { timeout: 60_000 }, () => {
    // 形态一：老导入的首个 surface 节点（开场白 assistant）落在打开的 step 内——
    // 头插进该 step，后续引用随插入点平移。
    const withStep = join(SANDBOX_HEAD, '--root-.dsh-tavern-workspace--', 'session-head-step', 'session.v4.jsonl.zstd')
    mkdirSync(dirname(withStep), { recursive: true })
    const stepRows = [
      { type: 'session', version: 4, id: 'session-head-step', createdAt: 1700000000000, cwd: '/root/.dsh/tavern/workspace', isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 1, time: 1700000000001, data: { turn: 1 } },
      { type: 'step/start', seq: 2, time: 1700000000002, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 3, time: 1700000000003, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Greeting.' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } } },
      { type: 'step/end', seq: 4, time: 1700000000004, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 5, time: 1700000000005, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 6, time: 1700000000006, data: { turn: 2 } },
      { type: 'step/start', seq: 7, time: 1700000000007, data: { turn: 2, step: 1 } },
      // 宿主 live loop 首轮的 system prompt 提交：surface 非空且无头时这就是
      // `system/message requires a protected first surface head` 的触发点。
      { type: 'system/message', seq: 8, time: 1700000000008, surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } } },
      { type: 'user/message', seq: 9, time: 1700000000009, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 10, time: 1700000000010, surfaceOp: 'append', data: { turn: 2, step: 1, stream: [], message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'tool-call', id: 'c1', name: 'lookup', arguments: '{}' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      { type: 'tool/call', seq: 11, time: 1700000000011, data: { turn: 2, step: 1, callId: 'c1', name: 'lookup', arguments: '{}' } },
      { type: 'tool/result', seq: 12, time: 1700000000012, surfaceOp: 'append', sourceEventSeqs: [11], data: { turn: 2, step: 1, message: { id: 'r1', role: 'tool', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'c1' } } } },
      { type: 'step/end', seq: 13, time: 1700000000013, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 14, time: 1700000000014, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    writeV4Artifact(withStep, stepRows)

    // 形态二：老 user 先行导入——首个 surface 是 user/message，当时没有打开的
    // step；修复要新开 step 1 承接头，并把该 turn 原有的 step 1 平移为 step 2。
    const userFirst = join(SANDBOX_HEAD, '--root-.dsh-tavern-workspace--', 'session-head-userfirst', 'session.v4.jsonl.zstd')
    mkdirSync(dirname(userFirst), { recursive: true })
    const userFirstRows = [
      { type: 'session', version: 4, id: 'session-head-userfirst', createdAt: 1700000000000, cwd: '/root/.dsh/tavern/workspace', isSeeded: false, delegationDepth: 0 },
      { type: 'turn/start', seq: 1, time: 1700000000001, data: { turn: 1 } },
      { type: 'user/message', seq: 2, time: 1700000000002, surfaceOp: 'append', data: { id: 'u0', role: 'user', content: [{ type: 'text', text: 'old' }], source: { kind: 'plugin:dsh-tavern' } } },
      { type: 'step/start', seq: 3, time: 1700000000003, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', seq: 4, time: 1700000000004, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: 'old reply' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } } },
      { type: 'step/end', seq: 5, time: 1700000000005, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 6, time: 1700000000006, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 7, time: 1700000000007, data: { turn: 2 } },
      { type: 'step/start', seq: 8, time: 1700000000008, data: { turn: 2, step: 1 } },
      { type: 'system/message', seq: 9, time: 1700000000009, surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'system-prompt' } } } },
      { type: 'step/end', seq: 10, time: 1700000000010, data: { turn: 2, step: 1 } },
      { type: 'turn/end', seq: 11, time: 1700000000011, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    writeV4Artifact(userFirst, userFirstRows)

    const dry = run([SANDBOX_HEAD, '--runtime', RUNTIME])
    expect(dry).toContain('dry-run: 2 artifact(s), 2 repaired, 0 clean/skipped, 0 failed')
    expect(dry.match(/1 surface head\(s\) inserted/g)).toHaveLength(2)
    expect(dry).toContain('real v4 admission passes')
    const applied = run([SANDBOX_HEAD, '--apply', '--runtime', RUNTIME])
    expect(applied).toContain('applied: 2 artifact(s), 2 repaired, 0 clean/skipped, 0 failed')
    const recheck = run([SANDBOX_HEAD, '--runtime', RUNTIME])
    expect(recheck).toContain('dry-run: 2 artifact(s), 0 repaired, 2 clean/skipped, 0 failed')

    const stepRepaired = decodeArtifact(withStep).slice(1)
    // 头是 surface 首节点（assistant 之前），且落在 turn 1 / step 1 内。
    const headIndex = stepRepaired.findIndex((row) => row.type === 'system/message')
    const firstImport = stepRepaired.findIndex((row) => row.type === 'assistant/message')
    expect(headIndex).toBeGreaterThan(-1)
    expect(headIndex).toBeLessThan(firstImport)
    expect(stepRepaired[headIndex]).toMatchObject({ surfaceOp: 'append', data: { turn: 1, step: 1 } })
    // 恢复校验唯一放行的 system 源形状（plugin 源会被真实 observe 拒绝）。
    expect(stepRepaired[headIndex].data.message.source).toEqual({ kind: 'system-prompt' })
    // 插入点之后的引用（tool/result → tool/call）随重编号平移，仍指向正确行。
    const toolResult = stepRepaired.find((row) => row.type === 'tool/result')
    const toolCall = stepRepaired.find((row) => row.type === 'tool/call')
    expect(toolResult!.sourceEventSeqs).toEqual([toolCall!.seq])

    // 形态二的修复结果：头占据 turn 1 / step 1；原 step 1 的 assistant 被
    // 平移到 step 2（step/start 必须匹配 nextStep，不能留跳号）。
    const userFirstRepaired = decodeArtifact(userFirst).slice(1)
    // 头占据 turn 1 / step 1；原 step 1 的 assistant 被平移到 step 2。
    const firstTurnSteps = userFirstRepaired.filter((row) => row.data?.turn === 1 && Number.isSafeInteger(row.data?.step))
    expect(firstTurnSteps.map((row) => [row.type, row.data.step])).toEqual([
      ['step/start', 1], ['system/message', 1], ['step/end', 1],
      ['step/start', 2], ['assistant/message', 2], ['step/end', 2],
    ])
  })
})

/** 解码两帧 zstd 工件（第一帧 header、第二帧 body）为行数组。 */
function decodeArtifact(artifact: string) {
  const buffer = readFileSync(artifact)
  const starts: number[] = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (buffer.readUInt32LE(index) === 0xfd2fb528) starts.push(index)
  }
  return starts.map((start, index) => zstdDecompressSync(buffer.subarray(start, starts[index + 1] ?? buffer.length)).toString('utf8'))
    .join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

/**
 * v0 工件的 turn 坐标修复回归（2026-10 历史加载失败：v2→v3 迁移拒绝
 * "turn must be positive"）。合成工件复刻真实毒形状：孤儿 turn-0 导入
 * assistant（无边界包裹）、列压缩 chunk 行（seq0/time0/dt/texts，一行展开
 * 多个 chunk、占展开空间多号）、sourceEventSeqs 闭区间引用、后续 live
 * turn 1。修复后必须通过真实宿主 observe（v0→…→v4 迁移链）且复检 clean；
 * 健康工件必须零改动（2026-10-05 的 258 会话过度医疗事故的防线）。
 */
// v0 组还要求统一修复引擎存在：scripts/lib/session-turn-repair.mjs 曾因
// .gitignore 的全局 lib/ 规则被静默挡在 git 之外（见 decisions/2026-10-08），
// 缺文件的检出上脚本会如实跳过 v0 工件，该组必须以同样条件跳过而不是变红。
describe.skipIf(!existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-format-v3-to-v4'))
  || !existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-persistence-jsonl'))
  || !existsSync(join(REPO_ROOT, 'scripts', 'lib', 'session-turn-repair.mjs')))('repair-v4-sessions script (v0 artifacts)', () => {
  /** 宿主可见布局：<sessions-root>/<project>/<session-dir>/session.jsonl.zstd */
  function v0Rows(sessionId: string, poisoned: boolean) {
    const t = 1789091280327
    const rows: any[] = [
      { type: 'session', version: 0, id: sessionId, createdAt: t, cwd: '/root/.dsh/tavern/workspace', delegationDepth: 0, agentPreset: 'standard' },
      { type: 'permission/preset', seq: 0, time: t, data: { preset: 'workspace-write' } },
      { type: 'sandbox/mode', seq: 1, time: t, data: { mode: 'workspace-write' } },
      { type: 'approval/policy', seq: 2, time: t, data: { policy: 'ask' } },
      { type: 'command/run', seq: 3, time: t, data: { commandId: 'cmd-test-1', name: 'dsh-tavern-session', source: { kind: 'user' } } },
      { type: 'agent-preset/selected', seq: 4, time: t, data: { agentPreset: 'agent-tavern' } },
      { type: 'agent/inbox/spliced', seq: 5, time: t, data: { target: 'next-step', start: 0, inserted: [{ id: 'init-1', role: 'user', content: [{ type: 'text', text: 'init context' }], source: { kind: 'user' } }] } },
    ]
    if (poisoned) {
      // 0.3.x stamp-turn-0 形状：无 turn/start 包裹，载荷 turn: 0。
      rows.push({
        type: 'assistant/message', seq: 6, time: t + 1, surfaceOp: 'append',
        data: { turn: 0, step: 1, message: { id: 'import-1', role: 'assistant', content: [{ type: 'text', text: 'Greeting.' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } },
      })
    } else {
      // 健康模板：完整开/关的导入 turn 1。
      rows.push(
        { type: 'turn/start', seq: 6, time: t + 1, data: { turn: 1 } },
        { type: 'step/start', seq: 7, time: t + 1, data: { turn: 1, step: 1 } },
        { type: 'assistant/message', seq: 8, time: t + 1, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'import-1', role: 'assistant', content: [{ type: 'text', text: 'Greeting.' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } } },
        { type: 'step/end', seq: 9, time: t + 1, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 10, time: t + 1, data: { turn: 1, reason: { kind: 'completed' } } },
      )
    }
    const base = poisoned ? 7 : 11
    // 毒工件：live loop 开 turn 1（与孤儿前奏冲突，修复后抬升为 turn 2）；
    // 健康工件：live loop 开在导入 turn 之上的 turn 2（现行 advanceHostTurnBase 契约）。
    const live = poisoned ? 1 : 2
    rows.push(
      { type: 'command/done', seq: base, time: t + 2, data: { commandId: 'cmd-test-1', kind: 'success', text: 'Tavern: Test' } },
      { type: 'session/title', seq: base + 1, time: t + 2, data: { title: 'AgentTavern Test', messageSeqs: [], source: { kind: 'user' } } },
      // step/start 后跟一个压缩 text-chunks 行：占展开空间 2 号（texts 长度），
      // 磁盘 seq0 是其展开区间起点；assistant 以闭区间 [start, start+1] 引用
      // 这两个 chunk。
      { type: 'turn/start', seq: base + 2, time: t + 3, data: { turn: live } },
      { type: 'step/start', seq: base + 3, time: t + 3, data: { turn: live, step: 1 } },
      { type: 'text-chunks', seq0: base + 4, time0: t + 4, data: { turn: live, step: 1, index: 0, dt: [5], texts: ['He', 'llo'] } },
      {
        type: 'assistant/message', seq: base + 6, time: t + 6, surfaceOp: 'append',
        sourceEventSeqs: [[base + 4, base + 5]],
        data: { turn: live, step: 1, message: { id: 'reply-1', role: 'assistant', content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-test' } } },
      },
      { type: 'step/end', seq: base + 7, time: t + 6, data: { turn: live, step: 1 } },
      { type: 'turn/end', seq: base + 8, time: t + 6, data: { turn: live, reason: { kind: 'completed' } } },
    )
    return rows
  }

  function writeV0Artifact(artifact: string, sessionId: string, poisoned: boolean) {
    const rows = v0Rows(sessionId, poisoned)
    const header = `${JSON.stringify(rows[0])}\n`
    const body = `${rows.slice(1).map((row) => JSON.stringify(row)).join('\n')}\n`
    writeFileSync(artifact, Buffer.concat([
      zstdCompressSync(Buffer.from(header, 'utf8')),
      zstdCompressSync(Buffer.from(body, 'utf8')),
    ]))
  }

  it('wraps the orphan turn-0 import, renumbers the live turn, and passes host observe', () => {
    const sessionDir = join(SANDBOX_V0, '--root-.dsh-tavern-workspace--', 'session-v0poison')
    const artifact = join(sessionDir, 'session.jsonl.zstd')
    mkdirSync(sessionDir, { recursive: true })
    writeV0Artifact(artifact, 'session-v0poison', true)

    const dry = run([SANDBOX_V0, '--runtime', RUNTIME])
    expect(dry).toContain('1 orphan import(s) wrapped')

    const applied = run([SANDBOX_V0, '--apply', '--runtime', RUNTIME])
    expect(applied).toContain('host observe passes')

    const recheck = run([SANDBOX_V0, '--runtime', RUNTIME])
    expect(recheck).toContain('clean ')

    const repaired = decodeArtifact(artifact)
    // 前奏被包裹成 turn 1；live turn 1 → 2；压缩行保持 seq0 且区间引用被重映射。
    const turnStarts = repaired.filter((row) => row.type === 'turn/start').map((row) => row.data.turn)
    expect(turnStarts).toEqual([1, 2])
    const prelude = repaired.find((row) => row.type === 'assistant/message' && row.data.message.id === 'import-1')
    expect(prelude.data.turn).toBe(1)
    expect(prelude.data.step).toBe(1)
    const reply = repaired.find((row) => row.type === 'assistant/message' && row.data.message.id === 'reply-1')
    expect(reply.data.turn).toBe(2)
    // 毒工件 base=7：插入 4 个边界事件后，chunk 行旧区间 [11,12] → [15,16]。
    expect(reply.sourceEventSeqs).toEqual([[15, 16]])
    const chunks = repaired.filter((row) => row.type === 'text-chunks')
    expect(chunks).toHaveLength(1)
    expect(Number.isSafeInteger(chunks[0].seq0)).toBe(true)
    // 展开空间连续：每行起始 = 前序行起点 + 宽度。
    let cursor = 0
    for (const row of repaired.slice(1)) {
      const width = row.type === 'text-chunks' ? row.data.texts.length : 1
      const start = Number.isSafeInteger(row.seq0) ? row.seq0 : row.seq
      expect(start).toBe(cursor)
      cursor += width
    }
  })

  it('leaves a healthy v0 artifact byte-identical (no over-repair)', () => {
    const sessionDir = join(SANDBOX_V0, '--root-.dsh-tavern-workspace--', 'session-v0healthy')
    const artifact = join(sessionDir, 'session.jsonl.zstd')
    mkdirSync(sessionDir, { recursive: true })
    writeV0Artifact(artifact, 'session-v0healthy', false)
    const before = readFileSync(artifact)

    const check = run([SANDBOX_V0, '--apply', '--runtime', RUNTIME])
    expect(check).toContain('clean ')
    expect(readFileSync(artifact).equals(before)).toBe(true)
  })
})
