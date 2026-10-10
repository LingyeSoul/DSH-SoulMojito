# Mod P1：加载器与最小可用（manifest 校验、三层开关、api 适配层、审计线）

日期：2026-10-10。状态：已实施。关联：提案 `docs/proposals/0015-mod-extensions.md`（§3.2/§3.3/§3.5/§4 P1 定义、§5 gate 四不变量）、`decisions/2026-10-10-mod-p0-hook-buses.md`（P0 骨架与 P1 边界注记）。

> **验收修订（同日）**：主会话独立验收打回一项——`npm run check` 的 vitest 步
> 出现 unhandled rejection（`ENOENT / rename / …dsh-tavern-modreload-*\
> …state.json.<pid>.<ts>.tmp`）。根因分析与修复见文末
> 「附录：原子写竞态（主会话验收发现）」；正文其余部分为初版交付记录。

## Problem

提案 0015 的 P1 要在 P0 的空插槽上交付「Mod 真的能装进来」：`<tavern>/mods/`
的扫描与清单校验、三层开关（默认全关）、最小 api 面
（logger/storage/assets/events/timers/http）、审计线、重载、管理面板分区与
bootstrap 投影真实化、新 gate `mod-loader`、一个示例 Mod。信任立场与 ST 服务端
插件对齐：进程内、不沙箱、默认禁用、显式启用、坏 Mod 不断路。

## Decision

### 1. 目录划分（`packages/plugin/src/mods/`）

提案给了 loader.ts/host.ts/registry.ts 三文件的建议形状，实施按内聚微调为六文件：

- `manifest.ts`：清单校验（纯函数，不触 fs）+ 自写 semver 匹配器 + `MOD_ID_PATTERN`。
- `audit.ts`：`<tavern>/mods/audit.jsonl` 追加式 JSONL + 进程内计数。
- `events.ts`：mod 事件总线（模块级单例，`generationHooks` 同款）。
- `storage.ts`：私有 kv（配额 + writeAtomic + mutation tail 串行化）。
- `http.ts`：路由表 + path 白名单 + reply 出口（json/html）+ CSP 注入。
- `host.ts`：`ModHost`（扫描/对账/装载/卸载/重载/快照/子路由分派）+ 适配层组装。

registry.ts 不需要：单例 memoization 放在 index.ts（`storePromise` /
`updateServiceInstance` 同款先例），dbProvider 经闭包注入避免与 index.ts 循环
import。

### 2. manifest 校验（加载前只读 mod.json，不执行代码）

- id：`^[a-z0-9](-?[a-z0-9])*(\.…)*$` 单段或点连多段（反域名），**必须等于目录
  名**——路由寻址（`mods/<id>/…`）与去重天然 WYSIWYG，目录即身份；改名=换 id。
- name/version/author/description/main 必填非空；main 必须是相对路径、段不得为
  `.`/`..`/空、段不得以 `.` 开头（拦 `.mjs` 这类隐形文件）、禁反斜杠。
- engines.`dsh-tavern` 缺省=无约束；有则按 semver 范围装载时校验，不满足=
  `skip` + 状态错误位（面板展示 `requires dsh-tavern >=99 (host 0.4.1)`），不 crash。
- semver 匹配器自写（仓库零运行时依赖）：`||` 多选一 + 空格 AND；比较器
  `*`/`>=`/`<=`/`>`/`<`/`=`/`^`（leftmost-nonzero 规则）/`~`；缺段补 0；
  prerelease 解析后忽略（宿主版本不带）。**范围或版本不可解析一律 fail-closed**
  （vitest 里宿主版本是 `unknown` → 带 engines 的 Mod 一律跳过，这是刻意的）。
- capabilities ⊆ {llm,network,storage}（去重）；panel 可选 `{title, icon?}`；
  loadingOrder 有限数值（缺省 100）。

### 3. 三层开关的 state 键位

- 第一层（全局）：`state.json` 的 `modsEnabled`（默认 false；
  `readState` 归一化 `=== true`，手改非布尔值=关）。
- 第二层（逐 Mod）：`state.json` 的 `mods.enabled.<id>`（默认 false；归一化只
  保留显式 `true` 的项）。
- 第三层（硬关）：环境变量 `DSH_TAVERN_DISABLE_MODS` 非空（非 `0`/`false`）即
  关，**每次 refresh/子路由分派实时读取**（对齐 `DSH_TAVERN_DISABLE_UPDATE_CHECK`
  先例；实时读取让 e2e 与 gate 可以在同一进程里开关验证，也避免宿主改环境后
  残留旧状态）。
