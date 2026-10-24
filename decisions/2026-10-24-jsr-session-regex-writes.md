# JSR 正则会话写面（2026-10-24）

## 背景

酒馆助手（JSR）的 `replaceTavernRegexes` / `updateTavernRegexesWith` 在 ST 里直接改
全局设置、角色卡 `extensions.regex_scripts` 或预设内嵌正则。本插件的沙箱前端没有
这些资产的写权限；此前的 shim 对两个函数一律显式抛错，正则只能由面板编辑。

但正则同时影响生成（prompt / 保存文本）、STscript `/regex` 与浏览器展示。如果只做
写接口而不接读链路，会出现「写入成功但生成/展示不生效」的半实现。本轮把写面收进
**当前聊天的会话覆盖层**，并让所有读面读同一份合并集合。

## 决策

### 落盘位置

复用 `chats/<角色>/<聊天>.jsonl.scripts.json`，新增：

```json
{
  "version": 1,
  "scriptTrees": [],
  "regexScripts": {
    "global": [],
    "character": [],
    "preset": []
  }
}
```

- 每个值必须是对象数组；未知 scope、非数组、非对象元素都会带文件路径显式报错。
- 旧文件没有 `regexScripts` 字段时按「无覆盖」读取，保持兼容。
- 覆盖层与脚本树/脚本变量/会话预设/人设共用同一文件，所有写面继续走
  `serializeSessionWrite`，避免并发丢更新。

### 合并规则

- 基础集合仍由 `collectRegexScripts(state, character)` 产生（全局 + 卡级 + 卡内嵌 +
  预设来源，按所有权过滤、同名去重、卡内顺序恢复）。
- 会话覆盖与基础集合按 `scriptName` 合并：**同名会话脚本替换基础脚本**，会话新增
  名字追加。`global` → `character` → `preset` 依次覆盖。
- 一次 `replaceTavernRegexes(regexes, {type})` 写的是该 `type` 的会话覆盖表。覆盖表
  之外的基础同名脚本不会出现在该表里，因此**覆盖层是"替换/停用"面，不是删除面**：
  要停用基础脚本，写同名 `enabled:false`；要整体回到基础集合，用宿主
  `regex.reset-session`。
- `type:'preset'` 是聊天内预设来源的覆盖副本；切换激活预设后仍按本聊天覆盖生效，
  直到 reset（与预设树按预设名分表不同，边界见下）。

### Helper ops

| op | 负载 | 作用 |
|---|---|---|
| `regex.put-session` | `{ type, scripts }` | 写本聊天 `regexScripts[type]`，返回规范化后的 `{ type, scripts }` |
| `regex.reset-session` | `{ type? }` | 删除对应类型；无 `type` 删除整个正则覆盖；覆盖文件为空则删文件 |
| `regex.get` | — | 返回基础 + 会话覆盖按 `scriptName` 合并后的 ST `TavernRegex[]` |
| `regex.format` | `{ text, placement, scripts?, depth? }` | 显式 `scripts` 优先；否则应用合并集合 |

两个写 op 都要求 `chatId`，因此只能在绑定聊天的 iframe 内调用。

### Shim

- `replaceTavernRegexes(regexes, option)` 保持 JSR 签名；同时接受
  `(type, regexes)` 旧/简写姿势。`option.type` 必填为 `global|character|preset`；
  `option.name` 只允许省略、`current` 或 `in_use`（会话写面不能指定别的卡/预设）。
- ST `TavernRegex`（`script_name` / `find_regex` / `source` / `destination`）在边界
  转成宿主 `RegexScriptIR`；写入成功后更新本地 `sessionRegexScripts[type]`，同步
  getter 立即可读；宿主随后重投快照。
- `updateTavernRegexesWith(updater, option)` 先取本地合并后的 ST 列表副本，执行
  同步或异步 updater，结果必须是数组，再走 put；返回 `Promise<TavernRegex[]>`。
- `getTavernRegexes({ type: 'in_use' })` 返回三来源合并后的生效集；显式
  `global|character|preset` 仍只读该来源（基础 + 同名会话覆盖）。
- `importRawTavernRegex` 仍是显式不可用（原始资产导入不属于会话写面）。

### 读面

所有下列链路都经 `collectSessionRegexScripts` / `readSessionRegexScripts` 读合并集合：

- ST 生成：`previewGeneration`、`runGeneration`、`runTavernScript` 的 `/regex`；
- 宿主 helper：`regex.get` / `regex.format`；
- 快照：`regexScripts` 保持基础分表，新增 `sessionRegexScripts`；shim 在
  `applySnapshot` 接收两者，并在同步读取时按同名规则合并（基础分表先按
  global → character → preset 去重，再让会话覆盖替换同名项，与宿主顺序一致）；
- 浏览器展示：`/display`、`/frontend/latest`、`chat/<id>` 的 `displays`、
  `displayTexts`；
- AgentTavern：投影器 `projectOne` 与激活时的 `historyImportAppends`。

面板的正则列表/编辑器仍只读写基础资产，不展示会话覆盖。

## 边界

1. 覆盖层不能删除基础脚本；只能用同名 `enabled:false` 停用，或 reset 整个覆盖。
2. `preset` 覆盖按聊天生效，不按预设名分表；切换预设后覆盖仍会应用。若未来需要
   严格跟随预设，可把字段升级为按预设名的映射（与 `trees.preset` 同形）。
3. 面板不展示某个聊天的会话覆盖；诊断时直接读 `.jsonl.scripts.json`。
4. `SessionRegexSource` / `ProjectorStore` 的 `getChatJsrOverlay` 是必选方法：
   生产 `TavernStore` 与项目内 test store 都提供，漏接会在类型检查时报错，
   不会静默退回基础集合。
5. 覆盖写面只对**当前聊天**生效；同一角色卡的其他聊天不受影响。
6. 没有 `chatId` 的读取面（未绑定聊天的 iframe、面板正则编辑器、
   `buildSnapshot` 的无聊天分支）只看到基础资产；会话覆盖天然属于某条聊天，
   这些入口不伪造会话作用域。

## 验证

- store：读写、旧文件兼容、非法 scope/形状拒绝、脚本树写入不丢正则覆盖。
- helper e2e：`regex.put-session` → `regex.get` / `regex.format` / `snapshot`；
  同名覆盖、reset、非法负载。
- 生成/展示：preview USER_INPUT、STscript `/regex`、`/display`、AgentTavern 投影、
  `collectSessionRegexScripts` 纯函数合并。
- shim runtime：快照合并、写 op 参数、成功后本地读新值、非法参数不发请求。

## 追加：面板全量保存的大体积请求（同日）

现状 `state.json` 的正则表可达数 MB（实测 150 条、3.3 MiB，含多张状态栏的数百 KB
`replaceString`）。面板每次开关都会把整张表发回 `PUT /regex`，旧路由使用
`readJson(req)` 的默认 2 MiB 上限；超限时读取端会 `req.destroy()`，浏览器看到的是
`net::ERR_CONNECTION_RESET`，而不是结构化错误。该问题与会话正则覆盖层无关，是既有
请求体上限与真实资产体量不匹配。

处理：`PUT regex` 与 `POST import/regex` 改用 25 MiB 上限，与角色卡/人设等大资产
写入一致；新增 `packages/plugin/tests/panel-regex-large-body.spec.ts` 用 20×160 KiB
的合成脚本（>2 MiB）锁住回归。验证：`npx tsc -b` 通过、全量 2084 通过 +1 跳过、
18 项 gates PASS。运行中的 `dsh web` 进程需要重启才会加载新 bundle。
