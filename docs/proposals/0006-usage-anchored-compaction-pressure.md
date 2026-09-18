# 提案 0006：usage 锚定的压缩压力闸门

> 状态：已实施（2026-09-18 代码落地，`pnpm check` 全绿）。设计日期：2026-09-18。前置提案：[0004](0004-agent-tavern-architecture.md)、[0005](0005-agent-novel-architecture.md)。本文是 curator 压力触发策略的唯一设计说明。直接诱因：AgentNovel 真机 E2E 在 MiniMax-M3（token plan 512k）上以 `pi-ai detected context overflow` 失败（§1）。

## 1. 背景与故障机理

宿主 `dsh-compaction-basic` 的自动压力压缩在 `agent/pre-step` 触发，但它的闸门比较的是 `dsh-token-meter` 的**启发式表面估算**（默认阈值 `thresholdRatio 0.8`）。对中文正文该估算严重低估——真机故障会话（`session-b45f1229`）的实测：

| 量 | 值 |
|---|---|
| MiniMax 上报真实 prompt 用量（`pressureTokens = input + cacheRead + cacheWrite`） | **517,759** |
| 启发式表面估算（`surfaceTokens`） | 265,912（低估 ≈ 1.95x） |
| 配置窗口（token plan 上限） | 512,000 |
| 压力阈值（0.8 × 512k，比的是估算值） | 409,600 —— 永远够不着 |

结果链：压力压缩从未提前触发 → 请求发出 → pi-ai 在**成功响应**上做用量判定（`usage.input + cacheRead > contextWindow`）→ `dsh-llm-pi-ai` 映射为 `CONTEXT_WINDOW_EXCEEDED`（错误文案是无 `errorMessage` 时的 fallback：`pi-ai detected context overflow for model "..."`）→ 溢出恢复用同款 512k 模型总结约 50 万 token 区域，总结请求自身溢出 → 运行失败。

调低 `thresholdRatio` 只是按低估系数反推的**猜参**（当前 `~/.dsh/settings.yaml` 的 0.45 即此产物），换模型、换语种、换内容形态都要重猜。本提案用真实 usage 锚定闸门，消除猜参。

## 2. 目标与非目标

**目标**

1. 压缩触发时机由**真实用量投影**决定，启发式估算只作委托下限，不再猜低估系数。
2. 全部会话受益（主聊天、AgentTavern、AgentNovel 作者、novel 推演子代理），不只 novel。
3. 只拦截"何时压"的决策，压缩机制（prune、保留 16% 逐字尾部、重试循环、检查点合并）全部复用宿主。
4. 宿主行为零回退：投影缺失、服务缺失、宿主版本漂移时自动退回宿主原生策略。
5. 伴随修复：`agent-novel` 会话的压缩摘要改用 RP 检查点模板（宿主 basic 模板是编码助手导向的，见 §6）。

**非目标**

- 不改宿主包（上游修复是另一条路，见 §8）。
- 不接管溢出恢复路径（`context-overflow` 触发）——它保持宿主原样，作为单步暴涨的最后防线。
- 不做 novel 专属摘要模板定制（RP 模板已覆盖剧情状态需求，进一步定制另立提案）。

## 3. 复用的宿主 seam

| seam | 位置 | 约束 |
|---|---|---|
| `contextPressure` 投影 | `dsh-token-meter` state v4：`pressureTokens`（真实样本）、`surfaceTokens`、`sampledSurfaceTokens`、`contextWindow`；wire view 发布 `projectedTokens = max(0, pressureTokens + surfaceTokens − sampledSurfaceTokens)` | 采样在事件入表面**前**盖章，公式即"下一次请求"的占用估计；压缩影子价已计入 fold。公式必须**镜像**宿主 view，不得自创 |
| `ctx.sessionProjections.stateOf(session, key)` | 公开读取模式（`dsh-agent-presets` 读 `turnBoundary` 同款） | 同步；服务缺失时容忍性降级 |
| `compactIfNeeded` 动态分发 | 宿主 `_registerAutomaticCompaction` 经 `this.compactIfNeeded(...)` 调用，注释明说"subclass overrides are honored" | 覆写只应作用于 `pressure` 触发；`context-overflow` 透传 |
| `selectCompactableRange` | **模块私有**，子类不可复用 | 这决定了本设计"拦截决策、委托机制"，不能重写压力路径本身 |

## 4. 闸门设计

### 4.1 决策纯函数（`compaction/shared.ts`）

```ts
type PressureDecision =
  | { kind: 'delegate' }    // 真实闸门开启：委托宿主压力路径压缩
  | { kind: 'block' }       // 真实压力未到：拦截本次启发式触发（防过早压缩）
  | { kind: 'passthrough' } // 无真实样本/形状不符：维持宿主原生行为（冷启动、降级）
```

