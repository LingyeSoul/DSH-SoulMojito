# 提案 0015：Mod 扩展接口与加载机制（设计）

> 状态：P0-P2 已实现（c14c949；详见 decisions/2026-10-10-mod-p0-hook-buses.md、
> 2026-10-10-mod-p1-loader.md、2026-10-10-mod-p2-capabilities.md；P3 分发另立提案）。日期：2026-10-10。
> 参照物：SillyTavern 扩展双体系（UI 扩展 manifest.json + eventSource + generate_interceptor；
> 服务端插件 `init(router)`/`exit()`/`info` 挂 `/api/plugins/{id}/`，官方明示**不沙箱**、需
> `enableServerPlugins` 显式开启）。本提案只借鉴其接口形态与信任立场，不复制实现，
> 亦**不承诺兼容或加载 ST 扩展本体**（见 §6 裁剪）。

## 1. 目标行为（Working Backwards）

**PR**：Mod 开发者把一个带 `mod.json` 的文件夹放进 `$DSH_HOME/tavern/mods/`，在 Tavern 管理面板
「Mod」分区看到它（默认禁用），点启用后：他注册的 Agent 工具出现在模型工具面、他的文本变换挂进
ST 生成管线、他的宏/STscript 命令即刻可用、他的面板分区以隔离 iframe 形态出现在管理面板里、他的
HTTP 路由挂在 `/api/dsh-tavern/mods/<id>/` 下。全程不改 dsh-tavern 一行源码、不需要重新安装插件、
一个坏 Mod 不会拖垮酒馆本体。

**客户与验收**：
- Mod 开发者：不 fork 仓库即可扩展六类现有面做不到的事（跨相位管线组合、注册表扩展、新工具、
  新面板分区、新 HTTP 路由、长生命周期任务）；API 有版本承诺。
- 玩家：默认全关；启用前看到 Mod 声明的能力面（知情同意）；单个 Mod 加载失败只跳过并报错，
  本体照常工作；禁用/删除不留残留行为。
- 维护者：核心 44 条路由、隔离纪律、gates 全部不被 Mod 绕过或稀释。

## 2. 既有事实盘点（2026-10-10 深度探索结论）

### 2.1 五类现成挂载点（服务端）

| 挂载点 | 位置 | 现状 |
|---|---|---|
| HTTP 路由 | `ctx.webServer.register({kind:'prefix', path:'/api/dsh-tavern'})`，`src/index.ts:435-468` 级联分派 | 加子路由零宿主成本；44 条路由被 `server-bundle` gate 逐字锁定 |
| Agent 工具 | `tool()` 工厂 + `ctx.tools.register`，`src/agent-tavern/agent.ts:171-177, 124-128` | 无统一 registry，三组 preset 各自 `createTools()` |
| prompt 分区 | `ctx.systemPrompt.section/context({name, order, text})`，`agent.ts:65-111` | 核心占用 order -80..-64（kernel/-80、preset/-75、facts/-70、guides/-65、script/-64） |
| 事件 | 宿主 `session/event`/`agent/created`/`agent/request`/`agent/pre-step` + 跨 bundle `createGlobalListenerRegistry`（`src/cross-bundle-events.ts:23-46`，globalThis Symbol.for） | guides-changed / agent-preset-changed 两条内部总线在用 |
| 面板 API | `POST /state` 写 `state.json`、`GET bootstrap` 聚合投影、3s store-revision 水位轮询 | 轻量投影样板：`worldEntryCounts`（`src/index.ts:521-530`） |

### 2.2 缺口（当前完全没有的东西）

- **动态加载机制本身**：五个 Node bundle 是 esbuild `packages:'bundle'` 零 external 的死产物
  （`scripts/build-plugin.mjs:28-103`）；新代码唯一官方入口是 update service 的 pnpm git 安装且强制
  restart（`src/update/apply.ts:235-281`）。唯一运行时动态 import 先例是 `importHostPackage` 按 URL
  取宿主包（`packages/bind/src/host-package.ts:18-27`）——这正是 Mod 加载器要复用的模式。
- **ST 生成循环无中间件**：`runGeneration`（`src/index.ts:2521-2912`）是单函数内联调用链，外部无法
  在装配前/模型调用前/落盘前挂变换。
