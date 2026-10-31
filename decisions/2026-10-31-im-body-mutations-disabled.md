# IM 绑定会话关闭正文手术：只读正文保留，编辑/重生成/候选切换停用

日期：2026-10-31。状态：已实施。前篇：`2026-10-31-im-native-session-binding.md`。

## 背景

AgentTavern 的正文手术（编辑正文、重新生成、候选切换）建立在 **body ledger** 上：
候选楼层由 `assistant/message` 与候选事件投影，`GET body` 读台账，三个变更路由
（`PUT body`、`POST body/regenerate`、`POST body/select`）再用 `groupId` /
`expectedAnchorId` / `expectedIndex` 做 CAS 后写回。

IM 绑定会话的回复不走 assistant 正文：Agent 通过 `im_send` 工具把回复发给 peer，
宿主会话里留下的是工具调用与工具结果，没有可对应的 assistant 楼层，也没有候选
台账。对这类会话放行正文手术，轻则编辑一个不存在的候选，重则让回滚、凭据和
投影水位互相打架。**能力必须在服务端关闭，而不是只在面板上藏按钮**：HTTP 面
可以直接被调用，UI 只是其中一个客户端。

## 决定

1. **绑定判定，不按预设判定**：`architecture === 'agent-tavern'` 且
   `state.imPeers` 中至少一条的 `sessionId` 等于当前会话时，判定为 IM 绑定。
   判定函数是 `packages/plugin/src/agent-tavern/body-view.ts` 的
   `imBodyMutationDisabledOf`；三个变更路由在任何状态变更（读卡、读聊天、启动
   运行时）之前复用它。
2. **统一拒绝**：三个变更路由返回 409，`code: 'im-body-mutation-disabled'`，
   消息固定为
   `IM-bound AgentTavern sessions deliver replies through im_send; body edit, regenerate and candidate switch are disabled`。
   响应不携带 peer key 或 peer id——请求里本来就有 session id，没有新增信息面。
3. **读仍然可用**：`GET body` 不拒绝，正常返回正文与候选计数；额外发布
   `mutationsEnabled: false` 与 `disabledReason`（同上消息），并把
   `canEdit` / `canRegenerate` / `canSelect` 置为 false。普通会话不出现这两个
   字段，旧客户端不受影响；`state` / `safety` 的既有 reason/detail 语义不改。
4. **面板只读态**：`packages/plugin/client-src/89b-ui-body.js` 在
   `mutationsEnabled === false` 时保留编辑/重生成按钮与候选翻页控件但禁用，
   `title` 优先使用本地化文案 `body.mutationsDisabledHint`（zh/en 双表），仅当
   字典连键都解析不到时才回落服务端 `disabledReason`；另挂一条
   `data-testid="tavern-body-mutations-disabled"` 的只读提示，文案走
   `body.mutationsDisabled`。
5. **其余能力不动**：历史、聊天浏览、记忆、世界书、工具、正文只读展示都保持
   原样；普通 AgentTavern 会话与非 Tavern 会话走原路径。

## 预设切换的边界

门控只看 `sessionBindings` 的架构与 `state.imPeers` 的 `sessionId`，**不看当前
预设**。用户可以在一轮对话后把 `agent-tavern-im` 切回普通 AgentTavern 预设，
但 peer 绑定还在，下一条 IM 回复仍会走 `im_send`；如果按预设判定，切换后的
窗口会重新打开正文手术，正好制造「台账与投递通道不一致」的状态。反过来，
解绑 peer 后即使预设仍是 IM 预设，也没有 IM 投递面，此时按普通 AgentTavern
会话处理即可。换言之：**能力跟随投递通道，不跟随界面选择**。

## 否决项

- **只在面板隐藏按钮**：HTTP 路由仍可调用，服务端状态照样会被改坏；UI 不是
  权限边界。
- **只按 IM 预设 marker 排除**：预设可在绑定存续期间切换，见上节；marker 是
  界面选择的结果，不是投递通道的事实，判定会随界面抖动。
- **用 marker / 合成 assistant 楼层补台账**：给 IM 回复伪造正文楼层会把
  `im_send` 的投递事实复制成两份真相，投影水位、回复锚点与工具结果都会争抢
  同一条正文；这属于绕过限制，不是支持正文手术。
- **直接 404 / 隐藏路由**：客户端无法区分「旧版本没有该能力」与「当前会话被
  禁用」，也会让既有诊断丢失稳定错误码。
- **把 IM 会话整个标成只读**：历史、记忆、世界书和工具都还能用，扩大拒绝面
  没有依据。

## 验证

- `packages/plugin/tests/agent-tavern-body-wiring.spec.ts`：
  `IM body mutation gate` 覆盖三个变更路由的 409 + `im-body-mutation-disabled`
  （并断言响应不含 peer key/id）、`GET body` 的 `mutationsEnabled:false` +
  `disabledReason` + 三个 `can*` 为 false、peer 绑定到其它会话时不误伤、普通
  会话响应不出现这两个字段。
- `packages/plugin/tests/agent-tavern-body-client.spec.ts`：只读面板解析
  `mutationsEnabled` / `disabledReason`、禁用控件与本地化 title、只读提示 test
  id，以及 zh/en 两个新文案键（zh 断言中文标题而非服务端英文常量）。
- `npx vitest run packages/plugin/tests/agent-tavern-body-wiring.spec.ts packages/plugin/tests/agent-tavern-body-client.spec.ts`
- `npx tsc -p packages/plugin/tsconfig.json --pretty false`
- `node packages/plugin/scripts/gates/run.mjs`
