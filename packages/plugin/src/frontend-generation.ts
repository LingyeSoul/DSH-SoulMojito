/**
 * Frontend generation bridge (2026-10-22): JSR cards may own an OpenAI-compatible
 * API source (URL + key + model) and call `TavernHelper.generate` / `getModelList`
 * from the sandboxed frontend iframe. JSR proxies those calls through the
 * SillyTavern backend; this module provides the same server-side proxy so the API
 * key never has to travel to an arbitrary page or depend on browser CORS.
 *
 * The bridge is deliberately narrow: /models (GET) and /chat/completions (POST,
 * non-streaming), no redirects, no credentials in the URL, HTTPS only except for
 * loopback development proxies. The key is used only in the outgoing request and
 * is redacted from every error message.
 */

const REQUEST_TIMEOUT_MS = 180_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_PROMPT_CHARS = 2_000_000
const MAX_MESSAGES = 256
const MAX_API_KEY_CHARS = 8192

type ChatRole = 'system' | 'user' | 'assistant'

interface ChatMessage {
  role: ChatRole
  content: string
}

interface CustomApiTarget {
  baseUrl: string
  key: string
  model: string
}

export class FrontendGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontendGenerationError'
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requireText(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw new FrontendGenerationError(`${field} must be a string`)
  const text = value.trim()
  if (text === '') throw new FrontendGenerationError(`${field} must not be empty`)
  if (text.length > maxChars) throw new FrontendGenerationError(`${field} is too long (${text.length} > ${maxChars})`)
  return text
}

function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1'
}

function normalizeBaseUrl(url: URL): string {
  if (url.search !== '' || url.hash !== '') {
    throw new FrontendGenerationError('custom_api.apiurl must be a base URL without query or hash parameters')
  }
  let base = url.toString().replace(/\/+$/, '')
  base = base.replace(/\/chat\/completions$/i, '')
  base = base.replace(/\/models$/i, '')
  if (base === '') throw new FrontendGenerationError('custom_api.apiurl must include a host')
  return base
}

