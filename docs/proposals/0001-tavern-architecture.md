# 提案 0001：dsh-tavern 原生角色扮演层

> 状态：第一版已实现并验证。日期：2026-08-14。

## 1. 目标

dsh-tavern 让 DSH 用户直接使用 SillyTavern 的角色扮演资产和交互语义，同时继续复用 DSH 的模型路由、密钥管理、Web 容器和插件分发。

目标不是在 DSH 设置页里嵌入另一个聊天应用，而是让 Tavern 角色和聊天进入原生侧边栏，让 transcript、composer、swipe、编辑和 regenerate 进入原生 conversation 区域。设置页只保留资产和行为配置。

## 2. 核心边界

DSH 的 agentic 工具循环和 SillyTavern 的纯 RP 循环用途不同。第一版采用以下分工：

- Tavern Node half 自建 RP 循环：世界书扫描、宏展开、preset prompt 装配、`ctx.llm.stream`、JSONL 保存。
- DSH 提供模型选择、provider 路由、密钥、session 容器、Web server 和插件生命周期。
- Tavern client half 使用 DSH 正式 slots 进入原生 UI，不把完整工作台放在设置页。
- Fabric 不进入第一版运行路径；只有正式插件层无法实现未来需求时才考虑。

这种结构既保持 ST prompt 和 swipe 语义，也不要求修改 DSH 宿主。

## 3. 原生 UI 集成

### 3.1 正式 slots

| Slot | Kind | Tavern 用途 |
|---|---|---|
| `settings.section` | list | 角色、世界书、preset、persona、导入、普通 Agent 人格开关 |
| `conversation.view` | list | Tavern JSONL transcript tab |
| `conversation.composer` | chain | 仅接管有效 Tavern session 的 RP composer |
| `conversation.session.header.actions` | list | 当前角色和 regenerate |
| `shell.overlay` | list | sidebar adapter 生命周期与折叠后的浮动分支 |
| `sidebar.footer.action` | list | sidebar adapter 失败或原生侧栏折叠时的 fallback |

`conversation.composer` selector 只读取 owner session 的 conversation marker，保持 DSH chain 要求的纯函数语义。普通 DSH session 继续使用原生 composer。

### 3.2 Session binding

每个 Tavern chat 与一个 DSH session 绑定，映射保存在：

```text
$DSH_HOME/tavern/state.json -> sessionBindings
```

打开新 Tavern chat 时：

1. 连接当前 workspace 的 blank DSH session。
2. 调用内部 `/tavern <base64url-json>` command。
3. Node half 校验 chat 并原子保存 binding。
4. 向 session 追加 `plugin:dsh-tavern` 的 `user/message` notice marker。
5. marker 让 blank session 进入 active 状态，但不触发模型调用。
6. client 重命名并打开 DSH session，然后切到 `Tavern` tab。

删除 chat 时，client 调用 close action，Node half追加 `tavernState: closed` marker 并移除 binding，随后 client 归档对应 DSH session。即使该 session 将来恢复，composer selector 也不会再次接管。

### 3.3 侧边栏 adapter

DSH `0.1.0-rc.6` 的 `sidebar.workspaces` 是完整 single/root 接管点，没有可追加到原生 session tree 的 list slot。重写整个 workspace/session browser 的维护成本不合理，因此第一版采用集中式 DOM adapter：

- 由 `shell.overlay` 提供生命周期锚点。
- 只寻找可见、位于左侧、尺寸合理的 `[role="tree"]`。
- 在原生 tree 前插入 `data-dsh-tavern-sidebar-host`，通过 React portal 渲染。
- `MutationObserver` 与 resize 只负责重新匹配，使用 animation frame 合并。
- teardown 时断开 observer、取消 frame、删除 host。
- 不依赖 DSH CSS module hash，不隐藏原生 session tree。
- 匹配失败时保持原生 UI，并由 `sidebar.footer.action` 提供浮动 Tavern 导航。

该 adapter 是明确的版本敏感边界；DSH 升级验收必须覆盖它。

## 4. RP 数据流

