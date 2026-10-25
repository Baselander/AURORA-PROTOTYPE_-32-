/**
 * info/brain.mjs —— 她自己的「脑子」：不走 DSH，直接接 DeepSeek API 的流式一问一答
 * （2026-10-22 早上，P1 见面礼。主人要的是"像聊天"，不是"发请求等十秒"）
 *
 * 为什么不用 DSH：DSH 每次都要冷启动一个完整 profile（1~3 秒）、不流式、每句话都是新进程。
 * 这个脚本只做三件事：读她的规矩/记忆 → 调 API（流式）→ 把这一问一答记进会话文件。
 * 它自己也不常驻：浮窗按下回车时起它、它把字一个个吐到 stdout、说完就退。
 * （以后要"她主动开口/随时插话"，再外面套一层常驻进程，协议不用变。）
 *
 * 输出协议（stdout，一行一个 JSON；浮窗按行读，边读边上屏）：
 *   {"t":"start"}
 *   {"t":"delta","d":"她"}
 *   {"t":"done","reply":"完整回复","ms":1234,"usage":{...}}
 *   {"t":"error","message":"..."}
 *
 * 会话记忆：`<数据目录>\brain-session.jsonl`（一行一条 {at, role, content}）。
 *   每次只带最近 N 条 + 总量上限，防止把上下文撑爆。
 *
 * 用法：
 *   node info/brain.mjs --ask "hist WS FRI 是什么意思"
 *   node info/brain.mjs --ask-file <文件>      # 浮窗用这个（避免命令行转义）
 *   node info/brain.mjs --mock --ask "自检用（不联网，吐假流）"
 *   node info/brain.mjs --probe                  # 用真 key 打一次最小请求，报延迟
 *   node info/brain.mjs --show-session           # 看看会话里存了几条
 *   可选：--data <_study-core> --root <数据根> --keyfile <KEY.txt> --model deepseek-chat --max-tokens 600
 *
 * ⚠️ key 文件放 `<数据根>\mystery\KEY.txt`（一行，sk-...）。本脚本**从不打印 key**。
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// 方括号 = 控制模型 / 小括号 = 给人看（同一套规则主进程也用，见 info\brackets.mjs）
import { makeBracketBroom, stripBracketControls } from './brackets.mjs'
// ```board 画图块：解析成 strokes（给对话页画）+ 从正文与念稿里剥掉（2026-10-25 P0-2，见 info\board.mjs）
import { makeBoardBroom, splitBoardBlocks, stripBoardBlocks } from './board.mjs'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const ROOT = opt('root', process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`)
const DATA = opt('data', join(ROOT, '_study-core'))
const KEYFILE = opt('keyfile', join(ROOT, 'mystery', 'KEY.txt'))
const MODEL = opt('model', process.env.DSH_BRAIN_MODEL || 'deepseek-chat')
const BASE_URL = (opt('base', process.env.DSH_BRAIN_BASE_URL || 'https://api.deepseek.com')).replace(/\/+$/, '')
const MAX_TOKENS = Number.parseInt(opt('max-tokens', '600'), 10)
const TIMEOUT_MS = Number.parseInt(opt('timeout', '60'), 10) * 1000
const MOCK = has('mock')
// 2026-10-22（模型/浮窗分离）：她说话时，把这一轮做成"agent 事件"写进 out\pet-events.jsonl，
//   桌宠窗口（info\pet\serve.mjs 的 SSE）就会照着做：倾听 → 思考 → 说话 → 收工。
// ⚠️ ROOT 是"数据根"（AURORA_DATA，缺省包内 data\），out\ 在**项目根**下 —— 别混。
const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = process.env.DSH_PROJECT_ROOT || dirname(HERE)
const PET_EVENTS = join(PROJECT_ROOT, 'out', 'pet-events.jsonl')
const PET_ENABLED = process.env.DSH_PET_EVENTS !== 'off'

// ── 课件库检索（2026-10-24 接上；数据侧在 info\materials，主人暑假项目 ClassCapainAI 的 RAG 思路）
//   每次提问先在本机检索一遍他自己的课件/讲义，命中了就附在问题前面（并要求她标来源）。
//   DSH_MATERIALS=0 可以关；检索失败/没索引都不影响正常聊天。
const MATERIALS_QUERY = join(HERE, 'materials', 'query.mjs')
const MATERIALS_ON = process.env.DSH_MATERIALS !== 'off' && existsSync(MATERIALS_QUERY)
const MATERIALS_K = Number.parseInt(process.env.DSH_MATERIALS_K || '4', 10)
const MATERIALS_MIN_SCORE = Number(process.env.DSH_MATERIALS_MIN_SCORE || '0.15')
const MATERIALS_MAX_CHARS = Number.parseInt(process.env.DSH_MATERIALS_MAX_CHARS || '1800', 10)

/**
 * 问一句课件库，拿回 {hits:[{source,page,score,text}], text}（text 是要塞给她的那段）
 * 刻意同步 + 短超时：检索慢了她就别等，直接照常回答。
 */
