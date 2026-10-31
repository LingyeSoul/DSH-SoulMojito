/**
 * QQ 运行时一键安装（提案 0024 §5）。
 *
 * 与本地 ONNX 运行时同款纪律：插件自己在数据目录 `im/runtime` 里跑 pnpm，
 * 用户不开终端。全程注入假 spawn，不联网、不要求本机 pnpm，也不碰真实运行期
 * 目录（`DSH_HOME` 指向临时目录）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installQqRuntime, QQ_RUNTIME_INSTALL_TIMEOUT_MS } from '../src/im/qq/install.js'
import { qqRuntimeRoot, qqRuntimeStatus } from '../src/im/qq/sdk.js'

const SDK_SPEC = '@tencent-connect/qqbot-nodejs@1.0.5'
const CONNECTOR_SPEC = '@tencent-connect/qqbot-connector@1.2.0'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'qq-install-'))
  process.env.DSH_HOME = root
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 写入两个包的入口文件：等价于 pnpm 装完后的磁盘状态。 */
async function writeRuntimeEntryFiles(): Promise<void> {
  const runtime = qqRuntimeRoot()
  await mkdir(join(runtime, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist'), { recursive: true })
  await writeFile(join(runtime, 'node_modules', '@tencent-connect', 'qqbot-nodejs', 'dist', 'index.js'), '')
  await mkdir(join(runtime, 'node_modules', '@tencent-connect', 'qqbot-connector', 'dist', 'esm'), { recursive: true })
  await writeFile(join(runtime, 'node_modules', '@tencent-connect', 'qqbot-connector', 'dist', 'esm', 'index.js'), '')
}

describe('installQqRuntime', () => {
  it('returns the fast path without spawning when both packages are already on disk', async () => {
    await writeRuntimeEntryFiles()
    const outcome = await installQqRuntime({
      spawnRunner: async () => { throw new Error('must not spawn when the runtime is installed') },
    })
    expect(outcome).toEqual({ ok: true, alreadyInstalled: true, outputTail: '' })
  })

  it('creates the runtime package.json and shells out with the pinned package specs', async () => {
    const runs: Array<{ command: string; args: readonly string[]; options: { cwd: string; timeoutMs: number } }> = []
    const outcome = await installQqRuntime({
      spawnRunner: async (command, args, options) => {
        runs.push({ command, args, options })
        // 假 pnpm：真正把入口文件写出来，安装后的状态检查才应通过。
        await writeRuntimeEntryFiles()
        return { code: 0, output: 'progress: 100%' }
      },
    })

    expect(outcome).toEqual({ ok: true, alreadyInstalled: false, outputTail: 'progress: 100%' })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.command).toBe('pnpm')
    expect(runs[0]!.args).toEqual(['add', SDK_SPEC, CONNECTOR_SPEC])
    expect(runs[0]!.options.cwd).toBe(qqRuntimeRoot())
    expect(runs[0]!.options.timeoutMs).toBe(QQ_RUNTIME_INSTALL_TIMEOUT_MS)
    expect(QQ_RUNTIME_INSTALL_TIMEOUT_MS).toBe(10 * 60 * 1000)

    const manifest = JSON.parse(await readFile(join(qqRuntimeRoot(), 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest).toEqual({ name: 'dsh-soulmojito-im-runtime', private: true })
  })

  it('never overwrites a package.json the user already has in the runtime directory', async () => {
    const runtime = qqRuntimeRoot()
    await mkdir(runtime, { recursive: true })
    const manifestPath = join(runtime, 'package.json')
    await writeFile(manifestPath, '{"name":"mine","private":true}\n', 'utf8')

    const outcome = await installQqRuntime({
      spawnRunner: async () => ({ code: 0, output: '' }),
    })
    expect(outcome.ok).toBe(false)
    expect(await readFile(manifestPath, 'utf8')).toBe('{"name":"mine","private":true}\n')
  })

  it('reports the exit code and the output tail when pnpm fails', async () => {
    const outcome = await installQqRuntime({
      spawnRunner: async () => ({ code: 1, output: `x${'y'.repeat(9000)}` }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.alreadyInstalled).toBe(false)
    expect(outcome.message).toBe('pnpm exited with 1')
    // 尾段回传上限 8000：面板只展示最后几屏，不整段塞进去。
    expect(outcome.outputTail).toHaveLength(8000)
    expect(outcome.outputTail.endsWith('y')).toBe(true)
  })

  it('refuses to claim success when pnpm exits zero but the entry files are still missing', async () => {
    const outcome = await installQqRuntime({
      spawnRunner: async () => ({ code: 0, output: 'done' }),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('restart DSH')
    expect(outcome.outputTail).toBe('done')
  })

  it('mentions pnpm on PATH when the spawner cannot find the binary', async () => {
    const outcome = await installQqRuntime({
      spawnRunner: async () => { throw new Error('spawn pnpm ENOENT') },
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('spawn pnpm ENOENT')
    expect(outcome.message).toContain('is pnpm on PATH?')
  })
})

describe('qq runtime status wording', () => {
  it('points at the IM panel install button instead of a shell command', async () => {
    const status = await qqRuntimeStatus()
    expect(status.installed).toBe(false)
    expect(status.reason).toBeDefined()
    const reason = status.reason ?? ''
    expect(reason).toContain('安装 QQ 依赖')
    expect(reason).toContain('IM panel')
    // 用户永远不该被要求开终端：提示里不能出现可复制的安装命令行。
    expect(reason).not.toContain('pnpm add')
    expect(reason).not.toContain('cd ')
  })
})
