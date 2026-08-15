# 决策：Tavern 管理面板的入口选型与落地形态

日期：2026-08-15。状态：已接受。设计来源：`docs/proposals/0003-tavern-management-panel.md`。

## 1. 入口走 `sidebar.footer.action` + `shell.overlay`，弃 DOM 爬取

侧边栏集成的官方扩展点是 `sidebar.footer.action`（list slot，宿主语义即
"Settings 旁边的可选动作"，官方占用者 CordisPanel 同在此）与 `shell.overlay`
（frame 级浮层）。面板容器用 `@deepseek-ai/dsh-client-ui-primitives` 的
`Modal`（headless）：它 portal 到 `document.body` 并自带遮罩/Escape/aria-modal，
完全脱离 overlay 层的 `pointer-events:none`——提案 Bar Raiser #1 的叠层风险
实测不成立。原 `useSidebarHost` 的 MutationObserver + 几何启发式爬取、
`[data-dsh-tavern-sidebar-host]` 注入与 `dt-floating-shell` 浮动壳全部删除；
`sidebar.footer.action` 从"挂载失败回落"转正为常驻主入口（wide=图标+文字，
rail=圆钮+Tooltip）。`bindings/prune` 副作用随 PanelHost 保留在 shell.overlay。

## 2. 删除角色连同聊天记录，并做三处级联

`store.deleteCharacter` 扩展为同时移除 `chats/<name>/`（对齐 ST 删角色连聊天
的语义；store 测试覆盖）。HTTP 层 `DELETE character` 级联：清 activeCharacter
（命中时）、prune 该角色的 solo 会话绑定（`group: true` 的群组绑定按组名寻址，
与同名角色互不影响，保留）、从各群组 members/disabledMembers 收敛，最后
`refreshActivePrompt()`。`DELETE preset` 同理清理 activePreset 与
textCompletion 三处模板引用；`DELETE world` 从 activeWorlds 移除。

## 3. 新路由与 gates 扩面

`GET character/<name>`（卡查看器）、`GET export/character/<name>`（PNG/charx/JSON
按 kind 定 content-type + attachment）、`GET world/<name>`（条目浏览器）、
`GET/PUT variables`（scriptGlobals 读写，值限 string/number/boolean）。
`REQUIRED_SERVER_ROUTES` 与 `client-vm-mount` 的 requiredSlots 同步扩面
（shell.overlay 与 sidebar.footer.action 的占用 id 统一为 `dsh-tavern-panel`）。

## 4. 变量编辑的数值收敛

面板全局变量编辑器把形如 `-12`/`3.14` 的输入收敛为 number，其余保持 string；
聊天局部变量只读展示（经既有 chat 快照的 `chat_metadata.variables`），写路径
仍归 STscript `{{setvar}}`。

## 5. 设置页瘦身为快速切换 + 面板跳板

`settings.section` 只保留 Active setup（角色/预设/persona/nativePersona + 世界书
开关，抽取为 `ActiveSetupBand` 与面板总览共享）和「打开酒馆面板」按钮。重管理
（导入、persona/群组/regex/生成迁移、卡查看、世界书条目、预设、变量）全部进
面板十分区区。面板视觉全部走 `--dsw-alias-*` token 与官方原语
（Button/Input/Pill/StateDot/Tooltip/MarkdownText），未新造颜色。
