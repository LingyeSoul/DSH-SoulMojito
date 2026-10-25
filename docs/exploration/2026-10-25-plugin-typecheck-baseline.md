# 插件类型检查基线（2026-10-25）

> 基线提交：`6340a56`（工作树干净时测量）。本文只记录 `packages/plugin` 的现状与第一个
> **scoped** gate，**不代表插件已通过全量类型检查**。全量配置仍有数百个错误，本轮故意不把它接进
> `pnpm check`。

## 1. 为什么插件今天不在 `tsc -b` 里

- 根 `tsconfig.json` 的 `references` 只有 10 个 `tavern-*` 包，没有 `packages/plugin`；插件既不是
  composite 工程，也没有自己的 `tsconfig.json`。
- 插件的构建走 `scripts/build-plugin.mjs`：先 `tsc -b` 构建根 references 里的 `tavern-*` 包，再用
  esbuild 打包插件入口。`packages/plugin/src` 本身不在 `tsc -b` 的 project graph 里，esbuild 只转译、
  不做类型检查，因此 `src/` 下 127 个 `.ts` 文件里的类型错误不会阻断构建或 `pnpm check`。
- 现在直接加一个覆盖全插件的配置会让 `pnpm check` 变红，挡住其他并行工作；迁移必须分片推进。

## 2. 全量错误计数（实测）

测量方式：仓库外临时 `tsconfig` 继承 `tsconfig.base.json`，`include` 仅
`packages/plugin/src/**/*.ts`，`noEmit: true`，`types: ["node"]`；不向仓库添加全量配置。
TypeScript 5.6.2。等价命令（`<repo>` 与 `<temp-config>` 替换为绝对路径）：

```text
node node_modules/typescript/bin/tsc -p <temp-config> --pretty false
# count lines containing "error TS"
```

| 配置 | 错误数 |
|---|---|
| strict（继承 base，含 `noUncheckedIndexedAccess`） | **796** |
| strict off（`strict: false` + `noUncheckedIndexedAccess: false`） | **597** |

错误最集中的文件：

| 文件 | 错误数 |
|---|---|
| `src/http/router.ts` | 287 |
| `src/generation/pipeline.ts` | 123 |
| `src/helper.ts` | 85 |
| `src/http/panel.ts` | 41 |
| `src/games/builtin/dungeon-crawl.ts` | 23 |
| `src/session/trace.ts` | 21 |

前四个文件占全部错误的约 67%。错误码分布（strict）：`TS18046` 378（对 `unknown` 取属性）、
`TS7006` 173（隐式 any 参数）、`TS2339` 107、`TS2345` 59、`TS2322` 24、`TS18048` 18。
主体是**宿主边界与内部 helper 没类型**造成的级联错误，不是深层逻辑错误。

> 计数会随并行改动漂移：另一份包含当日其他 agent 改动的隔离快照上，未改 `io.ts` 时为
> 799 / 600。本文把干净基线 `6340a56` 的 796 / 597 作为迁移起点，不把 796 当成实时不变的数字。

## 3. 本切片覆盖什么

新增 `packages/plugin/tsconfig.security.json`：继承 `../../tsconfig.base.json`，`noEmit`，
`rootDir: "src"`，`types: ["node"]`，只 include：

- `src/http/trust.ts`：纯函数请求信任策略（Host / Origin / sec-fetch-site / content-type）；
- `src/http/errors.ts`：带 HTTP status 的 `HttpError`；
- `src/http/io.ts`：JSON 请求体读取与 JSON 响应写出。

`io.ts` 现在有显式结构类型，没有 `any`：

- `JsonRequest`：可选 `headers`、`on(event, listener)`（listener 接受未知 chunk，兼容测试 fake）、
  可选 `destroy`；Node 的 `IncomingMessage` 与测试 fake 结构上满足它。
- `JsonResponse`：`statusCode`、`setHeader`、`end`、可选 `writableEnded`；
  Node 的 `ServerResponse` 满足它。
- `sendJson(res, status, body: unknown): void`。
- `readJson(req, maxBytes?): Promise<Record<string, unknown>>`；默认上限仍为 2 MiB，
  413/415/400 的状态与消息、超限后 `destroy()` 的时序均保持不变。

根 `package.json`：

- 新增 `typecheck:security`：`node node_modules/typescript/bin/tsc -p packages/plugin/tsconfig.security.json --pretty false`；
- 插到 `check` 里 `tsc -b --pretty false` 之后，下一轮 `pnpm check` 起强制执行。

**覆盖范围仅此 3 个文件**：不检查路由、runtime、helper、client，也不检查 bundle 产物。没有创建
`packages/plugin/tsconfig.json`。

### 3.1 对全量检查的影响与暴露出的调用点

在隔离快照上只切换 `io.ts`（同一份其他文件不变）：

| | 未类型化 io | 类型化 io |
|---|---|---|
| strict | 799 | **460** |
| strict off | 600 | **271** |

净减少主要来自旧的 `readJson` 被推断为 `Promise<unknown>`，调用方每次都报 `TS18046`。但它也**新暴露
62 个调用点错误**，本轮按分工不修改这些文件：

- `helper.ts` 44 处：`sendJson(res, …)` 的 `res` 声明为 `unknown`，结构上不能赋给 `JsonResponse`；
  修法是给 handler 的 `res` 一个最小响应接口（或改调用的边界类型）。
- `http/novel.ts` 8 处、`http/panel.ts` 7 处、`http/memory.ts` 3 处：`NovelApiRequest.on` 是可选的，
  不能赋给要求可读流的 `JsonRequest`。应把 `on` 收紧为必填，或让这些路由共用同一套边界类型。

这些是纯类型问题，运行时行为不变；security gate 不 include 这些文件，所以仍然是绿的。

## 4. 后续迁移计划

按“先边界、后路由、再内部”的顺序分片，每片单独加配置/脚本，**不为凑绿而加 `any` 或 `@ts-ignore`**：

1. **HTTP 边界收尾**：修上面 62 个调用点；让 `NovelApiRequest/Response` 与 `JsonRequest/Response`
   统一或互相兼容；再把 `src/http/{panel,memory,mods,novel,update}.ts` 纳入 scoped 配置。
2. **router / generation / helper**：这三个文件占错误大头，先补显式参数与返回值、请求体形状，
   再处理 `TS18046/TS7006` 的级联；仍保持行为不变。
3. **宿主边界类型**：`ctx`、`webServer`、`tools`、`llm`、`agents` 等注入面用最小结构接口替代隐式 any。
4. **跨包类型对齐**：清掉 `tavern-*` 包之间重复 domain 类型的 `TS2322/TS2345`。
5. **最后才加全量配置**：`packages/plugin/tsconfig.json`（或根 references 加入 plugin）应在错误数
   接近 0 时才创建/接入 `check`；接入前保持 `noEmit`，不生成 `lib/` 或 bundle。

退出标准：`tsc -p packages/plugin/tsconfig.json` 在 base strict 下为 0，且 `pnpm check` 仍绿。
本轮明确**未达到**该标准。

## 5. 本轮验证

```text
pnpm run typecheck:security
  -> exit 0（仅 trust.ts / errors.ts / io.ts）

npx vitest run packages/plugin/tests/http-trust.spec.ts packages/plugin/tests/helper-route.spec.ts
  -> 2 files, 53 tests passed
```

`pnpm check` 本轮未运行：其他 agent 正在并行修改 `helper.ts` / `router.ts` / `runtime.ts`，
整树结果不稳定；门禁已排在 `tsc -b` 之后，待并行改动落定后由下一次 `pnpm check` 执行。
