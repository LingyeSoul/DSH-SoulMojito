/**
 * Mod 审计线（提案 0015 §3.2 P1）：`<tavern>/mods/audit.jsonl` 追加式 JSONL。
 *
 * 每行 `{ ts, mod, event, detail? }`，事件集：
 * `load` / `enable` / `disable` / `reload` / `skip`（坏 Mod 跳过，含原因）/
 * `load-error` / `dispose-error` / `event-error` / `timer-error` /
 * `http-error` / `storage-quota` / `storage-error` / `remove`（目录消失自动卸载）。
 * P2 新增：`hook-degradation`（管线 hook 抛错/超时/忘 return 的降级计数）/
 * `llm-call`（api.llm 调用与用量）/ `llm-error` / `macro-error`（mod 宏首调异常）/
 * `install` / `install-error`（git 安装）。
 *
 * 追加失败（磁盘满/权限）静默降级为仅内存计数——审计是观测面，不允许反噬宿主。
 * 计数是**本进程内**的（bootstrap 投影与面板展示用），完整历史在 jsonl 文件里。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type ModAuditEvent =
  | 'load'
  | 'enable'
  | 'disable'
  | 'reload'
  | 'remove'
  | 'skip'
  | 'load-error'
  | 'dispose-error'
  | 'event-error'
  | 'timer-error'
  | 'http-error'
  | 'storage-quota'
  | 'storage-error'
  | 'hook-degradation'
  | 'llm-call'
  | 'llm-error'
  | 'macro-error'
  | 'install'
  | 'install-error'

export class ModAuditLog {
  private readonly counts = new Map<string, number>()
  private warn: ((message: string) => void) | undefined
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** 宿主 logger 可选注入；没有 logger 时审计写入失败完全静默。 */
  setLogger(warn: ((message: string) => void) | undefined): void {
    this.warn = warn
  }

  /** 追加一条审计记录（best-effort）；无论落盘与否都推进内存计数。 */
  record(mod: string, event: ModAuditEvent, detail = ''): Promise<void> {
    this.counts.set(mod, (this.counts.get(mod) ?? 0) + 1)
    const line = `${JSON.stringify({ ts: new Date().toISOString(), mod, event, ...(detail === '' ? {} : { detail }) })}\n`
    const written = this.tail
      .catch(() => {})
      .then(async () => {
        try {
          await mkdir(dirname(this.file), { recursive: true })
          await appendFile(this.file, line, 'utf8')
        } catch (cause) {
          this.warn?.(`dsh-tavern: mod audit append failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      })
    this.tail = written
    return written
  }

  /** 本进程内某 Mod 的审计事件计数（面板「审计计数」数据源）。 */
  count(mod: string): number {
    return this.counts.get(mod) ?? 0
  }
}
