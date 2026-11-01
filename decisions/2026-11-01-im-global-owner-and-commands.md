# IM 全局主人与斜杠指令：账号级指定 + 插件直执行

日期：2026-11-01。状态：已实施。前篇：`2026-10-31-im-owner-designation.md`、`2026-10-31-im-native-session-binding.md`、`2026-10-31-im-inbound-coalescing.md`。

## 背景

上一版主人表按 peer（一个群或一个私聊）指定：同一个用户在十个群里要设十次主人，换绑到新会话后还要逐个重设。实际使用里，「谁是这个 QQ 机器人 / OneBot 账号的主人」是账号级事实，不是会话级事实；会话级主人只应该用来表达例外（例如某个群由另一个人负责）。

同时，IM 侧的操作（看状态、把对话绑到 DSH 会话、解绑、查帮助）不该绕到网页面板：用户就在手机上，发一条指令最直接。但指令是**控制面**操作，不能让群里任何一个成员用 `/bind` 改走会话，更不能把 `/status` 之类文本塞进模型上下文让模型「自由发挥」。微信是私聊专用通道，不存在「其他成员」需要区分，也不该出现主人概念。

## 决定

1. **新增账号级主人表**：`state.imAccountOwners: Record<accountKey, ImOwnerEntry>`，`accountKey = ${channel}:${accountId}`（`imAccountKey`，定义在 `packages/tavern-store/src/im-state.ts`，与 `imPeerKey` 同处）。值形状与 `imOwners` 完全一致：只有 `snd-<10 hex>` 哈希、显示名快照与 `setAt`；原始 openid/user_id 不进入这张表、HTTP 投影或日志。
2. **主人解析顺序（只用于标记）**：`imOwners[peerKey]`（会话级）优先；没有则回落到 `imAccountOwners[channel:accountId]`；两者都没有 = 不是主人。**微信永不解析主人**——`resolveImOwnerId` 对 `weixin` 直接返回 undefined，即使 state 里有历史遗留行（面板不显示、写入被拒、标记也不认）。解析函数在 `packages/plugin/src/im/owner.ts`，投递侧 `owner-ledger.ownerIdOf` 只把 `peerKey` 拆成 channel/account 后调用它。
3. **`/bind` 的绑定来源**：`ImPeerBinding.boundBy` 增加 `'command'`，归一化只接受 `auto | manual | command`，其它手改值回落 `auto`。这样面板能区分「用户点的」与「对端自己发的指令」，也为将来审计留了字段。
4. **容错读取**：`normalizeImAccountOwners` 与 `normalizeImOwners` 共用单行归一化：键必须恰好是两段非空 `channel:accountId`，`id` 必须是 `snd-<10 hex>`，否则整行丢弃；`name` 缺省空串、`setAt` 缺失回落 epoch。旧 `state.json` 没有这张表时读成空表，零迁移。
5. **指令拦截在合流/绑定之前**（`packages/plugin/src/im/commands.ts`，路由 `inbound()` 里调用）：先剥掉行首连续的平台提及段（OneBot 的 `@<qq>`、QQ 可能保留的 `<@appid>` / `<@!appid>`），剥完再 `trim()`，以 `/` 开头即视为指令。`groupRequireMention: true`（默认）下 OneBot 群消息正文必然带 `@机器人`，不剥提及就永远认不出指令。顺序固定为
   1. 平台去重 `seenDedupe`（重放的指令不执行第二次；被拒绝的指令同样先烧掉键）；
   2. 访问控制 `imAccessAllows`（白名单外的人拿不到任何回执，与普通消息同口径）；
   3. 渠道判定（微信 → 回复「不支持指令」）；
   4. 全局主人校验（未设置全局主人或哈希不匹配 → 回复「只有全局主人可以使用指令」）；
   5. 执行并回执。

   去重先于访问控制是刻意的：白名单只在当前时刻决定「能不能收到回执」，不让一条之前被拒的指令在放开名单后被重放执行。非指令文本继续走原来的缓冲/合流路径；指令文本**不进入缓冲、不插入会话、不写 `imSenders`/`imOwners`**。