const MAT_EN_DICT = [
  ['细胞呼吸', 'cellular respiration'],
  ['光合作用', 'photosynthesis'],
  ['糖酵解', 'glycolysis'],
  ['三羧酸循环', 'citric acid cycle krebs'],
  ['线粒体', 'mitochondria'],
  ['细胞膜', 'cell membrane'],
  ['细胞壁', 'cell wall'],
  ['酶', 'enzyme'],
  ['蛋白质', 'protein'],
  ['基因', 'gene'],
  ['转录', 'transcription'],
  ['翻译', 'translation'],
  ['遗传', 'genetics inheritance'],
  ['减数分裂', 'meiosis'],
  ['有丝分裂', 'mitosis'],
  ['自然选择', 'natural selection evolution'],
  ['生态', 'ecology'],
  ['受力', 'force free body diagram'],
  ['加速度', 'acceleration'],
  ['动量', 'momentum'],
  ['能量守恒', 'conservation of energy'],
  ['机械能', 'mechanical energy'],
  ['摩擦', 'friction'],
  ['圆周运动', 'circular motion'],
  ['简谐', 'simple harmonic'],
  ['电场', 'electric field'],
  ['磁场', 'magnetic field'],
  ['电路', 'circuit'],
  ['导数', 'derivative'],
  ['积分', 'integral'],
  ['极限', 'limit'],
  ['级数', 'series'],
  ['函数', 'function'],
  ['斜率', 'slope'],
  ['供需', 'supply demand'],
  ['弹性', 'elasticity'],
  ['机会成本', 'opportunity cost'],
  ['边际', 'marginal'],
  ['均衡', 'equilibrium'],
  ['通货膨胀', 'inflation'],
  [' subsidies', 'subsidy'],
  ['垄断', 'monopoly'],
  ['一战', 'world war i'],
  ['二战', 'world war ii'],
  ['革命', 'revolution'],
  ['文艺复兴', 'renaissance'],
  ['冷战', 'cold war'],
]

/** 中→英关键词扩展（他的课件基本是英文；他若用中文问，纯 2-gram 检索会全落空） */
function expandMaterialsQuery(q) {
  const text = String(q || '')
  const extra = []
  for (const [zh, en] of MAT_EN_DICT) {
    if (text.includes(zh)) extra.push(en)
  }
  return extra.length > 0 ? `${text} ${extra.join(' ')}` : text
}

/**
 * 2026-10-25 P1-1：按科目过滤检索。
 * 索引从 11,611 涨到 37,279 块以后，每次提问前的检索从 ~0.3 秒变成 1.1 秒以上；
 * 而一个问答基本只可能是某一门课的 → 认出科目就只在那门课的课件里找（bio 746 块 / econ 3,320 块）。
 * 词表故意写得宽（认不出就不加过滤，只是慢一点，不会答错）；英文词按"整词"匹配，
 * 免得 `calculate` 被当成 calc、`speed limit` 被当成微积分的 limit。
 */
