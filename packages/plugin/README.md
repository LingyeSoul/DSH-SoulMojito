# dsh-soulmojito（插件包）

monorepo 中的**可安装单元**：DSH 官方 Web bundle。产品概览、三种会话架构、能力地图与安装流程见仓库根 [`README.md`](../../README.md) 与 [`docs/README.md`](../../docs/README.md)，本文件只写包级内容。

`pnpm run build:plugin` 把八个 `@dsh-soulmojito/*` 工作区库与 Node half 打进六个自包含 bundle（`index.mjs` + `agent` / `compaction` / `novel` / `card-workbench` / `reasoning`），client closure 由 DSH profile 注入，不要求用户另行安装公共 `@deepseek-ai/*` 依赖。

## 安装

```sh
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
dsh --profile web
```

桌面版（`desktop` profile）用 Git 子目录 spec 安装——spec **必须**指向本目录，仓库根不声明 `dsh.bundle`，会被插件管理器以「这个包没有声明组合包，不能作为插件管理」拒绝。

```sh
dsh plugin --profile desktop add github:LingyeSoul/DSH-SoulMojito#path:/packages/plugin
```

从旧包名迁移（2026-10-16）时先 `dsh plugin --profile <p> remove dsh-tavern`。数据（新装 `$DSH_HOME/soulmojito/`、旧装 `$DSH_HOME/tavern/`）、既有会话与对局的持久化标记、旧环境变量（`DSH_TAVERN_*`）与旧游戏命名空间 id 均被读取端兼容，无需迁移；完整映射见根 README「从旧名迁移」。

## 包级运行面

以下几件事是本包的特性，不在根 README 展开。

### HTTP 信任边界与自定义 Host

插件 API 默认只信任 loopback（任意端口）、宿主上报的 bind host/origin；浏览器跨站 Origin、`sec-fetch-site: cross-site|same-site`、非 JSON 请求体与不匹配的 Host 仍会被拒绝。局域网、反向代理或自定义域名部署时，在 profile 的 `dsh-soulmojito` 行追加 `allowedHosts`：

```yaml
- id: dsh-soulmojito
  config:
    allowedHosts:
      - tavern.internal
      - tavern.internal:8443
```

- 条目是 `host` 或 `host:port`；不带端口表示该主机的任意端口，带端口只放行该端口。
- 大小写与末尾 DNS 根点会归一化（`Tavern.Internal.` → `tavern.internal`）。
- 不接受通配符 `*`、scheme、路径或凭据；非法配置在 `apply` 时直接报错，不会静默回退。
- 追加 allowlist **不会**放宽 Origin、`sec-fetch-site` 或 Content-Type 检查；反向代理必须保留原始 Host/Origin 语义。

### Compaction curator

`dsh-native` 模式下历史容量由宿主 `dsh-compaction-basic` 决定，而它的自动摘要是编码助手导向的（Files and Code / Pending Jobs 等段落），会把剧情状态、人物关系与记忆维护习惯摘要掉。本包的 bundle patch 因此把 `compaction-basic` 一行覆写为 `dsh-soulmojito/compaction`：该引擎继承宿主 basic 实现，触发时机、保留预算、overflow recovery 与工具结果修剪全部复用宿主，仅覆写摘要指令——

- **AgentTavern 绑定的会话**使用 RP 检查点模板（Story So Far / Characters / World Canon / Open Threads / Current Scene / Memory Maintenance / Critical Context），其中 Memory Maintenance 段显式记录记忆工具的维护状态，使记忆职责跨 compaction 延续；摘要语言跟随对话。
- **其余会话**（编码等）原样透传宿主默认摘要，零影响。
- 可选 curator 专属配置（其余配置键与 basic 完全一致）：`curatorProvider` / `curatorModel` 为 RP 摘要指定独立模型（缺省跟随当前路由），`curatorMaxTokens` 覆盖摘要输出上限（缺省 8192）。在 profile 的 `cordis.patch.yml` 给 `id: compaction-basic` 行加 `config` 即可。

回退：在 profile `cordis.patch.yml` 写 `- id: compaction-basic` + `name: '@deepseek-ai/dsh-compaction-basic'` 覆写回去。摘要调用与宿主默认 summarizer 同为 logged 的 `ctx.llm.stream` 辅助调用，`;compact` 手动命令与自动 compaction 共用该后端。

### 锚定提醒（开场装载引导 + 周期锚定）

工具调用衰减有两个实证窗口。本包通过宿主 `agent/pre-step` 在批次末尾（注意力最高点）追加提醒（与宿主 `dsh-time-context` 同款追加模式）：

