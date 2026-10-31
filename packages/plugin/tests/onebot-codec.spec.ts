/**
 * OneBot 11 codec (proposal 0024): 事件归一、CQ 码转义、出站 API 参数。
 *
 * 反向 WS 适配器只依赖这些纯函数，所以用例按表驱动钉住边界：哪些事件该被
 * 丢弃、哪些坏数据必须抛错、转义是否可逆。账号身份一律由调用方给，事件里
 * 的 self_id 不参与。
 */
import { describe, expect, it } from 'vitest'
import {
  OneBotCodecError,
  cqEscape,
  cqUnescape,
  oneBotMentioned,
  oneBotSendCall,
  parseCqString,
  parseOneBotMessage,
  type OneBotSegment,
} from '../src/im/onebot/codec.js'
import type { ImInbound, ImTarget, OutboundPart } from '../src/im/types.js'

const ACCOUNT = 'qq-main'
const RECEIVED_AT = 1_730_000_000_000
const BOT_ID = 900000

const stringFormatEvent = {
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 4003,
  user_id: 10003,
  self_id: BOT_ID,
  sender: { nickname: '小满' },
  message: '[CQ:reply,id=3001]&#91;草稿&#93;看看[CQ:image,file=b.jpg,url=https://cdn.example/b.jpg]',
}

interface MessageCase {
  name: string
  event: unknown
  expected: ImInbound | undefined
}

// 一个事件只断言一条主路径：坏事件与坏目标会抛错，另起用例
const messageCases: readonly MessageCase[] = [
  {
    name: '私聊文本事件（数组格式）归一出完整 ImInbound',
    event: {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 4001,
      user_id: 10001,
      self_id: BOT_ID,
      sender: { nickname: '阿澈' },
      message: [{ type: 'text', data: { text: '晚上好' } }],
    },
    expected: {
      channel: 'onebot',
      accountId: ACCOUNT,
      scope: 'private',
      peerId: '10001',
      senderId: '10001',
      senderName: '阿澈',
      text: '晚上好',
      media: [],
      dedupeKey: 'onebot:qq-main:private:10001:4001',
      receivedAt: RECEIVED_AT,
    },
  },
  {
    name: '群消息用群名片作答，at 与图片按顺序落进正文和 media',
    event: {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 4002,
      group_id: 20001,
      user_id: 10002,
      self_id: BOT_ID,
      sender: { card: '群名片甲', nickname: '昵称甲' },
      message: [
        { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: ' ' } },
        { type: 'image', data: { file: 'a.jpg', url: 'https://cdn.example/a.jpg' } },
      ],
    },
    expected: {
      channel: 'onebot',
      accountId: ACCOUNT,
      scope: 'group',
      peerId: '20001',
      senderId: '10002',
      senderName: '群名片甲',
      text: '@123 [图片]',
      media: [{ kind: 'image', url: 'https://cdn.example/a.jpg', name: 'a.jpg' }],
      dedupeKey: 'onebot:qq-main:group:20001:4002',
      receivedAt: RECEIVED_AT,
    },
  },
  {
    name: '字符串格式的 CQ 码与 reply 段归一成同样的正文和回复锚点',
    event: stringFormatEvent,
    expected: {
      channel: 'onebot',
      accountId: ACCOUNT,
      scope: 'private',
      peerId: '10003',
      senderId: '10003',
      senderName: '小满',
      text: '[草稿]看看[图片]',
      media: [{ kind: 'image', url: 'https://cdn.example/b.jpg', name: 'b.jpg' }],
      replyTo: '3001',
      dedupeKey: 'onebot:qq-main:private:10003:4003',
      receivedAt: RECEIVED_AT,
    },
  },
  {
    name: '群系统提示（sub_type=notice）不是人说的话',
    event: {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'notice',
      message_id: 4005,
      group_id: 20001,
      user_id: 10005,
      message: [{ type: 'text', data: { text: '管理员已禁止群内匿名聊天' } }],
    },
    expected: undefined,
  },
  {
    name: 'meta_event 不属于消息上报',
    event: { post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: BOT_ID, time: 1730000000 },
    expected: undefined,
  },
  {
    name: 'notice 上报不属于消息事件',
    event: { post_type: 'notice', notice_type: 'group_increase', self_id: BOT_ID },
    expected: undefined,
  },
  {
    name: '空消息段数组没有可投递内容',
    event: {
      post_type: 'message',
      message_type: 'private',
      message_id: 4006,
      user_id: 10006,
      message: [],
    },
    expected: undefined,
  },
  {
    name: '只有空文本段同样没有可投递内容',
    event: {
      post_type: 'message',
      message_type: 'private',
      message_id: 4007,
      user_id: 10007,
      message: [{ type: 'text', data: { text: '   ' } }],
    },
    expected: undefined,
  },
  {
    name: '纯未知消息段被丢弃后没有可投递内容',
    event: {
      post_type: 'message',
      message_type: 'group',
      message_id: 4008,
      group_id: 20008,
      user_id: 10008,
      message: [{ type: 'share', data: { url: 'https://example.com', title: '链接' } }],
    },
    expected: undefined,
  },
]