- **注册表封闭**：STscript 命令是固定 switch（`packages/tavern-script/src/stscript.ts:208-332`）；
  宏引擎 `registerMacro` 预留但零使用（`packages/tavern-macros/src/engine.ts:485-503`）；管理面板
  分区是 `PANEL_SECTIONS` 常量 + 13 分支三元链（`client/main.js:5255-5269, 7631-7644`），新增分区
  要改 4 处。
- **客户端加载外部 JS 被双向封死**：宿主 ModuleLoader 只允许 9 个平台包字面量 require
  （gates `run.mjs:89-99, 382-390`），仓库纪律「第三方值必须走注入服务，不能走 client 端包导入」。

### 2.3 既有三级隔离与 Mod 的分工边界

| 隔离级 | 承载面 | 适用 |
|---|---|---|
| `node:vm` 沙箱（同信任域，已声明不承诺对抗恶意） | EJS 模板（`packages/tavern-template/src/runtime.ts:95`，TemplateHost 适配层） | 卡片/世界书作者的提示词逻辑 |
| iframe 沙箱（跨信任域） | 美化前端（`client/main.js:149-172`，`sandbox="allow-scripts"` 无 same-origin + CSP `connect-src 'none'` + token postMessage） | 模型/卡片产出的展示性 UI |
| 声明式配置 + 确定性执行器 | STscript 封闭命令、regex IR、MVU 声明批、VariableStore CAS/配额/审计 | 高频可审计的用户自动化 |

**不该由 Mod 重复造的**：提示词内计算（模板面已有变量族/资产读取/注入/回执重试）、文本改写
（regex 四 placement + promptOnly/markdownOnly 已覆盖落库/prompt/展示三层）、消息内 UI（iframe 面
已覆盖）、简单聊天自动化（STscript 已覆盖）。**只有 Mod 能做的**：跨相位管线组合、注册表扩展
（宏/STscript 命令/面板分区）、新 Agent 工具、新 HTTP 路由、长生命周期任务、组合上述任意多项。

## 3. 设计

### 3.1 Mod 是什么

**Mod = 一个自包含 ESM 文件夹 + `mod.json` 清单，由服务端 Node half 在进程内加载的受信任第三方
代码**。信任模型与 ST 服务端插件对齐：进程内、不沙箱、默认禁用、显式启用（详见 §3.6）。UI 扩展
不加载第三方 JS 进宿主页面，而是走**服务端声明 + 隔离 iframe 表面**（§3.5），与三级隔离纪律相容。

命名说明：仓库内 `scripts/`（剧本游玩，提案 0014）与「脚本」一词撞车，本提案统一用 **Mod** 一词，
落盘目录 `<tavern>/mods/`。

### 3.2 目录、清单与加载

```
$DSH_HOME/tavern/mods/<mod-id>/
  mod.json          # 清单（加载前可读，不执行任何代码）
  index.mjs         # 入口 ESM（main 字段指定，相对路径）
  data/             # api.storage 私有数据（由宿主创建与管理）
  node_modules/     # 可选：Mod 自带依赖（bare specifier 相对本目录解析，天然可达）
```

```jsonc
// mod.json
{
  "id": "com.author.mood-tracker",        // 反域名或 [a-z0-9-]，加载时去重校验
  "name": "Mood Tracker",
  "version": "1.0.0",
  "author": "…",
  "description": "…",
  "main": "index.mjs",
  "engines": { "dsh-tavern": ">=0.5.0 <0.6" },  // semver 范围，装载时校验
  "loadingOrder": 100,                     // 多 Mod 顺序（ST loading_order 先例）
  "capabilities": ["llm"],                 // 知情同意标签：llm | network | storage
  "panel": { "title": "心情追踪", "icon": "sparkle" }  // 可选：声明面板分区
}
```

```js
// index.mjs —— 唯一入口约定
export async function setup(api) {   // 返回可选 dispose()（ctx.effect 同构）
  const off = api.hooks.on('post-output', async (text, ctx) => text.replace(/…/g, '…'))
  return () => off()
}
```

**加载器**（新增 `src/mods/`：`loader.ts`/`host.ts`/`registry.ts`）：

- 时机：`apply()` 内 stores 初始化之后扫描 `mods/` 目录；逐 Mod try/catch（坏 Mod 只记录
  `mods/audit.jsonl` + state 错误位，跳过不断路——与坏世界书 JSON 不 500 bootstrap 同教义，
  `src/index.ts:521-530`）。
