/**
 * 美化前端右栏（2026-10-20）的服务端抽取：客户端内联渲染器
 * （client-src/10-frontend-frame.js）与这里的判定必须同构——这里只做 Node
 * 侧的「最新一条带完整 HTML 的楼层」扫描，避免 5s 轮询回传整份聊天。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../tavern-format/src/index.js'
import { extractFrontendDocuments, isFrontendDocument, latestFrontendMessage, stripFrontendDocuments } from '../src/frontend-documents.js'

function message(patch: Partial<ChatMessage>): ChatMessage {
  return { name: 'Character', is_user: false, is_system: false, send_date: '', mes: '', ...patch }
}

describe('frontend document extraction', () => {
  it('accepts a doctype document, an html pair, and bare head/body fragments', () => {
    expect(isFrontendDocument('<!doctype html><html><body>x</body></html>')).toBe(true)
    expect(isFrontendDocument('<html><head></head><body>x</body></html>')).toBe(true)
    expect(isFrontendDocument('<body><div>x</div></body>')).toBe(true)
    expect(isFrontendDocument('ordinary prose with a <body> mention')).toBe(true)
    expect(isFrontendDocument('just prose')).toBe(false)
    expect(isFrontendDocument(undefined)).toBe(false)
  })

  it('prefers complete documents inside markdown fences', () => {
    const text = [
      'Here is the panel:',
      '```html',
      '<!doctype html><html><body><div id="hud">HP</div></body></html>',
      '```',
      '```js',
      'console.log(1)',
      '```',
    ].join('\n')
    expect(extractFrontendDocuments(text)).toEqual(['<!doctype html><html><body><div id="hud">HP</div></body></html>'])
  })

  it('falls back to the raw message when no fence carries a document', () => {
    const raw = '<!doctype html><html><body><p>raw</p></body></html>'
    expect(extractFrontendDocuments(`\n${raw}\n`)).toEqual([raw])
  })

  it('returns no documents for prose or partial streaming output', () => {
    expect(extractFrontendDocuments('The hero draws a blade.')).toEqual([])
    expect(extractFrontendDocuments('<div class="half">')).toEqual([])
  })

  it('strips complete documents from the native conversation text but keeps prose', () => {
    const text = [
      'The hero draws a blade.',
      '```html',
      '<!doctype html><html><body><div id="hud">HP</div></body></html>',
      '```',
      '```js',
      'console.log(1)',
      '```',
      '</UpdateVariable><StatusPlaceHolderImpl/>',
    ].join('\n')
    expect(stripFrontendDocuments(text)).toBe('The hero draws a blade.\n\n```js\nconsole.log(1)\n```')
  })

  it('returns empty when the whole message is a document and removes MVU blocks', () => {
    expect(stripFrontendDocuments('<body>only hud</body>')).toBe('')
    expect(stripFrontendDocuments('prose\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>\n<StatusPlaceHolderREADY/>')).toBe('prose')
  })
})

describe('latest frontend message', () => {
  it('scans newest-first and keeps the message index for the floor label', () => {
    const messages = [
      message({ name: 'Old', mes: '<body>old</body>' }),
      message({ name: 'User', is_user: true, mes: 'hello' }),
      message({ name: 'New', mes: '```html\n<!doctype html><html><body>new</body></html>\n```' }),
      message({ name: 'Latest', mes: 'plain reply' }),
    ]
    expect(latestFrontendMessage(messages, (entry) => entry.mes)).toEqual({
      index: 2,
      name: 'New',
      isUser: false,
      documents: ['<!doctype html><html><body>new</body></html>'],
    })
  })

  it('renders through the display-layer callback (markdownOnly scripts)', () => {
    const messages = [message({ name: 'Char', mes: 'RAW' })]
    const found = latestFrontendMessage(messages, () => '<body>rendered</body>')
    expect(found?.documents).toEqual(['<body>rendered</body>'])
  })

  it('skips system messages and returns undefined when nothing matches', () => {
    const messages = [
      message({ name: 'System', is_system: true, mes: '<body>hidden</body>' }),
      message({ name: 'Char', mes: 'prose' }),
    ]
    expect(latestFrontendMessage(messages, (entry) => entry.mes)).toBeUndefined()
  })
})
