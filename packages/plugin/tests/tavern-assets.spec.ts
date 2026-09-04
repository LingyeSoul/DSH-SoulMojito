import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectWorldInfoBooks } from '../src/tavern-assets.js'
import { decodeCharacterCard } from '../../tavern-format/src/index.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const CHARACTER = 'Carrier'

describe('collectWorldInfoBooks', () => {
  let home: string
  let store: TavernStore

  const characterCard = (extensions: Record<string, unknown>) => decodeCharacterCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: CHARACTER, description: '', personality: '', scenario: '', first_mes: '',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '',
      character_book: {
        entries: [
          { id: 0, keys: [], content: 'embedded constant lore', enabled: true, insertion_order: 100, constant: true },
        ],
      },
      extensions,
    },
  })

  function booksFor(extensions: Record<string, unknown>, activeWorlds: string[] = []) {
    return collectWorldInfoBooks(store, { activeWorlds }, CHARACTER, { card: characterCard(extensions) })
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'tavern-assets-'))
    process.env.DSH_HOME = home
    store = await TavernStore.open(join(home, 'tavern'))
    await store.importWorldFile('Linked Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: '', content: 'linked lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
    await store.importWorldFile('Active Lore', {
      entries: {
        '0': { uid: 0, key: [], keysecondary: [], comment: '', content: 'active lore', constant: true, selective: false, order: 100, position: 0, disable: false },
      },
    })
  })

  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('链接世界已导入时只保留世界书文件，不叠加内嵌书', async () => {
    const books = await booksFor({ world: 'Linked Lore' }, ['Active Lore'])
    expect(books.map((book) => book.name).sort()).toEqual(['Active Lore', 'Linked Lore'])
  })

  it('链接世界缺失时回退到卡内嵌书', async () => {
    const books = await booksFor({ world: 'Missing Lore' })
    expect(books).toHaveLength(1)
    expect(books[0]?.name).toBe(`${CHARACTER}:embedded`)
    expect(books[0]?.entries[0]?.content).toBe('embedded constant lore')
  })

  it('无链接时同样回退到卡内嵌书', async () => {
    const books = await booksFor({})
    expect(books).toHaveLength(1)
    expect(books[0]?.name).toBe(`${CHARACTER}:embedded`)
  })

  it('activeWorlds 中的世界书照常并入', async () => {
    const books = await booksFor({}, ['Active Lore'])
    expect(books.map((book) => book.name)).toEqual([`${CHARACTER}:embedded`, 'Active Lore'])
  })
})
