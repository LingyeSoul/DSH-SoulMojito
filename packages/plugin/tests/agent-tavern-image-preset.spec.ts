import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Image input is delivered by two different seams, so the preset rows must stay
 * split:
 *
 * - `agent-tavern` keeps the host composer, which uploads an image as a native
 *   `image` block gated on the route's `inputModalities`. A `tool-fs` row here
 *   would add filesystem tools the mode never needed.
 * - `agent-tavern-im` receives remote media as a text line holding a local path
 *   (no image block ever exists), so it needs `read_image` — and nothing else:
 *   `read`/`write`/`edit`/`applyPatch` stay off.
 */
describe('image input preset rows', () => {
  const patch = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../cordis.patch.yml'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  const block = (presetId: string): string => {
    const start = patch.indexOf(`id: ${presetId}\n`)
    expect(start).toBeGreaterThan(-1)
    const following = patch.indexOf('\n    - id: preset-', start + 1)
    return patch.slice(start, following === -1 ? undefined : following)
  }

  it('leaves the default Agent mode on the host composer image path', () => {
    const rows = block('preset-agent-tavern')
    expect(rows).toContain("name: 'dsh-soulmojito/agent'")
    expect(rows).not.toContain('dsh-tool-fs')
  })

  it('mounts read_image for IM sessions that only ever see a local path', () => {
    const rows = block('preset-agent-tavern-im')
    expect(rows).toContain('@deepseek-ai/dsh-tool-fs')
    expect(rows).toContain('readImage: true')
    for (const disabled of ['read: false', 'write: false', 'edit: false']) {
      expect(rows).toContain(disabled)
    }
    expect(rows).not.toContain('applyPatch: true')
  })
})
