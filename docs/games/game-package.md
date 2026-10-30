# 标准游戏包制作指南（Game Bridge v1）

> 面向游戏包作者。标准为什么这样设计见[提案 0018 §3](../proposals/0018-agent-game-bridge.md)；
> 本文件是「照着做」的操作文档。运行时校验与一致性套件是唯一事实来源——标准不是
> 文档，是可执行断言（`tests/games-gomoku.spec.ts` / `tests/games-import.spec.ts`）。

## 1. 一个游戏包是什么

一个目录、三个文件：

```
com.example.my-game/
├── game.json     清单：id / 名字 / 版本 / 角色 / 动作词汇表
├── engine.mjs    纯逻辑引擎：ESM 默认导出无状态纯函数对象（Node 侧权威）
└── view.html     自包含渲染页：iframe 内运行，只与宿主交换两条消息
```

硬性约束：

- **`id` 即安装目录名**：手工放入数据根的 `games/installed/` 时，目录名必须等于
  `game.json` 的 `id`（扫描期校验，不符即 broken）；面板上传 zip / git 安装由清单
  `id` 决定落盘目录（源目录/包装目录名不参与校验）。建议包目录始终用 `id` 命名，
  避免两种路径的认知混淆。
- **三件套必须齐全**：缺 `engine.mjs` / `view.html` 以 broken 入册（面板灰显 + reason）。
- **`view.html` 必须自包含**：无外链 script / 样式 / 图片，无 `fetch(`（运行时 CSP
  `connect-src 'none'`；外链或网络调用在装载期直接拒绝）。
- 导入的 `engine.mjs` 与 Mod 同信任级（进程内执行、可全盘 IO）——**只导入你信任的来源**。

## 2. 清单 `game.json`

```json
{
  "id": "com.example.gomoku",
  "name": "五子棋",
  "version": "1.0.0",
  "engines": { "dsh-soulmojito": "^0.7.1" },
  "players": { "min": 2, "max": 2, "roles": ["black", "white"] },
  "turnBased": true,
  "actionVocabulary": "落子 {type:'place', x, y}；认输 {type:'resign'} 由运行时统一处理"
}
```

| 字段 | 规则（装载期校验） |
|---|---|
| `id` | 非空；`[a-z0-9-]` 段落以 `.` 连接；安装后目录名等于 `id`（手工放入时即包目录名，不符即 broken） |
| `name` | 非空字符串（面板与 Agent 工具面显示名） |
| `version` | 非空字符串（建议语义化版本） |
| `engines` | 可选；`{ "dsh-soulmojito": "^0.7.1" }` 复用宿主版本门控，不满足则 broken「版本不满足」。旧键 `dsh-tavern` 双读兼容 |
| `players.min` / `max` | 整数且 `1 <= min <= max`；`players.roles.length` 必须等于 `max` 且无重复 |
| `players.roles` | 非空字符串数组。面板开局时人类缺省执 `roles[0]`，Agent 执另一方 |
| `turnBased` | v1 明确裁剪实时游戏：必须是 `true` |
| `actionVocabulary` | 非空一句话，写给模型与玩家看的动作词汇表 |

补充约定：

- **v1 会话恒为「一人类一 Agent」**：`players.max` 必须为 `2` 且 `roles` 恰有两个，
  否则开局被拒（引擎可以先按多人写，但桥 v1 不开多人局）。
- 清单与 `engine.meta` 的冗余字段（id / name / version / players / turnBased /
  actionVocabulary）应逐字段一致；不一致时可装载但记 warning，**运行时以 `engine.meta` 为准**。

## 3. 引擎 `engine.mjs`

默认导出对象（无状态、纯函数）：

