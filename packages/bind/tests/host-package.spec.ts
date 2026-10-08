import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importHostPackage } from '../src/host-package.js'

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..')

describe('importHostPackage', () => {
  it('resolves a package reachable from the given anchor, like the running dsh install', async () => {
    // tavern-format 依赖 fflate；以它的 package.json 为锚等价于以宿主安装锚
    // 解析宿主 node_modules 里的包。
    const anchor = resolve(repoRoot, 'packages/tavern-format/package.json')
    const mod = await importHostPackage<{ unzipSync?: unknown }>('fflate', anchor)
    expect(typeof mod?.unzipSync).toBe('function')
  })

  it('falls back to standard resolution when the anchor is missing or unusable', async () => {
    const mod = await importHostPackage<{ dirname?: unknown }>('node:path', 'Z:/definitely/not/an/anchor.mjs')
    expect(mod.dirname).toBeTypeOf('function')
  })

  it('falls back to standard resolution when no anchor is provided', async () => {
    const mod = await importHostPackage<{ ok?: unknown }>('node:assert', undefined)
    expect(mod.ok).toBeTypeOf('function')
  })

  // 2026-10-08 真机故障：nvm 的全局 bin 是软链（`dsh -> ../lib/node_modules/
  // @deepseek-ai/dsh/lib/bin.js`），process.argv[1] 因此指向软链而不是真实
  // bin.js，锚解析落空、bare import 又因 link: 挂载点在宿主 profile 之外而
  // 失败，`dsh-tavern/compaction` 整体 import 失败（宿主 compaction 服务同时
  // 消失、主插件永久 pending）。锚必须解引用软链后重试。
  it.skipIf(process.platform === 'win32')(
    'resolves through a symlinked launcher anchor, like an nvm or pnpm global bin shim',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-bind-anchor-'))
      try {
        // 宿主安装树：真实 bin.js 的同级与上级 node_modules 是解析面。
        const hostLib = join(root, 'host', 'lib')
        const hostPackage = join(root, 'host', 'node_modules', '@dsh-tavern-test', 'hostpkg')
        mkdirSync(hostLib, { recursive: true })
        mkdirSync(hostPackage, { recursive: true })
        writeFileSync(join(hostLib, 'bin.js'), 'export {}\n')
        writeFileSync(
          join(hostPackage, 'package.json'),
          JSON.stringify({ name: '@dsh-tavern-test/hostpkg', type: 'module', main: 'index.js' }),
        )
        writeFileSync(join(hostPackage, 'index.js'), "export const marker = 'host-package-reached'\n")

        const shimDir = join(root, 'bin')
        mkdirSync(shimDir)
        symlinkSync(join(hostLib, 'bin.js'), join(shimDir, 'dsh'))

        const mod = await importHostPackage<{ marker?: string }>('@dsh-tavern-test/hostpkg', join(shimDir, 'dsh'))
        expect(mod.marker).toBe('host-package-reached')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