`usagePressureDecision(state, usageThresholdRatio)`：

1. `state` 缺失，或 `pressureTokens` / `sampledSurfaceTokens` / `contextWindow` 任一非有限数值，或 `contextWindow <= 0` → `passthrough`。`surfaceTokens` 缺失时按 `sampledSurfaceTokens` 计（投影公式退化为样本本身）。
2. `projected = max(0, pressureTokens + (surfaceTokens ?? sampledSurfaceTokens) − sampledSurfaceTokens)`。
3. `projected >= usageThresholdRatio × contextWindow` → `delegate`，否则 `block`。

默认 `usageThresholdRatio = 0.7`：真实值无估算误差，0.7 给单步增长（一个工具结果 + 一段正文输出）留 30% 余量；闸门在**每个 pre-step** 重查，不需要更大提前量。

### 4.2 curator 覆写（`compaction/curator.ts`）

```text
compactIfNeeded(agent, trigger, signal):
  trigger ≠ pressure        → super 原样透传（溢出恢复不动）
  读投影 stateOf(session, 'contextPressure')（服务/状态缺失 → undefined）
  decision = usagePressureDecision(state, usageThresholdRatio)
  block       → return null                     # 真实压力没到，拦掉启发式触发
  passthrough → return super(...)               # 冷启动/降级：宿主原生决策
  delegate    → result = super(…, 'pressure')   # 优先宿主路径：prune + 16% 尾部保留 + 重试循环
               result ≠ null → return result
               # 真实闸门开了但宿主启发式门没过（低估超过策略阈值补偿范围）
               → 兜底 super(…, 'context-overflow')   # 宿主无门限路径，retain 0
               兜底抛错 → warn 一条日志，return null（绝不因新增逻辑打断 turn）
```

兜底分支的存在使特性对用户的 `thresholdRatio` 配置**不敏感**：策略阈值没调低时最多走一次激进路径，调低后（推荐 0.2）几乎总是走保留尾部语义。

### 4.3 配置

curator 配置行与宿主策略共用 settings.yaml 的 `compaction-basic:` 键（插件以 `- id: compaction-basic` 覆写宿主条目，行配置整体进入 curator 构造器，由 `splitCuratorConfig` 分流）：

| 键 | 归属 | 语义变化 |
|---|---|---|
| `usageThresholdRatio` | curator（新增，默认 0.7，(0,1] 区间，非法值静默丢弃） | 真实用量闸门 |
| `thresholdRatio` | 宿主（现有） | **语义降级为委托下限**：只要真实闸门开启，估算值超过该下限宿主就会真压。推荐 0.2；不再承担"猜低估系数"职责 |
| `curatorProvider` / `curatorModel` / `curatorMaxTokens` | curator（现有） | 剧情会话摘要目标；大窗口模型可防"总结请求自身溢出" |
| **面板运行时覆盖** | TavernStore `state.compaction`（`{curatorProvider, curatorModel}`，2026-09-18 增） | **最高优先级**：Tavern 面板设置区"压缩总结模型"下拉写入，成对非空才生效、空值回落下一层。解析顺序：面板覆盖 > 部署层 curator 行配置 > 会话路由 > agent 选项（`mergeSummarizerTarget`） |
| `modelPolicies`、`summarizationProvider/Model` 等 | 宿主（现有） | 不变；宿主 policy 的 summarization 仍管非剧情会话 |

### 4.4 降级与版本漂移

- 宿主无 `sessionProjections` 服务、投影未注册、状态形状漂移 → `usagePressureDecision` 收到 `undefined`/不完整形状 → `passthrough`，压缩决策与今日完全一致；但降级不再无声——curator 按 (session, 原因) 去重打一条 `usage gate unanchored` warn（2026-09-18 增：真机 churn 事故里静默降级让闸门形同虚设，重启会话后也无人察觉；去重集有上限，满即清空重计）。
- 宿主未来重命名 `compactIfNeeded` → 覆写不再被调用，自然回退原生策略（不 fail）。
- 读取用 `this.ctx.sessionProjections?.stateOf?.(…)` 容忍式调用，不新增 `static inject` 硬依赖。

## 5. 故障模式对照

