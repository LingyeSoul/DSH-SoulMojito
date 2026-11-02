// Explicit route table for the top-level API domains. Each entry owns one
// prefix family. Table position is behavior: PRE_STORE_ROUTES run before the
// Tavern store is opened, EARLY_STORE_ROUTES run immediately after it.

import type { TavernStore } from '../../../tavern-store/src/index.js'
import { handleGamesApi, isGamesRoute } from '../games/http.js'
import type { PluginContext } from '../host-contract.js'
import { getGamesServicePromise, getImRuntime } from '../runtime.js'
import { handleImApi } from './im.js'
import type { HttpRequest, HttpResponse } from './io.js'
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
  readonly matches: (route: string) => boolean
  readonly handle: (context: C) => Promise<void>
}

export const PRE_STORE_ROUTES: readonly RouteEntry<RouteContext>[] = [
  // Self-update answers even when the store cannot open; upgrading is the way
  // out of a broken data or compatibility state.
  {
    name: 'update',
    matches: (route) => route === 'update' || route.startsWith('update/'),
    handle: ({ ctx, req, res, url, route, method }) => handleUpdateApi(ctx, req, res, url, route, method),
  },
  // The games bridge keeps its own games/ directory and session storage, so it
  // must not wait for the Tavern store either.
  {
    name: 'games',
    matches: isGamesRoute,
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
    matches: (route) => route === 'im' || route.startsWith('im/'),
    handle: ({ req, res, url, route, method, db }) => handleImApi(req, res, url, route, method, db, getImRuntime()),
  },
]
