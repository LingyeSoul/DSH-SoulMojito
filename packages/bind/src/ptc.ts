/**
 * DSH PTC host seam across host lines.
 *
 * PTC has two host-facing shapes:
 * - DSH 0.2.1: `ctx.tools.presentAs('ptc')` plus `modeFor` / `sdkSection` /
 *   `collapseSection` (the retired `dsh-agent-tool-presentation` row).
 * - DSH 0.2.2+: the first-party `@deepseek-ai/dsh-tool-executor-ptc` plugin is
 *   mounted in the agent scope; it calls `ctx.tools.setExecutor()` and
 *   contributes the `tools:ptc-only` / `tools:sdk` prompt sections itself.
 *
 * This module owns every host-specific detail: capability probing, module
 * loading through the host package resolver (`importHostPackage`), mounting/
 * unmounting the per-agent executor, and rendering the PTC prompt sections into
 * a complete system prompt. The plugin layer only decides when a session should
 * use PTC.
 */

import { importHostPackage } from './host-package.js'

/** SDK renderer languages shipped by the supported DSH host lines. */
const SDK_LANGUAGES: readonly string[] = ['typescript', 'python']

const PTC_EXECUTOR_SPECIFIER = '@deepseek-ai/dsh-tool-executor-ptc'
const PTC_ONLY_SECTION = 'tools:ptc-only'
const TOOLS_SDK_SECTION = 'tools:sdk'

export type PtcHostSeam = 'presentation' | 'executor'

export interface PtcHostCapabilities {
  readonly available: boolean
  readonly reasons: readonly string[]
  readonly language?: string
  readonly seam?: PtcHostSeam
}

interface PtcDisposable {
  dispose?: () => unknown
}

interface PtcPresentationTools {
  presentAs?: (mode: 'native' | 'ptc') => unknown
  modeFor?: (scope: unknown) => 'native' | 'ptc' | undefined
  sdkSection?: () => PtcPromptSection
  collapseSection?: () => PtcPromptSection
}

interface PtcExecutorTools {
  setExecutor?: (executor: unknown) => unknown
  selectExecutor?: (scope: unknown) => unknown
  definitions?: (scope: unknown, toolSet: unknown) => unknown
  scoped?: {
    get?: (scope: object) => unknown
    has?: (scope: object) => boolean
    delete?: (scope: object) => boolean
  }
}

interface PtcPromptSection {
  readonly name?: unknown
  readonly text?: string | ((context: unknown) => string)
}

interface PtcRuntimeLike {
  readonly language?: unknown
}

interface PtcExecutorRecordLike {
  readonly executor?: {
    readonly sections?: readonly PtcPromptSection[]
  }
}

interface PtcRuntimeInjectionContext {
  tools?: {
    presentAs?: (mode: 'ptc') => unknown
  }
}

/** The minimal host context PTC probing and mounting touch. */
export interface PtcHostContext {
  readonly tools?: unknown
  get?(name: string): unknown
  inject?(
    deps: readonly string[],
    callback: (context: PtcRuntimeInjectionContext) => unknown,
  ): PtcDisposable | undefined
  plugin?(plugin: unknown, config?: unknown): PtcDisposable | undefined
}

