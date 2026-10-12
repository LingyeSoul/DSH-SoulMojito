# 自更新 restart-required 永不解除：stamp 自指悖论 + 共享缓存幽灵

> 日期：2026-10-12。Bug 报告：更新到 v0.5.0 (77a1319) 后面板一直显示「需要重启」，
> 手动重启后仍不消失；desktop profile 更新一次后同样卡住，更新按钮失效
> （「用不了更新」）。修正
> [2026-10-05-desktop-plugin-self-update.md](2026-10-05-desktop-plugin-self-update.md)
> 引入的过渡态收敛机制——该机制的收敛锚点在 dist 随源入库的仓库里数学上不可达。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | `packages/plugin/src/update/service.ts`（过渡态收敛与缓存幽灵防线）、`packages/plugin/src/update/apply.ts`（安装成功统一落戳）、`packages/plugin/src/index.ts`（readBuildInfo 身份优先级翻转） |
| 唯一事实来源 | 模块加载时磁盘上的 `version.json` 旁车（安装器成功后统一落戳）= 运行中构建的 commit 身份；GitHub main HEAD = 远端身份。烤进 bundle 的 `__TAVERN_COMMIT__` 降级为旁车缺席时的兜底 |
| 持久态 | `$DSH_HOME/tavern/update-state.json` 新增 `pendingRestartPluginDir` 来源字段（schema 1 容错读取，旧缓存无此字段时过渡态不恢复）；已安装目录的 `version.json` 旁车（安装语义的一部分） |
| 临时态 | 进程内 pendingRestart / installState / 环形日志（不变） |
| 外部依赖 | 无新增；persistCache 复用 apply.ts 导出的 `writeFileAtomic`（Windows 瞬时锁有界重试） |
| 注册入口 | `installUpdate` 成功路径统一落戳（cli / plugin-manager / checkout 三条策略共用，不再由 checkout 专属的 ensureVersionStamp 分头保障） |
| 删除路径 | 还原 readBuildInfo 优先级、移除 stampInstalledBuild 与来源字段、恢复 ensureVersionStamp 即回旧语义（不推荐：卡死复发） |
| 兼容对象 | 旧缓存（无来源字段）读入时幽灵不恢复——存量卡死态装上本版后自愈；check/install HTTP 契约与客户端渲染零改动（客户端只消费 status） |

## RCA（证据坐标）

1. **症状闭环条件**：`service.ts` `check()` 只在
   `sameCommit(this.local.commit, this.pendingRestart.commit)` 时解除
   `restart-required`；不匹配则提前返回继续亮「需要重启」。
2. **local.commit 取值链**：`index.ts` `readBuildInfo()` 里烤进 bundle 的
   `__TAVERN_COMMIT__` 字面量**优先于** version.json 旁车（旁车只在字面量缺席时
   填位）。
3. **自指悖论（根因）**：dist 随源入库 ⇒ commit C 内的 dist 烤的必是父提交
   stamp——commit 不可能包含自身 hash。实证三例：
   - `git show 77a1319:packages/plugin/index.mjs` 烤的是 `"84f204e"`（父提交）；
   - desktop 实况安装的 210ec91（提交名即 "Rebuild plugin bundles at 03607a4"）
     烤的是 `"03607a4"`；
   - 仓库历史多次出现「Rebuild plugin bundles at X」提交——作者已经在跟 stamp
     滞后搏斗，但追一拍仍差一拍（重烤时的 HEAD 是 X，提交后 hash 变成新值）。
4. **git 源不携带旁车**：仓库 `.gitignore` 排除 version.json（构建旁车），
   `git show 77a1319:packages/plugin/version.json` 报 not in tree ⇒ 纯 git 安装
   现场只有字面量可读。
5. **推论**：pendingRestart.commit（安装目标，来自 spec/旁车合成，准确）与
   local.commit（恒父提交）**永不相等** ⇒ restart-required 永久；且 `install()`
   在 pendingRestart 非空时短路（"already installed; restart DSH"）⇒ 更新按钮
   死亡——与「用不了更新」的报告逐字吻合。
6. **共犯 A（跨 profile 幽灵）**：update-state.json 在 `$DSH_HOME/tavern` 下被
   desktop/web 两个 profile 共享（实况：`~/.dsh/tavern/update-state.json` 停在
   10-07 的 `{0.3.9, 48f3f74}`，而 web 面板徽标显示的是 0.5.0——安装结果只活在
   进程内存）。`loadCache` 的「local 变了作废」不清 pendingRestart，也没有
   来源限定：A profile 装出的过渡态会压到 B profile 头上，B 的 stamp 永远追不上
   A 的安装目标。
7. **共犯 B（persist 静默失败）**：`persistCache` 单次 `writeFileSync`+`renameSync`
   无重试、异常整体吞掉（apply.ts 对同类 Windows 瞬时锁专门做了
   `FILE_LOCK_RETRY_DELAYS_MS` 有界重试）——实况缓存 mtime 自 10-07 未再前进，
   与「安装完成徽标却只在本进程可见」互相印证。

## 方案（四层）

**A. 运行身份翻转（index.ts readBuildInfo）**：磁盘旁车的合法 commit 优先于烤入
字面量；字面量降为旁车缺席时的兜底。旁车在模块加载时从磁盘读，正是「这一代
进程跑的是什么」的真相来源；烤入字面量恒滞后一拍，做首选会让过渡态永远解除
不了。开发仓库（pluginDir 即 `packages/plugin`）的 `resolveTavernCommit` git
HEAD 覆盖链保持不变。

