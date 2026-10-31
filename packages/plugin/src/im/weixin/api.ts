/**
 * 微信官方 iLink HTTP 客户端（提案 0024 §2.2 / M4）。
 *
 * 六个端点、一层校验：取二维码、轮询扫码状态、长轮询收消息、发消息、取配置、
 * 发输入状态。协议细节（路径、鉴权头、超时、HTTP 与业务 `ret` 的两套错误面）
 * 全部收在这里；重试、暂停、游标推进由 `channel.ts` 决定，本模块不认识 store。
 *
 * 两条来自协议、必须记住的事实：
 * 1. `ret` / `errcode` 与 HTTP 状态是两套错误面。`-14` 表示 token 失效，
 *    调用方据此暂停账号，不能当成普通网络错误重试。
 * 2. 长轮询由服务端挂起，客户端超时是正常返回（空页），不是故障；外部中止
 *    则必须原样抛出，让轮询循环立刻退出。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { BUILD_INFO } from '../../build-info.js'

/** 固定入口：二维码流程从这一个 host 开始，确认后由服务端给 `baseurl`。 */
export const WEIXIN_FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** 媒体 CDN：上传/下载附件的默认入口（协议给出的 c2c 域名）。 */
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** 当前通道使用的 `bot_type`（参考实现同样是 3）。 */
export const WEIXIN_DEFAULT_BOT_TYPE = '3'
/** token 失效：`ret` 或 `errcode` 等于它时暂停该账号。 */
export const WEIXIN_STALE_TOKEN_RETCODE = -14

const ILINK_APP_ID = 'bot'
const BOT_AGENT = 'DSH-SoulMojito'
/** 扫码状态轮询的已知状态；未知值按协议破坏处理，不当成 wait。 */
const QRCODE_STATUSES = [
  'wait',
  'scaned',
  'confirmed',
  'expired',
  'need_verifycode',
  'verify_code_blocked',
  'scaned_but_redirect',
  'binded_redirect',
] as const

export type WeixinQrcodeStatus = (typeof QRCODE_STATUSES)[number]

export type WeixinApiErrorCode = 'WEIXIN_HTTP' | 'WEIXIN_API' | 'WEIXIN_BAD_BODY'

export interface WeixinApiErrorOptions {
  status?: number
  retcode?: number
  /** true 表示本地超时：长轮询据此返回空页。 */
  timedOut?: boolean
  cause?: unknown
}

/**
 * 通道级 HTTP 错误。三个 code 的分工：
 * - `WEIXIN_HTTP`：网络/HTTP 层失败（含本地超时），重试策略交给调用方；
 * - `WEIXIN_API`：HTTP 成功但业务 `ret`/`errcode` 非 0，`retcode` 可判 -14；
 * - `WEIXIN_BAD_BODY`：响应不是约定的 JSON 形状，字段缺失或类型不符。
 */
export class WeixinApiError extends Error {
  readonly code: WeixinApiErrorCode
  readonly status: number | undefined
  readonly retcode: number | undefined
  readonly timedOut: boolean

  constructor(code: WeixinApiErrorCode, message: string, options: WeixinApiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WeixinApiError'
    this.code = code
    this.status = options.status
    this.retcode = options.retcode
    this.timedOut = options.timedOut ?? false
  }
}

/** 每次请求的注入面：入口、token、外部中止信号与超时。 */
export interface WeixinApiContext {
  baseUrl: string
  /** Bot token；二维码端点不带它（尚未绑定）。 */
  token?: string
  signal?: AbortSignal
  timeoutMs: number
}

/** `confirmed` 换回来的凭据；由绑定器落库，本模块只做形状校验。 */
export interface WeixinCredential {
  botToken: string
  baseUrl: string
  ilinkBotId: string
  ilinkUserId?: string
}

export interface WeixinQrcode {
  /** 轮询状态用的不透明串。 */
  qrcode: string
  /** 面板展示用的二维码内容（URL 或内容串）。 */
  url: string
}

export interface WeixinQrcodeResult {
  status: WeixinQrcodeStatus
  /** `scaned_but_redirect` 时后续轮询应换到的主机。 */
  redirectHost?: string
  /** 仅 `confirmed` 出现。 */
  credential?: WeixinCredential
}

