/**
 * 宿主 systemPrompt 文本安全化（DSH AgentLoop 装配层）。
 *
 * 根因（0.4.1 线上故障）：宿主 @deepseek-ai/dsh-system-prompt 的 interpolate()
 * 把 section/context 文本里的 {{name}} 当宿主模板变量渲染，注册表只有
 * provider/model/cwd——任何 {{...}} 组都会让装配抛错中止本轮运行：
 * 未注册的宏名 → "unknown prompt variable"；大写/含空格/含冒号的名字
 * → "malformed prompt variable"。角色卡、会话指引、剧本名是 ST 宏
 * （{{user}}/{{char}}/...）的高频来源，以原文进上下文必然踩雷。
 *
 * 处置：先按 ST 语义展开宏（与历史导入、快照预载通道一致），再把产物里
 * 残留的连续 { 括号拆开——宿主只扫描相邻的 "{{"，单括号与落单的 }}
 * 都是散文。宿主变量（{{model}} 等）也被一并中性化：这些通道不需要宿主
 * 变量；若未来某段文本真需要，显式拼接值而不是依赖宿主插值。
 */

import { createMacroEngine } from '../../tavern-macros/src/index.js'

/**
 * 冻结求值上下文：进宿主 systemPrompt 的文本（受保护头，字节一变其后全部
 * 前缀缓存作废）要在装载周期内字节稳定——{{time}}/{{date}}/{{random}}/{{roll}}
 * 这类动态宏因此按绑定的首次装载时刻/种子求值，重载复现首次选择而不是换值。
 * 当前时间由宿主 dsh-time-context 在消息流尾部按 append-only 纪律提供。
 */
export interface FrozenMacroContext {
  now?: () => Date
  rng?: () => number
}

/** ST 宏展开器：{{char}}=char、{{user}}=user（大小写不敏感，对齐 ST）；未知宏保留原样。
 *  frozen 透传确定性时钟/RNG（见 FrozenMacroContext）；缺省沿用实时钟与 Math.random。 */
export function createHostPromptExpander(char: string, user: string, frozen?: FrozenMacroContext): (text: string) => string {
  const macros = createMacroEngine({
    char,
    user,
    ...(frozen?.now === undefined ? {} : { now: frozen.now }),
    ...(frozen?.rng === undefined ? {} : { rng: frozen.rng }),
  })
  return (text) => macros.expand(text)
}

/** mulberry32 种子随机源：同一种子 + 同一文本 ⇒ {{random}}/{{roll}} 复现首次选择。
 *  每次装载新建实例（引擎无跨文本状态），种子在绑定生命周期内不变即字节稳定。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 展开 ST 宏并保证产物不含任何相邻 "{{"，可直接交给宿主的 section/context。 */
export function hostPromptSafe(text: string, expand: (text: string) => string = (value) => value): string {
  // 括号成组拆开（{{ -> { {、{{{ -> { { {），一次扫描到底，杜绝三括号残留。
  return expand(text).replace(/\{+/g, (run) => run.split('').join(' '))
}
