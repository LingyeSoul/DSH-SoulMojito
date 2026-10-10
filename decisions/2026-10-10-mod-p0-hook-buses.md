# Mod P0：五条注册表/总线骨架（纯重构零行为变化）

日期：2026-10-10。状态：已实施。关联：提案 `docs/proposals/0015-mod-extensions.md`（§3.3/§3.4/§3.5/§4 P0 定义）、`decisions/2026-10-10-group-nudge-and-regex-slash.md`（pre-assemble 缝隙的既有占用者）。

## Problem

提案 0015 的 Mod 扩展面（P1/P2）依赖五个「现在不存在」的骨架结构：ST 生成
管线无中间件（外部无法在装配前/模型调用前/落盘前挂变换）、STscript 命令是
固定 switch、管理面板分区是常量 + 三元链（新增分区要改 4 处）、宏引擎
`registerMacro` 预留但宿主侧零接线（注册了也只活在一个短生命周期实例里）、
bootstrap 无 mods 投影。这些骨架若与 P1 的加载器/API 面一起交付，会把
「结构性重构」与「新行为」搅在同一批改动里，回归面无法收敛。

P0 的存在意义：**单独交付全部骨架、注册面恒空、生成/脚本/面板行为逐字节
不变**——P1 只需要在空插槽上落注册方，不再动核心路径。

## Decision

五个结构一次落地，全部遵循同一条纪律：**注册表/总线存在、注册方不存在；
空态快路径与原代码路径等价**。

### 1. runGeneration 五相位空总线（`src/generation-hooks.ts` + `src/index.ts`）

- 相位与调用点（`runGeneration` 内，行号为本次实施时实测）：
  - `user-input`：send 分支内、`applyRegexScripts(USER_INPUT)` **之前**——
    mod 看到用户敲入的原文；regex 是用户配置层，mod 变换置于其外层。
  - `pre-assemble`：装配输入先提为 `assembleDraft` 变量再 dispatch、
    `assemblePrompt` 之前——nudge 合成楼层已在 draft 的 `messages` 末尾
    （决策 2026-10-10-group-nudge-and-regex-slash 的注入点），mod 可见可改写，
    它是该相位第一个既有受益者。对象字面量的属性求值顺序逐字保持。
  - `pre-llm`：`ctx.llm.stream` 之前，payload 为最终请求
    `{messages, system, params}`；stream 调用从 hook 结果展开，
    「system 无内容则不带键」的条件语义保留（undefined 时不注入）。
  - `post-output`：`AI_OUTPUT regex` 与 `tpl.renderOutput` **之前**——
    mod 看到模型原文。
  - `post-save`：`db.saveChat` 之后，只读观察（handler 返回值被调用方丢弃）。
- 机制：顺序 waterfall（order 升序、平局按注册先后，快照遍历）；单 hook
  10s 超时（`GENERATION_HOOK_TIMEOUT_MS`，`Promise.race` + settle 时
  `clearTimeout` 防悬挂 timer）与抛错统一降级——**该 hook 跳过、进入前的
  值继续、不中断生成**（renderText 失败保原文同款纪律，`src/template.ts`
  的 try/catch 保原文）；hook 忘 return（undefined）按不变处理并计降级，
  防 payload 被洗成 undefined 炸生成。降级经 `onDegradation` 回调上报 +
  `degradationCount()` 计数（P1 接日志与审计线）。超时与普通抛错以
  `reason: 'timeout' | 'error'` 区分。
- 总线是模块级单例 `generationHooks`（进程内单写者，与 storePromise
  memoization 同款宿主单例先例）；空相位 dispatch 原样返回同一引用。
- **Mod 注册面（api.hooks.on）不在此阶段开放**——总线恒空。

### 2. STscript 命令表 registry 化（`packages/tavern-script/src/stscript.ts`）

