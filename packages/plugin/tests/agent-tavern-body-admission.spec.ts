/**
 * AgentTavern body operations — real-host seam regression.
 *
 * Proposal 0021 composes host seams instead of forking DSH:
 *   1. a log-only body record written through `appendPluginRecord()` (§2.5);
 *   2. a plugin-owned message projection that rewrites the anchor text;
 *   3. an empty `developer/message` replacement that removes a current surface node.
 *
 * This file pins those seams against the real DSH runtime. The record-seam
 * checks below deliberately do not import product code: the contract under test
 * belongs to the host, and the body ledger itself is covered by the sibling body
 * specs. The final two blocks add the plugin-level regressions that belong to
 * this slice: mounting without a `sessions` service (body disabled, other
 * surfaces intact), the missing-sessionId rejection code, and the turn/end
 * retry queue. Everything here is synthetic Example data.
 *
 * Host facts asserted below come from the installed sources:
 *   - `deriveEventMessage()` returns a projected message before the empty-content
 *     check, so a projection can empty a message but cannot remove it
 *     (`dsh-session/lib/index.js` 214-227 in 0.2.0-rc.2 / 217-230 in 0.2.1-rc.2,
 *     empty-content check at :225);
 *   - empty `developer/message` content derives no message while the replacement
 *     keeps the append-origin log record (`dsh-session/lib/index.js`
 *     `applySurfacePlan` 460-478 in 0.2.0-rc.2 / 463-481 in 0.2.1-rc.2);
 *   - `assistant/message` may never cite `sourceEventSeqs`, so it cannot replace a
 *     surface node (`dsh-session/lib/index.js`:316 in 0.2.1-rc.2);
 *   - `Session.append()` takes only surface metadata, while
 *     `appendPluginRecord()` commits `ignorable: true`
 *     (`dsh-session@0.2.1-rc.2` `lib/index.js`:1295 and `#appendRecord`
 *     1548-1557), and `pluginRecordOf()` reads the record back (`:1306`);
 *   - artifact admission owns vocabulary closure and refuses unknown event types
 *     unless `ignorable === true`
 *     (`dsh-session-format-v3-to-v4/lib/index.js`:989 in both 0.2.0-rc.2 and
 *     0.2.1-rc.2); the persistence read path applies the same rule
 *     (`dsh-session-persistence/lib/index.js` validateStoredEvents).
 *
 * The plugin-record API is 0.2.1-rc.2+ while the repo cache may still be
 * 0.2.0-rc.2, so this file resolves the newest usable runtime in the repo gate's
 * priority order (`packages/plugin/scripts/gates/run.mjs`
 * `locateOfficialDependencyRoot`): the repo cache, NODE_PATH entries (plus each
 * entry's `@deepseek-ai/dsh/node_modules` nested form), then the global npm root
 * from `npm root -g` (also with that nested form). Only the record-specific
 * tests skip when nothing exposes `appendPluginRecord`, and resolution fails
 * closed with a loud warning instead of a fake green.
 *
 * Known host-side risk kept visible: the 0.2.1 host README states that plugins
 * outside its repository must not call `appendPluginRecord` either
 * (`dsh-session@0.2.1-rc.2` README.md:70), so proposal §2.5 still needs a
 * host-side confirmation before release.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { handleBodySessionEvent, turnEndRestoreKey } from '../src/agent-tavern/body-wiring.js'
import { pendingByAgent } from '../src/agent-tavern/body-runtime-core.js'

/** Dependency root (a node_modules directory) of the vendored repo runtime. */
const REPO_RUNTIME_ROOT = fileURLToPath(new URL('../../../.npm-cache/dsh-runtime/node_modules', import.meta.url))
const SCOPE = '@deepseek-ai'
const MODULES = [
  'dsh-session/lib/index.js',
  'dsh-session-format-v3-to-v4/lib/index.js',
] as const

const SESSION_ID = 'session-body-seam'
const BASE_TIME = 1_700_000_000_000
const BODY_RECORD_TYPE = 'plugin:dsh-soulmojito/body'
const LEGACY_EVENT_TYPE = 'dsh-soulmojito/legacy-body'
const SYSTEM_TEXT = 'EXAMPLE SYSTEM PROMPT'
const USER_TEXT = 'EXAMPLE USER LINE'
const ORIGINAL_TEXT = 'EXAMPLE ASSISTANT REPLY'
const EDITED_TEXT = 'EXAMPLE EDITED REPLY'
const REASONING_TEXT = 'EXAMPLE REASONING'
const SYSTEM_MESSAGE_ID = 'example-system-1'
const USER_MESSAGE_ID = 'example-user-1'
const ASSISTANT_MESSAGE_ID = 'example-assistant-1'

type HostRole = 'system' | 'user' | 'assistant' | 'developer'

interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

type HostBlock = TextBlock | ReasoningBlock

interface HostMessageSource {
  readonly kind: string
  readonly provider?: string
  readonly model?: string
}

interface HostMessage {
  readonly id: string
  readonly role: HostRole
  readonly content: readonly HostBlock[]
  readonly source: HostMessageSource
}

interface ReplaceOp {
  readonly op: 'replace'
  readonly startSeq: number
  readonly endSeq: number
}

type SurfaceOpValue = 'append' | ReplaceOp

