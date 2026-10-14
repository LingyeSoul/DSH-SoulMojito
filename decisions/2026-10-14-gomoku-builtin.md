# 内置五子棋游戏（提案 0018 §4.1 双内置回归）

> 日期：2026-10-14。需求源：用户——「帮我新建一个五子棋游戏」（对局环境实况：只有
> 内置井字棋开箱可玩、且已有实际对局，五子棋此前仅存在于不随包分发的参照包里）。
> 设计契约与先行件：[提案 0018](../docs/proposals/0018-agent-game-bridge.md)
> （§3.2/§3.3 引擎与视图契约、§4.1 双内置愿景、§9 五子棋参照实现）、
> [决策 2026-10-13](2026-10-13-agent-game-bridge.md) 偏差 1（内置裁为井字棋）与
> [参照包](../packages/plugin/examples/games/dsh-tavern.gomoku/)。本文记录内置回归
> 的落法、对偏差 1 的重新裁定、遮蔽语义与边界。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 回答 |
|---|---|
| 所有者 | `src/games/builtin/gomoku.ts`（引擎 + 内联视图单一文件）为内置五子棋唯一 owner；registry 装载数组、gates 标记块、games-builtin.spec 各属其链路 |
| 唯一事实来源 | 内置游戏定义 = engine.meta（与 MANIFEST 同源同值）；对局状态仍以 `$DSH_HOME/tavern/games/sessions/*.json` 为准（本变更零改动会话面） |
| 持久态及理由 | 零新增持久态——内置游戏 0 文件依赖、随 bundle 分发（viewHtml 字符串常量内联，mood-tracker UI_PAGE 先例） |
| 临时态 | 零新增（无缓存/无定时器；视图仍是 per-mount iframe，token 纪律不变） |
| 外部依赖 | 零新增：复用 standard.ts 契约校验/烟测 + view.ts 桥注入管线（renderModHtmlDocument） |
| 注册入口 | `registry.loadBuiltins()` 装载数组 `[ticTacToe, gomoku]`；无新 HTTP 路由、无新工具、无新提示段——`game_*` 五工具与面板「游戏」分区零改动即见新游戏 |
| 删除路径 | 删 `builtin/gomoku.ts` + 装载数组一项 + gates 的 gomoku 标记块（含负样本）+ games-builtin.spec 五子棋 describe——对局面零残留（会话只是数据） |
| 兼容对象 | 内置工具名/Mod API/state.json/storeRevision 零变化；示例清单零改动；测试基线只在既有文件内净增（无新测试文件） |

## 落法（四层）

1. **引擎**（`builtin/gomoku.ts`）：与参照包逐条同款的自由五子棋（15×15、黑先、
   任意方向 ≥5 连即胜含长连、无禁手、resign 由运行时统一处理）；形态对齐
   tic-tac-toe.ts（TS + 中文报错 + 深拷贝 + 全文无随机/时间源）；legalActions 是
   有界建议集（空盘天元、邻居加权 ≤64、**不是合法性依据**——applyAction 按全量
   规则终审任意空点）。
2. **视图**（同文件内联 viewHtml，ASCII 标记 `data-game="dsh-tavern.gomoku"`）：
   自包含 SVG 棋盘（木纹/网格/星位/坐标 A-O·1-15/渐变棋子/最后一手红圈/winLine
   红圈/终局覆盖层/无 token 静态预览局面）；**人类回合才启用点击与建议点提示**
   （agent 回合静默等待、落子经下行自动出现——与参照包视图的差异语义，减少无谓
   409）；首条下行未到的空盘等待态不借预览局面。
3. **registry**：装载数组加入内置；新增「导入同 id 遮蔽内置」装载期 warning
   （不静默——来源目录与装载结果进日志）。
4. **gates**：server-bundle 增 `dsh-tavern.gomoku` 标记（ASCII）+ 负样本自测。

## 对「偏差 1」的重新裁定（内置 vs 参照包）

2026-10-13 把 §4.1 双内置裁为井字棋一个，理由是「examples/ 不随包分发，五子棋
已是导入参照包——双份维护是负资产」。本次按用户显式需求与产品实况重新裁定：
**内置 = 开箱可玩面**——npm 包 files 不含 examples/，普通用户（含桌面档位）没有
途径拿到五子棋；「可导入」只对能访问仓库的人成立。代价如实：**两份五子棋实现**
（内置 TS + 参照包 JS），分工为——内置 = 产品分发面（随插件、零导入），参照包 =
导入路径夹具与可分发标准样本；规则一致性由两套测试各自钉死（和棋用例共用同一份
113/112 冻结数据）。

## 遮蔽语义（同 id：`dsh-tavern.gomoku`）

