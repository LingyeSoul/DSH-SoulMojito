# JSR P0/P1 补齐：流式生成、控制、事件与跨帧/存储

> 日期：2026-10-24
> 触发：用户要求实现兼容性报表的 4.1 与 4.2 P0/P1。
> 落点：`packages/plugin/src/frontend-generation.ts`、`helper.ts`、`generation/pipeline.ts`、
> `http/router.ts`、`client-src/10-frontend-frame.js`、`packages/tavern-jsr/src/client.ts`、
> `packages/tavern-frontend-storage/src/{client,idb-store}.ts`。

## 问题

2026-10-23 的兼容层已经对齐 JSR 4.11.3 的 179 个公共名与同步契约，但运行面仍有四个
P0 断点：`generate` 只有非流式最终文本；`stopGeneration*` 恒返回 `false`；事件只有
快照比对能证实的 13 个；iframe `/regenerate` `/stop` 没有接宿主。P1 还缺跨 iframe
事件、虚拟 IndexedDB 的 index/cursor、`extensionSettings` 持久化与更完整的 ST context。

## 决议

1. **流式生成放宿主侧**：新增 `POST /frontend/generate` NDJSON 路由，宿主解析卡内
   OpenAI 兼容接口的 SSE/JSON 增量，经既有 `helper-event` 通道转发给 iframe；
   最终 `done` 行携带完整文本，`generate` 的 Promise 语义不变。API Key 仍只进
   outbound `Authorization`，不进入事件、快照或错误消息。
2. **停止用服务端 AbortController 表**：`generate.stop` / `generate.stop-all` 按
   `character + chatId + generationId` 查表并 abort；`/stop` 额外中止 ST 主生成。
3. **事件只发可观测信号**：新增 `MESSAGE_SWIPED`（swipe 数/选中变化）、
   `PRESET_CHANGED`（快照激活预设变化）、`GENERATION_STARTED/STOPPED`（卡内生成桥
   生命周期）。`WORLD_INFO_ACTIVATED` 仍不伪造——宿主只在提示词查看器与激活轨迹里
   有这份信息，尚未接入 iframe 事件形状。
4. **`/regenerate` 只在 ST 架构接管**：宿主桥调用既有 `generateFor`，AgentTavern
   或生成中显式报错；不复刻 ST 的第二生成循环。
5. **跨帧事件显式化**：`eventEmit` 保持 iframe 本地；新增
   `TavernHelper.iframe.self/list/broadcast/emitTo`，宿主以 token 注册表转发，发送者不自收。
6. **虚拟 IndexedDB 补 index/cursor**：store 元数据保存 index 描述；index 查询与
   cursor 在 shim 侧基于 `idb.keys` + `idb.get` 实现；新增 `IDBKeyRange` 四种构造。
   `unique` / `multiEntry` / `index.delete` / `cursor.update` 与多 store 原子事务
   仍不支持，保持显式缺口。
7. **设置与音频持久化**：`extensionSettings` / `chatCompletionSettings` 用沙箱
   localStorage 的保留键持久；音频列表、当前曲目与设置同样落 localStorage，刷新后
   恢复状态（浏览器仍可能阻止自动播放）。
8. **ST context 补字段**：`getContext()` 增加 `chatMetadata`、`characterNames` 与
   完整 `getCharacterCardFields()`；`characters` 仍只装载当前卡，避免把全部卡正文
   塞进每个 iframe 的快照。

## 否决项

- **在 iframe 内直接 `fetch` 上游 API**：CORS 与 Key 暴露面不可控，继续走宿主代理。
- **伪造 `tavern_events.GENERATION_ENDED`**：卡内生成桥没有真实楼层写入，发它会让卡
  去读不存在的楼层；只保留 `iframe_events.GENERATION_ENDED`。
- **把 `eventEmit` 改成跨帧广播**：会破坏 JSR 的本地事件语义；跨帧走显式 `iframe` 命名空间。
- **为 IndexedDB 做完整事务引擎**：当前需求是卡内缓存与普通行查询，完整原子事务
  成本远高于收益；缺口继续显式失败。

## 边界（仍然不同）

- `WORLD_INFO_ACTIVATED` 未桥接；需要时轮询或看提示词查看器。
- `unique` / `multiEntry` / `index.delete` / `cursor.update`、多 store 原子事务不支持。
- `/regenerate` 仅 ST 架构；AgentTavern 仍由宿主 AgentLoop 管理，不提供 ST 重掷。
- 正则写面、角色卡/基础世界书/预设激活/扩展安装/宿主 DOM 仍显式拒绝。
- `getCharData(name)` 仍只对当前角色返回完整数据；其它角色用异步 `getCharacter(name)`。

## 测试

- `frontend-generation.spec.ts`：真实本地 HTTP 服务返回 SSE，断言增量拼接与最终文本。
- `frontend-generation-route.spec.ts`：NDJSON `start/delta/done`、按 id/按聊天 abort 表。
- `tavern-frontend-storage/tests/client.spec.ts`：虚拟 IndexedDB 的 index cursor +
  `IDBKeyRange.only`。
- 全量 `npx vitest run`：136 文件 2069 通过 + 1 跳过；`npx tsc -b --pretty false` 通过；
  `node packages/plugin/scripts/gates/run.mjs` 18 项 PASS。
