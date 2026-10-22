# JSR 兼容与沙箱虚拟存储拆分为库包（2026-10-22）

## 问题

沙箱美化前端的两块运行时此前都长在插件里：

- `packages/plugin/client-src/11-helper-bridge.js` 用一份约 1570 行的模板字面量同时承载
  TavernHelper shim、lodash/jQuery/Vue/Zod 注入、虚拟 localStorage/sessionStorage 与
  虚拟 IndexedDB。模板里的注释反引号曾提前终止字符串（2026-10-22 的
  `Unexpected identifier 'window'` 事故），而且任何一半都无法独立测试或复用。
- `packages/plugin/src/frontend-idb.ts` 把宿主侧 IndexedDB 记录存储、配额、原子写和
  插件的 `tavernDataRoot()` 绑在一起；`helper.ts` 里还散着 localStorage 的 512KB
  校验与 state 写入。

结论：JSR 兼容面没有稳定的库边界，虚拟存储也没有单一所有者。

## 决策

1. **新增 `@dsh-soulmojito/jsr`（`packages/tavern-jsr`）**：拥有 iframe 运行时源文本
   （`buildIframeScript`）、`tavern_events` / `iframe_events` 词汇表、CDN 库版本与
   `helperLibraryTags()`。它只负责沙箱运行时可观察面；变量、楼层、世界书、生成桥等
   需要 tavern store 的宿主域操作仍留在 `packages/plugin/src/helper.ts`。
2. **新增 `@dsh-soulmojito/frontend-storage`（`packages/tavern-frontend-storage`）**：
   同时拥有三块内容——
   - iframe 内的 localStorage/sessionStorage 垫片与虚拟 IndexedDB 垫片源文本；
   - 宿主页的二进制通道（base64url、query、`x-dsh-idb-meta`、`handleIdbBridge`）；
   - 宿主侧 IndexedDB 记录存储（显式 `root` 参数）与按角色的 localStorage 校验/持久化。
3. **构建期 IIFE 注入**：沿用 bind 的既有模式，`build:plugin` 把两个包分别打成
   `DshJsrRuntime` / `DshFrontendStorage` IIFE，注入 `client/main.js` 的
   `__DSH_JSR_CLIENT_SLOT__` 与 `__DSH_FRONTEND_STORAGE_CLIENT_SLOT__` 标记处。
   `client/main.js` 仍只保留分片与槽位，`client/index.js` 是完整产物。
4. **存储源文本由调用方注入**：`buildIframeScript(token, messageId, storageSeedJson,
   storageSources)` 接收存储包提供的两段 shim 源文本，JSR 包不反向依赖存储包。
   两段 shim 各自包在 IIFE 里，只显式接收 `call` / `clone` / `showToast` 等运行时依赖。
5. **行为不变**：helper op 名称、`frontend/idb/get|put` 路由、按角色
   `state.frontendStorage` 结构、512KB 字符上限、单条 1GB / 角色 2GB 配额、沙箱
   `allow-scripts` + CSP 全部保持原样。

## 否决项

- **把 `helper.ts` 整体搬进 JSR 包**：它依赖 tavern store、MVU、Mod 事件、生成桥与
  插件运行时；搬走会需要一层巨大的 adapter seam，超出本次“建库边界”的范围。
- **iframe 内直接 import 库模块**：沙箱是 opaque origin 且 CSP 禁止外部脚本，运行时
  只能以源文本注入；`eval` / `new Function` 同样被 CSP 禁止。
- **JSR 包直接打包存储 shim**：会在 JSR IIFE 与存储 IIFE 里各留一份源文本；改为
  调用方注入源文本，单一事实来源留在存储包。
- **继续用一份模板字面量承载全部运行时**：反引号/插入值逃逸风险与不可测试性已被
  2026-10-22 的事故证明。

## 已知边界

- JSR 包是**运行时与协议**库，不是完整的酒馆域实现；`helper.ts` 仍是宿主域适配层。
- 存储包的宿主侧 API 显式接收 `root`，不读 `DSH_HOME`；插件负责传 `tavernDataRoot()`。
- iframe 侧 shim 仍是源文本（不是可 import 的模块），其依赖由外层运行时显式传入。

## 删除路径

1. 删除 `packages/tavern-jsr` 与 `packages/tavern-frontend-storage`；
2. 移除 `scripts/build-plugin.mjs` 的两段 IIFE 构建与两个槽位注入；
3. 把 `helper.ts` / `router.ts` 的导入换回插件内模块（IDB 存储与 localStorage 校验）；
4. `client-src/11-helper-bridge.js` 与 `12-frontend-storage.js` 重新内联运行时与传输代码；
5. 移除根 `tsconfig.json` 的两个 references 与 gate 的预算/allowlist 条目。

## 兼容对象

- 卡前端：同一批 `window.*` / `TavernHelper.*` 函数、同一组事件名、同一套存储语义。
- 宿主路由：`POST /helper` 的 `idb.*` / `storage.*` op，`GET|POST /frontend/idb/*`，
  `GET /frontend/storage`。
- 落盘：`$DSH_HOME/soulmojito/frontend-idb/<sha256(角色)>/<sha256(数据库)>/`，
  `state.json` 的 `frontendStorage`。
