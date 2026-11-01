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

/**
 * Commit this build should advertise. This runs while the bundle is imported on
 * host start-up, so normal checkouts must not start a child process: two
 * `execFileSync` calls used to cost most of the import (2026-11-01
 * measurement). Everything is a direct read of the repository metadata instead,
 * and only a checkout whose refs cannot be read that way (reftable ref storage)
 * falls back to one `git` process, then to the environment override or the
 * build stamp.
 */
export function resolveTavernCommit(buildFallback: string): string {
  // Only a source checkout laid out as `packages/plugin` has its repository
  // around it; an installed copy (a directory named after the package) must not
  // report the commit of whatever checkout encloses it.
  const repositoryRoot = resolve(import.meta.dirname, '..', '..')
  const packagePath = relative(repositoryRoot, import.meta.dirname).replaceAll('\\', '/')
  if (packagePath !== 'packages/plugin') return commitFallback(buildFallback)
  return resolveRepositoryCommit(repositoryRoot, buildFallback, readCommitViaGit)
}

/** Reader consulted only when the direct metadata reads cannot resolve HEAD. */
export type GitCommitReader = (repositoryRoot: string) => string | undefined

/**
 * Commit of the Git checkout rooted at `repositoryRoot`, or the fallback when
 * the checkout is missing or its metadata is unusable. `readFallbackCommit` is
 * consulted only for a repository whose `.git` exists but whose HEAD cannot be
 * resolved from a loose ref, `packed-refs` or a linked worktree's `commondir`;
 * a checkout without `.git` at all (installed copy, nested checkout) never
 * reaches it.
 */
export function resolveRepositoryCommit(
  repositoryRoot: string,
  buildFallback: string,
  readFallbackCommit: GitCommitReader,
): string {
  const checkout = readGitCheckout(repositoryRoot)
  if (checkout === undefined) return commitFallback(buildFallback)
  return readCheckoutCommit(checkout) ?? readFallbackCommit(repositoryRoot) ?? commitFallback(buildFallback)
}

interface GitCheckout {
  gitDir: string
  commonDir: string
  head: string
}

/**
 * Locates the Git metadata behind `repositoryRoot`. `.git` is either the Git
 * directory itself or a `gitdir: <path>` pointer written by linked worktrees
 * and submodules. A checkout nested inside an outer repository has no `.git` at
 * all and is rejected here, which keeps the old `rev-parse --show-toplevel`
 * guard against reporting the host application's commit.
 */
function readGitCheckout(repositoryRoot: string): GitCheckout | undefined {
  const dotGit = resolve(repositoryRoot, '.git')
  const pointer = readTextFile(dotGit)
  if (pointer === undefined) return checkoutAt(dotGit)
  const pointedAt = /^gitdir:[ \t]*(.*)$/m.exec(pointer)?.[1]?.trim()
  if (pointedAt === undefined || pointedAt === '') return undefined
  return checkoutAt(resolve(repositoryRoot, pointedAt))
}

function checkoutAt(gitDir: string): GitCheckout | undefined {
  const head = readTextFile(resolve(gitDir, 'HEAD'))?.trim()
  if (head === undefined || head === '') return undefined
  return { gitDir, commonDir: commonDirectory(gitDir), head }
}

/**
 * A linked worktree keeps per-worktree state (HEAD) in its own Git directory
 * and the shared refs in the common one, named by the `commondir` pointer.
 */
function commonDirectory(gitDir: string): string {
  const pointer = readTextFile(resolve(gitDir, 'commondir'))?.trim()
  if (pointer === undefined || pointer === '') return gitDir
  return resolve(gitDir, pointer)
}

/** HEAD is either a detached object id or `ref: <name>` pointing at a ref. */
function readCheckoutCommit(checkout: GitCheckout): string | undefined {
  if (!checkout.head.startsWith('ref:')) return readObjectId(checkout.head)
  const ref = checkout.head.slice('ref:'.length).trim()
  if (ref === '') return undefined
  return readLooseRef(checkout.gitDir, ref)
    ?? readLooseRef(checkout.commonDir, ref)
    ?? readPackedRef(checkout.commonDir, ref)
}

/**
 * Fallback for a repository shape the direct reads cannot resolve: reftable ref
 * storage keeps refs in binary `.git/reftable` tables instead of loose refs and
 * `packed-refs`, so every path above misses. This is the only branch that may
 * still start a child process, and it is reached only when `.git` exists; a
 * normal loose/packed/worktree checkout stays process-free.
 */
export function readCommitViaGit(repositoryRoot: string): string | undefined {
  try {
    const output = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    })
    return normalizeCommit(output)
  } catch {
    return undefined
  }
}

function readLooseRef(gitDir: string, ref: string): string | undefined {
  const value = readTextFile(resolve(gitDir, ref))
  return value === undefined ? undefined : readObjectId(value)
}

/**
 * `packed-refs` holds one `<object id> <ref name>` line per packed ref; `#`
 * headers and `^<peeled tag id>` continuation lines carry no commit of ours.
 */
function readPackedRef(commonDir: string, ref: string): string | undefined {
  const packed = readTextFile(resolve(commonDir, 'packed-refs'))
  if (packed === undefined) return undefined
  for (const line of packed.split('\n')) {
    if (line.startsWith('#') || line.startsWith('^')) continue
    const [id, name] = line.trim().split(/\s+/)
    if (id === undefined || name !== ref) continue
    const commit = readObjectId(id)
    if (commit !== undefined) return commit
  }
  return undefined
}

/**
 * Full object id to the 7-character short commit Git would print. SHA-1 (40
 * characters) and SHA-256 (64 characters) repositories are both accepted;
 * anything else means the metadata cannot be trusted.
 */
function readObjectId(value: string): string | undefined {
  const id = value.trim()
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(id) ? id.slice(0, 7).toLowerCase() : undefined
}

function commitFallback(buildFallback: string): string {
  return normalizeCommit(envCompat('COMMIT') ?? buildFallback) ?? 'unknown'
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

export function normalizeCommit(value: string): string | undefined {
  const commit = value.trim()
  return /^[0-9a-f]{7,40}$/i.test(commit)
    ? commit.slice(0, 7).toLowerCase()
    : undefined
}
