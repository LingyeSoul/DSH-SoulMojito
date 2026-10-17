# 源码大文件拆分（2026-10-17）

目标：把 agent 维护成本最高的源码文件按领域拆小，行为零变化。
生成物（`packages/plugin/*.mjs`、`client/index.js`、`packages/*/lib`）不在拆分范围内。

## 验收纪律

- 每个切片完成后运行 `pnpm check`（tsc + vitest + build + gates），必须全绿。
- 不提交 git，保持工作区 diff 供主人审阅。
- 拆分只搬代码与收敛接口，不改业务行为；需要改接口时先说明理由。

## Steps

- [x] Batch 1：宿主入口 `packages/plugin/src/index.ts`（4956 行 → 245 行；拆出 build-info/runtime/http/generation/session 等模块，`pnpm check` 全绿）
- [x] Batch 2：客户端 `packages/plugin/client/main.js`（10517 行 → 29 个分片，最大 902 行；构建改为按 `client-src/manifest.json` 顺序拼接，生成物 10523 行仅含头注释增量，gate 零改动，`pnpm check` 全绿）
- [x] Batch 3：agent 工具与 store（`agent-tavern/agent.ts` 1974 行 → 399 行；`agent-novel/agent.ts` 1504 行 → 112 行；`tavern-store/src/novel.ts` 2029 行 → 1664 行；工具顺序与 HEAD 逐项一致，gate 改为递归扫描，`pnpm check` 全绿）
- [x] Batch 4：文件预算 guardrail（`source-file-budget` gate：手写源码 800 行上限 + 显式 allowlist；80 行探针实测 FAIL 后删除，`pnpm check` 全绿）

## Batch 1 拆分设计

- `src/runtime.ts`：memoized 单例与可变运行态
- `src/build-info.ts`：版本/commit 解析
- `src/session/trace.ts`：宿主 turn 轨迹
- `src/assets/avatar.ts`：头像读取与 fallback
- `src/http/panel.ts`：guides / script / mvu / workbench 路由
- `src/http/memory.ts`：memory embed / maintenance 路由
- `src/http/novel.ts`：novel 路由、恢复、命令与会话事件
- `src/generation/pipeline.ts`：生成请求装配与执行
- `src/http/router.ts`：handleApi 的分发表
- `src/index.ts`：仅保留 name / inject / apply 装配

目标：入口 ≤ 400 行，其余文件 ≤ 800 行；不允许循环依赖。

## Batch 2 拆分设计

- 新增 `packages/plugin/client-src/` 源目录，按 `manifest.json` 顺序拼接为 `client/main.js`。
- 为什么不用 esbuild 重打包：esbuild 会重打印引号与格式，现有 gate 依赖大量精确源码标记；拼接保持单 factory 作用域与字节级文本，gate 零改动。
- 保留 `__DSH_BIND_CLIENT_SLOT__` 注入点与 `client/index.js` 产物名。
- `main.js`/`index.js` 变为生成物（带 Generated 头），分片才是编辑入口。
- 同步 gate：本轮无需修改任何客户端 gate。

## Batch 3 拆分设计

- `agent-tavern/agent.ts`：`createTools()` 按工具域拆到 `tools/*.ts`，输出 schema 单独成文件。
- `agent-novel/agent.ts`：同样按工具域拆。
- `tavern-store/src/novel.ts`：先抽纯函数与子域帮手（canon / outline / usage / owner / recovery），`NovelStore` 保留编排。
- 同步 gate：`agentTavernSourceFiles()` 改为递归扫描子目录，否则拆分后隔离检查会漏扫。
- 游戏引擎默认不拆（单款规则内聚）。

## Batch 4 设计

- 新增 `source-file-budget` gate：手写源码 800 行上限，超限必须拆分或登记带理由的 allowlist。
- 扫描范围：`packages/*/src/**` + `packages/plugin/client-src/**`；排除测试、脚本、生成物与 game engine。
- 当前 allowlist：`NovelStore` / `TavernStore` / `novel-model` / `http/router` / `generation/pipeline` / `memory-maintenance` / `mods/host` / `mvu` / `agent-novel` writer+driver / `card-workbench/tools-world` / 内置游戏引擎 / 小说面板分片。
- 负向验证：临时 801 行探针文件触发 FAIL，删除后 PASS。
