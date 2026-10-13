# 0017 · 记忆检索本地 ONNX embed（provider='local'）

状态：已实施（v1）。前置：提案 0016（混合记忆检索）。用户需求（2026-10-12）：
「让 embed 支持本地 embed 运行 onnx 模型」——进程内本地嵌入，不依赖外部
API 端点。执行后端经两轮用户决策收敛为 **onnxruntime-node（native）单后端**
（onnxruntime-web 评估留档 §否决项），dtype 默认链定为 **FP16 优先**
（fp16 → q8 → fp32），推荐模型经 ModelScope 镜像分发。

## 开工前八项表（CONTEXT.md 纪律）

| 项 | 答案 |
|---|---|
| 所有者 | 本地运行时 `packages/plugin/src/memory-embed-local.ts`（解析/指纹/会话缓存/pipeline 装载）；provider 分发在 `packages/plugin/src/memory-embed.ts`（embedTexts 单点）；配置 schema `packages/tavern-store/src/store.ts` |
| 唯一事实来源 | 配置 = `TavernState.memoryEmbedding`（state.json，判别联合：`provider:'local'` 分支）；模型 = 用户自备的本地目录（modelDir，绝对路径）；运行状态仍走 `<tavern>/memory-vectors/status.json` sidecar |
| 持久态 | `{provider:'local', modelDir, pooling?, dims?, batchSize?}`（modelDir 存 PUT 时刻的绝对路径）；向量 sidecar 不变，model 字段落 `local-onnx:<basename>@<指纹>` |
| 临时态 | 模型会话缓存（每 bundle ≤2 条，key=modelDir+指纹+pooling）、查询 memo（沿用 32 条，key 含指纹）——进程内即失，可接受 |
| 外部依赖 | `@huggingface/transformers`（tokenizer + feature-extraction pipeline；其依赖自带 onnxruntime-node native 绑定）。**零打包**：运行时从「本 bundle 真实位置 → 宿主安装锚」链动态解析 import，插件 bundle 不携带、不静态 import；未安装时报错含安装指引（pnpm add 于 DSH profile 根目录） |
| 注册入口 | 挂接面全部复用 0016：HTTP `GET/PUT memory/embed`（PUT 增 local 分支 + 目录实存校验 + pooling fail-fast）、`POST memory/embed/test`（探针经分发自动覆盖本地形态，首次探针含模型加载耗时）；面板第 15 分区「记忆检索」增 provider 切换；memory_search/write/update 工具签名零改动 |
| 删除路径 | 置 `provider:'local', modelDir:''`（PUT）或三件套全空即清除；代码删除面 = memory-embed-local.ts + memory-embed.ts 分发段 + store.ts 判别联合回退（normalize 拒绝 provider 字段即整体回落）+ 路由/面板/gates marker；数据文件：向量 sidecar 的 `local-onnx:` 条目（不清也不炸——身份不匹配即 stale，懒回填按新配置收敛） |
| 兼容对象 | 0016 红线原样：无配置/熔断/全 stale ⇒ `memory_search` 逐字节纯词法（本地失败走同一熔断）；既有远程配置（无 provider 字段）行为逐字节不变（normalize 缺省分支不动）；status sidecar/探针语义不变 |

## 0. 动机与第一性约束

0016 的混合检索要求一个 OpenAI 兼容 `/embeddings` 端点。不想开 API/不想跑
本地推理服务（Ollama/llama.cpp server 本就可用 baseURL 指向）的用户没有
第三条路。本提案补进程内形态：**transformers.js + onnxruntime-node 原生执行
本地 ONNX 权重**，嵌入零网络、零外部进程。

硬约束（决定全部设计形状）：

1. **插件是零依赖 esbuild bundle**（`files` 只发 .mjs；memory-embed.ts 的
   「零新增依赖」是 0016 的明文纪律）。native 绑定不可能进 bundle ⇒ 一切
   运行时依赖必须**运行时解析**，缺席时优雅降级。
2. **跨 bundle**：index.mjs / agent.mjs 各内联一份本模块 ⇒ 会话缓存与查询
   memo 按 bundle 生效（同进程最坏双份模型内存）；可共享状态仍走文件 sidecar。
3. **离线纪律**：`env.allowRemoteModels=false`——tokenizer/权重只从本地目录
   加载，插件永不替用户下载模型（网络面保持「用户自配之外零网络」）。

## 1. 配置面（判别联合）