- **开场不装载**：开场白与既有聊天历史会镜像进原生会话，模型把镜像剧情当作「本聊天已确立的事实」，反而抑制开场查证。第一个真实用户轮（会话尚无 `source.kind === 'user'` 消息）注入一次性的开场装载引导（`tavern_character_get` / `tavern_lore_search` / `memory_search` / `tavern_history_search` 清单），不受轮数节流；其后由周期锚定接管。
- **长上下文衰减**：system prompt 里的职责会被剧情文本稀释，模型在若干轮后停止主动写记忆/查世界书。默认每 5 个 turn 的 step 1 注入一次周期维护提醒，把职责重新拉回注意力。

共同契约：

- **触发**：仅 step 1；去重（同 turn 不重复，开场与周期共用去重账本）、空批次/拒绝/中止/非 AgentTavern 会话全部原样透传；存储读取只发生在注入点，非注入 step 零开销。
- **缓存安全契约**（不可破坏）：提醒 append-only 且 write-once——只追加到当前批次末尾、写入 durable log 后永不改写，因此对 KV 前缀缓存完全透明；内容不含易变计数器。
- **投影安全**：消息带 `dsh-soulmojito` plugin source，投影器按 `source.kind !== 'user'` 过滤，不会写进 Tavern JSONL 剧情记录。
- **配置**：`dsh-soulmojito` 行 config 的 `anchorEveryTurns`（整数；`0` 同时关闭开场引导与周期锚定，缺省 5，非法值回退默认）。

### 多 Agent 推演（tavern_deduce）

DSH 0.1.2+ 提供 SubAgent capability seam（`ctx.subagents`）与 in-process `spawn` 驱动。`tavern_deduce` 在此之上实现沙盘推演：调用方（RP 主 Agent）从剧情中归纳 2-5 个有利害冲突的角色（关键人物、阵营或全知视角），本工具为每个角色派生一个一次性子 Agent——spawn 语义不带父会话上下文，`toolFilter: { allow: [] }` 清空工具保持纯推理，`finally` 中 dispose 保证零泄漏。第 2 轮起每个角色的 prompt 携带此前各轮的全员站位，形成交叉推演（对峙、让步、反制）；transcript 由本工具无状态维护，不依赖 continuable 持久化。子 Agent 前缀级复用的成本优化见 [`decisions/2026-09-10-deduce-prefix-cache-reuse.md`](../../decisions/2026-09-10-deduce-prefix-cache-reuse.md)。

边界与失败语义：

- 单角色失败（非 `completed` 或空输出）只进 `failures` 数组，不阻断其余角色；全员失败才抛错。
- 推演结论不由子 Agent 合成——工具只回传各轮 `positions`，由主 Agent 织入叙事，保持单一叙事声音。
- 仅 AgentTavern 绑定会话可用（复用 binding 门禁，群聊拒绝）；未部署 dsh-subagent 的宿主上明确报错，而不是静默降级。

### 语言

插件 UI 跟随 DSH 的语言设置（`@deepseek-ai/dsh-client-locale`，zh/en）：client half 声明 `inject: [..., 'locale']`，向 locale 服务注册 `dsh-soulmojito` 命名空间字典并经 `useSyncExternalStore` 订阅快照，在「通用设置 → 语言」切换后无需刷新即时生效。字典 zh/en 键集与 `{param}` 占位符的对称性由 `client-vm-mount` gate 校验。

## 验证

```sh
pnpm run build:plugin
node packages/plugin/scripts/gates/run.mjs
```

15 个 gate 覆盖包元数据、Cordis patch、Node/client bundle、构建期 stamp、自更新路由、frontend runtime、client VM mount、Node half mount、AgentTavern 隔离、native header adapter、内部工作区、revision、stale binding、V4 会话准入与设置页边界。全量测试基线与门禁口径以根 [`README.md`](../../README.md) 的「测试与质量基线」为唯一来源，不在本文件另记一份（免得两份口径漂移）。

## 存量会话修复

历史版本写入的会话事件形状在 DSH 0.2.0-rc.2（session format v4）宿主上会让会话文件重开即拒载。仓库根提供两个修复脚本（默认 dry-run，`--apply` 落盘前自动备份 `.bak-<时间戳>`，且改写结果必须先通过真实宿主编解码/准入校验）：

```sh
# v4 工件四类毒化：assistant/chunk 毒事件、assistant/message 缺 settlement
# stream、turn:0 裸导入镜像（补全边界并重编号后续 turn）、裸 plugin source
node scripts/repair-v4-sessions.mjs <session.jsonl.zstd | sessions 目录> [--apply]

# v0 工件的消息 source 超员成员（0.3.9 之前写入 novelId/intentId 等）
node scripts/repair-session-sources.mjs <session.jsonl.zstd | sessions 目录> [--apply]
```

会话目录一般在 `$DSH_HOME/sessions`（默认 `~/.dsh/sessions`）。修复前先退出 `dsh web`——并发追加的帧会丢失。宿主运行时缓存不可用时加 `--runtime <node_modules>`（`pnpm check` 会装 `.npm-cache/dsh-runtime`）。
