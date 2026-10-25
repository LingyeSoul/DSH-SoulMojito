# Prompt Template 默认关闭（EJS opt-in）

> 日期：2026-10-25。安全收口：未配置的 profile 不再执行角色卡/世界书里的 EJS。
> 落点：`packages/plugin/src/runtime.ts`（`templatesEnabled` / `templatesEnvEnabled` / flag）、
> `packages/plugin/src/generation/pipeline.ts` 与 `packages/plugin/src/http/panel.ts`（env 实时检查）、
> `packages/plugin/tests/template-default.spec.ts`。

## 问题

`templatesEnabled(config)` 原先只把 `templateEnabled === false` 视为关闭，模块级
`templatesEnabledFlag` 初值也是 `true`。未配置的 profile 因此默认执行卡内 `<% %>`：
导入或打开一张不可信角色卡/世界书，就可能让其中的 JavaScript 在插件进程内运行。
`node:vm` 只隔离全局对象，不是可用于不可信代码的安全边界；默认开放等于把卡作者
视为完全可信。

## 决策

- **默认拒绝**：`templatesEnabled(config)` 仅在 `config.templateEnabled === true` 时返回
  true；缺省、`false` 与任意非布尔真值都不开启。
- **env 优先**：`DSH_SOULMOJITO_DISABLE_TEMPLATES` 非空（且不为 `0` / `false`）时无条件
  关闭。新增 `templatesEnvEnabled()` 供生成与 MVU retry 链路实时组合，避免 profile
  opt-in 后 env kill switch 失效。
- **flag 初值 false**：`templatesEnabledFlag` 默认关闭；`apply()` 用
  `setTemplatesEnabledFlag(templatesEnabled(config))` 写入同一决策，未配置 profile 保持关闭。
- **关闭即直通**：不创建模板运行时，`<% %>` 原样进入 prompt；没有模板标签时链路不产生
  额外模板执行。
- **引擎不动**：`packages/tavern-template` 的 EJS 编译/执行与既有测试保持不变，仅改变
  默认是否接线。

## 启用方式（opt-in）

在 profile `cordis.patch.yml` 的 `dsh-soulmojito` 行 config 显式写：

```yaml
- id: dsh-soulmojito
  config:
    templateEnabled: true
```

`DSH_SOULMOJITO_DISABLE_TEMPLATES=1`（旧前缀 `DSH_TAVERN_DISABLE_TEMPLATES=1` 同义）始终
优先，用于紧急停机。没有逐卡开关：这是 profile 级信任决策，不是对单张卡的沙箱承诺。

## 残余风险

- `node:vm` **不是安全边界**。模板与宿主同进程，逃逸后可直接触达 Node 能力；本决策只把
  「默认执行」改为「显式信任后执行」，不承诺安全运行不可信卡。
- 同一 EJS 引擎还被 AgentTavern 卡内常驻世界书注入与 MVU 状态栏模板使用；这两条链路
  不在 `templateEnabled` 的本次接线范围（本步只收口 Prompt Template 生成/渲染面）。
  若要求「零默认 EJS 执行」，需要单独决策把这两面也接到同一开关。
- 关闭只影响后续请求：已写入聊天的模板产物与变量保持原样。

## 开工前八项（CONTEXT.md）

| 项 | 答案 |
|---|---|
| 所有者 | `runtime.ts` 的开关与 flag；`index.ts` 的 apply 写入；生成与 retry 链路读取 |
| 唯一事实来源 | profile config `templateEnabled` + 环境变量；`templatesEnabledFlag` 只是 apply 后的进程内快照 |
| 持久态 | 无新增；不改变 profile 文件、聊天或变量格式 |
| 临时态 | flag 与 env 实时读取，进程重启后重新由 apply 计算 |
| 外部依赖 | 无新增；仅既有 `envCompat` |
| 注册入口 | 无新增路由/工具；生成、MVU retry 与 helper 渲染面读同一 flag |
| 删除路径 | 删 `templatesEnvEnabled`、恢复 `templatesEnabled` 旧默认、flag 初值改回 true、删本决策与测试；引擎包不动 |
| 兼容对象 | 既有显式 `templateEnabled: false` 语义不变；显式 `true` 的部署行为不变；未配置部署从「执行」变为「直通」 |

## 验证

```powershell
npx vitest run packages/plugin/tests/template-default.spec.ts packages/tavern-template/tests/template.spec.ts packages/tavern-template/tests/inject.spec.ts
```

结果：3 个测试文件、53 项通过。`template-default.spec.ts` 覆盖 `templatesEnabled({}) === false`、
`templateEnabled: false`、`templateEnabled: true`、env kill switch 优先，以及 flag 初值与
重置为 false。

已知残留：`packages/plugin/tests/tavern-template.spec.ts` 的首个端到端用例仍以无配置
`apply()` 启动并断言模板渲染，默认关闭后失败（实测 1 failed / 1 passed）。本步不静默
改它；该用例需显式 opt-in（apply 配置 `templateEnabled: true` 或设置 flag）后恢复旧语义。
