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
