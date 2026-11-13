/**
 * 世界书全局设置（ST `world_info_*` 语义；施工契约 2026-11-12 §2.8）。
 *
 * 引擎（`tavern-lore/src/engine.ts`）早已实现递归步数、预算上限、最小激活、
 * 大小写/整词匹配、组计分与消息名前缀，但唯一调用点
 * （`generation/pipeline.ts`）长期写死 `{recursive:true, scanDepth:2,
 * budgetPercent:25}`——设置项没有 state 键、没有面板，等于死代码。
 *
 * 本模块是这组设置的**唯一**默认值来源与读取口径：`TavernState.worldInfoSettings`
 * 按 `Partial<WorldInfoSettings>` 落库（旧 state.json 零迁移），读取一律走
 * `worldInfoSettingsOf(state)` 合并默认并夹取到合法区间。手改 state.json 的
 * 废值只影响它自己那一个键，不会把整组设置打成 undefined（生成面因此永远
 * 拿到一份形状完整的设置，不需要在自己的代码里再兜一次默认）。
 */

import type { TavernState } from './store.js'

/** 世界书全局设置；字段语义与 `@dsh-soulmojito/lore` 的 `GlobalSettings` 同名键一致。 */
export interface WorldInfoSettings {
  /** 递归扫描（激活条目内容回扫新条目）。 */
  recursive: boolean
  /** 扫描深度：最近 N 条消息。 */
  scanDepth: number
  /** 预算占上下文 token 的百分比。 */
  budgetPercent: number
  /** 预算绝对上限 token；0 = 不设上限。 */
  budgetCap: number
  /** 最大递归步数（计数含初始轮）；0 = 不限。 */
  maxRecursionSteps: number
  /** 最少激活条数（不足则加深扫描重扫）；0 = 关闭。 */
  minActivations: number
  /** min activations 加深的深度上限；0 = 不限。 */
  minActivationsDepthMax: number
  /** 键匹配大小写敏感。 */
  caseSensitive: boolean
  /** 键匹配要求整词。 */
  matchWholeWords: boolean
  /** inclusion group 使用加权计分（而非先命中先取）。 */
  useGroupScoring: boolean
  /** 扫描时消息带 `名字: ` 前缀。 */
  includeNames: boolean
}

/**
 * 默认值 = 契约落地前的实际生成行为（`recursive:true`、`scanDepth:2`、
 * `budgetPercent:25`）+ 引擎自身的 ST 原生默认（`includeNames:true`，其余
 * 关闭/不限）。旧 state.json 因此与升级前逐位一致。
 */
export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings = {
  recursive: true,
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  includeNames: true,
}

function clampCount(value: unknown, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(max, Math.round(value)))
}

function flagOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 读取口径：state 里的部分设置合并默认值。非法类型逐键回落默认（不是整组
 * 丢弃），数值夹取到引擎可接受的区间。
 */
export function worldInfoSettingsOf(
  state: Pick<TavernState, 'worldInfoSettings'>,
): WorldInfoSettings {
  const raw = state.worldInfoSettings
  const settings: Partial<WorldInfoSettings> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const base = DEFAULT_WORLD_INFO_SETTINGS
  return {
    recursive: flagOf(settings.recursive, base.recursive),
    // 扫描深度 0 = 只看最新一条（ST 允许）；上限 100 与面板输入框一致。
    scanDepth: clampCount(settings.scanDepth, 100, base.scanDepth),
    budgetPercent: clampCount(settings.budgetPercent, 100, base.budgetPercent),
    budgetCap: clampCount(settings.budgetCap, 1_000_000, base.budgetCap),
    maxRecursionSteps: clampCount(settings.maxRecursionSteps, 100, base.maxRecursionSteps),
    minActivations: clampCount(settings.minActivations, 100, base.minActivations),
    minActivationsDepthMax: clampCount(settings.minActivationsDepthMax, 1000, base.minActivationsDepthMax),
    caseSensitive: flagOf(settings.caseSensitive, base.caseSensitive),
    matchWholeWords: flagOf(settings.matchWholeWords, base.matchWholeWords),
    useGroupScoring: flagOf(settings.useGroupScoring, base.useGroupScoring),
    includeNames: flagOf(settings.includeNames, base.includeNames),
  }
}
