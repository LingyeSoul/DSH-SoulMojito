import { describe, expect, it } from 'vitest'
import {
  createTemplateRuntime,
  protectBlocks,
  type TemplateHost,
  type TemplateVariableStores,
} from '../src/index.js'

function baseHost(overrides: Partial<TemplateHost> = {}): TemplateHost {
  return {
    runType: 'generate',
    userName: 'User',
    charName: 'ExampleCard',
    chatId: 'chat1',
    model: 'test-model',
    messages: [
      { name: 'User', mes: 'hello there', is_user: true, is_system: false },
      { name: 'ExampleCard', mes: 'greetings, traveler', is_user: false, is_system: false },
    ],
    lastUserMessageId: 0,
    lastCharMessageId: 1,
    findWorldEntries: () => [],
    getCard: () => null,
    findPresetPrompt: () => null,
    renderNested: async () => '',
    ...overrides,
  }
}

function baseStores(): TemplateVariableStores & { initial: Record<string, unknown> } {
  return { local: {}, global: {}, initial: {} }
}

function runtime(overrides: { host?: Partial<TemplateHost>; stores?: Partial<TemplateVariableStores> } = {}) {
  const stores = { ...baseStores(), ...overrides.stores }
  const host = baseHost(overrides.host)
  const warnings: string[] = []
  const rt = createTemplateRuntime({ host, stores, onWarning: (m) => warnings.push(m) })
  return { rt, stores, warnings }
}

