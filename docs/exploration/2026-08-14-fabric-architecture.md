# Fabric 架构调研（浅克隆 github.com/omdsh-dev/fabric @ 87d31bc）

> 调研日期：2026-08-14。所有文件引用基于浅克隆根 `E:\WorkProject\fabric\`。
> 用途：评估 Cordis Fabric 作为「dsh 酒馆化」深度改造层的可行性，盘点全部可挂载扩展点。

## 0. 定位

Cordis Fabric 是受 Minecraft Fabric 启发的 DSH mod 层，分三档能力：

1. **加载期代码转换引擎**（"Mixin"）——任意 npm 包的任意具名函数在被求值前重写（before/after/around/replace）。
2. **协作 Mod API**（"Fabric API"）——DSH 权威服务（tools/systemPrompt/commands/agent 事件/浏览器 command+slots）之上的薄 facade。
3. **bundle carrier + host patch**——把前两者接进真实 DSH（deepseek-harness）checkout。

对酒馆平台而言：协作层覆盖 prompt 注入（角色卡/世界书 = 有序 prompt 段 + 动态 context）、工具注册、命令、UI slots；低层 patch 是逃生舱（消息历史重写、LLM 请求塑造、会话持久化）。

> 2026-08-16 对 DSH `0.1.0-rc.6` 编译产物复核后，AgentTavern 的 `dsh-native` 模式不启用 Fabric：`dsh-agent-presets`、agent-scoped `dsh-system-prompt` 和原生 AgentLoop 已覆盖 profile、固定 context 与工具回流，容量行为直接服从 DSH。只有 `agent-managed` 的非破坏性历史投影仍需要未来的 `agent/context` seam；Fabric 仅保留为 source checkout 上验证该 seam 的版本门控 fallback。详见 [DSH AgentLoop 原生能力审计](2026-08-16-dsh-agentloop-native-audit.md)。

## 1. 核心机制

### 1.1 三个协作件

- **`FabricService`**（`packages/cordis-fabric/src/service.ts:32`，provide `ctx.fabric`）：`register(patch)`（:59）校验描述符、绑定调用方 fiber、存入进程内 runtime；`list/disable/enable/remove/owns/bindings`。patch handler 是**受信代码**，绝不由 YAML/模型输入反序列化。
- **`FabricRuntime`**（`packages/cordis-fabric/src/runtime.ts:112`）：Cordis 无关的 patch 状态 + 分发。`dispatch()`（:297）实现四种操作语义：`before` 改 `call.arguments` 后委托；`after` 观察/改写返回值（含 Promise settle 后，:316-331）；`around`/`replace` 调 `handler(record, invoke)`，`invoke()` 执行原函数体（:333-338）。
- **桥**（`packages/cordis-fabric/src/bridge.ts`）：`globalThis.__dshFabricBridge = { publish }`（key :18）。被转换代码以零 import 调 `publish(call)`；桥或 handler 缺席时回落原函数体（:64-69）。平台无关，Node/浏览器同一桥。

### 1.2 转换实际做什么（`packages/cordis-fabric/src/transform.ts`）

`registerFabricTransform`（:51）在 `@apm-js-collab/code-transformer` matcher 上装名为 `'fabric'` 的 Orchestrion transform。`createFabricTransform`（:88）把每个命中的函数改写为：

1. 快照 `arguments`（箭头函数从参数模式重建，:159-203）；
2. `traced = () => (原函数体).apply(this, args)`（:205-248）；
3. 组装 `FabricCall { id, operation, arguments, self, traced }`（:250-268）；
4. 函数体变为 `bridge ? bridge.publish(call) : traced()`（:271-301）。

注入名按文件唯一化防遮蔽（:595-611）；构造器拒绝（:93-102）；generator 以 `yield*` 委托（:309-381）。

**能拦截什么**：hooks 安装后加载的任何模块中的具名函数/方法/私有方法/esquery 选中节点——参数（before）、返回值（after）、整个调用（around/replace）。类型契约：`FabricOperation`（`src/types.ts:18`）、`FabricTarget`（:24，module + versionRange + filePath(s) + functionQuery/astQuery + index）、`FabricCall`（:53）、`FabricPatch`（:110，含 `required`/`priority`）。

### 1.3 hook 安装（`packages/cordis-fabric/src/node-loader.ts`）

- `bootstrapFabric(patches)`（:189）= 校验 + 展开 filePaths + `installFabricHooks`。`patchInstrumentation`（:70）生成 Orchestrion 配置；名字查询转 esquery 选择器（:131）。
- `installFabricHooks`（:485）装桥 + Node ≥22.22.3/24.11.1 的同步 `module.registerHooks`（:517-553）；低版本走异步 `module.register` 加载线程入口 `./hook-entry`（`src/hook-entry.ts:102`，pid 作用域共享 JSON 配置 :354-386）。CommonJS 由进程级 `Module.prototype._compile` 包装处理（:583）。模块身份用 npm 布局解析 + 最近 package.json 回退，**workspace 包可定位**（`moduleIdentity` :265）。
- 启动后校验：`checkRequiredPatches`（:204）——`required: true` 的 patch 零绑定则启动失败。
- 重转换/HMR：`retransformCommonJs`（:641）/ `retransformEsm`（:703）逐出模块缓存。
- **浏览器转换**（`src/browser-transform.ts`）：`createBrowserTransform`（:140）是 bundler 无关的 `(code, id) => output | null`；`createWatchedBrowserTransform`（:238）监视 patches JSON 驱动重建→HMR 链；运行时替代 `serveBrowserTransform(ctx, {route, patch, fallback})`（`src/serve.ts:84`）在 DSH webserver 上注册 EXACT 路由，服务「不属于自己」的 bundle 的转换副本。

**关键约束**（docs/fabric.md:56,138）：hook 必须在目标模块**首次 import 前**安装；Node 侧转换需预编译 JS（浏览器路径会剥 TS）。

## 2. 三包 API 面

### 2.1 `cordis-fabric`（纯转换服务，零 DSH import）

导出（`src/index.ts:13-53`）：bridge、hooks（bootstrap/check/expand/flush/install/retransform）、browser（transform/resolvers）、`serveBrowserTransform`、runtime、types、`FabricService` + `getFabric`（挂载感知访问器，`src/service.ts:157`）。浏览器半入口 `./client`（`src/client/index.ts`——`apply` 装桥并在浏览器 Cordis 树挂 `ctx.fabric`，:34-37）。

### 2.2 `cordis-fabric-api`（纯 peer 兼容 facade）

`ctx.fabricCompat`（`src/compat.ts:89`）：`buildCompatInstrumentations(config)`（:72）、`observe(name, listener)`（:219，稳定事件式观察）、`registerPatch/unregisterPatch/disable/enable`（:149-192，独占 id 命名空间）、`serveBundle(options)`（:201）。

### 2.3 `cordis-fabric-dsh`（DSH 侧 facade；entries 见 `package.json:9-44`）

根入口 `src/index.ts`：`inject = ['tools','systemPrompt','commands']`（:32）。子入口 `./agent` `./tools` `./prompt` `./commands` `./client` `./invariant` `./profile-bootstrap`。

| Facade | 位置 | 能力 |
|---|---|---|
| `ctx.fabricAgent` | `src/agent.ts:33` | `onCreated/onDisposed/onStatus(agent,'idle'\|'running')`（:50-70）；`inject(agent, message)`（:82）——经 Agent 持久注入路径追加**有日志、模型可见**的 user 消息。**刻意不暴露**循环内部/队列/会话改写（模块注释 :4-11） |
| `ctx.fabricTools` | `src/tools.ts:40` | `register(definition)`（:59）、`onPreExecute`（:68）/`onPostExecute`（:77）瀑布监听——不调 `next()` 即否决 |
| `ctx.fabricPrompt` | `src/prompt.ts:38` | `section({name, order, text\|fn, complete?})`（:57）、`context({name, order, text\|fn})`（:66，缓存安全的动态 context，物化为持久 user 快照）、`tools(provider)`（:75）、`variable(name, provider)`（:85） |
| `ctx.fabricCommands` | `src/commands.ts:34` | `register({name, description, input?, handler})`（:53）——模型回合外的人类斜杠命令 |
| `ctx.fabricClient` | `src/client/index.ts:118` | `registerCommand(contribution)`（:140，斜杠菜单 + `available(session)` + `ui` 行为对象如 `{kind:'popupSelect'}`）；`registerSlot(options, component)`（:150）；`registerKeyedSlot`（:178）——**keyed hole 的优先级仲裁**（`KeyedSlotOptions` :81，`onGain/onLost`，`SlotClaim` :70） |
| `./invariant` | `src/invariant.ts:47` | 在宿主 invariants 服务上注册（空）invariant 伴随 |
| `./profile-bootstrap` | `src/profile-bootstrap.ts` | `installFabricBootstrap(rows)`（:63）、`checkFabricRequiredPatches`（:80） |

端到端 Mod 样例：`packages/cordis-fabric-dsh/tests/fixtures/node_modules/fabric-api-fixture-mod/index.mjs`。

## 3. host-contracts.ts——DSH 内部结构的声明图

`packages/cordis-fabric-dsh/src/host-contracts.ts` 是工作区对私有 `@deepseek-ai/dsh-*` 宿主的唯一视图：

- **Agent**：`HostAgent { id, status, inject(message) }`（:20-30）；`HostUserMessage { id, content }`（:33-38）
- **Commands**：`HostCommandRegistry.register/list`（:204-209）
- **Tools**：`HostToolRegistry { register, schemas }`（:128-133）；瀑布决策 `HostPreToolDecision`（allow/deny/ask，:81-84）、`HostPostToolDecision`（accept 含 content/value/additionalContexts，或 block 含 feedback，:86-89）
- **SystemPrompt**：`HostSystemPrompt { section, context, tools, variable, assemble }`（:190-201）；`HostPromptSection` 含 **`complete?: true`——「此贡献即完整 system prompt」**（:151）；`HostPromptAssembly` 返回 sections/contexts/variables（:180-187）
- **浏览器**：`HostClientCommandRegistry`（:224）、`HostSlotRegistry { register(options, component) }`（:230）、`slots/changed` 事件（:298）
- **Webserver**：`HostHttpServer { port, register({kind:'exact'|'prefix', path, handler}) }`（:243-248）
- **Invariants**：`HostInvariantRegistry.register(packageName, installer)`（:257-259）
- **Context/Events 扩充**（:261-299）：`ctx.tools/systemPrompt/commands/command/slots/httpServer`；事件 `agent/created|disposed|status`、`tools/pre|post-execute`、`slots/changed`

其他揭示：浏览器服务 `slash`、`sessions`、`connection`（`tests/client-assembly.spec.ts:25-33`）；client UI 包名 `@deepseek-ai/dsh-client-ui-command` / `dsh-client-ui-slots`（`src/client/index.ts:5-6`）；宿主流形状 `PreparedLlmCall.stream(options): AsyncIterable<StreamChunk>`、`LlmCallConfig`、`Session/SessionProjectionMap`（`patches/fabric-host-integration.patch:497-509`）。

## 4. 与酒馆平台相关的扩展缝

### 4.1 Prompt 操纵（角色卡/世界书/预设）——一等公民

- `ctx.fabricPrompt.section`——有序命名段，按 `order` 升序拼接。角色卡 = 若干段；`complete: true` 可**整体接管 system prompt**（预设接管）。
- `ctx.fabricPrompt.context`——每次组装重算的缓存安全动态 context（世界书逐轮计算）。
- `ctx.fabricPrompt.variable` + `{{var}}` 插值（fixture 证实）。
- `ctx.fabricPrompt.tools(provider)`——逐次组装贡献/过滤工具 schema。
- **原始 LLM 请求拦截不在协作面内**（docs/fabric-api.md:93）。逃生舱 = 低层 patch（`ctx.fabric.register` / `ctx.fabricCompat.registerPatch`）对构建 provider 请求的宿主私有函数打 `around`，patch 桩声明在 profile 行 `config.fabric.patches`。

### 4.2 聊天/会话与消息流——部分暴露

- 生命周期：`ctx.fabricAgent.onCreated/onDisposed/onStatus`。
- 消息注入：`ctx.fabricAgent.inject`——有日志、模型可见、会话日志可重建（docs/fabric-api.md:117）。
- 工具结果驱动 context：`onPostExecute` 返回 `block + feedback + additionalContexts` 注入 user 角色 context。
- **对话历史刻意不上浮**（docs/fabric-api.md:91）。读/改历史或 token 流需要低层 patch 宿主函数，或 patch 访问器读 DSH 会话日志/SessionProjection。

### 4.3 UI

- **Slots 即 UI 扩展系统**：`ctx.fabricClient.registerSlot({name, children, store, inject, key, id, order, label, priority}, component)` 注入 `dsh-client-ui-slots` 拥有的 slot「洞」；完整 SlotMap 类型留在 DSH slot 服务（docs/fabric-api.md:126）。`registerKeyedSlot` 仲裁接管 keyed hole。
- 客户端命令：斜杠菜单 + popup UI 行为。
- 客户端 bundle 加载：浏览器插件是 `dshClient` 工件；bundle 以 `/plugins/<package>/client.js` 提供（host patch :300-302）。**本仓库无 `__ModuleLoader__` 符号**（grep 证实）——浏览器模块加载是 web roster 上的 Cordis Loader，client-HMR 走 stat 轮询 → `rebuilt` 帧 → fiber 换装。
- 改既有 DSH UI 代码：构建期 `clientBundle(..., {transform})`（host patch tsdown.client.ts hunk，:282-299）或运行时 `serveBrowserTransform` / `fabricCompat.serveBundle`。
- 类「控制台」面板不存在；最近似物是 slots 与 `httpServer` exact 路由原语。

### 4.4 工具

`ctx.fabricTools.register({name, description, schema, execute(args, {signal})}`——与原生 DSH 工具同义务（模型可见日志/渲染意图）；`onPreExecute` 门控。

### 4.5 设置/持久化

Mod = 普通 Cordis 函数插件（`name/inject/Config/apply`，AGENTS.md:6）→ 用户设置走 Cordis Loader 配置树（每 profile YAML 叠加、`$DSH_HOME/config.yaml`，docs/fabric.md:37-39）。无专用 KV/数据库 facade。角色卡/世界书文件存储的实际缝：插件自身 `node:*` 访问、Cordis `Config`、或 `ctx.httpServer.register` 自建 HTTP API。

## 5. Bootstrap 与安装

- `installFabricBootstrap(rows)`（`src/profile-bootstrap.ts:63`）在 boot `prepare` 阶段、任何配置树条目挂载前调 `bootstrapFabric`。宿主接线点：`apps/cli/src/profile-boot.ts` 于 `boot(...)` 的 prepare 回调内调用（`patches/fabric-host-integration.patch:62-76`）。
- **host patch**（712 行，基线 `7b9644f2`，上游 `1de04707`）改动：CLI `package.json` 加两个 git 子目录依赖（:15-28）；`profile-boot.ts` 启动器接线（:30-79）；`packages/boot/app-boot/src/profile.ts` 生成 profile 加 `blockExoticSubdeps: false`（:217-228）；`packages/bundle/web-app/cordis.patch.yml` 插入两行 disabled fabric 行（:231-250）；`packages/client/tsdown.client.ts` 加 `clientBundle` 源 transform 缝（:251-302）；`packages/extensions/tool-cordis/src/api-catalog.ts` 把 fabric 服务/类型补进编译期 API 目录（:303-508）。→ 揭示 DSH 宿主结构：`apps/cli`（commander CLI/boot/profile 组合）、`packages/boot/app-boot`、`packages/client`（浏览器构建工具）、`packages/bundle/web-app`（web-app bundle 层）、`packages/extensions/*`（官方插件）。
- `cordis.patch.yml`（根 :10-17）：两个 `insert` 行均 `disabled: true`（显式 opt-in）。安装：`dsh plugin --profile web add github:dsh-external/fabric` 后重启 web。
- 脚本：`scripts/patch.sh`（幂等 git apply）、`install.sh`、`extract-patch.mjs`、`prepare.mjs`、`verify-self-contained.mjs`（边界执法）。

## 6. Testkit

`cordis-fabric/testkit`（`src/testkit.ts`）：`runPatchFixture({patches, entry, args, cwd})`（:64）spawn 干净子进程（`--import tsx/esm`），runner 装补丁→import entry→跑默认导出→输出 JSON 信封 `{bindings, result, error, exitCode}`。`registerHooks` 不可注销且转换后模块留缓存——**每个 patch 场景需新进程**。

## 7. 可挂载扩展点总表（酒馆 mod 视角）

1. `ctx.fabricPrompt.section/context/tools/variable`——卡、书、预设、`complete` 接管（prompt.ts:57-87）
2. `ctx.fabricAgent.onCreated/onDisposed/onStatus/inject`——生命周期 + 消息注入（agent.ts:50-84）
3. `ctx.fabricTools.register/onPreExecute/onPostExecute`——新工具 + 门控 + context 反馈（tools.ts:59-85）
4. `ctx.fabricCommands.register/list`——人类命令（commands.ts:53-64）
5. `ctx.fabricClient.registerCommand/registerSlot/registerKeyedSlot`——斜杠菜单 + UI 洞 + 仲裁（client/index.ts:140-229）
6. `ctx.httpServer.register`——自建 exact/prefix HTTP 路由（卡片库 API 等）（host-contracts.ts:243-248）
7. Cordis `Config` + Loader profile 行——用户设置持久化
8. `ctx.fabricCompat.observe/registerPatch/serveBundle`——协作低层补丁 + 运行时 bundle 改写（compat.ts:72-255）
9. `ctx.fabric.register`（任意模块含私有宿主包，四操作）+ profile `config.fabric.patches`——LLM 请求塑造/历史访问/深度 UI 改写的逃生舱（service.ts:59）
10. 构建期 `clientBundle({transform})` + `retransformEsm/CommonJs`——开发期迭代

## 8. 必须规划绕开的缺口

- 协作面**无历史/流访问**、无专用存储服务。
- npm 安装的官方 `dsh`（预编译 CLI）**无法打 host patch**——fabric 三件套要跑起来需 deepseek-harness 源码 checkout（README.md:85-90,112）。
- 浏览器 patch 只对浏览器 runtime 物化后的调用生效（docs/fabric.md:54）。
- 宿主内部低层 patch 无稳定性契约——versionRange 漂移静默 no-op（docs/fabric.md:91）。

## 9. AGENTS.md 设计意图

三包恒定；其余一律 pnpm 依赖补丁；函数插件 `name/inject/Config/apply` 无默认导出；host contracts 只窄扩展；注册全部 scoped 到 fiber 且测 dispose；`workspace:^` 限仓内；docs/README/config/tests/cordis.patch.yml 同步更新；发布前五道验证命令。