- 装载判定 = `!envOff && modsEnabled && enabled.<id>`；`refresh()` 是幂等对账
  循环（该装的装、该卸的卸、目录消失的 `remove`）。

### 4. 路由挂载与 404 语义

- 管理面：`GET mods`（快照）、`POST mods/state`（全局开关）、
  `POST mods/<id>/enable|disable|reload`。**任一层关闭时管理面仍可用**——否则
  用户无法再打开。
- 子路由：`ANY mods/<id>/<path>` → `api.http.route` 注册表。**env 硬关 / 全局
  关 / 逐 Mod 关 / 未装载 / 无此路由，一律回与未知路由逐字相同的 404**——不泄露
  「Mod 是否存在」，语义即「Mod 关了 = 它的路由不存在」。
- 管理面与子路由的关键词歧义（`mods/<id>/enable` 是管理路由还是 mod 自注册的
  `enable` 子路由）：管理面优先，mod 不能注册名为 `enable|disable|reload` 的
  子路由（P1 文档义务，注册时若与这些保留段撞名按「无此路由」404）。
- id 双保险：分派侧先过 `MOD_ID_PATTERN` 再查 loaded Map（map 键永不含 `/`、
  `..`），穿越串（`..%2F..` 解码后）在两道检查都出局；`isValidModHttpPath`
  白名单（段 `[A-Za-z0-9][A-Za-z0-9._-]*`，拒 `%`、反斜杠、点段）在注册与
  分派两侧都跑。
- **server-bundle gate 路由清单 44 → 46**：新增 `'mods'` 与 `'mods/'` 两个
  marker（合法 gate 演进；其余 44 条逐字不动）。

### 5. 审计线事件集

`<tavern>/mods/audit.jsonl`，每行 `{ts, mod, event, detail?}`：
`load` / `enable` / `disable` / `reload` / `remove` / `skip`（坏 Mod，含原因）/
`load-error` / `dispose-error` / `event-error` / `timer-error` / `http-error` /
`storage-quota`。全局开关用 `mod: "*"` 记。追加失败静默降级（审计是观测面，
不允许反噬宿主）；计数是**进程内**的（bootstrap 投影/面板用），完整历史在
jsonl。handler 抛错 → 500 JSON `{ok:false, message}` + `http-error` 审计，
宿主不炸；handler 忘了 reply → 500「did not send a response」。

### 6. api 适配层形状（`api.version === 1`）

全部白名单对象，不透传 cordis ctx（TemplateHost 模式）：

- `api.logger.{info,warn,error}`：宿主 logger 加 `[mod:<id>]` 前缀。
- `api.storage.{get,set,delete}`：`<mod>/data/state.json`；键同 VariableStore
  规则；单值 256KB / 总量 1MB（按 JSON 字节数，VariableStore 配额先例的报错
  形态：抛 Error 不静默）；超配额记 `storage-quota` 审计。
- `api.assets.*`：只读快照（characters/worlds/presets/personas/groups 的列表
  与内容、chats 列表与内容），全部 `structuredClone`，无写路径。
- `api.events.on(kind, handler)`：`chat-saved`（`{character, chatId, revision}`）
  / `assets-saved`（`{kind, name}`）/ `guides-changed`（`{character, chatId}`）。
  前两者在宿主落盘点发射：chat 的全部 `db.saveChat` 调用点（PUT chat、guides
  增删、runGeneration 两段、STscript persist——6 处）；assets 在
  character/world/preset/persona/group 的导入与保存路由（11 处）。guides-changed
  桥接既有 globalThis 总线（guides.ts 的 `emitGuidesChanged`），mod 不感知两条
  总线。无监听时 emit 是已 resolve 的 promise（零开销，不拖生成路径）。
- `api.timers.{setInterval,clearInterval}`：句柄记进 LoadedMod，卸载时全清；
  另在 host.open 注册一条 `ctx.effect` 兜底清全部定时器（宿主卸载）。
- `api.http.route(method, path, handler)`：`reply.json(body, status?)` 与
  `reply.html(doc, csp?)` 两个出口；html 自动注入 CSP meta（默认策略对齐美化
  前端纪律：`default-src 'none'`、`connect-src 'none'`、脚本仅 `unsafe-inline`
  ——Mod 取数走服务端，不开放浏览器 fetch；mod 可传自定义 cpi 串，属性转义）。
  handler 收 `{method, path, query, json()}`（2MB 上限，与宿主 readJson 同义）。