describe('parseOneBotMessage', () => {
  for (const item of messageCases) {
    it(item.name, () => {
      expect(parseOneBotMessage(item.event, ACCOUNT, RECEIVED_AT)).toEqual(item.expected)
    })
  }

  it('字符串格式与等价的数组格式归一结果完全一致', () => {
    const arrayForm = {
      ...stringFormatEvent,
      message: [
        { type: 'reply', data: { id: '3001' } },
        { type: 'text', data: { text: '[草稿]看看' } },
        { type: 'image', data: { file: 'b.jpg', url: 'https://cdn.example/b.jpg' } },
      ],
    }
    expect(parseOneBotMessage(arrayForm, ACCOUNT, RECEIVED_AT)).toEqual(
      parseOneBotMessage(stringFormatEvent, ACCOUNT, RECEIVED_AT),
    )
  })

  it('账号身份只取调用方给的 accountId，不被 self_id 覆盖', () => {
    const inbound = parseOneBotMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 4009,
        user_id: 10009,
        self_id: 123456,
        sender: { nickname: '甲' },
        message: [{ type: 'text', data: { text: 'hi' } }],
      },
      ACCOUNT,
      RECEIVED_AT,
    )
    expect(inbound?.accountId).toBe(ACCOUNT)
    expect(inbound?.dedupeKey).toBe('onebot:qq-main:private:10009:4009')
  })

  it('私聊缺昵称时用 (user_id) 兜底', () => {
    const inbound = parseOneBotMessage(
      {
        post_type: 'message',
        message_type: 'private',
        message_id: 4010,
        user_id: 10010,
        message: [{ type: 'text', data: { text: 'hi' } }],
      },
      ACCOUNT,
      RECEIVED_AT,
    )
    expect(inbound?.senderName).toBe('(10010)')
  })

  it('群名片与昵称都缺失时用 群成员(user_id) 兜底', () => {
    const inbound = parseOneBotMessage(
      {
        post_type: 'message',
        message_type: 'group',
        message_id: 4011,
        group_id: 20011,
        user_id: 10011,
        message: [{ type: 'text', data: { text: 'hi' } }],
      },
      ACCOUNT,
      RECEIVED_AT,
    )
    expect(inbound?.senderName).toBe('群成员(10011)')
  })

  it('缺 message_id 抛 BAD_EVENT 并点名字段', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'private',
            user_id: 10012,
            message: [{ type: 'text', data: { text: 'hi' } }],
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_EVENT',
      'message_id',
    )
  })

  it('message_id 是字符串时按非整数拒绝', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'private',
            message_id: '4013',
            user_id: 10013,
            message: [{ type: 'text', data: { text: 'hi' } }],
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_EVENT',
      'message_id',
    )
  })

  it('缺 user_id 抛 BAD_EVENT 并点名字段', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'group',
            message_id: 4014,
            group_id: 20014,
            message: [{ type: 'text', data: { text: 'hi' } }],
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_EVENT',
      'user_id',
    )
  })

  it('群消息缺 group_id 抛 BAD_EVENT 并点名字段', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'group',
            message_id: 4015,
            user_id: 10015,
            message: [{ type: 'text', data: { text: 'hi' } }],
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_EVENT',
      'group_id',
    )
  })

  it('message 字段类型坏掉时抛 BAD_SEGMENT 而不是静默丢弃', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'private',
            message_id: 4016,
            user_id: 10016,
            message: 42,
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_SEGMENT',
      'message',
    )
  })

  it('消息段数组里混入非对象时抛 BAD_SEGMENT 并给出下标', () => {
    expectCodecError(
      () =>
        parseOneBotMessage(
          {
            post_type: 'message',
            message_type: 'private',
            message_id: 4017,
            user_id: 10017,
            message: ['不是段'],
          },
          ACCOUNT,
          RECEIVED_AT,
        ),
      'BAD_SEGMENT',
      'message[0]',
    )
  })

  it('事件 time 按秒归一到毫秒，已毫秒原样保留，缺失则省略 platformAt', () => {
    const base = {
      post_type: 'message',
      message_type: 'private',
      message_id: 4020,
      user_id: 10020,
      sender: { nickname: '甲' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    }
    // OneBot 11 的 time 是 UNIX 秒 → 毫秒。
    expect(parseOneBotMessage({ ...base, time: 1_730_000_000 }, ACCOUNT, RECEIVED_AT)?.platformAt)
      .toBe(1_730_000_000_000)
    // 已经是毫秒的值按同一套规则原样保留。
    expect(parseOneBotMessage({ ...base, message_id: 4021, time: RECEIVED_AT }, ACCOUNT, RECEIVED_AT)?.platformAt)
      .toBe(RECEIVED_AT)
    // 没有 time：省略 platformAt，不发明平台时间。
    expect(parseOneBotMessage(base, ACCOUNT, RECEIVED_AT)?.platformAt).toBeUndefined()
  })
})

