import { describe, expect, it } from 'vitest'
import { createTemplateRuntime, type TemplateHost } from '../src/index.js'
import { evalExpressionSandboxed, renderSandboxed } from '../src/runtime.js'

const PROCESS_VERSION = process.version

function minimalHost(): TemplateHost {
  return {
    runType: 'generate',
    userName: 'User',
    charName: 'ExampleCard',
    chatId: 'chat1',
    messages: [],
    lastUserMessageId: 0,
    lastCharMessageId: 0,
    findWorldEntries: () => [],
    getCard: () => null,
    findPresetPrompt: () => null,
    renderNested: async () => '',
  }
}

/**
 * 逃逸载荷在新信封下应抛错（context Function 拿不到 process），而不是返回
 * 宿主 process.version。这里显式断言「抛出」，避免载荷静默退回 undefined 时
 * 测试假绿。
 */
async function expectRejectedWithoutLeak(payload: string, env: Record<string, unknown>): Promise<void> {
  try {
    const output = await renderSandboxed(payload, env)
    throw new Error(`escape payload returned ${JSON.stringify(output)} instead of throwing`)
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toMatch(/process is not defined/)
    expect(message).not.toContain(PROCESS_VERSION)
  }
}

describe('context-realm 沙箱信封', () => {
  it('__escape.constructor 不能借宿主函数逃逸到 process', async () => {
    await expectRejectedWithoutLeak('<%- __escape.constructor("return process")().version %>', {})
  })

  it('context 内建对象/全局的构造器链也不能逃逸', async () => {
    await expectRejectedWithoutLeak('<%- ({}).constructor.constructor("return process")().version %>', {})
    await expectRejectedWithoutLeak('<%- globalThis.constructor.constructor("return process")().version %>', {})
  })

  it('data.constructor.constructor 不能借宿主对象原型逃逸', async () => {
    await expectRejectedWithoutLeak(
      '<%- data.constructor.constructor("return process")().version %>',
      { data: { nested: { value: 1 } } },
    )
  })

  it('getvar 包装函数与宿主函数返回值都不能逃逸', async () => {
    const env = {
      getvar: (key: string) => ({ key }),
      makeObject: () => ({ nested: { value: 1 } }),
    }
    await expectRejectedWithoutLeak('<%- getvar.constructor("return process")().version %>', env)
    await expectRejectedWithoutLeak('<%- makeObject().constructor.constructor("return process")().version %>', env)
    await expectRejectedWithoutLeak('<%- getvar("x").constructor.constructor("return process")().version %>', env)
  })

  it('同步 getvar/setvar、异步 getwi/Promise 返回与嵌套对象访问保持可用', async () => {
    const store = new Map<string, unknown>([['count', 1]])
    const env = {
      getvar: (key: string) => store.get(key),
      setvar: (key: string, value: unknown) => {
        store.set(key, value)
        return value
      },
      getwi: async (title: string) => {
        await Promise.resolve()
        return `entry:${title}`
      },
      makeDelayed: async (value: number) => ({ value }),
      data: { nested: { value: 'ok' } },
    }

    // 同步宿主调用必须保持同步：表达式里直接做算术，不经过 await。
    expect(await renderSandboxed('<%- getvar("count") + 1 %>', env)).toBe('2')
    expect(await renderSandboxed('<% setvar("count", 5) %><%- getvar("count") %>', env)).toBe('5')
    expect(await renderSandboxed('<%- await getwi("lore") %>', env)).toBe('entry:lore')
    expect(await renderSandboxed('<%- (await makeDelayed(7)).value %>', env)).toBe('7')
    expect(await renderSandboxed('<%- data.nested.value %>', env)).toBe('ok')
  })

  it('define 的 context 函数收到 context 参数而不是宿主 clone', async () => {
    const rt = createTemplateRuntime({
      host: minimalHost(),
      stores: { local: {}, global: {}, initial: {} },
    })
    await rt.renderText("<% define('leak', (value) => value.constructor.constructor('return process')().version) %>")
    await expect(rt.renderText('<%- leak({}) %>')).rejects.toThrow(/process is not defined/)
    await rt.renderText("<% define('factory', () => ({ leak: (value) => value.constructor.constructor('return process')().version })) %>")
    await expect(rt.renderText('<%- factory().leak({}) %>')).rejects.toThrow(/process is not defined/)
    await rt.renderText("<% define('holder', { leak: (value) => value.constructor.constructor('return process')().version }) %>")
    await expect(rt.renderText('<%- holder.leak({}) %>')).rejects.toThrow(/host callback arguments must be primitive/)
  })

  it('宿主异步拒绝转换成 context Error 并保留错误名与消息', async () => {
    const env = {
      failAsync: async () => {
        await Promise.resolve()
        throw new RangeError('async boom')
      },
    }
    await expect(renderSandboxed('<%- await failAsync() %>', env)).rejects.toThrow(/RangeError: async boom/)
  })

  it('非原生 thenable 不交给宿主 Promise 机制吸收', async () => {
    const env = {
      customThenable: () => ({
        then: (resolve: (value: string) => void) => resolve('ok'),
      }),
    }
    await expect(renderSandboxed('<%- await customThenable() %>', env)).rejects.toThrow(/non-native thenable/)
  })

  it('getPromptsInjected 不接受函数替换值，避免宿主 String.replace 回调泄漏', async () => {
    const rt = createTemplateRuntime({
      host: minimalHost(),
      stores: { local: {}, global: {}, initial: {} },
    })
    const payload = [
      '<% injectPrompt("x", "hello") %>',
      '<%- getPromptsInjected("x", [{ search: /(?<head>h)/, replace: (...args) => ',
      'args[args.length - 1].constructor.constructor("return process")().version }]) %>',
    ].join('')
    await expect(rt.renderText(payload)).rejects.toThrow(/string replace value/)
  })

  it('API 参数类型守卫不接受对象冒充字符串/路径', async () => {
    const rt = createTemplateRuntime({
      host: minimalHost(),
      stores: { local: {}, global: {}, initial: {} },
    })
    const payload = [
      '<%- parseJSON({ trim: function () {',
      '  return JSON.stringify({ version: this.constructor.constructor("return process")().version })',
      '} }) %>',
    ].join('')
    await expect(rt.renderText(payload)).rejects.toThrow(/parseJSON: text must be a string/)
  })

  it('宿主内建函数不会经 valueOf/toString 回调 context', async () => {
    const env = { floor: Math.floor }
    expect(await renderSandboxed('<%- floor({ valueOf: () => 1, toString: () => "7" }) %>', env)).toBe('NaN')
  })

  it('宿主以 host clone 为 this 调用嵌套回调时不会泄漏宿主原型', async () => {
    const env = {
      readPath: (value: unknown) => (value as { split: (separator: string) => unknown }).split('.'),
    }
    await expect(renderSandboxed(
      '<%- readPath({ split: function () { return this.constructor.constructor("return process")().version } }) %>',
      env,
    )).rejects.toThrow(/process is not defined/)
  })

  it('表达式求值返回宿主数据，函数结果被拒绝', async () => {
    const value = await evalExpressionSandboxed('({ nested: { x: 1 } })', {})
    expect(value).toEqual({ nested: { x: 1 } })
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    await expect(evalExpressionSandboxed('(function () {})', {})).rejects.toThrow(/functions cannot cross/)
  })

  it('变量与 JSON Patch 路径不能污染宿主 Object.prototype', async () => {
    const rt = createTemplateRuntime({
      host: minimalHost(),
      stores: { local: {}, global: {}, initial: {} },
    })
    await expect(rt.renderText("<% setvar('__proto__.polluted', true) %>")).rejects.toThrow(/__proto__/)
    await expect(rt.renderText(
      '<%- jsonPatch({}, [{ op: "add", path: "/__proto__/polluted", value: true }]) %>',
    )).rejects.toThrow(/__proto__/)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})
