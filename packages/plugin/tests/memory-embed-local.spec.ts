/**
 * 本地 ONNX embed（提案 0017）——零网络、零真模型测试面。
 *
 * 覆盖：目录指纹（稳定/文件替换失效/不可读目录）、身份格式、PUT 前置目录
 * 校验、会话缓存（在飞去重/失败摘除/指纹换 key）、embedTexts 本地分发
 * （分批/dims 校验/计数校验/失败映射 EmbedHttpError('runtime')）、查询 memo
 * 的 provider 键隔离、运行时未安装的可操作报错（skipIf：装了就真跑不了）。
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeMemoryEmbedding } from '../../tavern-store/src/index.js'
import {
  EmbedHttpError,
  embedTexts,
  memoizedQueryVector,
  storeMemoizedQueryVector,
} from '../src/memory-embed.js'
import {
  TRANSFORMERS_INSTALL_HINT,
  inferLocalModelSettings,
  installLocalEmbedRuntime,
  isLocalEmbedRuntimeInstalled,
  localRuntimeProfileRoot,
  loadLocalEmbedModel,
  localModelFingerprint,
  localModelIdentity,
  resetLocalEmbedSessionCache,
  validateLocalModelDir,
  type LocalEmbedRuntime,
} from '../src/memory-embed-local.js'

let dir: string
let dirCounter = 0

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-embed-local-'))
  dirCounter = 0
  resetLocalEmbedSessionCache()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  resetLocalEmbedSessionCache()
})

/** 每次调用建全新子目录（同测试内多次调用互不累积——会话缓存与文件校验都
 *  以目录为身份，共享目录会让断言互相污染）。 */
function makeModelDir(files: Record<string, string> = { 'tokenizer.json': '{}', 'onnx/model_quantized.onnx': 'weights' }): string {
  dirCounter += 1
  const modelDir = join(dir, dirCounter === 1 ? 'bge-small-zh-v1.5' : `bge-small-zh-v1.5-${dirCounter}`)
  for (const [name, content] of Object.entries(files)) {
    const full = join(modelDir, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return modelDir
}

describe('localModelFingerprint / localModelIdentity', () => {
  it('同一目录内容稳定，子目录文件计入指纹', () => {
    const modelDir = makeModelDir()
    const first = localModelFingerprint(modelDir)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(localModelFingerprint(modelDir)).toBe(first)
  })

  it('替换 onnx 权重（大小或 mtime 变化）⇒ 指纹变化（向量自动转 stale 的收敛锚）', () => {
    const modelDir = makeModelDir()
    const first = localModelFingerprint(modelDir)
    writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), 'weights-replaced-longer')
    expect(localModelFingerprint(modelDir)).not.toBe(first)
  })

  it('同大小仅 mtime 变化也计入指纹', () => {
    const modelDir = makeModelDir()
    const first = localModelFingerprint(modelDir)
    const weights = join(modelDir, 'onnx', 'model_quantized.onnx')
    utimesSync(weights, new Date(1_000_000), new Date(1_000_000))
    expect(localModelFingerprint(modelDir)).not.toBe(first)
  })

  it('目录不可读/不存在 ⇒ unreadable（身份恒变 ⇒ 恒 stale ⇒ 熔断降级）', () => {
    expect(localModelFingerprint(join(dir, 'missing'))).toBe('unreadable')
  })

  it('身份格式 local-onnx:<basename>@<指纹>:<池化>，pooling 进身份（换池化=换空间）', () => {
    const modelDir = makeModelDir()
    expect(localModelIdentity({ modelDir })).toMatch(/^local-onnx:bge-small-zh-v1\.5@[0-9a-f]{16}:cls$/)
    expect(localModelIdentity({ modelDir, pooling: 'mean' })).toMatch(/:mean$/)
    expect(localModelIdentity({ modelDir, pooling: 'mean' })).not.toBe(localModelIdentity({ modelDir }))
  })
})

describe('validateLocalModelDir（PUT fail-fast 校验）', () => {
  it('合法 HF onnx 布局通过', () => {
    expect(validateLocalModelDir(makeModelDir())).toBeNull()
  })

  it('顶层散装 .onnx 也通过', () => {
    expect(validateLocalModelDir(makeModelDir({ 'tokenizer.json': '{}', 'model.onnx': 'w' }))).toBeNull()
  })

  it('缺 tokenizer.json / 缺 onnx 权重 / 不存在 / 非目录 各自给可操作报错', () => {
    expect(validateLocalModelDir(join(dir, 'nope'))).toContain('does not exist')
    expect(validateLocalModelDir(makeModelDir({ 'onnx/model.onnx': 'w' }))).toContain('tokenizer.json')
    expect(validateLocalModelDir(makeModelDir({ 'tokenizer.json': '{}' }))).toContain('.onnx')
    const filePath = join(dir, 'plain-file')
    writeFileSync(filePath, 'x')
    expect(validateLocalModelDir(filePath)).toContain('not a directory')
  })
})

