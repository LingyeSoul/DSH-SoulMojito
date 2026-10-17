import { mkdir } from 'node:fs/promises'
import { dshHomePath } from './dsh-home.js'

export const TAVERN_WORKSPACE_TITLE = 'Tavern (internal)'
// 写卡工作台专用内部工作区：工作台会话按聊天一一对应（提案 0013 排错场景），
// 数量随聊天增长，与角色扮演会话混在同一个 Tavern (internal) 会互相污染；
// 路径与角色卡/聊天记录等数据目录隔离，沿用 2026-08-17 决策的划分逻辑。
export const TAVERN_WORKBENCH_WORKSPACE_TITLE = 'Tavern Workbench (internal)'
export async function prepareInternalWorkspace() {
  const path = dshHomePath('tavern', 'workspace')
  await mkdir(path, { recursive: true })
  return { path, title: TAVERN_WORKSPACE_TITLE }
}

export async function prepareWorkbenchWorkspace() {
  const path = dshHomePath('tavern', 'workbench')
  await mkdir(path, { recursive: true })
  return { path, title: TAVERN_WORKBENCH_WORKSPACE_TITLE }
}
