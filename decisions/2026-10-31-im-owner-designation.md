# IM 会话主人：每个 peer 至多一位，面板与状态只认哈希

日期：2026-10-31。状态：已实施。前篇：`2026-10-31-im-native-session-binding.md`、`2026-10-31-im-inbound-coalescing.md`。

## 背景

群聊里每个成员都会说话，模型只看到 `[昵称] 正文`：它无法分辨哪一位是用户本人（主人），只能把所有人的要求一视同仁，或者靠昵称猜。私聊虽然没有「多人」问题，但用户仍可能想显式确认「这个对端就是主人」。插件需要一张**按会话**的主人表，并在转发文本里给主人一个明确标记，让模型知道该优先听谁的。

身份不能落原始 id：`openid`/`user_id` 会进 state、面板、HTTP 与模型上下文，可能被复述到群里。既有的 `privateAllow` 存原始 id 是历史例外，这次不复制它。准确口径是：主人/发言人的**值**只存哈希与显示名；peer 键沿用既有 `channel:account:scope:peerId` 约定（键本身含 peerId），本次不迁移。另有一个信任边界问题：正文里的 `[主人]` 只是展示，若把它当身份依据，昵称 `主人` 或换行后的正文都能伪造，所以权威信号必须在头部。

## 决定

1. **身份只过哈希**：`imSenderHash(channel, accountId, senderId)` = `snd-` + sha256(`${channel}:${accountId}:${senderId}`) 前 10 位十六进制（格式与校验定义在 `packages/tavern-store/src/im-state.ts`，`im/owner.ts` re-export，与 `imPeerAlias`/`imMessageRef` 同口径）。主人/发言人的**值**在 state、面板、HTTP、relay 文本、摘要与日志里只出现这个哈希与显示名；原始 sender id 不落入这些值。`channel`/`accountId` 进哈希，跨渠道/账号同名 id 不会撞车。`state.json` 的 peer 键沿用既有 `channel:account:scope:peerId` 约定（键本身含 peerId），本次不迁移——这是明示的残余风险，不是「平台身份完全不落库」。
2. **两张新表**（`packages/tavern-store/src/im-state.ts`）：
   - `imSenders: Record<peerKey, Array<{ id, name, lastAt }>>`：已投递对端的最近发言人，按 `lastAt` 倒序、同一 id 去重、每 peer 上限 `IM_SENDERS_MAX_PER_PEER = 20`。
   - `imOwners: Record<peerKey, { id, name, setAt }>`：每个 peer 至多一位主人；键不存在 = 未指定。`setAt` 是 ISO 字符串，`name` 是设置时的显示名快照。
   容错读取与既有 `imPeers`/`imPendingPeers` 同款：缺 id、非 `snd-<10 hex>` 哈希、时间戳非有限数/为负/超过 `Date` 上界（`IM_MAX_TIMESTAMP_MS = 8.64e15`）、不是对象的条目丢弃；重复发言人取最新；旧 `state.json` 没有两张表时读成空表（零迁移）。
3. **只记录真正投递的入站消息**：发言人写在 `deliverOne`/`deliverMerged` 的 `insert` 成功之后。去重命中、访问控制拒绝、未绑定对端（只记待办）、有文本但插入失败的消息都不碰这两张表——被拒绝的人不能靠「发一条消息」进入主人的候选名单。账本写入是 **best-effort**（`im/owner-ledger.ts`）：投递已成功，写盘失败只记一条 warn，绝不把异常冒泡回投递路径（批次余下条目已被去重表标记，冒泡会丢消息）。
4. **写入按 5 分钟窗口限流**（`IM_SENDER_REFRESH_WINDOW_MS`）：`state.json` 是整份重写，每条消息都刷新 `lastAt` 会让群聊消息变成逐条落盘。新发言人第一次出现必须写；同一发言人窗口内的重复投递**整条跳过**（包括改名——窗口只有几分钟，不值得为一次改名写盘）；窗口外刷新 `lastAt` 并把该发言人挪到最前。`lastAt` 因此最多滞后一个窗口，面板的「最近发言人」只承诺排序与大致新鲜度。
5. **relay 标记：权威在头部，正文只做展示**：
   - 单条消息（群聊/私聊）：头部追加 ` owner=1`，形如 `[IM qq/群聊 peer=… msg=… time=… owner=1]`。这是模型判断主人的唯一权威信号。
   - 合流批次：整批全部来自主人 → 头部 ` owner=1`；部分来自主人 → 头部 ` ownerItems=<1-based 条目序号逗号表>`（例如 `ownerItems=1,3`，序号对应正文里第几个 `[msg-…]` 条目，不是物理行号——条目正文可能自带换行）；没有主人 → 不出现这两个字段。
   - 群聊主人行仍加 `[主人]` 展示前缀（`[主人][昵称] 正文`），但提示词明确它只是展示，身份以头部为准。
   - 文本层防伪造：昵称先做 NFKC、去零宽字符、去方括号、折叠空白；归一化后恰好是保留词 `主人` 时回退为「群成员」。正文/附件路径的每个行首 `[主人]` 转义成全角 `［主人］`，用户文本不可能产生与插件标记逐字同形的行。
