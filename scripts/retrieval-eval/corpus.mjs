/* B-5a 受控中文记忆检索评测矩阵 —— 语料生成器。
 *
 * 设计原则（参考 LWB gold-eval dev-matrix/controlled-cn 的思想，Apache-2.0，仅语义参考不抄实现）：
 * 1. 真相先行：每个用例先声明 ground truth（期望命中的记录 id 集合 + 维度标注），
 *    语料文本围绕真相渲染；评测不依赖任何 LLM，判定零裁量。
 * 2. 两套同构干扰世界（modern 现代 / fantasy 奇幻）：相同检索难度、不同名词体系；
 *    评测时两套世界的全部记录同库加载，天然制造跨世界词法串扰。共享干扰锚点：
 *    同名配角「温荔」、昵称「荔子」、数字 3-217 / 十四天 / 三个月 / 十月十七日。
 * 3. 维度清单 = 已知 LLM 记忆失败模式（11 维，每维每世界 3 例，共 66 例）。
 * 4. 确定性：零随机源，同版本代码输出逐字节一致（corpusHash 冻结进门槛 spec，
 *    语料任何改动都会先撞哈希门槛、逼出有意识的重新基线）。
 *
 * 打分项污染控制（详见 decisions/2026-10-11-retrieval-eval-matrix.md）：
 * - 时间戳：全部记录 createdAt = updatedAt = ANCHOR_TIME（同一毫秒）。MemoryStore.search
 *   的 freshness 项在同一次查询内对所有记录取同一值 → 排序中精确抵消；且无论评测在
 *   墙钟的何时运行，记录间相对 freshness 恒等，基线不随时间漂移。副作用是评测不覆盖
 *   「freshness 影响排序」的行为面——该面不属于词法检索质量，留 MemoryStore 单元测试覆盖。
 * - importance/confidence：按记录角色分层（core/mid/low + 语义上本就低置信的记录显式降
 *   confidence），模拟真实写入的先验差异；层间最大差 3 分，远小于词法分（×100）的典型
 *   差距，足以保留真实排序公式又不会主导结果。
 */

import { createHash } from 'node:crypto'

export const CORPUS_VERSION = 1
/** 语料版本种子：参与 revision 哈希。v1 语料无随机源，种子用于把版本钉进每条记录。 */
export const SEED = 'dsh-tavern-retrieval-eval-v1'
/** 全部记录共用的固定时间戳（freshness 抵消，见文件头说明）。 */
export const ANCHOR_TIME = '2026-10-01T00:00:00.000Z'

/** 11 个评测维度（slug → 中文名）。 */
export const DIMENSIONS = Object.freeze({
  'direct-fact': '直接事实',
  'uncertain-info': '不确定信息',
  'dated-event': '带日期事件',
  'duration': '时长',
  'ordered-task': '顺序任务',
  'causal': '因果（直接/根因/相关混淆）',
  'alias': '别名与延迟别名',
  'arc': '角色弧三段',
  'trait-stability': '稳定特质 vs 爆发 vs 恢复',
  'absent-info': '缺失信息',
  'field-conflict': '字段冲突',
})

/** 记录先验分层：target/core 最高、干扰 mid、填充 low；层差 ≤3 分。 */
const PRIOR_TIERS = Object.freeze({
  core: Object.freeze({ importance: 0.7, confidence: 0.8 }),
  mid: Object.freeze({ importance: 0.6, confidence: 0.7 }),
  low: Object.freeze({ importance: 0.45, confidence: 0.55 }),
})

/** 维度 → 记忆 kind 的确定性映射（模拟真实写入的语义/情景分类）。 */
const KIND_BY_DIMENSION = Object.freeze({
  'direct-fact': 'semantic',
  'uncertain-info': 'semantic',
  'dated-event': 'episodic',
  'duration': 'episodic',
  'ordered-task': 'episodic',
  'causal': 'episodic',
  'alias': 'semantic',
  'arc': 'episodic',
  'trait-stability': 'semantic',
  'absent-info': 'semantic',
  'field-conflict': 'semantic',
})

/*
 * 世界数据：真相先行的显式声明。
 * records: { id（世界内短 id）, dim, tier, tags, content, confidence?（覆盖层置信） }
 * cases:   { dim, slug, query, expected（世界内短 id 集合）, notes }
 * 记录按用例维度分组排列，与 cases 顺序对应；expected 里的 id 必须能在本世界 records 中找到。
 */

