/**
 * apps\desktop\main\remind.mjs —— 提醒这一整套
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 整段搬出来（逻辑原样，一个判断都没改）。
 * 四块都在这一个文件里：
 *   ① DDL 前主动提醒：定时器 + 桌面通知 + 去重台账 + 规则可配（mystery\DSH\她的限制-提醒.txt）
 *   ② 提醒队列：「知道了 / 稍后 10 分钟」那条提醒条
 *   ③ 每日提醒（_study-core\提醒清单.json）
 *   ④ 每周计划（每周计划.json） + 学科学习计划（学科计划.json）
 *
 * 依赖从 main.mjs 传进来（createRemind(deps)）：log / MOCK / SELFTEST / DATA_ROOT / OUT /
 * readJson / writeJson / petControl / speakBubble / speak / loadTasks / loadAgenda / todayKey，
 * 外加 win（活引用，getter）。fs / path / electron 的 Notification 这个文件自己 import。
 *
 * ⚠️ act() 名字和 her:* 通道都在 main.mjs 里，这里一个字没动。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Notification } from 'electron'

export function createRemind (deps) {
  const { log, MOCK, SELFTEST, DATA_ROOT, OUT, readJson, writeJson, petControl, speakBubble, speak, loadTasks, loadAgenda, todayKey } = deps

// ── DDL 前主动提醒（主人第 8 条：定时器 + 通知 + 去重台账 + 规则可配）─────────────
/**
 * 要什么（主人的原话）：定时器 + Electron 通知 + 去重台账 + 规则可配"提前多久 / 上课不弹"。
 * 怎么做的：
 *   · 规则文件 `她的限制-提醒.txt`（跟别的"她的限制-*"同一套 key = value；可编辑、可回滚）
 *   · 每 remind_check_seconds 秒查一次"今天有 DDL、还没做完"的待办：
 *       还差 lead 分钟以内 → 提醒一次；到点（±5 分钟内）→ 再提醒一次
 *       在上课（课表里此刻有课）→ **不弹**，只记日志，等下一轮
 *   · 台账 `out\her-remind-ledger.json`：同一条待办的"提前/到点"各只提醒一次，永不重复；
 *     只留最近 30 天（不然越攒越大）
 *   · 提醒方式：系统通知 + 她头上气泡 + （可选）她念出来
 */
const REMIND_RULES_FILE = `${DATA_ROOT}/mystery/DSH/她的限制-提醒.txt`
const REMIND_LEDGER_FILE = join(OUT, 'her-remind-ledger.json')
/** 自检 / 假数据时用 out\ 里的那份，绝不碰主人的规则文件和真台账 */
function remindRulesPath() {
  return SELFTEST || MOCK ? join(OUT, '她的限制-提醒.mock.txt') : REMIND_RULES_FILE
}
function remindLedgerPath() {
  return SELFTEST || MOCK ? join(OUT, 'her-remind-ledger.mock.json') : REMIND_LEDGER_FILE
}
const REMIND_KEYS = [
  'remind_on',
  'remind_lead_minutes',
  'remind_at_due',
  'remind_quiet_in_class',
  'remind_check_seconds',
  'remind_speak',
  'remind_snooze_minutes',
  'summary_on',
  'summary_at',
]
const REMIND_DEFAULTS = {
  remind_on: 'on',
  remind_lead_minutes: '60',
  remind_at_due: 'on',
  remind_quiet_in_class: 'on',
  remind_check_seconds: '60',
  remind_speak: 'on',
  remind_snooze_minutes: '10',
  summary_on: 'on',
  summary_at: '21:30',
}
const REMIND_HINT = {
  remind_on: 'on / off —— 总开关：要不要主动提醒',
  remind_lead_minutes: '提前多少分钟提醒（1~600，例如 60）',
  remind_at_due: 'on / off —— 到截止那一刻再提醒一次',
  remind_quiet_in_class: 'on / off —— 上课时间不弹通知（她安静，等你下课）',
  remind_check_seconds: '多久查一次（秒，15~3600）',
  remind_speak: 'on / off —— 提醒的时候她也念出来（要 allow_speak 开着）',
  remind_snooze_minutes: '提醒时点「稍后」推迟多少分钟（0~1440，默认 10）',
  summary_on: 'on / off —— 每天到点让她写当天的学习总结',
  summary_at: '几点让她写总结（HH:MM，默认 21:30）',
}

