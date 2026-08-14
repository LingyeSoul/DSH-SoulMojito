# UI 跟随 DSH 语言（zh/en）+ 设置页版本/commit 戳

日期：2026-08-15

## 背景

client half 的全部界面文案（设置页、侧边栏、transcript、composer、模型菜单、对话框与错误提示）都是英文硬编码；宿主自带 `@deepseek-ai/dsh-client-locale` 服务（zh/en 双语、`locale.preference` 持久化、浏览器探测兜底），插件没有接入。同时设置页无法辨别当前运行的是哪个构建——用户装的是 git 源还是哪个 commit 无从对照。

## 决策

1. **接入 locale 服务而不是自建语言状态**：client half `exports.inject` 增加 `'locale'`（严格注入），`apply` 中 `ctx.effect(() => ctx.locale.register('dsh-tavern', { zh, en }))` 注册命名空间字典、`ctx.locale.bind()` 取翻译函数。语言选择完全由宿主"通用设置 -> 语言"与浏览器探测决定，插件不提供独立语言开关。
2. **响应式翻译走自建 `useTranslate()` hook**：`useSyncExternalStore(ctx.locale.subscribe, ctx.locale.getSnapshot)` 订阅 locale 快照（revision 变化即重渲染），渲染期调用模块级 `translate(key, params)`。不逐 slot 声明 `locale:` 席位——七个 slot 注册的组件树全部经同一 hook 取词，无需框架逐席位注入 `t` prop。`translate` 保持 bind 前的恒等回退（缺键返回键本身、`{param}` 插值），与 `LocaleRuntime.translate` 行为一致，兼容 stub/预 apply 环境。
3. **字典 zh/en 平铺键集**（`nav.*` / `settings.*` / `model.*` / `composer.*` / `message.*` / `view.*` / `run.*` / `error.*`），共 60+ 键。运行状态（Connecting/Saved/Stopped）存键、渲染期翻译；一次性对话框（重命名 prompt、删除 confirm）与抛错文案在调用期翻译。`conversation.view` 的 `label: () => translate('nav.title')` 官方模式实时跟随；`clickTavernTab` 的 DOM 匹配相应改为对照 zh/en 两个字典值。
4. **版本戳构建期注入**：`scripts/build-plugin.mjs` 读 `packages/plugin/package.json` 的 version + `git rev-parse --short HEAD`，经 esbuild `define` 替换 `__TAVERN_VERSION__`/`__TAVERN_COMMIT__`（git 不可用时回退 `unknown`）；Node half 的 bootstrap 响应携带两字段，设置页标题下渲染 `版本 v0.1.0 (f6d2847)` 样式的 muted 小字（字段缺失时不渲染）。
5. **gate 同步强化**：`client-vm-mount` 断言 inject 含 `'locale'`、`ctx.locale.register('dsh-tavern', {zh, en})` 已调用、zh/en 键集一致、每键 `{param}` 占位符集合一致、`ctx.locale.bind` 已绑定；`server-bundle` 断言 bundle 含 `version:`/`commit:` 字面量标记，新鲜度检查把 package.json 纳入 mtime 源（bump 版本不重建即 FAIL）。

## 备选方案

- **每个 slot 注册声明 `locale:` 用框架注入的 `t` prop**：被否——七处注册的子组件树都要逐层透传 `t`，不如 hook 一处订阅。
- **版本号运行时读自身 package.json、commit 用 `import.meta.url` 推导**：被否——commit 无法在无 `.git` 的安装现场推导，运行时 fs 读引入额外失败面；构建期 define 单一机制、新鲜度 gate 已把 package.json 纳入监控。
- **服务端错误消息也 i18n**：暂缓——API 错误文案（英文）直达 UI 属可接受边界，翻译应在需求出现时随错误码体系一起做。

## 后果

- 宿主 web bundle 必含 locale 服务（rc.6 起标配）；更老宿主上 client half 因 inject 缺失不挂载，属显式失败。
- 语言切换时已在运行的 run 状态、已弹出的错误消息保留原语言直到下一次更新（注册期文本一次性读取是宿主已知限制）。
- 改字典只需编辑 `client/index.js` 顶部两个常量；gate 保证 zh/en 不漂移。
- 升版本流程变为：改 package.json → `pnpm run build:plugin`（否则 server-bundle gate FAIL）→ 安装/重启。