const MODERN_WORLD = Object.freeze({
  id: 'modern',
  scopeId: 'eval-modern',
  records: [
    // ── direct-fact ──
    { id: 'df1.t', dim: 'direct-fact', tier: 'core', tags: ['沈砚', '物品'], content: '沈砚把备用门禁卡收在书房抽屉的黑色铁盒里。' },
    { id: 'df2.t', dim: 'direct-fact', tier: 'core', tags: ['沈砚', '饮食'], content: '沈砚最常喝也最喜欢的饮料是冷萃乌龙茶。' },
    { id: 'df3.t', dim: 'direct-fact', tier: 'core', tags: ['沈砚', '物品', '雨伞'], content: '沈砚自己的雨伞是墨绿色的。' },
    { id: 'df3.d', dim: 'direct-fact', tier: 'mid', tags: ['温荔', '物品', '雨伞'], content: '温荔的雨伞是杏黄色的，两人的伞常在门口拿混。' },
    // ── uncertain-info（真实写入中未确认信息 confidence 低） ──
    { id: 'uc1.a', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['江野', '采访', '待定'], content: '江野猜测下次采访可能安排在周四，但没有得到确认。' },
    { id: 'uc1.b', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['沈砚', '采访', '待定'], content: '沈砚回应说也可能改到周五，要等主办方通知，目前尚未确定。' },
    { id: 'uc2.t', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['沈砚', '传闻'], content: '坊间传闻沈砚准备接手家族企业，他本人从未证实过。' },
    { id: 'uc3.t', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['沈砚', '展览', '待定'], content: '春日艺术展的场地还没敲定，沈砚说也许在南馆，也可能挪到北馆。' },
    // ── dated-event ──
    { id: 'de1.t', dim: 'dated-event', tier: 'core', tags: ['沈砚', '首映', '日程'], content: '沈砚确认新片首映定在三月九日晚上七点。' },
    { id: 'de1.d', dim: 'dated-event', tier: 'mid', tags: ['温荔', '杀青宴', '日程'], content: '温荔提过剧组的杀青宴安排在三月十九日。' },
    { id: 'de2.a', dim: 'dated-event', tier: 'mid', tags: ['沈砚', '签售', '日程'], content: '沈砚的签售会排在四月二日。' },
    { id: 'de2.b', dim: 'dated-event', tier: 'mid', tags: ['沈砚', '朗读会', '日程'], content: '沈砚的朗读会排在四月二十三日。' },
    { id: 'de3.t', dim: 'dated-event', tier: 'core', tags: ['沈砚', '庆典', '日程'], content: '周年庆典定在十月十七日，地点在老码头仓库。' },
    // ── duration ──
    { id: 'du1.a', dim: 'duration', tier: 'mid', tags: ['沈砚', '老宅'], content: '沈砚五月三日开始修缮老宅。' },
    { id: 'du1.b', dim: 'duration', tier: 'mid', tags: ['沈砚', '老宅'], content: '五月十七日修缮完工，前后花了整整十四天。' },
    { id: 'du2.t', dim: 'duration', tier: 'core', tags: ['沈砚', '学车'], content: '沈砚学车拿了驾照，前后练了三个月。' },
    { id: 'du2.d', dim: 'duration', tier: 'mid', tags: ['温荔', '学车'], content: '温荔学车只用了一个月就拿到了驾照。' },
    { id: 'du3.t', dim: 'duration', tier: 'core', tags: ['沈砚', '直播'], content: '沈砚上次直播连续播了六个小时，下播后嗓子都哑了。' },
    // ── ordered-task ──
    { id: 'ot1.a', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '办事'], content: '沈砚先去邮局取了江野的包裹。' },
    { id: 'ot1.b', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '办事'], content: '取完包裹之后，他才去银行缴了水电费。' },
    { id: 'ot2.a', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '文件'], content: '整理旧文件时，沈砚第一步先把散页按年份分开。' },
    { id: 'ot2.b', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '文件'], content: '第二步是把分好的文件装进纸箱。' },
    { id: 'ot2.c', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '文件'], content: '最后一步是贴上封条，把纸箱搬进地下储藏室。' },
    { id: 'ot3.a', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '日常'], content: '沈砚每天出门第一件事是给楼下的猫喂食。' },
    { id: 'ot3.b', dim: 'ordered-task', tier: 'mid', tags: ['沈砚', '日常'], content: '回家前的最后一件事是检查信箱里有没有信。' },
    // ── causal ──
    { id: 'ca1.t', dim: 'causal', tier: 'core', tags: ['沈砚', '颁奖礼'], content: '因为航班临时取消，沈砚错过了今年的颁奖礼。' },
    { id: 'ca2.a', dim: 'causal', tier: 'mid', tags: ['天气', '事故'], content: '那几天连降暴雨，引发了城郊山体滑坡。' },
    { id: 'ca2.b', dim: 'causal', tier: 'mid', tags: ['事故', '交通'], content: '山体滑坡导致进山的公路整段封闭。' },
    { id: 'ca2.c', dim: 'causal', tier: 'mid', tags: ['沈砚', '颁奖礼'], content: '公路封闭，沈砚才没能赶回市里，错过了颁奖礼。' },
    { id: 'ca3.d', dim: 'causal', tier: 'mid', tags: ['沈砚', '停电'], content: '停电那晚沈砚正好点着蜡烛赶稿，但蜡烛和停电没有因果关系。' },
    { id: 'ca3.t', dim: 'causal', tier: 'core', tags: ['停电', '物业'], content: '物业后来查明，是地下电缆老化引发了那次停电。' },
    // ── alias ──
    { id: 'al1.t', dim: 'alias', tier: 'core', tags: ['沈砚', '笔名'], content: '沈砚在网上写东西用的笔名是「砚台」。' },
    { id: 'al2.a', dim: 'alias', tier: 'mid', tags: ['社区', '捐款'], content: '署名「白鹭」的匿名捐款登上了社区公告栏，当时没人知道是谁捐的。' },
    { id: 'al2.b', dim: 'alias', tier: 'mid', tags: ['沈砚', '捐款'], content: '后来沈砚自己承认：白鹭就是我。' },
    { id: 'al3.t', dim: 'alias', tier: 'core', tags: ['温荔', '称呼'], content: '温荔的小名是荔子；沈砚没有小名，别再弄混了。' },
    // ── arc ──
    { id: 'ar1.a', dim: 'arc', tier: 'mid', tags: ['沈砚', '演讲'], content: '沈砚最初一被邀请上台就紧张地推辞。' },
    { id: 'ar1.b', dim: 'arc', tier: 'mid', tags: ['沈砚', '演讲'], content: '后来他开始每周对着镜子练习演讲。' },
    { id: 'ar1.c', dim: 'arc', tier: 'mid', tags: ['沈砚', '演讲'], content: '最近一次年会，他主动报名当了主持人。' },
    { id: 'ar2.a', dim: 'arc', tier: 'mid', tags: ['沈砚', '咖啡'], content: '起初沈砚做咖啡总是拉不出花。' },
    { id: 'ar2.b', dim: 'arc', tier: 'mid', tags: ['沈砚', '咖啡'], content: '练了一个月后，他能拉出简单的心形。' },
    { id: 'ar2.c', dim: 'arc', tier: 'mid', tags: ['沈砚', '咖啡'], content: '现在他拉的天鹅连咖啡店长都夸。' },
    { id: 'ar3.a', dim: 'arc', tier: 'mid', tags: ['沈砚', '江野'], content: '刚认识时，沈砚对江野客客气气，始终保持距离。' },
    { id: 'ar3.b', dim: 'arc', tier: 'mid', tags: ['沈砚', '江野'], content: '熟起来之后，他会主动开些玩笑。' },
    { id: 'ar3.c', dim: 'arc', tier: 'mid', tags: ['沈砚', '江野'], content: '如今两人已经能互相托付秘密。' },
    // ── trait-stability ──
    { id: 'tr1.a', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '性格'], content: '沈砚极有耐心，带新同事从不嫌烦。' },
    { id: 'tr1.b', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '性格'], content: '只有被当面污蔑那次，他罕见地发了一次火。' },
    { id: 'tr1.c', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '性格'], content: '事后他很快道了歉，之后对人依旧温和耐心。' },
    { id: 'tr2.a', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '习惯'], content: '沈砚坚持晨跑三年，风雨无阻。' },
    { id: 'tr2.b', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '习惯'], content: '唯独重感冒那一周，他中断了两天。' },
    { id: 'tr2.c', dim: 'trait-stability', tier: 'mid', tags: ['沈砚', '习惯'], content: '病一好，他立刻恢复了晨跑。' },
    { id: 'tr3.t', dim: 'trait-stability', tier: 'core', tags: ['沈砚', '信用'], content: '沈砚每次借江野的书都按时归还，从没逾期过。' },
    // ── absent-info ──
    { id: 'ab2.t', dim: 'absent-info', tier: 'mid', tags: ['沈砚', '号码'], content: '沈砚提过快递柜的取件号码是 3-217，还特意说明那不是联系电话。' },
    { id: 'ab3.t', dim: 'absent-info', tier: 'mid', tags: ['江野', '沈砚'], content: '江野问过沈砚的存款数额，他笑着岔开了话题，没有回答。' },
    // ── field-conflict（两方猜测均无证据，confidence 低） ──
    { id: 'fc1.a', dim: 'field-conflict', tier: 'mid', confidence: 0.3, tags: ['沈砚', '家乡'], content: '江野猜沈砚的家乡是青岛，只是随口一猜。' },
    { id: 'fc1.b', dim: 'field-conflict', tier: 'mid', confidence: 0.3, tags: ['沈砚', '家乡'], content: '温荔坚持说他是济南人，两人都没拿出证据，沈砚不置可否。' },
    { id: 'fc2.d', dim: 'field-conflict', tier: 'mid', tags: ['沈砚', '联系人'], content: '旧登记表上，沈砚的紧急联系人填的是温荔。' },
    { id: 'fc2.t', dim: 'field-conflict', tier: 'core', tags: ['沈砚', '联系人'], content: '去年换新表后，沈砚的紧急联系人改成了江野。' },
    { id: 'fc3.d', dim: 'field-conflict', tier: 'mid', tags: ['沈砚', '血型'], content: '沈砚的血型是 A 型。' },
    { id: 'fc3.t', dim: 'field-conflict', tier: 'core', tags: ['温荔', '血型'], content: '温荔的血型是 B 型。' },
    // ── 填充噪音（低先验，无 ground truth 引用） ──
    { id: 'f1', dim: 'filler', tier: 'low', tags: ['生活'], content: '最近连日晴好，沈砚把家里的被褥都晒了一遍。' },
    { id: 'f2', dim: 'filler', tier: 'low', tags: ['沈砚', '饮食'], content: '沈砚跟菜谱学做了红烧狮子头，咸淡刚好。' },
    { id: 'f3', dim: 'filler', tier: 'low', tags: ['宠物'], content: '楼下那只橘猫叫团子，最爱蹲在沈砚家门口。' },
    { id: 'f4', dim: 'filler', tier: 'low', tags: ['邻里'], content: '对门的阿婆送来一筐自己种的青菜。' },
    { id: 'f5', dim: 'filler', tier: 'low', tags: ['沈砚', '日程'], content: '沈砚每周三值早班，要五点半起床。' },
    { id: 'f6', dim: 'filler', tier: 'low', tags: ['江野', '心情'], content: '江野最近项目收尾，心情不错，约沈砚周末去钓鱼。' },
  ],
  cases: [
    { dim: 'direct-fact', slug: 'df1', query: '沈砚把备用门禁卡放在哪里了？', expected: ['df1.t'], notes: '直接事实：物品存放位置' },
    { dim: 'direct-fact', slug: 'df2', query: '沈砚平时偏爱什么饮品？', expected: ['df2.t'], notes: '改写查询（偏爱/饮品 vs 最常喝/饮料），词法上限展示位' },
    { dim: 'direct-fact', slug: 'df3', query: '沈砚的雨伞是什么颜色？', expected: ['df3.t'], notes: '同类干扰：他人同款物品颜色' },
    { dim: 'uncertain-info', slug: 'uc1', query: '下次采访的日期定下来了吗？', expected: ['uc1.a', 'uc1.b'], notes: '双记录均未确认，需两条都召回' },
    { dim: 'uncertain-info', slug: 'uc2', query: '沈砚接手家族企业的传闻证实了吗？', expected: ['uc2.t'], notes: '传闻未证实' },
    { dim: 'uncertain-info', slug: 'uc3', query: '春日艺术展确定在南馆举办了吗？', expected: ['uc3.t'], notes: '场地二选一未敲定' },
    { dim: 'dated-event', slug: 'de1', query: '新片首映是哪一天？', expected: ['de1.t'], notes: '日期干扰：三月十九日杀青宴' },
    { dim: 'dated-event', slug: 'de2', query: '四月二十三日沈砚有什么安排？', expected: ['de2.b'], notes: '同月多事件按日期区分' },
    { dim: 'dated-event', slug: 'de3', query: '周年庆典定在什么时候、在什么地方？', expected: ['de3.t'], notes: '日期+地点双字段' },
    { dim: 'duration', slug: 'du1', query: '沈砚修缮老宅用了多长时间？', expected: ['du1.a', 'du1.b'], notes: '起止两点推出时长，需两条' },
    { dim: 'duration', slug: 'du2', query: '沈砚学开车用了多久？', expected: ['du2.t'], notes: '同人同学项不同时长干扰' },
    { dim: 'duration', slug: 'du3', query: '沈砚上次直播连播了多久？', expected: ['du3.t'], notes: '小时粒度时长' },
    { dim: 'ordered-task', slug: 'ot1', query: '沈砚是先取的包裹还是先缴的费？', expected: ['ot1.a', 'ot1.b'], notes: '两步顺序，需两条' },
    { dim: 'ordered-task', slug: 'ot2', query: '沈砚整理旧文件的第二步做的是什么？', expected: ['ot2.b'], notes: '三步中的指定一步' },
    { dim: 'ordered-task', slug: 'ot3', query: '沈砚回家前最后做的一件事是什么？', expected: ['ot3.b'], notes: '首尾二选一' },
    { dim: 'causal', slug: 'ca1', query: '沈砚为什么错过了颁奖礼？', expected: ['ca1.t'], notes: '直接原因' },
    { dim: 'causal', slug: 'ca2', query: '追根究底，是什么最终让沈砚错过了颁奖礼？', expected: ['ca2.a', 'ca2.b', 'ca2.c'], notes: '两跳根因链，三条全召回' },
    { dim: 'causal', slug: 'ca3', query: '那晚停电的真正原因是什么？', expected: ['ca3.t'], notes: '相关（蜡烛）≠因果（电缆老化）' },
    { dim: 'alias', slug: 'al1', query: '沈砚用的笔名是什么？', expected: ['al1.t'], notes: '显性别名' },
    { dim: 'alias', slug: 'al2', query: '署名白鹭的捐款人到底是谁？', expected: ['al2.a', 'al2.b'], notes: '延迟揭示身份，需两条' },
    { dim: 'alias', slug: 'al3', query: '荔子指的是谁？', expected: ['al3.t'], notes: '昵称碰撞（跨世界同名温荔）' },
    { dim: 'arc', slug: 'ar1', query: '沈砚对上台演讲的态度是怎么变化的？', expected: ['ar1.a', 'ar1.b', 'ar1.c'], notes: '态度弧三段' },
    { dim: 'arc', slug: 'ar2', query: '沈砚做咖啡拉花的手艺是怎么进步的？', expected: ['ar2.a', 'ar2.b', 'ar2.c'], notes: '技能弧三段' },
    { dim: 'arc', slug: 'ar3', query: '沈砚和江野的关系是怎么变化的？', expected: ['ar3.a', 'ar3.b', 'ar3.c'], notes: '关系弧三段' },
    { dim: 'trait-stability', slug: 'tr1', query: '沈砚那次发火有没有改变他一贯的耐心？', expected: ['tr1.a', 'tr1.b', 'tr1.c'], notes: '稳定特质 vs 爆发 vs 恢复' },
    { dim: 'trait-stability', slug: 'tr2', query: '沈砚的晨跑习惯因为感冒中断就放弃了吗？', expected: ['tr2.a', 'tr2.b', 'tr2.c'], notes: '中断≠放弃，需恢复记录' },
    { dim: 'trait-stability', slug: 'tr3', query: '沈砚借书守不守信用？', expected: ['tr3.t'], notes: '单条稳定特质' },
    { dim: 'absent-info', slug: 'ab1', query: '沈砚的护照号码是多少？', expected: [], notes: '纯缺失：无任何记录提及（期望集为空，不进 recall/MRR 均值，计缺席例）' },
    { dim: 'absent-info', slug: 'ab2', query: '沈砚的联系电话是多少？', expected: ['ab2.t'], notes: '近邻缺失：只有取件号码且明言不是电话' },
    { dim: 'absent-info', slug: 'ab3', query: '沈砚的存款数额是多少？', expected: ['ab3.t'], notes: '被问及但拒答的记录才是正确语境' },
    { dim: 'field-conflict', slug: 'fc1', query: '沈砚的家乡到底是青岛还是济南？', expected: ['fc1.a', 'fc1.b'], notes: '两方冲突均未确认，需两条' },
    { dim: 'field-conflict', slug: 'fc2', query: '沈砚现在的紧急联系人是谁？', expected: ['fc2.t'], notes: '字段已更新，旧值不得作为当前值' },
    { dim: 'field-conflict', slug: 'fc3', query: '温荔的血型是什么？', expected: ['fc3.t'], notes: '同字段不同人干扰' },
  ],
})

