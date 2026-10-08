window.__ModuleLoader__.load({
  id: 'dsh-tavern',
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
      // 旧尺寸后缀名不再导出；解析与降级见 @dsh-tavern/bind 的 ui-primitives。
      createElement: React.createElement,
      trace: clientShapeTrace,
    })
    if (clientShapeTrace.uiPrimitives?.synthesized?.length > 0 || clientShapeTrace.uiPrimitives?.missing?.length > 0) {
      console.warn('dsh-tavern: host UI primitives diverge from this build', clientShapeTrace.uiPrimitives)
    }
    const { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement.bind(React)

    const API = '/api/dsh-tavern'
    const FRONTEND_HEIGHT_MESSAGE = 'dsh-tavern:frontend-height'
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
      "font-src data: https:",
      "media-src data: blob: https:",
      "worker-src blob:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')

    function escapeFrontendAttribute(value) {
      return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    }

    function isFrontendDocument(value) {
      const text = String(value || '')
      return /<!doctype\s+html\b/i.test(text)
        || (/<html(?:\s[^>]*)?>/i.test(text) && /<(?:head|body)(?:\s[^>]*)?>/i.test(text))
        || /<(?:head|body)(?:\s[^>]*)?>/i.test(text)
    }

    function extractFrontendDocuments(value) {
      const text = String(value || '')
      const documents = []
      const fenced = /```[^\n]*\n([\s\S]*?)```/gi
      let match
      while ((match = fenced.exec(text)) !== null) {
        const candidate = match[1].trim()
        if (isFrontendDocument(candidate)) documents.push(candidate)
      }
      if (documents.length > 0) return documents
      const raw = text.trim()
      return isFrontendDocument(raw) ? [raw] : []
    }

    function frontendHeightReporter(token) {
      const serializedToken = JSON.stringify(token)
      return `(function () {
  var report = function () {
    try {
      var root = document.documentElement;
      var body = document.body;
      var height = Math.max(root ? root.scrollHeight : 0, body ? body.scrollHeight : 0);
      parent.postMessage({ type: ${JSON.stringify(FRONTEND_HEIGHT_MESSAGE)}, token: ${serializedToken}, height: height }, '*');
    } catch (_) {}
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(document.documentElement);
  addEventListener('load', report);
  addEventListener('resize', report);
  setTimeout(report, 0);
})();`
    }

    function buildFrontendDocument(value, token) {
      const source = String(value || '').trim()
      const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeFrontendAttribute(FRONTEND_CSP)}">`
      const reset = '<style>html,body{margin:0!important;padding:0;max-width:100%;}*,*::before,*::after{box-sizing:border-box;}</style>'
      const reporter = `<script>${frontendHeightReporter(token)}</script>`
      if (/<html(?:\s[^>]*)?>/i.test(source)) {
        let documentText = source
        if (/<head(?:\s[^>]*)?>/i.test(documentText)) {
          documentText = documentText.replace(/<head(?:\s[^>]*)?>/i, (tag) => `${tag}${csp}${reset}`)
        } else {
          documentText = documentText.replace(/<html(?:\s[^>]*)?>/i, (tag) => `${tag}<head>${csp}${reset}</head>`)
        }
        if (/<\/body\s*>/i.test(documentText)) {
          return documentText.replace(/<\/body\s*>/i, `${reporter}</body>`)
        }
        if (/<\/html\s*>/i.test(documentText)) {
          return documentText.replace(/<\/html\s*>/i, `${reporter}</html>`)
        }
        return `${documentText}${reporter}`
      }
      const headMatch = /<head(?:\s[^>]*)?>([\s\S]*?)<\/head\s*>/i.exec(source)
      const bodyMatch = /<body(?:\s[^>]*)?>([\s\S]*?)<\/body\s*>/i.exec(source)
      const headContent = headMatch ? headMatch[1] : ''
      const bodyContent = bodyMatch ? bodyMatch[1] : source
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${csp}${reset}${headContent}</head><body>${bodyContent}${reporter}</body></html>`
    }

    function FrontendFrame({ html, token }) {
      const frameRef = useRef(null)
      const [height, setHeight] = useState(120)
      useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== FRONTEND_HEIGHT_MESSAGE || data.token !== token) return
          if (event.source !== frameRef.current?.contentWindow) return
          if (typeof data.height !== 'number' || !Number.isFinite(data.height)) return
          setHeight(Math.max(80, Math.min(Math.ceil(data.height), 1200)))
        }
        addEventListener('message', onMessage)
        return () => removeEventListener('message', onMessage)
      }, [token])
      return h('iframe', {
        ref: frameRef,
        className: 'dt-frontend-frame',
        sandbox: 'allow-scripts',
        referrerPolicy: 'no-referrer',
        title: 'Tavern frontend',
        srcDoc: buildFrontendDocument(html, token),
        style: { height },
      })
    }

    const LOCALE_NS = 'dsh-tavern'
    const MESSAGES_EN = {
      'settings.subtitle': 'Roleplay assets and prompt configuration',
      'settings.activeSetup': 'Active setup',
      'settings.character': 'Character',
      'settings.characterEmpty': 'No active character',
      'settings.preset': 'Preset',
      'settings.presetEmpty': 'Built-in RP preset',
      'settings.persona': 'Persona',
      'settings.personaEmpty': 'Default user',
      'settings.nativePersona': 'Use active character in standard DSH Agent chats',
      'settings.compactionModel': 'Compaction summarizer',
      'settings.compactionModelFollow': 'Follow deployment config',
      'settings.compactionModelHint': 'Model that condenses story sessions (AgentTavern / AgentNovel) when context is compacted. Prefer a large-context model; empty falls back to the deployment config, then the session model.',
      'settings.defaultArchitecture': 'New chat architecture',
      'settings.architectureAgent': 'AgentTavern',
      'settings.architectureSt': 'ST',
      'settings.architectureHint': 'Only new single-character chats use this default. Group chats always use ST.',
      'settings.contextMode': 'AgentTavern context',
      'settings.contextNative': 'DSH context',
      'settings.contextManaged': 'Agent memory',
      'settings.contextManagedUnavailable': 'Agent memory is unavailable: {reason}',
      'settings.preloadAssets': 'Preload character and constant World Info when a new AgentTavern session starts',
      'settings.allowGlobalWrites': 'Allow AgentTavern tools to write memories and variables in the global scope',
      'settings.worldFollowsCharacter': 'World books follow character card activation',
      'settings.worldsEmpty': 'No world books imported',
      'settings.import': 'Import',
      'settings.importCharacter': 'Character card',
      'settings.importWorld': 'World book',
      'settings.importPreset': 'Chat preset',
      'settings.importing': 'Importing…',
      'settings.importTitle': 'Import {name}',
      'settings.version': 'Version',
      'settings.personaManage': 'Personas',
      'settings.personaEmpty': 'No personas yet',
      'settings.personaNew': 'New persona',
      'settings.personaImport': 'Persona PNG',
      'settings.personaNamePrompt': 'Persona name',
      'settings.personaDescPrompt': 'Persona description',
      'settings.personaEdit': 'Edit {name}',
      'settings.personaDelete': 'Delete {name}',
      'settings.personaDeleteConfirm': 'Delete persona "{name}"?',
      'settings.groups': 'Groups',
      'settings.groupsEmpty': 'No groups created',
      'settings.groupNew': 'New group',
      'settings.groupNamePrompt': 'Group name',
      'settings.groupPickMembers': 'Pick members',
      'settings.groupCreate': 'Create group',
      'settings.groupCancel': 'Cancel',
      'settings.groupMembers': 'Members',
      'settings.groupStrategy': 'Activation',
      'settings.groupNatural': 'Natural (talkativeness)',
      'settings.groupList': 'List order',
      'settings.groupDelete': 'Delete {name}',
      'settings.groupDeleteConfirm': 'Delete group "{name}"? Chats are kept.',
      'settings.groupToggleMember': 'Enable or disable {member}',
      'settings.groupRemoveMember': 'Remove {member}',
      'settings.regex': 'Regex scripts',
      'settings.regexEmpty': 'No regex scripts imported',
      'settings.importRegex': 'Regex scripts',
      'settings.regexDelete': 'Delete {name}',
      'settings.regexToggle': 'Enable or disable {name}',
      'settings.regexPlacements': 'Placements: {names}',
      'panel.title': 'Tavern management',
      'panel.close': 'Close panel',
      'panel.open': 'Open Tavern panel',
      'panel.nav': 'Tavern panel sections',
      'panel.section.overview': 'Overview',
      'panel.section.characters': 'Characters',
      'panel.section.chats': 'Chats',
      'panel.section.guides': 'Guides',
      'panel.section.groups': 'Groups',
      'panel.section.personas': 'Personas',
      'panel.section.worlds': 'World Info',
      'panel.section.presets': 'Presets',
      'panel.section.scripts': 'Scripts',
      'panel.section.regex': 'Regex scripts',
      'panel.section.variables': 'Variables',
      'panel.section.workbench': 'Workbench plans',
      'workbench.hint': 'Modification plans proposed by the Card Workbench agent — per-field card diffs and per-entry world book diffs. Expand a plan to review the changes, then approve to apply it to the working copy, or reject it.',
      'workbench.empty': 'No workbench plans yet',
      'workbench.worldMeta': 'World · {world}',
      'workbench.world.newBook': 'new book',
      'workbench.world.update': 'update',
      'workbench.world.create': 'new entry',
      'workbench.world.remove': 'remove',
      'workbench.sessionLabel': 'CardWorkbench',
      'workbench.opening': 'Opening workbench…',
      'workbench.chatSessionLabel': 'Card · {character} · {chat}',
      'workbench.bindTimeout': 'Workbench session binding timed out.',
      'workbench.renamePrompt': 'Rename Card Workbench session',
      'workbench.deleteConfirm': 'Delete Card Workbench session "{name}"? The session and its conversation are removed. This cannot be undone.',
      'workbench.refresh': 'Refresh',
      'workbench.approve': 'Approve and apply',
      'workbench.reject': 'Reject',
      'workbench.status.pending': 'Pending',
      'workbench.status.approved': 'Approved',
      'workbench.status.rejected': 'Rejected',
      'workbench.status.applied': 'Applied',
      'workbench.current': 'Current',
      'workbench.new': 'New',
      'workbench.showDiff': 'Show changes',
      'workbench.hideDiff': 'Hide changes',
      'workbench.appliedAt': 'Applied {time}',
      'workbench.decidedAt': 'Decided {time}',
      'panel.overview.counts': 'Characters {characters} · Chats {chats} · Worlds {worlds} · Presets {presets} · Personas {personas} · Groups {groups}',
      'panel.characters.empty': 'No character cards imported',
      'panel.characters.viewCard': 'View card',
      'panel.characters.hideCard': 'Hide card',
      'panel.characters.setActive': 'Set active',
      'panel.characters.active': 'Active',
      'panel.characters.export': 'Export {name}',
      'panel.characters.delete': 'Delete {name}',
      'panel.characters.deleteConfirm': 'Delete character "{name}"? Its chats are removed as well. This cannot be undone.',
      'panel.characters.description': 'Description',
      'panel.characters.personality': 'Personality',
      'panel.characters.scenario': 'Scenario',
      'panel.characters.firstMes': 'First message',
      'panel.characters.mesExample': 'Dialogue examples',
      'panel.characters.creatorNotes': 'Creator notes',
      'panel.characters.creator': 'By {name}',
      'panel.characters.loadFailed': 'Failed to load card: {message}',
      'panel.edit': 'Edit',
      'panel.save': 'Save changes',
      'panel.saved': 'Saved',
      'panel.unsaved': 'Unsaved changes',
      'panel.cancel': 'Cancel',
      'panel.add': 'Add',
      'panel.remove': 'Remove',
      'panel.rename': 'Name',
      'panel.exportJson': 'Export JSON',
      'panel.characters.nickname': 'Nickname',
      'panel.characters.tags': 'Tags (comma separated)',
      'panel.characters.systemPrompt': 'System prompt',
      'panel.characters.postHistory': 'Post-history instructions',
      'panel.characters.alternateGreetings': 'Alternate greetings (one per line)',
      'panel.characters.advancedJson': 'Advanced card data (JSON)',
      'panel.characters.editHint': 'Edits keep the original card container and embedded assets when possible.',
      'panel.characters.identitySummary': 'Identity summary (AgentTavern)',
      'panel.characters.identitySummaryHint': 'Short third-person identity the AgentTavern kernel injects every turn. Leave empty to derive a minimal summary from the description.',
      'panel.characters.new': 'New character card',
      'panel.characters.createTitle': 'Create a character card',
      'panel.characters.createHint': 'Pick how you want to create the card.',
      'panel.characters.createAgentTitle': 'Card Workbench agent',
      'panel.characters.createAgentHint': 'Start a chat with the card-writing agent: describe the character (or point it at material/scripts), it drafts the fields and proposes a per-field plan you approve in the Workbench section. Best for full cards from an idea.',
      'panel.characters.createAgentLaunch': 'Start workbench session',
      'panel.characters.createManualTitle': 'Edit manually',
      'panel.characters.createManualHint': 'Open a blank card right here and fill in the fields yourself.',
      'panel.characters.createManualStart': 'Open blank card',
      'panel.characters.creating': 'New card (unsaved)',
      'panel.characters.createEditorHint': 'Filling the name and at least a description is usually enough to start; everything else is optional.',
      'panel.characters.duplicate': 'Character "{name}" already exists; creating it again would overwrite that card. Pick another name or delete the existing card first.',
      'panel.characters.createFailed': 'Failed to create card: {message}',
      'panel.worlds.entries': '{count} entries',
      'panel.worlds.search': 'Search entries',
      'panel.worlds.noEntries': 'No entries match the search.',
      'panel.worlds.delete': 'Delete {name}',
      'panel.worlds.deleteConfirm': 'Delete world book "{name}"?',
      'panel.worlds.keys': 'Keys: {keys}',
      'panel.worlds.edit': 'Edit world book',
      'panel.worlds.name': 'World book name',
      'panel.worlds.entry': 'Entry',
      'panel.worlds.comment': 'Comment',
      'panel.worlds.keysPrimary': 'Primary keys (comma separated)',
      'panel.worlds.keysSecondary': 'Secondary keys (comma separated)',
      'panel.worlds.content': 'Content',
      'panel.worlds.order': 'Order',
      'panel.worlds.depth': 'Depth',
      'panel.worlds.enabled': 'Enabled',
      'panel.worlds.constant': 'Constant',
      'panel.worlds.selective': 'Selective',
      'panel.worlds.addEntry': 'Add entry',
      'panel.presets.empty': 'No presets imported',
      'panel.presets.setActive': 'Set active',
      'panel.presets.delete': 'Delete {name}',
      'panel.presets.deleteConfirm': 'Delete preset "{name}"?',
      'panel.presets.edit': 'Edit preset',
      'panel.presets.prompts': 'Prompt stack',
      'panel.presets.promptName': 'Prompt name',
      'panel.presets.identifier': 'Identifier',
      'panel.presets.role': 'Role',
      'panel.presets.content': 'Content',
      'panel.presets.marker': 'Marker',
      'panel.presets.enabled': 'Enabled',
      'panel.presets.addPrompt': 'Add prompt',
      'panel.presets.removePrompt': 'Remove prompt',
      'panel.presets.sampler': 'Sampling and advanced fields (JSON)',
      'panel.presets.invalidJson': 'Advanced fields must be valid JSON.',
      'panel.presets.identifierInvalid': 'Prompt identifiers must be non-empty and unique.',
      'panel.presets.editHint': 'Prompt order and unknown sampler fields are preserved on save.',
      'panel.variables.globals': 'Global STscript variables',
      'panel.variables.globalsHint': 'Shared across every chat through the getvar/setvar macros.',
      'panel.variables.empty': 'No variables set',
      'panel.variables.key': 'Key',
      'panel.variables.value': 'Value',
      'panel.variables.add': 'Add variable',
      'panel.variables.save': 'Save variables',
      'panel.variables.saved': 'Saved',
      'panel.variables.remove': 'Remove {key}',
      'panel.variables.chatLocal': 'Chat variables (current session)',
      'panel.variables.chatLocalEmpty': 'This session has no bound Tavern chat.',
      'panel.variables.agentAudit': 'AgentTavern audit',
      'panel.variables.agentAuditEmpty': 'No AgentTavern session is active.',
      'panel.variables.projection': 'Projection: {status} · cursor {cursor}',
      'panel.variables.memories': 'Memories',
      'panel.variables.nativeVariables': 'Agent variables',
      'panel.variables.auditLoading': 'Loading AgentTavern audit…',
      'panel.variables.auditProjectionError': 'Projection error: {message}',
      'panel.variables.replayProjection': 'Replay projection',
      'panel.variables.replaying': 'Replaying…',
      'panel.variables.auditSource': 'Source: {source}',
      'panel.variables.auditRevision': 'Revision: {revision}',
      'panel.variables.auditExpired': 'Expired: {value}',
      'panel.variables.auditDeleted': 'Soft-deleted: {value}',
      // 持续指引（提案 0009）/ 行动候选（提案 0010）的客户端文案；zh/en 键集
      // 与 {param} 占位符必须完全镜像，由 client-vm-mount gate 校验。
      'panel.guides.hint': 'Persistent directives applied to every generation in this chat (ST and AgentTavern alike): at most 8 guides, up to 500 characters each.',
      'panel.guides.empty': 'No guides yet',
      'panel.guides.unavailable': 'Guides follow a single bound chat; chat-less sessions (Card Workbench, novels) do not use guides.',
      'panel.guides.placeholder': 'Add a guide for this chat…',
      'panel.guides.add': 'Add',
      'panel.guides.adding': 'Adding…',
      'panel.guides.remove': 'Remove guide',
      'candidates.title': 'Candidates',
      'candidates.generate': 'Generate candidates',
      'candidates.generating': 'Generating…',
      'candidates.empty': 'No candidates yet. Generate a few suggestions for your next message.',
      'candidates.generatedAt': 'Generated {time}',
      'candidates.lastFeedback': 'Last feedback: {feedback}',
      'candidates.feedbackPlaceholder': 'Feedback for regeneration (optional)',
      'candidates.regenerate': 'Regenerate with feedback',
      'candidates.fill': 'Fill the input box (edit before sending)',
      'candidates.kind.action': 'Action',
      'candidates.kind.scene': 'Scene',
      // MVU 状态与回执（提案 0012 P1）/ 剧本游玩（提案 0014 P1）的客户端文案；
      // zh/en 键集与 {param} 占位符必须完全镜像，由 client-vm-mount gate 校验。
      'mvu.title': 'MVU status',
      'mvu.variables': 'Variables',
      'mvu.receipts': 'Settlement receipts',
      'mvu.receiptsEmpty': 'No settlement receipts yet',
      'mvu.status.updated': 'updated',
      'mvu.status.unchanged': 'unchanged',
      'mvu.status.failed': 'failed',
      'mvu.turn': 'Turn {turn}',
      'mvu.change': '{name}: {before} → {after}',
      'mvu.more': '+{count} more',
      'mvu.less': 'Show fewer',
      'mvu.failures': 'Failures',
      'mvu.retry': 'Retry settlement',
      'mvu.retrying': 'Retrying…',
      'mvu.unavailable': 'No variables or receipts in this chat',
      'mvu.guide.description': 'Variables and settlement receipts for this chat',
      'mvu.summary': '{variables} variables · {receipts} receipts',
      'script.progressTitle': 'Script progress',
      'script.position': 'Segment {current} of {total}',
      'script.alignedAt': 'Aligned {time}',
      'script.hint': 'The script is a reference, not a chapter skip: the story may deviate at any time, and the position only advances when the latest reply covers the current segment.',
      'scripts.hint': 'Import a novel or outline as a script (auto-chunked for staged recall) and bind it to a character card — one script per card; new chats with a bound card follow the script.',
      'scripts.empty': 'No scripts imported yet',
      'scripts.importFile': 'Import TXT/MD/EPUB',
      'scripts.importing': 'Importing…',
      'scripts.paste': 'Paste text',
      'scripts.pasteName': 'Script name',
      'scripts.pasteContent': 'Script text',
      'scripts.pastePlaceholder': 'Paste the script text here…',
      'scripts.pasteImport': 'Import pasted text',
      'scripts.chunks': '{count} chunks',
      'scripts.characters': '{count} characters',
      'scripts.importedAt': 'Imported {time}',
      'scripts.bindTo': 'Bind to a card',
      'scripts.bind': 'Bind',
      'scripts.unbind': 'Unbind {name}',
      'scripts.noCharacters': 'No character cards imported yet; bind a script after importing a card.',
      'scripts.refresh': 'Refresh',
      'message.user': 'User',
      'message.previousSwipe': 'Previous swipe',
      'message.nextSwipe': 'Next swipe',
      'message.edit': 'Edit message',
      'message.branch': 'Branch chat from this message',
      'message.branching': 'Branching…',
      'message.save': 'Save',
      'message.cancel': 'Cancel',
      'view.unbound': 'No Tavern chat is bound to this session.',
      'view.loading': 'Loading Tavern chat…',
      'view.regenerate': 'Regenerate last response',
      'view.rewrite': 'Rewrite with feedback',
      'view.rewriteFeedbackPlaceholder': 'What should change? Leave empty to just rewrite.',
      'view.rewriteSubmit': 'Rewrite',
      'view.rewritten': 'Rewritten with feedback',
      'view.openGuides': 'Open guides panel',
      'view.forkArchitecture': 'Fork to {architecture}',
      'view.architectureAgent': 'AgentTavern',
      'view.architectureSt': 'ST',
      'view.linkedFrom': 'Linked from {name}',
      'stats.counts': '{turns} turns · {steps} steps',
      'stats.llm': 'LLM {duration}',
      'stats.toolCall': 'Tool calls {duration}',
      'stats.ttftAverage': 'Avg. TTFT {duration}',
      'stats.tokensPerSecond': '{throughput} tok/s',
      'stats.cacheHit': 'Cache hit {percent}%',
      'stats.tokens': 'Input {input} tok · Output {output} tok',
      'run.connecting': 'Connecting',
      'run.saved': 'Saved',
      'run.stopped': 'Stopped',
      'run.failed': 'Generation failed',
      'model.select': 'Select model',
      'model.default': 'Default',
      'model.model': 'Model',
      'model.effort': 'Effort',
      'model.menuLabel': 'Model and reasoning effort',
      'model.refreshing': 'Refreshing model list…',
      'model.retry': 'Retry',
      'model.loadFailed': '{name} failed to load: {message}',
      'model.noneAvailable': 'No models available.',
      'model.noEffort': 'This model provides no reasoning effort levels.',
      'composer.writeTo': 'Write to {name}',
      'composer.unavailable': 'Tavern binding unavailable',
      'composer.stop': 'Stop generation',
      'composer.send': 'Send',
      'composer.script': 'Run STscript',
      'composer.member': 'Reply as {name}',
      'nav.title': 'Tavern',
      'nav.chats': 'Tavern roleplay chats',
      'nav.open': 'Open Tavern roleplay chats',
      'nav.close': 'Close',
      'nav.groups': 'Groups',
      'nav.workbench': 'Card Workbench',
      'nav.workbenchFree': 'Free workbench',
      'nav.workbenchNew': 'Create a new free workbench session',
      'nav.workbenchChat': 'Open this chat in the Card Workbench',
      'nav.noWorkbench': 'No workbench sessions',
      'nav.newChat': 'New chat with {name}',
      'nav.newGroupChat': 'New chat in {name}',
      'nav.loading': 'Loading…',
      'nav.noChats': 'No chats',
      'nav.noCharacters': 'No character cards',
      'nav.opening': 'Opening {name}',
      'nav.rename': 'Rename {name}',
      'nav.delete': 'Delete {name}',
      'nav.renamePrompt': 'Rename Tavern chat',
      'nav.deleteConfirm': 'Delete Tavern chat "{name}"? This cannot be undone.',
      'error.fileRead': 'File read failed',
      'error.noWorkspace': 'No DSH workspace is available for a Tavern session.',
      'error.noBinding': 'DSH did not expose the new session binding.',
      'error.activationFailed': 'Tavern activation failed.',
      'error.agentTavernUnavailable': 'AgentTavern is unavailable: {reason}',
      'error.hostCommandUnavailable': 'The Tavern host command is unavailable.',
      // 自更新（GitHub 版本发现 + 一键更新）。zh/en 键集与 {param} 占位符必须
      // 完全镜像，由 client-vm-mount gate 校验。
      'update.title': 'Plugin update',
      'update.current': 'Installed v{version} ({commit})',
      'update.latest': 'GitHub v{version} ({commit})',
      'update.check': 'Check for updates',
      'update.checking': 'Checking…',
      'update.now': 'Update now',
      'update.installing': 'Updating…',
      'update.confirm': 'Install Tavern v{version} from GitHub now? DSH must be restarted afterwards.',
      'update.restartHint': 'Restart DeepSeek Harness to load the new version (the running host keeps the old module generation).',
      'update.restartHintWeb': 'Restart DSH to load the new version, then reload this page.',
      'update.checkedAt': 'Last checked {at}',
      'update.notes': 'Incoming changes',
      'update.remoteError': 'GitHub lookup failed: {error}',
      'update.status.available': 'v{version} available',
      'update.status.upToDate': 'Up to date',
      'update.status.localAhead': 'Local build is newer',
      'update.status.restartRequired': 'Restart required',
      'update.status.unknown': 'Update status unknown',
      // AgentNovel surface (proposal 0005). zh/en keys must stay mirrored with
      // identical {param} placeholders; the client-vm-mount gate enforces it.
      'panel.section.novels': 'Novels',
      'view.architectureNovel': 'AgentNovel',
      'novel.empty': 'No novels yet. Create one to start automatic writing.',
      'novel.create': 'New novel',
      'novel.creating': 'Creating…',
      'novel.createUnavailable': 'AgentNovel is unavailable: {reason}',
      'novel.open': 'Open novel session',
      'novel.opening': 'Opening novel…',
      'novel.openPanel': 'Open novel panel',
      'novel.bindTimeout': 'The host did not confirm the novel session binding.',
      'novel.conflict': 'The novel changed elsewhere; the latest state was reloaded.',
      'novel.viewNotice': 'This is an AgentNovel session; the story is managed from the novels panel.',
      'novel.status.active': 'Active',
      'novel.status.paused': 'Paused',
      'novel.status.completed': 'Completed',
      'novel.phase.outlining': 'Outlining',
      'novel.phase.revising': 'Revising outline',
      'novel.phase.writing': 'Writing',
      'novel.phase.finishing': 'Finishing',
      'novel.pauseReason.awaiting-approval': 'Awaiting outline approval',
      'novel.pauseReason.requirement-conflict': 'Requirement conflicts with committed text',
      'novel.pauseReason.stalled': 'Stalled without progress',
      'novel.pauseReason.budget': 'Run or length budget reached',
      'novel.pauseReason.recovery-required': 'Recovery required',
      'novel.pauseReason.projection-pending': 'Reading projection pending',
      'novel.chapters': 'Chapters {completed}/{total}',
      'novel.characters': '{effective} characters',
      'novel.charactersTarget': '{effective} / {target} characters',
      'novel.updatedAt': 'Updated {time}',
      'novel.lastError': 'Last error: {message}',
      'novel.pauseDetail': 'Pause detail: {detail}',
      'novel.resumeHint': 'Resume hint: {hint}',
      'novel.pause': 'Pause',
      'novel.resume': 'Resume',
      'novel.stop': 'Stop now',
      'novel.stopConfirm': 'Stop "{name}" immediately? In-flight generation is cancelled and the novel stays paused.',
      'novel.approveOutline': 'Approve outline',
      'novel.updateOutline': 'Update outline',
      'novel.outlineRevision': 'Outline revision',
      'novel.approveHint': 'Approving revision {revision} begins the first writing unit.',
      'novel.exportMd': 'Export Markdown',
      'novel.exportZip': 'Export ZIP',
      'novel.editTitle': 'Edit novel',
      'novel.edit.invalidBudgets': 'Run budgets must be positive integers.',
      'novel.edit.budgetsHint': 'Budgets apply from the next turn; a novel paused by a budget needs an explicit resume to continue.',
      'novel.edit.writerModeHint': 'The writing mode applies from the next writing unit; a unit already claimed finishes in the mode it was claimed with.',
      'novel.genre': 'Genre',
      'novel.delete': 'Delete {name}',
      'novel.deleteConfirm': 'Delete novel "{name}"? An active novel is paused first, its sessions are unbound, and all novel data is removed. This cannot be undone.',
      'novel.refresh': 'Refresh',
      'novel.back': 'Back to novels',
      'novel.loadingDetail': 'Loading novel…',
      'novel.chaptersTitle': 'Chapters',
      'novel.chapterState.planned': 'Planned',
      'novel.chapterState.writing': 'Writing',
      'novel.chapterState.completed': 'Completed',
      'novel.storyPremise': 'Premise',
      'novel.storyTheme': 'Theme',
      'novel.storyEnding': 'Ending direction',
      'novel.foreshadowing': 'Foreshadowing',
      'novel.foreshadowingRequired': 'Must resolve',
      'novel.showOutline': 'View full outline',
      'novel.outlineTitle': 'Full outline',
      'novel.readerTitle': 'Committed text',
      'novel.readerEmpty': 'No committed text yet.',
      'novel.loadMore': 'Load more',
      'novel.authorPanel': 'Author panel',
      'novel.authorHint': 'Send new instructions as ordinary messages in the novel session. They are registered in the ledger and take effect through the outline revision protocol.',
      'novel.authorOpenSession': 'Open session to write',
      'novel.requirements': 'Instruction ledger',
      'novel.requirementsEmpty': 'No instructions registered.',
      'novel.req.status.pending': 'Pending',
      'novel.req.status.applied': 'Applied',
      'novel.req.status.superseded': 'Superseded',
      'novel.req.status.blocked': 'Blocked',
      'novel.req.effectiveAt': 'Effective: {location}',
      'novel.req.blockedReason': 'Blocked: {reason}',
      'novel.budgetTitle': 'Length and run budget',
      'novel.lengthUnbounded': 'Length: unbounded',
      'novel.lengthTarget': 'Target: {target} characters',
      'novel.remainingCharacters': 'Remaining: {value} characters',
      'novel.remainingUnbounded': 'Remaining: not limited',
      'novel.runBudget': 'Turns {used}/{max} · Deduce {deduce}/{maxDeduce}',
      'novel.runWriterRuns': 'Writer runs {count}',
      'novel.usageSample.title': 'Usage sampling',
      'novel.usageSample.hint': 'Per-turn tool output sizes recorded for auditing; not authoritative billing data.',
      'novel.usageSample.empty': 'No samples yet.',
      'novel.usageSample.latest': 'Latest sample: turn {turn} · {time}',
      'novel.usageSample.toolBytesTotal': 'Tool output total: {size}',
      'novel.usageSample.toolBytes': '{tool}: {size}',
      'novel.usageSample.writerOutput': 'Writer output: {chars} characters',
      'novel.assets': 'Asset sources',
      'novel.assetsCharacters': 'Characters: {names}',
      'novel.assetsWorlds': 'World books: {names}',
      'novel.assetsNone': 'Original story without selected assets.',
      'novel.form.title': 'Title',
      'novel.form.requirement': 'Creative requirement',
      'novel.form.requirementHint': 'Describe the story you want; this text becomes the first registered instruction.',
      'novel.form.language': 'Language',
      'novel.form.language.zh': 'Chinese',
      'novel.form.language.en': 'English',
      'novel.form.genre': 'Genre',
      'novel.form.genrePlaceholder': 'e.g. sci-fi mystery',
      'novel.form.perspective': 'Narrative perspective',
      'novel.form.perspective.third': 'Third person',
      'novel.form.perspective.first': 'First person',
      'novel.form.perspective.second': 'Second person',
      'novel.form.perspective.mixed': 'Mixed viewpoints',
      'novel.form.styleNotes': 'Style notes',
      'novel.form.length': 'Length budget',
      'novel.form.length.unbounded': 'Unbounded',
      'novel.form.length.target': 'Target length',
      'novel.form.targetCharacters': 'Target characters',
      'novel.form.toleranceRatio': 'Tolerance ratio [0,1)',
      'novel.form.hardMaximum': 'Hard maximum (optional)',
      'novel.form.maxChapters': 'Chapter limit (optional)',
      'novel.form.approval': 'Outline approval',
      'novel.form.approval.automatic': 'Automatic',
      'novel.form.approval.manual': 'Manual',
      'novel.form.characters': 'Character cards',
      'novel.form.worlds': 'World books',
      'novel.form.budgets': 'Run budgets',
      'novel.form.maxTurns': 'Max turns',
      'novel.form.maxDurationMs': 'Max duration (ms)',
      'novel.form.stallThresholdTurns': 'Stall threshold (turns)',
      'novel.form.consecutiveFailureLimit': 'Consecutive failure limit',
      'novel.form.retryMaxAttempts': 'External retry attempts',
      'novel.form.retryBackoffMs': 'External retry backoff (ms)',
      'novel.form.maxDeduceRuns': 'Deduce run limit',
      'novel.form.writerDispatchLimit': 'Writer dispatch limit (per claim)',
      'novel.form.writerMode': 'Writing mode',
      'novel.form.writerMode.inline': 'In-session',
      'novel.form.writerMode.subagent': 'Writer subagent',
      'novel.form.writerMode.hint': 'The writer subagent drafts each unit in its own bounded writing context; in-session mode drafts directly in the main session context.',
      'novel.form.submit': 'Create novel',
      'novel.form.missingRequired': 'Title and creative requirement are required.',
      'novel.form.invalidNumbers': 'Check the numeric fields: target characters must be a positive integer, tolerance ratio within [0,1), and the hard maximum must not be below the target.',
    }
    const MESSAGES_ZH = {
      'settings.subtitle': '角色卡、世界书与预设管理',
      'settings.activeSetup': '当前配置',
      'settings.character': '角色',
      'settings.characterEmpty': '未选择角色',
      'settings.preset': '预设',
      'settings.presetEmpty': '内置角色扮演预设',
      'settings.persona': '用户人设',
      'settings.personaEmpty': '默认用户',
      'settings.nativePersona': '在标准 DSH Agent 会话中使用当前角色',
      'settings.compactionModel': '压缩总结模型',
      'settings.compactionModelFollow': '跟随部署配置',
      'settings.compactionModelHint': '剧情会话（AgentTavern / AgentNovel）上下文压缩时生成检查点摘要的模型，建议选大上下文窗口模型；留空回落部署配置，再回落会话模型。',
      'settings.defaultArchitecture': '新聊天架构',
      'settings.architectureAgent': 'AgentTavern',
      'settings.architectureSt': 'ST',
      'settings.architectureHint': '仅影响新建的单角色聊天；群聊始终使用 ST。',
      'settings.contextMode': 'AgentTavern 上下文',
      'settings.contextNative': 'DSH 上下文',
      'settings.contextManaged': 'Agent 记忆',
      'settings.contextManagedUnavailable': 'Agent 记忆不可用：{reason}',
      'settings.preloadAssets': '新 AgentTavern 会话开始时预载角色信息和常驻世界书条目',
      'settings.allowGlobalWrites': '允许 AgentTavern 工具写入 global 作用域的记忆和变量',
      'settings.worldFollowsCharacter': '世界书跟随角色卡激活',
      'settings.worldsEmpty': '尚未导入世界书',
      'settings.import': '导入',
      'settings.importCharacter': '角色卡',
      'settings.importWorld': '世界书',
      'settings.importPreset': '聊天预设',
      'settings.importing': '导入中…',
      'settings.importTitle': '导入{name}',
      'settings.version': '版本',
      'settings.personaManage': '用户人设',
      'settings.personaEmpty': '尚未创建人设',
      'settings.personaNew': '新建人设',
      'settings.personaImport': '人设 PNG',
      'settings.personaNamePrompt': '人设名称',
      'settings.personaDescPrompt': '人设描述',
      'settings.personaEdit': '编辑{name}',
      'settings.personaDelete': '删除{name}',
      'settings.personaDeleteConfirm': '删除人设“{name}”？',
      'settings.groups': '群聊',
      'settings.groupsEmpty': '尚未创建群聊',
      'settings.groupNew': '新建群聊',
      'settings.groupNamePrompt': '群组名称',
      'settings.groupPickMembers': '选择成员',
      'settings.groupCreate': '创建群组',
      'settings.groupCancel': '取消',
      'settings.groupMembers': '成员',
      'settings.groupStrategy': '激活策略',
      'settings.groupNatural': '自然（健谈度）',
      'settings.groupList': '列表顺序',
      'settings.groupDelete': '删除{name}',
      'settings.groupDeleteConfirm': '删除群组“{name}”？聊天记录会保留。',
      'settings.groupToggleMember': '启用或停用{member}',
      'settings.groupRemoveMember': '移除{member}',
      'settings.regex': '正则脚本',
      'settings.regexEmpty': '尚未导入正则脚本',
      'settings.importRegex': '正则脚本',
      'settings.regexDelete': '删除{name}',
      'settings.regexToggle': '启用或停用{name}',
      'settings.regexPlacements': '作用位置：{names}',
      'panel.title': '酒馆管理面板',
      'panel.close': '关闭面板',
      'panel.open': '打开酒馆面板',
      'panel.nav': '酒馆面板分区',
      'panel.section.overview': '总览',
      'panel.section.characters': '角色',
      'panel.section.chats': '聊天',
      'panel.section.guides': '指引',
      'panel.section.groups': '群组',
      'panel.section.personas': '用户人设',
      'panel.section.worlds': '世界书',
      'panel.section.presets': '预设',
      'panel.section.scripts': '剧本',
      'panel.section.regex': '正则脚本',
      'panel.section.variables': '变量',
      'panel.section.workbench': '工作台方案',
      'workbench.hint': '卡片工作台 Agent 提出的修改方案——角色卡逐字段、世界书逐条目。展开查看改动，批准即应用到工作版，也可直接拒绝。',
      'workbench.empty': '暂无工作台方案',
      'workbench.worldMeta': '世界书 · {world}',
      'workbench.world.newBook': '新建书',
      'workbench.world.update': '更新',
      'workbench.world.create': '新条目',
      'workbench.world.remove': '删除',
      'workbench.sessionLabel': '写卡工作台',
      'workbench.opening': '正在打开写卡工作台…',
      'workbench.chatSessionLabel': '写卡 · {character} · {chat}',
      'workbench.bindTimeout': '写卡工作台会话绑定超时。',
      'workbench.renamePrompt': '重命名写卡会话',
      'workbench.deleteConfirm': '删除写卡会话“{name}”？该会话及其对话记录将被删除，且不可撤销。',
      'workbench.refresh': '刷新',
      'workbench.approve': '批准并应用',
      'workbench.reject': '拒绝',
      'workbench.status.pending': '待确认',
      'workbench.status.approved': '已批准',
      'workbench.status.rejected': '已拒绝',
      'workbench.status.applied': '已应用',
      'workbench.current': '当前',
      'workbench.new': '改为',
      'workbench.showDiff': '查看改动',
      'workbench.hideDiff': '收起改动',
      'workbench.appliedAt': '应用于 {time}',
      'workbench.decidedAt': '决定于 {time}',
      'panel.overview.counts': '角色 {characters} · 聊天 {chats} · 世界书 {worlds} · 预设 {presets} · 人设 {personas} · 群组 {groups}',
      'panel.characters.empty': '尚未导入角色卡',
      'panel.characters.viewCard': '查看卡面',
      'panel.characters.hideCard': '收起卡面',
      'panel.characters.setActive': '设为当前',
      'panel.characters.active': '使用中',
      'panel.characters.export': '导出 {name}',
      'panel.characters.delete': '删除 {name}',
      'panel.characters.deleteConfirm': '删除角色“{name}”？其聊天记录会一并删除，且不可撤销。',
      'panel.characters.description': '描述',
      'panel.characters.personality': '性格',
      'panel.characters.scenario': '场景',
      'panel.characters.firstMes': '开场白',
      'panel.characters.mesExample': '对话示例',
      'panel.characters.creatorNotes': '作者注',
      'panel.characters.creator': '作者：{name}',
      'panel.characters.loadFailed': '卡面加载失败：{message}',
      'panel.edit': '编辑',
      'panel.save': '保存修改',
      'panel.saved': '已保存',
      'panel.unsaved': '有未保存修改',
      'panel.cancel': '取消',
      'panel.add': '新增',
      'panel.remove': '移除',
      'panel.rename': '名称',
      'panel.exportJson': '导出 JSON',
      'panel.characters.nickname': '昵称',
      'panel.characters.tags': '标签（逗号分隔）',
      'panel.characters.systemPrompt': '系统提示词',
      'panel.characters.postHistory': '历史后指令',
      'panel.characters.alternateGreetings': '备用开场白（每行一个）',
      'panel.characters.advancedJson': '高级卡片数据（JSON）',
      'panel.characters.editHint': '保存时会尽量保留原始卡片容器与内嵌资源。',
      'panel.characters.identitySummary': '身份摘要（AgentTavern）',
      'panel.characters.identitySummaryHint': 'AgentTavern 内核每轮注入的简短第三人称身份描述；留空时从角色描述派生极短摘要。',
      'panel.characters.new': '新建角色卡',
      'panel.characters.createTitle': '新建角色卡',
      'panel.characters.createHint': '选择创建方式。',
      'panel.characters.createAgentTitle': '写卡 Agent（卡片工作台）',
      'panel.characters.createAgentHint': '拉起与写卡 Agent 的对话：描述想要的角色（或让它读取素材/剧本），它逐字段起草并提交方案，你在「工作台方案」分区审批后写入。适合从一个想法产出完整卡面。',
      'panel.characters.createAgentLaunch': '启动写卡工作台',
      'panel.characters.createManualTitle': '面板手动编辑',
      'panel.characters.createManualHint': '在当前面板直接打开空白卡面，自己填写各字段。',
      'panel.characters.createManualStart': '打开空白卡面',
      'panel.characters.creating': '新卡（未保存）',
      'panel.characters.createEditorHint': '填好名称和描述通常就够开聊了，其余字段都可以留空。',
      'panel.characters.duplicate': '已存在同名角色「{name}」，再次创建会覆盖原卡。请换个名字，或先删除已有角色。',
      'panel.characters.createFailed': '新建角色卡失败：{message}',
      'panel.worlds.entries': '{count} 条目',
      'panel.worlds.search': '搜索条目',
      'panel.worlds.noEntries': '没有匹配的条目。',
      'panel.worlds.delete': '删除 {name}',
      'panel.worlds.deleteConfirm': '删除世界书“{name}”？',
      'panel.worlds.keys': '键：{keys}',
      'panel.worlds.edit': '编辑世界书',
      'panel.worlds.name': '世界书名称',
      'panel.worlds.entry': '条目',
      'panel.worlds.comment': '备注',
      'panel.worlds.keysPrimary': '主关键词（逗号分隔）',
      'panel.worlds.keysSecondary': '次关键词（逗号分隔）',
      'panel.worlds.content': '内容',
      'panel.worlds.order': '排序',
      'panel.worlds.depth': '深度',
      'panel.worlds.enabled': '启用',
      'panel.worlds.constant': '常驻',
      'panel.worlds.selective': '选择性匹配',
      'panel.worlds.addEntry': '新增条目',
      'panel.presets.empty': '尚未导入预设',
      'panel.presets.setActive': '设为当前',
      'panel.presets.delete': '删除 {name}',
      'panel.presets.deleteConfirm': '删除预设“{name}”？',
      'panel.presets.edit': '编辑预设',
      'panel.presets.prompts': '提示词堆栈',
      'panel.presets.promptName': '提示词名称',
      'panel.presets.identifier': '标识符',
      'panel.presets.role': '角色',
      'panel.presets.content': '内容',
      'panel.presets.marker': '插槽标记',
      'panel.presets.enabled': '启用',
      'panel.presets.addPrompt': '新增提示词',
      'panel.presets.removePrompt': '移除提示词',
      'panel.presets.sampler': '采样与高级字段（JSON）',
      'panel.presets.invalidJson': '高级字段必须是有效 JSON。',
      'panel.presets.identifierInvalid': '提示词标识符不能为空且必须唯一。',
      'panel.presets.editHint': '保存时会保留提示词顺序与未知采样字段。',
      'panel.variables.globals': '全局 STscript 变量',
      'panel.variables.globalsHint': '所有聊天通过 getvar/setvar 宏共享。',
      'panel.variables.empty': '暂无变量',
      'panel.variables.key': '键',
      'panel.variables.value': '值',
      'panel.variables.add': '新增变量',
      'panel.variables.save': '保存变量',
      'panel.variables.saved': '已保存',
      'panel.variables.remove': '移除 {key}',
      'panel.variables.chatLocal': '聊天局部变量（当前会话）',
      'panel.variables.chatLocalEmpty': '当前会话未绑定酒馆聊天。',
      'panel.variables.agentAudit': 'AgentTavern 审计',
      'panel.variables.agentAuditEmpty': '当前没有 AgentTavern 会话。',
      'panel.variables.projection': '投影：{status} · 游标 {cursor}',
      'panel.variables.memories': '记忆',
      'panel.variables.nativeVariables': 'Agent 变量',
      'panel.variables.auditLoading': '正在加载 AgentTavern 审计…',
      'panel.variables.auditProjectionError': '投影错误：{message}',
      'panel.variables.replayProjection': '重放投影',
      'panel.variables.replaying': '重放中…',
      'panel.variables.auditSource': '来源：{source}',
      'panel.variables.auditRevision': '修订：{revision}',
      'panel.variables.auditExpired': '过期：{value}',
      'panel.variables.auditDeleted': '软删除：{value}',
      // 持续指引（提案 0009）/ 行动候选（提案 0010）的客户端文案；zh/en 键集
      // 与 {param} 占位符必须完全镜像，由 client-vm-mount gate 校验。
      'panel.guides.hint': '对本局每次生成（ST 与 AgentTavern 同样生效）持续作用的指引：最多 8 条，单条不超过 500 字符。',
      'panel.guides.empty': '还没有指引',
      'panel.guides.unavailable': '指引跟随单局绑定的聊天生效；写卡工作台等未绑定聊天的会话不使用指引。',
      'panel.guides.placeholder': '添加一条本局指引…',
      'panel.guides.add': '添加',
      'panel.guides.adding': '添加中…',
      'panel.guides.remove': '删除指引',
      'candidates.title': '行动候选',
      'candidates.generate': '生成候选',
      'candidates.generating': '生成中…',
      'candidates.empty': '还没有候选。为你下一条消息生成几个建议吧。',
      'candidates.generatedAt': '生成于 {time}',
      'candidates.lastFeedback': '上次意见：{feedback}',
      'candidates.feedbackPlaceholder': '对候选的意见（可空）',
      'candidates.regenerate': '带意见重新生成',
      'candidates.fill': '填入输入框（发送前可修改）',
      'candidates.kind.action': '行动',
      'candidates.kind.scene': '场景',
      // MVU 状态与回执（提案 0012 P1）/ 剧本游玩（提案 0014 P1）的客户端文案；
      // zh/en 键集与 {param} 占位符必须完全镜像，由 client-vm-mount gate 校验。
      'mvu.title': 'MVU 状态',
      'mvu.variables': '变量',
      'mvu.receipts': '结算回执',
      'mvu.receiptsEmpty': '还没有结算回执',
      'mvu.status.updated': '已更新',
      'mvu.status.unchanged': '未变化',
      'mvu.status.failed': '失败',
      'mvu.turn': '第 {turn} 楼',
      'mvu.change': '{name}：{before} → {after}',
      'mvu.more': '还有 {count} 条',
      'mvu.less': '收起',
      'mvu.failures': '失败项',
      'mvu.retry': '重试结算',
      'mvu.retrying': '重试中…',
      'mvu.unavailable': '本聊暂无变量或回执',
      'mvu.guide.description': '本聊的变量与结算回执',
      'mvu.summary': '{variables} 个变量 · {receipts} 条回执',
      'script.progressTitle': '剧本进度',
      'script.position': '片段 {current} / {total}',
      'script.alignedAt': '对齐于 {time}',
      'script.hint': '剧本是参考不是跳章：剧情可以随时偏离，只有正文覆盖当前片段时进度才会推进。',
      'scripts.hint': '把小说或大纲导入为剧本（自动分段、分段召回），并与人物卡一对一绑定；绑定的卡开新局会按剧本推进。',
      'scripts.empty': '尚未导入剧本',
      'scripts.importFile': '导入 TXT/MD/EPUB',
      'scripts.importing': '导入中…',
      'scripts.paste': '粘贴文本',
      'scripts.pasteName': '剧本名称',
      'scripts.pasteContent': '剧本正文',
      'scripts.pastePlaceholder': '在此粘贴剧本正文…',
      'scripts.pasteImport': '导入粘贴文本',
      'scripts.chunks': '{count} 块',
      'scripts.characters': '{count} 字符',
      'scripts.importedAt': '导入于 {time}',
      'scripts.bindTo': '绑定到卡',
      'scripts.bind': '绑定',
      'scripts.unbind': '解绑 {name}',
      'scripts.noCharacters': '尚未导入角色卡；导入卡后才能绑定剧本。',
      'scripts.refresh': '刷新',
      'message.user': '用户',
      'message.previousSwipe': '上一个候选',
      'message.nextSwipe': '下一个候选',
      'message.edit': '编辑消息',
      'message.branch': '从此消息分支',
      'message.branching': '分支中…',
      'message.save': '保存',
      'message.cancel': '取消',
      'view.unbound': '此会话未绑定酒馆聊天。',
      'view.loading': '正在加载酒馆聊天…',
      'view.regenerate': '重新生成最新回复',
      'view.rewrite': '带意见重写',
      'view.rewriteFeedbackPlaceholder': '要改哪里？留空则直接重写。',
      'view.rewriteSubmit': '重写',
      'view.rewritten': '按意见重写',
      'view.openGuides': '打开指引面板',
      'view.forkArchitecture': '分叉到 {architecture}',
      'view.architectureAgent': 'AgentTavern',
      'view.architectureSt': 'ST',
      'view.linkedFrom': '来源聊天：{name}',
      'stats.counts': '{turns} 轮 · {steps} 步',
      'stats.llm': 'LLM {duration}',
      'stats.toolCall': '工具调用 {duration}',
      'stats.ttftAverage': '首 token 平均 {duration}',
      'stats.tokensPerSecond': '{throughput} tok/s',
      'stats.cacheHit': '缓存命中 {percent}%',
      'stats.tokens': '输入 {input} tok · 输出 {output} tok',
      'run.connecting': '连接中',
      'run.saved': '已保存',
      'run.stopped': '已停止',
      'run.failed': '生成失败',
      'model.select': '选择模型',
      'model.default': '默认',
      'model.model': '模型',
      'model.effort': '思考力度',
      'model.menuLabel': '模型与思考力度',
      'model.refreshing': '正在刷新模型列表…',
      'model.retry': '重试',
      'model.loadFailed': '{name} 加载失败：{message}',
      'model.noneAvailable': '没有可用模型。',
      'model.noEffort': '该模型不提供思考力度选项。',
      'composer.writeTo': '写给 {name}',
      'composer.unavailable': '酒馆绑定不可用',
      'composer.stop': '停止生成',
      'composer.send': '发送',
      'composer.script': '运行 STscript',
      'composer.member': '由 {name} 回复',
      'nav.title': '酒馆',
      'nav.chats': '酒馆角色扮演聊天',
      'nav.open': '打开酒馆角色扮演聊天',
      'nav.close': '关闭',
      'nav.groups': '群聊',
      'nav.workbench': '写卡工作台',
      'nav.workbenchFree': '自由写卡',
      'nav.workbenchNew': '新建自由写卡工作台',
      'nav.workbenchChat': '把该聊天交给写卡工作台',
      'nav.noWorkbench': '暂无写卡工作会话',
      'nav.newChat': '与 {name} 开新聊天',
      'nav.newGroupChat': '在 {name} 开新聊天',
      'nav.loading': '加载中…',
      'nav.noChats': '暂无聊天',
      'nav.noCharacters': '暂无角色卡',
      'nav.opening': '正在打开 {name}',
      'nav.rename': '重命名 {name}',
      'nav.delete': '删除 {name}',
      'nav.renamePrompt': '重命名酒馆聊天',
      'nav.deleteConfirm': '删除酒馆聊天“{name}”？此操作不可撤销。',
      'error.fileRead': '文件读取失败',
      'error.noWorkspace': '没有可用于酒馆会话的 DSH 工作区。',
      'error.noBinding': 'DSH 未返回新建会话的绑定。',
      'error.activationFailed': '酒馆激活失败。',
      'error.agentTavernUnavailable': 'AgentTavern 不可用：{reason}',
      'error.hostCommandUnavailable': '宿主的酒馆命令不可用。',
      'update.title': '插件更新',
      'update.current': '已安装 v{version}（{commit}）',
      'update.latest': 'GitHub v{version}（{commit}）',
      'update.check': '检查更新',
      'update.checking': '检查中…',
      'update.now': '立即更新',
      'update.installing': '更新中…',
      'update.confirm': '现在从 GitHub 安装酒馆 v{version}？安装后需要重启 DSH。',
      'update.restartHint': '重启 DeepSeek Harness 后新版本才会生效（运行中的宿主仍是旧模块）。',
      'update.restartHintWeb': '重启 DSH 后新版本生效，然后刷新本页面。',
      'update.checkedAt': '上次检查 {at}',
      'update.notes': '即将合入的改动',
      'update.remoteError': 'GitHub 查询失败：{error}',
      'update.status.available': '有新版本 v{version}',
      'update.status.upToDate': '已是最新',
      'update.status.localAhead': '本地构建更新',
      'update.status.restartRequired': '需要重启',
      'update.status.unknown': '更新状态未知',
      'panel.section.novels': '小说',
      'view.architectureNovel': 'AgentNovel',
      'novel.empty': '还没有小说，创建一部开始全自动创作。',
      'novel.create': '新建小说',
      'novel.creating': '创建中…',
      'novel.createUnavailable': 'AgentNovel 不可用：{reason}',
      'novel.open': '打开小说会话',
      'novel.opening': '正在打开小说…',
      'novel.openPanel': '打开小说面板',
      'novel.bindTimeout': '宿主未确认小说会话绑定。',
      'novel.conflict': '小说已在其他位置修改，已重新加载最新状态。',
      'novel.viewNotice': '这是 AgentNovel 小说会话，请在小说面板中管理创作。',
      'novel.status.active': '创作中',
      'novel.status.paused': '已暂停',
      'novel.status.completed': '已完成',
      'novel.phase.outlining': '构思大纲',
      'novel.phase.revising': '修订大纲',
      'novel.phase.writing': '写作中',
      'novel.phase.finishing': '收尾中',
      'novel.pauseReason.awaiting-approval': '等待大纲批准',
      'novel.pauseReason.requirement-conflict': '创作要求与已提交正文冲突',
      'novel.pauseReason.stalled': '写作停滞',
      'novel.pauseReason.budget': '运行或篇幅预算已达上限',
      'novel.pauseReason.recovery-required': '需要恢复',
      'novel.pauseReason.projection-pending': '阅读投影待重建',
      'novel.chapters': '章节 {completed}/{total}',
      'novel.characters': '有效字符 {effective}',
      'novel.charactersTarget': '有效字符 {effective} / {target}',
      'novel.updatedAt': '更新于 {time}',
      'novel.lastError': '最近错误：{message}',
      'novel.pauseDetail': '暂停详情：{detail}',
      'novel.resumeHint': '恢复提示：{hint}',
      'novel.pause': '暂停',
      'novel.resume': '恢复',
      'novel.stop': '立即停止',
      'novel.stopConfirm': '立即停止“{name}”？在途生成会被取消，小说保持暂停。',
      'novel.approveOutline': '批准大纲',
      'novel.updateOutline': '更新大纲',
      'novel.outlineRevision': '大纲版本',
      'novel.approveHint': '批准版本 {revision} 后开始第一个写作单元。',
      'novel.exportMd': '导出 Markdown',
      'novel.exportZip': '导出 ZIP',
      'novel.editTitle': '编辑小说',
      'novel.edit.invalidBudgets': '运行预算必须为正整数。',
      'novel.edit.budgetsHint': '预算自下一轮起生效；因预算暂停的小说需手动恢复后才会继续。',
      'novel.edit.writerModeHint': '写作模式自下一写作单元起生效；已认领的单元按认领时的模式完成。',
      'novel.genre': '题材',
      'novel.delete': '删除 {name}',
      'novel.deleteConfirm': '删除小说“{name}”？运行中的小说会先暂停，绑定会话会解绑，全部小说数据将被删除，且不可撤销。',
      'novel.refresh': '刷新',
      'novel.back': '返回小说列表',
      'novel.loadingDetail': '正在加载小说…',
      'novel.chaptersTitle': '章节目录',
      'novel.chapterState.planned': '已规划',
      'novel.chapterState.writing': '写作中',
      'novel.chapterState.completed': '已完成',
      'novel.storyPremise': '前提',
      'novel.storyTheme': '主题',
      'novel.storyEnding': '结局方向',
      'novel.foreshadowing': '伏笔',
      'novel.foreshadowingRequired': '必须回收',
      'novel.showOutline': '查看完整大纲',
      'novel.outlineTitle': '完整大纲',
      'novel.readerTitle': '已提交正文',
      'novel.readerEmpty': '尚未提交正文。',
      'novel.loadMore': '加载更多',
      'novel.authorPanel': '作者面板',
      'novel.authorHint': '在小说会话中像普通消息一样发送新的创作要求；指令会登记进台账，并按大纲修订协议生效。',
      'novel.authorOpenSession': '打开会话发送指令',
      'novel.requirements': '指令台账',
      'novel.requirementsEmpty': '暂无指令记录。',
      'novel.req.status.pending': '待处理',
      'novel.req.status.applied': '已生效',
      'novel.req.status.superseded': '已取代',
      'novel.req.status.blocked': '已阻塞',
      'novel.req.effectiveAt': '生效位置：{location}',
      'novel.req.blockedReason': '阻塞原因：{reason}',
      'novel.budgetTitle': '篇幅与运行预算',
      'novel.lengthUnbounded': '篇幅：不限',
      'novel.lengthTarget': '目标篇幅：{target} 字符',
      'novel.remainingCharacters': '剩余：{value} 字符',
      'novel.remainingUnbounded': '剩余：不限',
      'novel.runBudget': '轮次 {used}/{max} · 推演 {deduce}/{maxDeduce}',
      'novel.runWriterRuns': '写手运行 {count}',
      'novel.usageSample.title': '用量采样',
      'novel.usageSample.hint': '按轮次采样的工具输出用量，仅供审计参考，非权威计费数据。',
      'novel.usageSample.empty': '暂无采样。',
      'novel.usageSample.latest': '最近采样：第 {turn} 轮 · {time}',
      'novel.usageSample.toolBytesTotal': '工具输出合计：{size}',
      'novel.usageSample.toolBytes': '{tool}：{size}',
      'novel.usageSample.writerOutput': '写手产出：{chars} 字符',
      'novel.assets': '资产来源',
      'novel.assetsCharacters': '角色：{names}',
      'novel.assetsWorlds': '世界书：{names}',
      'novel.assetsNone': '原创故事，未选择资产。',
      'novel.form.title': '标题',
      'novel.form.requirement': '创作要求',
      'novel.form.requirementHint': '描述你想要的故事；这段文本会作为首条指令登记。',
      'novel.form.language': '语言',
      'novel.form.language.zh': '中文',
      'novel.form.language.en': '英语',
      'novel.form.genre': '题材',
      'novel.form.genrePlaceholder': '例如：科幻悬疑',
      'novel.form.perspective': '叙事视角',
      'novel.form.perspective.third': '第三人称',
      'novel.form.perspective.first': '第一人称',
      'novel.form.perspective.second': '第二人称',
      'novel.form.perspective.mixed': '多视角混合',
      'novel.form.styleNotes': '文风要求',
      'novel.form.length': '篇幅设置',
      'novel.form.length.unbounded': '不限',
      'novel.form.length.target': '目标字数',
      'novel.form.targetCharacters': '目标字符数',
      'novel.form.toleranceRatio': '浮动比例 [0,1)',
      'novel.form.hardMaximum': '硬上限（可选）',
      'novel.form.maxChapters': '章节数上限（可选）',
      'novel.form.approval': '大纲批准',
      'novel.form.approval.automatic': '自动',
      'novel.form.approval.manual': '手动批准',
      'novel.form.characters': '角色卡',
      'novel.form.worlds': '世界书',
      'novel.form.budgets': '运行预算',
      'novel.form.maxTurns': '最大轮数',
      'novel.form.maxDurationMs': '最大时长（毫秒）',
      'novel.form.stallThresholdTurns': '停滞阈值（轮）',
      'novel.form.consecutiveFailureLimit': '连续失败上限',
      'novel.form.retryMaxAttempts': '外部重试次数',
      'novel.form.retryBackoffMs': '外部重试退避（毫秒）',
      'novel.form.maxDeduceRuns': '推演次数上限',
      'novel.form.writerDispatchLimit': '写手派发上限（每认领）',
      'novel.form.writerMode': '写作模式',
      'novel.form.writerMode.inline': '主会话写作',
      'novel.form.writerMode.subagent': '写手子代理',
      'novel.form.writerMode.hint': '写手子代理在每单元独立的有界写作上下文中完成正文；主会话模式在主会话上下文中直接写作。',
      'novel.form.submit': '创建小说',
      'novel.form.missingRequired': '标题与创作要求为必填项。',
      'novel.form.invalidNumbers': '请检查数值字段：目标字符数须为正整数，浮动比例在 [0,1) 内，硬上限不得低于目标。',
    }
    // translate follows the host locale service once apply() binds it; the
    // identity fallback mirrors LocaleRuntime.translate (missing key -> key,
    // {param} interpolation) for pre-apply and stubbed environments.
    let translate = (key, params) => {
      if (!params) return key
      return key.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    }
    let subscribeLocale = () => () => {}
    let getLocaleRevision = () => ({ revision: 0 })

    function useTranslate() {
      useSyncExternalStore(subscribeLocale, getLocaleRevision, getLocaleRevision)
      return translate
    }
    const STYLE_ID = 'dsh-tavern/native-ui'
    const REVISION_CONFLICT = 'CHAT_REVISION_CONFLICT'
    const NOVEL_REVISION_CONFLICT = 'NOVEL_REVISION_CONFLICT'
    const STORE_REVISION_POLL_MS = 3000
    const EMPTY_BOOTSTRAP = {
      storeRevision: '',
      state: {
        activeWorlds: [], sessionBindings: {}, defaultArchitecture: 'agent-tavern', defaultContextMode: 'dsh-native',
        agentTavernPreloadAssets: false, agentTavernAllowGlobalWrites: false, worldFollowsCharacter: true, modelSelections: {}, chats: {}, regexScripts: [], scriptGlobals: {},
      },
      characters: [],
      worlds: [],
      presets: [],
      presetKinds: {},
      personas: [],
      groups: [],
      activeCard: null,
      model: { provider: '', model: '' },
      internalWorkspace: null,
      agentTavern: {
        native: { available: false, missing: [], reasons: [] },
        managed: { available: false, missing: [], reasons: [] },
      },
      agentNovel: { available: false, missing: [], reasons: [] },
      // 宿主 /update 快照（bootstrap 里带的是磁盘缓存结论）。字段与
      // src/update/service.ts 的 TavernUpdateSnapshot 对齐。
      update: {
        status: 'unknown', reason: '', checkedAt: null, nextCheckAt: null, error: '', source: 'none',
        repository: '', ref: '', local: { version: '', commit: '' }, remote: null, spec: '',
        install: {
          running: false, phase: 'idle', strategy: null, startedAt: null, finishedAt: null,
          message: '', restartRequired: false, installed: null, log: [],
        },
      },
    }
    const EMPTY_MODELS = { status: 'idle', groups: [], failures: [], error: '' }
    let snapshot = {
      bootstrap: EMPTY_BOOTSTRAP,
      loading: true,
      error: '',
      chatLists: {},
      chats: {},
      revisions: {},
      displays: {},
      runs: {},
      models: EMPTY_MODELS,
      panelOpen: false,
      panelSection: 'overview',
      navigationStatus: '',
      // 剧本库写操作（导入/绑定/解绑）的广播计数：绑定写在卡 extensions 上，
      // 不经过聊天 revision，进度卡靠它感知重取（绑定后出现 / 解绑后隐藏）。
      scriptsRevision: 0,
    }
    const listeners = new Set()
    const pendingChats = new Map()
    const pendingLists = new Map()
    const pendingModels = new Map()
    const controllers = new Map()
    // 存量 blank 绑定会话的修复去重（成功修复的 sessionId；失败会移除以待重试）
    const repairedBindings = new Set()
    let internalWorkspace
    let internalWorkspacePromise
    let workbenchWorkspace
    let workbenchWorkspacePromise

    function update(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function getSnapshot() {
      return snapshot
    }

    function useTavernStore() {
      return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
    }

    function jsonHeaders() {
      return { 'content-type': 'application/json' }
    }

    async function api(path, options) {
      const response = await fetch(`${API}/${path}`, options)
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok === false) {
        const error = new Error(body.message || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body.code
        throw error
      }
      return body
    }

    async function refreshBootstrap() {
      try {
        const result = await api('bootstrap')
        update({ bootstrap: result, loading: false, error: '' })
        return result
      } catch (cause) {
        update({ loading: false, error: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
    }

    // 资产变更水位（store-revision）：写卡 Agent 等后台写入直接在服务端落盘、
    // 没有推送通道，客户端轮询它与 bootstrap 携带的 storeRevision 比对，变化
    // 即重取 bootstrap。与自更新安装进度（1.5s 轮询 `/update`）同款轮询策略，
    // 不引入 SSE。
    async function fetchStoreRevision() {
      const result = await api('store-revision')
      return typeof result.revision === 'string' ? result.revision : ''
    }

    // 自更新三件套：读快照（宿主缓存结论，默认不打网络）、强制检查、开始安装。
    // 安装可能跑几十秒（pnpm add），宿主在 install 里维护进度日志，客户端按
    // 1.5s 轮询快照即可看到阶段与日志，不需要 SSE。
    async function loadUpdateSnapshot(refresh) {
      const result = await api(refresh === true ? 'update?refresh=1' : 'update')
      return result.update || null
    }

    async function requestUpdateCheck() {
      const result = await api('update/check', { method: 'POST', headers: jsonHeaders(), body: '{}' })
      return result.update || null
    }

    async function requestUpdateInstall(force) {
      const result = await api('update/install', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ force: force === true, wait: false }),
      })
      return result.update || null
    }

    async function patchState(patch) {
      await api('state', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(patch) })
      return refreshBootstrap()
    }

    async function loadModels(force) {
      if (!force && snapshot.models.status !== 'idle') return snapshot.models
      if (pendingModels.has('all')) return pendingModels.get('all')
      update({ models: { ...snapshot.models, status: 'loading', error: '' } })
      const pending = api('models')
        .then((result) => {
          update({
            models: { status: 'ready', groups: result.groups, failures: result.failures, error: '' },
          })
          return snapshot.models
        })
        .catch((cause) => {
          update({ models: { ...snapshot.models, status: 'error', error: cause instanceof Error ? cause.message : String(cause) } })
          throw cause
        })
        .finally(() => pendingModels.delete('all'))
      pendingModels.set('all', pending)
      return pending
    }

    async function saveModelSelection(sessionId, selection) {
      const result = await api('model', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId, selection }),
      })
      update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })
      return result.state
    }

    function sessionSelection(sessionId) {
      const state = snapshot.bootstrap.state
      const saved = state.modelSelections?.[sessionId]
      if (saved?.provider && saved?.model) return saved
      const fallback = snapshot.bootstrap.model
      return fallback?.provider && fallback?.model ? fallback : null
    }

    function chatKey(character, chatId) {
      return `${character}\u0000${chatId}`
    }

    async function loadChatList(character, force) {
      if (!character) return []
      if (!force && snapshot.chatLists[character]) return snapshot.chatLists[character]
      if (pendingLists.has(character)) return pendingLists.get(character)
      const pending = api(`chats?character=${encodeURIComponent(character)}`)
        .then((result) => {
          const ids = [...result.chats].reverse()
          update({ chatLists: { ...snapshot.chatLists, [character]: ids } })
          return ids
        })
        .finally(() => pendingLists.delete(character))
      pendingLists.set(character, pending)
      return pending
    }

    async function loadChat(character, chatId, force) {
      if (!character || !chatId) return null
      const key = chatKey(character, chatId)
      if (!force && snapshot.chats[key]) return snapshot.chats[key]
      if (pendingChats.has(key)) return pendingChats.get(key)
      const pending = api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`)
        .then((result) => {
          update({
            chats: { ...snapshot.chats, [key]: result.chat },
            revisions: { ...snapshot.revisions, [key]: result.revision },
            displays: { ...snapshot.displays, [key]: result.displays },
          })
          return result.chat
        })
        .finally(() => pendingChats.delete(key))
      pendingChats.set(key, pending)
      return pending
    }

    async function saveChat(character, chatId, chat) {
      const key = chatKey(character, chatId)
      try {
        const result = await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ chat, revision: snapshot.revisions[key] }),
        })
        update({
          chats: { ...snapshot.chats, [key]: result.chat || chat },
          revisions: { ...snapshot.revisions, [key]: result.revision },
        })
        return result.chat || chat
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    function setRun(sessionId, patch) {
      update({
        runs: {
          ...snapshot.runs,
          [sessionId]: { busy: false, streamText: '', status: '', error: '', ...(snapshot.runs[sessionId] || {}), ...patch },
        },
      })
    }

    // 持续指引（提案 0009）与行动候选（提案 0010）的写路径：服务端自读快照做
    // revision CAS，响应携带新 revision。客户端照 chat 写路径（saveChat /
    // runTavernScriptCommand）同步 revisions[key]，并强刷本地聊天快照——这两
    // 类写只改 chat_metadata，不返回整个 chat，缓存里的 chats[key] 必须重取。
    function syncChatRevision(character, chatId, revision) {
      if (typeof revision !== 'string') return
      const key = chatKey(character, chatId)
      update({ revisions: { ...snapshot.revisions, [key]: revision } })
      void loadChat(character, chatId, true).catch(() => {})
    }

    function guidesPath(character, chatId, id) {
      const base = `guides/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
      return id === undefined ? base : `${base}/${encodeURIComponent(id)}`
    }

    function loadGuides(character, chatId) {
      return api(guidesPath(character, chatId))
    }

    async function addChatGuide(character, chatId, text) {
      const result = await api(guidesPath(character, chatId), {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ text }),
      })
      syncChatRevision(character, chatId, result.revision)
      return result
    }

    async function removeChatGuide(character, chatId, id) {
      const result = await api(guidesPath(character, chatId, id), { method: 'DELETE' })
      syncChatRevision(character, chatId, result.revision)
      return result
    }

    // chat_metadata.candidates 的读取容错（形状对齐 src/candidates.ts 的
    // readStoredCandidates：kind 非 scene 即 action，缺文本丢弃，空集视为无）。
    function normalizeStoredCandidates(value) {
      if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null
      const items = value.items
        .filter((item) => item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim() !== '')
        .map((item) => ({ kind: item.kind === 'scene' ? 'scene' : 'action', text: item.text }))
      if (items.length === 0) return null
      return {
        items,
        generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
        ...(typeof value.feedback === 'string' && value.feedback !== '' ? { feedback: value.feedback } : {}),
      }
    }

    async function generateChatCandidates(sessionId, binding, feedback) {
      const key = chatKey(binding.character, binding.chatId)
      const result = await api('candidates', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          sessionId,
          character: binding.character,
          chatId: binding.chatId,
          revision: snapshot.revisions[key],
          ...(feedback !== undefined ? { feedback } : {}),
        }),
      })
      syncChatRevision(binding.character, binding.chatId, result.revision)
      return result
    }

    // MVU 状态与回执（提案 0012 P1）的读写路径：GET mvu/status 与写路径同样
    // 走 revision CAS（POST mvu/retry 响应携带新 revision，照 guides/candidates
    // 模式同步 revisions[key] 并强刷本地聊天快照——回执落在 chat_metadata）。
    function mvuStatusPath(character, chatId) {
      return `mvu/status/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
    }

    function loadMvuStatus(character, chatId) {
      return api(mvuStatusPath(character, chatId))
    }

    async function retryMvuSettlement(sessionId, binding) {
      const key = chatKey(binding.character, binding.chatId)
      const result = await api('mvu/retry', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          sessionId,
          character: binding.character,
          chatId: binding.chatId,
          revision: snapshot.revisions[key],
        }),
      })
      syncChatRevision(binding.character, binding.chatId, result.revision)
      return result
    }

    // 剧本游玩（提案 0014 P1）：剧本库（GET scripts / POST script/import）与
    // 绑定（POST script/bind / script/unbind，写在卡 extensions 上，非聊天
    // revision 域）；进度 GET script/progress 由生成链路的对齐推进写，这里只读。
    function scriptProgressPath(character, chatId) {
      return `script/progress/${encodeURIComponent(character)}/${encodeURIComponent(chatId)}`
    }

    function loadScriptProgress(character, chatId) {
      return api(scriptProgressPath(character, chatId))
    }

    function loadScriptsLibrary() {
      return api('scripts')
    }

    function importScriptAsset(name, content, format) {
      return api('script/import', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, content, ...(format !== undefined ? { format } : {}) }),
      })
    }

    function bindCharacterScript(character, scriptName) {
      return api('script/bind', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character, scriptName }),
      })
    }

    function unbindCharacterScript(character) {
      return api('script/unbind', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ character }),
      })
    }

    function bumpScriptsRevision() {
      update({ scriptsRevision: snapshot.scriptsRevision + 1 })
    }

    // 卡片工作台方案确认协议（提案 0013 P2）：面板拉 pending/全量方案列表并
    // 给决定；approve=true 由服务端执行核按方案写入工作版并标记 applied。
    function loadWorkbenchPlans(status = 'all', character) {
      const params = new URLSearchParams()
      params.set('status', status)
      if (character) params.set('character', character)
      return api(`card-workbench/plans?${params.toString()}`)
    }

    function decideWorkbenchPlan(planId, approve) {
      return api(`card-workbench/plans/${encodeURIComponent(planId)}/decision`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ approve }),
      })
    }

    async function generateFor(sessionId, binding, mode, text, options = {}) {
      const currentRun = snapshot.runs[sessionId]
      if (!binding || currentRun?.busy) return
      const key = chatKey(binding.character, binding.chatId)
      const currentChat = snapshot.chats[key] || await loadChat(binding.character, binding.chatId)
      const message = (text || '').trim()
      if (mode === 'send' && !message) return
      if (mode === 'send') {
        const optimistic = {
          ...currentChat,
          messages: [...currentChat.messages, {
            name: 'User',
            is_user: true,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: message,
          }],
        }
        update({ chats: { ...snapshot.chats, [key]: optimistic } })
      }
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      setRun(sessionId, { busy: true, streamText: '', status: 'run.connecting', error: '' })
      const selection = sessionSelection(sessionId)
      try {
        const response = await fetch(`${API}/generate`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            revision: snapshot.revisions[key],
            message,
            mode,
            // 带意见重写（提案 0011）：feedback 仅 regenerate 可携带（服务端同款
            // 校验，非 regenerate 带该字段会被拒）；空串等价普通重掷，不发送。
            ...(mode === 'regenerate' && typeof options.feedback === 'string' && options.feedback.trim() !== '' ? { feedback: options.feedback.trim() } : {}),
            ...(binding.group === true ? { group: true } : {}),
            ...(options.triggerMember ? { triggerMember: options.triggerMember } : {}),
            ...(selection ? {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
            } : {}),
          }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          const body = await response.json().catch(() => ({}))
          throw new Error(body.message || `HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let streamed = ''
        while (true) {
          const part = await reader.read()
          buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line)
            if (event.type === 'start') {
              const via = `${event.provider}/${event.model}`
              setRun(sessionId, { status: event.speaker && event.speaker !== binding.character ? `${event.speaker} · ${via}` : via, speaker: event.speaker })
            }
            if (event.type === 'delta') {
              streamed += event.text
              setRun(sessionId, { streamText: streamed })
            }
            if (event.type === 'error') {
              const error = new Error(event.message || translate('run.failed'))
              error.code = event.code
              throw error
            }
            if (event.type === 'saved') {
              update({
                chats: { ...snapshot.chats, [key]: event.chat },
                revisions: { ...snapshot.revisions, [key]: event.revision },
              })
              setRun(sessionId, { streamText: '', status: 'run.saved' })
            }
          }
          if (part.done) break
        }
      } catch (cause) {
        const aborted = controller.signal.aborted
        setRun(sessionId, {
          error: aborted ? '' : (cause instanceof Error ? cause.message : String(cause)),
          status: aborted ? 'run.stopped' : '',
          streamText: '',
        })
        await loadChat(binding.character, binding.chatId, true).catch(() => {})
      } finally {
        controllers.delete(sessionId)
        setRun(sessionId, { busy: false })
      }
    }

    function stopGeneration(sessionId) {
      controllers.get(sessionId)?.abort()
    }

    function base64Url(value) {
      const bytes = new TextEncoder().encode(value)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    // 路径而非显示名是插件内部工作区的身份依据（决策 2026-08-17）；写卡工作台
    // 用同款注册核，只是路径/标题不同（bootstrap.workbenchWorkspace）。
    async function registerPluginWorkspace(ctx, config) {
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (typeof ctx?.workspaces?.create !== 'function') throw new Error(translate('error.noWorkspace'))
      const created = await ctx.workspaces.create({ path: config.path })
      let workspace = created?.workspace || created
      if (!workspace?.workspaceId) throw new Error(translate('error.noWorkspace'))
      if (config.title && workspace.title !== config.title && typeof ctx.workspaces.rename === 'function') {
        try {
          workspace = await ctx.workspaces.rename(workspace.workspaceId, config.title)
        } catch {
          // A user-owned workspace may already use the display title; the
          // canonical path remains the identity and is safe to reuse.
        }
      }
      return workspace
    }

    async function ensureTavernWorkspace(ctx) {
      const config = snapshot.bootstrap.internalWorkspace
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (internalWorkspace?.path === config.path) return internalWorkspace
      if (internalWorkspacePromise) return internalWorkspacePromise
      internalWorkspacePromise = registerPluginWorkspace(ctx, config)
        .then((workspace) => { internalWorkspace = workspace; return workspace })
        .finally(() => { internalWorkspacePromise = undefined })
      return internalWorkspacePromise
    }

    async function ensureWorkbenchWorkspace(ctx) {
      const config = snapshot.bootstrap.workbenchWorkspace
      if (!config?.path) throw new Error(translate('error.noWorkspace'))
      if (workbenchWorkspace?.path === config.path) return workbenchWorkspace
      if (workbenchWorkspacePromise) return workbenchWorkspacePromise
      workbenchWorkspacePromise = registerPluginWorkspace(ctx, config)
        .then((workspace) => { workbenchWorkspace = workspace; return workspace })
        .finally(() => { workbenchWorkspacePromise = undefined })
      return workbenchWorkspacePromise
    }

    function connectTavernWorkspace(ctx, workspaceId) {
      // uiWorkspace → workspaces 双面回退与形状轨迹记录在 @dsh-tavern/bind 的
      // client 探测模块（构建时经 __DSH_BIND_CLIENT_SLOT__ 注入，轨迹同步挂
      // window.__DSH_TAVERN_BIND__ 供诊断读取）；源文件 client/main.js 由
      // scripts/build-plugin.mjs 拼接为产物 client/index.js。
      return DshBindClient.connectHostWorkspace(ctx, workspaceId, clientShapeTrace)
    }

    function openSessionView(ctx, sessionId) {
      // 0.2.0 宿主把「会话进入主视图」从 sessions.open 挪到 uiWorkspace
      // .openSession（retain mainView + 替换 selection）；双面回退与轨迹记录
      // 同样集中在 @dsh-tavern/bind 的 client 探测模块。
      return DshBindClient.openHostSession(ctx, sessionId, clientShapeTrace)
    }

    function bindingArchitecture(binding) {
      // agent-novel / card-workbench sessions keep the native composer and
      // conversation view; classifying them as 'st' would force the ST Tavern
      // tab and composer.
      if (binding?.architecture === 'agent-novel') return 'agent-novel'
      if (binding?.architecture === 'card-workbench') return 'card-workbench'
      return binding?.architecture === 'agent-tavern' ? 'agent-tavern' : 'st'
    }

    // 宿主 sessions store 的快照是 SessionListState { ids, byId, phase,
    // projectionsBySession }——没有 current 字段（dsh-api-session-controller
    // lib/types/client/sessions/service.d.ts）。宿主自己的组件（DocumentTitle /
    // CordisPanel / ui-session.publishMain）一律以 retainedBy.mainView > 0 推导
    // 「主视图中的会话」。这里照宿主同款口径推导；若未来宿主补充 current 字段则
    // 优先直读。返回 string | undefined，引用稳定，可直接喂给 selector hook。
    function useCurrentSessionId(useSessions) {
      return useSessions((sessions) => {
        if (typeof sessions?.current === 'string') return sessions.current
        for (const session of Object.values(sessions?.byId || {})) {
          if ((session?.retainedBy?.mainView ?? 0) > 0) return session.id
        }
        return undefined
      })
    }

    function architectureLabel(architecture) {
      if (architecture === 'agent-novel') return translate('view.architectureNovel')
      if (architecture === 'card-workbench') return translate('workbench.sessionLabel')
      return architecture === 'agent-tavern' ? translate('view.architectureAgent') : translate('view.architectureSt')
    }

    function newChatPolicy(group = false, override = {}) {
      if (group) return { architecture: 'st', contextMode: 'dsh-native' }
      const state = snapshot.bootstrap.state || {}
      const architecture = override.architecture === 'st' || override.architecture === 'agent-tavern'
        ? override.architecture
        : state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'
      const contextMode = override.contextMode === 'agent-managed' || state.defaultContextMode === 'agent-managed'
        ? 'agent-managed'
        : 'dsh-native'
      if (architecture === 'agent-tavern') {
        const status = contextMode === 'agent-managed'
          ? snapshot.bootstrap.agentTavern?.managed
          : snapshot.bootstrap.agentTavern?.native
        if (!status?.available) {
          const reason = status?.reasons?.join(' ') || translate('error.agentTavernUnavailable', { reason: 'host capability check failed' })
          const error = new Error(translate('error.agentTavernUnavailable', { reason }))
          error.code = 'TAVERN_ARCHITECTURE_CONFLICT'
          error.status = 409
          throw error
        }
      }
      return { architecture, contextMode }
    }

    function activationFields(policy) {
      return policy.architecture === 'agent-tavern'
        ? { architecture: policy.architecture, contextMode: policy.contextMode }
        : { architecture: 'st' }
    }

    function reserveTavernSession(ctx, sessionId) {
      // rc.6 connectWorkspace reuses any locally blank session. AgentTavern
      // cannot append a synthetic turn/start, so clear only the client blank
      // mirror while keeping the durable event log untouched.
      ctx?.sessions?.binding(sessionId)?.session?.handleBlank?.(false)
    }

    // 诊断（0.2.0-rc.2 适配期临时）：侧边栏错误原本只显示 message，定位
    // 「Cannot read properties of undefined (reading 'sessionId')」这类宿主链路
    // 抛点需要首帧栈位。同时把完整 stack 存 window.__DSH_TAVERN_DIAG__ 供
    // devtools 取用；问题定位后移除。
    function sidebarErrorDetail(cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const stack = cause instanceof Error ? String(cause.stack || '') : ''
      try {
        window.__DSH_TAVERN_DIAG__ = [...(window.__DSH_TAVERN_DIAG__ || []), { message, stack, at: new Date().toISOString() }].slice(-10)
      } catch { /* 诊断本身不许抛 */ }
      console.error('[dsh-tavern] sidebar error:', cause)
      const frames = stack.split(/\r?\n/).slice(1, 4).map((line) => line.trim()).filter(Boolean)
      return frames.length > 0 ? `${message} ⏎ ${frames.join(' ⏎ ')}` : message
    }

    function clickTavernTab(attempt) {
      // The conversation.view tab label is translated via the slot's label()
      // callback, so match every shipped spelling of the Tavern title.
      const titles = [MESSAGES_EN['nav.title'], MESSAGES_ZH['nav.title']]
      const tab = [...document.querySelectorAll('[role="tab"]')]
        .find((item) => titles.includes(item.textContent?.trim() || ''))
      if (tab instanceof HTMLElement) {
        tab.click()
        return
      }
      if (attempt < 12) setTimeout(() => clickTavernTab(attempt + 1), 50)
    }

    // 旧版本激活的绑定会话在宿主侧仍是 blank（无 turn/start），会被原生「新建
    // 会话」的 blank 复用逻辑劫持。对其幂等重发内部绑定桥接命令，服务端
    // 补齐 marker 和占位 turn 对即摘除。成功记入 repairedBindings，失败移除以待
    // 下次触发重试。AgentTavern 桥接命令对已初始化会话是一次性的，重发只会
    // 往会话记录里塞报错，摘除客户端 blank 镜像即可；仅 initializationPending
    // 的绑定才需要重发以补完初始化。CardWorkbench 的同来源重发是幂等安全路径
    // （服务端不重复 recompose、只补占位），与 ST 同走命令重发。
    async function repairBinding(ctx, sessionId, binding) {
      if (!binding || repairedBindings.has(sessionId)) return
      repairedBindings.add(sessionId)
      // Novel bindings are established by the novel-open bridge command; the
      // generic repair path only clears the client blank mirror so the native
      // new-chat reuse cannot hijack the session.
      if (binding.architecture === 'agent-novel') {
        reserveTavernSession(ctx, sessionId)
        return
      }
      if (binding.architecture === 'card-workbench') {
        // 旧版本打开的工作台会话宿主侧仍是 blank（无 turn/start），会劫持下一次
        // openWorkbenchSession 的 connect 并撞上「已绑定其他来源」守卫。重发同
        // 来源 workbench-open 让服务端补占位 turn 对（幂等：marker 已在则不
        // recompose，同来源通过已启动锁，绑定重写保留 createdCard）。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const payload = base64Url(JSON.stringify({
            action: 'workbench-open',
            sourceCharacter: typeof binding.sourceCharacter === 'string' ? binding.sourceCharacter : '',
            sourceChatId: typeof binding.sourceChatId === 'string' ? binding.sourceChatId : '',
          }))
          const bound = ctx?.sessions?.binding(sessionId)
          if (!bound) throw new Error('session binding unavailable')
          const result = await bound.session.command(`/dsh-tavern-session ${payload}`)
          if (!result?.ok || !result.value?.matched) throw new Error('Tavern session bridge rejected')
          reserveTavernSession(ctx, sessionId)
        } catch {
          repairedBindings.delete(sessionId)
        } finally {
          heldSession.release()
        }
        return
      }
      if (bindingArchitecture(binding) !== 'st' && binding.initializationPending !== true) {
        reserveTavernSession(ctx, sessionId)
        return
      }
      // 待修复的会话可能早已离开主视图（mainView 保留已释放），同样需要显式
      // 持有才能借到 binding；失败照旧由 catch 回落重试。
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const policy = {
          architecture: bindingArchitecture(binding),
          contextMode: binding.contextMode === 'agent-managed' ? 'agent-managed' : 'dsh-native',
        }
        const payload = base64Url(JSON.stringify({
          character: binding.character,
          chatId: binding.chatId,
          ...(binding.group === true ? { group: true } : {}),
          ...activationFields(policy),
        }))
        const bound = ctx?.sessions?.binding(sessionId)
        if (!bound) throw new Error('session binding unavailable')
        const result = await bound.session.command(`/dsh-tavern-session ${payload}`)
        if (!result?.ok || !result.value?.matched) throw new Error('Tavern session bridge rejected')
        reserveTavernSession(ctx, sessionId)
      } catch {
        repairedBindings.delete(sessionId)
      } finally {
        heldSession.release()
      }
    }

    async function openTavernChat(ctx, character, chatId, group = false, policyOverride) {
      update({ navigationStatus: '' })
      const sessions = ctx.sessions.list.getSnapshot()
      const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .find(([sessionId, binding]) => sessions.byId[sessionId]
          && binding.character === character
          && binding.chatId === chatId)
      if (existing) {
        // 已绑定的会话也重发一次绑定命令：旧版本激活的会话宿主侧可能仍 blank，
        // 服务端借此补占位 turn 对，解除原生「新建会话」的复用劫持（幂等）。
        if (bindingArchitecture(existing[1]) === 'st' || existing[1].initializationPending === true) {
          void repairBinding(ctx, existing[0], existing[1])
        }
        reserveTavernSession(ctx, existing[0])
        openSessionView(ctx, existing[0])
        if (bindingArchitecture(existing[1]) === 'st') clickTavernTab(0)
        return existing[0]
      }

      const policy = newChatPolicy(group, policyOverride)
      const workspace = await ensureTavernWorkspace(ctx)

      update({ navigationStatus: translate('nav.opening', { name: character }) })
      const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId)
      // 0.2.0-rc.2 起 connectWorkspace 内部走 sessions.create，不再隐式保留
      // 作用域，未 retain 时 ctx.sessions.binding() 恒为 undefined（宿主契约：
      // retain 后才能借 binding）。先以插件名义显式持有，openSessionView 建立
      // mainView 保留后在 finally 归还，全程引用计数 ≥ 1。
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (!binding) throw new Error(translate('error.noBinding'))
        const payload = JSON.stringify({ sessionId, character, chatId, ...(group ? { group: true } : {}), ...activationFields(policy) })
        await api('binding', {
          method: 'POST',
          headers: jsonHeaders(),
          body: payload,
        })
        const commandPayload = base64Url(JSON.stringify({
          character,
          chatId,
          ...(group ? { group: true } : {}),
          ...activationFields(policy),
        }))
        const result = await binding.session.command(`/dsh-tavern-session ${commandPayload}`)
        if (!result.ok || !result.value?.matched) {
          await api('binding', {
            method: 'DELETE',
            headers: jsonHeaders(),
            body: JSON.stringify({ sessionId }),
          }).catch(() => {})
          throw new Error(result.error?.message || translate('error.activationFailed'))
        }
        reserveTavernSession(ctx, sessionId)
        const label = sessionLabel(character, chatId, group, policy.architecture)
        await binding.session.rename(label).catch(() => {})
        await refreshBootstrap()
        openSessionView(ctx, sessionId)
        update({ navigationStatus: '' })
        if (policy.architecture === 'st') clickTavernTab(0)
        return sessionId
      } finally {
        heldSession.release()
      }
    }

    async function createTavernChat(ctx, character, group = false, policyOverride) {
      const result = await api('chats', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(group ? { group: character } : { character }),
      })
      await loadChatList(character, true)
      const key = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [key]: result.chat },
        revisions: { ...snapshot.revisions, [key]: result.revision },
      })
      return openTavernChat(ctx, character, result.id, group, policyOverride)
    }

    function novelSessionLabel(title) {
      return `AgentNovel · ${String(title || '').slice(0, 60)}`.slice(0, 80)
    }

    // novel-open 通过既有内部桥接命令绑定会话（服务端负责绑定 + recompose
    // agent-novel preset + 唤醒 driver）；发送后轮询 bootstrap 直到会话出现在
    // sessionBindings 且 architecture === 'agent-novel'。
    async function waitForNovelBinding(sessionId, novelId) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const bootstrap = await refreshBootstrap()
          const binding = bootstrap?.state?.sessionBindings?.[sessionId]
          if (binding?.architecture === 'agent-novel' && (novelId === null || binding.novelId === novelId)) return binding
        } catch {
          // Bootstrap may briefly fail while the server binds; keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    }

    async function openNovelSession(ctx, novel) {
      update({ navigationStatus: translate('novel.opening') })
      try {
        const sessions = ctx.sessions.list.getSnapshot()
        const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
          .find(([sessionId, binding]) => binding?.architecture === 'agent-novel'
            && binding.novelId === novel.novelId
            && sessions.byId[sessionId])
        if (existing) {
          reserveTavernSession(ctx, existing[0])
          openSessionView(ctx, existing[0])
          return existing[0]
        }
        const workspace = await ensureTavernWorkspace(ctx)
        const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId)
        // 与 openTavernChat 同因：0.2.0 宿主 connect 不再隐式 retain，先显式
        // 持有再借 binding，openSessionView 接棒 mainView 保留后归还。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          if (!binding) throw new Error(translate('error.noBinding'))
          const commandPayload = base64Url(JSON.stringify({ action: 'novel-open', novelId: novel.novelId }))
          const result = await binding.session.command(`/dsh-tavern-session ${commandPayload}`)
          if (!result?.ok || !result.value?.matched) {
            throw new Error(result.error?.message || translate('error.activationFailed'))
          }
          reserveTavernSession(ctx, sessionId)
          const bound = await waitForNovelBinding(sessionId, novel.novelId)
          if (!bound) throw new Error(translate('novel.bindTimeout'))
          await binding.session.rename(novelSessionLabel(novel.title)).catch(() => {})
          openSessionView(ctx, sessionId)
          return sessionId
        } finally {
          heldSession.release()
        }
      } finally {
        update({ navigationStatus: '' })
      }
    }

    // workbench-open（提案 0013）：与 novel-open 同款桥接——服务端负责绑定 +
    // recompose card-workbench preset；发送后轮询 bootstrap 直到会话出现在
    // sessionBindings 且 architecture === 'card-workbench'、来源身份匹配。
    // source 为 null 时匹配自由工作台（sourceCharacter/sourceChatId 均空）。
    function workbenchBindingMatches(binding, source) {
      if (binding?.architecture !== 'card-workbench') return false
      return source
        ? binding.sourceCharacter === source.character && binding.sourceChatId === source.chatId
        : !binding.sourceCharacter && !binding.sourceChatId
    }

    async function waitForWorkbenchBinding(sessionId, source) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        try {
          const bootstrap = await refreshBootstrap()
          const binding = bootstrap?.state?.sessionBindings?.[sessionId]
          if (workbenchBindingMatches(binding, source)) return binding
        } catch {
          // Bootstrap may briefly fail while the server binds; keep polling.
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      }
      return null
    }

    // 每个聊天对应一个写卡工作会话：source 携带来源聊天身份时按身份幂等复用
    // （聊天侧「交给工作台」）；source 为 null 时是面板拉起的自由工作台，「+」
    // 与新建角色卡向导走 fresh 每次新建（幂等复用会把新建短路成跳转旧会话，
    // 决策 2026-10-08 workbench-blank-reuse 客户端补充）。工作台会话落在专用
    // 内部工作区（Tavern Workbench (internal)）。
    function workbenchSessionLabel(source, ordinal = 0) {
      return source
        ? translate('workbench.chatSessionLabel', {
          character: source.character,
          chat: String(source.chatId).replace(/\.jsonl$/i, ''),
        })
        : ordinal > 1 ? `${translate('workbench.sessionLabel')} ${ordinal}` : translate('workbench.sessionLabel')
    }

    async function openWorkbenchSession(ctx, source = null, { fresh = false } = {}) {
      update({ navigationStatus: translate('workbench.opening') })
      try {
        // 幂等复用只服务「回到已有工作台」的入口（聊天侧「交给工作台」按来源
        // 身份复用，一聊一会话）；fresh 入口（侧栏「+」、新建角色卡向导）必须
        // 跳过——否则同来源会话存活期间点「新建」永远只是跳回旧会话。
        if (!fresh) {
          const sessions = ctx.sessions.list.getSnapshot()
          const existing = Object.entries(snapshot.bootstrap.state.sessionBindings || {})
            .find(([sessionId, binding]) => workbenchBindingMatches(binding, source) && sessions.byId[sessionId])
          if (existing) {
            reserveTavernSession(ctx, existing[0])
            openSessionView(ctx, existing[0])
            return existing[0]
          }
        }
        const workspace = await ensureWorkbenchWorkspace(ctx)
        const sessionId = await connectTavernWorkspace(ctx, workspace.workspaceId)
        // 与 openTavernChat 同因：0.2.0 宿主 connect 不再隐式 retain，先显式
        // 持有再借 binding，openSessionView 接棒 mainView 保留后归还。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          if (!binding) throw new Error(translate('error.noBinding'))
          const commandPayload = base64Url(JSON.stringify(source
            ? { action: 'workbench-open', sourceCharacter: source.character, sourceChatId: source.chatId }
            : { action: 'workbench-open' }))
          const result = await binding.session.command(`/dsh-tavern-session ${commandPayload}`)
          if (!result?.ok || !result.value?.matched) {
            throw new Error(result.error?.message || translate('error.activationFailed'))
          }
          reserveTavernSession(ctx, sessionId)
          const bound = await waitForWorkbenchBinding(sessionId, source)
          if (!bound) throw new Error(translate('workbench.bindTimeout'))
          // 多自由工作台并存时按现存数给宿主标题带序号（第 2 个起），面板列表
          // WorkbenchList 用同款序号区分同名条目；聊天侧工作台按来源身份天然
          // 唯一，出卡后统一改名为卡名。
          const freeOrdinal = source ? 0 : 1 + Object.entries(snapshot.bootstrap.state.sessionBindings || {})
            .filter(([sid, binding]) => sid !== sessionId && workbenchBindingMatches(binding, null) && ctx.sessions.list.getSnapshot().byId[sid])
            .length
          await binding.session.rename(workbenchSessionLabel(source, freeOrdinal)).catch(() => {})
          openSessionView(ctx, sessionId)
          return sessionId
        } finally {
          heldSession.release()
        }
      } finally {
        update({ navigationStatus: '' })
      }
    }

    // 写卡会话改名（对齐酒馆聊天侧边栏的改名能力）：title 落进绑定（侧边栏
    // 分组标签的数据源，压过 createdCard 与来源派生标签），宿主会话标题经
    // binding.session.rename 同步（best-effort，失败只丢宿主标题不改绑定）。
    async function renameWorkbenchSession(ctx, sessionId, currentLabel) {
      const name = window.prompt(translate('workbench.renamePrompt'), currentLabel)
      if (name === null || name.trim() === '' || name.trim() === currentLabel) return false
      await api('card-workbench/rename', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId, title: name.trim() }),
      })
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        const binding = ctx.sessions.binding(sessionId)
        await binding?.session.rename(name.trim()).catch(() => {})
      } finally {
        heldSession.release()
      }
      await refreshBootstrap()
      return true
    }

    // 写卡会话删除（对齐酒馆聊天侧边栏的删除能力）：会话数据本体在宿主侧，
    // 删绑定 + 归档会话即删干净（工作台方案按卡/世界书独立存储，不受影响，
    // 面板仍可见）。不发 close 桥接命令——那是给存活的 ST 会话留「已关闭」
    // 用的，删除路径写进去只会污染将被归档的记录。
    async function deleteWorkbenchSession(ctx, sessionId) {
      await api('binding', {
        method: 'DELETE',
        headers: jsonHeaders(),
        body: JSON.stringify({ sessionId }),
      })
      const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
      try {
        await ctx.workspaces.archiveSession(sessionId).catch(() => {})
      } finally {
        heldSession.release()
      }
      await refreshBootstrap()
      return true
    }

    async function branchTavernChat(ctx, character, chatId, index, sessionId, targetArchitecture) {
      const key = chatKey(character, chatId)
      const revision = snapshot.revisions[key]
      if (!revision) throw new Error(translate('view.loading'))
      const result = await api('branch', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          character, chatId, messageId: index, revision,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          originArchitecture: bindingArchitecture(snapshot.bootstrap.state.sessionBindings?.[sessionId]),
          targetArchitecture: targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st',
        }),
      })
      const nextKey = chatKey(character, result.id)
      update({
        chats: { ...snapshot.chats, [nextKey]: result.chat },
        revisions: { ...snapshot.revisions, [nextKey]: result.revision },
      })
      await loadChatList(character, true)
      return openTavernChat(ctx, character, result.id, false, {
        architecture: targetArchitecture === 'agent-tavern' ? 'agent-tavern' : 'st',
        contextMode: 'dsh-native',
      })
    }

    async function forkTavernArchitecture(ctx, sessionId, binding) {
      const chat = await loadChat(binding.character, binding.chatId)
      if (!chat || chat.messages.length === 0) throw new Error(translate('view.loading'))
      const target = bindingArchitecture(binding) === 'agent-tavern' ? 'st' : 'agent-tavern'
      return branchTavernChat(ctx, binding.character, binding.chatId, chat.messages.length - 1, sessionId, target)
    }

    async function runTavernScriptCommand(sessionId, binding, script) {
      setRun(sessionId, { busy: true, streamText: '', status: 'composer.script', error: '' })
      try {
        const result = await api('script', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({
            character: binding.character,
            chatId: binding.chatId,
            ...(binding.group === true ? { group: true } : {}),
            script,
          }),
        })
        const key = chatKey(binding.character, binding.chatId)
        update({
          chats: { ...snapshot.chats, [key]: result.chat },
          revisions: { ...snapshot.revisions, [key]: result.revision },
        })
        setRun(sessionId, {
          streamText: '',
          status: result.output ? `↳ ${result.output.slice(0, 120)}` : 'run.saved',
        })
      } catch (cause) {
        setRun(sessionId, { error: cause instanceof Error ? cause.message : String(cause), status: '' })
        await loadChat(binding.character, binding.chatId, true).catch(() => {})
      } finally {
        setRun(sessionId, { busy: false })
      }
    }

    function boundSessionIds(character, chatId) {
      return Object.entries(snapshot.bootstrap.state.sessionBindings || {})
        .filter(([, binding]) => binding.character === character && binding.chatId === chatId)
        .map(([sessionId]) => sessionId)
    }

    function sessionLabel(character, chatId, group = false, architecture = 'st') {
      const stem = chatId.replace(/\.jsonl$/i, '').slice(0, 44)
      const prefix = group ? '☰' : architecture === 'agent-tavern' ? 'AgentTavern' : 'ST'
      return `${prefix} ${character} · ${stem}`
    }

    function chatArchitectureLabels(character, chatId, group = false) {
      const matches = Object.values(snapshot.bootstrap.state.sessionBindings || {})
        .filter((binding) => binding?.character === character && binding?.chatId === chatId)
        .map((binding) => architectureLabel(bindingArchitecture(binding)))
      if (matches.length === 0) return [architectureLabel(group ? 'st' : snapshot.bootstrap.state.defaultArchitecture)]
      return [...new Set(matches)]
    }

    async function renameTavernChat(ctx, character, chatId) {
      const currentName = chatId.replace(/\.jsonl$/i, '')
      const name = window.prompt(translate('nav.renamePrompt'), currentName)
      if (name === null || name.trim() === '' || name.trim() === currentName) return chatId
      await loadChat(character, chatId)
      const key = chatKey(character, chatId)
      const sessionIds = boundSessionIds(character, chatId)
      try {
        const result = await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'PATCH',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: name.trim(), revision: snapshot.revisions[key] }),
        })
        const nextKey = chatKey(character, result.id)
        const chats = { ...snapshot.chats }
        const revisions = { ...snapshot.revisions }
        delete chats[key]
        delete revisions[key]
        chats[nextKey] = result.chat
        revisions[nextKey] = result.revision
        update({
          bootstrap: { ...snapshot.bootstrap, state: result.state },
          chats,
          revisions,
        })
        await loadChatList(character, true)
        await Promise.all(sessionIds.map(async (sessionId) => {
          // 已绑定会话可能不在主视图（binding() 为 undefined），显式持有后才
          // 能补齐宿主侧 rename。
          const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
          try {
            const binding = ctx.sessions.binding(sessionId)
            await binding?.session.rename(sessionLabel(character, result.id, binding?.group === true, bindingArchitecture(binding))).catch(() => {})
          } finally {
            heldSession.release()
          }
        }))
        return result.id
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
    }

    async function deleteTavernChat(ctx, character, chatId) {
      const label = chatId.replace(/\.jsonl$/i, '')
      if (!window.confirm(translate('nav.deleteConfirm', { name: label }))) return false
      await loadChat(character, chatId)
      const key = chatKey(character, chatId)
      const sessionIds = boundSessionIds(character, chatId)
      try {
        await api(`chat/${encodeURIComponent(chatId)}?character=${encodeURIComponent(character)}`, {
          method: 'DELETE',
          headers: jsonHeaders(),
          body: JSON.stringify({ revision: snapshot.revisions[key] }),
        })
      } catch (cause) {
        if (cause.status === 409 || cause.code === REVISION_CONFLICT) await loadChat(character, chatId, true).catch(() => {})
        throw cause
      }
      const closePayload = base64Url(JSON.stringify({ action: 'close' }))
      await Promise.all(sessionIds.map(async (sessionId) => {
        // close 桥接命令需要会话作用域存活；不在主视图的绑定会话先显式持有。
        const heldSession = DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)
        try {
          const binding = ctx.sessions.binding(sessionId)
          await api('binding', {
            method: 'DELETE',
            headers: jsonHeaders(),
            body: JSON.stringify({ sessionId }),
          }).catch(() => {})
          await binding?.session.command(`/dsh-tavern-session ${closePayload}`).catch(() => {})
          await ctx.workspaces.archiveSession(sessionId).catch(() => {})
        } finally {
          heldSession.release()
        }
      }))
      const chats = { ...snapshot.chats }
      const revisions = { ...snapshot.revisions }
      delete chats[key]
      delete revisions[key]
      update({ chats, revisions })
      await Promise.all([loadChatList(character, true), refreshBootstrap()])
      return true
    }

    function isTavernSession(session) {
      if (!session?.chat?.order || !session.chat.nodes) return null
      let match = null
      for (const key of session.chat.order) {
        const node = session.chat.nodes.get(key)
        if (node?.kind !== 'context') continue
        // v4 宿主把 plugin source 归并为 producer-owned kind（'plugin:dsh-tavern'，
        // 与宿主 v3→v4 迁移产物一致）；v0-v3 宿主仍是 { kind: 'plugin', plugin }。
        const source = node.data?.source
        const isTavernSource = source?.kind === 'plugin:dsh-tavern'
          || (source?.kind === 'plugin' && source.plugin === 'dsh-tavern')
        if (isTavernSource && source.form === 'notice') {
          match = source.tavernState === 'closed' ? null : { marker: node.key }
        }
      }
      return match
    }

    function selectTavernComposer(owner) {
      return isTavernSession(owner.session)
    }

    function readFile(file, binary) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error || new Error(translate('error.fileRead')))
        reader.onload = () => resolve(reader.result)
        if (binary) reader.readAsArrayBuffer(file)
        else reader.readAsText(file)
      })
    }

    function fileStem(name) {
      return name.replace(/\.[^.]+$/, '') || 'Imported'
    }

    // 分块 btoa：避免大文件 String.fromCharCode 展开超出参数上限（与 importAsset 同款）。
    function bytesToBase64(bytes) {
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary)
    }

    async function importAsset(kind, file) {
      if (!file) return
      if (kind === 'character') {
        const bytes = new Uint8Array(await readFile(file, true))
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        }
        if (/\.png$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ pngBase64: btoa(binary) }),
          })
        } else if (/\.charx$/i.test(file.name)) {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ charxBase64: btoa(binary) }),
          })
        } else {
          await api('import/character', {
            method: 'POST',
            headers: jsonHeaders(),
            body: JSON.stringify({ card: JSON.parse(new TextDecoder().decode(bytes)) }),
          })
        }
      } else if (kind === 'persona') {
        const bytes = new Uint8Array(await readFile(file, true))
        let binary = ''
        for (let index = 0; index < bytes.length; index += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
        }
        await api('import/persona', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ pngBase64: btoa(binary), name: fileStem(file.name) }),
        })
      } else if (kind === 'regex') {
        await api('import/regex', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ data: JSON.parse(await readFile(file, false)) }),
        })
      } else {
        await api(`import/${kind}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ name: fileStem(file.name), data: JSON.parse(await readFile(file, false)) }),
        })
      }
      await refreshBootstrap()
    }

    async function createPersona(name, description) {
      const result = await api('import/persona', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
      return result.persona
    }

    async function savePersona(name, description) {
      const result = await api('persona', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, description }),
      })
      await refreshBootstrap()
      return result.persona
    }

    async function deletePersona(name) {
      await api(`persona?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function createGroup(name, members, activationStrategy) {
      const result = await api('groups', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ name, members, activationStrategy }),
      })
      await refreshBootstrap()
      return result.group
    }

    async function updateGroup(payload) {
      const result = await api('group', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      await refreshBootstrap()
      return result.group
    }

    async function deleteGroup(name) {
      await api(`group?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function saveRegexScripts(scripts) {
      const result = await api('regex', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ scripts }),
      })
      update({ bootstrap: { ...snapshot.bootstrap, state: { ...snapshot.bootstrap.state, regexScripts: result.scripts } } })
      return result.scripts
    }

    function openPanel(section) {
      update({ panelOpen: true, ...(typeof section === 'string' && section !== '' ? { panelSection: section } : {}) })
    }

    function closePanel() {
      update({ panelOpen: false })
    }

    async function fetchCharacterCard(name) {
      const result = await api(`character/${encodeURIComponent(name)}`)
      return result.card
    }

    async function saveCharacterCard(name, card) {
      const result = await api(`character/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ card }),
      })
      await refreshBootstrap()
      return result.card
    }

    async function deleteCharacterAsset(name) {
      await api(`character?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function fetchWorldBook(name) {
      const result = await api(`world/${encodeURIComponent(name)}`)
      return result.book
    }

    async function saveWorldBook(name, book) {
      const result = await api(`world/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: book.name, data: worldBookToFile(book) }),
      })
      await refreshBootstrap()
      return result.book
    }

    async function deleteWorldBook(name) {
      await api(`world?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function deletePresetAsset(name) {
      await api(`preset?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
      await refreshBootstrap()
    }

    async function fetchPreset(name) {
      const result = await api(`preset/${encodeURIComponent(name)}`)
      return result.data
    }

    async function savePreset(name, data, nextName = name) {
      nextName = String(nextName || name).trim() || name
      const result = await api(`preset/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ name: nextName, data }),
      })
      await refreshBootstrap()
      return result.data
    }

    function downloadAsset(path, fallbackName) {
      const anchor = document.createElement('a')
      anchor.href = `${API}/${path}`
      anchor.download = fallbackName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    function commaList(value) {
      return Array.isArray(value) ? value.join(', ') : ''
    }

    function parseCommaList(value) {
      return String(value || '').split(',').map((item) => item.trim()).filter(Boolean)
    }

    function worldBookToFile(book) {
      const entries = {}
      for (const entry of book.entries || []) {
        const {
          uid, key, keysecondary, comment, content, constant, vectorized, selective, selectiveLogic,
          addMemo, order, position, disable, ignoreBudget, excludeRecursion, preventRecursion,
          delayUntilRecursion, probability, useProbability, depth, outletName, group, groupOverride,
          groupWeight, scanDepth, caseSensitive, matchWholeWords, useGroupScoring, automationId,
          role, sticky, cooldown, delay, triggers, matchPersonaDescription, matchCharacterDescription,
          matchCharacterPersonality, matchCharacterDepthPrompt, matchScenario, matchCreatorNotes, extra,
        } = entry
        entries[String(uid)] = {
          ...(extra || {}), uid, key: key || [], keysecondary: keysecondary || [], comment: comment || '', content: content || '',
          constant: Boolean(constant), vectorized: Boolean(vectorized), selective: Boolean(selective), selectiveLogic: Number(selectiveLogic || 0),
          addMemo: Boolean(addMemo), order: Number(order || 100), position: Number(position || 0), disable: Boolean(disable), ignoreBudget: Boolean(ignoreBudget),
          excludeRecursion: Boolean(excludeRecursion), preventRecursion: Boolean(preventRecursion), delayUntilRecursion: Number(delayUntilRecursion || 0),
          probability: Number(probability ?? 100), useProbability: useProbability !== false, depth: Number(depth || 4), outletName: outletName || '',
          group: group || '', groupOverride: Boolean(groupOverride), groupWeight: Number(groupWeight || 100), scanDepth, caseSensitive, matchWholeWords,
          useGroupScoring, automationId: automationId || '', role: Number(role || 0), sticky, cooldown, delay, triggers: triggers || [],
          matchPersonaDescription: Boolean(matchPersonaDescription), matchCharacterDescription: Boolean(matchCharacterDescription),
          matchCharacterPersonality: Boolean(matchCharacterPersonality), matchCharacterDepthPrompt: Boolean(matchCharacterDepthPrompt),
          matchScenario: Boolean(matchScenario), matchCreatorNotes: Boolean(matchCreatorNotes),
        }
      }
      return { ...(book.extra || {}), entries }
    }

    async function fetchGlobals() {
      const result = await api('variables')
      return result.globals || {}
    }

    async function saveGlobals(globals) {
      const result = await api('variables', {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ globals }),
      })
      return result.globals
    }

    // AgentNovel HTTP contract (docs/proposals/0005-agent-novel-architecture.md):
    // GET/POST novels, novels/:id detail, outline, paginated body, control
    // actions, CAS patch and blob export. The server is authoritative; the UI
    // only presents the latest known status.
    function novelPath(novelId, suffix) {
      return `novels/${encodeURIComponent(novelId)}${suffix || ''}`
    }

    async function fetchNovelList() {
      const result = await api('novels')
      return Array.isArray(result.novels) ? result.novels : []
    }

    async function fetchNovelDetail(novelId) {
      const result = await api(novelPath(novelId))
      return result.novel
    }

    async function fetchNovelOutline(novelId) {
      const result = await api(novelPath(novelId, '/outline'))
      return result.outline
    }

    async function fetchNovelBody(novelId, chapterId, cursor, limit) {
      const params = new URLSearchParams()
      if (chapterId) params.set('chapterId', chapterId)
      if (cursor) params.set('cursor', cursor)
      if (limit) params.set('limit', String(limit))
      const query = params.toString()
      const result = await api(novelPath(novelId, `/body${query ? `?${query}` : ''}`))
      return {
        paragraphs: Array.isArray(result.paragraphs) ? result.paragraphs : [],
        nextCursor: result.nextCursor || null,
      }
    }

    async function createNovel(config) {
      const result = await api('novels', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(config),
      })
      return result.novel
    }

    async function runNovelAction(novelId, action, body) {
      return api(novelPath(novelId, `/${action}`), body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
    }

    function isNovelConflict(cause) {
      return cause?.code === NOVEL_REVISION_CONFLICT || cause?.status === 409
    }

    async function patchNovel(novelId, expectedRevision, patch) {
      return api(novelPath(novelId), {
        method: 'PATCH',
        headers: jsonHeaders(),
        body: JSON.stringify({ expectedRevision, patch, cause: 'panel-edit' }),
      })
    }

    async function deleteNovel(novelId) {
      await api(novelPath(novelId), { method: 'DELETE' })
      await refreshBootstrap().catch(() => {})
    }

    function novelExportFileStem(title) {
      const stem = String(title || 'novel').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120)
      return stem !== '' ? stem : 'novel'
    }

    async function downloadNovelExport(novelId, format, title) {
      const kind = format === 'zip' ? 'zip' : 'md'
      const response = await fetch(`${API}/novels/${encodeURIComponent(novelId)}/export?format=${kind}`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        const error = new Error(body.message || `HTTP ${response.status}`)
        error.status = response.status
        error.code = body.code
        throw error
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${novelExportFileStem(title)}.${kind}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    }

    function SettingSelect({ label, value, options, empty, onChange }) {
      return h('label', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, label),
        h('select', { value: value || '', onChange: (event) => onChange(event.target.value || null) },
          ...(empty === undefined ? [] : [h('option', { key: '', value: '' }, empty)]),
          options.map((option) => h('option', { key: option, value: option }, option))))
    }

    function UploadButton({ kind, label, accept }) {
      const t = useTranslate()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      return h('label', { className: 'dt-upload', title: t('settings.importTitle', { name: label }) },
        busy ? t('settings.importing') : label,
        h('input', {
          type: 'file',
          accept,
          disabled: busy,
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (!file) return
            setBusy(true)
            setError('')
            void importAsset(kind, file).catch((cause) => setError(cause.message)).finally(() => setBusy(false))
          },
        }),
        error ? h('span', { className: 'dt-upload-error', title: error }, '!') : null)
    }

    function PersonaBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const personas = state.bootstrap.personas || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.personaManage')),
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            onClick: () => {
              const name = window.prompt(t('settings.personaNamePrompt'), '')
              if (name === null || name.trim() === '') return
              run(createPersona(name.trim(), ''))
            },
          }, t('settings.personaNew')),
          h(UploadButton, { kind: 'persona', label: t('settings.personaImport'), accept: '.png,image/png' })),
        personas.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.personaEmpty')) : h('div', { className: 'dt-persona-list' },
          personas.map((persona) => h('div', { key: persona.name, className: 'dt-persona-row' },
            h('img', {
              className: 'dt-persona-avatar',
              src: `${API}/persona-avatar/${encodeURIComponent(persona.name)}`,
              alt: '',
              onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
            }),
            h('div', { className: 'dt-persona-copy' },
              h('strong', null, persona.name),
              h('span', { title: persona.description }, persona.description.slice(0, 140) || '—')),
            h('div', { className: 'dt-persona-actions' },
              h('button', {
                type: 'button',
                title: t('settings.personaEdit', { name: persona.name }),
                onClick: () => {
                  const next = window.prompt(t('settings.personaDescPrompt'), persona.description)
                  if (next === null) return
                  run(savePersona(persona.name, next))
                },
              }, h(IconEditOutline16)),
              h('button', {
                type: 'button',
                title: t('settings.personaDelete', { name: persona.name }),
                onClick: () => {
                  if (window.confirm(t('settings.personaDeleteConfirm', { name: persona.name }))) run(deletePersona(persona.name))
                },
              }, h(IconTrashOutline16)))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function GroupBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [creating, setCreating] = useState(null)
      const [selected, setSelected] = useState([])
      const characters = state.bootstrap.characters
      const groups = state.bootstrap.groups || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.groups')),
        h('div', { className: 'dt-imports' },
          h('button', {
            type: 'button',
            className: 'dt-upload',
            onClick: () => {
              const name = window.prompt(t('settings.groupNamePrompt'), '')
              if (name === null || name.trim() === '') return
              setCreating(name.trim())
              setSelected([])
            },
          }, t('settings.groupNew'))),
        creating !== null ? h('div', { className: 'dt-group-create' },
          h('strong', null, `${t('settings.groupPickMembers')} — ${creating}`),
          h('div', { className: 'dt-check-grid' }, characters.map((name) => h('label', { key: name },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(name),
              onChange: (event) => {
                setSelected(event.target.checked ? [...selected, name] : selected.filter((item) => item !== name))
              },
            }),
            h('span', null, name))),
          characters.length === 0 ? h('span', { className: 'dt-muted' }, t('nav.noCharacters')) : null),
          h('div', { className: 'dt-imports' },
            h('button', {
              type: 'button',
              className: 'dt-upload',
              disabled: selected.length === 0,
              onClick: () => {
                const name = creating
                setCreating(null)
                run(createGroup(name, selected, 1))
              },
            }, t('settings.groupCreate')),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => setCreating(null) }, t('settings.groupCancel')))) : null,
        groups.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.groupsEmpty')) : h('div', { className: 'dt-group-list' },
          groups.map((group) => h('div', { key: group.name, className: 'dt-group-manage' },
            h('div', { className: 'dt-group-title' },
              h('strong', null, `${group.name} (${group.members.length})`),
              h('span', null, t('settings.groupMembers')),
              h('select', {
                value: group.activationStrategy,
                'aria-label': t('settings.groupStrategy'),
                onChange: (event) => run(updateGroup({ name: group.name, activationStrategy: Number(event.target.value) })),
              },
              h('option', { value: 1 }, t('settings.groupNatural')),
              h('option', { value: 2 }, t('settings.groupList'))),
              h('button', {
                type: 'button',
                title: t('settings.groupDelete', { name: group.name }),
                onClick: () => {
                  if (window.confirm(t('settings.groupDeleteConfirm', { name: group.name }))) run(deleteGroup(group.name))
                },
              }, h(IconTrashOutline16))),
            h('div', { className: 'dt-group-members' }, group.members.map((member) => {
              const disabled = group.disabledMembers.includes(member)
              return h('span', {
                key: member,
                className: `dt-member-chip ${disabled ? 'dt-member-chip-off' : ''}`,
                title: t('settings.groupToggleMember', { member }),
                onClick: () => run(updateGroup({
                  name: group.name,
                  disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                })),
              },
              h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
              h('span', null, member),
              h('button', {
                type: 'button',
                title: t('settings.groupToggleMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({
                    name: group.name,
                    disabledMembers: disabled ? group.disabledMembers.filter((item) => item !== member) : [...group.disabledMembers, member],
                  }))
                },
              }, disabled ? '○' : '●'),
              h('button', {
                type: 'button',
                title: t('settings.groupRemoveMember', { member }),
                onClick: (clickEvent) => {
                  clickEvent.stopPropagation()
                  run(updateGroup({ name: group.name, members: group.members.filter((item) => item !== member) }))
                },
              }, '×'))
            }))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    const REGEX_PLACEMENT_NAMES = { 1: 'input', 2: 'output', 3: 'command', 5: 'world info', 6: 'reasoning' }

    function RegexBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const scripts = state.bootstrap.state.regexScripts || []
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.regex')),
        h('div', { className: 'dt-imports' },
          h(UploadButton, { kind: 'regex', label: t('settings.importRegex'), accept: '.json,application/json' })),
        scripts.length === 0 ? h('p', { className: 'dt-muted' }, t('settings.regexEmpty')) : h('div', { className: 'dt-regex-list' },
          scripts.map((script) => h('div', { key: script.id, className: `dt-regex-row ${script.disabled ? 'dt-regex-off' : ''}` },
            h('label', { className: 'dt-toggle', title: t('settings.regexToggle', { name: script.scriptName }) },
              h('input', {
                type: 'checkbox',
                checked: !script.disabled,
                onChange: () => run(saveRegexScripts(scripts.map((item) => item.id === script.id ? { ...item, disabled: !item.disabled } : item))),
              }),
              h('span', null, script.scriptName)),
            h('span', { className: 'dt-muted', title: t('settings.regexPlacements', { names: script.placement.map((p) => REGEX_PLACEMENT_NAMES[p] || p).join(', ') }) },
              script.findRegex.slice(0, 60)),
            h('button', {
              type: 'button',
              title: t('settings.regexDelete', { name: script.scriptName }),
              onClick: () => run(saveRegexScripts(scripts.filter((item) => item.id !== script.id))),
            }, h(IconTrashOutline16))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function ActiveSetupBand() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const bootstrap = state.bootstrap
      const applyPatch = (patch) => {
        setError('')
        void patchState(patch).catch((cause) => setError(cause.message))
      }
      // 压缩总结模型（提案 0006 §4.3）：选项来自宿主模型目录，值用
      // provider\u0000model 组合以免跨 provider 的同名模型撞 key；空值回落
      // 部署配置（profile patch 的 curatorProvider/Model），再回落会话模型。
      useEffect(() => { if (snapshot.models.status === 'idle') void loadModels().catch(() => {}) }, [])
      const compaction = bootstrap.state.compaction
      const compactionValue = compaction?.curatorProvider && compaction?.curatorModel
        ? `${compaction.curatorProvider}\u0000${compaction.curatorModel}` : ''
      const compactionOptions = []
      for (const group of state.models.groups ?? []) {
        for (const model of group.models ?? []) {
          compactionOptions.push({
            value: `${group.id}\u0000${model.id}`,
            label: `${group.name ?? group.id} · ${model.name ?? model.id}`,
          })
        }
      }
      const changeCompaction = (next) => {
        if (next === '') { applyPatch({ compaction: null }); return }
        const separator = next.indexOf('\u0000')
        applyPatch({
          compaction: {
            curatorProvider: next.slice(0, separator),
            curatorModel: next.slice(separator + 1),
          },
        })
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('settings.activeSetup')),
        h('div', { className: 'dt-settings-grid' },
          h(SettingSelect, {
            label: t('settings.character'),
            value: bootstrap.state.activeCharacter,
            options: bootstrap.characters,
            empty: t('settings.characterEmpty'),
            onChange: (value) => applyPatch({ activeCharacter: value }),
          }),
          h(SettingSelect, {
            label: t('settings.preset'),
            value: bootstrap.state.activePreset,
            options: bootstrap.presets,
            empty: t('settings.presetEmpty'),
            onChange: (value) => applyPatch({ activePreset: value }),
          }),
          h(SettingSelect, {
            label: t('settings.persona'),
            value: bootstrap.state.activePersona,
            options: bootstrap.personas.map((persona) => persona.name),
            empty: t('settings.personaEmpty'),
            onChange: (value) => applyPatch({ activePersona: value }),
          }),
          h('label', { className: 'dt-field', title: t('settings.compactionModelHint') },
            h('span', { className: 'dt-label' }, t('settings.compactionModel')),
            h('select', {
              value: compactionValue,
              onChange: (event) => changeCompaction(event.target.value),
            },
              h('option', { key: '', value: '' }, t('settings.compactionModelFollow')),
              compactionOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label)))),
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: bootstrap.state.nativeAgentPersona === true,
              onChange: (event) => applyPatch({ nativeAgentPersona: event.target.checked }),
            }),
            h('span', null, t('settings.nativePersona')))),
        h('div', { className: 'dt-architecture-settings' },
          h('div', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('settings.defaultArchitecture')),
            h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('settings.defaultArchitecture') },
              h('button', {
                type: 'button',
                className: bootstrap.state.defaultArchitecture === 'agent-tavern' ? 'dt-segmented-active' : '',
                'aria-pressed': bootstrap.state.defaultArchitecture === 'agent-tavern',
                disabled: bootstrap.agentTavern?.native?.available !== true,
                onClick: () => applyPatch({ defaultArchitecture: 'agent-tavern' }),
              }, t('settings.architectureAgent')),
              h('button', {
                type: 'button',
                className: bootstrap.state.defaultArchitecture === 'st' ? 'dt-segmented-active' : '',
                'aria-pressed': bootstrap.state.defaultArchitecture === 'st',
                onClick: () => applyPatch({ defaultArchitecture: 'st' }),
              }, t('settings.architectureSt')))),
          h('p', { className: 'dt-hint' }, t('settings.architectureHint')),
          bootstrap.state.defaultArchitecture === 'agent-tavern'
            ? h(React.Fragment, null,
              h('div', { className: 'dt-field' },
                h('span', { className: 'dt-label' }, t('settings.contextMode')),
                h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('settings.contextMode') },
                  h('button', {
                    type: 'button',
                    className: bootstrap.state.defaultContextMode === 'dsh-native' ? 'dt-segmented-active' : '',
                    'aria-pressed': bootstrap.state.defaultContextMode === 'dsh-native',
                    onClick: () => applyPatch({ defaultContextMode: 'dsh-native' }),
                  }, t('settings.contextNative')),
                  h('button', {
                    type: 'button',
                    className: bootstrap.state.defaultContextMode === 'agent-managed' ? 'dt-segmented-active' : '',
                    'aria-pressed': bootstrap.state.defaultContextMode === 'agent-managed',
                    disabled: bootstrap.agentTavern?.managed?.available !== true,
                    onClick: () => applyPatch({ defaultContextMode: 'agent-managed' }),
                  }, t('settings.contextManaged'))),
                bootstrap.agentTavern?.managed?.available !== true
                  ? h('p', { className: 'dt-hint' }, t('settings.contextManagedUnavailable', {
                    reason: bootstrap.agentTavern?.managed?.reasons?.join(' ') || 'host capability check failed',
                  }))
                  : null),
              h('label', { className: 'dt-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: bootstrap.state.agentTavernPreloadAssets === true,
                  onChange: (event) => applyPatch({ agentTavernPreloadAssets: event.target.checked }),
                }),
                h('span', null, t('settings.preloadAssets'))),
              h('label', { className: 'dt-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: bootstrap.state.agentTavernAllowGlobalWrites === true,
                  onChange: (event) => applyPatch({ agentTavernAllowGlobalWrites: event.target.checked }),
                }),
                h('span', null, t('settings.allowGlobalWrites'))))
            : null),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 自更新卡片/徽标。数据来自宿主 /update 快照：bootstrap 里带的是磁盘缓存
    // 结论（首屏立刻可显示，不打网络），点「检查更新」才穿透 TTL 打 GitHub，
    // 「立即更新」交给宿主依次尝试 dsh plugin → plugin-manager → checkout。
    // 安装期间按 1.5s 轮询宿主快照，面板关掉再打开也能恢复当前阶段。
    function updateStatusText(t, current) {
      const status = current?.status
      if (status === 'update-available') return t('update.status.available', { version: current?.remote?.version || '?' })
      if (status === 'up-to-date') return t('update.status.upToDate')
      if (status === 'local-ahead') return t('update.status.localAhead')
      if (status === 'restart-required') return t('update.status.restartRequired')
      return t('update.status.unknown')
    }

    function updateStatusClass(current) {
      const status = current?.status
      if (status === 'update-available') return 'dt-update-badge-available'
      if (status === 'restart-required') return 'dt-update-badge-pending'
      if (status === 'up-to-date') return 'dt-update-badge-current'
      return 'dt-update-badge-unknown'
    }

    function updateNotes(current) {
      const commits = current?.remote?.commits
      if (!Array.isArray(commits)) return []
      return commits.slice(0, 5).map((commit) => (commit.message ? `${commit.short} ${commit.message}` : commit.short))
    }

    function useUpdateController() {
      const state = useTavernStore()
      const [current, setCurrent] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const snapshot = current || state.bootstrap.update || null
      const installing = snapshot?.install?.running === true

      useEffect(() => {
        let cancelled = false
        void loadUpdateSnapshot()
          .then((next) => { if (!cancelled && next) setCurrent(next) })
          .catch(() => {})
        return () => { cancelled = true }
      }, [])

      // 安装是宿主侧的后台任务：这里只轮询快照直到 running 变 false。
      useEffect(() => {
        if (!installing) return undefined
        let cancelled = false
        const timer = setInterval(() => {
          void loadUpdateSnapshot()
            .then((next) => { if (!cancelled && next) setCurrent(next) })
            .catch(() => {})
        }, 1500)
        return () => { cancelled = true; clearInterval(timer) }
      }, [installing])

      const check = () => {
        setBusy('check')
        setError('')
        return requestUpdateCheck()
          .then((next) => { if (next) setCurrent(next) })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(''))
      }

      const install = (t) => {
        if (!window.confirm(t('update.confirm', { version: snapshot?.remote?.version || '?' }))) return
        setBusy('install')
        setError('')
        void requestUpdateInstall(false)
          .then((next) => { if (next) setCurrent(next) })
          .catch((cause) => setError(cause.message))
          .finally(() => setBusy(''))
      }

      return { snapshot, busy, error, installing, check, install }
    }

    // compact：设置页标题行（状态徽标 + 按钮）；完整版：管理面板「总览」分区。
    function UpdateBand({ compact }) {
      const t = useTranslate()
      const { snapshot, busy, error, installing, check, install } = useUpdateController()
      const local = snapshot?.local || {}
      const remoteBuild = snapshot?.remote || null
      const canInstall = snapshot?.status === 'update-available' && busy === '' && !installing
      const statusLabel = updateStatusText(t, snapshot)
      const checkButton = h(Button, {
        size: 'sm',
        variant: 'outline',
        icon: h(IconRefreshOutline16),
        disabled: busy !== '' || installing,
        onClick: check,
      }, busy === 'check' ? t('update.checking') : t('update.check'))
      const installButton = h(Button, {
        size: 'sm',
        variant: 'primary',
        icon: h(IconDownloadOutline16),
        disabled: !canInstall,
        onClick: () => install(t),
      }, busy === 'install' || installing ? t('update.installing') : t('update.now'))

      if (compact) {
        return h('div', { className: 'dt-settings-update' },
          h('span', { className: `dt-update-badge ${updateStatusClass(snapshot)}` }, statusLabel),
          checkButton,
          snapshot?.status === 'update-available' || installing ? installButton : null,
          error ? h('span', { className: 'dt-error' }, error) : null)
      }

      const notes = updateNotes(snapshot)
      const installState = snapshot?.install || {}
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('update.title')),
        h('div', { className: 'dt-update-row' },
          h('span', { className: `dt-update-badge ${updateStatusClass(snapshot)}` }, statusLabel),
          h('span', { className: 'dt-update-stamp' }, t('update.current', {
            version: local.version || '?',
            commit: local.commit && local.commit !== 'unknown' ? local.commit : '?',
          })),
          remoteBuild
            ? h('span', { className: 'dt-update-stamp' }, t('update.latest', {
              version: remoteBuild.version && remoteBuild.version !== 'unknown' ? remoteBuild.version : '?',
              commit: remoteBuild.commit ? String(remoteBuild.commit).slice(0, 7) : '?',
            }))
            : null),
        notes.length > 0 && snapshot?.status === 'update-available'
          ? h('div', { className: 'dt-update-notes' },
            h('span', { className: 'dt-update-notes-title' }, t('update.notes')),
            h('ul', null, notes.map((note, index) => h('li', { key: `${index}:${note}` }, note))))
          : null,
        h('div', { className: 'dt-update-actions' }, checkButton, installButton),
        installState.message
          ? h('p', { className: installState.phase === 'failed' ? 'dt-error' : 'dt-hint' }, installState.message)
          : null,
        installState.restartRequired
          ? h('p', { className: 'dt-hint' }, t('update.restartHint'))
          : null,
        Array.isArray(installState.log) && installState.log.length > 0
          ? h('pre', { className: 'dt-update-log' }, installState.log.slice(-6).join('\n'))
          : null,
        snapshot?.checkedAt ? h('p', { className: 'dt-hint' }, t('update.checkedAt', { at: new Date(snapshot.checkedAt).toLocaleString() })) : null,
        snapshot?.error ? h('p', { className: 'dt-hint' }, t('update.remoteError', { error: snapshot.error })) : null,
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function TavernSettings() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const stamp = bootstrap.version || bootstrap.commit
        ? `v${bootstrap.version || '?'}${bootstrap.commit ? ` (${bootstrap.commit})` : ''}`
        : ''
      // 重管理全部移入 Tavern 管理面板（sidebar footer 按钮 / 本页按钮打开）；
      // 设置页只保留快速切换与面板入口。
      return h('div', { className: 'dt-settings', 'data-dsh-tavern-settings': '' },
        h('div', { className: 'dt-settings-heading' },
          h('div', null,
            h('h2', null, 'dsh-tavern'),
            h('p', null, t('settings.subtitle')),
            stamp ? h('p', { className: 'dt-settings-version' }, `${t('settings.version')} ${stamp}`) : null,
            h(UpdateBand, { compact: true })),
          h(Button, { variant: 'primary', size: 'sm', icon: h(IconSparkle16), onClick: () => openPanel() }, t('panel.open'))),
        h(ActiveSetupBand),
        state.error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, state.error)) : null)
    }

    // 显示层宏替换（ST substituteParams 的常用子集）：只影响渲染，落库文本保持
    // 原样，切换 swipe / 编辑框读原始 mes 都不受影响。
    function expandDisplayMacros(text, user, char) {
      if (typeof text !== 'string' || !text.includes('{')) return text
      return text
        .replace(/\{\{user\}\}/gi, user)
        .replace(/\{\{char\}\}/gi, char)
        .replace(/\{\{bot\}\}/gi, char)
    }

    function MessageRow({ sessionId, character, chatId, chat, message, index, busy, display, persona }) {
      const t = useTranslate()
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(message.mes || '')
      const [error, setError] = useState('')
      const [branching, setBranching] = useState(false)
      useEffect(() => setDraft(message.mes || ''), [message.mes])
      const isUser = message.is_user === true
      const swipes = Array.isArray(message.swipes) && message.swipes.length > 0 ? message.swipes : [message.mes || '']
      const swipeIndex = Math.min(Math.max(Number(message.swipe_id) || 0, 0), swipes.length - 1)
      // 带意见重写（提案 0011）：swipe_info[].extra.feedback 记录该变体是按
      // 哪条意见重写的；标题悬停可见全文，正文中不出现意见文本。
      const swipeExtra = Array.isArray(message.swipe_info) ? message.swipe_info[swipeIndex] : null
      const swipeFeedback = swipeExtra && typeof swipeExtra === 'object'
        && typeof swipeExtra.extra?.feedback === 'string' && swipeExtra.extra.feedback !== ''
        ? swipeExtra.extra.feedback : ''
      const renderedText = expandDisplayMacros(
        display ?? message.mes ?? '',
        persona || 'User',
        !isUser && message.name ? message.name : character)
      // Do not execute a half-streamed document. Once persisted, complete HTML
      // documents are rendered in isolated frames while ordinary prose remains
      // text, matching Tavern Helper's frontend code-block behavior.
      const frontendDocuments = editing || message.streaming ? [] : extractFrontendDocuments(renderedText)
      const persist = async (nextMessage) => {
        setError('')
        const nextChat = { ...chat, messages: chat.messages.map((item, itemIndex) => itemIndex === index ? nextMessage : item) }
        try {
          await saveChat(character, chatId, nextChat)
          return true
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(message)
          setRun(sessionId, { error: message })
          return false
        }
      }
      const changeSwipe = (delta) => {
        const nextIndex = (swipeIndex + delta + swipes.length) % swipes.length
        void persist({ ...message, swipe_id: nextIndex, mes: swipes[nextIndex] })
      }
      const commit = async () => {
        const nextSwipes = swipes.map((value, itemIndex) => itemIndex === swipeIndex ? draft : value)
        if (await persist({ ...message, mes: draft, ...(message.swipes ? { swipes: nextSwipes } : {}) })) {
          setEditing(false)
        }
      }
      const branch = () => {
        setError('')
        setBranching(true)
        void branchTavernChat(PanelHost.context, character, chatId, index, sessionId, 'st')
          .catch((cause) => setError(cause.message))
          .finally(() => setBranching(false))
      }
      const branchAgent = () => {
        setError('')
        setBranching(true)
        void branchTavernChat(PanelHost.context, character, chatId, index, sessionId, 'agent-tavern')
          .catch((cause) => setError(cause.message))
          .finally(() => setBranching(false))
      }
      return h('article', { className: `dt-message ${isUser ? 'dt-message-user' : 'dt-message-character'}` },
        !isUser ? h('img', {
          className: 'dt-message-avatar',
          src: `${API}/avatar/${encodeURIComponent(message.name || character)}`,
          alt: '',
          onError: (event) => { event.currentTarget.style.visibility = 'hidden' },
        }) : null,
        h('div', { className: 'dt-message-body' },
          h('div', { className: 'dt-message-name' }, message.name || (isUser ? t('message.user') : character)),
          editing
            ? h('textarea', { className: 'dt-message-edit', value: draft, disabled: busy, onChange: (event) => setDraft(event.target.value) })
            : frontendDocuments.length > 0
              ? h('div', { className: 'dt-message-frontend' }, frontendDocuments.map((html, frontendIndex) => h(FrontendFrame, {
                key: `${index}-${frontendIndex}`,
                html,
                token: `tavern-${sessionId}-${index}-${frontendIndex}`,
              })))
              : h('div', { className: 'dt-message-copy' }, renderedText),
          h('div', { className: 'dt-message-actions' },
            swipes.length > 1 ? h(React.Fragment, null,
              h('button', { type: 'button', title: t('message.previousSwipe'), disabled: busy, onClick: () => changeSwipe(-1) }, h(IconChevronLeftOutline14)),
              h('span', null, `${swipeIndex + 1}/${swipes.length}`),
              h('button', { type: 'button', title: t('message.nextSwipe'), disabled: busy, onClick: () => changeSwipe(1) }, h(IconChevronRightOutline14))) : null,
            !isUser && swipeFeedback ? h('span', { className: 'dt-swipe-feedback', title: swipeFeedback }, t('view.rewritten')) : null,
            editing ? h(React.Fragment, null,
              h('button', { type: 'button', disabled: busy, onClick: () => void commit() }, t('message.save')),
              h('button', { type: 'button', onClick: () => { setDraft(message.mes || ''); setError(''); setEditing(false) } }, t('message.cancel')))
              : h(React.Fragment, null,
                h('button', { type: 'button', title: t('message.edit'), disabled: busy, onClick: () => setEditing(true) }, h(IconEditOutline16)),
                h('button', { type: 'button', className: 'dt-branch-btn', title: t('message.branch'), disabled: busy || branching, onClick: branch }, '⑂'),
                h('button', { type: 'button', title: t('view.forkArchitecture', { architecture: t('view.architectureAgent') }), disabled: busy || branching, onClick: branchAgent }, h(IconAgentPresetOutline16)))),
          branching ? h('span', { className: 'dt-message-error' }, t('message.branching')) : null,
          error ? h('span', { className: 'dt-message-error' }, error) : null))
    }

    function TavernView({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const run = state.runs[sessionId] || {}
      const endRef = useRef(null)
      useEffect(() => {
        if (binding) void repairBinding(PanelHost.context, sessionId, binding)
      }, [sessionId, binding?.character, binding?.chatId])
      useEffect(() => {
        if (binding) void loadChat(binding.character, binding.chatId).catch((cause) => setRun(sessionId, { error: cause.message }))
      }, [binding?.character, binding?.chatId, sessionId])
      useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }) }, [chat, run.streamText])
      if (!binding) {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' },
          h(IconUserOutline16, { size: 22 }),
          h('strong', null, t('view.unbound')))
      }
      // Novel sessions keep the native conversation surface; this legacy view
      // only points back at the novels panel (the tab itself stays hidden by
      // useNativeTavernTabFilter in PanelHost).
      if (binding.architecture === 'agent-novel') {
        return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' },
          h(IconListPenOutline16, { size: 22 }),
          h('strong', null, t('novel.viewNotice')),
          h('button', { type: 'button', className: 'dt-upload', onClick: () => openPanel('novels') }, t('novel.openPanel')))
      }
      if (!chat) return h('div', { className: 'dt-view dt-empty', 'data-dsh-tavern-surface': 'view' }, t('view.loading'))
      const messages = [...chat.messages]
      if (run.streamText) messages.push({ name: run.speaker || binding.character, is_user: false, mes: run.streamText, streaming: true })
      const link = chat.header?.chat_metadata?.bookmark_link
      return h('div', { className: 'dt-view', 'data-dsh-tavern-surface': 'view' },
        link ? h('div', { className: 'dt-backlink' },
          h('button', {
            type: 'button',
            onClick: () => {
              void openTavernChat(PanelHost.context, link.character, link.chatId)
                .catch((cause) => setRun(sessionId, { error: cause.message }))
            },
          }, `↩ ${t('view.linkedFrom', { name: `${link.character} · ${(link.chatId || '').replace(/\.jsonl$/i, '')}` })}`)) : null,
        // MVU 状态与回执（0012）/ 剧本进度卡（0014）：available=false / 未绑定剧本
        // 时组件自身返回 null，不占位
        h(TavernMvuStatus, { sessionId }),
        h(TavernScriptProgress, { sessionId }),
        h('div', { className: 'dt-transcript' },
          messages.map((message, index) => h(MessageRow, {
            key: `${index}-${message.send_date || ''}-${message.streaming ? 'stream' : 'saved'}`,
            sessionId,
            character: binding.character,
            chatId: binding.chatId,
            chat,
            message,
            index,
            busy: run.busy || message.streaming,
            display: state.displays[chatKey(binding.character, binding.chatId)]?.[index],
            persona: state.bootstrap.state?.activePersona,
          })),
          h('div', { className: 'dt-transcript-end', ref: endRef })),
        run.error ? h('div', { className: 'dt-run-error' }, run.error) : null)
    }

    function findCurrentChoice(groups, selection) {
      if (!selection) return null
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === selection.provider && model.id === selection.model) return { group, model }
        }
      }
      return null
    }

    // ModelSelect mirrors the native composer model seat: a pill trigger in the
    // input row opening a two-level Model/Effort menu over the provider-grouped
    // directory. Selection persists per Tavern session; the fallback is the DSH
    // default model, and a current selection outside the advertised catalog
    // keeps the trigger on the "Select model" fallback without a stale row.
    function ModelSelect({ sessionId, locked }) {
      const state = useTavernStore()
      const t = useTranslate()
      const models = state.models
      const [open, setOpen] = useState(false)
      const [pane, setPane] = useState('root')
      const [actionError, setActionError] = useState('')
      const [selecting, setSelecting] = useState(false)
      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const itemRefs = useRef([])
      const id = useId()
      const selection = sessionSelection(sessionId)
      const currentChoice = findCurrentChoice(models.groups, selection)
      const reasoning = currentChoice?.model.reasoning
      const effectiveEffort = selection?.reasoningEffort ?? reasoning?.defaultEffort
      const effortLabel = reasoning === undefined ? undefined
        : effectiveEffort === undefined ? t('model.default')
          : reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ?? effectiveEffort
      useEffect(() => { if (snapshot.models.status === 'idle') void loadModels().catch(() => {}) }, [])
      useEffect(() => {
        if (!open) return
        const closeOutside = (event) => {
          if (!rootRef.current?.contains(event.target)) setOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [open])
      const close = (restoreFocus) => {
        setOpen(false)
        setPane('root')
        setActionError('')
        if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
      }
      const show = () => {
        setPane('root')
        setActionError('')
        setOpen(true)
        void loadModels(true).catch(() => {})
      }
      const moveFocus = (offset) => {
        const items = itemRefs.current.filter((item) => item !== null)
        if (items.length === 0) return
        const active = items.findIndex((item) => item === document.activeElement)
        items[(Math.max(active, 0) + offset + items.length) % items.length]?.focus()
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          if (pane !== 'root') setPane('root')
          else close(true)
          return
        }
        if (!open) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(event.key === 'ArrowDown' ? 1 : -1)
        }
      }
      const onBlur = (event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
        close(false)
      }
      const submit = (next) => {
        setSelecting(true)
        setActionError('')
        saveModelSelection(sessionId, next)
          .then(() => { setSelecting(false); close(true) }, (cause) => {
            setSelecting(false)
            setActionError(cause instanceof Error ? cause.message : String(cause))
          })
      }
      const choose = (provider, model, defaultEffort) => {
        if (selection?.provider === provider && selection?.model === model) {
          close(true)
          return
        }
        submit({
          provider,
          model,
          ...(defaultEffort !== undefined ? { reasoningEffort: defaultEffort } : {}),
        })
      }
      const chooseEffort = (effort) => {
        if (!selection) return
        if (effectiveEffort === effort) {
          close(true)
          return
        }
        submit({
          provider: selection.provider,
          model: selection.model,
          ...(effort !== undefined ? { reasoningEffort: effort } : {}),
        })
      }
      const modelLabel = currentChoice?.model.name ?? t('model.select')
      const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
      itemRefs.current = []
      let itemIndex = 0
      const itemRef = () => {
        const at = itemIndex++
        return (node) => { itemRefs.current[at] = node }
      }
      const retry = h('button', {
        type: 'button',
        className: 'dt-model-retry',
        onClick: () => { void loadModels(true).catch(() => {}) },
      }, t('model.retry'))
      const actionErrorRow = actionError
        ? h('div', { className: 'dt-model-error' }, h('span', null, actionError))
        : null
      const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'dt-model-trigger',
        'aria-label': t('model.select'),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        title: triggerLabel,
        disabled: locked,
        onClick: () => { if (open) close(false); else show() },
      },
      h('span', { className: 'dt-model-trigger-label' }, modelLabel),
      effortLabel !== undefined ? h('span', { className: 'dt-model-trigger-effort' }, effortLabel) : null,
      h(IconChevronDownOutline14, { className: `dt-model-chevron ${open ? 'dt-model-chevron-open' : ''}` }))
      const drillCell = (label, value, paneName) => h('button', {
        ref: itemRef(),
        type: 'button',
        role: 'menuitem',
        className: 'dt-model-cell',
        onClick: () => setPane(paneName),
      },
      h('span', { className: 'dt-model-cell-label' }, label),
      h('span', { className: 'dt-model-cell-value' }, value),
      h(IconChevronRightOutline14, { className: 'dt-model-cell-chevron' }))
      const rootPane = pane === 'root' ? h(React.Fragment, null,
        actionErrorRow,
        drillCell(t('model.model'), modelLabel, 'model'),
        reasoning !== undefined ? drillCell(t('model.effort'), effortLabel, 'effort') : null) : null
      const modelPane = pane === 'model' ? h(React.Fragment, null,
        models.status === 'loading' ? h('div', { className: 'dt-model-status' }, t('model.refreshing')) : null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        models.failures.map((failure) => h('div', { key: failure.id, className: 'dt-model-warning' },
          h('span', null, t('model.loadFailed', { name: failure.name, message: failure.message })),
          retry)),
        h('div', { className: 'dt-model-groups' },
          models.groups.map((group) => h('section', {
            key: group.id,
            role: 'group',
            'aria-labelledby': `${id}-${group.id}`,
            className: 'dt-model-group',
          },
          h('div', { className: 'dt-model-group-title', id: `${id}-${group.id}` }, group.name),
          group.models.map((model) => {
            const selected = selection?.provider === group.id && selection?.model === model.id
            return h('button', {
              ref: itemRef(),
              key: model.id,
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': selected,
              className: 'dt-model-option',
              title: model.name,
              disabled: selecting,
              onClick: () => choose(group.id, model.id, model.reasoning?.defaultEffort),
            },
            h('span', { className: 'dt-model-option-copy' },
              h('span', { className: 'dt-model-name' }, model.name),
              model.description !== undefined ? h('span', { className: 'dt-model-description' }, model.description) : null),
            h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
          }))),
        models.status === 'ready' && models.groups.every((group) => group.models.length === 0)
          ? h('div', { className: 'dt-model-empty' }, t('model.noneAvailable'))
          : null)) : null
      const effortPane = pane === 'effort' ? h(React.Fragment, null,
        models.error ? h('div', { className: 'dt-model-error' }, h('span', null, models.error), retry) : null,
        actionErrorRow,
        reasoning === undefined
          ? h('div', { className: 'dt-model-empty' }, t('model.noEffort'))
          : h(React.Fragment, null,
            reasoning.defaultEffort === undefined ? h('button', {
              ref: itemRef(),
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': effectiveEffort === undefined,
              className: 'dt-model-option',
              disabled: selecting,
              onClick: () => chooseEffort(undefined),
            },
            h('span', { className: 'dt-model-option-copy' }, h('span', { className: 'dt-model-name' }, t('model.default'))),
            h('span', { className: 'dt-model-check' }, effectiveEffort === undefined ? h(IconCheckOutline16) : null)) : null,
            reasoning.efforts.map((effort) => {
              const selected = effectiveEffort === effort.id
              return h('button', {
                ref: itemRef(),
                key: effort.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': selected,
                className: 'dt-model-option',
                disabled: selecting,
                onClick: () => chooseEffort(effort.id),
              },
              h('span', { className: 'dt-model-option-copy' },
                h('span', { className: 'dt-model-name' }, effort.name),
                effort.description !== undefined ? h('span', { className: 'dt-model-description' }, effort.description) : null),
              h('span', { className: 'dt-model-check' }, selected ? h(IconCheckOutline16) : null))
            }))) : null
      return h('div', { ref: rootRef, className: 'dt-model-select', onKeyDown, onBlur },
        trigger,
        open ? h('div', {
          id: `${id}-menu`,
          className: 'dt-model-menu',
          role: 'menu',
          'aria-label': t('model.menuLabel'),
        }, rootPane, modelPane, effortPane) : null)
    }

    function MemberPicker({ binding, disabled, selected, onSelect }) {
      const state = useTavernStore()
      const t = useTranslate()
      const group = (state.bootstrap.groups || []).find((item) => item.name === binding.character)
      if (!group) return null
      const enabled = group.members.filter((member) => !group.disabledMembers.includes(member))
      return h('div', { className: 'dt-member-row' },
        enabled.map((member) => h('button', {
          key: member,
          type: 'button',
          className: `dt-member-chip ${selected === member ? 'dt-member-chip-active' : ''}`,
          title: t('composer.member', { name: member }),
          disabled,
          onClick: () => onSelect(selected === member ? '' : member),
        },
        h('img', { src: `${API}/avatar/${encodeURIComponent(member)}`, alt: '' }),
        h('span', null, member))))
    }

    // 行动候选（提案 0010）：与正文生成解耦的轻量请求。仅 ST 生成入口可见
    // （bindingArchitecture==='st'，与重掷按钮/Tavern 标签页的可见性判断同源；
    // 群聊无单角色卡，服务端 getCharacter 必然落空，同样不暴露）；若 POST
    // candidates 返回 TAVERN_ARCHITECTURE_CONFLICT 则兜底隐藏本面板。
    // 候选项点击只填入输入框（可改再发，绝不自动发送）；带意见重新生成携带
    // feedback；失败展示错误并保留旧候选（服务端失败不落聊天、revision 不动）。
    function TavernCandidates({ sessionId, disabled, onFill }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const chat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const stored = chat ? normalizeStoredCandidates(chat.header?.chat_metadata?.candidates) : null
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [feedback, setFeedback] = useState('')
      const [conflicted, setConflicted] = useState(false)
      // 每个聊天最多自动展开一次：加载时已有候选则直接展示（提案 0010 §3.2），
      // 用户手动收起后不再强制弹开；切换到无候选的聊天则回到折叠态。
      const autoOpenedFor = useRef('')
      useEffect(() => {
        if (!key) return
        if (autoOpenedFor.current === key) return
        if (stored !== null) {
          autoOpenedFor.current = key
          setOpen(true)
        } else {
          setOpen(false)
        }
      }, [key, stored?.generatedAt])
      const generate = (withFeedback) => {
        if (!binding || busy || disabled) return
        const text = withFeedback ? feedback.trim() : ''
        setBusy(true)
        setError('')
        void (async () => {
          try {
            // 候选写走 revision CAS，必须先确保本地拿得到当前 revision。
            await loadChat(binding.character, binding.chatId)
            await generateChatCandidates(sessionId, binding, text === '' ? undefined : text)
            if (withFeedback) setFeedback('')
            setOpen(true)
          } catch (cause) {
            if (cause?.code === 'TAVERN_ARCHITECTURE_CONFLICT') {
              setConflicted(true)
              return
            }
            setError(cause instanceof Error ? cause.message : String(cause))
            if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
              await loadChat(binding.character, binding.chatId, true).catch(() => {})
            }
          } finally {
            setBusy(false)
          }
        })()
      }
      if (!binding || binding.group === true || bindingArchitecture(binding) !== 'st' || conflicted) return null
      const blocked = busy || disabled === true
      return h('div', { className: 'dt-candidates', 'data-dsh-tavern-surface': 'candidates' },
        h('div', { className: 'dt-candidates-head' },
          h('button', {
            type: 'button',
            className: 'dt-candidates-toggle',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
            h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : undefined }),
            h('span', null, t('candidates.title')),
            stored ? h('span', { className: 'dt-candidates-count' }, String(stored.items.length)) : null),
          h('div', { className: 'dt-candidates-actions' },
            h('button', { type: 'button', disabled: blocked, onClick: () => generate(false) },
              busy ? t('candidates.generating') : t('candidates.generate')))),
        open ? h('div', { className: 'dt-candidates-body' },
          busy ? h('p', { className: 'dt-muted' }, t('candidates.generating')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          stored
            ? h(React.Fragment, null,
              stored.generatedAt ? h('p', { className: 'dt-candidates-meta' }, t('candidates.generatedAt', { time: formatNovelTime(stored.generatedAt) })) : null,
              stored.feedback ? h('p', { className: 'dt-candidates-meta' }, t('candidates.lastFeedback', { feedback: stored.feedback })) : null,
              h('div', { className: 'dt-candidate-list' }, stored.items.map((item, index) => h('button', {
                key: index,
                type: 'button',
                className: 'dt-candidate-item',
                title: t('candidates.fill'),
                onClick: () => onFill(item.text),
              },
                h('span', { className: `dt-candidate-kind dt-candidate-kind-${item.kind}` }, t(`candidates.kind.${item.kind}`)),
                h('span', { className: 'dt-candidate-text' }, item.text)))))
            : h('p', { className: 'dt-muted' }, t('candidates.empty')),
          h('div', { className: 'dt-candidates-feedback' },
            h('input', {
              value: feedback,
              placeholder: t('candidates.feedbackPlaceholder'),
              disabled: blocked,
              onChange: (event) => setFeedback(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                  event.preventDefault()
                  generate(true)
                }
              },
            }),
            h('button', { type: 'button', disabled: blocked, onClick: () => generate(true) }, t('candidates.regenerate')))) : null)
    }

    // MVU 状态与回执（提案 0012 P1）：ST 聊天挂在 TavernView 顶部的常驻面板，
    // AgentTavern 会话改由标题栏按钮弹出同一面板（embedded 变体）——原生
    // conversation 是宿主表面，插件没有可插入正文区的 slot，标题栏是两架构共有
    // 的插件挂载点。宿主带原生右侧栏（ui-sidebar-right，≥0.2.0-rc.2）时同一
    // 面板还注册为页面型 tab（sidebar 变体）：面板成为会话右栏的一页而不是
    // 弹层，标题栏按钮优先打开侧栏 tab，旧宿主回退弹层。
    // available=false（本局无变量也无回执）时内联整块隐藏；sidebar/embedded 是
    // 用户主动打开的表面，保留空态提示。renderedHtml 存在（卡带 statusTemplate）
    // 时用 FrontendFrame 同款沙箱渲染，否则退回变量键值表（嵌套对象折叠成
    // 路径.值；sidebar 变体按顶层段分组展示）。
    // 重试按钮只对 ST 绑定暴露——POST mvu/retry 重跑的是 ST 生成链路的模板
    // 输出渲染（AgentTavern 会话服务端 409 TAVERN_ARCHITECTURE_CONFLICT）；群聊
    // 走 ST 链路，服务端按楼层发言人回落支持重试（src/mvu.ts），同样暴露。
    function flattenMvuVariables(value, prefix = '') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
      const rows = []
      for (const [name, entry] of Object.entries(value)) {
        const path = prefix === '' ? name : `${prefix}.${name}`
        if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
          rows.push(...flattenMvuVariables(entry, path))
        } else {
          rows.push([path, entry])
        }
      }
      return rows
    }

    // sidebar 变体的变量分组：顶层段做组名，剩余路径做组内行键（无剩余路径时
    // 行键退化为 '·' 占位，值即组值本身——单层变量树不因分组丢行）。
    function groupMvuVariables(rows) {
      const groups = []
      const byName = new Map()
      for (const [path, value] of rows) {
        const separator = path.indexOf('.')
        const name = separator === -1 ? path : path.slice(0, separator)
        const rest = separator === -1 ? '·' : path.slice(separator + 1)
        if (!byName.has(name)) {
          byName.set(name, { name, rows: [] })
          groups.push(byName.get(name))
        }
        byName.get(name).rows.push([rest, value])
      }
      return groups
    }

    function formatMvuValue(value, limit = 96) {
      const text = typeof value === 'string' ? value : (() => {
        try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
      })()
      return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
    }

    // 原生会话（AgentTavern / 原生 conversation）的生成走宿主 AgentLoop：楼层
    // 投影、MVU 结算、tavern_script_advance 全在服务端落库，插件本地
    // chats/revisions 收不到任何信号（saved SSE 只在 ST 链路发）；后台写路径同
    // 样没有推送通道。MVU 面板 / 剧本进度卡这类「服务端权威」的会话面板因此补
    // 一条可见性门控的低频轮询（对齐 bootstrap 水位 3s / novel 10s 轮询的既有
    // 模式）：页面可见期间每 5s 重取，回前台立即补一拍，隐藏期间停发。load 经
    // latest ref 恒取最新闭包，父级重渲染不重置定时器；错误语义由 load 自理
    // （瞬时错误保留上次快照，404 才回落空态）。
    const SESSION_PANEL_POLL_MS = 5000

    function useSessionPanelPoll(load, deps) {
      const latest = useRef(load)
      useEffect(() => { latest.current = load })
      useEffect(() => {
        let cancelled = false
        let inFlight = false
        const tick = () => {
          if (cancelled || inFlight || document.visibilityState === 'hidden') return
          inFlight = true
          void Promise.resolve(latest.current())
            .catch(() => {})
            .finally(() => { inFlight = false })
        }
        const timer = setInterval(tick, SESSION_PANEL_POLL_MS)
        const onVisibility = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, deps)
    }

    function TavernMvuStatus({ sessionId, embedded = false, sidebar = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const chat = binding ? state.chats[key] : null
      // revision / 楼层计数变化（生成、重试、写路径）后重取状态快照
      const revision = binding ? state.revisions[key] : undefined
      const messageCount = chat?.messages?.length ?? 0
      const frameToken = useId()
      const [status, setStatus] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [expandedReceipt, setExpandedReceipt] = useState('')
      const [showAllReceipts, setShowAllReceipts] = useState(false)
      const autoOpenedFor = useRef('')
      const reload = () => {
        if (!binding) return Promise.resolve(null)
        return loadMvuStatus(binding.character, binding.chatId).catch(() => null)
      }
      useEffect(() => {
        if (!binding) return undefined
        let cancelled = false
        // 读取失败（含 404 聊天竞态）静默隐藏本面板，不打扰正文流
        void loadMvuStatus(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setStatus(result) })
          .catch(() => { if (!cancelled) setStatus(null) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, revision, messageCount])
      // 原生会话 / 后台写路径不经过本地 revision：可见期间轮询补齐自动刷新
      useSessionPanelPoll(() => {
        if (!binding) return Promise.resolve()
        return loadMvuStatus(binding.character, binding.chatId)
          .then((result) => { setStatus(result) })
          .catch((cause) => {
            // 404（聊天删除 / 竞态）才回落空态；瞬时错误保留上次快照不打扰
            if (cause?.status === 404) setStatus(null)
          })
      }, [binding?.character, binding?.chatId])
      // 每个聊天最多自动展开一次（对齐 TavernCandidates）；用户手动收起后不再弹开。
      // sidebar 变体没有折叠头（tab chip 就是容器），不参与自动展开。
      useEffect(() => {
        if (sidebar || !key || status?.available !== true) return
        if (autoOpenedFor.current === key) return
        autoOpenedFor.current = key
        setOpen(true)
      }, [key, status?.available])
      const receipts = Array.isArray(status?.receipts) ? status.receipts : []
      const latest = receipts[receipts.length - 1]
      const canRetry = Boolean(binding)
        && bindingArchitecture(binding) === 'st'
        && latest !== undefined
        && (latest.status === 'failed' || (Array.isArray(latest.failures) && latest.failures.length > 0))
      const retry = () => {
        if (!binding || busy) return
        setBusy(true)
        setError('')
        void (async () => {
          try {
            // 写走 revision CAS，必须先确保本地拿得到当前 revision
            await loadChat(binding.character, binding.chatId)
            const result = await retryMvuSettlement(sessionId, binding)
            const next = await reload()
            if (next) setStatus(next)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
            if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
              await loadChat(binding.character, binding.chatId, true).catch(() => {})
              const next = await reload()
              if (next) setStatus(next)
            }
          } finally {
            setBusy(false)
          }
        })()
      }
      // 回执卡片与「展开全部」钮在三个变体（内联 / 弹层 / 侧栏）间共享，收进
      // 组件内闭包：状态（expandedReceipt / showAllReceipts）挂在同一实例上。
      const receiptCard = (receipt, index) => {
        const rowKey = `${index}-${receipt.turnKey}-${receipt.at}`
        const changes = Array.isArray(receipt.changes) ? receipt.changes : []
        const failures = Array.isArray(receipt.failures) ? receipt.failures : []
        const expanded = expandedReceipt === rowKey
        const shownChanges = expanded ? changes : changes.slice(0, 3)
        return h('div', { key: rowKey, className: 'dt-mvu-receipt' },
          h('div', { className: 'dt-mvu-receipt-head' },
            h('span', { className: `dt-mvu-badge dt-mvu-badge-${receipt.status}` }, t(`mvu.status.${receipt.status}`)),
            h('span', { className: 'dt-mvu-meta' }, `${t('mvu.turn', { turn: receipt.turnKey })} · ${formatNovelTime(receipt.at)}`)),
          shownChanges.map((change) => h('div', { key: change.name, className: 'dt-mvu-change' },
            t('mvu.change', {
              name: change.name,
              before: 'before' in change ? formatMvuValue(change.before) : '∅',
              after: 'after' in change ? formatMvuValue(change.after) : '∅',
            }))),
          changes.length > 3 ? h('button', {
            type: 'button',
            className: 'dt-mvu-more',
            onClick: () => setExpandedReceipt(expanded ? '' : rowKey),
          }, t('mvu.more', { count: changes.length - 3 })) : null,
          failures.length > 0 ? h('div', { className: 'dt-mvu-failures' },
            h('span', { className: 'dt-mvu-failures-title' }, t('mvu.failures')),
            failures.map((failure, failureIndex) => h('div', { key: failureIndex, className: 'dt-mvu-failure' }, failure))) : null)
      }
      const visibleReceipts = (showAllReceipts ? receipts : receipts.slice(-5)).slice().reverse()
      const hiddenReceipts = Math.max(0, receipts.length - 5)
      const receiptsMoreToggle = hiddenReceipts > 0 ? h('button', {
        type: 'button',
        className: 'dt-mvu-more',
        onClick: () => setShowAllReceipts(!showAllReceipts),
      }, showAllReceipts ? t('mvu.less') : t('mvu.more', { count: hiddenReceipts })) : null
      // sidebar 变体（DSH 原生右侧栏页面型 tab）：无折叠头（tab chip 就是容器），
      // 内容自滚动；按「模板状态栏 → 变量分组 → 结算回执」三段纵向排布，面板
      // 取会话底色不加卡片底（宿主右栏设计约定：它是页面的一列，不是浮层卡片）。
      if (sidebar) {
        if (!binding || !status || status.available !== true) {
          return h('div', { className: 'dt-mvu-side', 'data-dsh-tavern-surface': 'mvu-sidebar' },
            h('div', { className: 'dt-mvu-side-empty' }, h(IconDataOutline16), h('span', null, t('mvu.unavailable'))))
        }
        const variables = flattenMvuVariables(status.variables)
        const groups = groupMvuVariables(variables)
        return h('div', { className: 'dt-mvu-side', 'data-dsh-tavern-surface': 'mvu-sidebar' },
          h('div', { className: 'dt-mvu-side-head' },
            h('span', { className: 'dt-mvu-summary' }, t('mvu.summary', { variables: variables.length, receipts: receipts.length })),
            canRetry ? h('button', {
              type: 'button',
              className: 'dt-mvu-side-retry',
              disabled: busy,
              onClick: retry,
            }, busy ? t('mvu.retrying') : t('mvu.retry')) : null),
          busy ? h('p', { className: 'dt-muted' }, t('mvu.retrying')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          status.renderedHtml
            ? h('div', { className: 'dt-mvu-rendered' }, h(FrontendFrame, { html: status.renderedHtml, token: frameToken }))
            : null,
          variables.length > 0
            ? h('section', { className: 'dt-mvu-side-section' },
              h('h3', { className: 'dt-mvu-side-h' },
                h('span', null, t('mvu.variables')),
                h('span', { className: 'dt-mvu-side-count' }, String(variables.length))),
              h('div', { className: 'dt-mvu-groups' }, groups.map((group) => h('div', { key: group.name, className: 'dt-mvu-group' },
                h('div', { className: 'dt-mvu-group-h' },
                  h('span', { className: 'dt-mvu-group-name' }, group.name),
                  h('span', { className: 'dt-mvu-group-count' }, String(group.rows.length))),
                h('div', { className: 'dt-mvu-group-body' }, group.rows.map(([path, value]) => h('div', { key: path, className: 'dt-mvu-var-row' },
                  h('span', { className: 'dt-mvu-var-path', title: path === '·' ? group.name : `${group.name}.${path}` }, path),
                  h('span', { className: 'dt-mvu-var-value', title: formatMvuValue(value, 480) }, formatMvuValue(value, 240)))))))))
            : null,
          h('section', { className: 'dt-mvu-side-section' },
            h('h3', { className: 'dt-mvu-side-h' },
              h('span', null, t('mvu.receipts')),
              receipts.length > 0 ? h('span', { className: 'dt-mvu-side-count' }, String(receipts.length)) : null),
            receipts.length === 0
              ? h('p', { className: 'dt-muted' }, t('mvu.receiptsEmpty'))
              : h('div', { className: 'dt-mvu-receipts' },
                visibleReceipts.map((receipt, index) => receiptCard(receipt, index)),
                receiptsMoreToggle)))
      }
      // 内嵌（标题栏弹出）时无内容也给出提示：用户是主动点开的，空面板比提示更困惑
      if (!binding || !status || status.available !== true) {
        return embedded ? h('p', { className: 'dt-muted' }, t('mvu.unavailable')) : null
      }
      const variables = flattenMvuVariables(status.variables)
      return h('div', { className: 'dt-mvu', 'data-dsh-tavern-surface': 'mvu' },
        h('div', { className: 'dt-mvu-head' },
          h('button', {
            type: 'button',
            className: 'dt-mvu-toggle',
            'aria-expanded': open,
            onClick: () => setOpen(!open),
          },
            h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : undefined }),
            h('span', null, t('mvu.title')),
            receipts.length > 0 ? h('span', { className: 'dt-mvu-count' }, String(receipts.length)) : null),
          canRetry ? h('div', { className: 'dt-mvu-actions' },
            h('button', { type: 'button', disabled: busy, onClick: retry }, busy ? t('mvu.retrying') : t('mvu.retry'))) : null),
        open ? h('div', { className: 'dt-mvu-body' },
          busy ? h('p', { className: 'dt-muted' }, t('mvu.retrying')) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          status.renderedHtml
            ? h('div', { className: 'dt-mvu-rendered' }, h(FrontendFrame, { html: status.renderedHtml, token: frameToken }))
            : variables.length > 0
              ? h(React.Fragment, null,
                h('div', { className: 'dt-mvu-section-title' }, t('mvu.variables')),
                h('div', { className: 'dt-mvu-vars' }, variables.map(([path, value]) => h('div', { key: path, className: 'dt-mvu-var' },
                  h('span', { className: 'dt-mvu-var-path' }, path),
                  h('span', { className: 'dt-mvu-var-value' }, formatMvuValue(value))))))
              : null,
          h('div', { className: 'dt-mvu-section-title' }, t('mvu.receipts')),
          receipts.length === 0
            ? h('p', { className: 'dt-muted' }, t('mvu.receiptsEmpty'))
            : h('div', { className: 'dt-mvu-receipts' },
              visibleReceipts.map((receipt, index) => receiptCard(receipt, index)),
              receiptsMoreToggle)) : null)
    }

    // MVU 面板在 DSH 原生右侧栏的 tab 标识：id 是本实现在 tab 系统里的身份
    // （也是 body/title 在 keyed slot 下的派发键），kind 是 openTab 的页面名。
    const MVU_TAB_ID = 'dsh-tavern/mvu'
    const MVU_TAB_KIND = 'tavern-mvu'

    // MVU 面板的 DSH 原生右侧栏 body（sidebar.right.pane.tab keyed slot，按
    // MVU_TAB_ID 派发到本组件）：会话作用域，sessionId 由 keyed 注入回调显式
    // 传入（与官方 browser/terminal 提供者同款姿势，不依赖标准 kit 的投递细
    // 节），渲染 TavernMvuStatus 的 sidebar 变体。tab 的 chip 标题、关闭、分栏
    // 都由宿主右栏 kit 拥有，本组件只管内容。
    function TavernMvuSidebarTab({ sessionId }) {
      return h(TavernMvuStatus, { sessionId, sidebar: true })
    }

    // 剧本进度卡（提案 0014 P1）：卡绑定剧本时在聊天视图顶部展示进度。进度是
    // 展示不是跳章——只读渲染 chunkIndex+1/chunkCount 与当前片段预览（服务端
    // 已截到 ≤400 字符），没有任何改写进度的入口；解绑（404）后隐藏。
    function TavernScriptProgress({ sessionId }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const key = binding ? chatKey(binding.character, binding.chatId) : ''
      const chat = binding ? state.chats[key] : null
      const revision = binding ? state.revisions[key] : undefined
      const messageCount = chat?.messages?.length ?? 0
      // 绑定/解绑不经过聊天 revision（写在卡上），靠剧本库写计数感知
      const scriptsRevision = state.scriptsRevision
      const [progress, setProgress] = useState(null)
      useEffect(() => {
        if (!binding) return undefined
        let cancelled = false
        // 404（卡未绑定剧本 / 聊天缺失）即隐藏本卡，绑定解绑对视图即时生效
        void loadScriptProgress(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setProgress(result) })
          .catch(() => { if (!cancelled) setProgress(null) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, revision, messageCount, scriptsRevision])
      // tavern_script_advance 是原生 AgentLoop 的 agent 工具：剧本推进同样
      // 不经过本地 revision，可见期间轮询补齐自动刷新
      useSessionPanelPoll(() => {
        if (!binding) return Promise.resolve()
        return loadScriptProgress(binding.character, binding.chatId)
          .then((result) => { setProgress(result) })
          .catch((cause) => {
            // 404（解绑 / 聊天缺失）即隐藏本卡；瞬时错误保留上次进度
            if (cause?.status === 404) setProgress(null)
          })
      }, [binding?.character, binding?.chatId])
      if (!binding || !progress) return null
      const total = Number(progress.chunkCount)
      if (!Number.isFinite(total) || total <= 0) return null
      const current = Math.min(Math.max(Number(progress.chunkIndex) || 0, 0), total - 1) + 1
      const percent = Math.round((current / total) * 100)
      return h('div', { className: 'dt-script-card', 'data-dsh-tavern-surface': 'script-progress' },
        h('div', { className: 'dt-script-card-head' },
          h('span', { className: 'dt-script-card-title' }, t('script.progressTitle')),
          h('span', { className: 'dt-script-card-pos' }, t('script.position', { current, total }))),
        h('div', { className: 'dt-script-bar' },
          h('div', { className: 'dt-script-bar-fill', style: { width: `${percent}%` } })),
        h('div', { className: 'dt-script-card-meta' },
          h('span', { className: 'dt-script-name', title: progress.scriptName }, progress.scriptName),
          progress.alignedAt ? h('span', null, t('script.alignedAt', { time: formatNovelTime(progress.alignedAt) })) : null),
        progress.currentPreview ? h('p', { className: 'dt-script-preview' }, progress.currentPreview) : null,
        h('p', { className: 'dt-script-hint' }, t('script.hint')))
    }

    function TavernComposer({ sessionId, useInput, inputActions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const input = useInput((value) => value)
      const run = state.runs[sessionId] || {}
      const [trigger, setTrigger] = useState('')
      const send = () => {
        const message = input.draft.trim()
        if (!binding || !message || run.busy) return
        if (message.startsWith('/')) {
          inputActions.setDraft('')
          void runTavernScriptCommand(sessionId, binding, message)
          return
        }
        inputActions.setDraft('')
        void generateFor(sessionId, binding, 'send', message, trigger ? { triggerMember: trigger } : {})
        setTrigger('')
      }
      const placeholder = binding
        ? `${binding.group === true ? '☰ ' : ''}${t('composer.writeTo', { name: binding.character })}`
        : t('composer.unavailable')
      return h('div', { className: 'dt-composer-wrap', 'data-dsh-tavern-surface': 'composer' },
        binding && bindingArchitecture(binding) === 'st' && binding.group !== true
          ? h(TavernCandidates, {
            sessionId,
            disabled: run.busy,
            onFill: (text) => inputActions.setDraft(text),
          })
          : null,
        h('div', { className: 'dt-composer' },
          binding?.group === true ? h(MemberPicker, { binding, disabled: run.busy, selected: trigger, onSelect: setTrigger }) : null,
          h('textarea', {
            value: input.draft,
            disabled: !binding || run.busy,
            placeholder,
            rows: 2,
            onChange: (event) => inputActions.setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault()
                send()
              }
            },
          }),
          h('div', { className: 'dt-composer-row' },
            h('span', { className: run.error ? 'dt-error' : 'dt-muted' }, run.error || (run.status ? t(run.status) : (binding ? binding.character : ''))),
            h('div', { className: 'dt-composer-actions' },
              h(ModelSelect, { sessionId, locked: run.busy || !binding }),
              run.busy
                ? h('button', { type: 'button', className: 'dt-primary-icon', title: t('composer.stop'), onClick: () => stopGeneration(sessionId) }, h(IconStopFill16))
                : h('button', {
                  type: 'button',
                  className: 'dt-primary-icon',
                  title: input.draft.trim().startsWith('/') ? t('composer.script') : t('composer.send'),
                  disabled: !binding || !input.draft.trim(),
                  onClick: send,
                }, input.draft.trim().startsWith('/') ? h('span', { className: 'dt-script-glyph' }, '/') : h(IconSendOutline16))))))
    }

    function formatStatsTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return '0'
      const scaled = (amount) => amount >= 100 ? String(Math.round(amount)) : String(Math.round(amount * 10) / 10)
      if (n < 1e3) return String(Math.round(n))
      if (n < 1e6) return `${scaled(n / 1e3)}K`
      return `${scaled(n / 1e6)}M`
    }

    function formatStatsDuration(value) {
      const ms = Number(value)
      if (!Number.isFinite(ms) || ms < 0) return '0s'
      const seconds = ms / 1e3
      if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
      const whole = Math.round(seconds)
      return `${Math.floor(whole / 60)}m${whole % 60}s`
    }

    function formatStatsThroughput(value) {
      const tps = Math.max(0, Number(value) || 0)
      return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)
    }

    function buildTavernStatsLine(stats, usage, t) {
      const groups = []
      if (stats && Number(stats.steps) > 0) {
        groups.push(t('stats.counts', { turns: stats.turns, steps: stats.steps }))
        const durations = []
        if (Number(stats.llmMs) > 0) durations.push(t('stats.llm', { duration: formatStatsDuration(stats.llmMs) }))
        if (Number(stats.toolMs) > 0) durations.push(t('stats.toolCall', { duration: formatStatsDuration(stats.toolMs) }))
        if (durations.length > 0) groups.push(durations.join(' · '))
        const speeds = []
        if (Number(stats.ttftSteps) > 0) speeds.push(t('stats.ttftAverage', { duration: formatStatsDuration(Number(stats.ttftMs) / Number(stats.ttftSteps)) }))
        if (Number(stats.decodeMs) > 0) speeds.push(t('stats.tokensPerSecond', { throughput: formatStatsThroughput(Number(stats.decodeTokens) / (Number(stats.decodeMs) / 1e3)) }))
        if (speeds.length > 0) groups.push(speeds.join(' · '))
      }
      if (usage && (Number(usage.uncachedInputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens) > 0 || Number(usage.outputTokens) > 0)) {
        const input = Number(usage.uncachedInputTokens) + Number(usage.cacheReadTokens) + Number(usage.cacheWriteTokens)
        if (input > 0) {
          const cacheHit = Math.round(Number(usage.cacheReadTokens) / input * 100)
          groups.push(t('stats.cacheHit', { percent: cacheHit }))
        }
        groups.push(t('stats.tokens', { input: formatStatsTokens(input), output: formatStatsTokens(usage.outputTokens) }))
      }
      return groups.join(' | ')
    }

    // The native agent-preset entry has no session filter prop. Resolve its
    // CSS-module class from the host marker, then hide only that sibling.
    const AGENT_PRESET_LABEL_STYLE = '@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetLabel.module.css'

    function nativeAgentPresetLabelClass() {
      const style = document.querySelector(`style[data-plugin-css="${AGENT_PRESET_LABEL_STYLE}"]`)
      return /\.([_a-zA-Z][\w-]*_label)\s*\{/.exec(style?.textContent || '')?.[1] || null
    }

    function nativeAgentPresetLabel(marker) {
      const parent = marker?.parentElement
      if (!parent) return null
      const siblings = [...parent.children]
      const markerIndex = siblings.indexOf(marker)
      if (markerIndex <= 0) return null
      const labelClass = nativeAgentPresetLabelClass()
      if (labelClass) {
        return siblings.slice(0, markerIndex).reverse()
          .find((element) => element.classList?.contains(labelClass)) || null
      }
      const previous = marker.previousElementSibling
      return previous?.tagName === 'SPAN'
        && [...(previous.classList || [])].some((name) => name.endsWith('_label'))
        && previous.querySelector?.('svg')
        ? previous
        : null
    }

    function hideNativeAgentPresetLabel(label) {
      if (!label || label.dataset?.dshTavernAgentPresetHidden !== undefined) return
      label.dataset.dshTavernAgentPresetHidden = ''
      label.dataset.dshTavernAgentPresetHiddenAria = label.getAttribute?.('aria-hidden') ?? ''
      label.dataset.dshTavernAgentPresetHiddenState = label.hidden ? 'hidden' : 'visible'
      label.setAttribute?.('aria-hidden', 'true')
      label.hidden = true
    }

    function restoreNativeAgentPresetLabel(label) {
      if (!label || label.dataset?.dshTavernAgentPresetHidden === undefined) return
      const aria = label.dataset.dshTavernAgentPresetHiddenAria || ''
      if (aria) label.setAttribute('aria-hidden', aria)
      else label.removeAttribute?.('aria-hidden')
      label.hidden = label.dataset.dshTavernAgentPresetHiddenState === 'hidden'
      delete label.dataset.dshTavernAgentPresetHidden
      delete label.dataset.dshTavernAgentPresetHiddenAria
      delete label.dataset.dshTavernAgentPresetHiddenState
    }

    function useNativeAgentPresetLabelFilter(active) {
      const markerRef = useRef(null)
      useLayoutEffect(() => {
        if (!active) return undefined
        const marked = new Set()
        let frame = 0
        const apply = () => {
          frame = 0
          const label = nativeAgentPresetLabel(markerRef.current)
          for (const previous of [...marked]) {
            if (previous === label) continue
            restoreNativeAgentPresetLabel(previous)
            marked.delete(previous)
          }
          if (!label) return
          hideNativeAgentPresetLabel(label)
          marked.add(label)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        const parent = markerRef.current?.parentElement
        const observer = parent && typeof MutationObserver !== 'undefined'
          ? new MutationObserver(schedule)
          : null
        observer?.observe(parent, { childList: true })
        return () => {
          observer?.disconnect()
          if (frame) cancelAnimationFrame(frame)
          for (const label of marked) restoreNativeAgentPresetLabel(label)
        }
      }, [active])
      return markerRef
    }

    function TavernHeaderAction({ sessionId, useSession, useProjection }) {
      const state = useTavernStore()
      const t = useTranslate()
      const usage = useProjection ? useProjection('tokenUsage') : undefined
      const binding = state.bootstrap.state.sessionBindings?.[sessionId]
      const architecture = bindingArchitecture(binding)
      const novelId = binding?.architecture === 'agent-novel' && typeof binding.novelId === 'string' ? binding.novelId : null
      const active = useSession((session) => architecture === 'agent-tavern' || isTavernSession(session) !== null || novelId !== null)
      const stats = useProjection ? useProjection('sessionStats') : undefined
      const run = state.runs[sessionId] || {}
      const markerRef = useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === 'st'))
      // Novel sessions surface the project status here; the server stays the
      // authority, so the buttons only present the latest known state.
      const [novelSummary, setNovelSummary] = useState(null)
      useEffect(() => {
        if (novelId === null) {
          setNovelSummary(null)
          return undefined
        }
        let cancelled = false
        const load = () => {
          void fetchNovelDetail(novelId)
            .then((next) => { if (!cancelled) setNovelSummary(next) })
            .catch(() => {})
        }
        load()
        const timer = setInterval(load, 10000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [novelId])
      // 带意见重写（提案 0011）：意见可空 = 直接重写；提交走既有 regenerate
      // 发送路径携带 feedback 字段。弹出层模式对齐 ModelSelect（绝对定位 +
      // 点外关闭），锚定 header 故向下展开。
      const [rewriteOpen, setRewriteOpen] = useState(false)
      const [rewriteDraft, setRewriteDraft] = useState('')
      const rewriteRef = useRef(null)
      useEffect(() => {
        if (!rewriteOpen) return undefined
        const closeOutside = (event) => {
          if (!rewriteRef.current?.contains(event.target)) setRewriteOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [rewriteOpen])
      // MVU 面板的标题栏挂载（AgentTavern 会话没有 TavernView）：宿主带原生
      // 右侧栏（≥0.2.0-rc.2）时优先把面板作为侧栏 tab 打开（openTab 会自动展
      // 开右栏）；旧宿主或 openTab 抛错（无在屏会话）时回退弹出层模式——绝对
      // 定位 + 点外关闭，锚定 header 向下展开，与带意见重写一致。
      const [mvuOpen, setMvuOpen] = useState(false)
      const mvuRef = useRef(null)
      useEffect(() => {
        if (!mvuOpen) return undefined
        const closeOutside = (event) => {
          if (!mvuRef.current?.contains(event.target)) setMvuOpen(false)
        }
        document.addEventListener('mousedown', closeOutside)
        return () => document.removeEventListener('mousedown', closeOutside)
      }, [mvuOpen])
      const openMvuSurface = () => {
        const sidebarRight = PanelHost.context?.get?.('sidebarRight')
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          try {
            sidebarRight.openTab(MVU_TAB_KIND)
            return
          } catch {
            // 无在屏会话或 store 未铸：落回弹出层
          }
        }
        setMvuOpen(!mvuOpen)
      }
      if (!active || !binding) return null
      if (novelId !== null) {
        const novel = novelSummary || { title: novelId, status: 'active' }
        const novelStatus = novelStatusId(novel)
        const runNovelHeader = (action) => {
          if (action === 'stop' && !window.confirm(t('novel.stopConfirm', { name: novel.title || novelId }))) return
          void runNovelAction(novelId, action)
            .catch(() => {})
            .finally(() => {
              void fetchNovelDetail(novelId).then((next) => setNovelSummary(next)).catch(() => {})
            })
        }
        return h('div', { className: 'dt-header-character dt-header-novel', 'data-dsh-tavern-surface': 'header' },
          h('div', { className: 'dt-header-character-copy' },
            h('span', { className: 'dt-header-character-name', title: novel.title || novelId }, novel.title || novelId),
            h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatus}` },
              novelStatusLabel(t, novel),
              novel.status === 'paused' && novel.pauseReason ? ` · ${novelPauseReasonLabel(t, novel.pauseReason)}` : '')),
          h('div', { className: 'dt-header-novel-actions' },
            novelStatus === 'active' ? h('button', { type: 'button', title: t('novel.pause'), onClick: () => runNovelHeader('pause') }, t('novel.pause')) : null,
            novelStatus === 'paused' ? h('button', { type: 'button', title: t('novel.resume'), onClick: () => runNovelHeader('resume') }, t('novel.resume')) : null,
            novelStatus === 'active' ? h('button', {
              type: 'button',
              title: t('novel.stop'),
              'aria-label': t('novel.stop'),
              onClick: () => runNovelHeader('stop'),
            }, h(IconStopFill16)) : null,
            h('button', {
              type: 'button',
              title: t('novel.openPanel'),
              'aria-label': t('novel.openPanel'),
              onClick: () => openPanel('novels'),
            }, h(IconListPenOutline16))))
      }
      const statsLine = architecture === 'st' ? buildTavernStatsLine(stats, usage, t) : ''
      const submitRewrite = () => {
        if (run.busy) return
        const feedback = rewriteDraft
        setRewriteOpen(false)
        void generateFor(sessionId, binding, 'regenerate', '', { feedback })
      }
      return h('div', { ref: markerRef, className: 'dt-header-character', 'data-dsh-tavern-surface': 'header' },
        h('img', { src: `${API}/avatar/${encodeURIComponent(binding.character)}`, alt: '' }),
        h('div', { className: 'dt-header-character-copy' },
          h('span', { className: 'dt-header-character-name' }, binding.character),
          h('span', { className: `dt-architecture-badge dt-architecture-${architecture}` }, architectureLabel(architecture)),
          statsLine ? h('span', { className: 'dt-header-stats', title: statsLine }, statsLine) : null),
        h('div', { className: 'dt-header-actions' },
          architecture === 'st'
            ? h(React.Fragment, null,
              h('button', {
                type: 'button',
                title: t('view.regenerate'),
                'aria-label': t('view.regenerate'),
                disabled: run.busy,
                onClick: () => void generateFor(sessionId, binding, 'regenerate', ''),
              }, h(IconRefreshOutline16)),
              h('span', { className: 'dt-rewrite', ref: rewriteRef },
                h('button', {
                  type: 'button',
                  title: t('view.rewrite'),
                  'aria-label': t('view.rewrite'),
                  'aria-expanded': rewriteOpen,
                  disabled: run.busy,
                  onClick: () => { setRewriteDraft(''); setRewriteOpen(!rewriteOpen) },
                }, h(IconEditOutline16)),
                rewriteOpen ? h('div', { className: 'dt-rewrite-pop' },
                  h('textarea', {
                    value: rewriteDraft,
                    placeholder: t('view.rewriteFeedbackPlaceholder'),
                    rows: 3,
                    autoFocus: true,
                    onChange: (event) => setRewriteDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                        event.preventDefault()
                        submitRewrite()
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setRewriteOpen(false)
                      }
                    },
                  }),
                  h('div', { className: 'dt-rewrite-actions' },
                    h('button', { type: 'button', onClick: () => setRewriteOpen(false) }, t('message.cancel')),
                    h('button', { type: 'button', className: 'dt-rewrite-go', disabled: run.busy, onClick: submitRewrite }, t('view.rewriteSubmit')))) : null))
            : h(React.Fragment, null,
              h('button', {
                type: 'button',
                title: t('view.forkArchitecture', { architecture: architectureLabel('st') }),
                disabled: run.busy,
                onClick: () => void forkTavernArchitecture(PanelHost.context, sessionId, binding),
              }, h(IconAgentPresetOutline16)),
              // AgentTavern 的 native conversation 由宿主渲染，插件正文区没有
              // 可插入的 slot：MVU 面板入口挂标题栏——右侧栏可用时开侧栏 tab
              // （ST 走 TavernView 内联面板，两架构都能从右栏 guide 进入）
              h('span', { className: 'dt-mvu-slot', ref: mvuRef },
                h('button', {
                  type: 'button',
                  title: t('mvu.title'),
                  'aria-label': t('mvu.title'),
                  'aria-expanded': mvuOpen,
                  onClick: openMvuSurface,
                }, h(IconDataOutline16)),
                mvuOpen ? h('div', { className: 'dt-mvu-pop' }, h(TavernMvuStatus, { sessionId, embedded: true })) : null)),
          h('button', {
            type: 'button',
            title: t('view.openGuides'),
            'aria-label': t('view.openGuides'),
            onClick: () => openPanel('guides'),
          }, h(IconListPenOutline16))))
    }

    function nativeTavernTabs() {
      const titles = [MESSAGES_EN['nav.title'], MESSAGES_ZH['nav.title']]
      return [...document.querySelectorAll('[role="tab"]')]
        .filter((item) => titles.includes(item.textContent?.trim() || ''))
    }

    function restoreNativeTavernTabs() {
      for (const tab of nativeTavernTabs()) {
        if (tab.dataset?.dshTavernTabHidden === undefined) continue
        const aria = tab.dataset.dshTavernTabHiddenAria || ''
        if (aria) tab.setAttribute('aria-hidden', aria)
        else tab.removeAttribute?.('aria-hidden')
        tab.hidden = tab.dataset.dshTavernTabHiddenState === 'hidden'
        delete tab.dataset.dshTavernTabHidden
        delete tab.dataset.dshTavernTabHiddenAria
        delete tab.dataset.dshTavernTabHiddenState
      }
    }

    function filterNativeTavernTab(show) {
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      const tavernTabs = nativeTavernTabs()
      if (show) {
        restoreNativeTavernTabs()
        return
      }
      for (const tab of tavernTabs) {
        if (tab.getAttribute('aria-selected') === 'true') {
          const fallback = tabs.find((item) => item !== tab && !nativeTavernTabs().includes(item))
          if (fallback instanceof HTMLElement) fallback.click()
        }
        if (tab.dataset?.dshTavernTabHidden !== undefined) continue
        tab.dataset.dshTavernTabHidden = ''
        tab.dataset.dshTavernTabHiddenAria = tab.getAttribute?.('aria-hidden') ?? ''
        tab.dataset.dshTavernTabHiddenState = tab.hidden ? 'hidden' : 'visible'
        tab.setAttribute?.('aria-hidden', 'true')
        tab.hidden = true
      }
    }

    function useNativeTavernTabFilter(show) {
      useEffect(() => {
        let frame = 0
        const apply = () => {
          frame = 0
          filterNativeTavernTab(show)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-hidden'] })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          restoreNativeTavernTabs()
        }
      }, [show])
    }

    // 侧边栏会话树的 DOM 注入：宿主未提供会话列表扩展 slot，按几何特征定位
    // DSH 会话树并在其上方插入宿主 div（与面板聊天分区共存：这里管快速切换）。
    function visibleSidebarTree() {
      const candidates = [...document.querySelectorAll('[role="tree"]')]
      const found = candidates.find((tree) => {
        if (tree.closest('[data-dsh-tavern-sidebar-host]')) return false
        const rect = tree.getBoundingClientRect()
        if (tree.dataset?.dshTavernNativeTree !== undefined) {
          return rect.width > 0 && rect.left < Math.min(420, window.innerWidth * 0.4)
        }
        return rect.width > 40 && rect.height > 20 && rect.left < Math.min(420, window.innerWidth * 0.4)
      }) || null
      if (found) found.dataset.dshTavernNativeTree = ''
      return found
    }

    // Tavern sessions remain real DSH sessions so the native conversation
    // surface can render them, but they are owned by the Tavern navigator. The
    // host has no session-tree slot, so hide only bound rows at the DOM edge.
    // This adapter is deliberately reversible: unbinding a chat restores the
    // row, while ordinary DSH sessions are never marked.
    function nativeSessionReference(value, sessionIds) {
      if (value === null || value === undefined) return false
      let text = String(value)
      try { text = decodeURIComponent(text) } catch {}
      if (sessionIds.has(text)) return true
      const parts = text.split(/[\\/?#=:]+/).filter(Boolean)
      return parts.some((part) => sessionIds.has(part))
    }

    function nativeTreeRow(node, tree) {
      let current = node
      while (current && current !== tree) {
        const role = current.getAttribute?.('role')
        if (role === 'treeitem' || role === 'option' || current.tagName === 'LI') return current
        current = current.parentElement
      }
      return node === tree ? null : node
    }

    function normalizeWorkspacePath(value) {
      if (typeof value !== 'string') return ''
      let path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (/^[a-z]:\//i.test(path)) path = path.toLowerCase()
      return path
    }

    // 插件内部工作区（Tavern / Tavern Workbench）都要整组隐藏：会话由自绘
    // 侧边栏导航，原生树只留普通用户工作区。身份依据是路径；显示名只在
    // 全局唯一时作回退（决策 2026-08-17）。
    function pluginWorkspaceSnapshots(ctx) {
      const items = ctx?.workspaces?.list?.getSnapshot?.().items || []
      const snapshots = []
      for (const config of [snapshot.bootstrap.internalWorkspace, snapshot.bootstrap.workbenchWorkspace]) {
        const expectedPath = normalizeWorkspacePath(config?.path)
        if (!expectedPath) continue
        const workspace = items.find((item) => normalizeWorkspacePath(item?.path) === expectedPath)
        if (!workspace?.workspaceId) continue
        const titleFallback = typeof workspace.title === 'string'
          && items.filter((item) => item?.title === workspace.title).length === 1
          ? workspace.title
          : ''
        snapshots.push({ workspace, titleFallback })
      }
      return snapshots
    }

    function nativeWorkspaceReference(value, workspace) {
      if (value === null || value === undefined) return false
      let text = String(value)
      try { text = decodeURIComponent(text) } catch {}
      if (text === workspace.workspaceId) return true
      if (normalizeWorkspacePath(text) === normalizeWorkspacePath(workspace.path)) return true
      return text.split(/[\\/?#=:]+/).filter(Boolean).some((part) => part === workspace.workspaceId)
    }

    function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback) {
      const values = []
      const collect = (element) => {
        if (!element?.getAttributeNames) return
        for (const name of element.getAttributeNames()) {
          if (name === 'id' || name === 'href' || name === 'data-key' || name === 'data-id'
            || name === 'data-item-id' || name === 'data-value' || name === 'data-path'
            || name === 'data-workspace' || name === 'data-workspace-id'
            || name.includes('workspace')) {
            values.push(element.getAttribute(name))
          }
        }
      }
      collect(node)
      for (const child of node.querySelectorAll?.('*') || []) collect(child)
      if (values.some((value) => nativeWorkspaceReference(value, workspace))) return true
      // rc.6 does not expose workspace identity in the DOM. A title fallback is
      // safe only when that title belongs to exactly one registered workspace.
      const text = node.textContent?.replace(/\s+/g, ' ').trim()
      return Boolean(titleFallback && text === titleFallback)
    }

    function nativeTreeWorkspaceGroup(row, tree) {
      let current = row
      while (current?.parentElement && current.parentElement !== tree) current = current.parentElement
      return current?.parentElement === tree ? current : row
    }

    function nativeTreeNodeMatches(node, sessionIds, labels) {
      const values = []
      const collect = (element) => {
        if (!element?.getAttributeNames) return
        for (const name of element.getAttributeNames()) {
          if (name === 'id' || name === 'href' || name === 'title' || name === 'aria-label'
            || name === 'aria-controls' || name === 'data-key' || name === 'data-id'
            || name === 'data-item-id' || name === 'data-value' || name === 'data-session'
            || name === 'data-session-id'
            || name.includes('session')) {
            values.push(element.getAttribute(name))
          }
        }
      }
      collect(node)
      for (const child of node.querySelectorAll?.('*') || []) {
        const nestedRow = child.closest?.('[role="treeitem"], [role="option"], li')
        if (nestedRow && nestedRow !== node) continue
        collect(child)
      }
      if (values.some((value) => nativeSessionReference(value, sessionIds))) return true
      // Older host builds expose no session id in the DOM. Their tree row text
      // is the renamed session label, which is safe to use only as a fallback.
      if ((node.querySelectorAll?.('[role="treeitem"], [role="option"], li') || []).length > 0) return false
      const text = node.textContent?.replace(/\s+/g, ' ').trim()
      return Boolean(text && [...labels].some((label) => text === label || text.startsWith(`${label} `)))
    }

    function markNativeTreeRow(row, kind = 'session') {
      if (!row || row.dataset?.dshTavernNativeHidden !== undefined) return
      row.dataset.dshTavernNativeHidden = ''
      row.dataset.dshTavernNativeHiddenKind = kind
      row.dataset.dshTavernNativeHiddenAria = row.getAttribute?.('aria-hidden') ?? ''
      row.dataset.dshTavernNativeHiddenState = row.hidden ? 'hidden' : 'visible'
      row.setAttribute?.('aria-hidden', 'true')
      row.hidden = true
    }

    function unmarkNativeTreeRows(tree) {
      for (const row of tree.querySelectorAll?.('[data-dsh-tavern-native-hidden]') || []) {
        const aria = row.dataset?.dshTavernNativeHiddenAria || ''
        const state = row.dataset?.dshTavernNativeHiddenState
        if (aria) row.setAttribute('aria-hidden', aria)
        else row.removeAttribute?.('aria-hidden')
        row.hidden = state === 'hidden'
        delete row.dataset.dshTavernNativeHidden
        delete row.dataset.dshTavernNativeHiddenKind
        delete row.dataset.dshTavernNativeHiddenAria
        delete row.dataset.dshTavernNativeHiddenState
      }
    }

    function filterNativeSessionTree(tree, bindings, ctx) {
      if (!tree) return
      const sessionIds = new Set(Object.keys(bindings || {}))
      unmarkNativeTreeRows(tree)
      for (const internal of pluginWorkspaceSnapshots(ctx)) {
        const headers = [...tree.querySelectorAll?.('[role="treeitem"][aria-expanded]') || []]
        for (const header of headers) {
          if (!nativeTreeNodeMatchesWorkspace(header, internal.workspace, internal.titleFallback)) continue
          markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')
        }
      }
      if (sessionIds.size === 0) return
      const labels = new Set(Object.entries(bindings)
        .filter(([, binding]) => typeof binding?.character === 'string' && typeof binding?.chatId === 'string')
        .map(([, binding]) => sessionLabel(binding.character, binding.chatId, binding.group === true, bindingArchitecture(binding))))
      const candidates = [...tree.querySelectorAll?.('[role="treeitem"], [role="option"], li, [data-session-id], [data-session], [data-item-id]') || []]
      const rows = new Set()
      for (const candidate of candidates) {
        const row = nativeTreeRow(candidate, tree)
        if (row && nativeTreeNodeMatches(row, sessionIds, labels)) rows.add(row)
      }
      for (const row of rows) {
        if (row.parentElement?.closest?.('[data-dsh-tavern-native-hidden]')) continue
        markNativeTreeRow(row)
      }
    }

    function useNativeSessionTreeFilter(bindingIds, ctx, internalWorkspacePaths) {
      const bindingKey = bindingIds.join('\u0000')
      useEffect(() => {
        let frame = 0
        let observer
        const apply = () => {
          frame = 0
          filterNativeSessionTree(visibleSidebarTree(), snapshot.bootstrap.state.sessionBindings, ctx)
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(apply)
        }
        apply()
        if (typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver(schedule)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['id', 'href', 'title', 'aria-label', 'aria-controls', 'data-key', 'data-id', 'data-item-id', 'data-value', 'data-path', 'data-workspace', 'data-workspace-id', 'data-session', 'data-session-id'],
          })
        }
        window.addEventListener('resize', schedule)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          const tree = visibleSidebarTree()
          if (tree) unmarkNativeTreeRows(tree)
        }
      }, [bindingKey, ctx, internalWorkspacePaths])
    }

    function useSidebarHost() {
      const [host, setHost] = useState(null)
      useEffect(() => {
        let frame = 0
        let current = null
        const attach = () => {
          frame = 0
          const tree = visibleSidebarTree()
          if (!tree?.parentElement) {
            if (current?.isConnected) current.remove()
            current = null
            setHost(null)
            return
          }
          if (!current || !current.isConnected || current.parentElement !== tree.parentElement) {
            current?.remove()
            current = document.createElement('div')
            current.dataset.dshTavernSidebarHost = ''
            tree.parentElement.insertBefore(current, tree)
            setHost(current)
          }
        }
        const schedule = () => {
          if (!frame) frame = requestAnimationFrame(attach)
        }
        attach()
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        window.addEventListener('resize', schedule)
        return () => {
          observer.disconnect()
          window.removeEventListener('resize', schedule)
          if (frame) cancelAnimationFrame(frame)
          current?.remove()
        }
      }, [])
      return host
    }

    function ChatList({ ctx, character, currentSession, group = false }) {
      const state = useTavernStore()
      const t = useTranslate()
      const chats = state.chatLists[character]
      const [error, setError] = useState('')
      const [busyChat, setBusyChat] = useState('')
      useEffect(() => { void loadChatList(character).catch((cause) => setError(sidebarErrorDetail(cause))) }, [character])
      const activeBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const open = (chatId) => {
        setError('')
        void openTavernChat(ctx, character, chatId, group).catch((cause) => {
          update({ navigationStatus: '' })
          setError(sidebarErrorDetail(cause))
        })
      }
      const runAction = (chatId, action) => {
        setError('')
        setBusyChat(chatId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusyChat(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        chats?.map((chatId) => {
          const labels = chatArchitectureLabels(character, chatId, group)
          return h('div', {
            key: chatId,
            className: `dt-sidebar-chat-row ${activeBinding?.character === character && activeBinding.chatId === chatId ? 'dt-sidebar-chat-active' : ''}`,
          },
          h('button', {
            type: 'button',
            className: 'dt-sidebar-chat-open',
            title: chatId,
            disabled: busyChat === chatId,
            onClick: () => open(chatId),
          }, h('span', null, / - branch \d+$/.test(chatId.replace(/\.jsonl$/i, '')) ? '⑂ ' : '', chatId.replace(/\.jsonl$/i, '')),
          h('span', { className: 'dt-chat-architecture' }, labels.join(' / '))),
          h('button', {
            type: 'button',
            title: t('nav.workbenchChat'),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => openWorkbenchSession(ctx, { character, chatId })),
          }, h(IconSparkle16)),
          h('button', {
            type: 'button',
            title: t('nav.rename', { name: chatId.replace(/\.jsonl$/i, '') }),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => renameTavernChat(ctx, character, chatId)),
          }, h(IconEditOutline16)),
          h('button', {
            type: 'button',
            title: t('nav.delete', { name: chatId.replace(/\.jsonl$/i, '') }),
            disabled: busyChat === chatId,
            onClick: () => runAction(chatId, () => deleteTavernChat(ctx, character, chatId)),
          }, h(IconTrashOutline16)))
        }),
        !chats ? h('span', { className: 'dt-sidebar-status' }, t('nav.loading')) : null,
        chats?.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noChats')) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    // 写卡工作台会话列表（侧边栏分组）：每个来源聊天一个工作会话，自由工作台
    // 也在此列出；点击切回主视图，与 TavernSidebar 其余分组共用 dt-sidebar-* 样式。
    // 改名/删除对齐 ChatList 的行内按钮（提案 0013 之后的能力补齐）：标签优先
    // 级 title（用户显式改名）> createdCard（出卡改名）> 来源聊天 > 自由序号。
    function WorkbenchList({ ctx, useSessions, currentSession }) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionIds = useSessions((value) => value.ids)
      const [error, setError] = useState('')
      const [busySession, setBusySession] = useState('')
      const entries = Object.entries(state.bootstrap.state.sessionBindings || {})
        .filter(([sessionId, binding]) => binding?.architecture === 'card-workbench' && sessionIds.includes(sessionId))
      // 多自由工作台并存时同名条目按枚举序号区分（第 2 个起带号，与创建时
      // 宿主标题的计数序号同族；删会话后序号重排仅为显示层变化）。
      const freeTotal = entries.filter(([, binding]) => !binding.sourceCharacter && !binding.sourceChatId).length
      let freeOrdinal = 0
      const labels = entries.map(([, binding]) => {
        // 用户显式改的名压过一切派生标签（服务端出卡改名同样让位）。
        if (binding.title) return binding.title
        // 出卡后会话改名为卡名（提案 0013 补充）：createdCard 优先于来源
        // 聊天/自由工作台标签，与服务端 sessionTitle.rename 固定的宿主标题一致。
        if (binding.createdCard) return binding.createdCard
        if (binding.sourceCharacter) return `${binding.sourceCharacter} · ${String(binding.sourceChatId).replace(/\.jsonl$/i, '')}`
        freeOrdinal += 1
        return freeTotal > 1 && freeOrdinal > 1 ? `${t('nav.workbenchFree')} ${freeOrdinal}` : t('nav.workbenchFree')
      })
      const runAction = (sessionId, action) => {
        setError('')
        setBusySession(sessionId)
        void action().catch((cause) => setError(cause.message)).finally(() => setBusySession(''))
      }
      return h('div', { className: 'dt-sidebar-chats' },
        entries.map(([sessionId, binding], index) => {
          const label = labels[index]
          return h('div', {
            key: sessionId,
            className: `dt-sidebar-chat-row ${currentSession === sessionId ? 'dt-sidebar-chat-active' : ''}`,
          },
          h('button', {
            type: 'button',
            className: 'dt-sidebar-chat-open',
            title: label,
            disabled: busySession === sessionId,
            onClick: () => {
              reserveTavernSession(ctx, sessionId)
              openSessionView(ctx, sessionId)
            },
          }, h('span', null, '✎ ', label)),
          h('button', {
            type: 'button',
            title: t('nav.rename', { name: label }),
            disabled: busySession === sessionId,
            onClick: () => runAction(sessionId, () => renameWorkbenchSession(ctx, sessionId, label)),
          }, h(IconEditOutline16)),
          h('button', {
            type: 'button',
            title: t('nav.delete', { name: label }),
            disabled: busySession === sessionId,
            onClick: () => {
              if (window.confirm(t('workbench.deleteConfirm', { name: label }))) {
                runAction(sessionId, () => deleteWorkbenchSession(ctx, sessionId))
              }
            },
          }, h(IconTrashOutline16)))
        }),
        entries.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noWorkbench')) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    function TavernSidebar({ ctx, useSessions, floating, onClose }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useCurrentSessionId(useSessions)
      const [expanded, setExpanded] = useState(state.bootstrap.state.activeCharacter || state.bootstrap.characters[0] || '')
      const [expandedGroup, setExpandedGroup] = useState('')
      const [error, setError] = useState('')
      const groups = state.bootstrap.groups || []
      return h('section', { className: `dt-sidebar ${floating ? 'dt-sidebar-floating' : ''}`, 'aria-label': t('nav.chats') },
        h('div', { className: 'dt-sidebar-heading' },
          h('span', null, h(IconUserOutline16), h('strong', null, t('nav.title'))),
          floating ? h('button', { type: 'button', title: t('nav.close'), onClick: onClose }, '×') : null),
        state.bootstrap.characters.map((character) => {
          const open = expanded === character
          return h('div', { key: character, className: 'dt-character-group' },
            h('div', { className: 'dt-character-row' },
              h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpanded(open ? '' : character) },
                h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                h('img', { src: `${API}/avatar/${encodeURIComponent(character)}`, alt: '' }),
                h('span', null, character)),
              h('button', {
                type: 'button',
                title: t('nav.newChat', { name: character }),
                onClick: () => {
                  setError('')
                  void createTavernChat(ctx, character).catch((cause) => {
                    update({ navigationStatus: '' })
                    setError(sidebarErrorDetail(cause))
                  })
                },
              }, h(IconPlusOutline16))),
            open ? h(ChatList, { ctx, character, currentSession }) : null)
        }),
        state.bootstrap.characters.length === 0 ? h('span', { className: 'dt-sidebar-status' }, t('nav.noCharacters')) : null,
        groups.length > 0 ? h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },
          h('span', null, '☰ ', h('strong', null, t('nav.groups')))) : null,
        groups.map((group) => {
          const open = expandedGroup === group.name
          return h('div', { key: group.name, className: 'dt-character-group' },
            h('div', { className: 'dt-character-row' },
              h('button', { type: 'button', className: 'dt-character-toggle', 'aria-expanded': open, onClick: () => setExpandedGroup(open ? '' : group.name) },
                h(IconChevronDownOutline14, { className: open ? 'dt-chevron-open' : '' }),
                h('img', { src: `${API}/avatar/${encodeURIComponent(group.name)}`, alt: '' }),
                h('span', null, `☰ ${group.name}`)),
              h('button', {
                type: 'button',
                title: t('nav.newGroupChat', { name: group.name }),
                onClick: () => {
                  setError('')
                  void createTavernChat(ctx, group.name, true).catch((cause) => {
                    update({ navigationStatus: '' })
                    setError(sidebarErrorDetail(cause))
                  })
                },
              }, h(IconPlusOutline16))),
            open ? h(ChatList, { ctx, character: group.name, currentSession, group: true }) : null)
        }),
        h('div', { className: 'dt-sidebar-heading dt-sidebar-subheading' },
          h('span', null, '✎ ', h('strong', null, t('nav.workbench'))),
          h('button', {
            type: 'button',
            title: t('nav.workbenchNew'),
            onClick: () => {
              setError('')
              void openWorkbenchSession(ctx, null, { fresh: true }).catch((cause) => {
                update({ navigationStatus: '' })
                setError(sidebarErrorDetail(cause))
              })
            },
          }, h(IconPlusOutline16))),
        h(WorkbenchList, { ctx, useSessions, currentSession }),
        state.navigationStatus ? h('span', { className: 'dt-sidebar-status' }, state.navigationStatus) : null,
        error ? h('span', { className: 'dt-sidebar-error' }, error) : null)
    }

    const PANEL_SECTIONS = [
      { id: 'overview', icon: IconSparkle16 },
      { id: 'characters', icon: IconUserOutline16 },
      { id: 'chats', icon: IconQueueOutline14 },
      { id: 'guides', icon: IconListPenOutline16 },
      { id: 'novels', icon: IconListPenOutline16 },
      { id: 'groups', icon: IconPersonalizationOutline16 },
      { id: 'personas', icon: IconDataOutline16 },
      { id: 'worlds', icon: IconBrowseOutline16 },
      { id: 'presets', icon: IconAgentPresetOutline16 },
      { id: 'scripts', icon: IconListPenOutline16 },
      { id: 'regex', icon: IconListPenOutline16 },
      { id: 'variables', icon: IconCordisPluginOutline14 },
      { id: 'workbench', icon: IconListPenOutline16 },
    ]

    function PanelOverview() {
      const state = useTavernStore()
      const t = useTranslate()
      const bootstrap = state.bootstrap
      const characterKey = bootstrap.characters.join('\u0000')
      const groupKey = (bootstrap.groups || []).map((group) => group.name).join('\u0000')
      useEffect(() => {
        for (const character of bootstrap.characters) void loadChatList(character).catch(() => {})
        for (const group of bootstrap.groups || []) void loadChatList(group.name).catch(() => {})
      }, [characterKey, groupKey])
      const chatsTotal = Object.keys(state.chatLists)
        .reduce((sum, character) => sum + (state.chatLists[character]?.length || 0), 0)
      return h(React.Fragment, null,
        h(ActiveSetupBand),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.title')),
          h('p', { className: 'dt-hint' }, t('panel.overview.counts', {
            characters: bootstrap.characters.length,
            chats: chatsTotal,
            worlds: bootstrap.worlds.length,
            presets: bootstrap.presets.length,
            personas: bootstrap.personas.length,
            groups: (bootstrap.groups || []).length,
          }))),
        h(UpdateBand, { compact: false }),
        state.error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, state.error)) : null)
    }

    function cloneValue(value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value))
    }

    function EditorField({ label, value, onChange, multiline = false, type = 'text', min, max, step, className = '', hint, placeholder, disabled }) {
      const props = {
        value: value ?? '',
        type,
        min,
        max,
        step,
        placeholder,
        onChange: (event) => onChange(event.target.value),
        ...(disabled === true ? { disabled: true } : {}),
      }
      return h('label', { className: `dt-editor-field ${className}` },
        h('span', { className: 'dt-label' }, label),
        multiline ? h('textarea', { ...props, type: undefined }) : h('input', props),
        hint ? h('span', { className: 'dt-hint' }, hint) : null)
    }

    function CardEditor({ card, name, onSave, onCancel, hint }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(card))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const [advanced, setAdvanced] = useState(() => JSON.stringify({ extensions: card?.data?.extensions || {}, characterBook: card?.data?.characterBook, assets: card?.data?.assets, source: card?.data?.source, groupOnlyGreetings: card?.data?.groupOnlyGreetings, creatorNotesMultilingual: card?.data?.creatorNotesMultilingual, characterVersion: card?.data?.characterVersion, creationDate: card?.data?.creationDate, modificationDate: card?.data?.modificationDate }, null, 2))
      const data = draft?.data || {}
      const advancedBaseline = JSON.stringify({ extensions: card?.data?.extensions || {}, characterBook: card?.data?.characterBook, assets: card?.data?.assets, source: card?.data?.source, groupOnlyGreetings: card?.data?.groupOnlyGreetings, creatorNotesMultilingual: card?.data?.creatorNotesMultilingual, characterVersion: card?.data?.characterVersion, creationDate: card?.data?.creationDate, modificationDate: card?.data?.modificationDate }, null, 2)
      const dirty = JSON.stringify(draft) !== JSON.stringify(card) || advanced !== advancedBaseline
      useEffect(() => {
        if (draft === null && card) {
          setDraft(cloneValue(card))
          setAdvanced(JSON.stringify({ extensions: card.data?.extensions || {}, characterBook: card.data?.characterBook, assets: card.data?.assets, source: card.data?.source, groupOnlyGreetings: card.data?.groupOnlyGreetings, creatorNotesMultilingual: card.data?.creatorNotesMultilingual, characterVersion: card.data?.characterVersion, creationDate: card.data?.creationDate, modificationDate: card.data?.modificationDate }, null, 2))
        }
      }, [card])
      useEffect(() => {
        if (!dirty) return undefined
        const handleBeforeUnload = (event) => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', handleBeforeUnload)
        return () => window.removeEventListener('beforeunload', handleBeforeUnload)
      }, [dirty])
      const setData = (key, value) => setDraft((current) => ({ ...current, data: { ...(current.data || {}), [key]: value } }))
      const identitySummary = typeof data.extensions?.agentTavern?.identitySummary === 'string'
        ? data.extensions.agentTavern.identitySummary
        : ''
      const setIdentitySummary = (value) => setDraft((current) => ({
        ...current,
        data: {
          ...(current.data || {}),
          extensions: {
            ...(current.data?.extensions || {}),
            agentTavern: { ...((current.data?.extensions || {}).agentTavern || {}), identitySummary: value },
          },
        },
      }))
      const cancel = () => {
        if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel()
      }
      const save = () => {
        let extra
        try { extra = advanced.trim() === '' ? {} : JSON.parse(advanced) } catch { setError('Advanced card data must be valid JSON.'); return }
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) { setError('Advanced card data must be a JSON object.'); return }
        // 专用编辑字段对 identitySummary 有更高优先级；留空且原卡也没有时不动
        // extensions，避免给无关卡片塞进空命名空间。
        const nextData = { ...data, ...extra, name: String(data.name || '').trim() }
        const originalSummary = typeof card?.data?.extensions?.agentTavern?.identitySummary === 'string'
          ? card.data.extensions.agentTavern.identitySummary
          : ''
        if (identitySummary !== '' || originalSummary !== '') {
          nextData.extensions = { ...(nextData.extensions || {}) }
          const agentExtensions = { ...((nextData.extensions || {}).agentTavern || {}) }
          if (identitySummary !== '') agentExtensions.identitySummary = identitySummary
          else delete agentExtensions.identitySummary
          if (Object.keys(agentExtensions).length > 0) nextData.extensions.agentTavern = agentExtensions
          else delete nextData.extensions.agentTavern
        }
        setSaving(true)
        setError('')
        void Promise.resolve(onSave({ ...draft, data: nextData }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      if (!draft) return h('p', { className: 'dt-muted' }, t('nav.loading'))
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !String(data.name || '').trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('p', { className: 'dt-hint' }, hint || t('panel.characters.editHint')),
        h('div', { className: 'dt-editor-grid' },
          h(EditorField, { label: t('panel.rename'), value: data.name, onChange: (value) => setData('name', value) }),
          h(EditorField, { label: t('panel.characters.nickname'), value: data.nickname, onChange: (value) => setData('nickname', value) }),
          h(EditorField, { label: t('panel.characters.creator'), value: data.creator, onChange: (value) => setData('creator', value) }),
          h(EditorField, { label: t('panel.characters.tags'), value: commaList(data.tags), onChange: (value) => setData('tags', parseCommaList(value)) }),
          h(EditorField, { label: t('panel.characters.identitySummary'), value: identitySummary, onChange: setIdentitySummary, multiline: true, className: 'dt-editor-wide', hint: t('panel.characters.identitySummaryHint') }),
          h(EditorField, { label: t('panel.characters.description'), value: data.description, onChange: (value) => setData('description', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.personality'), value: data.personality, onChange: (value) => setData('personality', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.scenario'), value: data.scenario, onChange: (value) => setData('scenario', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.firstMes'), value: data.firstMes, onChange: (value) => setData('firstMes', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.mesExample'), value: data.mesExample, onChange: (value) => setData('mesExample', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.alternateGreetings'), value: (data.alternateGreetings || []).join('\n'), onChange: (value) => setData('alternateGreetings', value.split('\n').map((item) => item.trim()).filter(Boolean)), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.systemPrompt'), value: data.systemPrompt, onChange: (value) => setData('systemPrompt', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.postHistory'), value: data.postHistoryInstructions, onChange: (value) => setData('postHistoryInstructions', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.creatorNotes'), value: data.creatorNotes, onChange: (value) => setData('creatorNotes', value), multiline: true, className: 'dt-editor-wide' }),
          h(EditorField, { label: t('panel.characters.advancedJson'), value: advanced, onChange: setAdvanced, multiline: true, className: 'dt-editor-wide dt-editor-json' })),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function CharacterCardFields({ card }) {
      const t = useTranslate()
      const [expanded, setExpanded] = useState({})
      if (!card) return h('div', { className: 'dt-card-fields' }, h('span', { className: 'dt-muted' }, t('nav.loading')))
      const data = card.data || {}
      const field = (key, label) => {
        const text = typeof data[key] === 'string' ? data[key].trim() : ''
        if (text === '') return null
        return h('div', { key, className: 'dt-card-field' },
          h('button', {
            type: 'button',
            className: 'dt-card-field-head',
            'aria-expanded': expanded[key] === true,
            onClick: () => setExpanded({ ...expanded, [key]: !expanded[key] }),
          },
          h('span', null, label),
          h(IconChevronDownOutline14, { className: expanded[key] ? 'dt-chevron-open' : '' })),
          expanded[key] ? h('div', { className: 'dt-card-copy' }, h(MarkdownText, { text })) : null)
      }
      return h('div', { className: 'dt-card-fields' },
        field('description', t('panel.characters.description')),
        field('personality', t('panel.characters.personality')),
        field('scenario', t('panel.characters.scenario')),
         field('firstMes', t('panel.characters.firstMes')),
         field('mesExample', t('panel.characters.mesExample')),
         field('creatorNotes', t('panel.characters.creatorNotes')))
    }

    // 手动新建的空白卡模板（提案 0013）：字段口径对齐 card_create 工具——
    // spec_version 蛇形是 decode 端（tavern-format card.ts）的读取口径。
    const BLANK_CHARACTER_CARD = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '',
        nickname: '',
        description: '',
        personality: '',
        scenario: '',
        firstMes: '',
        mesExample: '',
        creatorNotes: '',
        systemPrompt: '',
        postHistoryInstructions: '',
        alternateGreetings: [],
        tags: [],
        creator: '',
        characterVersion: '',
        extensions: {},
      },
    }

    function PanelCharacters({ ctx }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [viewing, setViewing] = useState('')
      const [editing, setEditing] = useState('')
      const [creating, setCreating] = useState(false)
      const [guideOpen, setGuideOpen] = useState(false)
      const [launching, setLaunching] = useState(false)
      const [cards, setCards] = useState({})
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const viewCard = (name) => {
        if (editing === name) return
        if (viewing === name) { setViewing(''); return }
        setViewing(name)
        if (!(name in cards)) {
          setCards((current) => ({ ...current, [name]: null }))
          void fetchCharacterCard(name)
            .then((card) => setCards((current) => ({ ...current, [name]: card })))
            .catch((cause) => {
              setCards((current) => {
                const next = { ...current }
                delete next[name]
                return next
              })
              setViewing('')
              setError(t('panel.characters.loadFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
        }
      }
      const editCard = (name) => {
        if (editing === name) { setEditing(''); return }
        setEditing(name)
        setViewing(name)
        if (!(name in cards)) {
          setCards((current) => ({ ...current, [name]: null }))
          void fetchCharacterCard(name).then((card) => setCards((current) => ({ ...current, [name]: card })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, card) => saveCharacterCard(name, card).then((saved) => {
        const nextName = saved?.data?.name || name
        setCards((current) => {
          const next = { ...current, [nextName]: saved }
          if (nextName !== name) delete next[name]
          return next
        })
        setEditing('')
        setViewing(nextName)
      })
      // 手动新建走与 card_create 工具同一条 import/character 落库路径；导入语义
      // 是重名覆盖，面板侧先拦同名（含大小写不敏感——落盘 stem 在部分文件系统
      // 上不区分大小写），避免一键静默覆盖既有角色。
      const createCharacter = (card) => {
        const name = String(card?.data?.name || '').trim()
        if (name === '') return Promise.reject(new Error(t('panel.rename')))
        const normalized = name.toLowerCase()
        if (state.bootstrap.characters.some((existing) => existing.toLowerCase() === normalized)) {
          return Promise.reject(new Error(t('panel.characters.duplicate', { name })))
        }
        return api('import/character', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ card }),
        })
          .then(async (result) => {
            await refreshBootstrap()
            setCards((current) => ({ ...current, [result.name]: result.card }))
            setCreating(false)
            setViewing(result.name)
            return result.card
          })
          .catch((cause) => {
            throw new Error(t('panel.characters.createFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
      }
      const launchWorkbench = () => {
        if (launching) return
        setLaunching(true)
        setError('')
        // 向导语义是「新建角色卡」：每次拉起都是新的写卡会话，不复用既有绑定。
        void openWorkbenchSession(ctx, null, { fresh: true })
          .then(() => setGuideOpen(false))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setLaunching(false))
      }
      const characters = state.bootstrap.characters
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'character', label: t('settings.importCharacter'), accept: '.png,.charx,.json,application/json,image/png,application/zip' }),
            h('button', { type: 'button', className: 'dt-upload', onClick: () => setGuideOpen(true) }, `+ ${t('panel.characters.new')}`))),
        h('section', { className: 'dt-settings-band' },
          characters.length === 0 && !creating
            ? h('p', { className: 'dt-muted' }, t('panel.characters.empty'))
            : h('div', { className: 'dt-card-grid' },
              creating
                ? h('div', { className: 'dt-card dt-card-editing' },
                  h('div', { className: 'dt-card-head' },
                    h('div', { className: 'dt-card-title' },
                      h('strong', null, t('panel.characters.creating')))),
                  h(CardEditor, { card: BLANK_CHARACTER_CARD, name: '', hint: t('panel.characters.createEditorHint'), onSave: createCharacter, onCancel: () => setCreating(false) }))
                : null,
              characters.map((name) => {
              const active = state.bootstrap.state.activeCharacter === name
              const card = cards[name]
              return h('div', { key: name, className: `dt-card ${editing === name ? 'dt-card-editing' : ''}` },
                h('div', { className: 'dt-card-head' },
                  h('img', { src: `${API}/avatar/${encodeURIComponent(name)}`, alt: '' }),
                  h('div', { className: 'dt-card-title' },
                    h('strong', null, name),
                    card?.data?.creator ? h('span', null, t('panel.characters.creator', { name: card.data.creator })) : null)),
                h('div', { className: 'dt-card-actions' },
                  active
                    ? h(Pill, { active: true }, t('panel.characters.active'))
                    : h(Button, { size: 'sm', variant: 'outline', onClick: () => run(patchState({ activeCharacter: name })) }, t('panel.characters.setActive')),
                  h(Button, { size: 'sm', variant: 'ghost', onClick: () => viewCard(name) }, t(viewing === name ? 'panel.characters.hideCard' : 'panel.characters.viewCard')),
                  h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editCard(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconDownloadOutline16),
                    'aria-label': t('panel.characters.export', { name }),
                    title: t('panel.characters.export', { name }),
                    onClick: () => downloadAsset(`export/character/${encodeURIComponent(name)}`, `${name}.png`),
                  }),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconTrashOutline16),
                    'aria-label': t('panel.characters.delete', { name }),
                    title: t('panel.characters.delete', { name }),
                    onClick: () => {
                      if (window.confirm(t('panel.characters.deleteConfirm', { name }))) run(deleteCharacterAsset(name))
                    },
                  })),
                editing === name
                  ? h(CardEditor, { card, name, onSave: (next) => save(name, next), onCancel: () => setEditing('') })
                  : viewing === name ? h(CharacterCardFields, { card }) : null)
            }))),
        guideOpen
          ? h(NovelModalFrame, {
            title: t('panel.characters.createTitle'),
            closeLabel: t('panel.close'),
            onClose: () => setGuideOpen(false),
          },
          h('p', { className: 'dt-hint' }, t('panel.characters.createHint')),
          h('div', { className: 'dt-create-choices' },
            h('div', { className: 'dt-create-choice' },
              h('div', { className: 'dt-create-choice-copy' },
                h('h3', null, t('panel.characters.createAgentTitle')),
                h('p', { className: 'dt-hint' }, t('panel.characters.createAgentHint'))),
              h(Button, { size: 'sm', variant: 'primary', icon: h(IconSparkle16), disabled: launching, onClick: launchWorkbench }, launching ? t('workbench.opening') : t('panel.characters.createAgentLaunch'))),
            h('div', { className: 'dt-create-choice' },
              h('div', { className: 'dt-create-choice-copy' },
                h('h3', null, t('panel.characters.createManualTitle')),
                h('p', { className: 'dt-hint' }, t('panel.characters.createManualHint'))),
              h(Button, { size: 'sm', variant: 'outline', icon: h(IconEditOutline16), onClick: () => { setGuideOpen(false); setCreating(true) } }, t('panel.characters.createManualStart')))),
          error ? h('p', { className: 'dt-error' }, error) : null)
          : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    function loreKeys(entry) {
      const primary = Array.isArray(entry.key) ? entry.key : []
      const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : []
      return [...primary, ...secondary].filter((value) => value !== '').join(', ')
    }

    function ToggleField({ label, checked, onChange }) {
      return h('label', { className: 'dt-editor-toggle' },
        h('input', { type: 'checkbox', checked: checked === true, onChange: (event) => onChange(event.target.checked) }),
        h('span', null, label))
    }

    function WorldBookEditor({ book, onSave, onCancel }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(book))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState('')
      const dirty = JSON.stringify(draft) !== JSON.stringify(book)
      const entries = draft?.entries || []
      const setBook = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
      const setEntry = (uid, key, value) => setDraft((current) => ({ ...current, entries: (current.entries || []).map((entry) => entry.uid === uid ? { ...entry, [key]: value } : entry) }))
      const addEntry = () => {
        const uid = entries.reduce((max, entry) => Math.max(max, Number(entry.uid) || 0), -1) + 1
        setDraft((current) => ({ ...current, entries: [...(current.entries || []), { uid, key: [], keysecondary: [], comment: '', content: '', constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true, order: 100, position: 0, disable: false, ignoreBudget: false, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0, probability: 100, useProbability: true, depth: 4, outletName: '', group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0, sticky: null, cooldown: null, delay: null, triggers: [], matchPersonaDescription: false, matchCharacterDescription: false, matchCharacterPersonality: false, matchCharacterDepthPrompt: false, matchScenario: false, matchCreatorNotes: false }] }))
      }
      const removeEntry = (uid) => setDraft((current) => ({ ...current, entries: (current.entries || []).filter((entry) => entry.uid !== uid) }))
      const save = () => {
        setSaving(true)
        setError('')
        void Promise.resolve(onSave({ ...draft, name: String(draft.name || '').trim(), entries: entries.map((entry) => ({ ...entry, order: Number(entry.order) || 0, depth: Number(entry.depth) || 0 })) }))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      if (!draft) return h('p', { className: 'dt-muted' }, t('nav.loading'))
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !String(draft.name || '').trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('div', { className: 'dt-editor-grid' },
          h(EditorField, { label: t('panel.worlds.name'), value: draft.name, onChange: (value) => setBook('name', value) })),
        h('div', { className: 'dt-editor-section-title' },
          h('strong', null, t('panel.worlds.entry')),
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: addEntry }, t('panel.worlds.addEntry'))),
        h('div', { className: 'dt-editor-entries' }, entries.map((entry, index) => h('section', { key: entry.uid ?? index, className: 'dt-editor-entry' },
          h('div', { className: 'dt-editor-entry-head' },
            h('strong', null, entry.comment || `#${index + 1}`),
            h(Button, { size: 'sm', variant: 'ghost', icon: h(IconTrashOutline16), 'aria-label': t('panel.remove'), title: t('panel.remove'), onClick: () => removeEntry(entry.uid) })),
          h('div', { className: 'dt-editor-grid' },
            h(EditorField, { label: t('panel.worlds.comment'), value: entry.comment, onChange: (value) => setEntry(entry.uid, 'comment', value) }),
            h(EditorField, { label: t('panel.worlds.keysPrimary'), value: commaList(entry.key), onChange: (value) => setEntry(entry.uid, 'key', parseCommaList(value)) }),
            h(EditorField, { label: t('panel.worlds.keysSecondary'), value: commaList(entry.keysecondary), onChange: (value) => setEntry(entry.uid, 'keysecondary', parseCommaList(value)) }),
            h(EditorField, { label: t('panel.worlds.order'), value: entry.order, type: 'number', onChange: (value) => setEntry(entry.uid, 'order', value) }),
            h(EditorField, { label: t('panel.worlds.depth'), value: entry.depth, type: 'number', min: 0, onChange: (value) => setEntry(entry.uid, 'depth', value) }),
            h(EditorField, { label: 'Probability', value: entry.probability, type: 'number', min: 0, max: 100, onChange: (value) => setEntry(entry.uid, 'probability', value) }),
            h(EditorField, { label: t('panel.worlds.content'), value: entry.content, onChange: (value) => setEntry(entry.uid, 'content', value), multiline: true, className: 'dt-editor-wide' }),
            h('div', { className: 'dt-editor-toggles dt-editor-wide' },
              h(ToggleField, { label: t('panel.worlds.enabled'), checked: !entry.disable, onChange: (value) => setEntry(entry.uid, 'disable', !value) }),
              h(ToggleField, { label: t('panel.worlds.constant'), checked: entry.constant, onChange: (value) => setEntry(entry.uid, 'constant', value) }),
              h(ToggleField, { label: t('panel.worlds.selective'), checked: entry.selective, onChange: (value) => setEntry(entry.uid, 'selective', value) })))))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PanelWorlds() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [browse, setBrowse] = useState('')
      const [editing, setEditing] = useState('')
      const [books, setBooks] = useState({})
      const [filter, setFilter] = useState('')
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const toggleBrowse = (name) => {
        if (browse === name) { setBrowse(''); return }
        setBrowse(name)
        if (!(name in books)) {
          setBooks((current) => ({ ...current, [name]: null }))
          void fetchWorldBook(name)
            .then((book) => setBooks((current) => ({ ...current, [name]: book })))
            .catch((cause) => {
              setBrowse('')
              setError(cause instanceof Error ? cause.message : String(cause))
            })
        }
      }
      const editBook = (name) => {
        setEditing(editing === name ? '' : name)
        setBrowse(name)
        if (!(name in books)) {
          setBooks((current) => ({ ...current, [name]: null }))
          void fetchWorldBook(name).then((book) => setBooks((current) => ({ ...current, [name]: book })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, book) => saveWorldBook(name, book).then((saved) => {
        const next = saved?.name || name
        setBooks((current) => {
          const result = { ...current, [next]: saved }
          if (next !== name) delete result[name]
          return result
        })
        setBrowse(next)
        setEditing('')
      })
      const worlds = state.bootstrap.worlds
      const book = browse !== '' ? books[browse] : undefined
      const entries = book?.entries
        ? book.entries.filter((entry) => filter === '' || `${entry.comment}\n${entry.content}\n${loreKeys(entry)}`.toLowerCase().includes(filter.toLowerCase()))
        : []
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'world', label: t('settings.importWorld'), accept: '.json,application/json' }))),
        h('section', { className: 'dt-settings-band' },
          h('label', { className: 'dt-toggle' },
            h('input', {
              type: 'checkbox',
              checked: state.bootstrap.state.worldFollowsCharacter !== false,
              onChange: (event) => run(patchState({ worldFollowsCharacter: event.target.checked })),
            }),
            h('span', null, t('settings.worldFollowsCharacter'))),
          worlds.length === 0
            ? h('p', { className: 'dt-muted' }, t('settings.worldsEmpty'))
            : h('div', { className: 'dt-world-list' }, worlds.map((name) => h('div', { key: name, className: 'dt-world-row' },
              h('label', { className: 'dt-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: state.bootstrap.state.activeWorlds.includes(name),
                  onChange: (event) => {
                    const next = new Set(state.bootstrap.state.activeWorlds)
                    if (event.target.checked) next.add(name)
                    else next.delete(name)
                    run(patchState({ activeWorlds: [...next] }))
                  },
                }),
                h('span', null, name)),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => toggleBrowse(name) },
                browse === name ? t('panel.characters.hideCard') : t('panel.worlds.entries', { count: books[name]?.entries?.length ?? 0 })),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editBook(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconDownloadOutline16), 'aria-label': t('panel.exportJson'), title: t('panel.exportJson'), onClick: () => downloadAsset(`export/world/${encodeURIComponent(name)}`, `${name}.json`) }),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                'aria-label': t('panel.worlds.delete', { name }),
                title: t('panel.worlds.delete', { name }),
                onClick: () => {
                  if (window.confirm(t('panel.worlds.deleteConfirm', { name }))) run(deleteWorldBook(name))
                },
              }))))),
         browse !== '' ? h('section', { className: 'dt-settings-band' },
           h('h3', null, browse),
           editing === browse && book
             ? h(WorldBookEditor, { book, onSave: (next) => save(browse, next), onCancel: () => setEditing('') })
             : h(React.Fragment, null,
               h('div', { className: 'dt-imports' },
                 h(Input, { icon: h(IconSearchOutline16), placeholder: t('panel.worlds.search'), value: filter, onChange: (event) => setFilter(event.target.value) })),
               !book
                 ? h('p', { className: 'dt-muted' }, t('nav.loading'))
                 : entries.length === 0
                   ? h('p', { className: 'dt-muted' }, t('panel.worlds.noEntries'))
                   : h('div', { className: 'dt-entry-list' }, entries.map((entry, index) => h('div', { key: entry.uid ?? index, className: `dt-entry ${entry.disable ? 'dt-entry-off' : ''}` },
                     h('div', { className: 'dt-entry-head' },
                       h('strong', null, entry.comment || `#${entry.uid ?? index + 1}`),
                       h('span', { className: 'dt-entry-keys' }, t('panel.worlds.keys', { keys: loreKeys(entry) }))),
                     h('div', { className: 'dt-entry-content' }, entry.content)))))) : null,
         error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    function PresetEditor({ name, data, kind, onSave, onCancel }) {
      const t = useTranslate()
      const [draft, setDraft] = useState(() => cloneValue(data) || {})
      const [presetName, setPresetName] = useState(name)
      const [advanced, setAdvanced] = useState(() => JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order')), null, 2))
      const [error, setError] = useState('')
      const [saving, setSaving] = useState(false)
      const prompts = draft.prompts || []
      const chatPreset = kind === 'chat-completion' || Array.isArray(data?.prompts)
      const dirty = presetName !== name || advanced !== JSON.stringify(Object.fromEntries(Object.entries(data || {}).filter(([key]) => key !== 'prompts' && key !== 'prompt_order')), null, 2) || JSON.stringify(draft.prompts) !== JSON.stringify((data || {}).prompts)
      const setPrompt = (index, key, value) => setDraft((current) => {
        const previous = current.prompts?.[index]
        const next = { ...current, prompts: (current.prompts || []).map((prompt, promptIndex) => promptIndex === index ? { ...prompt, [key]: value } : prompt) }
        if (key === 'identifier' && previous?.identifier !== value) {
          next.prompt_order = (current.prompt_order || []).map((item) => ({ ...item, order: (item.order || []).map((entry) => entry.identifier === previous?.identifier ? { ...entry, identifier: value } : entry) }))
        }
        return next
      })
      const addPrompt = () => {
        const identifier = `customPrompt${prompts.length + 1}`
        const prompt = { name: 'New prompt', identifier, role: 'system', content: '', system_prompt: true }
        setDraft((current) => {
          const order = Array.isArray(current.prompt_order) && current.prompt_order.length > 0 ? current.prompt_order.map((item) => ({ ...item, order: [...(item.order || []), { identifier, enabled: true }] })) : [{ character_id: 100000, order: [{ identifier, enabled: true }] }]
          return { ...current, prompts: [...(current.prompts || []), prompt], prompt_order: order }
        })
      }
      const removePrompt = (index) => {
        const identifier = prompts[index]?.identifier
        setDraft((current) => ({
          ...current,
          prompts: (current.prompts || []).filter((_, promptIndex) => promptIndex !== index),
          prompt_order: (current.prompt_order || []).map((item) => ({ ...item, order: (item.order || []).filter((entry) => entry.identifier !== identifier) })),
        }))
      }
      const save = () => {
        let sampler
        try { sampler = advanced.trim() === '' ? {} : JSON.parse(advanced) } catch { setError(t('panel.presets.invalidJson')); return }
        if (!sampler || typeof sampler !== 'object' || Array.isArray(sampler)) { setError(t('panel.presets.invalidJson')); return }
        if (chatPreset && prompts.some((prompt) => !String(prompt.identifier || '').trim() || prompts.filter((candidate) => candidate.identifier === prompt.identifier).length > 1)) {
          setError(t('panel.presets.identifierInvalid'))
          return
        }
        setSaving(true)
        setError('')
        const nextData = chatPreset ? { ...sampler, prompts: draft.prompts || [], prompt_order: draft.prompt_order || [] } : sampler
        void Promise.resolve(onSave(nextData, presetName.trim() || name))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setSaving(false))
      }
      const cancel = () => { if (!dirty || window.confirm(`${t('panel.unsaved')}?`)) onCancel() }
      return h('div', { className: 'dt-editor' },
        h('div', { className: 'dt-editor-toolbar' },
          h('div', { className: 'dt-editor-status' }, dirty ? t('panel.unsaved') : t('panel.saved')),
          h('div', { className: 'dt-editor-actions' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: cancel }, t('panel.cancel')),
            h(Button, { size: 'sm', variant: 'primary', disabled: saving || !presetName.trim(), onClick: save }, saving ? t('settings.importing') : t('panel.save')))),
        h('p', { className: 'dt-hint' }, t('panel.presets.editHint')),
        h('div', { className: 'dt-editor-grid' }, h(EditorField, { label: t('panel.rename'), value: presetName, onChange: setPresetName })),
        chatPreset ? h('div', { className: 'dt-editor-section-title' },
          h('strong', null, t('panel.presets.prompts')),
          h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: addPrompt }, t('panel.presets.addPrompt'))) : null,
        chatPreset ? h('div', { className: 'dt-editor-entries' }, prompts.map((prompt, index) => h('section', { key: `${prompt.identifier || 'prompt'}-${index}`, className: 'dt-editor-entry' },
          h('div', { className: 'dt-editor-entry-head' }, h('strong', null, prompt.name || prompt.identifier || `#${index + 1}`), h(Button, { size: 'sm', variant: 'ghost', icon: h(IconTrashOutline16), 'aria-label': t('panel.presets.removePrompt'), title: t('panel.presets.removePrompt'), onClick: () => removePrompt(index) })),
          h('div', { className: 'dt-editor-grid' },
            h(EditorField, { label: t('panel.presets.promptName'), value: prompt.name, onChange: (value) => setPrompt(index, 'name', value) }),
            h(EditorField, { label: t('panel.presets.identifier'), value: prompt.identifier, onChange: (value) => setPrompt(index, 'identifier', value) }),
            h('label', { className: 'dt-editor-field' }, h('span', { className: 'dt-label' }, t('panel.presets.role')), h('select', { value: prompt.role || 'system', onChange: (event) => setPrompt(index, 'role', event.target.value) }, h('option', { value: 'system' }, 'system'), h('option', { value: 'user' }, 'user'), h('option', { value: 'assistant' }, 'assistant'))),
            h(EditorField, { label: t('panel.presets.content'), value: prompt.content, onChange: (value) => setPrompt(index, 'content', value), multiline: true, className: 'dt-editor-wide' }),
            h('div', { className: 'dt-editor-toggles dt-editor-wide' },
              h(ToggleField, { label: t('panel.presets.marker'), checked: prompt.marker === true, onChange: (value) => setPrompt(index, 'marker', value) }),
              h(ToggleField, { label: t('panel.presets.enabled'), checked: prompt.system_prompt !== false, onChange: (value) => setPrompt(index, 'system_prompt', value) })))))) : null,
        h(EditorField, { label: t('panel.presets.sampler'), value: advanced, onChange: setAdvanced, multiline: true, className: 'dt-editor-wide dt-editor-json' }),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function PanelPresets() {
      const state = useTavernStore()
      const t = useTranslate()
      const [error, setError] = useState('')
      const [editing, setEditing] = useState('')
      const [presets, setPresets] = useState({})
      const run = (promise) => { setError(''); void promise.catch((cause) => setError(cause.message)) }
      const kinds = state.bootstrap.presetKinds || {}
      const editPreset = (name) => {
        setEditing(editing === name ? '' : name)
        if (!(name in presets)) {
          setPresets((current) => ({ ...current, [name]: null }))
          void fetchPreset(name).then((data) => setPresets((current) => ({ ...current, [name]: data })))
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        }
      }
      const save = (name, data, nextName) => savePreset(name, data, nextName).then((saved) => {
        const target = nextName || name
        setPresets((current) => {
          const next = { ...current, [target]: saved }
          if (target !== name) delete next[name]
          return next
        })
        setEditing('')
      })
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('settings.import')),
          h('div', { className: 'dt-imports' },
            h(UploadButton, { kind: 'preset', label: t('settings.importPreset'), accept: '.json,application/json' }))),
        h('section', { className: 'dt-settings-band' },
          state.bootstrap.presets.length === 0
            ? h('p', { className: 'dt-muted' }, t('panel.presets.empty'))
            : h('div', { className: 'dt-preset-list' }, state.bootstrap.presets.map((name) => h('div', { key: name, className: 'dt-preset-row' },
              h('strong', { className: 'dt-preset-name' }, name),
              h(Pill, null, kinds[name] || 'preset'),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconEditOutline16), onClick: () => editPreset(name) }, t(editing === name ? 'panel.cancel' : 'panel.edit')),
              h(Button, { size: 'sm', variant: 'ghost', icon: h(IconDownloadOutline16), 'aria-label': t('panel.exportJson'), title: t('panel.exportJson'), onClick: () => downloadAsset(`export/preset/${encodeURIComponent(name)}`, `${name}.json`) }),
              state.bootstrap.state.activePreset === name
                ? h(Pill, { active: true }, t('panel.characters.active'))
                : h(Button, { size: 'sm', variant: 'outline', onClick: () => run(patchState({ activePreset: name })) }, t('panel.presets.setActive')),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconTrashOutline16),
                'aria-label': t('panel.presets.delete', { name }),
                title: t('panel.presets.delete', { name }),
                onClick: () => {
                  if (window.confirm(t('panel.presets.deleteConfirm', { name }))) run(deletePresetAsset(name))
                },
              }),
            editing === name ? h('div', { className: 'dt-preset-editor-wrap' }, presets[name] ? h(PresetEditor, { name, kind: kinds[name], data: presets[name], onSave: (data, nextName) => save(name, data, nextName), onCancel: () => setEditing('') }) : h('p', { className: 'dt-muted' }, t('nav.loading'))) : null)))),
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    function AuditMemoryRow({ memory, t }) {
      const inactive = Boolean(memory.deletedAt || memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now())
      return h('article', { className: `dt-audit-row ${inactive ? 'dt-audit-row-inactive' : ''}` },
        h('div', { className: 'dt-audit-row-head' },
          h('strong', null, `${memory.scope} · ${memory.kind}`),
          h('span', null, memory.id)),
        h('p', null, memory.content),
        h('div', { className: 'dt-audit-meta' },
          h('span', null, t('panel.variables.auditSource', { source: memory.source?.kind || '-' })),
          h('span', null, t('panel.variables.auditRevision', { revision: memory.revision })),
          h('span', null, t('panel.variables.auditExpired', { value: memory.expiresAt || '-' })),
          h('span', null, t('panel.variables.auditDeleted', { value: memory.deletedAt || '-' }))))
    }

    function AuditVariableRow({ variable, t }) {
      return h('article', { className: 'dt-audit-row' },
        h('div', { className: 'dt-audit-row-head' },
          h('strong', null, `${variable.scope} · ${variable.name}`),
          h('span', null, t('panel.variables.auditRevision', { revision: variable.revision }))),
        h('pre', null, JSON.stringify(variable.value, null, 2)))
    }

    function PanelVariables({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [rows, setRows] = useState(null)
      const [error, setError] = useState('')
      const [audit, setAudit] = useState(null)
      const [auditLoading, setAuditLoading] = useState(false)
      const [auditError, setAuditError] = useState('')
      const [replayBusy, setReplayBusy] = useState(false)
      const [replayNonce, setReplayNonce] = useState(0)
      const [saved, setSaved] = useState(false)
      const currentSession = useSessions ? useCurrentSessionId(useSessions) : null
      const binding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      const agentBinding = binding && bindingArchitecture(binding) === 'agent-tavern' ? binding : null
      const localChat = binding ? state.chats[chatKey(binding.character, binding.chatId)] : null
      const localVars = localChat?.header?.chat_metadata?.variables
      useEffect(() => {
        void fetchGlobals()
          .then((globals) => setRows(Object.entries(globals).map(([key, value]) => ({ key, value: String(value) }))))
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setRows([]) })
      }, [])
      useEffect(() => {
        if (binding && !localChat) void loadChat(binding.character, binding.chatId).catch(() => {})
      }, [binding?.character, binding?.chatId])
      useEffect(() => {
        let cancelled = false
        setAudit(null)
        setAuditError('')
        if (!currentSession || !agentBinding) {
          setAuditLoading(false)
          return () => { cancelled = true }
        }
        setAuditLoading(true)
        void api(`agent-tavern/audit?sessionId=${encodeURIComponent(currentSession)}`)
          .then((result) => { if (!cancelled) setAudit(result) })
          .catch((cause) => { if (!cancelled) setAuditError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { if (!cancelled) setAuditLoading(false) })
        return () => { cancelled = true }
      }, [currentSession, agentBinding?.character, agentBinding?.chatId, agentBinding?.contextMode, replayNonce])
      const replayProjection = () => {
        if (!currentSession || replayBusy) return
        setReplayBusy(true)
        setAuditError('')
        void api('projection/replay', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionId: currentSession }),
        })
          .then(() => setReplayNonce((nonce) => nonce + 1))
          .catch((cause) => setAuditError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setReplayBusy(false))
      }
      const updateRow = (index, patch) => setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row))
      const save = () => {
        const globals = {}
        for (const row of rows) {
          const key = row.key.trim()
          if (key === '') continue
          const raw = row.value.trim()
          globals[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : row.value
        }
        setSaved(false)
        void saveGlobals(globals).then(() => setSaved(true)).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.globals')),
          h('p', { className: 'dt-hint' }, t('panel.variables.globalsHint')),
          rows === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h(React.Fragment, null,
              rows.length === 0 ? h('p', { className: 'dt-muted' }, t('panel.variables.empty')) : null,
              h('div', { className: 'dt-kv-list' }, rows.map((row, index) => h('div', { key: index, className: 'dt-kv-row' },
                h(Input, { value: row.key, placeholder: t('panel.variables.key'), onChange: (event) => updateRow(index, { key: event.target.value }) }),
                h(Input, { value: row.value, placeholder: t('panel.variables.value'), onChange: (event) => updateRow(index, { value: event.target.value }) }),
                h(Button, {
                  size: 'sm',
                  variant: 'ghost',
                  icon: h(IconTrashOutline16),
                  'aria-label': t('panel.variables.remove', { key: row.key }),
                  title: t('panel.variables.remove', { key: row.key }),
                  onClick: () => setRows(rows.filter((_, rowIndex) => rowIndex !== index)),
                })))),
              h('div', { className: 'dt-imports' },
                h(Button, { size: 'sm', variant: 'outline', icon: h(IconPlusOutline16), onClick: () => setRows([...rows, { key: '', value: '' }]) }, t('panel.variables.add')),
                h(Button, { size: 'sm', variant: 'primary', onClick: save }, t('panel.variables.save')),
                saved ? h('span', { className: 'dt-muted' }, t('panel.variables.saved')) : null))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.chatLocal')),
          !binding
            ? h('p', { className: 'dt-muted' }, t('panel.variables.chatLocalEmpty'))
            : localVars && Object.keys(localVars).length > 0
              ? h('div', { className: 'dt-kv-list' },
                Object.entries(localVars).map(([key, value]) => h('div', { key, className: 'dt-kv-row dt-kv-readonly' },
                  h('span', { className: 'dt-kv-key' }, key),
                  h('span', { className: 'dt-kv-value' }, String(value)),
                  h('span'))))
              : h('p', { className: 'dt-muted' }, t('panel.variables.empty'))),
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.variables.agentAudit')),
          !agentBinding
            ? h('p', { className: 'dt-muted' }, t('panel.variables.agentAuditEmpty'))
            : auditLoading
              ? h('p', { className: 'dt-muted' }, t('panel.variables.auditLoading'))
              : audit
                ? h('div', { className: 'dt-audit' },
                  h('div', { className: 'dt-audit-summary' },
                    h('span', { className: 'dt-architecture-badge dt-architecture-agent-tavern' }, architectureLabel('agent-tavern')),
                    h('span', null, audit.contextMode === 'agent-managed' ? t('settings.contextManaged') : t('settings.contextNative')),
                    audit.projection ? h('span', null, t('panel.variables.projection', {
                      status: audit.projection.status,
                      cursor: audit.projection.lastCursor,
                    })) : null),
                  audit.projection?.error
                    ? h('p', { className: 'dt-error' }, t('panel.variables.auditProjectionError', { message: audit.projection.error }))
                    : null,
                  audit.projection?.status === 'pending'
                    ? h('div', { className: 'dt-imports' },
                      h(Button, {
                        size: 'sm',
                        variant: 'outline',
                        disabled: replayBusy,
                        onClick: replayProjection,
                      }, replayBusy ? t('panel.variables.replaying') : t('panel.variables.replayProjection')))
                    : null,
                  h('h4', null, t('panel.variables.memories')),
                  audit.memories?.length
                    ? h('div', { className: 'dt-audit-list' }, audit.memories.map((memory) => h(AuditMemoryRow, {
                      key: `${memory.scope}:${memory.id}`,
                      memory,
                      t,
                    })))
                    : h('p', { className: 'dt-muted' }, t('panel.variables.empty')),
                  h('h4', null, t('panel.variables.nativeVariables')),
                  audit.variables?.length
                    ? h('div', { className: 'dt-audit-list' }, audit.variables.map((variable) => h(AuditVariableRow, {
                      key: `${variable.scope}:${variable.name}`,
                      variable,
                      t,
                    })))
                    : h('p', { className: 'dt-muted' }, t('panel.variables.empty')))
                : null),
        auditError ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, auditError)) : null,
        error ? h('div', { className: 'dt-settings-band' }, h('p', { className: 'dt-error' }, error)) : null)
    }

    // 持续指引面板（提案 0009）：跟随当前会话绑定的聊天（ST 与 AgentTavern
    // 都生效）。列出以 GET guides 为准（chat_metadata 里可能已有，也可能被
    // 其他端改过）；添加/删除成功后 revision 由服务端推进，客户端照 saveChat
    // 同款模式同步 revisions 并强刷聊天快照。
    function PanelGuides({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const currentSession = useSessions ? useCurrentSessionId(useSessions) : null
      const binding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      // 指引禁用面：写卡工作台会话不绑定聊天（binding.character/chatId 恒为空
      // 串），小说会话同款空绑定。直接禁用——不请求、不渲染输入，避免空 id 打
      // 到 guides 路由炸出 invalid chat id。
      const guidesDisabled = !!binding
        && (binding.architecture === 'card-workbench' || binding.character === '' || binding.chatId === '')
      const [guides, setGuides] = useState(null)
      const [draft, setDraft] = useState('')
      const [error, setError] = useState('')
      const [adding, setAdding] = useState(false)
      const [busyId, setBusyId] = useState('')
      useEffect(() => {
        let cancelled = false
        setGuides(null)
        setError('')
        if (!binding || guidesDisabled) return () => { cancelled = true }
        void loadGuides(binding.character, binding.chatId)
          .then((result) => { if (!cancelled) setGuides(Array.isArray(result.guides) ? result.guides : []) })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
        return () => { cancelled = true }
      }, [binding?.character, binding?.chatId, guidesDisabled])
      const reloadGuides = () => {
        if (!binding || guidesDisabled) return Promise.resolve()
        return loadGuides(binding.character, binding.chatId)
          .then((result) => setGuides(Array.isArray(result.guides) ? result.guides : []))
          .catch(() => {})
      }
      const recoverConflict = (cause) => {
        // 写路径 409（CHAT_REVISION_CONFLICT）：聊天在服务端被并发推进，重取
        // guides + 强刷本地聊天快照后让用户重试。
        if (cause?.status === 409 || cause?.code === REVISION_CONFLICT) {
          void reloadGuides()
          void loadChat(binding.character, binding.chatId, true).catch(() => {})
        }
      }
      const add = () => {
        const text = draft.trim()
        if (!binding || guidesDisabled || text === '' || adding) return
        setAdding(true)
        setError('')
        void addChatGuide(binding.character, binding.chatId, text)
          .then((result) => {
            setGuides(Array.isArray(result.guides) ? result.guides : [])
            setDraft('')
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            recoverConflict(cause)
          })
          .finally(() => setAdding(false))
      }
      const remove = (id) => {
        if (!binding || guidesDisabled || busyId !== '') return
        setBusyId(id)
        setError('')
        void removeChatGuide(binding.character, binding.chatId, id)
          .then((result) => setGuides(Array.isArray(result.guides) ? result.guides : []))
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            recoverConflict(cause)
          })
          .finally(() => setBusyId(''))
      }
      return h('section', { className: 'dt-settings-band' },
        h('h3', null, t('panel.section.guides')),
        h('p', { className: 'dt-hint' }, t('panel.guides.hint')),
        !binding
          ? h('p', { className: 'dt-muted' }, t('panel.variables.chatLocalEmpty'))
          : guidesDisabled
            ? h('p', { className: 'dt-muted' }, t('panel.guides.unavailable'))
            : guides === null
              ? h('p', { className: 'dt-muted' }, t('nav.loading'))
              : h(React.Fragment, null,
                guides.length === 0 ? h('p', { className: 'dt-muted' }, t('panel.guides.empty')) : null,
                h('div', { className: 'dt-guide-list' }, guides.map((guide) => h('div', { key: guide.id, className: 'dt-guide-row' },
                  h('span', { className: 'dt-guide-text' }, guide.text),
                  h(Button, {
                    size: 'sm',
                    variant: 'ghost',
                    icon: h(IconTrashOutline16),
                    'aria-label': t('panel.guides.remove'),
                    title: t('panel.guides.remove'),
                    disabled: busyId !== '' || adding,
                    onClick: () => remove(guide.id),
                  })))),
              h('div', { className: 'dt-guide-add' },
                h('div', { className: 'dt-guide-add-field' },
                  h(Input, {
                    value: draft,
                    placeholder: t('panel.guides.placeholder'),
                    disabled: adding,
                    onChange: (event) => setDraft(event.target.value),
                  })),
                h(Button, {
                  size: 'sm',
                  variant: 'primary',
                  disabled: adding || draft.trim() === '',
                  onClick: add,
                }, adding ? t('panel.guides.adding') : t('panel.guides.add')))),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    // 剧本库管理（提案 0014 P1）：管理面板资源区，与世界书/预设库同级。列表
    // 读 GET scripts（名称/分块数/绑定卡映射）；导入走 POST script/import
    // （文件读文本或粘贴，名字默认取文件名去后缀，format 按后缀推断）；绑定/
    // 解绑写在卡 extensions 上（POST script/bind / script/unbind），改完重取
    // 列表刷新绑定映射。
    function PanelScripts() {
      const state = useTavernStore()
      const t = useTranslate()
      const [library, setLibrary] = useState(null)
      const [error, setError] = useState('')
      const [importing, setImporting] = useState(false)
      const [pasteOpen, setPasteOpen] = useState(false)
      const [pasteName, setPasteName] = useState('')
      const [pasteContent, setPasteContent] = useState('')
      const [selection, setSelection] = useState({})
      const [busyKey, setBusyKey] = useState('')
      const characters = state.bootstrap.characters || []
      const reload = () => loadScriptsLibrary()
        .then((result) => { setLibrary(result); setError(''); return result })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void reload() }, [])
      const scripts = Array.isArray(library?.scripts) ? library.scripts : []
      const bindings = library?.bindings && typeof library.bindings === 'object' && !Array.isArray(library.bindings) ? library.bindings : {}
      const importText = (name, content, format) => {
        const trimmed = name.trim()
        if (trimmed === '' || content.trim() === '' || importing) return Promise.resolve(false)
        setImporting(true)
        setError('')
        return importScriptAsset(trimmed, content, format)
          .then(() => {
            bumpScriptsRevision()
            void reload()
            return true
          })
          .catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause))
            return false
          })
          .finally(() => setImporting(false))
      }
      const bind = (scriptName) => {
        const character = selection[scriptName]
        if (!character || busyKey !== '') return
        setBusyKey(scriptName)
        setError('')
        void bindCharacterScript(character, scriptName)
          .then(() => {
            setSelection((current) => ({ ...current, [scriptName]: '' }))
            bumpScriptsRevision()
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyKey(''))
      }
      const unbind = (character) => {
        if (busyKey !== '') return
        setBusyKey(character)
        setError('')
        void unbindCharacterScript(character)
          .then(() => {
            bumpScriptsRevision()
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyKey(''))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.section.scripts')),
          h('p', { className: 'dt-hint' }, t('scripts.hint')),
          h('div', { className: 'dt-imports' },
            h('label', { className: 'dt-upload', title: t('settings.importTitle', { name: t('scripts.importFile') }) },
              importing ? t('scripts.importing') : t('scripts.importFile'),
              h('input', {
                type: 'file',
                accept: '.txt,.md,.markdown,.epub,text/plain,text/markdown,application/epub+zip',
                disabled: importing,
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  // EPUB 走二进制（提案 0014 P2）：FileReader 读 ArrayBuffer →
                  // base64，format 'epub'（服务端解码 zip 取 spine 正文）；TXT/MD
                  // 路径不变，仍读文本按后缀推断。
                  const epub = /\.epub$/i.test(file.name)
                  void readFile(file, epub)
                    .then((content) => importText(
                      fileStem(file.name),
                      epub ? bytesToBase64(new Uint8Array(content)) : content,
                      epub ? 'epub' : (/\.md(?:own)?$/i.test(file.name) ? 'md' : 'txt'),
                    ))
                    .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                },
              })),
            h('button', {
              type: 'button',
              className: 'dt-upload',
              onClick: () => setPasteOpen(!pasteOpen),
            }, t('scripts.paste')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('scripts.refresh'))),
          pasteOpen ? h('div', { className: 'dt-script-paste' },
            h(EditorField, { label: t('scripts.pasteName'), value: pasteName, placeholder: 'my-script.md', onChange: setPasteName }),
            h('label', { className: 'dt-editor-field dt-editor-wide' },
              h('span', { className: 'dt-label' }, t('scripts.pasteContent')),
              h('textarea', {
                value: pasteContent,
                rows: 6,
                placeholder: t('scripts.pastePlaceholder'),
                onChange: (event) => setPasteContent(event.target.value),
              })),
            h('div', { className: 'dt-imports' },
              h(Button, {
                size: 'sm',
                variant: 'primary',
                disabled: importing || pasteName.trim() === '' || pasteContent.trim() === '',
                onClick: () => {
                  // 失败保留草稿（错误显示在下方），成功才清空并收起
                  void importText(pasteName, pasteContent, undefined).then((imported) => {
                    if (imported !== true) return
                    setPasteName('')
                    setPasteContent('')
                    setPasteOpen(false)
                  })
                },
              }, importing ? t('scripts.importing') : t('scripts.pasteImport')),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => setPasteOpen(false) }, t('panel.cancel')))) : null,
          characters.length === 0 ? h('p', { className: 'dt-hint' }, t('scripts.noCharacters')) : null),
        h('section', { className: 'dt-settings-band' },
          library === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : scripts.length === 0
              ? h('p', { className: 'dt-muted' }, t('scripts.empty'))
              : h('div', { className: 'dt-script-list' }, scripts.map((script) => {
                const bound = Object.keys(bindings).filter((character) => bindings[character] === script.name)
                const draft = selection[script.name] || ''
                return h('div', { key: script.name, className: 'dt-script-row' },
                  h('div', { className: 'dt-script-row-head' },
                    h('strong', { className: 'dt-script-name' }, script.name),
                    h(Pill, null, script.format === 'epub' ? 'EPUB' : script.format === 'md' ? 'md' : 'txt'),
                    h('span', { className: 'dt-script-meta' }, t('scripts.chunks', { count: script.chunkCount })),
                    h('span', { className: 'dt-script-meta' }, t('scripts.characters', { count: script.totalCharacters })),
                    h('span', { className: 'dt-script-meta' }, t('scripts.importedAt', { time: formatNovelTime(script.importedAt) }))),
                  h('div', { className: 'dt-script-bind' },
                    h('select', {
                      value: draft,
                      disabled: busyKey !== '' || characters.length === 0,
                      'aria-label': t('scripts.bindTo'),
                      onChange: (event) => setSelection((current) => ({ ...current, [script.name]: event.target.value })),
                    },
                      h('option', { key: '', value: '' }, t('scripts.bindTo')),
                      characters.map((character) => h('option', { key: character, value: character }, character))),
                    h(Button, {
                      size: 'sm',
                      variant: 'outline',
                      disabled: busyKey !== '' || draft === '',
                      onClick: () => bind(script.name),
                    }, t('scripts.bind'))),
                  bound.length > 0 ? h('div', { className: 'dt-script-bound' },
                    bound.map((character) => h('span', { key: character, className: 'dt-script-bound-chip' },
                      h('span', null, character),
                      h('button', {
                        type: 'button',
                        title: t('scripts.unbind', { name: character }),
                        'aria-label': t('scripts.unbind', { name: character }),
                        disabled: busyKey !== '',
                        onClick: () => unbind(character),
                      }, '×')))) : null)
              })),
          error ? h('p', { className: 'dt-error' }, error) : null))
    }

    // ---- AgentNovel panel surface (proposal 0005 §14.3) ----

    function novelStatusId(novel) {
      return novel?.status === 'paused' || novel?.status === 'completed' ? novel.status : 'active'
    }

    // translate() falls back to the key itself for unknown keys, so a missing
    // enum value degrades to the raw server string instead of a broken label.
    function translatedEnum(t, prefix, value) {
      const key = `${prefix}${value}`
      const label = t(key)
      return label === key ? String(value ?? '—') : label
    }

    function novelStatusLabel(t, novel) {
      return translatedEnum(t, 'novel.status.', novelStatusId(novel))
    }

    function novelPhaseLabel(t, phase) {
      return phase ? translatedEnum(t, 'novel.phase.', phase) : ''
    }

    function novelPauseReasonLabel(t, reason) {
      return reason ? translatedEnum(t, 'novel.pauseReason.', reason) : ''
    }

    function novelChapterStateLabel(t, state) {
      return state ? translatedEnum(t, 'novel.chapterState.', state) : '—'
    }

    function novelRequirementStatusLabel(t, status) {
      return translatedEnum(t, 'novel.req.status.', status)
    }

    function novelDetailText(value) {
      if (value === null || value === undefined || value === '') return ''
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    }

    function formatNovelTime(value) {
      const parsed = Date.parse(value || '')
      return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : String(value || '—')
    }

    // 写手运行计数（0007 §7）：与 deduceRuns 同类的运行计数、无上限；detail 投影
    // 未暴露该字段时返回 null，面板隐藏而不显示编造的 0。多路径读取兼容
    // budget 投影（对齐 deduceRuns 的暴露位置）与 run 快照两种形态。
    function novelWriterRuns(novel) {
      const value = novel?.budget?.writerRuns ?? novel?.run?.writerRuns
      return Number.isFinite(value) ? value : null
    }

    // 用量采样（0007 §7 W0）：审计性质、非权威——客户端只如实展示实测字段，
    // 不做四分类等分析性投影。采样数组按写入顺序追加，末位即最近一条；
    // 仍以 recordedAt 兜底比较，防御乱序数据。
    function novelUsageSamples(novel) {
      const raw = novel?.usageSamples ?? novel?.run?.usageSamples ?? novel?.budget?.usageSamples
      if (!Array.isArray(raw)) return []
      return raw.filter((item) => item !== null && typeof item === 'object')
    }

    function novelLatestUsageSample(novel) {
      const samples = novelUsageSamples(novel)
      if (samples.length === 0) return null
      return samples.reduce((latest, item) => (
        Date.parse(item.recordedAt || '') > Date.parse(latest.recordedAt || '') ? item : latest
      ))
    }

    function novelToolBytesEntries(sample) {
      const raw = sample?.toolBytes
      if (raw === null || typeof raw !== 'object') return []
      return Object.entries(raw).filter(([, bytes]) => Number.isFinite(bytes))
    }

    function novelToolBytesTotal(sample) {
      return novelToolBytesEntries(sample).reduce((sum, [, bytes]) => sum + bytes, 0)
    }

    function formatNovelBytes(bytes) {
      const value = Number.isFinite(bytes) ? bytes : 0
      return `${(value / 1024).toFixed(1)} KB`
    }

    function novelCharactersText(t, novel) {
      const effective = Number(novel?.effectiveCharacters || 0).toLocaleString()
      if (novel?.targetCharacters === null || novel?.targetCharacters === undefined) {
        return t('novel.characters', { effective })
      }
      return t('novel.charactersTarget', { effective, target: Number(novel.targetCharacters).toLocaleString() })
    }

    function NovelModalFrame({ title, closeLabel, onClose, children, footer, className = '' }) {
      return h(Modal, {
        open: true,
        onClose,
        title,
        closeLabel,
        headless: true,
        className: `dt-novel-modal ${className}`.trim(),
      },
      h('div', { className: 'dt-novel-modal-head' },
        h('h2', null, title),
        h('button', {
          type: 'button',
          className: 'dt-panel-close',
          'aria-label': closeLabel,
          onClick: onClose,
        }, h(IconCloseOutline16))),
      h('div', { className: 'dt-novel-modal-body' }, children),
      footer ? h('div', { className: 'dt-novel-modal-foot' }, footer) : null)
    }

    function NovelChapters({ novel, chapterId, onSelect, t }) {
      const chapters = novel?.chapters || []
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.chaptersTitle')),
        chapters.length === 0
          ? h('p', { className: 'dt-muted' }, '—')
          : h('div', { className: 'dt-novel-toc' }, chapters.map((chapter) => h('button', {
            key: chapter.chapterId,
            type: 'button',
            className: `dt-novel-chapter ${chapterId === chapter.chapterId ? 'dt-novel-chapter-active' : ''}`,
            onClick: () => onSelect(chapter.chapterId),
          },
          h('span', { className: 'dt-novel-chapter-title', title: chapter.title || chapter.chapterId },
            `${chapter.order}. ${chapter.title || chapter.chapterId}`),
          h('span', { className: 'dt-novel-chapter-meta' },
            `${novelChapterStateLabel(t, chapter.state)} · ${Number(chapter.committedCharacters || 0).toLocaleString()}`)))))
    }

    function NovelOutlineSummaryBlock({ novel, t }) {
      const summary = novel?.outlineSummary
      if (!summary) return null
      const story = summary.story || {}
      const note = (label, value) => value
        ? h('p', { className: 'dt-novel-note' }, `${label}: ${value}`)
        : null
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, `${t('novel.outlineRevision')}: ${summary.outlineRevision ?? '—'}`),
        note(t('novel.storyPremise'), story.premise),
        note(t('novel.storyTheme'), story.theme),
        note(t('novel.storyEnding'), story.endingDirection),
        Array.isArray(summary.foreshadowing) && summary.foreshadowing.length > 0
          ? h('div', { className: 'dt-novel-fores' },
            h('h4', null, t('novel.foreshadowing')),
            summary.foreshadowing.map((item) => h('div', { key: item.id, className: 'dt-novel-fore' },
              h('span', null, item.description || item.id),
              h('span', { className: 'dt-novel-fore-meta' },
                `${item.status || '—'}${item.required === true ? ` · ${t('novel.foreshadowingRequired')}` : ''}`))))
          : null)
    }

    function NovelReaderBlock({ novel, chapterId, paragraphs, nextCursor, loading, error, onLoadMore, t }) {
      const chapter = (novel?.chapters || []).find((item) => item.chapterId === chapterId)
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.readerTitle')),
        chapter ? h('p', { className: 'dt-muted' },
          `${chapter.order}. ${chapter.title || chapter.chapterId} · ${novelChapterStateLabel(t, chapter.state)} · ${Number(chapter.committedCharacters || 0).toLocaleString()}`) : null,
        error ? h('p', { className: 'dt-error' }, error) : null,
        !error && paragraphs.length === 0 && !loading ? h('p', { className: 'dt-muted' }, t('novel.readerEmpty')) : null,
        h('div', { className: 'dt-novel-paragraphs' },
          paragraphs.map((paragraph) => h('p', {
            key: `${paragraph.commitId}:${paragraph.paragraphIndex}`,
            className: 'dt-novel-paragraph',
          }, paragraph.text)),
          loading ? h('p', { className: 'dt-muted' }, t('nav.loading')) : null,
          nextCursor !== null && !loading
            ? h('button', { type: 'button', className: 'dt-upload', onClick: onLoadMore }, t('novel.loadMore'))
            : null))
    }

    function NovelAuthorPanel({ novel, t, onOpenSession }) {
      const budget = novel?.budget || {}
      const target = novel?.targetCharacters ?? null
      const remaining = budget.remainingCharacters ?? null
      const requirements = Array.isArray(novel?.requirements) ? novel.requirements : []
      const config = novel?.config || {}
      const writerRuns = novelWriterRuns(novel)
      const usageSample = novelLatestUsageSample(novel)
      const usageTools = novelToolBytesEntries(usageSample)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
      return h('div', { className: 'dt-novel-block' },
        h('h4', null, t('novel.authorPanel')),
        h('p', { className: 'dt-hint' }, t('novel.authorHint')),
        h('button', { type: 'button', className: 'dt-upload', onClick: onOpenSession }, t('novel.authorOpenSession')),
        h('h4', null, t('novel.requirements')),
        requirements.length === 0
          ? h('p', { className: 'dt-muted' }, t('novel.requirementsEmpty'))
          : h('div', { className: 'dt-novel-reqs' }, requirements.map((item) => h('div', {
            key: item.requirementId,
            className: `dt-novel-req ${item.status === 'blocked' ? 'dt-novel-req-blocked' : ''}`,
          },
          h('div', { className: 'dt-novel-req-head' },
            h('span', { className: 'dt-novel-req-status' }, novelRequirementStatusLabel(t, item.status)),
            h('span', { className: 'dt-muted' }, `#${item.sequence ?? '—'}`)),
          h('p', { className: 'dt-novel-req-text' }, item.text || ''),
          item.effectiveLocation
            ? h('span', { className: 'dt-novel-req-meta' }, t('novel.req.effectiveAt', { location: novelDetailText(item.effectiveLocation) || '—' }))
            : null,
          item.blockedReason
            ? h('span', { className: 'dt-novel-req-meta dt-error' }, t('novel.req.blockedReason', { reason: novelDetailText(item.blockedReason) }))
            : null))),
        h('h4', null, t('novel.budgetTitle')),
        h('div', { className: 'dt-novel-kv' },
          h('span', null, target === null
            ? t('novel.lengthUnbounded')
            : t('novel.lengthTarget', { target: Number(target).toLocaleString() })),
          h('span', null, remaining === null
            ? t('novel.remainingUnbounded')
            : t('novel.remainingCharacters', { value: Number(remaining).toLocaleString() })),
          h('span', null, t('novel.runBudget', {
            used: budget.turnsRun ?? 0,
            max: budget.maxTurns ?? '—',
            deduce: budget.deduceRuns ?? 0,
            maxDeduce: budget.maxDeduceRuns ?? '—',
          })),
          writerRuns === null
            ? null
            : h('span', null, t('novel.runWriterRuns', { count: Number(writerRuns).toLocaleString() }))),
        h('h4', null, t('novel.usageSample.title')),
        usageSample === null
          ? h('p', { className: 'dt-muted' }, t('novel.usageSample.empty'))
          : h('div', { className: 'dt-novel-kv' },
            h('span', null, t('novel.usageSample.latest', {
              turn: usageSample.turn ?? '—',
              time: formatNovelTime(usageSample.recordedAt),
            })),
            h('span', null, t('novel.usageSample.toolBytesTotal', { size: formatNovelBytes(novelToolBytesTotal(usageSample)) })),
            usageTools.map(([tool, bytes]) => h('span', { key: tool },
              t('novel.usageSample.toolBytes', { tool, size: formatNovelBytes(bytes) }))),
            Number.isFinite(usageSample.writerOutputChars)
              ? h('span', null, t('novel.usageSample.writerOutput', { chars: Number(usageSample.writerOutputChars).toLocaleString() }))
              : null),
        h('p', { className: 'dt-hint' }, t('novel.usageSample.hint')),
        h('h4', null, t('novel.assets')),
        (config.characterNames?.length || 0) + (config.worldNames?.length || 0) > 0
          ? h('div', { className: 'dt-novel-kv' },
            config.characterNames?.length
              ? h('span', null, t('novel.assetsCharacters', { names: config.characterNames.join(', ') }))
              : null,
            config.worldNames?.length
              ? h('span', null, t('novel.assetsWorlds', { names: config.worldNames.join(', ') }))
              : null)
          : h('p', { className: 'dt-muted' }, t('novel.assetsNone')))
    }

    const NOVEL_BODY_PAGE_SIZE = 200

    function NovelDetail({ ctx, novelId, onBack, onChanged }) {
      const t = useTranslate()
      const [novel, setNovel] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState(false)
      const [chapterId, setChapterId] = useState('')
      const [paragraphs, setParagraphs] = useState([])
      const [nextCursor, setNextCursor] = useState(null)
      const [bodyLoading, setBodyLoading] = useState(false)
      const [bodyError, setBodyError] = useState('')
      const [bodyNonce, setBodyNonce] = useState(0)
      const [outline, setOutline] = useState(null)
      const [outlineError, setOutlineError] = useState('')
      const [outlineOpen, setOutlineOpen] = useState(false)
      const [approveRevision, setApproveRevision] = useState('')
      const syncedRevisionRef = useRef(null)
      const loadDetail = () => fetchNovelDetail(novelId)
        .then((next) => {
          setNovel(next)
          setError('')
          const revision = next?.outlineSummary?.outlineRevision
          if (revision !== undefined && revision !== null && syncedRevisionRef.current !== revision) {
            syncedRevisionRef.current = revision
            setApproveRevision(String(revision))
          }
          return next
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void loadDetail() }, [novelId])
      useEffect(() => {
        if (!novel) return
        const chapters = novel.chapters || []
        if (chapters.length === 0) {
          if (chapterId !== '') setChapterId('')
          return
        }
        if (chapters.some((chapter) => chapter.chapterId === chapterId)) return
        const firstWithBody = chapters.find((chapter) => Number(chapter.committedCharacters) > 0)
        setChapterId((firstWithBody || chapters[0]).chapterId)
      }, [novel])
      useEffect(() => {
        if (!novel || chapterId === '') return
        let cancelled = false
        setBodyLoading(true)
        setBodyError('')
        setParagraphs([])
        setNextCursor(null)
        void fetchNovelBody(novelId, chapterId, null, NOVEL_BODY_PAGE_SIZE)
          .then((page) => {
            if (cancelled) return
            setParagraphs(page.paragraphs)
            setNextCursor(page.nextCursor)
          })
          .catch((cause) => { if (!cancelled) setBodyError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { if (!cancelled) setBodyLoading(false) })
        return () => { cancelled = true }
      }, [novelId, chapterId, bodyNonce])
      const loadMoreBody = () => {
        if (novel === null || chapterId === '' || bodyLoading || nextCursor === null) return
        setBodyLoading(true)
        void fetchNovelBody(novelId, chapterId, nextCursor, NOVEL_BODY_PAGE_SIZE)
          .then((page) => {
            setParagraphs((current) => [...current, ...page.paragraphs])
            setNextCursor(page.nextCursor)
          })
          .catch((cause) => setBodyError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBodyLoading(false))
      }
      const runAction = (action) => {
        if (busy) return
        setBusy(true)
        setError('')
        setNotice('')
        void Promise.resolve(action())
          .then(() => loadDetail())
          .then(() => { onChanged?.() })
          .catch((cause) => {
            if (isNovelConflict(cause)) setNotice(t('novel.conflict'))
            else setError(cause instanceof Error ? cause.message : String(cause))
            void loadDetail()
          })
          .finally(() => setBusy(false))
      }
      const approve = () => {
        const text = approveRevision.trim()
        const parsed = Number(text)
        if (text === '' || !Number.isFinite(parsed)) {
          setError(t('novel.form.invalidNumbers'))
          return
        }
        runAction(() => runNovelAction(novelId, 'approve-outline', { expectedOutlineRevision: parsed }))
      }
      const openOutline = () => {
        setOutlineOpen(true)
        setOutline(null)
        setOutlineError('')
        void fetchNovelOutline(novelId)
          .then((result) => setOutline(result))
          .catch((cause) => setOutlineError(cause instanceof Error ? cause.message : String(cause)))
      }
      if (novel === null) {
        return h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-editor-toolbar' },
            h(Button, { size: 'sm', variant: 'ghost', onClick: onBack }, `← ${t('novel.back')}`)),
          error !== '' ? h('p', { className: 'dt-error' }, error) : h('p', { className: 'dt-muted' }, t('novel.loadingDetail')))
      }
      const awaitingApproval = novel.status === 'paused' && novel.pauseReason === 'awaiting-approval'
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-editor-toolbar' },
            h('div', { className: 'dt-editor-actions' },
              h(Button, { size: 'sm', variant: 'ghost', onClick: onBack }, `← ${t('novel.back')}`),
              h(Button, {
                size: 'sm',
                variant: 'ghost',
                icon: h(IconRefreshOutline16),
                onClick: () => { setError(''); setNotice(''); void loadDetail().then(() => onChanged?.()) },
              }, t('novel.refresh')))),
          h('div', { className: 'dt-novel-head' },
            h('strong', { className: 'dt-novel-title-text', title: novel.title }, novel.title),
            h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatusId(novel)}` }, novelStatusLabel(t, novel)),
            novel.status === 'paused' && novel.pauseReason
              ? h('span', { className: 'dt-novel-reason' }, novelPauseReasonLabel(t, novel.pauseReason))
              : null,
            novel.phase ? h('span', { className: 'dt-muted' }, novelPhaseLabel(t, novel.phase)) : null),
          h('div', { className: 'dt-novel-meta' },
            h('span', null, t('novel.chapters', { completed: novel.chaptersCompleted ?? 0, total: novel.chaptersTotal ?? 0 })),
            h('span', null, novelCharactersText(t, novel)),
            novel.updatedAt ? h('span', null, t('novel.updatedAt', { time: formatNovelTime(novel.updatedAt) })) : null),
          novel.lastError ? h('p', { className: 'dt-error' }, t('novel.lastError', { message: novel.lastError })) : null,
          novel.pauseDetail ? h('p', { className: 'dt-hint' }, t('novel.pauseDetail', { detail: novelDetailText(novel.pauseDetail) })) : null,
          novel.resumeHint ? h('p', { className: 'dt-hint' }, t('novel.resumeHint', { hint: novelDetailText(novel.resumeHint) })) : null,
          h('div', { className: 'dt-novel-actions' },
            h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => runAction(() => openNovelSession(ctx, novel)) }, t('novel.open')),
            novel.status === 'active'
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'pause')) }, t('novel.pause'))
              : null,
            novel.status === 'paused'
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'resume')) }, t('novel.resume'))
              : null,
            novel.status === 'active' ? h(Button, {
              size: 'sm',
              variant: 'ghost',
              disabled: busy,
              onClick: () => {
                if (window.confirm(t('novel.stopConfirm', { name: novel.title }))) runAction(() => runNovelAction(novelId, 'stop'))
              },
            }, t('novel.stop')) : null,
            awaitingApproval
              ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => runAction(() => runNovelAction(novelId, 'update-outline')) }, t('novel.updateOutline'))
              : null,
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconDownloadOutline16),
              'aria-label': t('novel.exportMd'),
              title: t('novel.exportMd'),
              disabled: busy,
              onClick: () => runAction(() => downloadNovelExport(novelId, 'md', novel.title)),
            }),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconDownloadOutline16),
              'aria-label': t('novel.exportZip'),
              title: t('novel.exportZip'),
              disabled: busy,
              onClick: () => runAction(() => downloadNovelExport(novelId, 'zip', novel.title)),
            }),
            h(Button, { size: 'sm', variant: 'ghost', icon: h(IconListPenOutline16), onClick: openOutline }, t('novel.showOutline'))),
          awaitingApproval ? h('div', { className: 'dt-novel-approve' },
            h('span', { className: 'dt-label' }, t('novel.outlineRevision')),
            h('input', {
              value: approveRevision,
              'aria-label': t('novel.outlineRevision'),
              onChange: (event) => setApproveRevision(event.target.value),
            }),
            h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: approve }, t('novel.approveOutline')),
            h('span', { className: 'dt-muted' }, t('novel.approveHint', { revision: novel.outlineSummary?.outlineRevision ?? '—' }))) : null,
          error ? h('p', { className: 'dt-error' }, error) : null,
          notice ? h('p', { className: 'dt-muted' }, notice) : null),
        h('section', { className: 'dt-settings-band' },
          h('div', { className: 'dt-novel-detail' },
            h('div', { className: 'dt-novel-col' },
              h(NovelChapters, { novel, chapterId, onSelect: setChapterId, t }),
              h(NovelOutlineSummaryBlock, { novel, t })),
            h('div', { className: 'dt-novel-col' },
              h(NovelReaderBlock, {
                novel,
                chapterId,
                paragraphs,
                nextCursor,
                loading: bodyLoading,
                error: bodyError,
                onLoadMore: loadMoreBody,
                t,
              })),
            h('div', { className: 'dt-novel-col' },
              h(NovelAuthorPanel, { novel, t, onOpenSession: () => runAction(() => openNovelSession(ctx, novel)) })))),
        outlineOpen ? h(NovelModalFrame, {
          title: t('novel.outlineTitle'),
          closeLabel: t('panel.close'),
          onClose: () => setOutlineOpen(false),
        },
        outlineError !== ''
          ? h('p', { className: 'dt-error' }, outlineError)
          : outline === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : h('pre', { className: 'dt-novel-outline-pre' }, JSON.stringify(outline, null, 2))) : null)
    }

    function NovelCard({ ctx, novel, t, onDetail, onEdit, onChanged }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const run = (action) => {
        if (busy) return
        setError('')
        setBusy(true)
        void Promise.resolve(action())
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => {
            setBusy(false)
            void onChanged().catch(() => {})
          })
      }
      const awaitingApproval = novel.status === 'paused' && novel.pauseReason === 'awaiting-approval'
      return h('div', { className: 'dt-novel-card' },
        h('div', { className: 'dt-novel-head' },
          h('button', { type: 'button', className: 'dt-novel-title', title: novel.title, onClick: onDetail }, novel.title),
          h('span', { className: `dt-novel-badge dt-novel-badge-${novelStatusId(novel)}` }, novelStatusLabel(t, novel)),
          novel.status === 'paused' && novel.pauseReason
            ? h('span', { className: 'dt-novel-reason', title: novelPauseReasonLabel(t, novel.pauseReason) }, novelPauseReasonLabel(t, novel.pauseReason))
            : null,
          novel.phase ? h('span', { className: 'dt-muted' }, novelPhaseLabel(t, novel.phase)) : null),
        h('div', { className: 'dt-novel-meta' },
          h('span', null, t('novel.chapters', { completed: novel.chaptersCompleted ?? 0, total: novel.chaptersTotal ?? 0 })),
          h('span', null, novelCharactersText(t, novel)),
          novel.updatedAt ? h('span', null, t('novel.updatedAt', { time: formatNovelTime(novel.updatedAt) })) : null),
        novel.lastError ? h('p', { className: 'dt-error' }, t('novel.lastError', { message: novel.lastError })) : null,
        h('div', { className: 'dt-novel-actions' },
          h(Button, { size: 'sm', variant: 'outline', disabled: busy, onClick: () => run(() => openNovelSession(ctx, novel)) }, t('novel.open')),
          novel.status === 'active'
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'pause')) }, t('novel.pause'))
            : null,
          novel.status === 'paused'
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'resume')) }, t('novel.resume'))
            : null,
          novel.status === 'active' ? h(Button, {
            size: 'sm',
            variant: 'ghost',
            disabled: busy,
            onClick: () => {
              if (window.confirm(t('novel.stopConfirm', { name: novel.title }))) run(() => runNovelAction(novel.novelId, 'stop'))
            },
          }, t('novel.stop')) : null,
          awaitingApproval ? h(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: busy,
            onClick: () => run(async () => {
              const detail = await fetchNovelDetail(novel.novelId)
              const revision = detail?.outlineSummary?.outlineRevision
              if (revision === undefined || revision === null) throw new Error(t('novel.loadingDetail'))
              await runNovelAction(novel.novelId, 'approve-outline', { expectedOutlineRevision: revision })
            }),
          }, t('novel.approveOutline')) : null,
          awaitingApproval
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => run(() => runNovelAction(novel.novelId, 'update-outline')) }, t('novel.updateOutline'))
            : null,
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconDownloadOutline16),
            'aria-label': t('novel.exportMd'),
            title: t('novel.exportMd'),
            disabled: busy,
            onClick: () => run(() => downloadNovelExport(novel.novelId, 'md', novel.title)),
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconDownloadOutline16),
            'aria-label': t('novel.exportZip'),
            title: t('novel.exportZip'),
            disabled: busy,
            onClick: () => run(() => downloadNovelExport(novel.novelId, 'zip', novel.title)),
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconEditOutline16),
            'aria-label': t('novel.editTitle'),
            title: t('novel.editTitle'),
            disabled: busy,
            onClick: onEdit,
          }),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconTrashOutline16),
            'aria-label': t('novel.delete', { name: novel.title }),
            title: t('novel.delete', { name: novel.title }),
            disabled: busy,
            onClick: () => {
              if (window.confirm(t('novel.deleteConfirm', { name: novel.title }))) {
                run(() => deleteNovel(novel.novelId))
              }
            },
          })),
        error ? h('p', { className: 'dt-error' }, error) : null)
    }

    const NOVEL_PERSPECTIVES = ['third-person', 'first-person', 'second-person', 'mixed']
    const NOVEL_PERSPECTIVE_LABEL_KEYS = {
      'third-person': 'novel.form.perspective.third',
      'first-person': 'novel.form.perspective.first',
      'second-person': 'novel.form.perspective.second',
      mixed: 'novel.form.perspective.mixed',
    }
    // 运行预算字段描述符：创建与编辑共用同一组输入（编辑面板可改预算以应对长章节）。
    // pick/put 承载表单平铺键与 budgets 嵌套结构（externalRetry）的互转——新增预算
    // 字段只改这一张表，换算/校验/比较/默认值全部自动跟进。
    const NOVEL_BUDGET_FIELDS = [
      { key: 'maxTurns', label: 'novel.form.maxTurns', preset: '200', pick: (b) => b?.maxTurns, put: (b, v) => ({ ...b, maxTurns: v }) },
      { key: 'maxDurationMs', label: 'novel.form.maxDurationMs', preset: '3600000', pick: (b) => b?.maxDurationMs, put: (b, v) => ({ ...b, maxDurationMs: v }) },
      { key: 'stallThresholdTurns', label: 'novel.form.stallThresholdTurns', preset: '6', pick: (b) => b?.stallThresholdTurns, put: (b, v) => ({ ...b, stallThresholdTurns: v }) },
      { key: 'consecutiveFailureLimit', label: 'novel.form.consecutiveFailureLimit', preset: '3', pick: (b) => b?.consecutiveFailureLimit, put: (b, v) => ({ ...b, consecutiveFailureLimit: v }) },
      { key: 'retryMaxAttempts', label: 'novel.form.retryMaxAttempts', preset: '3', pick: (b) => b?.externalRetry?.maxAttempts, put: (b, v) => ({ ...b, externalRetry: { ...b?.externalRetry, maxAttempts: v } }) },
      { key: 'retryBackoffMs', label: 'novel.form.retryBackoffMs', preset: '2000', pick: (b) => b?.externalRetry?.backoffMs, put: (b, v) => ({ ...b, externalRetry: { ...b?.externalRetry, backoffMs: v } }) },
      { key: 'maxDeduceRuns', label: 'novel.form.maxDeduceRuns', preset: '20', pick: (b) => b?.maxDeduceRuns, put: (b, v) => ({ ...b, maxDeduceRuns: v }) },
      // 可选预算字段：留空 = 省略该键（服务端回落到 0007 §5.3 内置默认 3）。
      // optional 标记让旧快照（无此字段）的编辑面板不因空值判无效，也不会
      // 把它从既有 budgets 中抹掉——清空输入即回归默认，与全量编辑语义自洽。
      { key: 'writerDispatchLimit', label: 'novel.form.writerDispatchLimit', preset: '3', optional: true, pick: (b) => b?.writerDispatchLimit, put: (b, v) => (v === null ? { ...b } : { ...b, writerDispatchLimit: v }) },
    ]
    // 产品预设值：提交时传完整配置（提案 §4.1），内部不依赖服务端默认参数；预算默认取自字段描述符。
    const NOVEL_FORM_PRESETS = {
      targetCharacters: '20000',
      toleranceRatio: '0.1',
      ...Object.fromEntries(NOVEL_BUDGET_FIELDS.map((field) => [field.key, field.preset])),
    }

    function novelBudgetsToForm(budgets) {
      return Object.fromEntries(NOVEL_BUDGET_FIELDS.map((field) => [field.key, String(field.pick(budgets) ?? '')]))
    }

    function novelFormToBudgets(form) {
      return NOVEL_BUDGET_FIELDS.reduce((budgets, field) => field.put(budgets, parseNovelPositiveInt(form[field.key])), {})
    }

    function novelBudgetsEqual(left, right) {
      return NOVEL_BUDGET_FIELDS.every((field) => field.pick(left) === field.pick(right))
    }

    /** 表单值与快照预算双方归一化（快照经 form 往返）后比较，判定是否需要下发。 */
    function novelBudgetsChanged(form, budgets) {
      return !novelBudgetsEqual(novelFormToBudgets(form), novelFormToBudgets(novelBudgetsToForm(budgets)))
    }

    function novelFormLanguage() {
      return translate('panel.title') === MESSAGES_ZH['panel.title'] ? 'zh' : 'en'
    }

    function parseNovelPositiveInt(raw) {
      const text = String(raw ?? '').trim()
      if (!/^\d+$/.test(text)) return null
      const value = Number(text)
      return Number.isInteger(value) && value >= 1 ? value : null
    }

    function NovelCheckGrid({ label, options, selected, onToggle, emptyLabel }) {
      return h('div', { className: 'dt-novel-form-wide' },
        h('span', { className: 'dt-label' }, label),
        options.length === 0
          ? h('span', { className: 'dt-muted' }, emptyLabel)
          : h('div', { className: 'dt-check-grid' }, options.map((name) => h('label', { key: name },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(name),
              onChange: (event) => onToggle(name, event.target.checked),
            }),
            h('span', null, name)))))
    }

    function NovelCreateForm({ onClose, onCreated }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [form, setForm] = useState(() => ({
        title: '',
        requirement: '',
        language: novelFormLanguage(),
        genre: '',
        narrativePerspective: 'third-person',
        styleNotes: '',
        lengthKind: 'unbounded',
        hardMaximumCharacters: '',
        maxChapters: '',
        approvalMode: 'automatic',
        writerMode: 'inline',
        characterNames: [],
        worldNames: [],
        ...NOVEL_FORM_PRESETS,
      }))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const set = (key, value) => setForm((current) => ({ ...current, [key]: value }))
      const toggleAsset = (key, name, checked) => setForm((current) => ({
        ...current,
        [key]: checked ? [...current[key], name] : current[key].filter((item) => item !== name),
      }))
      const segmented = (labelKey, value, options) => h('div', { className: 'dt-field' },
        h('span', { className: 'dt-label' }, t(labelKey)),
        h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t(labelKey) },
          options.map((option) => h('button', {
            key: option.value,
            type: 'button',
            className: value === option.value ? 'dt-segmented-active' : '',
            'aria-pressed': value === option.value,
            onClick: () => set(option.key, option.value),
          }, t(option.label)))))
      const submit = () => {
        const titleValue = form.title.trim()
        const requirementValue = form.requirement.trim()
        if (!titleValue || !requirementValue) {
          setError(t('novel.form.missingRequired'))
          return
        }
        const target = form.lengthKind === 'target' ? parseNovelPositiveInt(form.targetCharacters) : null
        const tolerance = Number(String(form.toleranceRatio).trim())
        const hardText = String(form.hardMaximumCharacters).trim()
        const hardMaximum = hardText === '' ? null : parseNovelPositiveInt(hardText)
        const maxChaptersText = String(form.maxChapters).trim()
        const maxChapters = maxChaptersText === '' ? null : parseNovelPositiveInt(form.maxChapters)
        const budgets = novelFormToBudgets(form)
        const lengthValid = form.lengthKind !== 'target'
          || (target !== null
            && Number.isFinite(tolerance) && tolerance >= 0 && tolerance < 1
            && (hardText === '' || hardMaximum !== null)
            && (hardMaximum === null || hardMaximum >= target))
        const maxChaptersValid = maxChaptersText === '' || maxChapters !== null
        if (!lengthValid || !maxChaptersValid || NOVEL_BUDGET_FIELDS.some((field) => !field.optional && field.pick(budgets) === null)) {
          setError(t('novel.form.invalidNumbers'))
          return
        }
        const config = {
          title: titleValue,
          requirement: requirementValue,
          language: form.language === 'en' ? 'en' : 'zh',
          genre: form.genre.trim(),
          narrativePerspective: form.narrativePerspective,
          styleNotes: form.styleNotes.trim(),
          lengthBudget: form.lengthKind === 'target'
            ? { kind: 'target', targetCharacters: target, toleranceRatio: tolerance, hardMaximumCharacters: hardMaximum }
            : { kind: 'unbounded' },
          maxChapters,
          approvalMode: form.approvalMode === 'manual' ? 'manual' : 'automatic',
          writerMode: form.writerMode === 'subagent' ? 'subagent' : 'inline',
          characterNames: [...form.characterNames],
          worldNames: [...form.worldNames],
          budgets,
        }
        setBusy(true)
        setError('')
        void createNovel(config)
          .then((created) => onCreated(created))
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }
      return h(NovelModalFrame, {
        title: t('novel.create'),
        closeLabel: t('panel.close'),
        onClose,
        footer: h(React.Fragment, null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: busy || !form.title.trim() || !form.requirement.trim(), onClick: submit },
            busy ? t('novel.creating') : t('novel.form.submit'))),
      },
      h('div', { className: 'dt-novel-form-grid' },
        h(EditorField, { label: t('novel.form.title'), value: form.title, onChange: (value) => set('title', value) }),
        h('label', { className: 'dt-editor-field' },
          h('span', { className: 'dt-label' }, t('novel.form.language')),
          h('select', {
            value: form.language,
            'aria-label': t('novel.form.language'),
            onChange: (event) => set('language', event.target.value),
          },
          h('option', { value: 'zh' }, t('novel.form.language.zh')),
          h('option', { value: 'en' }, t('novel.form.language.en')))),
        h(EditorField, { label: t('novel.form.genre'), value: form.genre, placeholder: t('novel.form.genrePlaceholder'), onChange: (value) => set('genre', value) }),
        h('label', { className: 'dt-editor-field' },
          h('span', { className: 'dt-label' }, t('novel.form.perspective')),
          h('select', {
            value: form.narrativePerspective,
            'aria-label': t('novel.form.perspective'),
            onChange: (event) => set('narrativePerspective', event.target.value),
          },
          NOVEL_PERSPECTIVES.map((value) => h('option', { key: value, value }, t(NOVEL_PERSPECTIVE_LABEL_KEYS[value]))))),
        h(EditorField, {
          label: t('novel.form.requirement'),
          value: form.requirement,
          onChange: (value) => set('requirement', value),
          multiline: true,
          className: 'dt-novel-form-wide',
          hint: t('novel.form.requirementHint'),
        }),
        h(EditorField, {
          label: t('novel.form.styleNotes'),
          value: form.styleNotes,
          onChange: (value) => set('styleNotes', value),
          multiline: true,
          className: 'dt-novel-form-wide',
        })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.length')),
        h('div', { className: 'dt-novel-form-grid' },
          segmented('novel.form.length', form.lengthKind, [
            { key: 'lengthKind', value: 'unbounded', label: 'novel.form.length.unbounded' },
            { key: 'lengthKind', value: 'target', label: 'novel.form.length.target' },
          ]),
          form.lengthKind === 'target' ? h(React.Fragment, null,
            h(EditorField, { label: t('novel.form.targetCharacters'), value: form.targetCharacters, type: 'number', min: 1, onChange: (value) => set('targetCharacters', value) }),
            h(EditorField, { label: t('novel.form.toleranceRatio'), value: form.toleranceRatio, type: 'number', min: 0, max: 0.99, step: 0.05, onChange: (value) => set('toleranceRatio', value) }),
            h(EditorField, { label: t('novel.form.hardMaximum'), value: form.hardMaximumCharacters, type: 'number', min: 1, onChange: (value) => set('hardMaximumCharacters', value) })) : null,
          h(EditorField, { label: t('novel.form.maxChapters'), value: form.maxChapters, type: 'number', min: 1, onChange: (value) => set('maxChapters', value) }),
          segmented('novel.form.approval', form.approvalMode, [
            { key: 'approvalMode', value: 'automatic', label: 'novel.form.approval.automatic' },
            { key: 'approvalMode', value: 'manual', label: 'novel.form.approval.manual' },
          ]),
          // 写作模式（0007 §8）：与大纲批准同一控件风格；说明只描述上下文有界，
          // 不做成本承诺（账单结论等 W3 实测数据）。预设 inline 直至默认切换。
          segmented('novel.form.writerMode', form.writerMode, [
            { key: 'writerMode', value: 'inline', label: 'novel.form.writerMode.inline' },
            { key: 'writerMode', value: 'subagent', label: 'novel.form.writerMode.subagent' },
          ]),
          h('span', { className: 'dt-hint dt-novel-form-wide' }, t('novel.form.writerMode.hint')))),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.characters')),
        h(NovelCheckGrid, {
          label: t('novel.form.characters'),
          options: state.bootstrap.characters,
          selected: form.characterNames,
          onToggle: (name, checked) => toggleAsset('characterNames', name, checked),
          emptyLabel: t('nav.noCharacters'),
        }),
        h(NovelCheckGrid, {
          label: t('novel.form.worlds'),
          options: state.bootstrap.worlds,
          selected: form.worldNames,
          onToggle: (name, checked) => toggleAsset('worldNames', name, checked),
          emptyLabel: t('settings.worldsEmpty'),
        })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.budgets')),
        h('div', { className: 'dt-novel-form-grid' },
          NOVEL_BUDGET_FIELDS.map((field) => h(EditorField, {
            key: field.key,
            label: t(field.label),
            value: form[field.key],
            type: 'number',
            min: 1,
            onChange: (value) => set(field.key, value),
          })))),
      error ? h('p', { className: 'dt-error' }, error) : null)
    }

    function NovelEditForm({ novel, onClose, onSaved }) {
      const t = useTranslate()
      const [detail, setDetail] = useState(null)
      const [title, setTitle] = useState(novel.title || '')
      const [genre, setGenre] = useState('')
      const [budgets, setBudgets] = useState(null)
      const [writerMode, setWriterMode] = useState('inline')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const applyDetail = (next) => {
        setDetail(next)
        setTitle(typeof next?.title === 'string' ? next.title : novel.title || '')
        setGenre(typeof next?.config?.genre === 'string' ? next.config.genre : '')
        setBudgets(novelBudgetsToForm(next?.config?.budgets))
        setWriterMode(next?.config?.writerMode === 'subagent' ? 'subagent' : 'inline')
      }
      useEffect(() => {
        let cancelled = false
        void fetchNovelDetail(novel.novelId)
          .then((next) => { if (!cancelled) applyDetail(next) })
          .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
        return () => { cancelled = true }
      }, [novel.novelId])
      const setBudgetField = (key, value) => setBudgets((current) => ({ ...current, [key]: value }))
      const save = () => {
        if (busy || detail === null || budgets === null) return
        const patch = {}
        const nextTitle = title.trim()
        const nextGenre = genre.trim()
        if (nextTitle !== '' && nextTitle !== detail.title) patch.title = nextTitle
        if (nextGenre !== (detail.config?.genre ?? '')) patch.genre = nextGenre
        const parsed = novelFormToBudgets(budgets)
        if (NOVEL_BUDGET_FIELDS.some((field) => !field.optional && field.pick(parsed) === null)) {
          setError(t('novel.edit.invalidBudgets'))
          return
        }
        // 预算在 noteTurn 中从快照实时读取（§13），改完下一轮即生效；
        // 未改动的预算不下发，避免无意义的 revision 递增。
        if (novelBudgetsChanged(budgets, detail.config?.budgets)) {
          patch.budgets = parsed
        }
        // 写作模式（0007 §8）：与预算同走既有 PATCH 通道，仅在值变化时下发；
        // 切换只影响下一单元（服务端语义），面板只如实展示与提交。
        const nextWriterMode = writerMode === 'subagent' ? 'subagent' : 'inline'
        const currentWriterMode = detail.config?.writerMode === 'subagent' ? 'subagent' : 'inline'
        if (nextWriterMode !== currentWriterMode) {
          patch.writerMode = nextWriterMode
        }
        if (Object.keys(patch).length === 0) {
          onSaved()
          return
        }
        setBusy(true)
        setError('')
        setNotice('')
        void patchNovel(novel.novelId, detail.revision, patch)
          .then(() => onSaved())
          .catch((cause) => {
            if (isNovelConflict(cause)) {
              // CAS 冲突：自动重取详情并提示（契约要求），保留弹窗让用户重试。
              setNotice(t('novel.conflict'))
              void fetchNovelDetail(novel.novelId)
                .then((next) => applyDetail(next))
                .catch(() => {})
            } else {
              setError(cause instanceof Error ? cause.message : String(cause))
            }
          })
          .finally(() => setBusy(false))
      }
      return h(NovelModalFrame, {
        title: t('novel.editTitle'),
        closeLabel: t('panel.close'),
        onClose,
        footer: h(React.Fragment, null,
          h(Button, { size: 'sm', variant: 'ghost', onClick: onClose }, t('panel.cancel')),
          h(Button, { size: 'sm', variant: 'primary', disabled: busy || detail === null || title.trim() === '', onClick: save },
            busy ? t('settings.importing') : t('panel.save'))),
      },
      h('div', { className: 'dt-novel-form-grid' },
        h(EditorField, { label: t('novel.form.title'), value: title, onChange: setTitle }),
        h(EditorField, { label: t('novel.genre'), value: genre, onChange: setGenre })),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.budgets')),
        h('div', { className: 'dt-novel-form-grid' },
          NOVEL_BUDGET_FIELDS.map((field) => h(EditorField, {
            key: field.key,
            label: t(field.label),
            value: budgets?.[field.key] ?? '',
            type: 'number',
            min: 1,
            disabled: budgets === null,
            onChange: (value) => setBudgetField(field.key, value),
          }))),
        h('p', { className: 'dt-hint' }, t('novel.edit.budgetsHint'))),
      h('div', { className: 'dt-novel-form-section' },
        h('h4', null, t('novel.form.writerMode')),
        h('div', { className: 'dt-novel-form-grid' },
          h('div', { className: 'dt-field' },
            h('span', { className: 'dt-label' }, t('novel.form.writerMode')),
            h('div', { className: 'dt-segmented', role: 'group', 'aria-label': t('novel.form.writerMode') },
              [
                { value: 'inline', label: 'novel.form.writerMode.inline' },
                { value: 'subagent', label: 'novel.form.writerMode.subagent' },
              ].map((option) => h('button', {
                key: option.value,
                type: 'button',
                className: writerMode === option.value ? 'dt-segmented-active' : '',
                'aria-pressed': writerMode === option.value,
                disabled: detail === null,
                onClick: () => setWriterMode(option.value),
              }, t(option.label)))))),
        h('p', { className: 'dt-hint' }, t('novel.form.writerMode.hint')),
        h('p', { className: 'dt-hint' }, t('novel.edit.writerModeHint'))),
      error ? h('p', { className: 'dt-error' }, error) : null,
      notice ? h('p', { className: 'dt-muted' }, notice) : null)
    }

    function formatWorkbenchTime(value) {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
    }

    // 世界书方案字段值（string|number|boolean|null|string[]）的展示形态：
    // 数组按行 join，null 显式可见（可空字段有「跟随全局」语义），标量 String。
    function formatWorldPlanValue(value) {
      if (Array.isArray(value)) return value.join('\n')
      if (value === null) return 'null'
      if (value === undefined) return ''
      return String(value)
    }

    // 工作台方案卡片（提案 0013 P2；世界书面板化同构扩展）：pending 可批准/
    // 拒绝，已决定的显示状态；展开即 diff——卡方案逐字段，世界书方案按条目
    // 分组（#uid + 动作 + 逐字段 当前 → 改为，note 灰字）。
    function WorkbenchPlanCard({ plan, busy, open, onToggle, onDecide }) {
      const t = useTranslate()
      const isWorld = plan.kind === 'world'
      const changes = Array.isArray(plan.changes) ? plan.changes : []
      const entries = Array.isArray(plan.entries) ? plan.entries : []
      const meta = [isWorld
        ? t('workbench.worldMeta', { world: plan.world }) + (plan.op === 'create' ? ` · ${t('workbench.world.newBook')}` : '')
        : plan.character, plan.id]
      if (plan.appliedAt) meta.push(t('workbench.appliedAt', { time: formatWorkbenchTime(plan.appliedAt) }))
      else if (plan.decidedAt) meta.push(t('workbench.decidedAt', { time: formatWorkbenchTime(plan.decidedAt) }))
      else meta.push(formatWorkbenchTime(plan.createdAt))
      const renderFieldChange = (change, key) => h('div', { key, className: 'dt-workbench-change' },
        h('div', { className: 'dt-workbench-change-field' }, change.field),
        h('div', { className: 'dt-workbench-change-values' },
          change.currentValue !== undefined ? h('span', { className: 'dt-workbench-label' }, t('workbench.current')) : null,
          change.currentValue !== undefined
            ? h('pre', { className: 'dt-workbench-old' },
              // 数组值（tags/alternateGreetings/worldbook key 列表）按行 join 展示，避免压成一行
              Array.isArray(change.currentValue) ? change.currentValue.join('\n') : (change.currentValue || ''))
            : null,
          h('span', { className: 'dt-workbench-label' }, t('workbench.new')),
          h('pre', { className: 'dt-workbench-new' },
            Array.isArray(change.newValue) ? change.newValue.join('\n') : formatWorldPlanValue(change.newValue))),
        change.note ? h('p', { className: 'dt-workbench-note' }, change.note) : null)
      return h('div', { className: `dt-workbench-plan${plan.status === 'pending' ? '' : ' dt-workbench-done'}` },
        h('div', { className: 'dt-workbench-plan-head' },
          h('button', {
            type: 'button',
            className: 'dt-workbench-plan-title',
            onClick: onToggle,
            title: open ? t('workbench.hideDiff') : t('workbench.showDiff'),
          },
            h('span', { className: 'dt-workbench-caret' }, open ? '▾' : '▸'),
            h('span', null, plan.title || plan.id)),
          h('span', { className: `dt-workbench-status dt-workbench-status-${plan.status}` }, t(`workbench.status.${plan.status}`)),
          plan.status === 'pending'
            ? h('span', { className: 'dt-workbench-actions' },
                h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => onDecide(plan, true) }, t('workbench.approve')),
                h(Button, { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => onDecide(plan, false) }, t('workbench.reject')))
            : null),
        h('div', { className: 'dt-workbench-meta' }, meta.join(' · ')),
        open ? h('div', { className: 'dt-workbench-diff' },
          isWorld
            ? entries.map((entry, index) => h('div', { key: index, className: 'dt-workbench-entry' },
              h('div', { className: 'dt-workbench-entry-head' },
                h('span', { className: 'dt-workbench-entry-uid' }, `#${entry.uid}`),
                h('span', { className: `dt-workbench-entry-action dt-workbench-entry-action-${entry.action}` }, t(`workbench.world.${entry.action}`))),
              entry.fields.map((change, fieldIndex) => renderFieldChange(change, fieldIndex)),
              entry.note ? h('p', { className: 'dt-workbench-note' }, entry.note) : null))
            : changes.map((change, index) => renderFieldChange(change, index))) : null)
    }

    function PanelWorkbench() {
      const t = useTranslate()
      const [plans, setPlans] = useState(null)
      const [error, setError] = useState('')
      const [busyId, setBusyId] = useState('')
      const [openId, setOpenId] = useState('')
      const reload = () => loadWorkbenchPlans('all')
        .then((result) => { setPlans(Array.isArray(result.plans) ? result.plans : []); setError(''); return result })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })
      useEffect(() => { void reload() }, [])
      const decide = (plan, approve) => {
        if (busyId !== '') return
        setBusyId(plan.id)
        setError('')
        void decideWorkbenchPlan(plan.id, approve)
          .then(() => {
            // 批准会写入资产（角色卡/世界书/预设）：立即重取 bootstrap，角色卡
            // 分区与侧栏不必等下一次水位轮询就同步到新内容。
            if (approve === true) void refreshBootstrap().catch(() => {})
            return reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusyId(''))
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.section.workbench')),
          h('p', { className: 'dt-hint' }, t('workbench.hint')),
          h('div', { className: 'dt-imports' },
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('workbench.refresh')))),
        h('section', { className: 'dt-settings-band' },
          error ? h('p', { className: 'dt-error' }, error) : null,
          plans === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : plans.length === 0
              ? h('p', { className: 'dt-muted' }, t('workbench.empty'))
              : h('div', { className: 'dt-workbench-list' },
                plans.map((plan) => h(WorkbenchPlanCard, {
                  key: plan.id,
                  plan,
                  busy: busyId === plan.id,
                  open: openId === plan.id,
                  onToggle: () => setOpenId(openId === plan.id ? '' : plan.id),
                  onDecide: decide,
                })))))
    }

    function PanelNovels({ ctx }) {
      const state = useTavernStore()
      const t = useTranslate()
      const [novels, setNovels] = useState(null)
      const [error, setError] = useState('')
      const [selected, setSelected] = useState('')
      const [creating, setCreating] = useState(false)
      const [editing, setEditing] = useState(null)
      const capability = state.bootstrap.agentNovel || { available: false, missing: [], reasons: [] }
      const unavailableReason = capability.reasons?.length ? capability.reasons.join(' ')
        : capability.missing?.length ? capability.missing.join(', ') : ''
      const reload = () => fetchNovelList()
        .then((list) => { setNovels(list); setError(''); return list })
        .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); return null })
      useEffect(() => { void reload() }, [])
      if (selected !== '') {
        return h(NovelDetail, {
          ctx,
          novelId: selected,
          onBack: () => setSelected(''),
          onChanged: () => { void reload() },
        })
      }
      return h(React.Fragment, null,
        h('section', { className: 'dt-settings-band' },
          h('h3', null, t('panel.section.novels')),
          h('div', { className: 'dt-imports' },
            h(Button, {
              size: 'sm',
              variant: 'primary',
              icon: h(IconPlusOutline16),
              disabled: capability.available !== true,
              title: capability.available !== true && unavailableReason !== ''
                ? t('novel.createUnavailable', { reason: unavailableReason })
                : undefined,
              onClick: () => setCreating(true),
            }, t('novel.create')),
            h(Button, {
              size: 'sm',
              variant: 'ghost',
              icon: h(IconRefreshOutline16),
              onClick: () => { setError(''); void reload() },
            }, t('novel.refresh'))),
          capability.available !== true
            ? h('p', { className: 'dt-hint' }, t('novel.createUnavailable', { reason: unavailableReason || '—' }))
            : null),
        h('section', { className: 'dt-settings-band' },
          novels === null
            ? h('p', { className: 'dt-muted' }, t('nav.loading'))
            : novels.length === 0
              ? h('p', { className: 'dt-muted' }, t('novel.empty'))
              : h('div', { className: 'dt-novel-list' }, novels.map((novel) => h(NovelCard, {
                key: novel.novelId,
                ctx,
                novel,
                t,
                onDetail: () => setSelected(novel.novelId),
                onEdit: () => setEditing(novel),
                onChanged: reload,
              }))),
          error ? h('p', { className: 'dt-error' }, error) : null),
        creating ? h(NovelCreateForm, {
          onClose: () => setCreating(false),
          onCreated: (created) => {
            setCreating(false)
            void reload().then((list) => {
              if (list !== null && created?.novelId) setSelected(created.novelId)
            })
          },
        }) : null,
        editing ? h(NovelEditForm, {
          novel: editing,
          onClose: () => setEditing(null),
          onSaved: () => { setEditing(null); void reload() },
        }) : null)
    }

    function TavernPanel({ ctx, useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      // 分区跟随 store 的 panelSection（openPanel(section) 可在面板已打开时切换，
      // 例如小说会话头的“打开小说面板”入口）；导航点击同步写回 store。
      const section = state.panelSection || 'overview'
      useEffect(() => { if (state.loading) void refreshBootstrap().catch(() => {}) }, [])
      const stamp = state.bootstrap.version || state.bootstrap.commit
        ? `v${state.bootstrap.version || '?'}${state.bootstrap.commit ? ` (${state.bootstrap.commit})` : ''}`
        : ''
      const body = section === 'overview' ? h(PanelOverview)
        : section === 'characters' ? h(PanelCharacters, { ctx })
        : section === 'chats' ? h(TavernSidebar, { ctx, useSessions })
        : section === 'guides' ? h(PanelGuides, { useSessions })
        : section === 'novels' ? h(PanelNovels, { ctx })
        : section === 'groups' ? h(GroupBand)
        : section === 'personas' ? h(PersonaBand)
        : section === 'worlds' ? h(PanelWorlds)
        : section === 'presets' ? h(PanelPresets)
        : section === 'scripts' ? h(PanelScripts)
        : section === 'regex' ? h(RegexBand)
        : section === 'variables' ? h(PanelVariables, { useSessions })
        : section === 'workbench' ? h(PanelWorkbench)
        : h(PanelOverview)
      return h('div', { className: 'dt-panel' },
        h('nav', { className: 'dt-panel-nav', 'aria-label': t('panel.nav') },
          h('div', { className: 'dt-panel-brand' },
            h(IconSparkle16),
            h('div', { className: 'dt-panel-brand-copy' },
              h('strong', null, 'Tavern'),
              stamp ? h('span', null, stamp) : null)),
          PANEL_SECTIONS.map((item) => h('button', {
            key: item.id,
            type: 'button',
            className: `dt-panel-navcell ${section === item.id ? 'dt-panel-navcell-active' : ''}`,
            'aria-current': section === item.id ? 'page' : undefined,
            onClick: () => update({ panelSection: item.id }),
          }, h(item.icon), h('span', null, t(`panel.section.${item.id}`))))),
        h('div', { className: 'dt-panel-main' },
          h('header', { className: 'dt-panel-header' },
            h('h2', null, t(`panel.section.${PANEL_SECTIONS.some((item) => item.id === section) ? section : 'overview'}`)),
            h('button', {
              type: 'button',
              className: 'dt-panel-close',
              'aria-label': t('panel.close'),
              onClick: closePanel,
            }, h(IconCloseOutline16))),
          h('div', { className: 'dt-panel-body' }, body)))
    }

    // shell.overlay 占用者：常驻挂载，四件事——隐藏原生树中的 Tavern 会话、
    // 侧边栏会话树注入（快速切换）、会话绑定清理、Tavern 管理面板。
    function PanelHost({ useSessions }) {
      const state = useTavernStore()
      const t = useTranslate()
      const sessionIds = useSessions((value) => value.ids)
      const sessionPhase = useSessions((value) => value.phase)
      const currentSession = useCurrentSessionId(useSessions)
      const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})
      const currentBinding = currentSession ? state.bootstrap.state.sessionBindings?.[currentSession] : null
      // AgentTavern stays hidden from the native session tree, but its native
      // conversation view must not be forced into the legacy Tavern tab.
      useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))
      useNativeSessionTreeFilter(bindingIds, PanelHost.context, [state.bootstrap.internalWorkspace?.path, state.bootstrap.workbenchWorkspace?.path].filter(Boolean).join('\u0000'))
      const host = useSidebarHost()
      useEffect(() => {
        if (sessionPhase !== 'ready') return
        if (bindingIds.every((sessionId) => sessionIds.includes(sessionId))) return
        void api('bindings/prune', {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ sessionIds }),
        }).then((result) => update({ bootstrap: { ...snapshot.bootstrap, state: result.state } })).catch(() => {})
      }, [sessionPhase, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      // 存量修复：旧版本激活的绑定会话在宿主侧仍是 blank（无 turn/start），会被
      // 原生「新建会话」的 blank 复用逻辑劫持。会话列表就绪后对宿主仍标记 blank
      // 的绑定会话统一修复（repairBinding 幂等、失败可重试；点击聊天/Tavern 视图
      // 挂载两个路径也会补触发）。
      useEffect(() => {
        if (sessionPhase !== 'ready' || state.loading) return
        const ctx = PanelHost.context
        const byId = ctx?.sessions?.list?.getSnapshot?.().byId
        if (!byId) return
        for (const [sessionId, binding] of Object.entries(snapshot.bootstrap.state.sessionBindings || {})) {
          if (byId[sessionId]?.blank !== true) continue
          void repairBinding(ctx, sessionId, binding)
        }
      }, [sessionPhase, state.loading, sessionIds.join('\u0000'), bindingIds.join('\u0000')])
      useEffect(() => {
        const toggle = () => update({ panelOpen: !snapshot.panelOpen })
        window.addEventListener('dsh-tavern:toggle-panel', toggle)
        return () => window.removeEventListener('dsh-tavern:toggle-panel', toggle)
      }, [])
      // 后台写入（写卡 Agent 等）没有推送通道：页面可见期间按 3s 轮询 store
      // 变更水位，水位一变就重取 bootstrap——角色卡/世界书/预设与侧栏自动吸收，
      // 不再需要手动刷新网页。refreshing 防抖避免慢请求期间重复触发。
      useEffect(() => {
        let disposed = false
        let refreshing = false
        const check = () => {
          if (disposed || refreshing || document.visibilityState === 'hidden') return
          refreshing = true
          void fetchStoreRevision()
            .then((revision) => {
              if (disposed || revision === '' || revision === snapshot.bootstrap.storeRevision) return undefined
              return refreshBootstrap()
            })
            .catch(() => {})
            .finally(() => { refreshing = false })
        }
        const timer = setInterval(check, STORE_REVISION_POLL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      }, [])
      // 打开面板先无条件重取一次：不等下一拍水位轮询，打开即最新。
      useEffect(() => {
        if (!state.panelOpen) return
        void refreshBootstrap().catch(() => {})
      }, [state.panelOpen])
      return h(React.Fragment, null,
        host ? createPortal(h(TavernSidebar, { ctx: PanelHost.context, useSessions }), host) : null,
        h(Modal, {
          open: state.panelOpen,
          onClose: closePanel,
          title: t('panel.title'),
          closeLabel: t('panel.close'),
          headless: true,
          className: 'dt-panel-modal',
        }, h(TavernPanel, { ctx: PanelHost.context, useSessions })))
    }

    // 常驻侧栏 footer 主入口（与宿主 Settings 按钮同排）：点击打开 Tavern 管理面板。
    // 与原生 Settings trigger 同款：宽栏 34px 行，rail 36px 圆形图标钮。
    function SidebarFooterAction({ wide }) {
      const t = useTranslate()
      const button = h('button', {
        type: 'button',
        className: `dt-footer-action ${wide ? 'dt-footer-action-wide' : 'dt-footer-action-rail'}`,
        'aria-label': t('panel.open'),
        title: t('panel.title'),
        onClick: () => openPanel(),
      }, h(IconSparkle16, { size: wide ? 16 : 18 }), wide ? h('span', { className: 'dt-footer-label' }, t('nav.title')) : null)
      return wide ? button : h(Tooltip, { label: t('panel.open'), side: 'right' }, button)
    }

    function installStyle() {
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-tavern'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = `
         [data-dsh-tavern-native-hidden],[data-dsh-tavern-tab-hidden],[data-dsh-tavern-agent-preset-hidden]{display:none!important}
        .dt-settings{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:0;min-height:100%;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-settings-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings h2{font-size:20px;line-height:28px;margin:0;font-weight:600}.dt-settings-heading p{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;margin:4px 0 0}.dt-settings-version{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:2px 0 0;user-select:text}.dt-settings-band{padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-settings-band h3{font-size:14px;line-height:20px;margin:0 0 14px;font-weight:600}.dt-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}.dt-field{display:flex;flex-direction:column;gap:6px}.dt-label{color:var(--dsw-alias-label-secondary);font-size:12px}.dt-field select{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-toggle,.dt-check-grid label{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}.dt-toggle{min-height:36px}.dt-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 20px}.dt-imports{display:flex;gap:8px;flex-wrap:wrap}.dt-upload{position:relative;cursor:pointer;height:34px;display:inline-flex;align-items:center;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:13px}.dt-upload input{position:absolute;inset:0;opacity:0;cursor:pointer}.dt-upload-error{color:var(--dsw-alias-state-error-primary);margin-left:5px}.dt-error,.dt-run-error,.dt-sidebar-error{color:var(--dsw-alias-state-error-primary)}.dt-muted{color:var(--dsw-alias-label-tertiary)}
         .dt-view{box-sizing:border-box;width:100%;max-width:780px;margin:0 auto;display:flex;flex-direction:column;min-height:100%;padding:8px 16px 28px;color:var(--dsw-alias-label-primary);letter-spacing:0}.dt-empty{min-height:300px;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px}.dt-message-actions button,.dt-header-character button,.dt-sidebar button,.dt-footer-action{color:inherit;background:transparent;border:0;cursor:pointer}.dt-message-actions button:hover,.dt-header-character button:hover,.dt-sidebar button:hover,.dt-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-view button:disabled,.dt-composer button:disabled,.dt-sidebar button:disabled{cursor:not-allowed;opacity:.45}.dt-transcript{display:flex;flex-direction:column;gap:22px;padding:22px 4px}.dt-message{display:flex;gap:10px;max-width:88%;min-width:0}.dt-message-user{align-self:flex-end}.dt-message-character{align-self:flex-start}.dt-message-avatar{width:30px;height:30px;object-fit:cover;border-radius:6px;flex:none}.dt-message-body{display:flex;flex-direction:column;gap:4px;min-width:0}.dt-message-user .dt-message-body{align-items:flex-end}.dt-message-name{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.dt-message-copy{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-raised,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l2)}.dt-message-user .dt-message-copy{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,var(--dsw-alias-bg-base))}.dt-message-frontend{width:min(760px,82vw);max-width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}.dt-frontend-frame{display:block;width:100%;border:0;background:transparent;transition:height 180ms ease}.dt-message-actions{display:flex;align-items:center;gap:4px;min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dt-message-actions button{min-width:24px;height:24px;border-radius:5px;display:inline-grid;place-items:center;padding:0 5px}.dt-message-edit{box-sizing:border-box;width:min(620px,70vw);max-width:100%;min-height:100px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:9px;font:inherit;line-height:1.55}.dt-transcript-end{height:1px;flex:none}.dt-message-error{max-width:620px;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}.dt-run-error{padding:7px 12px;font-size:12px}
         .dt-composer-wrap{box-sizing:border-box;width:100%;padding:6px var(--dsh-composer-side-clearance,16px) 14px;pointer-events:auto}.dt-composer{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);padding:10px 10px 8px;box-shadow:0 2px 10px rgba(0,0,0,.06)}.dt-composer textarea{box-sizing:border-box;width:100%;min-height:52px;max-height:200px;resize:vertical;border:0;outline:0;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;font-size:14px;line-height:1.5}.dt-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:30px;font-size:11px}.dt-composer-row>span{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dt-composer-actions{display:flex;align-items:center;gap:8px;flex:none}.dt-primary-icon{width:30px;height:30px;border:0;border-radius:7px;display:grid;place-items:center;background:var(--dsw-alias-state-business-primary);color:#fff;cursor:pointer}.dt-header-character{min-width:0;display:flex;align-items:center;gap:7px;padding:2px 4px 2px 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font-size:12px}.dt-header-character>img{width:20px;height:20px;border-radius:4px;object-fit:cover;flex:none}.dt-header-character-copy{display:flex;flex-direction:column;min-width:0;max-width:min(520px,55vw);gap:0}.dt-header-character-name{max-width:100%;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;line-height:16px}.dt-header-stats{display:block;max-width:100%;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.dt-header-character>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center;flex:none}
        .dt-model-select{min-width:0;position:relative}.dt-model-trigger{min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:flex}.dt-model-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dt-model-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}.dt-model-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-trigger-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.dt-model-trigger-effort{color:var(--dsw-alias-label-caption);flex:none}.dt-model-chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s}.dt-model-chevron-open{transform:rotate(180deg)}.dt-model-menu{z-index:20;border:1px solid var(--dsw-alias-border-inverted);background:var(--dsw-specific-menu);width:min(240px,100vw - 32px);max-height:min(360px,100vh - 96px);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;padding:4px;display:flex;position:absolute;bottom:calc(100% + 8px);right:0;overflow:hidden}.dt-model-status,.dt-model-empty{color:var(--dsw-alias-label-tertiary);padding:10px;font-size:13px;line-height:20px}.dt-model-error,.dt-model-warning{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-radius:8px;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:4px;padding:7px 8px;font-size:12px;line-height:18px;display:flex}.dt-model-warning{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-label)}.dt-model-retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-weight:600}.dt-model-groups{min-height:0;overflow-y:auto}.dt-model-group+.dt-model-group{margin-top:4px}.dt-model-group-title{z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-tertiary);padding:5px 8px 3px;font-size:12px;font-weight:500;line-height:18px;position:sticky;top:0}.dt-model-option{width:100%;min-height:38px;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;border-radius:10px;outline:none;align-items:center;gap:8px;padding:6px 8px;display:flex}.dt-model-option:hover:not(:disabled),.dt-model-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-option:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}.dt-model-option-copy{flex-direction:column;flex:1;min-width:0;display:flex}.dt-model-name{color:inherit;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;overflow:hidden}.dt-model-description{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}.dt-model-check{color:var(--dsw-alias-label-primary);flex:0 0 18px;place-items:center;display:grid}.dt-model-cell{width:100%;height:40px;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;background:0 0;border:none;border-radius:10px;align-items:center;gap:8px;padding:0 10px;font-size:14px;line-height:22px;display:flex}.dt-model-cell:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-model-cell-label{text-overflow:ellipsis;white-space:nowrap;flex:auto;min-width:0;overflow:hidden}.dt-model-cell-value{text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:0 auto;overflow:hidden}.dt-model-cell-chevron{color:var(--dsw-alias-label-tertiary);flex:none}
        [data-dsh-tavern-sidebar-host]{flex:none;margin:0 0 6px;padding-right:var(--dsh-session-list-edge-inset,8px)}.dt-sidebar{box-sizing:border-box;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}.dt-sidebar-heading{display:flex;align-items:center;justify-content:space-between;height:30px;padding:0 5px;color:var(--dsw-alias-label-secondary)}.dt-sidebar-heading>span{display:flex;align-items:center;gap:6px;font-size:12px}.dt-sidebar-heading>button{width:26px;height:26px;border-radius:6px}.dt-character-group{margin-top:2px}.dt-character-row{display:flex;align-items:center;gap:2px}.dt-character-toggle{height:32px;min-width:0;flex:1;display:flex;align-items:center;gap:5px;border-radius:6px;padding:0 5px;text-align:left}.dt-character-toggle svg{transform:rotate(-90deg);transition:transform .15s}.dt-character-toggle svg.dt-chevron-open{transform:rotate(0)}.dt-character-toggle img{width:22px;height:22px;border-radius:5px;object-fit:cover}.dt-character-toggle span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.dt-character-row>button:last-child{width:28px;height:28px;display:grid;place-items:center;border-radius:6px;flex:none}.dt-sidebar-chats{display:flex;flex-direction:column;margin:1px 0 4px 28px}.dt-sidebar-chat-row{height:28px;border-radius:6px;display:grid;grid-template-columns:minmax(0,1fr) repeat(3,26px);align-items:center;color:var(--dsw-alias-label-secondary)}.dt-sidebar-chat-open{height:28px;min-width:0;text-align:left;padding:0 7px;color:inherit;font-size:12px}.dt-sidebar-chat-open span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){width:26px;height:26px;display:grid;place-items:center;border-radius:5px;opacity:0}.dt-sidebar-chat-row:hover>button:not(.dt-sidebar-chat-open),.dt-sidebar-chat-row:focus-within>button:not(.dt-sidebar-chat-open){opacity:1}.dt-sidebar-chat-row.dt-sidebar-chat-active{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}.dt-sidebar-status,.dt-sidebar-error{padding:4px 7px;font-size:11px;line-height:16px}.dt-footer-action{box-sizing:border-box;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;font-family:inherit;display:flex;align-items:center;overflow:hidden}.dt-footer-action-wide{width:calc(100% + 8px);height:34px;flex:none;justify-content:flex-start;gap:8px;margin:4px -4px;padding:6px 2px 6px 10px;border-radius:12px;font-size:14px;line-height:22px}.dt-footer-action-wide:hover{background:var(--dsw-alias-interactive-bg-hover)}.dt-footer-action-rail{width:36px;height:36px;flex:none;justify-content:center;gap:0;margin:8px 0 10px;padding:0;border-radius:50%}.dt-footer-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:22px}
         @media(max-width:700px){[role="dialog"]:has(.dt-settings){flex-direction:column}[role="dialog"]:has(.dt-settings)>nav{box-sizing:border-box;width:100%;height:auto;max-height:190px;flex:none;overflow-y:auto;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}[role="dialog"]:has(.dt-settings)>nav>:last-child{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:auto}[role="dialog"]:has(.dt-settings)>nav>:last-child>button{width:100%;min-width:0}[role="dialog"]:has(.dt-settings)>:not(nav){width:100%;min-width:0;flex:1}.dt-settings-heading{padding:16px}.dt-settings-band{padding:16px}.dt-settings-grid,.dt-check-grid{grid-template-columns:1fr}.dt-view{padding-inline:10px}.dt-transcript-end{height:132px}.dt-message{max-width:94%}.dt-header-character-copy{max-width:min(340px,52vw)}.dt-header-stats{max-width:100%}.dt-composer-wrap{padding-inline:8px}.dt-model-trigger{max-width:140px}.dt-message-edit{width:78vw}.dt-sidebar-chat-row>button:not(.dt-sidebar-chat-open){opacity:1}}
        .dt-persona-list{display:flex;flex-direction:column;gap:6px}.dt-persona-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dt-persona-avatar{width:34px;height:34px;border-radius:6px;object-fit:cover;flex:none}.dt-persona-copy{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.dt-persona-copy span{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-persona-actions{display:flex;gap:2px}.dt-persona-actions button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-persona-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-group-create{display:flex;flex-direction:column;gap:8px;margin:10px 0;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}.dt-group-list{display:flex;flex-direction:column;gap:12px}.dt-group-manage{display:flex;flex-direction:column;gap:6px}.dt-group-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dt-group-title>span{color:var(--dsw-alias-label-tertiary);font-size:12px}.dt-group-title select{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-base);padding:0 6px}.dt-group-title>button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}.dt-group-members{display:flex;flex-wrap:wrap;gap:6px}
        .dt-member-chip{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px 0 3px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:transparent;color:inherit;font-size:12px;cursor:pointer}.dt-member-chip>img{width:22px;height:22px;border-radius:50%;object-fit:cover}.dt-member-chip-off{opacity:.45}.dt-member-chip-off>span{text-decoration:line-through}.dt-member-chip-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}.dt-member-chip>button{color:inherit;background:transparent;border:0;cursor:pointer;padding:0 2px;font-size:11px}
        .dt-regex-list{display:flex;flex-direction:column;gap:6px}.dt-regex-row{display:flex;align-items:center;gap:10px;min-height:36px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dt-regex-row.dt-regex-off{opacity:.5}.dt-regex-row>.dt-toggle{flex:1;min-width:0}.dt-regex-row>.dt-muted{font-family:monospace;font-size:11px;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dt-regex-row>button{width:28px;height:28px;border-radius:6px;display:grid;place-items:center;color:inherit;background:transparent;border:0;cursor:pointer}
        .dt-field input[type=text],.dt-field input[type=password]{box-sizing:border-box;width:100%;height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 10px}.dt-upload:disabled{opacity:.5;cursor:not-allowed}
        .dt-backlink{display:flex;padding:2px 0}.dt-backlink>button{color:var(--dsw-alias-label-tertiary);background:transparent;border:0;cursor:pointer;font-size:12px;padding:4px 2px}.dt-backlink>button:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
        .dt-member-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.dt-member-row .dt-member-chip>button{display:none}.dt-script-glyph{font-weight:700;font-size:15px;line-height:1}.dt-sidebar-subheading{margin-top:10px}.dt-branch-btn{font-size:13px}
        .dt-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0 0 12px}.dt-hint-wide{grid-column:1 / -1;margin:0 0 12px}
        .dt-settings-update{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
        .dt-update-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .dt-update-stamp{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;user-select:text}
        .dt-update-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;line-height:1;font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
        .dt-update-badge-available{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
        .dt-update-badge-pending{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary));border-color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary))}
        .dt-update-badge-current{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}
        .dt-update-badge-unknown{opacity:.75}
        .dt-update-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 12px}
        .dt-update-notes{margin:0 0 12px}
        .dt-update-notes-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
        .dt-update-notes ul{margin:6px 0 0;padding-left:18px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-update-log{margin:0 0 12px;padding:8px 10px;max-height:132px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-tertiary);font-family:monospace;font-size:11px;line-height:16px;white-space:pre-wrap}
        .dt-panel-modal{pointer-events:auto;width:min(1080px,calc(100vw - 48px));height:min(700px,calc(100vh - 64px));max-width:100%;max-height:100%;padding:0;gap:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
        .dt-panel{display:flex;width:100%;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0;background:var(--dsw-alias-bg-base);border-radius:12px;overflow:hidden}
        .dt-panel-nav{display:flex;flex-direction:column;gap:2px;width:198px;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}
        .dt-panel-brand{display:flex;align-items:center;gap:9px;padding:4px 8px 12px;color:var(--dsw-alias-label-primary)}
        .dt-panel-brand>svg{color:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary));flex:none}
        .dt-panel-brand-copy{display:flex;flex-direction:column;min-width:0}
        .dt-panel-brand-copy strong{font-size:14px;line-height:18px}
        .dt-panel-brand-copy span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;user-select:text}
        .dt-panel-navcell{display:flex;align-items:center;gap:9px;min-height:34px;padding:0 9px;border:0;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:13px;line-height:18px;text-align:left}
        .dt-panel-navcell>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-panel-navcell:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-panel-navcell-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
        .dt-panel-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
        .dt-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dt-panel-header h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
        .dt-panel-close{width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}
        .dt-panel-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-panel-body{flex:1;min-height:0;overflow-y:auto}
        .dt-panel-body .dt-sidebar{padding:0 4px}
        .dt-card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
        .dt-card{display:flex;flex-direction:column;gap:9px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-card-editing{grid-column:1 / -1;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
        .dt-card-head{display:flex;align-items:center;gap:9px}
        .dt-card-head>img{width:40px;height:40px;border-radius:8px;object-fit:cover;flex:none}
        .dt-card-title{display:flex;flex-direction:column;min-width:0;flex:1}
        .dt-card-title strong{font-size:14px;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-card-title span{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-card-fields{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}
        .dt-card-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:28px;border:0;padding:0 2px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:12px;text-align:left}
        .dt-card-field-head:hover{color:var(--dsw-alias-label-primary)}
        .dt-card-field-head svg{transform:rotate(-90deg);transition:transform .15s}
        .dt-card-field-head .dt-chevron-open{transform:rotate(0)}
        .dt-card-copy{max-height:220px;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6;padding:2px 2px 8px;border-radius:6px}
        .dt-world-list{display:flex;flex-direction:column;gap:6px}
        .dt-world-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
        .dt-world-row>.dt-toggle{flex:1;min-width:0}
        .dt-entry-list{display:flex;flex-direction:column;gap:6px}
        .dt-entry{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;font-size:13px}
        .dt-entry-off{opacity:.55}
        .dt-entry-head{display:flex;flex-direction:column;gap:1px}
        .dt-entry-keys{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-entry-content{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:160px;overflow-y:auto}
        .dt-preset-list{display:flex;flex-direction:column;gap:6px}
        .dt-preset-row{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;flex-wrap:wrap}
        .dt-preset-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
        .dt-preset-editor-wrap{flex-basis:100%;min-width:0;border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px}
        .dt-editor{display:flex;flex-direction:column;gap:12px;min-width:0}
        .dt-editor-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;flex-wrap:wrap}
        .dt-editor-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-editor-actions{display:flex;align-items:center;gap:6px}
        .dt-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .dt-editor-field{display:flex;flex-direction:column;gap:5px;min-width:0}
        .dt-editor-field input,.dt-editor-field textarea,.dt-editor-field select{box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:7px 9px;font:inherit;font-size:13px;line-height:18px;outline:none}
        .dt-editor-field input:focus,.dt-editor-field textarea:focus,.dt-editor-field select:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-editor-field textarea{min-height:108px;resize:vertical;white-space:pre-wrap}
        .dt-editor-field.dt-editor-json textarea{min-height:180px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .dt-editor-wide{grid-column:1 / -1}
        .dt-editor-section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:4px}
        .dt-editor-entries{display:flex;flex-direction:column;gap:10px}
        .dt-editor-entry{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
        .dt-editor-entry-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}
        .dt-editor-toggles{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-top:3px}
        .dt-editor-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer}
        .dt-editor-toggle input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
        .dt-kv-list{display:flex;flex-direction:column;gap:6px;max-width:640px}
        .dt-kv-row{display:grid;grid-template-columns:minmax(110px,200px) 1fr 28px;gap:8px;align-items:center}
        .dt-kv-readonly>span{font-size:13px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-kv-key{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
        .dt-kv-value{color:var(--dsw-alias-label-primary)}
        .dt-architecture-settings{display:flex;flex-direction:column;gap:10px;margin-top:14px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-segmented{display:inline-flex;align-items:stretch;align-self:flex-start;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;overflow:hidden}
        .dt-segmented button{min-height:32px;padding:0 12px;border:0;border-right:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);cursor:pointer;font:inherit;font-size:12px}
        .dt-segmented button:last-child{border-right:0}
        .dt-segmented button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-segmented button:disabled{cursor:not-allowed;opacity:.45}
        .dt-segmented .dt-segmented-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
        .dt-architecture-badge{display:inline-flex;align-items:center;align-self:flex-start;min-height:18px;padding:0 6px;border-radius:4px;font-size:10px;line-height:18px;font-weight:600;white-space:nowrap}
        .dt-architecture-agent-tavern{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-architecture-st{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-sidebar-chat-open{display:flex;align-items:center;gap:6px}
        .dt-sidebar-chat-open>span:first-child{min-width:0;flex:1}
        .dt-chat-architecture{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;white-space:nowrap}
        .dt-audit{display:flex;flex-direction:column;gap:8px}
        .dt-audit-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-audit h4{margin:10px 0 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}
        .dt-audit-list{display:flex;flex-direction:column;gap:6px}
        .dt-audit-row{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base))}
        .dt-audit-row-inactive{opacity:.65}
        .dt-audit-row-head{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
        .dt-audit-row-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
        .dt-audit-row p{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-audit-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}
        .dt-audit-row pre{margin:0;max-height:120px;overflow:auto;color:var(--dsw-alias-label-primary);font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-tc-state{display:inline-flex;align-items:center;padding:0 4px}
        .dt-header-character{padding:0;border:0;border-radius:0}
        @media(max-width:700px){.dt-panel{flex-direction:column}.dt-panel-nav{width:100%;flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dt-panel-brand{padding:4px 8px}.dt-panel-brand-copy{display:none}.dt-panel-navcell{flex:none}.dt-card-grid{grid-template-columns:1fr}.dt-kv-row{grid-template-columns:1fr 1fr 28px}.dt-editor-grid{grid-template-columns:1fr}.dt-editor-wide{grid-column:auto}.dt-editor-toolbar{align-items:flex-start}.dt-preset-row{align-items:flex-start}.dt-preset-name{flex-basis:100%}}
        .dt-novel-badge{display:inline-flex;align-items:center;min-height:18px;padding:0 7px;border-radius:9px;font-size:10px;line-height:18px;font-weight:600;white-space:nowrap}
        .dt-novel-badge-active{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-novel-badge-paused{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-badge-completed{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-list{display:flex;flex-direction:column;gap:10px}
        .dt-novel-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-novel-card .dt-error,.dt-novel-detail .dt-error{margin:0}
        .dt-novel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-novel-title{min-width:0;flex:1;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:14px;font-weight:600;padding:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-title:hover{color:var(--dsw-alias-state-business-primary)}
        .dt-novel-title-text{font-size:14px;line-height:20px;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-reason{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}
        .dt-novel-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
        .dt-novel-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-novel-detail{display:grid;grid-template-columns:210px minmax(0,1fr) 250px;gap:14px;align-items:start}
        .dt-novel-col{display:flex;flex-direction:column;gap:12px;min-width:0}
        .dt-novel-block{display:flex;flex-direction:column;gap:6px;min-width:0}
        .dt-novel-block h4{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-novel-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
        .dt-novel-toc{display:flex;flex-direction:column;gap:2px}
        .dt-novel-chapter{display:flex;flex-direction:column;gap:1px;align-items:flex-start;text-align:left;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;padding:5px 6px;border-radius:6px}
        .dt-novel-chapter:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-novel-chapter-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}
        .dt-novel-chapter-title{font-size:13px;line-height:18px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-novel-chapter-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
        .dt-novel-paragraphs{display:flex;flex-direction:column;gap:12px}
        .dt-novel-paragraph{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-primary)}
        .dt-novel-reqs{display:flex;flex-direction:column;gap:6px}
        .dt-novel-req{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px}
        .dt-novel-req-head{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:11px;line-height:16px}
        .dt-novel-req-status{font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-novel-req-blocked .dt-novel-req-status{color:var(--dsw-alias-state-error-primary)}
        .dt-novel-req-text{margin:0;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-novel-req-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;overflow-wrap:anywhere}
        .dt-novel-kv{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
        .dt-novel-kv span{overflow-wrap:anywhere}
        .dt-novel-fores{display:flex;flex-direction:column;gap:4px}
        .dt-novel-fore{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:17px}
        .dt-novel-fore-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
        .dt-novel-outline-pre{margin:0;max-height:60vh;overflow:auto;font:11px/16px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-novel-approve{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
        .dt-novel-approve input{box-sizing:border-box;width:130px;min-height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:5px 8px;font:inherit;font-size:12px}
        .dt-novel-modal{pointer-events:auto;display:flex;flex-direction:column;width:min(760px,calc(100vw - 48px));height:min(680px,calc(100vh - 64px));max-width:100%;max-height:100%;padding:0;gap:0;border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
        .dt-novel-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
        .dt-novel-modal-head h2{margin:0;font-size:16px;line-height:22px;font-weight:600}
        .dt-novel-modal-body{flex:1;min-height:0;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:12px}
        .dt-novel-modal-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-novel-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .dt-novel-form-wide{grid-column:1 / -1}
        .dt-novel-form-section{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}
        .dt-novel-form-section h4{margin:0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-header-novel-actions{display:flex;align-items:center;gap:2px}
        .dt-header-novel-actions button{min-width:24px;height:24px;padding:0 6px;border:0;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;gap:3px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-header-novel-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        @media(max-width:900px){.dt-novel-detail{grid-template-columns:1fr}}
        @media(max-width:700px){.dt-novel-form-grid{grid-template-columns:1fr}.dt-novel-form-wide{grid-column:auto}}
        .dt-header-actions{display:flex;align-items:center;gap:2px;flex:none}
        .dt-header-actions>button,.dt-rewrite>button,.dt-mvu-slot>button{width:24px;height:24px;border-radius:5px;display:grid;place-items:center;flex:none;color:inherit;background:transparent;border:0;cursor:pointer;padding:0}
        .dt-header-actions>button:hover,.dt-rewrite>button:hover,.dt-mvu-slot>button:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-header-actions>button:disabled,.dt-rewrite>button:disabled,.dt-mvu-slot>button:disabled,.dt-rewrite-actions>button:disabled,.dt-candidates button:disabled{cursor:not-allowed;opacity:.45}
        .dt-rewrite{position:relative;display:inline-flex}
        .dt-rewrite-pop{z-index:20;position:absolute;top:calc(100% + 8px);right:0;width:min(320px,calc(100vw - 32px));display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
        .dt-mvu-slot{position:relative;display:inline-flex}
        .dt-mvu-pop{z-index:20;position:absolute;top:calc(100% + 8px);right:0;width:min(360px,calc(100vw - 32px));max-height:min(60vh,540px);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}
        .dt-rewrite-pop textarea{box-sizing:border-box;width:100%;min-height:72px;max-height:180px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:7px 9px;font:inherit;font-size:13px;line-height:18px;outline:none}
        .dt-rewrite-pop textarea:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-rewrite-actions{display:flex;justify-content:flex-end;gap:8px}
        .dt-rewrite-actions>button{min-height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:12px}
        .dt-rewrite-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-rewrite-actions>.dt-rewrite-go{color:#fff;background:var(--dsw-alias-state-business-primary);border-color:transparent}
        .dt-swipe-feedback{display:inline-flex;align-items:center;min-height:18px;padding:0 6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:10px;line-height:18px;font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-guide-list{display:flex;flex-direction:column;gap:6px;max-width:640px}
        .dt-guide-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 8px 8px 10px}
        .dt-guide-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
        .dt-guide-add{display:flex;gap:8px;align-items:center;max-width:640px;margin-top:8px;flex-wrap:wrap}
        .dt-guide-add-field{flex:1;min-width:220px}
        .dt-candidates{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,780px),100%);margin:0 auto 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}
        .dt-candidates-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:4px 8px 4px 6px}
        .dt-candidates-toggle{display:flex;align-items:center;gap:6px;min-width:0;border:0;border-radius:6px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;padding:3px 6px}
        .dt-candidates-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-candidates-toggle svg{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s}
        .dt-candidates-toggle svg.dt-chevron-open{transform:rotate(180deg)}
        .dt-candidates-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-candidates-actions>button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-candidates-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-candidates-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
        .dt-candidates-body p{margin:0}
        .dt-candidates-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
        .dt-candidate-list{display:flex;flex-direction:column;gap:4px}
        .dt-candidate-item{display:flex;align-items:flex-start;gap:8px;width:100%;min-height:30px;text-align:left;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;line-height:17px;padding:6px 8px}
        .dt-candidate-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
        .dt-candidate-kind{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 5px;border-radius:4px;font-size:10px;line-height:16px;font-weight:600;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
        .dt-candidate-kind-scene{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
        .dt-candidate-text{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
        .dt-candidates-feedback{display:flex;gap:6px;align-items:center}
        .dt-candidates-feedback input{box-sizing:border-box;flex:1;min-width:0;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);padding:0 8px;font:inherit;font-size:12px;outline:none}
        .dt-candidates-feedback input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
        .dt-candidates-feedback>button{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-candidates-feedback>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu{box-sizing:border-box;width:100%;margin:0 auto 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px}
        .dt-mvu button:disabled,.dt-script-bound-chip>button:disabled{cursor:not-allowed;opacity:.45}
        .dt-mvu-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:36px;padding:4px 8px 4px 6px}
        .dt-mvu-toggle{display:flex;align-items:center;gap:6px;min-width:0;border:0;border-radius:6px;color:inherit;background:transparent;cursor:pointer;font:inherit;font-size:12px;padding:3px 6px}
        .dt-mvu-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
        .dt-mvu-toggle svg{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .12s}
        .dt-mvu-toggle svg.dt-chevron-open{transform:rotate(180deg)}
        .dt-mvu-count{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-mvu-actions>button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-mvu-actions>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu-body{display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px}
        .dt-mvu-body p{margin:0}
        .dt-mvu-section-title{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-mvu-vars{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px}
        .dt-mvu-var{display:grid;grid-template-columns:minmax(90px,max-content) minmax(0,1fr);gap:2px 12px;min-width:0}
        .dt-mvu-var-path{font-family:monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
        .dt-mvu-var-value{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
        .dt-mvu-rendered{width:100%;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base)}
        .dt-mvu-receipts{display:flex;flex-direction:column;gap:4px}
        .dt-mvu-receipt{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px}
        .dt-mvu-receipt-head{display:flex;align-items:center;gap:8px;min-width:0}
        .dt-mvu-badge{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 6px;border-radius:4px;font-size:10px;line-height:16px;font-weight:600}
        .dt-mvu-badge-updated{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 12%,transparent)}
        .dt-mvu-badge-unchanged{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
        .dt-mvu-badge-failed{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
        .dt-mvu-meta{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-mvu-change{font-family:monospace;font-size:11px;line-height:16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
        .dt-mvu-more{align-self:flex-start;border:0;padding:0;color:var(--dsw-alias-state-business-primary);background:transparent;cursor:pointer;font:inherit;font-size:11px}
        .dt-mvu-more:hover{text-decoration:underline}
        .dt-mvu-failures{display:flex;flex-direction:column;gap:2px}
        .dt-mvu-failures-title{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}
        .dt-mvu-failure{color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px;overflow-wrap:anywhere}
        .dt-mvu-side{box-sizing:border-box;width:100%;height:100%;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:14px;padding:14px 14px 24px;color:var(--dsw-alias-label-primary);font-size:13px;font-family:var(--ds-font-family,Inter,system-ui,sans-serif);letter-spacing:0}
        .dt-mvu-side-head{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;flex:none}
        .dt-mvu-summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .dt-mvu-side-retry{flex:none;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:12px}
        .dt-mvu-side-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-mvu-side-retry:disabled{cursor:not-allowed;opacity:.45}
        .dt-mvu-side-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:220px;color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;line-height:20px}
        .dt-mvu-side-empty svg{color:var(--dsw-alias-label-caption)}
        .dt-mvu-side-section{display:flex;flex-direction:column;gap:8px;min-width:0}
        .dt-mvu-side-h{display:flex;align-items:center;gap:8px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
        .dt-mvu-side-h>span:first-child{flex:none}
        .dt-mvu-side-h::after{content:"";flex:1;height:1px;background:var(--dsw-alias-border-l2)}
        .dt-mvu-side-count{flex:none;display:inline-flex;align-items:center;min-height:16px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px;font-weight:500;letter-spacing:0}
        .dt-mvu-groups{display:flex;flex-direction:column;gap:10px}
        .dt-mvu-group{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden}
        .dt-mvu-group-h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
        .dt-mvu-group-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;font-weight:600}
        .dt-mvu-group-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px}
        .dt-mvu-group-body{display:flex;flex-direction:column}
        .dt-mvu-var-row{display:grid;grid-template-columns:minmax(72px,max-content) minmax(0,1fr);gap:2px 12px;padding:5px 10px}
        .dt-mvu-var-row+.dt-mvu-var-row{border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
        .dt-mvu-side .dt-mvu-var-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}
        .dt-mvu-side .dt-mvu-var-value{color:var(--dsw-alias-label-primary);font-size:12px;line-height:17px;white-space:pre-wrap}
        .dt-mvu-side .dt-mvu-receipt{gap:4px;border-radius:9px;padding:7px 10px}
        .dt-mvu-side .dt-mvu-change{font-size:11.5px;line-height:17px}
        .dt-mvu-side .dt-mvu-rendered{border-radius:10px}
        .dt-script-card{box-sizing:border-box;width:100%;margin:0 auto 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
        .dt-script-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
        .dt-script-card-title{font-weight:600}
        .dt-script-card-pos{color:var(--dsw-alias-label-secondary);font-size:11px;flex:none}
        .dt-script-bar{height:6px;border-radius:3px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
        .dt-script-bar-fill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary);transition:width .2s ease}
        .dt-script-card-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
        .dt-script-card-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
        .dt-script-card-meta .dt-script-name{color:var(--dsw-alias-label-secondary)}
        .dt-script-preview{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);max-height:132px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base))}
        .dt-script-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
        .dt-script-list{display:flex;flex-direction:column;gap:10px}
        .dt-script-row{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
        .dt-script-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
        .dt-script-name{min-width:0;overflow-wrap:anywhere}
        .dt-script-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-script-bind{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-script-bind select{height:30px;min-width:200px;max-width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;background:var(--dsw-alias-bg-base);padding:0 6px}
        .dt-script-bound{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
        .dt-script-bound-chip{display:inline-flex;align-items:center;gap:4px;min-height:24px;padding:0 4px 0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;font-size:11px;color:var(--dsw-alias-label-secondary)}
        .dt-script-bound-chip>button{width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:50%;color:inherit;background:transparent;cursor:pointer;font-size:12px;line-height:1}
        .dt-script-bound-chip>button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
        .dt-script-paste{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
        .dt-workbench-list{display:flex;flex-direction:column;gap:10px}
        .dt-workbench-plan{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px}
        .dt-workbench-plan.dt-workbench-done{opacity:.75}
        .dt-create-choices{display:flex;flex-direction:column;gap:12px}
        .dt-create-choice{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
        .dt-create-choice-copy{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
        .dt-create-choice-copy h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
        .dt-create-choice-copy .dt-hint{margin:0}
        .dt-create-choice>button{flex:none}
        .dt-workbench-plan-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
        .dt-workbench-plan-title{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}
        .dt-workbench-plan-title:hover{color:var(--dsw-alias-label-primary)}
        .dt-workbench-plan-title>span:last-child{min-width:0;overflow-wrap:anywhere;font-weight:600}
        .dt-workbench-caret{flex:none;color:var(--dsw-alias-label-tertiary)}
        .dt-workbench-status{flex:none;font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-status-applied{color:var(--dsw-alias-state-business-primary,inherit)}
        .dt-workbench-actions{display:inline-flex;gap:6px;margin-left:auto}
        .dt-workbench-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-workbench-diff{display:flex;flex-direction:column;gap:8px}
        .dt-workbench-entry{display:flex;flex-direction:column;gap:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:8px}
        .dt-workbench-entry-head{display:flex;align-items:center;gap:8px}
        .dt-workbench-entry-uid{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
        .dt-workbench-entry-action{font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-entry-action-remove{color:var(--dsw-alias-state-danger,inherit)}
        .dt-workbench-change{display:flex;flex-direction:column;gap:4px}
        .dt-workbench-change-field{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
        .dt-workbench-change-values{display:flex;flex-direction:column;gap:4px}
        .dt-workbench-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
        .dt-workbench-old,.dt-workbench-new{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 8px;max-height:160px;overflow-y:auto;background:var(--dsw-alias-bg-sunken,var(--dsw-alias-bg-base))}
        .dt-workbench-old{color:var(--dsw-alias-label-secondary)}
        .dt-workbench-note{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
      `
      document.head.appendChild(tag)
    }

    function apply(ctx) {
      installStyle()
      PanelHost.context = ctx
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: MESSAGES_ZH, en: MESSAGES_EN }), 'dsh-tavern: locale dictionaries')
      translate = ctx.locale.bind(LOCALE_NS)
      subscribeLocale = (listener) => ctx.locale.subscribe(listener)
      getLocaleRevision = () => ctx.locale.getSnapshot()
      void refreshBootstrap().catch(() => {})
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-tavern',
        order: 45,
        label: () => 'dsh-tavern',
        inject: () => ({}),
      }, TavernSettings))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'tavern',
        order: 20,
        label: () => translate('nav.title'),
        inject: () => ({}),
      }, TavernView))
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer',
        priority: -20,
        select: selectTavernComposer,
        inject: () => ({}),
      }, TavernComposer))
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'dsh-tavern',
        order: -5,
        inject: () => ({}),
      }, TavernHeaderAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-tavern-panel',
        order: 20,
        inject: () => ({}),
      }, PanelHost))
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-tavern-panel',
        order: 20,
        inject: () => ({}),
      }, SidebarFooterAction))
      // DSH 原生右侧栏（宿主 ≥0.2.0-rc.2 的 ui-sidebar-right）：MVU 面板注册为
      // 页面型 tab（无 patterns、按 kind 打开），guide 入口让任意会话都能从右栏
      // 的「+」进入。sidebarRightTabs/sidebarRight 经 ctx.inject 动态等待——服务
      // 就绪时回调生效、离开时随 scope 整体卸载；刻意不进 exports.inject：旧宿
      // 主没有这两个服务，硬注入会让插件 apply 永久挂起，回退只剩标题栏弹层，
      // 行为与侧栏存在前一致。
      if (typeof ctx.inject === 'function') {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
          scope.effect(() => scope.sidebarRightTabs.register({
            id: MVU_TAB_ID,
            kind: MVU_TAB_KIND,
            priority: 'extension',
            title: () => translate('mvu.title'),
            guide: [{
              id: 'mvu',
              order: 40,
              title: () => translate('mvu.title'),
              description: () => translate('mvu.guide.description'),
              icon: IconDataOutline16,
            }],
          }), 'dsh-tavern: sidebar-right mvu tab type')
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: MVU_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          }, TavernMvuSidebarTab)), 'dsh-tavern: sidebar-right mvu tab body')
        })
      }
    }

    exports.name = 'dsh-tavern'
    exports.inject = ['slots', 'sessions', 'workspaces', 'locale']
    exports.apply = apply
    return module.exports
  },
})
