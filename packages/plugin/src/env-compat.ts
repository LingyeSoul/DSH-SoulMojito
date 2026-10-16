/**
 * 环境变量兼容读（2026-10-16 项目改名 dsh-tavern → DSH-SoulMojito）：
 * 新前缀 `DSH_SOULMOJITO_*` 优先，旧前缀 `DSH_TAVERN_*` 保留读取兼容——
 * 存量用户的宿主机配置与脚本不改也能继续生效；文档与测试只认新前缀。
 */
export function envCompat(suffix: string): string | undefined {
  return process.env[`DSH_SOULMOJITO_${suffix}`] ?? process.env[`DSH_TAVERN_${suffix}`]
}
