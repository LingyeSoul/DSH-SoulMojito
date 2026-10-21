#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { inflateSync } from 'node:zlib'
import { build as esbuildBuild } from 'esbuild'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPO_ROOT = resolve(PLUGIN_ROOT, '../..')
const PACKAGE_PATH = join(PLUGIN_ROOT, 'package.json')
const VERSION_PATH = join(PLUGIN_ROOT, 'version.json')
const PATCH_PATH = join(PLUGIN_ROOT, 'cordis.patch.yml')
const SOURCE_PATH = join(PLUGIN_ROOT, 'src', 'index.ts')
const SERVER_PATH = join(PLUGIN_ROOT, 'index.mjs')
const AGENT_PATH = join(PLUGIN_ROOT, 'agent.mjs')
const NOVEL_PATH = join(PLUGIN_ROOT, 'novel.mjs')
const REASONING_PATH = join(PLUGIN_ROOT, 'reasoning.mjs')
const CLIENT_PATH = join(PLUGIN_ROOT, 'client', 'index.js')
const PLUGIN_NAME = 'dsh-soulmojito'
const API_PREFIX = '/api/dsh-soulmojito'

// Hand-written source files stay navigable for agents: a file over this budget
// must either be split or carry an explicit, reasoned allowlist entry.
const SOURCE_BUDGET_LINES = 800
const SOURCE_BUDGET_ROOTS = [
  'packages/bind/src',
  'packages/plugin/client-src',
  'packages/plugin/src',
  'packages/tavern-format/src',
  'packages/tavern-lore/src',
  'packages/tavern-macros/src',
  'packages/tavern-pipeline/src',
  'packages/tavern-script/src',
  'packages/tavern-store/src',
  'packages/tavern-template/src',
]
const SOURCE_BUDGET_ALLOWLIST = [
  { path: 'packages/plugin/client-src/40-i18n-en.js', reason: 'single English message table; novel import/revision strings stay in the existing novel section' },
  { path: 'packages/plugin/client-src/41-i18n-zh.js', reason: 'single Chinese message table; novel import/revision strings stay in the existing novel section' },
  { path: 'packages/plugin/client-src/92-ui-novel.js', reason: 'novel panel surface kept in one fragment' },
  { path: 'packages/plugin/client-src/11-helper-bridge.js', reason: 'one generated iframe shim template: it must stay a single IIFE string so the syntactically-valid-source test can evaluate it' },
  { path: 'packages/plugin/src/agent-novel/writer.ts', reason: 'writer subagent orchestration kept together' },
  { path: 'packages/plugin/src/agent-novel/driver.ts', reason: 'novel scheduling and recovery state machine kept together' },
  { path: 'packages/plugin/src/card-workbench/tools-world.ts', reason: 'world-book tool family kept together' },
  { path: 'packages/plugin/src/generation/pipeline.ts', reason: 'generation request assembly kept as one unit' },
  { path: 'packages/plugin/src/helper.ts', reason: 'single TavernHelper RPC surface; snapshot + session world/script copy ops share the same binding and validation seams' },
  { path: 'packages/plugin/src/games/builtin/', prefix: true, reason: 'one built-in game engine per file' },
  { path: 'packages/plugin/src/http/router.ts', reason: 'single HTTP dispatch surface; split when route groups move' },
  { path: 'packages/plugin/src/http/novel.ts', reason: 'single AgentNovel HTTP surface; import/revision routes share the same creation gate and error mapping' },
  { path: 'packages/plugin/src/memory-maintenance.ts', reason: 'maintenance run loop and tool surface kept together' },
  { path: 'packages/plugin/src/mods/host.ts', reason: 'mod host lifecycle and API adapter kept together' },
  { path: 'packages/plugin/src/mvu.ts', reason: 'MVU settlement service and receipts kept together' },
  { path: 'packages/tavern-store/src/novel-model.ts', reason: 'novel domain model and validators kept together' },
  { path: 'packages/tavern-store/src/novel-import.ts', reason: 'imported-source parsing, extraction validation and merge digest kept together' },
  { path: 'packages/tavern-store/src/novel.ts', reason: 'NovelStore orchestration class' },
  { path: 'packages/tavern-store/src/store.ts', reason: 'TavernStore orchestration class' },
]

const REQUIRED_SERVER_ROUTES = [
  'bootstrap',
  'store-revision',
  'state',
  'models',
  'model',
  'import/character',
  'character/',
  'export/character/',
  'export/world/',
  'export/preset/',
  'import/world',
  'world/',
  'import/preset',
  'preset/',
  'import/persona',
  'import/regex',
  'regex/sync-cards',
  'regex/sync-presets',
  'persona',
  'persona-avatar/',
  'groups',
  'group',
  'binding',
  'bindings/prune',
  'chats',
  'chat/',
  'display',
  'branch',
  'agent-tavern/audit',
  'projection',
  'projection/replay',
  'regex',
  'script',
  'generate',
  'novels',
  'novels/pause',
  'novels/resume',
  'novels/stop',
  'novels/update-outline',
  'novels/approve-outline',
  'novels/export',
  'novels/outline',
  'novels/body',
  'novels/import',
  'novels/import/preview',
  'novels/import/chapter',
  'novels/optimize',
  'novels/optimize/apply',
  'novels/optimize/discard',
  'novels/revision',
  'update',
  'update/check',
  'update/install',
  // Mod 管理面与子路由（提案 0015 P1）：GET mods / POST mods/state /
  // POST mods/<id>/{enable,disable,reload} 管理面 + mods/<id>/<path> 子路由。
  'mods',
  'mods/',
  // Mod git 安装（提案 0015 P2）：GitHub 源降级链预读 + git clone。管理保留段。
  'mods/install',
  // 游戏桥 HTTP 面（提案 0018 §4.1，P0+P2）：list/revision/start/state/action/
  // install/reload 七路 + 前缀分派段（视图路由 games/:gid/view/:sid 的动态段
  // 不可作字面量，由 checkServerText 的 games 标记块另行覆盖）。
  'games/',
  'games/list',
  'games/revision',
  'games/start',
  'games/state/',
  'games/action/',
  'games/install',
  'games/reload',
  // 美化前端（2026-10-20）：右栏面板取最新一条完整 HTML 楼层；酒馆助手兼容面
  // 的单入口（POST，op 分派）。
  'frontend/latest',
  'helper',
]

// DSH client-web's platform module table, mirrored from the host web shell's
// staticModules seed (verified against DSH 0.2.0-rc.2's dsh-web-frontend).
// Third-party plugin values must flow through injected services, not through
// client-side package imports. The host dropped web-react / schema-form /
// ui-attachment and added client-store / ui-dockkit between 0.1.0-rc.6 and
// 0.1.5-rc.2 — re-sync this copy whenever the verification baseline moves
// (the seed is unchanged from 0.1.5-rc.2 through 0.2.0-rc.2).
const CLIENT_STATIC_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function declaredPathExists(value) {
  return typeof value === 'string' && existsSync(resolve(PLUGIN_ROOT, value))
}

function checkPackageObject(pkg, checkFiles = false) {
  const problems = []
  if (pkg.name !== PLUGIN_NAME) problems.push(`package name must be '${PLUGIN_NAME}'`)
  if (pkg.type !== 'module') problems.push("package type must be 'module'")
  if (pkg.main !== './index.mjs') problems.push("main must be './index.mjs'")
  if (pkg.exports?.['.'] !== './index.mjs') problems.push("exports['.'] must be './index.mjs'")
  if (pkg.exports?.['./client'] !== './client/index.js') {
    problems.push("exports['./client'] must be './client/index.js'")
  }
  if (pkg.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    problems.push("exports['./cordis.patch.yml'] must be './cordis.patch.yml'")
  }
  if (pkg.exports?.['./novel'] !== './novel.mjs') {
    problems.push("exports['./novel'] must be './novel.mjs'")
  }
  if (pkg.exports?.['./agent'] !== './agent.mjs') {
    problems.push("exports['./agent'] must be './agent.mjs'")
  }
  if (pkg.exports?.['./compaction'] !== './compaction.mjs') {
    problems.push("exports['./compaction'] must be './compaction.mjs'")
  }
  if (pkg.exports?.['./card-workbench'] !== './card-workbench.mjs') {
    problems.push("exports['./card-workbench'] must be './card-workbench.mjs'")
  }
  if (pkg.exports?.['./reasoning'] !== './reasoning.mjs') {
    problems.push("exports['./reasoning'] must be './reasoning.mjs'")
  }
  if (pkg.exports?.['./package.json'] !== './package.json') {
    problems.push("exports['./package.json'] must be './package.json'")
  }
  if (!Array.isArray(pkg.files)) {
    problems.push('files must be an array')
  } else {
    for (const entry of ['index.mjs', 'agent.mjs', 'compaction.mjs', 'novel.mjs', 'card-workbench.mjs', 'reasoning.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md']) {
      if (!pkg.files.includes(entry)) problems.push(`files must include '${entry}'`)
    }
  }
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push("dsh.bundle.patch must be './cordis.patch.yml'")
  }
  if (pkg.dsh?.manifestVersion !== 1) {
    problems.push('dsh.manifestVersion must be 1')
  }
  // 注：不要在这里加 @deepseek-ai/dsh* 的 peerDependencies 版本护栏。宿主的
  // evaluatePluginCompatibility 确实只按名字模式 + semver 读取它，但 pnpm v11
  // 的 autoInstallPeer 会无视 optional 元数据把整棵宿主运行时（node-pty/koffi
  // 等原生构建）拖进每个安装现场，pnpm check 已实证撞 ERR_PNPM_IGNORED_BUILDS。
  // 版本边界由本 gate 集与 .npm-cache 运行时基线共同守护。
  if (pkg.dsh?.client?.platform !== 'web') problems.push("dsh.client.platform must be 'web'")
  if (!Array.isArray(pkg.dsh?.client?.inject) || !pkg.dsh.client.inject.every((value) => typeof value === 'string')) {
    problems.push('dsh.client.inject must be an array of package-name strings')
  }

  if (checkFiles) {
    for (const [label, value] of [
      ['main', pkg.main],
      ["exports['.']", pkg.exports?.['.']],
      ["exports['./client']", pkg.exports?.['./client']],
      ["exports['./cordis.patch.yml']", pkg.exports?.['./cordis.patch.yml']],
      ["exports['./novel']", pkg.exports?.['./novel']],
      ["exports['./agent']", pkg.exports?.['./agent']],
      ["exports['./compaction']", pkg.exports?.['./compaction']],
      ["exports['./card-workbench']", pkg.exports?.['./card-workbench']],
      ["exports['./reasoning']", pkg.exports?.['./reasoning']],
      ["exports['./package.json']", pkg.exports?.['./package.json']],
      ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ]) {
      if (typeof value === 'string' && !declaredPathExists(value)) {
        problems.push(`${label} target does not exist: ${value}`)
      }
    }
  }
  return problems
}

/**
 * client.inject edges name host client packages the boot wire must load before
 * this plugin's client half arrives. A name the host no longer ships (DSH
 * 0.1.5-rc.2 removed dsh-client-runtime) leaves a dangling wire edge — the
 * current loader skips it silently, but that is host grace, not a contract.
 * Guard it here so a stale manifest fails the gate instead of the browser.
 * Degrades to a no-op when no official dependency root is locatable, matching
 * the restricted-environment pattern of runNodeMount.
 */
function checkClientInjectPackagesResolvable(pkg) {
  const inject = pkg?.dsh?.client?.inject
  if (!Array.isArray(inject) || inject.length === 0) return []
  const root = locateOfficialDependencyRoot()
  if (root === null) return []
  const problems = []
  for (const name of inject) {
    if (typeof name !== 'string') continue
    const segments = name.split('/')
    const resolvable = existsSync(join(root, ...segments, 'package.json'))
      || existsSync(join(root, '@deepseek-ai', 'dsh', 'node_modules', ...segments, 'package.json'))
    if (!resolvable) {
      problems.push(`dsh.client.inject entry '${name}' does not resolve in the official DSH install (dangling client edge)`)
    }
  }
  return problems
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && (trimmed[0] === "'" || trimmed[0] === '"') && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function stripYamlComment(line) {
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== null) {
      if (char === quote && line[index - 1] !== '\\') quote = null
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (char === '#') {
      return line.slice(0, index)
    }
  }
  return line
}

function parsePatchEntries(text) {
  const lines = text.split(/\r?\n/).map(stripYamlComment)
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)-\s+id:\s*(.*?)\s*$/.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const entry = { id: unquoteYamlScalar(match[2]), name: undefined }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') continue
      const lineIndent = /^\s*/.exec(line)[0].length
      if (lineIndent <= indent) break
      const nameMatch = /^\s*name:\s*(.*?)\s*$/.exec(line)
      // 只取 id 后的第一个 name：preset 行的 config.plugins 子块里还有更深的
      // `- id / name` 对，后扫描的浅层 name 不能被子条目覆盖。
      if (nameMatch !== null && entry.name === undefined) entry.name = unquoteYamlScalar(nameMatch[1])
    }
    entries.push(entry)
  }
  return entries
}

/** ST 生成轨迹的词汇表 tripwire：assistant/chunk 是 v0 词汇，v4 加载整件拒收。 */
function serverAppendsAssistantChunk(text) {
  return /append\(\s*['"]assistant\/chunk['"]/.test(text)
}

function checkPatchText(text) {
  const problems = []
  if (!/^\s*-\s+insert:\s*$/m.test(text)) problems.push('patch must contain a top-level insert list')
  const entries = parsePatchEntries(text)
  if (!entries.some((entry) => entry.id === PLUGIN_NAME && entry.name === PLUGIN_NAME)) {
    problems.push(`patch must insert id/name '${PLUGIN_NAME}'`)
  }
  // 两个 Agent preset 声明行（DSH 0.2.0 起 preset 的唯一投递方式）：行在、
  // 目标包名对、config.id 与 bundle 内常量一致。config.id 是会话日志里的
  // agent-preset/selected 持久值——改 id 会让旧会话的 preset 恢复被宿主拒绝
  // （"rejects a missing definition"），所以这里同时锁定 patch 与产物两侧。
  for (const [rowId, presetId] of [
    ['preset-agent-tavern', 'agent-tavern'],
    ['preset-agent-novel', 'agent-novel'],
    ['preset-agent-reasoning', 'agent-reasoning'],
  ]) {
    if (!entries.some((entry) => entry.id === rowId && entry.name === '@deepseek-ai/dsh-agent-preset')) {
      problems.push(`patch must insert preset row '${rowId}' targeting @deepseek-ai/dsh-agent-preset`)
    }
    if (!new RegExp(`id:\\s*['"]?${presetId}['"]?\\s*$`, 'm').test(text)) {
      problems.push(`patch preset row '${rowId}' must declare config.id '${presetId}'`)
    }
  }
  return problems
}

function exportedNames(text) {
  const names = new Set()
  for (const match of text.matchAll(/\bexport\s*\{([\s\S]*?)\}/g)) {
    for (const item of match[1].split(',')) {
      const clean = item.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      if (clean === '') continue
      const parts = clean.split(/\s+as\s+/)
      names.add((parts.at(-1) ?? '').trim())
    }
  }
  return names
}

function checkServerText(text) {
  const problems = []
  const exports = exportedNames(text)
  for (const name of ['name', 'inject', 'apply']) {
    if (!exports.has(name)) problems.push(`server bundle does not export ${name}`)
  }
  if (!/\b(?:const|var)\s+name\s*=\s*['"]dsh-soulmojito['"]/.test(text)) {
    problems.push(`server bundle name is not '${PLUGIN_NAME}'`)
  }
  if (!/\bfunction\s+apply\s*\(/.test(text)) problems.push('server bundle has no apply function')
  if (!/\b(?:const|var)\s+inject\s*=\s*\[/.test(text)) problems.push('server bundle has no inject array')
  if (!text.includes(API_PREFIX)) problems.push(`server bundle is missing API prefix ${API_PREFIX}`)
  for (const route of REQUIRED_SERVER_ROUTES) {
    if (!text.includes(`"${route}"`) && !text.includes(`'${route}'`)) {
      problems.push(`server bundle is missing API route marker '${route}'`)
    }
  }
  if (!/\bversion:\s*[A-Za-z_$][\w$]*/.test(text)) {
    problems.push('bootstrap payload must carry a runtime version stamp from version.json')
  }
  if (!/\bcommit:\s*[A-Za-z_$][\w$]*/.test(text)) {
    problems.push('bootstrap payload must carry a runtime-resolved commit stamp')
  }
  if (!text.includes('rev-parse') || !text.includes('--show-toplevel')) {
    problems.push('server bundle must resolve the commit from its own Git checkout at runtime')
  }
  if (!text.includes('version.json')) {
    problems.push('server bundle must read generated version.json')
  }
  if (!text.includes('assertStGenerationBinding')) {
    problems.push('server bundle must guard the ST generation route by architecture')
  }
  // 本地 ONNX embed（提案 0017）：身份锚 / 运行时包名 / installed 状态面三者缺一
  // 即可判定打包丢失。
  if (!text.includes('local-onnx:')) {
    problems.push('server bundle must carry the local-onnx identity anchor for local embed vectors')
  }
  if (!text.includes('@huggingface/transformers')) {
    problems.push('server bundle must reference the local ONNX embed runtime package')
  }
  if (!text.includes('runtimeInstalled')) {
    problems.push('server bundle must expose the local embed runtimeInstalled status')
  }
  // 自动填充（提案 0017 §自动填充）：PUT 缺省 pooling/dims 按模型目录推断——
  // 推断函数丢失即判定打包缺失。
  if (!text.includes('inferLocalModelSettings')) {
    problems.push('server bundle must infer pooling/dims defaults from the local model dir')
  }
  // 面板一键安装路由（提案 0017 §安装面）：路由 marker 必须在 bundle 里。
  if (!text.includes('memory/embed/local/install')) {
    problems.push('server bundle must expose the local runtime install route')
  }
  // 量化精度识别（2026-10-13）：目录扫描函数 + 检测路由 + 精度配置面三者丢失
  // 即判定打包缺失。
  if (!text.includes('detectLocalQuantizations')) {
    problems.push('server bundle must scan the local model dir for available quantizations')
  }
  if (!text.includes('memory/embed/local/quantizations')) {
    problems.push('server bundle must expose the local quantizations detection route')
  }
  if (!text.includes('resolveLocalDtype')) {
    problems.push('server bundle must resolve the configured local embed precision to a concrete dtype')
  }
  // 游戏桥（提案 0018 P0+P2）：跨 bundle 服务句柄锚（agent bundle 经同一
  // Symbol.for 解析）+ 导入期烟测函数 + 孤儿会话语义。games/revision 路由由
  // REQUIRED_SERVER_ROUTES 锁定；视图路由的 'view' 段在此一并锁。
  if (!text.includes('dsh-soulmojito:games-service')) {
    problems.push("server bundle must publish the games service handle 'dsh-soulmojito:games-service'")
  }
  if (!text.includes('smokeTestGameEngine')) {
    problems.push('server bundle must run the game engine import smoke test (smokeTestGameEngine)')
  }
  if (!text.includes('orphaned')) {
    problems.push('server bundle must carry the orphaned-session semantics marker')
  }
  // 视图路由 games/:gid/view/:sid 的动态段字面量（esbuild 输出统一双引号，
  // 两种引号形态都收）。
  if (!text.includes("'view'") && !text.includes('"view"')) {
    problems.push("server bundle must serve game views under games/:gid/view/:sid")
  }
  // 内置五子棋（2026-10-14 回归）：id 字面量须在 bundle 里（引擎 MANIFEST 与
  // 视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.gomoku')) {
    problems.push('server bundle must ship the builtin gomoku game (dsh-soulmojito.gomoku)')
  }
  // 内置中国象棋（2026-10-14）：同五子棋纪律——id 字面量须在 bundle 里
  // （引擎 MANIFEST 与视图 data-game 标记双处）。
  if (!text.includes('dsh-soulmojito.xiangqi')) {
    problems.push('server bundle must ship the builtin xiangqi game (dsh-soulmojito.xiangqi)')
  }
  // 内置军棋（2026-10-14）：同款纪律——id 字面量须在 bundle 里（引擎 MANIFEST
  // 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.junqi')) {
    problems.push('server bundle must ship the builtin junqi game (dsh-soulmojito.junqi)')
  }
  // 内置21点（2026-10-14）：同款纪律——id 字面量须在 bundle 里（引擎 MANIFEST
  // 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.blackjack')) {
    problems.push('server bundle must ship the builtin blackjack game (dsh-soulmojito.blackjack)')
  }
  // 内置记忆翻牌对战（2026-10-15）：同款纪律——id 字面量须在 bundle 里（引擎
  // MANIFEST 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.memory-match')) {
    problems.push('server bundle must ship the builtin memory-match game (dsh-soulmojito.memory-match)')
  }
  // 内置大富翁（2026-10-15）：同款纪律——id 字面量须在 bundle 里（引擎 MANIFEST
  // 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.monopoly')) {
    problems.push('server bundle must ship the builtin monopoly game (dsh-soulmojito.monopoly)')
  }
  // 内置地牢爬行（2026-10-16）：同款纪律——id 字面量须在 bundle 里（引擎 MANIFEST
  // 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.dungeon-crawl')) {
    problems.push('server bundle must ship the builtin dungeon-crawl game (dsh-soulmojito.dungeon-crawl)')
  }
  // 内置中国跳棋（2026-10-17）：同款纪律——id 字面量须在 bundle 里（引擎 MANIFEST
  // 与视图 data-game 标记双处都有）——丢失即判定内置游戏未随包分发。
  if (!text.includes('dsh-soulmojito.chinese-checkers')) {
    problems.push('server bundle must ship the builtin chinese-checkers game (dsh-soulmojito.chinese-checkers)')
  }
  // 地牢爬行视图反馈层（2026-10-16 用户需求「攻击等交互事件应弹出显眼的提示，
  // 在 PC 上支持 WASD 和方向键以及 JKL 绑定操作」）：事件提示栈与飘字伤害的
  // 容器/类名标记丢失即判定反馈层被拆（象棋将军提示层同款纪律）。
  if (!text.includes('dc-toast-stack')) {
    problems.push('server bundle must ship the dungeon-crawl event toast stack (dc-toast-stack)')
  }
  if (!text.includes('dc-float-num')) {
    problems.push('server bundle must ship the dungeon-crawl floating damage numbers (dc-float-num)')
  }
  // 将军提示层（2026-10-14 用户需求「象棋应该提供提示：如将军提示」）：警报
  // 横幅样式与光晕类名丢失即判定提示层未随视图分发（与 id 字面量同款纪律）。
  if (!text.includes('#banner.check')) {
    problems.push('server bundle must ship the xiangqi check banner style (#banner.check)')
  }
  if (!text.includes('check-halo')) {
    problems.push('server bundle must ship the xiangqi checked-general halo (check-halo)')
  }
  // 人类落子自动续弈（2026-10-14 用户需求）：等待登记的跨 bundle key（wake 的
  // 防重判据根）+ 通知消息 id 前缀（投递形状契约）须在 index bundle 里。
  if (!text.includes('dsh-soulmojito:games-waiters')) {
    problems.push("server bundle must carry the games waiters registry key 'dsh-soulmojito:games-waiters'")
  }
  if (!text.includes('game-notice-')) {
    problems.push('server bundle must carry the game wake notice id prefix (game-notice-)')
  }
  // 自动续弈的两道防重闸（2026-10-15 竞态修订，真机 g-60bfb716）：回合判定
  // （该手交出回合或终局）与运行中判定（agent status === 'running'）的函数声明名
  // 须在 bundle 里——丢失即判定防线被拆（大富翁决定窗 roll 的提前唤醒 / 运行中
  // 回合被 splice 成陈旧通知回合的回归）。
  if (!text.includes('function turnReachedAgent(')) {
    problems.push('server bundle must gate the game wake on the turn reaching the agent (turnReachedAgent)')
  }
  if (!text.includes('function agentTurnRunning(')) {
    problems.push('server bundle must gate the game wake on the agent turn being over (agentTurnRunning)')
  }
  // 投降门（2026-10-14 用户需求「禁用投降」）：状态键 + 服务层拒绝闸须在
  // index bundle 里（键在 store 归一化与面板补丁路由两处、闸在 games service）。
  if (!text.includes('gamesDisableResign')) {
    problems.push('server bundle must carry the games resign policy key (gamesDisableResign)')
  }
  if (!text.includes('assertResignAllowed')) {
    problems.push('server bundle must gate the resign action (assertResignAllowed)')
  }
  // 面板 zip 上传导入口（2026-10-17，提案 0018 §4.5 补记）：zip 解包装载函数、
  // tavern-format 的通用解包入口与 games/install 的 { zipBase64 } 请求键须在
  // index bundle 里——丢失即判定面板上传路径被拆（本地目录/git 导入走其他键，
  // 不会被这几条救活）。
  if (!text.includes('installFromZip')) {
    problems.push('server bundle must support zip game-package import (installFromZip)')
  }
  if (!text.includes('unzipArchive')) {
    problems.push('server bundle must unpack game-package zips through tavern-format (unzipArchive)')
  }
  if (!text.includes('zipBase64')) {
    problems.push('server bundle must accept { zipBase64 } on games/install')
  }
  // 改名兼容（2026-10-16 项目改名 dsh-tavern → DSH-SoulMojito；决策
  // decisions/2026-10-16-project-rename-dsh-soulmojito.md）：存量数据的读取
  // 通道必须在产物里——旧持久化名常量、旧 env 前缀、旧游戏命名空间别名前缀
  // 三者任一缺失即翻红（负样本自证见 server-bundle selfTest 的 renameCompat 段）。
  if (!text.includes('"dsh-tavern"') && !text.includes("'dsh-tavern'")) {
    problems.push('server bundle must ship the legacy persisted name (dsh-tavern) for rename-compat reads')
  }
  if (!text.includes('DSH_TAVERN_')) {
    problems.push('server bundle must ship the legacy env prefix (DSH_TAVERN_) for rename-compat reads')
  }
  if (!text.includes('"dsh-tavern."') && !text.includes("'dsh-tavern.'")) {
    problems.push('server bundle must ship the legacy game namespace alias prefix (dsh-tavern.) for rename-compat reads')
  }
  return problems
}