interface EventEnvelope<TType extends string, TData> {
  readonly type: TType
  readonly seq: number
  readonly time: number
  readonly data: TData
  readonly surfaceOp?: SurfaceOpValue
  readonly sourceEventSeqs?: readonly number[]
  readonly ignorable?: true
}

/** Detached event as returned by `snapshotEvents()` and accepted by artifact admission. */
interface CommittedEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: SurfaceOpValue
  readonly sourceEventSeqs?: readonly number[]
  readonly ignorable?: true
}

interface TurnStartData {
  readonly turn: number
}

interface StepData {
  readonly turn: number
  readonly step: number
}

interface TurnEndData {
  readonly turn: number
  readonly reason: { readonly kind: 'completed' }
}

interface AssistantData {
  readonly turn: number
  readonly step: number
  readonly stream: readonly never[]
  readonly message: HostMessage
}

interface SystemData {
  readonly turn: number
  readonly step: number
  readonly message: HostMessage
}

interface DeveloperData {
  readonly turn: number
  readonly step: number
  readonly message: HostMessage
}

interface BodyCandidateData {
  readonly op: 'candidate'
  readonly groupId: string
  readonly messageId: string
  readonly index: number
  readonly feedback?: string
}

interface BodyEditData {
  readonly op: 'edit'
  readonly groupId: string
  readonly index: number
  readonly text: string
  readonly previousText: string
}

interface BodySelectData {
  readonly op: 'select'
  readonly groupId: string
  readonly index: number
}

type BodyEventData = BodyCandidateData | BodyEditData | BodySelectData
type BodyEvent = EventEnvelope<typeof BODY_RECORD_TYPE, BodyEventData>

type SeedEvent =
  | EventEnvelope<'turn/start', TurnStartData>
  | EventEnvelope<'step/start', StepData>
  | EventEnvelope<'step/end', StepData>
  | EventEnvelope<'turn/end', TurnEndData>
  | EventEnvelope<'system/message', SystemData>
  | EventEnvelope<'user/message', HostMessage>
  | EventEnvelope<'assistant/message', AssistantData>
  | EventEnvelope<'developer/message', DeveloperData>
  | BodyEvent

interface SessionHeaderLike {
  readonly version: 4
  readonly id: string
  readonly createdAt: number
  readonly isSeeded: boolean
  readonly delegationDepth: number
}

interface SessionSurfaceLike {
  readonly nodes: readonly number[]
}

interface SurfaceAppendOptions {
  readonly surfaceOp: SurfaceOpValue
  readonly sourceEventSeqs?: readonly number[]
}

interface SessionLike {
  readonly id: string
  readonly seq: number
  readonly surface: SessionSurfaceLike
  snapshotEvents(): readonly CommittedEvent[]
  deriveMessages(): readonly HostMessage[]
  append(type: string, data: unknown, options?: SurfaceAppendOptions): CommittedEvent
}

interface ProjectionContext {
  readonly nodes: readonly number[]
  readonly events: readonly CommittedEvent[]
  readonly baseSeq: number
  readonly messages: ReadonlyMap<number, HostMessage>
}

interface MessageProjection {
  readonly type: string
  project(event: BodyEvent, context: ProjectionContext): ReadonlyMap<number, HostMessage>
}

/** Structural view of one committed plugin record returned by `pluginRecordOf()`. */
interface PluginRecordLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

interface V4Artifact {
  readonly header: SessionHeaderLike
  readonly events: readonly CommittedEvent[]
  readonly inheritedEventCount: number
}

type CreateSession = (
  id: string,
  seed: readonly CommittedEvent[],
  header: SessionHeaderLike,
  inheritedEventCount: number,
  projections: readonly MessageProjection[],
) => SessionLike

type RestoreV4Artifact = (artifact: V4Artifact, knownEventTypes: ReadonlySet<string>) => V4Artifact
type AssertV4Relationships = (artifact: V4Artifact, knownEventTypes: ReadonlySet<string>) => void
type AppendPluginRecord = (session: SessionLike, type: string, data: unknown) => number
type PluginRecordOf = (event: CommittedEvent) => PluginRecordLike | undefined

interface SessionModule {
  readonly Session: { readonly create: CreateSession }
  readonly KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string>
  readonly appendPluginRecord?: AppendPluginRecord
  readonly pluginRecordOf?: PluginRecordOf
}

interface SessionFormatModule {
  readonly restoreReleasedV4Artifact: RestoreV4Artifact
  readonly assertReleasedV4Relationships: AssertV4Relationships
}

interface RuntimeHost {
  readonly root: string
  readonly createSession: CreateSession
  readonly knownEventTypes: ReadonlySet<string>
  readonly restoreV4Artifact: RestoreV4Artifact
  readonly assertV4Relationships: AssertV4Relationships
  readonly appendPluginRecord: AppendPluginRecord | undefined
  readonly pluginRecordOf: PluginRecordOf | undefined
}

interface PluginRecordHost extends RuntimeHost {
  readonly appendPluginRecord: AppendPluginRecord
  readonly pluginRecordOf: PluginRecordOf
}

