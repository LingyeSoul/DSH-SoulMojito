# 会话消息 source 适配 format v4 的 producer-owned kind

日期：2026-09-30。状态：已实施。

## Problem

DSH `0.2.0-rc.2` 的 Session format 升到 v4，持久化 admission
（`dsh-session-persistence-jsonl` worker 内联的
`@deepseek-ai/dsh-session-format-v3-to-v4` `assertV4RowAdmission`）对
`kind === 'plugin'` 的消息 source 显式拒绝：

```
if (... || value["kind"] === "plugin") throw new SessionFormatError(
  "format v4 message requires a producer-owned source kind")
```

插件落会话日志的全部写入点（AgentTavern 历史导入镜像、锚定/开场提醒、
激活/关闭/预加载 notice、AgentNovel 调度 notice）此前都写 v0-v3 形状
`{ kind: 'plugin', plugin: 'dsh-tavern', ... }`——在 0.2.0-rc.2 宿主上，
事件一旦落盘即抛 `format v4 message requires a producer-owned source kind`，
历史导入、通知与锚定注入全部失效。内存 `Session.append` 不查这一条
（只查非空 kind），报错发生在异步持久化，定位时容易被 append 成功误导。

反向约束同样存在：**单一形状无法同时满足两端**。

- v4 要求非 `'plugin'` 的 producer-owned kind；宿主 v3→v4 迁移把
  `{ kind: 'plugin', plugin: '<name>' }` 重写为 `plugin:<name>` 并丢弃
  `plugin` 成员，其余自有 JSON 成员（form/summary）保留。`dsh-tavern`
  不在同名生产者名单，迁移产物即 `plugin:dsh-tavern`。
- v0-v3 的迁移链拒绝 v4 形状：v0→v1 边对未知 kind 走 default 分支
  （只查非空，`plugin:dsh-tavern` 能过），但 **v2→v3 边以封闭 kind 集合
  （SOURCE_KINDS：user/plugin/model/tool/agent-instructions/...）拒绝一切
  未知 kind**——`cannot safely transform unclassified message source`。
  把 v4 形状写进老宿主工件会在宿主升级时毒化整个会话文件，正是
  4f1b3cc 修过的"工件不可加载"事故类别。

## Decision

与 uiWorkspace / sessions.open 的双面探测同构，**按会话格式版本分支写入
形状**，集中到 `@dsh-tavern/bind` 的 host-session 兼容层：

- `hostPluginMessageSource(session, members?)`：读
  `session.header.version`（宿主 Session 公开字段，创建时即定，
  0.2.0-rc.2 恒为 4）。`>= 4` 返回 `{ kind: 'plugin:dsh-tavern',
  ...members }`（与宿主 v3→v4 迁移产物收敛为同一 kind）；其余
  （v0-v3、header 缺失的非宿主 stub）保持 `{ kind: 'plugin',
  plugin: 'dsh-tavern', ...members }`。fail-safe 方向选老形状：旧宿主
  与测试 stub 行为不变，v4 宿主必带 header。
- `isHostPluginMessageSource(source)`：读取端双形状匹配（v4 kind 或
  v0-v3 老形状）。宿主把 v3 工件读出时已迁移为 v4 kind，老形状匹配
  只为防御直读未迁移日志的路径。
- `TAVERN_PLUGIN_SOURCE_KIND = 'plugin:dsh-tavern'` 常量导出。

写入点改造（8 处）：`anchor.ts` 的 `createAnchorMessage` /
`createOpeningMessage` 增加可选 session 参数（pre-step 处传
`payload.agent?.session`）；`projector.ts` 的 `historyImportAppends`
增加第 5 可选参数 session；`index.ts` 关闭/预加载/激活三个 notice、
`driver.ts` 的 `buildNoticeMessage`、`curator.ts` 的 compaction 指令消息
改用工厂。读取点改造（2 处）：`projector.ts` `isTavernSessionMarker`
与 client `main.js` `isTavernSession` 双形状。

例外：`index.ts` runGeneration 的 llmMessages（`ctx.llm.stream` 请求消息，
不带 sessionId、不落会话日志，dsh-llm 对 source 不校验）保持 v0 形状并
注释说明——该作用域无会话对象可探测，为外观性字段引入宿主 API 依赖不值。

## Verification

- 真实宿主 admission 探针（`@deepseek-ai/dsh-session-format-v3-to-v4`
  `assertV4RowAdmission`，与 0.2.0-rc.2 持久化 worker 同源）：
  老形状被拒且报错原文与用户报告一致；`{ kind: 'plugin:dsh-tavern',
  form, summary }` 与裸 kind 均 ACCEPTED。
- v0→v1 边（`assertReleasedEventPayload`）：老形状 ACCEPTED（既有行为）。
- v2→v3 边：SOURCE_KINDS 封闭集合（v2-to-v3 lib line 14-30、123-125），
  v4 形状会被 "cannot safely transform unclassified message source" 拒绝，
  证实必须按版本分支而非全量切 v4 形状。
- 仓库全量：`pnpm run check` 通过（tsc、40 文件 532 测试、5 个构建产物、
  11 gates）。新增 22 个用例：bind 工厂/匹配器、disposition 双表
  （v0 封闭成员集 + v4 producer-owned）、v4 会话的锚定注入与历史导入、
  marker 双形状。

## Alternatives considered

- 全量切 v4 形状：v0-v3 宿主工件被 v2→v3 迁移边拒绝，毒化升级路径，否决。
- 保持老形状：0.2.0-rc.2 宿主上持久化必炸（即本 bug），否决。
- 写入失败时 try/catch 回退另一形状重写：append 在内存层成功、报错在
  异步持久化层，无法在写入点捕获；且历史导入逐条追加，中途失败留半截
  状态，否决。
- 以宿主版本号（`SESSIONS_VERSION` 等）分支：与 uiWorkspace 修复同理，
  探测实际对象的字段（`session.header.version`）比版本号字符串更可靠，
  否决。

## Consequences

- 同一份插件 bundle 在 v0-v3 与 v4 宿主上均可落消息；v4 会话里的插件
  source 与宿主迁移产物收敛为 `plugin:dsh-tavern`，读取端只认一个 v4 值。
- form/summary 等自有成员在 v4 admission 下保留（"Unknown attribution
  and own JSON metadata survive"），v0 disposition 的封闭成员集
  （{kind, plugin, form, sections, summary}）继续由
  `session-source-dispositions.spec.ts` 双表守卫。
- `scripts/repair-session-sources.mjs`（v0 毒化工件修复）无需跟进：v4
  宿主在 append→持久化边界拒绝非法 source，不会产生该类 v4 工件。
- 后续宿主若再调整 producer source 形状（v5+），只改 bind 的
  `hostPluginMessageSource` 探测分支。