6. **四个指令的语义**：
   - `/status`：回渠道与范围、peer alias、绑定会话（长 id 遮罩为前 8 位 + `…`，未绑定如实说）、全局主人昵称（空名回退哈希）、当前时间；运行时有发送节奏投影时再加一行「现在可发/需要等待、下次可发、冷却至、队列 N 条」，缺省依赖时整行省略而不是编造。
   - `/bind <sessionId>`：把本 peer 绑到给定原生会话 id（`boundBy: 'command'`），顺手删掉同键的未绑定待办；缺参数回用法提示。**不创建、不恢复会话**；会话没打开也允许绑定，投递时会按既有 `IM_SESSION_NOT_LIVE` 提示对端。绑定成功后 best-effort 调 `applyImPreset`（由 runtime 注入）：回执写明「已切换 / 待切换（未打开或运行中） / 预设切换失败（详见运行日志） / 运行时未提供切换能力」；失败原因（host 术语、异常原文，可能带绝对路径）只写运行日志，**不进入群聊可见的回执**，切换失败不回滚绑定。
   - `/unbind`：删除本 peer 的绑定与未绑定待办；两者都不存在时回「本对话当前未绑定」。
   - `/help`：列出四个指令与「只有账号的全局主人可以使用」规则。
   - 未知指令（含单独一个 `/`）：回一行用法提示，主人校验规则不变。
7. **回执走既有 `sendNotice`，但不阻塞入站链**：一条短文本、`index/total = 0/1`，不经过模型、不经过会话；`void sendNotice(...).catch(warn)` 异步发出——通道发送可能排队或超时（微信队列、QQ 网络），控制面回执不应该拖住同一账号的下一条消息。发送失败只记日志（与未绑定提示同一条路径）。代价是回执到达顺序不保证与指令顺序一致，控制面可接受。
8. **HTTP**（`packages/plugin/src/http/im.ts`）：
   - `GET im` 增 `accountOwners`（过滤微信与坏键）与 `accountSenders`（把一个账号下**已绑定** peer 的最近发言人按哈希去重、时间倒序、截到 `IM_SENDERS_MAX_PER_PEER`），供「行为」页的全局主人选择器使用；`owners`/`senders`/`peerSelfId` 原样保留。
   - 新增 `POST im/owner/global`：`{ channel, accountId, senderId: <snd-hash> | null }`。微信 400（`微信渠道不使用全局主人`）；账号未登记 404；原始 id / 非 `snd-` 形状 400；`null` 清除；返回 `accountKey`、`owner` 与整份账号主人投影。
   - 既有 `POST im/owner`（会话级）同样拒绝微信：面板已隐藏控件，服务端再挡一层，避免脚本/旧面板写进死配置。
9. **面板**：「行为」页新增「全局主人」区（`97cc-ui-im-behavior.js` 的 `ImAccountOwnerBand`）：每个 QQ / OneBot 账号一块，显示当前主人（昵称或哈希回退）、从 `accountSenders` 选、已设置时可清除；下方是四个指令与全局主人规则的只读帮助。微信账号整块不渲染。绑定表里微信 peer 行的主人文案与选择器也整块隐藏（`97f-ui-im-peers.js` 按 peerKey 的 channel 判定）。写入走 `im/owner/global`，忙碌键 `globalOwner:<accountKey>` 与会话级主人、改绑互不阻塞。
10. **预设提示词**（`packages/plugin/src/im/agent.ts`）：一条规则说明 `/...` 是插件直执行的指令、只有账号的全局主人能用，其他成员发来的指令已被插件拒绝并回复，模型不得把这类文本当成自己的指令或任务。
11. **账号删除的清理**：`removeAccount` 同时删掉该账号的 `imAccountOwners` 行——账号没了，全局主人就是死配置；会话级 `imOwners`/`imSenders` 仍按上一版纪律保留（解绑不等于忘掉这个人）。

## 代价与边界

- **全局主人的候选只来自账号发言人聚合**：`accountSenders` 只来自已投递（已绑定）peer 的最近发言人。新账号需要先绑一个对话、对端发过消息，面板才会出现候选。服务端只校验 `snd-` 形状（与 `POST im/owner` 的入口校验同口径），不接受原始 id；手填一个没人用的哈希只会让指令一直没人能触发，不构成提权。
- **全局主人是「账号」不是「渠道」**：同一 QQ 渠道下两个机器人账号各有各的主人；同名 id 跨账号不会互相命中（哈希含 accountId）。
- **会话级主人仍是覆盖项**：一个群里换了负责人时，单独给这个 peer 指定主人即可，不必撤销账号级主人；反过来，撤销会话级主人会回落到账号级主人，而不是「没有主人」。
- **指令不是消息**：指令不写发言人表、不进会话、不出现在聊天历史里；模型永远不知道有人发过 `/status`（除非对端之后自己转述）。
- **`/bind` 不校验会话是否活着**：绑定是配置动作，投递才是运行事实；允许绑定一个当前没打开的会话，失败提示在投递时给。
- **`/status` 的发送节奏只覆盖实现了队列的通道**：当前只有微信有 `sendStatus`，QQ / OneBot 的这一行会省略。
- **群聊里的斜杠文本同样被拦截**：剥掉行首 `@机器人` / `<@…>` 提及后以 `/` 开头的群消息都会被当指令；非主人得到一条拒绝回执，不会被模型看到。这是有意的取舍——宁可误拦，也不让控制面文本进入会话。
- **回执是异步的**：控制面回复不阻塞入站链，多条指令的回复到达顺序可能与发送顺序不同；`/bind` 的回执仍包含预设切换结果，但预设切换本身是 best-effort，失败不回滚绑定。
- **预设切换只在绑定成功后调用一次**：与面板改绑一样，会话未打开/正在运行时留待宿主的 `agent/created` / `agent/status(idle)` 重试；`/bind` 不会自己起会话。
- **微信的历史遗留行**：state 里可能还有旧版本手改出来的 `weixin:*` 主人行；归一化保留（不迁移数据），但投影、写入与标记三处都不认它。