describe('EJS 语法子集', () => {
  it('脚本块与原样输出', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<% print("a") %>b')).toBe('ab')
    expect(await rt.renderText('x = <%- 1 + 2 %>')).toBe('x = 3')
  })

  it('<%= HTML 转义，<%- 原样', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<%= "<b>" %>')).toBe('&lt;b&gt;')
    expect(await rt.renderText('<%- "<b>" %>')).toBe('<b>')
  })

  it('条件与循环跨块结构', async () => {
    const { rt } = runtime()
    const src = '<% if (true) { %>yes<% } else { %>no<% } %>'
    expect(await rt.renderText(src)).toBe('yes')
    const loop = '<% const out = []; for (let i = 0; i < 3; i++) { out.push(i) } %><%- out.join(",") %>'
    expect(await rt.renderText(loop)).toBe('0,1,2')
  })

  it('注释块不输出', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('a<%# nothing %>b')).toBe('ab')
  })

  it('-%> 吞噬一个换行；<%_ _%> 吞噬两侧空白', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('a\n<%- 1 -%>\nb')).toBe('a\n1b')
    expect(await rt.renderText('a   <%_ 1 _%>   b')).toBe('ab')
  })

  it('<%% 与 %%> 字面量', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<%%= 1 %>')).toBe('<%= 1 %>')
    expect(await rt.renderText('<% print("x") %>%%>')).toBe('x%>')
  })

  it('顶层 await 可用', async () => {
    const { rt } = runtime({ host: { renderNested: async (src) => `{${src}}` } })
    expect(await rt.renderText('<%- await evalTemplate("1+1") %>')).toBe('{1+1}')
  })

  it('同步回调里的 <%= %> 不再把 await 当未定义标识符', async () => {
    const { rt } = runtime()
    const source = '<% [1, 2].forEach((value) => { %><%= value %><% }) %>'
    await expect(rt.renderText(source)).resolves.toBe('12')
  })

  it('迷你 lodash 覆盖卡内 EJS 的 random/sample/sampleSize/clamp/uniq/isEqual/unset', async () => {
    const { rt } = runtime()
    const rendered = await rt.renderText([
      '<% const roll = _.random(1, 6); const sample = _.sample(["a", "b"]); const pair = _.sampleSize(["x", "y", "z"], 2); %>',
      '<%- roll >= 1 && roll <= 6 %>|',
      '<%- ["a", "b"].includes(sample) %>|',
      '<%- pair.length === 2 && new Set(pair).size === 2 %>|',
      '<%- _.clamp(9, 0, 5) %>|',
      '<%- _.uniq([1, 1, 2]).join(",") %>|',
      '<%- _.isEqual({ a: 1 }, { a: 1 }) %>|',
      '<% const tree = { a: { b: 1 } }; const removed = _.unset(tree, "a.b"); %>',
      '<%- removed && tree.a.b === undefined %>',
    ].join(''))
    expect(rendered).toBe('true|true|true|5|1,2|true|true')
  })

  it('同步回调里的异步表达式给出明确错误而不是静默输出 Promise', async () => {
    const { rt } = runtime({ host: { renderNested: async (src) => src } })
    const source = '<% [1].forEach(() => { %><%- evalTemplate("x") %><% }) %>'
    await expect(rt.renderText(source)).rejects.toThrow(/async template expression used inside a synchronous callback/)
  })

  it('print 多参数空格拼接', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<% print("a", "b", 3) %>')).toBe('a b 3')
  })

  it('undefined/null 输出为空串', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('a<%- undefined %>b<%- null %>')).toBe('ab')
  })

  it('沙箱无宿主全局（process/require 不可见）', async () => {
    const { rt } = runtime()
    await expect(rt.renderText('<%- typeof process %>')).resolves.toBe('undefined')
    await expect(rt.renderText('<%- typeof require %>')).resolves.toBe('undefined')
    await expect(rt.renderText('<%- typeof fetch %>')).resolves.toBe('undefined')
    await expect(rt.renderText('<%- typeof setTimeout %>')).resolves.toBe('undefined')
    expect(await rt.renderText('<%- typeof JSON %>')).toBe('object')
  })

  it('保护块：escape-ejs 与 think 标签内不执行', async () => {
    expect(protectBlocks('<#escape-ejs><%= 1 %><#/escape-ejs>')).toContain('<%%= 1 %%>')
    const { rt } = runtime()
    expect(await rt.renderText('<think><%= evil() %></think>ok')).toBe('<think><%= evil() %></think>ok')
  })

  it('无标签文本直通（不进沙箱）', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('plain text {{macro}}')).toBe('plain text {{macro}}')
    // 尾部悬空 <%% 同样按字面量解码为 <%
    expect(await rt.renderText('tail <%%')).toBe('tail <%')
  })

  it('语法错误与运行错误均抛出', async () => {
    const { rt } = runtime()
    await expect(rt.renderText('<%- 1 +')).rejects.toThrow(/template execution failed: .*unclosed tag/)
    await expect(rt.renderText('<% nope() %>')).rejects.toThrow(/template execution failed/)
  })
})