function renderRemindRules(vals) {
  const lines = [
    '# 她的限制-提醒.txt —— 主动提醒的规矩（2026-10-24 建）',
    '# 格式：一行一条  key = value。改完存盘就生效（她每 remind_check_seconds 秒看一次）。',
    '# 想整套关掉：remind_on = off',
    '',
  ]
  for (const k of REMIND_KEYS) {
    lines.push(`# ${REMIND_HINT[k]}`)
    lines.push(`${k} = ${vals[k]}`)
    lines.push('')
  }
  return lines.join('\r\n')
}

/** 没有就按默认建一份（主人可以照着改；这是**新文件**，不动他已有的任何规矩文件） */
function ensureRemindRules() {
  try {
    if (existsSync(remindRulesPath())) return false
    mkdirSync(dirname(remindRulesPath()), { recursive: true })
    writeFileSync(remindRulesPath(), renderRemindRules(REMIND_DEFAULTS), 'utf8')
    log('建了提醒规则文件：' + remindRulesPath())
    return true
  } catch (err) {
    log('建提醒规则文件失败：' + ((err && err.message) || err))
    return false
  }
}

function remindClamp(v, lo, hi, dft) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dft
  return Math.min(Math.max(Math.round(n), lo), hi)
}

/** 读规则（坏值一律退回默认，不让一条写错就把提醒弄死） */
function readRemindRules() {
  const raw = Object.assign({}, REMIND_DEFAULTS)
  try {
    for (const line of readFileSync(remindRulesPath(), 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const m = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(t)
      if (!m) continue
      const k = m[1].toLowerCase()
      if (REMIND_KEYS.includes(k)) raw[k] = m[2].trim()
    }
  } catch {}
  return {
    on: String(raw.remind_on).toLowerCase() !== 'off',
    lead: remindClamp(raw.remind_lead_minutes, 1, 600, 60),
    atDue: String(raw.remind_at_due).toLowerCase() !== 'off',
    quietInClass: String(raw.remind_quiet_in_class).toLowerCase() !== 'off',
    everySec: remindClamp(raw.remind_check_seconds, 15, 3600, 60),
    speak: String(raw.remind_speak).toLowerCase() !== 'off',
    snoozeMin: remindClamp(raw.remind_snooze_minutes, 0, 1440, 10),
    summaryOn: String(raw.summary_on).toLowerCase() !== 'off',
    summaryAt: /^\d{1,2}:\d{2}$/.test(String(raw.summary_at)) ? String(raw.summary_at).padStart(5, '0') : '21:30',
    raw,
  }
}

/** 改一条规则（存快照再写，跟 settings-lite 一个口径） */
function setRemindRule(key, value) {
  const k = String(key || '').toLowerCase()
  if (!REMIND_KEYS.includes(k)) return { ok: false, error: '不认识的键：' + key + '（只认 ' + REMIND_KEYS.join(' / ') + '）' }
  let v = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  if (k === 'remind_on' || k === 'remind_at_due' || k === 'remind_quiet_in_class' || k === 'remind_speak') {
    if (!['on', 'off'].includes(v)) return { ok: false, error: k + ' 只认 on / off' }
  } else if (k === 'remind_lead_minutes') {
    v = String(remindClamp(v, 1, 600, 60))
  } else if (k === 'remind_check_seconds') {
    v = String(remindClamp(v, 15, 3600, 60))
  } else if (k === 'remind_snooze_minutes') {
    v = String(remindClamp(v, 0, 1440, 10))
  } else if (k === 'summary_on') {
    if (!['on', 'off'].includes(v)) return { ok: false, error: k + ' 只认 on / off' }
  } else if (k === 'summary_at') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(v)
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { ok: false, error: 'summary_at 要写成 HH:MM，例如 21:30' }
    v = `${String(m[1]).padStart(2, '0')}:${m[2]}`
  }
  const cur = readRemindRules().raw
  cur[k] = v
  try {
    // 快照（能回滚）：跟 pack/learn 那套一样留一份就够
    if (!SELFTEST && !MOCK && existsSync(remindRulesPath())) {
      const bak = remindRulesPath() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      writeFileSync(bak, readFileSync(remindRulesPath(), 'utf8'), 'utf8')
    }
    mkdirSync(dirname(remindRulesPath()), { recursive: true })
    writeFileSync(remindRulesPath(), renderRemindRules(cur), 'utf8')
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  const after = readRemindRules()
  log(`提醒规则 ${k} → ${v}`)
  // 查询节奏变了就重挂定时器
  if (k === 'remind_check_seconds') restartReminders()
  return { ok: true, key: k, value: v, rules: after }
}

// 台账（去重）
function readRemindLedger() {
  const j = readJson(remindLedgerPath())
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
}

function writeRemindLedger(map) {
  try {
    // 只留最近 30 天，别越攒越大
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19)
    const out = {}
    for (const [k, at] of Object.entries(map)) if (String(at) >= cutoff.replace('T', ' ')) out[k] = at
    writeJson(remindLedgerPath(), out)
  } catch {}
}

