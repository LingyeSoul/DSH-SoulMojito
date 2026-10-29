/** AgentTavern deduction and MVU settlement tool slice (registration order 17-18). */

import { tavernDataRoot } from '../../dsh-home.js'
import {
  appendMvuReceipt,
  overlayScopedVariables,
  readChatVariables,
  type MvuReceipt,
  type MvuVariableChange,
} from '../../mvu.js'
import type { JsonValue, VariableSnapshot } from '../../../../tavern-store/src/index.js'
import { getMvuTreePath, guardMvuWrite, readMvuSchema } from '../../mvu-guard.js'
import { readMvuRules, runMvuRules, type MvuRuleWrite } from '../../mvu-rules.js'
import {
  DEDUCE_MAX_ROLES,
  DEDUCE_MAX_ROUNDS,
  type DeductionExecAgent,
  parseDeductionRequest,
  runDeduction,
  subagentRuntimeOf,
} from '../deduce.js'
import {
  appendSettleIntentWith,
  openSettleIntent,
  openSettleIntentsOf,
  type SettleIntentItem,
} from '../write-journal.js'
import { appendMvuAudit } from '../projector.js'
import { bindingFor, objectOutput, tool, type ToolDefinition } from './shared.js'
import { tavernStore, variableStore } from './stores.js'


