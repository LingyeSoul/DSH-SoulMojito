// Privacy boundary for API error bodies.
//
// Route handlers throw many different error families: intentional caller
// mistakes (HttpError, chat/architecture conflicts, novel domain errors) and
// unexpected infrastructure failures (store IO, filesystem, third-party mod
// code). Infrastructure messages routinely embed absolute paths, machine
// usernames and internal file names, which must never reach an HTTP response.
//
// `publicError` is the single classifier: it keeps intentionally public
// messages, maps sensitive/internal failures to one stable body and logs the
// full original error server-side through structured fields. `sendApiError`
// applies that body to both response shapes (JSON and the NDJSON stream error
// line) so the outer handler cannot drift from the helper.

import type { JsonResponse } from './io.js'
import { sendJson } from './io.js'
import { HttpError } from './errors.js'
import type { HostLogger } from '../host-contract.js'
import type { NovelHttpFailure } from './novel.js'

export interface PublicApiError {
  status: number
  message: string
  code?: string
  extra?: Record<string, unknown>
}

export interface PublicErrorOptions {
  /** Stable route/operation label for structured server logs. */
  operation: string
  logger?: HostLogger
  /** Pre-classified novel failure; novel.ts owns the domain mapping. */
  novelFailure?: NovelHttpFailure
}

export interface ApiErrorResponse extends JsonResponse {
  readonly headersSent?: boolean
  write?(chunk: string): unknown
}

export const INTERNAL_ERROR_MESSAGE = 'internal storage error'
export const INTERNAL_ERROR_CODE = 'INTERNAL_STORAGE_ERROR'
const MAX_PUBLIC_MESSAGE_LENGTH = 500

// Absolute Windows path (`C:\...`, `C:/...`) or a UNC path (`\\host\share`).
const WINDOWS_PATH = /(?:^|[\s"'`(=])(?:[A-Za-z]:[\\/]|\\\\)/
// Absolute POSIX path (`/home/...`, `/tmp/...`) after a word boundary. URLs
// (`https://...`) do not match because the first slash follows `:`.
const POSIX_PATH = /(?:^|[\s"'`(=~])\/[A-Za-z0-9._-]/
const HOME_PATH = /(?:%USERPROFILE%|\$HOME|~[\\/])/i
const FILE_URL = /file:\/\//i
const INTERNAL_FILE_NAME = /\b[\w.-]+\.(?:jsonl(?:\.zst)?|zst|lock|tmp|bin)\b/i
const FILE_SYSTEM_CODE = /\b(?:EACCES|EBUSY|EEXIST|EIO|EISDIR|ELOOP|EMFILE|ENAMETOOLONG|ENFILE|ENOENT|ENOSPC|ENOTDIR|EPERM|EROFS)\b/

/**
 * Returns the caller-facing text for an arbitrary error. Intentionally public
 * validation messages pass through unchanged; anything carrying a filesystem
 * path, an internal file name or a filesystem error code collapses to the
 * stable internal message.
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error) && typeof error !== 'string') return INTERNAL_ERROR_MESSAGE
  const message = rawErrorMessage(error)
  if (message.trim() === '') return INTERNAL_ERROR_MESSAGE
  if (isSensitiveErrorMessage(message) || hasInternalErrorShape(error)) return INTERNAL_ERROR_MESSAGE
  return message
}

/**
 * Classifies any thrown value into the API error body. The original error is
 * never echoed when it looks internal; the full value (message, stack, cause)
 * only goes to the server logger.
 */
export function publicError(error: unknown, options: PublicErrorOptions): PublicApiError {
  let failure: PublicApiError
  if (options.novelFailure !== undefined) {
    const novel = options.novelFailure
    failure = {
      status: novel.status,
      message: novel.sanitized === true
        ? `Novel failure '${novel.code}'; see the server log for details.`
        : rawErrorMessage(error),
      code: novel.code,
      ...(novel.extra === undefined ? {} : { extra: novel.extra }),
    }
  } else {
    const conflict = conflictFailure(error)
    if (error instanceof HttpError) {
      failure = { status: error.status, message: error.message }
    } else if (conflict !== undefined) {
      failure = conflict
    } else {
      const message = publicErrorMessage(error)
      failure = message === INTERNAL_ERROR_MESSAGE
        ? { status: 500, message, code: INTERNAL_ERROR_CODE }
        : { status: 500, message }
    }
  }

  // Novel domain failures preserve their existing server-log trail even when
  // they map to 4xx; other caller mistakes do not need a full stack dump.
  if (failure.status >= 500 || options.novelFailure !== undefined) logFailure(error, failure, options)
  return failure
}

/**
 * Writes the classified failure to either response shape used by the route:
 * a JSON body before headers, or an NDJSON `error` line once a stream started.
 * A response that already ended is left alone.
 */
export function sendApiError(res: ApiErrorResponse, error: unknown, options: PublicErrorOptions): void {
  const failure = publicError(error, options)
  if (res.writableEnded === true) return
  if (res.headersSent === true) {
    res.write?.(`${JSON.stringify({
      type: 'error',
      message: failure.message,
      code: failure.code,
    })}\n`)
    res.end()
    return
  }
  sendJson(res, failure.status, {
    ok: false,
    message: failure.message,
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.extra ?? {}),
  })
}

function conflictFailure(error: unknown): PublicApiError | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as { code?: unknown }).code
  if (error.name === 'ChatRevisionConflictError' && code === 'CHAT_REVISION_CONFLICT') {
    return { status: 409, message: error.message, code }
  }
  if (error.name === 'TavernArchitectureConflictError' && code === 'TAVERN_ARCHITECTURE_CONFLICT') {
    return { status: 409, message: error.message, code }
  }
  return undefined
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isSensitiveErrorMessage(message: string): boolean {
  if (message.length > MAX_PUBLIC_MESSAGE_LENGTH || message.includes('\n')) return true
  return WINDOWS_PATH.test(message)
    || POSIX_PATH.test(message)
    || HOME_PATH.test(message)
    || FILE_URL.test(message)
    || INTERNAL_FILE_NAME.test(message)
    || FILE_SYSTEM_CODE.test(message)
}

function hasInternalErrorShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as Record<string, unknown>
  if (record['name'] === 'InternalError') return true
  const code = record['code']
  if (typeof code === 'string' && FILE_SYSTEM_CODE.test(code)) return true
  return typeof record['path'] === 'string'
    || typeof record['dest'] === 'string'
    || typeof record['syscall'] === 'string'
}

function logFailure(error: unknown, failure: PublicApiError, options: PublicErrorOptions): void {
  const warn = options.logger?.warn
  if (typeof warn !== 'function') return
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : undefined
  warn('dsh-soulmojito: API request failed', {
    operation: options.operation,
    status: failure.status,
    code: failure.code ?? 'none',
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: rawErrorMessage(error),
    errorStack: error instanceof Error ? error.stack : undefined,
    cause: causeRecordOf(record?.['cause']),
  })
}

function causeRecordOf(cause: unknown): Record<string, unknown> | undefined {
  if (cause === undefined) return undefined
  if (cause instanceof Error) return { name: cause.name, message: cause.message, stack: cause.stack }
  return { message: String(cause) }
}