function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null
  return h * 60 + mi
}

function nowMinutes(d) {
  const t = d || new Date()
  return t.getHours() * 60 + t.getMinutes()
}

/** 现在是不是在上课（用课表里今天的 items；一节课默认上到下一节开始，最后一节按 90 分钟） */
function inClassNow(agenda, now) {
  try {
    if (!agenda || !Array.isArray(agenda.days)) return null
    const today = todayKey()
    const day = agenda.days.find((d) => d.isToday) || agenda.days.find((d) => d.date === today)
    if (!day) return null
    if (day.isSchoolDay === false) return null
    const items = (day.items || []).filter((i) => i && i.time)
    const cur = nowMinutes(now)
    for (let i = 0; i < items.length; i += 1) {
      const start = hhmmToMinutes(items[i].time)
      if (start == null) continue
      const next = i + 1 < items.length ? hhmmToMinutes(items[i + 1].time) : null
      const end = next != null && next > start ? next : start + 90
      if (cur >= start && cur < end) {
        return { label: String(items[i].label || ''), room: items[i].room || null, until: end, start }
      }
    }
  } catch {}
  return null
}

/** 今天"该提醒"的待办（提前 N 分钟 / 到点两种） */
function remindCandidates(now, tasksOverride) {
  const r = readRemindRules()
  const list = Array.isArray(tasksOverride) ? tasksOverride : (loadTasks() || {}).tasks
  const out = []
  if (!Array.isArray(list)) return out
  const t = now || new Date()
  const tMs = t.getTime()
  for (const task of list) {
    if (!task || !task.dueDate || !task.dueTime) continue
    const st = String(task.status || 'open')
    if (st === 'done' || st === 'dropped' || st === 'expired') continue
    // 用"完整时刻"算差值 —— 别只看"是不是今天"：明天 00:30 截止的，今天 23:30 就该提醒（跨零点）
    const dueMs = new Date(`${task.dueDate}T${String(task.dueTime).slice(0, 5)}:00`).getTime()
    if (!Number.isFinite(dueMs)) continue
    const diff = Math.round((dueMs - tMs) / 60000)
    const title = String(task.title || '(没写标题)')
    const base = `${task.id || title}|${task.dueDate} ${task.dueTime}`
    if (diff > 0 && diff <= r.lead) {
      out.push({ key: base + '|lead', kind: 'lead', minutes: diff, title, subject: task.subjectName || '', dueTime: task.dueTime })
    }
    if (r.atDue && diff <= 0 && diff >= -5) {
      out.push({ key: base + '|due', kind: 'due', minutes: diff, title, subject: task.subjectName || '', dueTime: task.dueTime })
    }
  }
  return out
}

/** 桌面通知（自检里只记日志，不真的弹） */
function notifyDesktop(title, body) {
  if (SELFTEST) {
    log(`（自检）桌面通知：${title} — ${body}`)
    return
  }
  try {
    if (!Notification.isSupported()) {
      log('系统不支持通知 → 只在她头上说')
      return
    }
    new Notification({ title: '她 · ' + title, body, silent: false }).show()
  } catch (err) {
    log('通知弹不出来：' + ((err && err.message) || err))
  }
}

/**
 * 查一轮。可注入 now / tasks / classNow（自检和模拟用），不传就是"现在、真待办、真课表"。
 * 返回 {ok, skipped?, fired?, items[]}，自检靠它断言。
 *
 * 去重台账（2026-10-24 改）：值是「**这个时刻之后才可以再说**」的 ISO 字符串。
 *   · 正常发过 → 9999-12-31（这辈子不再提这件事）
 *   · 点了「稍后 10 分钟」→ 现在 + 10 分钟（到点会重新说一次）
 * 这样 snooze 和去重共用一张表，不用两套状态。
 */
const LEDGER_FOREVER = '9999-12-31T00:00:00'

function ledgerTime(now) {
  return new Date(now.getTime()).toISOString().slice(0, 19)
}