**B. 安装器统一落戳（apply.ts stampInstalledBuild）**：`installUpdate` 三条落地
路径（cli / plugin-manager / checkout）成功后把目标 commit 写进已安装目录的
version.json 旁车，并回读 `outcome.installed` 保持一致；目标 commit 非法或版本
不可知时不动磁盘。取代旧 checkout 专属 `ensureVersionStamp`——那个版本只在
旁车缺失时合成，装到已有陈旧旁车的目录（link: 开发仓库、老 checkout 残留）
不覆盖，readInstalledStamp 读回旧值同样造出收敛失败。

**C. 过渡态幽灵防线与逃生门（service.ts）**：
- `loadCache` 恢复 pendingRestart 要求缓存的 `pendingRestartPluginDir` 与本实例
  的 `pluginDir` 一致；旧缓存无来源字段一律不恢复（存量卡死态一次性自愈），
  且未恢复时缓存的 restart-required 状态重置为 unknown（首屏不亮假徽标）；
- 「local stamp 变了」的既有作废分支同时丢弃 pendingRestart（新模块代已加载 ⇒
  过渡态结束，交给常规检查重新落锤，不让上一代安装记录压住新代）；
- `install({force})` 穿透 pendingRestart 短路——死循环的过渡态有逃生门；
- `applyOutcome` 在安装结果 commit 不可知时不再进入 restart-required（没有可
  判定收敛的锚点，硬造只会得到解除不了的过渡态），落 unknown 并如实说明；
- `check()` 解除过渡态时作废旧结论（checkedAt 置空）立即重查——TTL 窗口内
  不带着刚清空的过渡态复读上一个 status。

**D. 持久化重试（service.ts persistCache）**：改用 apply.ts 导出的
`writeFileAtomic`（临时文件 + rename + 瞬时锁有界重试），与安装文件写入同一
套 Windows 锁纪律；缓存 payload 增写 `pendingRestartPluginDir`。

## 否决项

- **内容寻址（本地 dist blob hash 对 GitHub tree API 的 blob hash）**：身份判定
  彻底摆脱 commit 自指，但需要重写 fetchRemoteBuild/compareBuilds 的比较模型、
  远端多取一份 tree 响应，超出本次修复面；留作后续提案候选。
- **进程启动时间对比（process.uptime vs installedAt）**：能判「重启已发生」，
  判不了「装的是什么」——compareBuilds 的 update-available 回弹（冰山第二层）
  仍在，只修一半。
- **提交前构建 CI 化（commit 后 CI 重建 dist 再追加提交）**：把悖论转移给 CI
  与提交顺序；桌面单人仓库成本不成比例，且历史上的手工 Rebuild 提交已实证此路
  恒差一拍。
- **update-state.json schema 强升清缓存**：容错读取 + 来源字段已让旧缓存自然
  失效（无字段不恢复过渡态），不需要全局作废一次所有人的发现缓存。

## 边界如实标注

- **首轮兜底语义**：纯 git 安装（无旁车）在装上本修复版之前，local 仍取字面量
  （父提交）⇒ 首个更新周期照常报 update-available；用本版安装器更新一次后旁车
  落地，此后身份恒以旁车为准、一次重启即收敛。存量 desktop 需先手动升到本版
  （其按钮已被旧版幽灵短路）：`dsh plugin --profile desktop add
  github:LingyeSoul/dsh-tavern#<本修复 commit>&path:/packages/plugin`。
- **link: 开发仓库**：旁车是构建产物（.gitignore），本地构建后即准确；checkout
  兜底把发布产物拷进开发仓库工作区时同步覆盖旁车（本就是安装语义）。
- **pnpm 后续操作**（按 lockfile 重装）会丢旁车（tarball 不含）⇒ 回落字面量 ⇒
  再走一个更新周期重新收敛；可接受。
- **checkout 落到 lockfile 未更新的旧 pin**（既有文档化边界）：重启后旁车=目标
  commit、lockfile 仍旧——下一次 pnpm 操作回退文件时会再触发一轮更新，语义自洽。

## 测试锁

- `tavern-update.spec.ts` 新增 6 项：旧缓存幽灵不恢复（历史卡死自愈 + 按钮解封）、
  跨插件目录幽灵不恢复、来源匹配时恢复过渡态 + force 穿透重装、local stamp 变化
  丢弃过渡态、安装结果 commit 不可知不进 restart-required、stampInstalledBuild
  单元（覆盖陈旧旁车 + 非法值不动磁盘）与 installUpdate 真链路落戳集成；
- 既有 42 项更新面测试全数保持绿（含「plugin-manager 安装后进入
  restart-required」「applied(HMR) 不回弹」「本地 stamp 变化丢弃缓存」）；
- gates `update-routes` 的 `installLogTail` 断言从「最后一行」放宽为「末 5 行
  窗口」：断言语义本就是「pnpm install-log chunk 到达快照」，落戳日志行合法
  排在 pnpm 进度行之后，取末行是把实现顺序错当契约。

测试基线 87 文件 1220 过 → 87 文件 1226 过 +1 跳（净增 6）、15 gates 全
PASS、tsc 零错、端到端 `pnpm run check` exit 0。
