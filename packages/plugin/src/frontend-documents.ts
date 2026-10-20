import type { ChatMessage } from '../../tavern-format/src/index.js'

/**
 * Complete-document detection for Tavern message frontends.
 *
 * The Web client's inline renderer (client-src/10-frontend-frame.js) owns the
 * same predicate. The right-sidebar surface needs it on the Node half so its
 * poll can transfer only the documents instead of the whole chat: long chats
 * run into megabytes, and a panel that refreshes every few seconds must not
 * re-ship them. Keep the two copies in lockstep — both accept a doctype
 * document, an <html> + <head|body> pair, or a bare <head|body> fragment, and
 * markdown fences win over the raw message.
 */
export interface FrontendMessage {
  index: number
  name: string
  isUser: boolean
  documents: string[]
}

const FENCED_DOCUMENT = /```[^\n]*\n([\s\S]*?)```/gi

export function isFrontendDocument(value: unknown): boolean {
  const text = typeof value === 'string' ? value : ''
  return /<!doctype\s+html\b/i.test(text)
    || (/<html(?:\s[^>]*)?>/i.test(text) && /<(?:head|body)(?:\s[^>]*)?>/i.test(text))
    || /<(?:head|body)(?:\s[^>]*)?>/i.test(text)
}

export function extractFrontendDocuments(value: unknown): string[] {
  const text = typeof value === 'string' ? value : ''
  const documents: string[] = []
  FENCED_DOCUMENT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FENCED_DOCUMENT.exec(text)) !== null) {
    const candidate = match[1].trim()
    if (isFrontendDocument(candidate)) documents.push(candidate)
  }
  if (documents.length > 0) return documents
  const raw = text.trim()
  return isFrontendDocument(raw) ? [raw] : []
}

/**
 * Latest saved message that carries at least one complete document. `render`
 * receives the display-layer text (markdownOnly regex scripts) so the sidebar
 * sees the same HTML the inline transcript would; the caller owns that
 * lookup, this module stays store-agnostic.
 */
export function latestFrontendMessage(
  messages: ChatMessage[],
  render: (message: ChatMessage, index: number) => string,
): FrontendMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.is_system === true) continue
    const documents = extractFrontendDocuments(render(message, index))
    if (documents.length === 0) continue
    return {
      index,
      name: typeof message.name === 'string' ? message.name : '',
      isUser: message.is_user === true,
      documents,
    }
  }
  return undefined
}
