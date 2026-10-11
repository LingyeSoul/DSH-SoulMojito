# iframe 视口正确性 + 高度上报健壮性（A-4）

> 日期：2026-10-11。来源：[JSR/LWB 竞品参考](../docs/exploration/2026-10-11-jsr-lwb-reference.md)
> §2.1/§4 A-4 的建议（JSR 为 PolyForm NonCommercial——只复刻可观察语义，全部重新
> 实现，零代码拷贝）。落点：`packages/plugin/client/main.js`、
> `packages/plugin/src/mods/http.ts`、`packages/plugin/scripts/gates/run.mjs`。
> 开发者文档：[mod-api.md §13](../docs/mods/mod-api.md)。

## 开工前八项表（CONTEXT.md 纪律；规则晚于本文落地，补记于 2026-10-11 审查修复）

| 项 | 答案 |
|---|---|
| 所有者 | client `packages/plugin/client/main.js`（buildFrontendDocument 改写、useViewportBridge、frontendHeightReporter）与 server `packages/plugin/src/mods/http.ts`（renderModHtmlDocument 改写、modViewportScript、modHeightReporterScript）；双份同步义务由 gates marker 锚定 |
| 唯一事实来源 | 改写规则与注入脚本文本就是两份源码本体（client half 是拼接 IIFE 无 import 通道，共享消重是否决项）；跨侧契约 = `--dt-viewport-height` CSS 变量与 `dsh-tavern:viewport` 消息 |
| 持久态 | 无——视口高度是运行时消息，不落任何 store/文件 |
| 临时态 | iframe 内 CSS 变量与宿主 resize 监听，随挂载生灭 |
| 外部依赖 | postMessage 单向下行 + ResizeObserver/rAF（浏览器标准面）；零 npm 新依赖 |
| 注册入口 | 两个注入点（client buildFrontendDocument / server renderModHtmlDocument，改写先于 CSP 注入）+ gates frontend-runtime 两个 marker |
| 删除路径 | 删两份改写/视口脚本/桥 + gates marker 与自测负样本 + tavern-mods-viewport.spec.ts + mod-api.md §13 条目 + 本决策；已分发前端里的 `var(--dt-viewport-height, 100vh)` 因 fallback 自然回退旧行为 |
| 兼容对象 | 非 100 系列 vh、`%` 布局、CSS 注释/字符串零触碰；mood-tracker 手写上报器共存（宿主 setHeight 钳制幂等）；上行高度消息 token+contentWindow 双对账纪律不变 |

## 1. 问题：100vh 的循环依赖

美化前端（`FrontendFrame`，srcDoc）与 Mod 面板（`ModSurface`，src 指向 `GET
mods/<id>/ui`）的 iframe 高度都由内容决定：iframe 内 reporter 上报
scrollHeight → 宿主 `setHeight(80..1200)` 调 iframe 高度。内容里写
`height:100vh` 时，vh = **当前 iframe 高度** = 上次内容高度——自引用循环，前端作者
预期"可视区高度"的满屏布局会塌（首帧 iframe 只有默认 120/140px）。

## 2. 方案（三件套）

1. **vh 改写**：宿主注入前把 100 系列视口高度单位改写成
   `var(--dt-viewport-height, 100vh)`——client 的 `buildFrontendDocument`（美化
   前端/MVU 渲染面共用）与 server 的 `renderModHtmlDocument`（mod HTML 出口）两个
   注入点都做，正则同构同款（该 client half 是独立拼接的 IIFE，无法与 src/ 共享
   模块——沿用 FRONTEND_CSP / MOD_HTML_DEFAULT_CSP 的双份纪律）。
2. **视口变量脚本**：注入小脚本（与 reporter 同机制）把宿主真实可视区高度挂到
   `documentElement.style` 的 `--dt-viewport-height`；监听 `dsh-tavern:viewport`
   postMessage `{height}` 更新。宿主侧 `useViewportBridge(frameRef)`（client）在
   iframe **load 时**（注入脚本在 head 解析期同步执行，load 事件时监听器必已就绪）
   与 **window resize 时**把 `window.innerHeight` 投进 `contentWindow`。
   FrontendFrame 与 ModSurface 都接。iframe 自身 innerHeight 只作初始化值（宿主
   load 投递即刻纠正）。
3. **高度上报健壮性**：client `frontendHeightReporter` 与 server 新增的
   `modHeightReporterScript`（注入所有 `reply.html` 出口，token 从 URL 查询段自读、
   无 token 静默跳过——与 console reporter 同纪律）都升级为：rAF 单帧合并（同帧
   ResizeObserver 连发只测一次）+ 高度去重（数值未变零消息）+ ResizeObserver 双观察
   （documentElement 与 body；head 期 body 未建，DOMContentLoaded 补挂）+ 保留
   load/resize 触发。**500ms 尾随重测兜底**：每次实际发出消息后排一次 +500ms 重测，
   覆盖字体晚到/图片解码/沙箱里观察器偶发漏报的收尾；无变化不发消息、无周期轮询
   （参数理由：RO 事件在下一帧内到达，500ms 足以跨过字体交换/图片解码的典型尾延，
   再长会让可见滞后变明显，再短退化为轮询）。

