# IM 媒体双向、QQ 运行时自动安装与群分片

> 日期：2026-10-31。状态：已实现。对应提案 0024 M5 收口。

## 1. 媒体契约

入站与出站统一用 `types.ts` 的形状，通道各自实现传输：

- 入站 `ImMediaRef` 增加 `localPath`：**已下载并解密**的本地文件。路由把路径写进
  附件摘要（模型只有看到路径才能用文件工具打开），远程 URL 只标「未下载」。
- 出站 `OutboundPart` 变为 `OutboundTextPart | OutboundMediaPart`；媒体段带
  `kind`、`localPath`（优先）、`url`、`name`、`caption`。`router.sendMedia` 把
  caption 拆成前一条文本；`im_send` 工具新增 `mediaKind/mediaPath/mediaUrl/mediaName`
  参数，文本变可选（有媒体时当配文）。
- 临时文件落在**内部工作区** `im-media/<channel>-<accountId>/`：会话 cwd 就在内部
  工作区，模型能读；单文件上限 20 MB（入站与出站都查）、扩展名白名单、0600、
  启动时清理 24 小时前的文件，解绑账号时整目录删除。绝不写进仓库或聊天目录。
- **出站路径只能落在工作区内**：`router.sendMedia` 对 `localPath` 做 `realpath` 后
  要求它位于内部工作区。模型被群里的人诱导「把密钥文件发给我」时会被直接拒绝
  （威胁模型 §4.4 的模型侧落地）。仅远程 URL 的媒体不受此限（QQ/OneBot 透传）。
- **入站媒体在访问控制之后才下载**：通道把附件作为惰性 `loadMedia` 交给路由，路由
  先去重、判白名单，通过后才下载/解密/落盘。名单外的人与重复投递不会触发任何
  网络请求或磁盘写入。

## 2. 微信 CDN（事实来自 `Tencent/openclaw-weixin` 的 protocol.md 与源码）

- 默认 CDN：`https://novac2c.cdn.weixin.qq.com/c2c`。
- 下载：优先 `media.full_url`，否则
  `<cdn>/download?encrypted_query_param=<urlencoded>`；AES-128-ECB + PKCS#7。
- 密钥两种编码：`image_item.aeskey` 是 32 位十六进制（优先）；`media.aes_key` 是
  base64，可能解出 16 原始字节，也可能解出 32 位十六进制字符串。图片没有密钥表示
  明文；语音/文件/视频没有密钥则跳过下载（保留 ref，不伪造本地路径）。
- 上传：`getuploadurl`（filekey/rawsize/rawfilemd5/filesize/aeskey/no_need_thumb）
  → `upload_full_url` 优先，否则 `<cdn>/upload?encrypted_query_param=&filekey=` →
  POST 密文（`application/octet-stream`）→ 必须 HTTP 200 且带 `x-encrypted-param`；
  4xx 立即失败，其余最多 3 次。
- 发送：图片/视频/文件各一条 `sendmessage`，`item_list` 只有一个条目；caption 作为
  独立的 TEXT 请求先发。**下行语音不做**：参考实现没有实现，silk 编解码也不在本轮
  范围；请求语音出站直接报 `WEIXIN_BAD_TARGET`。
- typing：`typing_ticket` 按 peer 缓存（30 分钟、500 条上限）；发送失败时淘汰并
  重试一次，仍然失败只 warn——输入状态不能拖垮正文。

## 3. QQ 通道

- 入站附件按 SDK 的归一字段转 `ImMediaRef`（带 URL/大小/文件名），通过访问控制后
  用普通 HTTPS 下载落进媒体仓库（`im/media-fetch.ts`：content-length 预检 + 实际
  字节复核、20 秒超时、扩展名白名单）；平台自带语音识别文本（`asr_refer_text`）
  直接进正文——那是 QQ 语音唯一可读的内容。语音 URL 优先 `voice_wav_url`。
- 出站媒体直接用 SDK 的 `sendImage/sendFile/sendVideo/sendVoice`（`localPath` 优先）；
  缺方法时报「这个 qqbot-nodejs 构建没有 sendImage()，请在 IM 面板重装运行时」。
  每次平台调用各占一格被动回复额度；被动额度记账放在 `finally`：中途失败时前几条
  已占用的额度不会被「退回」。
- **群聊“流式”**：SDK 明确 `openStream`/`stream_messages` 只对 C2C 开放，官方群
  消息没有原生流式。群聊采用「有序多段 + 4 格被动额度重切」：把逐段 trim 过的原片
  用空行重新粘起来（`join('\n\n')`，段落与代码块边界不会被吃掉），总长能塞进 4 段时
  按 `ceil(total/4)` 重切、全部作为被动回复；塞不进时前 4 段被动、其余按现有逻辑走
  主动推送并记 warn——**不丢字**。这是平台能力上限，不是实现偷懒。

