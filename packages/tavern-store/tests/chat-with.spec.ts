/**
 * Chat write transaction seam (`TavernStore.withChat`).
 *
 * Pins the observable contract: every attempt reads a fresh snapshot and
 * re-applies the mutation to a clone, only CAS conflicts retry, the cached
 * snapshot and the chat file stay untouched when a save never lands, and an
 * invalid retry policy fails loudly instead of falling back to a default.
 */
import { promises as fsPromises } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChatLogIR } from '@dsh-soulmojito/format'
import { ChatRevisionConflictError, TavernStore } from '../src/index.js'

const CHARACTER = 'With Chat Char'

function chatLog(mes: string): ChatLogIR {
  return {
    header: {
      user_name: 'User',
      character_name: CHARACTER,
      chat_metadata: { variables: { seed: 1 } },
    },
    messages: [{ name: CHARACTER, is_user: false, is_system: false, send_date: 'now', mes }],
  }
}

async function withStore(run: (store: TavernStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tavern-chat-with-'))
  try {
    await run(await TavernStore.open(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function seedChat(store: TavernStore): Promise<string> {
  const log = chatLog('hello')
  return store.createChat(CHARACTER, log.header, log.messages)
}

describe('TavernStore.withChat', () => {
  it('applies the mutation and reports the revision of the persisted chat', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)

      const result = await store.withChat(CHARACTER, chatId, (chat) => {
        chat.header.chat_metadata.variables = { seed: 2, added: true }
        chat.messages.push({ name: 'User', is_user: true, is_system: false, send_date: 'now', mes: 'next' })
      }, { attempts: 1, delayMs: () => 0 })

      const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
      expect(snapshot?.chat).toEqual(result.chat)
      expect(snapshot?.revision).toBe(result.revision)
      expect(snapshot?.chat.header.chat_metadata.variables).toEqual({ seed: 2, added: true })
      expect(snapshot?.chat.messages.map((message) => message.mes)).toEqual(['hello', 'next'])
    })
  })

  it('re-reads and reapplies the mutation once after a CAS conflict', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)
      const original = store.saveChat.bind(store)
      let saveAttempts = 0
      const save = vi.spyOn(store, 'saveChat').mockImplementation(async (...args) => {
        saveAttempts += 1
        if (saveAttempts === 1) throw new ChatRevisionConflictError('stale', 'actual')
        return original(...args)
      })
      try {
        let mutations = 0
        const result = await store.withChat(CHARACTER, chatId, (chat) => {
          mutations += 1
          chat.header.chat_metadata.variables = { retried: mutations }
        }, { attempts: 3, delayMs: () => 0 })

        expect(saveAttempts).toBe(2)
        expect(mutations).toBe(2)
        expect(result.chat.header.chat_metadata.variables).toEqual({ retried: 2 })
        const snapshot = await store.getChatSnapshot(CHARACTER, chatId)
        expect(snapshot?.chat.header.chat_metadata.variables).toEqual({ retried: 2 })
      } finally {
        save.mockRestore()
      }
    })
  })

  it('propagates a mutation error without saving or retrying', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)
      const save = vi.spyOn(store, 'saveChat')
      try {
        await expect(store.withChat(CHARACTER, chatId, () => {
          throw new Error('mutation failed')
        }, { attempts: 3, delayMs: () => 0 })).rejects.toThrow('mutation failed')
        expect(save).not.toHaveBeenCalled()
      } finally {
        save.mockRestore()
      }
    })
  })

  it('propagates a non-conflict save error without retrying', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)
      const save = vi.spyOn(store, 'saveChat').mockRejectedValue(new Error('disk offline'))
      try {
        let mutations = 0
        await expect(store.withChat(CHARACTER, chatId, () => {
          mutations += 1
        }, { attempts: 3, delayMs: () => 0 })).rejects.toThrow('disk offline')
        expect(save).toHaveBeenCalledTimes(1)
        expect(mutations).toBe(1)
      } finally {
        save.mockRestore()
      }
    })
  })

  it('stops after the configured attempts and throws the last conflict', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)
      const conflicts: ChatRevisionConflictError[] = []
      const save = vi.spyOn(store, 'saveChat').mockImplementation(async () => {
        const conflict = new ChatRevisionConflictError(`stale-${conflicts.length}`, 'actual')
        conflicts.push(conflict)
        throw conflict
      })
      try {
        let mutations = 0
        const delays: number[] = []
        const failure = store.withChat(CHARACTER, chatId, () => {
          mutations += 1
        }, {
          attempts: 3,
          delayMs: (attempt) => {
            delays.push(attempt)
            return 0
          },
        })

        let thrown: unknown
        try {
          await failure
        } catch (error) {
          thrown = error
        }

        expect(thrown).toBe(conflicts[conflicts.length - 1])
        expect(save).toHaveBeenCalledTimes(3)
        expect(mutations).toBe(3)
        expect(delays).toEqual([0, 1])
      } finally {
        save.mockRestore()
      }
    })
  })

  it('leaves the previously read snapshot and the chat file untouched when every save conflicts', async () => {
    await withStore(async (store, dir) => {
      const chatId = await seedChat(store)
      const before = await store.getChatSnapshot(CHARACTER, chatId)
      expect(before).toBeDefined()
      const file = path.join(dir, 'chats', CHARACTER, chatId)
      const bytesBefore = await fsPromises.readFile(file)

      const save = vi.spyOn(store, 'saveChat').mockRejectedValue(new ChatRevisionConflictError('stale', 'actual'))
      try {
        await expect(store.withChat(CHARACTER, chatId, (chat) => {
          chat.header.chat_metadata.variables = { corrupted: true }
          chat.messages.push({ name: 'User', is_user: true, is_system: false, send_date: 'now', mes: 'leak' })
        }, { attempts: 2, delayMs: () => 0 })).rejects.toBeInstanceOf(ChatRevisionConflictError)
      } finally {
        save.mockRestore()
      }

      expect(before?.chat.header.chat_metadata.variables).toEqual({ seed: 1 })
      expect(before?.chat.messages.map((message) => message.mes)).toEqual(['hello'])
      const after = await store.getChatSnapshot(CHARACTER, chatId)
      expect(after).toEqual(before)
      expect((await fsPromises.readFile(file)).equals(bytesBefore)).toBe(true)
    })
  })

  it('fails clearly when the chat does not exist', async () => {
    await withStore(async (store) => {
      await expect(store.withChat(CHARACTER, 'missing.jsonl', () => {}, { attempts: 1, delayMs: () => 0 }))
        .rejects.toThrow("chat 'missing.jsonl' of character 'With Chat Char' not found")
    })
  })

  it('rejects an invalid retry policy before reading the chat', async () => {
    await withStore(async (store) => {
      const chatId = await seedChat(store)
      let mutations = 0
      const mutate = (): void => {
        mutations += 1
      }

      for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.withChat(CHARACTER, chatId, mutate, { attempts, delayMs: () => 0 }))
          .rejects.toThrow(`withChat attempts must be a positive safe integer; received ${String(attempts)}`)
      }
      for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(store.withChat(CHARACTER, chatId, mutate, { attempts: 1, delayMs: () => delay }))
          .rejects.toThrow(`withChat delayMs(0) must be a finite non-negative number; received ${String(delay)}`)
      }
      expect(mutations).toBe(0)
    })
  })
})
