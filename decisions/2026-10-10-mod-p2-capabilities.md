# Mod P2：能力面扩展（hooks/tools/macros/stscript/llm/prompt + iframe 表面 + git 安装）

日期：2026-10-10。状态：已实施。关联：提案 `docs/proposals/0015-mod-extensions.md`
（§3.3 API 面、§3.4 五相位与不对称、§3.5 iframe 表面、§3.6 跨 bundle 接线、§4 P2
定义）、`decisions/2026-10-10-mod-p0-hook-buses.md`（五条注册表骨架）、
`decisions/2026-10-10-mod-p1-loader.md`（加载器与三层开关）。

## Problem

P1 交付了「Mod 能装进来」；P2 交付「装进来的 Mod 能做什么」：`api.{hooks 全相位,
tools, macros, stscript, llm, prompt.section}` 六个能力面、Mod UI iframe 表面 +
postMessage 数据桥、git 安装复用 GitHub 源降级链、启用确认弹层的注册面展示、
三件套示例 Mod。其中 §3.6 留了一个明示的开放问题（`ctx.tools` 宿主语义）需要
实测定案。

## Decision

### 1. ctx.tools 宿主语义定案（提案 §3.6 的开放问题）

**结论：按「挂载域」语义实施（提案双路线的 (b)），且该路线在两种宿主语义下都
正确（并集安全）。**

定案过程（证据链，非猜测）：