```ts
type MemoryEmbeddingSettings =
  | MemoryEmbeddingEndpointSettings   // 0016 原状；provider?: 'openai' 缺省
  | MemoryEmbeddingLocalSettings      // 本提案
interface MemoryEmbeddingLocalSettings {
  provider: 'local'
  modelDir: string        // 绝对路径（PUT 时 resolve 钉死）；HF onnx 布局
  pooling?: 'cls' | 'mean' // 缺省 cls（BERT/bge）；MiniLM 类需显式 mean
  dims?: number           // 1..8192
  batchSize?: number      // 1..64，分批顺序嵌入
}
```

- `normalizeMemoryEmbedding` 按 `provider` 判别：`'local'` 走本地形状校验
  （modelDir 非空/无 NUL/≤1024；不做磁盘校验——state 读取保持纯函数）；缺省/
  `'openai'` 走 0016 原状分支（**逐字节不动**）；未知 provider ⇒ undefined
  （手改 state.json 安全回落纯词法）。
- PUT local 分支：modelDir 相对路径 `resolve()` 成绝对路径存储（嵌入发生在
  未来任意 CWD 下）；目录实存校验 fail-fast 400（必须是目录 + 含
  tokenizer.json + 至少一个 .onnx）；pooling 非法值 400（normalize 会静默
  丢弃，fail-fast 防用户误以为已生效）；空 modelDir = 清除配置。
- GET 状态面增 `provider` 与（local 时）`runtimeInstalled`（仅 resolve 不
  加载）；keyless/envResolvable 对 local 恒真。

### 自动填充（2026-10-12 补，小白项零填写）

PUT local 分支对缺省的 pooling/dims 按模型目录推断后落库（显式值永远优先），
响应 `inferred` 回报每项来源，面板保存后提示「已按模型目录自动填充：…」——
小白路径收敛为「选本地 → 填目录 → 保存 → 测试」四步，pooling/dims/batchSize
全部可留空：

- **dims** ← `config.json` 的 `hidden_size`（BERT/bge/e5/gte/MiniLM 家族输出
  维度即 hidden size；读不到不填，首次探针成功仍会记录 dims 基准，功能不依赖
  推断）。
- **pooling** 优先级：① sentence-transformers 官方导出 `modules.json` 的
  Pooling 旗标（权威）② `config.json` 的 `pooling` 字段（少见约定）③ 模型族
  启发（目录名 + `_name_or_path`：bge/bert → cls；minilm/mpnet/e5/gte/gtr/
  sentence-t5 → mean）④ 兜底 cls。启发只影响默认值，面板仍可显式覆盖。
- batchSize 不推断（默认 16 已足够；面板标注可选）。

## 2. 运行时（memory-embed-local.ts）

**解析链**：`@huggingface/transformers` 不入 bundle 图。候选锚 =
①本 bundle 真实位置（`import.meta.url`；profile 物理安装下位于
`<profile>/node_modules/dsh-tavern/*.mjs`，parent 解析可达用户装在 profile 根
的包）→ ②宿主锚（`process.argv[1]` + realpath；覆盖 link: 挂载下宿主自带包）
→ ③`importHostPackage` 兜底（bind/src/host-package.ts 既有纪律）。命中即按
`pathToFileURL` 动态 import（与宿主同实例）。

**装载**：`pipeline('feature-extraction', modelDir, {dtype})` 按优先链
**fp16 → q8 → fp32** 逐档尝试（2026-10-12 用户决策：默认 FP16；对应 Xenova
布局的 onnx/model_fp16.onnx / model_quantized.onnx / model.onnx，目录缺哪档落
下一档）；调用侧显式 `{pooling, normalize:true}`（不依赖库默认值，pooling 是
配置面的一等公民）。

**会话缓存**：`Map<modelDir|指纹|pooling, Promise<model>>`，在飞去重（并发
触发只装载一次）、失败摘除（不被失败 Promise 卡死）、LRU 上限 2。

**向量空间身份**：`localModelIdentity = local-onnx:<basename>@<指纹>:<池化>`，
指纹 = 模型目录两层文件清单（`相对路径:大小:mtimeMs` 排序拼接）的 SHA-256
前 16 位。身份进向量 entry 的 model 字段与 `memoryContentDigest`——**换权重
文件 ⇒ 指纹变化 ⇒ 旧向量全 stale ⇒ 懒回填收敛**（与换远程 model 同款语义，
无需手动清缓存）。**pooling 必须进身份**（2026-10-12 补：cls/mean 是两个不同
向量空间，不进身份会把旧池化存量向量误判为新鲜、混空间排序——同轮修复查询
memo 的 key 缺池化维度）。只用 stat 不读内容（几十 MB 权重不做全量哈希；
mtime 粒度噪声的代价仅一次多余重嵌）。查询 memo 的 key 含指纹与池化（旧空间
向量不会喂进新空间 cosine）。

