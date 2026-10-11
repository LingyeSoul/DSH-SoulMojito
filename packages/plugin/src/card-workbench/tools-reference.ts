/**
 * 写卡工作台 · 参考文件域工具（决策 2026-10-11-workbench-reference-read）。
 *
 * 修的是「用户在 DSH 对话框给工作台上传参考文件，agent 读不了」：DSH 0.2.0 起
 * preset 的工具面按 plugins 行组合（standard preset 挂 dsh-tool-fs 等文件工具），
 * card-workbench preset 只挂本插件——两条在用附件管线都把读取责任压给
 * 「file tools」，而工作台没有：
 *  - 原生附件（dsh-attachment）：非图片文件按字节存 $DSH_HOME/attachments/v1/
 *    file-objects/<sha前2>/<sha>，消息里 FileBlock 在请求组装时投影为句柄文本
 *    「[File "名" (字节数, sha256:xx): verbatim read-only copy saved at "路径".
 *    Read that path with your file tools ...]」（dsh-llm fileHandleText）；
 *  - dsh-rider 暂存（bundle 插件，web profile 在装）：拖入文件落会话工作区
 *    <cwd>/.dsh/uploads/<时间戳>-<名>，发送时 agent/pre-step 注入「📎 名（大小）
 *    → .dsh/uploads/…」清单行 + 「需要时用文件工具按相对路径读取」指引。
 *
 * 为什么不挂宿主 dsh-tool-fs 了事：它没有只读配置，整包带来 write/edit——工作台
 * 的写入纪律是白名单 + 确认协议（提案 0013），任意路径写工具会绕过 card_put /
 * world_put 的方案确认门。自建 reference_read 把读取面收到两条附件管线的落盘
 * 根内，只读、分块（对齐 material_read 的 chunkIndex/maxChars 契约）、带二进制
 * 守卫（NUL 字节即拒，图片对象走 objects/ 子树，同理拒绝并提示附件面不支持）。
 *
 * 路径解析：相对路径以工作台专用工作区（$DSH_HOME/tavern/workbench，面板
 * ensureWorkbenchWorkspace 的注册 cwd）为基——dsh-rider 清单行给的就是该 cwd
 * 下的 .dsh/uploads/ 相对路径；绝对路径（原生句柄文本给的是宿主绝对路径，
 * 本地 fs 宿主 processPathFromHostPath 恒等映射）原样解析。包含性校验用
 * path.relative 幂等式（对齐 dsh-fs contains），win32 下大小写不敏感比对
 * （模型可能小写回显盘符）。越界路径明确报错并列出允许根，让模型转告用户
 * 「改走对话框附件」而不是静默失败。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { dshHomePath } from '../dsh-home.js'
import { stringArg } from '../tool-args.js'
import { objectOutput, tool, type ToolDefinition } from './shared.js'

/** 允许读取的两个落盘根（每次调用重取 dshHomePath——DSH_HOME 与 tavern 根
 *  在进程内不变，但测试逐用例换临时 home，缓存会在套件间串台）。 */
function referenceRoots(): string[] {
  return [
    dshHomePath('attachments', 'v1'),
    dshHomePath('tavern', 'workbench'),
  ]
}

/** 相对路径的解析基：工作台专用工作区（dsh-rider 清单行的 cwd 语义）。 */
function workbenchWorkspaceRoot(): string {
  return dshHomePath('tavern', 'workbench')
}

/** win32 下大小写不敏感的包含性判定：child === parent 或位于其下。 */
function isUnder(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (process.platform === 'win32') {
    const lowered = rel.toLowerCase()
    return !(lowered === '..' || lowered.startsWith(`..${path.sep}`))
  }
  return !(rel === '..' || rel.startsWith(`..${path.sep}`))
}

/** 解析传入路径并校验落在允许根内；越界抛错并列出允许根（模型可纠正的
 *  用法错误，不是 found:false 那种资源缺失）。 */
