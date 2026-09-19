// W0 用量采样（0007 §7）：tool() 工厂处按工具名累计输出字节数的进程内累计器。
// Task D 的 driver 在 turn/end 处 drain 并经 noteUsageSample 落库
// （NovelUsageSample.toolBytes），本模块只产出这个契约。
//
// 审计性质、非权威（提案 §7 原话）：累计只按工具名、不含 novelId 归属——
// driver flush 时把当前 drained 字节归属到当时绑定的小说；多小说并存或跨小说
// 切换的窗口内，字节会记到 flush 时刻的小说名下。采样失败永不影响工具结果
// （调用方 best-effort try/catch）。宿主 run result 的 usage 字段（探针 P4）
// 不经过这里，由 Task D 在 driver 侧 fail-open 记录。
//
// globalThis 锚定（同学科于 writer.ts 委托注册表、novel.ts BOOT_ID）：插件可能
// 被多个 bundle 各自实例化，模块级常量会分裂成多份累计器；Symbol.for 跨副本
// 取同一 symbol，所有 bundle 共享同一底层 Map。

const USAGE_SAMPLER_KEY = Symbol.for('dsh-tavern:novel-usage-sampler')
type UsageSamplerTable = Map<string, number>
const samplerTable: UsageSamplerTable = (globalThis as Record<symbol, UsageSamplerTable | undefined>)[USAGE_SAMPLER_KEY] ??= new Map()

/** 累计一次工具成功输出的字节数（UTF-8）。非有限或负数值静默忽略。 */
export function noteToolOutputBytes(toolName: string, bytes: number): void {
  if (typeof toolName !== 'string' || toolName === '') return
  if (!Number.isFinite(bytes) || bytes < 0) return
  samplerTable.set(toolName, (samplerTable.get(toolName) ?? 0) + bytes)
}

/** 取出并清零当前累计（Task D 在 turn/end flush 时调用）。返回防御性拷贝。 */
export function drainToolOutputBytes(): Record<string, number> {
  const drained: Record<string, number> = {}
  for (const [toolName, bytes] of samplerTable) {
    drained[toolName] = bytes
  }
  samplerTable.clear()
  return drained
}

/* --------------------- P1 探针记录槽（0007 §9，Task D） --------------------- */

// 一次性探针记录槽：novel_status_read 工具体执行时无条件 best-effort 覆盖写入
// exec.agent.id；inspectWriterSubagentCapabilities 的 P1 探针在 run.result
// settle 后 take 走并与 spawn run.id 比对，证明"子代理工具执行身份可关联"
// （0007 §6.2/§9 P1）。不污染正常路径：覆盖写 + drain 后即空，正常工具调用
// 只是多一次属性赋值，没有任何行为分支读取它。globalThis 锚定同学科于上方
// 累计器：双 bundle 共享同一槽，否则探针 spawn 与工具体可能各持一份。
const PROBE_AGENT_ID_KEY = Symbol.for('dsh-tavern:novel-writer-probe-agent-id')
interface ProbeAgentSlot { id?: string }
const probeAgentSlot: ProbeAgentSlot = (globalThis as Record<symbol, ProbeAgentSlot | undefined>)[PROBE_AGENT_ID_KEY] ??= {}

/** 记录一次工具执行的代理身份（覆盖写）；非字符串/空值静默忽略，永不抛错。 */
export function recordProbeAgentId(id: unknown): void {
  try {
    if (typeof id !== 'string' || id === '') return
    probeAgentSlot.id = id
  } catch {
    /* 探针记录绝不影响工具执行 */
  }
}

/** 取走记录的代理身份并清空槽位；从未记录时返回 null。 */
export function takeProbeAgentId(): string | null {
  try {
    const id = probeAgentSlot.id
    delete probeAgentSlot.id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

/* ------------- writer run usage (0007 §7 probe P4, fail-open) ------------- */

// 写手子代理运行的观测槽（0007 §7："宿主若在 run result 暴露 usage 字段则一并
// 记录，fail-open 仅影响观测不影响执行"）：writer.ts 的 draft/delegated 编排
// 在 run.result settle 后记录宿主回传的 token 计数（仅收数值字段），委托成功
// 再补 outputChars（写手正文有效字符）；driver 的 turn/end 采样 drain 走并
// 并入 NovelUsageSample.usage / writerOutputChars。槽位是单条覆盖写、字段级
// 合并：一个 turn 多次委托时保留最后一次成功委托的 outputChars 与最新
// usage——审计性质，与上方按工具名累计器同款局限（flush 时归属当前小说）。
// globalThis 锚定同学科于上方累计器：双 bundle 必须共享同一槽。
const WRITER_RUN_USAGE_KEY = Symbol.for('dsh-tavern:novel-writer-run-usage')
interface WriterRunUsageSlot { outputChars: number | null; usage: Record<string, number> | null }
const writerRunUsageSlot: WriterRunUsageSlot = (globalThis as Record<symbol, WriterRunUsageSlot | undefined>)[WRITER_RUN_USAGE_KEY] ??= { outputChars: null, usage: null }

/** 记录一次写手运行的观测字段（fail-open 永不抛错）：usage 只收对象中的
 *  非负有限数值字段（其余形状静默忽略），outputChars 非负有限才接受。 */
export function recordWriterRunUsage(entry: { outputChars?: number; usage?: unknown }): void {
  try {
    if (typeof entry.outputChars === 'number' && Number.isFinite(entry.outputChars) && entry.outputChars >= 0) {
      writerRunUsageSlot.outputChars = entry.outputChars
    }
    if (typeof entry.usage === 'object' && entry.usage !== null && !Array.isArray(entry.usage)) {
      const usage: Record<string, number> = {}
      for (const [key, value] of Object.entries(entry.usage as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] = value
      }
      if (Object.keys(usage).length > 0) writerRunUsageSlot.usage = usage
    }
  } catch {
    /* observation only */
  }
}

/** 取走写手运行观测并复位槽位；无记录时两字段均为 null。 */
export function drainWriterRunUsage(): { outputChars: number | null; usage: Record<string, number> | null } {
  try {
    const drained = { outputChars: writerRunUsageSlot.outputChars, usage: writerRunUsageSlot.usage }
    writerRunUsageSlot.outputChars = null
    writerRunUsageSlot.usage = null
    return drained
  } catch {
    return { outputChars: null, usage: null }
  }
}
