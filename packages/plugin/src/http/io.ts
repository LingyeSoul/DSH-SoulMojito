// Shared JSON request/response helpers for the plugin HTTP surface.

import { HttpError } from './errors.js'

export function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export function readJson(req, maxBytes = 2 * 1024 * 1024) {
  const contentType = headerValue(req?.headers?.['content-type'])
  // Local non-browser clients may omit content-type; a present non-JSON type
  // is a cross-site form/simple request (or a caller bug) and must not parse.
  if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
    return Promise.reject(new HttpError(415, `unsupported content-type '${contentType}'; expected application/json`))
  }
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > maxBytes) { reject(new HttpError(413, `request exceeds ${maxBytes} bytes`)); req.destroy?.() }
      else chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new HttpError(400, 'invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return typeof first === 'string' && first.trim() !== '' ? first.trim() : undefined
}