/** 一条消息里被通道认识的 item；未知类型只保留 `type`。 */
export interface WeixinMessageItem {
  readonly type: number
  /** type 1 的正文。 */
  readonly text?: string
  /** type 3 的语音转录（服务端给才有）。 */
  readonly voiceText?: string
  /** 媒体项的 CDN 全量地址；协议要求优先用 `full_url`。 */
  readonly mediaUrl?: string
  /** 与 `mediaUrl` 同值，保留协议字段名，下载路径按它选地址。 */
  readonly fullUrl?: string
  /** `media.thumb_url`：视频/图片的缩略图地址，仅记录。 */
  readonly thumbUrl?: string
  /** `media.encrypt_query_param`：没有 `full_url` 时用它拼下载地址。 */
  readonly encryptQueryParam?: string
  /** `image_item.aeskey`：32 字符 hex，图片解密优先用它。 */
  readonly aesKeyHex?: string
  /** `media.aes_key`：base64 密钥；语音/文件/视频必须有。 */
  readonly aesKey?: string
  readonly fileName?: string
  readonly size?: number
}

export interface WeixinMessage {
  readonly messageId?: string
  readonly fromUserId?: string
  readonly messageType?: number
  readonly groupId?: string
  readonly contextToken?: string
  readonly items: readonly WeixinMessageItem[]
}

export interface WeixinUpdatesPage {
  readonly messages: readonly WeixinMessage[]
  /** 服务端返回的新游标；未返回时保持调用方手里的值。 */
  readonly cursor: string | undefined
  /** 服务端建议的下一轮长轮询时长；0 表示没说。 */
  readonly longPollTimeoutMs: number
}

// ---- 端点 ----

