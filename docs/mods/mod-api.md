# dsh-soulmojito Mod API（v1）

> 面向 Mod 作者的开发者文档。设计文档见[提案 0015](../proposals/0015-mod-extensions.md)；
> 落地决策见 [2026-10-10-mod-p0-hook-buses](../../decisions/2026-10-10-mod-p0-hook-buses.md)、
> [2026-10-10-mod-p1-loader](../../decisions/2026-10-10-mod-p1-loader.md)、
> [2026-10-10-mod-p2-capabilities](../../decisions/2026-10-10-mod-p2-capabilities.md)、
> [2026-10-11-mod-bridge-buttons-logs](../../decisions/2026-10-11-mod-bridge-buttons-logs.md)。
> 本文以 `packages/plugin/src/mods/` 的实现为准；API 版本常量 `api.version === 1`。

**Mod = 一个自包含 ESM 文件夹 + `mod.json` 清单，由服务端在进程内加载的受信任第三方代码。**
把文件夹放进 `$DSH_HOME/tavern/mods/`，在 Tavern 管理面板「Mod」分区启用后：你注册的 Agent
工具出现在模型工具面、文本变换挂进 ST 生成管线、宏/STscript 命令即刻可用、面板分区以隔离
iframe 出现、HTTP 路由挂在 `/api/dsh-soulmojito/mods/<id>/` 下。全程不改 dsh-soulmojito 一行源码。

**信任模型（诚实立场）**：Mod 运行在插件进程内，**没有沙箱**——与 SillyTavern 服务端插件同款
边界。防线是流程性的：默认全关（三层开关）、启用前知情同意（capabilities + 注册面声明）、
事后可查（审计线）。只安装来自可信作者的 Mod。

---

## 目录