/** A mounted PTC selection that can undo itself and restore native fallback. */
export interface PtcMount {
  dispose(): Promise<void>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toolsOf(ctx: PtcHostContext | undefined): unknown {
  return ctx?.tools ?? ctx?.get?.('tools')
}

function hasPresentationSeam(ctx: PtcHostContext | undefined, seam: PtcPresentationTools | undefined): boolean {
  return typeof ctx?.inject === 'function'
    && typeof seam?.presentAs === 'function'
    && typeof seam?.modeFor === 'function'
    && typeof seam?.sdkSection === 'function'
    && typeof seam?.collapseSection === 'function'
}

function hasExecutorSeam(ctx: PtcHostContext | undefined, seam: PtcExecutorTools | undefined): boolean {
  const scoped = seam?.scoped
  return typeof ctx?.plugin === 'function'
    && typeof seam?.setExecutor === 'function'
    && typeof seam?.selectExecutor === 'function'
    && typeof seam?.definitions === 'function'
    && typeof scoped?.get === 'function'
    && typeof scoped?.has === 'function'
    && typeof scoped?.delete === 'function'
}

/**
 * Probe PTC support without loading the executor module.
 *
 * The old presentation seam is preferred when a transitional host exposes both.
 * The runtime language gate is shared because both seams feed the same TS or
 * Python SDK renderer.
 */
export function inspectPtcCapabilities(ctx: PtcHostContext | undefined): PtcHostCapabilities {
  const tools = toolsOf(ctx)
  const presentation = tools as PtcPresentationTools | undefined
  const executor = tools as PtcExecutorTools | undefined
  const reasons: string[] = []
  const presentationSeam = hasPresentationSeam(ctx, presentation)
  const executorSeam = hasExecutorSeam(ctx, executor)
  let seam: PtcHostSeam | undefined
  if (presentationSeam) {
    seam = 'presentation'
  } else if (executorSeam) {
    seam = 'executor'
  } else {
    reasons.push(
      'the host exposes neither the 0.2.1 tool presentation seam (tools.presentAs) '
      + 'nor the 0.2.2 PTC executor seam (tools.setExecutor plus a loadable @deepseek-ai/dsh-tool-executor-ptc); '
      + 'use a DSH host that ships the PTC tool executor or keep PTC mode off',
    )
  }
  const runtime = ctx?.get?.('ptcRuntime') as PtcRuntimeLike | undefined
  if (runtime === undefined || runtime === null) {
    reasons.push('the host has no ctx.ptcRuntime service; load @deepseek-ai/dsh-ptc-runtime-node or keep PTC mode off')
  } else if (typeof runtime.language !== 'string' || !SDK_LANGUAGES.includes(runtime.language)) {
    const language = typeof runtime.language === 'string' ? runtime.language : String(runtime.language)
    reasons.push(`the host PTC runtime language '${language}' has no SDK renderer in this build (known: ${SDK_LANGUAGES.join(', ')})`)
  }
  return {
    available: reasons.length === 0,
    reasons,
    ...(typeof runtime?.language === 'string' ? { language: runtime.language } : {}),
    ...(seam === undefined ? {} : { seam }),
  }
}

/**
 * Probe PTC support and preflight the executor module import. Use this for UI
 * availability and for writes that enable the behavior switch.
 */
export async function inspectPtcCapabilitiesAsync(ctx: PtcHostContext | undefined): Promise<PtcHostCapabilities> {
  const capabilities = inspectPtcCapabilities(ctx)
  if (!capabilities.available || capabilities.seam !== 'executor') return capabilities
  try {
    await loadPtcExecutorModule()
    return capabilities
  } catch (error) {
    return {
      available: false,
      reasons: [
        ...capabilities.reasons,
        `the host package resolver cannot import ${PTC_EXECUTOR_SPECIFIER}: ${messageOf(error)}`,
      ],
      ...(capabilities.language === undefined ? {} : { language: capabilities.language }),
      seam: 'executor',
    }
  }
}

/**
 * Mount PTC for one agent scope.
 *
 * `scopeKey` is the host's agent scope key (the Agent subject in DSH). It is
 * only used by the 0.2.2 executor seam to guard and clean the per-scope
 * executor record.
 */
export async function mountPtc(ctx: PtcHostContext, scopeKey: object): Promise<PtcMount> {
  const capabilities = inspectPtcCapabilities(ctx)
  if (!capabilities.available) {
    throw new Error(`PTC is unavailable: ${capabilities.reasons.join(' ')}`)
  }
  if (capabilities.seam === 'presentation') {
    return mountPresentation(ctx)
  }
  if (capabilities.seam === 'executor') {
    return mountExecutor(ctx, scopeKey)
  }
  throw new Error('PTC is unavailable: the host exposes no recognized PTC seam')
}

function mountPresentation(ctx: PtcHostContext): PtcMount {
  let injection: PtcDisposable | undefined
  try {
    injection = ctx.inject?.(['tools', 'ptcRuntime'], (runtimeCtx) => {
      const tools = runtimeCtx.tools
      const presentAs = tools?.presentAs
      if (tools === undefined || typeof presentAs !== 'function') {
        throw new Error('the scoped tools service exposes no presentAs()')
      }
      presentAs.call(tools, 'ptc')
    })
  } catch (error) {
    throw new Error(`the 0.2.1 PTC presentation could not be mounted: ${messageOf(error)}`)
  }
  if (injection === undefined || typeof injection.dispose !== 'function') {
    throw new Error('the 0.2.1 PTC presentation returned no disposable injection')
  }
  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await injection?.dispose?.()
    },
  }
}

