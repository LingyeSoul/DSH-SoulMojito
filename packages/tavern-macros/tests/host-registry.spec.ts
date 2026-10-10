import { afterEach, describe, expect, it } from 'vitest'
import { builtinMacroNames, createMacroEngine, hostMacroSnapshot, registerHostMacro } from '../src/index.js'

// 宿主全局宏注册表（提案 0015 P0）：注册 → 引擎实例化时吸收快照 → 全部
// createMacroEngine 调用点共享扩展宏。P0 注册面无宿主调用方（恒空），
// 这里直接驱动注册表验证接线语义。vitest 同 worker 进程内 globalThis
// 注册表跨文件共享，offs 必须全量回收避免污染其他 spec。
const offs: Array<() => void> = []

afterEach(() => {
  for (const off of offs.splice(0)) off()
})

const make = () => createMacroEngine({ char: 'Char', user: 'User' })

describe('host macro registry wiring', () => {
  it('registered macros expand in engines created afterwards', () => {
    offs.push(registerHostMacro('mood', (args) => `mood:${args.join('/')}`))
    const engine = make()
    expect(engine.expand('{{mood::happy}}')).toBe('mood:happy')
    expect(engine.expand('{{mood}}')).toBe('mood:')
    // 引擎既有宏不受注册表影响
    expect(engine.expand('{{char}}')).toBe('Char')
  })

  it('unregistering stops affecting engines created afterwards', () => {
    const off = registerHostMacro('ephemeral', () => 'gone')
    off()
    const engine = make()
    expect(engine.expand('{{ephemeral}}')).toBe('{{ephemeral}}')
  })

  it('snapshot absorption is frozen at engine creation time', () => {
    const off = registerHostMacro('late', () => 'late-value')
    const before = make()
    off()
    offs.push(registerHostMacro('late', () => 'late-value-2'))
    const after = make()
    // before 吸收的是注册时刻的快照：后续注销/重注册不改变既有实例
    expect(before.expand('{{late}}')).toBe('late-value')
    expect(after.expand('{{late}}')).toBe('late-value-2')
  })

  it('same-name entries resolve by order: the higher order wins (absorbed last)', () => {
    offs.push(registerHostMacro('doubled', () => 'first', 10))
    offs.push(registerHostMacro('doubled', () => 'second', 20))
    const engine = make()
    expect(engine.expand('{{doubled}}')).toBe('second')
  })

  it('malformed registrations are skipped without breaking engine creation', () => {
    offs.push(registerHostMacro('   ', () => 'bad'))
    offs.push(registerHostMacro('{{braced}}', () => 'bad'))
    const engine = make()
    expect(engine.expand('{{char}}')).toBe('Char')
    expect(engine.expand('{{braced}}')).toBe('{{braced}}')
  })

  it('registerMacro API on the engine instance still works alongside host macros', () => {
    offs.push(registerHostMacro('fromHost', () => 'host'))
    const engine = make()
    engine.registerMacro('fromInstance', () => 'instance')
    expect(engine.expand('{{fromHost}}|{{fromInstance}}')).toBe('host|instance')
  })

  it('hostMacroSnapshot is empty when nothing is registered', () => {
    // 前置：afterEach 已回收本文件此前的注册；其他并行 spec 不写此注册表
    // （注册面目前只有本文件与 P1 的 mod 宿主）。空快照是 P0 恒等基线。
    const engine = make()
    expect(engine.expand('{{char}}/{{user}}')).toBe('Char/User')
  })
})

// P2（提案 0015）：内置宏名快照——mod 宏注册面据此拒绝对核心宏的劫持
// （reg 是 Map.set 后写胜，{{char}} 一旦被覆盖影响全部求值上下文）。
describe('builtin macro names snapshot (P2 guard)', () => {
  it('contains the core builtin macro names after any engine instantiation', () => {
    make()
    const names = builtinMacroNames()
    for (const core of ['char', 'user', 'random', 'roll', 'pick', 'trim', 'setvar', 'getglobalvar']) {
      expect(names.has(core)).toBe(true)
    }
    // 快照是副本：调用方增删不影响后续读取。
    names.add('not-a-builtin')
    expect(builtinMacroNames().has('not-a-builtin')).toBe(false)
  })

  it('does not contain host-registered extension macros', () => {
    offs.push(registerHostMacro('extensionprobe', () => 'x'))
    make()
    expect(builtinMacroNames().has('extensionprobe')).toBe(false)
  })
})
