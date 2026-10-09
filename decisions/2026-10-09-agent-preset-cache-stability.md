# 决策：预设投影的前缀缓存稳定性（冻结投影）

> 日期：2026-10-09。状态：已实施。相关：`2026-10-09-agent-tavern-preset-projection.md`（预设投影本体）、`2026-10-09-workbench-novel-preset-projection.md`（工作台/小说挂载）、`2026-09-10-deduce-prefix-cache-reuse.md`（前缀缓存纪律的既有范式）。

## 背景：ST 与 Agent 的行为方式区别

预设接入 AgentTavern 后，用户观察到 provider 前缀缓存命中率骤降。根因不在「预设进不进 prompt」，而在两种架构对「已注入文本」的语义完全不同：

| 维度 | ST 模式 | AgentTavern（复用宿主 AgentLoop） |
|---|---|---|
| 请求构造 | 每轮从零全量重装（预设+世界书+宏+裁剪历史），一次性 stream | 每步只 append 新消息；历史与工具结果持久在 session surface |
| 已注入文本 | 每轮重算，不存在「上一轮的版本」 | append-only 的不可变历史；system prompt 是受保护首节点，宿主每步用新装配结果「替换或追加」 |
| 宏语义 | `{{time}}`/`{{random}}` 每轮重新求值就是 ST 的设计语义 | 求值结果成为历史字节；任何换值都改变请求前缀 |
| 缓存模型 | 无稳定前缀诉求（用户对宏换值导致的 miss 有认知） | 前缀缓存的命门在 system 头：字节一变，其后全部历史/工具消息的缓存一并作废 |

结论：预设在 AgentTavern 里的正确形态是「一次性注入 system 头、此后字节冻结」——即本仓库 deduce/writer/anchor 已确立的「字节稳定共享前缀 + append-only」纪律（2026-09-10 决策），预设投影此前没有套用该纪律。

## 根因：三个字节不稳定源

预设块是 `dsh-tavern:agent-preset` section（order -75），随宿主 system prompt 落在消息流最前端的受保护头。修前的三个突变源：

1. **重载即重算动态宏（主因）**：`loadAgentPreset` 每次执行都新建宏引擎（实时钟 + `Math.random`）。预设内 `{{time}}`/`{{date}}`/`{{datetimeformat}}`/`{{random}}`/`{{roll}}`/`{{idle_duration}}` 随每次重载换值。而触发重载的 `emitAgentPresetChanged` 有 7 处，其中 **index.ts 的会话激活预热每次重发**——用户每次打开会话，若预设带时间宏就烧一次全量缓存。
2. **懒装载竞态**：首轮装配返回空串，装载完成后整块出现——system 头一次突变。激活路径已预热，但插件重启后 store 里既有绑定（持续中的会话）不走激活路径，首轮仍会踩中。
3. **写穿无差别重载**：预设编辑/切换/人设变化对全部绑定重载。语义上应该生效（用户主动行为），但叠加 1 之后即使内容没变也会变字节。

## 决议：冻结投影（frozen projection）

核心不变量：**一个绑定的预设 section 文本，除非用户真的改了预设相关输入（内容/激活选择/人设/卡覆盖字段），否则字节永不变化。**

1. **每绑定冻结求值上下文**（`presetFreeze` / mount 的 `freeze`）：首次装载捕获 `frozenAt`（时钟）与 `seed`（RNG 种子），此后所有写穿重载用同一上下文重渲染。相同输入 ⇒ 相同字节；动态宏停在装载时刻。
   - `{{time}}` 冻结为绑定的装载时刻：Agent 语义下 system 头不该每轮变；**当前时间由宿主 `dsh-time-context` 在消息流尾部按 append-only 纪律提供**，语义不缺失。
   - `{{random}}`/`{{roll}}` 用 mulberry32 种子随机（`seededRandom`）：重渲染复现首次选择。
   - 实现通道：`createHostPromptExpander(char, user, frozen?)` 透传 `MacroEngineInit.now/rng`（引擎本就支持注入）；缺省行为不变（其余调用方不受影响）。
2. **启动预热**（`preheatAgentPresetProjections` / `PresetMount.preheat`）：模块 `apply()` 时装载全部既有绑定，消除重启后的首轮空串竞态。fire-and-forget，失败由懒装载兜底；预热只覆盖启动时已存在的绑定，之后新绑定的 agent 走懒装载回退（旧行为）。工作台/小说的预热由消费方 `apply()` 调 `mount.preheat()`——工厂在模块顶层执行，import 期 DSH_HOME 尚未确定，不能在工厂里直接跑。
3. **写穿语义保持「改了就生效」**：预设内容编辑、切换、删除回落、人设变化仍然立即写穿（下一次装配生效）。用户主动修改预设时一次性重建缓存是可接受代价（ST 也一样）；冻结求值上下文保证的是**没有真实输入变化的重载**（如激活预热、同内容 PUT）字节不变。

三个挂载点（AgentTavern / 写卡工作台 / AgentNovel）同套纪律，`preset-mount.ts` 与 `agent-tavern/agent.ts` 各自持有冻结记录（跨 bundle 闭包，无需共享——冻结记录只服务本 bundle 的渲染确定性）。

## 变化与代价

- system 头在会话生命周期内字节稳定（预设侧）；宿主其余 section（kernel 静态、可选全局段默认关）本就稳定。
- 重载不再有「时间宏换值」效应：同一预设反复写穿不产生额外缓存重建。
- 插件启动多一轮 best-effort 装载（读盘几次，无失败路径——catch 后回懒装载）。

## 边界与已知偏差

- **`{{time}}` 语义偏差**：冻结在装载时刻而非每轮当前时间。当前时间有宿主尾部时间上下文承接；若用户依赖「system 头里的时间随轮次刷新」，该诉求与前缀缓存互斥，不支持。
- **`{{idle_duration}}`**：装载时无 lastMessage 语境，展开为 'just now' 并冻结（修前行为相同，只是不再换值）。
- **EJS 模板 / regex 仍不进预设文本通道**（与 2026-10-09 投影决策一致）。
- **context 段不在本决议范围**：facts/guides/script 是 user-role runtime snapshot（宿主物化进 surface，旧快照留到 compaction shadow），不住在受保护头。其中剧本进度 `N/M` 计数器（`agent-script`）随推进变化——若宿主把 context 快照物化在头部附近，它对前缀缓存的影响需要另行评估（宿主源码不在本仓库，审计记录未定位置）；预设侧已闭环。
- **compaction**：宿主压缩重写 surface 时前缀必然变化，归宿主所有。

## 验证

- `packages/plugin/tests/agent-tavern-preset.spec.ts`：
  - 新增「跨写穿重载字节稳定」用例：秒级时间宏（`{{datetimeformat::HH:mm:ss}}`）+ 跨秒边界等待 + 同内容 PUT 写穿——重载后字节必须一致；内容编辑仍即时生效且冻结宏取值不漂移。**敏感性已验证**：临时移除冻结上下文后该用例确定性变红。
  - 新增「启动后新绑定的懒装载回退」用例：预热未覆盖的 agent 首轮空串→装载落定（旧行为锚点）。
  - 既有用例（-75 注册、宏展开、温度投影、state/PUT/DELETE 写穿、跨 bundle 注册表）全部保持绿。
- `packages/plugin/tests/preset-mount.spec.ts`：同款字节稳定用例（工作台投影，敏感性同上验证）。
- 全量 `pnpm check`（tsc + vitest + build-plugin + gates）通过（见提交）。