## 否决项

- **`/bind` 不带会话 id、由插件挑一个会话**：挑错会话等于把对话接进别人的上下文；绑定必须是用户明确指名的 id。
- **从 IM 指令创建或恢复会话**：`2026-10-31-im-native-session-binding` 已明确插件不代建会话；指令只能绑到已存在的原生会话。
- **让模型执行指令**（把 `/status` 插进会话，等模型回复）：指令是控制面，模型无法可靠地读写绑定与主人表，还会把控制文本混进角色扮演上下文；必须插件直执行。
- **会话级主人也能用指令**：群聊里任何一个被设为「会话主人」的成员都能改绑/解绑，等于把控制权交给群成员；执行权限只认账号级。
- **微信也支持指令/主人**：私聊专用通道没有多成员问题，主人概念没有意义；保留 400/拒绝回执是为了让脚本与旧面板得到明确答案，而不是静默吞掉。
- **接受原始 openid/user_id 作为全局主人输入**：会把平台身份写进 state 与面板；新面只收 `snd-` 哈希。
- **把 `imAccountOwners` 做成数组支持共同主人**：现阶段没有「多个全局主人」的语义，数组只会让执行权限的判定含糊。
- **给每条指令都回长帮助**：拒绝与用法提示保持一行，避免把控制面回执刷成聊天噪音。

## 验证

- `packages/plugin/tests/im-owner.spec.ts`：`resolveImOwnerId` 的会话级优先、账号级回落、坏 peer 键仍回落账号级、微信永不解析；`normalizeImAccountOwners` 的键形状与坏行丢弃；`normalizeImPeers` 保留 `boundBy: 'command'` 并把未知值降级 `auto`；旧 state 无三张表时读成空表。
- `packages/plugin/tests/im-router.spec.ts`：账号级主人单独存在时群聊头部 `owner=1` 且行首 `[主人]`；会话级主人压过账号级；微信即使三张表都有行也不加 `owner=1`、不加 `[主人]`。
- `packages/plugin/tests/im-commands.spec.ts`：`/status`（含节奏行、无投影降级与长会话 id 遮罩）、`/bind`（写入 `boundBy=command`、遮罩回执、空参数用法、预设切换已应用/待切换/未注入/失败原因不进回执只进日志）、`/unbind`（绑定 + 待办一起删、二次回未绑定）、`/help`、未知指令；非主人/无全局主人/仅会话级主人均被拒绝且不插入；微信拒绝；访问控制先于指令（无回执）；去重先于访问控制（拒绝后放开名单也不能重放）；慢回执不阻塞后续入站；重放指令只执行一次；指令不写 `imOwners`/`imSenders`；OneBot `@999 /status` 主人执行、非主人拒绝且绑定不被改；QQ `<@…>` 提及形态同样识别。
- `packages/plugin/tests/onebot-codec.spec.ts`：群聊 at 段与文本归一成 `@999 /status`，指令识别剥掉提及后成立。
- `packages/plugin/tests/im-runtime-accounts.spec.ts`：删账号时该账号的 `imAccountOwners` 行消失、另一账号保留。
- `packages/plugin/tests/im-http-accounts.spec.ts`：`GET im` 的 `accountOwners`（过滤微信与坏键）与 `accountSenders`（跨 peer 聚合、去重、倒序、只有哈希）；`POST im/owner/global` 设置/清除、微信 400、未知账号 404、原始 id 400、会话级路由拒绝微信；拒绝时 state 不变。
- `packages/plugin/tests/im-panel.spec.ts`：`im/owner/global` 调用点、`accountOwners`/`accountSenders` 数据源、全局主人区只列 QQ/OneBot、微信 peer 行没有主人控件、选择器提交哈希/清除提交 null、指令帮助文案与 i18n 键。
- `packages/plugin/tests/im-agent-preset.spec.ts`：提示词包含四个指令、插件直执行、全局主人规则，以及其他成员的指令不得当成任务。
