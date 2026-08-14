/**
 * ST 聊天文件（jsonl）：首行 header，其后每行一条消息（含 swipes 系字段）。
 */

import type { ChatHeader, ChatLogIR, ChatMessage } from './types.js'

export class ChatFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatFormatError'
  }
}

export function parseChatLog(text: string): ChatLogIR {
  const lines = text.split('\n')
  let header: ChatHeader | undefined
  const messages: ChatMessage[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length === 0) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch (cause) {
      throw new ChatFormatError(`line ${i + 1} is not valid JSON: ${String(cause)}`)
    }
    if (typeof obj !== 'object' || obj === null) throw new ChatFormatError(`line ${i + 1} is not an object`)
    if (header === undefined) header = obj as ChatHeader
    else messages.push(obj as ChatMessage)
  }
  if (header === undefined) throw new ChatFormatError('chat log is empty')
  return { header, messages }
}

export function serializeChatLog(ir: ChatLogIR): string {
  const lines = [JSON.stringify(ir.header), ...ir.messages.map((m) => JSON.stringify(m))]
  return lines.join('\n') + '\n'
}
