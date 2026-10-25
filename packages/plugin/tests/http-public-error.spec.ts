/**
 * API error privacy boundary (2026-10-25): infrastructure errors must never
 * echo absolute paths, machine usernames or internal file names in an HTTP
 * response. The fixtures below are synthetic placeholders only.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ChatRevisionConflictError, NovelStorageCorruptionError } from '../../tavern-store/src/index.js'
import { TavernArchitectureConflictError } from '../src/session/binding.js'
import { HttpError } from '../src/http/errors.js'
import { novelHttpFailure } from '../src/http/novel.js'
import {
  INTERNAL_ERROR_CODE,
  INTERNAL_ERROR_MESSAGE,
  publicError,
  publicErrorMessage,
  sendApiError,
} from '../src/http/public-error.js'

const WINDOWS_PLACEHOLDER_PATH = 'C:\\SyntheticWorkspace\\ExampleUser\\soulmojito\\state.json'
const POSIX_PLACEHOLDER_PATH = '/synthetic/home/example-user/.dsh/soulmojito/state.json'
const here = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(join(here, '../src/index.ts'), 'utf8')

function internalFailure(): Error {
  return new Error(
    `failed to read ${WINDOWS_PLACEHOLDER_PATH} and ${POSIX_PLACEHOLDER_PATH}`,
    { cause: new Error(`open failed at ${WINDOWS_PLACEHOLDER_PATH}`) },
  )
}

function makeResponse(headersSent: boolean) {
  const chunks: string[] = []
  const headers: Record<string, string> = {}
  const response = {
    statusCode: 0,
    headersSent,
    writableEnded: false,
    headers,
    chunks,
    setHeader(name: string, value: string) {
      headers[name] = value
    },
    write(chunk: string) {
      chunks.push(chunk)
      return true
    },
    end(body?: string | Uint8Array) {
      if (body !== undefined) chunks.push(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'))
      response.writableEnded = true
    },
  }
  return response
}

describe('public API error sanitization', () => {
  it('maps a JSON internal failure to a stable body with no path or cause', () => {
    const res = makeResponse(false)
    sendApiError(res, internalFailure(), { operation: 'http-api' })

    expect(res.statusCode).toBe(500)
    const body = res.chunks.join('')
    expect(body).not.toContain(WINDOWS_PLACEHOLDER_PATH)
    expect(body).not.toContain(POSIX_PLACEHOLDER_PATH)
    expect(body).not.toContain(JSON.stringify(WINDOWS_PLACEHOLDER_PATH).slice(1, -1))
    expect(body).not.toContain('SyntheticWorkspace')
    expect(body).not.toContain('ExampleUser')
    expect(body).not.toContain('synthetic/home')
    expect(body).not.toContain('open failed at')
    expect(JSON.parse(body)).toEqual({
      ok: false,
      message: INTERNAL_ERROR_MESSAGE,
      code: INTERNAL_ERROR_CODE,
    })
  })

  it('maps a streamed internal failure to a stable NDJSON error line', () => {
    const res = makeResponse(true)
    sendApiError(res, internalFailure(), { operation: 'http-api' })

    const body = res.chunks.join('')
    expect(body).not.toContain(WINDOWS_PLACEHOLDER_PATH)
    expect(body).not.toContain(POSIX_PLACEHOLDER_PATH)
    expect(body).not.toContain(JSON.stringify(WINDOWS_PLACEHOLDER_PATH).slice(1, -1))
    expect(body).not.toContain('SyntheticWorkspace')
    expect(body).not.toContain('ExampleUser')
    expect(body).not.toContain('synthetic/home')
    expect(JSON.parse(body.trim())).toEqual({
      type: 'error',
      message: INTERNAL_ERROR_MESSAGE,
      code: INTERNAL_ERROR_CODE,
    })
  })

  it('logs the full original error server-side through structured fields', () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = []
    const logger = {
      warn: (message: string, fields?: Record<string, unknown>) => {
        warnings.push({ message, fields })
      },
    }

    publicError(internalFailure(), { operation: 'store-read', logger })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toBe('dsh-soulmojito: API request failed')
    expect(warnings[0]!.fields).toMatchObject({
      operation: 'store-read',
      status: 500,
      code: INTERNAL_ERROR_CODE,
    })
    expect(String(warnings[0]!.fields?.['errorMessage'])).toContain('SyntheticWorkspace')
    expect(JSON.stringify(warnings[0]!.fields?.['cause'])).toContain('ExampleUser')
  })

  it('keeps intentionally public errors readable', () => {
    expect(publicError(new HttpError(400, 'expected { name }'), { operation: 'test' })).toEqual({
      status: 400,
      message: 'expected { name }',
    })
    expect(publicErrorMessage(new Error('chatId query is required'))).toBe('chatId query is required')
    expect(publicErrorMessage({ message: 'untyped failure' })).toBe(INTERNAL_ERROR_MESSAGE)
  })

  it('preserves chat and architecture conflict codes and messages', () => {
    const revision = new ChatRevisionConflictError('revision-a', 'revision-b')
    expect(publicError(revision, { operation: 'test' })).toEqual({
      status: 409,
      message: revision.message,
      code: 'CHAT_REVISION_CONFLICT',
    })

    const architecture = new TavernArchitectureConflictError('This host session already started.')
    expect(publicError(architecture, { operation: 'test' })).toEqual({
      status: 409,
      message: 'This host session already started.',
      code: 'TAVERN_ARCHITECTURE_CONFLICT',
    })
  })

  it('wires the outer handler through sendApiError for both response shapes', () => {
    expect(indexSource).toContain('sendApiError(res, error, {')
    expect(indexSource).toContain('novelFailure: novelHttpFailure(error)')
    expect(indexSource).not.toContain('error instanceof ChatRevisionConflictError')
    expect(indexSource).not.toContain('? error.status')
  })

  it('keeps novel domain mapping and sanitizes storage corruption paths', () => {
    const error = new NovelStorageCorruptionError({
      novelId: 'novel-example',
      path: WINDOWS_PLACEHOLDER_PATH,
      detail: 'invalid snapshot',
    })
    const failure = publicError(error, {
      operation: 'novels-api',
      novelFailure: novelHttpFailure(error),
    })

    expect(failure.status).toBe(500)
    expect(failure.code).toBe('NOVEL_STORAGE_CORRUPTION')
    expect(failure.message).toBe(`Novel failure 'NOVEL_STORAGE_CORRUPTION'; see the server log for details.`)
    expect(failure.message).not.toContain('SyntheticWorkspace')
  })
})