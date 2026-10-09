# 决策：审查修复的七项去重/拆分重构

日期：2026-10-09。状态：已实施。相关：48f3f74d...HEAD 代码审查（Standards 轴五组重复 + 两组巨型函数/文件）；提案 0008-0014 与同日另五份决策。

## Problem

48f3f74 以来的 60 提交（+36k 行）在五个位置留下了逐字或同构的复制（同一语义靠拷贝维护，改动时静默漂移），两个文件出现了发散式变更（每个新功能都改同一函数/文件）。审查判定为本次 diff 最大的结构债。

## Decision

七项行为不变重构（全量测试 + gates 锁定，无运行时行为变更——唯一的例外见第 2 条）：

1. **工具参数助手统一**：`stringArg`/`boundedStringArg`/`clampInt`/`limitText` 三份逐字拷贝收进 `plugin/src/tool-args.ts`；writer.ts 的 limitText 定义迁走后 re-export 维持 agent-novel 既有 import 面。WRITER_TRUNCATION_MARKER 与 candidates.excerpt 是另一套带省略号的展示级截断，刻意不合并。
2. **prompt_order 选集/启用语义统一**：`resolvePromptOrder`/`entryEnabled`/dummy 常量由 tavern-pipeline 导出（plugin 经相对源码 import，esbuild 内联，零运行时新增依赖），preset.ts 删本地副本。**唯一的语义修正**：pipeline 侧启用判定从「仅 slot.enabled === false 跳过」统一到 ST PromptManager 语义（slot 布尔权威、缺布尔回落 prompt.enabled !== false）——边角场景（手改数据 slot 缺布尔且条目自标 enabled:false）pipeline 此前会注入，现与 preset 投影一致地跳过；新增 pipeline.spec 用例锁定回落方向。
3. **跨 bundle 监听器注册表工厂**：`cross-bundle-events.ts` 的 `createGlobalListenerRegistry` 统一 guides/preset 两份同构注册表；**Symbol.for key 字符串逐字保留**（存量 bundle 按 key 注册在 globalThis，换 key 会静默丢互见性）。
4. **懒装载投影工厂**：`lazy-projection.ts` 的 `createLazyProjection<V>` 统一 agent-tavern 四条文本通道（facts/guides/剧本摘要/预设）与 preset-mount 的闭包版——Map 缓存 + started + 票号 last-write-wins + settle 内置票号检查 + `refreshWhere`/`preheatWhere` 写穿遍历骨架（原 6 份拷贝）。门控失败策略（留旧值 vs 写空串）与冻结求值上下文（决策 2026-10-09-agent-preset-cache-stability）留在各通道的 load 注入里，工厂不感知。
5. **formatGuidesBlock 的 header 常量共享**：candidates.ts 硬编码的 header 字面量改 import `GUIDES_BLOCK_HEADER`；排序/形状容错保留本地实现（CandidateGuide.createdAt 可选，guides.ts 的 normalize 会丢无 createdAt 条目——行为差异刻意）。
6. **handleApi 域拆分**：guides/script/mvu/card-workbench 四组分支提取为同文件域处理器（handleNovelsApi 先例：显式传参、原位置委托）。分派条件是原分支条件的并集，处理器尾部 404 与级联兜底同文案；顺序敏感点（script/progress/ 先于 script/、POST script 不被 script/ 前缀吞掉）原样保留；路由字面量不动态构造（gates 在 bundle 上逐字断言 43 个路由串与 `assertStGenerationBinding(state, body.sessionId)` 调用形状）。
7. **card-workbench 域拆分**：2100 行单文件拆为 shared.ts（store 懒单例唯一实例 + 工具工厂 + 确认文案 + titleArg）+ tools-card/tools-world/tools-preset/tools-material 四域模块；agent.ts 仍是唯一 bundle 入口与聚合器，`createTools()` 按拆分前全序拼装（tools.spec 对 22 工具名做全序 toEqual，顺序是冻结契约）；`executeCardPlan`/`executeWorldPlan` 经 agent.ts re-export，index.ts decision 路由 import 面不变。域内常量先于模块级工具数组初始化（WORLD_ENTRY_FIELDS 表上移避免 TDZ）。

## Alternatives considered

- **只修 smell 不动 handleApi/card-workbench（低风险 5 项）**：两个巨型文件会继续随每个功能发散。用户选择全做。
- **handleApi 拆到独立文件**：模块级懒单例（storePromise 等单写者纪律）需要跨文件共享导出，同文件提取零状态管道。拒绝。
- **懒装载工厂连冻结上下文一起收编**：冻结是预设通道特有纪律（字节稳定性），抽象进工厂是投机泛化。拒绝。

## Consequences

- 复制面清零：五组重复各自只剩一份实现；新增通道/监听器/域工具有现成工厂可循。
- handleApi 从约 1205 行降到约 860 行（四域 15 个分支外迁）；card-workbench/agent.ts 从 2100 行降到约 190 行（入口 + KERNEL + 聚合）。
- **附带修复（验证期发现）**：`TavernStore.writeAtomic`（store.ts）在 Windows 上对瞬态 rename 占用（EPERM/EACCES/EBUSY/ENOTEMPTY）做有界退避重试——`getState` 的 readFile 与 `updateState` 的 rename 不互斥，预热/写穿并发的读句柄会让 rename 落到被打开的 state.json 上失败（tavern-command 预热用例的间歇红，重构后的异步时序放大了竞态概率）；确定性单测（mock 首次 rename 抛 EPERM）锁定重试语义。同包其余自建原子写点（originals/scripts/variable/memory/novel 与 plugin 侧 projectors/plans/update）存在同类理论竞态，无实证失败，记为跟进项——需要时把 `renameWithWindowsRetry` 提为共享 util 复用。
- 验证：`tsc -b` 0 错；全量 vitest 846 通过 + 1 跳过（61 文件，含预设字节稳定性双用例、22 工具全序断言与 EPERM 重试用例）；build-plugin 六 bundle 重建；plugin gates 13 项全 PASS；原间歇失败用例修复后 6/6 稳定。
- 行为锁定回归点：pipeline.spec 新增「顺序表缺 enabled 布尔回落条目自身 enabled」用例；store.spec 新增 EPERM 重试用例；其余全靠既有用例（未改任何断言）。
