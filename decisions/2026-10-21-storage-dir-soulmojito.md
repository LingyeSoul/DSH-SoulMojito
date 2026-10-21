# 存储目录迁移：`$DSH_HOME/tavern` → `$DSH_HOME/soulmojito`（2026-10-21）

需求源：2026-10-21 用户「把存储目录从 dsh/tavern 换成 dsh/soulmojito 并提供旧目录兼容」。

## 决策

1. **新装数据根 = `$DSH_HOME/soulmojito`**。`$DSH_HOME/tavern` 作为旧安装的原地根保留：不自动搬迁、不双写、不合并读。
2. **解析规则**（唯一事实来源：`packages/plugin/src/dsh-home.ts` 的 `tavernDataRoot()`）：
   - `soulmojito/` 非空 → 用它；
   - 否则 `tavern/` 非空 → 用它（读与写都在旧路径，行为与 0.6.x 完全一致）；
   - 否则 → `soulmojito`（新装）。
   「非空」判定挡住「误建的空 `soulmojito/` 目录遮蔽存量库」这类静默失联。
3. **内部工作区跟随同一解析**：旧安装仍是 `$DSH_HOME/tavern/workspace` 与 `tavern/workbench`，新装是 `soulmojito/workspace` 与 `soulmojito/workbench`。
4. **命中面**：store / memory / variables / memory-vectors / novels / mods / games / update-state / workbench / projections / 卡工作台快照，全部经 `tavernDataRoot()`；`dshHomePath('tavern', …)` 在源码中清零，不存在第二条路径来源。

## 为什么不做自动搬迁

- 宿主 workspace 注册表按**路径**登记（决策 [`2026-08-17-internal-tavern-workspace`](2026-08-17-internal-tavern-workspace.md)），原生 session 目录按路径编码：`$DSH_HOME/sessions/--C-…-dsh-tavern-workspace--/<sessionId>/`。把 `tavern/` 整体 rename 成 `soulmojito/` 会让已绑定会话的 cwd 消失、旧 workspace 变成悬空条目，存量 Tavern 会话有从原生侧栏失联的风险——与「旧数据兼容读」直接冲突。
- 完整迁移还要同时改宿主 workspace 注册表与 session 目录编码，两者都不在插件控制面。v1 边界：插件只保证旧目录原地可用；搬迁留给后续显式迁移工具，本次不做。
- 双库并存时新目录优先，这就是显式搬迁后的生效路径（停 `dsh web` → 处理目录与宿主登记 → 重启）。

## 否决项

- **双目录合并读**：同一份 store 跨两个根读一半写一半 = 两份事实来源，冲突无法收敛。
- **双写镜像（写新读旧）**：磁盘占用翻倍，且半写失败没有回滚语义。
- **按文件粒度回落**：资产互相引用（角色卡 → 内嵌世界书 → 聊天），按文件回落会产出半新半旧的库。
- **开工即 rename**：见上，破坏宿主 session 目录与 workspace 注册表。

## 证据

- 源码：`dsh-home.ts` 增 `TAVERN_DATA_DIR` / `LEGACY_TAVERN_DATA_DIR` / `tavernDataRoot()` / `holdsTavernData()`；18 个源文件、79 处调用改由它解析；`agent-tavern/anchor.ts` 的私有 `anchorDshHomePath` 删除（锚定注入与主链路必须读同一个库）。
- 测试：`tests/storage-root.spec.ts`（4 项：新装 / 旧库原地 / 双库新优先 / 空 `soulmojito` 不遮蔽）；`tests/storage-legacy-compat.spec.ts`（旧库经真实 bootstrap 可读、workspace 仍指旧路径、不产生新库）；`helper-route.spec.ts` 新增新装根断言。全量 vitest：123 文件 / 1905 过 / 1 平台跳过。
- gate `internal-workspace`：新增 `tavernDataRoot("workspace")`、`TAVERN_DATA_DIR`、`LEGACY_TAVERN_DATA_DIR`、`holdsTavernData` 四个 bundle marker + 两条负样本；mod-loader 夹具改到 `soulmojito/mods`。
- 文档：根 README / 插件 README / `docs/content-policy.md` / `docs/games/game-package.md` / `docs/mods/mod-api.md` 的现行路径；客户端 Mod 提示改 `soulmojito/mods/`（旧装注记 `tavern`）。
- 存量测试夹具：60 个 spec、142 处 store 根从 `tavern` 改到 `soulmojito`（覆盖新装默认路径）；旧目录行为由 `storage-legacy-compat.spec.ts` 单独覆盖。
- `scripts/repair-novel-outline.mjs` 缺省根同步为「新优先、旧兜底」。
