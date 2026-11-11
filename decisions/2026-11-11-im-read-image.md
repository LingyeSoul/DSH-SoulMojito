# 图片输入分两条路：默认 Agent 模式走宿主原生 block，IM 模式挂 `read_image`

> 日期：2026-11-11。状态：已实施。相关：`decisions/2026-11-10-im-native-agent-mode.md`（IM 默认零宿主工具的原边界）、`decisions/2026-11-10-im-native-preset-host-row-drift.md`（preset 行只在会话激活时展开）。

## 用户需求

「把 `read_image` 默认启用关掉，对 IM 模式的默认预设启用 `read_image`，同时检查 IM 模式怎么处理用户远程 IM 输入的图片。」

## 两条通路的差别（决定这次挂在哪里）

| 会话 | 图片怎么进上下文 | 需要 `read_image` 吗 |
|---|---|---|
| `agent-tavern`（默认 Agent 模式，宿主 composer） | 用户消息里的原生 `image` block；提交时按 `llm.resolveModelInfo(provider, model).inputModalities` 门控，非视觉模型直接 `session/attachment-invalid`（reason `MODEL_DOES_NOT_SUPPORT_IMAGES`） | **不需要** |
| `agent-tavern-im`（IM 默认预设） | `im/session-host.ts` 的 `buildImInboxMessage` 固定 `content: [{ type: 'text', text }]`——**只有文本**，图片最多是正文里一行 `图片（<本地路径>）` | **需要**，否则模型永远看不见图 |

所以默认 Agent 模式的 `tool-fs` 行撤掉：它只会给一个已经有原生图片通路的会话凭空加文件工具。

## IM 入站图片的实际处理（本次核查结论）

| 环节 | 行为 | 位置 |
|---|---|---|
| 解析 | 平台事件 → `ImMediaRef{kind:'image', url, localPath?}`；正文里插一行可读标记 | `im/onebot/codec.ts`、`im/qq/inbound-media.ts`、`im/weixin/media.ts` |
| 下载时机 | **只在对端通过访问控制且已绑定会话之后**调用 `loadMedia`；未绑定的陌生人不会引发下载/解密/写盘 | `im/router.ts` `DeliverableInbound` |
| QQ | `fetchInboundMedia`：GET CDN 直链，先看 `content-length` 再复核实际字节，单文件上限 20 MiB，超限不落盘 | `im/qq/channel.ts`、`im/media-fetch.ts` |
| 微信 | 自带 CDN + AES：`aeskey`（hex）或 `media.aes_key`（base64）解密后落盘，上限同为 20 MiB | `im/weixin/media.ts` |
| OneBot | `loadMedia` → `fetchInboundMedia`：只抓 http(s) `url`（2026-11-11 补齐，此前只生成 ref）；`base64://`、上游缓存名与 file id 仍只留引用 | `im/onebot/server.ts` |
| 落盘 | `<内部工作区>/im-media/<channel>-<accountId>/<uuid>.<ext>`，文件名由插件生成（平台给的名字只作诊断），mode `0600`，扩展名过白名单 | `im/media-store.ts` |
| 上下文 | 正文摘要每消息最多 6 条附件，路径写进正文；下载失败只 warn，消息照常投递（ref 保留 url，摘要写「未下载」） | `im/relay.ts` |
| 生命周期 | 通道启动按 TTL 清扫；账号解绑即删该账号媒体目录 | `im/media-store.ts`、`im/runtime.ts` |