describe('会话缓存（loadLocalEmbedModel）', () => {
  it('并发请求共享同一次 load（在飞去重）', async () => {
    const modelDir = makeModelDir()
    let loads = 0
    const runtime: LocalEmbedRuntime = {
      load: async () => {
        loads += 1
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { embed: async (texts) => texts.map(() => [1]) }
      },
    }
    const [a, b] = await Promise.all([
      loadLocalEmbedModel({ modelDir }, runtime),
      loadLocalEmbedModel({ modelDir }, runtime),
    ])
    expect(loads).toBe(1)
    expect(a).toBe(b)
  })

  it('加载失败从缓存摘除（下次重试不被失败 Promise 卡死）', async () => {
    const modelDir = makeModelDir()
    let attempts = 0
    const runtime: LocalEmbedRuntime = {
      load: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('first load fails')
        return { embed: async (texts) => texts.map(() => [1]) }
      },
    }
    await expect(loadLocalEmbedModel({ modelDir }, runtime)).rejects.toThrow('first load fails')
    await expect(loadLocalEmbedModel({ modelDir }, runtime)).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })

  it('指纹变化 ⇒ 新 key ⇒ 重新加载', async () => {
    const modelDir = makeModelDir()
    let loads = 0
    const runtime: LocalEmbedRuntime = {
      load: async () => {
        loads += 1
        return { embed: async (texts) => texts.map(() => [1]) }
      },
    }
    await loadLocalEmbedModel({ modelDir }, runtime)
    writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), 'swapped-weights')
    await loadLocalEmbedModel({ modelDir }, runtime)
    expect(loads).toBe(2)
  })
})

describe('embedTexts 本地分发', () => {
  const localConfig = (modelDir: string, overrides: Record<string, unknown> = {}) =>
    normalizeMemoryEmbedding({ provider: 'local', modelDir, dims: 4, batchSize: 3, ...overrides })!

  it('按 batchSize 分批顺序嵌入 + 批量合并返回', async () => {
    const modelDir = makeModelDir()
    const batches: number[] = []
    const runtime: LocalEmbedRuntime = {
      load: async () => ({
        embed: async (texts) => {
          batches.push(texts.length)
          return texts.map(() => [0.5, 0.5, 0.5, 0.5])
        },
      }),
    }
    const vectors = await embedTexts(localConfig(modelDir), ['a', 'b', 'c', 'd', 'e'], { localRuntime: runtime })
    expect(vectors).toHaveLength(5)
    expect(batches).toEqual([3, 2])
  })

  it('期望维度不一致 ⇒ EmbedHttpError dims（与远程同语义，防混向量空间）', async () => {
    const modelDir = makeModelDir()
    const runtime: LocalEmbedRuntime = {
      load: async () => ({ embed: async (texts) => texts.map(() => [1, 2, 3]) }),
    }
    await expect(
      embedTexts(localConfig(modelDir), ['x'], { expectedDims: 4, localRuntime: runtime }),
    ).rejects.toMatchObject({ kind: 'dims' })
  })

  it('批内维度不一致 / 计数不匹配 / 非有限数值 各自报错', async () => {
    const dimsRuntime: LocalEmbedRuntime = {
      load: async () => ({ embed: async () => [[1, 2], [1, 2, 3]] }),
    }
    // 三个子断言各自用全新 modelDir：会话缓存以 目录|指纹 为 key，共用目录会让
    // 后续断言命中前一个 runtime 的缓存会话。
    await expect(embedTexts(localConfig(makeModelDir()), ['a', 'b'], { localRuntime: dimsRuntime }))
      .rejects.toMatchObject({ kind: 'dims' })

    const countRuntime: LocalEmbedRuntime = {
      load: async () => ({ embed: async () => [[1, 2, 3, 4]] }),
    }
    await expect(embedTexts(localConfig(makeModelDir()), ['a', 'b'], { localRuntime: countRuntime }))
      .rejects.toMatchObject({ kind: 'payload' })

    const nanRuntime: LocalEmbedRuntime = {
      load: async () => ({ embed: async (texts) => texts.map(() => [Number.NaN, 1, 2, 3]) }),
    }
    await expect(embedTexts(localConfig(makeModelDir()), ['a'], { localRuntime: nanRuntime }))
      .rejects.toMatchObject({ kind: 'payload' })
  })

  it('加载/推理失败 ⇒ EmbedHttpError runtime 且不重试（确定性失败）', async () => {
    const modelDir = makeModelDir()
    const loadFail: LocalEmbedRuntime = { load: async () => { throw new Error('no runtime') } }
    const error = await embedTexts(localConfig(modelDir), ['a'], { localRuntime: loadFail }).catch((cause) => cause)
    expect(error).toBeInstanceOf(EmbedHttpError)
    expect(error).toMatchObject({ kind: 'runtime', retriable: false, message: 'no runtime' })

    const embedFail: LocalEmbedRuntime = {
      load: async () => ({ embed: async () => { throw new Error('inference blew up') } }),
    }
    const error2 = await embedTexts(localConfig(modelDir), ['a'], { localRuntime: embedFail }).catch((cause) => cause)
    expect(error2).toMatchObject({ kind: 'runtime', retriable: false, message: 'inference blew up' })
  })

  it('运行时未安装 ⇒ 报错含安装指引（本仓库未装运行时时才跑）', { skipIf: isLocalEmbedRuntimeInstalled() }, async () => {
    const modelDir = makeModelDir()
    const error = await embedTexts(localConfig(modelDir), ['a']).catch((cause) => cause)
    expect(error).toBeInstanceOf(EmbedHttpError)
    expect(error).toMatchObject({ kind: 'runtime' })
    expect((error as EmbedHttpError).message).toContain(TRANSFORMERS_INSTALL_HINT)
  })
})