- 方式：`import(pathToFileURL(entry).href)`——复用 `importHostPackage` 已验证的 URL 动态 import
  模式；bare specifier 走 Node 标准解析，Mod 自带 `node_modules/` 可达、宿主内部包不可达。
- **重载**：`POST /api/dsh-tavern/mods/<id>/reload` → 调旧 `dispose()` → 带 `?t=` 户 timeStamp 的
  cache-bust 重新 import。**ESM 实例驻留是已知限制**：模块级副作用无法回收（globalThis 监听表因此
  要求 Mod 一律经 `api.*` 注册、宿主持有 off/disposer 全量反注册；与 ST 服务端插件同等承诺）。
- 禁用：state.json `mods.enabled.<id>` 默认 false + 全局 `modsEnabled` 默认 false + 环境变量
  `DSH_TAVERN_DISABLE_MODS=1` 硬关（三层，对齐 `DSH_TAVERN_DISABLE_UPDATE_CHECK` 先例）。

### 3.3 API 面（v1，`modApiVersion: 1`）

全部经**适配层注入**（TemplateHost 模式：不透传 cordis ctx，宿主能力白名单化），逐项对应 §2.1 的
挂载点：

| API | 语义 | 关键约束 |
|---|---|---|
| `api.logger` | 带 `[mod:<id>]` 前缀的宿主日志 | — |
| `api.storage.{get,set,delete}` | 私有 JSON kv，`<tavern>/mods/<id>/data/state.json`，`writeAtomic` 落盘 | 单值 256KB / 总量 1MB 配额（VariableStore 配额先例） |
| `api.assets.*` | 只读快照：角色卡/世界书/预设/聊天列表与内容（deepClone，复用 store 读 API） | 无写路径；聊天写回一律走 hooks 变换 |
| `api.hooks.on(phase, handler)` | ST 管线五相位（§3.4） | 顺序 waterfall；单 hook 超时 10s（Promise.race）后降级跳过并计数 |
| `api.tools.register(def)` | Agent 工具，形状对齐 `tool()` 工厂（name/description/parameters/output/execute） | name 必须 `<modId>_` 前缀；与 60 个内置工具查重，冲突即拒 |
| `api.macros.register(name, fn)` | 接线到三处引擎实例化点 | 对齐既有 `registerMacro` 契约（engine.ts:485） |
| `api.stscript.registerCommand(name, spec)` | 命令表 registry 化后开放 | 命令名字符集校验，禁覆盖内置命令 |
| `api.http.route(method, path, handler)` | 挂 `/api/dsh-tavern/mods/<id>/<path>` | path 字符集白名单；`reply.json()/html(doc, csp?)` 两个出口；html 出口自动注入标准 CSP meta |
| `api.events.on(kind, handler)` | `chat-saved`/`assets-saved`/`guides-changed` | 复用/补齐既有内部事件发射点 |
| `api.llm.{request,stream}` | 代理 `ctx.llm` | 仅 `capabilities` 含 `llm` 时注入该键；用量记入审计线 |
| `api.timers.{setInterval,clearInterval}` | 经 `ctx.effect` 绑定生命周期 | 宿主卸载自动清 |
| `api.onDispose(fn)` | 追加清理 | 与 setup 返回的 dispose 合并 |

**能力声明是知情同意标签，不是强制隔离**——进程内代码天然握有 `process`，`capabilities` 的作用
是让启用确认界面如实展示「此 Mod 会调用模型/发网络请求/大额落盘」，配合审计线事后可查。这是对
ST「plugins are not sandboxed, only install from trusted developers」同款诚实立场。

### 3.4 ST 管线 hook 相位（核心改动，P0 落空总线）

`runGeneration` 的五个既有变换点直接升格为 Mod hook 位（行号为当前实测）：

| 相位 | 位置（`src/index.ts`） | 输入→输出 | 语义对齐 |
|---|---|---|---|
| `user-input` | :2587（USER_INPUT regex 旁） | 文本→文本 | 与 regex 同位的可组合变换 |
| `pre-assemble` | :2743（assemblePrompt 前） | 装配输入 draft→draft | lore/历史/卡/预设可改 |

