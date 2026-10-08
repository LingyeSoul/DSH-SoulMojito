# 无头像资产的默认替代头像

日期：2026-10-08。状态：已实施。

## Problem

`GET avatar/:name` 与 `GET persona-avatar/:name` 只在有真实图像字节时返回 200：
json 角色卡、无内嵌图 charx、成员均无头像的群组、无 PNG 的 persona（prompt 新建）
全部 404。客户端 8 个头像渲染位（消息流、标题栏、侧栏、角色卡网格、群组成员
chip、MemberPicker、persona 列表）中只有 2 处有 onError 隐藏兜底，其余直接显示
碎图图标；隐藏兜底则留下空位。无头像卡在 UI 上呈现为破损或缺失。

## Decision

- 服务端生成默认替代头像：`sendAvatarFallback(res, name)` 按名字生成首字母
  色块 SVG（128×128 viewBox，1:1）。色相由名字 FNV-1a 哈希决定（同名稳定），
  饱和度/明度固定在双主题都可读的中间值（SVG 在 `<img>` 内读不到宿主 CSS
  变量，不做主题跟随）；首字母取名字首个码点（CJK 原字符，ASCII 大写），
  XML 转义后内嵌。
- 接入点：`serveCharacterAvatar` 的 json 分支与 charx 无内嵌图分支；群组
  成员回落循环落空后按群组名生成；persona 存在但无 PNG 时按 persona 名生成
  （`getPersona` 存在性判定）。
- 404 语义收窄为「实体不存在」（角色/群组/persona 都查不到）：真正的错误仍
  404，客户端消息头像与 persona 列表的 onError 隐藏兜底继续覆盖删卡成员等
  陈旧引用场景。
- 客户端零改动：全部头像位是正方形 + `object-fit:cover` + 固定 CSS 尺寸，
  一张自带 viewBox 的 SVG 覆盖所有渲染面；缓存策略与真实头像一致
  （`private, max-age=300`）。

## Alternatives considered

- 客户端每处 `<img>` 加 onError 换 data-URI：8 个渲染位各自兜底，逻辑重复、
  与服务端生成器双实现易漂移，否决。
- 抽客户端共享 Avatar 组件统一渲染：仍需双端生成同一视觉，重构面大于收益，否决。
- 服务端生成 PNG 占位图：需要图像编码依赖，SVG 零依赖即可表达色块+文字，否决。
- 对任意名字（含不存在的实体）都返回替代头像：实体缺失被静默美化，掩盖删卡
  后的陈旧引用，否决。

## Consequences

- 无头像资产在全部 8 个渲染位显示首字母色块，不再出现碎图或空位。
- 同名头像颜色稳定，不同名大概率不同色；换头像后同 URL 最多 5 分钟缓存延迟
  （与现有头像变更行为一致）。
- `avatar-fallback.spec.ts` 钉住契约：json 卡/CJK 首字母/群组两段回落/persona
  存在性/404 语义。charx 无内嵌图分支与 json 分支共用同一助手，由实现路径
  覆盖（测试不单独构造 zip 容器）。
