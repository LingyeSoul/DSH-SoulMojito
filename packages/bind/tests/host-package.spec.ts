import { resolve } from 'node:path'
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
})