注：群聊 nudge 注入（决策 `decisions/2026-10-10-group-nudge-and-regex-slash.md`）
已落位在该缝隙——nudge 作为合成 user 楼层位于装配输入 `messages` 末尾，本 hook
落地后即是第一个既有受益者（mod 在 draft 中可见并可改写 nudge）。
| `pre-llm` | :2837（llm.stream 前） | `{messages, system, params}`→同形 | 对齐宿主 `agent/request` waterfall 语义 |
| `post-output` | :2858（AI_OUTPUT regex 旁） | 文本→文本 | 与 regex/renderOutput 同位 |
| `post-save` | :2906（saveChat 后） | 只读观察 | 对齐 `session/event` 落盘后语义 |

顺序：`loadingOrder` 升序；Mod hook 失败=降级（日志 + 审计计数 + 该相位跳过），**不中断生成**
（renderText 失败保原文同款纪律，`src/template.ts:304-311`）。

**AgentTavern 侧的 prompt hook 是另一条腿**：`api.prompt.section({name, text})` 经 globalThis 注册表
（§3.6）进入 agent bundle 的 section 注册面；order 由宿主钳制在 Mod 专属区间（核心占用 -80..-64，
Mod 允许 -50..0，防止冲掉 kernel/preset）。Mod 工具同理进入 AgentTavern/AgentNovel 工具面。ST 循环
hook 与 AgentTavern section/tool 的**不对称是刻意的**：两种架构本来就不对称（ST 自有循环 vs 宿主
AgentLoop），Mod 文档如实标注各自覆盖面。

### 3.5 面板与 UI 扩展（不加载第三方 JS 的路线）

- **客户端一次性改造（P0）**：`PANEL_SECTIONS` 常量 + 三元链重构为
  `{id, icon, label, component}` 注册表 + `registerPanelSection()`；i18n 走宿主 locale thunk 先例。
  现有 13 分区行为零变化，gates 同步。
- **Mod 面板 = 声明式清单 + 通用渲染器**：bootstrap 新增 `mods` 轻量投影（id/name/version/enabled/
  错误位/panel 声明）；客户端把启用 Mod 的声明分区追加进导航；分区 body 是通用 `ModSurface` 组件
  ——iframe 指向该 Mod 的 `api.http` 路由（如 `GET mods/<id>/ui` 返回自包含 HTML）。
- **iframe 纪律完整继承美化前端先例**（`client/main.js:149-172` + `decisions/2026-08-16-frontend-html-
  runtime.md`）：`sandbox="allow-scripts"` 无 same-origin、服务端注入 CSP meta、token 校验的
  postMessage。Mod UI 取数不能 fetch（CSP `connect-src 'none'` 延续），走**postMessage 数据桥**：
  iframe 发 `{type:'dsh-tavern:mod-request', token, req}` → 父页代理到该 Mod 的 HTTP 路由 → 回投
  `{type:'dsh-tavern:mod-response', token, …}`。高度上报协议（main.js:104-158）原样复用。
- **核心新增「Mod」管理分区**（第 14 个）：列表（清单信息、能力声明、加载/错误状态、审计计数）、
  启用/禁用、重载、打开 Mod 面板分区；启用确认弹层展示 capabilities 与 hooks/tools/http 声明。

### 3.6 跨 bundle 接线（globalThis 注册表）

Mod 宿主只活在 index bundle（`apply` 内加载）。工具/section 要在 agent bundle（agent.mjs）生效，
沿用**已验证的跨 bundle 模式**：注册表锚定 `globalThis[Symbol.for('dsh-tavern:mod-registry')]`
（`cross-bundle-events.ts:23-46` 同构），变更经 `dsh-tavern:mods-changed-listeners` 写穿通知。

接线细节有一个**P1 必须实测的宿主语义**：`ctx.tools` 注册是 host 全局还是 preset 域。两条路线都
已备好且 **`api.tools.register` 对 Mod 作者的形状不变**：(a) 若全局——mod 宿主直接在 index bundle
的 ctx（inject 已含 `'tools'`，`src/index.ts:105`）注册；(b) 若 preset 域——agent bundle 的
`createTools()` 吸收注册表快照 + 订阅增量。新工具对既有会话的可见性不承诺免 recompose 生效
（与内置工具 recompose 语义一致），新会话必然可见。

### 3.7 版本与兼容