- `api.onDispose(fn)` 与 setup 返回的 dispose 合并为一个队列，**逆序执行**
  （后注册先清；setup 返回的外层 dispose 最先跑）。

P1 刻意缺席：api.hooks（P0 总线在但注册面 P2 开）、api.tools/macros/stscript/
llm/prompt（全部 P2）。

### 7. 重载与 ESM 驻留

`POST mods/<id>/reload` → unload（审计 `reload`，dispose 链）→
`import(entryUrl + '?t=' + Date.now())` cache-bust 重新拿模块实例 → 重跑
setup。**模块级副作用无法回收是已知限制**（与提案 §3.2/§5 一致）：缓解=注册
必须走 api.*（宿主持全量 disposer/timer/event/route 反注册），文档义务。reload
要求当前已装载（否则报错）；重载失败 → 状态 `error`，路由 404。

### 8. bootstrap 投影与面板

- bootstrap：`mods: [...]`（P0 占位真实化，字段
  `{id,name,version,author,description,capabilities,panel,status,enabled,error,
  auditCount}`）+ 新增旁键 `modsAvailable`（env 硬关时 false）。旧客户端不读
  这两个键，不构成协议变化；mod 宿主初始化失败时投影回 `[]`，bootstrap 不 500
  （坏世界书教义）。
- 「Mod」管理分区（第 14 个，`registerPanelSection`）：列表（清单字段、能力
  Pill、状态/错误、审计计数）、全局开关（`bootstrap.state.modsEnabled`）、
  启用/停用/重载、**启用确认弹层如实展示 capabilities + 「无沙箱、只信信任的
  开发者」告知**（知情同意）。i18n 走 locale thunk（`panel.section.mods` 等
  23 个新键，zh/en 逐键镜像由 client-vm-mount gate 锁定）。
- 动作-刷新闭环：面板写操作（`mods/state`、enable/disable/reload）成功后
  `refreshBootstrap()`（patchState 同款）。已知边界：state.json 写入不进
  `store-revision` 资产水位（该水位的契约是资产目录），所以开关变化不会经
  3s 轮询自动传播到其他打开的页面——P1 面板动作自带刷新，够用；若未来需要
  跨页跟随，把 mods 状态纳入水位另立决策。

### 9. gate `mod-loader`（四不变量的锁定方式）

真实 bundle 子进程探测（update-routes gate 同款）+ 静态 marker，两段探测：

- 主探测（临时 DSH_HOME 拷入示例 Mod + 坏 mod.json）：bootstrap 列出且
  `enabled` 全 false（不变量 1 双默认关）；默认/仅逐 Mod 开两层 404、两层同开
  200 且 counts 到位（不变量 1+4）；未知子路由与 `..%2F..` 穿越 404（不变量 2
  path 校验）；reload 200 且路由复通；disable 复 404；坏 mod 状态 error 且
  bootstrap 仍 200（坏 Mod 不断路）。
- env 探测（第二子进程 `DSH_TAVERN_DISABLE_MODS=1`）：available false、投影空、
  两层全开后子路由仍 404（不变量 1 第三层 + 4）。
- 静态（bundle）：`join(_, "mods")` 扫描锚点（不变量 2 目录白名单——esbuild
  会给 join 加数字后缀，正则 `join\w*\(`）；`generation hook timed out after`
  机制串 + 10s 常量字面（不变量 3，提案 §5 的 hook 超时内嵌于构建产物可 grep）。
- selfTest 反样本：good 快照 + 12 个坏样本（每个断言字段逐个翻转）全部被拒。

### 10. 示例 Mod（仓库交付物）

`packages/plugin/examples/mods/asset-stats/`（mod.json + index.mjs）：资产只读
统计——`api.assets` 出 counts、`api.http.route('GET','stats')` 暴露 JSON、
`api.storage` 持久化 fetch/chat-saved 计数、`api.events.on('chat-saved')` 计数、
setup 返回 dispose（写 `disposed` 标记）。不进 package.json `files`（repo 夹具
与文档，不分发）；它同时是 e2e（tavern-mods.spec）与 mod-loader gate 的夹具
（临时 DSH_HOME 拷贝加载）。

## Alternatives considered

- **用 `packages/plugin/src/mods/registry.ts` 持全局单例**：需要 dbProvider 又
  不能反向 import index.ts（循环），要么传 lazy 工厂要么把 memoization 留在
  index.ts。后者与 `storePromise`/`updateServiceInstance` 先例完全同形，少一个
  文件。选后者。
