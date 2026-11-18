# 管理面板「使用手册」分区

## 问题

面板分区已增至 27 个，但「第一次该做什么」「AgentTavern 和 ST 有什么区别」「哪个分区管什么」只散落在根 README、提案与决策文档里。用户必须在面板与外部文档之间来回跳，且 ST 迁移者最容易把本插件当成另一套 SillyTavern：模型密钥、群聊、STscript、扩展加载这四类边界一旦误解，后面的操作全错。

2026-11-18 用户要求：管理面板新增使用手册，详细讲解与 ST 的区别，并给新手引导与功能解释。

## 方案

新增无分组分区 `manual`，注册在 `overview` 之后、`characters` 之前：与总览一起钉在导航顶部，首次打开面板即可看到，不挤进内容/会话/系统组。

内容分五段，全部由 `packages/plugin/client-src/89c-ui-manual.js` 的数据表驱动：

1. **五分钟上手** — 导入角色卡、按聊天选架构、新建聊天、原生输入框对话、按需补齐工作流；每一步带直达分区按钮。
2. **名词与架构** — DSH、SillyTavern（ST）、AgentTavern、资产四个名词；AgentTavern / ST / AgentNovel 三行架构表，写清生成循环、适合场景与边界。
3. **数据与迁移** — `$DSH_HOME/soulmojito/`（旧装 `tavern/`）、内部 `workspace/`、逐项导入 ST 资产、备份 ZIP 的 replace 前快照。
4. **与 ST 的区别** — 九维对照：运行形态、模型与密钥、生成循环、上下文、交互面、群聊、扩展、数据目录、模板与脚本。
5. **功能地图与边界 FAQ** — 三个功能组共 19 张卡片，每张带直达按钮；八条诚实边界与五条 FAQ 使用原生 `<details>` 折叠。

总览同时加一条「第一次用 SoulMojito？」callout，按钮直接切到 `manual`。分区跳转统一走 `update({ panelSection })`，与总览数字卡片同一路径，不新增路由或持久态。

文案全部进入 `40-i18n-en.js` / `41-i18n-zh.js` 的 `manual.*` 键集，跟随宿主语言即时切换；组件只保存分区 id 与键名，避免中文文案硬编码在渲染代码里。

## 否决项

- **只外链 README/docs**：不满足「面板内使用手册」；断网或本地安装时外链也不可靠。
- **把整篇手册塞进一个 i18n 字符串再按换行拆分**：结构、按钮与表格无法语义化，也无法逐段测试。
- **新增独立 Guide 路由/页面**：多一个宿主表面与生命周期，收益只是排版；面板分区已能承载同样的内容与跳转。
- **给每个功能卡片写独立动作文案**：动作语义统一为「打开某分区」，按钮标签由分区 locale thunk 生成，少一套会漂移的键。

## 验证

- `node scripts/build-plugin.mjs` 成功；`node --check packages/plugin/client/main.js` 通过。
- `npx vitest run packages/plugin/tests/panel-manual.spec.ts`：7 项通过（注册顺序、总览入口、五个锚点、19 个目标分区、内容与双语键、渲染 smoke、负样本）；渲染 smoke 在 vm 里真实执行组件，点分区按钮验证 `panelSection` 切换、点目录验证 `scrollIntoView` 锚点。
- `npx vitest run --exclude packages/tavern-store/tests/novel-store.spec.ts`：217 个文件、3495 passed / 2 skipped；`npx vitest run packages/tavern-store/tests/novel-store.spec.ts` 单独 45/45 通过。全量并行时该文件的 Windows PID 复用所有权用例会偶发，属既有环境敏感用例，不经过面板/客户端代码。
- `node packages/plugin/scripts/gates/run.mjs`：21 gates 全 PASS（含 client-bundle、client-vm-mount、source-file-budget、content-lexicon）。

## 偏差与维护

- 首个版本 `ManualSectionTable` 少一个闭合括号，`tbody` 被收进 `thead`；浏览器重排后表头标签漂到右侧、与表体列错位（2026-11-18 用户截图）。已修正为 `table > [thead, tbody]` 同级，并在 render smoke 里断言两个表组的子节点只有 `tr`——防止再次出现「表头单独成表」。

- 手册是行为说明，不替代源码契约；`agent-managed`、群聊、STscript、EJS、Mod、IM Native 等边界仍以对应提案/决策为准。
- 若后续新增分区或改变架构边界，必须同步更新 `89c-ui-manual.js` 的目标表与 `manual.*` 文案；测试会因目标分区缺失或键集缺半而变红。
- 不新增持久化：手册没有用户状态、没有 API 调用，也不记录阅读进度。