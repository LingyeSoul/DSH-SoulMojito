import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolves a path under the DSH home directory ($DSH_HOME when set and
 * non-blank, ~/.dsh otherwise). Shared by every plugin entry bundle —
 * index.ts (HTTP API / lifecycle), the agent-tavern and agent-novel preset
 * modules, and the compaction curator — so all bundles agree on the home
 * resolution by construction. Pure function of the environment: inlining one
 * copy into each esbuild bundle is harmless (unlike the NovelStore BOOT_ID,
 * no process-wide state lives here).
 */
export function dshHomePath(...segments: string[]): string {
  const configured = process.env.DSH_HOME?.trim()
  return join(resolve(configured || join(homedir(), '.dsh')), ...segments)
}

/** Current Tavern data directory (2026-10-21). */
export const TAVERN_DATA_DIR = 'soulmojito'

/** Pre-2026-10-21 data directory, read-only as far as naming goes. */
export const LEGACY_TAVERN_DATA_DIR = 'tavern'

/**
 * Tavern data root: every asset, chat, memory, mod, game and internal
 * workspace lives below it. Fresh installs use `$DSH_HOME/soulmojito`;
 * installs that still hold a populated `$DSH_HOME/tavern` keep reading and
 * writing there in place, because the host workspace registry and the native
 * session directories pin the old path (decisions/2026-10-21-storage-dir-
 * soulmojito.md). When both directories hold data the new one wins, so an
 * explicit user migration takes effect.
 *
 * A directory only counts as a Tavern root when it is non-empty: a stray
 * empty `soulmojito/` must never shadow a populated legacy store.
 */
export function tavernDataRoot(...segments: string[]): string {
  const next = dshHomePath(TAVERN_DATA_DIR)
  if (holdsTavernData(next)) return join(next, ...segments)
  const legacy = dshHomePath(LEGACY_TAVERN_DATA_DIR)
  if (holdsTavernData(legacy)) return join(legacy, ...segments)
  return join(next, ...segments)
}

function holdsTavernData(root: string): boolean {
  try {
    return readdirSync(root).length > 0
  } catch {
    return false
  }
}