1. [快速开始](#1-快速开始)
2. [mod.json 清单参考](#2-modjson-清单参考)
3. [生命周期：装载、卸载与重载](#3-生命周期装载卸载与重载)
4. [API 总表](#4-api-总表)
5. [基础面：logger / storage / assets / events / timers / onDispose](#5-基础面)
6. [HTTP 面：api.http.route](#6-http-面apihttproute)
7. [管线 hook：api.hooks.on（五相位）](#7-管线-hookapihookson五相位)
8. [Agent 工具：api.tools.register](#8-agent-工具apitoolsregister)
9. [宏：api.macros.register](#9-宏apimacrosregister)
10. [STscript 命令：api.stscript.registerCommand](#10-stscript-命令apistscriptregistercommand)
11. [AgentTavern prompt 分区：api.prompt.section](#11-agenttavern-prompt-分区apipromptsection)
12. [LLM 面：api.llm](#12-llm-面apillm)
13. [面板 UI 表面（iframe + postMessage 桥）](#13-面板-ui-表面iframe--postmessage-桥)
14. [管理 HTTP 端点](#14-管理-http-端点)
15. [审计事件](#15-审计事件)
16. [示例索引](#16-示例索引)
17. [纪律与限制：什么时候不该写 Mod](#17-纪律与限制什么时候不该写-mod)
18. [游戏注册：api.games.register](#18-游戏注册apigamesregister)

---

## 1. 快速开始

### 目录结构

```
$DSH_HOME/tavern/mods/<mod-id>/
  mod.json          # 清单（加载前只读它，不执行任何代码）
  index.mjs         # 入口 ESM（main 字段指定，相对路径）
  data/             # api.storage 私有数据（宿主创建与管理，别手写）
  node_modules/     # 可选：Mod 自带依赖（bare specifier 相对本目录解析）
```

### 最小 Mod

```jsonc
// mod.json
{
  "id": "com.author.hello",
  "name": "Hello",
  "version": "1.0.0",
  "author": "you",
  "description": "says hello in the log",
  "main": "index.mjs"
}
```

```js
// index.mjs —— 唯一入口约定
export async function setup(api) {
  api.logger.info('hello (api v' + api.version + ')')
  return () => api.logger.info('bye')   // 可选 dispose（卸载时调用）
}
```

### 安装与启用

- **手动**：把目录拷进 `$DSH_HOME/tavern/mods/<id>/`（目录名必须等于 `id`）。
  **注意**：宿主只在 refresh（启动 / 任一管理写操作 / git 安装）时重扫目录——服务器
  运行中手动拷入的目录要先触发一次扫描才可见，例如 `POST /api/dsh-soulmojito/mods/state`
  `{"globalEnabled": true}`（幂等重设全局开关，副作用是 rescan），然后再
  `POST …/mods/<id>/enable`；否则 enable 报 `mod '<id>' is not installed`。
- **git**：管理面板「Mod」分区填仓库地址，或 `POST /api/dsh-soulmojito/mods/install`
  `{ "url": "https://github.com/<owner>/<repo>#<ref>" }`（根目录需有 `mod.json`；
  已存在目录需 `force: true` 替换）。
- **启用（三层开关，全部默认关）**：
  1. 环境变量 `DSH_SOULMOJITO_DISABLE_MODS` 非空（非 `0`/`false`）→ 硬关整面子系统；
  2. `state.json` 的 `modsEnabled`（全局开关，面板「Mod」分区顶部）；
  3. `state.json` 的 `mods.enabled.<id>`（逐 Mod 开关，面板列表行内）。

  2、3 层**同时开**才装载。装上不等于启用。

---

## 2. mod.json 清单参考

校验是纯函数（`src/mods/manifest.ts`），所有失败形态逐条进错误位展示、该 Mod 被跳过
（坏 Mod 不断路，宿主与其余 Mod 照常）。

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | ✅ | 单段 `[a-z0-9-]`（段首尾不为 `-`）或以 `.` 连接的多段（反域名）；≤100 字符；**必须等于目录名** |
| `name` / `version` / `author` / `description` | ✅ | 非空字符串，各 ≤2000 字符 |
| `main` | ✅ | 相对路径、`/` 分隔、不得越出 Mod 目录（拒绝 `..`、绝对路径、反斜杠、以 `.` 开头的段）、必须带扩展名；首尾空白视为非法 |
| `engines.dsh-soulmojito` | — | semver 范围串（语法见下）；装载时对宿主版本判定，不满足 → 跳过并在面板报原因（改名兼容：旧键 `engines.dsh-tavern` 同义读取，2026-10-16；新写入用新键） |
| `loadingOrder` | — | 有限数字，默认 `100`；hook 顺序 / 工具与分区排序的决胜键（升序） |
| `capabilities` | — | `llm` \| `network` \| `storage` 的子集（去重）；**知情同意标签**，不是隔离——唯一的技术强制是 `llm`：不声明就没有 `api.llm` 这个键 |
| `panel` | — | `{ title: string, icon?: string }`；声明后面板出现该 Mod 的 iframe 分区（§13） |
| `buttons` | — | `string[]`：声明式按钮的**显示名**（允许 CJK）；≤8 项、每项 trim 后非空 ≤40 字符、去重（重复 = 清单校验失败）。声明后宿主在 Mod 面板分区头与 ST 聊天视图渲染按钮 chip，点击经 `POST mods/<id>/button/<name>` 分发到 `api.onButton`（§5）；启用确认弹层披露按钮数量与名单 |
| `games` | — | `string[]`：声明本 Mod 将经 `api.games.register` 注册的游戏 id（§18）；≤8 项、每项非空 ≤80 字符、`[a-z0-9-]` 标签或 `.` 连接的反域名形态、去重。注册时 id 必须以 `<modId>.` 为前缀**且**在名单内，否则 setup 抛错进错误位（镜像 `buttons` 的「未声明即拒」） |
| `surfaces` | — | `{ hooks: string[], tools: string[], http: string[] }`，各 ≤32 项、每项 ≤200 字符；**作者自查声明**，未装载时启用确认弹层展示它，已装载时展示**实际注册**的名单（事实优先于声明） |

### engines 范围语法（自写 semver 匹配器）

- `||` 分隔多选一；分支内空格分隔的比较器做 AND。
- 比较器：`*`（任意）、`>=v`、`<=v`、`>v`、`<v`、`=v` 或裸 `v`（精确）、`^v`（最左非零段
  起的上界：`^0.5.1` ⇒ `>=0.5.1 <0.6.0`；`^1.2.3` ⇒ `<2.0.0`）、`~v`（`~0.5.1` ⇒
  `>=0.5.1 <0.6.0`；`~0.5` ⇒ `>=0.5.0 <0.6.0`；`~1` ⇒ `<2.0.0`）。
- 缺段补 0（`0.5` == `0.5.0`）；prerelease 后缀解析后忽略。
- 版本或范围不可解析 → **fail-closed**（不满足，面板展示原因）。
- **0.x 陷阱**：`^0.4.1` ⇒ `>=0.4.1 <0.5.0`——主版本为 0 时 caret 锁的是**次段**，
  宿主升次版本（0.4.x → 0.5.0）即越界：Mod 在扫描阶段被拦进 blocked，面板报
  「错误」并展示 `requires dsh-soulmojito … (host …)` 原因。要跨次版本兼容写 `||`
  分支（`^0.4.1 || ^0.5.0`）；只声明实际验证过的版本
  （踩坑实录：[decisions/2026-10-12-story-clock-engines-drift.md](../../decisions/2026-10-12-story-clock-engines-drift.md)）。

```jsonc
"engines": { "dsh-soulmojito": "^0.6.7" }   // 宿主 0.6.x 且 ≥0.6.7
```

---

## 3. 生命周期：装载、卸载与重载

**装载**（`apply()` 内 stores 就绪后）：扫描 `mods/` 直接子目录 → 只读 `mod.json` 过校验
（此时不执行任何 Mod 代码）→ engines 判定 → 入口存在性检查 → 三层开关裁决 →
`import(pathToFileURL(entry))` 动态加载 → 调 `setup(api)` → `setup` 返回函数则并入 dispose 链。
任何一步失败：记审计（`skip` / `load-error`）+ 面板错误位，跳过不断路。

**卸载**（disable / 目录消失 / 宿主停用），依次执行：

1. dispose 链（`setup` 返回值与 `api.onDispose` 注册项，**后注册先清**）；
2. 定时器清空；
3. 该 Mod 注册的全部 `api.*` 面（事件 → hooks/tools/macros/stscript/prompt.section 路由）——
   **宿主托管全量反注册**，不依赖你手动 off；
4. 存储在飞写排空（`flush`——卸载返回后该实例不再有任何在飞写）。

**重载**（`POST mods/<id>/reload`）：调旧 dispose 链 → `?t=` cache-bust 重新 import。
**ESM 实例驻留是已知限制**：旧模块实例的模块级副作用（globalThis 挂钩、闭包）无法回收。
纪律：**一切注册必须走 `api.*`**，宿主持全量 disposer；不要自己往 globalThis / 计时器 /
进程挂东西。

**setup 抛错**：该 Mod 进错误位（面板可见原因），不装其余面照常。

---

## 4. API 总表

`setup(api)` 收到的是宿主白名单适配对象（TemplateHost 模式，不透传宿主 ctx）：

| API | 语义 | 关键约束 |
|---|---|---|
| `api.version` | `1`（`MOD_API_VERSION`）；破坏性变更升 2 | — |
| `api.logger.{info,warn,error}` | 带 `[mod:<id>]` 前缀的宿主日志 | — |
| `api.storage.{get,set,delete}` | 私有 JSON kv：`<tavern>/mods/<id>/data/state.json` | 单值 256KB / 总量 1MB；原子写 |
| `api.assets.*` | 只读资产快照（12 个方法，deepClone） | 无任何写路径 |
| `api.events.on(kind, handler)` | `chat-saved` / `assets-saved` / `guides-changed` / `stream-delta` | 逐个吞错，失败进审计（`stream-delta` 高频，首错纪律见 §5/§15） |
| `api.onButton(name, handler)` | 声明式按钮的点击 handler（name 必须在 manifest `buttons` 里声明） | 同名重复注册抛错；返回反注册；宿主托管卸载回收 |
| `api.timers.{setInterval,clearInterval}` | 定时器 | 宿主绑定生命周期，卸载自动清 |
| `api.http.route(method, path, handler)` | 挂 `/api/dsh-soulmojito/mods/<id>/<path>` | path 白名单；`reply.json/html` 两出口 |
| `api.hooks.on(phase, handler)` | ST 生成管线五相位 | waterfall + 10s 超时降级不中断生成 |
| `api.tools.register(def)` | Agent 工具（AgentTavern/AgentNovel） | name 强制 `<modId>_` 前缀；三层查重 |
| `api.macros.register(name, fn)` | 全局宏（四个引擎实例化点全部生效） | 确定性强制（静态筛查 + 运行期降级） |
| `api.stscript.registerCommand(name, spec)` | STscript 命令 | `[a-z0-9_]+`；禁覆盖内置 |
| `api.prompt.section({name, text, order})` | AgentTavern system prompt 分区 | order 钳制 -50..0；文本过 prompt-safety |
| `api.games.register(def)` | 注册标准游戏（提案 0018 游戏桥第 3 源），进入「游戏」面板与 Agent `game_*` 工具面 | id 强制 `<modId>.` 前缀且须在 manifest `games` 声明；engine 过契约烟测（§18） |
| `api.llm.{request,stream}` | 宿主 LLM 代理（流收集出口） | **仅 `capabilities` 含 `llm` 时该键存在** |
| `api.onDispose(fn)` | 追加清理 | 与 setup 返回的 dispose 合并（逆序） |

所有注册面（hooks/tools/macros/stscript/prompt.section/http）都返回反注册函数——**你可以
忽略返回值**（宿主卸载时统一回收，story-clock 示范这一路），也可以保存下来在运行期主动
撤销（mood-tracker 示范这一路）。

---

## 5. 基础面

### api.logger

```js
api.logger.info('...')   // 输出形如 dsh-soulmojito: [mod:<id>] ...
api.logger.warn('...')
api.logger.error('...')
```

### api.storage

私有 JSON kv。**键**：`/^[\p{L}_][\p{L}\p{N}_.-]{0,63}$/u`（Unicode 字母或 `_` 开头，字母
数字 `_.-` 续接，≤64 字符）——聊天 id 等外部字符串做键前先清洗。**值**：JSON 可序列化
（函数/symbol/非有限数字拒绝）；单值序列化后 ≤256KB，全部合计 ≤1MB，超限**抛错不静默丢**
并记 `storage-quota` 审计。文件损坏时抛错（提示删 `data/state.json` 重置）。

```js
await api.storage.get('counter')            // JsonValue | undefined
await api.storage.set('counter', 3)          // 读改写串行化 + 原子落盘
await api.storage.delete('counter')          // boolean（是否存在）
```

丢弃 `set` 返回的 promise 也不会产生进程级 unhandled rejection（宿主观察分支记审计）。

### api.assets

只读快照，全部 `structuredClone` 深拷贝（改副本不影响本体）：

| 方法 | 返回 |
|---|---|
| `listCharacters()` / `listWorlds()` / `listPresets()` / `listPersonas()` / `listGroups()` | `string[]` |
| `getCharacter(name)` | 角色卡 IR（`{kind, card}`）或 `null` |
| `getWorld(name)` / `getPreset(name)` / `getPersona(name)` / `getGroup(name)` | 对应 IR 或 `null` |
| `listChats(character)` | `string[]`（聊天 id） |
| `getChat(character, chatId)` | `{header, messages}` 或 `null`；**聊天变量在 `header.chat_metadata.variables`** |

没有写路径——聊天写回一律走 hooks 变换或 STscript（由核心落盘，提案 §6 裁剪）。

### api.events

| kind | payload | 发射时机 |
|---|---|---|
| `chat-saved` | `{character, chatId, revision, floorCount}` | 聊天落盘后（PUT chat / guides 写入 / 生成两段落盘 / STscript persist）。`floorCount` = 落盘后楼层总数（messages.length 原始计数）——「每 N 楼执行」类调度直接比对这个字段，不必整聊拉取 |
| `assets-saved` | `{kind, name}` | 资产保存/导入后（character/world/preset/persona/group） |
| `guides-changed` | `{character, chatId}` | 持续指引变更 |
| `stream-delta` | `{mode, character, chatId, text, delta}` | ST 生成循环每收到一个正文 text-delta chunk（累积拼接之后）。`mode ∈ send/regenerate/trigger`；`text` = 当前累积全文（fully 通道），`delta` = 本次增量（incrementally 通道）——一个事件双字段，Mod 自选粒度做打字机进度 / 实时 UI |

```js
const off = api.events.on('chat-saved', async (payload) => { ... })   // 返回反注册
```

handler 抛错：吞掉 + `event-error` 审计，不影响其他监听方与宿主落盘。未知 kind 注册期抛错。

`stream-delta` 的专用纪律（高频路径）：

- **handler 要快、别做重活**：每 chunk 一次，一轮生成几十上百次。宿主**不等待**
  handler（投递异步且串行保序，慢 handler 不会节流生成），但 handler 里的存储写、
  LLM 调用等重活仍是自找的放大器——累积统计用节流/末次快照，别逐 chunk 落盘。
- reasoning 增量**不进事件**（v1 只观察正文）；Stop/abort 后停发。
- 覆盖范围（v1 如实）：只覆盖 **ST 生成循环**（runGeneration 的 llm.stream 消费点，
  send/regenerate/trigger 三 mode）。AgentTavern 生成走宿主 AgentLoop，本事件**收不到**
  ——流式观察对 AgentTavern 的可达性是 v1 范围外。
- **不进 §13 的 iframe 下行**（`dsh-soulmojito:mod-event`）：流式高频广播到浏览器面
  弊大于利，iframe UI 需要进度时走自己的 HTTP 子路由拉取。

### api.onButton（声明式按钮）

manifest `buttons: ["显示名", …]` 声明按钮 → 宿主渲染（Mod 面板分区头 chips +
ST 聊天视图的紧凑按钮行）→ 用户点击 → `POST /api/dsh-soulmojito/mods/<id>/button/<name>`
→ 分发到你注册的 handler：

```js
const off = api.onButton('拨快 1 小时', async (click, context) => {
  // click:   { name }            —— 被点击的按钮显示名
  // context: { character?, chatId? } —— 点击时可得的聊天归因；面板 chips 没有
  //           绑定上下文时字段缺省，代码不得假设它存在
  await api.storage.set('lastClick', { name: click.name, ...context })
})
off()   // 可选：运行期撤销（不调用也行——卸载时宿主整组回收）
```

- name 必须是 manifest `buttons` 里声明过的显示名（注册期校验，未声明即抛错）；
  同名重复注册抛错；返回反注册函数；卸载时宿主托管回收（对齐其他 `api.*` 面）。
- 声明了但没注册 handler 的按钮：路由答 200 `{ ok: true, handled: false }`
  （可选消费语义）；handler 正常执行答 `{ ok: true, handled: true }`。
- handler 抛错：`button-error` 审计 + 路由 500；**正常点击不审计**（高频路径）。
- 未装载 / 未知按钮 / 任一层开关关闭：404，与未知路由不可区分（§6 纪律）。
- **写边界（v1 如实）**：按钮 handler 没有聊天/资产写面——要改动聊天变量或资产，
  仍然走 hooks/STscript 由核心落盘（§17）。按钮适合触发 Mod 自有状态、外部
  副作用（storage/llm/日志）与「提示用户下一步」的展示逻辑。

### api.timers

```js
const timer = api.timers.setInterval(() => { ... }, 5 * 60 * 1000)   // ms 非法收 1
api.timers.clearInterval(timer)
```

handler 同步抛错与异步拒绝都被适配层包装进 `timer-error` 审计，不会变成进程级崩溃；
卸载时宿主自动 clearInterval。

### api.onDispose

```js
api.onDispose(async () => { await flushSomething() })   // 与 setup 返回的 dispose 合并，逆序执行
```

---

## 6. HTTP 面：api.http.route

路由挂 `/api/dsh-soulmojito/mods/<id>/<path>`。**method**：`GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS`。
**path**：非空相对路径，段 `[A-Za-z0-9][A-Za-z0-9._-]*` 以 `/` 连接，≤200 字符，拒绝 `\`、
`%`、`.`/`..` 段（穿越在注册与分发两侧都拒）。同 method+path 重复注册抛错。**保留段**：
`POST` 的 `enable`/`disable`/`reload` 是宿主管理路由（先于子路由分发被截获），`POST` 的
`button` 与 `button/<name>` 是宿主按钮分发路由（§5 onButton，先于子路由分发被截获）——
这些组合注册即抛错；`GET ui` 不在此列——那是面板 iframe 表面的约定路径（§13），由你的
Mod 自行注册。

```js
api.http.route('GET', 'stats', async (req, reply) => {
  const body = await req.json()          // POST/PUT/PATCH…：请求体 JSON（≤2MB，空体 {}）
  const q = req.query.get('x')           // URLSearchParams
  reply.json({ ok: true, value: 42 })    // JSON 出口（默认 200；可传状态码）
  // 或 reply.html(doc, csp?)            // HTML 出口：自动注入 CSP meta（§13）
})
```

- `reply.json(body, status = 200)`：`content-type: application/json`、`cache-control: no-store`。
- `reply.html(document, csp?)`：`nosniff`；把 CSP meta 注入 `<head>` 最前（无 `<head>` 补骨架）。
  默认策略与美化前端同款：`default-src 'none'; script-src 'unsafe-inline'; style-src
  'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none';
  form-action 'none'`——**浏览器 fetch 被封死**，Mod UI 取数走 postMessage 桥（§13）。
- handler 必须**发出一个响应**（`reply.json`/`reply.html`），否则宿主兜底 500；抛错同样兜底
  成 500 JSON 错误体 + `http-error` 审计。
- 任一层开关关闭 / 未装载 / 无此路由：一律 404，与未知路由不可区分（不泄露 Mod 是否存在）。

---

## 7. 管线 hook：api.hooks.on（五相位）

`runGeneration` 的五个既有变换点升格为总线相位（`src/generation-hooks.ts`）。**顺序
waterfall**：按 `loadingOrder` 升序（平局按注册先后），前一 hook 的输出是后一 hook 的输入。
**单 hook 10 秒超时**；抛错 / 超时 / 忘了 return 统一降级：跳过该 hook（保进入前的值继续），
记 `hook-degradation` 审计（归因到你的 mod id），**绝不中断生成**（renderText 失败保原文
同款纪律）。

| 相位 | 位置 | payload（输入→输出） | 典型用途 |
|---|---|---|---|
| `user-input` | USER_INPUT regex 之前 | `string`（用户原文）→ `string` | 输入清理/规范化 |
| `pre-assemble` | assemblePrompt 之前 | 装配输入 draft → 同形（字段同 `AssembleInput`：`card/preset/personaDescription?/messages/worldInfoBefore/worldInfoAfter/beforeExamples?/afterExamples?/depthInjections?/maxContextTokens?/maxResponseTokens?`） | 改历史/lore/卡面；群聊 nudge 在 `messages` 末尾可见可改写 |
| `pre-llm` | llm.stream 之前 | `{messages, system?, params}` → 同形 | 最终请求改写（对齐宿主 agent/request 语义） |
| `post-output` | AI_OUTPUT regex 与渲染之前 | `string`（模型原文）→ `string` | 输出观察/改写 |
| `post-save` | saveChat 之后 | `{chat, revision, speaker, finalText}`（**返回值被丢弃**，只读观察） | 落盘后统计 |

pre-llm 改写 `params.provider/model` 后，落盘元数据（`swipe_info[].extra`、消息 `extra`、
宿主会话轨迹）记录**改写后的实参**——与实际发给 llm.stream 的请求一致，不记生成器选择器的
原值。

context（第二参数，只读）：`{phase, mode: 'send'|'regenerate'|'trigger', character, chatId, group}`。

```js
api.hooks.on('post-output', async (text, context) => {
  return text.replace(/foo/g, 'bar')   // 必须 return；忘 return 按 no-return 降级
})
```

观察位（不改写就原样返回）是 hook 最安全的用法；改写位要幂等、要快（10s 上限内）。

---

## 8. Agent 工具：api.tools.register

形状对齐宿主 `tool()` 工厂，进入 **AgentTavern / AgentNovel** 的模型工具面（跨 bundle 经
globalThis 注册表互见；**新会话必然可见**，既有会话经变更通知尽力补齐、不承诺免
recompose 生效——与内置工具同语义）。ST 循环没有工具面（不对称是刻意的，见 §11）。

```js
api.tools.register({
  name: 'com.author.my-mod_lookup',        // 强制 `<modId>_` 前缀；[A-Za-z0-9][A-Za-z0-9._-]*，≤64
  description: 'What it does (for the model).',   // ≤4000 字符
  parameters: {                             // JSON Schema（参数面）
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],  // 结果→文本块
  },
  execute: async (args, exec) => {          // exec: { agent?: {id}, signal? }
    return { result: '...' }
  },
})
```

- **三层查重冲突即拒**（setup 期抛错 → 状态错误位，不静默）：本 Mod 重复名、内置工具
  （约 60 个，`tavern_*`/`memory_*`/`variable_*`/`novel_*`/`card_*`/`world_*`/`preset_*`/
  `material_*`/`chat_log_read` 等）、其他 Mod 的工具。
- `execute`/`render` 在调用时活查注册表：reload 换行为不必等重注册。
- Mod 被禁用后 execute 拒绝并明确报「工具已不可用」。

---

## 9. 宏：api.macros.register

注册**全局宏**，对全部四个宏引擎实例化点生效（runGeneration / STscript / 宏展开 API /
prompt-safety 冻结上下文）。引擎实例创建时吸收注册表快照——生成中途的新注册不影响本轮。

```js
api.macros.register('greeting', (args, engine) => {
  // args: {{greeting::a::b}} → ['a', 'b']（:: 分隔，可空）
  // engine.getVar/setVar…：聊天级变量；engine.expand / snapshotVars
  const who = engine.getVar('who') ?? 'traveler'
  return `hello ${who}`        // string 替换；null = 保留原文不替换
})
```

约束：

- name ≤64 字符、不含大括号/空白、大小写不敏感；与内置宏（`char`/`user`/`getvar`/…）或
  已有注册冲突 → 注册期抛错。
- **确定性强制**：宏进入 prompt-safety 冻结求值上下文，非确定宏会烧掉受保护 system 头的
  字节稳定承诺。注册期对 handler 源码静态筛查随机/时间源（`Math.random` / `Date.now` /
  `new Date` / `performance.now` / `hrtime` / `crypto.` / `setTimeout` / `setInterval` /
  `process.env`），命中即拒（best-effort：命名函数闭包源不可见）；运行期抛错或返回
  Promise（非同步）→ 降级保原文 + 首次错误记 `macro-error` 审计。
- 需要跨调用状态时用**同步内存缓存 + 别处回填**（hook/命令/事件写，宏只读）或聊天变量
  （`engine.getVar`，天然按聊天隔离——story-clock 的 `{{clock}}` 即此模式）。

---

## 10. STscript 命令：api.stscript.registerCommand

往 STscript 命令表加命令（用户在输入框以 `/名字` 调用，支持 `|` 管道与 `{{pipe}}`）。

```js
api.stscript.registerCommand('mycmd', {
  name: 'mycmd',                      // 可省（宿主以第一参数为准）
  aliases: ['mc'],                    // 可选，同字符集
  run: async (cmd, env, tools) => {
    // cmd:   { name, raw, args: string[], named: Record<string,string> }
    //        （raw=原始参数串；args=位置参数（引号感知）；named=key=value）
    // env:   聊天/全局变量读写 + expand + echo + 聊天动作钩子（send/trigger/…，按部署可用）
    // tools: { rng(), changed(), runNested(text, env) }
    const value = env.getVar('score') ?? 0
    env.setVar('score', value + 1)
    return tools.changed()            // { output: '', chatChanged: true }
    // 或 { output: '文本', chatChanged: false }——output 进管道
  },
})
```

- 命令名/别名 `[a-z0-9_]+`、≤40（自动小写化）；**禁覆盖内置命令**（冲突即拒）。
- **chatChanged 语义**：`true` 告诉宿主「聊天（含你刚 setVar 的变量）需要落盘」——写完
  `env.setVar` 返回 `tools.changed()`（或 `{output, chatChanged: true}`），与内置 `/setvar`
  同款；纯读命令返回 `chatChanged: false`。
- 抛错按命令失败如实上抛（脚本中断）；异步 handler 支持。

---

## 11. AgentTavern prompt 分区：api.prompt.section

往 **AgentTavern / AgentNovel** 的 system prompt 注册分区。ST 生成循环没有这条腿（两架构
本不对称：ST 自有循环 vs 宿主 AgentLoop——各自覆盖面如实分开，见 §7/§8）。

```js
api.prompt.section({
  name: 'my-notes',                          // [A-Za-z0-9][A-Za-z0-9._-]{0,63}
  text: 'Static guidance text for the model', // 非空，≤64KB
  order: -40,                                 // 可选；宿主钳制 -50..0
})
```

- **order 钳制 -50..0**：核心分区占 -80..-64（kernel/preset/facts/guides/script），Mod 分区
  永远冲不掉核心头（前缀缓存生命线）；非法/缺省取下界 -50。
- 消费名空间化：`dsh-soulmojito:mod:<modId>:<name>`；文本过 `hostPromptSafe`——**不要写
  `{{...}}`**（残留宏会被宿主当变量渲染，消费侧先中性化）。
- 新会话必然生效；既有会话经变更通知尽力补齐（同工具语义）。

---

## 12. LLM 面：api.llm

**仅 manifest `capabilities` 含 `llm` 时 `api.llm` 才存在**（知情同意的技术强制面）；
部署没有 LLM 服务时调用抛错。

```js
// 请求形状对齐部署的 dsh-llm stream 接口；provider/model 宿主不代填——Mod 需自持配置
// （如让用户在请求体里传，story-clock 的 summarize 路由即此模式）：
const request = {
  provider: '…', model: '…',
  messages: [{ role: 'user', content: [{ type: 'text', text: '…' }] }],
  system: '…',            // 可选
  temperature: 0.7,       // 可选
  maxTokens: 300,         // 可选
}

const result = await api.llm.request(request)
// → { text, reasoning, usage, finish }：流式 chunk 的收集出口
//   （text-delta/reasoning-delta 拼接、usage、finish.reason.kind）

for await (const chunk of api.llm.stream(request)) { … }   // 原始流（需要流式处理时）
```

每次调用（成败均）进审计线：`llm-call`（模型 + 用量）/ `llm-error`。丢弃 `request` 的
promise 不会产生进程级 unhandled rejection（观察分支兜底）。

---

## 13. 面板 UI 表面（iframe + postMessage 桥）

宿主页面**不加载第三方 JS**：manifest 声明 `panel: { title, icon }`，启用后管理面板出现
你的分区，body 是通用 `ModSurface` 组件——iframe 指向你的 `GET mods/<id>/ui` 路由
（约定名，任意路由都行），由你返回自包含 HTML。

iframe 纪律（完整继承美化前端先例）：

- `sandbox="allow-scripts"`、无 same-origin、`referrerPolicy: no-referrer`；
- 服务端注入 CSP meta（§6 默认策略）——**iframe 里不能 fetch**；
- 每次挂载生成随机 token，经 iframe URL 查询段 `?token=…` 交给你的页面；postMessage
  回投时 token 对账 + 事件源必须是该 frame 的 contentWindow，双对账缺一不受理。

### postMessage 数据桥协议

iframe 内脚本（照抄 mood-tracker / story-clock 的样板）：

```js
var token = new URLSearchParams(location.search).get('token') || ''

// ① 取数：发请求 → 父页代理到本 Mod 的 HTTP 子路由 → 回投
parent.postMessage({
  type: 'dsh-soulmojito:mod-request', token, id: 'req-1',
  req: { method: 'GET', path: 'stats', body: undefined },   // method ∈ GET/POST/PUT/DELETE/PATCH
}, '*')
// 收：{ type: 'dsh-soulmojito:mod-response', token, id, ok, status, body | error }

// ② 高度自适应上报：宿主已在所有 reply.html 出口自动注入上报器（见下），手写
//    仅当你想完全接管高度协议时才需要：
parent.postMessage({ type: 'dsh-soulmojito:frontend-height', token, height: document.body.scrollHeight }, '*')
```

- 桥只到**本 Mod** 的子路由（父页代理时拼 `mods/<id>/<path>`）；method 白名单比注册面窄
  （无 HEAD/OPTIONS）；path 与 §6 同字符集。
- 父页把高度钳制在 80..1200px。

### 高度上报器（服务端自动注入，无需手写）

服务端在**所有** `reply.html` 出口自动注入高度上报脚本（与 console reporter 同机制），
token 从 iframe URL 查询段自读（无 token 静默跳过）。上报器纪律（A-4 升级）：

- rAF 单帧合并（ResizeObserver 连发只测一次）+ 高度去重（数值未变零消息）；
- ResizeObserver 同时观察 `documentElement` 与 `body`（head 期 body 未建，
  `DOMContentLoaded` 补挂），保留 `load`/`resize` 触发；
- 500ms 尾随重测兜底（字体晚到/图片解码/观察器偶发漏报的收尾，无变化不发消息）。

自带上报脚本（mood-tracker 样板）照旧兼容：同 token 同协议重复上报在宿主侧幂等。

### 视口高度：`--dt-viewport-height` 与 `100vh` 改写

iframe 高度由内容决定（父页按上报高度调整 iframe），内容里写 `height:100vh` 会引用
iframe 自身高度——循环依赖，"满屏"布局会塌。宿主对此的处理（A-4，无需你做任何事）：

- 服务端注入前把 `<style>` 块与内联 `style="…"` 里的 `100vh`/`100dvh`/`100svh`/
  `100lvh` 改写成 `var(--dt-viewport-height, 100vh)`；
- 注入脚本把宿主**真实可视区高度**挂到 `--dt-viewport-height`（挂载时初始化 + 宿主
  resize 时经 `dsh-soulmojito:viewport` 下行消息更新——消息只下行，iframe 不需要监听它）。

对 Mod UI 作者的含义：**按"满可视区"意图放心写 `100vh`**（含 `calc(100vh - 24px)`
这类组合），改写后即真实视口高度；若你的页面确实想要"iframe 内容高度"语义，直接
用 `100%`（相对父元素，不经改写）。非 100 数值（如 `50vh`）不改写——需要半屏时写
`calc(var(--dt-viewport-height, 100vh) * 0.5)`，或用 `50%`。

### 下行事件：`dsh-soulmojito:mod-event`

宿主把**本客户端发起的**写入推回挂载中的 mod iframe（每个挂载面各自收到带自己
token 的消息）：

```js
addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'dsh-soulmojito:mod-event' || data.token !== token) return
  // data.kind ∈ 'chat-saved' | 'assets-saved' | 'guides-changed' | 'button-click'
  // data.payload 与 Node 侧 api.events 的 payload 同形；button-click 是
  // { mod: <modId>, name: <按钮显示名> }
  if (data.kind === 'chat-saved') refresh()
})
```

**诚实边界（v1）**：下行事件只覆盖本客户端（本标签页）发起的成功写入——PUT chat、
生成两段落盘、STscript persist、guides 写入、资产保存/导入、声明按钮点击。**其他
标签页或服务端侧的写入不推送**：mod UI 应保留拉取/轮询兜底（事件当加速器，不当
唯一事实源）。mood-tracker 示范「事件到达即刷新 + 初始拉取兜底」这一路。

### 日志上报：console reporter 与 `dsh-soulmojito:mod-log`

服务端在**所有** `reply.html` 出口（不只 `GET ui`）注入一段 console reporter 脚本
（与 CSP meta 注入同机制）：

- 从 iframe URL 查询段自读 `token`，**无 token 静默跳过**（直接 curl 该路由不产生消息）；
- wrap `console.log/warn/error`（原方法照常调用，iframe 控制台里仍可见）+
  `window.onerror` + `unhandledrejection`，经 postMessage 回投
  `{ type: 'dsh-soulmojito:mod-log', token, level, text }`；
- args 逐个序列化（字符串直出、其余 JSON.stringify，失败退 String）拼接，单条截断
  ~2KB（防刷爆）。

宿主页把回投日志收进 **per-mod 环形缓冲（≤200 条，内存态）**，Mod 面板该 mod 分区
底部的「Mod 日志」折叠视图展示（时间 + level 着色 + 文本）。日志随页面重载清空，
不落盘、不进审计线——它是排障面，不是取证面（取证走宿主日志与审计线）。

---

## 14. 管理 HTTP 端点

| 端点 | 语义 |
|---|---|
| `GET /api/dsh-soulmojito/mods` | 管理快照 `{ok, available, reason?, globalEnabled, mods: ModInfo[]}` |
| `POST /api/dsh-soulmojito/mods/state` | `{globalEnabled}` 全局开关 |
| `POST /api/dsh-soulmojito/mods/install` | `{url, force?}` git 安装（§1） |
| `POST /api/dsh-soulmojito/mods/<id>/enable` \| `disable` | 逐 Mod 开关（enable = 装载） |
| `POST /api/dsh-soulmojito/mods/<id>/reload` | dispose → cache-bust 重载 |
| `POST /api/dsh-soulmojito/mods/<id>/button/<name>` | 声明式按钮点击分发（§5 onButton）；响应 `{ ok, handled }` |
| `ANY /api/dsh-soulmojito/mods/<id>/<path>` | Mod http 子路由（§6） |

`ModInfo`：`{id, name, version, author, description, capabilities, loadingOrder, panel,
status: 'loaded'|'disabled'|'error', error, auditCount, surfaces: {hooks, tools, http},
buttons}`。
管理面在任何一层关闭时仍可用（否则用户无法再打开）；`install` 是管理保留段（不能当 mod id）。
`GET bootstrap` 的 `mods` 投影含同款字段 + `enabled`（= status==='loaded'）。

---

## 15. 审计事件

`<tavern>/mods/audit.jsonl` 追加式 JSONL，每行 `{ts, mod, event, detail?}`。面板展示**本进程内**
计数，完整历史在文件里。

| 事件 | 含义 |
|---|---|
| `load` / `reload` | 装载 / 重载成功 |
| `enable` / `disable` | 开关翻转（`mod: '*'` 为全局） |
| `remove` | 目录消失自动卸载 |
| `skip` | 坏清单 / engines 不满足 / 入口缺失——跳过（含原因） |
| `load-error` | setup 抛错或入口形状非法 |
| `dispose-error` | dispose 链 / 反注册单项失败 |
| `hook-degradation` | 管线 hook 抛错/超时/忘 return 被降级跳过 |
| `http-error` | Mod 路由 handler 抛错（500 兜底） |
| `event-error` / `timer-error` | 事件 / 定时器 handler 失败。**首错纪律（`stream-delta`）**：每流代次（每次生成）每 Mod 只记第一条，detail 标注 `stream-delta: … (further … silenced)`，同代次后续静默吞掉（handler 仍逐个吞错不中断生成）；其余 kind 逐次审计 |
| `button-error` | 声明式按钮 handler 点击分发失败（正常点击不审计） |
| `storage-quota` / `storage-error` | 超配额 / 存储读写失败 |
| `macro-error` | 宏运行期首错（降级保原文） |
| `llm-call` / `llm-error` | api.llm 调用与用量 / 失败 |
| `install` / `install-error` | git 安装成败 |

---

## 16. 示例索引

四个官方示例都在 `packages/plugin/examples/mods/`，同时是 e2e 测试与 gate 的夹具：

| 示例 | 演示的能力面 |
|---|---|
| `dsh-soulmojito.asset-stats` | assets 只读快照、http JSON 出口、storage 配额内持久化、chat-saved 事件、setup 返回 dispose |
| `dsh-soulmojito.mood-tracker` | post-output hook（改写位+返回契约）、Agent 工具对（`<modId>_` 前缀）、panel 声明 + iframe UI + postMessage 桥 + 高度上报、mod-event 下行订阅（事件到达即刷新，拉取兜底）、console 日志上报（宿主日志查看器）、`reply.html` |
| `dsh-soulmojito.story-clock` | 宏（{{clock}} 读聊天变量，确定性模式）、STscript 命令族（位置/命名参数/别名/chatChanged）、声明式按钮（「拨快 1 小时」，onButton 复用 /clock advance 的推进逻辑）、user-input 变换位与 post-save 观察位 hook、prompt.section（order -40）、api.llm（capability 门 + request 收集出口 + 用量审计）、timers、assets-saved/guides-changed 事件、宿主托管卸载（不持 off 句柄） |
| `dsh-soulmojito.rps` | 游戏注册（§18）：manifest `games` 声明 + `api.games.register`（进程内引擎对象 + 内联 view 字符串）、三局两胜回合制建模、无自有面板（游戏出现在「游戏」分区） |

四个示例合计覆盖 v1 全部能力面。新 Mod 建议从最接近的示例拷起。

---

## 17. 纪律与限制：什么时候不该写 Mod

先看既有面是否已经够用（提案 0015 §2.3 的分工表）：

| 需求 | 该用的既有面（不是 Mod） |
|---|---|
| 提示词内计算/注入 | EJS 模板面（变量族/资产读取/回执重试） |
| 文本改写 | regex 四 placement + promptOnly/markdownOnly（落库/prompt/展示三层） |
| 消息内展示 UI | 美化前端 iframe 面 |
| 简单聊天自动化 | STscript 内置命令 |

**只有 Mod 能做的**：跨相位管线组合、注册表扩展（宏/STscript 命令/面板分区）、新 Agent
工具、新 HTTP 路由、长生命周期任务、组合以上任意多项。

其余硬边界：

- **无沙箱**：进程内代码天然握有 `process`；capabilities 是知情同意标签（唯一技术强制是
  `llm` 键的存在性）。只装可信来源。
- **不透传宿主 ctx**：`api` 是白名单适配对象；宿主内部面不是稳定契约。
- **不直接写聊天/资产**：聊天写回牵动 CAS/投影/会话准入三重纪律，v1 一律走 hooks/STscript
  由核心落盘（`api.assets` 只读）。
- **ESM 实例驻留**：reload 不回收模块级副作用；注册必须走 `api.*`，宿主持全量 disposer。
- **确定性宏**：进入冻结求值上下文的宏不许有随机/时间源（静态筛查 + 运行期降级双保险）。
- **ST 扩展不兼容**（永久非目标）：本 API 是自有契约，不为 ST 扩展格式做垫层；ST 资产格式
  兼容不受影响。
- **生成不被拖垮**：五相位全部 10s 单 hook 超时 + 降级；审计计数面板可见，玩家可定位卸载。

---

## 18. 游戏注册：api.games.register

注册一个**标准游戏**进入游戏桥（[提案 0018](../proposals/0018-agent-game-bridge.md)）——游戏
出现在面板「游戏」分区（可开局可对弈），Agent 经 `game_list` / `game_start` / `game_state` /
`game_history` / `game_move` / `game_wait` 六个内置工具与你的人类玩家对局（2026-10-14 增量
修订：wait/move 只回增量，局面与日志分别经 `game_state` / `game_history` 读取）。这是游戏
三条来源（内置 / 导入包 / **Mod**）中 Mod 专属的一条：引擎以**进程内对象**注册（不需要
`engine.mjs` 文件），视图是**内联 HTML 字符串**（维持 Mod 无静态文件服务的纪律）。

```js
// mod.json 先声明：  "games": ["<你的modId>.gesture"]
api.games.register({
  id: 'dsh-soulmojito.rps.gesture',        // 强制 `<modId>.` 前缀 + 必须在 manifest games 名单内
  name: '猜拳', version: '1.0.0',
  players: { min: 2, max: 2, roles: ['first', 'second'] },   // v1 会话恒「一人类一 Agent」，max 必须 2
  turnBased: true,
  actionVocabulary: '出拳 {type:\'throw\', gesture:\'rock\'|\'paper\'|\'scissors\'}；认输 resign 由运行时处理',
  engine: {                            // 提案 0018 §3.2 引擎契约（与导入包 engine.mjs 同形）
    meta: { /* 与顶层冗余字段逐字段相等，运行时以 meta 为准 */ },
    createGame(options) { return { state } },        // state 恒 deep-JSON-safe（≤64KB）
    legalActions(state) { return [action] },          // 有界建议集 ≤64（非合法性依据）
    applyAction(state, action, actor) { /* 纯且确定；非法动作必须抛错 */ },
    describe(state, actor, action) { return '甲方出石头' },   // Agent 对话叙述用文案
  },
  view: '<!doctype html><html>…</html>',  // 自包含渲染页：token 自读 + game-state 监听 + game-action 上行
})
```

纪律（全部 fail-fast：抛错 = 本 Mod setup 失败进错误位，不带病入册）：

- **id 双重门**：`<modId>.` 前缀 + manifest `games` 名单声明（镜像 `buttons` 的「未声明即拒」）；
  与内置/导入/其他 Mod 的游戏三源统一查重，撞 id 即拒。
- **引擎烟测**：注册期跑提案 §4.6 五关——初始态 JSON-safe、建议集有界、首个合法动作连打两次
  deep-equal（确定性——需要随机的游戏用 `options.seed` 自行派生确定性 RNG）、非法动作与保留
  动作 `{type:'resign'}` 必须抛错（resign 由运行时统一处理，引擎静默接受会被烟测拒绝）。
- **双子段对账**：顶层冗余字段（id/name/version/players/turnBased/actionVocabulary）与
  `engine.meta` 逐字段相等，漂移即拒。
- **view 静态检查**：无外链 script/样式、无 `fetch(`（CSP 在服务期兜底，这里提前给可读报错）；
  桥协议见提案 §3.3——服务端注入 token/高度/视口桥脚本，你的页面只管监听
  `dsh-soulmojito:game-state`（带 token 校验）与上行 `dsh-soulmojito:game-action`。照抄
  `examples/games/dsh-soulmojito.gomoku/view.html` 的桥写法即可。

生命周期：返回反注册函数（宿主托管）；Mod 卸载/禁用 → 游戏摘册，其活跃会话**孤儿化**（可查看
不可落子，面板如实展示）；重新装载后孤儿判定按 gameId 动态查表，旧会话自动恢复可玩。反注册带
引擎实例身份对账——reload 后旧实例的反注册触碰新注册是 no-op（`onButton` 同款纪律）。

最小可抄实现：`examples/mods/dsh-soulmojito.rps/`（三局两胜猜拳，回合制建模 + 比分板 view）。
