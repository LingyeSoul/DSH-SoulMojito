# 提案 0008：Prompt Template（EJS 模板）— ST-Prompt-Template 功能复刻

> 状态：已实现。日期：2026-10-07。参照物：`zonde306/ST-Prompt-Template`（AGPL-3.0）的**公开功能文档**
> （README / docs/features.md / docs/reference.md），按本仓库 clean-room 教义从行为规格重实现，
> 不复制其源码，也不引入 `ejs` / `lodash` / `faker` 依赖。

## 1. 范围

ST-Prompt-Template 的核心价值是在提示词中执行 JavaScript（EJS 语法）并管理带作用域的变量。
本提案把该能力适配进 dsh-tavern 的 ST 兼容生成链路（`runGeneration`）：

| 能力 | 去向 |
|---|---|
| EJS 语法（`<% %>` / `<%= %>` / `<%- %>` / `<%# %>` / `<%_ _%>` / `-%>` / `<%%` 字面量） | 新包 `@dsh-tavern/template`，`node:vm` 沙箱执行 |
| 生成前模板处理（预设 / 世界书 / 角色卡字段 / 消息） | `runGeneration` 装配前预渲染（不动 `assemblePrompt` 同步 API） |
| 生成后模板处理（LLM 输出中的 `<% setvar() -%>` 等） | AI_OUTPUT regex 之后、落盘之前渲染 |
| 变量 API（`getvar`/`setvar`/`incvar`/`decvar`/`delvar`/`insvar` + flags/defaults/路径） | `chat_metadata.variables`（local，任意 JSON）/ `state.scriptGlobals`（global，标量）/ `chat_metadata.initial_variables`（initial） |
| Content Injection（`[GENERATE:BEFORE/AFTER/{idx}/REGEX]`、`[RENDER:*]`、`[InitialVariables]`） | 激活条目分区 + 装配后消息级注入 |
| Prompt Injection（`@INJECT pos=/target=/regex=`） | 装配后对 `LlmMessage[]` 整消息插队 |
| `injectPrompt`/`getPromptsInjected`、`define`、`getwi`/`getchar`/`getpreset`/`getChatMessage(s)`、`matchChatMessages`、`parseJSON`、`jsonPatch`、`print` | 模板 API（`tavern-template/src/api.ts`） |
| `<#escape-ejs>` / `<think>` / `<reasoning>` 保护块 | 渲染前置处理（块内 `<%` 转义为字面量） |
| 装饰器 `@@generate_before/after`、`@@render_before/after`、`@@initial_variables`、`@@if`、`@@private` | `tavern-template/src/inject.ts` |

**明确裁剪**（不做，理由：宿主无对应面或属于 UI/浏览器生态）：
faker / jQuery / toastr / dayjs / Monaco 代码编辑器 / iframe 渲染（`@@iframe`、`@@message_formatting`）/ web worker 后台编译 / 缓存策略开关 / `activateRegex` / `activewi` / Quick Reply（`getqr`）/ `execute`（STscript 桥）/ zod `setVariableSchema` / swipe 与 message 作用域变量（无楼层渲染面）/ token 计数全局变量（`LAST_SEND_TOKENS` 由宿主 usage 事件承载）。

**已文档化的适配偏差**：
1. `scope='message'` 映射到 local（dsh-tavern 无楼层变量）。
2. global 作用域仅接受标量（`scriptGlobals` 既有类型约束）；对象树应写 local。
3. `[GENERATE:BEFORE]` 对绿灯激活条目同样生效（ST 文档标注 🔵 only，属实现顺序产物）。
4. 模板渲染发生在宏展开**之前**（EJS 输出中的 `{{macro}}` 会被继续展开；ST 是先宏后模板）。
5. 模板错误不中断生成：告警记入 assistant 消息 `extra.templateWarnings`，原文原样保留。
6. `[InitialVariables]` 在每次生成开始时重算并深合并覆盖（数组替换），不要求「立即加载世界书」开关。

## 2. 包结构

```
packages/tavern-template/
  src/paths.ts      路径读写（a.b[0].c 子集）、深合并（对象合并/数组替换）、深拷贝
  src/syntax.ts     EJS 子集编译器（clean-room，按 ejs.co 公开语法）→ 异步函数体源码
  src/runtime.ts    node:vm 沙箱执行 + escape-ejs/think/reasoning 保护块 + 编译缓存
  src/variables.ts  变量作用域存储（cache 快照 + 写穿透）、flags、injectPrompt/define 注册表
  src/yaml.ts       InitialVariables 的 YAML 子集解析（缩进嵌套 map / `- ` 数组 / 标量）
  src/api.ts        模板环境 API（getvar/getwi/getchar/... + 常量 + 迷你 `_`）
  src/inject.ts     特殊条目分类（标题标签 + 内容装饰器）、GENERATE/RENDER/@INJECT/InitialVariables
  src/index.ts      createTemplateRuntime 装配入口
  tests/*.spec.ts   语法 / 变量 / 注入 / yaml 单测
packages/plugin/src/template.ts   宿主接线：lore 分区、预渲染、消息注入、输出渲染、变量持久化
```

## 3. 生成链路接线（runGeneration）

1. `activateWorldInfo` 之后：从激活结果分区出 `[GENERATE:*]`/`[RENDER:*]` 条目（从
   worldInfoBefore/After、beforeExamples/afterExamples、atDepth 组移除）；从活动书全量条目
   （含未激活）识别 `@INJECT` 与 `[InitialVariables]`。
2. InitialVariables 渲染 + JSON→YAML 解析，深合并进 initial 作用域。
3. 预渲染（EJS → 宏）:世界书串（regex 之后）、角色卡 6 字段克隆、预设 content 条目克隆、
   persona、历史消息 `mes`、depthInjections。
4. `assemblePrompt`（不变）→ GENERATE 注入（BEFORE/AFTER/idx/REGEX）→ `@INJECT` 插队。
5. LLM 流式输出 → AI_OUTPUT regex → 输出模板渲染（runType='render'）→ `[RENDER:*]` 前后缀
   → 落盘（模板写穿的 local/initial 变量随 chat 持久化；global 写穿 `state.scriptGlobals`）。

开关：profile 的 dsh-tavern 行 `templateEnabled: false` 或环境变量 `DSH_TAVERN_DISABLE_TEMPLATES=1`
（默认开启；无模板标签/`<%` 时整条链路为直通，不产生额外开销）。

## 4. 语义对照要点

- `variables` 视图 = global → initial → local 深合并快照，任何 `setvar` 族写入同时写穿 cache
  （对齐 ST「无论 scope 如何都会更新临时变量」）。
- `getvar` 默认 scope='cache'；`setvar` 默认 scope='local'（ST 为 message，见偏差 1）。
- flags：`nx`（cache 视图不存在才写）/ `xx` / `n` / `nxs`（目标 scope 不存在才写）/ `xxs`。
- `@INJECT` 位置解析：`pos` 1 起算（0 视为开头，负数从尾）；`target`+`index`（1 起算，负数从尾）
  +`at=before|after`；`regex`（大小写不敏感、首个匹配消息）+`at`。同位排序：位置从后往前插、
  `order` 升序出现、pos > target > regex 类型优先；regex 模式在位置模式之后单独成批。
- GENERATE:REGEX 对每条匹配消息前缀注入，暴露 `matched_message` / `matched_message_index` /
  `matched_message_role`。
