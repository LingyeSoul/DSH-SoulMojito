# 审计 D · Client half（已完成 2026-10-05）

总裁决：**0 项 ❌**，client half 与宿主 0.2.0-rc.2 web 壳兼容良好。staticModules 种子表 9/9 逐项一致（读宿主真实前端产物核对）；6 个 slot 名、4 个注入服务（slots/sessions/workspaces/locale）、uiWorkspace 双面探测、22 个图标别名（全描边后缀命名）、样式清点约定全部双侧验证成立；gates 镜像实时读同一缓存非陈旧。

## ⚠️ 卫生级（batch 3 处理）

1. **client/main.js 死重发布** — files 清单整目录发布 client/，main.js 是构建输入（index.js 是其注入产物，build-plugin.mjs:104-113）；宿主仅经 exports['./client'] 加载 index.js；duplicate-registration 守卫（dsh-client-modules/lib/client.js:576-578）兜住不会静默双挂。处置：files 改为精确 client/index.js + gate 同步。
2. **陈旧 CSS 变量** — `--dsh-composer-side-clearance`/`--dsh-session-list-edge-inset` 宿主 0.2.0-rc.2 全域不存在，靠 fallback 降级（16px/8px），仅潜在轻微不对齐。处置：低优先，可改现存变量或保留 fallback。
3. **disable 时 style 标签残留** — apply 期注入的伪装宿主标签不在 factory 物化期清点窗口（dsh-client-modules/lib/client.js:496），条目逐出路径不清；死 CSS 影响极小；HMR replace 会被连带清理。处置：低优先。

## ℹ️ 认知负担项

- 双轨 inject 声明（dsh.client.inject graph-row 级无运行时消费方 vs bundle exports.inject 权威门禁）——现状安全。
- ctx.sessions.open / workspaces.connectWorkspace 旧宿主回退在 0.2.0-rc.2 为死代码（不触发），设计正确。

## ❓

- 「种子 0.1.5→0.2.0 未变」的 0.1.5 侧本地无样本不可复核；现态完全匹配，注释已留 re-sync 纪律。
