/** Novel single-writer ownership probes and duration helpers (§10.2/§13), extracted from novel.ts. */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { NovelStorageCorruptionError, type NovelRunState } from './novel-model.js'


/** Process identity shared by every bundled copy of this module: the build
 *  ships tavern-store inside several entry bundles (index.mjs and novel.mjs
 *  both mutate novels), and two NovelStore instances in one process are the
 *  same writer that may re-enter each other's ownership (§10.2). A constant
 *  local to one copy would make the bundles reject each other under the same
 *  pid, so the identity lives on globalThis. */
export const BOOT_ID: string = (globalThis as { __dshSoulMojitoNovelBootId?: string }).__dshSoulMojitoNovelBootId ??= randomBytes(16).toString('hex')

/** Command-line shapes of a live dsh host: the global install path
 *  (`node …@deepseek-ai/dsh/lib/bin.js web`) or a bare `dsh web` invocation.
 *  Deliberately narrow so a path merely containing "dsh" (a checkout of this
 *  repo, the profile dir `~/.dsh`) never reads as a competing writer. */
const DSH_HOST_COMMAND = /@deepseek-ai[\\/]dsh\b|(?:^|[\\/ \t"'])dsh(?:\.(?:cmd|js|ps1|exe|bat))?["']?[ \t]+web\b/

/** Full command line of a pid, or undefined when the pid is gone and null
 *  when the platform cannot tell. Windows asks CIM (an absent process yields
 *  empty output, a broken shell yields an error); Linux reads /proc; darwin
 *  asks ps. */
function commandLineOf(pid: number): Promise<string | undefined | null> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) resolve(null)
        else resolve(stdout.trim() === '' ? undefined : stdout.trim())
      })
    })
  }
  if (process.platform === 'linux') {
    return fs.readFile(`/proc/${pid}/cmdline`, 'utf8').then(
      (raw) => raw.split('\0').join(' ').trim() || undefined,
      (cause) => { const code = (cause as NodeJS.ErrnoException).code; return code === 'ENOENT' || code === 'ESRCH' ? undefined : null },
    )
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (error, stdout) => {
        if (error) resolve(Number((error as NodeJS.ErrnoException).code) === 1 ? undefined : null)
        else resolve(stdout.trim() === '' ? undefined : stdout.trim())
      })
    })
  }
  return Promise.resolve(null)
}

/** Whether the recorded pid still names a writer that could mutate novels
 *  (§10.2: stale ownership is recovered on evidence, never on a timeout).
 *  False proves the writer is gone: the pid is dead, was recycled to a
 *  non-dsh process, or is this very pid under a foreign boot id (every live
 *  module in this process shares BOOT_ID). An undecidable probe stays
 *  conservative and reports a live writer. */
export async function isLiveDshWriter(pid: number): Promise<boolean> {
  if (pid === process.pid) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  let alive = true
  try {
    process.kill(pid, 0)
  } catch (cause) {
    alive = (cause as NodeJS.ErrnoException).code === 'EPERM'
  }
  if (!alive) return false
  const command = await commandLineOf(pid)
  if (command === undefined) return false
  if (command === null) return true
  return DSH_HOST_COMMAND.test(command)
}

export interface OwnerFile {
  pid: number
  bootId: string
  acquiredAt: string
}

/** §13 duration budget: folds the open active window into the cumulative
 * total and closes it. Paused runs and legacy snapshots (created before the
 * window fields existed) have no open window — legacy history is amnestied
 * rather than reconstructed from wall-clock, which would charge host downtime
 * to the writing budget all over again. */
export function foldActiveDuration(run: NovelRunState, nowMs: number): { activeDurationMs: number; activeWindowStart: null } {
  const open = run.status === 'active' && run.activeWindowStart !== undefined && run.activeWindowStart !== null
    ? Math.max(0, nowMs - Date.parse(run.activeWindowStart))
    : 0
  return { activeDurationMs: (run.activeDurationMs ?? 0) + open, activeWindowStart: null }
}

/** Elapsed active milliseconds under the §13 duration budget right now. */
export function elapsedActiveDuration(run: NovelRunState, nowMs: number): number {
  const open = run.status === 'active' && run.activeWindowStart !== undefined && run.activeWindowStart !== null
    ? Math.max(0, nowMs - Date.parse(run.activeWindowStart))
    : 0
  return (run.activeDurationMs ?? 0) + open
}

export function parseOwnerFile(novelId: string, ownerPath: string, raw: string): OwnerFile {
  try {
    const owner = JSON.parse(raw) as OwnerFile
    if (typeof owner !== 'object' || owner === null || !Number.isInteger(owner.pid) || typeof owner.bootId !== 'string') {
      throw new Error('invalid shape')
    }
    return owner
  } catch (cause) {
    throw new NovelStorageCorruptionError({ novelId, path: ownerPath, detail: `.owner.json is unreadable: ${(cause as Error).message}` })
  }
}
