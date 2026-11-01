/**
 * `build-info.ts` resolves the reported commit while the bundle is imported on
 * host start-up, so it reads the Git metadata directly instead of spawning
 * `git` (two `execFileSync` calls used to dominate the import). These fixtures
 * pin every ref shape a checkout can have: a loose branch ref, a detached HEAD,
 * a ref that only exists in `packed-refs`, a `.git` file pointing at a linked
 * worktree's Git directory, and reftable ref storage, where the reads cannot
 * resolve HEAD and the single `git` fallback must run instead of silently
 * reporting the build stamp — plus the fallback paths.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { readCommitViaGit, resolveRepositoryCommit } from '../src/build-info.js'
import type { GitCommitReader } from '../src/build-info.js'

const STAMP = '1111111111111111111111111111111111111111'
const COMMIT = '3f9c2a1b8d7e6f5a4c3b2a1908f7e6d5c4b3a291'
const PACKED_COMMIT = 'c1d2e3f4a5b60718293a4b5c6d7e8f9012345678'
const WORKTREE_COMMIT = '9a8b7c6d5e4f302132435465768798a9b0c1d2e3'
const REALTABLE_COMMIT = '5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081'
const ENV_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01'
const LEGACY_ENV_COMMIT = '0fedcba9876543210fedcba9876543210fedcba9'

const shortOf = (hash: string) => hash.slice(0, 7)

const roots: string[] = []

/** Fail loudly if the direct reads reach the Git fallback: normal checkouts
 * must resolve without starting any child process. */
const forbiddenReader: GitCommitReader = (repositoryRoot: string) => {
  throw new Error(`git fallback must not run for ${repositoryRoot}`)
}

interface RecordingReader {
  read: GitCommitReader
  calls: string[]
}

function recordingReader(commit: string | undefined): RecordingReader {
  const calls: string[] = []
  return {
    calls,
    read: (repositoryRoot: string) => {
      calls.push(repositoryRoot)
      return commit
    },
  }
}