- 导入目录（installed/）与内置同 id 时以**磁盘上的导入副本为准**（延续既有
  「builtin/imported 优先于 mod」单一遮蔽规则，不引入内置保护特例），装载期记
  warning。
- 坏导入同 id 也遮蔽（broken 条目**可见**、reason 可读；删目录即恢复内置）——
  延续「坏游戏不断路 = 坏条目可见」教义，而不是让烂导入静默无效。
- 语义后果如实：导入参照包 = 用磁盘副本接管五子棋槽位（面板来源徽标变「导入」）。

## 版本与示例漂移连带（0.6.0→0.6.1）

- 版本补丁位（特性增量，不改任何对外契约面）。
- 连带（升版即逼同步的既定纪律）：story-clock 示例 engines `^0.6.0`→`^0.6.1`
  （其 spec 断言 engines 恰为 `^${PLUGIN_VERSION}`，2026-10-12 静默漂移修复的
  守卫语义不变）、mod-api.md engines 示例值同步 `^0.6.1`。
- 五子棋参照包 engines **维持 `^0.6.0`**（如实：`^0.6.0` ⇒ 0.6.x 全系含 0.6.1，
  是更准也更宽的声明；该包兼容性与宿主补丁版本无关）。配套把 games-import.spec
  的宿主版本从硬编码 `'0.6.0'` 改从 `packages/plugin/package.json` 推导（镜像
  tavern-mods-examples 守卫）——示例清单的 engines 一旦不再覆盖当前宿主（如
  0.7.0 到来）在该 spec 翻红。

## 视图真机验收（headless Edge / Chromium 渲染，2026-10-14）

四态截图（headless Edge + 本地 HTTP 服务视图字符串 + 自投递
`dsh-tavern:game-state` 下行——与生产同一条消息路径）：

- 预览（无 token）：静态局面 + 预览横幅与调试指引；
- 等待（有 token、首条下行未到）：空盘 + 「等待对局状态…」；
- 中局（人类回合）：棋子/星位/坐标/最后一手红圈/「黑方 · 轮到你落子 · 上一手 summary」横幅/建议点/可点热区；
- 终局：winLine 红圈 + 「黑棋获胜」覆盖层 + summary 文案 + 结束指引。

截图与 harness 为一次性验收产物（`%TEMP%/gomoku-view-check/`，不入库）。

## gates

- server-bundle 增 `dsh-tavern.gomoku` 标记（内置引擎 MANIFEST 与视图 data-game
  双处出现）+ 负样本自测（负样本用 `gomoku-removed` 全量替换——`dsh-tavern.gomoku-gone`
  仍含原串会被子串救活，是 2026-10-14 games/list 负样本同款陷阱）。
- 无新 gate、无其他 gate 改动（集成面零新增）。

## 测试对账

| 阶段 | 基线 |
|---|---|
| 起点（仓库 HEAD） | 96 文件 1394 过 +1 跳 |
| 内置五子棋 | **96 文件 1417 过 +1 跳**（净增 23，均为 games-builtin.spec 内扩展：五子棋契约 22 + 视图过 view 服务管线 1） |

`pnpm run check` exit 0（tsc 零错 + vitest 全绿 + dist 重建 v0.6.1 + 15 gates 全 PASS）。
过程留档（如实）：中途一次运行在自建 headless Edge 截图进程未回收的争用下出现 13 项
超时类失败（hook timed out / Windows rmdir 重试——截图验收与测试勿并发跑）；另一次
命中仓库既有偶发族 1 项（novel-store「pid 被非 dsh 进程复用时自动接管」），本次顺带
定位到机制：ownership 探针经 `powershell Get-CimInstance` 读命令行、超时 5s，
负载下探针超时落入「undecidable 保守拒绝」（packages/tavern-store/src/novel.ts
117-159），与本变更无关联（修复留档待裁）。清场后最终**连续两次全量全绿**
（96 文件 1417 过 +1 跳）。

## 边界（如实）

- 两份实现（内置 TS / 参照包 JS）是本次裁定的已知成本：规则漂移无机械守卫（两套
  测试各自钉死自己的行为面；更强的跨实现对照可后加）。
- 同 id 遮蔽对坏导入会让内置五子棋显示为 broken（reason 可见、删目录恢复）；
  不引入「坏导入不遮蔽内置」的特例——保持 registry 单一遮蔽规则。
- 视图终局覆盖层居中，可能与穿过棋盘中心的 winLine 视觉重叠（与参照包同款设计；
  文案仍完整可读）。
- 0.6.0 宿主不含本内置：需升级插件（桌面档位走自更新；web 档位为源码 link: 时
  重建 dist 后重启 DSH）。
