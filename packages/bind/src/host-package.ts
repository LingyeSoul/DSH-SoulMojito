/**
 * 宿主包运行时解析。`link:` 挂载下插件真实路径在宿主 profile 之外，Node 的
 * parent 目录解析碰不到宿主 node_modules，bare import 会失败。改为从宿主安装
 * 锚（默认 process.argv[1]，可用 anchor 参数覆盖）createRequire 解析后按 URL
 * 动态 import——ESM 缓存按 URL 取模，拿到的是与宿主完全相同的模块实例
 * （Service/类身份零漂移）；锚不可用时回退标准解析，覆盖 profile 物理安装
 * （closure fallback）形态。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export async function importHostPackage<T>(name: string, anchor: string | undefined = process.argv[1]): Promise<T> {
  if (typeof anchor === 'string' && anchor !== '') {
    try {
      const hostRequire = createRequire(anchor)
      return (await import(pathToFileURL(hostRequire.resolve(name)).href)) as T
    } catch {
      // 锚缺失（嵌入/打包运行时）或包不可达时走标准解析。
    }
  }
  return (await import(name)) as T
}
