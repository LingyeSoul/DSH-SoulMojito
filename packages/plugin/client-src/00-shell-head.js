// dsh-soulmojito client half source.
// Every file listed in manifest.json is concatenated into ONE ModuleLoader
// factory scope by scripts/build-plugin.mjs. These are fragments, not modules:
// declarations are shared across files and manifest order is load order.
// Edit fragments here; never edit the generated client/main.js or client/index.js.
window.__ModuleLoader__.load({
  id: 'dsh-soulmojito',
  factory: (require) => {
    // __DSH_BIND_CLIENT_SLOT__
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createPortal } = require('react-dom')
    const {
      Button,
      IconAgentPresetOutline16,
      IconBrowseOutline16,
      IconCheckOutline16,
      IconChevronDownOutline14,
      IconChevronLeftOutline14,
      IconChevronRightOutline14,
      IconCloseOutline16,
      IconCordisPluginOutline14,
      IconDataOutline16,
      IconDownloadOutline16,
      IconEditOutline16,
      IconListPenOutline16,
      IconPersonalizationOutline16,
      IconPlusOutline16,
      IconQueueOutline14,
      IconRefreshOutline16,
      IconSearchOutline16,
      IconSendOutline16,
      IconSparkle16,
      IconStopFill16,
      IconTrashOutline16,
      IconUserOutline16,
      Input,
      MarkdownText,
      Modal,
      Pill,
      Tooltip,
    } = DshBindClient.resolveUiPrimitives(require('@deepseek-ai/dsh-client-ui-primitives'), {
      // 宿主图标在 0.2.0-rc.2 换成描边后缀命名（IconSparkleRegular/Medium），
      // 旧尺寸后缀名不再导出；解析与降级见 @dsh-soulmojito/bind 的 ui-primitives。
      createElement: React.createElement,
      trace: clientShapeTrace,
    })
    if (clientShapeTrace.uiPrimitives?.synthesized?.length > 0 || clientShapeTrace.uiPrimitives?.missing?.length > 0) {
      console.warn('dsh-soulmojito: host UI primitives diverge from this build', clientShapeTrace.uiPrimitives)
    }
    const { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement.bind(React)

    const API = '/api/dsh-soulmojito'
    const FRONTEND_HEIGHT_MESSAGE = 'dsh-soulmojito:frontend-height'
    const FRONTEND_THEME_MESSAGE = 'dsh-soulmojito:theme'
    const FRONTEND_RESOURCE_SOURCES = [
      'https://cdn.jsdelivr.net',
      'https://testingcf.jsdelivr.net',
      'https://cdn.tailwindcss.com',
      'https://cdnjs.cloudflare.com',
      'https://unpkg.com',
      'https://esm.sh',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
    ]
    const FRONTEND_CSP = [
      "default-src 'none'",
      `script-src 'unsafe-inline' 'unsafe-eval' ${FRONTEND_RESOURCE_SOURCES.join(' ')}`,
      `style-src 'unsafe-inline' ${FRONTEND_RESOURCE_SOURCES.join(' ')}`,
      "img-src data: blob: https:",
      "font-src data: blob: https:",
      "media-src data: blob: https:",
      "worker-src blob:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
    // 外部资源开关（2026-10-21 用户需求）：默认仍是固定 CDN 白名单 + connect-src
    // 'none'；开启后 script/style 追加 https: 通配，connect-src 放宽到 https:。
    // CDN 脚本的 sourcemap 请求也走 connect-src，因此开这一项即可消除
    // "Connecting to '…showdown.min.js.map' violates connect-src 'none'"。
    // 代价：iframe 内脚本可以把前端可见的聊天数据发往任意 HTTPS 源——设置页
    // 必须同时展示风险警告，不做静默升级。
    function frontendContentSecurityPolicy(allowExternalResources) {
      if (allowExternalResources !== true) return FRONTEND_CSP
      const externalSources = `${FRONTEND_RESOURCE_SOURCES.join(' ')} https:`
      return [
        "default-src 'none'",
        `script-src 'unsafe-inline' 'unsafe-eval' ${externalSources}`,
        `style-src 'unsafe-inline' ${externalSources}`,
        "img-src data: blob: https:",
        "font-src data: blob: https:",
        "media-src data: blob: https:",
        "worker-src blob:",
        "connect-src https:",
        "frame-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; ')
    }

    function escapeFrontendAttribute(value) {
      return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    }