async function remindTick(opts) {
  const o = opts || {}
  const r = readRemindRules()
  if (!r.on) return { ok: true, skipped: 'off', fired: 0 }
  const now = o.now instanceof Date ? o.now : new Date()
  // DDL 提醒 + 每日提醒（2026-10-24 · Tevela D）：两条路最后汇进同一条提醒条
  const cands = remindCandidates(now, o.tasks).concat(dailyCandidates(now, o.daily))
  if (cands.length === 0) return { ok: true, fired: 0, items: [] }
  if (r.quietInClass) {
    const cls = o.classNow !== undefined ? o.classNow : inClassNow(loadAgenda(), now)
    if (cls) {
      log(`提醒：现在在上课（${cls.label || '有课'}），先不弹（${cands.length} 条压着）`)
      return { ok: true, skipped: 'class', inClass: cls.label || '', fired: 0, items: cands.length }
    }
  }
  const ledger = readRemindLedger()
  const nowIso = ledgerTime(now)
  const fired = []
  for (const c of cands) {
    // 台账里记着"什么时候之后才允许再说"；还没到那个点就跳过（这就是 snooze 和去重）
    const until = ledger[c.key]
    if (until && String(until) > nowIso) continue
    ledger[c.key] = LEDGER_FOREVER
    const say = c.daily
      ? `${c.title}——到点了，别忘了`
      : c.kind === 'due'
        ? `${c.title}到点了，该交了！`
        : `还有 ${c.minutes} 分钟：${c.title}（${c.dueTime} 前交）`
    pushedReminders.push({ key: c.key, kind: c.kind, daily: !!c.daily, title: c.title, subject: c.subject, dueTime: c.dueTime, minutes: c.minutes, say })
    fired.push({ ...c, say })
    log(`提醒排队（${c.daily ? '每日' : c.kind === 'lead' ? '提前' : '到点'}）：${c.title} → ${c.dueTime}`)
  }
  if (fired.length > 0) writeRemindLedger(ledger)
  // 一条一条弹（同时来三条就排队，不叠成一坨）
  pumpReminderQueue()
  return { ok: true, fired: fired.length, items: cands.length, fired_items: fired, queued: pushedReminders.length }
}

// ── 提醒队列 + 「知道了 / 稍后」──────────────────────────────────────────────
let pushedReminders = []
let activeReminder = null
let activeReminderTimer = null

function remindBarVisible(rem) {
  try {
    if (deps.win && !deps.win.isDestroyed()) deps.win.webContents.send('her:pick', { reminder: rem })
  } catch {}
}

/** 队列里有就弹下一条；一条只弹一次，90 秒没人理就自动"知道了"再弹下一条 */
function pumpReminderQueue() {
  if (activeReminder || pushedReminders.length === 0) return
  const rem = pushedReminders.shift()
  activeReminder = rem
  const r = readRemindRules()
  const say = rem.say || rem.title
  notifyDesktop(
    rem.daily ? '到点了' : rem.kind === 'due' ? '该交了' : '快要交了',
    rem.daily ? String(rem.title) : `${rem.title}${rem.subject ? ' · ' + rem.subject : ''}　${rem.dueTime} 截止`,
  )
  if (!MOCK) petControl({ say, mood: rem.kind === 'due' ? 'alert' : 'sweat' })
  if (r.speak) speakBubble(say)
  remindBarVisible(rem)
  clearTimeout(activeReminderTimer)
  activeReminderTimer = setTimeout(() => {
    log('提醒：90 秒没人理，自动收起来（下一条接着）')
    finishActiveReminder()
  }, 90000)
}

function finishActiveReminder() {
  clearTimeout(activeReminderTimer)
  activeReminderTimer = null
  activeReminder = null
  // 让她脚边那条收起来（页面收到"没有 reminder"就把提醒条收掉）
  try {
    if (deps.win && !deps.win.isDestroyed()) deps.win.webContents.send('her:pick', { reminder: null })
  } catch {}
  setTimeout(() => pumpReminderQueue(), 400)
}

/** 「知道了」：台账已经是"永不"，只要收掉这条、弹下一条 */
function ackReminder() {
  finishActiveReminder()
  return { ok: true }
}

/**
 * 「稍后 N 分钟」：把台账里这件事改成"现在 + N 分钟之后才可以再说"，
 * 到点 remindTick 会重新把它捡起来（所以"稍后"是真的会再说一次）。
 */
