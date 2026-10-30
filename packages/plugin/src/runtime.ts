import { inspectAgentNovelCapabilities, type AgentNovelCapabilities } from './agent-novel/capabilities.js'
import type { NovelDriver } from './agent-novel/driver.js'
import type { NovelProjector } from './agent-novel/projector.js'
import { inspectAgentTavernCapabilities, type AgentTavernCapabilities } from './agent-tavern/capabilities.js'
import type { AgentTavernProjector } from './agent-tavern/projector.js'
import { BUILD_INFO, TAVERN_COMMIT } from './build-info.js'
import { tavernDataRoot } from './dsh-home.js'
import { envCompat } from './env-compat.js'
import type { GamesService } from './games/service.js'
import type { PluginContext } from './host-contract.js'
import { ModHost, type ModHostContext, type ModHostSnapshot } from './mods/host.js'
import type { ImRuntime } from './im/runtime.js'
import { TavernUpdateService } from './update/service.js'
import { MemoryStore, MemoryVectorStore, NovelStore, TavernStore, VariableStore } from '../../tavern-store/src/index.js'

let storePromise: Promise<TavernStore> | undefined
let memoryStorePromise: Promise<MemoryStore> | undefined
let variableStorePromise: Promise<VariableStore> | undefined
let agentTavernCapabilities: AgentTavernCapabilities = inspectAgentTavernCapabilities({})
let agentTavernCapabilitiesPromise: Promise<AgentTavernCapabilities> | undefined
let agentTavernProjectorPromise: Promise<AgentTavernProjector> | undefined
// AgentNovel mount state (proposal 0005 §4.2/§12): capabilities are inspected
// once at apply (§16); the store/projector/driver follow the storePromise
// memoization pattern so a single DSH home owns a single writer.
let agentNovelCapabilities: AgentNovelCapabilities = inspectAgentNovelCapabilities({})
let novelStorePromise: Promise<NovelStore> | undefined
let novelProjectorPromise: Promise<NovelProjector> | undefined
let novelDriverPromise: Promise<NovelDriver | undefined> | undefined
// 自更新服务（GitHub 版本发现 + 一键更新）：单进程单实例，apply 时启动自动轮询，
// HTTP 路由与 bootstrap 共用同一份快照。开关由 profile 配置/环境变量决定，
// 在这里记一次供路由与 bootstrap 复用。
let updateServiceInstance: TavernUpdateService | undefined
let updateChecksEnabledFlag = true
// Mod 宿主（提案 0015 P1）：单进程单实例，storePromise 同款 memoization；ctx
// 在 apply() 时绑定（logger/effect 经适配层注入，不透传给 Mod）。
let modHostPromise: Promise<ModHost> | undefined
let modHostContext: ModHostContext | undefined
// 游戏桥运行时（提案 0018 P0+P2）：registry + sessions 组装后经 globalThis
// 句柄发布（agent bundle 的 game_* 工具逐调用解析，见 src/games/handle.ts）。
// 单进程单实例；apply 打开、effect 清理时 dispose 摘句柄。
let gamesServicePromise: Promise<GamesService> | undefined
// IM 通道运行时（提案 0024）：单进程单实例，apply 装配、effect 卸载时 dispose。
// 本轮只装配不活动（无真实通道适配器），HTTP 面与面板投影共用同一实例。
let imRuntimeInstance: ImRuntime | undefined
export function getImRuntime(): ImRuntime | undefined {
  return imRuntimeInstance
}

export function setImRuntime(value: ImRuntime | undefined): void {
  imRuntimeInstance = value
}
// Prompt Template（提案 0008）总开关：默认关闭（安全默认）；profile 行
// templateEnabled: true 显式开启，DSH_SOULMOJITO_DISABLE_TEMPLATES 环境 kill
// switch 始终优先。无模板标签时链路直通，无额外开销。
let templatesEnabledFlag = false

export function store(): Promise<TavernStore> {
  return (storePromise ??= TavernStore.open(tavernDataRoot()))
}