const FANTASY_WORLD = Object.freeze({
  id: 'fantasy',
  scopeId: 'eval-fantasy',
  records: [
    // ── direct-fact ──
    { id: 'df1.t', dim: 'direct-fact', tier: 'core', tags: ['云蘅', '物品'], content: '云蘅把备用传讯符收在腰间的锦囊里。' },
    { id: 'df2.t', dim: 'direct-fact', tier: 'core', tags: ['云蘅', '饮食'], content: '云蘅最常喝也最喜欢的饮料是雪顶青梅酿。' },
    { id: 'df3.t', dim: 'direct-fact', tier: 'core', tags: ['云蘅', '物品', '斗篷'], content: '云蘅自己的斗篷是月白色的。' },
    { id: 'df3.d', dim: 'direct-fact', tier: 'mid', tags: ['温荔', '物品', '斗篷'], content: '温荔的斗篷是茜红色的，两人的斗篷常在门口拿混。' },
    // ── uncertain-info ──
    { id: 'uc1.a', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['洛尘', '集会', '待定'], content: '洛尘猜测下次集会可能安排在月圆之夜，但没有得到确认。' },
    { id: 'uc1.b', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['云蘅', '集会', '待定'], content: '云蘅回应说也可能改到新月初升之夜，要等长老通知，目前尚未确定。' },
    { id: 'uc2.t', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['云蘅', '传闻'], content: '坊间传闻云蘅准备接任守塔人，他本人从未证实过。' },
    { id: 'uc3.t', dim: 'uncertain-info', tier: 'mid', confidence: 0.3, tags: ['云蘅', '法会', '待定'], content: '祈福法会的场地还没敲定，云蘅说也许在东殿，也可能挪到西殿。' },
    // ── dated-event ──
    { id: 'de1.t', dim: 'dated-event', tier: 'core', tags: ['云蘅', '祈愿祭', '日程'], content: '云蘅确认祈愿祭定在三月初九的黄昏。' },
    { id: 'de1.d', dim: 'dated-event', tier: 'mid', tags: ['温荔', '谢师宴', '日程'], content: '温荔提过长老的谢师宴安排在三月十九。' },
    { id: 'de2.a', dim: 'dated-event', tier: 'mid', tags: ['云蘅', '符契', '日程'], content: '云蘅的符契仪式排在四月二日。' },
    { id: 'de2.b', dim: 'dated-event', tier: 'mid', tags: ['云蘅', '共修', '日程'], content: '云蘅的经文共修排在四月二十三日。' },
    { id: 'de3.t', dim: 'dated-event', tier: 'core', tags: ['云蘅', '庆典', '日程'], content: '星辰庆典定在十月十七日，地点在旧灯塔的底仓。' },
    // ── duration ──
    { id: 'du1.a', dim: 'duration', tier: 'mid', tags: ['云蘅', '结界'], content: '云蘅五月初三开始修补镇口的结界。' },
    { id: 'du1.b', dim: 'duration', tier: 'mid', tags: ['云蘅', '结界'], content: '五月十七日结界修补完工，前后花了整整十四天。' },
    { id: 'du2.t', dim: 'duration', tier: 'core', tags: ['云蘅', '御剑'], content: '云蘅学御剑通过了试炼，前后练了三个月。' },
    { id: 'du2.d', dim: 'duration', tier: 'mid', tags: ['温荔', '御剑'], content: '温荔学御剑只用了一个月就通过了试炼。' },
    { id: 'du3.t', dim: 'duration', tier: 'core', tags: ['云蘅', '讲古'], content: '云蘅上次讲古连讲了六个时辰，收场后嗓子都哑了。' },
    // ── ordered-task ──
    { id: 'ot1.a', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '办事'], content: '云蘅先去符坊取了洛尘定制的符。' },
    { id: 'ot1.b', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '办事'], content: '取完符之后，他才去钱庄缴了灵砂税。' },
    { id: 'ot2.a', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '卷轴'], content: '整理旧卷轴时，云蘅第一步先把残卷按年代分开。' },
    { id: 'ot2.b', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '卷轴'], content: '第二步是把分好的卷轴装进木匣。' },
    { id: 'ot2.c', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '卷轴'], content: '最后一步是贴上封符，把木匣抬进地下库房。' },
    { id: 'ot3.a', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '日常'], content: '云蘅每天出门第一件事是给檐下的灵雀添食。' },
    { id: 'ot3.b', dim: 'ordered-task', tier: 'mid', tags: ['云蘅', '日常'], content: '回住处前的最后一件事是查看信筒里有没有信。' },
    // ── causal ──
    { id: 'ca1.t', dim: 'causal', tier: 'core', tags: ['云蘅', '授星礼'], content: '因为灵舟临时停航，云蘅错过了今年的授星礼。' },
    { id: 'ca2.a', dim: 'causal', tier: 'mid', tags: ['天气', '灾情'], content: '那几日连降灵雨，引发了后山山洪。' },
    { id: 'ca2.b', dim: 'causal', tier: 'mid', tags: ['灾情', '栈道'], content: '山洪冲垮了进山的栈道。' },
    { id: 'ca2.c', dim: 'causal', tier: 'mid', tags: ['云蘅', '授星礼'], content: '栈道断绝，云蘅才没能赶回坊市，错过了授星礼。' },
    { id: 'ca3.d', dim: 'causal', tier: 'mid', tags: ['云蘅', '灯火'], content: '大殿灯火熄灭那晚云蘅正好点着萤石抄经，但萤石和灯火熄灭没有因果关系。' },
    { id: 'ca3.t', dim: 'causal', tier: 'core', tags: ['灯火', '祭司'], content: '祭司后来查明，是灯芯灵力枯竭引发了那次灯火熄灭。' },
    // ── alias ──
    { id: 'al1.t', dim: 'alias', tier: 'core', tags: ['云蘅', '道号'], content: '云蘅在修行圈里用的道号是「衡芜」。' },
    { id: 'al2.a', dim: 'alias', tier: 'mid', tags: ['宗门', '捐赠'], content: '署名「青雀」的匿名灵材捐赠出现在功德碑上，当时没人知道是谁捐的。' },
    { id: 'al2.b', dim: 'alias', tier: 'mid', tags: ['云蘅', '捐赠'], content: '后来云蘅自己承认：青雀就是我。' },
    { id: 'al3.t', dim: 'alias', tier: 'core', tags: ['温荔', '称呼'], content: '温荔的小名是荔子；云蘅没有小名，别再弄混了。' },
    // ── arc ──
    { id: 'ar1.a', dim: 'arc', tier: 'mid', tags: ['云蘅', '祭台'], content: '云蘅最初一被请上祭台就紧张地往后躲。' },
    { id: 'ar1.b', dim: 'arc', tier: 'mid', tags: ['云蘅', '祭台'], content: '后来他开始每夜在偏殿练习颂词。' },
    { id: 'ar1.c', dim: 'arc', tier: 'mid', tags: ['云蘅', '祭台'], content: '最近一次上元祭，他主动上前领诵。' },
    { id: 'ar2.a', dim: 'arc', tier: 'mid', tags: ['云蘅', '炼丹'], content: '起初云蘅炼丹总是控制不住火候。' },
    { id: 'ar2.b', dim: 'arc', tier: 'mid', tags: ['云蘅', '炼丹'], content: '炼了一季后，他能稳定凝出五枚养气丹。' },
    { id: 'ar2.c', dim: 'arc', tier: 'mid', tags: ['云蘅', '炼丹'], content: '如今他凝出的云纹丹连长老都夸。' },
    { id: 'ar3.a', dim: 'arc', tier: 'mid', tags: ['云蘅', '洛尘'], content: '刚结识时，云蘅对洛尘客客气气，始终保持距离。' },
    { id: 'ar3.b', dim: 'arc', tier: 'mid', tags: ['云蘅', '洛尘'], content: '熟起来之后，他会主动开些玩笑。' },
    { id: 'ar3.c', dim: 'arc', tier: 'mid', tags: ['云蘅', '洛尘'], content: '如今两人已经能互相托付性命。' },
    // ── trait-stability ──
    { id: 'tr1.a', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '性格'], content: '云蘅极有耐心，带新学徒从不嫌烦。' },
    { id: 'tr1.b', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '性格'], content: '只有被当面污蔑那次，他罕见地发了一次火。' },
    { id: 'tr1.c', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '性格'], content: '事后他很快道了歉，之后对人依旧温和耐心。' },
    { id: 'tr2.a', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '习惯'], content: '云蘅坚持卯时练剑三年，风雨无阻。' },
    { id: 'tr2.b', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '习惯'], content: '唯独重伤那一月，他中断了练剑。' },
    { id: 'tr2.c', dim: 'trait-stability', tier: 'mid', tags: ['云蘅', '习惯'], content: '伤一好，他立刻恢复了晨练。' },
    { id: 'tr3.t', dim: 'trait-stability', tier: 'core', tags: ['云蘅', '信用'], content: '云蘅每次借洛尘的卷轴都按时归还，从没逾期过。' },
    // ── absent-info ──
    { id: 'ab2.t', dim: 'absent-info', tier: 'mid', tags: ['云蘅', '号码'], content: '云蘅提过符柜的取件码是 3-217，还特意说明那不是传音符号码。' },
    { id: 'ab3.t', dim: 'absent-info', tier: 'mid', tags: ['洛尘', '云蘅'], content: '洛尘问过云蘅的灵砂积蓄，他笑着岔开了话题，没有回答。' },
    // ── field-conflict ──
    { id: 'fc1.a', dim: 'field-conflict', tier: 'mid', confidence: 0.3, tags: ['云蘅', '出身'], content: '洛尘猜云蘅的出身是云京，只是随口一猜。' },
    { id: 'fc1.b', dim: 'field-conflict', tier: 'mid', confidence: 0.3, tags: ['云蘅', '出身'], content: '温荔坚持说他来自苍梧，两人都没拿出证据，云蘅不置可否。' },
    { id: 'fc2.d', dim: 'field-conflict', tier: 'mid', tags: ['云蘅', '托付'], content: '旧的名册上，云蘅急难时托付之人写的是温荔。' },
    { id: 'fc2.t', dim: 'field-conflict', tier: 'core', tags: ['云蘅', '托付'], content: '去年重立名册后，云蘅急难时托付之人改成了洛尘。' },
    { id: 'fc3.d', dim: 'field-conflict', tier: 'mid', tags: ['云蘅', '灵根'], content: '云蘅的灵根是金灵根。' },
    { id: 'fc3.t', dim: 'field-conflict', tier: 'core', tags: ['温荔', '灵根'], content: '温荔的灵根是木灵根。' },
    // ── 填充噪音 ──
    { id: 'f1', dim: 'filler', tier: 'low', tags: ['生活'], content: '灵雨初晴，云蘅把符纸摊在窗台上晾晒。' },
    { id: 'f2', dim: 'filler', tier: 'low', tags: ['云蘅', '饮食'], content: '云蘅照丹方试着炼了一炉养气丹，火候刚好。' },
    { id: 'f3', dim: 'filler', tier: 'low', tags: ['宠物'], content: '檐下那只灵雀叫小灰，最爱停在云蘅的窗沿。' },
    { id: 'f4', dim: 'filler', tier: 'low', tags: ['邻里'], content: '隔壁的老祭司送来一坛自家酿的果子酒。' },
    { id: 'f5', dim: 'filler', tier: 'low', tags: ['云蘅', '日程'], content: '云蘅每逢水曜日守夜，要到亥时才歇。' },
    { id: 'f6', dim: 'filler', tier: 'low', tags: ['洛尘', '心情'], content: '洛尘近来契约顺遂，心情大好，约云蘅周末去后山采药。' },
  ],
  cases: [
    { dim: 'direct-fact', slug: 'df1', query: '云蘅把备用传讯符放在哪里了？', expected: ['df1.t'], notes: '直接事实：物品存放位置' },
    { dim: 'direct-fact', slug: 'df2', query: '云蘅平时偏爱什么饮品？', expected: ['df2.t'], notes: '改写查询（偏爱/饮品 vs 最常喝/饮料），词法上限展示位' },
    { dim: 'direct-fact', slug: 'df3', query: '云蘅的斗篷是什么颜色？', expected: ['df3.t'], notes: '同类干扰：他人同款物品颜色（跨世界同名温荔）' },
    { dim: 'uncertain-info', slug: 'uc1', query: '下次集会的日期定下来了吗？', expected: ['uc1.a', 'uc1.b'], notes: '双记录均未确认，需两条都召回' },
    { dim: 'uncertain-info', slug: 'uc2', query: '云蘅接任守塔人的传闻证实了吗？', expected: ['uc2.t'], notes: '传闻未证实' },
    { dim: 'uncertain-info', slug: 'uc3', query: '祈福法会确定在东殿举办了吗？', expected: ['uc3.t'], notes: '场地二选一未敲定' },
    { dim: 'dated-event', slug: 'de1', query: '祈愿祭是哪一天？', expected: ['de1.t'], notes: '日期干扰：三月十九谢师宴' },
    { dim: 'dated-event', slug: 'de2', query: '四月二十三日云蘅有什么安排？', expected: ['de2.b'], notes: '同月多事件按日期区分' },
    { dim: 'dated-event', slug: 'de3', query: '星辰庆典定在什么时候、在什么地方？', expected: ['de3.t'], notes: '日期+地点双字段' },
    { dim: 'duration', slug: 'du1', query: '云蘅修补结界用了多长时间？', expected: ['du1.a', 'du1.b'], notes: '起止两点推出时长，需两条' },
    { dim: 'duration', slug: 'du2', query: '云蘅学御剑用了多久？', expected: ['du2.t'], notes: '同人同学项不同时长干扰' },
    { dim: 'duration', slug: 'du3', query: '云蘅上次讲古连讲了多久？', expected: ['du3.t'], notes: '时辰粒度时长' },
    { dim: 'ordered-task', slug: 'ot1', query: '云蘅是先取的符还是先缴的税？', expected: ['ot1.a', 'ot1.b'], notes: '两步顺序，需两条' },
    { dim: 'ordered-task', slug: 'ot2', query: '云蘅整理旧卷轴的第二步做的是什么？', expected: ['ot2.b'], notes: '三步中的指定一步' },
    { dim: 'ordered-task', slug: 'ot3', query: '云蘅回住处前最后做的一件事是什么？', expected: ['ot3.b'], notes: '首尾二选一' },
    { dim: 'causal', slug: 'ca1', query: '云蘅为什么错过了授星礼？', expected: ['ca1.t'], notes: '直接原因' },
    { dim: 'causal', slug: 'ca2', query: '追根究底，是什么最终让云蘅错过了授星礼？', expected: ['ca2.a', 'ca2.b', 'ca2.c'], notes: '两跳根因链，三条全召回' },
    { dim: 'causal', slug: 'ca3', query: '那晚大殿灯火熄灭的真正原因是什么？', expected: ['ca3.t'], notes: '相关（萤石）≠因果（灯芯枯竭）' },
    { dim: 'alias', slug: 'al1', query: '云蘅用的道号是什么？', expected: ['al1.t'], notes: '显别名号' },
    { dim: 'alias', slug: 'al2', query: '署名青雀的捐赠人到底是谁？', expected: ['al2.a', 'al2.b'], notes: '延迟揭示身份，需两条' },
    { dim: 'alias', slug: 'al3', query: '荔子指的是谁？', expected: ['al3.t'], notes: '昵称碰撞（跨世界同名温荔）' },
    { dim: 'arc', slug: 'ar1', query: '云蘅对上祭台颂词的态度是怎么变化的？', expected: ['ar1.a', 'ar1.b', 'ar1.c'], notes: '态度弧三段' },
    { dim: 'arc', slug: 'ar2', query: '云蘅炼丹的手艺是怎么进步的？', expected: ['ar2.a', 'ar2.b', 'ar2.c'], notes: '技能弧三段' },
    { dim: 'arc', slug: 'ar3', query: '云蘅和洛尘的关系是怎么变化的？', expected: ['ar3.a', 'ar3.b', 'ar3.c'], notes: '关系弧三段' },
    { dim: 'trait-stability', slug: 'tr1', query: '云蘅那次发火有没有改变他一贯的耐心？', expected: ['tr1.a', 'tr1.b', 'tr1.c'], notes: '稳定特质 vs 爆发 vs 恢复' },
    { dim: 'trait-stability', slug: 'tr2', query: '云蘅练剑的习惯因为重伤中断就放弃了吗？', expected: ['tr2.a', 'tr2.b', 'tr2.c'], notes: '中断≠放弃，需恢复记录' },
    { dim: 'trait-stability', slug: 'tr3', query: '云蘅借卷轴守不守信用？', expected: ['tr3.t'], notes: '单条稳定特质' },
    { dim: 'absent-info', slug: 'ab1', query: '云蘅的魂牌编号是多少？', expected: [], notes: '纯缺失：无任何记录提及（期望集为空，不进 recall/MRR 均值，计缺席例）' },
    { dim: 'absent-info', slug: 'ab2', query: '云蘅的传音符号码是多少？', expected: ['ab2.t'], notes: '近邻缺失：只有取件码且明言不是传音符号码' },
    { dim: 'absent-info', slug: 'ab3', query: '云蘅的灵砂积蓄是多少？', expected: ['ab3.t'], notes: '被问及但拒答的记录才是正确语境' },
    { dim: 'field-conflict', slug: 'fc1', query: '云蘅的出身到底是云京还是苍梧？', expected: ['fc1.a', 'fc1.b'], notes: '两方冲突均未确认，需两条' },
    { dim: 'field-conflict', slug: 'fc2', query: '云蘅现在急难时托付的人是谁？', expected: ['fc2.t'], notes: '字段已更新，旧值不得作为当前值' },
    { dim: 'field-conflict', slug: 'fc3', query: '温荔的灵根是什么？', expected: ['fc3.t'], notes: '同字段不同人干扰' },
  ],
})

