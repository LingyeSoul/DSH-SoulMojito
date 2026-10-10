/**
 * Mod git 安装（提案 0015 §4 P2）：管理面「从 git URL 安装」。
 *
 * 复用 update service 的 GitHub 源降级链（src/update/sources.ts）：
 * - URL 解析：`https://github.com/<owner>/<repo>(.git)?` / `<owner>/<repo>`，
 *   可带 `#<ref>`；非 GitHub 的完整 git URL 走纯 clone 路线（无元数据预读）。
 * - 元数据预读（GitHub 源）：raw.githubusercontent.com 经 fetch→curl 两级抓
 *   （sources.ts 的 httpGet），读 `HEAD` 版 mod.json 先定 id、先拒绝坏仓库
 *   ——api.github.com 有配额、atom 无文件内容，raw 是唯一不吃配额的文件源
 *   （sources.ts 的 raw-git 来源先例）。
 * - 落地：`git clone --depth 1`（桌面版 profile 安装本就要 git；sources.ts 的
 *   `git ls-remote` 同款 execFile 纪律：GIT_TERMINAL_PROMPT=0、超时、windowsHide）。
 *   克隆后**再**用本地 mod.json 定 id（预读只是预检，落地以本地为准）。
 * - 装到 `<tavern>/mods/<id>/`（id 来自 mod.json，校验必须等于目录名）；已存在
 *   目录拒绝（force=true 时先删后装）。失败进错误位与审计（install-error）。
 */

import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { httpGet } from '../update/sources.js'
import { checkModManifest } from './manifest.js'

export interface ParsedGitSource {
  kind: 'github' | 'git'
  /** github：owner/repo slug；git：完整 URL。 */
  repository: string
  ref?: string
  /** 元数据预读（仅 github）：raw mod.json 的 URL。 */
  rawModJsonUrl: string | null
  cloneUrl: string
}

/** 解析用户输入的 git 源。不接受空串/控制字符；ref 只允许 [A-Za-z0-9._-]。 */
export function parseGitSource(input: string): ParsedGitSource {
  const text = typeof input === 'string' ? input.trim() : ''
  if (text === '' || text.length > 500 || /[\s"']/.test(text)) throw new Error('invalid git url')
  const hashAt = text.indexOf('#')
  const urlPart = hashAt >= 0 ? text.slice(0, hashAt) : text
  const ref = hashAt >= 0 ? text.slice(hashAt + 1) : undefined
  if (ref !== undefined && !/^[A-Za-z0-9._-]+$/.test(ref)) throw new Error(`invalid ref '${ref}'`)
  const github = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i.exec(urlPart)
    ?? /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/i.exec(urlPart)
  if (github !== null) {
    const repository = `${github[1]}/${github[2]}`.replace(/\.git$/i, '')
    return {
      kind: 'github',
      repository,
      ...(ref !== undefined ? { ref } : {}),
      rawModJsonUrl: `https://raw.githubusercontent.com/${repository}/${ref ?? 'HEAD'}/mod.json`,
      cloneUrl: `https://github.com/${repository}.git`,
    }
  }
  if (/^https:\/\/github\.com\/(?:[A-Za-z0-9._-]+)?\/?$/i.test(urlPart)) {
    // github.com 域但没有 owner/repo 两段：明确的坏输入，不当通用 git URL 放行
    // （clone 只会晚失败，parse 期拒绝给出可读错误）。
    throw new Error(`unsupported git url '${urlPart}' (expected https://github.com/<owner>/<repo> or a git URL)`)
  }
  if (/^https?:\/\/|^git@|^ssh:\/\//i.test(urlPart)) {
    return { kind: 'git', repository: urlPart, ...(ref !== undefined ? { ref } : {}), rawModJsonUrl: null, cloneUrl: urlPart }
  }
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(urlPart)) {
    const repository = urlPart.replace(/\.git$/i, '')
    return {
      kind: 'github',
      repository,
      ...(ref !== undefined ? { ref } : {}),
      rawModJsonUrl: `https://raw.githubusercontent.com/${repository}/${ref ?? 'HEAD'}/mod.json`,
      cloneUrl: `https://github.com/${repository}.git`,
    }
  }
  throw new Error(`unsupported git url '${urlPart}' (expected https://github.com/<owner>/<repo> or a git URL)`)
}

/** `git clone --depth 1 [--branch ref] <url> <dir>`；失败抛带 stderr 摘要的 Error。 */
export function gitClone(url: string, directory: string, ref: string | undefined, timeoutMs: number, exec = execFile): Promise<void> {
  const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout']
  // --branch 对 commit sha 也适用（shallow 单点）；ref 缺省用远端 HEAD。
  if (ref !== undefined) args.push('--branch', ref)
  args.push(url, directory)
  return runGit(args, exec, timeoutMs)
    // --no-checkout + 显式 checkout：绕开 Windows 上 sparse 目录句柄滞留问题。
    .then(() => runGit(['-C', directory, 'checkout', 'HEAD', '--', '.'], exec, timeoutMs))
}

/** execFile 包装（sources.ts 的 resolveRemoteCommit 同款纪律）：失败抛带 stderr 末行摘要的 Error。 */
function runGit(args: string[], exec: typeof execFile, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    exec('git', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
        reject(new Error(detail === '' ? error.message : `${error.message}: ${detail}`))
        return
      }
      resolve()
    })
  })
}