function resolveReferencePath(raw: string): string {
  const resolved = path.resolve(workbenchWorkspaceRoot(), raw.trim())
  const roots = referenceRoots()
  if (!roots.some((root) => isUnder(root, resolved))) {
    throw new Error(
      `reference path must stay inside the dialog-attachment roots (${roots.join(' or ')}); got '${raw}'. Ask the user to attach reference files through the DSH dialog instead of pasting paths from elsewhere.`,
    )
  }
  return resolved
}

/* ------------------------------ output schemas ------------------------------ */

const referenceReadOutput = objectOutput({
  found: { type: 'boolean' },
  path: { type: 'string' },
  chunkIndex: { type: 'number' },
  requestedChunkIndex: { type: 'number' },
  totalChunks: { type: 'number' },
  length: { type: 'number' },
  truncated: { type: 'boolean' },
  text: { type: 'string' },
}, ['chunkIndex', 'requestedChunkIndex', 'totalChunks', 'length', 'truncated', 'text'])

/* -------------------------------- 工具定义 -------------------------------- */

export const referenceTools: ToolDefinition[] = [
  tool('reference_read', 'Read one chunk of a reference file the user attached through the DSH dialog (decision 2026-10-11-workbench-reference-read). Attachment notes look like "📎 name（size）→ .dsh/uploads/<file>" (relative to the workbench workspace) or "[File "name" (N bytes, sha256:xx): verbatim read-only copy saved at "<absolute path>"]" — pass that path here. Only those attachment roots are readable; images and other binary files are rejected. chunkIndex defaults to 0 and is clamped into [0, totalChunks-1]; maxChars defaults to 2400 and is capped at 8000. Unknown files return found: false instead of throwing. Read chunk by chunk — never assume the whole file fits in one call.', {
    path: { type: 'string', required: true, description: 'Path from the attachment note: ".dsh/uploads/…" relative to the workbench workspace, or the absolute saved-copy path from a [File …] handle.' },
    chunkIndex: { type: 'integer', minimum: 0, description: 'Chunk to read (0-based); out-of-range values are clamped into range.' },
    maxChars: { type: 'integer', minimum: 1, maximum: 8000, description: 'Character budget for the returned text (default 2400, max 8000); longer chunks come back truncated.' },
  }, referenceReadOutput, async (args, exec) => {
    const rawPath = stringArg(args.path)
    let maxChars = 2400
    if (args.maxChars !== undefined) {
      if (typeof args.maxChars !== 'number' || !Number.isInteger(args.maxChars)) throw new Error('maxChars must be an integer')
      maxChars = Math.min(8000, Math.max(1, args.maxChars))
    }
    let requested = 0
    if (args.chunkIndex !== undefined) {
      if (typeof args.chunkIndex !== 'number' || !Number.isInteger(args.chunkIndex)) throw new Error('chunkIndex must be an integer')
      requested = args.chunkIndex
    }
    exec?.signal?.throwIfAborted()
    const resolved = resolveReferencePath(rawPath)
    let info
    try {
      info = await fs.stat(resolved)
    } catch {
      return { found: false, path: rawPath }
    }
    if (!info.isFile()) throw new Error(`reference path is not a regular file: '${rawPath}'`)
    const buffer = await fs.readFile(resolved)
    // 二进制守卫：文本参考里不该有 NUL；图片/压缩包落进来时给出可转述的拒绝
    // 而不是数 MB 乱码进上下文（原生图片对象在 attachments/v1/objects/ 下，
    // 同样被这条拦下）。
    if (buffer.includes(0)) {
      throw new Error(`reference file is binary (images and archives are not readable here): '${rawPath}'`)
    }
    let text = buffer.toString('utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const totalChunks = Math.max(1, Math.ceil(text.length / maxChars))
    const chunkIndex = Math.min(Math.max(requested, 0), totalChunks - 1)
    const chunk = text.slice(chunkIndex * maxChars, (chunkIndex + 1) * maxChars)
    return {
      found: true,
      path: rawPath,
      chunkIndex,
      ...(requested !== chunkIndex ? { requestedChunkIndex: requested } : {}),
      totalChunks,
      length: chunk.length,
      // 尾块恰好等于预算时不是截断——判据用「窗口之后还有内容」。
      truncated: (chunkIndex + 1) * maxChars < text.length,
      text: chunk,
    }
  }),
]