/**
 * 构建期 stamp 断言：esbuild define 必须把 __TAVERN_VERSION__ /
 * __TAVERN_COMMIT__ 全部替换成字面量。未替换的标识符在运行期 typeof 判断为
 * undefined，会让自更新退化成「commit 未知、只能比版本号」——静默失效比报错更
 * 难查，所以在 gate 里硬断言。
 */
function checkBuildStamps(text, version, commit) {
  const problems = []
  for (const stamp of ['__TAVERN_VERSION__', '__TAVERN_COMMIT__']) {
    if (text.includes(stamp)) {
      problems.push(`server bundle still contains the unstamped ${stamp} identifier (build through scripts/build-plugin.mjs)`)
    }
  }
  if (typeof version === 'string' && version !== '' && !text.includes(JSON.stringify(version))) {
    problems.push(`server bundle must carry the built version literal '${version}'`)
  }
  if (typeof commit === 'string' && commit !== '' && commit !== 'unknown' && !text.includes(JSON.stringify(commit))) {
    problems.push(`server bundle must carry the built commit literal '${commit}'`)
  }
  return problems
}

function checkVersionFile() {
  if (!existsSync(VERSION_PATH)) return ['generated packages/plugin/version.json does not exist']
  let value
  try {
    value = readJson(VERSION_PATH)
  } catch {
    return ['generated packages/plugin/version.json is not valid JSON']
  }
  const problems = []
  if (typeof value?.version !== 'string' || value.version.trim() === '') {
    problems.push('generated version.json must contain a non-empty version')
  } else if (value.version !== readJson(PACKAGE_PATH).version) {
    problems.push('generated version.json version must match package.json')
  }
  if (typeof value?.commit !== 'string' || value.commit.trim() === '') {
    problems.push('generated version.json must contain a non-empty commit')
  } else if (value.commit !== 'unknown' && !/^[0-9a-f]{7,40}$/i.test(value.commit)) {
    problems.push('generated version.json commit must be a Git SHA or unknown')
  }
  return problems
}

function checkServerFreshness(sourceMtime, bundleMtime) {
  return bundleMtime >= sourceMtime
    ? []
    : [`server bundle is stale (${new Date(bundleMtime).toISOString()} < ${new Date(sourceMtime).toISOString()})`]
}

function checkVersionFreshness(sourceMtime, versionMtime) {
  return versionMtime >= sourceMtime
    ? []
    : [`version.json is stale (${new Date(versionMtime).toISOString()} < ${new Date(sourceMtime).toISOString()})`]
}

function checkClientText(text) {
  const problems = []
  if (!/window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/.test(text)) {
    problems.push('client bundle must call window.__ModuleLoader__.load({...})')
  }
  if (!/(?:factory\s*:\s*(?:\(\s*require\s*\)|require)\s*=>|factory\s*\(\s*require\s*\)\s*\{)/.test(text)) {
    problems.push('client loader handoff must provide factory(require)')
  }

  for (const match of text.matchAll(/\brequire\s*\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1].trim()
    const literal = /^(['"])([^'"]+)\1$/.exec(argument)
    if (literal === null) {
      problems.push(`client bundle contains non-literal require(${argument})`)
    } else if (!CLIENT_STATIC_MODULES.has(literal[2])) {
      problems.push(`client bundle requires non-platform module '${literal[2]}'`)
    }
  }

  if (!/exports\.name\s*=\s*['"]dsh-soulmojito['"]/.test(text)) {
    problems.push(`client bundle must export name '${PLUGIN_NAME}'`)
  }
  if (!/exports\.inject\s*=/.test(text)) problems.push('client bundle must export inject')
  if (!/exports\.apply\s*=/.test(text)) problems.push('client bundle must export apply')
  for (const marker of ['revision', 'CHAT_REVISION_CONFLICT', 'bindings/prune', 'store-revision']) {
    if (!text.includes(marker)) problems.push(`client bundle is missing state-safety marker '${marker}'`)
  }
  // 改名兼容（2026-10-16 项目改名）：旧 producer kind 的客户端双读字面量须在
  // client half 里（存量会话的 marker 识别；负样本自证见 client-bundle selfTest）。
  if (!text.includes("'plugin:dsh-tavern'") && !text.includes('"plugin:dsh-tavern"')) {
    problems.push('client bundle must ship the legacy producer kind (plugin:dsh-tavern) for rename-compat reads')
  }
  if (text.includes('data-conversation-composer-overlay')) {
    problems.push('Tavern composer must use the native scroll layout, not composer overlay mode')
  }
  return problems
}

function checkFrontendRuntimeText(text) {
  const problems = []
  for (const marker of [
    'function extractFrontendDocuments',
    'function buildFrontendDocument',
    // Frontend default canvas (2026-10-21): the host resolves the DSH native
    // background and injects it as --dt-host-background; theme flips update it
    // via postMessage (no white ring in dark mode).
    "'--dt-host-background'",
    'html{background:var(--dt-host-background)}',
    // Late canvas rule (2026-10-21): cards with
    // `html,body{background:transparent!important}` must not win the cascade.
    'html{background:var(--dt-host-background)!important;}',
    'function frontendHostBackgroundColor()',
    'dsh-soulmojito:theme',
    'function useThemeBridge(frameRef)',
    'dsh-soulmojito:frontend-height',
    "sandbox: 'allow-scripts allow-modals'",
    "connect-src 'none'",
    'event.source !== frameRef.current?.contentWindow',
    'message.streaming',
    // Mod UI 表面（提案 0015 §3.5 P2）：postMessage 数据桥 + 桥路径预校验 +
    // ModSurface iframe（sandbox 同款纪律）。
    'dsh-soulmojito:mod-request',
    'dsh-soulmojito:mod-response',
    'function isValidModBridgePath',
    'function ModSurface({ mod, onLog })',
    // Mod 桥下行事件 + 声明式按钮 + 日志查看器（2026-10-11 A-1/A-2）：下行事件
    // 只走 token 对账的 postMessage（无新网络面）；按钮行必须挂在 ST 聊天视图
    // （TavernModButtons）并具备 mod-event 广播通道；mod-log 上行进环形缓冲。
    'dsh-soulmojito:mod-event',
    'dsh-soulmojito:mod-log',
    'function broadcastModEvent',
    'function TavernModButtons(',
    'function ModPanelSurface({ mod })',
    // 视口正确性 + 高度上报健壮性（2026-10-11 A-4）：vh 改写（--dt-viewport-height
    // CSS 变量）+ 宿主→iframe 视口投递（dsh-soulmojito:viewport）必须都在 client half。
    "'--dt-viewport-height'",
    "'dsh-soulmojito:viewport'",
    // ST 思考+正文双通道流式（2026-10-11）：/generate SSE 的 reasoning 增量必须被
    // 消费（event.type === 'reasoning'）进 run.streamReasoning，并以 dt-reasoning
    // 思考块渲染（流式展开、保存后折叠），双 locale 标签键齐备。
    'streamReasoning',
    "event.type === 'reasoning'",
    'dt-reasoning-body',
    "'message.thinking'",
    "'message.thoughts'",
    // 本地 ONNX embed 配置面（提案 0017）：provider 切换（远程端点/本地模型）、
    // 本地表单分发（provider === 'local'）与运行时未安装的双语提示键。
    "'settings.memoryProviderLocal'",
    "provider === 'local'",
    "'settings.memoryLocalRuntimeMissing'",
    // 自动填充回显（提案 0017 §自动填充）：保存后提示「已自动填了什么」。
    "'settings.memoryAutoFilled'",
    // 一键安装运行时按钮（提案 0017 §安装面）：本地 provider 且未装时出现。
    "'settings.memoryLocalInstall'",
    // 模式下拉含「关闭」（2026-10-13）：三态切换（关闭/远程/本地）。
    "'settings.memoryProviderOff'",
    // 量化精度下拉（2026-10-13）：标签键 + 按目录识别的检测端点调用。
    "'settings.memoryPrecision'",
    'memory/embed/local/quantizations',
    // 游戏对局面（提案 0018 §4.3，P1；2026-10-14 修订补对局面三面）：桥协议
    // 两条消息（与 src/games/view.ts 注入的桥脚本逐字段对齐）+ 清单/水位/开局/
    // 落子调用字面量 + 分区组件与 i18n 键 + MVU 同位对局面（ST 内联组件/共用
    // 数据 hook/右栏 tab 注册与开局自动展开；内联挂载顺序由 games-client.spec
    // 的源顺序断言锁定）。marker 全 ASCII（esbuild 中文转义不确定性是上一段
    // 的实测坑）。
    'dsh-soulmojito:game-state',
    'dsh-soulmojito:game-action',
    'games/list',
    'games/revision',
    'games/start',
    'games/action/',
    'function GameSurface({ session',
    'function GamesPanel({ useSessions })',
    'function TavernGameBoard({ sessionId, sidebar = false })',
    'function useChatGameSessions(character, chatId)',
    'function TavernGamesSidebarTab({ sessionId })',
    "'tavern-games'",
    'sidebarRight.openTab(GAMES_TAB_KIND)',
    // 2026-10-14 second revision: header games entry (MVU sibling), empty-state card, baseline-first.
    'const openGamesSurface = () => {',
    'dt-game-board-empty',
    ".then(() => api(`games/list${query}`))",
    // 2026-10-14 用户需求（投降按钮 + 终局保留盘面）：投降上行路径引用、
    // 「禁用投降」设置键、终局盘面补拉的见证集判据与投降按钮样式类——任一
    // 缺失即翻红（末条含终局「不只剩一行结果文案」的回归位）。
    'postActionRef.current({ type',
    'dt-game-actions',
    'dt-game-resign-armed',
    'gamesDisableResign',
    'witnessed[session.id] !== undefined',
    // 面板导入游戏包（2026-10-17，提案 0018 §4.5 补记）：zip 上传入口（体积预检 +
    // 读文件转 base64）、git 安装入口、games/install 调用、文件类型与状态文案键。
    // 任一缺失即判定导入口被拆（zh/en 双表齐备与占位符一致由 client-vm-mount 兜底）。
    'GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024',
    'const runGameImport = (source, busyKey) => {',
    'const importGameZip = (file) => {',
    'const installGameFromGit = () => {',
    "accept: '.zip,application/zip'",
    "api('games/install'",
    "t('games.import.tooLarge'",

    "'panel.section.games'",
    // 游戏图标=手柄 + 管理面板导航「标题区固定」（2026-10-14 用户反馈）：自绘手柄
    // 图标组件在场、导航分两段（品牌块常驻 + 清单滚动）的 DOM 结构与三条让它成立的
    // CSS 规则——nav 不再自滚（overflow:hidden）、清单独占滚动、header 不参与伸缩。
    'function IconGamepadOutline16(',
    "className: 'dt-panel-navlist'",
    '.dt-panel-nav{display:flex;flex-direction:column;gap:2px;width:198px;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow:hidden}',
    '.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}',
    '.dt-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
    // 移动端横条（同日移动端实况回归）：700px 断点里清单容器必须退场
    // （display:contents）——留着它，18 个分区按钮会在横向按钮条里竖排堆叠、
    // 把主区挤没（headless Chrome 390×844 实测：nav 667px / 主区 33px）。
    '.dt-panel-navlist{display:contents}',
    // 2026-10-21 导航重做（用户反馈「面板特别难用」）：分组清单 + 过滤框 +
    // 全屏切换 + 键盘导航 + 分区滚动记忆。逐一锁结构与让它成立的 CSS 规则——
    // 过滤框钉在清单外（与品牌同段常驻）、组容器/组标签渲染进清单、全屏修饰
    // 类吃满视口减 24px、移动端横条里过滤框与组标签退场、滚动记忆写读两行、
    // 自绘 info/expand/collapse 图标在场。任一回退都会让面板退回 18 项平铺。
    'const panelSectionGroups = [',
    "className: 'dt-panel-search'",
    "className: 'dt-panel-group'",
    "className: 'dt-panel-group-label'",
    "className: 'dt-panel-search-empty'",
    "className: 'dt-panel-expand'",
    "'data-dt-section': item.id",
    'body.scrollTop = scrollMemory.current[section] ?? 0',
    '.dt-panel-modal-full{width:calc(100vw - 24px)!important;height:calc(100vh - 24px)!important}',
    '.dt-panel-search{display:none}',
    '.dt-panel-group-label{display:none}',
    'function IconInfoOutline16(',
    'function IconExpand16(',
    'function IconCollapse16(',
    // Brand logo (2026-10-16 user request: the delivered assets/logo.svg replaces
    // the hand-drawn mark): the inlined SoulMojitoLogo component -- its viewBox
    // frame plus the palette carried by the asset -- and its four surfaces:
    // panel brand block (main name also moves from Tavern to SoulMojito),
    // sidebar footer action (visible label becomes the brand name), settings
    // panel entry and the about section header (official brand spelling). Any
    // surface left behind turns red.
    'function SoulMojitoLogo(',
    "viewBox: '-90 -100 180 190'",
    "h('strong', null, 'SoulMojito')",
    "className: 'dt-footer-label' }, 'SoulMojito'",
    "h('h3', null, 'DSH-SoulMojito')",
    // 侧栏两分区固定高度 + 独占滚动（2026-10-16 用户反馈：角色卡/会话过多时
    // 整块侧栏把宿主会话工作区挤到看不见）。三类 marker 逐一锁：酒馆/写卡
    // 工作台各自的内容容器（.dt-sidebar-scroll + 分区类）、让「固定高度 + 滚动」
    // 成立的唯一 CSS 规则，以及写卡工作台默认收起的 store 初值。任一回退都会
    // 让侧栏重新无限增高；容器换成 React.Fragment 是这次反馈的原始形态。
    "className: 'dt-sidebar-scroll dt-sidebar-tavern'",
    "className: 'dt-sidebar-scroll dt-sidebar-workbench'",
    '.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}',
    'sidebarCollapsed: { tavern: false, workbench: true }',
  ]) {
    if (!text.includes(marker)) problems.push(`frontend runtime is missing marker '${marker}'`)
  }
  return problems
}

function checkNativeHeaderAdapterText(text) {
  const problems = []
  for (const marker of [
    'AgentPresetLabel.module.css',
    'function useNativeAgentPresetLabelFilter',
    'dshSoulMojitoAgentPresetHiddenState',
    'data-dsh-soulmojito-agent-preset-hidden',
    'useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === \'st\'))',
  ]) {
    if (!text.includes(marker)) problems.push(`native Tavern header adapter is missing marker '${marker}'`)
  }
  return problems
}

/**
 * MVU 面板（提案 0012）的挂载门禁：面板必须在两个架构表面都可达——ST 走
 * TavernView 内联块，AgentTavern 走标题栏弹出层（原生 conversation 由宿主渲染，
 * 插件没有可插入正文区的 slot）。这些标记同时锁住「只有回执也要可见」的空态
 * 提示，防止「数据源修好了但界面又不挂载」的回归。
 *
 * 宿主 ≥0.2.0-rc.2 的原生右侧栏是第三个表面：tab 类型（kind tavern-mvu）经
 * ctx.inject(['sidebarRightTabs','sidebarRight']) 动态注册——服务缺失的旧宿主
 * 上回调不生效，插件其余表面照常工作，所以这两个服务名绝不能进 exports.inject
 * （会让旧宿主 apply 永久挂起）；body 挂 keyed slot sidebar.right.pane.tab
 * （key dsh-soulmojito/mvu），sessionId 由 keyed 注入回调显式传入。
 */
function checkMvuSurfaceText(text) {
  const problems = []
  for (const marker of [
    'function TavernMvuStatus(',
    "'data-dsh-soulmojito-surface': 'mvu'",
    'dt-mvu-slot',
    'dt-mvu-pop',
    'TavernMvuStatus, { sessionId, embedded: true',
    "'mvu.unavailable'",
    "const MVU_TAB_ID = 'dsh-soulmojito/mvu'",
    "const MVU_TAB_KIND = 'tavern-mvu'",
    "ctx.inject(['sidebarRightTabs', 'sidebarRight']",
    "'sidebar.right.pane.tab'",
    'sidebar: true',
    "'data-dsh-soulmojito-surface': 'mvu-sidebar'",
  ]) {
    if (!text.includes(marker)) problems.push(`MVU surface is missing marker '${marker}'`)
  }
  if (/exports\s*\.\s*inject\s*=\s*\[[^\]]*'sidebarRight/.test(text)) {
    problems.push("sidebarRight* must stay behind ctx.inject (exports.inject on pre-sidebar hosts would hang apply forever)")
  }
  return problems
}

function checkFrontendSurfaceText(text) {
  const problems = []
  for (const marker of [
    'function TavernFrontendPanel({ sessionId }) {',
    "const FRONTEND_TAB_ID = 'dsh-soulmojito/frontend'",
    "const FRONTEND_TAB_KIND = 'tavern-frontend'",
    "'data-dsh-soulmojito-surface': 'frontend-sidebar'",
    'frontend/latest${query}',
    "'frontend.inlineOnly'",
    "'frontend.refresh'",
    'key: FRONTEND_TAB_ID',
    'TavernFrontendSidebarTab',
    'sidebarRight.openTab(FRONTEND_TAB_KIND)',
    '.dt-frontend-side{box-sizing:border-box',
    // 自动展开开关（2026-10-20）：watcher 必须以设置为门（关闭时零轮询），且
    // 每聊天每楼层只展开一次。
    'function useFrontendAutoOpen(sessionId, binding, architecture, enabled)',
    "if (!enabled || !binding || architecture !== 'agent-tavern') return undefined",
    'autoOpenedRef.current.has(marker)',
    // 酒馆助手兼容层（2026-10-20）：沙箱内 shim + 宿主侧代理 + 事件白名单。
    "const HELPER_MESSAGE = 'dsh-soulmojito:helper'",
    'function frontendHelperScript(token, messageId)',
    'window.getVariables = function',
    'window.getChatMessages = function',
    'window.setChatMessages = function',
    'window.eventOn = function',
    'function useHelperBridge(frameRef, token, binding, refreshKey, hostSessionId)',
    'this frontend is not bound to a Tavern chat',
    'const HELPER_TAVERN_EVENTS = {',
    'window.triggerSlash = function',
    'window.builtin.renderMarkdown = function',
    'window.getTavernRegexes = function',
  ]) {
    if (!text.includes(marker)) problems.push(`frontend sidebar surface is missing marker '${marker}'`)
  }
  return problems
}

function checkClientArchitectureText(text) {
  const problems = []
  for (const marker of [
    'function newChatPolicy(group = false',
    "if (group) return { architecture: 'st', contextMode: 'dsh-native' }",
    ": state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'",
    "state.defaultContextMode === 'agent-managed'",
    "useNativeSessionTreeFilter(bindingIds, PanelHost.context",
    "const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})",
    "useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))",
    "if (policy.architecture === 'st') clickTavernTab(0)",
    'function reserveTavernSession(ctx, sessionId)',
    // 0.2.0-rc.2 契约：connectWorkspace 内部走 sessions.create，不隐式保留
    // 作用域；借 binding() 前必须显式 retain（ISessions.create 文档："retain
    // it before borrowing its binding"）。
    'DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)',
    'heldSession.release()',
    'select: selectTavernComposer',
    "disabled: bootstrap.agentTavern?.managed?.available !== true",
    'checked: bootstrap.state.agentTavernPreloadAssets === true',
    'existing[1].initializationPending === true',
  ]) {
    if (!text.includes(marker)) problems.push(`client architecture split is missing marker '${marker}'`)
  }
  return problems
}

function checkInternalWorkspaceText(serverText, clientText) {
  const problems = []
  for (const marker of [
    'internalWorkspace',
    'workbenchWorkspace',
    'TAVERN_WORKSPACE_TITLE',
    'TAVERN_WORKBENCH_WORKSPACE_TITLE',
    'tavernDataRoot("workspace")',
    'tavernDataRoot("workbench")',
    // 2026-10-21 数据根从 tavern 迁到 soulmojito：新目录常量、旧目录兼容
    // 常量与目录探测函数必须同时进服务端 bundle——少任何一个，旧安装会
    // 静默读到空库或新安装写回旧路径。
    'TAVERN_DATA_DIR',
    'LEGACY_TAVERN_DATA_DIR',
    'holdsTavernData',
  ]) {
    if (!serverText.includes(marker)) problems.push(`server internal workspace is missing marker '${marker}'`)
  }
  for (const marker of [
    'function ensureTavernWorkspace(ctx)',
    'function ensureWorkbenchWorkspace(ctx)',
    'ctx.workspaces.create({ path: config.path })',
    'function connectTavernWorkspace(ctx, workspaceId, agentPreset)',
    "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-tavern')",
    "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-novel')",
    "connectTavernWorkspace(ctx, workspace.workspaceId, 'card-workbench')",
    'uiWorkspace.connectWorkspace(workspaceId, options)',
    'ctx.workspaces.connectWorkspace(workspaceId)',
    'function pluginWorkspaceSnapshots(ctx)',
    'normalizeWorkspacePath(item?.path) === expectedPath',
    'function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback)',
    "items.filter((item) => item?.title === workspace.title).length === 1",
    "markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')",
  ]) {
    if (!clientText.includes(marker)) problems.push(`client internal workspace is missing marker '${marker}'`)
  }
  if (clientText.includes('function currentWorkspace(ctx)')) {
    problems.push('client must not route Tavern sessions through the current native workspace')
  }
  return problems
}

function checkAgentTavernIsolation(sourceFiles, serverText, agentText) {
  const problems = []
  for (const [name, text] of sourceFiles) {
    for (const [label, pattern] of [
      ['llm.stream', /\bllm\.stream\b/],
      ['runGeneration', /\brunGeneration\b/],
      ['ST prompt pipeline', /\bassemble(?:Prompt|TextCompletion)\b|\bpipelineMode\b/],
    ]) {
      if (pattern.test(text)) problems.push(`AgentTavern module '${name}' references ${label}`)
    }
  }
  for (const marker of ['agent-tavern/audit', 'assertStGenerationBinding(state, body.sessionId)']) {
    if (!serverText.includes(marker)) problems.push(`server architecture isolation is missing marker '${marker}'`)
  }
  // 游戏桥七工具 + 懒段（提案 0018 §4.2；game_wait 为 2026-10-14 修订，
  // game_history 为同日增量修订；game_wait_full 为 2026-10-16 带棋盘视图的
  // 等待变体）：工具名、order -63 段名与句柄解析 seam
  // 必须在 agent bundle 产物里（agent.mjs 是独立 esbuild 产物，源文件在场
  // 不等于打包在场；中文报文被 esbuild 转义为 \uXXXX，故锚 resolveGamesService）。
  if (agentText !== undefined) {
    for (const marker of ['game_list', 'game_start', 'game_state', 'game_history', 'game_move', 'game_wait', 'game_wait_full', 'dsh-soulmojito:agent-games', 'resolveGamesService']) {
      if (!agentText.includes(marker)) problems.push(`agent bundle is missing the games bridge marker '${marker}'`)
    }
  }
  return problems
}

function agentTavernSourceFiles() {
  // Native-execution isolation covers both agent architectures (proposal
  // 0005 §18 host isolation): agent-tavern and agent-novel sources must stay
  // free of plugin-side LLM loops and ST prompt pipeline calls. Subdirectories
  // (tools/*.ts) are scanned recursively so domain splits stay covered.
  const files = []
  const collect = (root, label) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const full = join(root, entry.name)
      const entryLabel = `${label}/${entry.name}`
      if (entry.isDirectory()) {
        collect(full, entryLabel)
        continue
      }
      if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) {
        files.push([entryLabel, readFileSync(full, 'utf8')])
      }
    }
  }
  for (const dir of ['agent-tavern', 'agent-novel']) {
    const root = join(PLUGIN_ROOT, 'src', dir)
    if (!existsSync(root)) continue
    collect(root, dir)
  }
  return files
}

function callableStub(label = 'stub') {
  const target = function stub() {}
  return new Proxy(target, {
    apply: () => undefined,
    construct: () => ({}),
    get: (_target, key) => {
      if (key === Symbol.toStringTag) return label
      if (key === 'then') return undefined
      return callableStub(`${label}.${String(key)}`)
    },
  })
}

function makeReactStub() {
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    cloneElement: (element, props, ...children) => ({ ...element, props: { ...element?.props, ...props }, children }),
    createContext: (value) => ({ Provider: callableStub('Provider'), Consumer: callableStub('Consumer'), _currentValue: value }),
    forwardRef: (render) => render,
    memo: (component) => component,
    useCallback: (fn) => fn,
    useContext: (context) => context?._currentValue,
    useEffect: () => {},
    useId: () => 'gate-id',
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useReducer: (_reducer, initial) => [initial, () => {}],
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  React.default = React
  return React
}

function makeClientRequire(primitives) {
  const React = makeReactStub()
  // The host's UI primitive table is the parity baseline: when it is readable the
  // stub exposes exactly those names, so a primitive the plugin asks for but the
  // host does not export stays undefined here just like it would in the browser.
  // Only the unreachable-host fallback keeps the permissive stub.
  const primitivesModule = primitives === null
    ? new Proxy({}, { get: (_target, name) => callableStub(`primitives.${String(name)}`) })
    : Object.fromEntries([...primitives].map((name) => [name, callableStub(`primitives.${name}`)]))
  const generic = callableStub('platform')
  const modules = {
    react: React,
    'react/jsx-runtime': {
      Fragment: React.Fragment,
      jsx: (type, props, key) => ({ type, props: props ?? {}, key }),
      jsxs: (type, props, key) => ({ type, props: props ?? {}, key }),
    },
    'react-dom': { createPortal: (node) => node },
    'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
    '@deepseek-ai/cordis': generic,
    '@deepseek-ai/dsh-client-store': generic,
    '@deepseek-ai/dsh-client-ui-slots': generic,
    '@deepseek-ai/dsh-client-ui-primitives': primitivesModule,
    '@deepseek-ai/dsh-client-ui-dockkit': generic,
  }
  return (specifier) => {
    if (!CLIENT_STATIC_MODULES.has(specifier) || !(specifier in modules)) {
      throw new Error(`client VM rejected require('${specifier}')`)
    }
    return modules[specifier]
  }
}

function makeFetchStub() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      state: { activeWorlds: [], chats: {} },
      characters: [],
      worlds: [],
      presets: [],
      personas: [],
      activeCard: null,
      model: { provider: 'stub', model: 'stub' },
    }),
    text: async () => '',
  })
}

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(String(key)) ?? null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: (key) => values.delete(String(key)),
    clear: () => values.clear(),
  }
}

