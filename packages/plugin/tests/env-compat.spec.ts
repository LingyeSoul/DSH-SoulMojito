/**
 * 环境变量兼容读（2026-10-16 项目改名 dsh-tavern → DSH-SoulMojito）：
 * 新前缀优先、旧前缀兜底——存量用户的宿主机配置与脚本不改也继续生效。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { envCompat } from '../src/env-compat.js'

const NEW_NAME = 'DSH_SOULMOJITO_TEST_FLAG'
const OLD_NAME = 'DSH_TAVERN_TEST_FLAG'

afterEach(() => {
  delete process.env[NEW_NAME]
  delete process.env[OLD_NAME]
})

describe('envCompat（改名兼容）', () => {
  it('新前缀优先于旧前缀', () => {
    process.env[NEW_NAME] = 'new'
    process.env[OLD_NAME] = 'old'
    expect(envCompat('TEST_FLAG')).toBe('new')
  })

  it('旧前缀单独存在时仍被读取（存量配置不断）', () => {
    process.env[OLD_NAME] = 'old'
    expect(envCompat('TEST_FLAG')).toBe('old')
  })

  it('两者都不存在时返回 undefined（不引入空串语义）', () => {
    expect(envCompat('TEST_FLAG')).toBeUndefined()
  })

  it('新名为空串时不回退旧值（设置语义优先，保持 ?? 左值语义）', () => {
    process.env[NEW_NAME] = ''
    process.env[OLD_NAME] = 'old'
    expect(envCompat('TEST_FLAG')).toBe('')
  })
})
