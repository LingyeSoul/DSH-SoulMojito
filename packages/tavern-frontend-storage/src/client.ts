/**
 * Sandboxed card-frontend storage shims and host-page transport.
 *
 * A sandboxed iframe has an opaque origin, so the native localStorage /
 * sessionStorage / IndexedDB APIs throw. The emitted source text below installs
 * in-memory localStorage/sessionStorage and a virtual IndexedDB backed by the
 * plugin's binary HTTP routes. The shims are embedded inside the TavernHelper
 * runtime IIFE, which is why they are source builders rather than imports.
 *
 * Host-page transport (encode/query/meta) stays here too so the plugin only
 * wires request and reply; the binary channel never leaks into UI code.
 */

const IDB_META_HEADER = 'x-dsh-idb-meta'

/**
 * localStorage + sessionStorage shim. Expects the surrounding runtime to pass
 * `initialStorage`, `call` and `showToast`; writes are debounced and persisted
 * through the `storage.set` helper op.
 */
export function localStorageIframeSource(): string {
  return `(function (initialStorage, call, showToast) {
  // 沙箱无 same-origin：原生 localStorage/sessionStorage 访问即抛 SecurityError。
  // localStorage 以宿主持久表播种（FrontendFrame 构建 srcdoc 前取回），写入
  // 200ms 合并后经 storage.set 写回；sessionStorage 保持 iframe 内存语义。
  function createMemoryStorage(seed, persistent) {
    var data = {};
    if (seed && typeof seed === 'object') {
      Object.keys(seed).forEach(function (key) {
        if (typeof seed[key] === 'string') data[key] = seed[key];
      });
    }
    var persistTimer = null;
    var persistFailed = false;
    function persist() {
      persistTimer = null;
      if (persistent !== true) return;
      call('storage.set', { storage: Object.assign({}, data) }).catch(function (error) {
        if (persistFailed) return;
        persistFailed = true;
        console.error('[TavernHelper] localStorage persist failed', error);
        showToast('error', 'localStorage 持久化失败：' + (error && error.message ? error.message : String(error)));
      });
    }
    function schedulePersist() {
      if (persistent !== true || persistTimer !== null) return;
      persistTimer = setTimeout(persist, 200);
    }
    addEventListener('pagehide', function () {
      if (persistTimer === null) return;
      clearTimeout(persistTimer);
      persist();
    });
    return {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, String(key)) ? data[String(key)] : null; },
      setItem: function (key, value) { data[String(key)] = String(value); schedulePersist(); },
      removeItem: function (key) { delete data[String(key)]; schedulePersist(); },
      clear: function () { data = {}; schedulePersist(); },
      key: function (index) { return Object.keys(data)[index] || null; },
      get length() { return Object.keys(data).length; }
    };
  }
  window.__dshTavernStorage = createMemoryStorage(initialStorage, true);
  window.__dshTavernSessionStorage = createMemoryStorage({}, false);
  try { Object.defineProperty(window, 'localStorage', { value: window.__dshTavernStorage, configurable: true }); } catch (_) {}
  try { Object.defineProperty(window, 'sessionStorage', { value: window.__dshTavernSessionStorage, configurable: true }); } catch (_) {}
})(initialStorage, call, showToast);
`
}

/**
 * Virtual IndexedDB shim. Expects the surrounding runtime to pass `call` and
 * `clone`; record bytes travel over frontend/idb/get|put.
 */
