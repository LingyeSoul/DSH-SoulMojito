import { describe, expect, it } from 'vitest'
import { IM_EMPTY_REPLY, chunkMarkdown, chunkParagraphs, projectImText, stripWeixinMarkdown } from '../src/im/project.js'

describe('projectImText', () => {
  it('drops a fenced frontend document and keeps the prose around it', () => {
    const text = '开场白\n\n```html\n<!doctype html><html><body><b>x</b></body></html>\n```\n\n正文继续'
    expect(projectImText(text, 'qq', 4000)).toEqual(['开场白\n\n正文继续'])
  })

  it('drops the MVU update block instead of shipping it to the phone', () => {
    const text = '她点了点头。\n<UpdateVariable><Analyze>...</Analyze></UpdateVariable>'
    expect(projectImText(text, 'qq', 4000)).toEqual(['她点了点头。'])
  })

  it('returns the fixed placeholder when nothing is left', () => {
    expect(projectImText('```html\n<!doctype html><html></html>\n```', 'qq', 4000)).toEqual([IM_EMPTY_REPLY])
  })

  it('strips markdown emphasis for weixin but keeps code fences', () => {
    const text = '## 标题\n**重点**和*斜体*\n\n```js\nconst a = 1\n```'
    const projected = projectImText(text, 'weixin', 4000).join('\n')
    expect(projected).toContain('标题')
    expect(projected).toContain('重点和斜体')
    expect(projected).not.toContain('**')
    expect(projected).toContain('```js')
  })

  it('rejects a non-positive limit', () => {
    expect(() => projectImText('x', 'qq', 0)).toThrow(/positive integer/)
  })
})

describe('chunkMarkdown', () => {
  it('never splits inside a fenced code block', () => {
    const code = ['```ts', ...Array.from({ length: 40 }, (_, index) => `const v${index} = ${index}`), '```'].join('\n')
    const parts = chunkMarkdown(`${code}\n\n尾注`, 120)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      const fences = part.split('\n').filter((line) => line.trimStart().startsWith('```')).length
      expect(fences % 2).toBe(0)
    }
    expect(parts.at(-1)).toContain('尾注')
  })

  it('hard-splits a single overlong line without breaking surrogate pairs', () => {
    const line = '😀'.repeat(50)
    const parts = chunkMarkdown(line, 10)
    expect(parts.join('')).toBe(line)
    for (const part of parts) expect(part).not.toContain('\uFFFD')
  })
})

describe('chunkParagraphs', () => {
  it('packs paragraphs up to the limit and keeps order', () => {
    const text = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n')
    const parts = chunkParagraphs(text, 70)
    expect(parts).toEqual([`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 'c'.repeat(30)])
  })
})

describe('stripWeixinMarkdown', () => {
  it('removes image markdown entirely and keeps link text', () => {
    const text = '看图![alt](https://example.invalid/a.png) 结束'
    expect(stripWeixinMarkdown(text)).toBe('看图 结束')
  })

  it('leaves fenced content untouched', () => {
    const text = '```md\n**不该被剥**\n```'
    expect(stripWeixinMarkdown(text)).toContain('**不该被剥**')
  })
})
