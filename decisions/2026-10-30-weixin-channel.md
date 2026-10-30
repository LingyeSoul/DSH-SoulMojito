# 微信官方 iLink 通道（提案 0024 M4）

> 日期：2026-10-30。状态：已落地。前置：提案 0024、施工计划
> [`docs/plans/2026-10-30-im-channels-implementation.md`](../docs/plans/2026-10-30-im-channels-implementation.md)。

## 问题

M0–M3 之后，OneBot 11 与 QQ 官方机器人都能收发，微信仍是空白。本轮补 M4：扫码绑定
（含验证码）、长轮询收消息、`context_token` 回带、`-14` 暂停、出站文本投影。协议事实
来自提案 §2.2 与参考实现 `login-qr.ts` / `monitor.ts`，只做文档写了的字段。

## 协议要点

### 1. 六个端点

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `POST /ilink/bot/get_bot_qrcode?bot_type=3` | 取二维码与轮询串 | 仅应用头（尚未绑定） |
| `GET /ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]` | 轮询扫码状态 | 仅应用头 |
| `POST /ilink/bot/getupdates` | 长轮询收消息（服务端挂起） | Bearer |
| `POST /ilink/bot/sendmessage` | 发一条文本 | Bearer |
| `POST /ilink/bot/getconfig` | 取 `typing_ticket` | Bearer |
| `POST /ilink/bot/sendtyping` | 开始/取消输入状态 | Bearer |

- 入口：固定 `https://ilinkai.weixin.qq.com`；确认后服务端下发 `baseurl`，后续请求全部
  走它（`im/weixin/api.ts` 的 `WEIXIN_FIXED_BASE_URL`）。
- 鉴权头：`Authorization: Bearer <bot_token>`、`AuthorizationType: ilink_bot_token`、
  `X-WECHAT-UIN`（随机 uint32 的十进制串再 base64）。所有请求都带应用头
  `iLink-App-Id: bot` 与 `iLink-App-ClientVersion`（`major<<16|minor<<8|patch`）。
- `base_info`：所有「受信」请求体都带 `{ channel_version, bot_agent }`；前者取
  `version.json` 的插件版本，后者是稳定的可观测标识。二维码两个端点不带它。

### 2. 游标先投递、后落盘

`getupdates` 返回的一页消息必须先逐条交给 router，再写新游标。反过来（先落盘）时，
进程在投递中途崩溃就再也拿不回这一页；先投递最多重放一页，去重日志会挡住重复投喂。
顺序由 `weixin-channel.spec.ts` 的 `deliver / cursor` 事件序锁住。

### 3. `context_token` 按对端记账

回复必须回带最近一条入站消息的 `context_token`。它按 `from_user_id` 记账（同对端后一条
覆盖前一条），落盘到 `weixin/<accountId>/context-tokens.json`，重启后继续可用；上限 500
条，超出淘汰最久未用的。缺 token 时只记 warning 并照常发送——丢了通行证也不能丢这一轮
回复。

### 4. `-14` 暂停一小时，且暂停期间不出站

`ret`/`errcode === -14` 表示 token 失效：账号进入 `paused` 一小时，不参与普通重试。
暂停期间：

- 轮询循环 `sleep` 到恢复时刻，不发任何 `getupdates`；
- `send()` 直接抛 `WEIXIN_PAUSED`，错误信息带恢复时间；
- `setTyping()` 静默跳过（typing 不是关键路径，不抛错）；
- 排队中的回复在真正出站前再判一次暂停，避免 `-14` 落在排队窗口里。

### 5. 扫码状态与 `verify` 相位

协议状态共八个：`wait / scaned / need_verifycode / scaned_but_redirect / expired /
verify_code_blocked / binded_redirect` 七个中间/终止状态，加 `confirmed` 换凭据。

- 面板相位：`idle → waiting → (verify) → saving → idle`，失败落 `failed{reason}`。
- `need_verifycode` 转 `verify` 相位并提示输入手机微信显示的数字；提交后回到 `waiting`，
  由服务端下一轮判定。错误码在 `verify` 相位之外提交一律 `WEIXIN_BIND_NOT_VERIFYING`。
- `scaned_but_redirect` 把后续轮询换到 `redirect_host`；只给主机名时沿用当前入口协议
  （本地桩/自建反代保持 http）。缺 `redirect_host` 只记 warning，不判死。
- `expired` 允许刷新一次二维码，第二次过期即 `failed`。
- `binded_redirect`：平台认为这个机器人**已经绑定**，本次不再下发凭据。语义是成功而
  不是失败——相位回 `idle`、触发 `onAlreadyBound`，已有凭据原状保留，面板不弹错误。
