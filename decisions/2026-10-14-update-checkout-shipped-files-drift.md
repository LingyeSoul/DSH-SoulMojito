# 自更新 checkout 兜底：发布清单单一事实来源化（SHIPPED 漂移修复）

日期：2026-10-14

## 背景

2026-10-14 用户问「仓库内被 git 跟踪的构建产物哪些可删」，审计裁定六产物（`index/agent/compaction/novel/card-workbench.mjs` 与 `client/index.js`）为发布通道本体、全不可删——git spec 安装无 `prepare` 脚本、装即所得，自更新 checkout 兜底直接拷贝仓库内产物（决策 2026-10-05-desktop-plugin-self-update：「分支头就是发布通道」）。同轮审计暴露 checkout 兜底的拷贝清单与发布面脱钩：

- `apply.ts` 的 `SHIPPED_FILES` 硬编码是 package.json `files` 的手工拷贝（外加 package.json 自身），提案 0013 新增 `card-workbench.mjs` 时漏同步；
- 后果：`cli`/`plugin-manager` 均不可用而走 checkout 兜底的用户，更新后拿到新四 bundle + 旧 `card-workbench.mjs` 的混装，无任何提示（拷贝是覆盖式、不删旧文件，旧 bundle 恰好残留）；
- 无 gate/测试锁定两份清单一致——package-contract gate 的 files 必含清单与 exports 契约面同样落后一个时代（`./agent`、`./compaction`、`./card-workbench` 从未进过契约检查）。

## 修复：消灭第二份清单

`copyShippedFiles` 改为运行时从**源目录 package.json 的 `files` 数组**派生清单（外加 package.json 自身——stamp 与版本读取需要）：

- 目录/文件条目按 stat 分流（`files` 里 `client` 是目录），`./` 前缀归一；
- manifest 缺失或 `files` 非数组/空/含非字符串 → 上抛明确错误。checkout 兜底是最后防线，「静默成功但什么都没换」比失败更危险；
- 源里缺席的条目跳过：gitignored 的 `version.json` 不在 checkout 里，安装目录中安装器落戳的旁车不被触碰。

## 防线

- **gates**：package-contract 的 files 必含清单补 `agent/compaction/card-workbench`；exports 契约面补三个子代理入口检查并进 `checkFiles` 磁盘存在性验证（selfTest fixture 同步）。
- **测试**：`tavern-update.spec.ts` 重写 `copyShippedFiles` 用例锁混装回归（安装目录旧 `card-workbench.mjs` 必须被新 bundle 覆盖、`src.ts` 不被带入、旁车不动）+ 上抛负样本两路（缺 manifest / `files` 非数组）。
- **`.gitignore`**：删掉对已跟踪文件无效的 `/packages/plugin/client/index.js` 误导条目，原位注释写明「六产物有意入库、分支头即发布通道、`version.json` 例外」——把设计意图写进文件，防止「构建产物怎么在 git 里」再次被当成误入库。

## 验证

`pnpm run check` 全绿：tsc 零错、99 文件 1486 过 +1 跳（+1 负样本）、15 gates 全 PASS（package-contract 强化后含新契约面）。fix 随 0.6.3 线不升版本（家法：6613a75 同例），`index.mjs` 随 check 例行重建（修复编译入包）。