function snoozeReminder(opts) {
  const o = opts || {}
  const r = readRemindRules()
  const minutes = Number.isFinite(Number(o.minutes)) ? remindClamp(o.minutes, 0, 1440, r.snoozeMin) : r.snoozeMin
  const key = String(o.key || (activeReminder && activeReminder.key) || '')
  finishActiveReminder()
  if (!key) return { ok: false, error: '不知道要推迟哪一条' }
  const ledger = readRemindLedger()
  const until = new Date(Date.now() + minutes * 60000)
  ledger[key] = ledgerTime(until)
  writeRemindLedger(ledger)
  log(`提醒：稍后 ${minutes} 分钟再说（${key}）`)
  return { ok: true, key, minutes, until: ledger[key], rules: { snoozeMin: r.snoozeMin } }
}

let remindTimer = null

function stopReminders() {
  if (remindTimer) {
    clearInterval(remindTimer)
    remindTimer = null
  }
}

function restartReminders() {
  stopReminders()
  startReminders()
}

/** 起定时器（应用启动时调；自检里也起，但不会真弹通知） */
function startReminders() {
  if (remindTimer) return
  const r = readRemindRules()
  if (!r.on) {
    log('主动提醒：off（规则文件里 remind_on = off）')
    return
  }
  remindTimer = setInterval(() => {
    void remindTick({})
  }, Math.max(15, r.everySec) * 1000)
  // 启动 8 秒后先查一次（别等第一个整周期）
  setTimeout(() => {
    void remindTick({})
  }, 8000)
  log(`主动提醒起来了：提前 ${r.lead} 分钟、到点${r.atDue ? '也提醒' : '不再提醒'}、上课${r.quietInClass ? '不弹' : '照样弹'}、每 ${r.everySec} 秒查一次`)
}

// ══════════════════════════════════════════════════════════════════════════════
//  每日提醒清单（2026-10-24 · 主人点名批次 1.4，借 Tevela D）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 「每日提醒」= 他自己定的钟点事，不是作业（喝水 / 背单词 / 22:30 收书包…）。
 * 数据：`_study-core\提醒清单.json` → `{version:1, items:[{id,title,time:"21:00",days:[1..7],enabled}]}`
 *   · time 用 `HH:MM`；days 空数组 = 每天，1 = 周一 … 7 = 周日
 * 它跟 DDL 提醒**共用同一条管道**（去重台账 + 她脚边那条「知道了 / 稍后」），所以不用另写一套；
 * 区别只有一个：**到点那一刻才提醒**（不提前 N 分钟）——"该喝水了"不需要提前一小时预告。
 */
const DAILY_FILE = `${DATA_ROOT}/_study-core/提醒清单.json`
function dailyFile() {
  return SELFTEST || MOCK ? join(OUT, '提醒清单.mock.json') : DAILY_FILE
}
const DAILY_WD = ['一', '二', '三', '四', '五', '六', '日']

/** '9:00' / '09:00' → '09:00'；认不出就 null */
function normHhmm(s) {
  const m = hhmmToMinutes(s)
  if (m == null) return null
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function normDaily(raw) {
  if (!raw || typeof raw !== 'object') return null
  const time = normHhmm(raw.time)
  if (!time) return null
  const title = String(raw.title || '').trim()
  if (!title) return null
  const days = Array.isArray(raw.days)
    ? Array.from(new Set(raw.days.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7))).sort((a, b) => a - b)
    : []
  const out = { id: String(raw.id || '') || 'd' + Date.now().toString(36), title, time, days, enabled: raw.enabled !== false }
  if (raw.createdAt) out.createdAt = String(raw.createdAt)
  return out
}

function readDaily() {
  const j = readJson(dailyFile())
  const raw = j && Array.isArray(j.items) ? j.items : []
  const items = raw.map(normDaily).filter(Boolean)
  return { ok: true, items, path: dailyFile(), file: dailyFile(), mock: SELFTEST || MOCK }
}

function writeDaily(items) {
  const list = (Array.isArray(items) ? items : []).map(normDaily).filter(Boolean)
  try {
    mkdirSync(dirname(dailyFile()), { recursive: true })
    // 动之前先留一份（跟提醒规则文件一个口径）；自检 / 假数据不碰真文件
    if (!SELFTEST && !MOCK && existsSync(dailyFile())) {
      const bak = dailyFile() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      writeFileSync(bak, readFileSync(dailyFile(), 'utf8'), 'utf8')
    }
    writeJson(dailyFile(), { version: 1, items: list })
    return { ok: true, items: list, path: dailyFile() }
  } catch (err) {
    return { ok: false, items: list, path: dailyFile(), error: String((err && err.message) || err) }
  }
}