export function indexedDbIframeSource(): string {
  return `(function (call, clone) {
  // 虚拟 IndexedDB（2026-10-22）：沙箱 opaque origin 拿不到真实 IndexedDB。
  // 这个垫片只实现卡常用的 open / createObjectStore / transaction / get / put /
  // delete / clear / deleteDatabase；记录体经宿主二进制路由按角色落盘，iframe
  // 不接触宿主 Origin、Cookie 或真实浏览器配额。
  function idbRequest() {
    return {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
  }
  function idbFire(request, result) {
    request.result = result;
    try { if (request.onsuccess) request.onsuccess({ target: request }); } catch (error) { console.error('[idb] onsuccess failed', error); }
  }
  function idbFail(request, error) {
    request.error = error;
    try { if (request.onerror) request.onerror({ target: request, error: error }); } catch (cause) { console.error('[idb] onerror failed', cause); }
  }
  function IdbDatabase(name) {
    var self = this;
    self.name = name;
    self.version = 0;
    self._stores = {};
    self._pending = [];
    self.objectStoreNames = {
      contains: function (storeName) { return Object.prototype.hasOwnProperty.call(self._stores, String(storeName)); },
      item: function (index) { return Object.keys(self._stores)[index] || null; },
      get length() { return Object.keys(self._stores).length; },
    };
  }
  IdbDatabase.prototype.createObjectStore = function (storeName, options) {
    var name = String(storeName);
    var keyPath = options && typeof options.keyPath === 'string' ? options.keyPath : '';
    this._stores[name] = { keyPath: keyPath };
    var dbName = this.name;
    var pending = call('idb.store.create', { db: dbName, store: name, keyPath: keyPath });
    this._pending.push(pending);
    return { name: name, keyPath: keyPath };
  };
  IdbDatabase.prototype.transaction = function (storeNames, mode) {
    return new IdbTransaction(this, storeNames, mode);
  };
  IdbDatabase.prototype.close = function () {};
  function IdbTransaction(db, storeNames, mode) {
    var self = this;
    self.db = db;
    self.mode = mode === 'readwrite' ? 'readwrite' : 'readonly';
    self.oncomplete = null;
    self.onerror = null;
    self.onabort = null;
    self.error = null;
    self._pending = [];
    self._settled = false;
    self._drainQueued = false;
    self._storeNames = Array.isArray(storeNames) ? storeNames.map(String) : [String(storeNames)];
    self._schedule();
  }
  IdbTransaction.prototype._schedule = function () {
    var self = this;
    if (self._drainQueued || self._settled) return;
    self._drainQueued = true;
    // A macrotask gives the synchronous transaction body (objectStore().get/put
    // in a row, or get().onsuccess -> put()) time to register requests. The
    // drain loop re-checks after each batch, so follow-up puts are awaited too.
    setTimeout(function () {
      self._drainQueued = false;
      self._drain();
    }, 0);
  };
  IdbTransaction.prototype._drain = function () {
    var self = this;
    if (self._settled) return;
    if (self._pending.length === 0) {
      self._complete();
      return;
    }
    var batch = self._pending;
    self._pending = [];
    Promise.allSettled(batch).then(function (results) {
      if (self._settled) return;
      var failure = results.filter(function (result) { return result.status === 'rejected'; })[0];
      if (failure !== undefined) {
        self.error = failure.reason;
        self._settled = true;
        try { if (self.onerror) self.onerror({ target: self, error: self.error }); } catch (error) { console.error('[idb] tx onerror failed', error); }
        try { if (self.onabort) self.onabort({ target: self }); } catch (error) { console.error('[idb] tx onabort failed', error); }
        return;
      }
      self._drain();
    });
  };
  IdbTransaction.prototype._complete = function () {
    if (this._settled) return;
    this._settled = true;
    try { if (this.oncomplete) this.oncomplete({ target: this }); } catch (error) { console.error('[idb] tx oncomplete failed', error); }
  };
  IdbTransaction.prototype._track = function (promise) {
    this._pending.push(promise);
    this._schedule();
  };
  IdbTransaction.prototype.objectStore = function (storeName) {
    return new IdbObjectStore(this, String(storeName));
  };
  function IdbObjectStore(transaction, name) {
    this.transaction = transaction;
    this.name = name;
    var descriptor = transaction.db._stores[name];
    this.keyPath = descriptor && typeof descriptor.keyPath === 'string' ? descriptor.keyPath : '';
  }
  IdbObjectStore.prototype.get = function (key) {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.get', { db: tx.db.name, store: this.name, key: key }).then(function (value) {
      var record = value && value.record !== undefined ? value.record : undefined;
      idbFire(request, record);
      return record;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.put = function (value) {
    var request = idbRequest();
    var tx = this.transaction;
    var record = value && typeof value === 'object' ? value : null;
    var bytes = record !== null ? record.bytes : null;
    if (ArrayBuffer.isView(bytes)) bytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (!(bytes instanceof ArrayBuffer)) {
      var error = new Error('idb.put requires a record with an ArrayBuffer bytes field');
      idbFail(request, error);
      tx._track(Promise.reject(error));
      return request;
    }
    var key = record !== null ? record.key : undefined;
    var meta = {};
    if (record !== null) {
      Object.keys(record).forEach(function (name) {
        if (name !== 'bytes') meta[name] = clone(record[name]);
      });
    }
    var promise = call('idb.put', { db: tx.db.name, store: this.name, key: key, meta: meta, bytes: bytes }, [bytes]).then(function (result) {
      idbFire(request, key);
      return result;
    }, function (cause) {
      idbFail(request, cause);
      throw cause;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.delete = function (key) {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.delete', { db: tx.db.name, store: this.name, key: key }).then(function (result) {
      idbFire(request, undefined);
      return result;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  IdbObjectStore.prototype.clear = function () {
    var request = idbRequest();
    var tx = this.transaction;
    var promise = call('idb.clear', { db: tx.db.name, store: this.name }).then(function (result) {
      idbFire(request, undefined);
      return result;
    }, function (error) {
      idbFail(request, error);
      throw error;
    });
    tx._track(promise);
    return request;
  };
  var idbShim = {
    open: function (name, version) {
      var request = idbRequest();
      var db = new IdbDatabase(String(name));
      call('idb.open', { name: String(name), version: version }).then(function (value) {
        db.version = value && typeof value.version === 'number' ? value.version : 0;
        var stores = value && Array.isArray(value.stores) ? value.stores : [];
        stores.forEach(function (storeName) { db._stores[String(storeName)] = { keyPath: '' }; });
        var previousVersion = value && typeof value.previousVersion === 'number' ? value.previousVersion : 0;
        var requested = typeof version === 'number' && version > 0 ? version : 1;
        request.result = db;
        if (requested > previousVersion && request.onupgradeneeded) {
          try {
            request.onupgradeneeded({ target: request, oldVersion: previousVersion, newVersion: requested });
          } catch (error) {
            idbFail(request, error);
            return;
          }
        }
        Promise.all(db._pending).then(function () { idbFire(request, db); }, function (error) { idbFail(request, error); });
      }, function (error) { idbFail(request, error); });
      return request;
    },
    deleteDatabase: function (name) {
      var request = idbRequest();
      call('idb.delete-db', { db: String(name) }).then(function () { idbFire(request, undefined); }, function (error) { idbFail(request, error); });
      return request;
    },
  };
  try {
    Object.defineProperty(window, 'indexedDB', { value: idbShim, configurable: true });
  } catch (_) {
    try { window.indexedDB = idbShim; } catch (_) {}
  }

})(call, clone);
`
}

