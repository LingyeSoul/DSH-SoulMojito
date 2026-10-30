/**
 * Minimal structural contract for the DSH host context.
 *
 * The plugin is bundled standalone and never imports @deepseek-ai/dsh types at
 * build time: the host package is resolved at runtime and its revisions drift.
 * These interfaces therefore model only the seams this plugin calls, and keep
 * everything else `unknown` so callers must narrow before use.
 */

import type { HostSessionEvent, HostSessionLog } from '../../bind/src/index.js'
import type { HttpRequest, HttpResponse } from './http/io.js'

export type HostLogMethod = (...args: unknown[]) => void

export interface HostLogger {
  info?: HostLogMethod
  warn?: HostLogMethod
  error?: HostLogMethod
  debug?: HostLogMethod
}

export interface HostModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface HostLlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: unknown
  id?: string
  source?: unknown
  [key: string]: unknown
}

export interface HostLlmRequest {
  provider: string
  model: string
  messages: readonly unknown[]
  system?: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  tools?: readonly unknown[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: string
  [key: string]: unknown
}

export interface HostFinishReason {
  kind: string
  failure?: { message?: string; code?: string }
}

export type HostLlmChunk =
  | { type: 'text-delta'; text: string; index?: number }
  | { type: 'reasoning-delta'; text: string; index?: number }
  | { type: 'usage'; usage: unknown }
  | { type: 'block-end'; block: Record<string, unknown>; index?: number }
  | { type: 'block-start'; blockType?: string; index?: number }
  | { type: 'tool-call-delta'; id?: string; name?: string; argumentsDelta?: string; index?: number }
  | { type: 'finish'; reason: HostFinishReason }

export interface HostProviderInfo {
  id: string
  name: string
}

export interface HostModelInfo {
  id: string
  name: string
  description?: string
}

export interface HostModelReasoningInfo {
  efforts: Array<{ id: string; name: string; description?: string }>
  defaultEffort?: string
}

export interface HostResolvedModelInfo extends HostModelInfo {
  reasoning?: HostModelReasoningInfo
}

export interface HostLlmService {
  stream(options: HostLlmRequest): AsyncIterable<HostLlmChunk>
  listProviders(): HostProviderInfo[]
  listModels(providerId: string): Promise<HostModelInfo[]>
  resolveModelInfo(providerId: string, modelId: string): Promise<HostResolvedModelInfo>
}

export interface HostAgentLike {
  id?: string
  session?: HostSessionLog & { id: string }
  ctx?: unknown
  status?: unknown
  /** Inbox append used by IM and game wake; the host loop owns turn scheduling. */
  followup?(message: unknown): Promise<unknown> | unknown
  whenIdle?(): Promise<unknown>
  [key: string]: unknown
}

export interface HostAgentsService {
  get?(id: string): HostAgentLike | undefined | null
  create?(...args: unknown[]): unknown
  /** Resume a persisted session (DSH 0.2.x shape, as used by official plugins). */
  resume?(...args: unknown[]): unknown
  /** All live agents, in registration order (0.2.x registry shape). */
  list?(): readonly HostAgentLike[]
}

export interface HostSessionEventLike extends HostSessionEvent {
  type: string
  seq: number
  time: number
}

export interface HostSessionLike extends HostSessionLog {
  id: string
}

export interface HostPromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
  complete?: boolean
  [key: string]: unknown
}

export interface HostPromptContext {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  [key: string]: unknown
}

export interface HostSystemPromptService {
  section(config: HostPromptSection): unknown
  context(config: HostPromptContext): unknown
}

export interface HostToolService {
  register?<T>(tool: T): unknown
  schemas?: () => Array<{ name: string }>
  restrict?(filter: { deny: string[] }): unknown
}

export interface HostCommandService {
  register(command: Record<string, unknown>): unknown
}

export interface HostAgentPresetsService {
  mount?(agentContext: unknown, presetId: string): Promise<unknown>
  recompose?(agentContext: unknown, presetId: string): Promise<{ id: string }>
  compositionInventory?(): Promise<Array<{ id?: unknown }>>
}

export interface HostCompactionService {
  compactNow?(agent: unknown, signal: AbortSignal, id?: string): Promise<unknown>
}

export interface HostSessionTitleService {
  rename?(session: unknown, title: string): unknown
}

export interface HostSessionProjectionsService {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * In-memory `ctx.sessions` store (DSH 0.2.x). Message projections are
 * long-lived contributions: the disposer belongs to the registering fiber and
 * must be retained for unload, not feature toggling.
 */
export interface HostSessionsService {
  registerMessageProjection?(projection: unknown): (() => void) | void
  get?(id: string): unknown
  list?(): readonly unknown[]
}

/**
 * `agent/turn-stopping` payload. The host serial event carries the subject
 * agent, the turn that is about to close and its cancellation signal.
 */
export interface HostTurnStoppingPayload {
  turn?: unknown
  signal?: unknown
  agent?: HostAgentLike
  agentId?: unknown
}

export interface HostWebRoute {
  kind: 'prefix'
  path: string
  handler: (req: HostWebRequest, res: HostWebResponse) => Promise<void> | void
}

export type HostWebRequest = HttpRequest

export type HostWebResponse = HttpResponse

export interface HostWebServerService {
  register(route: HostWebRoute): () => void
  /**
   * Exact-path HTTP upgrade seat (DSH `dsh-host-webserver`). Optional: hosts
   * without it keep the HTTP POST fallback and the panel reports it.
   */
  registerUpgrade?(route: HostWebUpgradeRoute): () => void
  host?: unknown
  port?: unknown
  getOrigin?(): unknown
}

/** One upgrade registration: the handler owns protocol negotiation and the socket. */
export interface HostWebUpgradeRoute {
  path: string
  handler: (req: HostWebRequest, socket: unknown, head: Buffer) => Promise<void> | void
}

/**
 * Plugin context: the subset of the host Cordis context this package uses.
 * Services the host always injects are required; optional seams stay optional
 * so feature detection stays explicit at the call site.
 */
export interface PluginContext {
  llm: HostLlmService
  agentDefaultModel: { currentSelection(): HostModelSelection }
  systemPrompt: HostSystemPromptService
  webServer: HostWebServerService
  commands: HostCommandService
  effect(callback: () => (() => void) | void, label?: string): unknown
  logger?: HostLogger
  agents?: HostAgentsService
  sessions?: HostSessionsService
  tools?: HostToolService
  agentPresets?: HostAgentPresetsService
  compaction?: HostCompactionService
  sessionTitle?: HostSessionTitleService
  sessionProjections?: HostSessionProjectionsService
  agent?: unknown
  subagents?: unknown
  pluginManager?: unknown
  profileContext?: { name?: string }
  get?(name: string): unknown
  inject?(deps: readonly string[], callback: (serviceContext: PluginContext) => unknown): unknown
  on?(event: 'session/event', listener: (session: HostSessionLike, event: HostSessionEventLike) => unknown): unknown
  on?(event: 'agent/created', listener: (payload: { agent: HostAgentLike }) => unknown): unknown
  on?(event: 'agent/turn-stopping', listener: (payload: HostTurnStoppingPayload) => unknown): unknown
  on?(event: 'agent/request', listener: (payload: unknown, next: () => Promise<unknown>) => unknown): unknown
  on?(event: 'agent/pre-step', listener: (payload: unknown, next: () => Promise<unknown>) => unknown): unknown
  on?(event: 'tools/change', listener: () => unknown): unknown
  on?(event: string, listener: (...args: never[]) => unknown): unknown
}
