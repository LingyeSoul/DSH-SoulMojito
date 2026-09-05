// 修复被 dsh-tavern 历史导入写坏的 DSH 会话日志。
//
// 根因：historyImportAppends 曾给 assistant/message 写
// `{ kind: 'plugin', plugin: 'dsh-tavern', form }` 来源；宿主在会话加载时
// （dsh-session 的 adoptSessionEvent → assertMessageEventShape）要求
// assistant 消息必须是 model 来源且带非空 provider/model，否则整个会话以
// SessionPersistenceCorruptionError 拒载。写入侧已改（projector.ts），本脚本
// 只修存量数据：把镜像来源升级为带 dsh-tavern 标记的 model 来源，与插件
// 现在写入的形态一致，投影器仍凭 plugin 标记跳过镜像消息。
//
// 用法：node scripts/repair-tavern-mirror-source.mjs [--root <sessions-dir>] [--dry-run]
// 默认 root 为 ~/.dsh/sessions。每个被修改的 artifact 先备份为 *.bak-<ts>，
// 再以单帧 zstd 原子写回；修复前后都用宿主 adoptSessionEvent 逐事件校验。
import { homedir } from 'node:os'
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompress, zstdDecompressSync } from 'node:zlib'
import { promisify } from 'node:util'

const zstdCompressAsync = promisify(zstdCompress)

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const rootIndex = args.indexOf('--root')
const sessionsRoot = rootIndex >= 0
  ? resolve(args[rootIndex + 1])
  : join(homedir(), '.dsh', 'sessions')

// 用宿主自己的校验器闭环：全局 @deepseek-ai/dsh 随附的 dsh-session 构建产物。
const dshSessionLib = process.env.DSH_SESSION_LIB
  ?? join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
if (!existsSync(dshSessionLib)) {
  console.error(`host validator not found: ${dshSessionLib} (set DSH_SESSION_LIB)`)
  process.exit(1)
}
const { adoptSessionEvent, decodeStorageRecord } = await import(pathToFileURL(dshSessionLib).href)

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decodeFrames(buffer) {
  const starts = []
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  if (starts.length === 0) throw new Error('no zstd frame found')
  let text = ''
  for (let f = 0; f < starts.length; f++) {
    const end = f + 1 < starts.length ? starts[f + 1] : buffer.length
    text += zstdDecompressSync(buffer.subarray(starts[f], end)).toString('utf8')
  }
  return text
}

/** 校验整份日志可被宿主加载；返回首个违规的描述，全部合法返回 undefined。 */
function firstInvalidEvent(text) {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      return `unparseable line: ${error.message}`
    }
    if (record.type === 'session') continue
    let stored
    try {
      stored = decodeStorageRecord(record)
    } catch (error) {
      return `undecodable row (${record.type}): ${error.message}`
    }
    for (const event of stored) {
      try {
        adoptSessionEvent(structuredClone(event))
      } catch (error) {
        return `seq ${event.seq} (${event.type}): ${error.message}`
      }
    }
  }
  return undefined
}

function repairLine(line) {
  const record = JSON.parse(line)
  if (record.type !== 'assistant/message') return { line, changed: false }
  const source = record.data?.message?.source
  if (source?.kind !== 'plugin' || source?.plugin !== 'dsh-tavern' || typeof source?.form !== 'string') {
    return { line, changed: false }
  }
  record.data.message.source = {
    kind: 'model',
    provider: 'dsh-tavern',
    model: 'agent-tavern-import',
    plugin: 'dsh-tavern',
    form: source.form,
  }
  return { line: JSON.stringify(record), changed: true }
}

const report = { scanned: 0, repaired: [], clean: 0, invalidOther: [] }
for (const workspace of readdirSync(sessionsRoot)) {
  const workspaceDir = join(sessionsRoot, workspace)
  if (!statSync(workspaceDir).isDirectory()) continue
  for (const sessionId of readdirSync(workspaceDir)) {
    const artifact = join(workspaceDir, sessionId, 'session.jsonl.zstd')
    if (!existsSync(artifact)) continue
    report.scanned += 1
    const before = decodeFrames(readFileSync(artifact))
    const preexisting = firstInvalidEvent(before)
    if (preexisting !== undefined && !preexisting.includes('must have model source')) {
      report.invalidOther.push(`${sessionId}: ${preexisting}`)
      continue
    }
    let changed = 0
    const lines = before.split('\n').map((line) => {
      if (line.trim() === '') return line
      const result = repairLine(line)
      if (result.changed) changed += 1
      return result.line
    })
    if (changed === 0) {
      report.clean += 1
      continue
    }
    const after = lines.join('\n')
    const invalid = firstInvalidEvent(after)
    if (invalid !== undefined) {
      console.error(`REPAIR REJECTED for ${sessionId}: ${invalid}`)
      process.exitCode = 1
      continue
    }
    if (dryRun) {
      report.repaired.push(`${sessionId}: ${changed} event(s) [dry-run]`)
      continue
    }
    const backup = `${artifact}.bak-${Date.now()}`
    renameSync(artifact, backup)
    const compressed = await zstdCompressAsync(Buffer.from(after, 'utf8'))
    const temporary = `${artifact}.${process.pid}.tmp`
    writeFileSync(temporary, compressed)
    renameSync(temporary, artifact)
    const reread = decodeFrames(readFileSync(artifact))
    if (firstInvalidEvent(reread) !== undefined || reread !== after) {
      console.error(`POST-WRITE VERIFY FAILED for ${sessionId}; original kept at ${backup}`)
      process.exitCode = 1
      continue
    }
    report.repaired.push(`${sessionId}: ${changed} event(s), backup ${backup}`)
  }
}

console.log(JSON.stringify({
  sessionsRoot,
  dryRun,
  scanned: report.scanned,
  clean: report.clean,
  repaired: report.repaired,
  invalidOther: report.invalidOther,
}, null, 2))
