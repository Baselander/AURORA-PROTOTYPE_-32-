/**
 * info/study-lite.mjs —— 浮窗用的「本地快通道」：不叫模型也能看/改待办。
 *
 * 为什么要有它（2026-10-21）：
 *   主人要「待办卡片点一下就能勾掉、再点一下能撤销」+「日历格子里看到那天的 DDL」。
 *   原来的路是弹一次模型（`$script:markDone` 走 DSH，十几秒、还容易按标题匹配错）。
 *   这些操作全是**确定性的**，没必要花 token，也没必要等模型：
 *   直接读 `tasks.json` → 用 study-core 的纯函数改 → 顺手重刷三份给人看的文件。
 *
 * 用法（参数都可以省略，默认值和 local-process.mjs 一致）：
 *   node info/study-lite.mjs --json --list                      # 全部待办（含 kind/status/dueAt/overdue）
 *   node info/study-lite.mjs --json --toggle t20261021051401-001 # 勾掉 ⇄ 撤销（done ⇄ open）
 *   node info/study-lite.mjs --json --set-kind <id> todo         # 改分类（作业 / to-do）
 *   node info/study-lite.mjs --json --delete <id>                # 删掉一条（2026-10-21 晚加）
 *   node info/study-lite.mjs --json --refresh                    # 只重刷三份文件
 *   node info/study-lite.mjs --json --notice-add "<通知原文>"     # 记一条通知（进日历的「通知」窗）
 *   可选：--data <目录> --rules <文件> --timetable <xlsx>
 *
 * 副作用：`--toggle` / `--set-kind` / `--delete` / `--refresh` **会写** `tasks.json`（原子写）
 *   和 `今日提醒.md / 待办总览.md / 本周安排.md`；`--list` 只读。
 *   `--delete` 还会把被删的那一条**追加**到 `<数据目录>\tasks.deleted.jsonl`
 *   —— 主人说「一不小心加上的东西要能删」，但删错了也得能捞回来（照着这个文件手工粘回 tasks.json）。
 *   输出永远是**一行 JSON**（`--json` 缺省也是 JSON，浮窗要解析）。
 */

import { appendFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_PROJECT_ROOT || 'AURORA_DATA web/DSH-PROJECT'
const lib = (name) => new URL(`packages/study-core/lib/src/core/${name}`, pathToFileURL(`${ROOT}/`)).href

const { loadRules } = await import(lib('rules.js'))
const { parseTimetable } = await import(lib('timetable.js'))
const { parseSelfStudy } = await import(lib('selfstudy.js'))
const { readXlsxFile } = await import(lib('xlsx.js'))
const { TaskStore } = await import(lib('store.js'))
const { withStatus, withPatch } = await import(lib('tasks.js'))
const { addNotice, loadNotices, saveNotices, renderNoticeList } = await import(lib('notices.js'))
const { subjectDisplayName } = await import(lib('subjects.js'))
const { buildDailyBrief } = await import(lib('brief.js'))
const { renderTasksOverview, writeReports } = await import(lib('report.js'))
const { buildAgenda } = await import(lib('agenda.js'))
const { formatIsoWithOffset, formatLocalDate } = await import(lib('datetime.js'))

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const positionalAfter = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args.slice(i + 1).filter((a) => !a.startsWith('--')) : []
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const DATA_ROOT = process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const RULES = opt('rules', `${DATA_ROOT}/mystery/DSH/study-rules.txt`)
const DATA = opt('data', `${DATA_ROOT}/_study-core`)
const TIMETABLE = opt('timetable', `${G10}/z-info/高一课表20261008.xlsx`)
const CLASS_ID = opt('class', '111A')

const now = new Date()
const out = (obj) => console.log(JSON.stringify(obj))

try {
  const { rules } = loadRules(RULES)
  // 2026-10-22：课表缺了**别让整套崩溃**（buildDailyBrief 会读 timetable.sessions）。
//   用一张"空课表"顶上去：今日提醒照写（今天没课），本周安排照写（顺带把通知写进去）。
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
  const warnings = store.warnings.map((w) => w.message)

  /** 重刷三份给人看的文件（和 local-process.mjs 同一套，保证两边说同一件事）。 */
  function refreshReports() {
    // 2026-10-21 晚：这里**不允许抛**。踩过：某个数据目录没有课表文件（timetable undefined）
    //   时 buildDailyBrief 会炸 —— 于是 `--delete` 明明已经把那条删掉了，却因为"刷新文件失败"
    //   整体返回 ok:false，浮窗上写着「没删成」，最误导人。刷新失败只是小事，如实报 issue。
    try {
      const tasks = store.list()
      const date = formatLocalDate(now)
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
      })
      // 2026-10-22：通知也要写进「本周安排」（浮窗日历页的「通知」窗读 `## 通知` 那一段）
      const loadedNotices = (() => {
        try { return loadNotices(join(DATA, 'notices.json')).notices } catch { return [] }
      })()
      const agenda = timetable === undefined ? undefined : buildAgenda({
        from: date,
        days: rules.agendaDays,
        timetable,
        tasks,
        courseChoices: rules.courseChoices,
        selfStudyRoom: rules.selfStudyRoom || undefined,
        selfStudyPlan,
        now,
        unknownTimeText: rules.briefUnknownTimeText,
        notices: loadedNotices.map((item) => ({ text: item.text, date: item.date })),
      })
      const result = writeReports({
        outputDir: rules.outputDir,
        briefFileName: rules.outputBriefFile,
        tasksFileName: rules.outputTasksFile,
        briefMarkdown: brief.markdown,
        tasksMarkdown: renderTasksOverview(tasks, now),
        agendaFileName: rules.agendaOutputFile ?? rules.outputAgendaFile,
        agendaMarkdown: agenda?.markdown,
        now,
      })
      return { written: result.written.map((f) => f.path), issues: [...result.issues] }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      return { written: [], issues: [`刷新三份文件失败（数据本身没事）：${reason}`] }
    }
  }

  /** 一条任务 → 浮窗好用的扁结构（dueDate 是本地日期，overdue 是「已经过了」）。 */
  function flat(task) {
    const dueMs = task.dueAt === undefined ? NaN : Date.parse(task.dueAt)
    const overdue = Number.isFinite(dueMs) && dueMs <= now.getTime() && task.status !== 'done' && task.status !== 'dropped'
    return {
      id: task.id,
      title: task.title,
      kind: task.kind,
      status: task.status,
      subjectId: task.subjectId ?? null,
      subjectName: task.subjectId === undefined ? null : subjectDisplayName(task.subjectId),
      dueAt: task.dueAt ?? null,
      dueDate: task.dueAt === undefined ? null : task.dueAt.slice(0, 10),
      dueTime: task.dueAt === undefined ? null : task.dueAt.slice(11, 16),
      overdue,
      createdAt: task.createdAt,
    }
  }

  if (flag('toggle')) {
    const id = opt('toggle', '')
    const existing = store.get(id)
    if (existing === undefined) {
      out({ ok: false, action: 'toggle', error: `找不到 id=${id}` })
      process.exit(3)
    }
    // done ⇄ open（撤销就是把状态改回去）；其余状态（expired / dropped）先回到 open
    const nextStatus = existing.status === 'done' ? 'open' : 'done'
    const updated = withStatus(existing, nextStatus, now)
    store.replace(updated)
    const reports = refreshReports()
    out({ ok: true, action: 'toggle', task: flat(updated), reports })
    process.exit(0)
  }

  if (flag('delete')) {
    // 2026-10-21 晚（主人说「一不小心加上的东西删不掉」）：真删一条。
    //   ⚠️ 是**真删**（从 tasks.json 里拿掉），不是标成 dropped；
    //      所以先把那一条原样追加到 tasks.deleted.jsonl，删错了能照着手工粘回去。
    const id = opt('delete', '')
    const existing = store.get(id)
    if (existing === undefined) {
      out({ ok: false, action: 'delete', error: `找不到 id=${id}` })
      process.exit(3)
    }
    const backupPath = join(DATA, 'tasks.deleted.jsonl')
    let backup = 'ok'
    try {
      appendFileSync(backupPath, `${JSON.stringify({ deletedAt: new Date().toISOString(), task: existing })}\n`, 'utf8')
    } catch (cause) {
      // 备份写不进去就**不删**（宁可删不掉，也别把主人的作业悄悄弄丢）
      backup = 'fail'
      out({ ok: false, action: 'delete', error: `备份写不进去，没删：${cause instanceof Error ? cause.message : String(cause)}` })
      process.exit(5)
    }
    const removed = store.remove(id)
    const reports = refreshReports()
    out({ ok: removed, action: 'delete', task: flat(existing), backup, backupPath, reports })
    process.exit(removed ? 0 : 3)
  }

  if (flag('set-kind')) {
    const [id, kind] = positionalAfter('set-kind')
    if (kind !== 'homework' && kind !== 'todo') {
      out({ ok: false, action: 'set-kind', error: 'kind 只能是 homework 或 todo' })
      process.exit(2)
    }
    const existing = store.get(id)
    if (existing === undefined) {
      out({ ok: false, action: 'set-kind', error: `找不到 id=${id}` })
      process.exit(3)
    }
    const updated = withPatch(existing, { kind }, now)
    store.replace(updated)
    const reports = refreshReports()
    out({ ok: true, action: 'set-kind', task: flat(updated), reports })
    process.exit(0)
  }

  if (flag('attach-image')) {
    // 白板画完的图挂到某一条错题上（2026-10-21）：往那条的「⑥ 额外记录」里追加一行。
    const [seqStr, imagePath] = positionalAfter('attach-image')
    const seq = Number.parseInt(seqStr ?? '', 10)
    if (!Number.isFinite(seq) || !imagePath) {
      out({ ok: false, action: 'attach-image', error: '用法：--attach-image <序号> <png 路径>' })
      process.exit(2)
    }
    const { attachEntryNote } = await import(lib('mistakes.js'))
    const studyRoot = dirname(DATA)
    const genDir = join(studyRoot, '新建', '_AURORA工作区', '错题本生成器')
    const entriesPath = join(genDir, 'entries.json')
    const r = attachEntryNote(entriesPath, seq, `配图：${imagePath}`)
    // 顺手重生 docx（生成器就在同一目录；没有就跳过，不报错）
    let docx = 'skip'
    if (r.ok && existsSync(join(genDir, 'make_cuotiben.js'))) {
      const run = spawnSync('node', ['make_cuotiben.js'], { cwd: genDir, encoding: 'utf8' })
      docx = run.status === 0 ? 'ok' : `fail(${String(run.status)})`
    }
    out({ ok: r.ok, action: 'attach-image', seq, title: r.title ?? null, error: r.error ?? null, docx, entriesPath })
    process.exit(r.ok ? 0 : 4)
  }

  if (flag('notice-add')) {
    // 2026-10-22：`*` 开头的通知 —— 浮窗直接记进 notices.json（0 token），
    //   再重刷三份文件，日历页的「通知」窗立刻就能看到。
    let text = opt('notice-add', '')
    const nf = opt('text-file', '')
    if (nf.length > 0) {
      try {
        text = readFileSync(nf, 'utf8')
      } catch (cause) {
        out({ ok: false, action: 'notice', error: `读不到 --text-file：${cause instanceof Error ? cause.message : String(cause)}` })
        process.exit(2)
      }
    }
    const file = join(DATA, 'notices.json')
    const loaded = loadNotices(file)
    const res = addNotice(loaded.notices, { text, source: '浮窗输入框' }, { now, deadlineTime: rules.ddlTime })
    if (res.action === 'created') saveNotices(file, res.notices)
    const reports = refreshReports()
    out({
      ok: true,
      action: 'notice',
      result: res.action,
      note: res.note,
      notice: res.notice === undefined ? null : { id: res.notice.id, date: res.notice.date ?? null, text: res.notice.text },
      reports,
    })
    process.exit(0)
  }

  if (flag('notice-list')) {
    // 浮窗「通知」窗用：列出来（带 id，撤掉时要用）
    const file = join(DATA, 'notices.json')
    const loaded = loadNotices(file)
    out({
      ok: true,
      action: 'notice-list',
      notices: loaded.notices.map((n) => ({ id: n.id, date: n.date ?? null, text: n.text, source: n.source ?? null })),
      issues: loaded.issues,
      rendered: renderNoticeList(loaded.notices),
    })
    process.exit(0)
  }

  if (flag('notice-remove')) {
    // 撤掉一条（认错了/混进来的假通知）
    const id = opt('notice-remove', '')
    const file = join(DATA, 'notices.json')
    const loaded = loadNotices(file)
    const kept = loaded.notices.filter((n) => n.id !== id)
    if (kept.length === loaded.notices.length) {
      out({ ok: false, action: 'notice-remove', error: `没有 id=${id} 的通知` })
      process.exit(3)
    }
    saveNotices(file, kept)
    out({ ok: true, action: 'notice-remove', removed: id, left: kept.length, reports: refreshReports() })
    process.exit(0)
  }

  if (flag('refresh')) {
    out({ ok: true, action: 'refresh', reports: refreshReports(), warnings })
    process.exit(0)
  }

  // 默认 = 列出（只读）
  const tasks = store.list().map(flat)
  out({ ok: true, action: 'list', tasks, warnings, dataDir: DATA, rulesFound: existsSync(RULES), timetableFound: existsSync(TIMETABLE) })
  process.exit(0)
} catch (cause) {
  out({ ok: false, error: cause instanceof Error ? `${cause.message}` : String(cause) })
  process.exit(1)
}
