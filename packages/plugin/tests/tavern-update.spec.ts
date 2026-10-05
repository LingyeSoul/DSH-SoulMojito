import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compareBuilds,
  compareTavernVersions,
  parseAtomFeed,
  parseCommitResponse,
  parseCompareResponse,
  parsePackageVersion,
  pluginFilesIn,
  pluginInstallSpec,
} from '../src/update/github.js'
import { fetchRemoteBuild } from '../src/update/sources.js'
import { TavernUpdateService, updateChangelog } from '../src/update/service.js'
import {
  copyShippedFiles,
  installViaCli,
  installViaPluginManager,
  readInstalledStamp,
  resolveDesktopCli,
  runInstallChain,
} from '../src/update/apply.js'

const REMOTE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const LOCAL_SHA = '8271f20'

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function textResponse(body: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body }
}

/** 记录每次请求并按 url 分派的 fetch 替身。 */
function fetchStub(handler: (url: string) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>) {
  const calls: string[] = []
  const impl = async (url: string) => {
    calls.push(url)
    return handler(url)
  }
  return { impl: impl as never, calls }
}

const HOUSING: Array<() => void> = []
beforeEach(() => {
  delete process.env.DSH_TAVERN_DSH_CLI
  // 单元测试里关掉 curl 兜底，保证每个来源的成败只由注入的 fetch 替身决定。
  process.env.DSH_TAVERN_DISABLE_CURL = '1'
})
afterEach(() => {
  delete process.env.DSH_TAVERN_DSH_CLI
  delete process.env.DSH_TAVERN_DISABLE_CURL
  while (HOUSING.length > 0) HOUSING.pop()?.()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  HOUSING.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe('compareTavernVersions', () => {
  it('比较三段数字版本', () => {
    expect(compareTavernVersions('0.3.9', '0.3.8')).toBe(1)
    expect(compareTavernVersions('0.3.8', '0.3.8')).toBe(0)
    expect(compareTavernVersions('0.4.0', '0.3.9')).toBe(1)
    expect(compareTavernVersions('0.3.8', '0.4.0')).toBe(-1)
  })

  it('预发布版本低于同号正式版，非法值按 0.0.0 处理', () => {
    expect(compareTavernVersions('0.2.0-rc.2', '0.2.0')).toBe(-1)
    expect(compareTavernVersions('0.2.0', '0.2.0-rc.2')).toBe(1)
    expect(compareTavernVersions('unknown', '0.0.0')).toBe(0)
    expect(compareTavernVersions('v1.2.3', '1.2.3')).toBe(0)
  })
})

describe('pluginFilesIn', () => {
  it('只保留插件包本体的改动', () => {
    expect(pluginFilesIn(['packages/plugin/index.mjs', 'README.md', 'packages/plugin/src/index.ts', 'packages/tavern-store/src/x.ts']))
      .toEqual(['packages/plugin/index.mjs', 'packages/plugin/src/index.ts'])
  })
})

describe('compareBuilds', () => {
  const local = { version: '0.3.8', commit: LOCAL_SHA }

  it('commit 相同即最新', () => {
    expect(compareBuilds({ local, remote: { version: '0.3.8', commit: LOCAL_SHA, changedPluginFiles: [] } }).status).toBe('up-to-date')
  })

  it('远端版本更高则可更新', () => {
    const result = compareBuilds({ local, remote: { version: '0.3.9', commit: REMOTE_SHA, changedPluginFiles: [] } })
    expect(result.status).toBe('update-available')
    expect(result.reason).toContain('0.3.9')
  })

  it('远端版本更低时报本地领先，不提示更新', () => {
    expect(compareBuilds({ local: { version: '0.4.0', commit: LOCAL_SHA }, remote: { version: '0.3.8', commit: REMOTE_SHA, changedPluginFiles: [] } }).status)
      .toBe('local-ahead')
  })

  it('同版本号但改动清单可信且只碰到文档时报最新', () => {
    expect(compareBuilds({ local, remote: { version: '0.3.8', commit: REMOTE_SHA, changedPluginFiles: ['packages/plugin/index.mjs'] } }).status)
      .toBe('update-available')
    expect(compareBuilds({ local, remote: { version: '0.3.8', commit: REMOTE_SHA, changedPluginFiles: ['docs/x.md', 'README.md'] } }).status)
      .toBe('up-to-date')
  })

  it('改动清单不可信（api 被限流）时按 commit 判定为可更新', () => {
    const result = compareBuilds({ local, remote: { version: '0.3.8', commit: REMOTE_SHA, changedPluginFiles: [], filesKnown: false } })
    expect(result.status).toBe('update-available')
    expect(result.reason).toContain('changed files are unavailable')
  })

  it('本地 commit 缺失时退化为版本比较', () => {
    expect(compareBuilds({ local: { version: '0.3.8', commit: 'unknown' }, remote: { version: '0.3.9', commit: REMOTE_SHA, changedPluginFiles: [] } }).status)
      .toBe('update-available')
    expect(compareBuilds({ local: { version: '0.3.8', commit: 'unknown' }, remote: { version: '0.3.8', commit: REMOTE_SHA, changedPluginFiles: [] } }).status)
      .toBe('up-to-date')
  })

  it('远端版本号读不到时用 commit 判定，而不是当成 0.0.0', () => {
    const result = compareBuilds({ local, remote: { version: 'unknown', commit: REMOTE_SHA, changedPluginFiles: [] } })
    expect(result.status).toBe('update-available')
    expect(result.reason).toContain('remote version unavailable')
    expect(compareBuilds({ local, remote: { version: 'unknown', commit: LOCAL_SHA, changedPluginFiles: [] } }).status).toBe('up-to-date')
  })

  it('两边都无法比较时状态是 unknown（不谎报最新）', () => {
    expect(compareBuilds({ local: { version: 'unknown', commit: 'unknown' }, remote: { version: 'unknown', commit: '', changedPluginFiles: [] } }).status)
      .toBe('unknown')
  })
})

describe('GitHub 响应解析', () => {
  it('解析 /commits/{ref}', () => {
    const commit = parseCommitResponse({
      sha: REMOTE_SHA,
      html_url: 'https://github.com/LingyeSoul/dsh-tavern/commit/a1b2c3d',
      commit: { message: '内置更新：发现新版本\n\nbody', author: { date: '2026-10-05T00:00:00Z' } },
    })
    expect(commit).toEqual({
      sha: REMOTE_SHA,
      short: 'a1b2c3d',
      message: '内置更新：发现新版本',
      date: '2026-10-05T00:00:00Z',
      url: 'https://github.com/LingyeSoul/dsh-tavern/commit/a1b2c3d',
    })
    expect(parseCommitResponse({ sha: 'nope' })).toBeNull()
    expect(parseCommitResponse(null)).toBeNull()
  })

  it('解析 /compare/... 并把 commits 反转为最新在前', () => {
    const parsed = parseCompareResponse({
      commits: [
        { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', commit: { message: 'older' } },
        { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', commit: { message: 'newer' } },
      ],
      files: [{ filename: 'packages/plugin/index.mjs' }, { filename: 'README.md' }, { nope: 1 }],
    })
    expect(parsed.commits.map((commit) => commit.message)).toEqual(['newer', 'older'])
    expect(parsed.files).toEqual(['packages/plugin/index.mjs', 'README.md'])
  })

  it('解析 atom feed（api.github.com 被拦时的兜底）', () => {
    const xml = `<?xml version="1.0"?><feed>
      <entry><id>tag:github.com,2008:Grit::Commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678</id>
      <title>内置更新&amp;重启提示</title><updated>2026-10-05T02:00:00Z</updated></entry>
      <entry><id>tag:github.com,2008:Grit::Commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</id>
      <title>修复</title><updated>2026-10-04T02:00:00Z</updated></entry>
    </feed>`
    const commits = parseAtomFeed(xml)
    expect(commits).toHaveLength(2)
    expect(commits[0]?.short).toBe('a1b2c3d')
    expect(commits[0]?.message).toBe('内置更新&重启提示')
  })

  it('读取 package.json 的 version', () => {
    expect(parsePackageVersion({ version: ' 0.3.9 ' })).toBe('0.3.9')
    expect(parsePackageVersion({})).toBe('unknown')
    expect(parsePackageVersion(null)).toBe('unknown')
  })
})

describe('pluginInstallSpec', () => {
  it('有 commit 时固定到 commit，否则用分支 ref', () => {
    expect(pluginInstallSpec('LingyeSoul/dsh-tavern', 'main', REMOTE_SHA))
      .toBe(`github:LingyeSoul/dsh-tavern#${REMOTE_SHA}&path:/packages/plugin`)
    expect(pluginInstallSpec('LingyeSoul/dsh-tavern.git', 'main', 'unknown'))
      .toBe('github:LingyeSoul/dsh-tavern#main&path:/packages/plugin')
  })
})

describe('fetchRemoteBuild', () => {
  const base = { repository: 'LingyeSoul/dsh-tavern', ref: 'main', localCommit: LOCAL_SHA }

  it('优先走 api 来源并带上改动文件', async () => {
    const stub = fetchStub((url) => {
      if (url.includes('/commits/')) return jsonResponse({ sha: REMOTE_SHA, commit: { message: 'feat', author: { date: 'now' } } })
      if (url.includes('raw.githubusercontent.com')) return jsonResponse({ version: '0.3.9' })
      if (url.includes('/compare/')) return jsonResponse({ commits: [{ sha: REMOTE_SHA, commit: { message: 'feat' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
      return jsonResponse({}, 404)
    })
    const result = await fetchRemoteBuild({ ...base, fetchImpl: stub.impl, now: () => new Date('2026-10-05T00:00:00Z') })
    expect(result.error).toBe('')
    expect(result.build?.source).toBe('api')
    expect(result.build?.version).toBe('0.3.9')
    expect(result.build?.commit).toBe(REMOTE_SHA)
    expect(result.build?.changedPluginFiles).toEqual(['packages/plugin/index.mjs'])
    expect(result.build?.checkedAt).toBe('2026-10-05T00:00:00.000Z')
  })

  it('api 不可用时退到 raw + git ls-remote', async () => {
    const stub = fetchStub((url) => {
      if (url.includes('api.github.com')) return jsonResponse({ message: 'blocked' }, 502)
      if (url.includes('raw.githubusercontent.com')) return jsonResponse({ version: '0.3.9' })
      return jsonResponse({}, 404)
    })
    const result = await fetchRemoteBuild({
      ...base,
      fetchImpl: stub.impl,
      resolveCommitImpl: async () => REMOTE_SHA,
    })
    expect(result.build?.source).toBe('raw-git')
    expect(result.build?.commit).toBe(REMOTE_SHA)
    expect(result.build?.version).toBe('0.3.9')
  })

  it('前两个来源都失败时退到 atom，全部失败则带回三处原因', async () => {
    const atomOnly = fetchStub((url) => {
      if (url.endsWith('.atom')) {
        return textResponse(`<feed><entry><id>tag:github.com,2008:Grit::Commit/${REMOTE_SHA}</id><title>fix</title><updated>now</updated></entry></feed>`)
      }
      return jsonResponse({}, 502)
    })
    const viaAtom = await fetchRemoteBuild({ ...base, fetchImpl: atomOnly.impl, resolveCommitImpl: async () => '' })
    expect(viaAtom.build?.source).toBe('atom')
    expect(viaAtom.build?.commit).toBe(REMOTE_SHA)

    const allBad = fetchStub(() => jsonResponse({}, 502))
    const failed = await fetchRemoteBuild({ ...base, fetchImpl: allBad.impl, resolveCommitImpl: async () => '' })
    expect(failed.build).toBeNull()
    expect(failed.error).toContain('api:')
    expect(failed.error).toContain('raw-git:')
    expect(failed.error).toContain('atom:')
  })

  it('fetch 因证书/网络失败时用 curl 兜底（企业 TLS 中间人场景）', async () => {
    delete process.env.DSH_TAVERN_DISABLE_CURL
    const stub = fetchStub(() => {
      throw new TypeError('fetch failed', { cause: new Error('unable to verify the first certificate') })
    })
    const asked: string[] = []
    const result = await fetchRemoteBuild({
      ...base,
      fetchImpl: stub.impl,
      resolveCommitImpl: async () => REMOTE_SHA,
      curlImpl: async (url) => {
        asked.push(url)
        if (url.includes('/commits/')) {
          return JSON.stringify({ sha: REMOTE_SHA, commit: { message: 'feat', author: { date: 'now' } } })
        }
        if (url.includes('raw.githubusercontent.com')) return JSON.stringify({ version: '0.3.9' })
        return JSON.stringify({ commits: [{ sha: REMOTE_SHA, commit: { message: 'feat' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
      },
    })
    expect(result.error).toBe('')
    expect(result.build?.source).toBe('api')
    expect(result.build?.version).toBe('0.3.9')
    expect(result.build?.changedPluginFiles).toEqual(['packages/plugin/index.mjs'])
    expect(asked.length).toBeGreaterThan(0)
  })

  it('curl 兜底也失败时错误里同时带上 fetch 与 curl 的原因', async () => {
    delete process.env.DSH_TAVERN_DISABLE_CURL
    const stub = fetchStub(() => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchRemoteBuild({
      ...base,
      fetchImpl: stub.impl,
      resolveCommitImpl: async () => '',
      curlImpl: async () => {
        throw new Error('curl: (60) SSL certificate problem')
      },
    })
    expect(result.build).toBeNull()
    expect(result.error).toContain('fetch:')
    expect(result.error).toContain('curl:')
    expect(result.error).toContain('SSL certificate problem')
  })

  it('DSH_TAVERN_DISABLE_CURL 生效时不调用 curl 兜底', async () => {
    process.env.DSH_TAVERN_DISABLE_CURL = '1'
    const stub = fetchStub(() => jsonResponse({}, 502))
    let curlCalls = 0
    const result = await fetchRemoteBuild({
      ...base,
      fetchImpl: stub.impl,
      resolveCommitImpl: async () => '',
      curlImpl: async () => {
        curlCalls += 1
        return '{}'
      },
    })
    expect(curlCalls).toBe(0)
    expect(result.build).toBeNull()
  })
})

describe('TavernUpdateService', () => {
  const local = { version: '0.3.8', commit: LOCAL_SHA }

  function remoteHandler(version = '0.3.9') {
    return (url: string) => {
      if (url.includes('/commits/')) return jsonResponse({ sha: REMOTE_SHA, commit: { message: 'feat: update', author: { date: '2026-10-05T00:00:00Z' } } })
      if (url.includes('raw.githubusercontent.com')) return jsonResponse({ version })
      if (url.includes('/compare/')) return jsonResponse({ commits: [{ sha: REMOTE_SHA, commit: { message: 'feat: update' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
      return jsonResponse({}, 404)
    }
  }

  function service(options: Record<string, unknown> = {}) {
    const home = tempDir('tavern-update-')
    const stub = fetchStub(remoteHandler())
    const instance = new TavernUpdateService({
      home,
      pluginDir: home,
      local,
      fetchImpl: stub.impl,
      ...options,
    })
    return { instance, home, stub }
  }

  it('检查发现新版本并写缓存，TTL 内不重复请求', async () => {
    const { instance, home, stub } = service({ checkTtlMs: 60_000 })
    const first = await instance.check()
    expect(first.status).toBe('update-available')
    expect(first.remote?.commit).toBe(REMOTE_SHA)
    expect(first.spec).toBe(`github:LingyeSoul/dsh-tavern#${REMOTE_SHA}&path:/packages/plugin`)
    expect(updateChangelog(first)).toEqual([`a1b2c3d feat: update`])
    const fetches = stub.calls.length
    expect(fetches).toBeGreaterThan(0)
    const cached = JSON.parse(readFileSync(join(home, 'update-state.json'), 'utf8'))
    expect(cached.status).toBe('update-available')
    await instance.check()
    expect(stub.calls.length).toBe(fetches)
    await instance.check({ force: true })
    expect(stub.calls.length).toBeGreaterThan(fetches)
  })

  it('远端读不到时状态 unknown 且错误不抛出', async () => {
    const home = tempDir('tavern-update-')
    const stub = fetchStub(() => jsonResponse({}, 502))
    const instance = new TavernUpdateService({
      home,
      pluginDir: home,
      local,
      fetchImpl: stub.impl,
      resolveCommitImpl: async () => '',
    })
    const snapshot = await instance.check({ force: true })
    expect(snapshot.status).toBe('unknown')
    expect(snapshot.error).toContain('502')
    expect(snapshot.remote).toBeNull()
  })

  it('通过 pluginManager 安装后进入 restart-required，且不再重复提示', async () => {
    const { instance, home } = service({ checkTtlMs: 1 })
    await instance.check({ force: true })
    const specs: string[] = []
    let emitInstallLog: ((payload: unknown) => void) | null = null
    const ctx = {
      logger: { info: () => {} },
      on: (event: string, handler: (payload: unknown) => void) => {
        if (event === 'plugin-manager/install-log') emitInstallLog = handler
        return () => {}
      },
      get: (name: string) => (name === 'pluginManager' ? {
        installBundle: (spec: string, options: { requestId?: string }) => {
          specs.push(spec)
          emitInstallLog?.({ requestId: options?.requestId, text: 'Progress: resolved 1', stream: 'stdout' })
          return Promise.resolve({ application: 'restart-required', changed: true, bundle: 'dsh-tavern' })
        },
      } : undefined),
    }
    const installed = new TavernUpdateService({ home, pluginDir: home, local, ctx, fetchImpl: stubOfRemote() })
    await installed.check({ force: true })
    const snapshot = await installed.install()
    expect(specs).toEqual([`github:LingyeSoul/dsh-tavern#${REMOTE_SHA}&path:/packages/plugin`])
    expect(snapshot.install.phase).toBe('done')
    expect(snapshot.install.strategy).toBe('plugin-manager')
    expect(snapshot.install.restartRequired).toBe(true)
    expect(snapshot.status).toBe('restart-required')
    expect(snapshot.install.log.length).toBeGreaterThan(0)
    expect(snapshot.install.log.some((line) => line.includes('Progress: resolved 1'))).toBe(true)

    // 过渡态下再检查不再打远端，也不再提示可更新。
    const again = await installed.check({ force: true })
    expect(again.status).toBe('restart-required')
    // 重启后本地 stamp 追上安装结果 → 回到常规判定。
    const restarted = new TavernUpdateService({
      home,
      pluginDir: home,
      local: { version: '0.3.9', commit: REMOTE_SHA },
      ctx,
      fetchImpl: stubOfRemote(),
    })
    const after = await restarted.check({ force: true })
    expect(after.status).toBe('up-to-date')
    expect(after.install.restartRequired).toBe(false)
  })

  it('安装失败时保留错误并停在 failed', async () => {
    const home = tempDir('tavern-update-')
    const instance = new TavernUpdateService({
      home,
      pluginDir: home,
      local,
      fetchImpl: stubOfRemote(),
      installerImpl: async () => ({
        ok: false,
        strategy: 'cli',
        application: 'failed',
        message: 'registry unreachable',
        restartRequired: false,
        installed: { version: 'unknown', commit: 'unknown' },
      }),
    })
    await instance.check({ force: true })
    const snapshot = await instance.install()
    expect(snapshot.install.phase).toBe('failed')
    expect(snapshot.install.message).toContain('registry unreachable')
    expect(snapshot.install.restartRequired).toBe(false)
  })

  it('没有新版本时安装被拒绝（除非 force）', async () => {
    const home = tempDir('tavern-update-')
    const instance = new TavernUpdateService({
      home,
      pluginDir: home,
      local: { version: '0.3.9', commit: REMOTE_SHA },
      fetchImpl: stubOfRemote(),
    })
    await instance.check({ force: true })
    const snapshot = await instance.install()
    expect(snapshot.install.message).toContain('no update available')
    expect(snapshot.install.running).toBe(false)
  })

  it('关闭后不发起网络请求', async () => {
    const { instance, stub } = service({ enabled: false })
    const snapshot = await instance.check({ force: true })
    expect(snapshot.status).toBe('unknown')
    expect(stub.calls.length).toBe(0)
  })

  it('本地 stamp 变化后丢弃缓存结论', async () => {
    const { instance, home } = service()
    await instance.check({ force: true })
    expect(instance.snapshot().status).toBe('update-available')
    const newer = new TavernUpdateService({ home, pluginDir: home, local: { version: '0.3.9', commit: REMOTE_SHA }, fetchImpl: stubOfRemote() })
    expect(newer.snapshot().status).toBe('unknown')
    expect(newer.snapshot().remote).toBeNull()
  })
})

function stubOfRemote(version = '0.3.9') {
  return fetchStub((url: string) => {
    if (url.includes('/commits/')) return jsonResponse({ sha: REMOTE_SHA, commit: { message: 'feat', author: { date: 'now' } } })
    if (url.includes('raw.githubusercontent.com')) return jsonResponse({ version })
    if (url.includes('/compare/')) return jsonResponse({ commits: [{ sha: REMOTE_SHA, commit: { message: 'feat' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
    return jsonResponse({}, 404)
  }).impl
}

describe('落地路径选择', () => {
  const request = {
    ctx: {},
    repository: 'LingyeSoul/dsh-tavern',
    ref: 'main',
    commit: REMOTE_SHA,
    local: { version: '0.3.8', commit: LOCAL_SHA },
    pluginDir: tempDir('tavern-chain-'),
    log: () => {},
  }

  it('不可用（null）换下一条，失败也继续，成功即返回', async () => {
    const order: string[] = []
    const outcome = await runInstallChain(request, [
      { name: 'cli', run: async () => { order.push('cli'); return null } },
      { name: 'plugin-manager', run: async () => { order.push('plugin-manager'); return { ok: false, strategy: 'plugin-manager', application: 'failed', message: 'ambiguous-install', restartRequired: false, installed: { version: '0.3.8', commit: LOCAL_SHA } } } },
      { name: 'checkout', run: async () => { order.push('checkout'); return { ok: true, strategy: 'checkout', application: 'restart-required', message: 'files replaced', restartRequired: true, installed: { version: '0.3.9', commit: REMOTE_SHA } } } },
    ])
    expect(order).toEqual(['cli', 'plugin-manager', 'checkout'])
    expect(outcome.strategy).toBe('checkout')
    expect(outcome.ok).toBe(true)
  })

  it('全部不可用时给出明确失败而不是抛错', async () => {
    const outcome = await runInstallChain(request, [{ name: 'cli', run: async () => null }])
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('no update path is available')
  })

  it('plugin-manager 的 ambiguous-install 会翻译成人能读懂的提示', async () => {
    const lines: string[] = []
    const outcome = await installViaPluginManager({ ...request, log: (line) => lines.push(line) }, {
      installBundle: async () => ({ application: 'failed', error: { code: 'ambiguous-install' } }),
    })
    expect(outcome?.ok).toBe(false)
    expect(outcome?.message).toContain('ambiguous-install')
    expect(outcome?.message).toContain('dsh plugin')
    expect(lines.some((line) => line.includes('installBundle'))).toBe(true)
  })

  it('有 CLI 时跑 dsh plugin add 并带上固定 commit 的 spec', async () => {
    const marker = join(tempDir('tavern-cli-'), 'argv.json')
    const cli = join(tempDir('tavern-cli-'), 'fake-cli.mjs')
    writeFileSync(cli, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)))\nprocess.exit(0)\n`)
    process.env.DSH_TAVERN_DSH_CLI = cli
    const lines: string[] = []
    const outcome = await installViaCli({ ...request, log: (line) => lines.push(line), timeoutMs: 60_000 })
    expect(outcome?.ok).toBe(true)
    expect(outcome?.strategy).toBe('cli')
    expect(outcome?.restartRequired).toBe(true)
    const argv = JSON.parse(readFileSync(marker, 'utf8')) as string[]
    expect(argv.slice(0, 3)).toEqual(['plugin', '--profile', 'desktop'])
    expect(argv[3]).toBe('add')
    expect(argv[4]).toBe(`github:LingyeSoul/dsh-tavern#${REMOTE_SHA}&path:/packages/plugin`)
  })

  it('CLI 退出码非 0 时返回 null 交给下一条路径', async () => {
    const cli = join(tempDir('tavern-cli-'), 'fake-cli.mjs')
    writeFileSync(cli, 'process.exit(3)\n')
    process.env.DSH_TAVERN_DSH_CLI = cli
    const lines: string[] = []
    expect(await installViaCli({ ...request, log: (line) => lines.push(line), timeoutMs: 60_000 })).toBeNull()
    expect(lines.some((line) => line.includes('dsh plugin failed'))).toBe(true)
  })
})

describe('落地工具', () => {
  it('copyShippedFiles 覆盖发布产物并保留其它文件', () => {
    const source = tempDir('tavern-src-')
    const target = tempDir('tavern-dst-')
    mkdirSync(join(source, 'client'), { recursive: true })
    writeFileSync(join(source, 'index.mjs'), 'new-index')
    writeFileSync(join(source, 'package.json'), '{"version":"0.3.9"}')
    writeFileSync(join(source, 'client', 'index.js'), 'new-client')
    writeFileSync(join(source, 'src.ts'), 'ignored')
    writeFileSync(join(target, 'index.mjs'), 'old-index')
    writeFileSync(join(target, 'extra.txt'), 'keep')
    const copied = copyShippedFiles(source, target)
    expect(copied).toContain('index.mjs')
    expect(copied).toContain('client/index.js')
    expect(copied).not.toContain('src.ts')
    expect(readFileSync(join(target, 'index.mjs'), 'utf8')).toBe('new-index')
    expect(readFileSync(join(target, 'client', 'index.js'), 'utf8')).toBe('new-client')
    expect(readFileSync(join(target, 'extra.txt'), 'utf8')).toBe('keep')
  })

  it('readInstalledStamp 读 version.json，缺失时退回 package.json 与 spec', () => {
    const dir = tempDir('tavern-stamp-')
    writeFileSync(join(dir, 'package.json'), '{"name":"dsh-tavern","version":"0.3.9"}')
    expect(readInstalledStamp(dir)).toEqual({ version: '0.3.9', commit: 'unknown' })
    writeFileSync(join(dir, 'version.json'), '{"version":"0.3.9","commit":"a1b2c3d4e5f6"}')
    expect(readInstalledStamp(dir)).toEqual({ version: '0.3.9', commit: 'a1b2c3d' })
    rmSync(join(dir, 'version.json'))
    expect(readInstalledStamp(dir, `github:o/r#${REMOTE_SHA}&path:/packages/plugin`).commit).toBe('a1b2c3d')
  })

  it('resolveDesktopCli 只在 runtime 目录下存在桌面 CLI 时给出命令', () => {
    const runtime = tempDir('tavern-runtime-')
    const argv = ['exe', 'script', runtime]
    expect(resolveDesktopCli(argv, 'exe.exe', () => false)).toBeNull()
    const cli = resolveDesktopCli(argv, 'exe.exe', (path) => path === join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'))
    expect(cli?.command).toBe('exe.exe')
    expect(cli?.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(resolveDesktopCli([], 'exe.exe', () => true)).toBeNull()
  })
})
