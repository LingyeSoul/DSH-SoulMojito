/**
 * reference_read（决策 2026-10-11-workbench-reference-read）的域测试。
 *
 * 锁死的行为面：
 *  - 两条附件管线的路径形态都可读：dsh-rider 清单行的相对路径
 *    （.dsh/uploads/…，基是工作台专用工作区）与原生 DSH 0.2.0 句柄文本的
 *    绝对路径（$DSH_HOME/attachments/v1/file-objects/<前2>/<sha>）；
 *  - 分块契约与 material_read 同款：chunkIndex 钳制、requestedChunkIndex 回显、
 *    totalChunks / length / truncated，尾块恰好等于预算不算截断；
 *  - 只读纪律：越界路径（escape / 外部绝对路径）明确报错并列出允许根；
 *  - 二进制守卫（NUL 字节拒绝）、BOM 剥离、目录与缺失文件的处理。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/card-workbench/agent.js'

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<any>
}

const UPLOAD_TEXT = '风格参考'.repeat(1200) // 4800 字符 → 2 块（默认预算 2400）
const NATIVE_TEXT = '{"framework":"即堕母猪描写框架","version":"1.1"}'

describe('card workbench reference_read (dialog attachments)', () => {
  let home: string
  let tools: Map<string, RegisteredTool>
  let kernel: string
  let nativeObjectPath: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'workbench-reference-'))
    process.env.DSH_HOME = home
    // dsh-rider 暂存形态：<工作台工作区>/.dsh/uploads/<时间戳>-<名>
    const uploadsDir = join(home, 'tavern', 'workbench', '.dsh', 'uploads')
    mkdirSync(uploadsDir, { recursive: true })
    writeFileSync(join(uploadsDir, '261011-182040-文风2.0.txt'), UPLOAD_TEXT, 'utf8')
    writeFileSync(join(uploadsDir, '261011-182040-带BOM.txt'), '\ufeffBOM 前缀内容', 'utf8')
    writeFileSync(join(uploadsDir, '261011-182040-图片.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))
    // 原生附件形态：$DSH_HOME/attachments/v1/file-objects/<sha前2>/<sha>（内容寻址、无扩展名）
    nativeObjectPath = join(home, 'attachments', 'v1', 'file-objects', 'ab', 'ab12cd34')
    mkdirSync(join(home, 'attachments', 'v1', 'file-objects', 'ab'), { recursive: true })
    writeFileSync(nativeObjectPath, NATIVE_TEXT, 'utf8')

    tools = new Map()
    const sections: string[] = []
    apply({
      systemPrompt: { section: (section) => { sections.push(typeof section.text === 'string' ? section.text : section.text()) } },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
    kernel = sections.join('\n')
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('kernel tells the model to read attachment notes with reference_read', () => {
    expect(kernel).toContain('reference_read')
    expect(kernel).toContain('.dsh/uploads/')
    expect(kernel).toContain('verbatim read-only copy saved at')
  })

  it('reads a dsh-rider style relative uploads path', async () => {
    const tool = tools.get('reference_read')!
    const result = await tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt' })
    expect(result.found).toBe(true)
    expect(result.text).toBe(UPLOAD_TEXT.slice(0, 2400))
    expect(result.totalChunks).toBe(2)
    expect(result.chunkIndex).toBe(0)
    expect(result.truncated).toBe(true)
  })

  it('reads a native DSH 0.2.0 absolute file-objects path', async () => {
    const tool = tools.get('reference_read')!
    const result = await tool.execute({ path: nativeObjectPath })
    expect(result.found).toBe(true)
    expect(result.text).toBe(NATIVE_TEXT)
    expect(result.totalChunks).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('clamps chunkIndex, echoes the request and reads the tail chunk', async () => {
    const tool = tools.get('reference_read')!
    const tail = await tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', chunkIndex: 1 })
    expect(tail.chunkIndex).toBe(1)
    expect(tail.text).toBe(UPLOAD_TEXT.slice(2400))
    expect(tail.truncated).toBe(false)
    const clamped = await tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', chunkIndex: 99 })
    expect(clamped.chunkIndex).toBe(1)
    expect(clamped.requestedChunkIndex).toBe(99)
    // 首块不带 requestedChunkIndex（钳制不发生时不回显）。
    expect(await (async () => { const r = await tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', chunkIndex: 0 }); return r.requestedChunkIndex })()).toBeUndefined()
  })

  it('honours maxChars with an exact-budget tail not marked truncated', async () => {
    const tool = tools.get('reference_read')!
    const result = await tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', maxChars: 4800 })
    expect(result.totalChunks).toBe(1)
    expect(result.text).toBe(UPLOAD_TEXT)
    expect(result.truncated).toBe(false)
  })

  it('strips a UTF-8 BOM before chunking', async () => {
    const tool = tools.get('reference_read')!
    const result = await tool.execute({ path: '.dsh/uploads/261011-182040-带BOM.txt' })
    expect(result.text.startsWith('\ufeff')).toBe(false)
    expect(result.text).toBe('BOM 前缀内容')
  })

  it('rejects binary attachments with an actionable message', async () => {
    const tool = tools.get('reference_read')!
    await expect(tool.execute({ path: '.dsh/uploads/261011-182040-图片.png' })).rejects.toThrow(/binary/)
  })

  it('returns found: false for missing files instead of throwing', async () => {
    const tool = tools.get('reference_read')!
    const result = await tool.execute({ path: '.dsh/uploads/261011-000000-不存在.txt' })
    expect(result).toEqual({ found: false, path: '.dsh/uploads/261011-000000-不存在.txt' })
  })

  it('refuses paths outside the attachment roots, listing them', async () => {
    const tool = tools.get('reference_read')!
    await expect(tool.execute({ path: '../../secret.txt' })).rejects.toThrow(/attachment roots/)
    // 盘符绝对路径仅在 win32 上是外部绝对路径；posix 下它只是工作区内的怪文件名。
    if (process.platform === 'win32') {
      await expect(tool.execute({ path: 'C:\\Windows\\win.ini' })).rejects.toThrow(/attachment roots/)
    } else {
      await expect(tool.execute({ path: '/etc/passwd' })).rejects.toThrow(/attachment roots/)
    }
  })

  it('refuses directories with a regular-file error', async () => {
    const tool = tools.get('reference_read')!
    await expect(tool.execute({ path: '.dsh/uploads' })).rejects.toThrow(/not a regular file/)
  })

  it('validates chunkIndex / maxChars argument types', async () => {
    const tool = tools.get('reference_read')!
    await expect(tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', chunkIndex: 'x' })).rejects.toThrow('chunkIndex must be an integer')
    await expect(tool.execute({ path: '.dsh/uploads/261011-182040-文风2.0.txt', maxChars: 1.5 })).rejects.toThrow('maxChars must be an integer')
    await expect(tool.execute({ path: '  ' })).rejects.toThrow('string argument is required')
  })
})