function addDailyReminder(arg) {
  const a = arg && typeof arg === 'object' ? arg : {}
  const time = normHhmm(a.time || a.at)
  if (!time) return { ok: false, error: '时间要写成 HH:MM（例如 21:00）' }
  const title = String(a.title || '').trim()
  if (!title) return { ok: false, error: '给这条提醒起个名字吧' }
  const cur = readDaily().items
  if (cur.length >= 50) return { ok: false, error: '最多 50 条（先删几条再加）' }
  const item = normDaily({
    id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title,
    time,
    days: Array.isArray(a.days) ? a.days : [],
    enabled: a.enabled !== false,
    createdAt: new Date().toISOString(),
  })
  const w = writeDaily(cur.concat([item]))
  if (!w.ok) return w
  log(`每日提醒 +1：${title} @ ${time}${item.days.length ? '（周' + item.days.map((d) => DAILY_WD[d - 1]).join('/') + '）' : '（每天）'}`)
  return Object.assign({ ok: true, item }, readDaily())
}

function setDailyReminder(arg) {
  const a = arg && typeof arg === 'object' ? arg : {}
  const id = String(a.id || '')
  const patch = a.patch && typeof a.patch === 'object' ? a.patch : {}
  const cur = readDaily().items
  const idx = cur.findIndex((it) => it.id === id)
  if (idx < 0) return { ok: false, error: '找不到这条提醒：' + id }
  const merged = Object.assign({}, cur[idx], patch)
  if (patch.time !== undefined) {
    const t = normHhmm(patch.time)
    if (!t) return { ok: false, error: '时间要写成 HH:MM（例如 21:00）' }
    merged.time = t
  }
  if (patch.title !== undefined && !String(patch.title).trim()) return { ok: false, error: '名字不能是空的' }
  if (patch.days !== undefined) merged.days = Array.isArray(patch.days) ? patch.days : []
  const it = normDaily(merged)
  if (!it) return { ok: false, error: '这条提醒不合法（时间 / 名字）' }
  cur[idx] = it
  const w = writeDaily(cur)
  if (!w.ok) return w
  log(`每日提醒改了：${it.title} @ ${it.time}（${it.enabled ? '开' : '关'}）`)
  return Object.assign({ ok: true, item: it }, readDaily())
}

function removeDailyReminder(id) {
  const key = String(id || '')
  const cur = readDaily().items
  const left = cur.filter((it) => it.id !== key)
  if (left.length === cur.length) return { ok: false, error: '找不到这条提醒：' + key }
  const w = writeDaily(left)
  if (!w.ok) return w
  log('每日提醒 -1：' + key)
  return Object.assign({ ok: true }, readDaily())
}

/** 这一分钟该响的每日提醒（到点才响，±5 分钟兜迟到的一轮） */
function dailyCandidates(now, listOverride) {
  const r = readRemindRules()
  if (!r.on) return []
  const list = Array.isArray(listOverride) ? listOverride.map(normDaily).filter(Boolean) : readDaily().items
  const t = now instanceof Date ? now : new Date()
  const wd = ((t.getDay() + 6) % 7) + 1
  const dayKey = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  const out = []
  for (const it of list) {
    if (!it || it.enabled === false) continue
    if (it.days.length > 0 && !it.days.includes(wd)) continue
    const mins = hhmmToMinutes(it.time)
    if (mins == null) continue
    const due = new Date(t.getTime())
    due.setHours(Math.floor(mins / 60), mins % 60, 0, 0)
    const diff = Math.round((due.getTime() - t.getTime()) / 60000)
    if (diff <= 0 && diff >= -5) {
      out.push({
        key: `daily|${it.id}|${dayKey} ${it.time}|due`,
        kind: 'due',
        daily: true,
        minutes: diff,
        title: it.title,
        subject: '每日提醒',
        dueTime: it.time,
      })
    }
  }
  return out
}

// ══════════════════════════════════════════════════════════════════════════════
//  每周计划（2026-10-24 · 主人点名批次 1.5，借 Tevela E）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 数据：`_study-core\每周计划.json` → `{version:1, weeks:{ "2026-10-19": {start,end,goals:[{id,text,done,createdAt,doneAt}]} }}`
 *   · 键 = 那一周的**周一日期**（一眼看得出是哪一周，不用算第几周）
 *   · 换周不删东西：上一周的目标留在自己那一格（这就是"按周归档"）
 */
