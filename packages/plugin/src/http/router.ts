import type { PluginContext } from '../host-contract.js'
import { store } from '../runtime.js'
import { sendJson, type HttpRequest, type HttpResponse } from './io.js'
import { EARLY_STORE_ROUTES, PRE_STORE_ROUTES, STORE_ROUTES } from './routes.js'

// The body handler moved to `body-api.ts`; the router module keeps re-exporting
// it so callers that import it from here do not break.
export { handleAgentTavernBodyApi } from './body-api.js'

export const API = '/api/dsh-soulmojito'
export async function handleApi(ctx: PluginContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  const url = new URL(req.url ?? API, 'http://localhost')
  const route = url.pathname.slice(API.length).replace(/^\//, '')
  const method = req.method ?? 'GET'

  for (const entry of PRE_STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method })
    return
  }

  const db = await store()

  for (const entry of EARLY_STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method, db })
    return
  }

  for (const entry of STORE_ROUTES) {
    if (!entry.matches(route, method)) continue
    await entry.handle({ ctx, req, res, url, route, method, db })
    return
  }

  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}