async function mountExecutor(ctx: PtcHostContext, scopeKey: object): Promise<PtcMount> {
  const tools = toolsOf(ctx) as PtcExecutorTools | undefined
  if (tools === undefined) throw new Error('the host exposes no tools service')
  const scoped = tools.scoped
  if (scoped === undefined) throw new Error('the 0.2.2 tools service exposes no scoped executor store')
  const existing = scoped.get?.(scopeKey) as { executor?: unknown } | undefined
  if (existing?.executor !== undefined) {
    throw new Error('a tool executor is already registered in this agent scope; remove the preset-level executor row or keep PTC mode off')
  }
  let module: unknown
  try {
    module = await loadPtcExecutorModule()
  } catch (error) {
    throw new Error(`the PTC executor module could not be loaded: ${messageOf(error)}`)
  }
  let injection: PtcDisposable | undefined
  try {
    injection = ctx.plugin?.(module)
    await Promise.resolve(injection)
  } catch (error) {
    throw new Error(`the PTC executor could not be mounted: ${messageOf(error)}`)
  }
  if (injection === undefined || typeof injection.dispose !== 'function') {
    throw new Error('the PTC executor returned no disposable injection')
  }
  const record = scoped.get?.(scopeKey)
  if (!isPtcExecutorRecord(record)) {
    try {
      await injection.dispose?.()
    } catch {
      // The failed mount may already be torn down.
    }
    throw new Error('the PTC executor did not register a scoped tool executor')
  }
  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      let failure: unknown
      try {
        await injection?.dispose?.()
      } catch (error) {
        failure = error
      }
      restoreNativeExecutor(tools, scopeKey, record)
      if (failure !== undefined) throw failure
    },
  }
}

function loadPtcExecutorModule(): Promise<unknown> {
  return importHostPackage<unknown>(PTC_EXECUTOR_SPECIFIER)
}

function isPtcExecutorRecord(record: unknown): boolean {
  const sections = (record as PtcExecutorRecordLike | undefined)?.executor?.sections
  if (!Array.isArray(sections)) return false
  return sections.some((section) => section.name === TOOLS_SDK_SECTION)
}

/**
 * Report which executor a scope currently selects. Diagnostics only: the PTC
 * executor contributes the `tools:ptc-only` section, while the native executor
 * has no sections. A missing selection reads as `unknown`.
 */
export function describePtcSelection(ctx: PtcHostContext | undefined, scope: unknown): 'ptc' | 'native' | 'unknown' {
  const tools = toolsOf(ctx) as PtcExecutorTools | undefined
  if (typeof tools?.selectExecutor !== 'function') return 'unknown'
  try {
    const selected = tools.selectExecutor(scope) as { readonly sections?: readonly PtcPromptSection[] } | undefined
    if (!Array.isArray(selected?.sections)) return 'native'
    return selected.sections.some((section) => section.name === PTC_ONLY_SECTION) ? 'ptc' : 'native'
  } catch {
    return 'unknown'
  }
}

function restoreNativeExecutor(tools: PtcExecutorTools, scopeKey: object, record: unknown): void {
  const scoped = tools.scoped
  if (scoped === undefined) return
  if (scoped.get?.(scopeKey) !== record) return
  scoped.delete?.(scopeKey)
}

/**
 * Render the PTC-only rule plus the generated SDK into a complete system prompt.
 *
 * A complete section drops the host's separately registered `tools:sdk` and
 * `tools:ptc-only` sections, so AgentTavern mirrors them here. Native and
 * executor-less scopes return an empty string and keep their byte-stable text.
 */
export function renderPtcCompleteText(tools: unknown, scope: unknown, toolSet: unknown): string {
  const presentation = tools as PtcPresentationTools | undefined
  if (typeof presentation?.modeFor === 'function' && presentation.modeFor(scope) === 'ptc') {
    const only = renderPresentationSection(presentation.collapseSection?.(), scope)
    const sdk = renderPresentationSection(presentation.sdkSection?.(), scope)
    return [only, sdk].filter((text) => text.length > 0).join('\n\n')
  }

  const executor = tools as PtcExecutorTools | undefined
  if (typeof executor?.selectExecutor === 'function' && typeof executor.definitions === 'function') {
    let selected: unknown
    try {
      selected = executor.selectExecutor(scope)
    } catch {
      return ''
    }
    const sections = (selected as { readonly sections?: readonly PtcPromptSection[] } | undefined)?.sections
    if (!Array.isArray(sections)) return ''
    const only = sections.find((section) => section.name === PTC_ONLY_SECTION)
    const sdk = sections.find((section) => section.name === TOOLS_SDK_SECTION)
    if (only === undefined && sdk === undefined) return ''
    const definitions = executor.definitions(scope, toolSet)
    return [
      renderExecutorSection(only, definitions),
      renderExecutorSection(sdk, definitions),
    ].filter((text) => text.length > 0).join('\n\n')
  }

  return ''
}

function renderPresentationSection(section: PtcPromptSection | undefined, scope: unknown): string {
  const text = section?.text
  if (text === undefined) return ''
  return typeof text === 'function' ? text({ scope }) : text
}

function renderExecutorSection(section: PtcPromptSection | undefined, definitions: unknown): string {
  const text = section?.text
  if (text === undefined) return ''
  return typeof text === 'function' ? text(definitions) : text
}
