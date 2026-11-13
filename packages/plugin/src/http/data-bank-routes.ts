// Data Bank HTTP routes (Wave 2 contract §2.2): text import, listing, deletion,
// retrieval probe and the ST chat attachment write. The table entry in
// `routes.ts` is registered by the main integration pass — this module only
// owns the handler so two owners never edit the same route table.

import { normalizeMemoryEmbedding, type TavernStore } from '../../../tavern-store/src/index.js'
import {
  DATA_BANK_MAX_BYTES,
  DATA_BANK_SEARCH_LIMIT_MAX,
  DataBankError,
  deleteDataBankFile,
  importDataBankText,
  listDataBank,
  searchDataBank,
  setChatDataBankIds,
} from '../data-bank.js'
import { tavernDataRoot } from '../dsh-home.js'
import { HttpError } from './errors.js'
import { readJson, sendJson, sendRouteNotFound, type HttpRequest, type HttpResponse } from './io.js'

/** Content-Type 白名单之外的请求体在 `readJson` 已拒绝；这里再放行 base64 膨胀。 */
const MAX_IMPORT_BODY_BYTES = Math.ceil(DATA_BANK_MAX_BYTES / 3) * 4 + 4096

function reject(status: number, message: string): never {
  throw new HttpError(status, message)
}

/** DataBankError → HttpError（数据银行核心保持 web 无关）。 */
async function withDomainErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (cause) {
    if (cause instanceof DataBankError) reject(cause.status, cause.message)
    throw cause
  }
}

function parseQueryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) reject(400, 'limit must be an integer')
  return Math.max(1, Math.min(DATA_BANK_SEARCH_LIMIT_MAX, value as number))
}

export async function handleDataBankRoute(
  db: TavernStore,
  req: HttpRequest,
  res: HttpResponse,
  route: string,
  method: string,
): Promise<void> {
  const root = tavernDataRoot()

  if (method === 'POST' && route === 'import/data-bank') {
    const body = await readJson(req, MAX_IMPORT_BODY_BYTES)
    const encoded = body['contentBase64']
    if (typeof encoded !== 'string' || encoded.trim() === '') reject(400, 'expected { name, contentBase64 }')
    const bytes = Buffer.from(encoded as string, 'base64')
    if (bytes.byteLength > DATA_BANK_MAX_BYTES) {
      reject(413, `content exceeds the ${DATA_BANK_MAX_BYTES} byte data bank limit`)
    }
    // UTF-8 解码到这里即可：核心模块拒绝 NUL 字节（二进制防线）。
    const content = bytes.toString('utf8')
    const result = await withDomainErrors(() => importDataBankText(root, {
      name: body['name'],
      mime: body['mime'],
      content,
    }))
    return sendJson(res, 200, {
      ok: true,
      created: result.created,
      id: result.file.id,
      name: result.file.name,
      mime: result.file.mime,
      size: result.file.size,
      chunks: result.file.chunks.length,
    })
  }

  if (method === 'GET' && route === 'data-bank') {
    const files = await listDataBank(root)
    const config = normalizeMemoryEmbedding((await db.getState()).memoryEmbedding)
    return sendJson(res, 200, { ok: true, files, embedding: { configured: config !== undefined } })
  }

  // 前缀分支放在精确路径之后（`data-bank/search` 是 POST，不与 DELETE 前缀抢）。
  if (method === 'POST' && route === 'data-bank/search') {
    const body = await readJson(req)
    const query = body['query']
    if (typeof query !== 'string' || query.trim() === '') reject(400, 'query is required')
    const limit = parseQueryLimit(body['limit'])
    const config = normalizeMemoryEmbedding((await db.getState()).memoryEmbedding)
    const result = await searchDataBank(root, query, {
      ...(limit === undefined ? {} : { limit }),
      ...(config === undefined ? {} : { config }),
    })
    return sendJson(res, 200, { ok: true, mode: result.mode, hits: result.hits })
  }

  if (method === 'DELETE' && route.startsWith('data-bank/')) {
    const raw = route.slice('data-bank/'.length)
    // 畸形 % 转义不抛 500：保留原文，核心的 16-hex 校验会给出 400。
    let id = raw
    try { id = decodeURIComponent(raw) } catch { /* keep the raw segment */ }
    const deleted = await withDomainErrors(() => deleteDataBankFile(root, id))
    if (!deleted) return sendJson(res, 404, { ok: false, message: `data bank file '${id}' not found` })
    return sendJson(res, 200, { ok: true, id, deleted: true })
  }

  if (method === 'PUT' && route === 'chat-data-bank') {
    const body = await readJson(req)
    const character = body['character']
    const chatId = body['chatId']
    if (typeof character !== 'string' || character.trim() === '') reject(400, 'character is required')
    if (typeof chatId !== 'string' || chatId.trim() === '') reject(400, 'chatId is required')
    const ids = body['ids']
    if (!Array.isArray(ids)) reject(400, 'ids must be an array of data bank ids')
    const result = await withDomainErrors(() => setChatDataBankIds(db, {
      root,
      character: character as string,
      chatId: chatId as string,
      ids,
    }))
    if (result === undefined) return sendJson(res, 404, { ok: false, message: 'chat not found' })
    return sendJson(res, 200, { ok: true, ids: result.ids, revision: result.revision })
  }

  return sendRouteNotFound(res, method, route)
}