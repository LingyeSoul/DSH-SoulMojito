# IM 工具只对已绑定会话可见

> 日期：2026-11-09。状态：已实施。相关：`decisions/2026-10-31-im-native-session-binding.md`（IM 绑定原生会话）、`decisions/2026-11-09-agent-ptc-mode.md`（PTC 的 `run_code` SDK 只应包含当前可见工具）。

## 问题

`mountIm` 把 `im_identity` / `im_channels` / `im_send` / `im_time` 注册到**每个原生 agent 的 scope**，再在执行时按 `exec.agent.id` + `state.imPeers` 校验。安全边界没问题，但没绑定 IM 的普通会话也会在工具表里看到四个 IM 工具，模型会误以为当前会话可以收发 IM，PTC 的 SDK 也会把这四个空转工具编进 `run_code` 绑定。

## 决策

- 注册时使用宿主 `tools.register(definition, { when })` 的**步骤级可见条件**，而不是把工具直接暴露给所有会话。
- `when` 读取当前 preparing agent 的 `session.id`，只有该会话出现在 `state.imPeers` 里才返回 true；未绑定时工具同时从模型工具表和 PTC SDK 的 `definitions(scope, toolSet)` 中消失。
- 绑定/解绑后立即失效共享快照：`POST/DELETE /api/dsh-soulmojito/im/peers`、`/bind`、`/unbind`、会话清理和账号删除路径都调用 `invalidateImToolBindingCache()`。快照本身只在一个步骤内复用（100 ms），避免四个工具重复读 `state`。
- 绑定表读取失败时隐藏 IM 工具并记一次 warning：不能证明会话已绑定就不扩大 IM 触达面。
- 不支持 `when` 的旧宿主会忽略第二个参数，退化为原先的「注册但执行时校验」；这是兼容回退，不改变安全边界。

## 结果

- 非 IM 会话的 `request/header.tools` 不再出现四个 `im_*` 工具。
- 已绑定会话在绑定的下一步立刻看到工具；PTC SDK 也只生成当前会话真正可用的绑定。
- `packages/plugin/tests/im-agent-mount.spec.ts` 覆盖未绑定隐藏、绑定出现和缓存失效。