export function memories(): Promise<MemoryStore> {
  return (memoryStorePromise ??= MemoryStore.open(tavernDataRoot()))
}

export function variables(): Promise<VariableStore> {
  return (variableStorePromise ??= VariableStore.open(tavernDataRoot()))
}

// 记忆向量缓存（提案 0016）：index.mjs 侧的 memoized 实例（维护 run 重嵌用；
// agent.mjs bundle 各自持有同款 memo，实例隔离但 CAS + digest 保证一致）。
let memoryVectorStorePromise: Promise<MemoryVectorStore> | undefined

export function memoryVectors() {
  return (memoryVectorStorePromise ??= MemoryVectorStore.open(tavernDataRoot()))
}

/**
 * Mod 宿主访问器：首次调用时扫描 `<tavern>/mods/` 并按三层开关装载（默认全关，
 * 扫描只读 mod.json 不执行代码）。坏 Mod 只记审计与状态错误位，不影响宿主。
 */
export function modHost(): Promise<ModHost> {
  return (modHostPromise ??= ModHost.open({
    ctx: modHostContext ?? {},
    root: tavernDataRoot(),
    hostVersion: BUILD_INFO.version,
    dbProvider: () => store(),
  }))
}

/** bootstrap 的 mods 投影（提案 0015 §3.5）：宿主初始化失败时回空数组不 500。 */
export async function modHostProjection(ctx: PluginContext): Promise<unknown[]> {
  try {
    const snapshot: ModHostSnapshot = await modHost().then((host) => host.snapshot())
    return snapshot.mods.map((mod) => ({
      id: mod.id,
      name: mod.name,
      version: mod.version,
      author: mod.author,
      description: mod.description,
      capabilities: mod.capabilities,
      panel: mod.panel,
      status: mod.status,
      enabled: mod.status === 'loaded',
      error: mod.error,
      auditCount: mod.auditCount,
      // 声明式按钮（A-1）：清单声明面，客户端据此渲染面板 chips 与聊天按钮行。
      buttons: mod.buttons,
      // P2（§3.5 启用确认弹层）：注册面——loaded 是实际注册名单，未装载回落
      // manifest 声明（作者自查面）。
      surfaces: mod.surfaces,
    }))
  } catch (cause) {
    ctx?.logger?.warn?.(`dsh-soulmojito: mod host unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
    return []
  }
}

export function novelStore(): Promise<NovelStore> {
  return (novelStorePromise ??= NovelStore.open(tavernDataRoot()))
}

/**
 * 自更新服务：默认开启自动发现（延迟首查 + 6h 复查），profile 里给 dsh-soulmojito
 * 行写 `checkForUpdates: false` 或设 `DSH_SOULMOJITO_DISABLE_UPDATE_CHECK=1` 可关闭。
 * 本地 stamp 见 readBuildInfo——模块加载时磁盘上的 version.json 旁车（安装器
 * 成功后统一落戳）优先，构建期 define 只是旁车缺席时的兜底；靠恒滞后一拍的
 * 字面量做身份会让 restart-required 永远解除不了（决策 2026-10-12）。
 */
export function tavernUpdate(ctx: PluginContext): TavernUpdateService {
  // HMR recompose 复用同一 module generation 重挂时，旧实例已被上一个 effect
  // 的 disposer 走到 dispose()——它的定时器与 pluginManager 监听都已拆除，
  // start() 会短路。这里检测已 dispose 就地重建，自动检查才不会静默死亡
  // （手动 check/install 路由拿的也是同一实例）。
  if (updateServiceInstance !== undefined && !updateServiceInstance.isDisposed) return updateServiceInstance
  updateServiceInstance = new TavernUpdateService({
    ctx,
    home: tavernDataRoot(),
    pluginDir: import.meta.dirname,
    local: { version: BUILD_INFO.version, commit: TAVERN_COMMIT },
    enabled: updateChecksEnabledFlag,
  })
  return updateServiceInstance
}

/**
 * 自动发现的开关：profile 的 dsh-soulmojito 行 `checkForUpdates: false`
 * 或环境变量 `DSH_SOULMOJITO_DISABLE_UPDATE_CHECK` 非空即关闭。
 */
export function updateChecksEnabled(config: { checkForUpdates?: unknown } = {}): boolean {
  if (config.checkForUpdates === false) return false
  const disabled = envCompat('DISABLE_UPDATE_CHECK')?.trim()
  return !(disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')
}

/**
 * 环境变量 kill switch（实时读）：`DSH_SOULMOJITO_DISABLE_TEMPLATES` 非空且不为
 * `0` / `false` 即关闭。生成/重试链路用它和 profile 的显式 opt-in 组合，env 关闭优先。
 */
export function templatesEnvEnabled(): boolean {
  const disabled = envCompat('DISABLE_TEMPLATES')?.trim()
  return !(disabled !== undefined && disabled !== '' && disabled !== '0' && disabled !== 'false')
}

/**
 * Prompt Template 开关（提案 0008）：默认关闭，只有 profile 的 dsh-soulmojito 行
 * 显式写 `templateEnabled: true` 才开启；环境变量 `DSH_SOULMOJITO_DISABLE_TEMPLATES`
 * 非空且不为 `0` / `false` 时始终关闭（优先于 profile）。模板面向可信卡作者，
 * 不是零信任沙箱。
 */
export function templatesEnabled(config: { templateEnabled?: unknown } = {}): boolean {
  return config.templateEnabled === true && templatesEnvEnabled()
}

// Mutable runtime state shared across the server modules. The apply wiring owns
// the write side; route and agent modules read through these accessors so no
// module has to import index.ts.
export function setUpdateChecksEnabledFlag(value: boolean): void {
  updateChecksEnabledFlag = value
}

export function templatesEnabledFlagValue(): boolean {
  return templatesEnabledFlag
}

export function setTemplatesEnabledFlag(value: boolean): void {
  templatesEnabledFlag = value
}

export function getAgentTavernCapabilities(): AgentTavernCapabilities {
  return agentTavernCapabilities
}

export function setAgentTavernCapabilities(value: AgentTavernCapabilities): void {
  agentTavernCapabilities = value
}

export function getAgentTavernCapabilitiesPromise(): Promise<AgentTavernCapabilities> | undefined {
  return agentTavernCapabilitiesPromise
}

export function setAgentTavernCapabilitiesPromise(value: Promise<AgentTavernCapabilities> | undefined): void {
  agentTavernCapabilitiesPromise = value
}

export function getAgentTavernProjectorPromise(): Promise<AgentTavernProjector> | undefined {
  return agentTavernProjectorPromise
}

export function setAgentTavernProjectorPromise(value: Promise<AgentTavernProjector> | undefined): void {
  agentTavernProjectorPromise = value
}

export function getAgentNovelCapabilities(): AgentNovelCapabilities {
  return agentNovelCapabilities
}

export function setAgentNovelCapabilities(value: AgentNovelCapabilities): void {
  agentNovelCapabilities = value
}

export function getNovelProjectorPromise(): Promise<NovelProjector> | undefined {
  return novelProjectorPromise
}

export function setNovelProjectorPromise(value: Promise<NovelProjector> | undefined): void {
  novelProjectorPromise = value
}

export function getNovelDriverPromise(): Promise<NovelDriver | undefined> | undefined {
  return novelDriverPromise
}

export function setNovelDriverPromise(value: Promise<NovelDriver | undefined> | undefined): void {
  novelDriverPromise = value
}

export function setModHostContext(value: ModHostContext | undefined): void {
  modHostContext = value
}

export function getGamesServicePromise(): Promise<GamesService> | undefined {
  return gamesServicePromise
}

export function setGamesServicePromise(value: Promise<GamesService> | undefined): void {
  gamesServicePromise = value
}
