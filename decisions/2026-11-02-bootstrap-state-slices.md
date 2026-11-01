# 决策：bootstrap 只带轻状态，正则表按分区挂载拉取

> 日期：2026-11-02。状态：已实施。相关：`packages/plugin/src/http/router.ts`（bootstrap 与 `state-slices`）、`packages/plugin/client-src/50-store-core.js`（`ensureRegexScripts`）、`packages/plugin/client-src/81-ui-regex.js`（分区挂载触发）、`decisions/2026-11-01-tavern-read-caches.md`（读侧缓存）、`decisions/2026-11-01-tavern-state-asset-split.md`（状态切片）。

## 问题（真实浏览器实测）

在隔离的 `DSH_HOME` 里起 `dsh web`，用 Playwright 打开面板并抓全部 `/api/` 响应：

- `GET /api/dsh-soulmojito/bootstrap` 一次回 2.2 MB JSON（合成夹具：129 条正则 + 7 份前端存储），真实存量数据组装后是 2.55 MB、gzip 775 KB。
- **面板每打开一次就重取一次 bootstrap**，并再解析一遍整包。
- 正则表约占整包的七成；`frontendStorage` 约占三成，而客户端**从不**从 bootstrap 读它——前端存储走 `frontend/storage` 按角色单独取（`12-frontend-storage.js`）。
- 分区是懒挂载的：面板默认分区打开时 DOM 里没有任何正则行；只有切到「正则脚本」才渲染。

## 方案

1. **bootstrap 只带轻状态**：剔除 `regexScripts`、`regexScriptOwners`、`regexScriptPresetOwners`、`frontendStorage`，并回 `stateSlices: ['regexScripts']` 声明哪一表需要单独取。`frontendStorage` 直接不再下发（客户端不读）。
2. **新增 `GET state-slices`**：只回正则表与两个归属映射；前端存储不在此端点。
3. **客户端按需拉取**：`ensureRegexScripts()` 在「正则脚本」分区首次挂载时取一次并写回 `bootstrap.state`，所有读该键的组件共享；未就绪时该分区不渲染（避免先闪一次「暂无脚本」）。
4. `applyRegexResult` 等既有写路径不变：写回后仍然把最新表放进 `bootstrap.state`。

## 否决项

- **把大表压成两个请求并行发**：总字节不变，只是把一次解析拆成两次，没有收益。
- **给 bootstrap 加 gzip 之外的新压缩**：宿主已按 HTTP 压缩传输（实测 2.55 MB → 775 KB），瓶颈是浏览器侧的解析与渲染，不是带宽。
- **让客户端只取「当前分区需要的字段」**：正则分区一次就要全表（分组、计数、编辑都基于全表），按条分页会把服务端与面板的查询面一起改掉，收益不成比例。

## 实测（Playwright + 隔离 DSH_HOME）

| 指标 | 改前 | 改后 |
|---|---|---|
| 面板打开时的 `bootstrap` 响应 | 2,205,510 B | **3,438 B** |
| `state-slices` 响应 | — | 1,585,471 B（仅在切到正则分区时） |
| 正则分区渲染 | 129 条（44 全局 + 85 卡级） | 129 条，同上 |
| 控制台错误 | 0 | 0 |
| 面板打开期间的其他请求 | 15 个 | 同量级（未见新增） |

真实存量数据（2.55 MB / gzip 775 KB）按同一比例折算：面板打开时约 12 KB（gzip）级别的响应，正则表 700 KB 级别只在打开该分区时出现。

## 影响面

- `bootstrap.state` 不再自包含：任何**外部**消费者（脚本、第三方集成）如果从 bootstrap 读 `regexScripts`，必须改读 `state-slices`。仓库内只有面板正则分区读它，已同步。
- `frontendStorage` 从 bootstrap 消失，客户端本来就不用；按角色的读取路径未变。
- 客户端 bundle 仍包含正则分区代码，体积不变；这次省的是**数据**不是代码。
- 服务端多一个只读端点，权限模型与 bootstrap 相同（同一个浏览器信任栅栏）。

## 验证

- 新增 `packages/plugin/tests/bootstrap-state-slices.spec.ts`：bootstrap 不带四个大键且声明 `stateSlices`；`state-slices` 回正则表与归属映射且**不带**前端存储。
- 全量 `pnpm check`（tsc ×3 + vitest + 重建产物 + 20 项 gate）。
- 真机：隔离 `DSH_HOME` 起 `dsh web`，Playwright 打开面板 → 切「正则脚本」→ 分组显示 44 / 85 条，控制台 0 错误。
