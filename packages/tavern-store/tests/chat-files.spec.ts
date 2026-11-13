/**
 * 聊天文件身份/存档语义（契约 2026-11-12 §2.5 的格式层）。
 *
 * 这里覆盖两件事：
 * 1. `@dsh-soulmojito/format` 的聊天文件辅助（id 命名、复制定名、checkpoint
 *    谱系、首楼开场白切换、导入形状校验）——路由层不做这些判断；
 * 2. 路由层组合的 store 原语序列：`createChat` 生成时间戳 id 后 `renameChat`
 *    改名到目标 id。这是“按指定名字导入/存档”的唯一现成路径（store 没有按 id
 *    创建的入口），改名失败会留下临时聊天，所以序列本身要被锁住。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyGreetingSwipe,
  chatDisplayName,
  chatIdOf,
  chatStem,
  freeChatId,
  parseChatLog,
  parseImportedChatLog,
  readCheckpointParent,
  serializeChatLog,
  toCheckpoint,
  toDuplicate,
  type ChatLogIR,
} from '../../tavern-format/src/index.js'
import { TavernStore } from '../src/index.js'

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Chat File Char', description: 'd', personality: 'p', scenario: 's', first_mes: 'hi',
    mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
    alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {},
  },
}

function sampleLog(): ChatLogIR {
  return {
    header: {
      user_name: 'unused',
      character_name: 'unused',
      chat_metadata: { bookmark_link: { character: 'Chat File Char', chatId: 'parent.jsonl', messageId: 0 } },
    },
    messages: [
      {
        name: 'Chat File Char', is_user: false, is_system: false, send_date: '2026-11-12 10:00',
        mes: 'opening one', swipe_id: 0, swipes: ['opening one', 'opening two'], swipe_info: [{ send_date: 'a' }, { send_date: 'b' }],
      },
      { name: 'User', is_user: true, is_system: false, send_date: '2026-11-12 10:01', mes: 'reply one' },
      { name: 'Chat File Char', is_user: false, is_system: false, send_date: '2026-11-12 10:02', mes: 'reply two' },
    ],
  }
}

describe('聊天文件 id 与命名', () => {
  it('补扩展名并把名字收敛成 store 认可的 id', () => {
    expect(chatIdOf('Scene 1')).toBe('Scene 1.jsonl')
    expect(chatIdOf('Scene 1.jsonl')).toBe('Scene 1.jsonl')
    expect(chatIdOf('  Scene 1  ')).toBe('Scene 1.jsonl')
    expect(chatDisplayName('Scene 1.jsonl')).toBe('Scene 1')
    // 中文/斜杠/`#` 都不在 store 的 id 字符集内：明确报错，不静默改名。
    expect(() => chatIdOf('场景 1')).toThrow()
    expect(() => chatIdOf('a/b')).toThrow()
    expect(() => chatIdOf('../escape')).toThrow()
    expect(() => chatIdOf('   ')).toThrow()
  })

  it('派生 id 按 N 递增到不冲突', () => {
    const stem = '2026-11-12@10h 00m 00s 000ms'
    expect(freeChatId([], stem, 'checkpoint')).toBe(`${stem} - checkpoint 1.jsonl`)
    expect(freeChatId([`${stem} - checkpoint 1.jsonl`], stem, 'checkpoint')).toBe(`${stem} - checkpoint 2.jsonl`)
    expect(chatStem('Scene: 1.jsonl')).toBe('Scene_ 1')
    expect(chatStem('.jsonl')).toBe('chat')
  })
})

describe('整聊复制与 checkpoint 日志', () => {
  it('复制保留全部消息但不带 bookmark_link', () => {
    const source = sampleLog()
    const copy = toDuplicate(source)
    expect(copy.messages).toEqual(source.messages)
    expect(copy.header.chat_metadata['bookmark_link']).toBeUndefined()
    // 深拷贝：改副本不动源。
    copy.messages[0]!.mes = 'mutated'
    expect(source.messages[0]!.mes).toBe('opening one')
    expect(source.header.chat_metadata['bookmark_link']).toBeDefined()
  })

  it('checkpoint 复制 0..messageId 并写谱系头', () => {
    const parent = { character: 'Chat File Char', chatId: '2026-11-12@10h 00m 00s 000ms.jsonl' }
    const partial = toCheckpoint(sampleLog(), parent, 1)
    expect(partial.messageId).toBe(1)
    expect(partial.log.messages.length).toBe(2)
    expect(readCheckpointParent(partial.log.header)).toEqual({ ...parent, messageId: 1 })

    const whole = toCheckpoint(sampleLog(), parent)
    expect(whole.messageId).toBe(2)
    expect(whole.log.messages.length).toBe(3)
    expect(readCheckpointParent(whole.log.header)).toEqual({ ...parent, messageId: 2 })

    expect(() => toCheckpoint(sampleLog(), parent, 3)).toThrow(/out of range/)

    const empty = toCheckpoint({ header: sampleLog().header, messages: [] }, parent)
    expect(empty.messageId).toBe(-1)
    expect(empty.log.messages).toEqual([])
    expect(readCheckpointParent(empty.log.header)?.messageId).toBe(-1)
  })

  it('没有谱系头的普通聊天不算 checkpoint', () => {
    expect(readCheckpointParent(sampleLog().header)).toBeUndefined()
    const legacy: ChatLogIR = { header: { user_name: 'u', character_name: 'c', chat_metadata: {} }, messages: [] }
    expect(readCheckpointParent(legacy.header)).toBeUndefined()
  })
})

describe('首楼开场白切换', () => {
  it('只改 swipe_id 与 mes', () => {
    const { log, mes } = applyGreetingSwipe(sampleLog(), 1)
    expect(mes).toBe('opening two')
    expect(log.messages[0]!['swipe_id']).toBe(1)
    expect(log.messages[0]!['mes']).toBe('opening two')
    expect(log.messages[0]!['swipes']).toEqual(['opening one', 'opening two'])
    expect(log.messages.length).toBe(3)
    // 源日志不被改写。
    expect(sampleLog().messages[0]!['swipe_id']).toBe(0)
  })

  it('越界/无 swipe 池/首楼是用户楼都报错', () => {
    expect(() => applyGreetingSwipe(sampleLog(), 2)).toThrow(/out of range/)
    expect(() => applyGreetingSwipe(sampleLog(), -1)).toThrow(/out of range/)
    expect(() => applyGreetingSwipe({
      header: sampleLog().header,
      messages: [{ name: 'User', is_user: true, is_system: false, send_date: 'x', mes: 'mine' }],
    }, 0)).toThrow(/user message/)
    expect(() => applyGreetingSwipe({
      header: sampleLog().header,
      messages: [{ name: 'Chat File Char', is_user: false, is_system: false, send_date: 'x', mes: 'only' }],
    }, 0)).toThrow(/no alternate greetings/)
    expect(() => applyGreetingSwipe({ header: sampleLog().header, messages: [] }, 0)).toThrow(/no opening message/)
  })
})

describe('导入形状校验', () => {
  it('接受合法 JSONL 并与宽松解析一致', () => {
    const text = serializeChatLog(sampleLog())
    expect(parseImportedChatLog(text)).toEqual(parseChatLog(text))
  })

  it('容忍 CRLF 行尾与 UTF-8 BOM（外部文件在 Windows 编辑器里存过）', () => {
    const text = serializeChatLog(sampleLog())
    const crlf = `\uFEFF${text.replaceAll('\n', '\r\n')}`
    expect(parseImportedChatLog(crlf)).toEqual(parseChatLog(text))
  })

  it('拒绝缺 mes 的消息、非对象 header 与坏 JSON', () => {
    const header = JSON.stringify({ user_name: 'u', character_name: 'c', chat_metadata: {} })
    expect(() => parseImportedChatLog(`${header}\n${JSON.stringify({ name: 'User', mes: 3 })}\n`)).toThrow(/mes/)
    expect(() => parseImportedChatLog('[1,2,3]\n')).toThrow(/header/)
    expect(() => parseImportedChatLog(`${header}\nnope\n`)).toThrow(/not valid JSON/)
    expect(() => parseImportedChatLog(`${JSON.stringify({ user_name: 7 })}\n`)).toThrow(/user_name/)
  })
})

describe('按指定 id 落聊天文件（路由层的 store 原语序列）', () => {
  it('createChat + renameChat 落到目标 id，内容与改名前的字节一致', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tavern-chat-file-'))
    try {
      const store = await TavernStore.open(dir)
      await store.importCharacter(CARD)
      const log = sampleLog()
      const createdId = await store.createChat(CARD.data.name, log.header, log.messages)
      expect(createdId).toMatch(/\.jsonl$/)
      const target = 'Scene 1.jsonl'
      await store.renameChat(CARD.data.name, createdId, target)

      const chats = await store.listChats(CARD.data.name)
      expect(chats).toEqual([target])
      const snapshot = await store.getChatSnapshot(CARD.data.name, target)
      expect(snapshot?.chat.messages.map((message) => message.mes)).toEqual(['opening one', 'reply one', 'reply two'])
      expect(snapshot?.chat.header.chat_metadata['bookmark_link']).toBeDefined()
      // renameChat 拒绝已存在的目标：重名不覆盖由这条底层保证。
      await expect(store.renameChat(CARD.data.name, createdId, target)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('store 拒绝字符集外的聊天 id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tavern-chat-file-'))
    try {
      const store = await TavernStore.open(dir)
      await store.importCharacter(CARD)
      const log = sampleLog()
      await expect(store.createChat(CARD.data.name, log.header, log.messages)
        .then((id) => store.renameChat(CARD.data.name, id, 'bad/name.jsonl')))
        .rejects.toThrow(/invalid chat id/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
