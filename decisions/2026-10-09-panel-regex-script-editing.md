# 面板正则脚本新建与编辑（补记 642dc14）

日期：2026-10-09。状态：已实施（补记）。相关：commit 642dc14；`packages/plugin/client/main.js`（RegexScriptEditor）。

## Problem

此前正则脚本（regex scripts）在面板里只能 JSON 上传导入 + 开关/删除：想改一个 findRegex 或调整作用位置，必须手写 JSON 重传。没有配套的提案/决策文档——违反本仓库「功能必附决策文档」的纪律，本文件补记。

## Decision

面板内建正则脚本全字段编辑器 `RegexScriptEditor`（纯客户端，零服务端改动——读写仍走既有 `GET/PUT regex` 与 `POST import/regex` 路由）：

- **全字段编辑**：scriptName、findRegex/replaceString、trimStrings（多行）、五个作用位置开关（1/2/3/5/6）、min/maxDepth、markdownOnly/promptOnly/runOnEdit/substituteRegex 四开关；复用 dt-editor CSS 体系。
- **新建**：列表加「新建」按钮，`newRegexScript()` 生成 `regex-<ts36>-<rand>` id，placement 缺省 `[2]`（AI_OUTPUT）。
- **浏览器侧预检**：空名/空 pattern 拒绝保存；`new RegExp(findRegex)` try/catch 坏正则就地报错（不发起请求）；placement 至少保留一项——最后一项禁取消，服务端 `parseRegexScripts` 对空集也会回落 AI_OUTPUT，客户端先拦住防意外。
- **防复活**：编辑中的行锁行内开关与删除按钮（disabled），避免「编辑器开着、列表里那条已被删」的复活窗口；dirty 时取消走 `window.confirm(panel.unsaved)`。
- **本地化**：placement 名称从硬编码 map 改 i18n labelKey（`regexPlacementLabel`），中英双语补齐。

## Alternatives considered

- **服务端 schema 校验前移**：POST 前先调服务端校验正则——多一次往返且服务端本就校验，浏览器预检足够。拒绝。
- **沿用 JSON 导入路径做编辑**（导出→改→重传）：用户必须理解完整 schema，门槛与出错率高。拒绝。

## Consequences

- 正则脚本的完整生命周期（新建/编辑/开关/删除/导入）全部面板内可达。
- 编辑器行为无专门 spec 文件锁定（纯客户端渲染层，与 client 其余面板组件同口径）；路由契约仍由 tavern-command.spec.ts 的 regex 路由用例覆盖。
- 本文件为补记：实现先于文档落地，后续功能应先写决策再动代码。
