# 施工计划：IM 通道（提案 0024）

> 日期：2026-10-30。状态：M0–M4 与 M5 客户端面板已落地（媒体与收口未做）。
> 设计契约：[`docs/proposals/0024-im-channels.md`](../proposals/0024-im-channels.md)。
> 验证口径：`pnpm run check`（tsc + vitest + build + gates）。

## 1. 本轮范围

**做**：M0 骨架 + M1 会话托管/立即投递/回复捕获 + 服务端路由与状态投影。
**不做（后续轮次）**：OneBot/QQ/微信 三条真实通道、客户端面板、`ws` 依赖、媒体。

这样排的理由：核心链路（绑定 → 建会话 → 激活 → 立即投递 → 回复回原 peer）不跑通，
接协议只是把坏链路接三遍。本轮用**假通道**端到端验证这条链路。

## 2. 模块与所有权

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/im/types.ts` | 通道/入站/出站/绑定/设置的全部类型；`imPeerKey` | 无 |
| `src/im/settings.ts` | 设置默认值、patch 校验、白名单判定 | `tavern-store` 类型 |
| `src/im/store.ts` | 密钥文件（0600）、去重键、游标 | `node:fs` |
| `src/im/project.ts` | 展示文本 → IM 文本 → 切分（QQ/微信/OneBot 三档） | 无 |
| `src/im/session-host.ts` | `ensureImSession`：resume/create + preset mount + bindSession + 开场白导入 | 注入式 host seam |
| `src/im/reply.ts` | `pendingOrigins` + `turn/end` 取正文 + 投影等待 | `sessionEvents` |
| `src/im/router.ts` | 入站流水线：去重 → 白名单 → 绑定 → 立即投递 | 上述模块 |
| `src/im/runtime.ts` | 单例注册表：通道集合、路由、生命周期 | `router` |
| `src/http/im.ts` | 面板 API（状态/绑定/设置） | `router`/`store` |

**不变量**：
1. `im/*` 不 import `generation/pipeline.ts`，IM 不走 ST。
2. 通道适配层（后续）只依赖 `types.ts`，不认识聊天与会话。
3. 身份只来自真实 `sessionBindings`，工具与路由都不能用参数指定会话。
4. 所有新文件 < 800 行（source-file-budget）。

## 3. 数据形状

`state.json` 新增（都可缺省，旧数据零迁移）：

```ts
interface TavernState {
  imSettings?: ImSettings            // 缺省用 DEFAULT_IM_SETTINGS
  imPeers?: Record<string, ImPeerBinding>   // key = imPeerKey(...)
}
```

密钥与游标不进 `state.json`：

```
$DSH_HOME/soulmojito/im/accounts.json
$DSH_HOME/soulmojito/im/secrets/<channel>-<accountId>.json   # 0600
$DSH_HOME/soulmojito/im/dedupe.log
```

## 4. 里程碑与出口条件

| 里程碑 | 出口 |
|---|---|
| M0（已完成） | 假通道 + 假 Agent 跑通「入站 → 绑定 → followup → turn/end → 回复」；`im-*.spec.ts` 全绿 |
| M1（已完成） | `ensureImSession` 独立/共享两种模式都能建绑定；缺 `agents.create` 时 fail-closed；IM 工具族与历史导入落地 |
| M2（已完成） | OneBot 11 反向 WS + HTTP POST 打通（codec + 连接层 + 账号路由） |
| M3（已完成） | QQ 扫码绑定 + 官方网关；两个腾讯包外挂安装、运行期动态导入 |
| M4（已完成） | 微信扫码（含验证码）、长轮询与游标、context token、`-14` 暂停、出站文本投影 |
| M5 | 客户端「聊天渠道」面板（已完成）；媒体 + 收口（未做） |

### 4.1 已落地（2026-10-30，五批）

第一批（`098db83`）：`im/types.ts`、`im/settings.ts`、`im/store.ts`、`im/project.ts`、
`im/session-host.ts`、`im/reply.ts`、`im/router.ts`、`im/runtime.ts`、
`im/onebot/codec.ts`、`http/im.ts`；`tavern-store/src/im-state.ts` 与
`TavernState.imSettings/imPeers`；`host-contract` 的 `registerUpgrade` 与
`agents.resume` / `followup` 声明。

第二批：`im/handle.ts`（跨 bundle 句柄 + env 硬关）、`im/tools.ts`
（`im_identity` / `im_channels` / `im_send`）、`session/activate.ts`
（历史导入抽给命令与 IM 共用）、`agent-tavern/agent.ts` 追加工具、
`session/command.ts` 改为调用抽出的导入函数、`im/session-host.ts` 在手绑/共享
模式下也导入历史。

第三批：`im/qq/sdk.ts`（两个腾讯包外挂安装 + 运行期动态导入 + 安装状态投影）、
`im/qq/channel.ts`（WebSocket 网关相位、入站归一、被动回复上限、markdown 两档、
出站串行）、`im/qq/bind.ts`（扫码状态机，连接器惰性加载）、`im/runtime.ts` 的 QQ
账号安装/回滚与扫码接线、`http/im.ts` 的 `qqRuntime` 投影。终态：根 `package.json`
不含任何腾讯依赖，`scripts/build-plugin.mjs` 的六个入口都不需要 `external` 列表或
`createRequire` 垫片——第三方 QQ 代码根本不进产物。决策记录：
[`decisions/2026-10-30-qq-channel.md`](../../decisions/2026-10-30-qq-channel.md)。

第四批：`im/weixin/api.ts`（六端点 + 两套错误面 + 响应形状校验）、`im/weixin/bind.ts`
（扫码八状态 + `verify` 相位 + 一次刷新额度 + IDC 重定向）、`im/weixin/channel.ts`
（长轮询、游标、context token、`-14` 暂停与暂停期不出站、出站串行）、
`im/weixin/context-tokens.ts`（按对端落盘，0600）、`im/weixin/clock.ts`、
`im/runtime.ts` 的微信账号安装/扫码接线与白名单、`http/im.ts` 的微信错误映射。
游标复用 `ImStore` 的 `cursors/<accountId>.json`。新增 `im-channels` gate 锁住
「腾讯包不进产物」四条不变量。决策记录：
[`decisions/2026-10-30-weixin-channel.md`](../../decisions/2026-10-30-weixin-channel.md)。

第五批（M5 客户端面板）：`client-src/97-ui-im.js`（三张通道卡 + 状态灯、扫码
相位轮询（1.5s）与微信验证码、OneBot 端点地址/安装指引、绑定表与「共享会话」
徽标、自动绑定与白名单）、`90-panels-core.js` 注册 `im` 分区、
`40-i18n-en.js`/`41-i18n-zh.js` 各 86 条键、`95-ui-styles.js` 的 `dt-im-*`
样式（只用既有 `dsw-alias-*` token）、`tests/im-panel.spec.ts`（22 条：结构、
vm 纯函数、渲染冒烟）。改绑下拉直接取 bootstrap 的 `characters` 与
`chatLists`，**未新增任何服务端路由**。`im-channels` gate 补第六条不变量：
分片清单必须含 `97-ui-im.js`（服务端路由齐全但分片缺失时，浏览器里只会表现为
「分区不见了」）。

**明确未做（下一轮）**：
1. 媒体双向：微信 CDN 上传/下载与 QQ 附件；当前入站只记 `ImMediaRef`，出站只发文本。
2. 真人扫码的端到端验证（微信八状态与 QQ 四相位都只有本地桩），以及面板的桌面/390×844 手测。
3. QQ 群聊流式输出；微信 typing 的 `typing_ticket` 缓存（当前每条都重新 `getconfig`）。

## 5. 测试面

| 文件 | 断言 |
|---|---|
| `tests/im-project.spec.ts` | 剥前端/MVU、CJK markdown、三档切分、空投影占位 |
| `tests/im-settings.spec.ts` | 默认值、非法 patch 拒绝、白名单三态 |
| `tests/im-store.spec.ts` | 0600、去重键 TTL、游标读写、坏文件不静默 |
| `tests/im-session-host.spec.ts` | 独立/共享绑定、resume 复用、缺能力 fail-closed |
| `tests/im-reply-target.spec.ts` | 谁的 message id 命中回给谁、无命中不发、多 origin 取最早 |
| `tests/im-router.spec.ts` | 立即投递、去重、白名单拒绝、未绑定提示、sendText 目标校验 |
| `tests/im-tools.spec.ts` | 身份只认 agent id、alias 不泄露平台 id、跨会话拒绝、多绑定需指定、env 关闭不注册 |
| `tests/session-activate.spec.ts` | 导入计划落地、读回失败降级关 turn、基线不可推进只 warn |
| `tests/onebot-codec.spec.ts` | 事件归一、CQ 转义、出站参数 |
| `tests/onebot-server.spec.ts` | 握手/401、入站、群 @、分片、未掩码 1002、并发发送不交错、webhook |
| `tests/qq-channel.spec.ts` | 入站归一、无 id 用 UUID 去重、群 @ 门控、被动回复上限 4 条、markdown 两档、并发出站不交错、相位与重连清错、缺包不落盘、安装失败回滚、扫码四相位 |
| `tests/weixin-channel.spec.ts` | 扫码八状态与 `verify` 相位、IDC 重定向、过期刷新、`binded_redirect` 成功语义、游标续读与「投递先于落盘」、`-14` 暂停与暂停期不出站、`message_type` 缺省按用户消息、出站载荷/认证头、typing 失败不阻断 |
| `tests/im-runtime-accounts.spec.ts` | 账号 upsert/remove、重启恢复、缺 seam 原因 |
| `tests/im-http-accounts.spec.ts` | 账号路由校验、webhook 401、`GET im` 的 `qqRuntime` 投影 |
| `tests/im-panel.spec.ts` | 分片清单顺序、`im` 分区注册、86 条 zh/en 键、8 条管理路由、扫码 1.5s 轮询与四相位、`qqRuntime` 缺包禁用、共享徽标/白名单/安装命令纯函数、渲染冒烟 |

## 6. 下一轮入口

- `ws` 只作为构建期内联依赖引入（`packages/plugin/package.json` 仍无 `dependencies`）。
- QQ 的两个腾讯包**不进产物**：装在 `$DSH_HOME/<tavern>/im/runtime/`，由面板按
  `GET im` 的 `qqRuntime` 指引安装（见决策 §1）。
- OneBot 反向 WS 需要 `webServer.registerUpgrade`；缺失时只开 HTTP POST 并在面板标注。
- QQ/微信凭据一律只在 `im/secrets/`，面板只读前缀。
