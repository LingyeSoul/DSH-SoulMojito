import { characterLinkedWorlds } from '../prompt-context.js'
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
  // 使用角色（会话绑定）时自动激活其绑定的世界书；群聊无单一角色，不并入。
  // worldFollowsCharacter 关闭时不并入，绑定世界书完全由 activeWorlds 显式控制。
  const follow = group ? false : (await db.getState()).worldFollowsCharacter !== false
  const linkedWorlds = follow ? await characterLinkedWorlds(db, character) : []
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
      ...(group || linkedWorlds.length === 0
        ? {}
        : { activeWorlds: [...new Set([...state.activeWorlds, ...linkedWorlds])] }),
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