/** Both shim sources in the order the runtime embeds them. */
export interface FrontendStorageIframeSources {
  localStorage: string
  indexedDb: string
}

export function iframeSources(): FrontendStorageIframeSources {
  return { localStorage: localStorageIframeSource(), indexedDb: indexedDbIframeSource() }
}

/**
 * Serialize the localStorage seed for a srcdoc `<script>`. Escaping `<` and the
 * two JavaScript line separators keeps card-controlled strings from closing the
 * script tag or breaking the parser.
 */
export function serializeFrontendStorageSeed(storage: unknown): string {
  const value = typeof storage === 'object' && storage !== null && !Array.isArray(storage) ? storage : {}
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = padded.length % 4
  const binary = atob(remainder === 0 ? padded : `${padded}${'='.repeat(4 - remainder)}`)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder().decode(bytes)
}

export function idbQuery(character: string, payload: Record<string, unknown>): string {
  const query = new URLSearchParams()
  query.set('character', character)
  for (const field of ['db', 'store', 'key']) {
    if (payload[field] !== undefined) query.set(field, String(payload[field]))
  }
  return query.toString()
}

export interface IdbFetchResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
}

export type IdbFetch = (
  url: string,
  init: { cache: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer },
) => Promise<IdbFetchResponse>

export function readIdbMetaHeader(response: IdbFetchResponse): Record<string, unknown> {
  const header = response.headers.get(IDB_META_HEADER)
  if (header === null || header === '') return {}
  try {
    const parsed = JSON.parse(decodeBase64Url(header)) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (error) {
    console.warn('dsh-soulmojito: invalid idb metadata header', error)
    return {}
  }
}

export const IDB_BRIDGE_OPS: readonly string[] = ['idb.get', 'idb.put']

export function isIdbBridgeOp(op: string): boolean {
  return IDB_BRIDGE_OPS.includes(op)
}

export interface IdbBridgeResult {
  value: unknown
  transfer: ArrayBuffer[]
}

async function responseBody(response: IdbFetchResponse): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await response.json() as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function failureMessage(response: IdbFetchResponse, body: Record<string, unknown> | undefined): string {
  const message = body?.message
  return typeof message === 'string' && message !== '' ? message : `HTTP ${response.status}`
}

/**
 * Run one binary IndexedDB bridge request. The plugin appends the session
 * binding (`character`) and replies with the returned value + transfer list.
 */
export async function handleIdbBridge(
  op: string,
  payload: Record<string, unknown>,
  character: string,
  apiUrl: string,
  fetchImpl: IdbFetch,
): Promise<IdbBridgeResult> {
  if (op === 'idb.get') {
    const response = await fetchImpl(`${apiUrl}/frontend/idb/get?${idbQuery(character, payload)}`, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error(failureMessage(response, await responseBody(response)))
    }
    const bytes = await response.arrayBuffer()
    const meta = readIdbMetaHeader(response)
    return { value: { record: { key: payload.key, bytes, ...meta } }, transfer: [bytes] }
  }
  if (op === 'idb.put') {
    const bytes = payload.bytes
    if (!(bytes instanceof ArrayBuffer)) {
      throw new Error('idb.put requires an ArrayBuffer payload')
    }
    const meta = typeof payload.meta === 'object' && payload.meta !== null && !Array.isArray(payload.meta)
      ? payload.meta as Record<string, unknown>
      : {}
    const response = await fetchImpl(`${apiUrl}/frontend/idb/put?${idbQuery(character, payload)}`, {
      cache: 'no-store',
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        [IDB_META_HEADER]: encodeBase64Url(JSON.stringify(meta)),
      },
      body: bytes,
    })
    const body = await responseBody(response)
    if (!response.ok || body?.ok === false) {
      throw new Error(failureMessage(response, body))
    }
    return { value: body?.value ?? {}, transfer: [] }
  }
  throw new Error(`unsupported idb bridge op '${op}'`)
}
