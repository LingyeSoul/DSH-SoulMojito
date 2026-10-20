# 决策：AgentNovel 原作导入续写与正文优化落地

> 日期：2026-10-20。状态：已实施。规格：[提案 0020](../docs/proposals/0020-novel-import-continuation-and-revision.md)。相关：0005（提交/调度/完成守卫）、0007（子代理执行面）。

## 问题

AgentNovel 只能从零创作：没有「读入已有小说并接着写」的入口，也无法在不改写提交历史的前提下按用户要求优化整章正文。需要在不破坏 0005 正典协议、不把整本原作塞进上下文、不引入插件侧 LLM 循环的前提下补齐两项能力。

## 方案

1. **服务端解析/切分**：`parseImportedNovelText` 纯函数识别中/英/Markdown 章节；无标题时按篇幅切伪章节；再按 `partTargetCharacters` 切成部分，段落不跨部分。
2. **逐部分提取子代理**：每部分一次无工具 `spawn`，输出严格 JSON（摘要/时间线/角色/世界条目/线索/文风）。结果写 `imports/extractions/<hash>.json`，快照只存 hash 与摘要。
3. **主代理熔炼**：`novel_import_read` 返回有界 digest（抽样摘要、去重角色/世界条目、时间线头尾、原文尾部）；`novel_import_merge` 校验收据并物化角色卡/世界书资产，再进入既有大纲流程。
4. **调度**：`NovelPhase` 增加 `importing`，`WorkIntentKind` 增加 `import-extract` / `import-merge`；`nextWork` 在既有分支之前处理导入。
5. **正文优化**：新增 `BodyRevisionRecord` + `bodyRevisions`；修订子代理输出纯文本整章改写稿，先 `pending`，显式 apply 后成为阅读投影，提交对象不变；有效字数与硬上限统一走 `effectiveNovelCharacters`。
6. **界面**：新建表单支持导入模式与解析预览；详情展示导入进度/原作章节/原文；阅读栏提供「优化本章」与待应用版本列表。

## 否决项

- **把原作原文写进 `commits`**：会污染正典、字数预算与完成守卫，也会让导出把原作当新书正文。
- **让主代理逐章读原文并提取**：上下文随原作长度增长，且与 0005 §11 的「材料不是指令」边界冲突。
- **优化直接覆盖提交/正文文件**：违反提交不可变与重试幂等；无法审计，也会破坏 canon source 坐标。
- **优化后重算 canon changes**：首版把优化限定为文风/语句层，事实变更仍走正文提交与修订协议。

## 与规格的偏差

1. 提取尝试耗尽由工具调用 `store.pause({reason:'recovery-required'})`，而不是只依赖 driver 的停滞计数；更早给出可操作原因。
2. `applyImportMerge` 在已熔炼且 bible 内容相同时先回放收据，再考虑 `expectedRevision`；保证网络重试幂等。
3. 优化稿长度守卫固定为 `[0.60, 1.60]`，未做成项目配置；首版先保证不会把「优化」变成删改剧情。
4. 面板优化走 HTTP + 宿主子代理运行时；运行时不可用时 503，不静默降级。
5. 写手包新增导入连续性块（bible + 原文尾部），位于稳定前缀之后；模板/单元参数仍在尾部。

## 验证

- `pnpm check`：tsc、全量 Vitest、插件构建、gates 全绿。
- 新增测试：`novel-import.spec.ts`、`novel-import-store.spec.ts`、`agent-novel-import.spec.ts`；扩展 command / outline / tools / writer 契约。
- gates：新增路由字面量进入 `REQUIRED_SERVER_ROUTES`；四个超出 800 行的文件登记 allowlist 理由（i18n 消息表、单 HTTP 域、导入域）。