const WEEKLY_FILE = `${DATA_ROOT}/_study-core/每周计划.json`
function weeklyFile() {
  return SELFTEST || MOCK ? join(OUT, '每周计划.mock.json') : WEEKLY_FILE
}
function ymdLocal(d) {
  const t = d instanceof Date ? d : new Date()
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
}
/** 这一周的周一 / 周日（周一为一周之始） */
function weekInfo(date) {
  const t = date instanceof Date ? date : new Date()
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate())
  const wd = (d.getDay() + 6) % 7
  const start = new Date(d.getTime() - wd * 86400000)
  const end = new Date(start.getTime() + 6 * 86400000)
  return { key: ymdLocal(start), start: ymdLocal(start), end: ymdLocal(end) }
}

function normWeekGoals(goals) {
  return (Array.isArray(goals) ? goals : [])
    .filter((g) => g && String(g.text || '').trim())
    .map((g) => {
      const o = { id: String(g.id || '') || 'g' + Date.now().toString(36), text: String(g.text).trim(), done: g.done === true }
      if (g.createdAt) o.createdAt = String(g.createdAt)
      if (g.doneAt) o.doneAt = String(g.doneAt)
      return o
    })
}

function readWeeklyWeeks() {
  const j = readJson(weeklyFile())
  const weeks = j && j.weeks && typeof j.weeks === 'object' && !Array.isArray(j.weeks) ? j.weeks : {}
  return weeks
}

function readWeekly() {
  const weeks = readWeeklyWeeks()
  const wi = weekInfo(new Date())
  const norm = (key) => {
    const o = weeks[key] && typeof weeks[key] === 'object' ? weeks[key] : {}
    return { key, start: o.start || key, end: o.end || null, goals: normWeekGoals(o.goals) }
  }
  const keys = Object.keys(weeks).sort()
  const past = keys
    .filter((k) => k < wi.key && norm(k).goals.length > 0)
    .map((k) => {
      const w = norm(k)
      return { key: k, start: w.start, end: w.end, total: w.goals.length, done: w.goals.filter((g) => g.done).length }
    })
    .reverse()
  return {
    ok: true,
    path: weeklyFile(),
    today: ymdLocal(new Date()),
    current: norm(wi.key),
    past,
    mock: SELFTEST || MOCK,
  }
}

