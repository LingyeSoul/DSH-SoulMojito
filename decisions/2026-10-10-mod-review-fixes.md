# 主会话两轴审查的修复落地（Mod P0-P2 交付后）

日期：2026-10-10。状态：已实施。关联：`decisions/2026-10-10-mod-p0-hook-buses.md`（遗留
已知问题）、`decisions/2026-10-10-mod-p1-loader.md`（保留子段文档义务）、
`decisions/2026-10-10-mod-p2-capabilities.md`。

## Problem

对 8629b65…HEAD（提案 0015 P0-P2 落地等 12 提交）的两轴审查（Standards/Spec）发现三项
实质问题与一列判断级味道：

1. **P0 决策承诺移交的已知问题从未闭环**：mod 经 pre-llm 改写 `provider/model` 后，
   `llm.stream` 用 hook 后实参，但落盘 `swipe_info[].extra`、消息 `extra`、宿主会话轨迹
   三处仍记生成器选择器原值——元数据与实际请求分叉，且 mod-api.md 无任何警示
   （mod-p0-hook-buses.md:113 明文「记入提案 §5 语义，P1 处理」，P1/P2 均未处理）。
2. **保留子段注册即静默不可达**：`POST mods/<id>/enable|disable|reload` 被管理路由先于
   子路由分发截获，而 `api.http.route` 的注册面照单全收不报错——mod 作者注册成功却永远
   不可达（mod-p1-loader.md:72 的文档义务也只覆盖了 `install` 顶层段，未覆盖这三个子段）。
3. **判断级味道**：storage 配额控制流耦合在错误文案子串上；manifest semver 通配分支含死
   析取；`LoadedMod.surfaces.macros/sections` 全域只写不读（快照 `liveSurfacesOf` 只投影
   hooks/tools/http）；三处搬迁孤儿注释；install.ts 双胞胎 execFile 包装；stscript 一处
   格式回归。

## Decision

- **落盘元数据以 pre-llm 后实参为唯一权威**：`runGeneration` 在 dispatch 后取
  `hookedLlmRequest.params.provider/model`，`swipe_info[].extra`、消息 `extra.api/model`、
  `recordTavernSessionAssistant` 三处统一改用（提案 0002 既有行为——hook 空总线时与选择器
  值恒等，零行为变化；仅 mod 改写时元数据从「分叉」变「一致」）。mod-api.md §7 与提案
  0015 §5 补口径注记。
- **保留子段 fail-fast 拒在注册面**：`createModRouteTable.register` 拒绝
  `POST + enable|disable|reload` 精确组合（与 manifest 校验同款 fail-closed 纪律）；
  **仅此组合**——`GET ui` 是面板 iframe 表面约定路径（mod-api.md §13）必须可注册，其余
  method 的 enable 等路径实际可达不拒。mod-api.md §6 补保留段规则。
- **storage 配额结构化分类**：`inspectValue` 返回 `{ message, quota }`，`onQuota` 转发由
  `quota` 位决定，控制流与错误文案解耦。
- **味道清理**：manifest 通配分支化简为「过滤后为空 ⇒ 通配」（语义等价，含
  `comparators.every(v => v === '*')` 对空集恒真与 `'*'` 析取死分支的合并）；删除
  `surfaces.macros/sections` 死状态（三处 `.add` 写入与类型声明一并移除，快照形状不变）；
  孤儿注释三处清理（storage/install 的注释随代码移动或吸收进 `runGit` 文档，novel.ts 的
  fs-atomic 收敛注记删除——知识已在 fs-atomic.ts 头部）；install.ts 两个 execFile 包装
  收敛为 `runGit`（checkout 错误文案从 stderr 末行独挑改为 `error.message: 末行`，更可
  诊断，无测试钉死旧文案）；stscript.ts:146 双空格格式修复。

## Alternatives considered

- **swipe 元数据仅补文档警示（最小修复）**：保留分叉行为、mod-api.md 标注边界。否决——
  分叉本身是缺陷（用户在 UI 看到的「本条回复由哪个模型生成」会说谎），修复成本五行且空
  总线恒等，无需为缺陷保留兼容。
- **保留子段全 method 拒绝（照 P1 决策文字无限定读法）**：更简单但过度——只有 POST 组合
  被管理路由遮蔽，GET/HEAD 等实际可达；拒绝可达注册是无据能力削夺。
- **保留 `surfaces.macros/sections` 备将来快照展示**：Speculative Generality——等真需求
  出现再加（数据本就源自 api.* 注册面，可随时重建）。

## Consequences

- mod 改写 provider/model 后，落盘元数据与实际请求一致；既有聊天数据不受影响（仅生成时
  写入路径变化）。
- mod 注册 `POST enable/disable/reload` 从「静默不可达」变「装载即报错进错误位」——坏
  mod 更早暴露；已发布的 mod 若真注册了这些组合（三示例均无）会在面板错误位看到明确原因。
- `LoadedMod.surfaces` 类型收窄为三键；快照/面板/测试面零变化。
- 新测试：generation-hooks 增「落盘元数据记 hook 后实参」、tavern-mods 增「保留子段
  POST 拒/GET 放行/ui 可注册」。
