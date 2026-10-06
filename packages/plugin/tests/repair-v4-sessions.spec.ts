import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const SANDBOX = join(tmpdir(), `dsh-tavern-repair-v4-${process.pid}`)
// v0 用独立沙箱：v4 用例把工件文件直接放在项目目录（宿主 observe 的根
// 扫描会判 flat layout），不能与需要完整 <root>/<project>/<session>/ 布局的
// v0 observe 验证共用一个根。
const SANDBOX_V0 = join(tmpdir(), `dsh-tavern-repair-v0-${process.pid}`)

function run(args: string[]) {
  return execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'repair-v4-sessions.mjs'), ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  rmSync(SANDBOX_V0, { recursive: true, force: true })
})

describe.skipIf(!existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-format-v3-to-v4')))('repair-v4-sessions script', () => {
  it('repairs all four poison classes and the result passes real v4 admission', () => {
    const artifact = join(SANDBOX, 'session-poisoned', 'session.jsonl.zstd')
    mkdirSync(join(SANDBOX, 'session-poisoned'), { recursive: true })
    const rows = [
      { type: 'session', version: 4, id: 'session-poisoned', createdAt: 1700000000000, isSeeded: false, delegationDepth: 0 },
      { type: 'assistant/message', seq: 1, time: 1700000000001, data: { turn: 0, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Greeting.' }], source: { kind: 'model', provider: 'dsh-tavern', model: 'agent-tavern-import' } } }, surfaceOp: 'append' },
      { type: 'user/message', seq: 2, time: 1700000000002, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'plugin', plugin: 'dsh-tavern' } }, surfaceOp: 'append' },
      { type: 'turn/start', seq: 3, time: 1700000000003, data: { turn: 1 } },
      { type: 'step/start', seq: 4, time: 1700000000004, data: { turn: 1, step: 1 } },
      { type: 'assistant/chunk', seq: 5, time: 1700000000005, data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'Re' } } },
      { type: 'assistant/message', seq: 6, time: 1700000000006, data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Reply' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, surfaceOp: 'append' },
      { type: 'step/end', seq: 7, time: 1700000000007, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 8, time: 1700000000008, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    writeFileSync(artifact, zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')))

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

    const repaired = zstdDecompressSync(readFileSync(artifact)).toString('utf8')
      .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
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
describe.skipIf(!existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-format-v3-to-v4'))
  || !existsSync(join(RUNTIME, '@deepseek-ai', 'dsh-session-persistence-jsonl')))('repair-v4-sessions script (v0 artifacts)', () => {
  /** 宿主可见布局：<sessions-root>/<project>/<session-dir>/session.jsonl.zstd */
  function v0Rows(sessionId: string, poisoned: boolean) {
    const t = 1789091280327
    const rows: any[] = [
      { type: 'session', version: 0, id: sessionId, createdAt: t, cwd: 'C:\\tavern\\workspace', delegationDepth: 0, agentPreset: 'standard' },
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
    const sessionDir = join(SANDBOX_V0, '--C-tavern-workspace--', 'session-v0poison')
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
    const sessionDir = join(SANDBOX_V0, '--C-tavern-workspace--', 'session-v0healthy')
    const artifact = join(sessionDir, 'session.jsonl.zstd')
    mkdirSync(sessionDir, { recursive: true })
    writeV0Artifact(artifact, 'session-v0healthy', false)
    const before = readFileSync(artifact)

    const check = run([SANDBOX_V0, '--apply', '--runtime', RUNTIME])
    expect(check).toContain('clean ')
    expect(readFileSync(artifact).equals(before)).toBe(true)
  })
})