afterEach(() => {
  delete process.env.DSH_SOULMOJITO_COMMIT
  delete process.env.DSH_TAVERN_COMMIT
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-soulmojito-build-info-${label}-`))
  roots.push(root)
  return root
}

function writeRepoFile(root: string, segments: string[], content: string): void {
  const target = join(root, ...segments)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, 'utf8')
}

interface ReftableRepo {
  root: string
  head: string
}

/**
 * A real reftable checkout: refs live in binary `.git/reftable` tables, so the
 * loose-ref and `packed-refs` reads both miss. Returns undefined when the local
 * Git predates `--ref-format=reftable`, which only skips that one fixture.
 */
function prepareReftableRepo(): ReftableRepo | undefined {
  const root = tempRoot('reftable')
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim()
  try {
    git(['init', '--ref-format=reftable', '--quiet', '.'])
  } catch {
    return undefined
  }
  git(['-c', 'user.name=build-info', '-c', 'user.email=build-info@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'ref fixture'])
  return { root, head: git(['rev-parse', '--short=7', 'HEAD']) }
}

const reftableRepo = prepareReftableRepo()

function requireReftableRepo(repo: ReftableRepo | undefined): ReftableRepo {
  if (repo === undefined) throw new Error('reftable fixture was not prepared')
  return repo
}

describe('resolveRepositoryCommit（正常仓库不启 git 进程读 commit）', () => {
  it('松散 ref：HEAD 符号引用，取 refs/heads/<branch> 文件里的 hash 前 7 位', () => {
    const root = tempRoot('loose')
    writeRepoFile(root, ['.git', 'HEAD'], 'ref: refs/heads/main\n')
    writeRepoFile(root, ['.git', 'refs', 'heads', 'main'], `${COMMIT}\n`)
    expect(resolveRepositoryCommit(root, STAMP, forbiddenReader)).toBe(shortOf(COMMIT))
  })

  it('detached HEAD：HEAD 直接是 40 位 hash', () => {
    const root = tempRoot('detached')
    writeRepoFile(root, ['.git', 'HEAD'], `${COMMIT}\n`)
    expect(resolveRepositoryCommit(root, STAMP, forbiddenReader)).toBe(shortOf(COMMIT))
  })

  it('packed-refs：松散 ref 缺席时按 ref 名匹配，跳过 # 头与 ^ 剥离行', () => {
    const root = tempRoot('packed')
    writeRepoFile(root, ['.git', 'HEAD'], 'ref: refs/heads/release\n')
    writeRepoFile(root, ['.git', 'packed-refs'], [
      '# pack-refs with: peeled fully-peeled sorted ',
      `${COMMIT} refs/heads/main`,
      `${PACKED_COMMIT} refs/heads/release`,
      '^1111111111111111111111111111111111111111',
      '',
    ].join('\n'))
    expect(resolveRepositoryCommit(root, STAMP, forbiddenReader)).toBe(shortOf(PACKED_COMMIT))
  })

  it('.git 是文件（linked worktree）：按 gitdir 指针进位，ref 从 commondir 指向的公共目录解析', () => {
    const root = tempRoot('worktree')
    writeRepoFile(root, ['checkout', '.git'], 'gitdir: ../main/.git/worktrees/feat\n')
    writeRepoFile(root, ['main', '.git', 'worktrees', 'feat', 'HEAD'], 'ref: refs/heads/feat\n')
    writeRepoFile(root, ['main', '.git', 'worktrees', 'feat', 'commondir'], '../..\n')
    writeRepoFile(root, ['main', '.git', 'refs', 'heads', 'feat'], `${WORKTREE_COMMIT}\n`)
    expect(resolveRepositoryCommit(join(root, 'checkout'), STAMP, forbiddenReader)).toBe(shortOf(WORKTREE_COMMIT))
  })

  it('没有 .git 时回落构建期 stamp，且不启 git 进程', () => {
    const root = tempRoot('stamp')
    expect(resolveRepositoryCommit(root, STAMP, forbiddenReader)).toBe(shortOf(STAMP))
  })

  it('内容非法时回落而不抛（乱写的 HEAD、截断的 ref、缺失或非法的 gitdir 指针）', () => {
    const garbageHead = tempRoot('garbage-head')
    writeRepoFile(garbageHead, ['.git', 'HEAD'], 'not a ref\n')
    const garbageReader = recordingReader(undefined)
    expect(resolveRepositoryCommit(garbageHead, STAMP, garbageReader.read)).toBe(shortOf(STAMP))
    expect(garbageReader.calls).toEqual([garbageHead])

    const shortRef = tempRoot('short-ref')
    writeRepoFile(shortRef, ['.git', 'HEAD'], 'ref: refs/heads/main\n')
    writeRepoFile(shortRef, ['.git', 'refs', 'heads', 'main'], 'deadbeef\n')
    const shortRefReader = recordingReader(undefined)
    expect(resolveRepositoryCommit(shortRef, STAMP, shortRefReader.read)).toBe(shortOf(STAMP))
    expect(shortRefReader.calls).toEqual([shortRef])

    // HEAD 读不出（或 `.git` 指针悬空）时连仓库形态都判不出来，不进 git 兜底。
    const danglingPointer = tempRoot('dangling-gitdir')
    writeRepoFile(danglingPointer, ['.git'], 'gitdir: ../nowhere/.git/worktrees/gone\n')
    expect(resolveRepositoryCommit(danglingPointer, STAMP, forbiddenReader)).toBe(shortOf(STAMP))

    const notAPointer = tempRoot('bad-gitdir')
    writeRepoFile(notAPointer, ['.git'], 'something else entirely\n')
    expect(resolveRepositoryCommit(notAPointer, STAMP, forbiddenReader)).toBe(shortOf(STAMP))
  })

  it('环境变量只在没有可用 .git 时生效，旧前缀保留读取（优先级与改动前一致）', () => {
    const checkout = tempRoot('env-checkout')
    writeRepoFile(checkout, ['.git', 'HEAD'], `${COMMIT}\n`)
    process.env.DSH_SOULMOJITO_COMMIT = ENV_COMMIT
    expect(resolveRepositoryCommit(checkout, STAMP, forbiddenReader)).toBe(shortOf(COMMIT))

    const bare = tempRoot('env-fallback')
    expect(resolveRepositoryCommit(bare, STAMP, forbiddenReader)).toBe(shortOf(ENV_COMMIT))

    delete process.env.DSH_SOULMOJITO_COMMIT
    process.env.DSH_TAVERN_COMMIT = LEGACY_ENV_COMMIT
    expect(resolveRepositoryCommit(bare, STAMP, forbiddenReader)).toBe(shortOf(LEGACY_ENV_COMMIT))
  })
})

describe('resolveRepositoryCommit（reftable 回落 git 子进程）', () => {
  it('.git 存在但 refs 与 packed-refs 都读不出时走 git 兜底，不回落构建期 stamp', () => {
    const root = tempRoot('reftable-shaped')
    writeRepoFile(root, ['.git', 'HEAD'], 'ref: refs/heads/main\n')
    writeRepoFile(root, ['.git', 'reftable', 'tables.list'], '0x0000000000000001-0x0000000000000002\n')
    const reader = recordingReader(shortOf(REALTABLE_COMMIT))
    expect(resolveRepositoryCommit(root, STAMP, reader.read)).toBe(shortOf(REALTABLE_COMMIT))
    expect(reader.calls).toEqual([root])
  })

  it('git 兜底也解析不出时仍回落 stamp（错误 metadata 不抛、不猜）', () => {
    const root = tempRoot('reftable-unresolved')
    writeRepoFile(root, ['.git', 'HEAD'], 'ref: refs/heads/main\n')
    const reader = recordingReader(undefined)
    expect(resolveRepositoryCommit(root, STAMP, reader.read)).toBe(shortOf(STAMP))
    expect(reader.calls).toEqual([root])
  })

  it.skipIf(reftableRepo === undefined)('真 reftable 仓库（git --ref-format=reftable）：直读解析不出，git 兜底给出真 HEAD', () => {
    const repo = requireReftableRepo(reftableRepo)
    expect(resolveRepositoryCommit(repo.root, STAMP, readCommitViaGit)).toBe(repo.head)
    expect(repo.head).not.toBe(shortOf(STAMP))
  })
})