describe('oneBotMentioned', () => {
  const groupTextEvent = (message: unknown): unknown => ({
    post_type: 'message',
    message_type: 'group',
    message_id: 5001,
    group_id: 20021,
    user_id: 10021,
    message,
  })

  it('数组格式里 at 了机器人返回 true', () => {
    expect(
      oneBotMentioned(groupTextEvent([{ type: 'at', data: { qq: String(BOT_ID) } }, { type: 'text', data: { text: '在吗' } }]), String(BOT_ID)),
    ).toBe(true)
  })

  it('at 的是别人返回 false', () => {
    expect(oneBotMentioned(groupTextEvent([{ type: 'at', data: { qq: '123' } }]), String(BOT_ID))).toBe(false)
  })

  it('字符串格式的 CQ 码同样能识别', () => {
    expect(oneBotMentioned(groupTextEvent(`[CQ:at,qq=${BOT_ID}] 在吗`), String(BOT_ID))).toBe(true)
  })

  it('没有 at 段返回 false', () => {
    expect(oneBotMentioned(groupTextEvent([{ type: 'text', data: { text: '@全体成员' } }]), String(BOT_ID))).toBe(false)
  })

  it('私聊事件不参与 mention 门', () => {
    expect(
      oneBotMentioned(
        {
          post_type: 'message',
          message_type: 'private',
          message_id: 5002,
          user_id: 10022,
          message: [{ type: 'at', data: { qq: String(BOT_ID) } }],
        },
        String(BOT_ID),
      ),
    ).toBe(false)
  })

  it('坏消息段不至于让投递门抛错', () => {
    expect(oneBotMentioned(groupTextEvent(['不是段']), String(BOT_ID))).toBe(false)
  })
})

