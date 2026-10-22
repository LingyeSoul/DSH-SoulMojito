# 历史重写与仓库重建（2026-10-22）

## 问题

公开仓库的历史提交里残留两类素材：

- 
- 第三方角色卡夹具：角色卡 PNG（含完整卡 JSON 与内嵌书）与世界书 JSON，以及测试和文档里的真实卡名、世界名。

HEAD 的隐私提交已移除夹具并改用合成夹具，但旧提交仍可检出这些 blob；仅替换 HEAD 不足以停止分发。

## 决策

1. **重写全部历史**：用 `git filter-repo` 对全部 refs 做文本替换，并用 `--invert-paths` 删除两个第三方夹具路径；随后 `reflog expire` + `gc --prune=now` 清除本地悬空对象。
2. **删除并重建 GitHub 仓库**：旧仓库由仓库所有者删除，重建后只推送重写后的 `main`；不保留旧 issue、PR 与提交链接。GitHub 删除仓库有 90 天恢复窗口，窗口结束后服务端对象才彻底回收。
3. **测试夹具合成化**：`tavern-format` 测试内生成 1×1 PNG、V2 卡 JSON 与世界书；真实卡名、世界名统一替换为 `ExampleCard` / `ExampleWorld`。HEAD 的夹具与文档不再包含第三方素材。
4. **更新面**：README 增加「仓库重建」说明；旧克隆必须重新 clone，不能把旧历史合并回来；已安装插件按新仓库地址重装或重新检查更新。

## 证据

- `git log --all -S <旧卡名>`、`git log --all -S <旧世界名>` 均为空；`git grep` 全部 refs 无命中。
- `git log --all --full-history -- <两个夹具路径>` 为空。
- `git fsck --unreachable --no-reflogs` 为空。
- `pnpm exec vitest run` 全绿；`tsc -b` 零错；插件 gates 全部 PASS。

## 边界

- 重写改变所有受影响提交的 SHA；旧克隆、旧 fork 与第三方缓存中的对象不受本仓库控制。
- 改写前备份在验证后删除，不保留含旧素材的 bundle。
- 90 天恢复窗口属于 GitHub 侧策略，本仓库无法保证服务端立即物理删除。
- 旧克隆若把旧历史推回远端，会重新引入已删除素材；README 的重建说明把「重新 clone」列为强制步骤。
