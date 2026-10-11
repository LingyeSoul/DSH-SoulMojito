# 写卡工作台读参考文件：挂宿主默认文件工具行（v2，替换当日 v1 自研 reference_read）

> 日期：2026-10-11。Bug 报告：用户通过 DSH 对话框给写卡工作台上传参考文件
> （文风/描写规则/词汇库/框架 JSON 等），agent 读不了。
> **v2（当日复盘后重做）**：v1 自建受限只读工具 `reference_read`（提交
> 3d96090）经维护者评审否决——「DSH 默认就提供了文件读取工具」，工作台
> 作为对默认面的偏离应当回归宿主默认姿势，而不是发明模型要重新学的私有
> 工具。v2 = preset 声明行挂 `@deepseek-ai/dsh-tool-fs`，v1 全量回滚
> （tools-reference.ts / card-workbench-reference.spec.ts 删除，agent.ts
> 与全序断言还原）。落点：`packages/plugin/cordis.patch.yml`（唯一代码
> 改动——preset-card-workbench 的 plugins 加一行）。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/cordis.patch.yml` 的 `preset-card-workbench` 行（config.plugins 列表）——工作台 preset 的组合声明 |
| 唯一事实来源 | 宿主 `@deepseek-ai/dsh-tool-fs`（read/read_image/write/edit 的定义与读取上限）；附件落盘位置（原生 `$DSH_HOME/attachments/v1/` + dsh-rider `<工作区>/.dsh/uploads/`） |
| 持久态 | **无**（本改动零代码零存储） |
| 临时态 | 宿主 tool-fs 自己的读取缓冲（与本决策无关） |
| 外部依赖 | 宿主包 `@deepseek-ai/dsh-tool-fs`（DSH 0.2.0 随包出货，standard preset 同款行）+ `ctx.fs` 后端（宿主面已挂，preset 只加工具层——standard 同构） |
| 注册入口 | preset 声明的 plugins 子行（`- id: tool-fs, name: '@deepseek-ai/dsh-tool-fs'`）；无插件代码改动、无 KERNEL 改动（附件句柄/清单行已自带读取指引） |
| 删除路径 | 删 cordis.patch.yml 的 tool-fs 子行 + 本决策文档 + 提案 0013 补记句。v1 的删除路径随回滚一并消失 |
| 兼容对象 | preset id `card-workbench` 不变（旧会话 preset 恢复不受影响）；**声明修改只影响之后创建的 Agent**（dsh-agent-preset 语义）——存量绑定工作台会话保持 22 工具旧组合，新建工作台会话（侧栏「+」/新建向导 fresh 入口）起带文件工具；工具全序断言回到 22 项冻结 |

## 根因（RCA，v1/v2 共用）

DSH 0.2.0 起 web 面把 agent 工具行整体下放给 preset（`dsh-web-app/cordis.patch.yml`
显式 `disabled: true` 掉 tool-fs/tool-bash 等，注释「the Web surface disables
them here and lets each session mount a preset instead」）；`agent-preset-registry`
`default: standard`，**standard preset 的 plugins 挂着 `@deepseek-ai/dsh-tool-fs`
等文件工具——这就是「DSH 默认提供文件读取工具」的机制本体**。而
`card-workbench` preset 只挂 `dsh-tavern/card-workbench` 一个插件（22 个域工具），
是对默认面的偏离。在用的两条附件管线都把读取责任显式压给「file tools」：

1. **DSH 0.2.0 原生附件**（dsh-attachment）：非图片文件按字节存
   `$DSH_HOME/attachments/v1/file-objects/<sha前2>/<sha>`；消息里 FileBlock
   在请求组装时投影为句柄文本（dsh-llm `fileHandleText`）：
   `[File "名" (字节数, sha256:xx): verbatim read-only copy saved at "路径".
   Read that path with your file tools …]`（本地 fs 宿主
   `processPathFromHostPath` 恒等映射，模型看到宿主绝对路径）。
2. **dsh-rider 暂存**（web profile 在装的 bundle 插件）：拖入文件落会话工作区
   `<cwd>/.dsh/uploads/<时间戳>-<名>`，发送时 `agent/pre-step` 注入清单行
   `📎 名（大小）→ .dsh/uploads/…` + 「需要时用文件工具按相对路径读取」。
   工作台会话 cwd 是专用工作区 `$DSH_HOME/tavern/workbench`（面板
   `ensureWorkbenchWorkspace` 注册）。

模型被两份指引指向「文件工具」，工作台 preset 没挂 → 参考文件不可读。

## 方案

**v2（采纳）**：`preset-card-workbench` 的 `config.plugins` 追加宿主默认行
`- id: tool-fs, name: '@deepseek-ai/dsh-tool-fs'`（与 standard preset 逐字
同款、零配置）。模型获得 `read`（带行号/分页/readMaxBytes 上限）、
`read_image`（图片附件，走持久附件存储）、`write`/`edit`——附件句柄与
dsh-rider 清单行的既有指引直接成立，无需 KERNEL 改动。

- 不带 `tool-fs-search`（glob/grep 发现面）：读取够了，工作台不需要文件
  搜索；要扩再按同款加行。
- `write`/`edit` 随包带出的纪律代价：与 DSH 默认会话（standard）完全一致
  ——这是宿主的默认信任姿势，不是工作台新开的口子。卡片/世界书/预设的
  **结构化写入**仍走 card_put/world_put 确认协议（KERNEL 纪律不变）；工具
  层文件写受宿主 approval/权限面管（与 standard 会话同款）。

**v1（已回滚，提交 3d96090 后当日替换）**：自建 `tools-reference.ts` 单工具
`reference_read`——受限只读（附件两根内）、分块对齐 material_read、二进制
守卫、BOM 剥离。否决原因（维护者评审）：DSH 默认会话本来就有文件读取工具，
为工作台单独造一套受限读取是过度设计——附件管线的指引文本、宿主的工具
描述、模型已有的工具使用先验全都指向宿主默认工具；自研工具反而要求模型
在清单行/句柄指引与私有工具之间多一次映射。v1 的合理遗产（已并入本决策
认知）：两条附件管线的路径形态与落盘根、`processPathFromHostPath` 恒等
映射、preset 组合语义的证据链。

## 生效路径（部署注意）

- 本改动在插件 bundle 的 cordis.patch.yml 里，随 bundle 重装/更新进宿主
  profile；重新 `dsh web` 后 Loader 重读声明。
- **「声明会提前加载，修改只影响之后创建的 Agent」**：存量绑定的写卡工作台
  会话保持旧组合（无文件工具），面板 fresh 入口新建的工作台会话起生效。
  用户遇到旧会话读不了时，用侧栏「+」或新建角色卡向导开新工作台即可。

## 测试

v1 的 11 项 spec 随回滚删除（工具不存在了）；工具全序断言还原 22 项冻结。
本改动是声明行变更，无插件代码路径——由 `pnpm run check` 的 tsc/vitest/
patch-reference 等 15 道门禁兜底（基线 87 文件 1211 过 → 86 文件 1200 过
+1 跳）。真机验收：新开工作台会话 → 拖入参考文件 → agent 用 `read` 读出
内容（相对路径 `.dsh/uploads/…` 与原生句柄绝对路径两条形态各验一次）。

## 同类风险（不在本次范围）

`agent-tavern` 与 `agent-novel` preset 同样只挂自己的插件行、无文件工具。
若要对齐，同款加行即可（各自评估 KERNEL 是否需要相应指引）：
agent-novel（作者上传参考资料）优先级最高。**注意同样的存量会话约束**：
加行只对新会话生效。
