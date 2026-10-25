# 删除角色卡时清理其卡级正则（含历史脏数据自愈）

> 日期：2026-10-25。用户反馈：切换角色卡后，已经被删除的角色卡的正则仍然被加载。承接 `2026-10-22-card-scoped-regex-and-worlds.md` 与 `2026-10-23-scoped-regex-identity-and-world-toggle.md`。

## 根因（RCA）

删除角色卡只删了 `characters/<卡名>.*` 与 `chats/<卡名>/`，没有处理由卡文件派生出来的状态：

1. `state.json` 的 `regexScripts` 里仍留着导入期物化的卡级脚本，`regexScriptOwners` 仍把 id 登记到已删的卡名；面板因此继续渲染一个「已删卡」的正则分区。
2. 更严重的是同名重建/重导：新卡落盘后，旧脚本的归属名与新卡相同，`collectRegexScripts` 会把它当成新卡的脚本重新生效——旧卡的正则被「加载」到新卡会话里。
3. 归属迁移（`ensureRegexScriptOwners`）只在一开始扫描一次；旧版本删卡留下的孤儿归属不会因为版本号已是最新而被清理。

## 决策

- **删除即清理**：`TavernStore.deleteCharacter` 是面板 `DELETE character` 与写卡工作台 `card_delete` 的共同出口，删除成功后在同一入口按 `regexScriptOwners[id] === 卡名` 删除对应脚本，并同步剪掉 `regexScriptOwners` / `regexScriptPresetOwners`。同名新卡从空归属开始，只物化自己卡内的脚本。
- **历史脏数据自愈**：`ensureRegexScriptOwners`（bootstrap / `GET regex` 调用）在版本迁移之后增加一次孤儿清理——归属的卡名在 `characters/` 下已无对应文件时删除该脚本。只有真的存在孤儿才写盘，常规轮询不产生额外 store 水位变化。
- 读取到写入之间如果脚本已被别的来源重新接管，只删仍挂在原归属下的条目，避免误删。

## 边界

- 预设级脚本保持既有语义（`2026-10-22` 决策）：删除预设后脚本自然停用、不随预设删除；本次只处理卡级脚本。
- 无归属的手动全局脚本永远不参与清理——它们不是卡文件派生资产。
- 会话级正则覆盖层存放在 `chats/<卡名>/<聊天>.scripts.json`，已随删卡的聊天目录一起移除，无需额外处理。
- 历史版本里卡片从未登记归属、只作为全局脚本存在的条目无法与用户手动脚本区分，仍按全局脚本保留。

## 见证

- `packages/tavern-store/tests/store.spec.ts`：删卡移除其卡级脚本且保留其他卡/全局脚本；同名新卡导入不复用旧脚本；卡文件缺失时 `ensureRegexScriptOwners` 自动清理历史孤儿，预设脚本不受影响。
- `pnpm run check`：2199 项测试通过（1 项环境跳过）+ 18 项 gates PASS。
