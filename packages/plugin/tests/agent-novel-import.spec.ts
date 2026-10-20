import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, type AgentContextLike } from '../src/agent-novel/agent.js'
import {
  NovelStore,
  TavernStore,
  type NovelCreateConfig,
  type NovelOutlinePayload,
} from '../../tavern-store/src/index.js'
import type { SubagentRuntimeLike } from '../src/agent-tavern/deduce.js'

const AUTHOR = 'novel-import-author'
const SOURCE = [
  '第一章 雾港',
  '',
  '雾从海面压进港口，灯塔只亮了一半。林舟把缆绳绕在桩上。',
  '',
  '第二章 旧信',
  '',
  '那封信在抽屉里放了十年，纸角已经发黄。他决定去北岸。',
].join('\n')

interface RegisteredTool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: Record<string, unknown>, exec: { agent?: { id?: string; ctx?: unknown } }): Promise<any>
}

function baseConfig(overrides?: Partial<NovelCreateConfig>): NovelCreateConfig {
  return {
    title: '雾港续章',
    requirement: '从旧信结尾继续写，保持冷峻的海港氛围。',
    language: 'zh',
    genre: '悬疑',
    narrativePerspective: 'third-person',
    styleNotes: '',
    lengthBudget: { kind: 'unbounded' },
    maxChapters: null,
    approvalMode: 'automatic',
    characterNames: [],
    worldNames: [],
    budgets: {
      maxTurns: 100,
      maxDurationMs: 3_600_000,
      stallThresholdTurns: 10,
      consecutiveFailureLimit: 3,
      externalRetry: { maxAttempts: 2, backoffMs: 500 },
      maxDeduceRuns: 5,
    },
    ...overrides,
  }
}

function outlinePayload(): NovelOutlinePayload {
  return {
    story: { premise: '旧信指向北岸', theme: '记忆', mainConflict: '真相与安稳', endingDirection: '读完信', taboos: [] },
    characters: [{ characterId: 'lin', name: '林舟', initialState: '守港', motivation: '寻找寄信人', relations: [], arc: '直面' }],
    chapters: [{
      chapterId: 'ch-1', order: 1, title: '北岸', purpose: '启程', keyEvents: ['登船'], plannedCharacters: null,
      entryCondition: '读完信', exitCondition: '抵达北岸',
    }],
    currentChapterId: 'ch-1',
    scenes: [{ sceneId: 'sc-1', order: 1, goal: '登船离港', participants: ['lin'], timeLocation: '码头', causality: '承接旧信', conflict: '雾', expectedChange: '离开' }],
    foreshadowing: [],
  }
}

function extractionJson(index: number): string {
  return JSON.stringify({
    summary: `第 ${index} 部分：雾港来信`,
    timeline: [{ summary: index === 1 ? '林舟收缆。' : '林舟读信。', characters: ['林舟'], importance: 'major' }],
    characters: [{
      name: '林舟', aliases: [], role: '主角', identity: '守港人', personality: '沉默', appearance: '旧雨衣',
      motivation: '寻找寄信人', relationships: [], stateAtEnd: '决定北上', confidence: 'high',
    }],
    worldEntries: [{ title: '雾港', keys: ['灯塔'], category: '地点', content: '冬季长雾。' }],
    openThreads: ['谁寄的信？'],
    style: { pointOfView: 'third', tone: '冷峻', pacing: 'slow', proseNotes: '海雾', dialogueStyle: '克制' },
  })
}

function scriptedRuntime(): { runtime: SubagentRuntimeLike; calls: Array<{ label: string; prompt: string; toolFilter: unknown }> } {
  const calls: Array<{ label: string; prompt: string; toolFilter: unknown }> = []
  let counter = 0
  return {
    calls,
    runtime: {
      async start(provider, request) {
        counter += 1
        const label = String(request.label ?? '')
        const prompt = request.prompt.map((block) => block.text ?? '').join('\n')
        calls.push({ label, prompt, toolFilter: request.toolFilter })
        const text = label.includes('novel-revision')
          ? '浓雾像湿布一样压在码头上。\n\n船笛从雾心传来，他踏上跳板。'
          : extractionJson(counter)
        return {
          id: `run-${counter}`,
          result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
          async dispose() {},
        }
      },
    },
  }
}

