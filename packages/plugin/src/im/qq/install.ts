/**
 * QQ 运行时一键安装（提案 0024 §5，2026-10-30）。
 *
 * 两个腾讯包与本地 ONNX 运行时同款纪律（`memory-embed-local.ts` 的
 * `installLocalEmbedRuntime`）：插件自己在数据目录 `im/runtime` 里 `pnpm add`，
 * 用户只在面板上按一次按钮，**永远不用开终端**。
 *
 * 安装目录带自己的 `package.json`（`private: true`），与 DSH profile 和插件源码
 * 仓库都隔离：不污染任何 lockfile，也不会撞上 pnpm 的 workspace 根规则。
 * 子进程纪律（windowsHide、win32 shell、超时 kill）来自 `spawn.ts`。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultSpawnRunner, type SpawnRunner } from '../../spawn.js'
import { QQ_RUNTIME_PACKAGES, qqRuntimeRoot, qqRuntimeStatus } from './sdk.js'

/** 安装超时：镜像本地 ONNX 运行时的十分钟（包体积大，冷装可能几分钟）。 */
export const QQ_RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
/** 回传面板的输出尾段上限（超长截尾，只留最有用的最后几屏）。 */
const INSTALL_OUTPUT_TAIL = 8000
/** 运行期目录的包描述：只为给 pnpm 一个独立根，不声明任何依赖。 */
const RUNTIME_PACKAGE_JSON = `${JSON.stringify({ name: 'dsh-soulmojito-im-runtime', private: true }, null, 2)}\n`

export interface QqRuntimeInstallOutcome {
  ok: boolean
  /** 已在位（快速路径，未跑 pnpm）。 */
  alreadyInstalled: boolean
  message?: string
  /** pnpm 输出尾段（诊断回显）。 */
  outputTail: string
}

/**
 * 面板一键安装：在 `qqRuntimeRoot()` 里执行 pnpm add 两个腾讯包。
 *
 * 返回结构化结果（面板直接展示 `message`/`outputTail`）；只有探测/准备目录失败
 * （权限、磁盘）才 reject——那是环境错误，不该被伪装成一条 pnpm 失败信息。
 */
export async function installQqRuntime(input: {
  timeoutMs?: number
  spawnRunner?: SpawnRunner
}): Promise<QqRuntimeInstallOutcome> {
  if ((await qqRuntimeStatus()).installed) {
    return { ok: true, alreadyInstalled: true, outputTail: '' }
  }
  const root = qqRuntimeRoot()
  await mkdir(root, { recursive: true })
  await ensureRuntimePackageJson(root)
  const run = input.spawnRunner ?? defaultSpawnRunner
  try {
    const result = await run(
      'pnpm',
      ['add', ...QQ_RUNTIME_PACKAGES.map((pkg) => `${pkg.name}@${pkg.version}`)],
      { cwd: root, timeoutMs: input.timeoutMs ?? QQ_RUNTIME_INSTALL_TIMEOUT_MS },
    )
    const outputTail = result.output.slice(-INSTALL_OUTPUT_TAIL)
    if (result.code !== 0) {
      return { ok: false, alreadyInstalled: false, message: `pnpm exited with ${result.code}`, outputTail }
    }
    if (!(await qqRuntimeStatus()).installed) {
      return {
        ok: false,
        alreadyInstalled: false,
        message: 'pnpm succeeded but the runtime is still not resolvable; restart DSH and retry',
        outputTail,
      }
    }
    return { ok: true, alreadyInstalled: false, outputTail }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      ok: false,
      alreadyInstalled: false,
      message: `pnpm add failed: ${detail}${/ENOENT|not found|not recognized/i.test(detail) ? ' (is pnpm on PATH?)' : ''}`,
      outputTail: '',
    }
  }
}

/**
 * 只在缺失时写 `package.json`：`wx` 的语义是「不存在才创建」。已存在（EEXIST）
 * 说明上一次安装已经建好——绝不覆盖它，用户可能往里面加过自己的字段。
 */
async function ensureRuntimePackageJson(root: string): Promise<void> {
  try {
    await writeFile(join(root, 'package.json'), RUNTIME_PACKAGE_JSON, { encoding: 'utf8', flag: 'wx' })
  } catch (cause) {
    const errno = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
    if (errno === 'EEXIST') return
    throw cause
  }
}