| 场景 | 行为 |
|---|---|
| 中文正文低估 ~2x（本次故障） | 真实闸门 0.7×512k=358k 触发 → 宿主压力路径（策略 0.2 下限必过）压缩 → 溢出前拦截 |
| 极端低估（估算 < 策略下限） | delegate + super no-op → `context-overflow` 兜底压一次 |
| 启发式**高**估（过早压缩风险） | 真实压力未到 → `block`，跳过本次触发（附带收益） |
| 冷启动会话（无 usage 样本） | `passthrough`，宿主原生启发式；每 (session, 原因) 附一条 unanchored warn（§4.4） |
| 单步暴涨越过窗口（一个大工具结果） | 闸门在 pre-step 只能看上一步之后的投影；来不及的部分仍由宿主溢出恢复兜底（本设计不削弱它） |
| 压缩中再触发 | 宿主 `assertNoActiveCompaction` / replaceGeneration 语义原样生效 |

## 6. 伴随修复：agent-novel 会话的摘要模板

curator 现判定 `binding.architecture === 'agent-tavern' && binding.group !== true` 才走 RP 检查点；`agent-novel` 作者会话落入宿主 basic 模板（"Files and Code / Pending Jobs"，编码助手导向）——对小说会话会把剧情状态摘要掉，与 0004 里 Tavern 会话的问题同源。修复：判定改为"剧情会话"——`agent-tavern` 非分组 **或** `agent-novel`（有 `novelId`）。RP 模板的七段结构（Story So Far / Characters / World Canon / Open Threads / Current Scene / Memory Maintenance / Critical Context）本就覆盖小说作者会话。

注意：剧情会话的摘要目标解析顺序是 curator 键 > 会话路由 > agent 默认。作者会话路由是 MiniMax-M3（512k）时，总结大区域可能自身溢出——部署配置应设 `curatorProvider`/`curatorModel` 指向大窗口模型（§7）。

## 7. 部署配置（真机 Web profile）

curator 的行配置走 **loader 条目配置**，即 profile patch 层（`~/.dsh/profiles/web/cordis.patch.yml`）。settings.yaml 的行只对注册了 `settings.installSection` 段的插件生效（如 `llm-pi-ai:`），curator 未注册 settings 段——写在 settings.yaml 里（无论 `compaction-basic:` 还是 `tavern-compaction:` 键）都不会生效（2026-09-18 真机踩坑，两次）。curator 经"停旧入口 + insert 新入口"挂载（宿主 patch 方言的覆写 `name` 是当前模块名守卫；dsh-web-app 本身也把 `compaction-basic` 与 `command-compact` 条目禁用了），**条目 id 是 `tavern-compaction`**：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: tavern-compaction
  config:
    usageThresholdRatio: 0.7      # curator：真实用量闸门（默认值，可省略）
    thresholdRatio: 0.2           # 宿主：委托下限（原 0.45 猜参降级）
    curatorProvider: siliconflow  # curator：剧情会话摘要走大窗口模型
    curatorModel: zai-org/GLM-5.2
    maxOverflowRetries: 3
    summarizationProvider: siliconflow   # 非剧情会话的摘要目标（透传宿主 basic）
    summarizationModel: zai-org/GLM-5.2
```

验证组合结果：`node <dsh>/lib/bin.js --profile web --dump-config`（确认 `tavern-compaction` 条目带 config）。`/compact` 命令在 web profile 被 dsh-web-app 禁用，手动止血走插件端点 `POST /api/dsh-tavern/compact`（body `{sessionId}`，要求 agent idle）。Node half 变更需重启 `dsh web`；Linux 盒子（独立 profile）同步。

## 8. 备选与否决

| 备选 | 否决理由 |
|---|---|
| novel driver 在 followup 前主动 `compactNow` | 只救 novel；`compactNow` 是手动语义（retain 0，不留尾部），且要求 agent 空闲 |
| 继续调低 `thresholdRatio` 猜低估系数 | 换模型/语种/形态即失效；高估场景反而过早压缩 |
| 上游修宿主（压力闸门直接读 contextPressure 投影） | 正确的长期方向，但受宿主发版节奏约束；curator 覆写是插件侧可立即落地的同构实现，宿主修复后本覆写可整体删除 |

## 9. 测试计划

`agent-tavern-compaction.spec.ts` 扩展：

1. `usagePressureDecision` 表驱动：delegate（超阈值）、block（未到）、passthrough（缺字段/冷启动/非法窗口）、投影公式镜像宿主 view（含 `surfaceTokens` 缺失退化、负增量 clamp 0）。
2. `splitCuratorConfig`：`usageThresholdRatio` 进 curator 桶（合法值保留、`0`/`1.5`/非数值丢弃），宿主键不受污染，`CURATOR_CONFIG_KEYS` 更新。
3. RP 模板路由：剧情会话判定纯函数覆盖 `agent-tavern`（含分组排除）与 `agent-novel`（含缺 `novelId` 拒绝）。
