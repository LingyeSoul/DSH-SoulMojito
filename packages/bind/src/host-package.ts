/**
 * 宿主包运行时解析。`link:` 挂载下插件真实路径在宿主 profile 之外，Node 的
 * parent 目录解析碰不到宿主 node_modules，bare import 会失败。改为从宿主安装
 * 锚（默认 process.argv[1]，可用 anchor 参数覆盖）createRequire 解析后按 URL
 * 动态 import——ESM 缓存按 URL 取模，拿到的是与宿主完全相同的模块实例
 * （Service/类身份零漂移）；锚不可用时回退标准解析，覆盖 profile 物理安装
 * （closure fallback）形态。
 *
 * 锚本身可能是启动器软链（nvm / pnpm 全局 bin 的 `dsh -> …/dsh/lib/bin.js`）：
 * createRequire 会从软链所在目录向上找 node_modules，永远碰不到宿主安装树。
 * 因此每个锚先按原样、再按 realpath 各解析一次，命中真实 bin.js 后即可解析
 * 宿主自己的 node_modules。
 */
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function importHostPackage<T>(name: string, anchor: string | undefined = process.argv[1]): Promise<T> {
  for (const candidate of anchorCandidates(anchor)) {
    try {
      const hostRequire = createRequire(candidate)
      return (await import(pathToFileURL(hostRequire.resolve(name)).href)) as T
    } catch {
      // 锚缺失（嵌入/打包运行时）、包不可达或该候选解析失败时尝试下一个。
    }
  }
  return (await import(name)) as T
}

/** 解析候选锚：原锚在前（保持既有命中），软链解引用后的真实路径在后。 */
function anchorCandidates(anchor: string | undefined): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined): void => {
    if (typeof value !== 'string' || value === '' || seen.has(value)) return
    seen.add(value)
    candidates.push(value)
  }

  push(anchor)
  if (typeof anchor === 'string' && anchor !== '') {
    try {
      push(realpathSync(anchor))
    } catch {
      // 锚不存在（虚拟路径/嵌入运行时）时保留原锚候选。
    }
  }
  return candidates
}
