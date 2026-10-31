/**
 * 子进程运行器（提案 0017 §安装面，0024 §5 复用）。
 *
 * 从 `memory-embed-local.ts` 抽出：本地 ONNX 运行时与 QQ 运行时都靠面板一键
 * `pnpm add`，两条链路对子进程的纪律必须一致——windowsHide、只在 win32 走
 * shell（pnpm 是 `.cmd`，Node 安全策略不允许无 shell 直启）、1MB 输出上限、
 * 超时杀**整棵进程树** + unref。`memory-embed-local.ts` 继续 re-export，旧导入
 * 与旧测试不受影响。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

/** 子进程运行器形状（测试注入口；生产为 spawn 流式捕获）。 */
export type SpawnRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number; output: string }>

export function defaultSpawnRunner(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // win32 下 pnpm 是 .cmd（Node 安全策略不允许无 shell 直启 .cmd）；参数是
    // 本模块写死的常量包名、路径经 cwd 传递，shell 化无注入面。
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let output = ''
    const feed = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 1_000_000) output = output.slice(-1_000_000)
    }
    child.stdout?.on('data', feed)
    child.stderr?.on('data', feed)
    const timer = setTimeout(() => {
      killProcessTree(child)
      reject(new Error(`pnpm timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

/**
 * 超时清理：`shell: true` 下 child 是 cmd.exe，杀它不会带走 pnpm/node——孤儿进程
 * 会继续写 node_modules，下一次安装就撞上 lockfile 争用。win32 用 `taskkill /T`
 * 杀整棵树；其它平台直接 SIGKILL 进程组下的 child。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // taskkill 不可用时退回 child.kill()，至少把 shell 收掉。
    }
  }
  try {
    if (pid !== undefined && process.platform !== 'win32') process.kill(pid, 'SIGKILL')
    else child.kill()
  } catch {
    // 进程已经退出：没有可清理的东西。
  }
}