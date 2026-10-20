# 美化前端的 AgentTavern 展示面：DSH 原生右侧栏

> 日期：2026-10-20。来源：用户需求「AgentTavern 模式下，利用原生右侧侧边栏
> 实现对酒馆美化前端的支持」。落点：`packages/plugin/client-src/88-ui-frontend.js`、
> `packages/plugin/src/frontend-documents.ts`、`packages/plugin/src/http/router.ts`、
> `packages/plugin/client-src/98-apply.js`、`86-ui-composer.js`、`95-ui-styles.js`、
> `40/41-i18n-*.js`、gates 与测试。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | client 右栏 tab 与面板（`TavernFrontendPanel` / `TavernFrontendSidebarTab`）；server 抽取与轮询端点（`src/frontend-documents.ts` + `GET frontend/latest`） |
| 唯一事实来源 | 聊天文件本身（Tavern store 的 `chats/<character>/<chatId>.jsonl`）；展示层文本仍由 `displayTexts`（markdownOnly regex 脚本）提供，与内联 transcript 同源 |
| 持久态 | 无新增持久态——面板是只读快照，"第几楼"来自当前聊天消息下标 |
| 临时态 | 面板的 `snapshot` / `error` 与 5s 可见性轮询，随 tab 挂载生灭 |
| 外部依赖 | 无新增依赖；复用 `FrontendFrame` 的 iframe 纪律（sandbox 无 same-origin、CSP、token 高度回传） |
| 注册入口 | `ctx.inject(['sidebarRightTabs','sidebarRight'])` 内的 tab 类型（`kind: tavern-frontend`）与 `sidebar.right.pane.tab` keyed slot body；AgentTavern 标题栏按钮（服务在场才渲染） |
| 删除路径 | 删 `88-ui-frontend.js` 与 manifest 条目、`src/frontend-documents.ts`、route 分支、apply 两处注册、标题栏按钮、i18n 键、CSS、gates marker/自测、两个 spec 与本决策；服务端 helper 无其他调用方 |
| 兼容对象 | ST 架构保持内联渲染（右栏只给说明空态，不重复执行脚本）；旧宿主没有 `sidebarRight` 服务时按钮不渲染、tab 不注册，插件其余表面不变 |

## 1. 问题

美化前端（消息内完整 HTML/JS，README「美化前端」一节）在 ST 架构由
`TavernView` 的消息正文内联到 `FrontendFrame`。AgentTavern 架构的 conversation
是宿主原生表面，插件没有可插入消息正文的 slot：同样的 HTML 会以源码文本出现，
美化 UI 完全不可用。MVU 状态卡与游戏对局面已经用 DSH 原生右侧栏
（`sidebarRightTabs` + `sidebar.right.pane.tab`）解决同类问题，这里沿用同一条通道。

## 2. 方案

1. **右栏 tab**：`dsh-soulmojito/frontend` / `kind: tavern-frontend`，guide 入口与
   MVU、游戏并列；body 是 keyed slot，`sessionId` 由 inject 回调显式传入。
2. **只展示最新一条**：从聊天末尾向前扫，第一条带完整 HTML 文档的楼层胜出。美化
   前端通常是随回合重发的状态 HUD；侧栏常驻保留最新快照，旧楼层不重复执行脚本，
   也不给用户一堆并行 iframe。标题行显示「第 N 楼」。
3. **服务端抽取**：`GET /api/dsh-soulmojito/frontend/latest?character=&chatId=`
   只回 `{revision, messageCount, message}`，`message` 含楼层下标、发言人、
   documents。面板 5s 轮询（页面不可见停发，与 MVU 侧栏同一条可见性纪律）——
   回传整份聊天在长篇聊天上会是 MB 级，不能走现有 `GET chat/:id`。
4. **判定同构**：客户端内联渲染器（`10-frontend-frame.js`）与服务端
   `frontend-documents.ts` 使用同一组谓词（doctype / `<html>`+head|body / 裸
   head|body；markdown fence 优先）。client half 是拼接 IIFE 无法 import，双份
   与 FRONTEND_CSP、vh 改写同款纪律，由 gates marker 与测试锚定。
5. **ST 不重复执行**：ST 架构已在消息里内联渲染，右栏面板只显示说明空态；小说 /
   写卡工作台会话没有可读的聊天前端，同样给空态。

## 3. 入口与降级

- AgentTavern 标题栏新增「美化前端」按钮，与 MVU / 游戏入口同位；仅在
  `sidebarRight.openTab` 在场时渲染——旧宿主没有可承载表面，死按钮比没有按钮更糟。
- 右栏「+」guide 是稳定入口；tab 打开后随聊天更新，用户关闭后不抢焦点
  （不实现自动展开：美化前端是常驻 UI，不是像对局开始那样的单次事件）。

## 4. 否决项

- **每楼都挂一个 iframe / 楼层历史选择器**：并行执行多份脚本、侧栏变成长列表，
  收益仅是回看旧 UI；v1 不做。
- **轮询 `GET chat/:id` 取整份聊天**：5s 一次的整聊天 JSON 传输与客户端 store
  更新会拖垮长篇聊天，且会触发无关组件重渲染。服务端抽取是必要开销。
- **渲染进宿主 native conversation**：插件没有该 slot；DOM 注入宿主的消息树是
  版本敏感且会与宿主渲染循环冲突，不做。
- **自动展开 tab**：与游戏的「开局即展开」不同，美化前端随每条消息出现；自动
  抢焦点会打断写作。标题栏按钮 + guide 已足够可发现。

## 5. 兼容与边界

- 只读：面板不写聊天、不改 revision；swipe 切换或楼中编辑后，下一拍轮询自然更新。
- 沙箱纪律不变：`sandbox="allow-scripts"` 无 same-origin、CSP 禁止网络与嵌套
  frame、高度回传 token + `event.source` 双校验。
- `frontend/latest` 对无效 chatId（不符合 store 文件名规则）沿用 store 的
  `invalid chat id` 500；聊天不存在返回 404；没有可展示文档时省略 `message`。
- `displayTexts` 只对命中楼层的展示文本生效（markdownOnly 脚本），不扩大成
  全套 ST 渲染管线。

## 6. gates 与测试

- `frontend-surface` gate：面板/注册/端点/空态/入口/CSS marker，含自测负样本。
- `client-vm-mount` 的 sidebar mock 断言：apply 必须在 VM 里真实注册
  `tavern-frontend` 类型与 keyed body。
- `frontend-documents.spec.ts`：判定与「最新一条」扫描（fence 优先、裸文档、
  系统消息跳过、display 回调）。
- `frontend-route.spec.ts`：真实 store + 真实 HTTP 面（最新楼层、无文档、404、
  缺 chatId），并断言响应不带整份 `chat`。
- `frontend-client.spec.ts`：client 生成源的注册链路、标题栏入口、ST 空态与
  zh/en 键镜像。
