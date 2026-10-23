# 卡级正则按卡内数组顺序应用（2026-10-23）

## 问题

一张真实测试卡（卡名从略，依赖 MVU + 状态栏）的展示链依赖卡内正则顺序：

1. `[MVU] 变量更新校验-放行`：`</UpdateVariable>…<StatusPlaceHolderImpl/>` → `<StatusPlaceHolderREADY/>`
2. `[状态栏] PC版状态面板`：`<StatusPlaceHolderREADY/>` → 状态面板 HTML
3. `[变量]变量未更新警告`：`<StatusPlaceHolderImpl/>` → 「AI 遗漏变量更新」警告

最新楼层的 `mes` 同时带 `<UpdateVariable>` 与 `<StatusPlaceHolderImpl/>`，但
`state.regexScripts` 里警告脚本（导入 id 6）排在放行脚本（导入 id 95）之前，警告
先把占位符吃掉，状态栏永远显示「未更新」。用户没有生成新内容也会看到该警告，
因为 `frontend/latest` 每次轮询都会按当前顺序重新跑 markdownOnly 正则。

根因是 `collectRegexScripts` 把导入后的 `state.regexScripts` 顺序原样返回；同步/
重导会改变这个顺序，而卡作者的链式顺序只存在于卡内 `regex_scripts` 数组。

## 决策

- `collectRegexScripts` 在合并来源后，把**当前角色卡归属**的脚本按卡内
  `regex_scripts` 数组顺序稳定排序；全局/手动脚本仍排在最前，预设脚本保持原相对
  顺序。
- 卡内脚本运行时并入（state 里缺失的）仍追加在末尾，内容与顺序都以卡为准。
- 同名去重、「全局优先」与非法卡内脚本兜底不变：卡内数组解析失败时退回原
  state 顺序，不因一条坏脚本停掉全局脚本。
- 排序只改**应用顺序**，不改写 `state.json`、不新增接口、不迁移数据。

## 边界

- 预设级脚本的链式顺序仍取 state 顺序；当前 `collectRegexScripts` 没有预设资产
  可读，不在本轮扩大范围。
- 用户若在面板里手动调整（当前没有拖拽重排入口），卡内顺序仍优先。

## 验证

- `packages/plugin/tests/tavern-assets.spec.ts`：打乱 state 顺序后仍按卡内顺序
  输出；放行脚本先于警告脚本，渲染结果含 `StatusPlaceHolderREADY` 且不含警告。
- 真实卡 + 真实聊天（15 楼）离线探针：修复后最新楼层渲染出 `状态总览`
  （约 198k 字符），`mvu-leak-warning` 为 false；修复前警告先命中。
- `tsc -b`、全量 vitest、18 项 gates 全绿；`packages/plugin/index.mjs` 重新构建。
