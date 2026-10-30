import { AGENT_TAVERN_PRESET_ID } from '../agent-tavern/capabilities.js'
import { ensureChatVariables, seedJsrMvuVariables } from '../agent-tavern/mvu-compat.js'
import { historyImportAppends, isTavernSessionMarker } from '../agent-tavern/projector.js'
import { emitAgentPresetChanged } from '../agent-tavern/preset.js'
import { confirmSessionAppend, hostPluginMessageSource, sessionEvents } from '../../../bind/src/index.js'
import type { HostSessionEvent, HostSessionLog } from '../../../bind/src/index.js'
import type { SessionImportAppend } from '../agent-tavern/projector.js'
import { createMessage } from '../message.js'
import { refreshActivePrompt } from '../model-catalog.js'
import { tavernMacroExpand } from '../prompt-context.js'
import { store } from '../runtime.js'
import { assertAgentTavernAvailable, bindSession, TavernArchitectureConflictError } from './binding.js'
import { applyAgentTavernHistoryImport } from './activate.js'
import { occupyHostSession, parseTavernSessionCommand } from './trace.js'
import { lastSelectedPresetId } from './preset-marker.js'
import { buildAgentTavernPreloadSnapshot } from '../tavern-assets.js'
import { collectSessionRegexScripts } from '../regex-session.js'
import { handleNovelOpenCommand, handleWorkbenchOpenCommand } from '../http/novel.js'
import type { PluginContext } from '../host-contract.js'

interface SessionCommandAgent {
  id: string
  ctx: unknown
  session: HostSessionLog & { append(type: string, data: unknown, opts?: unknown): unknown }
  inject?: (message: unknown) => unknown
}

interface SessionCommandInput {
  agent: SessionCommandAgent
  rawInput: string
}

