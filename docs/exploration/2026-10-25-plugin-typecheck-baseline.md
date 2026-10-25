# 插件全量类型检查（2026-10-25 当前状态）

> 基线提交：`48012a9`（工作树干净时测量）。本文记录 `packages/plugin` 从
> “只有 security 切片” 到 **全量 strict 配置接入 `pnpm check`** 的现状。
> 全量命令已实测 exit 0；本文不再保留“部分覆盖”的旧结论。

## 1. 命令与配置

新增 `packages/plugin/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "../..",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

约束与取舍：

- 继承 `tsconfig.base.json` 的 `strict`、`noUncheckedIndexedAccess`、
  `noFallthroughCasesInSwitch` 等，**没有降低任何 strict 项**。
- `rootDir` 取仓库根而不是 `src`：插件源码用相对路径直接引用
  `packages/bind`、`packages/tavern-*` 的 `src`（例如
  `src/index.ts` 的 `../../bind/src/index.js`）。若 `rootDir: "src"`，
  TypeScript 会为这些同仓源文件报 `TS6059`；这类错误不是类型债务，因此
  把 `rootDir` 提到 `../..`，让被引用的工作区源码也落在根目录内。
- `include` 仍只列插件自身 `src/**/*.ts`；被 import 的工作区源码由
  TypeScript 自动进 program，不额外声明 `include`。
- `noEmit` 保证此配置只做检查，不生成 `lib/` 或 bundle。

等价验证命令：

```text
node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --pretty false
# 实测 exit 0，0 个 error TS
```

`packages/plugin/tsconfig.security.json` 保持原样，继续只覆盖
`http/trust.ts`、`http/errors.ts`、`http/io.ts` 三个安全边界文件。

## 2. 错误计数（实测）

| 阶段 | 配置 | 错误数 |
|---|---|---|
| 初始临时测量 | strict + `rootDir: "src"` | 531（含 71 个 `TS6059`） |
| 初始临时测量 | strict，`rootDir` 为仓库根 | **460**（真实类型债务） |
| 最终 | `packages/plugin/tsconfig.json`，base strict | **0** |

531 与 460 的差值全部是 `TS6059`：插件跨包引用同仓源码导致，未计入真实
债务。其余 460 个错误从 `TS7006`（隐式 any 参数）、`TS18046`（unknown 取
属性）、`TS2339`/`TS2345`/`TS2322` 为主，集中在 `generation/pipeline.ts`、
`helper.ts`、`http/router.ts`、`games/builtin/dungeon-crawl.ts`、
`session/trace.ts`、`http/panel.ts` 等模块。

## 3. 修了哪些域

### 3.1 宿主边界

新增 `src/host-contract.ts`，用最小结构接口建模插件实际调用的宿主面：

- `PluginContext`：`llm`、`agentDefaultModel`、`systemPrompt`、`webServer`、
  `commands`、`effect`、`logger`、`agents`、`tools`、`agentPresets`、
  `compaction`、`sessionTitle`、`sessionProjections` 等；
- `HostLlmService` / `HostLlmRequest` / `HostLlmChunk` / `HostModelSelection`：
  `ctx.llm.stream` 的请求与 `text-delta`、`reasoning-delta`、`usage`、
  `block-end`、`finish` 分块；
- `HostWebRequest` / `HostWebResponse` 直接复用 Node 的
  `IncomingMessage` / `ServerResponse`（`http/io.ts` 的
  `JsonRequest` / `JsonResponse` 仍是测试替身可满足的宽结构）。

`src/index.ts`、`generation/pipeline.ts`、`http/{router,panel,novel,memory,mods,update}.ts`、
`model-catalog.ts`、`memory-maintenance.ts`、`candidates.ts`、`compaction/curator.ts`
现在都通过这些边界类型读取宿主能力，不再依赖隐式 `any`。

### 3.2 HTTP 路由与 helper

- `handleApi`、各子路由 handler、`handleHelperApi`、
  `handleFrontendGenerationStream` 的 `req`/`res` 全部显式化；
- `NovelApiRequest`/`NovelApiResponse` 与 `HttpRequest`/`HttpResponse`
  统一（Node 真实请求/响应结构）；
- 请求体仍是 `Record<string, unknown>`，每个字段在入口逐项窄化：
  preset/world/character 的 `data`、`selection`、`entries`、`action`、
  `greetingIndex` 等都有显式 guard；
- `helper.ts` 的变量树、消息、脚本树、IndexedDB 参数按 JSON 形状校验，
  不再用 `as never` 把未知值塞进 typed store 调用。

### 3.3 生成管线与 hook

- `GenerationOptions`、`GenerationAssemblyOptions`、`buildGenerationLlmRequest`
  的输入/输出显式化：`TavernState`、`ChatSnapshot`、`CharacterFile`、
  `ChatLogIR`、`ChatMessage`、`AssembleInput`、`RegexScriptIR`；
- `generation-hooks.ts` 的 `pre-assemble` 载荷改为 `AssembleInput`，
  `pre-llm` 载荷改为 `GenerationLlmRequestPayload`，hook 注册表改为按相位
  映射的 `HookTable`，去掉了原来的 handler 擦除断言；
- `previewGeneration`、`runGeneration`、`runTavernScript` 的
  `ctx/db/req/res` 全部显式；`write` 事件、模型选择、中止信号、
  消息流分块均在类型内。

### 3.4 会话与投影

- `session/binding.ts`：`bindSession`、`requestedArchitecture`、
  `requestedContextMode`、`assertStGenerationBinding` 接收
  `TavernArchitecture` / `TavernContextMode` / `TavernState`；
- `session/trace.ts`：新增 `TraceSession` / `TraceAgentLike` /
  `TavernSessionTrace`，`append` 用可选方法 + 运行时 guard，事件
  `data` 用 `HostSessionEventData`；
- `agent-tavern/projector.ts`：`NativeSession` 改为只要求 `id`，
  事件数据不再依赖 `any`；`agent-tavern/{anchor,card-state,prompt-capture}.ts`
  的 pre-step 监听器使用具体 payload/decision 类型。

### 3.5 资产、游戏、Mod、MVU、工作台

- `tavern-assets.ts`：世界书格式 IR → lore 引擎 IR 的边界适配收敛到
  `formatEntriesToLore`；
- `games/standard.ts`：`GameManifestCheck` / `GameEngineCheck` 改为
  判别联合，成功态保证 `manifest`/`engine` 存在；
  `games/registry.ts`、内置游戏的状态/动作类型对齐；
- `mods/host.ts` 的 Mod API handler 载荷改为 `unknown` + 逐项窄化，
  不再用 `never` 擦除；Mod route handler 允许返回任意值（调用方 await
  后忽略返回值）；
- `mvu.ts`、`mvu-guard.ts`、`mvu-rules.ts`、`mvu-guard` 的 schema
  节点、`$rules` 读取、消息索引与变量值均显式窄化；
- `card-workbench/{plans,tools-world,tools-card,tools-preset}.ts`：
  世界书方案字段、字段规格表、编辑/种子分支、preset prompt 顺序表
  全部类型化；
- `memory-maintenance.ts`：维护 run 的 `MaintenanceLlmContext` 复用
  `HostLlmService`；`maintenanceDeps` 改为 async 并真正 await
  memoized `MemoryStore`/`MemoryVectorStore`（原实现把 Promise 当实例
  传入，是类型检查暴露出的运行时缺陷）。

## 4. 有意的 unknown seam 与边界断言

以下位置保留 `unknown` 或窄断言，不是漏网错误：

1. **宿主 logger**：`HostLogger` 的方法签名是
   `(...args: unknown[]) => void`。宿主各版本允许结构化字段，插件只透传，
   不做字段级建模。
2. **宿主 LLM 请求/分块**：`HostLlmRequest.messages`、`tools` 是
   `readonly unknown[]`；`HostLlmChunk['block-end'].block` 是
   `Record<string, unknown>`。这些载荷由宿主 `dsh-llm` 定义，插件只读取
   自己消费的字段（`text` / `reasoning` / `usage` / `finish`）。
3. **宿主 Agent 句柄**：`HostAgentLike` 有 `[key: string]: unknown`；
   `session`、`ctx`、`status` 之外的字段不建模。`subagents`、
   `pluginManager`、`agent` 也保持 `unknown`，调用点自行探测。
4. **外部宿主模块**：`compaction/curator.ts` 的 `HostBasicEngine` /
   `HostLlmModule` 是运行时 `importHostPackage` 的最小结构面；宿主包没有
   编译期依赖，不能直接 import 其类型。
5. **格式 IR → lore IR**：`tavern-assets.ts` 的 `formatEntriesToLore`
   对 `position`、`selectiveLogic`、`role`、`triggers` 做窄断言；lore
   引擎的 `normalizeEntry` 会在激活时重新校验/归一化这些字段。
6. **TavernHelper 全局变量**：`helper.ts` 的 `variables.replace` 仍按
   JSR 兼容语义把 JSON 树原样写入 `state.scriptGlobals`（该字段声明为
   标量 record）。这里用一次边界断言保住既有前端行为，宏引擎仍只识别
   标量。
7. **Template 变量树**：`mvu.ts` / `template.ts` / `card-state.ts` 用
   `jsonObjectOf`（JSON round-trip）把卡数据送入模板运行时。卡数据本身
   是 JSON，round-trip 只做形状归一，不改变持久化内容。
8. **MVU 语义值**：`agent-tavern/tools/deduction.ts` 的 `jsonValueOf`
   在每项写入前校验 JSON 值；失败只记单项 failure，不中断整批。

## 5. 类型检查暴露并修正的行为问题

这些问题在加 strict 配置前被隐式 `any` 掩盖，修复后由全量测试覆盖：

- `helper.ts` 的 `getchar` 读取 `data.first_mes` / `data.mes_example` /
  `data.creator_notes`，但 `CardDataIR` 的字段是
  `firstMes` / `mesExample` / `creatorNotes`；旧实现返回空串。现按 IR
  字段读取，并在 `helper-route.spec.ts` 增加一条 `template.render` smoke
  断言（`first_message` / `message_example` / `creator_notes`）。
- `http/router.ts` 的聊天重命名只写 `{ character, chatId, group }`，
  会丢掉绑定的 `architecture` / `contextMode`；现改为 `{ ...binding,
  character, chatId }`，保留其余绑定字段。
- `http/memory.ts` 的 `maintenanceDeps` 把 memoized Promise 当实例传入；
  现 await 后再交给维护 run。
- MVU 结算的值校验从“map 阶段整批抛错”改为“逐项 try 内校验”，恢复
  “单项失败、其余成功”的既有语义。

## 6. 接入 `pnpm check`

根 `package.json`：

```json
"typecheck:security": "node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.security.json --pretty false",
"typecheck:plugin": "node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --pretty false",
"check": "tsc -b --pretty false && node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.security.json --pretty false && node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --pretty false && vitest run && node scripts/build-plugin.mjs && node packages/plugin/scripts/gates/run.mjs"
```

顺序：`tsc -b` → security scoped gate → 全量 plugin gate → 全量测试 →
bundle 构建 → bundle/content gates。全量 gate 已实测退出 0，因此保留在
`check` 链中。

## 7. 本轮验证

在 `48012a9` 工作树上实测：

```text
node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.json --noEmit --pretty false
  -> exit 0，0 errors

