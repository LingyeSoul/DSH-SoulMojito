import { decodeCharxAsset } from '../../tavern-format/src/index.js'

export async function serveCharacterAvatar(res, db, name, found) {
  let bytes
  let contentType = 'image/png'
  if (found.kind === 'png') {
    bytes = await db.exportCharacter(name)
  } else if (found.kind === 'charx') {
    const container = await db.exportCharacter(name)
    const asset = found.card.data.assets?.find((item) => item.type === 'icon' && item.uri.startsWith('embeded://'))
      ?? found.card.data.assets?.find((item) => item.uri.startsWith('embeded://') && item.ext === 'png')
    if (!asset) return sendAvatarFallback(res, name)
    bytes = decodeCharxAsset(container, asset.uri.slice('embeded://'.length))
    contentType = imageContentType(asset.ext)
  } else {
    return sendAvatarFallback(res, name)
  }
  res.statusCode = 200
  res.setHeader('content-type', contentType)
  res.setHeader('cache-control', 'private, max-age=300')
  res.end(Buffer.from(bytes))
}

/**
 * 默认替代头像：角色卡/persona/群组没有头像图像时，按名字生成首字母色块 SVG。
 * 色相由名字哈希决定（同名稳定、不同名尽量不同），饱和度/明度取双主题都可读的
 * 中间值；客户端全部头像位都是正方形 + object-fit:cover，一张 1:1 viewBox 的
 * SVG 覆盖所有渲染面，无需客户端改动。实体不存在仍然 404（真正的错误）。
 */
export function sendAvatarFallback(res, name) {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const hue = (hash >>> 0) % 360
  const first = Array.from(name.trim())[0]
  const initial = first ? first.toUpperCase() : '?'
  const safeInitial = initial.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">`
    + `<rect width="128" height="128" fill="hsl(${hue},42%,46%)"/>`
    + `<text x="64" y="66" fill="#ffffff" opacity="0.95" font-family="-apple-system,'Segoe UI','Microsoft YaHei',system-ui,sans-serif" font-size="60" font-weight="600" text-anchor="middle" dominant-baseline="central">${safeInitial}</text></svg>`
  res.statusCode = 200
  res.setHeader('content-type', 'image/svg+xml')
  res.setHeader('cache-control', 'private, max-age=300')
  res.end(svg)
}

export async function isGroupChat(db, characterName, chatId) {
  const chat = await db.getChat(characterName, chatId)
  return chat?.header?.chat_metadata?.group !== undefined
}
function imageContentType(ext) {
  const normalized = String(ext || '').toLowerCase()
  return normalized === 'jpg' || normalized === 'jpeg'
    ? 'image/jpeg'
    : normalized === 'webp'
      ? 'image/webp'
      : normalized === 'gif'
        ? 'image/gif'
        : 'image/png'
}