describe('AgentNovel import and revision tools (proposal 0020)', () => {
  let home: string
  let tavern: TavernStore
  let novels: NovelStore
  let tools: Map<string, RegisteredTool>
  let runtime: ReturnType<typeof scriptedRuntime>

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-novel-import-'))
    process.env.DSH_HOME = home
    tavern = await TavernStore.open(join(home, 'tavern'))
    novels = await NovelStore.open(join(home, 'tavern'))
    runtime = scriptedRuntime()
    tools = new Map()
    apply({
      systemPrompt: { section: () => {} },
      tools: { register: (tool) => { tools.set(tool.name, tool as RegisteredTool) } },
      effect: (factory) => factory(),
    } satisfies AgentContextLike)
  })

  afterAll(async () => {
    delete process.env.DSH_HOME
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rm(home, { recursive: true, force: true })
        break
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw cause
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  })

  it('extracts every part through subagents, fuses the bible and exposes the digest', async () => {
    const created = await novels.createImportedNovel(tavern, baseConfig(), {
      name: '雾港.txt', format: 'txt', text: SOURCE, partTargetCharacters: 2000,
    })
    await tavern.updateState(() => ({
      sessionBindings: { [AUTHOR]: { architecture: 'agent-novel', novelId: created.novelId } },
    }))
    const exec = { agent: { id: AUTHOR, ctx: { subagents: runtime.runtime } } }

    const first = await tools.get('novel_import_extract')!.execute({ batchSize: 4 }, exec)
    expect(first).toMatchObject({ extracted: 2, pending: 0, failed: 0, paused: false })
    expect(runtime.calls).toHaveLength(2)
    expect(runtime.calls[0]!.toolFilter).toEqual({ allow: [] })
    expect(runtime.calls[0]!.prompt).toContain('第一章 雾港')
    expect(runtime.calls[0]!.prompt).toContain('Novel part text')

    const read = await tools.get('novel_import_read')!.execute({}, exec)
    expect(read.progress).toMatchObject({ extracted: 2, partCount: 2 })
    expect(read.digest.characters[0]).toMatchObject({ name: '林舟', mentions: 2 })
    expect(read.digest.sourceTail).toContain('那封信')

    const snapshot = (await novels.getNovel(created.novelId))!
    const merged = await tools.get('novel_import_merge')!.execute({
      expectedRevision: snapshot.revision,
      bible: {
        story: { premise: '雾港旧信', theme: '记忆', mainConflict: '真相', endingDirection: '北上', taboos: [] },
        timeline: read.digest.timeline,
        characters: read.digest.characters,
        worldEntries: read.digest.worldEntries,
        styleNotes: '冷峻潮湿',
        openThreads: read.digest.openThreads,
      },
    }, exec)
    expect(merged.assetsAdded).toBeGreaterThanOrEqual(2)
    const after = (await novels.getNovel(created.novelId))!
    expect(after.run.phase).toBe('outlining')
    expect(after.import?.bibleSummary?.characterCount).toBe(1)
  })

  it('optimizes a chapter into a pending revision and applies it only on request', async () => {
    const created = await novels.createNovel(tavern, baseConfig({ title: '北岸' }))
    const outlined = await novels.createOutline(created.novelId, {
      expectedRevision: created.revision,
      outline: outlinePayload(),
      handledRequirements: [{ requirementId: 'req-1', result: 'applied', effectiveLocation: 'story.premise' }],
    })
    const { unitId } = await novels.prepareUnit(created.novelId, { chapterId: 'ch-1', sceneId: 'sc-1', label: '登船', goal: '登船离港' })
    const claim = await novels.claimUnit(created.novelId, {
      unitId, expectedOutlineRevision: outlined.outlineRevision, expectedRequirementSequence: 1, hostTurn: null,
    })
    await novels.commitBody(created.novelId, {
      unitId,
      executionToken: claim.executionToken,
      paragraphs: ['雾里传来船笛。', '他踏上跳板。'],
      sceneCompletion: { completed: true, basis: '登船完成', outstandingGoals: [], nextAnchor: null },
      canonChanges: [],
    })
    await tavern.updateState(() => ({
      sessionBindings: { [AUTHOR]: { architecture: 'agent-novel', novelId: created.novelId } },
    }))
    const exec = { agent: { id: AUTHOR, ctx: { subagents: runtime.runtime } } }

    const optimized = await tools.get('novel_body_optimize')!.execute({
      chapterId: 'ch-1',
      instruction: '加强海雾与船笛的感官描写',
    }, exec)
    expect(optimized).toMatchObject({ status: 'pending', chapterId: 'ch-1' })
    expect(optimized.preview).toContain('浓雾像湿布')

    const before = await novels.readBody(created.novelId, { chapterId: 'ch-1' })
    expect(before.paragraphs[0]!.text).toBe('雾里传来船笛。')

    const snapshot = (await novels.getNovel(created.novelId))!
    const applied = await tools.get('novel_body_revision_apply')!.execute({
      revisionId: optimized.revisionId,
      expectedRevision: snapshot.revision,
    }, exec)
    expect(applied).toMatchObject({ novelId: created.novelId })
    const after = await novels.readBody(created.novelId, { chapterId: 'ch-1' })
    expect(after.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      '浓雾像湿布一样压在码头上。',
      '船笛从雾心传来，他踏上跳板。',
    ])
  })
})
