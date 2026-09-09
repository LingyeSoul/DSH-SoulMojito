# 新建 @dsh-tavern/bind 收编跨版本宿主形状兼容层

日期：2026-09-09。状态：已实施。

## Problem

插件对 DSH 宿主的行为兼容代码（纯 feature detection，无版本号检测）散落在
三处，且没有宿主形状的诊断出口：

- Node half 的会话事件日志探测在 `plugin/src/host-session.ts`（rc.6 的
  `events` 可变数组 vs 0.1.2 的私有 `log` + `snapshotEvents()` 冻结快照），
  被 index/projector/anchor 三处导入；
- 宿主包运行时解析 `importHostPackage`（`link:` 挂载下插件路径在宿主
  profile 之外，必须从安装锚 `process.argv[1]` createRequire 解析）内嵌在
  compaction curator，属于 compaction 语义之外的通用能力；
- client half 的 `connectTavernWorkspace`（0.1.2 把 connectWorkspace 挪到
  uiWorkspace 服务；rc.6 仍在 ctx.workspaces；声明注入 uiWorkspace 会让
  插件在 rc.6 上永远挂起，必须 declaration-free 探测）硬编码在 4100 行的
  `client/index.js` 里。

同一类「宿主形状知识」因此有三种形态：独立 shim 文件、类内私有函数、client
闭包内联。新兼容点该放哪里、已有哪些探测先例，全靠读代码背下来；插件在用户
环境里命中的是哪条绑定路径也无法从运行时确认，远程排查只能靠猜。

## Decision

- 新建纯库包 `packages/bind`（`@dsh-tavern/bind`），作为宿主形状知识的单源，
  加入根 tsconfig references；plugin 以源码相对导入方式消费，esbuild 内联，
  不引入运行时依赖（与 tavern-* 各包同模式）。
- Node half 收编三件：`host-session.ts`（原样迁移）、`host-package.ts`
  （`importHostPackage`，anchor 参数化为可选参数，默认仍取 `process.argv[1]`，
  便于测试）、`host-shape.ts`（新增）。边界：`createDshAgentTavernAdapter`
  与 capabilities 检查留在 plugin——它们产出的是 AgentTavern 域类型
  （`AgentTavernAdapter`），bind 只拥有宿主侧知识。
- 新增宿主形状诊断：`describeHostShape(ctx, session?)` 返回
  `{ sessionShape, services, checkedAt }`，`probeSessionShape` 的命中顺序与
  `readSessionEvents` 的读取顺序严格一致（events > snapshotEvents > log）。
  插件 `apply()` 时输出一行 `dsh-tavern host shape: {...}` 日志（经
  `ctx.logger?.info?.`，通道缺失则静默）。
- client half 收编为 `bind/src/client/host-probe.ts`（`connectHostWorkspace`
  双面回退 + `ClientShapeTrace` 轨迹）。client half 走宿主 ModuleLoader 的
  `factory(require)`，只能 require 宿主注入模块、无法相对 import 本地文件，
  共享代码只能构建期内联：源文件改名 `client/main.js`，factory 顶部留
  `// __DSH_BIND_CLIENT_SLOT__` 标记，`scripts/build-plugin.mjs` 把 host-probe
  打成 IIFE（`var DshBindClient = (() => {...})()`）替换标记，生成产物
  `client/index.js`（gitignore，不再手改）；轨迹同步挂
  `window.__DSH_TAVERN_BIND__` 供诊断读取。
- 探测函数的测试直接打 bind 包（`packages/bind/tests/`，vitest 通配覆盖），
  双形状 mock（rc.6 events / 0.1.2 snapshotEvents）在 bind 与 plugin 两侧
  各自成立：bind 测探测函数本身，plugin 测完整 agent 形状下的行为。

## Alternatives considered

- 保持现状散落：零迁移成本，但形状知识继续三处三形态，且无诊断出口，每次
  宿主升级（0.1.2 的两次破坏已验证）都要重新全仓库找探测点，否决。
- bind 作为独立 npm 包发布供其他 DSH 插件复用：本仓库所有包都不发布
  （profile 以 link 挂载源码），独立发包需要版本化宿主形状契约的维护承诺，
  现阶段消费方只有 dsh-tavern 一个，先按 workspace 内部包生长，否决。
- client 片段注册成第二个 ModuleLoader 模块供 require：宿主 ModuleLoader
  的 require 解析面只覆盖宿主注入模块，本地模块注册机制无先例、不可验证，
  否决；构建期 IIFE 拼接不依赖宿主任何新能力。
- 在 client half 保留一份独立实现、仅注释互指：两份实现必然漂移（本仓库
  已有一次「repair 脚本与验证器 region 名漂移」的教训），拼接方案成本一次
  性且由 `__DSH_BIND_CLIENT_SLOT__` 缺失即报错兜底，否决。

## Consequences

- `client/index.js` 从手写源变成构建产物：直接改它会被下次构建覆盖，改动
  必须落在 `client/main.js`（正文）或 `packages/bind/src/client/host-probe.ts`
  （探测逻辑）；挂载 profile 前必须先跑 `pnpm run build:plugin`（README
  原有流程已如此要求，行为未变，但产物缺失从「不可能」变为「未构建」）。
- `connectHostWorkspace` 在两代宿主均无连接面时抛语义化
  `no workspace connect face...`，替代原先的
  `TypeError: ctx.workspaces.connectWorkspace is not a function`；两代宿主
  正常路径行为不变，轨迹记录（trace）为纯旁路。
- `verify-tavern-history.mjs` 的 bundle 区域多候选探测仍留在脚本内：那是
  离线校验器对宿主构建产物布局的知识，不是运行时 API 兼容，收编进 bind
  反而混淆包的职责；后续若出现更多消费方再议。
- bind 的 lib 产物只服务 `tsc -b` 增量检查与包边界，plugin bundle 一律从
  bind 的 src 相对导入，与 tavern-* 各包一致。
