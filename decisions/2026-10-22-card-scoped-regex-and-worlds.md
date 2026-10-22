# 卡级正则与世界书跟随角色卡会话启用/停用

> 日期：2026-10-22。用户需求：正则与世界书跟随角色卡——绑定卡 A 的世界书在非卡 A 会话自动禁用、只在卡 A 会话自动启用；手动启停不归插件管。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/tavern-assets.ts`（`collectRegexScripts` 归属过滤）、`packages/plugin/src/http/router.ts`（移除 `activeWorlds` 自动并入、bootstrap 迁移）、`packages/plugin/src/session/binding.ts`（绑定不再写 `activeWorlds`）、`packages/plugin/src/helper.ts`（JSR regex 读取/格式化走生效集）、`packages/tavern-store/src/store.ts`（`regexScriptOwners` 持久层与回填/迁移）、客户端 `client-src/81-ui-regex.js` / `90-panels-core.js` / `95-ui-styles.js` / 双语 i18n |
| 唯一事实来源 | 世界书：`worlds/<name>.json` 与卡 `data.extensions.world`；正则：`state.json` 的 `regexScripts` + 新增 `regexScriptOwners`（script id → 角色卡名） |
| 持久态 | `TavernState.regexScriptOwners`（可选，旧 state 缺省时一次性迁移）；`activeWorlds` 继续只保存手动选择 |
| 临时态 | 无。正则归属不复制脚本内容，只登记 id 与卡名 |
| 外部依赖 | 无新增 |
| 注册入口 | `GET bootstrap` 里调用 `ensureRegexScriptOwners()` 做存量迁移；角色卡导入/回填自动登记归属；面板 PUT `/regex` 全量替换时剪枝 |
| 删除路径 | 删除 `regexScriptOwners` 字段与过滤逻辑即恢复「全局脚本」旧语义；`activeWorlds` 不再被插件写入，删除路由/绑定处的旧并入即可；世界书面无新增持久字段 |
| 兼容对象 | 旧 `state.json`（无归属字段）经 bootstrap 扫描角色卡推断一次；手动导入/新建的正则无归属，保持全局；手动 `activeWorlds` 勾选原样保留 |

## 语义

- **世界书**：`collectWorldInfoBooks(db, state, characterName, character, chatId)` 已按当前会话角色读取 `extensions.world`，但导入、切换 `activeCharacter`、会话绑定三个入口此前把链接书并入全局 `activeWorlds`，导致别的角色聊天也带上它。现在三个入口都不再写 `activeWorlds`；绑定书只在所属卡的会话由 `collectWorldInfoBooks` 自动并入，手动勾选列表保持用户所有。
- **正则**：卡导入时脚本仍物化为全局条目（面板可编辑、存量回填语义不变），同时登记 `regexScriptOwners[script.id] = 卡名`。`collectRegexScripts` 只保留「无归属」或「归属等于当前会话角色卡」的脚本；卡内脚本仍按 `scriptName` 合并兜底，因此别的卡占用同名全局条目时，当前卡的卡内版本仍可生效。JSR `regex.get` / `regex.format` 走同一生效集；面板按归属显示并锁定非本卡脚本的开关（置灰），编辑面保留。
- **手动启停**：`activeWorlds` 与脚本 `disabled` 字段仍是用户的手动面；插件只做会话级自动过滤/注入，不改写用户勾选或禁用状态。

## 边界

- 群聊没有单一「所属卡」：世界书仍按当前发言者取链接书，正则归属过滤按当前发言者卡；群成员全集的脚本合并不在本次范围。
- 存量 `activeWorlds` 里可能残留旧版本自动并入的链接书。无法区分手动勾选与旧自动写入，按「手动启停不归插件管」保留原值，用户可自行取消勾选。
- 预设内嵌 regex 不登记归属（预设不是角色卡），保持全局生效。

## 见证

- `packages/plugin/tests/tavern-assets.spec.ts`：卡级脚本只在归属卡会话生效、无归属脚本全局、跨卡同名时当前卡内版本兜底。
- `packages/tavern-store/tests/store.spec.ts`：导入登记归属、旧 state 迁移一次、面板全量替换剪枝。
- `packages/plugin/tests/tavern-command.spec.ts`：切换角色、会话绑定、首个角色导入都不再写 `activeWorlds`；显式 `activeWorlds` 补丁仍生效。