export interface ModInstallOptions {
  /** 输入：GitHub URL / owner/repo / 任意 git URL，可带 #ref。 */
  url: string
  /** `<tavern>` 数据根；装到 `<root>/mods/<id>/`。 */
  root: string
  force?: boolean
  /** 元数据预读的 HTTP 抓取（默认 sources.ts 的 fetch→curl 链）。 */
  fetchText?: (url: string, accept: string, timeoutMs: number) => Promise<string>
  /** 克隆实现（测试注入）。 */
  cloneImpl?: (url: string, directory: string, ref: string | undefined, timeoutMs: number) => Promise<void>
  timeoutMs?: number
}

export interface ModInstallResult {
  modId: string
  /** 已存在目录被 force 覆盖时为 true。 */
  replaced: boolean
  directory: string
}

/**
 * 从 git 源安装一个 Mod。抛错即失败（调用方进审计与错误位）；成功返回 id 与
 * 落地目录。流程：预读 mod.json（GitHub 源）→ clone → 本地校验 → 拷入
 * mods/<id>（排除 .git）→ 调用方 refresh()。
 */
export async function installModFromGit(options: ModInstallOptions): Promise<ModInstallResult> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const source = parseGitSource(options.url)
  // httpGet 只读 timeoutMs/fetchImpl/curlImpl/token；repository/ref 是链上层字段。
  const fetchText = options.fetchText ?? ((url, accept, ms) => httpGet({ repository: source.repository, ref: source.ref ?? 'HEAD', timeoutMs: ms }, url, accept))  // GitHub 源预读 mod.json：坏仓库/无清单在 clone 前被拒（省一次克隆）。
  if (source.rawModJsonUrl !== null) {
    try {
      const raw = await fetchText(source.rawModJsonUrl, 'application/json', Math.min(timeoutMs, 15_000))
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('mod.json must be a JSON object')
    } catch (cause) {
      throw new Error(`repository has no readable mod.json at its root (${source.repository}): ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-tavern-modinstall-'))
  try {
    const cloneDir = join(workRoot, 'clone')
    await (options.cloneImpl ?? gitClone)(source.cloneUrl, cloneDir, source.ref, timeoutMs)
    // 本地 mod.json 是权威：id 从这里读，定目录名。
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(readFileSync(join(cloneDir, 'mod.json'), 'utf8'))
    } catch (cause) {
      throw new Error(`repository has no readable mod.json at its root: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const idField = typeof (manifestRaw as Record<string, unknown>)?.['id'] === 'string'
      ? (manifestRaw as Record<string, unknown>)['id'] as string
      : ''
    const check = checkModManifest(manifestRaw, { directory: idField })
    if (!check.ok) throw new Error(`invalid mod.json: ${check.errors.join('; ')}`)
    const modId = check.manifest.id
    const target = join(options.root, 'mods', modId)
    const replaced = existsSync(target)
    if (replaced && options.force !== true) {
      throw new Error(`mod '${modId}' is already installed (POST again with force to replace it)`)
    }
    rmSync(target, { recursive: true, force: true })
    // 拷贝时排除 .git（含仓库顶层的 .git 目录；数据面只有清单与入口）。
    cpSync(cloneDir, target, { recursive: true, filter: (src) => !src.endsWith('.git') })
    return { modId, replaced, directory: target }
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}