## 3. 改写边界（宁缺勿滥；漏掉的由 fallback `100vh` 兜底 = 旧行为）

- **只改 `100vh`/`100dvh`/`100svh`/`100lvh`**（含大小写，含 `calc(100vh - 24px)`
  组合形态）。非 100 数值（`50vh`/`33.3vh`）不改：改写它们需要
  `calc(var(...) * 0.5)` 乘法形态，语义变更面大，且作者可用 `%` 或显式 calc 表达。
- **只改 `<style>` 块与内联 `style="…"` 两形态**。`<script>` 块整体屏蔽（占位符
  换出再换回）：JS 字符串/模板里的 `style="…"` 与 `'100vh'` 不是 CSS，正则无解析器，
  动了就是改 JS 字面量。
- **CSS 注释（`/* … */`）与字符串字面量（`"…"`/`'…'`）里的出现原样保留**
  （`content:"100vh"` 是显示文本）。实现走小扫描器逐段跳过，不是全局裸替换。
- 标识符邻接不误伤：`2100vh`/`100vhx`/`--my-100vh` 均不匹配
  （lookbehind `(?<![-\w])` + lookahead `(?![\w-])`）。
- 改写在注入（CSP meta/脚本）**之前**做，注入产物不会二次触碰。

## 4. 安全判断：为什么 viewport 消息无 token 对账

消息方向是**宿主→iframe 单向下行**，与既有 `mod-response`/`mod-event` 同向，
不新增鉴权面。iframe 侧收到后只做一件事：把一个有限正数值 setProperty 到
`--dt-viewport-height`——不回传、不取数、不触发任何桥请求。伪造该消息的最坏影响
是扰动沙箱内自身布局（攻击者若能向 iframe postMessage，它能造成的损害本就不止
于此，且 iframe 内容本就是不可信的第三方/AI 产物）。与高度上报（上行）不同——
上行影响**宿主**状态（iframe 高度），所以上行必须 token + contentWindow 双对账
（既有纪律不变）。

## 5. 否决项

- **window.name 身份双保险：不做**。JSR 用它是因为其 iframe 与宿主同源依赖
  `frameElement` 直连，Firefox 移除 srcdoc iframe 后 `frameElement` 失联才需要
  name 兜底路由。本插件消息路由用 **token（per-mount 随机）+ `event.source ===
  frameRef.current.contentWindow` 事件源双校验**，不依赖 frameElement；且 sandboxed
  iframe 内脚本可自行改写 `window.name`，name 路由在沙箱模型下无安全增益。
- **Blob URL 调试模式（srcdoc 之外的可选加载模式）：留 backlog 不做**。JSR 用它
  方便 F12 里看源码。本插件 iframe 是 `sandbox="allow-scripts"` + CSP `default-src
  'none'`，Blob URL 需要新增设置面与加载分支，收益仅限开发者调试，优先级不足
  （backlog：若未来 mod 作者强烈需要调试体验，可与"开发模式"设置一起做）。
- **共享模块消重（client/server 两份改写代码合并）：不做**。client half 是拼接
  IIFE 无 import 能力，能共享的只有再引入一个构建期拼接通道，复杂度大于双份纪律
  （仓库已有 FRONTEND_CSP 双份先例）；两份由 gates marker + 本决策锚定同步义务。

## 6. gates 与测试

- `frontend-runtime` gate 新增 marker：`'--dt-viewport-height'`、`'dsh-tavern:viewport'`
  （client half 必须带视口改写与投递）。自测负样本真移除 marker：替换文本
  `'--dt-vh-gone'` / `'dsh-tavern:vp-gone'` 均不以原 marker 为前缀/子串（上一批
  mod-event-removed 前缀坑的对策）。
- `tavern-mods-viewport.spec.ts`（新）：server 侧 `rewriteViewportUnits` /
  `modViewportScript` / `modHeightReporterScript` / `renderModHtmlDocument` 集成
  断言（改写正/负样本、script 屏蔽、注释/字符串保留、reporter 升级点）。
- client 侧函数（`buildFrontendDocument` 改写、`useViewportBridge`）无模块出口可
  import（IIFE），由 gates marker 对账覆盖——这是 client half 的既有测试模式
  （`checkFrontendRuntimeText` 同款）。
- 既有断言兼容：mood-tracker 自带的手写上报器保留（同 token 同协议重复上报在宿主
  侧幂等——`setHeight(80..1200)` 钳制），`tavern-mods-p2-e2e.spec.ts` 对
  `dsh-tavern:frontend-height` 的断言不受影响（双份来源都含该串）。
