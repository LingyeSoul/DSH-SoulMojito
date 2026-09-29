# UI 原子兼容 DSH 0.2.0-rc.2 的图标描边后缀命名

日期：2026-09-29。状态：已实施。

## Problem

DSH `0.2.0-rc.2` 的 `@deepseek-ai/dsh-client-ui-primitives` 把整套产品图标从
尺寸后缀命名（`IconSparkle16`、`IconChevronDownOutline14`）换成描边后缀命名
（`IconSparkleRegular`、`IconSparkleMedium`）。插件 client half 仍按旧名解构
23 个图标，在 0.2.0-rc.2 宿主上全部得到 `undefined`；React 渲染 `undefined`
元素类型抛 #130，把每一个挂载图标的 slot 一起打崩：

- `sidebar.footer.action`（`IconSparkle16`）
- `settings.section`（`IconSparkle16` + `Button`）
- `shell.overlay`（面板内导航图标）
- `conversation.session.header.actions`（regenerate / fork / novel 动作图标）

实测宿主导出表 282 项，旧尺寸后缀名 0 项（`packages/bind` 的宿主形状兼容层
此前只管 workspace 连接面，未覆盖 UI 原子）。

## Decision

`@dsh-tavern/bind` 新增 client 侧 `resolveUiPrimitives(namespace, options)`，
client half 经由它解构宿主 UI 原子：

- 请求名原样命中优先：老宿主仍用自己的图标，行为不变；
- 未命中时按 `^(Icon[A-Za-z]+?)(\d{2})$` 拆出基名与尺寸，回退
  `<base>Regular` → `<base>Medium`，并用调用方传入的 `createElement` 补回
  旧名字编码的尺寸（`*14` 保持 14px），调用方显式传入的 `size` 覆盖默认值；
- 两者都没有时，图标降级为空渲染组件并写入形状轨迹，绝不返回 `undefined`；
- 非图标原子不做空渲染兜底：它们是交互本体（`Modal`/`Button`/`Tooltip`），
  静默降级比显式失败更危险，缺失时保持 `undefined` 并写入轨迹的 `missing`；
- 解析结果写入 `window.__DSH_TAVERN_BIND__.uiPrimitives`，缺符号时 client half
  再补一条 `console.warn`。

门禁 `client-vm-mount` 从「任何名字都给可调用桩」的 Proxy 改为按真实宿主
导出表构造 primitives 桩（`hostPrimitiveExports()` 读取宿主安装里的
`lib/index.js` 导出名，路径沿 `locateOfficialDependencyRoot()`），并断言产物
上报的形状轨迹里 `synthesized` 与 `missing` 均为空。宿主导出表不可解析时门禁
直接失败，与 `node-half-mount` 一致。

## Alternatives considered

- 直接把 23 个图标名改成 `*Regular`：改动最小，但会在任何别的命名世代（老宿主
  或下一次重命名）重新炸同一处，且仓库已把宿主形状兼容集中在 `packages/bind`，
  否决。
- 解析层用显式请求名清单（而非 Proxy 按需解析）：清单与解构语句会各自漂移，
  门禁也难以守护两者一致，否决。
- 对缺失的非图标原子也返回空渲染组件：面板会静默失去交互而无人报警，否决。

## Consequences

- 同一份 client bundle 在旧命名与新命名宿主上均可挂载；后续宿主再改图标命名，
  只改 `ui-primitives.ts` 的候选规则。
- 图标缺失从「整个 slot 崩」降级为「按钮少一个图形」，并留下轨迹与告警；
  非图标原子缺失仍是显式失败，但在门禁阶段就会被拦下。
- 门禁的 primitives 桩不再放行任意名字，`client-vm-mount` 自测覆盖
  `synthesized`/`missing`/追溯缺失三个反例。