describe('oneBotSendCall', () => {
  const part: OutboundPart = { kind: 'text', text: '晚安', index: 0, total: 1 }
  const textMessage = [{ type: 'text', data: { text: '晚安' } }]

  it('私聊走 send_private_msg', () => {
    const target: ImTarget = { channel: 'onebot', accountId: ACCOUNT, scope: 'private', peerId: '10031' }
    expect(oneBotSendCall(target, part)).toEqual({
      action: 'send_private_msg',
      params: { user_id: 10031, message: textMessage, auto_escape: false },
    })
  })

  it('群聊走 send_group_msg', () => {
    const target: ImTarget = { channel: 'onebot', accountId: ACCOUNT, scope: 'group', peerId: '20032' }
    expect(oneBotSendCall(target, part)).toEqual({
      action: 'send_group_msg',
      params: { group_id: 20032, message: textMessage, auto_escape: false },
    })
  })

  it('peerId 不是整数时抛 BAD_TARGET', () => {
    const target: ImTarget = { channel: 'onebot', accountId: ACCOUNT, scope: 'private', peerId: '1003a' }
    expectCodecError(() => oneBotSendCall(target, part), 'BAD_TARGET', 'peerId')
  })

  it('peerId 为空串时抛 BAD_TARGET', () => {
    const target: ImTarget = { channel: 'onebot', accountId: ACCOUNT, scope: 'group', peerId: '' }
    expectCodecError(() => oneBotSendCall(target, part), 'BAD_TARGET', 'peerId')
  })
})

describe('cqEscape / cqUnescape', () => {
  it('转义 & [ ] , 四个字符', () => {
    expect(cqEscape('- [x] a,b & c')).toBe('- &#91;x&#93; a&#44;b &#38; c')
  })

  it('转义与反转义可逆', () => {
    const raw = '链接: http://a.example/?x=1&y=2 [逗号,方括号]'
    expect(cqUnescape(cqEscape(raw))).toBe(raw)
  })

  it('未知实体（含 &amp;）原样保留', () => {
    expect(cqUnescape('&amp; &#91;x&#93; &#40; &lt;')).toBe('&amp; [x] &#40; &lt;')
  })

  it('已转义文本再转义不会被二次解码', () => {
    expect(cqEscape('&#91;')).toBe('&#38;#91;')
    expect(cqUnescape(cqEscape('&#91;'))).toBe('&#91;')
  })

  it('原文里的实体在单次反转义后不会被连解', () => {
    expect(cqUnescape('&#38;#91;')).toBe('&#91;')
  })
})

describe('parseCqString', () => {
  it('表情与图片之间插入纯文本段', () => {
    expect(parseCqString('[CQ:face,id=123]看看[CQ:image,file=123.jpg]')).toEqual([
      { type: 'face', data: { id: '123' } },
      { type: 'text', data: { text: '看看' } },
      { type: 'image', data: { file: '123.jpg' } },
    ] satisfies OneBotSegment[])
  })

  it('功能名小写化，参数保留原值', () => {
    expect(parseCqString('[CQ:AT,qq=all]')).toEqual([{ type: 'at', data: { qq: 'all' } }])
  })

  it('未知功能名归到 unknown 并解出参数', () => {
    expect(parseCqString('[CQ:share,title=标题&#44;带逗号,url=http://baidu.com/?a=1&#38;b=2]')).toEqual([
      {
        type: 'unknown',
        data: { title: '标题,带逗号', url: 'http://baidu.com/?a=1&b=2' },
      },
    ])
  })

  it('CQ 码之外的转义文本会还原', () => {
    expect(parseCqString('&#91;x&#93;')).toEqual([{ type: 'text', data: { text: '[x]' } }])
  })

  it('未闭合的 [CQ: 当普通文本处理', () => {
    expect(parseCqString('打开 [CQ:bogus')).toEqual([{ type: 'text', data: { text: '打开 [CQ:bogus' } }])
  })
})

/** 断言抛出指定 code 的 OneBotCodecError，且消息里点名了出问题的字段。 */
function expectCodecError(run: () => unknown, code: string, field: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(OneBotCodecError)
    const codecError = error as OneBotCodecError
    expect(codecError.code).toBe(code)
    expect(codecError.message).toContain(field)
    return
  }
  throw new Error(`expected OneBotCodecError with code ${code}, but the call returned`)
}
