# 决策：Tavern 消息中的 HTML/JS 前端使用隔离 iframe 运行

日期：2026-08-16 · 状态：已实施

## 背景

酒馆生态中的美化前端通常以完整 HTML 文档（常见于 `html` 代码块）随助手消息返回，
并依赖内联 CSS/JavaScript 生成可交互界面。原有 transcript 只按纯文本显示消息，
因此这类内容无法运行。

## 决策

1. client half 在消息渲染期识别完整 HTML 文档或代码块中的完整 HTML；普通代码块、
   不完整文档和流式中的半成品保持文本显示。
2. 每个识别出的文档使用 `iframe[srcDoc]` 挂载，并设置 `sandbox="allow-scripts"`。
   不授予 `allow-same-origin`，消息脚本无法读取宿主 DOM、Cookie 或 DSH API。
3. iframe 文档注入首要 CSP：只允许内联脚本/样式、固定静态 CDN、图片/字体和媒体；
   禁止网络连接、表单提交、对象和嵌套 frame。脚本通过 `postMessage` 回传内容高度，
   父页面仅接受带 token 且来自对应 iframe 的消息。
4. 高度限制在 80-1200px，超出部分由 iframe 自身滚动；消息保存后才执行前端，避免
   流式 token 造成反复重载和重复副作用。

## 后果

- 支持大多数自包含的 Tavern 美化卡片和常见 CDN 组件，不需要改动 Node half 或聊天
  文件格式。
- 依赖宿主 API、跨域 `fetch`、嵌套 iframe 或需要访问父页面的旧脚本不会工作；这是隔离
  约束，而不是静默放宽权限。
- 运行时逻辑位于 Web client；TUI/headless 仍显示原始消息文本。
