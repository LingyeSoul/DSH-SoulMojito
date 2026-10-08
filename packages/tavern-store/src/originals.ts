/**
 * 原版卡快照（提案 0013 P1）：导入路由成功后一次性把导入时的原版卡写入
 * `characters/originals/<name>.json`，之后永不覆盖；日常编辑只落工作版
 * （characters/<name>.*），恢复原版即把快照写回工作版。
 *
 * ```text
 * tavern/
 * └── characters/
 *     ├── originals/<name>.json   # 导入时一次性快照（原子写，存在即跳过）
 *     └── <name>.png|json|charx   # 工作版（现有文件，不动）
 * ```
 *
 * 快照内容是 encodeCharacterCardJson 的规范 JSON 形态（未知字段经 raw 袋
 * 保留，readOriginalSnapshot 用 decodeCharacterCard 完整还原）。写操作
 * tmp+rename 原子（对齐 store.ts 的写纪律）；快照只写一次，半途崩溃留下
 * 的残缺文件会被下一次导入的 exists 检查视为已存在——因此原子性在这里
 * 比常规写更关键：绝不让残缺快照占据「已保存」的位置。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { decodeCharacterCard, encodeCharacterCardJson, type CharacterCardIR } from '@dsh-tavern/format'
import { TavernStore, safeFileName, type CharacterFile } from './store.js'

function originalSnapshotPath(root: string, characterName: string): string {
  return path.join(root, 'characters', 'originals', `${safeFileName(characterName)}.json`)
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** tmp+rename 原子写；tmp 名带 pid+随机后缀，并发导入互不踩踏。 */
async function writeAtomicText(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

/**
 * 保存原版快照：已存在则不覆盖（首个导入胜出），返回是否本次写入。
 * characterName 用作快照文件名（safeFileName 钳制），card 为导入得到的 IR。
 */
export async function saveOriginalSnapshot(root: string, characterName: string, card: CharacterCardIR): Promise<boolean> {
  const file = originalSnapshotPath(root, characterName)
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (await fileExists(file)) return false
  await writeAtomicText(file, `${JSON.stringify(encodeCharacterCardJson(card), null, 2)}\n`)
  return true
}

/** 读原版快照；无快照返回 undefined。 */
export async function readOriginalSnapshot(root: string, characterName: string): Promise<CharacterCardIR | undefined> {
  let bytes: Buffer
  try {
    bytes = await fs.readFile(originalSnapshotPath(root, characterName))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  return decodeCharacterCard(JSON.parse(bytes.toString('utf8')))
}

/**
 * 删除原版快照（删卡时清理）；返回是否存在并删除。不清理会留下幽灵快照：
 * 同名卡重建/再导入时 saveOriginalSnapshot 的「首个胜出」会保住陈旧快照，
 * card_restore_original 就会把错误的旧卡写回去。
 */
export async function deleteOriginalSnapshot(root: string, characterName: string): Promise<boolean> {
  try {
    await fs.unlink(originalSnapshotPath(root, characterName))
    return true
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}

/**
 * 恢复原版：把快照写回工作版，返回新工作版；无快照返回 undefined。
 * 工作版存在时走 updateCharacter（保留 PNG/CHARX 容器、迁移文件名与聊天
 * 目录，传规范 JSON 形态触发整体替换分支而非 data 合并，raw 袋也回到
 * 原版）；工作版已被删除时按原导入路径重建。
 */
export async function restoreOriginal(root: string, characterName: string): Promise<CharacterFile | undefined> {
  const original = await readOriginalSnapshot(root, characterName)
  if (original === undefined) return undefined
  const store = await TavernStore.open(root)
  const current = await store.getCharacter(characterName)
  if (current === undefined) {
    await store.importCharacter(original)
  } else {
    await store.updateCharacter(characterName, encodeCharacterCardJson(original))
  }
  const restored = await store.getCharacter(original.data.name)
  if (restored === undefined) throw new Error(`character '${original.data.name}' could not be reloaded after restore`)
  return restored
}
