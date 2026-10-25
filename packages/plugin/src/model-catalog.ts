import { hostPromptSafe } from './prompt-safety.js'
import { tavernMacroExpand } from './prompt-context.js'
import { store } from './runtime.js'
import type { CharacterCardIR, GroupIR } from '../../tavern-format/src/index.js'
import type { PluginContext } from './host-contract.js'

let activeAgentPrompt = ''

export function getActiveAgentPrompt(): string {
  return activeAgentPrompt
}

export function publicGroup(group: GroupIR) {
  return {
    name: group.name,
    members: group.members,
    disabledMembers: group.disabledMembers,
    activationStrategy: group.activationStrategy,
    allowSelfResponses: group.allowSelfResponses,
    autoModeDelay: group.autoModeDelay,
    chatCount: group.chats.length,
  }
}

export async function buildModelCatalog(ctx: PluginContext) {
  const catalog = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning = resolved.reasoning === undefined ? undefined : {
          efforts: resolved.reasoning.efforts.map((effort) => ({
            id: effort.id,
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort }),
        }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }
      }))
      return { kind: 'group' as const, group: { id: provider.id, name: provider.name, models: entries } }
    } catch (error) {
      return { kind: 'failure' as const, failure: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) } }
    }
  }))
  return {
    groups: catalog.flatMap((item) => item.kind === 'group' ? [item.group] : []).filter((group) => group.models.length > 0),
    failures: catalog.flatMap((item) => item.kind === 'failure' ? [item.failure] : []),
  }
}

export async function refreshActivePrompt() {
  try {
    const db = await store()
    const state = await db.getState()
    if (!state.nativeAgentPersona || !state.activeCharacter) { activeAgentPrompt = ''; return }
    const found = await db.getCharacter(state.activeCharacter)
    if (!found) { activeAgentPrompt = ''; return }
    const d = found.card.data
    // 卡字段原文含 ST 宏（{{user}}/{{char}}/...），宿主 interpolate 会把残留
    // {{...}} 当宿主变量渲染并抛错中止装配——先宏展开再安全化（prompt-safety.ts）。
    const expand = tavernMacroExpand(state, state.activeCharacter, found)
    activeAgentPrompt = hostPromptSafe([
      `Active roleplay character: ${d.nickname || d.name}`,
      d.description,
      d.personality ? `Personality: ${d.personality}` : '',
      d.scenario ? `Scenario: ${d.scenario}` : '',
    ].filter(Boolean).join('\n\n'), expand)
  } catch {
    activeAgentPrompt = ''
  }
}

export function publicCard(card: CharacterCardIR) {
  return { spec: card.spec, specVersion: card.specVersion, data: card.data }
}

/** 角色短身份摘要存在 data.extensions.agentTavern 下；服务端钳制长度，非字符串直接拒绝。 */
export function clampIdentitySummary(card: unknown): void {
  const record = typeof card === 'object' && card !== null ? card as { data?: { extensions?: Record<string, unknown> } } : undefined
  const extensions = record?.data?.extensions
  const agentTavern = extensions?.['agentTavern']
  if (!agentTavern || typeof agentTavern !== 'object' || Array.isArray(agentTavern)) return
  const fields = agentTavern as Record<string, unknown>
  const summary = fields['identitySummary']
  if (summary === undefined || summary === null || summary === '') {
    delete fields['identitySummary']
    return
  }
  if (typeof summary !== 'string') throw new Error('identitySummary must be a string')
  fields['identitySummary'] = summary.slice(0, 2000)
}