- `verify_code_blocked`：验证码尝试过多，本次扫码被判死（`failed` + 原因），要求重新
  扫码。与参考实现的口径差异：参考实现把该状态继续当作可轮询状态返回，本实现对一张
  已被封锁的二维码不再空转——协议没有给出解除封锁的路径，继续轮询只会拖住面板。

### 6. 游标落在 `im/cursors/<accountId>.json`

提案初期写的是 `weixin/<accountId>/sync-buf.json`，落地改为复用 `ImStore` 的通用游标面：
`$DSH_HOME/soulmojito/im/cursors/<accountId>.json`（形状 `{ "cursor": "…" }`，0600）。
理由：

1. OneBot 与微信的游标生命周期相同（重启续读、解绑清除），没必要两套文件格式；
2. 解绑账号只清一处，漏清会让下次绑定接着旧游标读，静默丢历史；
3. 提案 §4.2 已同步改为 `cursors/<accountId>.json`。

风险：游标文件名只含 `accountId`，跨通道同 id 会共用同一文件（当前账号命名空间实际
不会撞，但这是已知边界，见「风险」）。

## 其他落地口径（本轮审查修复）

- **`message_type` 是可选字段**：只有 `message_type === 2`（机器人自己的回显）才忽略；
  字段缺失或为 1 一律按真实用户消息处理。旧写法 `!== 1` 会把缺字段的正常消息吞掉。
- **HTTP 错误映射**：微信通道错误与 QQ 同口径——`WEIXIN_BAD_SECRET/BAD_TARGET/BAD_MESSAGE`
  → 400，其余（没在跑、状态读不出来、发送失败）→ 503；绑定错误里验证码坏 → 400，
  相位错/忙碌 → 409，其余 → 503。缺 `botToken` 的 `POST im/accounts` 因此是 400 而不是 500。
- **错误消息语言统一**：`im/weixin/*` 的运行时错误消息统一英文（日志/面板直接展示），
  代码注释保持中文。

## 否决项

- **把游标写进 `weixin/<accountId>/sync-buf.json`**：与既有 `ImStore` 游标面重复，解绑
  要清两处，见 §6。
- **暂停期间把回复攒起来**：恢复后发出的是一小时前的回复，用户与调用方都被骗。
- **`verify_code_blocked` 继续轮询**：一张被封锁的码不会自己解锁，见 §5。
- **`message_type` 缺失时丢弃**：协议字段可选，丢消息比多投一条更糟。
- **微信错误消息沿用中文**：同批其余微信文件的运行时错误已是英文，混语言让日志检索
  和面板文案都变差。

## 未做项

1. **媒体上下行**：`getuploadurl` + AES-128-ECB 上传、CDN 下载解密都不做；入站图片/
   文件/视频只记 `ImMediaRef`（kind + url + name/size），不下载、不转投；出站只发文本。
2. **真机扫码**：测试用本地 HTTP 桩锁住八个状态与 `verify` 相位，没有真实扫码记录；
   上线前需要人工扫一次，确认 `redirect_host` 与 `verify_code` 的真实形状。
3. **typing 成本**：每条入站/出站都会各发一次 `getconfig`（+ `sendtyping`），没有缓存
   `typing_ticket`。当前按账号串行且只在有消息时触发，量级可接受；高频对端下需要按
   peer 缓存并加 TTL。
4. **群聊**：带 `group_id` 的消息直接忽略（提案 §1「明确不做微信群聊」）。

## 验证

- `pnpm exec vitest run packages/plugin/tests/weixin-channel.spec.ts`：15 条，覆盖扫码
  八状态与 `verify` 相位、`scaned_but_redirect`、`expired` 刷新、`binded_redirect`、
  长轮询游标、投递先于落盘的顺序、`-14` 暂停与暂停期不出站、`message_type` 缺省、
  出站载荷/认证头/串行、typing 失败不阻断。
- `pnpm exec vitest run packages/plugin/tests/im-http-accounts.spec.ts`：微信缺 `botToken`
  → 400、`WEIXIN_CLOSED` → 503、绑定相位错 → 409/503。
- `node packages/plugin/scripts/gates/run.mjs`：新增 `im-channels` gate（腾讯包无静态
  import、构建脚本无 `external:`/`createRequire`、包清单无 `dependencies`、产物含两条
  OneBot 路径）。
- `pnpm run check`：tsc 三段 + 全量 vitest + build + 全 gates。
