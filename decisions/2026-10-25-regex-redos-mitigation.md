# 正则 ReDoS 缓解：执行前安全门 + 输入上限

> 日期：2026-10-25。安全收口：角色卡作者可控的 `findRegex` 不再把灾难性回溯
> 直接送进同步事件循环。落点：`packages/tavern-script/src/regex-safety.ts`（静态分析）、
> `packages/tavern-script/src/regex.ts`（编译/执行接线、输入上限、告警回调）、
> `packages/tavern-script/tests/regex.spec.ts`。

## 问题

正则脚本的 `findRegex` 由卡作者提供，现有实现直接 `new RegExp` 后同步执行
`text.replace(regex, ...)`。像 `(a+)+$` 这样的模式在 `aaa...a!` 输入上会触发指数级
回溯，阻塞整个插件进程；同步代码没有可插入的定时器或 `AbortSignal` 中断点。

## 决策

保持 `compileScriptRegex` / `applyRegexScript` / `applyRegexScripts` /
`applyRegexScriptsToLines` 的同步签名不变，在执行前加保守安全门：

- **模式长度上限**：编译前拒绝超过 `MAX_SCRIPT_REGEX_PATTERN_LENGTH`（100,000
  UTF-16 code units）的模式，避免把超大源码送进正则编译器。
- **结构规则**：拒绝以下已知超线性形状：
  - 被重复的子表达式内部还含量词（如 `(a+)+`、`(a*)*`、`(.*)*`、`(?:a+){20}`）；
  - 重复的交替分支存在重叠/前缀关系（如 `(a|aa)+`、`(foo|foobar)+`、可空分支）；
  - 相邻的无界量词可消费同一批字符（如 `a*a*`、`\w+\w+`、`(?:[a-z]+[a-z0-9]+)`）;
  - 无界重复可匹配空串，或重复含反向引用；
  - 分组嵌套超过 100 层，或交替分支超过 64 个（后者仅在需要外层重复时拒绝，
    避免逐对检查的平方开销）。
- **输入上限**：单次脚本应用最多处理 `MAX_SCRIPT_REGEX_INPUT_LENGTH`（100,000
  UTF-16 code units，约 10 万 ASCII/CJK 字符；非 BMP 字符按 2 个 code unit 计）。
  超过时脚本跳过，不截断、不部分替换。这个上限对聊天消息足够宽裕，同时限制多项式
  回溯的最坏输入。
- **跳过语义**：不合法、未通过安全门或超长输入都返回 `null`（`compileScriptRegex`
  同样返回 `null`）；`applyRegexScripts` 保留跳过前的文本继续下一条脚本。跳过
  绝不被当作成功替换。
- **可观察性**：`RegexApplyDeps` 新增可选 `onWarning(warning)`，同步收到
  `invalid-regex` / `unsafe-regex` / `input-too-long` 三种 code，以及脚本名和原因。
  回调异常按调用方错误处理，不静默吞掉。未传回调时行为与旧的“跳过”一致。

没有采用“同线程同步超时”：JS 无法中断正在执行的 `RegExp`。Worker + `Atomics.wait`
虽然能模拟同步超时，但会引入 worker 生命周期、序列化和打包耦合，且主线程仍被阻塞；
本步选择可移植的静态门禁。也没有引入 RE2 等原生依赖。

## 误报风险

门禁是保守的，会跳过一些实际线性的复杂写法，例如：

- `(?:<[^>]+>)*`（外层重复包含 `[^>]+`）；
- `(?:[^"\\]|\\.)*`（交替分支首字符集无法证明不相交）；
- `(?:cat|dog)+i`（忽略大小写时无法用字面前缀证明分支不相交）；
- `(\w)\1+`（无界重复反向引用）。

这些脚本不会执行，也不会报成功；调用方可通过 `onWarning` 记录并提示改写。常见安全
写法仍保留：`(?:cat|dog)+`、`[a-z]+[0-9]+`、`.*\s+`、无嵌套的捕获组和普通
`/pattern/flags` 字面量。

## 残余风险

这是缓解，不是 RE2 级线性引擎，也不是形式化 ReDoS 证明：

- `.*[a-z]+`、`\w+\s+\1` 等“通配符后接较窄量词 / 复杂反向引用”仍可能呈多项式级
  回溯；输入上限只能限制规模，不能保证低延迟。
- 正则自身的编译成本仍随模式规模增长；上限只保证不会无限大。
- `onWarning` 是可选钩子，现有插件生成调用方尚未传入；未接线时被跳过的脚本仍会
  静默回退为原文，需要后续在 plugin 侧显式接入才能留下日志。
- 新增 JS 正则语法若分析器不认识，会按不安全跳过（宁可误报）；后续引擎特性需要
  同步更新分析器。
- 该门禁只覆盖 `packages/tavern-script` 的卡脚本执行链路；`tavern-jsr` 内的浏览器侧
  正则执行器不在此次范围。

## 删除路径与兼容

删除 `regex-safety.ts`、`regex.ts` 中的门禁/上限/`onWarning` 接线和对应测试即可回到
旧行为；没有持久态、迁移或路由变更。调用方不传 `onWarning` 时签名保持兼容，原有
合法正则的替换结果不变；曾被执行的灾难性脚本现在会被跳过。

## 验证

```powershell
npx vitest run packages/tavern-script/tests/regex.spec.ts packages/plugin/tests/tavern-stscript-regex.spec.ts
npx vitest run packages/plugin/tests/tavern-template.spec.ts
npx tsc -p packages/tavern-script/tsconfig.json --pretty false --noEmit
pnpm run typecheck:plugin
```

结果：第一项 2 个文件、28 项通过；第二项 1 个文件、2 项通过；tavern-script 独立
typecheck 与插件 typecheck 均通过。覆盖：`(a+)+$` 长输入快速返回 `null` 且产生告警、
`(a*)*` / `(.*)*` / `(a|aa)+` / `(?:a+){20}` / `(a*a*)` 被拒、普通与复杂线性模式
仍可替换、输入上限边界的包含/拒绝、跳过脚本不产生成功替换、超长模式在编译前被拒。