- **state 键位选 `mods: {enabled}` 嵌套单层（无全局键）**：全局开关没有自然
  归属；提案明说 `modsEnabled` 与 `mods.enabled.<id>` 两键。照提案。
- **env 硬关在进程启动时读一次缓存**：省每次分派的字符串比较，但 e2e/gate
  无法在同进程验证开关行为，宿主环境变化也会残留。实时读取（比较一次 env
  字符串）成本可忽略。选实时。
- **`store-revision` 水位纳入 state.json/mods 目录**：让开关变化经轮询自动跨页
  跟随，但改变既有水位的契约（「资产目录变更」语义，store-revision.spec 锁定
  「无写入稳定」）——为 P1 的面板体验扩水位不值当，面板动作自带刷新。记为
  已知边界。
- **manifest 校验里做 fs 检查（入口存在性）**：让 checkModManifest 不再是纯
  函数，e2e 单测要铺文件。拆开：形状校验纯函数，入口存在性/containment 在
  host.scan（`resolve`+`relative` 双保险）。选拆开。
- **semver 引包**：仓库 devDependencies 之外零运行时依赖是既定事实（六 bundle
  全打包），为一个范围判断引依赖违反打包纪律。自写 60 行匹配器，prerelease
  忽略的局限文档化。
- **子路由 404 用专用错误体（如 `{code:'MOD_DISABLED'}`）**：泄露 Mod 存在性，
  与「禁用=不存在」语义相悖。选与未知路由逐字相同的 404。
- **坏清单的 ModInfo 只给 id**：面板只剩目录名不可读。清单字段抢救（name/
  version/author/description 若为字符串则展示）。选抢救。
- **`mods/<id>/enable` 歧义让给 mod 子路由**：管理面就没有稳定的启用入口
  （mod 未装载时本来也没有子路由）。管理面优先。选管理面优先。

## Consequences

- 新增路由 2 个 marker（`mods`、`mods/`），server-bundle gate 清单 44 → 46；
  gates 14 → 15 项（`mod-loader`）。
- `TavernState` 新增 `modsEnabled`/`mods`（readState 归一化只认显式 true）；
  store.spec 的默认值断言同步补键，另加 mods 归一化用例。
- 客户端新增第 14 个面板分区与 20 个 i18n 键（zh/en 镜像）；EMPTY_BOOTSTRAP
  补 `mods: []`、`modsAvailable: true`。
- 新增测试 35 例（tavern-mods.spec 34：清单 7 + semver 2 + storage 4 + http 3
  + 宿主矩阵/装载 8 + 事件 3 + e2e 7；store.spec +1）；全量 922 过。
- 六 bundle 重建：index.mjs（mods 模块 + 路由 + 发射点 + 投影）、client/index.js
  （PanelMods + 分区 + i18n）内容变化；其余四个 bundle 因共享 tavern-store
  state 归一化重打包（行为不变）。
- 已知限制（如实标注）：ESM 实例驻留（reload 不回收模块级副作用）；多 profile
  共享 `<tavern>/mods/`（提案 §5 原样）；mod 子路由保留段 `enable|disable|
  reload`；`capabilities` 是知情同意标签不是隔离（提案 §3.3 原样）；env 硬关时
  `POST enable` 因清单未扫描而报「not installed」（500）——状态写入本就无效，
  面板此时锁死开关，不构成用户可见路径。
- P2 落点预告：api.hooks.on → `generationHooks.register`（含降级审计接线）；
  tools/macros/stscript → P0 三条注册表；ModSurface iframe → postMessage 数据桥。

## 附录：原子写竞态（主会话验收发现，同日修复）

### 现象与归因（逐字验证，非推测）

主会话独立验收 `npm run check`：vitest 步 unhandled rejection——
`{ code: 'ENOENT', syscall: 'rename', path: '…dsh-tavern-modreload-*\
…state.json.<pid>.<ts>.tmp' }`，且在测试完成后才炸（fire-and-forget 写无
观察者）。用独立复现脚本（esbuild 现场打包 storage.ts，只用公共 API 制造
确定性竞态）证实了**三个真实形态**，全部源于 mods/storage.ts 初版自建的
`tmp = path.pid.Date.now()` 原子写：