function parseApiTarget(value: unknown, requireModel: boolean): CustomApiTarget {
  const record = asRecord(value)
  if (record === undefined) throw new FrontendGenerationError('custom_api must be an object')
  const rawUrl = requireText(record.apiurl, 'custom_api.apiurl', 2048)
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new FrontendGenerationError(`custom_api.apiurl is not a valid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FrontendGenerationError('custom_api.apiurl must use https:// (http:// is allowed only for loopback proxies)')
  }
  if (url.username !== '' || url.password !== '') {
    throw new FrontendGenerationError('custom_api.apiurl must not contain credentials; put the key in the API key field')
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new FrontendGenerationError('custom_api.apiurl must use https:// for non-loopback hosts')
  }
  if (record.key !== undefined && typeof record.key !== 'string') {
    throw new FrontendGenerationError('custom_api.key must be a string when present')
  }
  const key = typeof record.key === 'string' ? record.key : ''
  if (key.length > MAX_API_KEY_CHARS) {
    throw new FrontendGenerationError(`custom_api.key is too long (${key.length} > ${MAX_API_KEY_CHARS})`)
  }
  if (/[\r\n\u0000]/.test(key)) {
    throw new FrontendGenerationError('custom_api.key must not contain line breaks or NUL characters')
  }
  const model = requireModel
    ? requireText(record.model, 'custom_api.model', 256)
    : (typeof record.model === 'string' ? record.model.trim() : '')
  return { baseUrl: normalizeBaseUrl(url), key, model }
}

function authHeaders(target: CustomApiTarget): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (target.key !== '') headers.authorization = `Bearer ${target.key}`
  return headers
}

function redactSecret(value: string, secret: string): string {
  return secret === '' ? value : value.split(secret).join('[redacted]')
}

function bodySnippet(value: string, secret: string): string {
  const text = redactSecret(value, secret).replace(/\s+/g, ' ').trim()
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

async function requestJson(
  endpoint: string,
  init: RequestInit,
  label: string,
  secret: string,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new FrontendGenerationError(`custom API ${label} request failed: ${redactSecret(reason, secret)}`)
  }
  const declaredLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    if (response.body !== null) await response.body.cancel().catch(() => undefined)
    throw new FrontendGenerationError(`custom API ${label} response is too large (${declaredLength} bytes)`)
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new FrontendGenerationError(`custom API ${label} response is too large (${text.length} characters)`)
  }
  if (!response.ok) {
    throw new FrontendGenerationError(
      `custom API ${label} failed: HTTP ${response.status} ${response.statusText}: ${bodySnippet(text, secret)}`,
    )
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new FrontendGenerationError(`custom API ${label} returned invalid JSON: ${bodySnippet(text, secret)}`)
  }
}

function modelIds(payload: unknown): string[] {
  const record = asRecord(payload)
  const list = record === undefined
    ? []
    : (Array.isArray(record.data) ? record.data : (Array.isArray(record.models) ? record.models : []))
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (id !== '') ids.push(id)
      continue
    }
    const item = asRecord(entry)
    if (item === undefined) continue
    const id = typeof item.id === 'string' ? item.id.trim() : (typeof item.name === 'string' ? item.name.trim() : '')
    if (id !== '') ids.push(id)
  }
  return [...new Set(ids)].sort()
}

/** GET /models against the card-owned API source. */
export async function listCustomApiModels(value: unknown): Promise<string[]> {
  const target = parseApiTarget(value, false)
  const payload = await requestJson(
    `${target.baseUrl}/models`,
    { method: 'GET', headers: authHeaders(target) },
    'models',
    target.key,
  )
  const models = modelIds(payload)
  if (models.length === 0) {
    throw new FrontendGenerationError('custom API /models returned no model ids; check the API URL and key')
  }
  return models.slice(0, 500)
}

function parseRole(value: unknown, fallback: ChatRole): ChatRole {
  return value === 'system' || value === 'user' || value === 'assistant' ? value : fallback
}

function buildMessages(config: Record<string, unknown>): ChatMessage[] {
  const messages: ChatMessage[] = []
  const injects = Array.isArray(config.injects) ? config.injects : []
  for (const entry of injects) {
    const inject = asRecord(entry)
    if (inject === undefined) continue
    if (inject.position === 'none') continue
    if (typeof inject.content !== 'string' || inject.content.trim() === '') continue
    messages.push({ role: parseRole(inject.role, 'system'), content: inject.content })
  }
  const overrides = asRecord(config.overrides)
  const history = asRecord(overrides?.chat_history)
  const prompts = history !== undefined && Array.isArray(history.prompts) ? history.prompts : []
  for (const entry of prompts) {
    const prompt = asRecord(entry)
    if (prompt === undefined) continue
    if (typeof prompt.content !== 'string') {
      throw new FrontendGenerationError('overrides.chat_history.prompts[].content must be a string')
    }
    messages.push({ role: parseRole(prompt.role, 'user'), content: prompt.content })
  }
  const userInput = typeof config.user_input === 'string' ? config.user_input : ''
  if (userInput.trim() !== '') messages.push({ role: 'user', content: userInput })
  if (messages.length === 0) {
    throw new FrontendGenerationError('TavernHelper.generate needs user_input or chat history prompts')
  }
  if (messages.length > MAX_MESSAGES) {
    throw new FrontendGenerationError(`too many prompt messages (${messages.length} > ${MAX_MESSAGES})`)
  }
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0)
  if (totalChars > MAX_PROMPT_CHARS) {
    throw new FrontendGenerationError(`prompt is too large (${totalChars} > ${MAX_PROMPT_CHARS} characters)`)
  }
  return messages
}

function completionText(payload: unknown): string {
  const record = asRecord(payload)
  const choices = record !== undefined && Array.isArray(record.choices) ? record.choices : []
  const first = choices.length > 0 ? asRecord(choices[0]) : undefined
  if (first === undefined) {
    throw new FrontendGenerationError('custom API /chat/completions returned no choices')
  }
  const message = asRecord(first.message)
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      const item = asRecord(part)
      return item !== undefined && typeof item.text === 'string' ? item.text : ''
    }).join('')
  }
  if (typeof first.text === 'string') return first.text
  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : 'unknown'
  throw new FrontendGenerationError(`custom API /chat/completions returned no text (finish_reason=${finishReason})`)
}

/**
 * Non-streaming `TavernHelper.generate` equivalent. `value` is the card's
 * GenerateConfig; only `custom_api`, `user_input`, `injects` and
 * `overrides.chat_history.prompts` participate. `should_stream` is accepted and
 * served as one final response (the card's default setting is off).
 */
export async function generateWithCustomApi(value: unknown): Promise<string> {
  const config = asRecord(value)
  if (config === undefined) throw new FrontendGenerationError('generate config must be an object')
  const target = parseApiTarget(config.custom_api, true)
  const messages = buildMessages(config)
  const payload = await requestJson(
    `${target.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: authHeaders(target),
      body: JSON.stringify({ model: target.model, messages, stream: false }),
    },
    'chat/completions',
    target.key,
  )
  const text = completionText(payload)
  if (text.trim() === '') {
    throw new FrontendGenerationError('custom API /chat/completions returned an empty response')
  }
  return text
}
