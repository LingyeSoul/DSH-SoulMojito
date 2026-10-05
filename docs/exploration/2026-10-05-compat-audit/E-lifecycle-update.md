# 审计 E · 生命周期 / manifest / 自更新（已完成 2026-10-05）

宿主基准：`.npm-cache/dsh-runtime/node_modules/@deepseek-ai/`（0.2.0-rc.2）
总判定：manifest、patch.yml 全部字段、9 个 inject 服务名、webServer/preset/recompose/effect/inject API、v4 source kind、ambiguous-install 降级链——逐条吻合无断点。风险集中在自更新流 stamp 一致性与写盘原子性。

## 必修（❌）

1. **checkout 兜底不覆盖 version.json** — `src/update/apply.ts:69` SHIPPED_FILES 无 version.json；而 `files` 清单（package.json:17）带它、`readInstalledStamp`（apply.ts:433）version.json 优先、`readBuildInfo`（index.ts:2673-2677）version.json 覆盖 package.json。
   - 症状：registry 安装（tarball 含 version.json）自更新走 checkout 兜底后旧 version.json 残留 → stamp 读回旧 version+commit → pendingRestart 被 sameCommit 立即解除（service.ts:164-172）→ 更新徽标回弹死循环，重启后显示旧版本。
   - 修复：version.json 加入 SHIPPED_FILES（checkout 源被 .gitignore 排除则从已拷贝 package.json + 目标 commit 现写）。

## 建议修（⚠️）

2. **web+HMR `application:'applied'` 被当终态** — `apply.ts:244-247` 只有 `'restart-required'` 置 restartRequired；宿主 `dsh-plugin-manager/lib/index.js:2042` 在 HMR 下返回 `'applied'`，且 README:130 明示包替换必须重启进程才加载新 module generation。插件判 up-to-date 后内存 stamp 旧 → 6h TTL 重新报可更新，去重失效。修复：`applied` 分支同样按"磁盘 stamp ≠ 内存 stamp"进 pendingRestart。
3. **HMR 重挂后自动更新检查静默死亡** — `service.ts:272` start() 的 disposed 短路 + `index.ts:95,129` 模块级 memo 单例：同 module generation 复用时旧实例已 dispose，重挂 no-op，自动检查死亡（手动路由仍可用）。修复：apply 时检测实例已 disposed 则重建。
4. **checkout 覆盖非原子、无 Windows 锁重试** — `apply.ts:375-398` rmSync+copyFileSync 整组替换；宿主为同场景提供 `dsh-atomic-write writeFileAtomic`（Windows EACCES/EBUSY/EPERM 有界重试）。中途失败留半新半旧。修复：逐文件 writeFileAtomic 语义或暂存目录切换。
5. **manifest 无 peerDependencies/engines.dsh/manifestVersion** — 宿主组合边界只查 peer 声明（dsh-app-boot/README.md:52），缺失即无版本护栏，breaking change 运行期才炸。建议 `"peerDependencies": {"@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0"}` + manifestVersion: 1。
6. **gates 两处滞后** — node-half-mount（run.mjs:1513,952-959）断言的 inject 集合落后 index.ts:71 实际（缺 agentPresets/tools/compaction）；patch-reference（run.mjs:1264）不校验两个 preset 行 config 形状与 preset config.id 常量锁定。修复：同源化/扩 gate。
7. **compaction-basic 覆写在 rc.2 web profile 冗余 no-op** — cordis.patch.yml:50-51；宿主 web profile 自身已 disable（dsh-web-app/cordis.patch.yml:509-510）。无害，更新注释叙事即可。
8. **DSH_PROFILE 缺省 'desktop' 文案误导** — apply.ts:197,320；宿主进程从不设 DSH_PROFILE（仅 dsh-shell-env 在 shell 工具快照注入），web 用户看到 `--profile desktop` 提示。修复：从 ctx.profileContext 取真实 profile。

## ❓ 不可证（挂起）

- 桌面 CLI 链路：dsh-desktop-host 包不在 runtime 缓存，web 上不会误触发（argv[2] 是 config 路径 → exists() 失败正确回退）。
- pnpm `#<sha>&path:/packages/plugin` 子目录 spec：宿主 installBundle 透传 pnpm，插件有实测注释 + update-routes gate 锁格式。

## 已验证 ✅（蓝军项也安全）

- patch.yml 方言理解逐字吻合宿主（name 不匹配 → warn+skip，dsh-app-boot/lib/index.js:90-94）。
- 自更新不改 preset config.id（agent-tavern/agent-novel）→ 旧会话恢复不断（registry README "rejects a missing definition" 只对改 id 生效）。
- `pluginManager.installBundle(spec, {requestId, enabled})` 签名、install-log/install-state 事件、ambiguous-install 机制判断全部有据。
- v4 source 版本分支与宿主迁移边精确对齐（v3-to-v4 index.js:92,126）。
