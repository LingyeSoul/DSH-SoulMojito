# AgentTavern 复用原生 AgentLoop

状态：`proposed`。AgentTavern 采用 DSH 原生 AgentLoop 作为唯一执行循环，通过 `dsh-agent-presets`、agent-scoped `systemPrompt`、原生工具和事件投影实现按需记忆；现有 ST prompt/JSONL 生成链路保留为 `st` profile。这样可以避免 Tavern 与宿主各维护一套 turn、工具、取消和统计事实。

每个 AgentTavern session 选择 `dsh-native` 或 `agent-managed` context mode。`dsh-native` 不主动筛选历史或调用 compaction，直接服从实际 provider/model route 的 DSH surface、`contextWindow` 和宿主 overflow policy；`agent-managed` 使用可重建的非破坏性 request projection 主动排除旧历史，记忆/变量/资产/历史工具在两种模式均可用。选择 request projection 而非 surface replacement，是因为 context mode 必须能在 turn 边界切回而不改写同一份 session 事实。

DSH `0.1.0-rc.6` 已经满足 profile 组合、固定 context 和 `dsh-native` 的需求，短期用 `agent/pre-step` 适配器承载 kernel/工具结果注入。`agent-managed` 仍依赖正式的 `agent/context` 历史投影 seam，以及基于 effective projection 的 compaction 测量或 profile/session-scoped suppression；缺失任一能力就拒绝启用 managed，而不是伪装降级。Fabric 仅作为已安装 loader hook 的 DSH source checkout 上的版本门控验证 fallback，不作为默认生产依赖。