/**
 * Local dependency roots to probe, in the repo gate's order
 * (`packages/plugin/scripts/gates/run.mjs` locateOfficialDependencyRoot):
 *   1. the repo's vendored `.npm-cache/dsh-runtime/node_modules`;
 *   2. every NODE_PATH entry, plus its `@deepseek-ai/dsh/node_modules` nested form.
 * discoverHost() appends the global npm root (and the same nested form) as the
 * gate's third priority level after these local candidates.
 */
function localDependencyRoots(): readonly string[] {
  const roots: string[] = [REPO_RUNTIME_ROOT]
  const nodePath = process.env['NODE_PATH']
  if (nodePath !== undefined) {
    for (const entry of nodePath.split(delimiter)) {
      if (entry === '') continue
      roots.push(entry, join(entry, SCOPE, 'dsh', 'node_modules'))
    }
  }
  return roots
}

/**
 * Global npm root, mirroring the gate: `npm root -g` with npm_config_* overrides
 * cleared so the repo's local npm configuration cannot distort the answer.
 * Returns null when npm is unavailable or fails; resolution then fails closed.
 */
function npmGlobalRoot(): string | null {
  const env = { ...process.env }
  for (const key of ['npm_config_prefix', 'npm_config_local_prefix', 'npm_config_global']) delete env[key]
  const result = spawnSync('npm root -g', [], { encoding: 'utf8', env, shell: true, timeout: 10_000, windowsHide: true })
  if (result.status !== 0 || result.stdout === null) return null
  const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8')
  const root = stdout.trim()
  return root === '' ? null : root
}

function missingModules(scope: string): boolean {
  return MODULES.some((relative) => !existsSync(join(scope, relative)))
}

interface HostProbe {
  readonly host: RuntimeHost | undefined
  readonly failure: string | undefined
}