1. **同毫秒 tmp 碰撞（跨实例）**：reload 期间旧/新两个 ModStorage 实例指向
   同一 state.json，各持私有 mutation tail 互不知晓；同毫秒两次写生成同名
   tmp，先 rename 者把文件带走，后者 `rename → ENOENT`。复现数据：live 时钟
   双实例各 150 次并发写，3 跑 2 中 `ENOENT/rename`（另伴随 `EPERM/rename`——
   Windows 瞬态，正是 2290eb0 加重试的原因）。反直觉对照：**冻结时钟反而全过**
   ——所有写共享同一个 tmp 路径时后续写会不断重建它，自愈；失败恰好需要
   「两个写者恰好在同一毫秒」的二体巧合，没有第三方重建者。
2. **teardown 在飞写**：mod 的 interval 回调 `void api.storage.set(...)` 是
   fire-and-forget——宿主卸载只清了 timer，没排空写队列；测试 finally 的
   rmSync 落进 writeFile→rename 窗口 → 同一 ENOENT 签名。复现数据：240KB
   宽载荷 + rmSync 边界锤击 ×60，稳定出现 `ENOENT/rename`、`ENOENT/open`、
   `EPERM/rename`。
3. **跨实例读改写丢键**（修复过程中被新增回归网当场抓到）：即使写不失败，
   两个实例各自的「readFile→merge→writeFile」临界区交错，后写者基于陈旧读
   整批覆盖前写者的键（实测一整个 `a*` 键集消失）。串行化必须按**文件**，
   不能按实例。

验收日志里的单行 ENOENT 无法区分形态 1 与 2（签名相同），两者按「都必须
结构性不可能」处理。

### 修复（三道防线，收敛到共享实现）

1. **tavern-store 新增 `fs-atomic.ts`**（`writeAtomicBytes`/`writeAtomicText`）：
   模块级单调计数器保证 tmp 名全进程唯一（调用方串行化与否都不再可能碰撞）
   + 2290eb0 的 `renameWithWindowsRetry` 原样迁入（EPERM/EACCES/EBUSY/
   ENOTEMPTY 有界退避）。**收敛了七处自建**：store/variable/memory/originals/
   scripts/novel 六处既有实现（其中 originals/novel 曾各自私加随机后缀局部
   补丁——碰撞问题早有痕迹）+ mods/storage.ts；旧教训「同包其余自建原子写点
   是跟进项」就此清账，dedup 纪律对齐 cross-bundle-events/tool-args 先例。
   目录创建（mkdir recursive）保持调用方职责，各点语义不变。
2. **mods/storage.ts 按文件共享串行队列**（模块级 `fileTails: Map<path,
   Promise>`）：读改写在同一跨实例临界区完成，丢键与碰撞在存储层结构性不可
   能；`flush()` 排空该文件队列（含其他实例入队的写）。
3. **宿主生命周期与观察分支**（mods/host.ts）：`runDisposers` 末尾
   `await record.storage.flush()`——unload/reload 返回即该文件全部在飞写已
   落定（reload 的旧→新实例窗口与测试 teardown 竞态都消除）；timer 回调改为
   async 捕获（同步抛错与异步拒绝都进 `timer-error` 审计）；api 适配层给
   get/set/delete 挂**观察分支**（`p.catch(audit 'storage-error' + logger)`），
   mod 丢弃 promise 时失败也进审计线而不是进程级 unhandled rejection——
   等待方仍拿到原拒绝。

### 验证证据（Windows 本机）

- 修复前复现脚本：形态 1 `ENOENTx1,EPERMx2~3`（live 时钟）/形态 2
  `ENOENT/renamex17~21`（锤击 ×60）；修复后同脚本：`failures = none,
  keys = 300/300`（frozen 与 live 时钟皆然；脚本已删，结论由回归网固化）。
- 新增回归测试 5 例（tavern-mods.spec，34 → 39）：跨实例 2×80 并发写零失败
  零丢键、`flush()` 排空在飞写、卸载排空 interval 写（ticks 落盘可读）、
  timer 异步拒绝进 `timer-error` 审计、fire-and-forget 配额拒绝进
  `storage-error` 审计（vitest 对 unhandled rejection 直接判败，测试本身即
  证明）。`npx vitest run packages/plugin/tests/tavern-mods.spec.ts` 连续
  3 遍 39/39；全量 `npm run check`（tsc + vitest 927 过 + 六 bundle + 15
  gates）全绿。
- 存储层不承诺「目录被外部删除后写仍成功」——那是宿主 flush 契约的职责
  边界（卸载后无在飞写），三层观察保证任何失败可观测。