const SUBJECT_HINTS = [
  [
    'AP-Physics1',
    ['物理', 'physics', '力学', 'kinematics', 'velocity', 'acceleration', 'momentum', '动量', '动能', 'energy', 'force', 'free body', 'friction', '电路', 'circuit', 'electric', 'magnetic', '磁场', '电场', '圆周运动', 'harmonic', 'projectile', 'torque', '重力', '重力加速度', 'newton'],
  ],
  [
    'AP-CalculusBC',
    ['微积分', 'calculus', 'derivative', 'derivatives', '导数', '求导', '积分', 'integral', 'integrate', '极限', 'limits', 'series', '级数', 'slope', '斜率', 'tangent', 'taylor', '泰勒', '洛必达', 'lhopital', "l'hopital", 'polar', '极坐标', 'asymptote', '渐近线', 'riemann', '泰勒展开', 'convergence', '收敛'],
  ],
  [
    'AP-Microeconomic',
    ['经济', 'economics', 'economics', 'econ', 'microeconomic', '微观', '供给', '需求', 'supply', 'demand', 'elasticity', '弹性', '机会成本', 'opportunity cost', 'marginal', '边际', 'equilibrium', '均衡', 'inflation', '通胀', '通货膨胀', 'monopoly', '垄断', 'market structure', '市场结构', 'subsidy', '补贴', 'surplus', '无谓损失', 'externality', '外部性'],
  ],
  [
    'PreAP-Biology',
    ['生物', 'biology', '细胞', 'cell', 'cells', 'photosynthesis', '光合作用', 'respiration', '呼吸作用', 'enzyme', '酶', 'gene', 'genes', 'dna', 'rna', 'protein', '蛋白质', 'genetics', '遗传', 'evolution', '进化', 'ecology', '生态', 'mitochondria', '线粒体', 'meiosis', 'mitosis', 'chromosome', '染色体', 'osmosis', 'diffusion', '渗透', '扩散'],
  ],
  ['PreAP-Seminar', ['研讨', 'seminar', '论点', 'argument', 'research question', '文献', 'citation']],
  [
    'PreAP-WorldHistory',
    ['历史', 'history', 'cold war', '冷战', 'revolution', '革命', 'renaissance', '文艺复兴', 'world war', '世界大战', 'empire', '帝国', 'colonial', '殖民', 'treaty', '条约', 'civilization', '文明', 'dynasty', '朝代'],
  ],
]

const LOWER_LATIN = /^[a-z0-9 ''_-]+$/i

/** 英文词按整词匹配（calculate 不算 calc）；中文词按包含匹配 */
function hintHit(text, word) {
  const w = String(word || '').toLowerCase()
  if (!w) return false
  if (LOWER_LATIN.test(w)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]?")
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text)
  }
  return text.includes(w)
}

/** 从主人这句话里认出是哪几门课（最多 3 门；一门都认不出 = 不加过滤） */
function detectSubjects(question) {
  const t = String(question || '').toLowerCase()
  const out = []
  for (const [name, words] of SUBJECT_HINTS) {
    if (words.some((w) => hintHit(t, w))) {
      out.push(name)
      if (out.length >= 3) break
    }
  }
  return out
}

function runMaterialsQuery(query, k, subjects) {
  const args = [MATERIALS_QUERY, '--q', query, '--k', String(k), '--json']
  if (subjects && subjects.length > 0) args.push('--subject', subjects.join(','))
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, DSH_DATA: ROOT, DSH_G10_ROOT: G10 },
  })
  if (r.status !== 0 || !r.stdout) return null
  const line = String(r.stdout).trim().split(/\r?\n/).filter(Boolean).pop()
  try {
    const j = JSON.parse(line)
    return j && j.ok && Array.isArray(j.hits) ? j : null
  } catch {
    return null
  }
}

function materialsContext(question) {
  if (!MATERIALS_ON) return null
  const q = String(question || '').trim()
  if (q.length < 4) return null
  const query = expandMaterialsQuery(q)
  try {
    // 先按科目过滤（快）；过滤后一条都没命中 → 退回全库再找一次（宁可慢，也别漏）
    const subjects = detectSubjects(q)
    let j = subjects.length > 0 ? runMaterialsQuery(query, MATERIALS_K, subjects) : null
    let filteredTried = subjects.length > 0
    const tooFew = !j || j.hits.length === 0
    if (tooFew) {
      j = runMaterialsQuery(query, MATERIALS_K, [])
      if (filteredTried) log_materials(`按科目没命中（${subjects.join('/')}）→ 退回全库检索`)
    }
    if (!j || !Array.isArray(j.hits)) return null
    const hits = j.hits.filter((h) => h && Number(h.score) >= MATERIALS_MIN_SCORE).slice(0, MATERIALS_K)
    if (hits.length === 0) return null
    const parts = []
    let total = 0
    for (const h of hits) {
      const name = String(h.source || '').split(/[\\/]/).pop()
      const page = h.page ? ` P${h.page}` : ''
      const body = String(h.text || '').replace(/\s+/g, ' ').trim().slice(0, 600)
      const piece = `· ${name}${page}：${body}`
      if (total + piece.length > MATERIALS_MAX_CHARS) break
      parts.push(piece)
      total += piece.length
    }
    if (parts.length === 0) return null
    return { hits, text: parts.join('\n'), expandedWords: query !== q, subjects: filteredTried && !tooFew ? subjects : [] }
  } catch {
    return null
  }
}

