/**
 * 工具层参数解析共享助手（决策 2026-10-09-dedup-refactor）。
 *
 * agent-tavern / agent-novel / card-workbench 三个 bundle 此前各自持有一份逐字
 * 相同的 stringArg / boundedStringArg / clampInt / limitText——同一校验语义靠
 * 复制维护，改动时存在静默漂移风险。统一收进本模块，各处经相对源码 import
 * 共享同一实现（build-plugin 的 esbuild bundle 会内联，不产生新的运行时依赖）。
 *
 * 注意：writer.ts 的 WRITER_TRUNCATION_MARKER 与 candidates.ts 的 excerpt 是
 * 另一套带省略号标注的「展示级截断」机制，语义不同（本模块是无声的防御性
 * 裁剪），刻意不合并。
 */

/** 必填字符串参数：非字符串或 trim 后为空即抛错（工具层 fail-fast 约定）。 */
export function stringArg(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('string argument is required')
  return value
}

/** 必填字符串参数 + 长度上限：超出部分无声截断（不加分隔符，区别于展示级截断）。 */
export function boundedStringArg(value: unknown, maxLength: number): string {
  return stringArg(value).slice(0, maxLength)
}

/** 整数参数钳制：非整数回落 fallback，否则夹进 [min, max]。 */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value as number))
}

/** 可选文本防御性裁剪：undefined / 非串归空串，超长无声截断。 */
export function limitText(value: string | undefined, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
