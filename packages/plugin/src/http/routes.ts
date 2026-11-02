// Explicit route table for the top-level API domains. Each entry owns one
// prefix family. Table position is behavior: PRE_STORE_ROUTES run before the
// Tavern store is opened, EARLY_STORE_ROUTES run immediately after it, and
// STORE_ROUTES carry the post-store domain branches in their old if-chain
// order.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { handleGamesApi, isGamesRoute } from '../games/http.js'
import type { PluginContext } from '../host-contract.js'
import { getGamesServicePromise, getImRuntime } from '../runtime.js'
import { handleAgentTavernBodyApi } from './body-api.js'
import {
  handleCharacterDeleteRoute,
  handleCharacterExportRoute,
  handleCharacterUpdateRoute,
} from './character-routes.js'
import {
  handleAuditRoute,
  handleAvatarRoute,
  handleCharacterReadRoute,
  handleCompactRoute,
  handleProjectionReplayRoute,
  handleProjectionRoute,
} from './domain-routes.js'
import { handleImApi } from './im.js'
import type { HttpRequest, HttpResponse } from './io.js'
import { handleModsApi } from './mods.js'
import { handleNovelsApi } from './novel.js'
import { handleGuidesApi, handleScriptApi } from './panel.js'
import {
  handleGroupCreateRoute,
  handleGroupDeleteRoute,
  handleGroupsListRoute,
  handleGroupUpdateRoute,
  handlePersonaAvatarRoute,
  handlePersonaDeleteRoute,
  handlePersonaImportRoute,
  handlePersonaUpdateRoute,
} from './persona-group-routes.js'
import { handleBootstrapApi, handleStateSlicesApi, handleStoreRevisionApi } from './read-routes.js'
import { handleUpdateApi } from './update.js'

export interface RouteContext {
  readonly ctx: PluginContext
  readonly req: HttpRequest
  readonly res: HttpResponse
  readonly url: URL
  readonly route: string
  readonly method: string
}

export interface StoreRouteContext extends RouteContext {
  readonly db: TavernStore
}

export interface RouteEntry<C extends RouteContext> {
  readonly name: string
  readonly matches: (route: string, method: string) => boolean
  readonly handle: (context: C) => Promise<void>
}

export const PRE_STORE_ROUTES: readonly RouteEntry<RouteContext>[] = [
  // Self-update answers even when the store cannot open; upgrading is the way
  // out of a broken data or compatibility state.
  {
    name: 'update',
    matches: (route, _method) => route === 'update' || route.startsWith('update/'),
    handle: ({ ctx, req, res, url, route, method }) => handleUpdateApi(ctx, req, res, url, route, method),
  },
  // The games bridge keeps its own games/ directory and session storage, so it
  // must not wait for the Tavern store either.
  {
    name: 'games',
    matches: (route, _method) => isGamesRoute(route),
    handle: ({ req, res, url, route, method }) => handleGamesApi({
      resolveService: () => getGamesServicePromise(),
      req,
      res,
      url,
      route,
      method,
    }),
  },
]

export const EARLY_STORE_ROUTES: readonly RouteEntry<StoreRouteContext>[] = [
  // IM management stays reachable while channels are offline; a disabled or
  // unmounted runtime reports its reasons instead of failing the panel.
  {
    name: 'im',
    matches: (route, _method) => route === 'im' || route.startsWith('im/'),
    handle: ({ req, res, url, route, method, db }) => handleImApi(req, res, url, route, method, db, getImRuntime()),
  },
  // Panel reads: bootstrap is the light first read, store-revision the change
  // watermark polled while the page is visible, and state-slices the heavy
  // regex table fetched when its section first mounts. Method gating stays in
  // `matches`, so a non-GET request falls through to the unchanged if-chain.
  {
    name: 'bootstrap',
    matches: (route, method) => method === 'GET' && route === 'bootstrap',
    handle: ({ ctx, res, db }) => handleBootstrapApi(ctx, res, db),
  },
  {
    name: 'store-revision',
    matches: (route, method) => method === 'GET' && route === 'store-revision',
    handle: ({ res, db }) => handleStoreRevisionApi(res, db),
  },
  {
    name: 'state-slices',
    matches: (route, method) => method === 'GET' && route === 'state-slices',
    handle: ({ res, db }) => handleStateSlicesApi(res, db),
  },
]