**失败语义**：运行时未装/装载失败/推理异常 ⇒ `EmbedHttpError('runtime',
…, retriable:false)`（确定性失败不重试），调用方照常落 lastError + 60s 熔断
⇒ 检索自动纯词法（0016 降级矩阵原样适用）。

## 3. 与 0016 契约的关系

- `embedTexts` 是唯一分发点：`provider==='local'` 走本地批次（分批顺序、
  维度校验与远程同语义），否则远程路径原状。hybrid/写路径/维护路径全部经
  embedTexts/embedMemoryRecord，零改动自动受益（仅 `config.model` →
  `embedModelIdentity(config)` 的身份锚替换与 localRuntime 注入口）。
- 探针 `POST memory/embed/test`：本地形态首次探针含模型装载耗时（如实施为
  特性：它就是「可用性」的真实测量）。

## 4. 安装面（面板一键安装，2026-10-12 用户决策升级）

`POST memory/embed/local/install`：在 **profile 根**（插件物理安装在
`<profile>/node_modules/dsh-tavern` 时取其上两级）执行
`pnpm add @huggingface/transformers`，执行纪律镜像自更新链路 apply.ts 的
runCapture（windowsHide、流式逐行收集、10 分钟超时 kill+unref、win32 下
shell 化仅为本体为常量的 pnpm 调用——参数写死包名、路径走 cwd，无注入面）。

- **单飞守卫**：进程内在飞 Promise，并发触发 409。
- **link:/源码挂载拒绝**：profile 根与插件目录分离时自动装会写错地方，
  返回可操作指引（手动在 profile 根执行）；源码仓库内的 pnpm add 只作为
  link: 冒烟手段，测完必须还原 manifests（仓库纪律：运行时不进插件依赖面）。
- **成功即同进程生效**：运行时按 URL 动态 import、解析在每次装载时进行，
  无需重启 DSH；安装后立即跑探针（POST memory/embed/test）即可验证。安装
  器落盘后复核 `isLocalEmbedRuntimeInstalled()`，仍不可解析时如实报「重启后
  重试探针」而不是假成功。
- **输出尾段回传**：pnpm 输出末 8000 字符随响应回传（诊断回显）；非零退出
  码/ENOENT（附 PATH 提示）/超时各自给可操作 message。
- 桌面 profile 的依赖本就由 pnpm 管理（自更新链路实测），该安装天然被后续
  install 保留；pnpm v11 对 onnxruntime-node 构建脚本的 allowBuilds 拦截在
  无 workspace allowBuilds 表的 profile 下是警告级（scratch 实装实证：预编译
  绑定随包分发，跳过构建脚本不影响运行）。

**2026-10-12 实况（本设计的直接动因）**：v1 曾以「不做自动安装路由」否决
此功能（见否决项表——该行已被本节推翻）；同日用户按面板提示在**源码仓库根**
手动执行 pnpm add——依赖进 package.json/lockfile、onnxruntime-node 触发
pnpm v11 allowBuilds 改写 pnpm-workspace.yaml、check 的 verify-deps 安装被
build-script 策略拦死。修复=还原 manifests 后 `pnpm install` 剔除 node_modules
残留；并按用户决策升级为面板一键安装（profile 根定位 + link: 拒绝把「写错
目录」的失败模式从根上关掉），提示文案同步追加「不是本插件的源码仓库」。

## 5. 边界（如实标注）

- **推荐模型**：中文 RP 场景 `Xenova/bge-small-zh-v1.5`（cls 池化；fp16 约
  47MB，ModelScope 镜像 https://www.modelscope.cn/models/Xenova/bge-small-zh-v1.5
  可直下，只需 tokenizer/config 四件 + onnx/model_fp16.onnx）；MiniLM 家族需
  显式 pooling='mean'。
- **onnxruntime-node native 加载于 DSH 宿主进程内**：ABI 由 Node 本身保证
  （N-API），但 native 崩溃即宿主崩溃——接受该风险（onnxruntime-node 为
  成熟绑定），留档于此。
- **链接安装（`link:`）下**：解析链走宿主锚兜底，用户需将运行时装在宿主可
  解析处（全局安装或宿主 node_modules）；文档如实说明。
- **dtype 链不可配置**：fp16 → q8 → fp32 固定优先链（v1 零旋钮；要钉死某档
  就只放那一档权重文件）。fp16 于 onnxruntime-node CPU EP 实测可跑（见 §7）。
