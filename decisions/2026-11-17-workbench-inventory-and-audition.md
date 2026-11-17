# 写卡工作台：库存读取 + 新建入口 + 一次性角色试演

日期：2026-11-17。状态：已实施。关联：提案 0013、决策 2026-10-08-workbench-workspace / 2026-10-11-preview-generation。

## Problem

工作台只能从对话里「说出卡名」开始：Agent 没有库存列举工具，面板没有角色卡/世界书
库存面，角色卡/世界书面板也没有「交给工作台」入口。用户实际想改一张已导入的卡时，
必须自己把卡名打给 Agent，工作台会话也不知道用户从库存里点的是哪张卡；「新建」与
「修改已有」在面板上同样不可区分。工作台因此只是方案确认器，不是资产工作台。

另一个缺口：改完卡面后没有低成本的表现验证。既有「试写预览」走真实装配 + 单次
LLM，零副作用但成本/延迟接近真实生成，且不会以纯角色身份对一句测试台词作答。

## 开工前八项表

| 项 | 答案 |
|---|---|
| 所有者 | 工作台面板 `93-ui-workbench.js`（库存与新建入口）、`62-session-novel-workbench.js`（会话身份与打开）、`http/novel.ts`（绑定与开场提示）、`card-workbench/tools-card.ts`（`card_list`）、`tools-audition.ts`（试演） |
| 唯一事实来源 | 插件内库存：`TavernStore.listCharacters/getCharacter`、`listWorlds/getWorld`；会话身份：`state.sessionBindings` 的 card-workbench 绑定（新增 `targetCharacter`/`targetWorld`） |
| 持久态 | 绑定新增目标资产字段（空串 = 未指定）；旧绑定读取时归一化为空串，无迁移文件。试演不落任何盘 |
| 临时态 | 面板库存列表直接来自 `bootstrap.characters/worlds/worldEntryCounts`；试演子代理一次性 run，settle 后 dispose |
| 外部依赖 | 宿主 `ctx.subagents`（DSH SubAgent seam，`spawn` provider）+ `agent-reasoning` preset（0.2.1+；0.2.0 用 per-spawn `toolFilter`），运行时探测，缺失给明确错误 |
| 注册入口 | 面板分区 `workbench`（传 `ctx`）、角色卡/世界书行内按钮、`workbench-open` 桥载荷、`card_list`/`card_audition` 工具、KERNEL 提示 |
| 删除路径 | 删库存 band/按钮与 i18n、`card_list`/`tools-audition.ts` 及工具聚合行、绑定 target 字段与归一化、`workbench-open` 的 target/opening 分支与开场提示；试演无持久数据 |
| 兼容对象 | 旧工作台绑定（无 target 字段）= 自由/来源工作台，读取归一化空串；旧 `workbench-open` 载荷（无 target/opening）行为不变；工具全序契约新增两项（测试同步） |

## Decision

1. **库存列举**：新增 `card_list`（角色卡：库存名、creator、tags、链接世界书、
   备用问候数）。`world_list` 已存在，两者共同构成工作台库存读取面。KERNEL 要求
   「先 card_list/world_list 定位，再 *_get 读工作版」。
2. **库存面板**：工作台分区的方案列表之前新增「角色卡库存 / 世界书库存」两段：
   搜索、条目数、逐项「在工作台中修改」，以及「新建角色卡 / 新建世界书」。角色卡
   分区与世界书分区的每一行也加同款入口（用户不需要先来工作台面板找卡）。
3. **会话身份 = 来源聊天 + 目标资产**：`workbench-open` 载荷新增可选
   `targetCharacter`/`targetWorld`；绑定持久化这两个字段。同一目标幂等复用同一
   工作台会话，换目标/换来源按既有 fail-closed 守卫拒绝（错误文案保留
   `already bound to another chat` 前缀）。侧栏标签优先级：用户改名 `title` >
   `createdCard` > 目标资产 > 来源聊天 > 自由序号。
4. **开场提示**：首次绑定或目标变化时，服务端经 `agent.inject`（ST preload 同款）
   注入一条 plugin notice：目标卡/书名 + 「先 card_get/world_get，再等用户指令」。
   不写会话日志、不启动额外模型轮次；同身份重发不重复注入。`opening`
   （`new-card` / `new-world`）只在首次绑定注入新建协议提示，让面板新建按钮直达
   对应任务；未知 opening 作为脏载荷拒绝。
5. **一次性角色试演**：新增 `card_audition` 工具。每次调用 spawn 一个无工具、
   无工作台上下文的一次性推理子代理（`agent-reasoning` preset / `toolFilter`），
   把库存卡的核心字段、测试场景和一句用户台词编成单条 prompt，返回角色回复。
   不写卡、不写聊天、不结算；子代理失败/空输出按带原因的错抛出，回复超限截断并
   标记 `truncated`。与试写预览的分工：预览验证真实提示词装配与模型输出；
   试演只验证「这张卡以角色身份怎么答」。
6. **无 UI 试演按钮**：试演需要调用方 agent 的 `ctx.subagents`，HTTP 面板没有
   parent 句柄；面板直接调用会退化成第二条执行路径。由工作台对话里的 Agent 调用
   `card_audition`，保持单一执行核。

## Alternatives considered

- **面板独立路由跑试演**：需要在服务端凭空构造 parent / 另开 subagent 生命周期，
  与宿主 seam 语义不符；否决。
- **复用试写预览代替试演**：成本高、需要聊天上下文，且用户要的是纯角色表现检查；
  两者保留，职责分离。
- **target 与 source 互斥**：允许「从聊天交给工作台排错」同时指定目标卡/书更自然，
  且身份比较只是多两个字段；不互斥。
- **为 target 另造会话类型**：仍是一种 card-workbench 绑定，只是身份字段增加；
  新 architecture 会扩散到预设投影、PTC、侧栏等所有分支，否决。

## Consequences

- `workbench-open` 命令载荷与绑定 schema 扩展；旧载荷/旧绑定完全兼容（缺省空串）。
- 工具全序从 22 项变 24 项（`card_list` 置首、`card_audition` 紧跟卡片核心工具），
  冻结断言与 README/提案同步。
- 工作台会话数量模型从「每聊天一个 + 自由会话」扩展为「每聊天 / 每目标资产 /
  自由会话」；同一张卡不会因为从不同入口点开而产生多条会话。
- `card_list` 逐卡读取（与 `world_list` 同款），库存量级下可接受；未来若卡量上千，
  再引入缓存投影。
- 试演依赖宿主已部署 `dsh-subagent`；缺失时工具报明确错误，不影响其他工作台能力。