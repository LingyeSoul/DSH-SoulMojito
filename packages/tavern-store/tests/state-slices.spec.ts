/**
 * state.json 大表切片契约（决策 2026-11-01-tavern-state-asset-split）。
 *
 * `state.json` 只留轻量键，`regexScripts`（+ 两张归属表）落 `regex-scripts.json`，
 * `frontendStorage` 落 `frontend-storage.json`。这些测试钉住可观察契约：
 * 存量单文件能直接读出、**读路径永不写盘**（只读盘也能读）、首次写完成迁移、
 * 迁移与重复写幂等、切片存在时 state.json 里的同名大表被忽略（升级窗口，已知
 * 且不自动修复）、外部手改切片能被指纹发现、切片写失败时 state.json 保持旧内容、
 * 没有 state.json 时返回值的键集合与改动前一致。
 *
 * 切片是否被碰过用「把 mtime 钉到过去再看它变没变」判定：只比较两次自然的
 * mtime 会在同一毫秒内落盘时抖动，而钉死的旧时间与「刚刚写入」永远可区分。
 */
import { promises as fsPromises } from 'node:fs'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TavernStore } from '../src/index.js'

const PINNED_MTIME = new Date('2001-02-03T04:05:06.000Z')

const SCRIPT_COUNT = 129
const STORAGE_CHARACTER_COUNT = 4

/**
 * 改动前 `DEFAULT_STATE` 的 own-key 集合（store.ts）。盘上没有 state.json 时
 * `getState()` 必须原样返回这份形状：键集合属于对外契约，新增默认键要同时改这里。
 * 尤其 `compaction`/`memoryEmbedding` 不能以「值为 undefined 的 own key」出现——
 * JSON 看不见，`Object.keys` 看得见。
 */
const PRE_SPLIT_DEFAULT_STATE_KEYS = [
  'activeWorlds',
  'agentContextInjection',
  'agentNovelPresetEnabled',
  'agentTavernAllowGlobalWrites',
  'agentTavernPreloadAssets',
  'cardScriptsAutoRun',
  'cardWorkbenchPresetEnabled',
  'characterFavorites',
  'characterVariables',
  'chats',
  'defaultArchitecture',
  'defaultContextMode',
  'disabledAutoWorlds',
  'frontendAllowExternalResources',
  'frontendAutoOpen',
  'frontendStorage',
  'gamesDisableResign',
  'imAccountOwners',
  'imOwners',
  'imPeers',
  'imPendingPeers',
  'imSenders',
  'imSettings',
  'modelSelections',
  'mods',
  'modsEnabled',
  'quickReplies',
  'quickRepliesEnabled',
  'regexScripts',
  'scriptGlobals',
  'sessionBindings',
  'worldFollowsCharacter',
  'worldInfoSettings',
]

async function withStore(run: (store: TavernStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tavern-state-slices-'))
  try {
    await run(await TavernStore.open(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** One script per index, shaped like the materialized ST regex entries. */
function legacyScripts(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    id: `legacy-${index}`,
    scriptName: `Legacy ${index}`,
    findRegex: `find ${index}`,
    replaceString: `replace ${index}`,
  }))
}

function legacyOwners(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`legacy-${index}`, 'Legacy Char']))
}

function legacyFrontendStorage(count: number): Record<string, Record<string, string>> {
  return Object.fromEntries(Array.from(
    { length: count },
    (_, index) => [`Character ${index}`, { theme: 'dark', volume: `0.${index}` }],
  ))
}

/** The pre-split shape: one state.json carrying both large tables. */
function legacyState(): Record<string, unknown> {
  return {
    activeCharacter: 'Legacy Char',
    activeWorlds: ['Legacy World'],
    sessionBindings: { session_1: { character: 'Legacy Char', chatId: 'chat.jsonl' } },
    scriptGlobals: { mood: 'calm' },
    regexScripts: legacyScripts(SCRIPT_COUNT),
    regexScriptOwners: legacyOwners(SCRIPT_COUNT),
    frontendStorage: legacyFrontendStorage(STORAGE_CHARACTER_COUNT),
  }
}

function stateFile(dir: string): string {
  return path.join(dir, 'state.json')
}

function regexFile(dir: string): string {
  return path.join(dir, 'regex-scripts.json')
}