结论：只有 QQ 与微信的图片会真正落到本地并给出路径；OneBot 的图片在 IM 默认预设下不可用（这是通道能力缺口，不在本次变更内）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/cordis.patch.yml`（`preset-agent-tavern` 撤行、`preset-agent-tavern-im` 加行）、`packages/plugin/src/im/agent.ts`（附件指引）、`packages/plugin/tests/agent-tavern-image-preset.spec.ts`、`README.md` |
| 唯一事实来源 | 两个 preset 的 plugins 列表；图片能力判定归宿主 `inputModalities`，插件不自建白名单 |
| 持久态 | 无插件状态。读入的图片由宿主 attachment store（`DSH_HOME/attachments/v1`）持久化，`read_image` 输出 `attachmentId`，重放会话按 id 复原 |
| 临时态 | `im-media` 下载件是一次性的（TTL 清扫 / 解绑即删）；`read_image` 会在附件库里留一份归一化副本，生命周期归宿主 |
| 外部依赖 | `@deepseek-ai/dsh-tool-fs` 0.2.2 线的 `Config.readImage` 与 `assertImageCapableRoute`；`ctx.fs`（base 的 `dsh-fs-sandbox`）、`attachments`（base 的 `attachment-local`） |
| 注册入口 | 会话激活时按 preset id 展开；`read_image` 只在 `attachments` 服务挂载时注册 |
| 删除路径 | 删 `preset-agent-tavern-im` 的 `tool-fs` 行即回到「IM 只有 Tavern 工具」；无状态、无迁移 |
| 兼容对象 | `agent-tavern` 工具面回到 25 件（+4 件 `im_*`）；`agent-tavern-im-native` 与 `card-workbench` 早就有 `tool-fs`（默认 `readImage: true`），行为不变；非视觉模型调用被明确拒绝 |

## 决策

- **默认 Agent 模式不挂 `tool-fs`**：它已经有宿主 composer 的原生图片通路，加工具等于多一套文件面却换不来能力。
- **IM 默认预设只开 `readImage`**：与宿主 `minimal` preset 同款行（`read:false / readImage:true / write:false / edit:false`）。IM 会话原先零宿主工具，这次只增加一件只读工具，写面、文本读面与 shell 都不进。
- **不改 `agent-tavern-im-native`**：它按标准 preset 挂整行 `tool-fs`，`readImage` 默认开启，本次对齐后行为不变。
- **IM 提示词改成说实话**：原文写「入站消息里的本地路径可以直接读取」，实际只有图片能读，语音/视频/文件/压缩包仍只有路径；改成明确写出 `read_image` 及其格式，并要求对读不了的附件如实说明，不把路径当成已读内容。
- **OneBot 补上 `loadMedia`**：与 QQ 同款接缝（`router.handle(inbound, { loadMedia })`），只下载 `image` 且只认 http(s) `url`，上限 20 MiB、超时 20s、失败只 warn。非图片种类不落盘：本构建里没有读取方，写盘只是垃圾；`base64://` 与 file id 也不臆造下载逻辑（需要上游 API 才能取件）。媒体仓库缺省时通道行为与修复前完全一致。

## 变更面

| 所有者 | 内容 |
|---|---|
| `packages/plugin/cordis.patch.yml` | `preset-agent-tavern` 撤回 `tool-fs`；`preset-agent-tavern-im` 增加 `readImage` only 的 `tool-fs` |
| `packages/plugin/src/im/agent.ts` | 附件段：图片用 `read_image`；其余附件如实说明读不到 |
| `packages/plugin/src/im/onebot/server.ts` | 通道新增 `media?` 选项与 `loadMedia` 接缝：http(s) 图片经 `fetchInboundMedia` 落盘，失败只 warn |
| `packages/plugin/src/im/runtime.ts` | `openOneBot` 传入与 QQ/微信共用的 `mediaStore`；sink 转发 `loadMedia` |
| `packages/plugin/tests/agent-tavern-image-preset.spec.ts` | 锁「默认预设不挂 `dsh-tool-fs`」+「IM 预设挂 `readImage: true` 且读写全关」 |
| `packages/plugin/tests/onebot-inbound-media.spec.ts` | 真 HTTP 桩：图片落到媒体仓库并可读回字节；`base64://` 与非图片种类保持引用不变 |
| `README.md` | 「图片输入两条路」取代原先的默认预设图片段 |

## 验证

- `vitest run packages/plugin/tests/agent-tavern-image-preset.spec.ts packages/plugin/tests/im-agent-preset.spec.ts packages/plugin/tests/onebot-inbound-media.spec.ts`
- `pnpm run check`：tsc + 全量 vitest + build（`im-agent.mjs` 带新提示词）+ 21 gates（`preset-host-rows` 覆盖新增行）。
- 环境备注：本机 32 线程并行跑 vitest 会在 worker 层 `ERR_IPC_CHANNEL_CLOSED` 崩溃；`--no-file-parallelism` 串行跑同一套用例全绿（205 files / 3367 passed / 2 skipped）。

## 已知边界

- **OneBot 的 `base64://` 与纯 file id 仍未下载**：只接 http(s) `url`；`base64://` 需要解码分支、file id 需要上游 `get_image` API，两者都没有稳定跨实现口径，本次不臆造。
- **`bmp` 不被 `read_image` 接受**：媒体白名单允许 `bmp` 落盘，但宿主只认 PNG/JPEG/WebP/GIF；这类图片会得到明确拒绝。
- **`read_image` 的读面是任意可 stat 的路径**（`dsh-fs-sandbox` 对读放行）：IM 对端无法指定路径（路径由插件生成），但模型若被诱导仍可读工作区外的图片。写面为零。
- **附件摘要上限 6 条 / 单文件 20 MiB**：超出部分不进正文，模型看不到。
- **面板 composer 仍无聊天附件**：默认 Agent 模式靠宿主 composer 发图；ST 会话由插件 composer 接管（`form: 'notice'` marker 只在 `architecture === 'st'` 写），那条路只有纯文本。