- `runCommand` 的固定 switch（含 `/regex`，上一提交刚落）改为
  `commandTable: Map<name, StscriptCommandSpec>` 查找；17 个内置 spec
  （echo+comment、setvar 族、if、random/roll/pick、send/trigger/regenerate/
  stop/cut、regex）经 `registerStscriptCommand` 注册，**case 体逐字搬运**
  （错误消息、别名共处理器内 `cmd.name` 判定、`/regex` 的 placement 语义
  不动）。别名落表指向同一 spec，`cmd.name` 保留实际调用名。
- handler 通过 `StscriptCommandContext` 拿共享工具：`rng`（env 注入）、
  `changed()`（chatChanged 快捷构造）、`runNested`（/if 递归入口）——
  switch 闭包变量全部显式化，无隐式捕获差异。
- P0 无外部注册方（表恒为内置集）；P1 的
  `api.stscript.registerCommand(name, spec)`（含名字字符集校验、禁覆盖
  内置）以 `registerStscriptCommand` 为落点。

### 3. PANEL_SECTIONS registry 化（`packages/plugin/client/main.js`）

- 形状 `{id, icon, label, component}`：
  - `label` 是 **locale thunk `(t) => t('panel.section.<id>')`**——渲染点
    传入当前 `t`（`useTranslate()` 返回值），宿主 locale 切换跟随语义与
    原内联 `t(...)` 调用一致（MVU 侧栏 tab 的 `title: () => …` thunk 先例）。
  - `component` 收统一面板宿主参数 `{ctx, useSessions}`，各分区自取所需
    ——原来 13 分支三元链的 props 差异（有的要 ctx、有的要 useSessions、
    有的无 props）收口到一个签名，P1 的 ModSurface 分区（iframe 表面）用
    同一签名。
- `registerPanelSection(definition)` 追加在尾部并返回反注册函数；内置
  13 分区按原顺序注册。`TavernPanel` 的分区解析改为
  `panelSections.find(id) ?? panelSections[0]`——未知 section 回落注册表
  首项（overview 必为首条注册），与三元链末尾 `: h(PanelOverview)` 兜底
  等价。nav 按钮顺序、图标、文案 key、header h2 文案全部不变。

### 4. 宏注册表接线（`packages/tavern-macros/src/host-registry.ts`）

- 宿主侧实例化点实测为 **4 处**（提案 §3.3 写「三处」，实施时核实多一处）：
  `runGeneration`（index.ts）、`runTavernScript`（index.ts）、
  `tavernMacroExpand`（index.ts）、`createHostPromptExpander`
  （prompt-safety.ts，宿主 systemPrompt 安全化的冻结求值上下文）。
- 接线选在 `createMacroEngine` **内部**吸收注册表快照（`registerMacro`
  逐项注册、坏注册逐项跳过）：4 处调用点一行不改即全部生效，未来新增的
  实例化点也天然被覆盖。快照而非活引用——实例持有创建时刻的稳定视图，
  生成中途的新注册不影响本轮求值；同名项按 order 升序吸收（后吸收覆盖
  先吸收，order 大者胜）。
- 注册表锚定 `globalThis[Symbol.for('dsh-tavern:host-macros')]`：本包被
  esbuild 打进多个 Node bundle（index/agent/compaction/novel/
  card-workbench，`packages:'bundle'` 零 external），模块级状态跨 bundle
  不互见——与 `cross-bundle-events.ts` 同学科，且为 P1 mod 宿主（index
  bundle）注册、agent bundle 实例生效铺路。key 字符串是互见契约。
- P0 注册面无宿主调用方，注册表恒空。

### 5. bootstrap mods 投影占位（`src/index.ts`）

- bootstrap 载荷新增 `mods: []`，与 `worldEntryCounts` 同款轻量投影注释；
  P1 加载器落地后填充 `{id, name, version, enabled, error, panel}` 清单。
  现网所有客户端版本都不读该键，新增键不构成协议变化。

## Alternatives considered