describe('变量系统', () => {
  it('setvar/getvar 默认走 local 并写穿 cache 视图', async () => {
    const { rt, stores } = runtime()
    await rt.renderText("<% setvar('affinity', 10) %>")
    expect(stores.local['affinity']).toBe(10)
    expect(await rt.renderText('<%- getvar("affinity") %>')).toBe('10')
  })

  it('variables 常量合并 global→initial→local 且随写更新', async () => {
    const { rt } = runtime({ stores: { global: { g: 1 }, initial: { base: 0 }, local: { l: 2 } } })
    expect(await rt.renderText('<%- JSON.stringify(variables) %>')).toBe(JSON.stringify({ g: 1, base: 0, l: 2 }))
    await rt.renderText("<% setvar('extra', true) %>")
    expect(await rt.renderText('<%- variables.extra %>')).toBe('true')
  })

  it('点路径读写与 incvar/decvar', async () => {
    const { rt } = runtime()
    await rt.renderText("<% setvar('hakimi.affection', 5); incvar('hakimi.affection', 10) %>")
    expect(await rt.renderText('<%- getvar("hakimi.affection") %>')).toBe('15')
    await rt.renderText("<% decvar('hakimi.affection', 3) %>")
    expect(await rt.renderText('<%- getvar("hakimi.affection") %>')).toBe('12')
  })

  it('flags：nx/xx/nxs/xxs', async () => {
    const { rt } = runtime({ stores: { local: { a: 1 } } })
    await rt.renderText("<% setvar('a', 2, 'nx') %>")
    expect(await rt.renderText('<%- getvar("a") %>')).toBe('1')
    await rt.renderText("<% setvar('a', 2, 'xx') %>")
    expect(await rt.renderText('<%- getvar("a") %>')).toBe('2')
    await rt.renderText("<% setvar('b', 9, { scope: 'local', flags: 'xxs' }) %>")
    expect(await rt.renderText('<%- JSON.stringify(getvar(null)) %>')).not.toContain('"b":9')
  })

  it('getvar defaults 与 delvar/insvar', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<%- getvar("missing", { defaults: "dft" }) %>')).toBe('dft')
    await rt.renderText("<% setvar('arr', [1,2,3]); insvar('arr', 9, 1); delvar('arr', 0) %>")
    expect(await rt.renderText('<%- JSON.stringify(getvar("arr")) %>')).toBe('[9,2,3]')
  })

  it('global 仅标量；对象树报错', async () => {
    const { rt, stores } = runtime()
    await rt.renderText("<% setvar('count', 1, 'global') %>")
    expect(stores.global['count']).toBe(1)
    await expect(rt.renderText("<% setvar('tree', {}, 'global') %>")).rejects.toThrow(/global scope/)
    expect(stores.global['tree']).toBeUndefined()
  })

  it('injectPrompt / getPromptsInjected / hasPromptsInjected', async () => {
    const { rt } = runtime()
    await rt.renderText('<% injectPrompt("CoT", "step A", 200); injectPrompt("CoT", "step B", 100) %>')
    expect(await rt.renderText('<%- getPromptsInjected("CoT") %>')).toBe('step B\nstep A')
    expect(await rt.renderText('<%- hasPromptsInjected("CoT") %>')).toBe('true')
    expect(await rt.renderText('<%- hasPromptsInjected("Nope") %>')).toBe('false')
  })

  it('define 跨渲染共享', async () => {
    const { rt } = runtime()
    await rt.renderText("<% define('double', (x) => x * 2) %>")
    expect(await rt.renderText('<%- double(21) %>')).toBe('42')
  })

  it('parseJSON 宽容解析', async () => {
    const { rt } = runtime()
    expect(await rt.renderText('<%- parseJSON(\'{"a": 1,}\').a %>')).toBe('1')
    expect(await rt.renderText('<%- parseJSON("prelude {\\"b\\": 2} trailing").b %>')).toBe('2')
  })

  it('jsonPatch 修改变量', async () => {
    const { rt } = runtime()
    await rt.renderText("<% setvar('tree', { hp: 10, bag: ['a'] }); patchVariables('tree', [{ op: 'replace', path: '/hp', value: 5 }, { op: 'add', path: '/bag/-', value: 'b' }]) %>")
    expect(await rt.renderText('<%- JSON.stringify(getvar("tree")) %>')).toBe('{"hp":5,"bag":["a","b"]}')
  })
})

