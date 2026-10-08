# 面板用 store 变更水位轮询吸收后台写入

日期：2026-10-08。状态：已实施。

## Problem

写卡 Agent 通过工具在服务端直接落盘（`card_put`/`card_create`/面板批准的执行核，
最终都走 `TavernStore` 的角色卡/世界书/预设写路径），而 Tavern 面板的资产列表只在
插件 apply 与面板自身写操作后拉取 `GET bootstrap`：`TavernPanel` 的拉取 effect 被
`state.loading` 一次性门闩挡死，工作台批准后也只 reload 方案列表。写入没有推送
通道、读路径没有变更水位，用户必须手动刷新整个页面才能看到新写的卡（2026-10-08
实测报告）。

## Decision

- `TavernStore.storeRevision()`：对 characters/worlds/presets/personas(+avatars)/
  groups 的目录项名 + size + mtimeMs 做 sha256 摘要，作为资产变更水位；只读目录
  元数据而不是文件内容，保证按秒级轮询足够便宜；
- `GET bootstrap` 携带 `storeRevision`，且水位先于资产列表读取（最坏情况只是下一轮
  多刷一次，不会出现「水位已推进但列表没读到」的漏刷新方向）；新增轻量端点
  `GET store-revision` 供轮询比对；
- 客户端页面可见期间按 3s 轮询水位，变化即重取 bootstrap；打开面板先无条件重取
  一次；工作台批准写路径在响应后立即重取。与自更新安装进度（1.5s 轮询 `/update`）
  同款轮询策略，不引入 SSE/WebSocket。

## Alternatives considered

- SSE/WebSocket 推送：DSH 宿主没有面向插件的服务端推送面，客户端也没有任何推送
  基建；自更新决策（2026-10-05）已明确「不需要 SSE」，为资产刷新单独引入长连接
  不划算，否决。
- 只做「打开面板时重取」：修不了「面板开着、Agent 仍在写」的场景（工作台会话可在
  同一页面继续跑工具，随时落盘），否决。
- `fs.watch`/chokidar 监听目录：跨 bundle 副本（index.mjs 与 card-workbench.mjs
  各自打开 store）、跨平台行为差异、事件噪声大，否决。
- 每次轮询直接重取整个 bootstrap：接口比水位重（含分组/人设/preset 详情），空转
  成本高，否决。

## Consequences

- 资产写入到 UI 可见的延迟 ≤3s（打开面板即时；面板批准即时）；无写入时每 3s 一个
  只读目录元数据请求。
- 水位覆盖 bootstrap 驱动的全部资产面（角色卡/世界书/预设/人设/群组），后续新增
  落在这些目录的资产自动获得同一刷新路径；chats/ 与 state.json 不参与——聊天有
  各自的 CAS revision 通道，state 由面板写路径自行刷新。
- 客户端对水位只做「不等即重取」比对，不依赖排序语义；服务端重启后水位由文件
  元数据重算，天然稳定。
- `store-revision` 已钉进 gates 的必需路由与客户端状态安全标记；客户端轮询逻辑的
  浏览器级端到端验证依赖真实运行环境（本仓库验证基线不含浏览器自动化）。
