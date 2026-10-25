/**
 * apps\desktop\main\chat.mjs —— 对话：起她的大脑（info\brain.mjs）、流式、主题、方括号控制
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 整段搬出来（逻辑原样）。
 * 这里管四件：
 *   ① 历史 / 主题（每个主题一个会话文件，切主题不串）
 *   ② startTurn：起 brain.mjs --ask-file，把它的 NDJSON 逐条转给页面 + 边生成边念
 *   ③ 方括号控制（[动作：…] → petControl；表情 10 分钟自动收回，分钟数读 她的规矩.txt）
 *   ④ 读她的规矩里那些数字的小工具 readRuleNumber
 * ⚠️ act() 名字和 her:* 通道都在 main.mjs 里，这里不改。
 */

import { readdirSync } from 'node:fs'

export function createChat (deps) {
  const { readdirSync, log, MOCK, SELFTEST, DATA_ROOT, OUT, existsSync, readFileSync, writeFileSync, mkdirSync, join, basename, dirname, spawn, petControl, BRAIN, CHAT_IN_FILE, SESSION_FILE, readJson, writeJson, maybeLearnFromReply, maybeRememberFromReply, makeSpeaker } = deps
// ── 对话：起她的大脑（brain.mjs）并把流式吐给页面 ─────────────────────────────
const MOCK_HISTORY = {
  ok: true,
  mock: true,
  items: [
    { role: 'user', text: '（假数据）今天有什么要交的？' },
    { role: 'assistant', text: '（假数据）今天只有一条：生物实验报告第 3 章，22:00 之前。' },
  ],
}

function loadChatHistory(limit = 40, topicArg) {
  // 自检 / 假数据：主线还是给那几条假历史；非主线主题给空（这样"两个主题不串"才验得出来）
  const topic = safeTopic(topicArg || readCurrentTopic())
  if (MOCK && topic === DEFAULT_TOPIC) return MOCK_HISTORY
  try {
    const file = topicSessionFile(topic)
    if (!existsSync(file)) return { ok: true, topic, items: [] }
    const items = []
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const r = JSON.parse(line)
        if ((r.role === 'user' || r.role === 'assistant') && typeof r.content === 'string') {
          items.push({ role: r.role, text: r.content, at: r.at || null })
        }
      } catch {}
    }
    return { ok: true, topic, file, items: items.slice(-limit) }
  } catch (err) {
    return { ok: false, topic, items: [], error: String((err && err.message) || err) }
  }
}

// ── 对话：按主题分上下文（2026-10-24 晚，第 12 条）───────────────────────────
/**
 * 主人第 12 条：「对话按主题分上下文」。
 * 做法：一个主题一个会话文件 `_study-core\brain-session-<主题>.jsonl`；
 *   默认主题叫「主线」，**沿用老的 `brain-session.jsonl`**（不然他 6.6KB 的老会话就断了）。
 * 同主题共享历史；跨主题只共享长期记忆（规矩/记忆/人设那几份 —— 那些本来就每轮都读）。
 * 当前主题记在 `out\her-chat-topic.json`；自检写 `out\her-chat-topic.mock.json` + `*.mock.jsonl`。
 */