/** 检索这条链路的小日志（进 `out\brain.log` 那种地方；失败也不影响聊天） */
function log_materials(msg) {
  try {
    mkdirSync(dirname(join(ROOT, 'out', 'brain-materials.log')), { recursive: true })
    appendFileSync(join(ROOT, 'out', 'brain-materials.log'), `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch {
    /* 记不下来就算了 */
  }
}

function petEvent(event) {
  if (!PET_ENABLED) return
  try {
    mkdirSync(dirname(PET_EVENTS), { recursive: true })
    appendFileSync(PET_EVENTS, `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    /* 桌宠不在也不影响聊天 */
  }
}

/** 从回复里猜个情绪（很轻的规则，不调模型）。 */
function moodOf(reply) {
  const t = String(reply || '')
  if (/(抱歉|对不起|不好意思|失败|做不到|没弄好)/.test(t)) return 'sad'
  if (/(太好了|好耶|棒|开心|成功|搞定|完成)/.test(t)) return 'happy'
  if (/(等一下|稍等|让我看看|我先)/.test(t)) return 'thinking'
  if (/(别急|不要|小心|注意)/.test(t)) return 'alert'
  return 'happy'
}
// 2026-10-24 晚（第 12 条：对话按主题分上下文）
//   `--session <文件>` 让主进程按"主题"指定会话文件（brain-session-<主题>.jsonl）。
//   不传还是老路径 —— 旧脚本/旧浮窗一个字都不用改，主人的 6.6KB 老会话也不会丢。
const SESSION_FILE = opt('session', join(DATA, 'brain-session.jsonl'))
const HISTORY_MAX_ITEMS = 24
const HISTORY_MAX_CHARS = 9000


/**
 * 语言开关（2026-10-25 P2，设置页「语言」三个按钮写这里）
 *   follow = 跟着主人走（默认；人设里那条"他说什么语言她就用什么语言"）
 *   zh     = 这一阵只说中文
 *   en     = 这一阵只说英文
 * 文件：`<数据目录>\_study-core\她的语言.json`（她自己的状态，不是主人的规矩文件）
 */
const LANG_FILE = join(DATA, '她的语言.json')

function readLangMode() {
  try {
    if (!existsSync(LANG_FILE)) return 'follow'
    const j = JSON.parse(readFileSync(LANG_FILE, 'utf8'))
    const m = String((j && j.mode) || '').toLowerCase()
    return m === 'zh' || m === 'en' ? m : 'follow'
  } catch {
    return 'follow'
  }
}

// 【发行版】个人化的角色设定（那一整套亲密互动机制）已移除，不随包发布

function buildSystemPrompt() {
  // 2026-10-24：**人设单独一个文件**（主人定的 c 方案）
  //   `她的人设.txt` = 她是谁 / 怎么说话 / 底线；规矩、记忆、限制各归各的文件，互不覆盖。
  //   旧的"刀魂·隙"设定在 性格.txt，只有旧浮窗在读；这里读人设 → 规矩 → 记忆。
  //   读的时候把 `#` 注释行剥掉（那些是给主人看的说明，不该占她的 token）。
  // 2026-10-24：**上限按"剥掉注释后的正文"算**（原来按原文算 —— 注释一多，正文就被截掉尾巴）。
  const persona = stripHashComments(readText(join(ROOT, 'mystery', 'DSH', '她的人设.txt'))).slice(0, 6000)
  const rules = readText(join(ROOT, 'mystery', 'DSH', '她的规矩.txt'), 12000)
  const memory = readText(join(ROOT, 'mystery', 'DSH', '她的记忆.md'), 6000)
  const brief = todayBrief()
  // 2026-10-22（影子模式）：`她的规矩-建议.txt` 是"还没转正"的新规矩 —— 按它说话/判断，
  //   但**涉及动作的**（建待办、改文件、删东西）先只说不动，等主人点头转正。
  const shadow = readText(join(ROOT, 'mystery', 'DSH', '她的规矩-建议.txt'), 2500)
  // 2026-10-25：工作指南（工作口径/边界）单独一份，跟人设/记忆/规矩并列
  const workguide = stripHashComments(readText(join(ROOT, 'mystery', 'DSH', '她的工作指南.txt'))).slice(0, 3500)
  const parts = []
  parts.push(`现在的本地时间是：${nowStamp()}。`)
  // 2026-10-25 P2：语言开关（设置页三个按钮 → _study-core\她的语言.json）。
  //   默认 follow = 跟主人走（人设里就是这么写的）；zh / en 是"这一阵只说一种"。
  {
    const lang = readLangMode()
    if (lang === 'zh') {
      parts.push(
        '【语言硬规则（这一轮）】**这一轮只用中文回答**。这是主人在设置页点下的开关，' +
          '和"他说什么语言你用什么语言"不冲突 —— 这一轮就是中文。只有科目名/题目原文/术语可以保留英文原词。',
      )
    } else if (lang === 'en') {
      parts.push(
        '【语言硬规则（这一轮）】**Reply only in English this turn.** This is a switch the owner turned on; ' +
          'it overrides "match his language" for now. Chinese is allowed only for names/quotes that are originally Chinese.',
      )
    }
  }
  //   开关这一轮：两个版本都只在**开头**说一句，正文照样短。
  parts.push('【回复风格】短、口语化；一次 1~4 条，每条单独一行，每条不超过 20 字。')
  parts.push(
    '你是主人的桌面学习助手，在主人的 Windows 电脑上跟他聊天。**你是谁、怎么说话，以【她的人设】为准**' +
      '（那里写了她的身份和称呼）；像聊天一样：短、口语化、有情绪；不要写长篇 Markdown 列表；' +
      '不确定就问他一句；**不要用"作为一个 AI 模型/语言模型"那种腔调**（她可以坦然承认自己是 AI，但不把它当免责声明用）；不要编造事实。' +
      // 2026-10-25 主人：「改成类似微信——一次发好几条、她也回好几条，而不是一大段」
      '\n【像微信一样回话（硬规则）】**一次回 1~4 条**，每条**单独一行**（换行 = 分割成一条独立消息），' +
      '每条**不超过 20 个字**；标点能省就省，别写长段落、别写 Markdown 列表、别在一条里塞三件事。' +
      '要讲方法就拆开：第一条给结论，后面几条补"为什么/怎么做"。',
  )
  // 2026-10-22：**她会画** —— 讲清楚一个题时可以在回答里放一个 ```board 代码块，
  //   浮窗会把那段交给白板窗口画出来（文字照常说，别只丢个图）。
  parts.push(
    [
      '【画图（可选）】需要讲清楚一道题、一个位置关系、一条思路时，可以在回答**最后**附一个 ```board 代码块：',
      '内容必须是一个 JSON：{"strokes":[...]}（或者直接一个数组）。每笔是下面之一：',
      '  {"tool":"line","color":"red","x1":60,"y1":260,"x2":460,"y2":360}',
      '  {"tool":"ellipse","color":"blue","x1":520,"y1":220,"x2":760,"y2":400}',
      '  {"tool":"text","color":"black","x":80,"y":440,"text":"这里用动能定理"}',
      '  {"tool":"pen","color":"black","width":3,"points":[[10,10],[20,30],[30,25]]}',
      `画布是 860×560（左上角 0,0）；颜色可以用 black/red/blue；最多 8 笔，别画太密。正文里先用文字讲清楚，图只是辅助。`,
    ].join('\n'),
  )
  if (persona.length > 0) parts.push(`\n【她的人设（她是谁 / 怎么说话 / 底线；这里的"她是谁"优先于别处）】\n${persona}`)
  if (rules.length > 0) parts.push(`\n【她的规矩（主人手写，必须遵守）】\n${rules}`)
  // 2026-10-25（主人拍板）：工作上的口径与边界单独一页（不是人设/记忆/规矩），也进提示词。
  //   里面**故意不写**"收件箱 # 开头 = 作业"这类脚本已经在做的判断，免得她和脚本抢。
  if (workguide.length > 0) {
    parts.push(
      `\n【她的工作指南（工作上的判断口径与边界；标记类的判断交给脚本，判不准的先问他）】\n${workguide}`,
    )
  }
  if (memory.length > 0) parts.push(`\n【她的记忆】\n${memory}`)
  if (shadow.length > 0) {
    parts.push(
      `\n【建议中的新规矩（影子模式，还没转正）】\n${shadow}\n` +
        '（这些是从经验本里提炼出来的。照着说话/判断；但凡是"动手"的——建待办、改主人文件、删东西——先只说不动，等主人确认。）',
    )
  }
  if (brief.length > 0) {
    parts.push(
      `\n【今天的情况（自动生成，里面是主人今天的课/要带的/要交的/迟了的；回答"今天…"的问题先看这里）】\n${brief}`,
    )
  }
  // 2026-10-25（P2）：把她自己那两个"后台开关"的**生效值**也告诉她。
  //   这两份是主人手写的边界（presence.ps1 = 能不能看你屏幕；initiative.ps1 = 她能不能自己找你说话），
  //   以前她完全不知道里面写了什么，被问"你一天能主动找我几次"只能瞎编。
  //   做法：**只取 key = value 的生效值**（注释里那一大段解释不进提示词，省 token、也不乱她的语感）。
  const autonomy = autonomyLimitsBlock()
  if (autonomy.length > 0) parts.push(`\n【她自己那两个开关的生效值（主人手写，程序真在读；照这个答，别自己编数字）】\n${autonomy}`)
  // 2026-10-25 第 9 项：「她自己判断该记什么」。
  //   `她的经验本.txt` 以前只有被要求才写（主人说"记一条经验"）。现在给她一条**自主判断**的口径：
  //   什么时候该写、什么时候别写，以及"写完要跟主人说一句"（这样他能看见、能纠正）。
  //   落盘由主进程扫 `经验：…` 那一行完成（重复的会被指纹挡掉）。
  parts.push(
    '\n【你自己判断要不要记经验（别等人吩咐）】\n' +
      '· **该记**：主人纠正了你（"不对，应该是…"）／他明说过偏好（"我晚上写作业，别早上叫我"）／' +
      '你踩了一次坑还找到了原因。→ 在回复里**单独一行**写：`经验：<一句话结论>`（不超过 40 字，写"下次该怎么做"）。\n' +
      '· **不该记**：一次性的信息（今天几点睡）、他随口问的知识点、你已经记过的同一件事。\n' +
      '· 记了就在同一句里顺口说一声「我记下来了」，别长篇解释；没记就不用提。\n' +
      '· 一轮最多记一条。',
  )
  //   主人明确要求：性格/习惯/癖好一个字都不能丢 —— 但正文里那些条被"短、口语"的指令盖掉了，
  //   所以这里只留一行提纲，把"每句都要有的东西"钉在末尾。
  // 【发行版】个人化的"签名习惯"整段已移除
  return parts.join('\n')
}

/**
 * 她自己的两个"后台开关"的生效值（2026-10-25 P2）
 *   · 她的限制-看一眼.txt → presence.ps1 读：她能不能看主人屏幕 / 看什么 / 看哪些窗口
 *   · 她的限制-闲聊.txt   → initiative.ps1 读：她一天能主动找主人几次 / 隔多久 / 什么时候闭嘴
 * 只取 `key = value` 那几行（注释里的大段解释留在文件里，不进提示词）。
 * 读完拼一小段；两份都不存在就返回空串（提示词一个字都不多）。
 */
function autonomyLimitsBlock() {
  const pick = (file, keys, label) => {
    let text = ''
    try {
      text = readText(file)
    } catch {
      return ''
    }
    if (!text) return ''
    const got = []
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const m = /^([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(t)
      if (!m) continue
      const key = m[1]
      if (!keys.includes(key)) continue
      let value = m[2].trim()
      if (value.length > 80) value = value.slice(0, 80) + '…'
      got.push(`${key}=${value}`)
    }
    return got.length > 0 ? `· ${label}：${got.join('；')}` : ''
  }
  const lines = [
    pick(join(ROOT, 'mystery', 'DSH', '她的限制-看一眼.txt'), ['allow_presence', 'look_at', 'watch_titles'], '能不能看你屏幕（allow_presence=off 就是完全不看）'),
    pick(
      join(ROOT, 'mystery', 'DSH', '她的限制-闲聊.txt'),
      ['allow_initiative', 'daily_max', 'min_gap_minutes', 'quiet_hours', 'only_when_active'],
      '你自己找主人说话（daily_max = 一天最多几次）',
    ),
  ].filter((x) => x.length > 0)
  return lines.join('\n')
}

function loadHistory() {  if (!existsSync(SESSION_FILE)) return []
  try {
    const lines = readFileSync(SESSION_FILE, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    const items = []
    let chars = 0
    for (let i = lines.length - 1; i >= 0 && items.length < HISTORY_MAX_ITEMS; i -= 1) {
      try {
        const rec = JSON.parse(lines[i])
        if (typeof rec.content !== 'string' || (rec.role !== 'user' && rec.role !== 'assistant')) continue
        if (chars + rec.content.length > HISTORY_MAX_CHARS) break
        items.unshift({ role: rec.role, content: rec.content })
        chars += rec.content.length
      } catch {
        /* 坏行跳过 */
      }
    }
    return items
  } catch {
    return []
  }
}

function appendSession(role, content) {
  try {
    mkdirSync(DATA, { recursive: true })
    appendFileSync(SESSION_FILE, `${JSON.stringify({ at: new Date().toISOString(), role, content })}\n`, 'utf8')
  } catch (e) {
    emit({ t: 'error', message: `会话文件写不进去：${e instanceof Error ? e.message : String(e)}` })
  }
}

function readKey() {
  if (!existsSync(KEYFILE)) throw new Error(`找不到 key 文件：${KEYFILE}（应该是一行 sk-...）`)
  const key = readFileSync(KEYFILE, 'utf8').trim().split(/\r?\n/)[0].trim()
  if (key.length < 10) throw new Error(`key 文件看起来是空的：${KEYFILE}`)
  return key
}

/** 方括号剥除的规则在 info\brackets.mjs（brain 和主进程共用同一套；也能单独测） */

/** 假流（自检用）：不联网，按字吐一句固定回复。
 *  2026-10-25（P0-2）：问句里带「画图」/ board 时，假回复里**真的附一块 ```board**，
 *  这样自检能一路验到"画布出现、笔画数对得上"（走的是和真 API 完全一样的两把扫把）。 */
async function mockAsk(text) {
  const wantsBoard = /画图|画个图|draw|board/i.test(text)
  const board = wantsBoard
    ? '\n```board\n' +
      JSON.stringify({
        strokes: [
          { tool: 'line', color: 'red', x1: 60, y1: 260, x2: 460, y2: 360 },
          { tool: 'text', color: 'black', x: 80, y: 440, text: '自检的图' },
        ],
      }) +
      '\n```'
    : ''
  // 2026-10-25 M1 自检用：问句里带「三条」→ 假回复分三行（验「真的一行一个气泡」）
  const wantsThree = /三条|三句/.test(text)
  const reply = wantsThree
    ? `收到：「${text.slice(0, 16)}」\n这是第二句，验分框。\n这是第三句，三行就该三个气泡。` + board
    : `收到：「${text.slice(0, 20)}」。这是自检用的假回复，说明流式通道是通的。` + board
  emit({ t: 'start', mock: true })
  const bb = makeBoardBroom()
  const kb = makeBracketBroom()
  for (const ch of reply) {
    const clean = kb.feed(bb.feed(ch))
    if (clean) emit({ t: 'delta', d: clean })
    await new Promise((r) => setTimeout(r, 12))
  }
  const tail = kb.feed(bb.flush()) + kb.flush()
  if (tail) emit({ t: 'delta', d: tail })
  const noBoard = splitBoardBlocks(reply)
  emit({
    t: 'done',
    reply: stripBracketControls(noBoard.text).text,
    controls: kb.controls,
    board: bb.board || noBoard.board,
    ms: 0,
    mock: true,
  })
}

async function realAsk(text) {
  const key = readKey()
  petEvent({ t: 'user', text })
  petEvent({ t: 'turn-start', turn: Date.now() })
  // 先翻一遍她手边的资料（课件库）。命中了就把片段附在问题前面，并要求她标来源。
  const mat = materialsContext(text)
  let userContent = mat
    ? `【她手边的资料（本机课件库检索到的，可能相关也可能不相关）】\n${mat.text}\n\n` +
      `（上面这些如果对回答有用，就在句子里顺口提一句出自哪份/第几页；不相关就当没看见，别硬扯。）\n\n` +
      `【主人说的话】\n${text}`
    : text
  // 2026-10-25 P2：语言开关压在**用户这一侧**（实测：只写在 system 里，她会顺着人设继续说中文；
  //   在"主人说的话"前面再钉一句，两处一起压才真听话）
  {
    const lang = readLangMode()
    if (lang === 'zh') userContent = `（这一轮请**只用中文**回答。）\n\n${userContent}`
    else if (lang === 'en') userContent = `(= Reply **only in English** this turn. =)\n\n${userContent}`
  }
  if (mat) {
    emit({ t: 'materials', hits: mat.hits.map((h) => ({ source: String(h.source || '').split(/[\\/]/).pop(), page: h.page, score: h.score })), expanded: !!mat.expandedWords })
    petEvent({ t: 'materials', count: mat.hits.length })
  }
    const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...loadHistory(),
    { role: 'user', content: userContent },
  ]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const t0 = Date.now()
  let reply = ''
  let usage = null
  const broom = makeBracketBroom()
  // ```board 画图块也是"给模型/界面看、不给正文看"：先过画图扫把，再过方括号扫把
  const boardBroom = makeBoardBroom()
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, stream: true, max_tokens: MAX_TOKENS }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`API ${res.status}：${body.slice(0, 300)}`)
    }
    emit({ t: 'start' })
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let parsed
        try {
          parsed = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = parsed?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta.length > 0) {
          reply += delta
          // 方括号里的控制标记不往正文里吐（见 makeBracketBroom 的说明）
          // ```board 画图块同理：整块抠出来交给界面画，正文里一个字都不留（2026-10-25 P0-2）
          const clean = broom.feed(boardBroom.feed(delta))
          if (clean) emit({ t: 'delta', d: clean })
        }
        if (parsed?.usage) usage = parsed.usage
      }
    }
    appendSession('user', text)
    // 会话文件里不存画图块（那块 JSON 对她下次说话没用，还会把上下文撑爆）
    appendSession('assistant', splitBoardBlocks(reply).text)
    // 收尾：把还攒着的那点正文吐完，再报 done（带上这一轮的控制指令 + 画图）
    const tail = broom.feed(boardBroom.flush()) + broom.flush()
    if (tail) emit({ t: 'delta', d: tail })
    const noBoard = splitBoardBlocks(reply)
    const cleaned = stripBracketControls(noBoard.text)
    emit({
      t: 'done',
      reply: cleaned.text,
      controls: broom.controls,
      board: boardBroom.board || noBoard.board,
      ms: Date.now() - t0,
      usage,
    })
    // 桌宠：说一句话 + 收工（顺便按内容给个情绪）
    petEvent({ t: 'assistant', text: cleaned.text })
    petEvent({ t: 'control', mood: moodOf(cleaned.text), say: cleaned.text.slice(0, 120), bubbleMs: 7000 })
    petEvent({ t: 'turn-end', ok: true })
  } finally {
    clearTimeout(timer)
  }
}

