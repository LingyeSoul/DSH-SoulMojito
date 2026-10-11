/* B-5a 评测库播种：把语料记录按 MemoryStore 的磁盘契约直写进临时目录。
 *
 * 为什么不走 MemoryStore.put()：put 会用墙钟时间覆盖 updatedAt/createdAt，
 * 评测库的时间戳就不再确定（freshness 项随运行时刻漂移）。直写镜像
 * MemoryStore.writeRecord 的最终格式（`${JSON.stringify(record)}\n`、
 * encodeURIComponent 路径段），记录结构本身仍要过 listRecords 的
 * validateRecord 校验——播种格式漂移会在评测期直接暴露（召回归零），
 * 而不是静默通过。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function seedStore(corpus, root) {
  let written = 0
  for (const record of corpus.records) {
    const dir = join(root, 'memories', record.scope, encodeURIComponent(record.scopeId))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${encodeURIComponent(record.id)}.json`), `${JSON.stringify(record)}\n`, 'utf8')
    written += 1
  }
  return written
}