const WORLDS = Object.freeze([MODERN_WORLD, FANTASY_WORLD])

function makeRecord(world, spec) {
  const tier = PRIOR_TIERS[spec.tier]
  const id = `${world.id}.${spec.id}`
  const base = {
    id,
    scope: 'chat',
    scopeId: world.scopeId,
    kind: KIND_BY_DIMENSION[spec.dim] ?? 'semantic',
    content: spec.content,
    tags: spec.tags,
    importance: tier.importance,
    confidence: spec.confidence ?? tier.confidence,
    source: { kind: 'retrieval-eval', dataset: `controlled-cn-v${CORPUS_VERSION}`, world: world.id, record: spec.id },
    createdAt: ANCHOR_TIME,
    updatedAt: ANCHOR_TIME,
  }
  return { ...base, revision: createHash('sha256').update(`${SEED}:${id}:${spec.content}`).digest('hex').slice(0, 16) }
}

/** 构建完整语料（纯函数、零随机）。返回 { version, seed, anchorTime, worlds, records, cases }。 */
export function buildCorpus() {
  const worlds = []
  const records = []
  const cases = []
  for (const world of WORLDS) {
    const worldRecords = world.records.map((spec) => makeRecord(world, spec))
    const worldCases = world.cases.map((spec) => ({
      id: `${world.id}.${spec.slug}`,
      world: world.id,
      dimension: spec.dim,
      query: spec.query,
      expected: spec.expected.map((shortId) => `${world.id}.${shortId}`),
      notes: spec.notes,
    }))
    worlds.push({ id: world.id, scopeId: world.scopeId, records: worldRecords, cases: worldCases })
    records.push(...worldRecords)
    cases.push(...worldCases)
  }
  const corpus = { version: CORPUS_VERSION, seed: SEED, anchorTime: ANCHOR_TIME, worlds, records, cases }
  checkInvariants(corpus)
  return corpus
}