export function registerTavernSessionCommand(ctx: PluginContext): void {
  ctx.commands.register({
    // Internal bridge for the client binding API. It is intentionally separate
    // from the public slash-command surface.
    name: 'dsh-soulmojito-session',
    description: 'internal dsh-soulmojito session bridge',
    input: { hint: '<character> <chat-id>' },
    recordInput: false,
    handler: async ({ agent, rawInput }: SessionCommandInput) => {
      const parsed = parseTavernSessionCommand(rawInput)
      if (!parsed) return { kind: 'error', text: 'Invalid Tavern activation payload.' }
      const db = await store()
      if (parsed.action === 'close') {
        await db.updateState((state) => {
          const sessionBindings = { ...state.sessionBindings }
          delete sessionBindings[agent.id]
          return { sessionBindings }
        })
        // D-2 confirmable write（决策 2026-10-11-confirmable-session-writes）：关闭
        // marker 是「必须成立」写入——会话归档后客户端对 Tavern composer 的释放
        // 与日志里的关闭痕迹都以它在场为准。读回验证 + 一次重写；仍不在场即如实
        // 抛错（绑定删除已提交，但静默丢失关闭痕迹的会话更难诊断：宿主日志有据）。
        const closed = confirmSessionAppend({
          session: agent.session,
          logger: ctx.logger,
          label: `Tavern close marker (${agent.id})`,
          append: () => agent.session.append('user/message', createMessage({
            role: 'user',
            content: [{ type: 'text', text: 'Tavern roleplay mode closed.' }],
            source: hostPluginMessageSource(agent.session, {
              form: 'notice',
              summary: 'Tavern closed',
            }),
          }), { surfaceOp: 'append' }),
          present: (events) => events.some((event) => event.type === 'user/message'
            && isTavernSessionMarker(event.data?.source)
            && (event.data?.source as { summary?: unknown } | undefined)?.summary === 'Tavern closed'),
        })
        if (!closed) {
          throw new Error(`dsh-soulmojito: the Tavern close marker could not be confirmed in session '${agent.id}' after a rewrite; the host accepted the append but the read-back found no trace`)
        }
        return { kind: 'success', text: 'Tavern closed' }
      }
      if (parsed.action === 'novel-open') {
        return handleNovelOpenCommand(ctx, agent, parsed.novelId)
      }
      if (parsed.action === 'workbench-open') {
        return handleWorkbenchOpenCommand(ctx, agent, parsed)
      }
      const chatSnapshot = await db.getChatSnapshot(parsed.character, parsed.chatId)
      if (!chatSnapshot) return { kind: 'error', text: 'Tavern chat not found.' }
      const chat = chatSnapshot.chat
      const currentState = await db.getState()
      const previous = currentState.sessionBindings[agent.id]
      const initializeAgentTavern = parsed.architecture === 'agent-tavern'
        && (previous?.architecture !== 'agent-tavern' || previous.initializationPending === true)
      const shouldPreloadAssets = initializeAgentTavern
        && parsed.group !== true
        && currentState.agentTavernPreloadAssets === true
      let preloadSnapshot: string | undefined
      let historyImport: SessionImportAppend[] | undefined
      await assertAgentTavernAvailable(parsed.architecture, parsed.contextMode)
      if (parsed.architecture === 'agent-tavern') {
        // 客户端修复路径（视图挂载、blank 修复）会对已激活会话重发本命令；同绑定
        // 的重复激活必须幂等成功，否则开场白导入写入的 turn 会把修复变成用户可见
        // 的报错。已启动的会话只锁定换绑定目标（换角色/聊天或从 ST 转换会换预设）。
        const sameTavernBinding = previous?.architecture === 'agent-tavern'
          && previous.character === parsed.character
          && previous.chatId === parsed.chatId
        // 宿主 0.1.2 起事件日志经 host-session 兼容层读取（events →
        // snapshotEvents() → log）；同一激活流程内无追加，读一次即可。
        const activationEvents = sessionEvents(agent.session)
        const sessionStarted = activationEvents.some((event) => event.type === 'turn/start')
        const historyImported = activationEvents.some((event) => {
          if (event.type !== 'user/message' && event.type !== 'assistant/message') return false
          const source = event.type === 'user/message'
            ? event.data?.source
            : event.data?.message?.source
          return isTavernSessionMarker(source)
        })
        if ((sessionStarted || historyImported) && !sameTavernBinding) {
          throw new TavernArchitectureConflictError('This host session already started; AgentTavern preset selection is locked.')
        }
        if (typeof ctx.agentPresets?.recompose !== 'function') {
          throw new TavernArchitectureConflictError('The host cannot recompose a blank session with the AgentTavern preset.')
        }
        const character = parsed.group !== true && (initializeAgentTavern || shouldPreloadAssets)
          ? await db.getCharacter(parsed.character)
          : undefined
        if (initializeAgentTavern && character !== undefined
          && seedJsrMvuVariables(character.card, ensureChatVariables(chat))) {
          // 激活旧聊天：补 MVU 初始变量。保存必须 CAS，失败如实抛给命令层。
          await db.saveChat(parsed.character, parsed.chatId, chat, chatSnapshot.revision)
        }
        if (initializeAgentTavern && parsed.group !== true) {
          // 开场白与既有聊天记录必须先落到原生会话，用户才能在 DSH 会话里看到
          // 角色开口；带插件来源的导入事件由投影器跳过，不会重复写回 JSONL。
          // 历史文本应用 prompt 层正则与宏展开（{{char}}/{{user}}），模型上下文
          // 与 ST 管线一致。会话已有原生 turn 或导入消息（投影器重放先于
          // 激活完成）时历史已在场，跳过导入防重复。
          historyImport = sessionStarted || historyImported
            ? undefined
            : historyImportAppends(chat, agent.id, character ? await collectSessionRegexScripts(db, currentState, parsed.character, parsed.chatId, character) : [], tavernMacroExpand(currentState, parsed.character, character), agent.session)
        }
        if (shouldPreloadAssets) {
          if (typeof agent.inject !== 'function') {
            throw new TavernArchitectureConflictError('This host cannot preload AgentTavern session context.')
          }
          if (!character) throw new Error('Tavern character not found.')
          preloadSnapshot = await buildAgentTavernPreloadSnapshot(db, currentState, parsed.character, character, tavernMacroExpand(currentState, parsed.character, character))
        }
        // 幂等：最后一条 selected 已是 agent-tavern 时不重复 recompose/marker。
        // 0.2.1 的 reuseLive 会把 blank 会话改回请求的 preset（通常是宿主默认
        // standard），日志尾部出现第二条件 selected；只认「曾经出现过」会让这里
        // 短路，工具面永久停在 standard。判定必须读最后一条。
        const lastSelected = lastSelectedPresetId(agent.session)
        if (lastSelected !== AGENT_TAVERN_PRESET_ID) {
          if (sessionStarted && lastSelected !== undefined) {
            throw new TavernArchitectureConflictError(`This host session already started under preset '${lastSelected}'; AgentTavern cannot be re-selected.`)
          }
          const preset = await ctx.agentPresets.recompose(agent.ctx, AGENT_TAVERN_PRESET_ID)
          // D-2 confirmable write：预设 marker 驱动宿主的 agentPreset 投影
          // （dsh-agent-preset-registry：init 于 header、只认日志里的
          // agent-preset/selected）——丢失即会话在重载后失去 AgentTavern 身份。
          // 同 id 的重复 selected 事件无害（投影取最后一条），重写安全。
          const selected = confirmSessionAppend({
            session: agent.session,
            logger: ctx.logger,
            label: `AgentTavern preset marker (${agent.id})`,
            append: () => agent.session.append('agent-preset/selected', { agentPreset: preset.id }),
            present: () => lastSelectedPresetId(agent.session) === preset.id,
          })
          if (!selected) {
            throw new Error(`dsh-soulmojito: the AgentTavern preset marker could not be confirmed in session '${agent.id}' after a rewrite; the session would silently lose its preset identity on reload`)
          }
        }
      }
      await bindSession(
        db,
        agent.id,
        parsed.character,
        parsed.chatId,
        parsed.group === true,
        parsed.architecture,
        parsed.contextMode,
      )
      if (parsed.architecture === 'agent-tavern') {
        // 预热激活预设投影（agent-tavern/preset.ts）：投影与 facts/guides 同款
        // 异步装载，激活时先写穿缓存，首轮请求就带预设——否则首轮装配拿到空串，
        // 用户看到的现象就是「预设不生效」。绑定已落库，监听按 binding 反查。
        await emitAgentPresetChanged()
      }
      if (preloadSnapshot !== undefined) {
        if (agent.inject === undefined) {
          throw new TavernArchitectureConflictError('This host cannot preload AgentTavern session context.')
        }
        agent.inject(createMessage({
          role: 'user',
          content: [{ type: 'text', text: preloadSnapshot }],
          source: hostPluginMessageSource(agent.session, {
            form: 'notice',
            summary: `AgentTavern preload: ${parsed.character}`,
          }),
        }))
      }
      if (historyImport !== undefined) {
        // 落地协议（读回校验 / 后缀补写 / 失败兜底关 turn / 推进轮次基线）与
        // IM 新建会话共用 session/activate.ts，禁止第二份实现。
        applyAgentTavernHistoryImport({
          agent,
          plan: historyImport,
          ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
        })
      }
      await refreshActivePrompt()
      if (parsed.architecture === 'st') {
        occupyHostSession(agent, ctx)
        // D-2 confirmable write：激活 marker 是客户端 view/composer 接管的判据
        // （client isTavernSession 扫 session surface 里的 plugin notice marker）。
        // 绑定换目标，或日志里缺同角色 marker（此前被吞写/丢失）时追加——后者是
        // 自愈：旧逻辑按插件库绑定 diff 判重，marker 一旦丢失就永远补不回来，
        // composer 从此不接管。读回验证 + 一次重写；仍不在场如实抛错——比
        // 「绑定成功但 composer 永不接管」可诊断。
        const markerSummary = `Tavern: ${parsed.character}`
        const markerPresent = (events: readonly HostSessionEvent[]) => events.some((event) => event.type === 'user/message'
          && isTavernSessionMarker(event.data?.source)
          && (event.data?.source as { summary?: unknown } | undefined)?.summary === markerSummary)
        const bindingChanged = previous?.character !== parsed.character || previous.chatId !== parsed.chatId
        if (bindingChanged || !markerPresent(sessionEvents(agent.session))) {
          const activated = confirmSessionAppend({
            session: agent.session,
            logger: ctx.logger,
            label: `Tavern activation marker (${parsed.character})`,
            append: () => agent.session.append('user/message', createMessage({
              role: 'user',
              content: [{ type: 'text', text: `Tavern roleplay chat for ${parsed.character}.` }],
              source: hostPluginMessageSource(agent.session, { form: 'notice', summary: markerSummary }),
            }), { surfaceOp: 'append' }),
            present: markerPresent,
          })
          if (!activated) {
            throw new Error(`dsh-soulmojito: the Tavern activation marker could not be confirmed in session '${agent.id}' after a rewrite; the client composer would never take over an unmarked session`)
          }
        }
      }
      return { kind: 'success', text: `Tavern: ${parsed.character}` }
    },
  })
}