- **hook 相位选点**：`user-input`/`post-output` 各有「regex 前 vs 后」两选。
  选前（mod 看原文）：regex 是用户配置的既有变换层，ST 的
  generate_interceptor 也在管线最外层；mod 想改 regex 产物可以自己注册
  regex 或在后继相位处理。否决「regex 后」——那会让 mod 输入混入用户
  regex 产物，两层变换职责不清。
- **pre-llm payload 含 provider/model 与采样参数**：只交 messages 会迫使
  P1 补第二形状；`{messages, system, params}` 一次到位且与
  `ctx.llm.stream` 入参同构，hook 结果直接展开进 stream 调用。已知开放
  问题（记入提案 §5 语义，P1 处理）：P1 若 mod 改 provider，落盘
  `swipe_info.extra` 的 provider/model 仍取选择器原值——P0 不改此行为。
- **hook 总线用 globalThis 注册表**（cross-bundle-events 同款）：不必要——
  五个相位只在 index bundle 的 `runGeneration` 内 dispatch，P1 的 mod 宿主
  与生成循环同 bundle，模块级单例即互见。宏注册表才需要跨 bundle（见上）。
- **STscript 保留 switch、P1 再 registry**：会把「内置命令迁移」与「P1
  外部命令注册」耦合在同一批改动，且 switch 无法承载注册入口。否决。
  反向方案「命令表按相位分组」也否决——ST 命令无相位概念，平铺表最简。
- **PANEL_SECTIONS 的 label 用 id 惰性求值（`t('panel.section.' + id)`）
  而非 thunk**：两者输出等价，但 thunk 形状允许 P1 的 Mod 分区自带任意
  文案（不强迫走 `panel.section.*` key 空间），且与 MVU tab 的 title thunk
  先例一致。选 thunk。
- **PANEL_SECTIONS component 存组件引用 + props 映射表两个字段**：比
  「component 即 `(host) => vnode 工厂」多一个平行结构；工厂签名统一，
  P1 ModSurface 直接落同一签名。选工厂。
- **宏接线放宿主侧（plugin 在 4 处实例化点手动 apply）**：每处两行、共
  8 行重复，且未来新增实例化点会漏接；引擎内吸收一处收口。副作用是
  tavern-macros 包获得进程级全局状态（原来是纯函数包）——由「恒空快照 +
  吸收在本地 registry 建好之后」限定，行为不受影响。选引擎内吸收。
- **post-save 不 await（fire-and-forget）**：少一次空总线 await，但 P1
  有 hook 时观察与下一轮生成的时序无保证，且未处理 rejection 需额外防御。
  P0 空 dispatch 本就近零开销，选 await（简单一致）。

## Consequences

- 五条骨架全部空转：生成路径（860 既有用例）、STscript（27 用例）、宏
  （13 用例）、面板（gates 静态 + client-vm-mount 真实执行）行为不变；
  新增用例只锁「空态恒等 + 注册后生效 + 降级不中断」三类事实。
- 新增测试 27 例（bus 单元 8 + 真实生成接线 7 + bootstrap 投影 1 内嵌 +
  stscript 命令表 5 + 宏注册表 7——其中 stscript/宏在各包 spec 内追加）。
- 六 bundle 重建：index.mjs（hook 总线 + 投影）、client/index.js（面板
  注册表）内容变化；agent/compaction/novel/card-workbench 仅因 tavern-macros
  共享代码吸收快照一行而重打包（行为不变）。
- P1 的 API 面（api.hooks.on / api.stscript.registerCommand /
  api.macros.register / registerPanelSection 的 mod 声明驱动调用）分别以
  `generationHooks.register`、`registerStscriptCommand`、
  `registerHostMacro`、`registerPanelSection` 为落点，核心路径不再动。
- 已知边界（P1 处理）：pre-llm 改 provider/model 后落盘 extra 的一致性；
  prompt-safety 冻结上下文吸收 mod 宏后受保护头的字节稳定性承诺需要
  mod 宏自身确定性（文档义务，P1）。