/** `POST /ilink/bot/get_bot_qrcode?bot_type=3` → 二维码与轮询串。 */
export async function getBotQrcode(
  context: WeixinApiContext,
  options: { botType: string; localTokenList: readonly string[] },
): Promise<WeixinQrcode> {
  const raw = await requestJson({
    method: 'POST',
    context,
    path: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(options.botType)}`,
    label: 'get_bot_qrcode',
    body: { local_token_list: [...options.localTokenList] },
  })
  const record = asRecord(raw, 'get_bot_qrcode response')
  const qrcode = requireText(record, 'qrcode', 'get_bot_qrcode response')
  const url = requireText(record, 'qrcode_img_content', 'get_bot_qrcode response')
  return { qrcode, url }
}

/**
 * `GET /ilink/bot/get_qrcode_status?qrcode=…[&verify_code=…]`。
 *
 * 这个 GET 只带应用头（`iLink-App-Id` / `iLink-App-ClientVersion`）：绑定前
 * 还没有 `Authorization`，参考实现同样如此。
 */
export async function getQrcodeStatus(
  context: WeixinApiContext,
  options: { qrcode: string; verifyCode?: string | undefined },
): Promise<WeixinQrcodeResult> {
  const query = new URLSearchParams({ qrcode: options.qrcode })
  if (options.verifyCode !== undefined && options.verifyCode !== '') {
    query.set('verify_code', options.verifyCode)
  }
  const raw = await requestJson({
    method: 'GET',
    context,
    path: `ilink/bot/get_qrcode_status?${query.toString()}`,
    label: 'get_qrcode_status',
  })
  const record = asRecord(raw, 'get_qrcode_status response')
  const status = record['status']
  if (!isQrcodeStatus(status)) {
    throw badBody(`get_qrcode_status response.status is not a known state: ${JSON.stringify(status)}`)
  }
  if (status === 'confirmed') {
    return { status, credential: parseCredential(record) }
  }
  if (status === 'scaned_but_redirect') {
    // 协议写的是「redirect_host 存在时」才换 host；缺失时保持当前入口继续轮询，
    // 由绑定器记一条 warning，不把整次扫码判死。
    const redirectHost = optionalText(record['redirect_host'])
    return redirectHost === undefined ? { status } : { status, redirectHost }
  }
  return { status }
}

/**
 * `POST /ilink/bot/getupdates`：服务端挂起请求直到有新消息或长轮询超时。
 *
 * 本地超时（服务端一直没回）按空页返回，游标保持调用方手里的值；外部中止、
 * HTTP 错误与业务 `ret` 非 0 一律抛出——前者让循环退出，后两者交给重试/暂停。
 */
export async function getUpdates(
  context: WeixinApiContext,
  options: { cursor: string },
): Promise<WeixinUpdatesPage> {
  let raw: unknown
  try {
    raw = await requestJson({
      method: 'POST',
      context,
      path: 'ilink/bot/getupdates',
      label: 'getupdates',
      body: { get_updates_buf: options.cursor, base_info: baseInfo() },
    })
  } catch (error) {
    if (error instanceof WeixinApiError && error.timedOut) {
      return { messages: [], cursor: undefined, longPollTimeoutMs: 0 }
    }
    throw error
  }
  const record = asRecord(raw, 'getupdates response')
  const retcode = nonzeroOf(record, 'getupdates response')
  if (retcode !== undefined) throw apiError('getupdates', retcode, record)
  const messages = parseMessages(record['msgs'])
  const cursor = optionalText(record['get_updates_buf'])
  const suggested = optionalFiniteNumber(record['longpolling_timeout_ms'])
  return {
    messages,
    cursor,
    longPollTimeoutMs: suggested !== undefined && suggested > 0 ? suggested : 0,
  }
}

/**
 * `POST /ilink/bot/sendmessage`：一条文本 = 一次请求。
 *
 * `client_id` 每次都由本函数生成：平台用它做幂等，重发必须换新 id，否则
 * 服务端会把第二次当重复投递丢掉。`context_token` 由调用方回带。
 */
export async function sendMessage(
  context: WeixinApiContext,
  options: { toUserId: string; text: string; contextToken?: string | undefined },
): Promise<{ messageId?: string }> {
  const toUserId = options.toUserId.trim()
  if (toUserId === '') throw badBody('sendMessage requires a non-empty to_user_id')
  if (options.text.trim() === '') {
    throw badBody(`sendMessage to '${toUserId}' has empty text; an empty message must not be sent`)
  }
  return sendMessageItems(context, {
    toUserId: options.toUserId,
    items: [{ type: 1, text_item: { text: options.text } }],
    ...(options.contextToken === undefined ? {} : { contextToken: options.contextToken }),
  })
}

/**
 * 一条消息带一组 item（媒体项、以及媒体前的说明文字各走一次请求）。
 *
 * 协议限定 `item_list` 里放一项媒体；多项时服务端行为未定义，所以由调用方
 * 拆成多次 `sendMessageItems`，每次一项。
 */
export async function sendMessageItems(
  context: WeixinApiContext,
  options: { toUserId: string; items: readonly Record<string, unknown>[]; contextToken?: string | undefined },
): Promise<{ messageId?: string }> {
  const toUserId = options.toUserId.trim()
  if (toUserId === '') throw badBody('sendMessageItems requires a non-empty to_user_id')
  if (options.items.length === 0) throw badBody(`sendMessageItems to '${toUserId}' has no items; nothing to send`)
  const msg: Record<string, unknown> = {
    from_user_id: '',
    to_user_id: toUserId,
    client_id: randomUUID(),
    message_type: 2,
    message_state: 2,
    item_list: [...options.items],
  }
  if (options.contextToken !== undefined && options.contextToken !== '') {
    msg['context_token'] = options.contextToken
  }
  const raw = await requestJson({
    method: 'POST',
    context,
    path: 'ilink/bot/sendmessage',
    label: 'sendmessage',
    body: { msg, base_info: baseInfo() },
  })
  const record = asRecord(raw, 'sendmessage response')
  const retcode = nonzeroOf(record, 'sendmessage response')
  if (retcode !== undefined) throw apiError('sendmessage', retcode, record)
  const messageId = optionalId(record['message_id'])
  return messageId === undefined ? {} : { messageId }
}

/**
 * `POST /ilink/bot/getuploadurl`：为一份密文换 CDN 上传地址。
 *
 * 响应不一定带 `ret`（参考实现只读 `upload_full_url`/`upload_param`），所以
 * 与其它端点同一套校验：`ret` 缺省当成功，出现且非 0 才失败。两个地址都
 * 没有时不能猜 CDN 域名，直接判为响应形状错误。
 */
export async function getUploadUrl(
  context: WeixinApiContext,
  options: {
    filekey: string
    mediaType: 1 | 2 | 3 | 4
    toUserId: string
    rawsize: number
    rawfilemd5: string
    filesize: number
    aeskeyHex: string
  },
): Promise<{ uploadParam?: string; uploadFullUrl?: string }> {
  const toUserId = options.toUserId.trim()
  if (toUserId === '') throw badBody('getUploadUrl requires a non-empty to_user_id')
  const raw = await requestJson({
    method: 'POST',
    context,
    path: 'ilink/bot/getuploadurl',
    label: 'getuploadurl',
    body: {
      filekey: options.filekey,
      media_type: options.mediaType,
      to_user_id: toUserId,
      rawsize: options.rawsize,
      rawfilemd5: options.rawfilemd5,
      filesize: options.filesize,
      no_need_thumb: true,
      aeskey: options.aeskeyHex,
      base_info: baseInfo(),
    },
  })
  const record = asRecord(raw, 'getuploadurl response')
  const retcode = nonzeroOf(record, 'getuploadurl response')
  if (retcode !== undefined) throw apiError('getuploadurl', retcode, record)
  const uploadFullUrl = strictOptionalText(record, 'upload_full_url', 'getuploadurl response')
  const uploadParam = strictOptionalText(record, 'upload_param', 'getuploadurl response')
  if (uploadFullUrl === undefined && uploadParam === undefined) {
    throw badBody('getuploadurl response carries neither upload_full_url nor upload_param; the upload cannot start')
  }
  return {
    ...(uploadFullUrl === undefined ? {} : { uploadFullUrl }),
    ...(uploadParam === undefined ? {} : { uploadParam }),
  }
}

/** `POST /ilink/bot/getconfig`：取 `typing_ticket`（输入状态的通行证）。 */
export async function getConfig(
  context: WeixinApiContext,
  options: { ilinkUserId: string; contextToken?: string | undefined },
): Promise<{ typingTicket?: string }> {
  const body: Record<string, unknown> = { ilink_user_id: options.ilinkUserId, base_info: baseInfo() }
  if (options.contextToken !== undefined && options.contextToken !== '') {
    body['context_token'] = options.contextToken
  }
  const raw = await requestJson({
    method: 'POST',
    context,
    path: 'ilink/bot/getconfig',
    label: 'getconfig',
    body,
  })
  const record = asRecord(raw, 'getconfig response')
  const retcode = nonzeroOf(record, 'getconfig response')
  if (retcode !== undefined) throw apiError('getconfig', retcode, record)
  const typingTicket = optionalText(record['typing_ticket'])
  return typingTicket === undefined ? {} : { typingTicket }
}

/** `POST /ilink/bot/sendtyping`：status 1 开始、2 取消。 */
export async function sendTyping(
  context: WeixinApiContext,
  options: { ilinkUserId: string; typingTicket: string; status: 1 | 2 },
): Promise<void> {
  const raw = await requestJson({
    method: 'POST',
    context,
    path: 'ilink/bot/sendtyping',
    label: 'sendtyping',
    body: {
      ilink_user_id: options.ilinkUserId,
      typing_ticket: options.typingTicket,
      status: options.status,
      base_info: baseInfo(),
    },
    allowEmptyBody: true,
  })
  if (raw === undefined) return
  const record = asRecord(raw, 'sendtyping response')
  const retcode = nonzeroOf(record, 'sendtyping response')
  if (retcode !== undefined) throw apiError('sendtyping', retcode, record)
}

// ---- 请求层 ----

interface JsonRequest {
  method: 'GET' | 'POST'
  context: WeixinApiContext
  path: string
  label: string
  body?: Record<string, unknown>
  /** 少数端点用 200 + 空 body 表示成功（sendtyping）。 */
  allowEmptyBody?: boolean
}

interface RawResponse {
  status: number
  ok: boolean
  text: string
}

async function requestJson(request: JsonRequest): Promise<unknown> {
  const url = new URL(request.path, ensureTrailingSlash(request.context.baseUrl))
  const headers: Record<string, string> = { ...applicationHeaders() }
  if (request.method === 'POST') {
    headers['Content-Type'] = 'application/json'
    headers['AuthorizationType'] = 'ilink_bot_token'
    headers['X-WECHAT-UIN'] = randomWechatUin()
  }
  const token = request.context.token?.trim() ?? ''
  if (token !== '') headers['Authorization'] = `Bearer ${token}`
  const init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string } = {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  }
  const response = await requestText(url, init, request.context.timeoutMs, request.context.signal, request.label)
  if (!response.ok) {
    throw new WeixinApiError(
      'WEIXIN_HTTP',
      `${request.label} returned HTTP ${response.status}: ${snippet(response.text)}`,
      { status: response.status },
    )
  }
  if (response.text.trim() === '') {
    if (request.allowEmptyBody === true) return undefined
    throw badBody(`${request.label} returned an empty body; expected a JSON object`)
  }
  try {
    return JSON.parse(response.text) as unknown
  } catch (cause) {
    throw new WeixinApiError('WEIXIN_BAD_BODY', `${request.label} returned invalid JSON: ${messageOf(cause)}`, { cause })
  }
}

/**
 * fetch + 读 body 都受同一个超时与外部中止约束。
 *
 * 只给 fetch 设超时、body 读取裸奔的话，服务端发完响应头再挂住就能把轮询
 * 永久钉在 `res.text()` 上；这里把两步放进同一个 controller。
 */
async function requestText(
  url: URL,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<RawResponse> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  const onAbort = (): void => { controller.abort() }
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    return { status: response.status, ok: response.ok, text }
  } catch (cause) {
    if (signal?.aborted === true) {
      throw new WeixinApiError('WEIXIN_HTTP', `${label} was aborted`, { cause })
    }
    if (timedOut) {
      throw new WeixinApiError('WEIXIN_HTTP', `${label} timed out after ${timeoutMs}ms`, {
        timedOut: true,
        cause,
      })
    }
    throw new WeixinApiError('WEIXIN_HTTP', `${label} failed: ${messageOf(cause)}`, { cause })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 应用头：所有请求都带，不含鉴权。 */
function applicationHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(encodeClientVersion(BUILD_INFO.version)),
  }
}

/** 受信请求的公共声明：`channel_version` 是插件版本，`bot_agent` 是可观测标识。 */
function baseInfo(): Record<string, unknown> {
  return { channel_version: BUILD_INFO.version, bot_agent: BOT_AGENT }
}

/** `X-WECHAT-UIN`：随机 uint32 的十进制字符串再 base64。 */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

/** `0x00MMNNPP`：major<<16 | minor<<8 | patch；非数字段按 0 处理。 */
function encodeClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  })
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

// ---- 响应校验 ----

function parseCredential(record: Record<string, unknown>): WeixinCredential {
  const botToken = requireText(record, 'bot_token', 'get_qrcode_status confirmed response')
  const baseUrl = requireText(record, 'baseurl', 'get_qrcode_status confirmed response')
  const ilinkBotId = requireText(record, 'ilink_bot_id', 'get_qrcode_status confirmed response')
  const ilinkUserId = optionalText(record['ilink_user_id'])
  return ilinkUserId === undefined
    ? { botToken, baseUrl, ilinkBotId }
    : { botToken, baseUrl, ilinkBotId, ilinkUserId }
}

function parseMessages(value: unknown): WeixinMessage[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw badBody('getupdates response.msgs must be an array')
  return value.map((entry, index) => parseMessage(entry, index))
}

function parseMessage(value: unknown, index: number): WeixinMessage {
  const label = `getupdates response.msgs[${index}]`
  const record = asRecord(value, label)
  const itemList = record['item_list']
  const items = itemList === undefined ? [] : parseItems(itemList, label)
  const messageId = optionalId(record['message_id'])
  const fromUserId = optionalText(record['from_user_id'])
  const messageType = optionalFiniteNumber(record['message_type'])
  const groupId = optionalText(record['group_id'])
  const contextToken = optionalText(record['context_token'])
  return {
    ...(messageId === undefined ? {} : { messageId }),
    ...(fromUserId === undefined ? {} : { fromUserId }),
    ...(messageType === undefined ? {} : { messageType }),
    ...(groupId === undefined ? {} : { groupId }),
    ...(contextToken === undefined ? {} : { contextToken }),
    items,
  }
}

function parseItems(value: unknown, label: string): WeixinMessageItem[] {
  if (!Array.isArray(value)) throw badBody(`${label}.item_list must be an array`)
  return value.map((entry, index) => {
    const itemLabel = `${label}.item_list[${index}]`
    const record = asRecord(entry, itemLabel)
    const type = optionalFiniteNumber(record['type'])
    if (type === undefined) throw badBody(`${itemLabel}.type must be a number`)
    return parseItem(type, record)
  })
}

function parseItem(type: number, record: Record<string, unknown>): WeixinMessageItem {
  if (type === 1) {
    const text = optionalText(field(record['text_item'], 'text'))
    return text === undefined ? { type } : { type, text }
  }
  if (type === 3) {
    const voice = record['voice_item']
    const voiceText = optionalText(field(voice, 'text'))
    return { type, ...(voiceText === undefined ? {} : { voiceText }), ...mediaFieldsOf(voice) }
  }
  if (type === 2 || type === 4 || type === 5) {
    const item = record[itemKeyOf(type)]
    const aesKeyHex = type === 2 ? optionalText(field(item, 'aeskey')) : undefined
    return {
      type,
      ...mediaFieldsOf(item),
      ...(aesKeyHex === undefined ? {} : { aesKeyHex }),
      ...optionalFileNameOf(item),
      ...optionalSizeOf(type, item),
    }
  }
  return { type }
}

/**
 * 媒体项里与传输有关的字段。`mediaUrl` 保留旧名（`full_url`），下载路径按
 * `fullUrl` 读；没有 `full_url` 时用 `media.encrypt_query_param` 拼 CDN 地址。
 * 这四个字段都可能缺省：缺省不是协议破坏，只是「不能下载」。
 */
function mediaFieldsOf(item: unknown): Pick<
  WeixinMessageItem,
  'mediaUrl' | 'fullUrl' | 'thumbUrl' | 'encryptQueryParam' | 'aesKey'
> {
  const media = field(item, 'media')
  const fullUrl = optionalText(field(media, 'full_url'))
  const thumbUrl = optionalText(field(media, 'thumb_url'))
  const encryptQueryParam = optionalText(field(media, 'encrypt_query_param'))
  const aesKey = optionalText(field(media, 'aes_key'))
  return {
    ...(fullUrl === undefined ? {} : { mediaUrl: fullUrl, fullUrl }),
    ...(thumbUrl === undefined ? {} : { thumbUrl }),
    ...(encryptQueryParam === undefined ? {} : { encryptQueryParam }),
    ...(aesKey === undefined ? {} : { aesKey }),
  }
}

function optionalFileNameOf(item: unknown): Pick<WeixinMessageItem, 'fileName'> {
  const fileName = optionalText(field(item, 'file_name'))
  return fileName === undefined ? {} : { fileName }
}

function optionalSizeOf(type: number, item: unknown): Pick<WeixinMessageItem, 'size'> {
  const size = sizeOf(type, item)
  return size === undefined ? {} : { size }
}

function itemKeyOf(type: number): string {
  if (type === 2) return 'image_item'
  if (type === 4) return 'file_item'
  return 'video_item'
}

function sizeOf(type: number, item: unknown): number | undefined {
  if (type === 2) return optionalFiniteNumber(field(item, 'mid_size'))
  if (type === 5) return optionalFiniteNumber(field(item, 'video_size'))
  // file_item.len 是「明文字节数的十进制字符串」。
  const raw = optionalText(field(item, 'len'))
  if (raw === undefined) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** 取一个嵌套字段的原始值；非对象时返回 undefined（媒体字段缺省是合法的）。 */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as Record<string, unknown>)[key]
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badBody(`${label} must be a JSON object, received ${describe(value)}`)
  }
  return value as Record<string, unknown>
}

function requireText(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw badBody(`${label}.${key} must be a non-empty string, received ${describe(value)}`)
  }
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 出现但类型不对的文本字段说明响应形状变了，不能当成「没写」；
 * 空串按缺省处理（`upload_param` 为空等于没有地址）。
 */
function strictOptionalText(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw badBody(`${label}.${key} must be a string, received ${describe(value)}`)
  }
  return optionalText(value)
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** message_id 可能是数字（uint64）或已加引号的字符串，两者都收。 */
function optionalId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function isQrcodeStatus(value: unknown): value is WeixinQrcodeStatus {
  return typeof value === 'string' && (QRCODE_STATUSES as readonly string[]).includes(value)
}

/** `ret` / `errcode` 任一非 0 即业务失败；两者都为 0/缺省才算成功。 */
function nonzeroOf(record: Record<string, unknown>, label: string): number | undefined {
  const ret = numberField(record, 'ret', label)
  const errcode = numberField(record, 'errcode', label)
  if (ret !== undefined && ret !== 0) return ret
  if (errcode !== undefined && errcode !== 0) return errcode
  return undefined
}

/** 出现但类型不对的 `ret` 说明响应形状变了，不能当成「没写」。 */
function numberField(record: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badBody(`${label}.${key} must be a number, received ${describe(value)}`)
  }
  return value
}

function apiError(label: string, retcode: number, record: Record<string, unknown>): WeixinApiError {
  const errmsg = optionalText(record['errmsg'])
  return new WeixinApiError(
    'WEIXIN_API',
    `${label} returned ret/errcode ${retcode}${errmsg === undefined ? '' : `: ${errmsg}`}`,
    { retcode },
  )
}

function badBody(message: string): WeixinApiError {
  return new WeixinApiError('WEIXIN_BAD_BODY', message, {})
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
