/**
 * tmp+rename 原子写（仓库统一实现）。
 *
 * 收敛历史：本包曾有六处自建的 writeAtomic/writeAtomicText（store/variable/
 * memory/originals/scripts/novel），语义漂移出过两类真实缺陷——
 * (1) tmp 名 `path.pid.Date.now()` 同毫秒并发碰撞（两个写者共享同名 tmp，先
 *     rename 者把文件带走，后者 ENOENT；cross-bundle-events 提炼同期 mods/
 *     storage.ts 也自建了一个同款，2026-10-10 主会话验收以 ENOENT-on-rename
 *     打回，见 decisions/2026-10-10-mod-p1-loader.md）；
 * (2) Windows 下 rename 目标被并发句柄短暂占用抛 EPERM/EACCES/EBUSY——提交
 *     2290eb0 给 TavernStore 补了有界退避重试，其余自建点没跟进。
 *
 * 本模块两道防线一次补齐：模块级单调计数器保证 tmp 名全进程唯一（调用方
 * 是否串行化都不再可能碰撞）+ renameWithWindowsRetry 原样迁入。目录创建
 * （mkdir recursive）仍是调用方职责——各调用点对目录的存在时机语义不同。
 */
import { promises as fs } from 'node:fs'

let tmpCounter = 0

/** 字节原子写：唯一 tmp 名 + Windows 瞬态 rename 有界退避重试。 */
export async function writeAtomicBytes(file: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.${tmpCounter++}.tmp`
  await fs.writeFile(tmp, bytes)
  await renameWithWindowsRetry(tmp, file)
}

/** 文本原子写（UTF-8）。 */
export async function writeAtomicText(file: string, text: string): Promise<void> {
  await writeAtomicBytes(file, new Uint8Array(Buffer.from(text, 'utf8')))
}

/**
 * Windows 下 rename 的目标被并发读取句柄短暂占用（本进程内 getState 的
 * readFile 与写路径的 rename 不互斥）会抛 EPERM/EACCES/EBUSY——短退避重试
 * 即可收敛，占用方是毫秒级的读句柄；非占用类错误原样上抛。Linux/macOS 的
 * rename 不受打开句柄影响，首次即成功，重试路径不生效。
 */
async function renameWithWindowsRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'ENOTEMPTY')) throw cause
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt))
    }
  }
}
