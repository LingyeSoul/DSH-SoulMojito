# 美化前端：卡没有设置背景时用 DSH 原生背景色填满画布

> 日期：2026-10-21。来源：用户需求「当美化前端没有设置背景时，自动将背景设置为
> 和 DSH 原生一致的背景色，保证在深色模式下不会有一圈白圈」。落点：
> `packages/plugin/client-src/00-shell-head.js`、`10-frontend-frame.js`、
> `packages/plugin/tests/frontend-client.spec.ts`、
> `packages/plugin/scripts/gates/run.mjs`、`README.md`、`docs/README.md`。

## 开工前检查表

| 项 | 答案 |
|---|---|
| 所有者 | 客户端 iframe 文档装配：`buildFrontendDocument`（内联消息 / MVU 右侧栏 / 美化前端右栏共用） |
| 唯一事实来源 | 宿主主题变量 `--dsw-alias-bg-base` 的解析值；卡自己的 HTML/CSS 拥有最终覆盖权 |
| 持久态 | 无——纯运行时样式，不新增设置或落盘字段 |
| 临时态 | 每次 `FrontendFrame` 首次渲染解析一次颜色；主题翻转走 `postMessage`，不重建 `srcdoc` |
| 外部依赖 | 无新增依赖；依赖宿主 `--dsw-alias-bg-base`（取不到时按 `data-ds-dark-theme` / `prefers-color-scheme` 回退） |
| 注册入口 | 既有 `reset` 样式与 head 注入点；`useThemeBridge` 挂在 `FrontendFrame` |
| 删除路径 | 删掉 `FRONTEND_THEME_MESSAGE`、`frontendHostBackgroundColor`、`frontendThemeScript`、`useThemeBridge`、reset 的 `--dt-host-background` 与 `html` 背景规则，连带测试断言、gate marker、README 一句与本决策 |
| 兼容对象 | 卡显式设置的 `html` / `body` 背景继续按 cascade 覆盖；浅色主题用 `#fff`；卡内主题切换不受影响 |

## 问题

iframe 文档没有设置背景时，浏览器把画布按默认白色绘制。美化前端常用「内容容器
带圆角/留白、容器自己着色」的写法，深色主题下容器外的 iframe 画布仍是白色，看起来
就是内容周围一圈白边；右栏与内联消息卡都受影响。

第一次实现只把 `html` / `body` 设为 `transparent`，依赖外层容器的
`--dsw-alias-bg-base` 透出。用户实机回报「还是白色底」：sandbox/srcdoc iframe 的
透明画布在不同宿主 webview 里并不可靠——同一份文档在 Chromium 实测透明，在用户
运行环境仍呈白底。透明不是可依赖的契约，必须把颜色显式画出来。

## 方案

1. **宿主解析具体颜色**：`frontendHostBackgroundColor()` 直接读
   `getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base')`
   （自定义属性会继承并完成 `var()` 替换，Chrome 实测返回最终色值）；取不到时
   退到 body 的计算背景，再按 `body[data-ds-dark-theme]` /
   `prefers-color-scheme` 回退到 `#151517` / `#ffffff`（DSH 深/浅原生底色）。
   不插入探针节点，避免渲染期触发宿主的 DOM 观察器。
2. **首帧注入**：`buildFrontendDocument` 把颜色写进 reset 的
   `:root{--dt-host-background:<color>}`，并
   `html{background:var(--dt-host-background)}`；`body` 保持 `transparent`。
   reset 位于卡样式之前，卡自己的 `html` 背景按 cascade 覆盖；`body` 背景照常
   绘制，不被改写。
3. **主题跟随**：iframe 内的 `frontendThemeScript` 监听
   `dsh-soulmojito:theme`，把新颜色写回 `html` 的 `--dt-host-background`；
   宿主的 `useThemeBridge` 在 iframe `load`、`body`/`html` 主题属性变化与
   `prefers-color-scheme` 变化时投递颜色。**不重建 `srcdoc`**——重建会重新执行
   卡脚本并丢状态。
4. **首帧值**：`FrontendFrame` 首次渲染解析一次宿主颜色，`srcDoc` 直接带上；
   后续主题翻转只走消息通道，不影响卡内状态。

## 否决项

- **只设透明**：用户实机证明宿主的 iframe 画布仍可能是白底；不能靠 webview 的
  透明实现兜底。
- **硬编码 `#151517`**：浅色主题与自定义主题会错色；只在取不到宿主变量时作回退。
- **用 `!important` 强制宿主色**：会盖掉卡自己的换肤背景，包括卡内 `html`/`body`
  的渐变和图片。
- **直接读 `parent` 的 CSS**：sandbox 无 `allow-same-origin`，跨域 WindowProxy
  不可读；颜色只能由宿主解析后注入/投递。
- **主题切换时重建 `srcdoc`**：会重新执行卡脚本、丢表单与滚动状态；用消息通道。

## 边界

- 卡显式设置 `html` / `body` 背景时保持卡的背景，本改动不介入；「一圈白边」若来自
  卡自己的白色背景而不是画布，也不在本改动范围。
- `body` 只负责透明；若卡把背景画在 `body` 且 `body` 高度小于 iframe 视口，剩余
  区域是宿主原生色（比白底正确；卡应把背景画在 `html` 或撑满容器）。
- 颜色解析依赖宿主主题变量在场；取不到时按 DSH 的暗/亮色回退，不猜测任意主题。
- Mod 面板（`src/mods/http.ts` 的 `renderModHtmlDocument`）不在此次范围。

## 验证

- `node scripts/build-plugin.mjs`：v0.6.8，`client/index.js` 与 `client/main.js` 重建。
- `npx tsc -b --pretty false`：零错。
- `npx vitest run`：123 文件 1915 通过 / 1 跳过（`host-package` 环境跳过）。
- `vitest run packages/plugin/tests/frontend-client.spec.ts frontend-documents.spec.ts`：
  2 文件 14 项通过（新增宿主背景/主题通道断言）。
- `node packages/plugin/scripts/gates/run.mjs`：18 项全 PASS，`frontend-runtime`
  新增 `--dt-host-background` / `dsh-soulmojito:theme` marker 与两个负样本。
- 用真实聊天文件的最新楼层（两份文档：35,122 / 154,052 字符）走真实
  `buildFrontendDocument`，在深色宿主下渲染：
  - 透明模式：`html` 计算背景 `rgba(0, 0, 0, 0)`，画布依赖宿主透明度；
  - 宿主色模式：`html` 计算背景 `rgb(21, 21, 23)`（`#151517`），`body` 透明，
    状态卡自身 `rgb(26, 27, 38)` 不被改写；
  - 深色宿主截图像素：iframe 外围 `rgb(21, 21, 23)`，与 DSH 原生背景一致。
- 主题消息通道：iframe 初始 `html` 背景 `rgb(21, 21, 23)`；postMessage
  `{type:'dsh-soulmojito:theme', background:'rgb(255, 0, 0)'}` 后 200ms 内变为
  `rgb(255, 0, 0)`。
