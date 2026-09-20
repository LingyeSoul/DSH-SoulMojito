/**
 * Shared AgentNovel scope helper (proposal 0005 §8.2).
 *
 * A novel's retrieval index lives in the chat scope namespaced
 * `novel:<novelId>`, isolated from ordinary chat ids. Both the tool surface
 * (memory_search / memory_read) and the memory-index projector resolve the
 * same string; sharing one definition keeps the namespace from drifting
 * between the writer and the reader of the index.
 */

/** §8.2: novel chat-scope namespace, isolated from ordinary chat ids. */
export function novelScopeId(novelId: string): string {
  return `novel:${novelId}`
}
