import { describe, expect, it } from 'vitest'
import {
  MOD_VIEWPORT_MESSAGE,
  modHeightReporterScript,
  modViewportScript,
  renderModHtmlDocument,
  rewriteViewportUnits,
} from '../src/mods/http.js'

// A-4（2026-10-11）：iframe 视口正确性 + 高度上报健壮性——服务端 renderModHtmlDocument
// 出口的单元断言。问题：面板 iframe 高度=内容高度（宿主按上报调 iframe），内容里
// 100vh 引用自身高度 → 循环塌陷。方案：注入前把 100 系列视口单位改写成
// var(--dt-viewport-height, 100vh)（宿主投递真实可视区高度到该变量）+ 注入视口变量
// 脚本 + 注入升级版高度上报器（rAF 合帧 / 双观察 / 尾随兜底）。
// client/main.js 的 buildFrontendDocument 是同构同款，但 client half 是独立拼接的
// IIFE、无模块出口可 import——client 侧由 gates frontend-runtime 的
// '--dt-viewport-height' / 'dsh-soulmojito:viewport' marker 对账（scripts/gates/run.mjs）。

const VAR_REF = 'var(--dt-viewport-height, 100vh)'

describe('viewport unit rewriting (100-series vh in style blocks)', () => {
  it('rewrites 100vh/100dvh/100svh/100lvh inside <style> blocks', () => {
    const out = rewriteViewportUnits('<style>html{height:100vh}main{min-height:100dvh}.a{height:100svh}.b{height:100lvh}</style>')
    expect(out).toBe(`<style>html{height:${VAR_REF}}main{min-height:${VAR_REF}}.a{height:${VAR_REF}}.b{height:${VAR_REF}}</style>`)
  })

  it('rewrites inside calc() and matches case-insensitively', () => {
    expect(rewriteViewportUnits('<style>.h{height:calc(100VH - 24px)}</style>'))
      .toContain(`calc(${VAR_REF} - 24px)`)
  })

  it('keeps non-100 values and identifier-adjacent occurrences untouched', () => {
    const out = rewriteViewportUnits('<style>.a{height:50vh}.b{width:2100vh}.c{padding-top:100vhx}.d{--my-100vh:red}</style>')
    expect(out).toBe('<style>.a{height:50vh}.b{width:2100vh}.c{padding-top:100vhx}.d{--my-100vh:red}</style>')
  })

  it('keeps occurrences inside CSS comments and string literals', () => {
    const out = rewriteViewportUnits('<style>.a{content:"100vh"}/* 100vh */.b{height:100vh}</style>')
    expect(out).toContain('content:"100vh"')
    expect(out).toContain('/* 100vh */')
    expect(out).toContain(`height:${VAR_REF}`)
  })

  it('rewrites inline style attributes (both quote styles) but not plain attributes or text nodes', () => {
    const out = rewriteViewportUnits('<div style="height:100vh" data-x="100vh">100vh</div><div style=\'min-height:100dvh\'>x</div>')
    expect(out).toContain(`style="height:${VAR_REF}"`)
    expect(out).toContain(`style='min-height:${VAR_REF}'`)
    expect(out).toContain('data-x="100vh"')
    expect(out).toContain('>100vh</div>')
  })

  it('shields <script> blocks: JS strings and template style attributes survive verbatim', () => {
    const source = `<script>var el = document.querySelector('.hero'); el.style.height = '100vh'; tpl.innerHTML = '<div style="height:100vh"></div>';</script>`
    expect(rewriteViewportUnits(source)).toBe(source)
    // 屏蔽不影响 script 之外的同文档改写
    const mixed = `${source}<style>.h{height:100vh}</style>`
    const out = rewriteViewportUnits(mixed)
    expect(out).toContain(source)
    expect(out).toContain(`.h{height:${VAR_REF}}`)
  })
})

describe('renderModHtmlDocument viewport integration', () => {
  it('rewrites vh units and injects viewport + height scripts next to the CSP meta', () => {
    const out = renderModHtmlDocument(
      '<html><head><title>t</title></head><body style="margin:0"><style>.hero{height:100vh}</style><p>hi</p></body></html>',
      "default-src 'none'",
    )
    expect(out).toContain('.hero{height:var(--dt-viewport-height, 100vh)}')
    expect(out).toContain('style="margin:0"')
    expect(out).toContain('<head><meta http-equiv="Content-Security-Policy"')
    expect(out).toContain('--dt-viewport-height')
    expect(out).toContain(MOD_VIEWPORT_MESSAGE)
    expect(out).toContain('dsh-soulmojito:frontend-height')
    expect(out).toContain('dsh-soulmojito:mod-log')
  })

  it('rewrites in the headless and bare-fragment skeletons too', () => {
    for (const doc of [
      '<html><body><style>a{height:100vh}</style></body></html>',
      'bare <style>a{height:100vh}</style> fragment',
    ]) {
      const out = renderModHtmlDocument(doc, "default-src 'none'")
      expect(out).toContain(`a{height:${VAR_REF}}`)
      expect(out).toContain('--dt-viewport-height')
      expect(out).toContain('dsh-soulmojito:frontend-height')
    }
  })
})

describe('modViewportScript', () => {
  it('seeds the css variable and listens for the host viewport message', () => {
    const script = modViewportScript()
    expect(script).toContain('setProperty("--dt-viewport-height"')
    expect(script).toContain('window.innerHeight')
    expect(script).toContain(`data.type !== "${MOD_VIEWPORT_MESSAGE}"`)
  })

  it('validates the incoming height payload before applying', () => {
    expect(modViewportScript()).toContain('!isFinite(height) || height <= 0')
  })
})

describe('modHeightReporterScript (robustness upgrade)', () => {
  it('merges bursts via requestAnimationFrame and dedupes unchanged heights', () => {
    const script = modHeightReporterScript()
    expect(script).toContain('typeof requestAnimationFrame === \'function\'')
    expect(script).toContain('height <= 0 || height === last')
    expect(script).toContain('setTimeout(measure, 500)')
  })

  it('observes both documentElement and body via ResizeObserver', () => {
    const script = modHeightReporterScript()
    expect(script).toContain('new ResizeObserver(measure)')
    expect(script).toContain('observer.observe(document.documentElement)')
    expect(script).toContain('observer.observe(document.body)')
    // head 期 body 未建，DOMContentLoaded 后补挂
    expect(script).toContain("addEventListener('DOMContentLoaded', wire)")
  })

  it('keeps load/resize triggers and self-reads the token (silent without one)', () => {
    const script = modHeightReporterScript()
    expect(script).toContain("addEventListener('load', measure)")
    expect(script).toContain("addEventListener('resize', measure)")
    expect(script).toContain("new URLSearchParams(location.search).get('token')")
    expect(script).toContain("if (token === '') return;")
    expect(script).toContain("'dsh-soulmojito:frontend-height'")
  })
})