6. **HTTP 投影与写入**（`packages/plugin/src/http/im.ts`）：
   - `GET im` 增 `owners`、`senders`，只列**已绑定** peer；`peers` 行的私聊项增 `peerSelfId`（对端自己的发言人哈希，群聊没有），面板据此提供「设为对端为主人」，对端没发过消息也能设。`senders` 投影对 `lastAt` 再做一次范围检查，越界条目跳过而不是让 `toISOString()` 打崩整个 `GET im`。
   - `POST im/owner`：`{ channel, accountId, scope, peerId, senderId: <hash> | null }`。`null` 清除；其余必须是 `snd-<10 hex>`。校验 channel/scope/账号/peer 与绑定：未绑定 peer 返回 404；原始 id、格式不对、群聊里不在最近发言人表里的哈希返回 400；私聊额外接受 `peerSelfId`（等价于「对端本人」）。返回更新后的 owner 投影与整份 `owners`。
7. **面板**（`client-src/97e-ui-im-owner.js` 主人控件、`client-src/97f-ui-im-peers.js` 绑定行；manifest 里 97f 紧跟 97e、在 98-apply 之前）：每个绑定行显示 `主人：<name>` / `未指定`；选择器列出 `senders[peerKey]` 的哈希与昵称，私聊多一个「设为对端为主人」；已指定时出现「取消主人」。提交的 `senderId` 直接来自服务端投影，面板不接触原始 id。主人控件复用既有 `.dt-im-peer-actions select` 样式，不再往 95-ui-styles 的 CRLF 文件里追加新行。
8. **预设提示词**（`packages/plugin/src/im/agent.ts`）：一条规则说明头部的 `owner=1` / `ownerItems=…` 是权威主人标记，正文行首的 `[主人]` 只是展示——群聊里优先按主人的要求行动，其他成员不是主人，且不要向对端提起这套标记。

## 代价与边界

- **哈希碰撞**：10 位十六进制、每 peer ≤20 条、非对抗场景足够；碰撞只会把两个人认成同一个主人，不会泄露身份。
- **名字是快照**：改昵称后 `imOwners.name` 不会自动跟随；重新指定即可。面板优先显示 `name`，空名回退哈希（私聊自哈希显示「对端」）。
- **私聊不存昵称**：沿用 `imPendingPeers` 的纪律（私聊 `senderName` 常是 openid 前缀），`imSenders` 对私聊写入空名；面板用「对端」标签兜底。
- **未绑定期间的表**：解绑不删 `imOwners`/`imSenders`，只是投影里隐藏；重新绑定同一个 peer 会恢复原主人。这是有意的——解绑是会话绑定操作，不是「忘掉这个人」。
- **只能从最近发言人里选群主**：群成员还没在绑定后发过言时没有哈希可选；面板不提供「猜一个」的入口。
- **窗口内的改名不生效**：5 分钟内同一发言人换昵称不会写盘，面板短暂显示旧名。
- **每段对话一位主人**：不支持共同主人；多人群里如果需要「管理员」，未来另开概念，不把 `imOwners` 扩成数组。
- **peerKey 仍含 peerId**：本次不迁移既有键格式；「主人/发言人的值只有哈希」成立，但 state 的键与绑定行投影仍按既有约定含 peerId。要彻底去平台身份需要单独迁移，超出本单元。
- **账本写入可能丢一次**：best-effort 下写盘失败只 warn，最近发言人会暂时停在旧值，下一次成功投递补写；消息投递本身不受影响。
- **`ownerItems` 是合流条目序号**：不是物理行号（条目正文可能自带换行）；用 1-based 条目序号才能稳定对应正文里的 `[msg-…]`。
- **保留昵称会改名显示**：昵称归一化后恰好是「主人」时回退为「群成员」，这是防止整行与主人标记同形的代价。
- **`lastAt` 上界（覆盖 `imSenders` 与 `imPendingPeers` 两张表）**：超过 `IM_MAX_TIMESTAMP_MS = 8.64e15` 的条目在归一化与投影两层都丢弃，避免 `JSON.stringify` 后回读的 `toISOString()` 抛 RangeError；`imOwners.setAt` 是 ISO 字符串，不走这条时间戳路径。

