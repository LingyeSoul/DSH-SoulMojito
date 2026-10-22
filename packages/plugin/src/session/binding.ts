import { getAgentTavernCapabilities, getAgentTavernCapabilitiesPromise } from '../runtime.js'

export class TavernArchitectureConflictError extends Error {
  readonly code = 'TAVERN_ARCHITECTURE_CONFLICT'
  constructor(message: string) {
    super(message)
    this.name = 'TavernArchitectureConflictError'
  }
}
export async function bindSession(
  db,
  sessionId,
  character,
  chatId,
  group = false,
  architecture = 'st',
  contextMode = 'dsh-native',
  initializationPending = false,
) {
  // 绑定即进入某张卡的会话：先把旧 state 的卡级 regex 归属补齐一次（字段存在
  // 后为纯读），保证本会话第一次生成就按角色卡过滤。
  await db.ensureRegexScriptOwners()
  // 世界书跟随角色卡是会话级行为：绑定的世界书由 collectWorldInfoBooks 按当前
  // 会话角色自动并入，不写 activeWorlds（手动激活列表归用户所有）。
  return db.updateState((state) => {
    const existing = state.sessionBindings[sessionId]
    const sameAgentBinding = existing?.architecture === 'agent-tavern'
      && existing.character === character
      && existing.chatId === chatId
    const pending = initializationPending
      && (existing?.initializationPending === true || !sameAgentBinding)
    const binding = architecture === 'agent-tavern' && !group
      ? {
          architecture: 'agent-tavern', contextMode, character, chatId,
          ...(pending ? { initializationPending: true } : {}),
        }
      : { architecture: 'st', character, chatId, ...(group ? { group: true } : {}) }
    return {
      activeCharacter: group ? state.activeCharacter : character,
      sessionBindings: {
        ...state.sessionBindings,
        [sessionId]: binding,
      },
    }
  })
}

export async function assertAgentTavernAvailable(architecture, contextMode) {
  if (architecture !== 'agent-tavern') return
  const capabilities = await getAgentTavernCapabilitiesPromise() ?? getAgentTavernCapabilities()
  const status = contextMode === 'agent-managed' ? capabilities.managed : capabilities.native
  if (!status.available) {
    throw new TavernArchitectureConflictError(`AgentTavern ${contextMode} is unavailable: ${status.reasons.join(' ')}`)
  }
}

export function requestedArchitecture(value) {
  if (value === undefined || value === 'st') return 'st'
  if (value === 'agent-tavern') return value
  throw new Error(`unsupported Tavern architecture '${String(value)}'`)
}

export function requestedContextMode(value) {
  if (value === undefined || value === 'dsh-native') return 'dsh-native'
  if (value === 'agent-managed') return value
  throw new Error(`unsupported AgentTavern context mode '${String(value)}'`)
}

export function assertStGenerationBinding(state, sessionId) {
  if (typeof sessionId !== 'string') return
  const binding = state.sessionBindings[sessionId]
  if (binding?.architecture === 'agent-tavern') {
    throw new TavernArchitectureConflictError('AgentTavern sessions use the DSH native AgentLoop; the ST generation endpoint is unavailable.')
  }
}
