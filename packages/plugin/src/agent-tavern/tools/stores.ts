/** Memoized AgentTavern store singletons shared by agent.ts and every tool module.
 *  Single-instance discipline: never open a second copy of these stores. */

import {
  MemoryStore,
  MemoryVectorStore,
  TavernStore,
  VariableStore,
  normalizeMemoryEmbedding,
  type MemoryEmbeddingSettings,
  type MemoryRecord,
} from '../../../../tavern-store/src/index.js'
import { tavernDataRoot } from '../../dsh-home.js'
import { embedMemoryRecord } from '../../memory-hybrid.js'

let tavernStorePromise: Promise<TavernStore> | undefined
let memoryStorePromise: Promise<MemoryStore> | undefined
let memoryVectorStorePromise: Promise<MemoryVectorStore> | undefined
let variableStorePromise: Promise<VariableStore> | undefined

export function tavernStore(): Promise<TavernStore> {
  return (tavernStorePromise ??= TavernStore.open(tavernDataRoot()))
}

export function memoryStore(): Promise<MemoryStore> {
  return (memoryStorePromise ??= MemoryStore.open(tavernDataRoot()))
}

export function memoryVectorStore(): Promise<MemoryVectorStore> {
  return (memoryVectorStorePromise ??= MemoryVectorStore.open(tavernDataRoot()))
}

/** 混合检索配置（提案 0016）：state.memoryEmbedding 经 normalize 后有效才算开启；
 *  缺省/非法 ⇒ undefined ⇒ 全链路纯词法（golden 行为）。 */
export async function memoryEmbeddingConfig(): Promise<MemoryEmbeddingSettings | undefined> {
  const state = await (await tavernStore()).getState()
  return normalizeMemoryEmbedding(state.memoryEmbedding)
}

/** 写路径嵌入（提案 0016）：memory_write / memory_update 落盘成功后同步嵌入并
 *  落向量；embedMemoryRecord 内部已把失败落进 lastError/熔断，这里再兜一层
 *  catch 保证任何嵌入路径异常都不阻塞工具返回。 */
export async function embedWrittenMemory(record: MemoryRecord): Promise<void> {
  try {
    const config = await memoryEmbeddingConfig()
    if (config === undefined) return
    await embedMemoryRecord({ root: tavernDataRoot(), config, vectorStore: await memoryVectorStore(), record })
  } catch { /* 嵌入失败不阻塞记忆写入 */ }
}

export function variableStore(): Promise<VariableStore> {
  return (variableStorePromise ??= VariableStore.open(tavernDataRoot()))
}
