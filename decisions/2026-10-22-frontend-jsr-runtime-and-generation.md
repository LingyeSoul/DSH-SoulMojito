# 美化前端 JSR 运行时补齐与生成桥（2026-10-22）

## 问题

两张已导入的第三方卡在沙箱 iframe 里无法运行（下文以示例卡2 / 示例卡3 代称）：

- 示例卡2：Vue SFC bundle 读取全局 `Vue`；`mvu_zod.js` 读取全局 `z`（Zod 4）；
  开场 BGM 调 `playAudio`；Mvu 初始化包 `errorCatched`；前端 store 用
  `window.frameElement.getBoundingClientRect()` 与
  `window.parent.document.getElementById('send_textarea')`。
- 示例卡3：React 游戏前端在启动时硬性检查 `TavernHelper.generate`；启动诊断调用
  `getLoadedPresetName` / `getPreset` / `getCharData`；资源包密钥从
  `getCharData('current').data.creator/character_version/creator_notes` 派生；
  字体解密后以 blob URL 加载；设置/API 源写 `localStorage`。

旧构建还因为 shim 模板注释里的反引号提前终止模板字面量，产生
`Uncaught SyntaxError: Unexpected identifier 'window'`。

## 决策

1. **保持沙箱**：不加入 `allow-same-origin`。`window.parent` 仍是受控 facade，
   所有宿主能力继续走 token 校验的 postMessage RPC。
2. **补齐 JSR 运行时全局**：iframe head 注入 Vue 3.5.40 runtime global、
   Vue Router 4.6.4 global，以及 Zod 4.4.3 的 ESM 命名空间到 `window.z`
   （同时支持 `z.object` 与 `mvu_zod.js` 的 `z.z`）。版本与 JSR 对齐。
3. **生成桥放宿主 Node 侧**：`TavernHelper.generate` / `getModelList` 经 helper
   RPC 交给插件服务器，由服务器代发卡内配置的 OpenAI 兼容
   `GET /models`、`POST /chat/completions`。API Key 只用于 outbound
   `Authorization`，不写 snapshot/state、不回传、不落日志，错误消息 redact。
   首版非流式；`should_stream` 被接受但按最终文本返回。
4. **只读/内存兼容面**：`getCharData` 返回 JSR 的 `v1CharData` 形状（顶层字段 +
   `.data`）；`getPreset` / `replacePreset` 是 iframe 内存覆盖，不写基础预设资产；
   脚本按钮面同理（不渲染按钮栏）。`getTavernHelperVersion()` 返回兼容级别
   `4.8.2`，不是插件版本。
5. **事件别名**：`STREAM_TOKEN_RECEIVED` / `CHARACTER_MESSAGE_RENDERED` /
   `USER_MESSAGE_RENDERED` 由快照比对触发，只发最终文本一次；不伪造真实 token
   流，也不伪造 `tavern_events.GENERATION_ENDED`（没有楼层 id 可传）。
6. **沙箱存储走宿主**：`FrontendFrame` 构建 srcdoc 前取
   `GET frontend/storage?character=…`，把 localStorage 键值表同步播种到 iframe；
   写入 200ms 合并后 `storage.set` 写回 `state.json` 的 `frontendStorage`
   （512KB/角色）。`sessionStorage` 保持 iframe 内存。`indexedDB` 则提供虚拟
   垫片：open/createObjectStore/transaction/get/put/delete/clear/deleteDatabase
   经 helper RPC 转发，记录体走 `frontend/idb/put|get` 二进制路由，按角色落在
   `$DSH_HOME/soulmojito/frontend-idb/`，名字/key 全部 SHA-256 后落盘。
   单条 1GB、单角色 2GB，先写临时文件再原子 rename。IndexedDB 的 index/cursor/
   多 store 复合事务不在首版范围，缺口显式抛错。
7. **音频与字体**：`playAudio` / `pauseAudio` 等落到 iframe 内 `<audio>`；
   `font-src` 放行 `blob:`，因为卡常把解密字体做成 blob URL。
8. **输入框双路径**：`document` facade 的 `getElementById` 同时映射
   `send_textarea` / `send_but`，与既有的 `querySelector` 路径一致。

## 否决项

- **`allow-same-origin`**：能让 IndexedDB/localStorage 原生可用，但会把宿主
  DOM、Cookie、API Key 暴露给任意卡脚本，破坏现有安全边界。
- **iframe 内直接 fetch 卡内 API**：CORS 不可控，且 Key 会留在页面脚本可见域。
- **把数百 MB 级资源包塞进 `state.json` / helper JSON RPC**：状态文件膨胀且
  请求体受限；大记录改走二进制路由与独立磁盘目录，不进入 state。
- **伪造流式 token**：没有真实增量时发假 token 会让卡的解析/重绘进入错误状态。

## 素材与命名纪律

- 兼容性验证涉及的卡名、角色名、卡文件、封面/立绘截图、远程前端 URL 一律不进入仓库。
- 文档、测试、注释和 commit message 只使用 `示例卡2` / `示例卡3` 代称；测试数据使用通用
  `records` / `model-a` 这类占位名，不复用卡内真实 store、角色或资源标识。
- 本次调试使用的浏览器截图、卡 JSON、卡聊天记录只放在临时目录（`%TEMP%/opencode`），
  不提交、不复制进 `docs/` 或测试 fixture。
- 后续若需要保留回归素材，必须脱敏/裁剪为最小片段，并继续使用代称；无法脱敏的素材
  只作为本地手工验证，不进入版本库。

## 已知边界

- 生成桥非流式；需要 token 流的卡要等后续 SSE 转发。
- 虚拟 IndexedDB 首版只覆盖单 store 的 keyPath/get/put/delete/clear/
  deleteDatabase；index、cursor、多 store 复合事务、IDBKeyRange 显式抛错。
- `getPreset` / `replacePreset`、脚本按钮不写基础资产，也不出现在宿主 UI。
- `getTavernHelperVersion()` 是兼容级别声明；不存在的 JSR 函数仍显式抛错。
