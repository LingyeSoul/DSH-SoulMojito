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

function run(args: string[]) {
  return execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'repair-v4-sessions.mjs'), ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
}

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
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
