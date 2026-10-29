/**
 * Client-side source checks for the AgentTavern body-operations surface
 * (proposal 0021 §7): the body cache and assistant-actions entry, the anchor
 * hidden/text override, the synthetic turn-trigger hiding, i18n copy, and the
 * client fragment manifest ordering. Follows the source-check pattern of
 * agent-tavern-display-client.spec.ts but reads client-src fragments directly:
 * client/main.js is a build product and this slice does not rebuild it.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = join(here, '../client-src')
const bodySource = readFileSync(join(sourceDir, '89b-ui-body.js'), 'utf8')
const storeSource = readFileSync(join(sourceDir, '50-store-core.js'), 'utf8')
const stylesSource = readFileSync(join(sourceDir, '95-ui-styles.js'), 'utf8')
const assistantSource = readFileSync(join(sourceDir, '89-ui-assistant.js'), 'utf8')
const zh = readFileSync(join(sourceDir, '41-i18n-zh.js'), 'utf8')
const en = readFileSync(join(sourceDir, '40-i18n-en.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')) as { fragments: string[] }

describe('AgentTavern body client source checks', () => {
  it('registers the body action list slot with a stable id and owner message id', () => {
    expect(bodySource).toContain("ctx.slots.inject('conversation.chat.assistant-actions'")
    expect(bodySource).toContain("name: 'conversation.chat.assistant-actions'")
    expect(bodySource).toContain("id: 'tavern-body-actions'")
    expect(bodySource).toContain('props.messageId')
  })

  it('caches one body lookup per message and revision and dedupes inflight requests', () => {
    expect(bodySource).toContain('function tavernBodyCacheKey(sessionId, messageId, revision)')
    expect(bodySource).toContain('function loadTavernBody(sessionId, messageId, revision)')
    expect(bodySource).toContain('bodyInflight.has(key)')
    expect(bodySource).toContain('bodyInflight.set(key, pending)')
    expect(bodySource).toContain('function useTavernBody(sessionId, messageId)')
    expect(bodySource).toContain('function bumpTavernBodyRevision(sessionId, messageId)')
  })

  it('calls the four body endpoints through the plugin api helper', () => {
    expect(bodySource).toContain('body?sessionId=')
    expect(bodySource).toContain('&messageId=')
    expect(bodySource).toContain("api('body', {")
    expect(bodySource).toContain("method: 'PUT'")
    expect(bodySource).toContain("api('body/regenerate'")
    expect(bodySource).toContain("api('body/select'")
    expect(bodySource).toContain("method: 'POST'")
    // Every mutation carries the ledger group + anchor/index CAS fields from
    // proposal 0021 §9.1 so the server route can reach body-runtime unchanged.
    expect(bodySource.match(/groupId: body\.groupId/g)).toHaveLength(3)
    expect(bodySource.match(/expectedAnchorId,/g)).toHaveLength(3)
    expect(bodySource).toContain('...(trimmed === \'\' ? {} : { feedback: trimmed })')
  })

  it('retries a projection-pending body mutation on a bounded backoff', () => {
    expect(bodySource).toContain('function withBodyProjectionRetry(request)')
    expect(bodySource).toContain("code === 'projection-pending'")
    expect(bodySource).toContain('BODY_PROJECTION_RETRY_DELAYS_MS')
    expect(bodySource).toContain('void withBodyProjectionRetry(request)')
  })

  it('invalidates the whole body group and refreshes a pending JSONL projection', () => {
    // Candidate switching flips hidden on two messages: a per-message drop left
    // the previous anchor visible and the new anchor stale.
    expect(bodySource).toContain('function bumpTavernBodyGroup(sessionId, groupId)')
    expect(bodySource).toContain('function invalidateTavernBodyGroupCache(sessionId, groupId)')
    expect(bodySource).toContain('body.groupId === groupId')
    expect(bodySource).toContain('bodyMutationEpoch')
    expect(bodySource).toContain('function scheduleTavernBodyProjectionRefresh(sessionId, groupId)')
    // Only the anchor row drives the chain.
    expect(bodySource).toContain('body.anchorMessageId !== messageId')
    expect(bodySource).toContain('scheduleTavernBodyProjectionRefresh(sessionId, body.groupId)')
    expect(bodySource).toContain('BODY_PROJECTION_REFRESH_DELAYS_MS')
    // A mutation also drops in-flight batch promises of the group.
    expect(bodySource).toContain('bodyBatchInflight.delete(key)')
  })

  it('drops the projection refresh entry once the retry budget is spent', () => {
    // The exhausted entry used to linger as { attempt: N, timer: undefined }
    // until the next mutation. The budget now deletes it and latches the group
    // so a still-stale floor cannot restart the chain on every render.
    expect(bodySource).toContain('const bodyProjectionExhausted = new Set()')
    expect(bodySource).toContain('bodyProjectionExhausted.has(key)')
    expect(bodySource).toContain('bodyProjectionExhausted.add(key)')
    expect(bodySource).toContain('bodyProjectionExhausted.delete(key)')
    expect(bodySource).toContain('bodyProjectionRefreshes.delete(key)')
    expect(bodySource).toContain('if (current !== undefined && current.timer !== undefined) clearTimeout(current.timer)')

    const scheduleStart = bodySource.indexOf('function scheduleTavernBodyProjectionRefresh(sessionId, groupId)')
    const scheduleEnd = bodySource.indexOf('function loadTavernBody(sessionId, messageId, revision)')
    expect(scheduleStart).toBeGreaterThanOrEqual(0)
    expect(scheduleEnd).toBeGreaterThan(scheduleStart)
    const scheduleBody = bodySource.slice(scheduleStart, scheduleEnd)
    const exhaustedBranch = scheduleBody.indexOf('if (attempt >= BODY_PROJECTION_REFRESH_DELAYS_MS.length)')
    expect(exhaustedBranch).toBeGreaterThanOrEqual(0)
    expect(scheduleBody.slice(exhaustedBranch)).toContain('bodyProjectionRefreshes.delete(key)')
    // The last attempt owns no timer: it drops the entry instead of leaving a
    // spent record behind.
    expect(scheduleBody).toContain('if (used >= BODY_PROJECTION_REFRESH_DELAYS_MS.length)')
  })

  it('batches the visible body reads into one request with a per-message fallback', () => {
    // Every assistant row used to call `GET body` on its own, and the server
    // re-read the chat and re-folded the ledger per row. The batch window sends
    // one `messageIds` request and keeps the single-id route for one row and
    // for batch failures.
    expect(bodySource).toContain('function requestTavernBody(sessionId, messageId, revision)')
    expect(bodySource).toContain('function flushTavernBodyBatch(batch)')
    expect(bodySource).toContain('function loadTavernBodyBatch(sessionId, messageIds, revision)')
    expect(bodySource).toContain('&messageIds=${query}')
    expect(bodySource).toContain('const BODY_BATCH_LIMIT = 50')
    expect(bodySource).toContain('const BODY_BATCH_MIN = 2')
    expect(bodySource).toContain('function settleTavernBodySingles(sessionId, revision, waiters)')
    expect(bodySource).toContain('await settleTavernBodySingles(batch.sessionId, batch.revision, chunk)')
    expect(bodySource).toContain('void requestTavernBody(sessionId, messageId, revision)')
    // The single lookup and its cache/inflight guard stay the fallback path.
    expect(bodySource).toContain("api(`body?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`)")
    expect(bodySource).toContain("body batch response is missing items")
  })

  it('ships the five stable action test ids', () => {
    for (const testId of [
      'tavern-body-edit',
      'tavern-body-regenerate',
      'tavern-body-swipe-prev',
      'tavern-body-swipe-next',
      'tavern-body-swipe-count',
    ]) {
      expect(bodySource).toContain(`'data-testid': '${testId}'`)
    }
  })

  it('renders actions only for AgentTavern single-character sessions with a capability', () => {
    expect(bodySource).toContain("binding.architecture === 'agent-tavern'")
    expect(bodySource).toContain('binding.group !== true')
    expect(bodySource).toContain('body.canEdit === true')
    expect(bodySource).toContain('body.canRegenerate === true')
    expect(bodySource).toContain('body.canSelect === true')
    expect(bodySource).toContain('body.hidden === true')
  })

  it('stretches both body dialog textareas to the modal body height', () => {
    // Only these two dialogs opt into the body variant; EditorDialog and
    // EditorField keep their shared semantics and 108px resizable default.
    expect(bodySource).toContain("className: 'dt-body-dialog dt-body-dialog-edit'")
    expect(bodySource).toContain("className: 'dt-body-dialog dt-body-dialog-regenerate'")
    expect(bodySource).toContain("className: 'dt-editor-wide dt-body-textarea dt-body-textarea-edit'")
    expect(bodySource).toContain("className: 'dt-editor-wide dt-body-textarea dt-body-textarea-feedback'")

    const baseRule = stylesSource.indexOf('.dt-editor-field textarea{min-height:108px;resize:vertical;white-space:pre-wrap}')
    expect(baseRule).toBeGreaterThanOrEqual(0)
    // The override must come after the shared default and make the field grow
    // with the modal body instead of pinning a fixed textarea height.
    expect(stylesSource.indexOf('.dt-editor-field.dt-body-textarea textarea{flex:1;height:auto;min-height:120px;max-height:none;resize:none;overflow-y:auto}')).toBeGreaterThan(baseRule)
    expect(stylesSource).toContain('.dt-body-dialog .dt-editor-modal-body>.dt-editor{flex:1;min-height:0}')
    expect(stylesSource).toContain('.dt-editor-field.dt-body-textarea{flex:1;min-height:0}')
    expect(stylesSource).not.toContain('.dt-editor-field.dt-body-textarea-edit textarea{height:280px')
    expect(stylesSource).not.toContain('.dt-editor-field.dt-body-textarea-feedback textarea{height:180px')
  })

  it('parses the body response fields used by the action row', () => {
    for (const field of [
      'body.count',
      'body.selectedIndex',
      'body.anchorMessageId',
      'body.reason',
      'body.canEdit',
      'body.canRegenerate',
      'body.canSelect',
      'body.hidden',
      'body.text',
      'body.projectionPending',
      'body.detail',
    ]) {
      expect(bodySource).toContain(field)
    }
  })

  it('maps body detail codes to local copy and drops the unused revision sync', () => {
    expect(bodySource).toContain('function tavernBodyDetailText(t, detail)')
    for (const detail of [
      'body-receipt-missing',
      'body-receipt-duplicate',
      'candidate-switch-disabled',
      'body-group-mismatch',
      'body-floor-unreadable',
      'stale-anchor',
    ]) {
      expect(bodySource).toContain(`detail === '${detail}'`)
    }
    expect(bodySource).toContain("t('body.detailGroupMismatch')")
    expect(bodySource).toContain("t('body.detailFloorUnreadable')")
    expect(bodySource).toContain("t('body.detailUnknown')")
    expect(bodySource).toContain("'data-testid': 'tavern-body-detail'")
    // The server puts no `revision` on body mutation responses; the local
    // revision bump below already invalidates the cache.
    expect(bodySource).not.toContain('syncChatRevision')
    expect(bodySource).not.toContain('result.revision')
    expect(bodySource).toContain("code === 'invalid-arguments'")
  })

  it('keeps the display lookup as the fallback and hides body-hidden nodes', () => {
    expect(assistantSource).toContain('useTavernDisplayText(tavernBinding, messageId)')
    expect(assistantSource).toContain('useTavernBody(tavernBinding ? props.tavernSessionId : undefined, messageId)')
    expect(assistantSource).toContain('bodyState.body?.hidden === true')
    expect(assistantSource).toContain('withTavernDisplayText(props.node, bodyText !== undefined ? bodyText : displayText)')
  })

  it('hides synthetic body turn triggers and context rows, reusing host renderers otherwise', () => {
    expect(assistantSource).toContain("key: 'turn-trigger'")
    expect(assistantSource).toContain('source.form')
    expect(assistantSource).toContain("form === 'body-regenerate' || form === 'body-restore'")
    expect(assistantSource).toContain('findHostTurnTriggerEntry')
    expect(assistantSource).toContain('entry.component !== TavernTurnTriggerNode')
    expect(assistantSource).toContain("key: 'context'")
    expect(assistantSource).toContain("form === 'body-hide'")
    expect(assistantSource).toContain('findHostContextEntry')
    expect(assistantSource).toContain('entry.component !== TavernContextNode')
    expect(assistantSource).toContain('registerTavernBodyActions(ctx)')
  })

  it('carries the server detail onto the api error and maps it to local copy', () => {
    // api() keeps status/code unchanged and adds the stable detail field.
    expect(storeSource).toContain('error.detail = body.detail')
    expect(storeSource).toContain('error.status = response.status')
    expect(storeSource).toContain('error.code = body.code')

    // Mutation failures prefer code + detail over the server's English
    // sentence; a missing detail still gets the generic line.
    expect(bodySource).toContain('function tavernBodyErrorText(t, cause)')
    expect(bodySource).toContain("typeof cause.detail === 'string'")
    expect(bodySource).toContain("if (code === 'body-state-unsafe')")
    expect(bodySource).toContain('const detailText = tavernBodyDetailText(t, detail)')
    expect(bodySource).toContain("return detailText === '' ? t('body.detailUnknown') : detailText")
    expect(bodySource).toContain("if (code === 'host-unsupported') return t('body.hostUnsupported')")
  })

  it('ships the body copy in both dictionaries with matching placeholders', () => {
    const keys = [
      'body.edit', 'body.regenerate', 'body.swipe', 'body.saving', 'body.generating',
      'body.failed', 'body.busy', 'body.compacted', 'body.notLast', 'body.projectionPending',
      'body.hostUnsupported',
      'body.invalidRequest', 'body.detailReceiptMissing', 'body.detailReceiptDuplicate',
      'body.detailCandidateSwitchDisabled', 'body.detailStaleAnchor',
      'body.detailGroupMismatch', 'body.detailFloorUnreadable', 'body.detailUnknown',
    ]
    for (const key of keys) {
      expect(zh).toContain(`'${key}'`)
      expect(en).toContain(`'${key}'`)
    }
    expect(zh).toContain("'body.failed': '正文操作失败：{message}'")
    expect(en).toContain("'body.failed': 'Body operation failed: {message}'")
    expect(zh).toContain("'body.swipe': '候选 {index}/{count}'")
    expect(en).toContain("'body.swipe': 'Candidate {index} of {count}'")
  })

  it('lists the body fragment after the assistant fragment and registers every source fragment', () => {
    const assistantIndex = manifest.fragments.indexOf('89-ui-assistant.js')
    const bodyIndex = manifest.fragments.indexOf('89b-ui-body.js')
    expect(assistantIndex).toBeGreaterThanOrEqual(0)
    expect(bodyIndex).toBe(assistantIndex + 1)
    for (const name of readdirSync(sourceDir)) {
      if (!name.endsWith('.js')) continue
      expect(manifest.fragments).toContain(name)
    }
  })

  it('stays a shared-scope fragment without module syntax', () => {
    expect(bodySource).not.toMatch(/^\s*import\b/m)
    expect(bodySource).not.toMatch(/^\s*export\b/m)
  })
})