1. **宿主运行时不可直接观测**。DSH 宿主（@deepseek-ai/*）不在本仓库
   node_modules——插件独立开发、类型自持，gates 用 stub ctx 探测。对真机的
   `ctx.tools` 做黑盒实验在本仓库内不可能。
2. **结构性证据（cordis.patch.yml）**：preset 插件经
   `ctx.agentPresets.recompose(agent.ctx, id)` 挂载——agent.ts 的 apply 拿到的
   是 **agent 会话域的 ctx**，不是插件级 ctx。三个 preset（agent-tavern /
   agent-novel / card-workbench）各自挂载各自的域。
3. **行为证据（agent.ts 自注释）**：`preheatAgentPresetProjections` 的注释
   「模块级幂等（apply 可能被宿主重复调用）」——每次 recompose 重新挂载，
   apply 被重复调用；`ctx.effect(() => ctx.tools?.register?.(tool), ...)` 的
   effect-工厂-返回-disposer 形状即「mount 注册 / unmount 反注册」的域语义设计。
4. **提案自身的暗示**：§3.6 写「新工具对既有会话的可见性不承诺免 recompose
   生效（**与内置工具 recompose 语义一致**）」——内置工具有 recompose 语义
   = 注册绑定在挂载时刻 = 域语义。
5. **实验（tests/tavern-mods.spec.ts「agent bundle absorption」describe）**：
   双 fake ctx 模拟两次挂载，实测：每次挂载独立吸收快照、独立反注册
   （`disposeA` 后 mountB 不受影响）；挂载后注册的工具经 mods-changed 写穿
   补注册；mod 卸载后包装工具 execute 拒绝。mod-loader gate 里另有真 bundle
   级实测：同一子进程 import index.mjs（装载 mod）+ import agent.mjs（挂载），
   agent 的 fake ctx.tools 收到 mod 工具与内置工具并列。

**为什么 (b) 是并集安全**：经 agent bundle 自己的 ctx 注册——若宿主实为全局
注册表，任何 ctx 的注册等价（同一服务）；若宿主为挂载域，agent ctx 恰是正确
的域。反向路线 (a)（index bundle 插件级 ctx 注册）在挂载域语义下落空（插件级
ctx 的 tools 注入在域语义下没有自然消费者），被否决。index.ts 虽 inject 了
`'tools'` 但从不使用，保持原样。

实施形状（`src/mods/agent-mount.ts`，agent.ts 与 agent-novel/agent.ts 的 apply
末尾调用——提案 §3.4「Mod 工具同理进入 AgentTavern/AgentNovel 工具面」）：

- apply 时吸收 `modToolSnapshot()`/`modSectionSnapshot()`（globalThis 注册表，
  见 §2），经本 ctx 注册；订阅 `dsh-tavern:mods-changed-listeners` 增量同步
  （写穿通知异步、监听器内部抛错被 registry 吞——与 guides/preset 总线同纪律）；
  ctx.effect 清理时反注册本挂载的全部注册（apply 会被重复调用的幂等性由此保证）。
- 工具注册的是**包装器**：静态面（name/description/parameters/output.schema）
  来自注册时刻的定义，execute/render 在调用时**活查注册表**——mod reload 换
  execute 行为不需要重新挂载；静态面变化（指纹比对）才经宿主通道反注册旧包装
  再注册新包装；mod 卸载后活查落空，包装 execute 抛可读错误。
- 内置工具名运行时认领：apply 把自己的 createTools() 名单经
  `claimHostToolNames()` 写入注册表保留集——静态种子的运行时防漂移层。

### 2. 跨 bundle 注册表形状（`src/mods/cross-bundle.ts`）

- 锚定 `globalThis[Symbol.for('dsh-tavern:mod-registry')]`，存
  `{ tools: Map<key, entry>, sections: Map<key, entry>, builtinNames: Set, nextSequence }`
  ——cross-bundle-events.ts / 宏 host-registry 同学科（模块级状态跨 bundle 不互见，
  key 字符串是互见契约）。
- key 是 `${modId}\u0000${name}`（mod 域内身份）+ `sequence`（反注册凭据：
  只摘自己那一次注册，重载后的旧 disposer 不误删新注册）。
- 变更经 `createGlobalListenerRegistry('dsh-tavern:mods-changed-listeners')`
  emit（fire-and-forget、逐个吞错）；读侧重读快照做差分。
- 内置工具名保留集双层：静态种子（三组 preset 的 createTools 全名单，59 个去重）
  + 运行时认领。静态份的漂移由 vitest 对账（agent-tavern-tools.spec 等既有
  名单断言间接锁定 + 本文件名单提取自真实 grep）。

### 3. P2 六个 api 面（`src/mods/host.ts` createApi）

- **hooks.on(phase, handler)**：接 P0 单例 `generationHooks.register`，order=
  manifest loadingOrder，**owner=mod id** 归因（总线新增 owner 字段与
  `onDegradation` 订阅面——P0 结构的增量扩展，空总线行为不变）。降级经
  ModHost.open 时的订阅进审计线（`hook-degradation` 事件，含 phase/reason/
  detail）与面板 auditCount；总线已有的超时/抛错/忘 return 降级不中断生成
  语义原样继承。反注册句柄入 `offRegistrations`（unload 执行）。
- **tools.register(def)**：形状校验对齐 `tool()` 工厂（name/description/
  parameters/output{schema,render}/execute）；name 必须 `<modId>_` 前缀 +
  `[A-Za-z0-9][A-Za-z0-9._-]*` 白名单；查重三层（同 mod 重名 / 内置保留集 /
  其他 mod——前缀规则使跨 mod 撞名结构性不可能，保留集是纵深防御）。拒绝在
  setup 期抛错 → 状态错误位。
- **macros.register(name, fn)**：接 P0 `registerHostMacro`。四道防线：
  (a) 名字校验（非空/无大括号/无空白 + **内置宏名拒绝对**——`reg()` 是
  Map.set 后写胜，`{{char}}` 劫持会烧掉全部求值上下文；引擎包新增
  `builtinMacroNames()` 导出，在吸收宿主宏之前快照内置键集）；
  (b) **确定性静态筛查**（fn.toString() 匹配 Math.random/Date.now/new Date/
  performance.now/hrtime/crypto./setTimeout/setInterval/process.env 即拒）——
  mod 宏进入 prompt-safety 冻结求值上下文（P0 决策注记），非确定宏烧 system
  头字节稳定承诺；命名函数闭包源不可见，这是声明式防线不是隔离（文档义务）；
  (c) 运行时包装：抛错 → null（保原文，与引擎 registerMacro 的 catch 双保险）
  + `macro-error` 审计**首次一次**（不刷屏）；Promise/对象等非同步返回 → null
  保原文；(d) 跨 mod 重名拒绝。
- **stscript.registerCommand(name, spec)**：名字 `^[a-z0-9_]+$`（对齐
  parseCommand 的 `/^\/([a-zA-Z0-9_]+)/` + 小写化命名律）；禁覆盖内置
  （查 `stscriptCommandNames()`）；tavern-script 的
  `registerStscriptCommand` 增补返回反注册（void → () => void 向后兼容，
  只摘自己那一次注册）。STscript 只在 index bundle 执行（runTavernScript），
  模块级命令表即互见，无需跨 bundle。
- **llm.{request,stream}**：**仅 manifest capabilities 含 `llm` 时在 api 对象上
  挂键**（不含则键不存在——`typeof api.llm === 'undefined'`，知情同意的技术
  强制面，gate 与 vitest 双实测）。`stream` 透传 ctx.llm.stream 并在结束/失败
  审计（`llm-call`：provider/model + usage token 数；`llm-error`）；`request`
  是 stream 的收集出口（text/reasoning/usage/finish）——dsh-llm 的非流式面
  不承诺存在，自收集保证形状确定。失败原样抛给 mod；mod 丢弃 request promise
  时观察分支兜底（storage 同款：审计 + 日志，等待方仍拿原拒绝，无进程级
  unhandled rejection——P1 验收教训的纪律延续）。
- **prompt.section({name, text, order?})**：写跨 bundle 注册表；**order 宿主
  钳制在 [-50, 0]**（`clampModSectionOrder`：非法/缺省取 -50，越界收边）——
  核心占用 -80..-64（kernel/preset/facts/guides/script），Mod 区间防冲掉核心头
  （前缀缓存生命线），-63..-51 留作核心未来扩展带。消费侧（agent-mount）
  **再钳一次 + 文本过 hostPromptSafe**（`{{...}}` 宿主变量语法中性化——残留
  会让宿主 interpolate 抛错中止装配，agent.ts 对内核静态文本的同款纪律）；
  注册名带 `dsh-tavern:mod:<modId>:<name>` 域前缀。常量经消费路径打进
  agent.mjs（gate 静态断言）。
- **ST 循环 hook 与 AgentTavern section/tool 的不对称**（提案 §3.4 刻意）：
  hooks 五相位只作用于 index bundle 的 runGeneration（ST 自有循环）；
  prompt.section/tools 作用于 agent/novel bundle（宿主 AgentLoop）。两者架构
  本来就不对称，各自覆盖面在示例 Mod 与本文档如实标注。

### 4. Mod UI iframe 表面 + postMessage 数据桥（`client/main.js`）

- **分区注册**：`syncModPanelSections(bootstrap)` 在 refreshBootstrap 后调用——
  bootstrap.mods 里 status==='loaded' 且声明 panel 的 mod 各得一个
  `mod:<id>` 分区（P0 的 registerPanelSection 动态注册，label thunk 直接返回
  mod 自带 title——P0 决策预留的形状）。签名（id/title/icon 排序串）不变则
  不动（避免轮询重挂 iframe）；变化时整体重建；被移除的当前分区由 TavernPanel
  的注册表首项兜底。
- **ModSurface**：iframe `src` 指向 `GET mods/<id>/ui?token=<随机 token>`
  （token 经 URL 查询段交给 mod UI，是 postMessage 对账凭据）。纪律完整继承
  美化前端：`sandbox="allow-scripts"` 无 same-origin、referrerPolicy
  no-referrer、**事件源必须是该 frame 的 contentWindow + token 双对账**、
  高度上报协议（`dsh-tavern:frontend-height`，80..1200 钳制）同款——上报脚本
  由 mod UI 自带（父页无法注入 served iframe，示例 Mod 的 ui 路由含同款
  reporter，token 从 location.search 读）。
- **数据桥**：iframe 发 `{type:'dsh-tavern:mod-request', token, id, req:{method,
  path, body}}` → 父页预校验（method ∈ GET/POST/PUT/DELETE/PATCH；path 过
  `[A-Za-z0-9][A-Za-z0-9._-]*` 段白名单——穿越/编码在父页就被拒，服务端白名单
  是第二道）→ 父页同源 fetch 该 mod 的子路由 → 回投
  `{type:'dsh-tavern:mod-response', token, id, ok, status, body}`（JSON 优先、
  解析失败回原文）。mod UI 端 CSP `connect-src 'none'` 延续（不能 fetch）。
- gate：frontend-runtime 扩展 4 个 marker（mod-request/mod-response/
  isValidModBridgePath/ModSurface）+ 反样本；mod-loader gate 实测 ui 路由
  返回 CSP 注入的 HTML。

### 5. git 安装（`src/mods/install.ts` + `POST mods/install`）

复用 update service 的 GitHub 源降级链（sources.ts）：

- **URL 解析**：`https://github.com/<owner>/<repo>(.git)?` / `github:owner/repo` /
  `owner/repo`（可带 `#ref`，ref 限 `[A-Za-z0-9._-]`）；github.com 域缺 owner/
  repo 两段的直接拒（不当通用 git URL 放行晚失败）；非 GitHub 的完整
  `https?://|git@|ssh://` URL 走纯 clone 路线。
- **元数据预读**（GitHub 源）：raw.githubusercontent.com 读 `HEAD`（或 ref）的
  mod.json——经 `httpGet`（**fetch → curl 两级降级链**，从 sources.ts 导出
  复用；api.github.com 有配额、atom 无文件内容，raw 是唯一不吃配额的文件源，
  raw-git 来源先例）。坏仓库在 clone 前被拒。
- **落地**：`git clone --depth 1 --filter=blob:none --no-checkout` + 显式
  checkout（sources.ts 的 `git ls-remote` 同款 execFile 纪律：
  GIT_TERMINAL_PROMPT=0、超时、windowsHide）；**本地 mod.json 是权威**（id
  从这里读、定目录名、过 checkModManifest 全量校验）；拷入 `<tavern>/mods/
  <id>/` 排除 `.git`；已存在目录拒绝（force 先删后装）。成功/失败进审计
  （`install`/`install-error`），落地后 host.refresh() 让扫描吸收（装上≠启用，
  三层开关语义不变）。
- `mods/install` 因此成为第四个管理保留段（mods/state、enable|disable|reload
  之后的 P2 新增；同 P1 歧义处理：管理面优先）。管理 UI：输入 URL + 安装按钮
  + force 勾选 + 进度/结果反馈（长操作锁死防重复提交）。

### 6. 启用确认弹层与 surfaces 声明（manifest 扩展）

- manifest 新增可选 `surfaces: { hooks?: string[], tools?: string[], http?: string[] }`
  （校验：≤32 项、非空字符串、≤200 字符）——作者自查的注册面声明。
- 快照/投影：**loaded 展示实际注册名单**（宿主观察的事实：surfaces Sets），
  **未装载回落 manifest 声明**——「声明」与「事实」两个来源如实区分（确认
  弹层文案标注）。确认弹层在 P1 的 capabilities 之上加 hooks/tools/http 三行。
- 这是对 P1 manifest 的增量扩展（向后兼容：字段可缺省），理由：§3.5 要求
  确认弹层展示 hooks/tools/http「声明」——首次启用（尚未装载、无事实可观察）
  时声明的唯一来源是 manifest。

### 7. 审计线新事件

`hook-degradation`（phase/reason/detail + owner 归因落 mod id）/ `llm-call`
（provider/model + usage）/ `llm-error` / `macro-error`（mod 宏首调异常）/
`install` / `install-error`。全部经既有 ModAuditLog（追加失败静默降级为内存
计数——审计是观测面不许反噬宿主）。

### 8. 示例 Mod 三件套（`packages/plugin/examples/mods/dsh-tavern.mood-tracker/`）

post-output 观察 hook（统计字数/回复数落私有存储，不改写文本——观察位是
hook 最安全用法示范）+ Agent 工具对（`<modId>_get_mood`/`<modId>_set_mood`，
形状对齐 tool() 工厂）+ panel 分区（`GET ui` 返回自包含 HTML：CSP 由服务端
注入、自带高度上报脚本 + postMessage 桥客户端、token 从 URL 查询段读）。
是 tavern-mods-p2-e2e.spec 与 mod-loader gate 的夹具。

## Alternatives considered

- **ctx.tools 走路线 (a)（index bundle 插件级 ctx 注册）**：挂载域语义下落空
  （见 §1 证据链），否决。混合路线（a+b 双注册）会在全局语义下双重注册，否决。
- **mod 工具在 agent bundle apply 时一次性吸收、不订阅增量**：apply 后装载的
  mod（常态——装载是 index apply 内的异步动作）对已挂载会话不可见直到下次
  recompose；订阅增量是提案「既有会话尽力补齐」承诺的最小实现，成本一个
  listener。选订阅。
- **工具注册直接放定义引用（不做活查包装）**：mod reload 后 execute 行为停在
  旧闭包；活查包装让 reload 即时生效且指纹未变时零重注册。选包装。
- **api.llm.request 依赖宿主的非流式面（若存在）**：dsh-llm 契约未文档化该面，
  自收集（stream 聚合）形状确定且可测。选自收集。
- **宏确定性用 vm 沙箱求值或双调用比对**：`--experimental-vm-modules` 不可依赖
  （提案 §6 已裁）；双调用比对有副作用风险且测不出低概率时间源。静态筛查 +
  文档声明（信任立场与提案 §3.3 一致：知情同意标签不是隔离）。
- **git 安装走 codeload tarball**（不走 git clone）：curlGet 返回 utf8 字符串，
  二进制 tarball 经 utf8 往返会损坏；引 tar 解包依赖违反零运行时依赖纪律。
  clone 复用桌面版 profile 的既有 git 依赖。选 clone。
- **git 安装的 mod.json 预读失败即整体失败**：非 GitHub 源本来就无法预读
  （kind:'git' 直接 clone）；GitHub 源预读是省一次 clone 的优化 + 可读错误。
  保留该差异。
- **mod section 文本不过 hostPromptSafe**：`{{...}}` 残留会让宿主装配抛错中止
  运行——一个 mod 的坏文本炸所有 AgentTavern 会话。中性化后最坏是文本变体
  （`{{` → `{ {`），不炸装配。选中性化。
- **surfaces 声明当契约强制（注册超出声明即拒）**：声明是知情同意展示面不是
  运行时契约——mod 代码在进程内天然能做任何事（提案 §3.3 信任立场），假契约
  只产生虚假安全感。选展示性声明 + loaded 事实覆盖。

## Consequences

- 新增路由 1 个 marker（`mods/install`），server-bundle gate 清单 46 → 47；
  gates 仍 15 项（mod-loader 与 frontend-runtime 扩展断言，非新增 gate）。
- 六个 Node bundle 中四个内容变化：index.mjs（P2 面 + 安装 + 审计 + 投影）、
  agent.mjs/novel.mjs（agent-mount 吸收）、（card-workbench 仅因共享代码重打包）；
  client/index.js（ModSurface + 桥 + PanelMods 安装/确认 UI + i18n 新键
  zh/en 镜像）。
- 新增测试 37 例（tavern-mods.spec +28：六面 17 + agent-mount 吸收 6 + git
  安装 4 + hook 清单单元 1 内嵌；tavern-mods-p2-e2e.spec 新文件 +5；
  stscript.spec +2；macros host-registry +2）。全量 927 → 964 过。
- `tavern-macros` 新导出 `builtinMacroNames()`；`tavern-script` 的
  `registerStscriptCommand` 返回值 void → 反注册函数（向后兼容）；sources.ts
  导出 `httpGet`（私有 → 导出）——三处皆为 P2 落点的最小增量，语义不变。
- 已知边界（如实）：宏确定性静态筛查非封闭（命名函数闭包源不可见）；
  `mods/install` 是管理保留段（名为 install 的 mod 目录仍可装载，只是
  `POST mods/install` 恒为安装路由）；git 安装非 GitHub 源无元数据预读；
  section 文本经 hostPromptSafe 后 `{{` 变 `{ {`（显示层等价、装配安全）；
  mod UI 的 token 经 URL 查询段传递（单用途 postMessage 对账凭据，非机密）。
- P3（分发索引/市场）非目标，未实施。