describe('查询 memo 的 provider 键隔离', () => {
  it('同 query 下本地与远程配置互不串 memo', () => {
    const modelDir = makeModelDir()
    const local = normalizeMemoryEmbedding({ provider: 'local', modelDir })!
    const endpoint = normalizeMemoryEmbedding({ baseURL: 'http://embed.test/v1', apiKeyEnv: '', model: 'm' })!
    storeMemoizedQueryVector(local, 'q', [1, 1])
    expect(memoizedQueryVector(local, 'q')).toEqual([1, 1])
    expect(memoizedQueryVector(endpoint, 'q')).toBeUndefined()
  })

  it('本地指纹变化后旧 memo 失效（不把旧空间向量喂进新空间 cosine）', () => {
    const modelDir = makeModelDir()
    const local = normalizeMemoryEmbedding({ provider: 'local', modelDir })!
    storeMemoizedQueryVector(local, 'q', [1, 1])
    // 不等长内容：等长替换在同一毫秒内写入时 mtime 可能不变，指纹会假阴性。
    writeFileSync(join(modelDir, 'onnx', 'model_quantized.onnx'), 'swapped-weights-v2')
    expect(memoizedQueryVector(local, 'q')).toBeUndefined()
  })

  it('换池化后旧 memo 失效（cls/mean 是两个向量空间）', () => {
    const modelDir = makeModelDir()
    const cls = normalizeMemoryEmbedding({ provider: 'local', modelDir, pooling: 'cls' })!
    const mean = normalizeMemoryEmbedding({ provider: 'local', modelDir, pooling: 'mean' })!
    storeMemoizedQueryVector(cls, 'q', [1, 1])
    expect(memoizedQueryVector(cls, 'q')).toEqual([1, 1])
    expect(memoizedQueryVector(mean, 'q')).toBeUndefined()
  })
})


/* ---------------- 自动推断（提案 0017 §自动填充，小白项零填写） ---------------- */