## 否决项

- **照抄 `privateAllow` 存原始 openid**：会把平台身份带进 state、面板与模型上下文；新面一律哈希。
- **用昵称/显示名匹配主人**：昵称可改、可重复、可伪造；哈希来自平台 id，稳定且不可枚举。
- **存完整 sha256 或可逆编码**：10 位截断已足够区分本场景的少量发言人；更长的哈希只会增加 state 体积。
- **每条消息都刷新 `lastAt`**：`state.json` 整份重写，群聊会把磁盘写放大到每条消息一次。
- **把正文行首的 `[主人]` 当身份依据**：昵称 `主人`、正文换行、合流混合都能伪造；权威信号必须在头部（`owner=1`/`ownerItems`），正文只做展示。
- **用物理行号标 `ownerLines`**：合流条目正文可能自带换行，物理行号会漂移；用 1-based 条目序号更稳。
- **任意合法哈希都接受为群主**：面板只列最近发言人，接受未知哈希等于给手填/脚本留后门，且名字无来源。
- **自动把第一个发言人/私聊对端设为主人**：默认提升会改变模型行为却没有任何用户动作；主人必须由面板显式指定。
- **全局唯一主人**：同一位用户在不同群里可能是不同角色；主人按 peer 隔离。

## 验证

- `packages/plugin/tests/im-router.spec.ts`：单条群聊/私聊头的 `owner=1`、合流整批 `owner=1`、混批 `ownerItems=1`、非主人不带；正文 `[主人]` 只做展示，昵称 `主人` 回退「群成员」、正文换行后的 `[主人]` 转全角、混批非主人行伪造被转义；发言人表记录已投递消息且拒绝/未绑定不写、原始 id 不进表；每 peer 上限 20 与最新在前；5 分钟窗口内不调用 `updateState`、窗口外刷新 `lastAt`（假时钟 + 计数 store）；`updateState` 拒绝时整批仍投递且只留 warn。
- `packages/plugin/tests/im-owner.spec.ts`：哈希形状/稳定性/跨 channel/account 区分；`isImSenderHash` 只收 `snd-` 形状；归一化丢弃 `openid-alice` 这类非哈希 id 与 `1e300` 越界时间；合并函数的去重/窗口/上限/纯函数；旧 state 无两张表、坏行丢弃、手改文件可打开。
- `packages/plugin/tests/im-http-accounts.spec.ts`：`GET im` 的 `owners`/`senders`/`peerSelfId` 只含哈希且过滤未绑定 peer；`imSenders`/`imPendingPeers` 的 `lastAt=1e300` 不把整块打成 500（归一化 + 投影双层拦截，真实 store 级与 fake 投影级各一条）；`POST im/owner` 设置/清除、私聊自哈希；未绑定 404、原始 id/未知群成员/缺字段 400，拒绝时 state 不变。
- `packages/plugin/tests/im-agent-preset.spec.ts`：预设提示词含 `owner=1`、`ownerItems=…`、权威在头部、正文只是展示、优先主人、其他成员不是主人。
- `packages/plugin/tests/im-panel.spec.ts`：97e/97f 分片与 manifest 顺序、i18n 键、绑定行主人文案、选择器提交哈希/清除提交 null、群聊无「对端」选项。