export const STORE_ROUTES: readonly RouteEntry<StoreRouteContext>[] = [
  // Read-only projections and one-shot host commands. Method gating stays in
  // `matches`, so a wrong-method request keeps falling through to the chain.
  {
    name: 'avatar',
    matches: (route, method) => method === 'GET' && route.startsWith('avatar/'),
    handle: ({ db, res, route }) => handleAvatarRoute(db, res, route),
  },
  {
    name: 'character-read',
    matches: (route, method) => method === 'GET' && route.startsWith('character/'),
    handle: ({ db, res, route }) => handleCharacterReadRoute(db, res, route),
  },
  {
    name: 'projection',
    matches: (route, method) => method === 'GET' && route === 'projection',
    handle: ({ res, url }) => handleProjectionRoute(res, url),
  },
  {
    name: 'projection-replay',
    matches: (route, method) => method === 'POST' && route === 'projection/replay',
    handle: ({ ctx, db, req, res, url }) => handleProjectionReplayRoute(ctx, db, req, res, url),
  },
  {
    name: 'compact',
    matches: (route, method) => method === 'POST' && route === 'compact',
    handle: ({ ctx, req, res, url }) => handleCompactRoute(ctx, req, res, url),
  },
  // 持续指引（提案 0009）：guide 属于单局聊天，随 chat_metadata 持久化；
  // 读写走 getChatSnapshot + saveChat 的 revision CAS，与聊天写路径一致。
  // 路径段解码与 character/ 前缀路由同款 decodeURIComponent（角色名可含空格/中文）。
  {
    name: 'guides',
    matches: (route, method) => (method === 'GET' || method === 'POST' || method === 'DELETE') && route.startsWith('guides/'),
    handle: ({ req, res, route, method, db }) => handleGuidesApi(req, res, route, method, db),
  },
  // ---- 剧本游玩（提案 0014 P1）----
  // 剧本库：TXT/MD 素材分块存 <tavern>/scripts/<name>/script.json；绑定在卡
  // data.extensions.agentTavern.scriptId（一对一）；进度在 chat_metadata.scriptProgress，
  // 由生成链路的对齐推进写。进度是展示不是跳章（§4）：没有写进度的路由。
  {
    name: 'script',
    matches: (route, method) => (method === 'GET' || method === 'POST')
      && (route === 'scripts' || route === 'script/import' || route === 'script/bind' || route === 'script/unbind' || route.startsWith('script/')),
    handle: ({ req, res, route, method, db }) => handleScriptApi(req, res, route, method, db),
  },
  {
    name: 'agent-tavern-audit',
    matches: (route, method) => method === 'GET' && route === 'agent-tavern/audit',
    handle: ({ db, res, url }) => handleAuditRoute(db, res, url),
  },
  // ---- AgentTavern body operations (proposal 0021 §7.3) ----
  // GET is a display lookup with a stable empty body (never 500 for a cold or
  // unprojected session); mutations are serialized inside the runtime's
  // per-session `withBodyLock`, so no outer lock is taken here.
  {
    name: 'body',
    matches: (route, method) => ((method === 'GET' || method === 'PUT') && route === 'body')
      || (method === 'POST' && (route === 'body/regenerate' || route === 'body/select')),
    handle: ({ ctx, db, req, res, url, route, method }) => handleAgentTavernBodyApi(ctx, db, req, res, url, route, method),
  },
  // Novel and mod surfaces own their subpaths; the outer table only decides
  // that the family belongs to them.
  {
    name: 'novels',
    matches: (route, _method) => route === 'novels' || route.startsWith('novels/'),
    handle: ({ ctx, req, res, url, route, method }) => handleNovelsApi(ctx, req, res, url, route, method),
  },
  // ---- Mod 管理面与子路由（提案 0015 §3.2/§3.3 P1）----
  // 管理面（GET mods / POST mods/state / enable|disable|reload）在任一层关闭时
  // 仍可用（否则用户无法再打开）；Mod 子路由（mods/<id>/<path>）在任一层关闭、
  // 未装载或无此路由时一律 404，与未知路由不可区分。
  {
    name: 'mods',
    matches: (route, _method) => route === 'mods' || route.startsWith('mods/'),
    handle: ({ ctx, req, res, url, route, method }) => handleModsApi(ctx, req, res, url, route, method),
  },
  // Character writes and exports are post-store; method gating stays in
  // `matches`, so a non-matching request falls through to the unchanged chain.
  {
    name: 'character-write',
    matches: (route, method) => method === 'PUT' && route.startsWith('character/'),
    handle: ({ db, req, res, route }) => handleCharacterUpdateRoute(db, req, res, route),
  },
  {
    name: 'character-delete',
    matches: (route, method) => method === 'DELETE' && route === 'character',
    handle: ({ db, res, url }) => handleCharacterDeleteRoute(db, res, url),
  },
  {
    name: 'character-export',
    matches: (route, method) => method === 'GET' && route.startsWith('export/character/'),
    handle: ({ db, res, route }) => handleCharacterExportRoute(db, res, route),
  },
  // Persona and group routes are post-store; the table keeps the original
  // if-chain order. Only the write handlers emit asset-saved events.
  {
    name: 'persona-import',
    matches: (route, method) => method === 'POST' && route === 'import/persona',
    handle: ({ db, req, res }) => handlePersonaImportRoute(db, req, res),
  },
  {
    name: 'persona-update',
    matches: (route, method) => method === 'PUT' && route === 'persona',
    handle: ({ db, req, res }) => handlePersonaUpdateRoute(db, req, res),
  },
  {
    name: 'persona-delete',
    matches: (route, method) => method === 'DELETE' && route === 'persona',
    handle: ({ db, res, url }) => handlePersonaDeleteRoute(db, res, url),
  },
  {
    name: 'persona-avatar',
    matches: (route, method) => method === 'GET' && route.startsWith('persona-avatar/'),
    handle: ({ db, res, route }) => handlePersonaAvatarRoute(db, res, route),
  },
  {
    name: 'groups-list',
    matches: (route, method) => method === 'GET' && route === 'groups',
    handle: ({ db, res }) => handleGroupsListRoute(db, res),
  },
  {
    name: 'group-create',
    matches: (route, method) => method === 'POST' && route === 'groups',
    handle: ({ db, req, res }) => handleGroupCreateRoute(db, req, res),
  },
  {
    name: 'group-update',
    matches: (route, method) => method === 'PUT' && route === 'group',
    handle: ({ db, req, res }) => handleGroupUpdateRoute(db, req, res),
  },
  {
    name: 'group-delete',
    matches: (route, method) => method === 'DELETE' && route === 'group',
    handle: ({ db, res, url }) => handleGroupDeleteRoute(db, res, url),
  },
]