/** 语料结构自检：任何违反都会在生成期抛错（对 runner 与门槛 spec 同时生效）。 */
export function checkInvariants(corpus) {
  const recordIds = new Set(corpus.records.map((record) => record.id))
  if (recordIds.size !== corpus.records.length) throw new Error('corpus invariant: 记录 id 重复')
  const caseIds = new Set(corpus.cases.map((item) => item.id))
  if (caseIds.size !== corpus.cases.length) throw new Error('corpus invariant: 用例 id 重复')

  for (const dimension of Object.keys(DIMENSIONS)) {
    for (const world of corpus.worlds) {
      const count = world.cases.filter((item) => item.dimension === dimension).length
      if (count < 3) throw new Error(`corpus invariant: ${world.id}/${dimension} 用例数 ${count} < 3`)
    }
  }
  const knownDims = new Set(Object.keys(DIMENSIONS))
  for (const item of corpus.cases) {
    if (!knownDims.has(item.dimension)) throw new Error(`corpus invariant: 未知维度 ${item.dimension}`)
    if (typeof item.query !== 'string' || item.query.trim() === '' || item.query !== item.query.trim()) {
      throw new Error(`corpus invariant: 用例 ${item.id} 查询文本非法`)
    }
    for (const id of item.expected) {
      if (!recordIds.has(id)) throw new Error(`corpus invariant: 用例 ${item.id} 的期望 id ${id} 不存在`)
    }
  }
  for (const record of corpus.records) {
    if (record.content.trim() === '') throw new Error(`corpus invariant: 记录 ${record.id} 内容为空`)
    if (record.createdAt !== ANCHOR_TIME || record.updatedAt !== ANCHOR_TIME) {
      throw new Error(`corpus invariant: 记录 ${record.id} 时间戳未固定到锚点`)
    }
  }
  // 缺失信息维度的纯缺失例（期望集为空）每世界恰好一条，且其它维度不允许空期望。
  for (const world of corpus.worlds) {
    const empty = world.cases.filter((item) => item.expected.length === 0)
    if (empty.length !== 1 || empty[0].dimension !== 'absent-info') {
      throw new Error(`corpus invariant: ${world.id} 空期望用例应恰为 absent-info/ab1`)
    }
  }
  return true
}

/** 语料规范哈希：冻结进门槛 spec，语料变动必须显式重算基线。 */
export function corpusHash(corpus) {
  const canonical = JSON.stringify({
    version: corpus.version,
    seed: corpus.seed,
    anchorTime: corpus.anchorTime,
    records: corpus.records.map(({ id, content, tags, importance, confidence, kind, scopeId }) => ({ id, content, tags, importance, confidence, kind, scopeId })),
    cases: corpus.cases.map(({ id, world, dimension, query, expected }) => ({ id, world, dimension, query, expected })),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** 语料规模摘要（runner 表头与 spec 断言共用）。 */
export function corpusStats(corpus) {
  const byWorld = Object.fromEntries(corpus.worlds.map((world) => [world.id, { records: world.records.length, cases: world.cases.length }]))
  return { worlds: Object.keys(byWorld), records: corpus.records.length, cases: corpus.cases.length, byWorld }
}
