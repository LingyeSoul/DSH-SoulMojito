/**
 * 通用 zip 容器解包（CHARX 之外的共用入口——游戏包导入走这里；fflate 是本包
 * 既有依赖）。只做容器解码，不做路径清洗与体积上限——调用方负责把条目安全
 * 落盘（见 packages/plugin/src/games/registry.ts 的 installFromZip）。
 */

import { unzipSync } from 'fflate'

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipArchiveError'
  }
}

/** 解包 zip 为 { 条目路径: 字节 }；非法 zip 抛 ZipArchiveError（含底层原因）。 */
export function unzipArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes)
  } catch (cause) {
    throw new ZipArchiveError(`not a valid zip: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
