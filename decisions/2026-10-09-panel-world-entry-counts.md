# 面板世界书列表预显条目数

日期：2026-10-09。状态：已实施。关联：`decisions/2026-10-09-panel-create-world-preset.md`（面板世界书分区的既有交互）、`decisions/2026-10-08-worldbook-full-editing.md`（世界书编辑路径）。

## Problem

面板世界书列表每行有「N 条目」按钮（点击展开浏览/再点收起），但书本内容只在
浏览/编辑时才按需懒加载（`books` 缓存初始为空），按钮文案取
`books[name]?.entries?.length ?? 0`——没点开过的书永远显示「0 条目」。用户不点
编辑就以为世界书是空的/导入失败了；懒加载进行中（占位 null）的一瞬同样显示 0。

## Decision

- **bootstrap 附带条目数投影**：`GET bootstrap` 新增 `worldEntryCounts:
  Record<string, number>`，服务端遍历 `listWorlds()` 逐本 `getWorld` 取
  `entries.length`。与既有 `presetKinds` 同款服务端轻量投影（bootstrap 本就
  全量读 presets/personas/groups，读 worlds 计数属同一成本量级），书本全文
  仍按浏览/编辑懒加载，不放大面板首开载荷。
- **计数口径与浏览视图一致**：含禁用条目（浏览列表本就展示禁用条目、置灰），
  按钮数字 = 展开后看到的条目总数。
- **坏文件只缺数不断路**：逐本 try/catch，损坏的世界书 JSON 不进计数表
  （客户端回退 0），bootstrap 不因单本坏书 500；点开该书仍走既有 fetch
  错误路径，可见报错。
- **客户端消费零管道**：列表文案改为
  `books[name]?.entries?.length ?? state.bootstrap.worldEntryCounts?.[name] ?? 0`
  ——已缓存书本用实长，否则用 bootstrap 计数。刷新链路复用既有收敛点：
  导入（importAsset）、保存/新建（saveWorldBook）、删除（deleteWorldBook）
  都已调 `refreshBootstrap()`，后台写卡 Agent 落盘走 store-revision 轮询
  重取 bootstrap——所有变更路径的计数自动跟随，无新增客户端状态。
- **改名/懒加载占位顺带修正**：改名保存后 `books` 缓存键已换新名，实长优先
  于旧计数；fetch 进行中的 `null` 占位现在落到 bootstrap 计数而非 0。

## Alternatives considered

- **面板挂载时客户端逐本 fetchWorldBook 预热**：复用现有取数但把所有书全文
  拉进浏览器——多本大书时首开明显变重，且 N 个请求的并发/失败面都要自己管。
  否决，服务端一次投影更省。
- **新增 GET world-stats 专用端点**：少传了全文，但多一条路由 + 客户端一套
  独立刷新管道（bootstrap 轮询收敛点覆盖不到它）。计数信息量小，随 bootstrap
  搭车即可。否决。
- **worlds 列表形状改为 `{name, count}[]`**：`state.bootstrap.worlds` 在面板与
  Agent 侧多处按 `string[]` 消费，改形状是全链路 breaking。否决，加平行字段
  向后兼容（老服务端/新客户端自然回退 0，不劣于现状）。

## Consequences

- 世界书列表不点开即显真实条目数，「看起来是空书」的误导消除。
- bootstrap 载荷新增一个每书一个数字的映射；`worldEntryCounts` 投影与坏文件
  容错（坏书进名字列表、缺计数、bootstrap 仍 200）由 tavern-command.spec.ts
  用例锁定，防止后续路由改造无声破坏。
- 若未来世界书规模大到计数遍历成为 bootstrap 瓶颈，可再下沉为 store 层缓存
  或并入 store-revision 水位机制；当前量级（家庭酒馆场景）无此需求。