async function probeHost(root: string): Promise<HostProbe> {
  const scope = join(root, SCOPE)
  if (missingModules(scope)) return { host: undefined, failure: undefined }
  try {
    const session = (await import(pathToFileURL(join(scope, 'dsh-session/lib/index.js')).href)) as SessionModule
    const format = (await import(pathToFileURL(join(scope, 'dsh-session-format-v3-to-v4/lib/index.js')).href)) as SessionFormatModule
    const appendPluginRecord = typeof session.appendPluginRecord === 'function' ? session.appendPluginRecord : undefined
    const pluginRecordOf = typeof session.pluginRecordOf === 'function' ? session.pluginRecordOf : undefined
    return {
      failure: undefined,
      host: {
        root: scope,
        createSession: session.Session.create.bind(session.Session),
        knownEventTypes: session.KNOWN_SESSION_EVENT_TYPES,
        restoreV4Artifact: format.restoreReleasedV4Artifact,
        assertV4Relationships: format.assertReleasedV4Relationships,
        appendPluginRecord,
        pluginRecordOf,
      },
    }
  } catch (error) {
    return { host: undefined, failure: `${scope}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function isPluginRecordHost(host: RuntimeHost): boolean {
  return host.appendPluginRecord !== undefined && host.pluginRecordOf !== undefined
}

/**
 * Resolve a usable host in the gate's priority order. A candidate exposing
 * `appendPluginRecord`/`pluginRecordOf` (the proposal §2.5 seam) wins so the
 * record regression actually runs; otherwise the first usable host is kept and
 * only the record tests skip. When nothing is usable the caller warns and the
 * whole suite reports the explicit skip instead of a fake green.
 */
async function discoverHost(): Promise<RuntimeHost | undefined> {
  let fallback: RuntimeHost | undefined
  const failures: string[] = []
  const globalRoot = npmGlobalRoot()
  const roots = [...localDependencyRoots()]
  if (globalRoot !== null) roots.push(globalRoot, join(globalRoot, SCOPE, 'dsh', 'node_modules'))
  for (const root of roots) {
    const { host, failure } = await probeHost(root)
    if (failure !== undefined) failures.push(failure)
    if (host === undefined) continue
    if (isPluginRecordHost(host)) return host
    fallback ??= host
  }
  if (fallback === undefined && failures.length > 0) {
    console.warn(`[skip] every candidate DSH runtime failed to load: ${failures.join(' | ')}`)
  }
  return fallback
}

const HOST = await discoverHost()
const runtimeAvailable = HOST !== undefined
const pluginRecordAvailable = HOST !== undefined && HOST.appendPluginRecord !== undefined && HOST.pluginRecordOf !== undefined

if (HOST !== undefined && !pluginRecordAvailable) {
  console.warn(`[skip] ${HOST.root} exposes no appendPluginRecord/pluginRecordOf (DSH 0.2.1-rc.2 API); plugin-record regression skipped`)
}

function host(): RuntimeHost {
  if (HOST === undefined) throw new Error('DSH runtime unavailable')
  return HOST
}

function pluginRecordHost(): PluginRecordHost {
  const current = host()
  if (current.appendPluginRecord === undefined || current.pluginRecordOf === undefined) {
    throw new Error('appendPluginRecord is unavailable on this runtime')
  }
  return { ...current, appendPluginRecord: current.appendPluginRecord, pluginRecordOf: current.pluginRecordOf }
}

/** Unix epoch milliseconds for one deterministic fixture seq. */
function at(seq: number): number {
  return BASE_TIME + seq
}

function headerFor(id: string): SessionHeaderLike {
  return { version: 4, id, createdAt: BASE_TIME, isSeeded: false, delegationDepth: 0 }
}

function assistantMessage(text: string): HostMessage {
  return {
    id: ASSISTANT_MESSAGE_ID,
    role: 'assistant',
    content: [
      { type: 'reasoning', text: REASONING_TEXT },
      { type: 'text', text },
    ],
    source: { kind: 'model', provider: 'example-provider', model: 'example-model' },
  }
}

function bodyCandidateData(): BodyCandidateData {
  return { op: 'candidate', groupId: ASSISTANT_MESSAGE_ID, messageId: ASSISTANT_MESSAGE_ID, index: 0 }
}

function bodyEditData(): BodyEditData {
  return {
    op: 'edit',
    groupId: ASSISTANT_MESSAGE_ID,
    index: 0,
    text: EDITED_TEXT,
    previousText: ORIGINAL_TEXT,
  }
}

function emptyDeveloperMessage(id: string): HostMessage {
  return { id, role: 'developer', content: [], source: { kind: 'plugin:dsh-soulmojito' } }
}

/**
 * Seeded transcript: one closed step, then the body record pair a real edit
 * relies on — `candidate` (the native assistant becomes candidate 0) followed
 * by `edit`. `ignorable: true` is the envelope marker `appendPluginRecord()`
 * writes and the host requires for an out-of-vocabulary event.
 */
function baseSeed(): readonly SeedEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: at(0), data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: at(1), data: { turn: 1, step: 1 } },
    {
      type: 'system/message',
      seq: 2,
      time: at(2),
      surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: SYSTEM_MESSAGE_ID,
          role: 'system',
          content: [{ type: 'text', text: SYSTEM_TEXT }],
          source: { kind: 'system-prompt' },
        },
      },
    },
    {
      type: 'user/message',
      seq: 3,
      time: at(3),
      surfaceOp: 'append',
      data: {
        id: USER_MESSAGE_ID,
        role: 'user',
        content: [{ type: 'text', text: USER_TEXT }],
        source: { kind: 'user' },
      },
    },
    {
      type: 'assistant/message',
      seq: 4,
      time: at(4),
      surfaceOp: 'append',
      data: { turn: 1, step: 1, stream: [], message: assistantMessage(ORIGINAL_TEXT) },
    },
    { type: BODY_RECORD_TYPE, seq: 5, time: at(5), ignorable: true, data: bodyCandidateData() },
    { type: BODY_RECORD_TYPE, seq: 6, time: at(6), ignorable: true, data: bodyEditData() },
    { type: 'step/end', seq: 7, time: at(7), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time: at(8), data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Same transcript with a natively empty assistant (no projection involved). */
function baseSeedWithEmptyAssistant(): readonly SeedEvent[] {
  return baseSeed().map((event) => {
    if (event.type !== 'assistant/message') return event
    return { ...event, data: { ...event.data, message: { ...event.data.message, content: [] } } }
  })
}

/** Base transcript without body records: the state before a live body group forms. */
function plainSeed(): readonly SeedEvent[] {
  return [
    ...baseSeed().slice(0, 5),
    { type: 'step/end', seq: 5, time: at(5), data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 6, time: at(6), data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** Persisted shape: body records plus the empty developer replacement that shadows seq 4. */
function persistedSeed(): readonly SeedEvent[] {
  return [
    ...baseSeed(),
    { type: 'turn/start', seq: 9, time: at(9), data: { turn: 2 } },
    { type: 'step/start', seq: 10, time: at(10), data: { turn: 2, step: 1 } },
    {
      type: 'developer/message',
      seq: 11,
      time: at(11),
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
      sourceEventSeqs: [4],
      data: { turn: 2, step: 1, message: emptyDeveloperMessage('example-developer-2') },
    },
    { type: 'step/end', seq: 12, time: at(12), data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 13, time: at(13), data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

function isHostMessage(value: unknown): value is HostMessage {
  if (typeof value !== 'object' || value === null) return false
  const record = value as { readonly id?: unknown; readonly role?: unknown; readonly content?: unknown; readonly source?: unknown }
  if (typeof record.id !== 'string' || !Array.isArray(record.content)) return false
  if (record.role !== 'system' && record.role !== 'user' && record.role !== 'assistant' && record.role !== 'developer') return false
  if (typeof record.source !== 'object' || record.source === null) return false
  return typeof (record.source as { readonly kind?: unknown }).kind === 'string'
}

interface AssistantEvent extends CommittedEvent {
  readonly type: 'assistant/message'
  readonly data: AssistantData
}

function isAssistantEvent(event: CommittedEvent): event is AssistantEvent {
  if (event.type !== 'assistant/message') return false
  if (typeof event.data !== 'object' || event.data === null) return false
  const message = (event.data as { readonly message?: unknown }).message
  return isHostMessage(message) && message.role === 'assistant'
}

function findAssistantEvent(events: readonly CommittedEvent[], messageId: string): AssistantEvent | undefined {
  return events.find((event): event is AssistantEvent => isAssistantEvent(event) && event.data.message.id === messageId)
}

function lastEvent(session: SessionLike): CommittedEvent {
  const event = session.snapshotEvents().at(-1)
  if (event === undefined) throw new Error('example session log is empty')
  return event
}

/** Replace only text blocks, mirroring proposal 0021 §5 `replaceTextBlocks`. */
function replaceTextBlocks(message: HostMessage, text: string): HostMessage {
  return {
    ...message,
    content: message.content.map((block): HostBlock => (block.type === 'text' ? { type: 'text', text } : block)),
  }
}

function immutableBlock(block: HostBlock): HostBlock {
  if (block.type === 'text') return Object.freeze<TextBlock>({ type: 'text', text: block.text })
  return Object.freeze<ReasoningBlock>({ type: 'reasoning', text: block.text })
}

/** The projection contract publishes immutable copies instead of mutating inputs. */
function immutableMessage(message: HostMessage): HostMessage {
  return Object.freeze<HostMessage>({
    ...message,
    content: Object.freeze<readonly HostBlock[]>(message.content.map(immutableBlock)),
    source: Object.freeze<HostMessageSource>({ ...message.source }),
  })
}

/**
 * Minimal equivalent of proposal 0021 §5: only edit/select events project, the
 * anchor is located through `context.events` (never `context.messages`, which
 * only holds already-projected messages), and only the text blocks change.
 */
function projectAnchor(
  context: ProjectionContext,
  groupId: string,
  rewrite: (message: HostMessage) => HostMessage,
): ReadonlyMap<number, HostMessage> {
  const anchor = findAssistantEvent(context.events, groupId)
  if (anchor === undefined) return new Map()
  return new Map([[anchor.seq, rewrite(anchor.data.message)]])
}

function bodyTextEditProjection(): MessageProjection {
  return {
    type: BODY_RECORD_TYPE,
    project(event, context) {
      if (event.data.op !== 'edit') return new Map<number, HostMessage>()
      const text = event.data.text
      return projectAnchor(context, event.data.groupId, (anchor) => immutableMessage(replaceTextBlocks(anchor, text)))
    },
  }
}

/** Adversarial projection: empties the anchor content to prove projection cannot hide a message. */
function emptyContentProjection(): MessageProjection {
  return {
    type: BODY_RECORD_TYPE,
    project(event, context) {
      if (event.data.op !== 'edit' && event.data.op !== 'select') return new Map<number, HostMessage>()
      return projectAnchor(context, event.data.groupId, (anchor) => immutableMessage({ ...anchor, content: [] }))
    },
  }
}

function textOf(message: HostMessage): string {
  const block = message.content.find((item) => item.type === 'text')
  if (block === undefined || block.type !== 'text') throw new Error(`example message "${message.id}" has no text block`)
  return block.text
}

function reasoningOf(message: HostMessage): string {
  const block = message.content.find((item) => item.type === 'reasoning')
  if (block === undefined || block.type !== 'reasoning') throw new Error(`example message "${message.id}" has no reasoning block`)
  return block.text
}

/**
 * Open a new turn/step and replace one surface node with an empty developer
 * message. Empty developer content derives no message, so the node leaves the
 * model-visible surface while the append-origin event stays in the log.
 */
function appendReplacementTurn(session: SessionLike, turn: number, targetSeq: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('developer/message', {
    turn,
    step: 1,
    message: emptyDeveloperMessage(`example-developer-${turn}`),
  }, {
    surfaceOp: { op: 'replace', startSeq: targetSeq, endSeq: targetSeq },
    sourceEventSeqs: [targetSeq],
  })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe.skipIf(!runtimeAvailable)('AgentTavern body operations against the real DSH session seam', () => {
  it('seeds log-only body records without changing derived history and replays them', async () => {
    const session = host().createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [])

    const messages = session.deriveMessages()
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(messages.map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, ORIGINAL_TEXT])
    // A log-only record owns no surface node: without a projection it is inert.
    expect(session.surface.nodes).toEqual([2, 3, 4])
    const records = session.snapshotEvents().filter((event) => event.type === BODY_RECORD_TYPE)
    expect(records.map((event) => event.seq)).toEqual([5, 6])
    expect(records.every((event) => event.ignorable === true)).toBe(true)

    // Replaying the exact committed prefix must derive the same messages.
    const restored = host().createSession(SESSION_ID, session.snapshotEvents(), headerFor(SESSION_ID), 0, [])
    expect(restored.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, ORIGINAL_TEXT])
    expect(restored.surface.nodes).toEqual([2, 3, 4])
  })

  it('applies a body projection to the anchor text while preserving id, role, source, and non-text blocks', async () => {
    const session = host().createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [bodyTextEditProjection()])

    const derived = session.deriveMessages()
    expect(derived).toHaveLength(3)
    const assistant = derived.at(2)
    if (assistant === undefined) throw new Error('expected a derived assistant message')
    expect(assistant.id).toBe(ASSISTANT_MESSAGE_ID)
    expect(assistant.role).toBe('assistant')
    expect(assistant.source).toEqual({ kind: 'model', provider: 'example-provider', model: 'example-model' })
    expect(textOf(assistant)).toBe(EDITED_TEXT)
    expect(reasoningOf(assistant)).toBe(REASONING_TEXT)
    expect(assistant.content).toHaveLength(2)

    // The durable append-origin event keeps the original text; only derivation changed.
    const durable = session.snapshotEvents().find(isAssistantEvent)
    expect(durable?.data.message).toEqual(assistantMessage(ORIGINAL_TEXT))
  })

  it('keeps an assistant that a projection empties, while a natively empty assistant derives no message', async () => {
    const projected = host().createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [emptyContentProjection()])
    const derived = projected.deriveMessages()
    expect(derived.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
    const assistant = derived.at(2)
    if (assistant === undefined) throw new Error('expected a projected assistant message')
    expect(assistant.content).toEqual([])

    // Control: deriveEventMessage drops a natively empty assistant; a projection bypasses that check.
    const untouched = host().createSession(SESSION_ID, baseSeedWithEmptyAssistant(), headerFor(SESSION_ID), 0, [])
    expect(untouched.deriveMessages().map((message) => message.role)).toEqual(['system', 'user'])
  })

  it('removes surface nodes with empty developer replacements and keeps append-origin events', async () => {
    const session = host().createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [])

    appendReplacementTurn(session, 2, 4)
    expect(session.deriveMessages().map((message) => message.role)).toEqual(['system', 'user'])
    const afterAssistant = session.surface.nodes
    expect(afterAssistant).toHaveLength(3)
    expect(afterAssistant.slice(0, 2)).toEqual([2, 3])

    appendReplacementTurn(session, 3, 3)
    expect(session.deriveMessages().map((message) => message.role)).toEqual(['system'])

    // Shadowing is a model-surface operation: the append-origin records survive.
    const committed = session.snapshotEvents()
    expect(committed.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    expect(committed.filter((event) => event.type === 'user/message')).toHaveLength(1)
  })

  it('rejects an assistant/message surface replacement and leaves the log unchanged', async () => {
    const session = host().createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [])
    session.append('turn/start', { turn: 2 })
    session.append('step/start', { turn: 2, step: 1 })
    const before = session.seq
    const replacement = {
      turn: 2,
      step: 1,
      stream: [],
      message: { ...assistantMessage(EDITED_TEXT), id: 'example-assistant-2' },
    }

    // Without citations the host reports the missing shadowed surface node.
    expect(() => session.append('assistant/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
    })).toThrow(/surface replace: sourceEventSeqs must include every shadowed surface node/)

    // With citations the host refuses the event type itself.
    expect(() => session.append('assistant/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 },
      sourceEventSeqs: [4],
    })).toThrow(/assistant\/message embeds its source stream and cannot carry sourceEventSeqs/)

    // Validation runs before the log push, so both refusals are atomic.
    expect(session.seq).toBe(before)
    expect(session.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, ORIGINAL_TEXT])
  })

  it('admits the persisted body records plus the empty developer replacement', async () => {
    const current = host()
    const artifact: V4Artifact = { header: headerFor(SESSION_ID), events: persistedSeed(), inheritedEventCount: 0 }
    expect(() => current.assertV4Relationships(artifact, current.knownEventTypes)).not.toThrow()
    expect(() => current.restoreV4Artifact(artifact, current.knownEventTypes)).not.toThrow()
  })

  it('rejects an unknown required event appended through Session.append, which is why records go through appendPluginRecord', async () => {
    const current = host()
    const session = current.createSession(SESSION_ID, baseSeed(), headerFor(SESSION_ID), 0, [])
    const appended = session.append(LEGACY_EVENT_TYPE, bodyEditData())
    // Session.append() takes only surface metadata; unlike appendPluginRecord's
    // private #appendRecord (dsh-session@0.2.1-rc.2 lib/index.js:1548-1557).
    expect(appended.ignorable).toBeUndefined()

    const artifact: V4Artifact = { header: headerFor(SESSION_ID), events: session.snapshotEvents(), inheritedEventCount: 0 }
    // Relationship validation skips unknown types; artifact admission owns vocabulary closure.
    expect(() => current.assertV4Relationships(artifact, current.knownEventTypes)).not.toThrow()
    expect(() => current.restoreV4Artifact(artifact, current.knownEventTypes)).toThrow(/unknown event type "dsh-soulmojito\/legacy-body"/)
  })
})

describe.skipIf(!pluginRecordAvailable)('plugin records through the real appendPluginRecord seam', () => {
  it('writes ignorable candidate/edit records that pluginRecordOf recognizes and the projection applies', () => {
    const current = pluginRecordHost()
    const session = current.createSession(SESSION_ID, plainSeed(), headerFor(SESSION_ID), 0, [bodyTextEditProjection()])
    const before = session.seq

    const candidateSeq = current.appendPluginRecord(session, BODY_RECORD_TYPE, bodyCandidateData())
    expect(candidateSeq).toBe(before)
    const candidateEvent = lastEvent(session)
    expect(candidateEvent.seq).toBe(candidateSeq)
    expect(candidateEvent.ignorable).toBe(true)
    expect(current.pluginRecordOf(candidateEvent)).toEqual({
      type: BODY_RECORD_TYPE,
      seq: candidateSeq,
      time: candidateEvent.time,
      data: bodyCandidateData(),
    })
    // A record never joins the surface; the candidate alone keeps the original text.
    expect(session.surface.nodes).toEqual([2, 3, 4])
    expect(session.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, ORIGINAL_TEXT])

    const editSeq = current.appendPluginRecord(session, BODY_RECORD_TYPE, bodyEditData())
    expect(editSeq).toBe(candidateSeq + 1)
    expect(lastEvent(session).ignorable).toBe(true)
    expect(session.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, EDITED_TEXT])

    // The appendPluginRecord log itself passes artifact admission.
    const artifact: V4Artifact = { header: headerFor(SESSION_ID), events: session.snapshotEvents(), inheritedEventCount: 0 }
    expect(() => current.restoreV4Artifact(artifact, current.knownEventTypes)).not.toThrow()
  })

  it('restores the exact plugin-record log with and without the projection', () => {
    const current = pluginRecordHost()
    const session = current.createSession(SESSION_ID, plainSeed(), headerFor(SESSION_ID), 0, [bodyTextEditProjection()])
    current.appendPluginRecord(session, BODY_RECORD_TYPE, bodyCandidateData())
    current.appendPluginRecord(session, BODY_RECORD_TYPE, bodyEditData())
    const committed = session.snapshotEvents()
    expect(committed.filter((event) => current.pluginRecordOf(event)?.type === BODY_RECORD_TYPE)).toHaveLength(2)

    const ignored = current.createSession('session-body-restore-plain', committed, headerFor('session-body-restore-plain'), 0, [])
    expect(ignored.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, ORIGINAL_TEXT])

    const projected = current.createSession('session-body-restore-projected', committed, headerFor('session-body-restore-projected'), 0, [bodyTextEditProjection()])
    expect(projected.deriveMessages().map(textOf)).toEqual([SYSTEM_TEXT, USER_TEXT, EDITED_TEXT])
  })
})

/**
 * Plugin mount with no `sessions` service. `apply` must not throw: the body
 * projection degrades on the missing seam while the web route, prompt section
 * and command surface still mount.
 */
describe('plugin mount without a sessions service', () => {
  interface JsonResponseLike {
    readonly statusCode: number
    readonly chunks: string[]
    setHeader(name: string, value: string): void
    write(chunk: string): boolean
    end(chunk?: string): void
    on(event: string, listener: () => void): void
  }

  const infos: unknown[][] = []
  const warnings: unknown[][] = []
  const errors: unknown[][] = []
  const sections: string[] = []
  const cleanups: Array<() => void> = []
  let webRoutes = 0
  let commands = 0
  let apiHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined
  let home = ''

  function makeRequest(body: unknown) {
    const listeners = new Map<string, (value?: unknown) => void>()
    return {
      method: 'PUT',
      url: '/api/dsh-soulmojito/body',
      headers: { 'content-type': 'application/json' },
      on: (event: string, listener: (value?: unknown) => void) => {
        listeners.set(event, listener)
        if (event === 'end') {
          if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
          listener()
        }
        return undefined
      },
      destroy: () => {},
    }
  }

  function makeResponse(): JsonResponseLike {
    const chunks: string[] = []
    return {
      chunks,
      statusCode: 0,
      setHeader: () => {},
      write: (chunk: string) => { chunks.push(chunk); return true },
      end: (chunk?: string) => { if (chunk) chunks.push(chunk) },
      on: () => {},
    }
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-mount-'))
    process.env.DSH_HOME = home
    apply({
      systemPrompt: {
        section: (definition: { name?: unknown }) => {
          sections.push(String(definition.name))
        },
        context: () => {},
      },
      commands: { register: () => { commands += 1 } },
      webServer: {
        register: (definition: { handler: (req: unknown, res: unknown) => Promise<void> }) => {
          apiHandler = definition.handler
          webRoutes += 1
          return () => {}
        },
      },
      agentPresets: {
        mount: async () => ({ id: 'agent-tavern' }),
        recompose: async (_agent: unknown, presetId: string) => ({ id: presetId }),
        compositionInventory: async () => [{ id: 'standard' }, { id: 'agent-tavern' }],
      },
      tools: { register: () => {} },
      llm: { stream: async function* () {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'example-provider', model: 'example-model' }) },
      agents: { get: () => undefined },
      effect: (callback: () => unknown) => {
        const cleanup = callback()
        if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
        return () => {}
      },
      logger: {
        info: (...args: unknown[]) => { infos.push(args) },
        warn: (...args: unknown[]) => { warnings.push(args) },
        error: (...args: unknown[]) => { errors.push(args) },
      },
    } as never)
  })

  afterAll(() => {
    for (const cleanup of cleanups.reverse()) {
      try { cleanup() } catch { /* example host cleanup must not mask the test result */ }
    }
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('mounts the non-body surfaces and disables only the body projection', () => {
    expect(apiHandler).toBeDefined()
    expect(webRoutes).toBe(1)
    expect(sections).toContain('dsh-soulmojito:active-character')
    expect(commands).toBeGreaterThan(0)
    expect(warnings.some((args) => String(args[0]).includes('registerMessageProjection is unavailable'))).toBe(true)
    expect(infos.some((args) => String(args[0]).includes('projection seam missing; body operations disabled'))).toBe(true)
  })

  it('rejects a body PUT without sessionId with the invalid-arguments code', async () => {
    if (apiHandler === undefined) throw new Error('example host did not mount the API route')
    const response = makeResponse()
    await apiHandler(makeRequest({}), response)
    expect(response.statusCode).toBe(400)
    const payload = JSON.parse(response.chunks.join('')) as { code?: unknown }
    expect(payload.code).toBe('invalid-arguments')
  })
})

/**
 * The retry chain is keyed by task identity, not by session alone. A deferred
 * settlement arriving while a failed-turn restore is still retrying must run
 * instead of being silently dropped.
 */
describe('turn/end retry queue', () => {
  it('keys a restore and a settlement as different tasks of one session', () => {
    const restore = { sessionId: 'example-session-1', agentId: 'example-session-1', turn: 2, reason: 'error', mode: 'restore' }
    const settle = { sessionId: 'example-session-1', agentId: 'example-session-1', turn: 2, reason: undefined, mode: 'settle' }
    expect(turnEndRestoreKey(restore as never)).not.toBe(turnEndRestoreKey(settle as never))
    expect(turnEndRestoreKey({ ...restore } as never)).toBe(turnEndRestoreKey(restore as never))
  })

  it('reruns an identical edge once after its retry chain ends', async () => {
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    const logger = {
      info: () => {},
      warn: (...args: unknown[]) => { warnings.push(args) },
      error: (...args: unknown[]) => { errors.push(args) },
    }
    const sessionId = 'example-session-2'
    const session = {
      id: sessionId,
      events: [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 2 } }],
      append: () => 0,
    }
    const agent = { id: sessionId, status: 'idle', session, followup: async () => {} }
    const ctx = {
      logger,
      agents: { get: (id: string) => (id === sessionId ? agent : undefined) },
    } as never
    pendingByAgent.set(sessionId, {
      opId: 'example-op-2',
      groupId: 'example-group-2',
      previousAnchorId: 'example-anchor-2',
      previousIndex: 0,
      startSeq: 0,
      agentId: sessionId,
      triggerMessageId: 'example-anchor-2',
      turn: 2,
      release: () => {},
    } as never)

    try {
      const event = { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }
      handleBodySessionEvent(ctx, session, event)
      await vi.waitFor(() => {
        expect(warnings.some((args) => String(args[0]).includes('turn/end restore failed; retrying'))).toBe(true)
      })
      // Same task identity while the chain is still retrying: coalesced, then
      // rerun once after the chain ends, so the final-failure log appears twice.
      handleBodySessionEvent(ctx, session, event)
      await vi.waitFor(() => {
        const failures = errors.filter((args) => String(args[0]).includes('turn/end restore failed; op-start stays pending'))
        expect(failures).toHaveLength(2)
      }, { timeout: 3000 })
    } finally {
      pendingByAgent.delete(sessionId)
    }
  })

  it('keeps a deferred settlement that arrives during a restore retry', async () => {
    const infos: unknown[][] = []
    const warnings: unknown[][] = []
    const errors: unknown[][] = []
    const logger = {
      info: (...args: unknown[]) => { infos.push(args) },
      warn: (...args: unknown[]) => { warnings.push(args) },
      error: (...args: unknown[]) => { errors.push(args) },
    }
    const sessionId = 'example-session-1'
    const agentId = sessionId
    // An open turn makes the restore fail with the retryable `session-busy`
    // code even when the plugin-record seam resolves.
    const session = {
      id: sessionId,
      events: [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 2 } }],
      append: () => 0,
    }
    const agent = {
      id: agentId,
      status: 'idle',
      session,
      followup: async () => {},
    }
    const ctx = {
      logger,
      agents: { get: (id: string) => (id === agentId ? agent : undefined) },
    } as never
    pendingByAgent.set(agentId, {
      opId: 'example-op-1',
      groupId: 'example-group-1',
      previousAnchorId: 'example-anchor-1',
      previousIndex: 0,
      startSeq: 0,
      agentId,
      triggerMessageId: 'example-anchor-1',
      turn: 2,
      release: () => {},
    } as never)

    try {
      handleBodySessionEvent(ctx, session, {
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'error' } },
      })
      await vi.waitFor(() => {
        expect(warnings.some((args) => String(args[0]).includes('turn/end restore failed; retrying'))).toBe(true)
      })

      handleBodySessionEvent(ctx, session, {
        type: 'turn/end',
        data: { turn: 2, reason: { kind: 'completed' } },
      })
      await vi.waitFor(() => {
        // The attempt ran: either it retried, it failed for good, or it
        // finished. The "skipped because the live agent is gone" line is not
        // an attempt and must not satisfy this assertion.
        const ran = [...infos, ...warnings, ...errors].some((args) => {
          const message = String(args[0])
          return message.includes('deferred settlement failed; retrying')
            || message.includes('deferred settlement failed; op-start stays pending')
            || message.includes('deferred settlement finished after turn/end')
        })
        expect(ran).toBe(true)
      })
      // Let the 0/50/250 ms restore ladder drain before the test ends.
      await new Promise((resolve) => { setTimeout(resolve, 400) })
    } finally {
      pendingByAgent.delete(agentId)
    }
  })
})

if (!runtimeAvailable) {
  describe('AgentTavern body operations against the real DSH session seam', () => {
    it('is skipped without a usable DSH runtime', () => {
      console.warn(`[skip] ${MODULES.join(', ')} not found under .npm-cache/dsh-runtime, NODE_PATH, or the global npm root; body seam gate skipped`)
      expect(runtimeAvailable).toBe(false)
    })
  })
}