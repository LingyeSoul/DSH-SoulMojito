/** AgentTavern variable tool slice (registration order 10-14). */

import { clampInt, stringArg } from '../../tool-args.js'
import {
  assertWriteScopeAllowed,
  bindingFor,
  objectOutput,
  selectedVariableScope,
  tool,
  variableScopeParameter,
  type ToolDefinition,
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
      await assertWriteScopeAllowed(target.scope)
      const snapshot = await (await variableStore()).set(
        target.scope,
        target.scopeId,
        stringArg(args.name),
        args.value as never,
        typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
      )
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
      await assertWriteScopeAllowed(target.scope)
      if (!Array.isArray(args.changes) || args.changes.length === 0 || args.changes.length > 32) {
        throw new Error('changes must be a non-empty array of at most 32 entries')
      }
      const changes = args.changes.map((change) => {
        const entry = change as Record<string, unknown>
        return {
          name: stringArg(entry.name),
          value: entry.value as never,
          ...(typeof entry.expectedRevision === 'string' ? { expectedRevision: entry.expectedRevision } : {}),
        }
      })
      const snapshots = await (await variableStore()).patch(
        target.scope,
        target.scopeId,
        changes,
        typeof args.expectedRevision === 'string' ? args.expectedRevision : undefined,
      )
      return { scope: target.scope, variables: snapshots.map(variableSummary), truncated: false }
    }),
    tool('variable_delete', 'Delete one variable from the given scope; the audit-visible value history stays in the session log.', {
      scope: variableScopeParameter(true),
      name: { type: 'string', required: true },
      expectedRevision: { type: 'string' },
    }, variableDeleteOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      const target = selectedVariableScope(args.scope, binding)
      await assertWriteScopeAllowed(target.scope)
      const store = await variableStore()
      const name = stringArg(args.name)
      const existing = await store.get(target.scope, target.scopeId, name)
      if (existing === undefined) return { found: false, scope: target.scope, name }
      await store.delete(target.scope, target.scopeId, name, typeof args.expectedRevision === 'string' ? args.expectedRevision : existing.revision)
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