- `engines.dsh-tavern` semver 范围装载时校验，不满足=跳过并在面板报原因（不 crash）。
- `modApiVersion: 1` 常量由 `api.version` 暴露；未来破坏性变更升 2 并在 Mod 面板标不兼容。
- 多 profile 共享同一 `<tavern>/mods/`（与数据层无 per-profile 的现状一致，§5 记风险）。

## 4. 阶段划分

- **P0（核心缝隙，纯重构零行为变化）**：runGeneration 五 hook 空总线、STscript 命令表 registry 化、
  `PANEL_SECTIONS` registry 化、宏注册表接线到三处实例化点、bootstrap `mods` 投影占位。全量
  vitest + 14 gates 保持绿。
- **P1（加载器与最小可用）**：`src/mods/` 加载器、manifest 校验、三层开关、Mod 管理面板分区、
  `api.{logger,storage,assets,events,timers,http}`、审计线、`POST mods/<id>/reload`、新 gate
  `mod-loader`（§6）。交付物：一个示例 Mod（资产只读统计）。
- **P2（能力面扩展）**：`api.{tools,hooks 全相位,macros,stscript,llm}`、`api.prompt.section` +
  order 钳制、Mod UI iframe 表面 + postMessage 数据桥、git 安装复用 update service 的 GitHub 源
  降级链（`src/update/sources.ts`）。交付物：示例 Mod（带工具 + 面板 + 管线 hook 三件套）。
- **P3（生态可选，另立提案）**：Mod 分发索引。

## 5. 风险与开放问题

- **宿主工具可见性语义**（§3.6 双路线，P1 实测定案）。
- **ESM 实例驻留**：热重载不回收模块级副作用；靠「注册必须走 api.*、宿主持全量 disposer」纪律
  缓解，文档明示。
- **信任边界靠流程而非技术**：恶意 Mod 在进程内无解（与 ST 同立场）；缓解=默认关 + 知情同意 +
  审计 + 官方渠道分发时的源码要求（README 已有 GPL-3.0 clean-room 声明惯例）。
- **Mod 拖慢生成**：五相位全部有 10s 单 hook 超时 + 降级；审计计数在面板可见，玩家可定位卸载。
- **多 profile 共享 mods**：desktop/web 同机时共用一份（与 tavern 数据现状一致）；未来若需要
  per-profile 再立提案。
- **gates 膨胀**：`mod-loader` gate 用 selfTest 反样本模式（既有 gates 惯例）锁定「默认关、目录
  白名单、超时常量在 bundle、禁用时 mods 路由 404」四不变量。

## 6. 明确裁剪（与理由）

| 裁剪 | 理由 |
|---|---|
| 客户端 JS Mod（宿主页面跑第三方代码） | 宿主 ModuleLoader 白名单 + gates 纪律双向封死；与「第三方值走注入服务」既定决策冲突。UI 需求由 §3.5 iframe 表面承接。 |
| vm 沙箱化 Mod 模块 | `vm.Script` 无法承载异步 ESM 与富 API（`--experimental-vm-modules` 不可依赖）；且仓库教义已声明 vm 不承诺对抗恶意（runtime.ts:1-7）——假沙箱只产生虚假安全感，不如 ST 式诚实声明。 |
| 热卸载/热禁用的完全保证 | ESM 实例驻留（上文）；禁用=停止注册与效果，残留上限=模块闭包。 |
| Mod 直写聊天/资产 | 聊天写入牵动 CAS、投影、v4 会话准入三重纪律；v1 一律走 hooks 变换由核心落盘。 |
| 透传宿主 cordis ctx | 违反适配层注入纪律（TemplateHost 模式）；宿主内部面不是稳定契约。 |
| ST 扩展兼容（TavernHelper / eventSource / UI 扩展与服务端插件形态） | **永久非目标**，非延期：兼容层意味着长期追随 ST 内部 API 演进并承接其全部表面积，与仓库「只实现公开规范与可观察行为语义、clean-room」的既定边界（README 许可节）冲突；dsh-tavern 的 Mod API 是自有契约，不为任何外部插件格式做垫层。注意区分：ST **资产格式**（卡/世界书/预设/正则/chat JSONL）兼容是插件本体的既有职责，不受影响——裁的是扩展面，不是数据面。 |
| Mod 市场/自动更新 | 分发另立提案；v1 手动/git clone 放目录，P2 复用 update 源做 git 安装。 |
