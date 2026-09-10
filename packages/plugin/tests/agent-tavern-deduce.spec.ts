import { describe, expect, it } from 'vitest'
import {
  DEDUCE_POSITION_LIMIT,
  parseDeductionRequest,
  roleRoundPrompt,
  runDeduction,
  subagentRuntimeOf,
  type ContentBlockLike,
  type DeductionRequest,
  type SubagentRunLike,
  type SubagentRuntimeLike,
} from '../src/agent-tavern/deduce.js'

interface StartedCall {
  provider: string
  label?: string
  prompt: ContentBlockLike[]
  round: number
  role: string
  signal: AbortSignal
}

interface ScriptedRole {
  output?: ContentBlockLike[]
  stopReason?: string
  diagnostic?: string
  failStart?: Error
}

function scriptedRuntime(script: (call: { role: string; round: number; prompt: string }) => ScriptedRole) {
  const calls: StartedCall[] = []
  const disposed: string[] = []
  const startOrder: string[] = []
  const runtime: SubagentRuntimeLike = {
    async start(provider, request) {
      const promptText = request.prompt.map((block) => block.text ?? '').join('\n')
      const round = Number(/\bRound (\d+) of the deduction\b/.exec(promptText)?.[1] ?? 1)
      const role = /You are "([^"]+)"/.exec(promptText)?.[1] ?? '?'
      calls.push({ provider, label: request.label, prompt: request.prompt, round, role, signal: request.signal })
      const key = `${role}#${round}`
      startOrder.push(`start:${key}`)
      const chore = script({ role, round, prompt: promptText })
      if (chore.failStart) throw chore.failStart
      const run: SubagentRunLike = {
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: chore.output ?? [{ type: 'text', text: `${role} position round ${round}` }],
          stopReason: chore.stopReason ?? 'completed',
          ...(chore.diagnostic !== undefined ? { diagnostic: chore.diagnostic } : {}),
        }).then(async (value) => {
          startOrder.push(`settle:${key}`)
          return value
        }),
        async dispose() {
          disposed.push(key)
        },
      }
      return run
    },
  }
  return {
    runtime,
    calls,
    disposed,
    startOrder,
  }
}

const REQUEST: DeductionRequest = {
  scenario: 'The siege of the moon gate begins at midnight.',
  roles: [
    { name: 'Commander', brief: 'Holds the gate, fears a feint.' },
    { name: 'Spy', brief: 'Saw the supply wagons turn north.' },
  ],
  rounds: 1,
}

describe('tavern_deduce runDeduction', () => {
  it('spawns one tool-free spawn child per role and collects positions', async () => {
    const fake = scriptedRuntime(() => ({}))
    const result = await runDeduction({ subagents: fake.runtime, parent: { id: 'parent-1' } }, REQUEST)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls.every((call) => call.provider === 'spawn')).toBe(true)
    expect(fake.calls.every((call) => call.label === `dsh-tavern deduce · ${call.role}`)).toBe(true)
    expect(fake.calls[0]!.prompt).toEqual([{ type: 'text', text: expect.stringContaining(REQUEST.scenario) }])
    expect(fake.calls[0]!.prompt[0]!.text).toContain('Role brief: Holds the gate, fears a feint.')
    expect(fake.calls[0]!.prompt[0]!.text).not.toContain('[round')
    expect(fake.disposed.sort()).toEqual(['Commander#1', 'Spy#1'])
    expect(result).toMatchObject({
      scenario: REQUEST.scenario,
      rounds: 1,
      roleCount: 2,
      truncated: false,
      failures: [],
    })
    expect(result.positions).toEqual([
      { name: 'Commander', round: 1, text: 'Commander position round 1' },
      { name: 'Spy', round: 1, text: 'Spy position round 1' },
    ])
  })

  it('feeds earlier positions into later rounds and waits for the round to settle', async () => {
    const fake = scriptedRuntime(() => ({}))
    const result = await runDeduction({ subagents: fake.runtime, parent: null }, { ...REQUEST, rounds: 2 })
    expect(fake.calls).toHaveLength(4)
    const spyRound2 = fake.calls.find((call) => call.role === 'Spy' && call.round === 2)
    expect(spyRound2?.prompt[0]!.text).toContain('[round 1] Commander: Commander position round 1')
    expect(spyRound2?.prompt[0]!.text).toContain('Continue as "Spy" in round 2')
    // 第 2 轮的角色必须在第 1 轮全部 settle 之后才允许 start。
    const settleRound1 = fake.startOrder.filter((entry) => entry.startsWith('settle:'))
    const startRound2 = fake.calls.filter((call) => call.round === 2).map((call) => `start:${call.role}#2`)
    expect(startRound2.every((entry) => fake.startOrder.indexOf(entry) > fake.startOrder.lastIndexOf(settleRound1[0]!))).toBe(true)
    expect(result.positions).toHaveLength(4)
    expect(result.rounds).toBe(2)
  })

  it('isolates a failed role without blocking the others', async () => {
    const fake = scriptedRuntime(({ role }) => (role === 'Spy' ? { stopReason: 'error', diagnostic: 'route unavailable' } : {}))
    const result = await runDeduction({ subagents: fake.runtime, parent: null }, REQUEST)
    expect(result.positions).toEqual([{ name: 'Commander', round: 1, text: 'Commander position round 1' }])
    expect(result.failures).toEqual([{ name: 'Spy', round: 1, stopReason: 'error', diagnostic: 'route unavailable' }])
    expect(fake.disposed).toContain('Spy#1')
  })

  it('throws when every role fails and still disposes every run', async () => {
    const fake = scriptedRuntime(() => ({ stopReason: 'refusal' }))
    await expect(runDeduction({ subagents: fake.runtime, parent: null }, REQUEST))
      .rejects.toThrow('all deduction roles failed: refusal')
    expect(fake.disposed.sort()).toEqual(['Commander#1', 'Spy#1'])
  })

  it('reports empty assistant output as a failure entry', async () => {
    const fake = scriptedRuntime(({ role }) => (role === 'Spy' ? { output: [] } : {}))
    const result = await runDeduction({ subagents: fake.runtime, parent: null }, REQUEST)
    expect(result.failures).toEqual([{ name: 'Spy', round: 1, stopReason: 'empty-output' }])
  })

  it('clips oversized positions and flags truncation', async () => {
    const long = 'x'.repeat(DEDUCE_POSITION_LIMIT + 500)
    const fake = scriptedRuntime(({ role }) => ({ output: [{ type: 'text', text: role === 'Spy' ? long : 'short' }] }))
    const result = await runDeduction({ subagents: fake.runtime, parent: null }, REQUEST)
    expect(result.truncated).toBe(true)
    expect(result.positions.find((entry) => entry.name === 'Spy')?.text).toHaveLength(DEDUCE_POSITION_LIMIT)
  })

  it('aborts between rounds after disposing the previous round', async () => {
    const controller = new AbortController()
    const fake = scriptedRuntime(() => ({}))
    const promise = runDeduction({ subagents: fake.runtime, parent: null, signal: controller.signal }, { ...REQUEST, rounds: 2 })
    queueMicrotask(() => controller.abort())
    await expect(promise).rejects.toThrow()
    expect(fake.disposed.sort()).toEqual(['Commander#1', 'Spy#1'])
    expect(fake.calls.every((call) => call.round === 1)).toBe(true)
  })

  it('propagates start-time infrastructure faults for the failing role only', async () => {
    const fake = scriptedRuntime(({ role }) => (role === 'Spy' ? { failStart: new Error('depth exhausted') } : {}))
    await expect(runDeduction({ subagents: fake.runtime, parent: null }, REQUEST))
      .rejects.toThrow('depth exhausted')
  })
})

