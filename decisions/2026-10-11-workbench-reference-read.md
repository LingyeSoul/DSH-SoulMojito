# 写卡工作台读参考文件：reference_read 只读域工具

> 日期：2026-10-11。Bug 报告：用户通过 DSH 对话框给写卡工作台上传参考文件
> （文风/描写规则/词汇库/框架 JSON 等），agent 读不了。落点：
> `packages/plugin/src/card-workbench/tools-reference.ts`（新域模块）、
> `packages/plugin/src/card-workbench/agent.ts`（聚合 + KERNEL 指引）、
> `packages/plugin/tests/card-workbench-reference.spec.ts`（新 spec）+
> `card-workbench-tools.spec.ts`（全序断言加一）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `tools-reference.ts` 的 `referenceTools`（单工具 `reference_read`）；路径政策（允许根/解析基）同文件 `referenceRoots` / `workbenchWorkspaceRoot` |
| 唯一事实来源 | 附件落盘本身就是事实源：DSH 0.2.0 原生存储 `$DSH_HOME/attachments/v1/`（内容寻址，dsh-attachment-local 写入）与 dsh-rider 暂存 `$DSH_HOME/tavern/workbench/.dsh/uploads/`（web profile 在装的 bundle 插件写入）。本工具零自有存储 |
| 持久态 | **无**。纯只读，不写任何文件 |
| 临时态 | 单次调用的 `fs.readFile` 缓冲（BOM 剥离 + 分块切片后即弃） |
| 外部依赖 | 无新依赖。`node:fs` / `node:path` + 既有 `dshHomePath` / `tool-args` / `shared` 底座 |
| 注册入口 | `createTools()` 聚合（materialTools 之后、cardApplyMvuTool 之前——与素材读取工具相邻的只读分组）；KERNEL「Working protocol」第二条指引附件清单行与 `[File …]` 句柄都走本工具 |
| 删除路径 | 删 tools-reference.ts + agent.ts 的 import/聚合/KERNEL 条目 + reference spec + tools.spec 全序断言还原 + 本决策文档。无路由、无面板分区、无 locale 键 |
| 兼容对象 | 工具全序断言（加一后冻结）；22→23 个工具；agent-tavern / agent-novel 面不动（见「同类风险」） |

## 根因（RCA）

DSH 0.2.0 起 preset 的工具面按 `dsh-agent-preset` 声明行的 `plugins` 列表组合
（`dsh-web-app/presets/standard.patch.yml`：`dsh-tool-fs` / `dsh-tool-fs-search`
等文件工具是 **standard preset 的行**，不是全局默认）。`card-workbench` preset
只挂 `dsh-tavern/card-workbench` 一个插件——22 个域工具，无任何文件读取能力。

而在用的两条附件管线都把读取责任显式压给「file tools」：

1. **DSH 0.2.0 原生附件**（dsh-attachment）：非图片文件按字节存
   `$DSH_HOME/attachments/v1/file-objects/<sha前2>/<sha>`；消息里的 FileBlock
   在请求组装时投影为句柄文本（dsh-llm `fileHandleText`）：
   `[File "名" (字节数, sha256:xx): verbatim read-only copy saved at "路径".
   Read that path with your file tools …]`（本地 fs 宿主
   `processPathFromHostPath` 恒等映射，模型看到的就是宿主绝对路径）。
2. **dsh-rider 暂存**（web profile 在装）：拖入文件落会话工作区
   `<cwd>/.dsh/uploads/<时间戳>-<名>`，发送时 `agent/pre-step` 注入清单行
   `📎 名（大小）→ .dsh/uploads/…` + 「需要时用文件工具按相对路径读取」。
   工作台会话 cwd 是专用工作区 `$DSH_HOME/tavern/workbench`。

模型被两份指引都指向「文件工具」，工作台没有 → 参考文件不可读。

## 方案取舍

- **否决：preset 挂宿主 `dsh-tool-fs`**。它无只读配置，整包带来 `write`/`edit`
  ——工作台写入纪律是白名单 + 确认协议（提案 0013：写入必须过 card_put /
  world_put 的方案确认门），任意路径写工具直接绕开该纪律；读写面也远超
  「对话框附件」这个需求。
- **否决：放宽为任意路径只读**。工作台定位是编辑器不是文件代理（KERNEL
  Boundaries）；卡片/世界书/预设/剧本库各有专用读取工具（带 IR 投影与摘要），
  tavern store 内部文件不应经旁路裸读。收紧到两条附件管线的落盘根，越界
  明确报错并引导用户「改走对话框附件」。
- **采纳：自建 `reference_read`**，读取面 = 附件两根，契约对齐 `material_read`
  （chunkIndex/maxChars 分块、found:false、钳制回显），加二进制守卫与 BOM 剥离。

## 行为面

- **路径政策**：相对路径以工作台专用工作区为基（dsh-rider 清单行语义）；
  绝对路径原样解析（原生句柄语义）。包含性用 `path.relative` 幂等式（对齐
  dsh-fs `contains`），win32 下大小写不敏感比对（模型可能小写回显盘符；
  Node 的 win32 relative 本身对盘符大小写不敏感，双保险）。允许根：
  `$DSH_HOME/attachments/v1`（objects/ 图片对象与 file-objects/ 文件对象都在
  其下）与 `$DSH_HOME/tavern/workbench`（uploads 在其下，且该目录是专用内部
  工作区，无其他内容）。越界抛错并列出允许根（模型可纠正的用法错误）。
- **分块**：`maxChars` 默认 2400、上限 8000（与 material_read 同值）；`totalChunks`
  按全文长度算；`chunkIndex` 钳入 `[0, totalChunks-1]` 且钳制发生时回显
  `requestedChunkIndex`；`truncated` 判据是「窗口之后还有内容」（尾块恰好等于
  预算不算截断——material_read 语义在这点上有假阳性，这里修正并写进测试）。
- **守卫**：NUL 字节即拒（图片/压缩包给出可转述的拒绝，不进乱码）；
  UTF-8 BOM 剥离；目录拒绝；缺失文件 `found: false`（对齐 material_read，
  不抛）。
- **KERNEL 指引**：Working protocol 第二条——附件清单行与 `[File …]` 句柄都
  用 reference_read 读，二进制被拒时如实报告，「没读过就说没读过」。

## 测试（card-workbench-reference.spec.ts，11 项）

两种路径形态各读一遍；分块（钳制/回显/尾块/truncated 修正判据）；maxChars
整预算；BOM；二进制拒绝；found:false；越界两类（相对逃逸 + 平台门控的外部
绝对路径）；目录拒绝；参数类型校验。另有 tools.spec 全序断言加
`reference_read`（material_read 之后、card_apply_mvu 之前）。

## 同类风险（不在本次范围）

`agent-tavern` 与 `agent-novel` preset 同样只挂自己的插件行——**同样没有文件
读取工具**。agent-novel（作者上传参考资料写小说）是下一个真实受害者的概率
最高；agent-tavern（RP 对局，用户贴设定文档/图）次之。两架构的工具面与
KERNEL 各有纪律（confirmable-write / 写作循环），加同款受限只读工具需要
各自的决策评估，不在本次「修工作台读不了参考文件」的范围内扩张。
