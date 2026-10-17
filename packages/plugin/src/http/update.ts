import { tavernUpdate } from '../runtime.js'
import { updateChangelog } from '../update/service.js'
import { readJson, sendJson } from './io.js'

/**
 * `/api/dsh-soulmojito/update` 路由族：
 * - `GET  update`         → 缓存快照（`?refresh=1` 穿透 TTL 重新检查）；
 * - `POST update/check`   → 强制检查远端；
 * - `POST update/install` → 开始安装。默认等安装结束再回；`{ wait: false }`
 *   立刻返回，客户端轮询 `GET update` 读进度（安装本身跑在本进程里，不会因
 *   浏览器断开而中断）。
 */
export async function handleUpdateApi(ctx, req, res, url, route, method) {
  const service = tavernUpdate(ctx)
  if (method === 'GET' && route === 'update') {
    const refresh = url.searchParams.get('refresh')
    const fresh = refresh === '1' || refresh === 'true'
    const snapshot = fresh ? await service.check({ force: true }) : service.snapshot()
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  if (method === 'POST' && route === 'update/check') {
    const snapshot = await service.check({ force: true })
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  if (method === 'POST' && route === 'update/install') {
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>)
    const force = body.force === true
    if (body.wait === false) {
      void service.install({ force }).catch(() => {})
      const snapshot = service.snapshot()
      return sendJson(res, 200, { ok: true, started: true, update: snapshot, changelog: updateChangelog(snapshot) })
    }
    const snapshot = await service.install({ force })
    return sendJson(res, 200, { ok: true, update: snapshot, changelog: updateChangelog(snapshot) })
  }
  return sendJson(res, 404, { ok: false, message: `route not found: ${method} ${route}` })
}
