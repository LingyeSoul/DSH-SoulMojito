/** AgentTavern variable tool slice (registration order 10-14). */

import { clampInt, stringArg } from '../../tool-args.js'
import type { JsonValue, VariableSnapshot } from '../../../../tavern-store/src/index.js'
import {
  appendWriteJournalWith,
  openWriteJournal,
  type WriteJournalHandle,
  type WriteJournalVariableTarget,
  type WriteJournalVariableTool,
  type WriteJournalPhase,
} from '../write-journal.js'
import {
  assertWriteScopeAllowed,
  bindingFor,
  objectOutput,
  selectedVariableScope,
  tool,
  variableScopeParameter,
  type ToolDefinition,
  type ToolExecution,
} from './shared.js'
import { variableStore } from './stores.js'


export function variableTools(): ToolDefinition[] {
  return [
    tool('variable_get', 'Read a typed variable from the current chat, character, agent, global, or turn scope.', {
      scope: variableScopeParameter(true),
      name: { type: 'string', required: true },
    }, variableGetOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      const found = await (await variableStore()).get(target.scope, target.scopeId, stringArg(args.name))
      return found === undefined
        ? { found: false, scope: target.scope, name: stringArg(args.name) }
        : { found: true, scope: target.scope, name: found.name, value: found.value, revision: found.revision, updatedAt: found.updatedAt }
    }),
    tool('variable_set', 'Set a typed variable in the current chat, character, agent, global, or turn scope.', {
      scope: variableScopeParameter(true),
      name: { type: 'string', required: true, description: 'Variable name, 1-64 characters; letters of any script (Chinese MVU names included), digits, dot, dash, underscore.' },
      value: { required: true },
      expectedRevision: { type: 'string' },
    }, variableSetOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      const store = await variableStore()
      const name = stringArg(args.name)
      const value = jsonValueOf(args.value)
      const journalTarget = { scope: target.scope, scopeId: target.scopeId }
      await assertVariableScopeAllowed(exec, binding.agentId, journalTarget, 'variable_set', [name])
      const existing = await store.get(target.scope, target.scopeId, name)
      // Undo record before the store write: a rejected `before` append aborts
      // this set, so a turn never leaves an untracked mutation behind.
      const journal = await openWriteJournal(exec.agent, binding.agentId)
      appendVariableJournal(journal, {
        tool: 'variable_set',
        phase: 'before',
        target: journalTarget,
        names: [name],
        before: existing === undefined ? null : [existing],
      })
      const snapshot = await store.set(
        target.scope,
        target.scopeId,
        name,
        value,
        typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
      )
      appendVariableJournal(journal, { tool: 'variable_set', phase: 'after', target: journalTarget, after: [snapshot] })
      return { found: true, scope: target.scope, name: snapshot.name, value: snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt }
    }),
    tool('variable_patch', 'Atomically write several variables in one scope; the whole patch fails when any expected revision conflicts.', {
      scope: variableScopeParameter(true),
      changes: {
        type: 'array', required: true, description: 'Up to 32 entries of { name, value, expectedRevision? }.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: {},
            expectedRevision: { type: 'string' },
          },
          required: ['name', 'value'],
          additionalProperties: false,
        },
      },
      expectedRevision: { type: 'string', description: 'Optional whole-scope revision for a stronger check.' },
    }, variableListOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      if (!Array.isArray(args.changes) || args.changes.length === 0 || args.changes.length > 32) {
        throw new Error('changes must be a non-empty array of at most 32 entries')
      }
      const changes = args.changes.map((change) => {
        const entry = change as Record<string, unknown>
        return {
          name: stringArg(entry.name),
          value: jsonValueOf(entry.value),
          ...(typeof entry.expectedRevision === 'string' ? { expectedRevision: entry.expectedRevision } : {}),
        }
      })
      const journalTarget = { scope: target.scope, scopeId: target.scopeId }
      const names = changes.map((change) => change.name)
      await assertVariableScopeAllowed(exec, binding.agentId, journalTarget, 'variable_patch', names)
      const store = await variableStore()
      // Before snapshots of the changed names only; names absent here did not
      // exist before the patch and are rolled back by deleting them.
      const previous: VariableSnapshot[] = []
      for (const change of changes) {
        const existing = await store.get(target.scope, target.scopeId, change.name)
        if (existing !== undefined) previous.push(existing)
      }
      const journal = await openWriteJournal(exec.agent, binding.agentId)
      appendVariableJournal(journal, {
        tool: 'variable_patch',
        phase: 'before',
        target: journalTarget,
        names,
        before: previous,
      })
      const snapshots = await store.patch(
        target.scope,
        target.scopeId,
        changes,
        typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
      )
      appendVariableJournal(journal, { tool: 'variable_patch', phase: 'after', target: journalTarget, after: snapshots })
      return { scope: target.scope, variables: snapshots.map(variableSummary), truncated: false }
    }),
    tool('variable_delete', 'Delete one variable from the given scope; the audit-visible value history stays in the session log.', {
      scope: variableScopeParameter(true),
      name: { type: 'string', required: true },
      expectedRevision: { type: 'string' },
    }, variableDeleteOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      const store = await variableStore()
      const name = stringArg(args.name)
      const journalTarget = { scope: target.scope, scopeId: target.scopeId }
      await assertVariableScopeAllowed(exec, binding.agentId, journalTarget, 'variable_delete', [name])
      const existing = await store.get(target.scope, target.scopeId, name)
      if (existing === undefined) {
        // A miss writes nothing; the noop proves this to the coverage check.
        const journal = await openWriteJournal(exec.agent, binding.agentId)
        appendVariableJournal(journal, {
          tool: 'variable_delete',
          phase: 'noop',
          target: journalTarget,
          names: [name],
        })
        return { found: false, scope: target.scope, name }
      }
      // Delete journals its `after` as `null`: a replay must know the variable
      // stopped existing, which an empty array would not express.
      const journal = await openWriteJournal(exec.agent, binding.agentId)
      appendVariableJournal(journal, {
        tool: 'variable_delete',
        phase: 'before',
        target: journalTarget,
        names: [name],
        before: [existing],
      })
      await store.delete(target.scope, target.scopeId, name, typeof args.expectedRevision === 'string' ? args.expectedRevision : existing.revision)
      appendVariableJournal(journal, { tool: 'variable_delete', phase: 'after', target: journalTarget, after: null })
      return { found: true, scope: target.scope, name }
    }),
    tool('variable_list', 'List variable names and value summaries in the given scope, filtered by prefix.', {
      scope: variableScopeParameter(true),
      prefix: { type: 'string', description: 'Name prefix filter, capped at 64 characters.' },
      limit: { type: 'integer', description: 'Maximum entries, capped at 100.' },
    }, variableListOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      const entries = await (await variableStore()).list(
        target.scope,
        target.scopeId,
        typeof args.prefix === 'string' ? args.prefix.slice(0, 64) : '',
        clampInt(args.limit, 1, 100, 50),
      )
      return {
        scope: target.scope,
        variables: entries.map(variableSummary),
        sourceCount: entries.length,
        truncated: entries.length >= clampInt(args.limit, 1, 100, 50),
      }
    }),
  ]
}