```js
const META = {
  id: 'com.example.my-game', name: '我的游戏', version: '1.0.0',
  players: { min: 2, max: 2, roles: ['first', 'second'] },
  turnBased: true,
  actionVocabulary: "落子 {type:'place', x, y}",
}

export default {
  meta: META,
  // options.seed 可用于派生确定性 RNG（需要随机的游戏自己实现，如 mulberry32）
  createGame(options) { return { state: { turn: 'first', /* ... */ } } },
  // 当前行棋方的动作建议集：≤64 条，每条必须有 type 字符串
  legalActions(state) { return [{ type: 'place', x: 0, y: 0 }] },
  // 施加动作：纯且确定；非法动作抛错；不改入参
  applyAction(state, action, actor) {
    if (action === null || typeof action !== 'object' || action.type !== 'place') {
      throw new Error('只支持 place 动作')
    }
    const next = structuredClone(state)
    // ... 落子、判胜、换 turn ...
    return { state: next, events: [], finished: false, winner: null, summary: '' }
  },
  // 一手棋的人话描述（Agent 在对话里角色化叙述）
  describe(state, actor, action) { return '甲方落子 (0,0)' },
}
```

导入期烟测五关（任一不过 → broken「烟测失败: …」）：

| 关 | 检查 |
|---|---|
| 1 | `createGame({seed:1})` 返回 `{ state }`；state deep-JSON-safe、序列化 ≤64KB、`state.turn` 是 `players.roles` 之一 |
| 2 | `legalActions(state)` 返回数组且 ≤64 条；每条是带 `type` 字符串的对象；初始建议集非空 |
| 3 | 对首个建议动作连打两次 `applyAction` 结果 deep-equal（确定性），且不修改入参 state |
| 4 | 非法动作必须抛错：保留动作 `{type:'resign'}` 与未知 `type` 双探针 |
| 5 | `applyAction` 返回 `{ state, events, finished, winner, summary }`；新 state JSON-safe 且 ≤64KB |

运行时补充契约（提案未明文但必需）：**`state.turn`** 必须是当前行棋方角色名——
运行时据此推导 actor，缺失或越界直接拒绝开局。

动作语言：任意 JSON 对象，必须有 `type: string`，单动作序列化 ≤4KB；`resign` 是运行时
保留动作（认输），引擎收到必须抛错——运行时统一处理，不走引擎。

## 4. 视图 `view.html`

自包含 HTML（内联脚本/样式），运行时负责注入 CSP、token 桥、高度上报与视口桥。
协议只有两条消息：

- **下行** `dsh-soulmojito:game-state`（宿主 → iframe）：
  `{ type, token, session, view: { state, turn, legal, finished, summary } }`——v1 全量投递，
  宿主在 iframe `load` 后与每次局面变化时发送。
- **上行** `dsh-soulmojito:game-action`（iframe → 宿主）：
  `{ type, token, action }`——人类落子；宿主校验 token 与 `event.source` 后代理到
  `POST games/action/:id`，**合法性由 Node 侧引擎终审**（iframe 说了不算）。

最小桥骨架：

```html
<!doctype html>
<meta charset="utf-8">
<button id="move">落子 (0,0)</button>
<script>
  'use strict'
  var TOKEN = new URLSearchParams(location.search).get('token')

  addEventListener('message', function (event) {
    var data = event.data
    if (!data || data.type !== 'dsh-soulmojito:game-state' || data.token !== TOKEN) return
    latest = data.view
    render(data.session, data.view)
  })

  function render(session, view) {
    // 你的棋盘渲染：view.state 局面、view.legal 建议集、view.finished 终局
  }

  document.getElementById('move').addEventListener('click', function () {
    if (!TOKEN) return
    parent.postMessage({
      type: 'dsh-soulmojito:game-action',
      token: TOKEN,
      action: { type: 'place', x: 0, y: 0 },
    }, '*')
  })
</script>
```

约定：`view.legal` 只是建议集（用于高亮/灰显），不要把它当合法性依据；token 只用于
消息对账，不要把它发给任何远方。无 token 直接打开文件时的静态预览由你自行决定
（[参照包](../../packages/plugin/examples/games/dsh-soulmojito.gomoku/view.html) 的做法可抄）。

## 5. 打包与导入

四种进入方式：