describe('tavern_deduce request parsing', () => {
  it('rejects too few roles and duplicate names', () => {
    expect(() => parseDeductionRequest({ scenario: 's', roles: [{ name: 'A', brief: 'b' }] }))
      .toThrow('roles requires at least 2 entries')
    expect(() => parseDeductionRequest({
      scenario: 's',
      roles: [{ name: 'A', brief: 'b' }, { name: 'A', brief: 'c' }],
    })).toThrow('deduction role names must be unique')
  })

  it('clamps rounds and trims bounded text', () => {
    const parsed = parseDeductionRequest({
      scenario: '  s  ',
      rounds: 99,
      roles: [{ name: ' A ', brief: 'b' }, { name: 'B', brief: 'c' }],
    })
    expect(parsed).toEqual({ scenario: 's', rounds: 3, roles: [{ name: 'A', brief: 'b' }, { name: 'B', brief: 'c' }] })
    expect(() => parseDeductionRequest({ scenario: '', roles: REQUEST.roles })).toThrow('scenario is required')
  })
})

describe('tavern_deduce runtime probe', () => {
  const runtime = scriptedRuntime(() => ({})).runtime

  it('prefers the direct ctx property and falls back to ctx.get', () => {
    expect(subagentRuntimeOf({ id: 'a', ctx: { subagents: runtime } })).toBe(runtime)
    expect(subagentRuntimeOf({ id: 'a', ctx: { get: (name) => (name === 'subagents' ? runtime : undefined) } })).toBe(runtime)
  })

  it('returns undefined without a usable runtime', () => {
    expect(subagentRuntimeOf(undefined)).toBeUndefined()
    expect(subagentRuntimeOf({ id: 'a' })).toBeUndefined()
    expect(subagentRuntimeOf({ id: 'a', ctx: {} })).toBeUndefined()
    expect(subagentRuntimeOf({
      id: 'a',
      ctx: { get: () => { throw new Error('service not found') } },
    })).toBeUndefined()
  })
})

describe('tavern_deduce prompt builder', () => {
  it('keeps round 1 free of transcript and tools language positive', () => {
    const prompt = roleRoundPrompt({ role: REQUEST.roles[0]!, scenario: REQUEST.scenario, round: 1, transcript: [] })
    expect(prompt).toContain('You are "Commander"')
    expect(prompt).toContain('Tools are unavailable here')
    expect(prompt).not.toContain('[round')
  })

  it('embeds the cross-round transcript for later rounds', () => {
    const prompt = roleRoundPrompt({
      role: REQUEST.roles[1]!,
      scenario: REQUEST.scenario,
      round: 3,
      transcript: [
        { name: 'Commander', round: 1, text: 'Hold the gate.' },
        { name: 'Commander', round: 2, text: 'Hold the gate harder.' },
      ],
    })
    expect(prompt).toContain('[round 1] Commander: Hold the gate.')
    expect(prompt).toContain('[round 2] Commander: Hold the gate harder.')
    expect(prompt).toContain('Round 3 of the deduction')
  })
})