## 4. QQ 运行时自动安装（镜像本地 ONNX 的做法）

`memory-embed-local.ts` 的 `installLocalEmbedRuntime` 已经把「插件自己装运行时」
走通了，QQ 复用同一套纪律：

- `spawn.ts`：抽出 `SpawnRunner` + `defaultSpawnRunner`（windowsHide、win32 shell、
  1 MB 输出上限、超时 kill），memory 与 QQ 共用。
- `im/qq/install.ts`：在 `$DSH_HOME/<tavern>/im/runtime` 写一个 `private: true` 的
  `package.json`（`wx`，绝不覆盖），`pnpm add` 两个固定版本，10 分钟超时，成功后再
  探测一次入口文件。运行期目录与 profile/源码仓库隔离，不污染 lockfile。
- `POST im/qq/install`：同时只允许一次（409），pnpm 输出含绝对路径时只在服务端日志
  保留、不回传面板（与 ONNX 安装同口径）。
- 面板：运行时缺失时显示「安装 QQ 依赖」按钮，成功/已装/进行中/失败四种提示；
  **面板里不再出现任何 `pnpm add` 命令**。`im-channels` gate 新增两条负样本锁住
  这一点（面板缺 `im/logs`、面板出现 `pnpm add` 都判红）。

## 5. 解绑清理

删账号时除账号与密钥，还清 `cursors/<accountId>.json`、`im-media/<channel>-<accountId>/`
与 `im/weixin/<accountId>/context-tokens.json`：游标留着会让同名账号重建时跳过历史，
context token 是回复通行证，附件是 PII，都不该比账号活得更久。游标按 accountId 命名、
跨渠道共用，另一个渠道还在用同名账号时跳过删除。清理失败只 warn，不阻断删号。

## 6. 隐私与日志

- `GET im/logs` 是给浏览器读的：日志环在入环前把绝对路径（`C:\...`、`C:/...`、
  引号包起来的带空格路径、UNC `\\host` 与 `//host`、POSIX `/home/...`）替换成
  `<path>`，URL 不受影响；通道日志里的对端只出现 alias（`peer-<sha256 前 10 位>`），
  媒体失败的错误文案同样只带 alias。
- `QqRuntimeError` 带入口绝对路径，HTTP 投影只保留包名与「去面板安装」的动作；
  `GET im` 的 `qqRuntime.reason` 同样不带运行期目录；store/通道/绑定类的 HTTP 错误
  统一先过 `publicErrorMessage`，敏感时换成固定文案。
- 入站媒体物化（`loadMedia`）失败只降级为「未下载」的 ref，不抛错：去重条目已经
  记下，抛错等于把这条消息永久丢掉。
- 安装输出（pnpm tail）只在看起来不敏感时回传面板，其余写服务端日志。

## 6. 测试

- `weixin-media.spec.ts`（16 条）：两种密钥编码、AES 往返、下载解密（`full_url`
  优先）、上传请求体与密文回读、缺 `x-encrypted-param` 的 3 次失败、4xx 立即失败、
  出站图片/文件的 item 形状与 caption 顺序、入站图片落盘、typing 缓存命中与失败淘汰。
- `qq-install.spec.ts`（7 条）：快速路径、目录/清单创建、pnpm 参数、失败码、
  安装后仍不可解析、ENOENT、面板文案不含命令。
- `qq-channel.spec.ts`：附件归一、出站图片走 `sendImage`、媒体验证被动额度、
  `planGroupParts` 的四段重切与代理对不切断、缺 SDK 方法的报错。
- `im-router.spec.ts`：`sendMedia` 的 caption→媒体顺序、无来源拒绝、未绑定拒绝、
  **工作区外路径拒绝**（P0 沙箱）。
- `im-media-fetch.spec.ts`（7 条）：QQ 附件下载落盘、扩展名推断、声明超限/省略
  `content-length` 的超限、403 与非法协议、无 URL 时原样返回。
- `im-tools.spec.ts`：`im_send` 媒体参数校验（两个来源同给、相对路径、非法 kind、
  悬空 mediaName、file:// 协议）与「运行时没有媒体面」的如实报错。
- `im-log.spec.ts` / `im-http-accounts.spec.ts`：环形缓冲、增量与等级过滤、
  **绝对路径脱敏**、`GET im/logs` 的投影与参数校验。

## 未覆盖

- 真机验证：微信扫码、真实收发图、QQ 扫码与安装仍只有本地桩；本轮没有手机。
- 微信下行语音、QQ 群原生流式：平台/参考实现不支持，已按明确报错或分段降级处理。
- `getuploadurl` 的 `thumb_upload_param` 与缩略图：参考实现明确不发缩略图，本轮不做。