export function deductionTools(): ToolDefinition[] {
  return [
    tool('tavern_deduce', 'Run a multi-role scenario deduction: derive 2-5 named roles from the current story, spawn one reasoning-only subagent per role, and collect their predicted positions across 1-3 rounds. Use when the user asks to simulate, war-game, or deduce how a situation would unfold. Returns each role\'s position per round; weave the conclusion into the narrative yourself.', {
      scenario: { type: 'string', required: true, description: 'The concrete situation or what-if to deduce, grounded in established story facts, capped at 2000 characters.' },
      roles: {
        type: 'array', required: true, description: `2-${DEDUCE_MAX_ROLES} roles with distinct stakes, e.g. key characters, groups, or an omniscient narrator. Each brief states the role\'s perspective, knowledge and goal.`,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique short role name, capped at 80 characters.' },
            brief: { type: 'string', description: 'Role perspective, knowledge and goal, capped at 1500 characters.' },
          },
          required: ['name', 'brief'],
          additionalProperties: false,
        },
      },
      rounds: { type: 'integer', description: `Cross-examination rounds, 1-${DEDUCE_MAX_ROUNDS}. Rounds after the first let each role see and react to earlier positions. Default 1.` },
    }, deductionOutput, async (args, exec) => {
      await bindingFor(exec)
      const parent = exec.agent as DeductionExecAgent | undefined
      const subagents = subagentRuntimeOf(parent)
      if (!subagents) {
        throw new Error('subagent runtime is unavailable in this deployment; enable the dsh-subagent bundle with an in-process "spawn" provider to run deductions')
      }
      return runDeduction({ subagents, parent, signal: exec.signal }, parseDeductionRequest(args))
    }),
    tool('tavern_variable_settle', 'Settle tracked variable state for the current turn in one batch: writes chat-scope variables and records an MVU receipt (before/after per change, per-item failures) plus an audit line. Use it instead of scattered variable_set calls whenever a turn moves tracked story state; retrying a failed item is a fresh settle, the narrative stays untouched.', {
      changes: {
        type: 'array', required: true, description: 'Up to 16 entries of { name, value, reason? }.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Variable name, 1-64 characters; letters of any script (Chinese MVU names included), digits, dot, dash, underscore.' },
            value: {},
            reason: { type: 'string', description: 'Optional one-line settlement reason, capped at 200 characters.' },
          },
          required: ['name', 'value'],
          additionalProperties: false,
        },
      },
    }, settleOutput, async (args, exec) => {
      const binding = await bindingFor(exec)
      exec.signal?.throwIfAborted()
      if (!Array.isArray(args.changes) || args.changes.length === 0 || args.changes.length > 16) {
        throw new Error('changes must be a non-empty array of at most 16 entries')
      }
      const requests = args.changes.map((change) => {
        const entry = change as Record<string, unknown>
        if (typeof entry.name !== 'string' || entry.name.trim() === '') {
          throw new Error('each change requires a non-empty string name')
        }
        return {
          name: entry.name,
          value: entry.value,
          reason: typeof entry.reason === 'string' && entry.reason.trim() !== '' ? entry.reason.slice(0, 200) : undefined,
        }
      })
      // 读聊天对齐 tavern_scene_get（getChat），但保存必须带 revision CAS，故直接
      // 取 snapshot（getChatSnapshot/saveChat，与 retryMvuSettlement 同通道）。
      const db = await tavernStore()
      const snapshot = await db.getChatSnapshot(binding.character, binding.chatId)
      if (!snapshot) throw new Error('bound Tavern chat not found')
      const chat = snapshot.chat

      // MVU $schema 写入守卫（C-1）+ $rules 条件规则（C-2）：与 ST 生成/重试共享
      // 同一守卫/规则语义（mvu-guard.ts / mvu-rules.ts）。schema/rules 来源：聊天
      // 变量树根 → 卡 initialVariables → 世界书 InitialVariables（readMvuSchema /
      // readMvuRules 同链路）。flat store 的名字校验不含 `$`，$schema/$rules 本体
      // 永不可结算。种子树用于 ro/step 的「当前值」判定与规则求值基线：flat store
      // 未写过的路径回退聊天播种值。
      const card = (await db.getCharacter(binding.character))?.card
      const guardSchema = readMvuSchema(chat, card)
      const ruleSource = readMvuRules(chat, card)
      const seedTree = readChatVariables(chat)

      // 逐项写 chat 作用域变量（variable_set 同款 store 语义）：单项失败（非法
      // 名、超限值等 store 层校验，或 guard 拒绝）只记入 failures，不影响其他项。
      const store = await variableStore()
      // C-2 规则相的树基线：写前 flat 全量快照（listAll 不设 MAX_LIST 封顶——
      // 静默截断会让规则在缺项的基线上求值）——「flat 写后的树快照」由此叠加
      // 本轮成功写入构成；无 $rules 时零额外读。
      const preEntries = ruleSource !== undefined
        ? await store.listAll('chat', binding.chatId)
        : []
      // Durable intent before the first flat write: a crash between the flat
      // write and the chat save leaves an open record that startup recovery
      // restores from `before`. The append is fail-closed; no flat write starts
      // when the host rejects it.
      const settleIntent = await openSettleIntent(exec.agent, binding.agentId)
      const settlementAt = new Date().toISOString()
      if (settleIntent !== undefined) {
        const items: SettleIntentItem[] = []
        for (const request of requests) {
          let before: JsonValue | undefined
          try {
            before = (await store.get('chat', binding.chatId, request.name))?.value
          } catch {
            // An invalid name has no flat value; the batch records its failure.
          }
          let after: JsonValue | undefined
          try {
            after = jsonValueOf(request.value)
          } catch {
            // A non-JSON value can never be written; the batch records its failure.
          }
          items.push({
            name: request.name,
            ...(before === undefined ? {} : { before }),
            ...(after === undefined ? {} : { after }),
          })
        }
        appendSettleIntentWith(settleIntent.writer, settleIntent.session, {
          kind: 'settle-intent',
          phase: 'open',
          opId: settleIntent.opId,
          sessionId: settleIntent.sessionId,
          character: binding.character,
          scope: 'chat',
          scopeId: binding.chatId,
          turnKey: String(chat.messages.length),
          receiptAt: settlementAt,
          at: settlementAt,
          items,
        })
      }
      const applied: string[] = []
      const failed: Array<{ name: string; error: string }> = []
      const receiptChanges: MvuVariableChange[] = []
      // 本轮成功写入的 flat 条目（规则相构树快照用；值为守卫后落库值）。
      const writtenEntries: Array<{ name: string; value: unknown }> = []
      // 审计项与请求一一对应（成功项带 before/after，失败项只有名字），不能事后
      // 按 receiptChanges 下标对账——失败项不入 receiptChanges，下标会错位。
      const auditChanges: Array<{ name: string; reason?: string; before?: unknown; after?: unknown }> = []
      for (const request of requests) {
        try {
          // store.get 的名字校验先于守卫执行（$schema 等 `$` 开头名本就不可存）：
          // 抛错时过一遍守卫语义归因——$schema 路径报 guard readonly，其余保留
          // store 原始报错（既有失败路径）。
          let existing: Awaited<ReturnType<typeof store.get>> = undefined
          try {
            existing = await store.get('chat', binding.chatId, request.name)
          } catch (nameError) {
            const screened = guardSchema === undefined ? undefined : guardMvuWrite(guardSchema, request.name, request.value, undefined)
            failed.push({
              name: request.name,
              error: screened !== undefined && !screened.ok
                ? `guard ${screened.kind}: ${screened.reason}`
                : (nameError instanceof Error ? nameError.message : String(nameError)),
            })
            auditChanges.push({
              name: request.name,
              ...(request.reason !== undefined ? { reason: request.reason } : {}),
            })
            continue
          }
          const current = existing !== undefined ? existing.value : getMvuTreePath(seedTree, request.name)
          // Validate the value at the same point the store would (after the name
          // check) so a malformed item still fails alone instead of the batch.
          const requestValue = jsonValueOf(request.value)
          // 守卫先行：clamp/step 调整值落库并记 reason；reject（type-mismatch /
          // enum-violation / readonly / structure）走既有单项失败路径，可重试。
          const guarded = guardSchema === undefined ? undefined : guardMvuWrite(guardSchema, request.name, requestValue, current)
          if (guarded !== undefined && !guarded.ok) {
            failed.push({ name: request.name, error: `guard ${guarded.kind}: ${guarded.reason}` })
            auditChanges.push({
              name: request.name,
              ...(request.reason !== undefined ? { reason: request.reason } : {}),
            })
            continue
          }
          // set 的既有语义：无 expectedRevision 只允许创建，更新必须 CAS。写前
          // 读旧值并以其 revision 作期望（variable_delete 同款习语）；get 与 set
          // 之间的真并发写仍会冲突并落 failures，交给下一次结算重试。
          const written = await store.set(
            'chat', binding.chatId, request.name,
            guarded === undefined ? requestValue : jsonValueOf(guarded.value),
            existing?.revision,
          )
          applied.push(request.name)
          writtenEntries.push({ name: request.name, value: written.value })
          const guardNote = guarded !== undefined && guarded.ok ? guarded.note : undefined
          const auditReason = [request.reason, guardNote].filter((part): part is string => part !== undefined).join('; ')
          const change: MvuVariableChange = {
            name: request.name,
            // before 取守卫同源的「当前值」（flat 既有值 ?? 聊天播种树）：回执按
            // 覆盖后的变量树视角呈现真实前后值（C-1；schema-less 卡播种树为空，
            // 行为不变）。
            ...(current !== undefined ? { before: current } : {}),
            after: written.value,
            ...(guardNote !== undefined ? { reason: guardNote } : {}),
          }
          receiptChanges.push(change)
          auditChanges.push({
            name: request.name,
            ...(auditReason !== '' ? { reason: auditReason } : {}),
            ...('before' in change ? { before: change.before } : {}),
            after: change.after,
          })
        } catch (error) {
          failed.push({ name: request.name, error: error instanceof Error ? error.message : String(error) })
          auditChanges.push({
            name: request.name,
            ...(request.reason !== undefined ? { reason: request.reason } : {}),
          })
        }
      }

      // $rules 条件规则相（C-2，与 ST 共享 runMvuRules 纯函数核）：flat 写后的树
      // 快照上跑——守卫后二次计算（派生值/阈值触发/连锁修正），规则产出再过一次
      // 守卫；产物进同一回执管线（reason 标 rule:<name>，clamp 附 guard note），
      // 写回 flat store（get→set 同款 CAS 习语，冲突落 failures 交下次结算重试）。
      // 无 $rules 的卡恒等跳过，行为不变（golden）。
      const ruleFailures: string[] = []
      if (ruleSource !== undefined) {
        if ('invalid' in ruleSource) {
          ruleFailures.push(ruleSource.invalid)
        } else {
          const preTree = overlayScopedVariables(seedTree, preEntries.map((entry) => ({ name: entry.name, value: entry.value })))
          const workTree = overlayScopedVariables(preTree, writtenEntries)
          const run = await runMvuRules(ruleSource.rules, { ...(guardSchema !== undefined ? { schema: guardSchema } : {}), tree: workTree })
          ruleFailures.push(...run.failures)
          // 同路径多轮触发只持久化终值（Map 末值胜出）；回执 reason 用 notes 的
          // 累计归因（rule:A; rule:B 如实呈现链路）。
          const terminalWrites = [...new Map(run.writes.map((write) => [write.path, write])).values()]
          // Resolve the exact payload and flat before value before recording the
          // intent: a malformed payload still fails alone, and the extend record
          // must describe what the write loop will actually store.
          const pendingWrites: PendingRuleWrite[] = []
          for (const write of terminalWrites) {
            let value: JsonValue
            let existing: VariableSnapshot | undefined
            try {
              value = jsonValueOf(write.value)
              existing = await store.get('chat', binding.chatId, write.path)
            } catch (error) {
              ruleFailures.push(`${write.path}: rule '${write.rule}': ${error instanceof Error ? error.message : String(error)}`)
              continue
            }
            pendingWrites.push({ write, value, existing })
          }
          // The open intent only lists request items. Append one extend record
          // covering every rule write before the first flat write; if the host
          // rejects it, no rule flat write runs and the failure closes the
          // receipt as failed. The intent stays recovery evidence only: the
          // receipt below still carries the rule changes exactly once.
          if (settleIntent !== undefined && pendingWrites.length > 0) {
            try {
              appendSettleIntentWith(settleIntent.writer, settleIntent.session, {
                kind: 'settle-intent',
                phase: 'extend',
                opId: settleIntent.opId,
                sessionId: settleIntent.sessionId,
                at: new Date().toISOString(),
                items: pendingWrites.map((pending) => ({
                  name: pending.write.path,
                  ...(pending.existing === undefined ? {} : { before: pending.existing.value }),
                  after: pending.value,
                })),
              })
            } catch (error) {
              ruleFailures.push(`rule settle intent: ${error instanceof Error ? error.message : String(error)}`)
              pendingWrites.length = 0
            }
          }
          for (const pending of pendingWrites) {
            const write = pending.write
            try {
              const written = await store.set('chat', binding.chatId, write.path, pending.value, pending.existing?.revision)
              const before = getMvuTreePath(preTree, write.path)
              const reason = run.notes[write.path] ?? `rule:${write.rule}`
              const change = receiptChanges.find((entry) => entry.name === write.path)
              if (change !== undefined) {
                change.after = written.value
                change.reason = change.reason !== undefined ? `${change.reason}; ${reason}` : reason
              } else {
                receiptChanges.push({
                  name: write.path,
                  ...(before !== undefined ? { before } : {}),
                  after: written.value,
                  reason,
                })
              }
              auditChanges.push({
                name: write.path,
                reason,
                ...(before !== undefined ? { before } : {}),
                after: written.value,
              })
            } catch (error) {
              ruleFailures.push(`${write.path}: rule '${write.rule}': ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }

      // 回执落 chat_metadata.mvu.receipts（P1 结构，环形 20 条）。工具形态的
      // turnKey 是「正在生成的楼层将占据的 messages 下标」：结算发生在楼层投影
      // 落库之前，同一楼层的多次结算共享同一 turnKey（P1 重试同楼层同理）。
      const receipt: MvuReceipt = {
        at: settlementAt,
        turnKey: String(chat.messages.length),
        // The durable intent's op id travels with the receipt: startup recovery
        // matches this settle by identity instead of guessing by at + turnKey.
        ...(settleIntent !== undefined ? { opId: settleIntent.opId } : {}),
        status: failed.length > 0 || ruleFailures.length > 0 ? 'failed' : receiptChanges.length > 0 ? 'updated' : 'unchanged',
        changes: receiptChanges,
        failures: [...failed.map((failure) => `${failure.name}: ${failure.error}`), ...ruleFailures],
      }
      appendMvuReceipt(chat, receipt)
      // CAS 冲突抛 ChatRevisionConflictError：由 agent 重调工具重试（变量已写、
      // 回执未落，重试幂等）。
      await db.saveChat(binding.character, binding.chatId, chat, snapshot.revision)
      // Close the intent only after the chat save persisted the receipt. A
      // failed append throws explicitly: an unclosed intent is never silent.
      // Every still-open intent of this chat closes too: an earlier failed
      // attempt must not undo this committed batch on the next startup.
      if (settleIntent !== undefined) {
        const closedAt = new Date().toISOString()
        for (const open of openSettleIntentsOf(settleIntent.session, settleIntent.sessionId)) {
          if (open.character !== binding.character || open.scopeId !== binding.chatId) continue
          appendSettleIntentWith(settleIntent.writer, settleIntent.session, {
            kind: 'settle-intent',
            phase: 'commit',
            opId: open.opId,
            sessionId: open.sessionId,
            at: closedAt,
            ...(open.opId === settleIntent.opId ? {} : { reason: `superseded by ${settleIntent.opId}` }),
          })
        }
      }
      // 回执的持久投影（提案 0012 P2）：会话事件词汇表对插件封闭（v4 宿主拒载
      // 未知事件类型），审计线落独立文件 <tavern>/mvu/audit.jsonl，见 projector.ts。
      await appendMvuAudit(tavernDataRoot(), {
        at: receipt.at,
        sessionId: binding.agentId,
        character: binding.character,
        chatId: binding.chatId,
        turnKey: receipt.turnKey,
        status: receipt.status,
        changes: auditChanges,
        failures: receipt.failures,
      })
      return { applied, failed, receipt }
    }),
  ]
}

const deductionOutput = objectOutput({
  scenario: { type: 'string' }, rounds: { type: 'integer' }, roleCount: { type: 'integer' },
  positions: { type: 'array', items: { type: 'object', additionalProperties: true } },
  failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
  truncated: { type: 'boolean' },
})
const settleOutput = objectOutput({
  applied: { type: 'array', items: { type: 'string' } },
  failed: { type: 'array', items: { type: 'object', additionalProperties: true } },
  receipt: { type: 'object', additionalProperties: true },
})

/** One resolved `$rules` write waiting for the intent append and flat write. */
interface PendingRuleWrite {
  readonly write: MvuRuleWrite
  readonly value: JsonValue
  readonly existing: VariableSnapshot | undefined
}

/** Narrow a tool argument to the JSON value the variable store accepts. */
function jsonValueOf(value: unknown): JsonValue {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('invalid variable value')
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return value
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