function writeWeekly(weeks) {
  try {
    mkdirSync(dirname(weeklyFile()), { recursive: true })
    if (!SELFTEST && !MOCK && existsSync(weeklyFile())) {
      const bak = weeklyFile() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      writeFileSync(bak, readFileSync(weeklyFile(), 'utf8'), 'utf8')
    }
    // 只留最近 26 周，别越攒越大
    const keys = Object.keys(weeks || {}).sort()
    const keep = keys.slice(-26)
    const out = {}
    for (const k of keep) out[k] = weeks[k]
    writeJson(weeklyFile(), { version: 1, weeks: out })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function mergeWeekSlot(weeks, key) {
  const cur = weeks[key] && typeof weeks[key] === 'object' ? weeks[key] : {}
  const wi = weekInfo(new Date(`${key}T00:00:00`))
  return { start: cur.start || wi.start, end: cur.end || wi.end, goals: normWeekGoals(cur.goals) }
}

function addWeeklyGoal(arg) {
  const a = arg && typeof arg === 'object' ? arg : { text: String(arg || '') }
  const text = String(a.text || '').trim()
  if (!text) return { ok: false, error: '这一周想做成什么？写一句话' }
  const wi = weekInfo(a.date ? new Date(`${String(a.date)}T00:00:00`) : new Date())
  const weeks = readWeeklyWeeks()
  const slot = mergeWeekSlot(weeks, wi.key)
  if (slot.goals.length >= 20) return { ok: false, error: '一周最多 20 条（挑最要紧的）' }
  slot.goals.push({ id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, done: false, createdAt: new Date().toISOString() })
  weeks[wi.key] = slot
  const w = writeWeekly(weeks)
  if (!w.ok) return w
  log(`每周计划 +1（${wi.key} 那一周）：${text}`)
  return Object.assign({ ok: true }, readWeekly())
}

/** 勾掉 / 取消勾掉（id 在哪一周都能找到） */
function toggleWeeklyGoal(id) {
  const key = String(id || '')
  const weeks = readWeeklyWeeks()
  for (const wk of Object.keys(weeks)) {
    const slot = mergeWeekSlot(weeks, wk)
    const idx = slot.goals.findIndex((g) => g.id === key)
    if (idx < 0) continue
    slot.goals[idx].done = !slot.goals[idx].done
    if (slot.goals[idx].done) slot.goals[idx].doneAt = new Date().toISOString()
    else delete slot.goals[idx].doneAt
    weeks[wk] = slot
    const w = writeWeekly(weeks)
    if (!w.ok) return w
    log(`每周计划：${slot.goals[idx].done ? '勾掉' : '取消'}「${slot.goals[idx].text}」（${wk} 那一周）`)
    return Object.assign({ ok: true, week: wk, goal: slot.goals[idx] }, readWeekly())
  }
  return { ok: false, error: '找不到这条：' + key }
}

function removeWeeklyGoal(id) {
  const key = String(id || '')
  const weeks = readWeeklyWeeks()
  for (const wk of Object.keys(weeks)) {
    const slot = mergeWeekSlot(weeks, wk)
    const left = slot.goals.filter((g) => g.id !== key)
    if (left.length === slot.goals.length) continue
    slot.goals = left
    weeks[wk] = slot
    const w = writeWeekly(weeks)
    if (!w.ok) return w
    return Object.assign({ ok: true, week: wk }, readWeekly())
  }
  return { ok: false, error: '找不到这条：' + key }
}

// ══════════════════════════════════════════════════════════════════════════════
//  学科学习计划（2026-10-24 · 主人点名批次 1.6，借 Tevela F）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 每门课一条："打算怎么学 + 进度（0~100）"。
 * 数据：`_study-core\学科计划.json` → `{version:1, items:[{subject,plan,progress,updatedAt}]}`
 */
const PLAN_FILE = `${DATA_ROOT}/_study-core/学科计划.json`
function planFile() {
  return SELFTEST || MOCK ? join(OUT, '学科计划.mock.json') : PLAN_FILE
}

function readPlans() {
  const j = readJson(planFile())
  const raw = j && Array.isArray(j.items) ? j.items : []
  const items = raw
    .filter((it) => it && String(it.subject || '').trim())
    .map((it) => ({
      subject: String(it.subject).trim(),
      plan: String(it.plan || ''),
      progress: remindClamp(it.progress, 0, 100, 0),
      updatedAt: it.updatedAt ? String(it.updatedAt) : null,
    }))
  return { ok: true, items, path: planFile(), mock: SELFTEST || MOCK }
}

function writePlans(items) {
  try {
    mkdirSync(dirname(planFile()), { recursive: true })
    if (!SELFTEST && !MOCK && existsSync(planFile())) {
      const bak = planFile() + '.bak-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      writeFileSync(bak, readFileSync(planFile(), 'utf8'), 'utf8')
    }
    writeJson(planFile(), { version: 1, items })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** 存一条（有就改、没有就加）。subject 是主键 */
function setPlan(arg) {
  const a = arg && typeof arg === 'object' ? arg : {}
  const subject = String(a.subject || '').trim()
  if (!subject) return { ok: false, error: '要写这是哪门课（科目名）' }
  const items = readPlans().items
  const idx = items.findIndex((it) => it.subject === subject)
  const plan = a.plan === undefined ? (idx >= 0 ? items[idx].plan : '') : String(a.plan || '')
  const progress = a.progress === undefined ? (idx >= 0 ? items[idx].progress : 0) : remindClamp(a.progress, 0, 100, 0)
  const row = { subject, plan, progress, updatedAt: new Date().toISOString() }
  if (idx >= 0) items[idx] = row
  else items.push(row)
  const w = writePlans(items)
  if (!w.ok) return w
  log(`学科计划：${subject} → 进度 ${progress}%`)
  return Object.assign({ ok: true, item: row }, readPlans())
}

function removePlan(subject) {
  const key = String(subject || '').trim()
  const items = readPlans().items
  const left = items.filter((it) => it.subject !== key)
  if (left.length === items.length) return { ok: false, error: '找不到这门课：' + key }
  const w = writePlans(left)
  if (!w.ok) return w
  log('学科计划 -1：' + key)
  return Object.assign({ ok: true }, readPlans())
}

  return {
    remindRulesPath,
    dailyFile,
    planFile,
    remindLedgerPath,
    readRemindRules,
    remindTick,
    readDaily,
    readPlans,
    weeklyFile,
    ymdLocal,
    REMIND_DEFAULTS,
    renderRemindRules,
    ensureRemindRules,
    setRemindRule,
    notifyDesktop,
    ackReminder,
    snoozeReminder,
    startReminders,
    DAILY_WD,
    addDailyReminder,
    setDailyReminder,
    removeDailyReminder,
    weekInfo,
    readWeekly,
    addWeeklyGoal,
    toggleWeeklyGoal,
    removeWeeklyGoal,
    setPlan,
    removePlan,
  }
}