- **指纹不防同内容同 mtime 的极端替换**：stat 级指纹的理论盲区，代价一次
  错误向量混排，重新 touch 模型文件即收敛。

## 6. 否决项留档

| 方案 | 否决理由 |
|---|---|
| **onnxruntime-web（WASM 后端）** | transformers.js 在 Node 环境**硬绑 onnxruntime-node**（onnx.js 源码：`IS_NODE_ENV ⇒ ONNX = ONNX_NODE`，supportedDevices 不含 wasm，`device:'wasm'` 直接 throw——2026-10-12 源码查证）。走 WASM 需绕开其 pipeline 层自维护 tokenizer→ORT 胶水与 ort-web 在 Node 的 wasm 加载细节，复杂度不划算。用户决策（2026-10-12）：「不要 onnxruntime web 了用 onnxruntime-node」 |
| 运行时打包进 bundle | esbuild 无法打包 native .node；且破坏「插件零依赖」纪律（0016 明文） |
| 插件 package.json 声明依赖 | 安装路径三种形态（git/tarball/link:）行为不一，且全体用户被动承担 ~200MB native 安装；按需安装 + 运行时检测更符合「功能默认关闭」 |
| ~~自动安装路由（spawn pnpm）~~（2026-10-12 用户决策推翻，已实施见 §4） | 原否决理由：shell 执行面 + link: 定位歧义；推翻时的护栏：profile 根从 node_modules 安装形态推导（link: 拒绝并给指引）、参数全为常量、单飞守卫、装后复核可解析性 |
| 自实现 WordPiece tokenizer 消灭 transformers.js 依赖 | tokenizer.json 格式覆盖 normalizer/pre-tokenizer/BPE/Unigram 全家族，自实现等于复刻 tokenizers 库；否决 |
| 模型目录内容寻址（全量 SHA-256） | 几十 MB 权重每次装载前全量哈希；stat 指纹（size+mtime）以一次多余重嵌的代价换掉它，值得 |

## 7. 测试与验收

- `memory-embed-local.spec.ts`（新增）：指纹稳定/替换失效/mtime 计入、身份
  格式、PUT 目录校验四路、会话缓存三态（在飞去重/失败摘除/指纹换 key）、
  embedTexts 本地分发（分批/dims/计数/非有限数值/失败映射）、memo 键隔离、
  运行时未安装报错含指引（skipIf 已安装）。
- `memory-hybrid.spec.ts`（新增 describe）：本地身份锚落库与融合命中、换权重
  ⇒ 指纹变化 ⇒ stale ⇒ 懒回填收敛到新身份、本地失败 ⇒ 熔断开窗回落纯词法。
- `store.spec.ts`（新增 describe）：判别联合 normalize 契约（legacy 原状/
  local 合法非法/未知 provider/字段互不渗透）。
- gates：server-bundle 增 `local-onnx:` / `@huggingface/transformers` /
  `runtimeInstalled` / `inferLocalModelSettings` / 安装路由 marker + 负样本；
  frontend-runtime 增 provider 切换/自动填充/一键安装 marker + 负样本。
- 一键安装（假 spawn 注入）：profile 根识别（node_modules 形态/link:）、
  link: 拒绝、pnpm 常量参数与 cwd、非零退出码与输出截尾、ENOENT 的 PATH
  提示、装后不可解析的如实失败（整组 skipIf 仓库已装运行时）。
- 真模型冒烟（2026-10-12 实跑，win32-x64 / Node 22 / transformers 4.3.1 /
  onnxruntime-node 1.30.0，模型取 ModelScope 镜像 fp16 权重）：直连 pipeline
  ——fp16 装载 274ms、3 条 14ms、dims 512、语义对 cos 0.6602 vs 无关对
  0.3549、L2 归一 ✔；**生产拓扑端到端**——真实 embedTexts 链路经 esbuild
  打进 scratch（模拟 `<profile>/node_modules/dsh-tavern/index.mjs` 位置），
  解析链命中 scratch node_modules，normalize→identity→embedTexts 全通，
  cosine 与直连参考逐位一致（0.3549）；pnpm 10 默认拦截 onnxruntime-node
  build script 不影响运行（预编译绑定随包分发）。自动填充同日对真实目录
  实证：`inferLocalModelSettings` → dims 512（config.json hidden_size）+
  pooling cls（模型族启发），来源标注正确；identity 带 `:cls`/`:mean` 后缀。

## 8. 2026-10-13 补记：量化精度可选（目录智能识别 + 面板下拉）

