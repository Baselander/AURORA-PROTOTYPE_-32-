/**
 * info/brief-json.mjs —— 把「今日提醒」输出成**结构化 JSON**（2026-10-22 晚，新应用用）
 *
 * 为什么要它：
 *   旧的浮窗是读 `今日提醒.txt` 再按行画的；新应用（apps\desktop）要画成卡片/列表，
 *   一行行猜格式太脆。这里直接调 study-core 的 `buildDailyBrief`，把**同一份数据**输出成 JSON：
 *   `{ date, weekdayZh, isSchoolDay, sections:[{heading, lines:[…]}], classes, materials, … }`
 *
 *   sections 是从 `brief.markdown` 切的「## 标题 + 后面的行」——这样界面上看到的文字
 *   和 txt 文件里**逐字一致**（不重复实现一遍段落逻辑）。
 *
 * 用法：node info/brief-json.mjs [--data <目录>] [--rules <文件>] [--timetable <xlsx>] [--date YYYY-MM-DD]
 * 输出：**一行 JSON**。失败也是 JSON（`{ok:false, error}`），别让人去猜。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT =
  process.env.DSH_PROJECT_ROOT || 'AURORA_DATA web/DSH-PROJECT'
const lib = (name) => new URL(`packages/study-core/lib/src/core/${name}`, pathToFileURL(`${ROOT}/`)).href

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const DATA_ROOT = process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const RULES = opt('rules', `${DATA_ROOT}/mystery/DSH/study-rules.txt`)
const DATA = opt('data', `${DATA_ROOT}/_study-core`)
const TIMETABLE = opt('timetable', `${G10}/z-info/高一课表20261008.xlsx`)
const CLASS_ID = opt('class', '111A')
const DATE_OPT = opt('date', '')

const out = (obj) => console.log(JSON.stringify(obj))

/** 「## 标题 / 正文行」→ [{heading, lines}] */
function splitMarkdownSections(markdown) {
  const sections = []
  let current = null
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const m = /^##\s+(.+)$/.exec(line.trim())
    if (m) {
      current = { heading: m[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (!current) continue
    if (line.trim().length === 0) continue
    if (/^#\s+/.test(line)) continue // 一级标题（日期那行）
    current.lines.push(line)
  }
  return sections.filter((s) => s.lines.length > 0 || s.heading.length > 0)
}

try {
  const { loadRules } = await import(lib('rules.js'))
  const { parseTimetable } = await import(lib('timetable.js'))
  const { parseSelfStudy } = await import(lib('selfstudy.js'))
  const { readXlsxFile } = await import(lib('xlsx.js'))
  const { TaskStore } = await import(lib('store.js'))
  const { buildDailyBrief } = await import(lib('brief.js'))
  const { subjectDisplayName } = await import(lib('subjects.js'))
  const { loadNotices } = await import(lib('notices.js'))
  const { formatLocalDate } = await import(lib('datetime.js'))

  const now = new Date()
  const { rules } = loadRules(RULES)

  // 课表缺了别崩（buildDailyBrief 要读 timetable.sessions）
  const EMPTY_TIMETABLE = {
    classId: CLASS_ID,
    sheetName: '',
    headerRow: 0,
    weekdays: [],
    periods: [],
    sessions: [],
    warnings: [],
  }
  const workbook = existsSync(TIMETABLE) ? readXlsxFile(TIMETABLE) : null
  const timetable = workbook ? parseTimetable(workbook, CLASS_ID) : EMPTY_TIMETABLE
  const selfStudyPlan = workbook ? parseSelfStudy(workbook) : undefined

  const store = TaskStore.open(DATA)
  const tasks = store.list()
  const date = DATE_OPT || formatLocalDate(now)

  let notices = []
  try {
    notices = loadNotices(join(DATA, 'notices.json')).notices || []
  } catch {
    notices = []
  }

  const brief = buildDailyBrief({
    date,
    timetable,
    tasks,
    courseChoices: rules.courseChoices,
    selfStudyRoom: rules.selfStudyRoom || undefined,
    selfStudyPlan,
    upcomingDays: rules.briefUpcomingDays,
    now,
    sections: rules.briefSections,
    unknownTimeText: rules.briefUnknownTimeText,
    // ⚠️ 这里**不传 events**：它的形状是 CalendarEvent（{at,title}），
    //   我们的通知是 {text,date}，硬塞进去会走到 `a.label.localeCompare` 上炸掉（2026-10-22 踩过）。
    //   通知单独放在下面的 `notices` 里，留给日历页用。
  })

  const nameOf = (t) => (t.subjectId === undefined ? null : subjectDisplayName(t.subjectId))
  const flatTask = (t) => ({
    id: t.id,
    title: t.title,
    kind: t.kind,
    status: t.status,
    subjectId: t.subjectId ?? null,
    subjectName: nameOf(t),
    dueAt: t.dueAt ?? null,
    dueDate: t.dueAt ? t.dueAt.slice(0, 10) : null,
    dueTime: t.dueAt ? t.dueAt.slice(11, 16) : null,
  })

  out({
    ok: true,
    source: 'brief-json',
    date: brief.date,
    weekdayZh: brief.weekdayZh ?? null,
    isSchoolDay: brief.isSchoolDay,
    classId: brief.classId,
    timezone: brief.timezone,
    sections: splitMarkdownSections(brief.markdown),
    classes: brief.classes.map((c) => ({
      period: c.period,
      label: c.label ?? null,
      subject: c.subject ?? null,
      room: c.room ?? null,
      start: c.start ?? null,
      end: c.end ?? null,
    })),
    materials: brief.materials.map((m) => ({ subject: m.subject ?? null, text: m.text })),
    timeline: brief.timeline.map((e) => ({ start: e.start ?? null, end: e.end ?? null, title: e.title })),
    tasksDueToday: brief.tasksDueToday.map(flatTask),
    tasksOverdue: brief.tasksOverdue.map(flatTask),
    tasksUpcoming: brief.tasksUpcoming.map(flatTask),
    reminders: brief.reminders.slice(),
    notices: notices.map((n) => ({ text: n.text, date: n.date ?? null })),
    warnings: (store.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)),
    rulesFound: existsSync(RULES),
    timetableFound: existsSync(TIMETABLE),
    markdown: brief.markdown,
  })
  process.exit(0)
} catch (cause) {
  out({ ok: false, source: 'brief-json', error: cause instanceof Error ? cause.message : String(cause) })
  process.exit(1)
}
