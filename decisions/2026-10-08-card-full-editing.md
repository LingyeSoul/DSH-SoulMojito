# 写卡 Agent 角色卡编辑能力完整扩展

日期：2026-10-08。状态：已实施。关联：提案 0013、`decisions/2026-10-08-worldbook-full-editing.md`（世界书侧同构扩展）。

## Problem

世界书工具面补全后，角色卡工具面成为同一结构短板的幸存者——面板编辑器能改的字段，
Agent 大半不可见不可写：

1. **长文读取无全文手段**：card_get 预览截断（description/firstMes 各 2000，其余 1000），
   没有任何参数能取回剩余部分——编辑导入的 8000 字 description 只能看前 2000 字盲改，
   违反 KERNEL 自己的「quote exact text」协议。
2. **mesExample（示例对话）零支持**：不在摘要、不在白名单、card_create 硬编码空串——
   定文风的核心写作素材整条路径缺失。
3. **alternateGreetings 一次性写入**：仅 card_create 可给，之后不可读不可增删改。
4. **systemPrompt / postHistoryInstructions 零支持**：V2 规范字段，面板两栏可编辑。
5. **tags / creator / characterVersion 元数据盲区**。
6. **无 card_delete**：能建不能删；且 ST 语义删卡连带聊天记录，不可逆。

## Decision

- **白名单扩表**：文本字段并入 mesExample(32000)、systemPrompt(16000)、
  postHistoryInstructions(16000)、creator(500)、characterVersion(100)；新增数组字段表
  tags（≤32 项，单项 ≤100）与 alternateGreetings（≤16 项，单项 ≤16000），整组替换语义
  （trim 后丢空白项，对齐面板逐行编辑行为）。
- **方案协议值类型放宽**：plans.ts 的 currentValue/newValue 从 string 放宽为
  `string | string[]`（存储层校验数组项形状与 join 长度上限）；数组字段因此完整进入
  card_plan_propose → 面板 diff → decision 的确认闭环；过期检测改逐项深比较
  （数组引用不等 ≠ 值不等）。面板 diff 渲染对数组值 join('\n') 展示。
- **card_get 增 `full` 参数**：按字段名白名单返回全文 `fullValues`（数组字段返回数组）；
   摘要同时暴露 mesExample/systemPrompt/postHistoryInstructions 预览、元数据、
   alternateGreetings 计数与逐条 200 字符预览。
- **card_create 出厂快照**：落库后立即 saveOriginalSnapshot（首个胜出），手工建的卡
   也有 restore 语义；fields 同步接受全部新字段（含 tags/元数据）。
- **card_delete 双重闸门**：①confirmed 常规闸门；②卡上有聊天记录时首次 confirmed 调用
   仍拒绝并报出确切聊天数与样例 id，用户知情后带 `deleteChats: true` 二次确认才执行
   ——比 world_delete 的「先解绑再删」更硬，因为聊天记录不可再生。清理面对齐面板
   DELETE 路由（删卡连带聊天目录、群组成员移除、activeCharacter 清指针、solo
   sessionBindings 解绑），并补上路由没做的一步：**删除原版快照**（tavern-store 新增
   deleteOriginalSnapshot）——否则同名卡重建/再导入时「首个胜出」语义会保住陈旧快照，
   card_restore_original 把错误的旧卡写回去。

## Alternatives considered

- **数组字段不进方案协议（只走直写 confirmed 路径）**：方案协议出现「部分字段可提案、
  部分不可」的分裂脑，且面板 diff 缺数组字段视图。否决，选存储层类型放宽。
- **方案值存 join 后字符串（tags 逗号、greetings 换行）**：greeting 可含换行，往返有损。
  否决。
- **card_delete 沿用面板路由行为（不删快照、不查聊天直接删）**：路由本身留着
  陈旧快照 footgun；聊天不可再生却一键带走。工具面做全并在本决策留档，面板路由的
  快照清理缺口后续单独修（客户端确认弹窗已有）。
- **tags/alternateGreetings 以 `changes` 之外的兄弟参数暴露**：单一 changes 数组
  （field 枚举 + string|array 值）对模型更不易用错，且与方案协议字段面天然一致。否决。
- **开放 extensions 全量 / V3 assets 等增量字段**：面板也仅给 advancedJson 逃生门，
  维持「扩展面只开 agentTavern + world 两个已建模键」的边界。裁剪。

## Consequences

- 卡编辑能力与面板编辑器字段面对齐（含示例对话、系统提示、元数据、备选开场白），
  长文「读全→改准」闭环打通；工具总数 20→21。
- 方案 JSON 里出现数组值：旧面板渲染 `value || ''` 会把数组压成无分隔拼接——已在
  client/main.js 修为 join('\n')，构建产物随本次一并更新。
- card_delete 的 deleteChats 二次确认是工具面语义；面板 DELETE 路由行为未变（单确认
  弹窗），两侧语义差异已在工具描述中向 Agent 声明。
- 面板 DELETE character 路由仍不清理原版快照（存量 footgun 未修，影响面：面板删卡后
  同名再导入）；后续修路由时可复用 deleteOriginalSnapshot。