需求（2026-10-13 用户，含中途澄清「提供给用户一个下拉框选择精度」）：本地
模型的量化精度从固定优先链升级为**可配置**——面板提供精度下拉框，选项按模型
目录**智能识别**（只列目录里实际可加载的档位）。

**dtype→文件名映射的权威源**：用户实装的 transformers 4.3.1
`src/utils/dtypes.js` `DEFAULT_DTYPE_SUFFIX_MAPPING`——fp32 无后缀、fp16
`_fp16`、q8 `_quantized`（注意不是 `_q8`）、int8/uint8 `_int8`/`_uint8`、
q4/q4f16 `_q4`/`_q4f16`、q2/q1 系同理；bnb4 排除（bitsandbytes JIT 量化不是
文件加载路径）。文件名 = `model${后缀}.onnx`，且 `from_pretrained` 恒从
`onnx/` 子目录读（modeling_utils.js `subfolder='onnx'`，无顶层回退）。

落法：

- **目录识别（detectLocalQuantizations）**：扫描 `<modelDir>/onnx/` 下的
  `model${后缀}.onnx`，返回档位+文件+大小，按 auto 优先链排序。只认 onnx/
  子目录——运行时从不读顶层散装 .onnx（源码级核对）。
- **解析（resolveLocalDtype）**：显式精度原样返回（钉档不猜，文件缺失留给
  加载期如实报错、不静默降档）；'auto'/缺省取识别结果的最高档；目录检不出
  档位返回 undefined，运行时保留 v1 的 fp16→q8→fp32 try 链兜底（覆盖扫描面
  之外的非标准布局）。auto 优先链定为 fp16 > q8 > q4 > q4f16 > int8 >
  uint8 > q2/q2f16/q1/q1f16 > fp32（2026-10-12「默认 FP16」决策的延伸）。
- **配置面**：`MemoryEmbeddingLocalSettings.precision?: LocalEmbedPrecision`
  （'auto' + 11 个具体档）；normalize 静默丢弃废值（手改 state.json 容错，
  与 pooling 同款）；PUT 对非法值 fail-fast 400（与 pooling 同款）。
- **检测端点**：`POST memory/embed/local/quantizations {modelDir}`（只读）→
  `{quantizations: [{precision, file, sizeBytes}], recommended}`；目录非法按
  PUT 同款文案 400。
- **面板**：①检索模式改**三态下拉**（关闭/远程端点/本地 ONNX）——「关闭」
  吸收原「清除配置」按钮的语义（保存即清除，检索回落纯词法）；②本地形态新增
  **量化精度下拉**——modelDir 输入防抖 500ms 调检测端点，「自动 · 识别为
  FP16」带出推荐档，其余选项按检出档位 + 文件大小展示；目录未检出当前选中档
  时保留该选项并标注「目录中未检出」（防 select 值悬空）。i18n zh/en 镜像。
- **身份扩展（必要，非顺带）**：`local-onnx:<basename>@<指纹>:<池化>:<精度>`
  ——不同量化档是不同向量空间（权重数值不同、嵌入随之偏移），与池化进身份
  同理；auto 段落的是**解析后的具体档**（与实际加载一致），检不出时为
  'auto'。查询 memo 键同步改用身份（单一事实来源）。**升级影响**：身份格式
  变化 ⇒ 存量本地向量一次性转 stale ⇒ 懒回填（v1 发布次日，影响面即作者
  本机，可接受；语义与换模型文件相同）。
- **validateLocalModelDir 收紧（修 latent bug）**：v1 放行「顶层散装 .onnx」
  但 transformers.js 只从 onnx/ 读权重——该布局通过 PUT 校验后必然在加载期
  炸出难懂报错。现直接拒绝并给出「把权重挪进 onnx/ 子目录」指引，测试同步
  翻转（放行→拒绝）。

测试：`memory-embed-local.spec` 新增 detectLocalQuantizations 三路（Xenova
三件套映射与排序/exotic 后缀/无关文件与缺目录）、resolveLocalDtype 三路
（auto 优先链/显式钉档/检不出 undefined）、会话缓存精度换 key + dtype 透传、
memo 精度隔离；身份格式断言更新为四段式；validate 顶层布局断言翻转。
`store.spec` 新增 precision normalize（12 合法值逐个/bnb4·int4·数值丢弃）。
gates：server-bundle 增 detectLocalQuantizations/检测路由/resolveLocalDtype
marker + 负样本；frontend-runtime 增模式下拉 off 键/精度键/检测端点调用
marker + 负样本。基线 89 文件 1267 过 +1 跳 → 89 文件 1276 过 +1 跳（净增 9）。
