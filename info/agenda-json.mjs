/**
 * info/agenda-json.mjs —— 把「本周安排」输出成结构化 JSON（2026-10-22 晚，新应用的日历页用）
 *
 * 和 `brief-json.mjs` 一对：还是调 study-core 的纯函数（`buildAgenda`），不重复实现一遍课表逻辑。
 * 输出：`{ ok, from, days:[{date, weekdayZh, isToday, isSchoolDay, items[], materials[], dueTasks[], …}],
 *          overdue[], reminders[], notices[] }` —— 一行 JSON。
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
const DAYS = Number(opt('days', ''))

const out = (obj) => console.log(JSON.stringify(obj))

try {
  const { loadRules } = await import(lib('rules.js'))
  const { parseTimetable } = await import(lib('timetable.js'))
  const { parseSelfStudy } = await import(lib('selfstudy.js'))
  const { readXlsxFile } = await import(lib('xlsx.js'))
  const { TaskStore } = await import(lib('store.js'))
  const { buildAgenda } = await import(lib('agenda.js'))
  const { subjectDisplayName } = await import(lib('subjects.js'))
  const { loadNotices } = await import(lib('notices.js'))
  const { formatLocalDate } = await import(lib('datetime.js'))

  const now = new Date()
  const { rules } = loadRules(RULES)
  const EMPTY_TIMETABLE = { classId: CLASS_ID, sheetName: '', headerRow: 0, weekdays: [], periods: [], sessions: [], warnings: [] }
  const workbook = existsSync(TIMETABLE) ? readXlsxFile(TIMETABLE) : null
  const timetable = workbook ? parseTimetable(workbook, CLASS_ID) : EMPTY_TIMETABLE
  const selfStudyPlan = workbook ? parseSelfStudy(workbook) : undefined
  const store = TaskStore.open(DATA)
  const tasks = store.list()
  const date = formatLocalDate(now)

  let notices = []
  try {
    notices = loadNotices(join(DATA, 'notices.json')).notices || []
  } catch {
    notices = []
  }

  const agenda = buildAgenda({
    from: date,
    days: Number.isFinite(DAYS) && DAYS > 0 ? Math.round(DAYS) : rules.agendaDays,
    timetable,
    tasks,
    courseChoices: rules.courseChoices,
    selfStudyRoom: rules.selfStudyRoom || undefined,
    selfStudyPlan,
    now,
    unknownTimeText: rules.briefUnknownTimeText,
    notices: notices.map((n) => ({ text: n.text, date: n.date })),
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
    source: 'agenda-json',
    from: agenda.from,
    days: agenda.days.map((d) => ({
      date: d.date,
      weekdayZh: d.weekdayZh,
      isToday: d.isToday,
      isSchoolDay: d.isSchoolDay,
      selfStudyRoom: d.selfStudyRoom ?? null,
      hasSelfStudy: !!d.hasSelfStudy,
      items: d.items.map((i) => ({
        time: i.time ?? null,
        label: i.label,
        room: i.room ?? null,
        teacher: i.teacher ?? null,
        kind: i.kind,
        isSelfStudy: !!i.isSelfStudy,
        needsConfirmation: !!i.needsConfirmation,
      })),
      materials: d.materials.map((m) => ({ subject: m.subject ?? null, text: m.text })),
      dueTasks: d.dueTasks.map(flatTask),
    })),
    overdue: agenda.overdue.map(flatTask),
    reminders: agenda.reminders.slice(),
    notices: (agenda.notices || []).map((n) => ({ text: n.text, date: n.date ?? null })),
    // 带 id 的原始通知（日历页要能"双击撤掉"一条 → study-lite --notice-remove <id>）
    noticeList: notices.map((n) => ({ id: n.id, text: n.text, date: n.date ?? null })),
    warnings: (store.warnings || []).map((w) => (typeof w === 'string' ? w : w.message)),
    rulesFound: existsSync(RULES),
    timetableFound: existsSync(TIMETABLE),
  })
  process.exit(0)
} catch (cause) {
  out({ ok: false, source: 'agenda-json', error: cause instanceof Error ? cause.message : String(cause) })
  process.exit(1)
}
