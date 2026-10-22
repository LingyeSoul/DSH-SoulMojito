# 决策：角色卡 IR 的 raw 袋必须存整个顶层对象（含 V1 兼容字段）

日期：2026-08-14 · 状态：已实施（tavern-format）。2026-10-22 起夹具改为合成卡（`ExampleCard`），按真实卡三层结构复刻；真实卡素材不再入库。

## 背景

用 ST 官方示例卡（下称「示例卡」，真实文件名与卡名从略；同时含 `chara` 与 `ccv3` tEXt chunk）做
roundtrip 测试时发现：**ST 导出的真实卡 JSON 是三层并存形态**——

```text
顶层: name/description/personality/first_mes/mes_example/scenario/tags
      + avatar/chat/create_date/talkativeness/fav/creatorcomment（V1 兼容字段）
      + spec/spec_version/data
data: 规范 V2/V3 嵌套字段
```

V1 兼容字段不在任何公开规范里（spec_v2/SPEC_V3 均未提及），是 ST
`src/character-card-parser.js` 导出行为的兼容层——旧前端只读顶层字段。

## 决策

`CharacterCardIR.raw` 存**整个原始对象**的深拷贝（而非仅 spec/spec_version/data
三键）；序列化时以 raw 为底、覆盖 spec/spec_version/data 与结构化字段：

- 未知顶层键（现在与未来的前端扩展字段）零丢失；
- V1 兼容字段经 raw 自然往返；
- V2 视图（`chara` chunk）额外从 data 镜像同步六字段——对齐 ST
  「顶层 V1 字段是 data 的投影」语义，编辑卡后导出的顶层字段不陈旧。

## 后果

- roundtrip 验收从「逐字节」放宽为「语义等价（键序无关）」——
  `stableDeepEqual`；顶层字段顺序不保证与原文件一致（JSON 对象键序本无语义）。
- 未来做卡编辑器时，只改 IR 结构化字段即可，镜像同步由序列化层负责。

## 证据

`packages/tavern-format/tests/card.spec.ts`：
"encode 产出的 JSON 与原卡 chunk JSON 语义等价（未知字段零丢失）"——
修复前失败（顶层字段全丢），修复后通过。