function frontendFile(dir: string): string {
  return path.join(dir, 'frontend-storage.json')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/** True when the file exists; a missing file is `false`, not an error. */
async function exists(file: string): Promise<boolean> {
  return await stat(file).then(() => true, () => false)
}

/** Pins mtime so "rewritten" and "untouched" stay distinguishable at any clock speed. */
async function pinMtime(file: string): Promise<void> {
  await utimes(file, PINNED_MTIME, PINNED_MTIME)
}

async function mtimeOf(file: string): Promise<number> {
  return (await stat(file)).mtimeMs
}

describe('state.json 切片布局', () => {
  it('存量大 state.json：读出的正则条目、归属与前端存储键与文件完全一致', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))

    const state = await store.getState()
    expect(state.regexScripts).toHaveLength(SCRIPT_COUNT)
    expect(state.regexScripts.at(-1)?.scriptName).toBe(`Legacy ${SCRIPT_COUNT - 1}`)
    expect(Object.keys(state.regexScriptOwners ?? {})).toHaveLength(SCRIPT_COUNT)
    expect(state.regexScriptOwners?.['legacy-7']).toBe('Legacy Char')
    expect(Object.keys(state.frontendStorage ?? {})).toHaveLength(STORAGE_CHARACTER_COUNT)
    expect(state.frontendStorage?.['Character 2']).toEqual({ theme: 'dark', volume: '0.2' })
    // 轻量键同一份读取里照旧可用，切片只搬位置不改形状。
    expect(state.activeCharacter).toBe('Legacy Char')
    expect(state.activeWorlds).toEqual(['Legacy World'])
    expect(state.scriptGlobals).toEqual({ mood: 'calm' })
    expect(state.sessionBindings['session_1']).toEqual({
      architecture: 'st',
      character: 'Legacy Char',
      chatId: 'chat.jsonl',
    })
  }))

  it('存量单文件：getState 只读不写——字节、mtime 不变，切片文件一个都不建', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    const before = await readFile(stateFile(dir))
    await pinMtime(stateFile(dir))

    // 冷读一次 + 热读一次：都不许碰盘。
    const cold = await store.getState()
    const warm = await store.getState()

    expect(cold.regexScripts).toHaveLength(SCRIPT_COUNT)
    expect(warm).toBe(cold)
    expect(await readFile(stateFile(dir))).toEqual(before)
    expect(await mtimeOf(stateFile(dir))).toBe(PINNED_MTIME.getTime())
    expect(await exists(regexFile(dir))).toBe(false)
    expect(await exists(frontendFile(dir))).toBe(false)
  }))

  it('首次写触发迁移：切片出现、state.json 去大表，之后的读不再改盘', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))

    // 迁移发生在第一次写盘（读路径不迁移）。
    const migrated = await store.updateState((state) => ({ scriptGlobals: { ...state.scriptGlobals, mood: 'busy' } }))

    const light = await readJson(stateFile(dir))
    for (const key of ['regexScripts', 'regexScriptOwners', 'regexScriptPresetOwners', 'frontendStorage']) {
      expect(hasKey(light, key)).toBe(false)
    }
    const regexSlice = await readJson(regexFile(dir))
    expect(regexSlice['version']).toBe(1)
    expect(regexSlice['regexScripts']).toHaveLength(SCRIPT_COUNT)
    const frontendSlice = await readJson(frontendFile(dir))
    expect(frontendSlice['version']).toBe(1)
    expect(Object.keys(frontendSlice['frontendStorage'] as Record<string, unknown>)).toHaveLength(STORAGE_CHARACTER_COUNT)

    // 迁移后是纯读缓存：再读既不改值也不改盘。
    await pinMtime(stateFile(dir))
    await pinMtime(regexFile(dir))
    await pinMtime(frontendFile(dir))
    const second = await store.getState()
    const third = await store.getState()
    expect(second).toEqual(migrated)
    expect(third).toBe(second)
    expect(await mtimeOf(stateFile(dir))).toBe(PINNED_MTIME.getTime())
    expect(await mtimeOf(regexFile(dir))).toBe(PINNED_MTIME.getTime())
    expect(await mtimeOf(frontendFile(dir))).toBe(PINNED_MTIME.getTime())
  }))

  it('迁移幂等：同一份值再写一次，三份文件的字节逐字节一致', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    await store.updateState((state) => ({ scriptGlobals: { ...state.scriptGlobals, mood: 'busy' } }))
    const first = {
      state: await readFile(stateFile(dir)),
      regex: await readFile(regexFile(dir)),
      frontend: await readFile(frontendFile(dir)),
    }

    // 同样的值再写一遍（引用全新，强制三份文件全部重写）：落盘字节由值决定，
    // 没有计数器、没有时间戳，所以必须逐字节相同。
    await store.updateState((state) => ({
      regexScripts: [...state.regexScripts],
      frontendStorage: { ...state.frontendStorage },
    }))

    expect(await readFile(stateFile(dir))).toEqual(first.state)
    expect(await readFile(regexFile(dir))).toEqual(first.regex)
    expect(await readFile(frontendFile(dir))).toEqual(first.frontend)
    const state = await store.getState()
    expect(state.regexScripts).toHaveLength(SCRIPT_COUNT)
    expect(Object.keys(state.frontendStorage ?? {})).toHaveLength(STORAGE_CHARACTER_COUNT)
  }))

  it('只改轻量键：state.json 重写，两个切片文件的 mtime 不变', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    // 先迁移（迁移本身必须发生在写路径上），再钉 mtime 观察后续轻量写。
    await store.updateState(() => ({}))
    await pinMtime(stateFile(dir))
    await pinMtime(regexFile(dir))
    await pinMtime(frontendFile(dir))

    await store.updateState((state) => ({ scriptGlobals: { ...state.scriptGlobals, mood: 'happy' } }))

    expect(await mtimeOf(stateFile(dir))).not.toBe(PINNED_MTIME.getTime())
    expect((await readJson(stateFile(dir)))['scriptGlobals']).toEqual({ mood: 'happy' })
    expect(await mtimeOf(regexFile(dir))).toBe(PINNED_MTIME.getTime())
    expect(await mtimeOf(frontendFile(dir))).toBe(PINNED_MTIME.getTime())
    // 只写小文件不等于丢数据：切片内容原样还在。
    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(SCRIPT_COUNT)
  }))

  it('只改 regexScripts：前端切片不被碰，state.json 重写且仍不含大表', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    await store.updateState(() => ({}))
    await pinMtime(stateFile(dir))
    await pinMtime(regexFile(dir))
    await pinMtime(frontendFile(dir))

    const replacement = [{ id: 'only-one', scriptName: 'Only One', findRegex: 'x', replaceString: 'y' }]
    await store.replaceRegexScripts(replacement)

    expect(await mtimeOf(regexFile(dir))).not.toBe(PINNED_MTIME.getTime())
    expect(await mtimeOf(frontendFile(dir))).toBe(PINNED_MTIME.getTime())
    // state.json 每次都写（它是提交点），但只带轻量键。
    expect(await mtimeOf(stateFile(dir))).not.toBe(PINNED_MTIME.getTime())
    const light = await readJson(stateFile(dir))
    expect(hasKey(light, 'regexScripts')).toBe(false)
    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(1)
    expect((await store.getState()).regexScripts).toHaveLength(1)
  }))

  it('外部手改切片文件后，下一次 getState 读到新值（指纹失效）', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    expect((await store.getState()).regexScripts).toHaveLength(SCRIPT_COUNT)
    expect((await store.getState()).regexScripts).toHaveLength(SCRIPT_COUNT)

    const edited = { version: 1, regexScripts: legacyScripts(3), regexScriptOwners: legacyOwners(3) }
    await writeFile(regexFile(dir), JSON.stringify(edited))

    const reread = await store.getState()
    expect(reread.regexScripts).toHaveLength(3)
    expect(reread.regexScripts.map((script) => script.scriptName)).toEqual(['Legacy 0', 'Legacy 1', 'Legacy 2'])
  }))

  it('契约：切片存在时 state.json 里的同名大表被忽略（升级窗口，不合并）', withStore(async (store, dir) => {
    // 旧版本进程写回的大表与新布局的切片同时存在：字节上与「迁移崩在切片已写、
    // state.json 未写」不可区分，所以规则固定为切片优先，绝不合并。
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    await writeFile(regexFile(dir), JSON.stringify({
      version: 1,
      regexScripts: legacyScripts(3),
      regexScriptOwners: legacyOwners(3),
    }))

    const state = await store.getState()
    expect(state.regexScripts).toHaveLength(3)
    expect(Object.keys(state.regexScriptOwners ?? {})).toHaveLength(3)
    // 没有切片的大表仍然从 state.json 读：切片只接管自己那一组键。
    expect(Object.keys(state.frontendStorage ?? {})).toHaveLength(STORAGE_CHARACTER_COUNT)

    // 读不落盘：state.json 里那 129 条旧值还在盘上。
    expect(hasKey(await readJson(stateFile(dir)), 'regexScripts')).toBe(true)

    // 下一次写按切片优先收尾：只存在于 state.json 的另外 126 条被丢弃。这是
    // 已知且不可自动修复的窗口，运维规则是升级前先停旧版本进程（见决策文档）。
    await store.updateState(() => ({}))
    expect(hasKey(await readJson(stateFile(dir)), 'regexScripts')).toBe(false)
    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(3)
    expect((await store.getState()).regexScripts).toHaveLength(3)
  }))

  it('切片写失败：拒绝并抛出，state.json 保持旧内容（不出现"两边都没有"）', withStore(async (store, dir) => {
    await store.updateState(() => ({
      regexScripts: legacyScripts(2),
      frontendStorage: legacyFrontendStorage(1),
    }))
    const before = await readFile(stateFile(dir))
    const beforeState = await store.getState()
    expect(beforeState.regexScripts).toHaveLength(2)

    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === regexFile(dir)) throw new Error(`rename blocked: ${String(to)}`)
      await fsPromises.rename(from, to)
    })
    try {
      await expect(store.updateState(() => ({ regexScripts: legacyScripts(SCRIPT_COUNT) })))
        .rejects.toThrow(/rename blocked/)
    } finally {
      rename.mockRestore()
    }

    expect(await readFile(stateFile(dir))).toEqual(before)
    expect((await store.getState()).regexScripts).toHaveLength(2)
  }))

  it('写路径遇到存量单文件：先落切片再重写 state.json，正则一条不丢', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))

    // 不先 getState：直接走写路径（写路径同样必须完成迁移）。
    await store.updateState((state) => ({ scriptGlobals: { ...state.scriptGlobals, mood: 'busy' } }))

    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(SCRIPT_COUNT)
    expect(Object.keys((await readJson(frontendFile(dir)))['frontendStorage'] as Record<string, unknown>))
      .toHaveLength(STORAGE_CHARACTER_COUNT)
    const light = await readJson(stateFile(dir))
    expect(hasKey(light, 'regexScripts')).toBe(false)
    expect(hasKey(light, 'frontendStorage')).toBe(false)
    const state = await store.getState()
    expect(state.regexScripts).toHaveLength(SCRIPT_COUNT)
    expect(state.scriptGlobals).toEqual({ mood: 'busy' })
  }))

  it('迁移崩在切片已写、state.json 未重写时：读出新值且不写盘，下一次写收尾', withStore(async (store, dir) => {
    const legacy = legacyState()
    await writeFile(stateFile(dir), JSON.stringify(legacy))
    // 崩在中间留下的盘面：切片已按同一份值落盘，state.json 仍带大表。
    await writeFile(regexFile(dir), JSON.stringify({
      version: 1,
      regexScripts: legacy['regexScripts'],
      regexScriptOwners: legacy['regexScriptOwners'],
    }))
    await writeFile(frontendFile(dir), JSON.stringify({
      version: 1,
      frontendStorage: legacy['frontendStorage'],
    }))
    const interrupted = await readFile(stateFile(dir))
    await pinMtime(stateFile(dir))

    const state = await store.getState()
    expect(state.regexScripts).toHaveLength(SCRIPT_COUNT)
    expect(Object.keys(state.frontendStorage ?? {})).toHaveLength(STORAGE_CHARACTER_COUNT)
    // 读路径不替崩溃补提交：state.json 仍是那份带大表的旧字节。
    expect(await readFile(stateFile(dir))).toEqual(interrupted)
    expect(await mtimeOf(stateFile(dir))).toBe(PINNED_MTIME.getTime())

    // 重来一次（重新读）结果相同。
    const again = await store.getState()
    expect(again).toBe(state)

    // 收尾发生在下一次写：切片值不丢，state.json 去大表。
    await store.updateState(() => ({}))
    const light = await readJson(stateFile(dir))
    expect(hasKey(light, 'regexScripts')).toBe(false)
    expect(hasKey(light, 'frontendStorage')).toBe(false)
    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(SCRIPT_COUNT)
  }))

  it('只读盘：getState 不抛错、不尝试写盘；写路径仍然抛出且盘面不变', withStore(async (store, dir) => {
    await writeFile(stateFile(dir), JSON.stringify(legacyState()))
    const before = await readFile(stateFile(dir))
    await pinMtime(stateFile(dir))

    const attempts: string[] = []
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (_from, to) => {
      attempts.push(String(to))
      const error = new Error(`read-only filesystem: ${String(to)}`) as NodeJS.ErrnoException
      error.code = 'EACCES'
      throw error
    })
    // Other tests in the same worker share fsPromises; only this store's dir is
    // part of the read-only contract under test.
    const attemptsForThisStore = (): string[] => attempts.filter((target) => target.startsWith(dir))
    try {
      const cold = await store.getState()
      const warm = await store.getState()
      expect(cold.regexScripts).toHaveLength(SCRIPT_COUNT)
      expect(warm).toBe(cold)
      // 读路径一次写都没试过（连重试都没有），字节与 mtime 都没动。
      expect(attemptsForThisStore()).toEqual([])
      expect(await readFile(stateFile(dir))).toEqual(before)
      expect(await mtimeOf(stateFile(dir))).toBe(PINNED_MTIME.getTime())

      // 写路径照旧失败：只读盘上不能静默返回一个没落盘的「成功」。
      await expect(store.updateState((state) => ({ scriptGlobals: { ...state.scriptGlobals, mood: 'denied' } })))
        .rejects.toThrow(/read-only filesystem/)
      expect(attemptsForThisStore().length).toBeGreaterThan(0)
      // 写失败没有留下半个迁移：state.json 字节不变，旧值仍可读。
      expect(await readFile(stateFile(dir))).toEqual(before)
      expect((await store.getState()).scriptGlobals).toEqual({ mood: 'calm' })
    } finally {
      rename.mockRestore()
    }
  }))

  it('盘上没有 state.json：返回值的键集合与改动前 DEFAULT_STATE 一致', withStore(async (store) => {
    const state = await store.getState()
    expect(Object.keys(state).sort()).toEqual(PRE_SPLIT_DEFAULT_STATE_KEYS)
    // 值为 undefined 的 own key 会通过 Object.keys 泄漏出对外形状。
    expect(hasKey(state, 'compaction')).toBe(false)
    expect(hasKey(state, 'memoryEmbedding')).toBe(false)
    expect(state.regexScripts).toEqual([])
    expect(state.frontendStorage).toEqual({})
    // 仍然是深冻结的共享副本：调用方改不动它。
    expect(() => (state.activeWorlds as string[]).push('nope')).toThrow(TypeError)
    expect(state).toBe(await store.getState())
  }))

  it('只有切片没有 state.json（首写崩在提交前）：读是全新安装，写会用提交值覆盖孤儿切片', withStore(async (store, dir) => {
    await writeFile(regexFile(dir), JSON.stringify({
      version: 1,
      regexScripts: legacyScripts(3),
      regexScriptOwners: legacyOwners(3),
    }))

    // state.json 是提交点：没有它就没有提交过的状态，残留切片算孤儿。
    const state = await store.getState()
    expect(state.regexScripts).toEqual([])
    expect(state.frontendStorage).toEqual({})
    // 读路径不清理孤儿（清理就是写盘）。
    expect((await readJson(regexFile(dir)))['regexScripts']).toHaveLength(3)

    // 第一次写把即将提交的值落进切片：提交后的读不会再看到孤儿字节。
    await store.updateState((current) => ({ scriptGlobals: { ...current.scriptGlobals, mood: 'fresh' } }))
    expect((await readJson(regexFile(dir)))['regexScripts']).toEqual([])
    const reread = await store.getState()
    expect(reread.regexScripts).toEqual([])
    expect(reread.scriptGlobals).toEqual({ mood: 'fresh' })
  }))
})
