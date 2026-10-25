/**
 * Prompt Template 默认信任面（2026-10-25 安全收口）：EJS 默认关闭，只有 profile
 * 显式 `templateEnabled: true` 才开启；`DSH_SOULMOJITO_DISABLE_TEMPLATES` 环境
 * kill switch 始终优先。模块级 flag 初值也必须为 false——apply() 尚未写入或被
 * 测试直接引用时不能意外开放模板执行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setTemplatesEnabledFlag,
  templatesEnabled,
  templatesEnabledFlagValue,
} from '../src/runtime.js'

const ENV_KEYS = ['DSH_SOULMOJITO_DISABLE_TEMPLATES', 'DSH_TAVERN_DISABLE_TEMPLATES'] as const

// Captured at module load, before any hook or test can mutate the flag.
const initialFlag = templatesEnabledFlagValue()
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  setTemplatesEnabledFlag(false)
})

describe('Prompt Template default trust posture', () => {
  it('starts with the runtime flag off', () => {
    expect(initialFlag).toBe(false)
  })

  it('requires an explicit templateEnabled: true opt-in', () => {
    expect(templatesEnabled()).toBe(false)
    expect(templatesEnabled({})).toBe(false)
    expect(templatesEnabled({ templateEnabled: false })).toBe(false)
    expect(templatesEnabled({ templateEnabled: true })).toBe(true)
  })

  it('keeps the env kill switch stronger than the profile opt-in', () => {
    process.env.DSH_SOULMOJITO_DISABLE_TEMPLATES = '1'
    expect(templatesEnabled({ templateEnabled: true })).toBe(false)
  })

  it('resets the runtime flag to the default off state', () => {
    setTemplatesEnabledFlag(true)
    expect(templatesEnabledFlagValue()).toBe(true)
    setTemplatesEnabledFlag(false)
    expect(templatesEnabledFlagValue()).toBe(false)
  })
})