/** One phase of a journaled variable mutation. */
interface VariableJournalPhase {
  readonly tool: WriteJournalVariableTool
  readonly phase: WriteJournalPhase
  readonly target: WriteJournalVariableTarget
  readonly names?: readonly string[]
  readonly before?: readonly VariableSnapshot[] | null
  readonly after?: readonly VariableSnapshot[] | null
}

/**
 * Append one journal phase when the host exposes the seam.
 *
 * `journal === undefined` means the host has no `appendPluginRecord`; the tool
 * then keeps its ordinary write and records nothing (proposal 0022 §3). Host
 * append failures propagate with their tool/phase/journal id context.
 */
function appendVariableJournal(journal: WriteJournalHandle | undefined, request: VariableJournalPhase): void {
  if (journal === undefined) return
  appendWriteJournalWith(journal.writer, journal.session, {
    kind: 'variable',
    tool: request.tool,
    journalId: journal.journalId,
    sessionId: journal.sessionId,
    turn: journal.turn,
    phase: request.phase,
    at: new Date().toISOString(),
    target: request.target,
    ...(request.names === undefined ? {} : { names: request.names }),
    ...(request.before === undefined ? {} : { before: request.before }),
    ...(request.after === undefined ? {} : { after: request.after }),
  })
}

/**
 * Journal one write tool call that provably changed nothing.
 *
 * A missing target or a policy refusal leaves no business write behind, but the
 * tool call is still in the session log. The `noop` record proves "nothing was
 * written" so journal coverage does not report a lost journal.
 */
async function journalVariableNoop(
  exec: ToolExecution,
  agentId: string,
  tool: WriteJournalVariableTool,
  target: WriteJournalVariableTarget,
  names: readonly string[],
): Promise<void> {
  const journal = await openWriteJournal(exec.agent, agentId)
  appendVariableJournal(journal, {
    tool,
    phase: 'noop',
    target,
    ...(names.length === 0 ? {} : { names }),
  })
}

/** `assertWriteScopeAllowed` plus its noop record when the scope is refused. */
async function assertVariableScopeAllowed(
  exec: ToolExecution,
  agentId: string,
  target: WriteJournalVariableTarget,
  tool: WriteJournalVariableTool,
  names: readonly string[],
): Promise<void> {
  try {
    await assertWriteScopeAllowed(target.scope)
  } catch (error) {
    await journalVariableNoop(exec, agentId, tool, target, names)
    throw error
  }
}

const variableGetOutput = objectOutput(
  { found: { type: 'boolean' }, scope: { type: 'string' }, name: { type: 'string' }, value: {}, revision: { type: 'string' }, updatedAt: { type: 'string' } },
  ['value', 'revision', 'updatedAt'],
)
const variableSetOutput = objectOutput(
  { found: { type: 'boolean' }, scope: { type: 'string' }, name: { type: 'string' }, value: {}, revision: { type: 'string' }, updatedAt: { type: 'string' } },
  ['revision', 'updatedAt'],
)
const variableListOutput = objectOutput({
  scope: { type: 'string' },
  variables: { type: 'array', items: { type: 'object', additionalProperties: true } },
  sourceCount: { type: 'integer' },
  truncated: { type: 'boolean' },
})
const variableDeleteOutput = objectOutput(
  { found: { type: 'boolean' }, scope: { type: 'string' }, name: { type: 'string' } },
  [],
)
function variableSummary(snapshot: { name: string; value: unknown; revision: string; updatedAt: string }): Record<string, unknown> {
  return { name: snapshot.name, value: snapshot.value, revision: snapshot.revision, updatedAt: snapshot.updatedAt }
}

/** Narrow a tool argument to the JSON value the variable store accepts. */
function jsonValueOf(value: unknown): JsonValue {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('invalid variable value')
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('variable number must be finite')
    return value
  }
  if (Array.isArray(value)) return value.map(jsonValueOf)
  if (typeof value === 'object') {
    const record: { [key: string]: JsonValue } = {}
    for (const [key, item] of Object.entries(value)) record[key] = jsonValueOf(item)
    return record
  }
  throw new Error('invalid variable value')
}
