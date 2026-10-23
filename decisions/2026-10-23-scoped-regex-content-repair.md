# 同名正则的归属内容错位与 v3 修复

> 日期：2026-10-23。承接 `2026-10-23-scoped-regex-identity-and-world-toggle.md`（同名跨来源拆分实体）与 `2026-10-23-regex-group-master-toggle.md`。用户反馈：用 A 卡的分区却渲染出 B 卡的美化前端，怀疑会话绑定错了。

## 问题

会话绑定本身是对的：`sessionBindings` 指向 A 卡的聊天，`frontend/latest` 也读同一份聊天。错的是正则实体：

旧表按 `scriptName` 合并导入，最后导入的卡覆盖正文——A 与 B 都有一条「状态栏美化」，表里只剩最后写入的 B 正文。v2 归属迁移按名字认领无归属实体时，**先遍历到的 A 认领了 B 的正文**（`claimUnownedByName` 不校验内容），B 随后得到一条 `#N` 副本。结果：A 的聊天启用「状态栏美化」，渲染出来的是 B 的前端；面板上 A 分区的开关看似生效，实际改的是错位实体。正文里的完整 HTML 被展示层按既有纪律搬进沙箱，所以表现成「正文少了 HTML + 前端是别人的」。

## 决策

- **按名认领必须内容逐字一致**。`applySourceRegexScripts` 只在「同名且 `findRegex`/`replaceString`/`trimStrings` 完全一致」时接管无归属旧实体；内容不同说明是另一来源的同名脚本，留给它真正的主人，本来源追加新实体。
- **v3 迁移修复已错位的数据**（`repairForeignRegexContent`）。仅当「本来源已有同名内嵌脚本、实体正文与它不一致、且与另一个来源的同名内嵌脚本逐字一致」时，把 `findRegex`/`replaceString`/`trimStrings` 换回本来源版本；`id`、归属、`disabled`/`placement`/深度等用户开关全部保留。
- **编辑过的副本不动**。用户手改后的正文既不等于本来源也不等于别的来源，v3 不覆盖——迁移只修「整段照抄错来源」这一种可判定形态。
- **版本号 3 只跑一次**。与 v2 同一入口（`ensureRegexScriptOwners`）：会话绑定、正则面板路由触发；迁移后写 `regexOwnershipVersion: 3`，不再重复扫描。

## 边界

- 不按 `scriptName` 模糊匹配、不做相似度判断：无法逐字判定的一律保留现状，宁可让用户手动改，也不静默覆盖。
- 不修改角色的卡内脚本（只读），也不改生成期合并语义（`collectRegexScripts` 仍全局 → 卡 → 预设、同名去重）。
- 迁移只处理角色卡/预设内嵌脚本有同名条目的实体；来源文件缺失或条目非法的来源跳过。

## 验证

- `packages/tavern-store/tests/store.spec.ts`：v1 同名不同内容不再按名认领；v2 错位内容按来源修复；手改副本不被覆盖。
- 真实数据副本：把 `state.json` + 角色/预设复制到临时目录跑 `ensureRegexScriptOwners`，错位条目从 85,359 字符（B 卡正文）修回 133,251 字符（A 卡正文），同组 `disabled` 保持不变。
- `pnpm run check`：`tsc -b` + 全量测试 + 构建 + gates。