1. **面板上传 zip**（推荐给「朋友发来一个包」）：把三件套目录压成 `.zip`，打开管理面板
   →「游戏」→「导入游戏包」→ 上传。允许 zip 里有一层包装目录（「压缩文件夹」形态）；
   `__MACOSX/`、`.DS_Store` 自动跳过。限制：zip ≤5MB、条目 ≤64、单文件 ≤2MB、解包
   总量 ≤4MB；含 `..` 穿越或绝对路径的 zip 会被拒绝。
2. **从 git 安装**：仓库根目录放三件套（`game.json` 在根），面板填 `owner/repo#ref`
   或完整 URL；clone 后走同一条校验路径。
3. **手工目录**：放进 `$DSH_HOME/soulmojito/games/installed/<id>/`（旧安装仍用
   `$DSH_HOME/tavern/games/installed/<id>/`），重启或调用
   `POST /api/dsh-soulmojito/games/reload`。
4. **Mod 内联注册**（引擎对象 + view HTML 字符串，作者是 Mod 开发者）：见
   [`docs/mods/mod-api.md` §18](../mods/mod-api.md)。

导入成功后游戏立即出现在面板清单与 Agent 的 `game_list`。同名游戏默认拒绝安装；
勾选「覆盖已安装的同名游戏」（或请求体 `force: true`）后替换。

HTTP 面（脚本 / CI 用）：`POST /api/dsh-soulmojito/games/install`，请求体为
`{ path }`（服务端本地目录）、`{ url }`（git 源）或 `{ zipBase64 }`（zip 字节的 base64），
可选 `force: true`。

## 6. 校验与排错

面板与清单里 broken 游戏的 `reason` 对照：

| reason 片段 | 含义 | 修法 |
|---|---|---|
| `清单校验失败: …` | `game.json` 字段/类型/范围不合法 | 按 §2 逐字段修（错误串会点名具体字段） |
| `版本不满足: …` | `engines` 与宿主版本不匹配 | 调整 `engines` 或升级宿主 |
| `view.html 缺失` / `包含外链…` / `包含 fetch(…)` | 视图不自包含或文件缺失 | 去掉外链与网络调用，补齐文件 |
| `engine.mjs 缺失` / `导入失败: …` | 引擎文件缺失或 ESM 语法错误 | 补齐文件、修语法（`export default {…}`） |
| `引擎校验失败: …` | 默认导出不是对象，或缺 `createGame`/`legalActions`/`applyAction`/`describe` | 对照 §3 成员表 |
| `烟测失败: …` | 五关之一不过（原因逐条列出） | 按 §3 五关表逐项修 |
| `已安装` | 同名目录已存在 | 勾选覆盖 / 传 `force: true` |
| `zip 含非法路径` / `条目数超过上限` / `zip 内没有 game.json` | 包形态不合规 | 直接压缩三件套目录（不要带 `..`/绝对路径） |
| `不在注册表`（孤儿会话） | 游戏被卸载但仍有对局 | 重装同 id 即恢复可玩；删会话文件可清 |

手工快速自测：把包放进 `installed/<id>/` → 面板「游戏」刷新；或在仓库内按
[`games-import.spec.ts`](../../packages/plugin/tests/games-import.spec.ts) 的 `service.install({ path })`
路径跑一遍装载（坏包会以 broken + reason 入册，不会崩启动）。

## 7. 参照实现与契约

- 参照包：[`packages/plugin/examples/games/dsh-soulmojito.gomoku/`](../../packages/plugin/examples/games/dsh-soulmojito.gomoku/)
  （三件套齐全、可分发样本、导入路径的一致性参照）。
- 设计契约：[提案 0018 §3](../proposals/0018-agent-game-bridge.md)（标准）、§4.6（烟测五关）、
  §6（meta 权威与信任模型）。
- 一致性套件：`packages/plugin/tests/games-gomoku.spec.ts`（确定性 / JSON-safe / 合法性抛错 /
  尺寸上限）与 `games-builtin.spec.ts`（内置引擎同套烟测）。
- Mod 注册游戏：[`docs/mods/mod-api.md` §18](../mods/mod-api.md)。
