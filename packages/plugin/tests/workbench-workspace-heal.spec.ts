/**
 * 写卡工作台的内部 DSH 工作区创建（2026-10-24 用户反馈：写卡工作台似乎不会
 * 创建内部对应工作区）。宿主工作区登记只在「新建工作台会话」路径上创建过，
 * 既有会话打开（侧栏列表行、聊天侧「交给工作台」的复用分支）从不经过注册核；
 * 缓存的 workspace 视图又被当成存在性依据，登记被删后不会按路径重建。
 * follow panel-active-session / behavior-settings-client 的 main.js source check 范式。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../client/main.js'), 'utf8')

describe('workbench internal workspace creation', () => {
  it('revalidates the cached workspace against the host registry before reuse', () => {
    for (const marker of [
      'function pluginWorkspaceRegistered(ctx, workspace)',
      'const items = ctx?.workspaces?.list?.getSnapshot?.()?.items',
      'if (!Array.isArray(items)) return true',
      'return items.some((item) => item?.workspaceId === workspace.workspaceId)',
      'if (internalWorkspace?.path === config.path && pluginWorkspaceRegistered(ctx, internalWorkspace)) return internalWorkspace',
      'if (workbenchWorkspace?.path === config.path && pluginWorkspaceRegistered(ctx, workbenchWorkspace)) return workbenchWorkspace',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('waits for bootstrap instead of failing while the workspace field is still absent', () => {
    for (const marker of [
      'async function pluginWorkspaceConfig(kind)',
      'const config = await pluginWorkspaceConfig(\'tavern\')',
      'const config = await pluginWorkspaceConfig(\'workbench\')',
      'await refreshBootstrap()',
    ]) {
      expect(source).toContain(marker)
    }
  })

  it('re-ensures the workspace when opening an existing workbench session', () => {
    for (const marker of [
      'function openWorkbenchSessionView(ctx, sessionId)',
      'void ensureWorkbenchWorkspace(ctx).catch(() => {})',
      'openWorkbenchSessionView(ctx, existing[0])',
      'onClick: () => openWorkbenchSessionView(ctx, sessionId),',
    ]) {
      expect(source).toContain(marker)
    }
  })
})