```text
Tavern composer
  -> POST /api/dsh-tavern/generate
  -> load Character Card + preset + persona + World Info + chat JSONL
  -> activate lore
  -> expand macros
  -> assemble prompt/messages
  -> ctx.llm.stream(default provider/model)
  -> NDJSON start/delta/reasoning/saved
  -> atomic JSONL save
  -> client replaces optimistic/streaming state
```

Send 会先持久化用户消息，因此 Stop 或 provider 失败不会丢用户输入。Regenerate 会移除最后一个 assistant message 参与 prompt，然后把新结果追加到原有 `swipes[]`，更新 `swipe_id` 和 `swipe_info`。

## 5. 并发与状态一致性

聊天读 API 返回内容哈希 revision。以下写操作都要求客户端提交它看到的 revision：

- 消息编辑。
- swipe 指针变更。
- send/regenerate。
- chat rename。
- chat delete。

存储层在进程内串行执行 compare-and-swap。revision 不一致时返回 `409 CHAT_REVISION_CONFLICT`；客户端强制重载最新 chat 并显示冲突，不使用 last-write-wins。

`state.json` 的 read-modify-write 同样串行，避免并发创建 session 时丢失其他 binding。client 在 DSH session list 进入 `ready` 后调用 `bindings/prune`，清除宿主已删除 session 的陈旧映射。

切换 Tavern 角色会同步刷新可选的普通 Agent 人格 prompt。该能力默认关闭，避免 RP 配置影响普通 DSH 会话。

## 6. 互操作核心

| Package | 职责 |
|---|---|
| `tavern-format` | Character Card V1/V2/V3、PNG `chara`/`ccv3`、CHARX、World Info、preset、ST chat JSONL |
| `tavern-lore` | 递归扫描、副键逻辑、概率、预算、分组、sticky/cooldown/delay、位置分发 |
| `tavern-macros` | 名称、卡字段、时间、random/pick/roll、变量宏和扩展注册 |
| `tavern-pipeline` | prompt order、marker、历史、lore、persona、depth injection 和 token budget |
| `tavern-store` | `$DSH_HOME/tavern/` 原子存储、revision、session binding |

角色 PNG 原字节保存以保留图片和兼容 chunks。未知规范字段进入 raw/extension 透传袋，避免导入导出丢失社区资产数据。

## 7. 插件分发

Node half 和五个纯库由 esbuild 打成单一 `packages/plugin/index.mjs`。运行时不从用户项目解析 `@deepseek-ai/*` 公共包；client closure 由 DSH profile 按 bundle 元数据注入。

安装：

```sh
pnpm run build:plugin
dsh plugin --profile web add ./packages/plugin
```

六道 gate 校验 package contract、patch reference、server bundle、client bundle、client VM mount 和 Node half mount。gate 还拒绝把 transcript/generation 放回设置页、重新启用 composer overlay、移除 revision 或 stale-binding 保护。

## 8. 已验证范围

- 10 个测试文件、77 项测试。
- 真实 ExampleCard PNG、ExampleWorld World Info、Default Chat Completion preset。
- 默认 DSH provider/model 的真实流式生成。
- send、Stop、edit、swipe、regenerate、rename、delete、session archive。
- 跨标签页 revision 冲突。
- 桌面原生 sidebar 与折叠 fallback。
- 390x844 conversation、composer、浮动 Tavern 导航和移动设置页。
- 最终浏览器控制台零错误。

## 9. 后备路线

Fabric 仍适用于必须修改宿主内部请求组装、完整替换 workspace/session browser 或注入正式 slots 之外行为的未来需求。但它需要源码宿主和版本门控，维护成本显著高于 bundle 插件。当前正式 slots 与受控 sidebar adapter 已覆盖第一版目标，因此不引入 Fabric。

## 10. 许可边界

项目采用 GPL-3.0，只实现 character-card 公开规范、SillyTavern 公开格式和可观察行为语义，不复制 SillyTavern AGPL 源码。Fabric 和 dsh-ads 仅作为架构参考，运行时不依赖它们。