function loadClientModule(code, options = {}) {
  let handoff = null
  const sandbox = {
    AbortController,
    Blob: globalThis.Blob,
    Buffer,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch: makeFetchStub(),
    localStorage: memoryStorage(),
    navigator: { language: 'en-US' },
    queueMicrotask,
    setInterval,
    setTimeout,
    structuredClone,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox
  sandbox.location = { href: 'http://localhost/', origin: 'http://localhost' }
  sandbox.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild: () => {} },
    createElement: () => ({ style: {}, dataset: {}, setAttribute: () => {}, appendChild: () => {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  }
  sandbox.__ModuleLoader__ = { load: (value) => { handoff = value } }

  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client/index.js', timeout: 2_000 })
  if (handoff === null) throw new Error('client did not hand a module to __ModuleLoader__.load')
  if (handoff.id !== PLUGIN_NAME) throw new Error(`client loader id must be '${PLUGIN_NAME}', got '${handoff.id}'`)
  if (typeof handoff.factory !== 'function') throw new Error('client loader handoff has no factory function')
  const module = handoff.factory(makeClientRequire(options.primitives ?? null))
  if (module === null || typeof module !== 'object' || typeof module.then === 'function') {
    throw new Error('client factory must synchronously return module exports')
  }
  return { module, sandbox }
}

function iterableEntries(value) {
  if (value === null || value === undefined) return []
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') return [...value]
  return [value]
}

/**
 * The client half resolves host UI atoms through @dsh-soulmojito/bind, which records
 * what it could actually serve. Anything the host cannot serve is either an icon
 * degraded to a null renderer (invisible button glyph) or a missing layout atom
 * (slot crashes on render) — both must fail the gate, which is what keeps a host
 * icon-set rename from shipping as a runtime React #130.
 */
function checkPrimitiveParity(trace) {
  const shape = trace?.uiPrimitives
  if (shape === undefined) {
    return ['client bundle must report host UI primitive resolution (window.__DSH_SOULMOJITO_BIND__.uiPrimitives)']
  }
  if (!Array.isArray(shape.synthesized) || !Array.isArray(shape.missing)) {
    return ['client shape trace must expose synthesized/missing UI primitive lists']
  }
  const problems = []
  if (shape.synthesized.length > 0) {
    problems.push(`host ${PRIMITIVES_PACKAGE} cannot serve these icons: ${shape.synthesized.join(', ')} (the 0.2.0-rc.2 set is stroke-suffixed, e.g. IconSparkleRegular/IconSparkleMedium)`)
  }
  if (shape.missing.length > 0) {
    problems.push(`host ${PRIMITIVES_PACKAGE} does not export: ${shape.missing.join(', ')}`)
  }
  return problems
}


const REQUIRED_UPDATE_KEYS = [
  'update.title',
  'update.current',
  'update.latest',
  'update.check',
  'update.checking',
  'update.now',
  'update.installing',
  'update.confirm',
  'update.restartHint',
  'update.restartHintWeb',
  'update.checkedAt',
  'update.notes',
  'update.remoteError',
  'update.status.available',
  'update.status.upToDate',
  'update.status.localAhead',
  'update.status.restartRequired',
  'update.status.unknown',
]

async function checkClientExecution(code, options = {}) {
  const problems = []
  let module
  let sandbox
  try {
    ({ module, sandbox } = loadClientModule(code, options))
  } catch (error) {
    return [`client VM load failed: ${error.message}`]
  }
  if (module.name !== PLUGIN_NAME) problems.push(`client runtime name must be '${PLUGIN_NAME}'`)
  if (!Array.isArray(module.inject)) problems.push('client runtime inject must be an array')
  else {
    if (!module.inject.includes('slots')) problems.push("client runtime inject must include 'slots'")
    if (!module.inject.includes('locale')) problems.push("client runtime inject must include 'locale' (DSH language following)")
  }
  if (typeof module.apply !== 'function') return [...problems, 'client runtime apply must be a function']

  const registrations = []
  const injections = []
  const localeRegistrations = []
  const localeBinds = []
  const sidebarRightTabTypes = []
  const slots = {
    inject: (name, callback) => {
      injections.push(name)
      for (const entry of iterableEntries(callback())) {
        if (entry !== undefined && entry !== null && !registrations.includes(entry)) registrations.push(entry)
      }
    },
    register: (options, component) => {
      const entry = { options, component }
      registrations.push(entry)
      return entry
    },
    entries: () => [],
    getVersion: () => 0,
    subscribe: () => () => {},
  }
  // ctx.inject(names, callback)：真实宿主上等所有命名服务就绪才运行回调（cordis
  // 动态注入）。VM 里模拟宿主已提供 sidebarRightTabs/sidebarRight 的 ≥0.2.0-rc.2
  // 场景立即同步运行，回调拿到的 scope 暴露 tab 注册表与同一份 slots mock。
  const serviceInjects = []
  const scopeFor = (names) => new Proxy({
    effect: (callback) => callback(),
    slots,
    ...(names.includes('sidebarRightTabs')
      ? { sidebarRightTabs: { register: (definition) => { sidebarRightTabTypes.push(definition); return () => {} } } }
      : {}),
  }, { get: (target, key) => (key in target ? target[key] : undefined) })
  const serviceFallback = callableStub('ctx')
  const context = new Proxy({
    effect: (callback) => callback(),
    inject: (names, callback) => {
      serviceInjects.push([...names])
      if (!names.includes('sidebarRightTabs') || !names.includes('sidebarRight')) return
      callback(scopeFor(names))
    },
    locale: {
      bind: (ns) => { localeBinds.push(ns); return (key) => key },
      register: (ns, dicts) => { localeRegistrations.push({ ns, dicts }) },
      getSnapshot: () => ({ revision: 0 }),
      subscribe: () => () => {},
    },
    slots,
  }, {
    get: (target, key) => key in target ? target[key] : serviceFallback,
  })

  try {
    module.apply(context)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
  } catch (error) {
    return [...problems, `client apply failed in VM: ${error.message}`]
  }

  const requiredSlots = [
    ['settings.section', PLUGIN_NAME],
    ['conversation.view', 'tavern'],
    ['conversation.composer', undefined],
    ['conversation.session.header.actions', PLUGIN_NAME],
    ['shell.overlay', 'dsh-soulmojito-panel'],
    ['sidebar.footer.action', 'dsh-soulmojito-panel'],
  ]
  for (const [name, id] of requiredSlots) {
    if (!injections.includes(name)) problems.push(`client apply did not inject the '${name}' slot`)
    const entry = registrations.find((candidate) => {
      const options = candidate?.options ?? candidate?.opts
      return options?.name === name && (id === undefined || options?.id === id)
    })
    if (entry === undefined) problems.push(`client apply did not register ${name}${id === undefined ? '' : ` id '${id}'}`}`)
  }
  // 原生右侧栏接入（宿主 ≥0.2.0-rc.2）：sidebarRightTabs/sidebarRight 服务在场
  // 时，apply 必须注册页面型 tab（kind tavern-mvu）并把 body 挂进 keyed slot
  // sidebar.right.pane.tab（key dsh-soulmojito/mvu）——guide 入口与标题栏按钮都靠它。
  if (!serviceInjects.some((names) => names.includes('sidebarRightTabs') && names.includes('sidebarRight'))) {
    problems.push('client apply did not request the sidebarRightTabs/sidebarRight services via ctx.inject')
  } else {
    const mvuType = sidebarRightTabTypes.find((definition) => definition?.kind === 'tavern-mvu')
    if (mvuType === undefined) {
      problems.push("client apply must register the sidebar-right MVU tab type (kind 'tavern-mvu')")
    } else {
      if (mvuType.id !== 'dsh-soulmojito/mvu') problems.push("MVU sidebar tab type id must be 'dsh-soulmojito/mvu'")
      if (typeof mvuType.title !== 'function') problems.push('MVU sidebar tab type must thunk its title for locale switches')
      if (!Array.isArray(mvuType.guide) || mvuType.guide.length === 0) problems.push('MVU sidebar tab type must contribute a guide entry')
      else if (typeof mvuType.guide[0]?.title !== 'function') problems.push('MVU sidebar guide entry must thunk its title')
    }
    const mvuBody = registrations.find((candidate) => {
      const options = candidate?.options ?? candidate?.opts
      return options?.name === 'sidebar.right.pane.tab' && options?.key === 'dsh-soulmojito/mvu'
    })
    if (mvuBody === undefined) problems.push("client apply must register the MVU sidebar body under keyed slot 'sidebar.right.pane.tab' (key 'dsh-soulmojito/mvu')")
    else if (typeof mvuBody.options?.inject !== 'function') problems.push('MVU sidebar body must pass sessionId through its keyed inject callback')
    // 美化前端 tab（2026-10-20）：与 MVU 同一条右栏通道，但承载的是消息内
    // 完整 HTML——AgentTavern 架构下插件没有正文 slot，这个 tab 是唯一展示面。
    const frontendType = sidebarRightTabTypes.find((definition) => definition?.kind === 'tavern-frontend')
    if (frontendType === undefined) {
      problems.push("client apply must register the sidebar-right frontend tab type (kind 'tavern-frontend')")
    } else {
      if (frontendType.id !== 'dsh-soulmojito/frontend') problems.push("frontend sidebar tab type id must be 'dsh-soulmojito/frontend'")
      if (typeof frontendType.title !== 'function') problems.push('frontend sidebar tab type must thunk its title for locale switches')
      if (!Array.isArray(frontendType.guide) || frontendType.guide.length === 0) problems.push('frontend sidebar tab type must contribute a guide entry')
      else if (typeof frontendType.guide[0]?.title !== 'function') problems.push('frontend sidebar guide entry must thunk its title')
    }
    const frontendBody = registrations.find((candidate) => {
      const options = candidate?.options ?? candidate?.opts
      return options?.name === 'sidebar.right.pane.tab' && options?.key === 'dsh-soulmojito/frontend'
    })
    if (frontendBody === undefined) problems.push("client apply must register the frontend sidebar body under keyed slot 'sidebar.right.pane.tab' (key 'dsh-soulmojito/frontend')")
    else if (typeof frontendBody.options?.inject !== 'function') problems.push('frontend sidebar body must pass sessionId through its keyed inject callback')
  }
  const localeRegistration = localeRegistrations.find((entry) => entry?.ns === PLUGIN_NAME)
  if (localeRegistration === undefined) {
    problems.push(`client apply must register '${PLUGIN_NAME}' dictionaries via ctx.locale.register`)
  } else {
    const zh = localeRegistration.dicts?.zh
    const en = localeRegistration.dicts?.en
    const zhKeys = Object.keys(zh ?? {}).sort()
    const enKeys = Object.keys(en ?? {}).sort()
    if (zhKeys.length === 0) problems.push('locale dictionaries must not be empty')
    if (zhKeys.join('\u0000') !== enKeys.join('\u0000')) {
      const missingInEn = zhKeys.filter((key) => !(key in (en ?? {})))
      const missingInZh = enKeys.filter((key) => !(key in (zh ?? {})))
      problems.push(`locale zh/en dictionaries diverge (missing in en: ${missingInEn.join(', ') || 'none'}; missing in zh: ${missingInZh.join(', ') || 'none'})`)
    } else {
      for (const key of zhKeys) {
        const zhParams = [...String(zh[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
        const enParams = [...String(en[key]).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(',')
        if (zhParams !== enParams) {
          problems.push(`locale key '${key}' must use the same {param} placeholders in zh and en`)
        }
      }
    }
  }
  if (options.requireUpdateWiring === true) {
    for (const marker of ['update/check', 'update/install']) {
      if (!code.includes(marker)) problems.push(`client bundle must call the host '${marker}' route`)
    }
    if (!/\bUpdateBand\b/.test(code)) problems.push('client bundle must render the UpdateBand surface')
    for (const key of REQUIRED_UPDATE_KEYS) {
      if (!(key in (localeRegistration?.dicts?.zh ?? {}))) problems.push(`zh dictionary is missing '${key}'`)
      if (!(key in (localeRegistration?.dicts?.en ?? {}))) problems.push(`en dictionary is missing '${key}'`)
    }
  }
  if (!localeBinds.includes(PLUGIN_NAME)) {
    problems.push(`client apply must bind the '${PLUGIN_NAME}' locale namespace via ctx.locale.bind`)
  }
  const settings = registrations.find((candidate) => (candidate?.options ?? candidate?.opts)?.name === 'settings.section')
  const settingsSource = settings?.component ? String(settings.component) : ''
  if (/generateFor|dt-transcript|MessageRow/.test(settingsSource)) {
    problems.push('settings.section must not own the Tavern transcript or generation workflow')
  }
  const composer = registrations.find((candidate) => (candidate?.options ?? candidate?.opts)?.name === 'conversation.composer')
  const selectComposer = (composer?.options ?? composer?.opts)?.select
  if (typeof selectComposer !== 'function') {
    problems.push('conversation.composer must expose a select function')
  } else {
    const stMarker = {
      key: 'marker',
      kind: 'context',
      data: { source: { kind: 'plugin', plugin: 'dsh-soulmojito', form: 'notice', tavernState: 'open' } },
    }
    const agentPreload = {
      key: 'preload',
      kind: 'context',
      data: { source: { kind: 'plugin', plugin: 'dsh-soulmojito', form: 'context' } },
    }
    const stSelected = selectComposer({ session: { chat: { order: ['marker'], nodes: new Map([['marker', stMarker]]) } } })
    const agentSelected = selectComposer({ session: { chat: { order: ['preload'], nodes: new Map([['preload', agentPreload]]) } } })
    const nativeSelected = selectComposer({ session: { chat: { order: [], nodes: new Map() } } })
    if (stSelected === null || stSelected === undefined) problems.push('legacy ST session must select the Tavern composer')
    if (agentSelected !== null) problems.push('AgentTavern preload context must keep the native composer')
    if (nativeSelected !== null) problems.push('native session must keep the native composer')
  }
  if (options.requirePrimitiveParity === true) {
    problems.push(...checkPrimitiveParity(sandbox.window?.__DSH_SOULMOJITO_BIND__))
  }
  return problems
}

function canResolveOfficialDependenciesFromRepo() {
  const require = createRequire(PACKAGE_PATH)
  try {
    require.resolve('@deepseek-ai/dsh-llm')
    require.resolve('@deepseek-ai/dsh-home-paths')
    return true
  } catch {
    return false
  }
}

function npmGlobalRoot() {
  const env = { ...process.env }
  for (const key of ['npm_config_prefix', 'npm_config_local_prefix', 'npm_config_global']) delete env[key]
  const result = spawnSync('npm root -g', [], {
    encoding: 'utf8',
    env,
    shell: true,
    timeout: 10_000,
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function hasOfficialDependencies(root) {
  return root !== null
    && existsSync(join(root, '@deepseek-ai', 'dsh-llm', 'package.json'))
    && existsSync(join(root, '@deepseek-ai', 'dsh-home-paths', 'package.json'))
}

function locateOfficialDependencyRoot() {
  const candidates = [
    // Keep the vendored runtime copied into the workspace usable in restricted
    // environments where the global npm installation is not readable.
    join(REPO_ROOT, '.npm-cache', 'dsh-runtime', 'node_modules'),
  ]
  for (const entry of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(entry, join(entry, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  const globalRoot = npmGlobalRoot()
  if (globalRoot !== null) {
    candidates.push(globalRoot, join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules'))
  }
  return candidates.find(hasOfficialDependencies) ?? null
}

const PRIMITIVES_PACKAGE = '@deepseek-ai/dsh-client-ui-primitives'

/**
 * The host's runtime export names for the UI primitive table. DSH 0.2.0-rc.2
 * renamed the whole product icon set from size suffixes (IconSparkle16) to
 * stroke suffixes (IconSparkleRegular/Medium); a plugin that still asks for the
 * old names destructures undefined and renders React #130 into every slot that
 * mounts the icon, so the client VM gate compares against this table instead of
 * handing out a stub for any name.
 *
 * DSH 0.2.1-rc.2 stopped installing @deepseek-ai/dsh-client-ui-primitives as a
 * resolvable package: the module now ships only inside the web frontend bundle
 * and reaches client modules through __ModuleLoader__'s built-in module table.
 * Read the package when it exists (0.2.0 installs, future re-ships), otherwise
 * decode the same table from the frontend asset that the browser will actually
 * load — never skip the parity check just because the package moved.
 */
function hostPrimitiveExports() {
  const root = locateOfficialDependencyRoot()
  if (root === null) return null
  const entry = [
    join(root, PRIMITIVES_PACKAGE, 'lib', 'index.js'),
    join(root, '@deepseek-ai', 'dsh', 'node_modules', PRIMITIVES_PACKAGE, 'lib', 'index.js'),
  ].find((candidate) => existsSync(candidate))
  if (entry !== undefined) {
    const names = exportNamesOf(readFileSync(entry, 'utf8'))
    if (names.size > 0) return names
  }
  return frontendPrimitiveExports(root)
}

/** Parse `export { a, b as c }` blocks from a package entry. */
function exportNamesOf(text) {
  const names = new Set()
  for (const block of text.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
    for (const part of block[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return names
}

/**
 * The frontend asset carries the primitive namespace as a frozen object:
 * `const <id>=Object.freeze(Object.defineProperty({__proto__:null,Button:…,
 * IconSparkleRegular:…},Symbol.toStringTag,…))`, and its client module table
 * maps "@deepseek-ai/dsh-client-ui-primitives" to that identifier. Decode the
 * keys of the mapped object: they are exactly the names a browser `require`
 * would expose.
 */
function frontendPrimitiveExports(root) {
  const assets = join(root, '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
  if (!existsSync(assets)) return null
  for (const file of readdirSync(assets).filter((name) => name.endsWith('.js'))) {
    const text = readFileSync(join(assets, file), 'utf8')
    const id = /"@deepseek-ai\/dsh-client-ui-primitives":([A-Za-z_$][\w$]*)/.exec(text)?.[1]
    if (id === undefined) continue
    const marker = `const ${id}=Object.freeze(Object.defineProperty({__proto__:null,`
    const start = text.indexOf(marker)
    if (start < 0) continue
    const bodyStart = start + marker.length
    const end = text.indexOf('},Symbol.toStringTag', bodyStart)
    if (end < 0) continue
    const names = new Set()
    for (const match of text.slice(bodyStart, end).matchAll(/(?:^|,)([A-Za-z_$][\w$]*):/g)) names.add(match[1])
    if (names.size > 0) return names
  }
  return null
}

const NODE_MOUNT_SCRIPT = String.raw`
const entry = process.env.DSH_SOULMOJITO_GATE_ENTRY
if (!entry) throw new Error('missing DSH_SOULMOJITO_GATE_ENTRY')
const mod = await import(entry)
const sections = []
const registrations = []
const effects = []
const ctx = {
  commands: { register: (value) => { registrations.push({ kind: 'command', name: value.name, handlerType: typeof value.handler }); if (value.name === 'dsh-soulmojito-session') commandHandler = value.handler; return () => {} } },
  systemPrompt: { section: (value) => { sections.push(value) } },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback, label) => { effects.push(label); return callback() },
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
}
let commandHandler = null
mod.apply(ctx)
// Novel-open payload parse probe (proposal 0005 §4.2 bridge): an unknown novel
// must produce a handled error, never the invalid-payload rejection.
let novelOpen = { kind: null, invalidPayload: true }
if (typeof commandHandler === 'function') {
  try {
    const sessionLog = []
    const novelAgent = {
      id: 'gate-novel-probe',
      ctx: {},
      session: {
        log: sessionLog,
        snapshotEvents: () => Object.freeze([...sessionLog]),
        append: (type, data) => { sessionLog.push({ type, seq: sessionLog.length, time: 0, data }) },
      },
    }
    const payload = Buffer.from(JSON.stringify({ action: 'novel-open', novelId: 'gate-probe' })).toString('base64url')
    const outcome = await commandHandler({ agent: novelAgent, rawInput: payload })
    novelOpen = { kind: outcome?.kind ?? null, invalidPayload: outcome?.text === 'Invalid Tavern activation payload.' }
  } catch (error) {
    novelOpen = { kind: 'threw', invalidPayload: true, message: String(error?.message ?? error) }
  }
}
console.log('DSH_SOULMOJITO_GATE_RESULT=' + JSON.stringify({
  name: mod.name,
  inject: mod.inject,
  applyType: typeof mod.apply,
  sections: sections.map(({ name, order, text }) => ({ name, order, textType: typeof text })),
  registrations: registrations.map(({ kind, path, name, handler, handlerType }) => ({ kind, path, name, handlerType: handlerType ?? typeof handler })),
  effects,
  novelOpen,
}))
`

function checkNodeMountResult(result) {
  const problems = []
  if (result.name !== PLUGIN_NAME) problems.push(`Node module name must be '${PLUGIN_NAME}'`)
  if (result.applyType !== 'function') problems.push('Node module apply export must be a function')
  if (!Array.isArray(result.inject)) {
    problems.push('Node module inject export must be an array')
  } else {
    // 与 src/index.ts 的 inject 声明同步的宿主服务全集（0.2.0-rc.2 审计后从 6
    // 项补齐到 9 项）：宿主移除任一服务时这里必须报警，而不是等运行期抛错。
    for (const service of ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction']) {
      if (!result.inject.includes(service)) problems.push(`Node module inject must include '${service}'`)
    }
  }
  const section = result.sections?.find((value) => value.name === 'dsh-soulmojito:active-character')
  if (section === undefined) problems.push('Node apply did not register the dsh-soulmojito systemPrompt section')
  else if (section.textType !== 'function' && section.textType !== 'string') {
    problems.push('Node systemPrompt section text must be a function or string')
  }
  const route = result.registrations?.find((value) => value.kind === 'prefix' && value.path === API_PREFIX)
  if (route === undefined) problems.push(`Node apply did not register webServer prefix ${API_PREFIX}`)
  else if (route.handlerType !== 'function') problems.push('Node webServer prefix has no handler function')
  const command = result.registrations?.find((value) => value.kind === 'command' && value.name === 'dsh-soulmojito-session')
  if (command === undefined) problems.push("Node apply did not register the internal Tavern session bridge")
  else if (command.handlerType !== 'function') problems.push('Node Tavern session bridge has no handler function')
  if (result.registrations?.some((value) => value.kind === 'command' && value.name === 'tavern')) {
    problems.push("Node apply must not expose the public '/tavern' activation command")
  }
  if (result.novelOpen?.invalidPayload !== false) {
    problems.push('internal session bridge must parse novel-open payloads (expected a handled unknown-novel error)')
  }
  return problems
}

function runNodeMount() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-gate-'))
  try {
    let entryPath = SERVER_PATH
    let dependencyRoot = null
    if (!canResolveOfficialDependenciesFromRepo()) {
      dependencyRoot = locateOfficialDependencyRoot()
      if (dependencyRoot === null) {
        return ['official @deepseek-ai dependencies are not resolvable from the repo, NODE_PATH, or global DSH install']
      }
      entryPath = join(tempRoot, 'index.mjs')
      copyFileSync(SERVER_PATH, entryPath)
      copyFileSync(VERSION_PATH, join(tempRoot, 'version.json'))
      symlinkSync(dependencyRoot, join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    }

    const dshHome = join(tempRoot, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', NODE_MOUNT_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_SOULMOJITO_GATE_ENTRY: pathToFileURL(entryPath).href,
        ...(dependencyRoot === null ? {} : { NODE_PATH: dependencyRoot }),
      },
      timeout: 20_000,
      windowsHide: true,
    })
    if (child.error) return [`Node mount subprocess failed: ${child.error.message}`]
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout).trim().split(/\r?\n/).at(-1) ?? `exit ${child.status}`
      return [`Node mount subprocess exited ${child.status}: ${detail}`]
    }
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('DSH_SOULMOJITO_GATE_RESULT='))
    if (line === undefined) return ['Node mount subprocess returned no result record']
    return checkNodeMountResult(JSON.parse(line.slice('DSH_SOULMOJITO_GATE_RESULT='.length)))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}


const UPDATE_ROUTE_SCRIPT = String.raw`
const entry = process.env.DSH_SOULMOJITO_GATE_ENTRY
if (!entry) throw new Error('missing DSH_SOULMOJITO_GATE_ENTRY')
const mod = await import(entry)
const registrations = []
const installedSpecs = []
const installBundleOptions = []
let installLogHandler = null
const pluginManagerStub = {
  installBundle: (spec, options) => {
    installedSpecs.push(spec)
    installBundleOptions.push(options || {})
    if (typeof installLogHandler === 'function') {
      installLogHandler({ requestId: options?.requestId, jobId: 'gate', argv: ['pnpm', 'add', spec], cwd: process.cwd(), stream: 'stdout', text: 'Progress: resolved 1, added 1' })
    }
    return Promise.resolve({ changed: true, application: 'restart-required', stage: 'install', target: spec, bundle: 'dsh-soulmojito' })
  },
}
const ctx = {
  commands: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback) => callback(),
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  get: (name) => (name === 'pluginManager' ? pluginManagerStub : undefined),
  on: (event, handler) => { if (event === 'plugin-manager/install-log') installLogHandler = handler; return () => {} },
}
mod.apply(ctx)
const UPDATE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
globalThis.fetch = async (url) => {
  const target = String(url)
  const reply = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) })
  if (target.includes('api.github.com') && target.includes('/commits/')) return reply({ sha: UPDATE_SHA, commit: { message: 'feat: update', author: { date: '2026-10-05T00:00:00Z' } } })
  if (target.includes('api.github.com') && target.includes('/compare/')) return reply({ commits: [{ sha: UPDATE_SHA, commit: { message: 'feat: update' } }], files: [{ filename: 'packages/plugin/index.mjs' }] })
  if (target.includes('raw.githubusercontent.com')) return reply({ version: '9.9.9' })
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
}
const route = registrations.find((value) => value.kind === 'prefix' && value.path === '/api/dsh-soulmojito')
function callRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      on: (event, handler) => { if (event === 'data') for (const chunk of chunks) handler(chunk); if (event === 'end') handler(); return req },
    }
    const res = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      write: () => {},
      end: (payload) => {
        res.writableEnded = true
        try { resolve({ status: res.statusCode, body: payload === undefined ? null : JSON.parse(payload) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
const probe = { reachable: false }
if (route !== undefined && typeof route.handler === 'function') {
  const checked = await callRoute('GET', '/api/dsh-soulmojito/update?refresh=1')
  const checkedUpdate = checked.body && checked.body.update ? checked.body.update : {}
  const changelog = checked.body && Array.isArray(checked.body.changelog) ? checked.body.changelog : []
  const missing = await callRoute('GET', '/api/dsh-soulmojito/update/nope')
  const installed = await callRoute('POST', '/api/dsh-soulmojito/update/install', { wait: false })
  const startedFlag = installed.body ? installed.body.started === true : false
  let afterInstall = installed.body && installed.body.update ? installed.body.update : {}
  for (let attempt = 0; attempt < 40 && afterInstall.install && afterInstall.install.running === true; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    const polled = await callRoute('GET', '/api/dsh-soulmojito/update')
    afterInstall = polled.body && polled.body.update ? polled.body.update : afterInstall
  }
  const installState = afterInstall.install || {}
  const log = Array.isArray(installState.log) ? installState.log : []
  probe.reachable = true
  probe.checkStatus = checkedUpdate.status || null
  probe.checkCommit = checkedUpdate.remote ? checkedUpdate.remote.commit || null : null
  probe.checkVersion = checkedUpdate.remote ? checkedUpdate.remote.version || null : null
  probe.localVersion = checkedUpdate.local ? checkedUpdate.local.version || null : null
  probe.spec = checkedUpdate.spec || null
  probe.changelog = changelog
  probe.missingRouteStatus = missing.status
  probe.installStarted = startedFlag
  probe.installPhase = installState.phase || null
  probe.installStrategy = installState.strategy || null
  probe.installRestartRequired = installState.restartRequired === true
  probe.installLogTail = log.slice(-5).join(' | ')
  probe.installedSpecs = installedSpecs
  probe.installRequestId = typeof installBundleOptions[0]?.requestId === 'string'
}
console.log('DSH_SOULMOJITO_GATE_RESULT=' + JSON.stringify(probe))
`

function checkUpdateRouteResult(result) {
  const problems = []
  if (result?.reachable !== true) {
    problems.push('update routes did not answer through the webServer prefix handler')
    return problems
  }
  if (result.checkStatus !== 'update-available') problems.push('update check must report update-available for a newer remote build')
  if (result.checkCommit !== 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678') problems.push('update check must carry the remote commit')
  if (result.checkVersion !== '9.9.9') problems.push('update check must read the remote package.json version')
  if (typeof result.localVersion !== 'string' || result.localVersion === '') problems.push('update check must report the local build version')
  if (result.spec !== 'github:LingyeSoul/DSH-SoulMojito#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin') {
    problems.push('update snapshot must expose a pinned pnpm git spec')
  }
  if (!Array.isArray(result.changelog) || result.changelog.length === 0) problems.push('update check must return a changelog')
  if (result.missingRouteStatus !== 404) problems.push('unknown update subroutes must answer 404')
  if (result.installStarted !== true) problems.push('update install must acknowledge the started job')
  if (result.installPhase !== 'done') problems.push('update install must finish in the done phase when the plugin manager succeeds')
  if (result.installStrategy !== 'plugin-manager') problems.push('update install must report which落地 strategy ran')
  if (result.installRestartRequired !== true) problems.push('a plugin-manager package replacement must report restart-required')
  if (!result.installLogTail.includes('Progress: resolved 1')) problems.push('pnpm install-log chunks must reach the update snapshot')
  if (result.installRequestId !== true) problems.push('installBundle must receive a requestId so pnpm output can be correlated')
  const specs = Array.isArray(result.installedSpecs) ? result.installedSpecs : []
  if (specs.length !== 1 || !String(specs[0]).includes('#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin')) {
    problems.push('installBundle must be called once with the pinned subdirectory spec')
  }
  return problems
}

function runUpdateRouteProbe() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-update-gate-'))
  try {
    let entryPath = SERVER_PATH
    let dependencyRoot = null
    if (!canResolveOfficialDependenciesFromRepo()) {
      dependencyRoot = locateOfficialDependencyRoot()
      if (dependencyRoot === null) {
        return ['official @deepseek-ai dependencies are not resolvable from the repo, NODE_PATH, or global DSH install']
      }
      entryPath = join(tempRoot, 'index.mjs')
      copyFileSync(SERVER_PATH, entryPath)
      copyFileSync(VERSION_PATH, join(tempRoot, 'version.json'))
      symlinkSync(dependencyRoot, join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const dshHome = join(tempRoot, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', UPDATE_ROUTE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_PROFILE: 'desktop',
        // 让 CLI 落地路径确定性失败（文件不存在），把安装逼到 plugin-manager 替身上。
        DSH_SOULMOJITO_DSH_CLI: join(tempRoot, 'missing-cli.js'),
        DSH_SOULMOJITO_GATE_ENTRY: pathToFileURL(entryPath).href,
        ...(dependencyRoot === null ? {} : { NODE_PATH: dependencyRoot }),
      },
      timeout: 30_000,
      windowsHide: true,
    })
    if (child.error) return ['update route subprocess failed: ' + child.error.message]
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout).trim().split(/\r?\n/).at(-1) ?? 'exit ' + child.status
      return ['update route subprocess exited ' + child.status + ': ' + detail]
    }
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('DSH_SOULMOJITO_GATE_RESULT='))
    if (line === undefined) return ['update route subprocess returned no result record']
    return checkUpdateRouteResult(JSON.parse(line.slice('DSH_SOULMOJITO_GATE_RESULT='.length)))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * mod-loader gate（提案 0015 §5 四不变量）：默认关（modsEnabled 与
 * enabled.<id> 双默认 false）、目录白名单（只扫 <tavern>/mods/ 且 path 校验拒
 * 穿越）、超时常量在 bundle、禁用时 mods 路由 404。真实 bundle 子进程探测 +
 * 静态 marker，update-routes gate 同款；示例 Mod（examples/mods/dsh-soulmojito.asset-stats）
 * 是夹具，另放一个坏 mod.json 证明坏 Mod 不断路。
 */
const EXAMPLE_MOD_ID = 'dsh-soulmojito.asset-stats'

const MOD_LOADER_SCRIPT = String.raw`
const entry = process.env.DSH_SOULMOJITO_GATE_ENTRY
if (!entry) throw new Error('missing DSH_SOULMOJITO_GATE_ENTRY')
const modId = process.env.DSH_SOULMOJITO_GATE_MOD_ID
const mod = await import(entry)
const registrations = []
const ctx = {
  commands: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback) => callback(),
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  agents: { get: () => undefined },
}
mod.apply(ctx)
const route = registrations.find((value) => value.kind === 'prefix' && value.path === '/api/dsh-soulmojito')
function callRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      on: (event, handler) => { if (event === 'data') for (const chunk of chunks) handler(chunk); if (event === 'end') handler(); return req },
    }
    const res = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      write: () => {},
      end: (payload) => {
        res.writableEnded = true
        if (payload === undefined) { resolve({ status: res.statusCode, body: null }); return }
        // mod 的 ui 路由回 HTML：JSON.parse 失败时回退原文（P2 探测要断言 CSP）。
        try { resolve({ status: res.statusCode, body: JSON.parse(payload) }) } catch { resolve({ status: res.statusCode, body: String(payload) }) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
const probe = {}
const boot = await callRoute('GET', '/api/dsh-soulmojito/bootstrap')
probe.bootstrapMods = Array.isArray(boot.body?.mods) ? boot.body.mods.map((item) => item.id) : null
probe.bootstrapAllDisabled = Array.isArray(boot.body?.mods) && boot.body.mods.length > 0 && boot.body.mods.every((item) => item.enabled === false)
probe.management = await callRoute('GET', '/api/dsh-soulmojito/mods')
probe.defaultOffStatus = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')).status
await callRoute('POST', '/api/dsh-soulmojito/mods/' + modId + '/enable', {})
probe.perModOnlyGlobal = probe.management.body?.globalEnabled
probe.perModOnlyStatus = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')).status
await callRoute('POST', '/api/dsh-soulmojito/mods/state', { globalEnabled: true })
const loaded = await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')
probe.loadedStatus = loaded.status
probe.loadedCounts = Boolean(loaded.body?.counts)
probe.unknownRouteStatus = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/nope')).status
probe.traversalStatus = (await callRoute('GET', '/api/dsh-soulmojito/mods/..%2F..%2Findex.mjs')).status
probe.reloadStatus = (await callRoute('POST', '/api/dsh-soulmojito/mods/' + modId + '/reload', {})).status
probe.statsAfterReload = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')).status
await callRoute('POST', '/api/dsh-soulmojito/mods/' + modId + '/disable', {})
probe.disabledAgainStatus = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')).status
const afterBroken = await callRoute('GET', '/api/dsh-soulmojito/mods')
probe.brokenStatus = Array.isArray(afterBroken.body?.mods) ? (afterBroken.body.mods.find((item) => item.id === 'broken-mod')?.status ?? null) : null
probe.bootstrapAfterBrokenStatus = (await callRoute('GET', '/api/dsh-soulmojito/bootstrap')).status

// ---- P2 能力面探测（提案 0015 §4）：llm 能力键、三件套示例 Mod、跨 bundle 吸收 ----
await callRoute('POST', '/api/dsh-soulmojito/mods/dsh-soulmojito.mood-tracker/enable', {})
await callRoute('POST', '/api/dsh-soulmojito/mods/p2-probe/enable', {})
await callRoute('POST', '/api/dsh-soulmojito/mods/p2-plain/enable', {})
const moodUi = await callRoute('GET', '/api/dsh-soulmojito/mods/dsh-soulmojito.mood-tracker/ui')
probe.moodUiStatus = moodUi.status
probe.moodUiCsp = typeof moodUi.body === 'string' ? moodUi.body : JSON.stringify(moodUi.body ?? '')
const llmProbe = await callRoute('GET', '/api/dsh-soulmojito/mods/p2-probe/llm')
probe.p2LlmKey = llmProbe.body?.hasLlm === true
const plainProbe = await callRoute('GET', '/api/dsh-soulmojito/mods/p2-plain/llm')
probe.p2PlainNoLlmKey = plainProbe.body?.hasLlm === false
// 跨 bundle 实测（§3.6 定案的 gate 级验证）：同一进程里再挂 agent bundle，
// 其注册表快照必须看到 index bundle 装载的 mod 工具（globalThis Symbol.for 互见）
// 且 section order 被钳制在 [-50, 0]。
const agentEntry = process.env.DSH_SOULMOJITO_GATE_AGENT_ENTRY
if (agentEntry) {
  const agentTools = []
  const agentSections = []
  const agentModule = await import(agentEntry)
  agentModule.apply({
    systemPrompt: {
      section: (section) => { agentSections.push({ name: section.name, order: section.order, text: typeof section.text === 'string' ? section.text : '' }); return () => {} },
      context: () => {},
    },
    tools: { register: (tool) => { agentTools.push(tool.name); return () => {} } },
    effect: (callback) => { callback(); return () => {} },
  })
  probe.agentHasMoodTool = agentTools.includes('dsh-soulmojito.mood-tracker_get_mood')
  probe.agentHasBuiltin = agentTools.includes('tavern_character_get')
  const probeSection = agentSections.find((section) => section.name === 'dsh-soulmojito:mod:p2-probe:probe')
  probe.agentSectionPresent = probeSection !== undefined
  probe.agentSectionTextNeutralized = probeSection !== undefined && !probeSection.text.includes('{{')
  probe.agentSectionOrderClamped = probeSection !== undefined && probeSection.order >= -50 && probeSection.order <= 0
}
console.log('DSH_SOULMOJITO_GATE_RESULT=' + JSON.stringify(probe))
`

const MOD_LOADER_ENV_SCRIPT = String.raw`
const entry = process.env.DSH_SOULMOJITO_GATE_ENTRY
if (!entry) throw new Error('missing DSH_SOULMOJITO_GATE_ENTRY')
const modId = process.env.DSH_SOULMOJITO_GATE_MOD_ID
const mod = await import(entry)
const registrations = []
const ctx = {
  commands: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  webServer: { register: (value) => { registrations.push(value); return () => {} } },
  effect: (callback) => callback(),
  llm: { stream: async function* () {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
  agents: { get: () => undefined },
}
mod.apply(ctx)
const route = registrations.find((value) => value.kind === 'prefix' && value.path === '/api/dsh-soulmojito')
function callRoute(method, url, body) {
  return new Promise((resolve, reject) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url,
      on: (event, handler) => { if (event === 'data') for (const chunk of chunks) handler(chunk); if (event === 'end') handler(); return req },
    }
    const res = {
      statusCode: 0,
      headersSent: false,
      writableEnded: false,
      setHeader: () => {},
      write: () => {},
      end: (payload) => {
        res.writableEnded = true
        try { resolve({ status: res.statusCode, body: payload === undefined ? null : JSON.parse(payload) }) } catch (error) { reject(error) }
      },
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}
const probe = {}
const boot = await callRoute('GET', '/api/dsh-soulmojito/bootstrap')
probe.envBootstrapModsEmpty = Array.isArray(boot.body?.mods) && boot.body.mods.length === 0
probe.envBootstrapAvailable = boot.body?.modsAvailable === false
const management = await callRoute('GET', '/api/dsh-soulmojito/mods')
probe.envAvailable = management.body?.available === false
await callRoute('POST', '/api/dsh-soulmojito/mods/' + modId + '/enable', {})
await callRoute('POST', '/api/dsh-soulmojito/mods/state', { globalEnabled: true })
probe.envStatsAfterEnabling = (await callRoute('GET', '/api/dsh-soulmojito/mods/' + modId + '/stats')).status
console.log('DSH_SOULMOJITO_GATE_RESULT=' + JSON.stringify(probe))
`

/**
 * 校验探测结果。requireEnvOff=false 用于第一段探测（主探测不含 env 硬关子
 * 进程的字段）；合并 envOff 后的第二段用默认 true。
 */
function checkModLoaderResult(result, { requireEnvOff = true } = {}) {
  const problems = []
  if (!Array.isArray(result?.bootstrapMods) || !result.bootstrapMods.includes(EXAMPLE_MOD_ID)) {
    problems.push('bootstrap must list the installed example mod')
  }
  if (result?.bootstrapAllDisabled !== true) {
    problems.push('mods must default to disabled in the bootstrap projection (both state switches default false)')
  }
  if (result?.perModOnlyGlobal !== false || result?.defaultOffStatus !== 404 || result?.perModOnlyStatus !== 404) {
    problems.push('mod routes must 404 until BOTH the global switch and the per-mod switch are on')
  }
  if (result?.loadedStatus !== 200 || result?.loadedCounts !== true) {
    problems.push('both switches on must load the mod and serve its registered route')
  }
  if (result?.unknownRouteStatus !== 404) problems.push('unknown mod subroutes must 404')
  if (result?.traversalStatus !== 404) problems.push('path traversal in mod subroutes must be rejected with 404')
  if (result?.reloadStatus !== 200 || result?.statsAfterReload !== 200) {
    problems.push('reload must dispose and re-import the mod entry (route serves again)')
  }
  if (result?.disabledAgainStatus !== 404) problems.push('a disabled mod must answer 404 again')
  if (result?.brokenStatus !== 'error') problems.push('a broken mod.json must surface as status error, not crash the host')
  if (result?.bootstrapAfterBrokenStatus !== 200) problems.push('bootstrap must stay 200 next to a broken mod')
  // ---- P2 能力面（提案 0015 §4）----
  if (result?.moodUiStatus !== 200 || !String(result?.moodUiCsp ?? '').includes('Content-Security-Policy')) {
    problems.push('the panel-surface example mod must serve GET ui as HTML with the CSP meta injected')
  }
  if (result?.p2LlmKey !== true) problems.push('a mod declaring the llm capability must see api.llm injected')
  if (result?.p2PlainNoLlmKey !== true) problems.push('a mod without the llm capability must NOT see the api.llm key')
  if (result?.agentHasMoodTool !== true || result?.agentHasBuiltin !== true) {
    problems.push('the agent bundle mount must absorb mod tools from the cross-bundle registry next to its builtin tools')
  }
  if (result?.agentSectionPresent !== true || result?.agentSectionOrderClamped !== true) {
    problems.push('the agent bundle mount must absorb mod prompt sections with order clamped to [-50, 0]')
  }
  if (result?.agentSectionTextNeutralized !== true) {
    problems.push('mod prompt section text must be neutralized (no raw {{...}} host-variable syntax)')
  }
  if (!requireEnvOff) return problems
  const env = result?.envOff ?? {}
  if (env.envAvailable !== true || env.envBootstrapAvailable !== true || env.envBootstrapModsEmpty !== true) {
    problems.push('DSH_SOULMOJITO_DISABLE_MODS=1 must hard-disable mods (management reports unavailable, projection empty)')
  }
  if (env.envStatsAfterEnabling !== 404) {
    problems.push('with mods hard-disabled by env, enabling both state switches must still answer 404')
  }
  return problems
}

function runModLoaderProbe(script, extraEnv = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-mod-gate-'))
  try {
    let entryPath = SERVER_PATH
    let dependencyRoot = null
    if (!canResolveOfficialDependenciesFromRepo()) {
      dependencyRoot = locateOfficialDependencyRoot()
      if (dependencyRoot === null) {
        return ['official @deepseek-ai dependencies are not resolvable from the repo, NODE_PATH, or global DSH install']
      }
      entryPath = join(tempRoot, 'index.mjs')
      copyFileSync(SERVER_PATH, entryPath)
      copyFileSync(VERSION_PATH, join(tempRoot, 'version.json'))
      symlinkSync(dependencyRoot, join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    const dshHome = join(tempRoot, 'dsh-home')
    // 2026-10-21 起干净 home 的数据根是 soulmojito/（旧目录兼容只在旧库存在时生效）。
    const modsRoot = join(dshHome, 'soulmojito', 'mods')
    // 夹具：示例 Mod（仓库交付物）+ 坏 mod.json（坏 Mod 不断路反样本）+ P2 探针
    // （三件套示例 mod + llm 能力键有无的对照双 mod）。
    const exampleDir = join(modsRoot, EXAMPLE_MOD_ID)
    mkdirSync(exampleDir, { recursive: true })
    copyFileSync(join(PLUGIN_ROOT, 'examples', 'mods', 'dsh-soulmojito.asset-stats', 'mod.json'), join(exampleDir, 'mod.json'))
    copyFileSync(join(PLUGIN_ROOT, 'examples', 'mods', 'dsh-soulmojito.asset-stats', 'index.mjs'), join(exampleDir, 'index.mjs'))
    const moodDir = join(modsRoot, 'dsh-soulmojito.mood-tracker')
    mkdirSync(moodDir, { recursive: true })
    copyFileSync(join(PLUGIN_ROOT, 'examples', 'mods', 'dsh-soulmojito.mood-tracker', 'mod.json'), join(moodDir, 'mod.json'))
    copyFileSync(join(PLUGIN_ROOT, 'examples', 'mods', 'dsh-soulmojito.mood-tracker', 'index.mjs'), join(moodDir, 'index.mjs'))
    const llmProbeDir = join(modsRoot, 'p2-probe')
    mkdirSync(llmProbeDir, { recursive: true })
    writeFileSync(join(llmProbeDir, 'mod.json'), JSON.stringify({
      id: 'p2-probe', name: 'P2 Probe', version: '1.0.0', author: 'gate', description: 'llm capability + prompt section probe',
      main: 'index.mjs', capabilities: ['llm'],
    }), 'utf8')
    writeFileSync(join(llmProbeDir, 'index.mjs'), [
      'export async function setup(api) {',
      "  api.http.route('GET', 'llm', (req, reply) => reply.json({ hasLlm: typeof api.llm !== 'undefined' }))",
      "  api.prompt.section({ name: 'probe', text: 'p2 probe {{unclosed host variable}} section', order: -9999 })",
      '}',
    ].join('\n'), 'utf8')
    const plainProbeDir = join(modsRoot, 'p2-plain')
    mkdirSync(plainProbeDir, { recursive: true })
    writeFileSync(join(plainProbeDir, 'mod.json'), JSON.stringify({
      id: 'p2-plain', name: 'P2 Plain', version: '1.0.0', author: 'gate', description: 'no capability probe',
      main: 'index.mjs',
    }), 'utf8')
    writeFileSync(join(plainProbeDir, 'index.mjs'), [
      'export async function setup(api) {',
      "  api.http.route('GET', 'llm', (req, reply) => reply.json({ hasLlm: typeof api.llm !== 'undefined' }))",
      '}',
    ].join('\n'), 'utf8')
    mkdirSync(join(modsRoot, 'broken-mod'), { recursive: true })
    writeFileSync(join(modsRoot, 'broken-mod', 'mod.json'), '{ "id": "broken-mod", oops', 'utf8')
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        DSH_HOME: dshHome,
        DSH_SOULMOJITO_GATE_ENTRY: pathToFileURL(entryPath).href,
        DSH_SOULMOJITO_GATE_MOD_ID: EXAMPLE_MOD_ID,
        DSH_SOULMOJITO_GATE_AGENT_ENTRY: existsSync(AGENT_PATH) ? pathToFileURL(AGENT_PATH).href : '',
        ...(dependencyRoot === null ? {} : { NODE_PATH: dependencyRoot }),
      },
      timeout: 40_000,
      windowsHide: true,
    })
    if (child.error) return [`mod loader subprocess failed: ${child.error.message}`]
    if (child.status !== 0) {
      const detail = (child.stderr || child.stdout).trim().split(/\r?\n/).at(-1) ?? `exit ${child.status}`
      return [`mod loader subprocess exited ${child.status}: ${detail}`]
    }
    const line = child.stdout.split(/\r?\n/).find((value) => value.startsWith('DSH_SOULMOJITO_GATE_RESULT='))
    if (line === undefined) return ['mod loader subprocess returned no result record']
    return [null, JSON.parse(line.slice('DSH_SOULMOJITO_GATE_RESULT='.length))]
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function isSourceBudgetAllowlisted(relativePath) {
  return SOURCE_BUDGET_ALLOWLIST.some((entry) => entry.prefix === true
    ? relativePath.startsWith(entry.path)
    : relativePath === entry.path)
}

function sourceBudgetVerdict(relativePath, lines) {
  if (isSourceBudgetAllowlisted(relativePath)) return undefined
  return lines > SOURCE_BUDGET_LINES
    ? `${relativePath} has ${lines} lines (budget ${SOURCE_BUDGET_LINES}); split the file or add a reasoned entry to SOURCE_BUDGET_ALLOWLIST`
    : undefined
}

function walkSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist' || entry.name === 'tests') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkSourceFiles(full))
    else if (entry.isFile() && /\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(full)
  }
  return files
}

function checkSourceFileBudget() {
  const problems = []
  for (const root of SOURCE_BUDGET_ROOTS) {
    const absolute = join(REPO_ROOT, root)
    if (!existsSync(absolute)) continue
    for (const file of walkSourceFiles(absolute)) {
      const relativePath = relative(REPO_ROOT, file).replaceAll('\\', '/')
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).length
      const verdict = sourceBudgetVerdict(relativePath, lines)
      if (verdict !== undefined) problems.push(verdict)
    }
  }
  return problems
}

/* --------------------------- content lexicon --------------------------- */

// Concrete explicit-material terms only. Descriptors such as bare `裸`, `成人`
// or `触手` are intentionally absent because they occur in ordinary prose
// (`裸消息`, `触手可及`, `翻译成人能读懂`). Policy documents may describe the
// prohibited categories in neutral language; they are scanned like every other
// tracked file.
const CONTENT_LEXICON_ASCII = [
  'porn', 'pornography', 'pornographic',
  'hentai',
  'erotic', 'erotica',
  'smut', 'smutty',
  'lewd',
  'nsfw', 'jailbreak',
  'rape', 'raped', 'raping', 'rapist',
  'incest',
  'loli', 'lolita', 'lolicon',
  'shota', 'shotacon',
  'underage',
  'orgasm', 'orgasms', 'orgasmic',
  'masturbate', 'masturbation', 'masturbating',
  'blowjob', 'blowjobs', 'handjob', 'handjobs',
  'cumshot', 'cumshots', 'creampie', 'deepthroat',
  'gangbang', 'bukkake', 'futanari', 'yiff',
  'bestiality', 'necrophilia', 'pedophilia', 'pedophile',
  'molest', 'molested', 'molestation',
  'penis', 'penises', 'vagina', 'vaginas', 'vaginal', 'semen',
  'dick', 'dicks', 'pussy', 'pussies', 'clit', 'clits', 'clitoris',
  'tits', 'boob', 'boobs', 'nipple', 'nipples', 'areola', 'areolas',
  'dildo', 'dildos', 'vibrator', 'bondage', 'fetish', 'fetishes',
  'voyeur', 'voyeurism', 'onlyfans',
]
const CONTENT_LEXICON_CJK = [
  '色情', '情色', '裸体', '全裸', '裸照',
  '性交', '性爱', '做爱', '口交', '肛交', '群交', '乱交', '兽交',
  '强奸', '轮奸', '迷奸', '诱奸', '乱伦',
  '萝莉', '正太', '幼女', '肉棒', '蜜穴', '阴道', '阴茎', '龟头', '精液',
  '淫秽', '淫荡', '淫乱', '呻吟', '发情', '性癖',
  '触手play', '触手系', '恶堕', '痴汉', '援交', '卖淫', '嫖娼', '恋童',
  'エロ', 'おっぱい', 'セックス', 'レイプ', '陵辱', 'ロリ', '痴漢',
]

// The gate cannot scan its own lexicon literals; every other tracked file and
// every untracked-but-not-ignored file is in scope, so pre-commit content is
// caught before it enters history.
const CONTENT_GATE_SELF = 'packages/plugin/scripts/gates/run.mjs'
const CONTENT_TEXT_EXTENSIONS = /\.(?:md|txt|json|jsonl|ya?ml|ts|tsx|js|mjs|cjs|html|css|svg|sh|ps1)$/i

/**
 * SillyTavern prompt slot names are compatibility identifiers, not content.
 * Strip them before matching so `"identifier": "nsfw"` and `"jailbreak"`
 * pass while `nsfw porn` still fails on `porn`.
 */
function scanContentLexicon(text) {
  const haystack = text.replace(/\b(?:nsfw|jailbreak)\b/gi, ' ')
  const hits = []
  const ascii = new RegExp(`\\b(?:${CONTENT_LEXICON_ASCII.join('|')})\\b`, 'gi')
  for (const match of haystack.matchAll(ascii)) {
    hits.push({ term: match[0].toLowerCase(), index: match.index ?? 0 })
  }
  const cjk = new RegExp(CONTENT_LEXICON_CJK.join('|'), 'g')
  for (const match of haystack.matchAll(cjk)) {
    hits.push({ term: match[0], index: match.index ?? 0 })
  }
  return hits.sort((left, right) => left.index - right.index)
}

function decodePngTextValue(keyword, value) {
  if (keyword === 'chara' || keyword === 'ccv3') {
    return Buffer.from(value.toString('latin1'), 'base64').toString('utf8')
  }
  return value.toString('utf8')
}

function pngTextChunks(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return []
  const chunks = []
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buffer.length) break
    const data = buffer.subarray(start, end)
    if (type === 'tEXt') {
      const zero = data.indexOf(0)
      if (zero !== -1) {
        const keyword = data.toString('latin1', 0, zero)
        chunks.push({ keyword, text: decodePngTextValue(keyword, data.subarray(zero + 1)) })
      }
    } else if (type === 'zTXt') {
      const zero = data.indexOf(0)
      if (zero !== -1 && data[zero + 1] === 0) {
        const keyword = data.toString('latin1', 0, zero)
        try {
          chunks.push({ keyword, text: inflateSync(data.subarray(zero + 2)).toString('utf8') })
        } catch (error) {
          chunks.push({ keyword, text: '', error: `zTXt inflate failed: ${error instanceof Error ? error.message : String(error)}` })
        }
      }
    } else if (type === 'iTXt') {
      const zero = data.indexOf(0)
      if (zero !== -1 && data.length > zero + 2) {
        const keyword = data.toString('latin1', 0, zero)
        const compressed = data[zero + 1] === 1
        const languageEnd = data.indexOf(0, zero + 3)
        const translatedEnd = languageEnd === -1 ? -1 : data.indexOf(0, languageEnd + 1)
        if (languageEnd !== -1 && translatedEnd !== -1) {
          const value = data.subarray(translatedEnd + 1)
          try {
            chunks.push({ keyword, text: compressed ? inflateSync(value).toString('utf8') : value.toString('utf8') })
          } catch (error) {
            chunks.push({ keyword, text: '', error: `iTXt inflate failed: ${error instanceof Error ? error.message : String(error)}` })
          }
        }
      }
    }
    offset = end + 4
    if (type === 'IEND') break
  }
  return chunks
}

function lineOfIndex(text, index) {
  return text.slice(0, index).split('\n').length
}

function listContentGateFiles() {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (listed.error) throw new Error(`git ls-files failed: ${listed.error.message}`)
  if (listed.status !== 0) {
    throw new Error(`git ls-files failed (${listed.status}): ${String(listed.stderr ?? '').trim()}`)
  }
  return listed.stdout.split('\0').filter((file) => file.length > 0).sort()
}

function checkContentLexicon() {
  const problems = []
  for (const file of listContentGateFiles()) {
    if (file === CONTENT_GATE_SELF) continue
    const absolute = join(REPO_ROOT, file)
    if (!existsSync(absolute)) continue
    if (/\.png$/i.test(file)) {
      for (const chunk of pngTextChunks(readFileSync(absolute))) {
        if (chunk.error) {
          problems.push(`${file}: ${chunk.error} (${chunk.keyword})`)
          continue
        }
        for (const hit of scanContentLexicon(chunk.text)) {
          problems.push(`${file}:${lineOfIndex(chunk.text, hit.index)}: PNG ${chunk.keyword} contains '${hit.term}'`)
        }
      }
      continue
    }
    if (!CONTENT_TEXT_EXTENSIONS.test(file)) continue
    const text = readFileSync(absolute, 'utf8')
    for (const hit of scanContentLexicon(text)) {
      problems.push(`${file}:${lineOfIndex(text, hit.index)}: contains '${hit.term}'`)
    }
  }
  return problems
}

const gates = [
  {
    name: 'update-routes',
    selfTest: () => {
      const good = {
        reachable: true,
        checkStatus: 'update-available',
        checkCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        checkVersion: '9.9.9',
        localVersion: '0.3.8',
        spec: 'github:LingyeSoul/DSH-SoulMojito#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin',
        changelog: ['a1b2c3d feat: update'],
        missingRouteStatus: 404,
        installStarted: true,
        installPhase: 'done',
        installStrategy: 'plugin-manager',
        installRestartRequired: true,
        installLogTail: '12:00:00 pnpm stdout: Progress: resolved 1, added 1',
        installedSpecs: ['github:LingyeSoul/DSH-SoulMojito#a1b2c3d4e5f60718293a4b5c6d7e8f9012345678&path:/packages/plugin'],
        installRequestId: true,
      }
      const badSamples = [
        { ...good, reachable: false },
        { ...good, checkStatus: 'up-to-date' },
        { ...good, spec: 'github:LingyeSoul/DSH-SoulMojito#main&path:/packages/plugin' },
        { ...good, installPhase: 'failed' },
        { ...good, installStrategy: 'checkout' },
        { ...good, installRestartRequired: false },
        { ...good, installLogTail: '' },
        { ...good, installRequestId: false },
        { ...good, installedSpecs: [] },
        { ...good, changelog: [] },
        { ...good, missingRouteStatus: 200 },
      ]
      const rejected = badSamples.filter((sample) => checkUpdateRouteResult(sample).length > 0).length
      return checkUpdateRouteResult(good).length === 0 && rejected === badSamples.length
        ? []
        : ['update route bad samples were not rejected']
    },
    check: () => existsSync(SERVER_PATH) ? runUpdateRouteProbe() : ['generated packages/plugin/index.mjs does not exist'],
  },
  {
    name: 'package-contract',
    selfTest: () => {
      const valid = {
        name: PLUGIN_NAME,
        type: 'module',
        main: './index.mjs',
        exports: {
          '.': './index.mjs',
          './agent': './agent.mjs',
          './compaction': './compaction.mjs',
          './novel': './novel.mjs',
          './card-workbench': './card-workbench.mjs',
          './reasoning': './reasoning.mjs',
          './client': './client/index.js',
          './cordis.patch.yml': './cordis.patch.yml',
          './package.json': './package.json',
        },
        files: ['index.mjs', 'agent.mjs', 'compaction.mjs', 'novel.mjs', 'card-workbench.mjs', 'reasoning.mjs', 'version.json', 'client', 'cordis.patch.yml', 'README.md'],
        dsh: {
          manifestVersion: 1,
          bundle: { patch: './cordis.patch.yml' },
          client: { platform: 'web', inject: [] },
        },
      }
      const bad = structuredClone(valid)
      bad.dsh.client.platform = 'node'
      const badManifest = structuredClone(valid)
      delete badManifest.dsh.manifestVersion
      return checkPackageObject(valid).length === 0 && checkPackageObject(bad).length > 0 && checkPackageObject(badManifest).length > 0
        ? []
        : ['package contract bad samples were not distinguished from the valid sample']
    },
    check: () => {
      const pkg = readJson(PACKAGE_PATH)
      return [...checkPackageObject(pkg, true), ...checkClientInjectPackagesResolvable(pkg)]
    },
  },
  {
    name: 'patch-reference',
    selfTest: () => {
      const good = '- insert:\n'
        + '    - id: dsh-soulmojito\n      name: \'dsh-soulmojito\'\n'
        + '    - id: preset-agent-tavern\n      name: \'@deepseek-ai/dsh-agent-preset\'\n      config:\n        id: agent-tavern\n'
        + '    - id: preset-agent-novel\n      name: \'@deepseek-ai/dsh-agent-preset\'\n      config:\n        id: agent-novel\n'
        + '    - id: preset-agent-reasoning\n      name: \'@deepseek-ai/dsh-agent-preset\'\n      config:\n        id: agent-reasoning\n'
      const bad = "- insert:\n    - id: other\n      name: 'other'\n"
      const badPresetId = good.replace('id: agent-tavern', 'id: agent-tavern-x')
      const badReasoningId = good.replace('id: agent-reasoning', 'id: agent-reasoning-x')
      return checkPatchText(good).length === 0 && checkPatchText(bad).length > 0
        && checkPatchText(badPresetId).length > 0 && checkPatchText(badReasoningId).length > 0
        ? []
        : ['patch reference bad samples were not rejected']
    },
    check: () => {
      const problems = checkPatchText(readFileSync(PATCH_PATH, 'utf8'))
      // patch 声明的 config.id 必须与构建产物内的常量同值（见 checkPatchText 注释）。
      if (existsSync(SERVER_PATH)) {
        const server = readFileSync(SERVER_PATH, 'utf8')
        if (!server.includes('agent-tavern')) problems.push('built server bundle lost the agent-tavern preset id constant')
      }
      for (const [path, presetId] of [
        [AGENT_PATH, 'agent-tavern'],
        [NOVEL_PATH, 'agent-novel'],
        [AGENT_PATH, 'agent-reasoning'],
        [NOVEL_PATH, 'agent-reasoning'],
      ]) {
        if (!existsSync(path)) {
          problems.push(`generated ${path} does not exist`)
          continue
        }
        if (!readFileSync(path, 'utf8').includes(presetId)) {
          problems.push(`built ${basename(path)} lost the '${presetId}' preset id constant`)
        }
      }
      if (!existsSync(REASONING_PATH)) {
        problems.push(`generated ${REASONING_PATH} does not exist`)
      }
      return problems
    },
  },
  {
    name: 'server-bundle',
    selfTest: () => {
      const routeMarkers = REQUIRED_SERVER_ROUTES.map((route) => `"${route}"`).join('\n')
      const versionReader = 'readFileSync("version.json", "utf8"); var BUILD_INFO = { version: "0.0.0", commit: "stub" };'
      const commitResolver = 'function resolveCommit() { execFileSync("git", ["rev-parse", "--show-toplevel"]); return "stub"; } var TAVERN_COMMIT = resolveCommit();'
      const localEmbed = '"local-onnx:"\n\'@huggingface/transformers\'\nvar localStatus = { runtimeInstalled: true };\nfunction inferLocalModelSettings() {}\n"memory/embed/local/install"\nfunction detectLocalQuantizations() {}\n"memory/embed/local/quantizations"\nfunction resolveLocalDtype() {}'
      const gamesBridge = '"dsh-soulmojito:games-service"\nfunction smokeTestGameEngine() {}\nvar orphanSession = { orphaned: true };\nvar viewSeg = segments[2] === \'view\';\nvar builtinGomoku = "dsh-soulmojito.gomoku";\nvar builtinXiangqi = "dsh-soulmojito.xiangqi";\nvar builtinJunqi = "dsh-soulmojito.junqi";\nvar builtinBlackjack = "dsh-soulmojito.blackjack";\nvar builtinMemory = "dsh-soulmojito.memory-match";\nvar builtinMonopoly = "dsh-soulmojito.monopoly";\nvar builtinDungeonCrawl = "dsh-soulmojito.dungeon-crawl";\nvar builtinChineseCheckers = "dsh-soulmojito.chinese-checkers";\nvar dcToastStack = "dc-toast-stack";\nvar dcFloatNum = "dc-float-num";\nvar xiangqiCheckBanner = "#banner.check";\nvar xiangqiCheckHalo = "check-halo";\nvar waitersKey = "dsh-soulmojito:games-waiters";\nvar noticeId = "game-notice-" + sessionId;\nvar resignKey = "gamesDisableResign";\nfunction assertResignAllowed(action) {}\nfunction turnReachedAgent(session) {}\nfunction agentTurnRunning(agent) {}\nfunction installFromZip() {}\nfunction unzipArchive() {}\nvar zipInstallKey = "zipBase64";'
      // 改名兼容（2026-10-16）fixture 段：旧持久化名 / 旧 env 前缀 / 旧游戏
      // 命名空间别名前缀各恰好出现一次（负样本替换唯一命中）。
      const renameCompat = 'var legacyName = "dsh-tavern";\nvar legacyEnvPrefix = "DSH_TAVERN_DISABLE_UPDATE_CHECK";\nvar legacyGamePrefix = "dsh-tavern.";'
      const good = `var name = "dsh-soulmojito"; var inject = []; function apply() {} function assertStGenerationBinding() {}\n${routeMarkers}\n"${API_PREFIX}"\n${versionReader}\n${commitResolver}\n${localEmbed}\n${gamesBridge}\n${renameCompat}\nvar bootstrap = { ok: true, version: BUILD_INFO.version, commit: TAVERN_COMMIT };\nexport { name, inject, apply };`
      const badRoute = good.replace('"generate"', '"missing"')
      const badStamp = good.replace('version: BUILD_INFO.version, ', '')
      const hardcodedCommit = good.replace('commit: TAVERN_COMMIT', 'commit: "stub"')
      const badLocalEmbed = good.replace("'@huggingface/transformers'", "'embed-runtime-gone'")
      const badLocalInfer = good.replace('function inferLocalModelSettings() {}', 'function inferNothing() {}')
      const badLocalInstallRoute = good.replace('"memory/embed/local/install"', '"memory/embed/local/gone"')
      const badLocalQuantScan = good.replace('function detectLocalQuantizations() {}', 'function detectNothing() {}')
      const badLocalQuantRoute = good.replace('"memory/embed/local/quantizations"', '"memory/embed/local/gone"')
      const badLocalDtypeResolve = good.replace('function resolveLocalDtype() {}', 'function resolveNothing() {}')
      const badGamesHandle = good.replace('"dsh-soulmojito:games-service"', '"games-service-gone"')
      const badGamesSmoke = good.replace('function smokeTestGameEngine() {}', 'function smokeNothing() {}')
      const badGamesOrphan = good.replace('orphaned: true', 'gone: true')
      const badGamesView = good.replace("=== 'view'", "=== 'gone'").replace("=== \"view\"", "=== \"gone\"")
      const badGamesGomoku = good.replace('"dsh-soulmojito.gomoku"', '"gomoku-removed"')
      const badGamesXiangqi = good.replace('"dsh-soulmojito.xiangqi"', '"xiangqi-removed"')
      const badGamesJunqi = good.replace('"dsh-soulmojito.junqi"', '"junqi-removed"')
      const badGamesBlackjack = good.replace('"dsh-soulmojito.blackjack"', '"blackjack-removed"')
      const badGamesMemory = good.replace('"dsh-soulmojito.memory-match"', '"memory-removed"')
      const badGamesMonopoly = good.replace('"dsh-soulmojito.monopoly"', '"monopoly-removed"')
      // 内置地牢爬行（2026-10-16）负样本：替换名不含原 marker 子串（同款核对）。
      const badGamesDungeonCrawl = good.replace('"dsh-soulmojito.dungeon-crawl"', '"dungeon-crawl-removed"')
      // 内置中国跳棋（2026-10-17）负样本：替换名不含原 marker 子串（同款核对）。
      const badGamesChineseCheckers = good.replace('"dsh-soulmojito.chinese-checkers"', '"chinese-checkers-removed"')
      // 地牢爬行视图反馈层（2026-10-16）负样本：替换类名不含原子串。
      const badDcToastStack = good.replace('"dc-toast-stack"', '"toast-stack-gone"')
      const badDcFloatNum = good.replace('"dc-float-num"', '"float-num-gone"')
      // 自动续弈与投降门（2026-10-14 用户需求）负样本：替换文本逐一核对过不含
      // 原 marker（前缀/子串救活防护）。
      const badGamesWaiters = good.replace('"dsh-soulmojito:games-waiters"', '"games-waiters-gone"')
      const badGameNotice = good.replace('"game-notice-"', '"notice-gone-"')
      // 自动续弈两道防重闸（2026-10-15 竞态修订）负样本同款核对：替换名不含原
      // 函数名子串。
      const badWakeTurnGate = good.replace('function turnReachedAgent(session) {}', 'function turnGateGone(session) {}')
      const badWakeRunningGate = good.replace('function agentTurnRunning(agent) {}', 'function runningGateGone(agent) {}')
      const badGamesResignKey = good.replace('"gamesDisableResign"', '"gamesResignGone"')
      const badGamesResignGate = good.replace('function assertResignAllowed(action) {}', 'function assertNothing(action) {}')
      // 面板 zip 上传（2026-10-17）负样本：替换名逐一核对过不含原 marker 子串。
      const badGamesZipInstall = good.replace('function installFromZip() {}', 'function zipInstallGone() {}')
      const badGamesZipUnpack = good.replace('function unzipArchive() {}', 'function unpackGone() {}')
      const badGamesZipKey = good.replace('"zipBase64"', '"zip-gone"')
      // 将军提示层（2026-10-14 用户需求）负样本：同款核对——替换值 'banner-style-gone'
      // / 'halo-gone' 均不含原 marker 子串。
      const badXiangqiCheckBanner = good.replace('"#banner.check"', '"banner-style-gone"')
      const badXiangqiCheckHalo = good.replace('"check-halo"', '"halo-gone"')
      // 改名兼容（2026-10-16）负样本：替换值不含原 marker 子串
      // （'tavern-removed' / 'TAVERN_ENV_GONE_' / 'tavern-removed.' 均不救活原文）。
      const badLegacyName = good.replace('"dsh-tavern"', '"tavern-removed"')
      const badLegacyEnv = good.replace('DSH_TAVERN_', 'TAVERN_ENV_GONE_')
      const badLegacyGamePrefix = good.replace('"dsh-tavern."', '"tavern-removed."')
      return checkServerText(good).length === 0
        && checkServerText(badRoute).length > 0
        && checkServerText(badStamp).length > 0
        && checkServerText(hardcodedCommit).length > 0
        && checkServerText(badLocalEmbed).length > 0
        && checkServerText(badLocalInfer).length > 0
        && checkServerText(badLocalInstallRoute).length > 0
        && checkServerText(badLocalQuantScan).length > 0
        && checkServerText(badLocalQuantRoute).length > 0
        && checkServerText(badLocalDtypeResolve).length > 0
        && checkServerText(badGamesHandle).length > 0
        && checkServerText(badGamesSmoke).length > 0
        && checkServerText(badGamesOrphan).length > 0
        && checkServerText(badGamesView).length > 0
        && checkServerText(badGamesGomoku).length > 0
        && checkServerText(badGamesXiangqi).length > 0
        && checkServerText(badGamesJunqi).length > 0
        && checkServerText(badGamesBlackjack).length > 0
        && checkServerText(badGamesMemory).length > 0
        && checkServerText(badGamesMonopoly).length > 0
        && checkServerText(badGamesDungeonCrawl).length > 0
        && checkServerText(badGamesChineseCheckers).length > 0
        && checkServerText(badDcToastStack).length > 0
        && checkServerText(badDcFloatNum).length > 0
        && checkServerText(badGamesWaiters).length > 0
        && checkServerText(badGameNotice).length > 0
        && checkServerText(badWakeTurnGate).length > 0
        && checkServerText(badWakeRunningGate).length > 0
        && checkServerText(badGamesResignKey).length > 0
        && checkServerText(badGamesResignGate).length > 0
        && checkServerText(badGamesZipInstall).length > 0
        && checkServerText(badGamesZipUnpack).length > 0
        && checkServerText(badGamesZipKey).length > 0
        && checkServerText(badXiangqiCheckBanner).length > 0
        && checkServerText(badXiangqiCheckHalo).length > 0
        && checkServerText(badLegacyName).length > 0
        && checkServerText(badLegacyEnv).length > 0
        && checkServerText(badLegacyGamePrefix).length > 0
        && checkServerFreshness(10, 10).length === 0
        && checkBuildStamps('var built = { version: "0.0.0", commit: "abc1234" };', '0.0.0', 'abc1234').length === 0
        && checkBuildStamps('var built = { version: __TAVERN_VERSION__, commit: __TAVERN_COMMIT__ };', '0.0.0', 'abc1234').length > 0
        && checkBuildStamps('var built = { version: "0.0.0", commit: "abc1234" };', '9.9.9', 'abc1234').length > 0
        && checkServerFreshness(11, 10).length > 0
        ? []
        : ['server bundle bad samples were not rejected']
    },
    check: () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      const versionProblems = checkVersionFile()
      const packageStat = statSync(PACKAGE_PATH)
      const newestSource = Math.max(statSync(SOURCE_PATH).mtimeMs, packageStat.mtimeMs)
      const serverStat = statSync(SERVER_PATH)
      return [
        ...checkServerFreshness(newestSource, serverStat.mtimeMs),
        ...versionProblems,
        ...(versionProblems.length === 0
          ? checkVersionFreshness(packageStat.mtimeMs, statSync(VERSION_PATH).mtimeMs)
          : []),
        ...checkServerText(readFileSync(SERVER_PATH, 'utf8')),
        ...checkBuildStamps(readFileSync(SERVER_PATH, 'utf8'), readJson(PACKAGE_PATH).version, readJson(VERSION_PATH).commit),
      ]
    },
  },
  {
    name: 'client-bundle',
    selfTest: () => {
      const good = "window.__ModuleLoader__.load({ id: 'dsh-soulmojito', factory: (require) => { var module = { exports: {} }; var exports = module.exports; require('react'); require('@deepseek-ai/dsh-client-ui-primitives'); const markers = ['revision', 'CHAT_REVISION_CONFLICT', 'bindings/prune', 'store-revision', 'plugin:dsh-tavern']; exports.name = 'dsh-soulmojito'; exports.inject = ['slots']; exports.apply = () => markers; return module.exports; } });"
      const bad = good.replace("require('react')", "require('@deepseek-ai/not-platform')")
      // 改名兼容（2026-10-16）负样本：替换值不含原 marker 子串。
      const badLegacyKind = good.replace("'plugin:dsh-tavern'", "'legacy-kind-gone'")
      return checkClientText(good).length === 0 && checkClientText(bad).length > 0 && checkClientText(badLegacyKind).length > 0
        ? []
        : ['client static bad sample was not rejected']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkClientText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'frontend-runtime',
    selfTest: () => {
      const good = [
        'function extractFrontendDocuments() {}',
        'function buildFrontendDocument() {}',
        "'--dt-host-background'",
        'html{background:var(--dt-host-background)}',
        'html{background:var(--dt-host-background)!important;}',
        'function frontendHostBackgroundColor() {}',
        'dsh-soulmojito:theme',
        'function useThemeBridge(frameRef) {}',
        'dsh-soulmojito:frontend-height',
        "sandbox: 'allow-scripts allow-modals'",
        "connect-src 'none'",
        'event.source !== frameRef.current?.contentWindow',
        'message.streaming',
        'dsh-soulmojito:mod-request',
        'dsh-soulmojito:mod-response',
        'function isValidModBridgePath() {}',
        'function ModSurface({ mod, onLog }) {}',
        'dsh-soulmojito:mod-event',
        'dsh-soulmojito:mod-log',
        'function broadcastModEvent() {}',
        'function TavernModButtons() {}',
        'function ModPanelSurface({ mod }) {}',
        "'--dt-viewport-height'",
        "'dsh-soulmojito:viewport'",
        'streamReasoning',
        "event.type === 'reasoning'",
        'dt-reasoning-body',
        "'message.thinking'",
        "'message.thoughts'",
        "'settings.memoryProviderLocal'",
        "provider === 'local'",
        "'settings.memoryLocalRuntimeMissing'",
        "'settings.memoryAutoFilled'",
        "'settings.memoryLocalInstall'",
        // 模式下拉含「关闭」（2026-10-13）：三态切换的 off 选项标签键。
        "'settings.memoryProviderOff'",
        // 量化精度下拉（2026-10-13）：标签键 + 目录识别端点调用。
        "'settings.memoryPrecision'",
        'memory/embed/local/quantizations',
        // 游戏对局面（提案 0018 §4.3，P1）：桥消息 + 调用字面量 + 组件 + i18n 键。
        'dsh-soulmojito:game-state',
        'dsh-soulmojito:game-action',
        'games/list',
        'games/revision',
        'games/start',
        'games/action/',
        'function GameSurface({ session, view, onOutcome }) {}',
        'function GamesPanel({ useSessions }) {}',
        'function TavernGameBoard({ sessionId, sidebar = false }) {}',
        'function useChatGameSessions(character, chatId) {}',
        'function TavernGamesSidebarTab({ sessionId }) {}',
        "'tavern-games'",
        'sidebarRight.openTab(GAMES_TAB_KIND)',
        'const openGamesSurface = () => {}',
        'dt-game-board-empty',
        '.then(() => api(`games/list${query}`))',
        // 投降按钮 + 终局保留盘面（2026-10-14 用户需求）：与 checker 的必需
        // marker 列表逐条对齐——self-test 的 good 串缺一即自检自红。
        'postActionRef.current({ type',
        'dt-game-actions',
        'dt-game-resign-armed',
        'gamesDisableResign',
        'witnessed[session.id] !== undefined',
        // 面板导入游戏包（2026-10-17）：与 checker 的必需 marker 列表逐条对齐。
        'GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024',
        'const runGameImport = (source, busyKey) => {}',
        'const importGameZip = (file) => {}',
        'const installGameFromGit = () => {}',
        "accept: '.zip,application/zip'",
        "api('games/install')",
        "t('games.import.tooLarge', { limit: '5 MB' })",

        "'panel.section.games'",
        // 游戏图标=手柄 + 管理面板导航「标题区固定」（2026-10-14 用户反馈：红框的
        // Tavern 标题区要钉住、游戏图标换成手柄）。三类 marker 分别锁：自绘图标
        // 组件在场、导航分两段（品牌块常驻 + 清单滚动）的 DOM 结构、以及让
        // 「只有清单滚动」成立的那三条 CSS 规则（nav 不再自滚 / header 不参与
        // 伸缩 / body 独占滚动）。任何一条回退都会让面板退回「整列/整页滚动」。
        'function IconGamepadOutline16({ size = 16, className }) {}',
        "className: 'dt-panel-navlist'",
        '.dt-panel-nav{display:flex;flex-direction:column;gap:2px;width:198px;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l2);overflow:hidden}',
        '.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}',
        '.dt-panel-header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;min-height:52px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
        // 移动端横条复位（2026-10-14 移动端实况回归）：媒体查询里清单容器退场。
        '.dt-panel-navlist{display:contents}',
        // 2026-10-21 导航重做：与 checker 的必需 marker 列表逐条对齐。
        'const panelSectionGroups = [',
        "className: 'dt-panel-search'",
        "className: 'dt-panel-group'",
        "className: 'dt-panel-group-label'",
        "className: 'dt-panel-search-empty'",
        "className: 'dt-panel-expand'",
        "'data-dt-section': item.id",
        'body.scrollTop = scrollMemory.current[section] ?? 0',
        '.dt-panel-modal-full{width:calc(100vw - 24px)!important;height:calc(100vh - 24px)!important}',
        '.dt-panel-search{display:none}',
        '.dt-panel-group-label{display:none}',
        'function IconInfoOutline16({ size = 16, className }) {}',
        'function IconExpand16({ size = 16, className }) {}',
        'function IconCollapse16({ size = 16, className }) {}',
        // Brand logo (2026-10-16 user request): inlined logo component + frame +
        // brand name in the panel brand block + brand label on the sidebar footer
        // action + brand spelling in the about heading — aligned one-to-one with
        // the checker's required markers.
        'function SoulMojitoLogo({ size = 16, className }) {}',
        "viewBox: '-90 -100 180 190'",
        "h('strong', null, 'SoulMojito')",
        "className: 'dt-footer-label' }, 'SoulMojito')",
        "h('h3', null, 'DSH-SoulMojito')",
        // 侧栏两分区固定高度 + 独占滚动（2026-10-16 用户反馈）——与 checker
        // 的必需 marker 列表逐条对齐。
        "className: 'dt-sidebar-scroll dt-sidebar-tavern'",
        "className: 'dt-sidebar-scroll dt-sidebar-workbench'",
        '.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}',
        'sidebarCollapsed: { tavern: false, workbench: true }',
      ].join('\n')
      const bad = good.replace("sandbox: 'allow-scripts allow-modals'", "sandbox: 'allow-forms'")
      // Frontend default canvas (2026-10-21): a missing host background
      // injection or theme channel must turn red.
      const badFrameCanvas = good.replace('html{background:var(--dt-host-background)}', 'html{background:#fff}')
      const badFrameLateCanvas = good.replace('html{background:var(--dt-host-background)!important;}', 'html{background:transparent}')
      const badFrameTheme = good.replace('dsh-soulmojito:theme', 'dsh-soulmojito:palette')
      const badBridge = good.replace('dsh-soulmojito:mod-request', 'dsh-soulmojito:mod-bridge-removed')
      const badEvent = good.replace('dsh-soulmojito:mod-event', 'dsh-soulmojito:mod-gone')
      // 负样本必须真移除 marker：替换文本不得以原 marker 为前缀/子串（含 includes
      // 匹配），否则负样本形同虚设（上一批的已知坑）。
      const badViewportVar = good.replace("'--dt-viewport-height'", "'--dt-vh-gone'")
      const badViewportMsg = good.replace("'dsh-soulmojito:viewport'", "'dsh-soulmojito:vp-gone'")
      const badReasoningConsume = good.replace("event.type === 'reasoning'", "event.type === 'reason-gone'")
      const badReasoningRender = good.replace('dt-reasoning-body', 'dt-reason-gone')
      const badLocalProviderSelect = good.replace("'settings.memoryProviderLocal'", "'settings.memoryProviderGone'")
      const badLocalDispatch = good.replace("provider === 'local'", "provider === 'vanished'")
      const badLocalRuntimeHint = good.replace("'settings.memoryLocalRuntimeMissing'", "'settings.memoryRuntimeGone'")
      const badAutoFilled = good.replace("'settings.memoryAutoFilled'", "'settings.memoryAutoGone'")
      const badLocalInstall = good.replace("'settings.memoryLocalInstall'", "'settings.memoryInstallGone'")
      const badModeOff = good.replace("'settings.memoryProviderOff'", "'settings.memoryModeGone'")
      const badPrecisionSelect = good.replace("'settings.memoryPrecision'", "'settings.memoryQuantGone'")
      const badQuantRoute = good.replace('memory/embed/local/quantizations', 'memory/embed/local/gone')
      // 游戏面负样本（提案 0018 §4.3）：替换文本不得以原 marker 为前缀/子串——
      // 'games/list-gone' 会包含 'games/list' 这类坑逐个排过。
      const badGameState = good.replace('dsh-soulmojito:game-state', 'dsh-soulmojito:game-stale')
      const badGameAction = good.replace('dsh-soulmojito:game-action', 'dsh-soulmojito:game-act-gone')
      // games/list 子串在基线链 marker（.then(() => api(`games/list${query}`))）里
      // 也出现——单次 replace 只换第一处会让 marker 幸存不翻红（2026-10-14 实测坑），
      // 全量替换。
      const badGamesList = good.split('games/list').join('games/gone-list')
      const badGamesRevision = good.replace('games/revision', 'games/rev-gone')
      const badGamesStart = good.replace('games/start', 'games/gone-start')
      const badGamesAction = good.replace('games/action/', 'games/act-gone/')
      const badGameSurface = good.replace('function GameSurface({ session', 'function GameStale({ session')
      const badGamesPanel = good.replace('function GamesPanel({ useSessions })', 'function GamesPane({ useSessions })')
      // 对局面三面（2026-10-14 修订）：内联组件/右栏 tab kind/开局自动展开
      // 任一缺失都必须翻红——替换文本不得以原 marker 为前缀/子串。
      const badGameBoard = good.replace('function TavernGameBoard({ sessionId, sidebar = false })', 'function TavernGameStale({ sessionId, sidebar = false })')
      const badGameHook = good.replace('function useChatGameSessions(character, chatId)', 'function useChatGameSessionsGone(character, chatId)')
      const badGameTabKind = good.replace("'tavern-games'", "'tavern-gamesX'")
      const badGameAutoOpen = good.replace('sidebarRight.openTab(GAMES_TAB_KIND)', 'sidebarRight.openTab(GAMES_TAB_GONE)')
      const badGameHeaderEntry = good.replace('const openGamesSurface = () => {}', 'const openGamesGone = () => {}')
      const badGameEmptyCard = good.replace('dt-game-board-empty', 'dt-game-empty-gone')
      const badGameBaseline = good.replace('.then(() => api(`games/list${query}`))', '.then(() => api(`games/gone-list`))')
      // 投降按钮 + 终局盘面（2026-10-14 用户需求）负样本：替换文本不含原
      // marker 的前缀/子串。
      const badGameResignAction = good.replace('postActionRef.current({ type', 'postActionGone.current({ type')
      const badGameResignBar = good.replace('dt-game-actions', 'dt-game-act-gone')
      const badGameResignArmed = good.replace('dt-game-resign-armed', 'dt-game-resign-gone')
      const badGameResignKey = good.replace('gamesDisableResign', 'gamesResignGone')
      const badGameWitnessed = good.replace('witnessed[session.id] !== undefined', 'witnessedGone[session.id] !== undefined')
      // 面板导入游戏包（2026-10-17）负样本：替换文本逐一核对过不含原 marker 子串。
      const badGameImportRun = good.replace('const runGameImport = (source, busyKey) => {}', 'const gameImportRunGone = (source, busyKey) => {}')
      const badGameImportZip = good.replace('const importGameZip = (file) => {}', 'const importZipGone = (file) => {}')
      const badGameImportGit = good.replace('const installGameFromGit = () => {}', 'const installGitGone = () => {}')
      const badGameImportRoute = good.replace("api('games/install')", "api('games/gone-import')")
      const badGameImportAccept = good.replace("accept: '.zip,application/zip'", "accept: '.gone'")
      const badGameImportSize = good.replace('GAMES_ZIP_MAX_BYTES = 5 * 1024 * 1024', 'GAMES_ZIP_MAX_BYTES = 0')
      const badGameImportTooLarge = good.replace("t('games.import.tooLarge', { limit: '5 MB' })", "t('games.import.tooLargeGone', { limit: '5 MB' })")

      const badGamesSectionKey = good.replace("'panel.section.games'", "'panel.section.gone'")
      // 手柄图标 + 导航标题区固定（2026-10-14 用户反馈）负样本：图标组件改名、
      // 清单容器去掉、三条 CSS 规则各自回退（nav 重新自滚 / 清单不再滚 /
      // header 重新参与伸缩）都必须翻红。替换文本逐一核对过不含原 marker。
      const badGamepadIcon = good.replace('function IconGamepadOutline16(', 'function IconGamepadGone(')
      const badNavlistStructure = good.replace("className: 'dt-panel-navlist'", "className: 'dt-panel-navlist-gone'")
      const badPanelNavRule = good.replace(';border-right:1px solid var(--dsw-alias-border-l2);overflow:hidden}', ';border-right:1px solid var(--dsw-alias-border-l2);overflow-y:auto}')
      const badNavlistRule = good.replace('.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}', '.dt-panel-navlist{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow:visible}')
      const badPanelHeaderRule = good.replace('justify-content:space-between;gap:12px;flex:none;min-height:52px', 'justify-content:space-between;gap:12px;min-height:52px')
      // 移动端横条复位（2026-10-14 移动端实况回归）：清单一层不退了（display:contents
      // 被拆）必须翻红——替换文本 'display:contents-gone' 不含原 marker 的子串。
      const badMobileNavlist = good.replace('.dt-panel-navlist{display:contents}', '.dt-panel-navlist{display:contents-gone}')
      // Brand logo (2026-10-16 user request) negative samples: renaming the logo
      // component, breaking the viewBox frame, reverting the brand block copy to
      // Tavern, reverting the sidebar footer label to the i18n title and putting
      // a non-brand spelling back into the about heading must each turn red — the
      // replacement texts contain no substring of the original markers.
      const badBrandIcon = good.replace('function SoulMojitoLogo(', 'function SoulMojitoLogoGone(')
      const badBrandFrame = good.replace("viewBox: '-90 -100 180 190'", "viewBox: '-90 -100 180 191'")
      const badBrandCopy = good.replace("h('strong', null, 'SoulMojito')", "h('strong', null, 'TavernGone')")
      const badFooterLabel = good.replace("className: 'dt-footer-label' }, 'SoulMojito'", "className: 'dt-footer-label' }, 'TavernGone'")
      const badAboutTitle = good.replace("h('h3', null, 'DSH-SoulMojito')", "h('h3', null, 'SoulmojitoGone')")
      // 侧栏两分区滚动契约（2026-10-16 用户反馈）负样本：分区容器还原成无包装 /
      // 固定高度规则换成不滚动 / 写卡工作台默认展开（回到用户报告的原始形态）。
      // 替换文本逐一核对不含原 marker 的子串。
      const badSidebarTavernScroll = good.replace("className: 'dt-sidebar-scroll dt-sidebar-tavern'", "className: 'dt-sidebar-tavern-gone'")
      const badSidebarWorkbenchScroll = good.replace("className: 'dt-sidebar-scroll dt-sidebar-workbench'", "className: 'dt-sidebar-workbench-gone'")
      const badSidebarScrollRule = good.replace('.dt-sidebar-scroll{display:flex;flex-direction:column;min-height:0;max-height:min(320px,32vh);overflow-y:auto;overflow-x:hidden}', '.dt-sidebar-scroll{display:flex;flex-direction:column;overflow:visible}')
      const badSidebarWorkbenchDefault = good.replace('sidebarCollapsed: { tavern: false, workbench: true }', 'sidebarCollapsed: { tavern: false, workbench: false }')
      return checkFrontendRuntimeText(good).length === 0
        && checkFrontendRuntimeText(bad).length > 0
        && checkFrontendRuntimeText(badFrameCanvas).length > 0
        && checkFrontendRuntimeText(badFrameLateCanvas).length > 0
        && checkFrontendRuntimeText(badFrameTheme).length > 0
        && checkFrontendRuntimeText(badBridge).length > 0
        && checkFrontendRuntimeText(badEvent).length > 0
        && checkFrontendRuntimeText(badViewportVar).length > 0
        && checkFrontendRuntimeText(badViewportMsg).length > 0
        && checkFrontendRuntimeText(badReasoningConsume).length > 0
        && checkFrontendRuntimeText(badReasoningRender).length > 0
        && checkFrontendRuntimeText(badLocalProviderSelect).length > 0
        && checkFrontendRuntimeText(badLocalDispatch).length > 0
        && checkFrontendRuntimeText(badLocalRuntimeHint).length > 0
        && checkFrontendRuntimeText(badAutoFilled).length > 0
        && checkFrontendRuntimeText(badLocalInstall).length > 0
        && checkFrontendRuntimeText(badModeOff).length > 0
        && checkFrontendRuntimeText(badPrecisionSelect).length > 0
        && checkFrontendRuntimeText(badQuantRoute).length > 0
        && checkFrontendRuntimeText(badGameState).length > 0
        && checkFrontendRuntimeText(badGameAction).length > 0
        && checkFrontendRuntimeText(badGamesList).length > 0
        && checkFrontendRuntimeText(badGamesRevision).length > 0
        && checkFrontendRuntimeText(badGamesStart).length > 0
        && checkFrontendRuntimeText(badGamesAction).length > 0
        && checkFrontendRuntimeText(badGameSurface).length > 0
        && checkFrontendRuntimeText(badGamesPanel).length > 0
        && checkFrontendRuntimeText(badGameBoard).length > 0
        && checkFrontendRuntimeText(badGameHook).length > 0
        && checkFrontendRuntimeText(badGameTabKind).length > 0
        && checkFrontendRuntimeText(badGameAutoOpen).length > 0
        && checkFrontendRuntimeText(badGameHeaderEntry).length > 0
        && checkFrontendRuntimeText(badGameEmptyCard).length > 0
        && checkFrontendRuntimeText(badGameBaseline).length > 0
        && checkFrontendRuntimeText(badGameResignAction).length > 0
        && checkFrontendRuntimeText(badGameResignBar).length > 0
        && checkFrontendRuntimeText(badGameResignArmed).length > 0
        && checkFrontendRuntimeText(badGameResignKey).length > 0
        && checkFrontendRuntimeText(badGameWitnessed).length > 0
        && checkFrontendRuntimeText(badGameImportRun).length > 0
        && checkFrontendRuntimeText(badGameImportZip).length > 0
        && checkFrontendRuntimeText(badGameImportGit).length > 0
        && checkFrontendRuntimeText(badGameImportRoute).length > 0
        && checkFrontendRuntimeText(badGameImportAccept).length > 0
        && checkFrontendRuntimeText(badGameImportSize).length > 0
        && checkFrontendRuntimeText(badGameImportTooLarge).length > 0
        && checkFrontendRuntimeText(badGamesSectionKey).length > 0
        && checkFrontendRuntimeText(badGamepadIcon).length > 0
        && checkFrontendRuntimeText(badNavlistStructure).length > 0
        && checkFrontendRuntimeText(badPanelNavRule).length > 0
        && checkFrontendRuntimeText(badNavlistRule).length > 0
        && checkFrontendRuntimeText(badPanelHeaderRule).length > 0
        && checkFrontendRuntimeText(badMobileNavlist).length > 0
        && checkFrontendRuntimeText(badBrandIcon).length > 0
        && checkFrontendRuntimeText(badBrandFrame).length > 0
        && checkFrontendRuntimeText(badBrandCopy).length > 0
        && checkFrontendRuntimeText(badFooterLabel).length > 0
        && checkFrontendRuntimeText(badAboutTitle).length > 0
        && checkFrontendRuntimeText(badSidebarTavernScroll).length > 0
        && checkFrontendRuntimeText(badSidebarWorkbenchScroll).length > 0
        && checkFrontendRuntimeText(badSidebarScrollRule).length > 0
        && checkFrontendRuntimeText(badSidebarWorkbenchDefault).length > 0
        ? []
        : ['frontend runtime marker self-test did not distinguish an unsafe sample']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkFrontendRuntimeText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'native-header-adapter',
    selfTest: () => {
      const good = [
        'AgentPresetLabel.module.css',
        'function useNativeAgentPresetLabelFilter() {}',
        'dshSoulMojitoAgentPresetHiddenState',
        'data-dsh-soulmojito-agent-preset-hidden',
        "useNativeAgentPresetLabelFilter(Boolean(active && binding && architecture === 'st'))",
      ].join('\n')
      const bad = good.replace("Boolean(active && binding && architecture === 'st')", 'true')
      return checkNativeHeaderAdapterText(good).length === 0
        && checkNativeHeaderAdapterText(bad).length > 0
        ? []
        : ['native header adapter self-test did not distinguish a globally enabled sample']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkNativeHeaderAdapterText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'mvu-surface',
    selfTest: () => {
      const good = [
        'function TavernMvuStatus({ sessionId, embedded = false, sidebar = false }) {',
        "h('div', { className: 'dt-mvu', 'data-dsh-soulmojito-surface': 'mvu' },",
        '.dt-mvu-slot{position:relative;display:inline-flex}',
        '.dt-mvu-pop{z-index:20;position:absolute}',
        "mvuOpen ? h('div', { className: 'dt-mvu-pop' }, h(TavernMvuStatus, { sessionId, embedded: true })) : null",
        "'mvu.unavailable': 'No variables or receipts in this chat',",
        "const MVU_TAB_ID = 'dsh-soulmojito/mvu'",
        "const MVU_TAB_KIND = 'tavern-mvu'",
        "ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {",
        "scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({",
        "h(TavernMvuStatus, { sessionId, sidebar: true })",
        "'data-dsh-soulmojito-surface': 'mvu-sidebar'",
        "exports.inject = ['slots', 'sessions', 'workspaces', 'locale']",
      ].join('\n')
      const unmounted = good.replace('TavernMvuStatus, { sessionId, embedded: true', 'TavernMvuStatus, { sessionId')
      const noEmptyState = good.replace("'mvu.unavailable': 'No variables or receipts in this chat',", '')
      const noSidebarTab = good.replace("const MVU_TAB_KIND = 'tavern-mvu'", "const MVU_TAB_KIND = 'other'")
      const hardInjected = good.replace(
        "exports.inject = ['slots', 'sessions', 'workspaces', 'locale']",
        "exports.inject = ['slots', 'sessions', 'workspaces', 'locale', 'sidebarRight']",
      )
      return checkMvuSurfaceText(good).length === 0
        && checkMvuSurfaceText(unmounted).length > 0
        && checkMvuSurfaceText(noEmptyState).length > 0
        && checkMvuSurfaceText(noSidebarTab).length > 0
        && checkMvuSurfaceText(hardInjected).length > 0
        ? []
        : ['MVU surface bad samples were not rejected']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkMvuSurfaceText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'frontend-surface',
    selfTest: () => {
      const good = [
        'function TavernFrontendPanel({ sessionId }) {',
        "const FRONTEND_TAB_ID = 'dsh-soulmojito/frontend'",
        "const FRONTEND_TAB_KIND = 'tavern-frontend'",
        "'data-dsh-soulmojito-surface': 'frontend-sidebar'",
        'frontend/latest${query}',
        "'frontend.inlineOnly'",
        "'frontend.refresh'",
        'key: FRONTEND_TAB_ID',
        'TavernFrontendSidebarTab',
        'sidebarRight.openTab(FRONTEND_TAB_KIND)',
        '.dt-frontend-side{box-sizing:border-box',
        'function useFrontendAutoOpen(sessionId, binding, architecture, enabled)',
        "if (!enabled || !binding || architecture !== 'agent-tavern') return undefined",
        'autoOpenedRef.current.has(marker)',
        "const HELPER_MESSAGE = 'dsh-soulmojito:helper'",
        'function frontendHelperScript(token, messageId)',
        'window.getVariables = function',
        'window.getChatMessages = function',
        'window.setChatMessages = function',
        'window.eventOn = function',
        'function useHelperBridge(frameRef, token, binding, refreshKey, hostSessionId)',
        'this frontend is not bound to a Tavern chat',
        'const HELPER_TAVERN_EVENTS = {',
        'window.triggerSlash = function',
        'window.builtin.renderMarkdown = function',
        'window.getTavernRegexes = function',
      ].join('\n')
      const noTabKind = good.replace("const FRONTEND_TAB_KIND = 'tavern-frontend'", "const FRONTEND_TAB_KIND = 'other'")
      const noInlineNote = good.replace("'frontend.inlineOnly'", '')
      const ungatedAutoOpen = good.replace("if (!enabled || !binding || architecture !== 'agent-tavern') return undefined", 'void enabled')
      const noIdentityGuard = good.replace('this frontend is not bound to a Tavern chat', 'ok')
      return checkFrontendSurfaceText(good).length === 0
        && checkFrontendSurfaceText(noTabKind).length > 0
        && checkFrontendSurfaceText(noInlineNote).length > 0
        && checkFrontendSurfaceText(ungatedAutoOpen).length > 0
        && checkFrontendSurfaceText(noIdentityGuard).length > 0
        ? []
        : ['frontend sidebar surface bad samples were not rejected']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkFrontendSurfaceText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'client-architecture-split',
    selfTest: () => {
      const good = [
        'function newChatPolicy(group = false',
        "if (group) return { architecture: 'st', contextMode: 'dsh-native' }",
        ": state.defaultArchitecture === 'st' ? 'st' : 'agent-tavern'",
        "state.defaultContextMode === 'agent-managed'",
        'useNativeSessionTreeFilter(bindingIds, PanelHost.context',
        "const bindingIds = Object.keys(state.bootstrap.state.sessionBindings || {})",
        "useNativeTavernTabFilter(Boolean(currentBinding && bindingArchitecture(currentBinding) === 'st'))",
        "if (policy.architecture === 'st') clickTavernTab(0)",
        'function reserveTavernSession(ctx, sessionId)',
        'DshBindClient.retainHostSession(ctx, sessionId, clientShapeTrace)',
        'heldSession.release()',
        'select: selectTavernComposer',
        "disabled: bootstrap.agentTavern?.managed?.available !== true",
        'checked: bootstrap.state.agentTavernPreloadAssets === true',
        'existing[1].initializationPending === true',
      ].join('\n')
      const badTree = good.replace('useNativeSessionTreeFilter(bindingIds, PanelHost.context', 'useNativeSessionTreeFilter([], PanelHost.context')
      const badTab = good.replace("bindingArchitecture(currentBinding) === 'st'", 'true')
      return checkClientArchitectureText(good).length === 0
        && checkClientArchitectureText(badTree).length > 0
        && checkClientArchitectureText(badTab).length > 0
        ? []
        : ['client architecture split self-test did not protect the native tree and tab routing']
    },
    check: () => existsSync(CLIENT_PATH)
      ? checkClientArchitectureText(readFileSync(CLIENT_PATH, 'utf8'))
      : ['generated packages/plugin/client/index.js does not exist'],
  },
  {
    name: 'internal-workspace',
    selfTest: () => {
      const server = [
        'internalWorkspace workbenchWorkspace',
        'TAVERN_WORKSPACE_TITLE TAVERN_WORKBENCH_WORKSPACE_TITLE',
        'tavernDataRoot("workspace") tavernDataRoot("workbench")',
        'var TAVERN_DATA_DIR = "soulmojito"; var LEGACY_TAVERN_DATA_DIR = "tavern";',
        'function holdsTavernData(root) {}',
      ].join('\n')
      const client = [
        'function ensureTavernWorkspace(ctx)',
        'function ensureWorkbenchWorkspace(ctx)',
        'ctx.workspaces.create({ path: config.path })',
        'function connectTavernWorkspace(ctx, workspaceId, agentPreset)',
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-tavern')",
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-novel')",
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'card-workbench')",
        'uiWorkspace.connectWorkspace(workspaceId, options)',
        'ctx.workspaces.connectWorkspace(workspaceId)',
        'function pluginWorkspaceSnapshots(ctx)',
        'normalizeWorkspacePath(item?.path) === expectedPath',
        'function nativeTreeNodeMatchesWorkspace(node, workspace, titleFallback)',
        "items.filter((item) => item?.title === workspace.title).length === 1",
        "markNativeTreeRow(nativeTreeWorkspaceGroup(header, tree), 'internal-workspace')",
      ].join('\n')
      const bad = `${client}\nfunction currentWorkspace(ctx) {}`
      const titleOnly = [
        'function ensureTavernWorkspace(ctx)',
        'function ensureWorkbenchWorkspace(ctx)',
        'ctx.workspaces.create({ path: config.path })',
        'function connectTavernWorkspace(ctx, workspaceId, agentPreset)',
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-tavern')",
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'agent-novel')",
        "connectTavernWorkspace(ctx, workspace.workspaceId, 'card-workbench')",
        'uiWorkspace.connectWorkspace(workspaceId, options)',
        'ctx.workspaces.connectWorkspace(workspaceId)',
        "if (node.textContent === 'Tavern (internal)') node.hidden = true",
      ].join('\n')
      const badStorage = server.replace('tavernDataRoot("workspace")', 'dshHomePath("workspace")')
      const badLegacy = server.replace('function holdsTavernData(root) {}', '')
      return checkInternalWorkspaceText(server, client).length === 0
        && checkInternalWorkspaceText(server, bad).length > 0
        && checkInternalWorkspaceText(server, titleOnly).length > 0
        && checkInternalWorkspaceText('', client).length > 0
        && checkInternalWorkspaceText(badStorage, client).length > 0
        && checkInternalWorkspaceText(badLegacy, client).length > 0
        ? []
        : ['internal workspace self-test did not reject native-workspace routing or the storage-root compat markers']
    },
    check: () => existsSync(SERVER_PATH) && existsSync(CLIENT_PATH)
      ? checkInternalWorkspaceText(readFileSync(SERVER_PATH, 'utf8'), readFileSync(CLIENT_PATH, 'utf8'))
      : ['internal workspace gate requires both server and client bundles'],
  },
  {
    name: 'agent-tavern-isolation',
    selfTest: () => {
      const goodAgent = "var games = ['game_list', 'game_start', 'game_state', 'game_history', 'game_move', 'game_wait', 'game_wait_full']; registerSection('dsh-soulmojito:agent-games'); function resolveGamesService() {}"
      const good = checkAgentTavernIsolation([
        ['runtime.ts', 'export function runAgentLoop() {}'],
        ['tools.ts', 'export function tool() {}'],
      ], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent)
      const bad = checkAgentTavernIsolation([
        ['runtime.ts', 'ctx.llm.stream()'],
      ], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent)
      // games 桥负样本：七工具名/段名/报文任一缺失都必须翻红（game_wait 摘除
      // = 2026-10-14 修订的专属回归位——marker 是子串匹配，须连 game_wait_full
      // 一起摘除，否则残留全名仍含 game_wait 子串救活负样本；game_history 单独
      // 摘除 = 同日增量修订的专属回归位；game_wait_full 单独摘除 = 2026-10-16
      // 新工具的专属回归位）。
      const badGamesTool = checkAgentTavernIsolation([], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent.replace("'game_state', 'game_history', 'game_move'", "'game_state', 'game_move'"))
      const badGamesWait = checkAgentTavernIsolation([], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent.replace("'game_wait', 'game_wait_full'", "'wait-gone'"))
      const badGamesWaitFull = checkAgentTavernIsolation([], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent.replace("'game_wait_full'", "'wait-full-gone'"))
      const badGamesSection = checkAgentTavernIsolation([], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent.replace('dsh-soulmojito:agent-games', 'dsh-soulmojito:gone'))
      const badGamesError = checkAgentTavernIsolation([], 'agent-tavern/audit assertStGenerationBinding(state, body.sessionId)', goodAgent.replace('function resolveGamesService() {}', 'function resolveNothing() {}'))
      return good.length === 0 && bad.length > 0
        && badGamesTool.length > 0 && badGamesWait.length > 0 && badGamesWaitFull.length > 0 && badGamesSection.length > 0 && badGamesError.length > 0
        ? []
        : ['AgentTavern isolation self-test did not reject ST generation calls']
    },
    check: () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      if (!existsSync(AGENT_PATH)) return ['generated packages/plugin/agent.mjs does not exist']
      return checkAgentTavernIsolation(agentTavernSourceFiles(), readFileSync(SERVER_PATH, 'utf8'), readFileSync(AGENT_PATH, 'utf8'))
    },
  },
  {
    name: 'client-vm-mount',
    selfTest: async () => {
      const localeWiring = "ctx.effect(() => ctx.locale.register('dsh-soulmojito', { zh: { 'nav.title': '酒馆' }, en: { 'nav.title': 'Tavern' } })); ctx.locale.bind('dsh-soulmojito');"
      const sidebarWiring = "ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => { scope.effect(() => scope.sidebarRightTabs.register({ id: 'dsh-soulmojito/mvu', kind: 'tavern-mvu', priority: 'extension', title: () => 'MVU', guide: [{ id: 'mvu', order: 40, title: () => 'MVU', description: () => 'MVU' }] })); scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-soulmojito/mvu', inject: (sessionId) => ({ sessionId }) }, () => null))); scope.effect(() => scope.sidebarRightTabs.register({ id: 'dsh-soulmojito/frontend', kind: 'tavern-frontend', priority: 'extension', title: () => 'Frontend', guide: [{ id: 'frontend', order: 42, title: () => 'Frontend', description: () => 'Frontend' }] })); scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-soulmojito/frontend', inject: (sessionId) => ({ sessionId }) }, () => null))); });"
      const good = `window.__ModuleLoader__.load({ id: 'dsh-soulmojito', factory: (require) => { var module = { exports: {} }; var exports = module.exports; require('react'); exports.name = 'dsh-soulmojito'; exports.inject = ['slots', 'locale']; exports.apply = (ctx) => { ${localeWiring} ${sidebarWiring} const entries = [['settings.section','dsh-soulmojito'],['conversation.view','tavern'],['conversation.composer',null],['conversation.session.header.actions','dsh-soulmojito'],['shell.overlay','dsh-soulmojito-panel'],['sidebar.footer.action','dsh-soulmojito-panel']]; for (const [name,id] of entries) ctx.slots.inject(name, () => ctx.slots.register({ name, ...(id ? { id } : {}), ...(name === 'conversation.composer' ? { select: (owner) => owner?.session?.chat?.order?.some((key) => owner.session.chat.nodes.get(key)?.data?.source?.form === 'notice') ? {} : null } : {}) }, () => null)); }; return module.exports; } });`
      const badSlot = good.replace("['conversation.view','tavern'],", '')
      const badLocale = good.replace("exports.inject = ['slots', 'locale']", "exports.inject = ['slots']")
      const badParity = good.replace("en: { 'nav.title': 'Tavern' }", "en: {}")
      const badComposer = good.replace("owner.session.chat.nodes.get(key)?.data?.source?.form === 'notice'", 'true')
      const badSidebar = good.replace("ctx.inject(['sidebarRightTabs', 'sidebarRight'], ", 'void (')
      const goodProblems = await checkClientExecution(good)
      const failureCounts = (await Promise.all([badSlot, badLocale, badParity, badComposer, badSidebar].map((sample) => checkClientExecution(sample))))
        .filter((problems) => problems.length > 0).length
      const parityShape = { uiPrimitives: { direct: 30, aliased: { IconSparkle16: 'IconSparkleRegular' }, synthesized: [], missing: [] } }
      const parityBad = [
        { uiPrimitives: { direct: 29, aliased: {}, synthesized: ['IconSparkle16'], missing: [] } },
        { uiPrimitives: { direct: 29, aliased: {}, synthesized: [], missing: ['Modal'] } },
        { uiPrimitives: { direct: 30, aliased: {} } },
        undefined,
      ]
      const parityRejected = parityBad.filter((sample) => checkPrimitiveParity(sample).length > 0).length
      const traced = good.replace(
        'exports.apply = (ctx) => {',
        `window.__DSH_SOULMOJITO_BIND__ = ${JSON.stringify(parityShape)}; exports.apply = (ctx) => {`,
      )
      const wiringOk = (await checkClientExecution(traced, { requirePrimitiveParity: true })).length === 0
      const wiringRejectsUntraced = (await checkClientExecution(good, { requirePrimitiveParity: true })).length > 0
      const updateZh = "{ 'update.title': '插件更新', 'update.current': '已安装 v{version}（{commit}）', 'update.latest': 'GitHub v{version}（{commit}）', 'update.check': '检查更新', 'update.checking': '检查中…', 'update.now': '立即更新', 'update.installing': '更新中…', 'update.confirm': '安装 v{version}？', 'update.restartHint': '重启生效', 'update.restartHintWeb': '重启并刷新', 'update.checkedAt': '上次 {at}', 'update.notes': '改动', 'update.remoteError': '查询失败 {error}', 'update.status.available': '有 v{version}', 'update.status.upToDate': '最新', 'update.status.localAhead': '本地更新', 'update.status.restartRequired': '需重启', 'update.status.unknown': '未知' }"
      const updateEn = "{ 'update.title': 'Plugin update', 'update.current': 'Installed v{version} ({commit})', 'update.latest': 'GitHub v{version} ({commit})', 'update.check': 'Check', 'update.checking': 'Checking…', 'update.now': 'Update now', 'update.installing': 'Updating…', 'update.confirm': 'Install v{version}?', 'update.restartHint': 'Restart', 'update.restartHintWeb': 'Restart and reload', 'update.checkedAt': 'Checked {at}', 'update.notes': 'Changes', 'update.remoteError': 'Lookup failed {error}', 'update.status.available': 'v{version} available', 'update.status.upToDate': 'Up to date', 'update.status.localAhead': 'Local newer', 'update.status.restartRequired': 'Restart', 'update.status.unknown': 'Unknown' }"
      const updateMissing = updateEn.replace("'update.now': 'Update now', ", '')
      const goodWithUpdate = good
        .replace("zh: { 'nav.title': '酒馆' }", `zh: { 'nav.title': '酒馆', ${updateZh.slice(1, -1)} }`)
        .replace("en: { 'nav.title': 'Tavern' }", `en: { 'nav.title': 'Tavern', ${updateEn.slice(1, -1)} }`)
        .replace('exports.apply = (ctx) => {', "exports.apply = (ctx) => { const updateMarkers = ['update/check', 'update/install']; const UpdateBand = () => null; void updateMarkers; void UpdateBand; ")
      const badUpdateKeys = goodWithUpdate.replace(updateEn.slice(1, -1), updateMissing.slice(1, -1))
      const updateWiringOk = (await checkClientExecution(goodWithUpdate, { requireUpdateWiring: true })).length === 0
      const updateWiringRejectsPlain = (await checkClientExecution(good, { requireUpdateWiring: true })).length > 0
      const updateWiringRejectsMissingKey = (await checkClientExecution(badUpdateKeys, { requireUpdateWiring: true })).length > 0
      const updateWiringRejectsNoMarker = (await checkClientExecution(goodWithUpdate.replace("'update/check', 'update/install'", "'update/check'"), { requireUpdateWiring: true })).length > 0
      return goodProblems.length === 0
        && failureCounts === 5
        && checkPrimitiveParity(parityShape).length === 0
        && parityRejected === parityBad.length
        && wiringOk
        && wiringRejectsUntraced
        && updateWiringOk
        && updateWiringRejectsPlain
        && updateWiringRejectsMissingKey
        && updateWiringRejectsNoMarker
        ? []
        : ['client VM bad samples were not rejected']
    },
    check: () => {
      if (!existsSync(CLIENT_PATH)) return ['generated packages/plugin/client/index.js does not exist']
      const primitives = hostPrimitiveExports()
      if (primitives === null) {
        return [`${PRIMITIVES_PACKAGE} is not resolvable from the repo, NODE_PATH, or global DSH install`]
      }
      return checkClientExecution(readFileSync(CLIENT_PATH, 'utf8'), { primitives, requirePrimitiveParity: true, requireUpdateWiring: true })
    },
  },
  {
    name: 'node-half-mount',
    selfTest: () => {
      const good = {
        name: PLUGIN_NAME,
        inject: ['llm', 'agentDefaultModel', 'webServer', 'systemPrompt', 'commands', 'agents', 'agentPresets', 'tools', 'compaction'],
        applyType: 'function',
        sections: [{ name: 'dsh-soulmojito:active-character', textType: 'function' }],
        registrations: [
          { kind: 'prefix', path: API_PREFIX, handlerType: 'function' },
          { kind: 'command', name: 'dsh-soulmojito-session', handlerType: 'function' },
        ],
        novelOpen: { kind: 'error', invalidPayload: false },
      }
      const bad = { ...good, registrations: [] }
      return checkNodeMountResult(good).length === 0 && checkNodeMountResult(bad).length > 0
        ? []
        : ['Node mount bad sample was not rejected']
    },
    check: () => existsSync(SERVER_PATH) ? runNodeMount() : ['generated packages/plugin/index.mjs does not exist'],
  },
  {
    // v4 会话准入回归网（0.2.0-rc.2 审计产出）：插件的每类会话写入序列都必须
    // 通过真实宿主校验——词汇表（事件类型 ∈ KNOWN_SESSION_EVENT_TYPES）与
    // turn/step 关系（assertReleasedV4Relationships）。历史导入序列直接跑真实
    // 的 historyImportAppends（esbuild 现场打包 src，杜绝 gate 镜像漂移）；
    // ST 生成轨迹与 notice 是 recordTavernSessionAssistant 等内部函数的静态
    // 镜像（未导出），加 assistant/chunk 落盘 tripwire 兜底。负样本（旧裸
    // turn:0 导入形状）必须被拒——证明 gate 接的是真校验器而非橡皮图章。
    name: 'v4-session-admission',
    selfTest: () => {
      const dirty = 'trace.session.append(\'assistant/chunk\', { turn: 1 })'
      const clean = 'trace.session.append(\'assistant/message\', { turn: 1, stream: [] })'
      return serverAppendsAssistantChunk(dirty) && !serverAppendsAssistantChunk(clean)
        ? []
        : ['assistant/chunk tripwire failed its self samples']
    },
    check: async () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      const problems = []
      if (serverAppendsAssistantChunk(readFileSync(SERVER_PATH, 'utf8'))) {
        problems.push("server bundle still appends 'assistant/chunk' — v0 vocabulary the v4 loader refuses the whole artifact for")
      }
      const runtime = locateOfficialDependencyRoot()
      if (runtime === null) return problems
      const migrationEntry = join(runtime, '@deepseek-ai', 'dsh-session-format-v3-to-v4', 'lib', 'index.js')
      const sessionEntry = join(runtime, '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
      const v3to4 = await import(pathToFileURL(migrationEntry).href)
      const dshSession = await import(pathToFileURL(sessionEntry).href)
      const known = dshSession.KNOWN_SESSION_EVENT_TYPES
      const assertRelationships = v3to4.assertReleasedV4Relationships

      const header = { version: 4, id: 'gate-v4-admission', createdAt: 1, isSeeded: false, delegationDepth: 0 }
      const toEvents = (rows) => rows.map((row, index) => ({
        type: row.type,
        seq: index,
        time: 1000 + index,
        data: row.data,
        ...(row.surfaceOp === undefined ? {} : { surfaceOp: row.surfaceOp }),
      }))
      const admissionProblems = (label, rows) => {
        const events = toEvents(rows)
        for (const event of events) {
          if (!known.has(event.type)) return [`${label}: event type '${event.type}' is outside the host KNOWN vocabulary`]
        }
        for (const event of events) {
          if (event.type === 'assistant/message' && !Array.isArray(event.data?.stream)) {
            return [`${label}: assistant/message lacks the settlement stream array (load-boundary seed check throws)`]
          }
        }
        try {
          assertRelationships({ header, events, inheritedEventCount: 0 }, known)
        } catch (error) {
          return [`${label}: real v4 relationship admission rejected the stream: ${error.message}`]
        }
        return []
      }

      // 1) 历史导入序列：真实 historyImportAppends 输出（现有闭合 turn 1 的 v4 会话）。
      const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-soulmojito-gate-v4-'))
      try {
        const bundle = await esbuildBuild({
          entryPoints: [join(PLUGIN_ROOT, 'src', 'agent-tavern', 'projector.ts')],
          bundle: true,
          format: 'esm',
          platform: 'node',
          sourcemap: false,
          write: false,
        })
        const modulePath = join(tempRoot, 'projector.mjs')
        writeFileSync(modulePath, bundle.outputFiles[0].text, 'utf8')
        const { historyImportAppends } = await import(pathToFileURL(modulePath).href)
        const chat = {
          header: { user_name: 'Alice', character_name: 'Gate Character', chat_metadata: {} },
          messages: [
            { name: 'Gate Character', is_user: false, is_system: false, send_date: '', mes: 'Greeting.' },
            { name: 'Alice', is_user: true, is_system: false, send_date: '', mes: 'Hello.' },
          ],
        }
        // 导入契约面向空白会话（激活流程保证），turn 号从 1 起步。
        const session = { header: { version: 4 } }
        const importRows = historyImportAppends(chat, 'gate-session', [], undefined, session)
        problems.push(...admissionProblems('history import', importRows))

        // 负控：旧形状（剥掉边界 + turn:0 裸消息 + 无 stream）必须被真实校验拒绝。
        const legacyShape = importRows
          .filter((row) => row.type !== 'turn/start' && row.type !== 'turn/end' && row.type !== 'step/start' && row.type !== 'step/end')
          .map((row) => row.type === 'assistant/message' ? { ...row, data: { turn: 0, step: 1 } } : row)
        let rejected = true
        try {
          assertRelationships({
            header,
            events: toEvents(legacyShape).map((event) => event.type === 'assistant/message' ? { ...event, data: { ...event.data, stream: [] } } : event),
            inheritedEventCount: 0,
          }, known)
          rejected = false
        } catch {
          rejected = true
        }
        if (!rejected) problems.push('negative control passed: the bare turn:0 import shape was NOT rejected — admission wiring is broken')
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }

      // 2) ST 生成轨迹（recordTavernSessionAssistant 等内部函数的静态镜像）。
      const traceRows = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { id: 'gate-user', role: 'user', content: [{ type: 'text', text: 'Write' }], source: { kind: 'user' } }, surfaceOp: 'append' },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'gate-assistant', role: 'assistant', content: [{ type: 'text', text: 'Reply' }], source: { kind: 'model', provider: 'gate', model: 'gate' } }, stream: [] }, surfaceOp: 'append' },
        { type: 'step/end', data: { turn: 1, step: 1 } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      problems.push(...admissionProblems('ST generation trace', traceRows))

      // 3) notice（插件 producer-owned source 的 user/message）。
      const noticeRows = [
        { type: 'user/message', data: { id: 'gate-notice', role: 'user', content: [{ type: 'text', text: 'Tavern roleplay chat.' }], source: { kind: 'plugin:dsh-soulmojito', form: 'notice', summary: 'Tavern' } }, surfaceOp: 'append' },
      ]
      problems.push(...admissionProblems('activation notice', noticeRows))

      return problems
    },
  },
  {
    // 提案 0015 §5 四不变量（P1）：默认关、目录白名单、超时常量在 bundle、
    // 禁用时 mods 路由 404。真实 bundle 子进程探测（示例 Mod 夹具 + 坏 mod.json
    // 反样本 + env 硬关第二子进程）+ 产物静态 marker。
    name: 'mod-loader',
    selfTest: () => {
      const good = {
        bootstrapMods: [EXAMPLE_MOD_ID, 'broken-mod'],
        bootstrapAllDisabled: true,
        perModOnlyGlobal: false,
        defaultOffStatus: 404,
        perModOnlyStatus: 404,
        loadedStatus: 200,
        loadedCounts: true,
        unknownRouteStatus: 404,
        traversalStatus: 404,
        reloadStatus: 200,
        statsAfterReload: 200,
        disabledAgainStatus: 404,
        brokenStatus: 'error',
        bootstrapAfterBrokenStatus: 200,
        moodUiStatus: 200,
        moodUiCsp: '<meta http-equiv="Content-Security-Policy" content="default-src',
        p2LlmKey: true,
        p2PlainNoLlmKey: true,
        agentHasMoodTool: true,
        agentHasBuiltin: true,
        agentSectionPresent: true,
        agentSectionOrderClamped: true,
        agentSectionTextNeutralized: true,
        envOff: {
          envAvailable: true,
          envBootstrapAvailable: true,
          envBootstrapModsEmpty: true,
          envStatsAfterEnabling: 404,
        },
      }
      const badSamples = [
        { ...good, bootstrapAllDisabled: false },
        { ...good, defaultOffStatus: 200 },
        { ...good, perModOnlyStatus: 200 },
        { ...good, loadedStatus: 404 },
        { ...good, loadedCounts: false },
        { ...good, traversalStatus: 200 },
        { ...good, reloadStatus: 500 },
        { ...good, disabledAgainStatus: 200 },
        { ...good, brokenStatus: 'loaded' },
        { ...good, bootstrapAfterBrokenStatus: 500 },
        { ...good, moodUiCsp: 'no csp here' },
        { ...good, p2LlmKey: false },
        { ...good, p2PlainNoLlmKey: false },
        { ...good, agentHasMoodTool: false },
        { ...good, agentSectionOrderClamped: false },
        { ...good, agentSectionTextNeutralized: false },
        { ...good, envOff: { ...good.envOff, envStatsAfterEnabling: 200 } },
        { ...good, envOff: undefined },
      ]
      const rejected = badSamples.filter((sample) => checkModLoaderResult(sample).length > 0).length
      return checkModLoaderResult(good).length === 0 && rejected === badSamples.length
        ? []
        : ['mod loader bad samples were not rejected']
    },
    check: () => {
      if (!existsSync(SERVER_PATH)) return ['generated packages/plugin/index.mjs does not exist']
      const problems = []
      const server = readFileSync(SERVER_PATH, 'utf8')
      // 不变量 2（目录白名单）：扫描锚点必须是 join(<tavern>, "mods")。
      if (!/join\w*\([^)]*,\s*"mods"\)/.test(server)) {
        problems.push('mod loader must anchor its scan at join(<tavern>, "mods") and nowhere else')
      }
      // 不变量 3（超时常量在 bundle）：hook 10s 超时的机制与常量必须打进产物。
      if (!server.includes('generation hook timed out after')) {
        problems.push('server bundle must embed the generation hook timeout mechanism (10s per-hook degradation)')
      }
      if (!/(?:10_000|10000|1e4)/.test(server)) {
        problems.push('server bundle must carry the 10s hook timeout constant')
      }
      // P2：git 安装路由在 server bundle。
      if (!server.includes('mods/install')) {
        problems.push('server bundle must carry the mods/install git route (proposal 0015 P2)')
      }
      // P2：跨 bundle 注册表与 order 钳制常量在 agent bundle（§3.6/§3.4）。
      if (existsSync(AGENT_PATH)) {
        const agent = readFileSync(AGENT_PATH, 'utf8')
        if (!agent.includes('dsh-soulmojito:mod-registry')) {
          problems.push('agent bundle must consume the globalThis mod-registry (dsh-soulmojito:mod-registry)')
        }
        if (!agent.includes('dsh-soulmojito:mods-changed-listeners')) {
          problems.push('agent bundle must subscribe to mods-changed write-through notifications')
        }
        if (!/-50/.test(agent) || !/\b0\b/.test(agent)) {
          problems.push('agent bundle must carry the mod section order clamp constants (-50..0)')
        }
      } else {
        problems.push('generated packages/plugin/agent.mjs does not exist')
      }
      const [setupProblems, result] = runModLoaderProbe(MOD_LOADER_SCRIPT)
      if (setupProblems !== null) return [...problems, ...setupProblems]
      problems.push(...checkModLoaderResult(result, { requireEnvOff: false }))
      const [envProblems, envResult] = runModLoaderProbe(MOD_LOADER_ENV_SCRIPT, { DSH_SOULMOJITO_DISABLE_MODS: '1' })
      if (envProblems !== null) return [...problems, ...envProblems]
      problems.push(...checkModLoaderResult({ ...(result ?? {}), envOff: envResult }))
      return problems
    },
  },
  {
    name: 'source-file-budget',
    selfTest: () => {
      const over = sourceBudgetVerdict('packages/plugin/src/fresh.ts', SOURCE_BUDGET_LINES + 1)
      const atLimit = sourceBudgetVerdict('packages/plugin/src/fresh.ts', SOURCE_BUDGET_LINES)
      const allowlisted = sourceBudgetVerdict('packages/plugin/src/games/builtin/monopoly.ts', 5000)
      return typeof over === 'string' && atLimit === undefined && allowlisted === undefined
        ? []
        : ['source file budget self-test did not enforce the limit and allowlist']
    },
    check: () => checkSourceFileBudget(),
  },
  {
    name: 'content-lexicon',
    selfTest: () => {
      const problems = []
      if (scanContentLexicon('The quick brown fox jumps over the lazy dog.').length !== 0) {
        problems.push('content lexicon flagged neutral prose')
      }
      if (scanContentLexicon('"identifier": "nsfw", "identifier": "jailbreak"').length !== 0) {
        problems.push('content lexicon did not allow ST prompt slot identifiers')
      }
      const sample = scanContentLexicon('an explicit porn scene')
      if (sample.length !== 1 || sample[0].term !== 'porn') {
        problems.push('content lexicon did not detect an explicit term')
      }
      const payload = Buffer.from(`chara\0${Buffer.from(JSON.stringify({ name: 'porn' })).toString('base64')}`, 'latin1')
      const chunk = Buffer.alloc(12 + payload.length)
      chunk.writeUInt32BE(payload.length, 0)
      chunk.write('tEXt', 4, 'latin1')
      payload.copy(chunk, 8)
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk])
      const texts = pngTextChunks(png)
      if (texts.length !== 1 || scanContentLexicon(texts[0].text).length !== 1) {
        problems.push('content lexicon did not read a PNG chara text chunk')
      }
      return problems
    },
    check: () => checkContentLexicon(),
  },
]

const onlyIndex = process.argv.indexOf('--only')
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1]
if (onlyIndex !== -1 && (!only || !gates.some((gate) => gate.name === only))) {
  console.error(`[FAIL] unknown gate '${only ?? ''}'`)
  console.error(`Available gates: ${gates.map((gate) => gate.name).join(', ')}`)
  process.exit(2)
}

let failures = 0
for (const gate of gates) {
  if (only !== null && gate.name !== only) continue
  let selfProblems
  try {
    selfProblems = await gate.selfTest()
  } catch (error) {
    selfProblems = [error instanceof Error ? error.stack ?? error.message : String(error)]
  }
  if (selfProblems.length > 0) {
    failures += 1
    console.error(`[FAIL] ${gate.name} self-test`)
    for (const item of selfProblems) console.error(`  - ${item}`)
    continue
  }

  let problems
  try {
    problems = await gate.check()
  } catch (error) {
    problems = [error instanceof Error ? error.stack ?? error.message : String(error)]
  }
  if (problems.length === 0) {
    console.log(`[PASS] ${gate.name}`)
  } else {
    failures += 1
    console.error(`[FAIL] ${gate.name}`)
    for (const item of problems) console.error(`  - ${item}`)
  }
}

if (failures > 0) {
  console.error(`\nGate result: FAIL (${failures} failed)`)
  process.exit(1)
}
console.log('\nGate result: PASS')