describe('inferLocalModelSettings', () => {
  it('dims 取 config.json hidden_size', () => {
    const modelDir = makeModelDir({ 'tokenizer.json': '{}', 'onnx/model_fp16.onnx': 'w', 'config.json': '{"hidden_size": 512}' })
    const inferred = inferLocalModelSettings(modelDir)
    expect(inferred.dims).toBe(512)
    expect(inferred.sources.dims).toContain('hidden_size')
  })

  it('modules.json 的 Pooling 旗标权威（mean 优先于模型族启发）', () => {
    const modelDir = makeModelDir({
      'tokenizer.json': '{}', 'onnx/model_fp16.onnx': 'w',
      'config.json': '{"hidden_size": 384, "_name_or_path": "BAAI/bge-small"}',
      'modules.json': '[["sentence-transformers", "Pooling", {"pooling_mode_cls": false, "pooling_mode_mean": true}]]',
    })
    const inferred = inferLocalModelSettings(modelDir)
    expect(inferred.pooling).toBe('mean')
    expect(inferred.sources.pooling).toContain('modules.json')
  })

  it('无 modules.json 时按模型族启发：bge/bert → cls', () => {
    const modelDir = makeModelDir({
      'tokenizer.json': '{}', 'onnx/model_fp16.onnx': 'w',
      'config.json': '{"hidden_size": 512, "_name_or_path": "BAAI/bge-small-zh-v1.5"}',
    })
    expect(inferLocalModelSettings(modelDir).pooling).toBe('cls')
  })

  it('模型族启发：minilm/gte/e5 目录名即信号 → mean', () => {
    for (const name of ['all-MiniLM-L6-v2', 'gte-small', 'e5-base']) {
      const modelDir = join(dir, name)
      mkdirSync(modelDir, { recursive: true })
      writeFileSync(join(modelDir, 'tokenizer.json'), '{}')
      expect(inferLocalModelSettings(modelDir).pooling).toBe('mean')
    }
  })

  it('零信号目录：dims/pooling 都 undefined（运行时兜底 cls + 探针学 dims）', () => {
    // 目录名用中性名：makeModelDir 默认的 bge-* 名字本身就是模型族启发信号。
    const modelDir = join(dir, 'my-embed-model')
    mkdirSync(join(modelDir, 'onnx'), { recursive: true })
    writeFileSync(join(modelDir, 'tokenizer.json'), '{}')
    writeFileSync(join(modelDir, 'onnx', 'model_fp16.onnx'), 'w')
    const inferred = inferLocalModelSettings(modelDir)
    expect(inferred.dims).toBeUndefined()
    expect(inferred.pooling).toBeUndefined()
  })

  it('损坏 JSON 容错（不抛、当缺失处理）', () => {
    const modelDir = join(dir, 'broken-json-model')
    mkdirSync(join(modelDir, 'onnx'), { recursive: true })
    writeFileSync(join(modelDir, 'tokenizer.json'), '{}')
    writeFileSync(join(modelDir, 'onnx', 'model_fp16.onnx'), 'w')
    writeFileSync(join(modelDir, 'config.json'), '{broken')
    writeFileSync(join(modelDir, 'modules.json'), 'not-json')
    const inferred = inferLocalModelSettings(modelDir)
    expect(inferred.dims).toBeUndefined()
    expect(inferred.pooling).toBeUndefined()
  })
})


/* ---------------- 一键安装（提案 0017 §安装面，假 spawn 注入） ---------------- */

// 整组依赖「仓库未装运行时」的实况（装了会走 alreadyInstalled 快速路径）。
describe.skipIf(isLocalEmbedRuntimeInstalled())('installLocalEmbedRuntime（面板一键安装）', () => {
  it('localRuntimeProfileRoot：node_modules 安装形态识别 profile 根；link:/源码挂载返回 undefined', () => {
    expect(localRuntimeProfileRoot('C:/dsh/profiles/web/node_modules/dsh-tavern')).toBe('C:/dsh/profiles/web')
    expect(localRuntimeProfileRoot('E:/WorkProject/dsh-tavern/packages/plugin')).toBeUndefined()
  })

  it('link:/源码挂载拒绝自动安装（防写错目录——2026-10-12 实况用户在源码仓库跑过 pnpm add）', async () => {
    const outcome = await installLocalEmbedRuntime({
      pluginDir: 'E:/repo/packages/plugin',
      spawnRunner: async () => { throw new Error('must not spawn') },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.alreadyInstalled).toBe(false)
    expect(outcome.message).toContain('link:/source')
  })

  it('pnpm 在 profile 根执行、常量参数；非零退出码时报退出码并回传输出尾段（8000 截尾）', async () => {
    const runs: Array<{ command: string; args: readonly string[]; options: { cwd: string; timeoutMs: number } }> = []
    const outcome = await installLocalEmbedRuntime({
      pluginDir: 'C:/dsh/profiles/web/node_modules/dsh-tavern',
      spawnRunner: async (command, args, options) => {
        runs.push({ command, args, options })
        return { code: 1, output: 'x'.repeat(9000) }
      },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('pnpm exited with 1')
    expect(outcome.outputTail).toHaveLength(8000)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.command).toBe('pnpm')
    expect(runs[0]!.args).toEqual(['add', '@huggingface/transformers'])
    expect(runs[0]!.options.cwd).toBe('C:/dsh/profiles/web')
  })

  it('spawn ENOENT：报错附 PATH 提示', async () => {
    const outcome = await installLocalEmbedRuntime({
      pluginDir: 'C:/dsh/profiles/web/node_modules/dsh-tavern',
      spawnRunner: async () => { throw new Error('spawn pnpm ENOENT') },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('PATH')
  })

  it('pnpm 成功但运行时仍不可解析：如实报「重启后重试探针」而不是假成功', async () => {
    const outcome = await installLocalEmbedRuntime({
      pluginDir: 'C:/dsh/profiles/web/node_modules/dsh-tavern',
      spawnRunner: async () => ({ code: 0, output: 'done' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('restart DSH')
  })
})