describe('宿主资产 API', () => {
  /** 构建 renderNested 已桥接回 runtime 的实例（plugin 侧同款接线）。 */
  function bridged(hostOverrides: Partial<TemplateHost> = {}, stores: TemplateVariableStores = baseStores()) {
    const host = baseHost(hostOverrides)
    const rt = createTemplateRuntime({ host, stores })
    host.renderNested = (src, extra) => rt.renderText(src, extra)
    return { rt, host }
  }

  it('getwi 查找并渲染条目（串标题 / 数字 uid）', async () => {
    const { rt } = bridged({
      findWorldEntries: (title, book) => {
        if (title === 'lily is friend') {
          return [{ uid: 3, book: book ?? 'main', comment: 'lily is friend', content: 'Lily is <%- variables.mood %>.' }]
        }
        if (title === 7) return [{ uid: 7, book: 'x', comment: 'by-uid', content: 'uid entry' }]
        return []
      },
    }, { local: { mood: 'happy' }, global: {} })
    expect(await rt.renderText('<%- await getwi("lily is friend") %>')).toBe('Lily is happy.')
    expect(await rt.renderText('<%- await getwi(7) %>')).toBe('uid entry')
    expect(await rt.renderText('<%- await getwi("nope") %>')).toBe('')
  })

  it('getwi 指定书名匹配', async () => {
    const { rt } = bridged({
      findWorldEntries: (title, book) => (title === 'entry' && book === 'main' ? [{ uid: 1, book, comment: 'entry', content: 'in main' }] : []),
    })
    expect(await rt.renderText('<%- await getwi("main", "entry") %>')).toBe('in main')
  })

  it('getChatMessage(s) / matchChatMessages', async () => {
    const { rt } = bridged()
    expect(await rt.renderText('<%- getChatMessage(0) %>')).toBe('hello there')
    expect(await rt.renderText('<%- getChatMessage(-1) %>')).toBe('greetings, traveler')
    expect(await rt.renderText('<%- getChatMessages(0, 1, "user")[0] %>')).toBe('hello there')
    expect(await rt.renderText('<%- matchChatMessages("traveler") %>')).toBe('true')
    expect(await rt.renderText('<%- matchChatMessages(/^hello/) %>')).toBe('true')
    expect(await rt.renderText('<%- matchChatMessages("nope") %>')).toBe('false')
  })

  it('getchar 默认模板渲染卡定义', async () => {
    const { rt } = bridged({
      getCard: () => ({
        name: 'ExampleCard',
        systemPrompt: '',
        personality: 'cheerful',
        description: 'an elf',
        scenario: '',
        firstMes: 'hi',
        mesExample: '',
        creatorNotes: '',
        depthPrompt: '',
        data: {},
      }),
    })
    const out = await rt.renderText('<%- await getchar() %>')
    expect(out).toContain('name: ExampleCard')
    expect(out).toContain('personality: cheerful')
    expect(out).toContain('description: an elf')
  })

  it('getpreset 按名查找渲染', async () => {
    const { rt } = bridged({
      findPresetPrompt: (name) => (name === 'main' ? { name, content: 'Main: <%- charName %>' } : null),
    })
    expect(await rt.renderText('<%- await getpreset("main") %>')).toBe('Main: ExampleCard')
    expect(await rt.renderText('<%- await getpreset("none") %>')).toBe('')
  })

  it('getCharData 返回卡数据克隆', async () => {
    const { rt } = bridged({
      getCard: () => ({
        name: 'A', systemPrompt: '', personality: '', description: 'd', scenario: '',
        firstMes: '', mesExample: '', creatorNotes: '', depthPrompt: '',
        data: { description: 'd' },
      }),
    })
    expect(await rt.renderText('<%- getCharData().description %>')).toBe('d')
  })
})

describe('runtime 桥接', () => {
  it('host.renderNested 走 runtime 时 getwi 可递归（深度限制）', async () => {
    const host: TemplateHost = baseHost({
      findWorldEntries: (title) =>
        String(title) === 'chain' ? [{ uid: 1, book: 'b', comment: 'chain', content: '<%- await getwi("chain") %>' }] : [],
    })
    const warnings: string[] = []
    const rt = createTemplateRuntime({ host, stores: baseStores(), onWarning: (m) => warnings.push(m) })
    host.renderNested = (src, extra) => rt.renderText(src, extra)
    const out = await rt.renderText('<%- await getwi("chain") %>')
    expect(out).toBe('')
    expect(warnings.some((w) => w.includes('recursion depth'))).toBe(true)
  })
})