pnpm run typecheck:security
  -> exit 0

pnpm run typecheck:plugin
  -> exit 0

pnpm check
  -> exit 0
  -> Test Files 144 passed (144)
  -> Tests 2163 passed | 1 skipped (2164)
  -> built packages/plugin/index.mjs, agent.mjs, compaction.mjs, novel.mjs,
     card-workbench.mjs, reasoning.mjs, client/index.js and version.json
  -> gates: 18 项全部 PASS（update-routes … content-lexicon）
```

## 8. 剩余债务

- 插件 `src` 已无显式 `any`、`@ts-ignore`、`@ts-nocheck`、`as never`（全目录
  检索为空）；仍保留少量 `as unknown as` 边界断言（§4 的宿主/格式/模板
  接缝），以及 `UpdateHostContext` / `PluginManagerLike` 这类只建模已调用
  成员的动态宿主服务面。
- `packages/plugin` 尚未加入根 `tsconfig.json` 的 `references`。当前由
  `typecheck:plugin` 显式检查；如需 `tsc -b` 统一增量图，应把插件改成
  composite 工程，并处理它直接引用工作区 `src` 的解析方式。
- 格式包 `tavern-format` 与 lore/script 引擎之间仍有少量重复 domain
  类型（`LoreEntry` 的枚举字段最明显）；本轮的适配器只收敛在插件边界，
  未做跨包类型合并。
- 宿主 seam 是结构化的最小面，不是 DSH 官方类型。宿主若改变
  `ctx.llm.stream`、`agentDefaultModel.currentSelection`、
  `agentPresets.recompose` 等形状，`host-contract.ts` 需要同步更新。
- 没有引入类型级测试（例如 `expectTypeOf`）；行为回归由现有 2163 条
  运行期测试覆盖。