const CHAT_TOPIC_FILE = join(OUT, 'her-chat-topic.json')
const DEFAULT_TOPIC = '主线'
function chatTopicFile() {
  return SELFTEST || MOCK ? join(OUT, 'her-chat-topic.mock.json') : CHAT_TOPIC_FILE
}
function safeTopic(name) {
  const t = String(name || '').trim().replace(/[\\/:*?"<>|\r\n\t]/g, '').slice(0, 24)
  return t || DEFAULT_TOPIC
}
/** 主题 → 会话文件（「主线」= 老的 brain-session.jsonl） */
function topicSessionFile(topic) {
  const t = safeTopic(topic)
  const mock = SELFTEST || MOCK
  if (t === DEFAULT_TOPIC) return mock ? join(OUT, 'brain-session.mock.jsonl') : SESSION_FILE
  return mock ? join(OUT, `brain-session-${t}.mock.jsonl`) : `${DATA_ROOT}/_study-core/brain-session-${t}.jsonl`
}
function readCurrentTopic() {
  const j = readJson(chatTopicFile())
  return safeTopic((j && j.topic) || DEFAULT_TOPIC)
}
function setCurrentTopic(name) {
  const t = safeTopic(name)
  try {
    writeJson(chatTopicFile(), { topic: t, at: new Date().toISOString() })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  return { ok: true, topic: t }
}
/** 有哪些主题（扫会话文件；默认主题永远在） */
function listChatTopics() {
  const names = new Set([DEFAULT_TOPIC])
  const prefix = 'brain-session-'
  const scan = () => {
    try {
      const dir = SELFTEST || MOCK ? OUT : `${DATA_ROOT}/_study-core`
      for (const f of readdirSync(dir)) {
        if (!f.startsWith(prefix) || !f.endsWith('.jsonl')) continue
        const base = f.slice(prefix.length, -'.jsonl'.length).replace(/\.mock$/, '')
        if (base) names.add(base)
      }
    } catch {}
  }
  scan()
  const items = Array.from(names).map((name) => {
    const file = topicSessionFile(name)
    let lines = 0
    try {
      if (existsSync(file)) lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length
    } catch {}
    return { name, file, lines, current: false }
  })
  const cur = readCurrentTopic()
  const out = items.map((it) => ({ ...it, current: it.name === cur }))
  // 当前主题排最前，其余按条数降序
  out.sort((a, b) => Number(b.current) - Number(a.current) || b.lines - a.lines || a.name.localeCompare(b.name))
  return { ok: true, current: cur, topics: out, mock: SELFTEST || MOCK }
}

/**
 * 把 `[动作：吹泡泡]` / `[表情：脸红]` / `[造型：马尾]` 真的作用到模型上（2026-10-25）
 * 规则在 info\brackets.mjs：方括号是控制、小括号只是给人看的旁白。
 * 认得的值才用（动作/表情原样给 pet.js；造型/道具先过 deps.LOOK_GROUPS 白名单，认不出就忽略并记日志）。
 */
/** 她的规矩.txt 里的一个小整数（表情停留分钟之类）；读不到就给默认值 */
function readRuleNumber(key, dft, lo, hi) {
  try {
    const file = join(DATA_ROOT, 'mystery', 'DSH', '她的规矩.txt')
    if (!existsSync(file)) return dft
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const m = new RegExp('^' + key + '\\s*=\\s*(-?\\d+)').exec(t)
      if (m) {
        const n = Number(m[1])
        if (Number.isFinite(n)) return Math.min(Math.max(n, lo), hi)
      }
    }
  } catch {}
  return dft
}

/** 表情最多挂多少分钟，到点收回默认脸（2026-10-25 接上；0 = 永不自动收） */
let expressionResetTimer = null
function scheduleExpressionReset() {
  const minutes = readRuleNumber('表情停留分钟', 10, 0, 600)
  clearTimeout(expressionResetTimer)
  if (minutes <= 0) return
  expressionResetTimer = setTimeout(() => {
    try {
      petControl({ expression: '正常' })
      log(`表情挂了 ${minutes} 分钟，收回来（她的规矩.txt 的 表情停留分钟）`)
    } catch {}
  }, minutes * 60000)
}

function applyBracketControls(controls) {
  const props = {}
  let motion = ''
  let expression = ''
  for (const c of controls || []) {
    const kind = String((c && c.kind) || '')
    const value = String((c && c.value) || '').trim()
    if (!value) continue
    if (kind === '动作' || kind === 'motion') motion = value
    else if (kind === '表情' || kind === 'expression') expression = value
    else if (kind === '造型' || kind === '道具' || kind === 'props') {
      let hit = ''
      for (const g of deps.LOOK_GROUPS) {
        const item = g.items.find((i) => i.key === value || i.label === value || (i.key && value.includes(i.key)))
        if (item && item.key) {
          hit = item.key
          break
        }
      }
      if (hit) props[hit] = true
      else log('（控制）认不出的造型/道具：' + value + '（忽略）')
    }
  }
  const payload = {}
  if (motion) payload.motion = motion
  if (expression) payload.expression = expression
  if (Object.keys(props).length > 0) payload.props = props
  if (Object.keys(payload).length === 0) return { ok: false, skipped: 'nothing' }
  log('（控制）' + JSON.stringify(payload))
  // 表情换上去以后到点收回（她的规矩.txt 的 表情停留分钟，默认 10；0 = 永远挂着）
  if (payload.expression) scheduleExpressionReset()
  return petControl(payload)
}

let chatChild = null

/** 发一句给她：起 brain.mjs（--ask-file），把它的 NDJSON 逐条转给页面。 */
function startTurn(text) {
  const say = String(text || '').trim()
  if (!say) return { ok: false, error: '空的' }
  if (!existsSync(BRAIN)) return { ok: false, error: '找不到 info\\brain.mjs' }
  if (chatChild) {
    try {
      chatChild.kill()
    } catch {}
    chatChild = null
  }
  try {
    writeFileSync(CHAT_IN_FILE, say, 'utf8')
  } catch (err) {
    return { ok: false, error: '写不进 out\\her-chat-in.txt：' + ((err && err.message) || err) }
  }
  const args = [BRAIN, '--ask-file', CHAT_IN_FILE]
  // 会话文件按"当前主题"给（第 12 条）；主题变了以后新的一轮就进另一个文件
  const topic = readCurrentTopic()
  try {
    const sessionFile = topicSessionFile(topic)
    mkdirSync(dirname(sessionFile), { recursive: true })
    args.push('--session', sessionFile)
    log(`发给她（主题「${topic}」→ ${basename(sessionFile)}）：${say.slice(0, 30)}${say.length > 30 ? '…' : ''}`)
  } catch {}
  if (MOCK) args.push('--mock')
  let child = null
  try {
    child = spawn(process.execPath, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    return { ok: false, error: '起 brain 失败：' + ((err && err.message) || err) }
  }
  chatChild = child
  const send = (payload) => {
    // 对话页在**浮窗**里（2026-10-23 分窗后），所以流式事件发给浮窗；浮窗不在就发形象窗（不至于丢）
    try {
      const target = deps.panelWin && !deps.panelWin.isDestroyed() ? deps.panelWin : deps.win
      if (target && !target.isDestroyed()) target.webContents.send('her:chat', payload)
    } catch {}
  }
  let buf = ''
  const speaker = makeSpeaker()
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        let obj = null
        try {
          obj = JSON.parse(line)
        } catch {}
        if (obj) {
          send(obj)
          // 边生成边念：delta 攒到句子就合成
          if (obj.t === 'delta') speaker.push(obj.d)
          if (obj.t === 'done' || obj.t === 'error') speaker.flush()
          // 她在回答里写了「经验：…」→ 自动记进经验本（她的成长回路 ①）
          if (obj.t === 'done' && obj.reply) maybeLearnFromReply(obj.reply)
          if (obj.t === 'done' && obj.reply) maybeRememberFromReply(obj.reply)
          // 方括号里那几条控制指令（2026-10-25 主人定的口径）：真戴到她身上
          if (obj.t === 'done' && Array.isArray(obj.controls) && obj.controls.length > 0) applyBracketControls(obj.controls)
        } else {
          send({ t: 'raw', text: line })
        }
      }
      nl = buf.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim()
    if (text) {
      log('brain stderr：' + text.slice(0, 300))
      send({ t: 'stderr', text: text.slice(0, 500) })
    }
  })
  child.on('close', (code) => {
    if (chatChild === child) chatChild = null
    try {
      speaker.flush()
    } catch {}
    send({ t: 'exit', code })
    log(`一轮对话结束（brain exit=${code}）`)
  })
  log('发给她：' + say.slice(0, 40) + (say.length > 40 ? '…' : ''))
  return { ok: true }
}

  return {
    MOCK_HISTORY,
    /**
     * 收工/关窗时把她那一轮的子进程收掉。
     * 2026-10-25 补：拆模块时 main.mjs 里那两处 `chatChild` 变成了裸引用，
     * 外面套着 try/catch → 悄悄吞掉，等于退出时这一句一直没生效（真 bug，不是空话）。
     */
    killTurn() {
      if (chatChild) {
        try {
          chatChild.kill()
        } catch {}
        chatChild = null
      }
    },
    CHAT_TOPIC_FILE,
    DEFAULT_TOPIC,
    chatTopicFile,
    safeTopic,
    topicSessionFile,
    readCurrentTopic,
    setCurrentTopic,
    listChatTopics,
    readRuleNumber,
    scheduleExpressionReset,
    applyBracketControls,
    startTurn,
    loadChatHistory,
  }
}