async function probe() {
  const key = readKey()
  const t0 = Date.now()
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: '只回两个字：收到' }], max_tokens: 8 }),
  })
  const body = await res.text()
  emit({ status: res.status, ms: Date.now() - t0, body: body.slice(0, 200) })
}

async function main() {
  if (has('probe')) {
    await probe()
    return
  }
  if (has('materials')) {
    // 排查"检索这条链路"用：认出哪几门课、扫了多少块、多久、命中哪些（不联网、不调模型）
    const q = opt('materials', '') || opt('ask', '')
    const subjects = detectSubjects(q)
    const t0 = Date.now()
    const expanded = expandMaterialsQuery(q)
    const j = runMaterialsQuery(expanded, MATERIALS_K, subjects)
    const ms = Date.now() - t0
    emit({
      ok: !!(j && j.ok),
      question: q,
      subjects,
      filtered: subjects.length > 0,
      ms,
      scanned: j ? j.scanned : null,
      total: j ? j.total : null,
      hits: j && Array.isArray(j.hits)
        ? j.hits.map((h) => ({ source: String(h.source || '').split(/[\\/]/).slice(-2).join('/'), page: h.page ?? null, score: h.score }))
        : [],
    })
    return
  }
  if (has('show-prompt')) {
    // 排查"她到底拿到什么上下文"用：打印 system 提示词（不联网、不打印 key）
    emit({ ok: true, prompt: buildSystemPrompt() })
    return
  }
  if (has('show-session')) {
    const items = loadHistory()
    emit({ sessionFile: SESSION_FILE, loaded: items.length, sample: items.slice(-2) })
    return
  }
  let text = opt('ask', '')
  const askFile = opt('ask-file', '')
  if (askFile.length > 0) {
    try {
      text = readFileSync(askFile, 'utf8')
    } catch (e) {
      emit({ t: 'error', message: `读不到 --ask-file：${e instanceof Error ? e.message : String(e)}` })
      process.exitCode = 2
      return
    }
  }
  if (text.trim().length === 0) {
    emit({ t: 'error', message: '用法：--ask "<一句话>"' })
    process.exitCode = 2
    return
  }
  try {
    if (MOCK) await mockAsk(text)
    else await realAsk(text)
  } catch (e) {
    emit({ t: 'error', message: e instanceof Error ? e.message : String(e) })
    process.exitCode = 3
  }
}

await main()
