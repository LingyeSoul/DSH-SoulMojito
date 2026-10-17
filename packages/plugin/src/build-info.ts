import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { envCompat } from './env-compat.js'

// 构建期 stamp：由 scripts/build-plugin.mjs 经 esbuild define 注入，用于在
// 没有 version.json / 没有 .git 的安装现场给出「跑的是哪个版本和 commit」。
declare const __TAVERN_VERSION__: string | undefined
declare const __TAVERN_COMMIT__: string | undefined
export const BUILD_INFO = readBuildInfo()
export const TAVERN_COMMIT = resolveTavernCommit(BUILD_INFO.commit)
export function readBuildInfo(): { version: string; commit: string } {
  let version = 'unknown'
  let commit = 'unknown'

  // 构建期 stamp（esbuild define）作为 commit 兜底：git 安装现场没有
  // version.json 旁车（仓库 .gitignore 排除它，安装器成功后才会补写），install
  // 目录也不是 Git 检出。注意它对 dist 随源入库的仓库恒为「父提交」——commit
  // 不可能包含自身 hash，所以它只在旁车缺席时填位，不能当运行身份的最终来源。
  const stamped = buildTimeStamp()
  if (stamped.commit !== '') commit = stamped.commit

  for (const packagePath of [
    resolve(import.meta.dirname, 'package.json'),
    resolve(import.meta.dirname, '..', 'package.json'),
  ]) {
    try {
      const packageData = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (typeof packageData?.version === 'string' && packageData.version.trim() !== '') {
        version = packageData.version.trim()
        break
      }
    } catch {
    }
  }

  // version.json 旁车（安装器成功后统一落戳，见 update/apply.ts 的
  // stampInstalledBuild）优先于构建期字面量：它在模块加载时从磁盘读，正是
  // 「这一代进程跑的是什么」的真相来源——重启加载新安装后 stamp 才能追上
  // 安装结果、解除 restart-required。烤入的字面量恒滞后一拍，做首选会让
  // 过渡态永远解除不了。
  try {
    const generated = JSON.parse(readFileSync(resolve(import.meta.dirname, 'version.json'), 'utf8'))
    if (typeof generated?.version === 'string' && generated.version.trim() !== '') {
      version = generated.version.trim()
    }
    const sidecarCommit = typeof generated?.commit === 'string' ? normalizeCommit(generated.commit) : undefined
    if (sidecarCommit !== undefined) commit = sidecarCommit
  } catch {
  }

  return { version, commit }
}

/**
 * 读构建期注入的 `__TAVERN_VERSION__` / `__TAVERN_COMMIT__`。未定义时
 * （vitest、未走 build-plugin.mjs 的运行）返回空串，`typeof` 对未声明标识符
 * 安全，不会抛 ReferenceError。
 */
export function buildTimeStamp(): { version: string; commit: string } {
  const version = typeof __TAVERN_VERSION__ === 'string' ? __TAVERN_VERSION__.trim() : ''
  const commit = typeof __TAVERN_COMMIT__ === 'string' ? normalizeCommit(__TAVERN_COMMIT__) : undefined
  return { version, commit: commit ?? '' }
}

export function resolveTavernCommit(buildFallback: string): string {
  const fallback = normalizeCommit(envCompat('COMMIT') ?? buildFallback) ?? 'unknown'
  const repositoryRoot = resolve(import.meta.dirname, '..', '..')
  const packagePath = relative(repositoryRoot, import.meta.dirname).replaceAll('\\', '/')
  if (packagePath !== 'packages/plugin') return fallback

  const git = (args: string[]) => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
    windowsHide: true,
  }).trim()

  try {
    // Avoid reporting the host application's commit when this package lives in
    // node_modules under an unrelated Git checkout.
    const gitRoot = resolve(git(['rev-parse', '--show-toplevel']))
    if (relative(repositoryRoot, gitRoot) !== '') return fallback
    return normalizeCommit(git(['rev-parse', '--short=7', 'HEAD'])) ?? fallback
  } catch {
    return fallback
  }
}

export function normalizeCommit(value: string): string | undefined {
  const commit = value.trim()
  return /^[0-9a-f]{7,40}$/i.test(commit)
    ? commit.slice(0, 7).toLowerCase()
    : undefined
}
