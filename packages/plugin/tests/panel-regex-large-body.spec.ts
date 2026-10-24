/**
 * Panel regex saves carry full card code pages: one entry can hold hundreds of
 * kilobytes of replacement HTML. The route must accept the same large body the
 * character-card write path already allows instead of resetting the connection
 * at the default readJson cap.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleApi } from '../src/http/router.js'
import { TavernStore } from '../../tavern-store/src/index.js'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-regex-large-body-'))

function makeRequest(url: string, method: string, body: unknown) {
  const encoded = Buffer.from(JSON.stringify(body))
  const listeners = new Map<string, (value?: unknown) => void>()
  return {
    method,
    url,
    on: (event: string, listener: (value?: unknown) => void) => {
      listeners.set(event, listener)
      if (event === 'end') {
        listeners.get('data')?.(encoded)
        listener()
      }
      return undefined
    },
    destroy: () => {},
  }
}

function makeResponse() {
  const chunks: string[] = []
  const response = {
    chunks,
    statusCode: 0,
    writableEnded: false,
    headersSent: false,
    setHeader: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: (chunk?: string) => { if (chunk) chunks.push(chunk); response.writableEnded = true },
    on: () => {},
  }
  return response
}

describe('panel regex full-list save', () => {
  beforeAll(async () => {
    process.env.DSH_HOME = HOME
    await TavernStore.open(join(HOME, 'soulmojito'))
  })
  afterAll(() => {
    delete process.env.DSH_HOME
    rmSync(HOME, { recursive: true, force: true })
  })

  it('accepts a payload above the default 2 MiB request cap', async () => {
    const scripts = Array.from({ length: 20 }, (_, index) => ({
      id: `large-${index}`,
      scriptName: `Large ${index}`,
      findRegex: '<probe>',
      replaceString: 'x'.repeat(160 * 1024),
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: false,
      promptOnly: false,
      runOnEdit: false,
      substituteRegex: false,
      minDepth: null,
      maxDepth: null,
    }))
    const res = makeResponse()
    await handleApi({}, makeRequest('/api/dsh-soulmojito/regex', 'PUT', { scripts }), res)
    expect(res.statusCode).toBe(200)
    expect(res.chunks.join('')).toContain('Large 19')
  })
})
