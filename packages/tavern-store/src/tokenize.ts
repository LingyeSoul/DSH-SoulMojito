/**
 * CJK 感知查询分词（决策 2026-10-11-cjk-tokenization）。
 *
 * 旧实现 `[\p{L}\p{N}]+` 把无空格中文整句切成单个巨型 token，模型用自然语言
 * 调 memory_search / tavern_history_search（如"林小雨欠的赌债还了吗"）时只有
 * 逐字子串才命中，召回趋近于零。本实现：
 * - 拉丁字母/数字连续段 → 整词 token（小写化，与旧行为一致）；
 * - 汉字/假名/谚文连续段（按 Unicode script 判定）→ 全部相邻二元组（bigram），
 *   长度 1 时保留单字 token（单字查询语义；纯虚词单字同样保留，不做过度清理）；
 * - 两端均为中文虚词的 bigram 丢弃，避免"还了""了吗"这类功能词组合稀释
 *   匹配率与打分。
 * 查询侧与被检索文本侧共用同一函数；匹配仍是逐 token 的子串包含。
 */

/** 中文虚词停用字符表：bigram 两端字符都在表内即视为功能词组合，丢弃以降噪。
 * 注意 "还" 是规格示例点名的字符（"还了""还没"为体貌/时间功能词组合）；
 * 实义搭配不受影响——规则要求两端都在表内，"还钱""还债"等照常保留。 */
const CJK_STOP_BIGRAM_CHARS = new Set([...'的了是在吗呢吧啊呀么和与就都也很被把没不有还这那你我他她它们个'])

/** 汉字 + 平假名/片假名 + 谚文：无空格书写的 CJK 文化圈文字，统一走 bigram 展开。 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
/** 拉丁/数字整词（与旧实现一致的小写化词段；CJK run 已先行剥离，防止
 * `[\p{L}\p{N}]+` 从拉丁位置贪婪吃进相邻 Han 字符形成 "vip卡" 跨脚本词）。 */
const WORD = /[\p{L}\p{N}]+/gu

export function tokenizeQuery(value: string): string[] {
  const lower = value.toLocaleLowerCase()
  const tokens = new Set<string>()
  for (const word of lower.replace(CJK_RUN, ' ').match(WORD) ?? []) {
    tokens.add(word)
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    const chars = [...run]
    if (chars.length === 1) {
      tokens.add(chars[0]!)
      continue
    }
    for (let index = 0; index + 1 < chars.length; index += 1) {
      const left = chars[index]!
      const right = chars[index + 1]!
      if (CJK_STOP_BIGRAM_CHARS.has(left) && CJK_STOP_BIGRAM_CHARS.has(right)) continue
      tokens.add(left + right)
    }
  }
  return [...tokens]
}
