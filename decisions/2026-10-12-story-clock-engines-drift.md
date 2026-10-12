# Story Clock 示例 Mod 被 engines 卡死：0.x caret 次段锁 + 测试版本漂移共谋

> 日期：2026-10-12。Bug 报告：Mod 面板里 Story Clock（v1.0.0 · dsh-tavern）显示
> 「错误」，面板原文 `requires dsh-tavern ^0.4.1 (host 0.5.0)`；同目录另两个示例
> （asset-stats / mood-tracker）正常。修正示例清单的 engines 漂移，并补上让这类
> 漂移在 CI 翻红而不是在用户面板上爆炸的防漂移守卫。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/examples/mods/dsh-tavern.story-clock/mod.json`（engines 范围）、`packages/plugin/tests/tavern-mods-story-clock.spec.ts`（宿主版本模拟与断言）、新增 `packages/plugin/tests/tavern-mods-examples.spec.ts`（全示例防漂移守卫） |
| 唯一事实来源 | `packages/plugin/package.json` 的 `version`（宿主 `BUILD_INFO.version` 的同源发布真值）——测试从此读取，不再硬编码 |
| 持久态 | 无新增（mod.json 是声明性配置；Mod 私有存储 `data/state.json` 不受影响） |
| 临时态 | 无 |
| 外部依赖 | 无新增（semver 匹配器是自写的，`manifest.ts satisfiesVersionRange`） |
| 注册入口 | 无新面；engines 判定点在 `mods/host.ts` scan（既有） |
| 删除路径 | 还原 engines `^0.4.1` + 删 drift guard spec 即回旧语义（不推荐：0.6.0 时复发） |
| 兼容对象 | 用户已装副本（`$DSH_HOME/tavern/mods/dsh-tavern.story-clock`，0.4.1 时代老代码、无 onButton）就地改 `^0.4.1 \|\| ^0.5.0`——对那份代码诚实（全部 API 自 0.4.1 存在）；仓库示例（含按钮面）只声明 `^0.5.0` |

## RCA（证据坐标）

1. **症状逐字节对上**：面板错误文案 `requires dsh-tavern ^0.4.1 (host 0.5.0)` 正是
   `manifest.ts` `satisfiesVersionRange` 不满足时的 reason 原文（`requires
   dsh-tavern ${range} (host ${version})`）；`host.ts` scan 把 engines 不满足的 Mod
   放进 blocked，snapshot 投影为 `status: 'error'` + 原因——面板「错误」即此。
2. **caret 的 0.x 语义**：`caretUpperBound`（`manifest.ts`）对 `0.4.1` 返回
   `0.5.0` ⇒ `^0.4.1` = `>=0.4.1 <0.5.0`。宿主 `e585324`（Bump version to
   0.5.0，2026-10-11）之后，`0.5.0` 越上界，判定翻负。
3. **为什么只有 story-clock**：三个示例里只有它声明了 engines（asset-stats /
   mood-tracker 无 engines 字段 = 不做版本判定），所以升版本只炸它一个。
4. **时间线**：story-clock 诞生于 `8e252ca`（当时 package.json = 0.4.1，`^0.4.1`
   是准确的）；按钮面 `0bac59a` 落地时版本串已是 0.4.5；`e585324` 升 0.5.0——
   没有任何机制提醒「示例清单里的 engines 要跟着宿主版本走」。
5. **测试为什么没拦住（共谋）**：`tavern-mods-story-clock.spec.ts` 硬编码
   `hostVersion: '0.4.1'`——用一个不存在的旧宿主模拟装载，示例对真实宿主已经
   blocked 的事实被绿灯掩盖。`tavern-mods*.spec.ts` 里共 9 处同样硬编码（其余
   测的是合成 Mod 的通用宿主行为，版本左值无意义，不在本修范围）。
6. **用户现场**：`C:\Users\%USERNAME%\.dsh\tavern\mods\dsh-tavern.story-clock\` 是
   0.4.1 时代的旧拷贝（无 `buttons` 字段、index.mjs 无 onButton），与仓库 HEAD
   版本不同源——两边要分别处理。

## 落法

- **仓库示例**：engines `^0.4.1` → `^0.5.0`。HEAD 版示例使用 `api.onButton` /
  manifest `buttons`（`0bac59a` 起），只声明可验证的版本（0.5.0 = 本仓库宿主），
   不对无法考证发布边界的 0.4.x 点版本做兼容声称。
- **用户已装副本**：就地改 `^0.4.1 || ^0.5.0`（演示 `||` 跨次版本语法，也正是
   mod-api.md 新增陷阱警告的活例子）；旧代码 API 面自 0.4.1 全部存在，声称诚实。
   改完后需重启 DSH 或 `POST mods/state` 幂等重设唤醒 rescan（宿主只在 refresh
   重扫目录，mod-api.md §1 已有既档说明）。
- **story-clock spec**：`hostVersion` 改为从 `packages/plugin/package.json` 读
   `PLUGIN_VERSION`（与宿主 `BUILD_INFO.version` 同源语义）；engines 断言改
   `^0.5.0` 并新增 `satisfiesVersionRange(PLUGIN_VERSION, …)` 真判定断言——
   硬编码版本模拟从此对该 spec 失效。
- **drift guard（新增 `tavern-mods-examples.spec.ts`）**：拷 `examples/mods/`
   全部示例进 tmp，以 `PLUGIN_VERSION` 开宿主、三层开关全开装载，断言每个示例
   `status === 'loaded'`。blocked / broken / load-error 在 snapshot 里全部投影为
   `error + 原因`，所以这一个断言覆盖清单校验、engines、setup 三环对当前宿主
   的有效性。下次宿主升 0.6.0 而忘了示例清单，CI 在这里翻红而不是用户面板翻红。
- **mod-api.md**：engines 范围语法节新增「0.x 陷阱」条目（caret 在 0.x 下锁次段、
   跨次版本用 `||`、只声明验证过的版本），示例值同步 `^0.5.0`。

## 蓝军自攻击

- **守卫必须真有牙**：把示例 mod.json 临时改回 `^0.4.1` 跑 drift guard——翻红，
   失败信息逐字节复现用户面板原文（`dsh-tavern.story-clock: requires dsh-tavern
   ^0.4.1 (host 0.5.0): expected 'error' to be 'loaded'`），还原后复绿。守卫对
   事故形态的回归敏感已证。
- **会不会误伤**：guard 断言 `snapshot.mods` 的 id 集合与目录清单相等 + 全部
   `loaded`；`examples/mods` 下混入坏示例目录会翻红——这是期望行为（示例就该
   是可装载的），不是误伤。
- **用户副本改 `^0.5.0` 行不行**：行但不必要地放弃 0.4.x 声明；`||` 分支语义
   对旧代码诚实且演示了文档语法，选 `||`。

## 边界（如实）

- 用户已装副本仍是 0.4.1 时代代码（无按钮面）；要从仓库 HEAD 拿新版（含「拨快
  1 小时」按钮），整目录重拷 examples 版即可，`data/state.json` 私有存储兼容。
- `^0.5.0` 在宿主升 0.6.0 时会再次卡示例——这是**故意的设计**：engines 只声明
  验证过的版本，升版本时由 drift guard 逼人同步清单，而不是无声地假装兼容。
- `tavern-mods.spec.ts` / `tavern-mods-stream.spec.ts` 里其余 8 处硬编码
  `hostVersion: '0.4.1'` 测的是合成 Mod 的通用宿主行为（开关裁决、审计、桥
  协议），版本左值对结论无影响，不在本修范围；若未来这些 spec 引入示例 Mod，
  应同样改为读 `PLUGIN_VERSION`。
- npm 上 `dsh-tavern` 名下的 2.x 版本与本项目无关（本项目 git 分发），无法用
  npm 版本史考证 0.4.x 点版本的发布边界——这正是仓库示例只声明 `^0.5.0` 的
  原因之一。

## 测试锁

- `tavern-mods-story-clock.spec.ts`：清单断言 engines = `^0.5.0` + 对
  `PLUGIN_VERSION` 的 satisfies 真判定；装载用真实宿主版本。
- `tavern-mods-examples.spec.ts`（新）：三示例齐全性 + 全示例对当前版本
  `loaded`（防漂移守卫，负样本自证有牙）。
