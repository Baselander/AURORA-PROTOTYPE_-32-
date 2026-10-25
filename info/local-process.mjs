/**
 * info/local-process.mjs —— 零 token 的本地处理（主人定的筛选规则）
 *
 * 主人 2026-10-14 的规则（原话要点）：
 *   「我以后直接写到文件里面的东西：**先过筛选**（本来就有对我的输出规定），
 *     然后如果出现**过长、时间不明**（这些原本的提示词里面有提）**再叫她**；
 *     **群聊里的东西就直接叫她**。」
 * 对照 `info/original-requirements.md` 第 9~11 条：
 *   字数少 → 原样复制；字数较多 → 总结；**过长 或 没有 HW/To Do 栏目 → 先问主人**
 *
 * 所以这个脚本干的是**确定性的那部分**（不需要模型）：
 *   · 读「收件箱」（主人手写）里**没处理过**的行
 *   · 判断：带明确标记（#/作业/待办/要交）**或**（≤25 字且认得出科目）→ 本地直接建待办
 *     （科目识别 A3、DDL 推断 A5、去重合并 A2 全是本地纯计算，见 core/*.ts）
 *   · **超过 25 字** 或 **时间不明**（没写日期钟点、且按课表也推不出下一节）→ **不建**，
 *     记进 `leftForModel`，交给模型（那才需要花 token）
 *   · 处理掉的按指纹记账（不会重复处理）
 *   · 顺手刷新三份给人看的文件（也是本地渲染）
 *
 * 副作用（**会写磁盘**）：`dataDir/tasks.json`、`inbox-ledger.json`、
 *   以及输出目录里的 今日提醒.md / 待办总览.md / 本周安排.md。
 *   `--dry-run` 时**什么都不写**（只报告它打算做什么）。
 *
 * 用法：
 *   node info/local-process.mjs --dry-run     # 只看它打算干什么（安全）
 *   node info/local-process.mjs                # 真跑（建待办 + 刷文件）
 *   node info/local-process.mjs --json         # 给 agent-loop 看的机器可读输出
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 2026-10-20：不再写死开发机路径 —— 发布版用环境变量指过去（缺省值仍是开发机，行为零变化）
const ROOT = process.env.DSH_PROJECT_ROOT || 'AURORA_DATA web/DSH-PROJECT'
// ⚠️ Windows 上动态 import 必须是 file:// URL（绝对路径会被当成协议），
//    而且路径里有空格，必须交给 URL 去编码起来。踩过。
const lib = (name) => new URL(`packages/study-core/lib/src/core/${name}`, pathToFileURL(`${ROOT}/`)).href

const { loadRules } = await import(lib('rules.js'))
const { parseTimetable } = await import(lib('timetable.js'))
const { parseSelfStudy } = await import(lib('selfstudy.js'))
const { readXlsxFile } = await import(lib('xlsx.js'))
const { TaskStore } = await import(lib('store.js'))
const { createTask } = await import(lib('tasks.js'))
const { resolveSubject } = await import(lib('subjects.js'))
const { inferDueAt } = await import(lib('ddl.js'))
const { InboxLedger, readInbox } = await import(lib('inbox.js'))
const { buildDailyBrief } = await import(lib('brief.js'))
const { renderTasksOverview, writeReports } = await import(lib('report.js'))
const { loadNotices } = await import(lib('notices.js'))
const { buildAgenda } = await import(lib('agenda.js'))
const { formatIsoWithOffset, formatLocalDate } = await import(lib('datetime.js'))

// ── 参数（默认值和 cordis.patch.yml 保持一致）────────────────────────────────

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const DRY = flag('dry-run')
const AS_JSON = flag('json')
const MAX_CHARS = Number.parseInt(opt('max-chars', '25'), 10)
const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const DATA_ROOT = process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const RULES = opt('rules', `${DATA_ROOT}/mystery/DSH/study-rules.txt`)
const DATA = opt('data', `${DATA_ROOT}/_study-core`)
const TIMETABLE = opt('timetable', `${G10}/z-info/高一课表20261008.xlsx`)
const CLASS_ID = opt('class', '111A')

const now = new Date()
const { rules, found } = loadRules(RULES)
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

const inboxPath = opt('inbox', join(DATA, '收件箱.txt'))
const ledger = InboxLedger.open(DATA)
const inbox = readInbox(inboxPath, ledger.processed)

const created = []
const wouldCreate = []
const leftForModel = []
const notes = []

/** 建一条待办（刻意和 index.ts 的 addTaskCore 保持同一套规则） */
function addTask(store, text, ref) {
  const resolved = resolveSubject(text)
  const subjectId = resolved.subjectId
  let dueAt
  let dueSource = 'none'
  let dueConfidence = 'low'
  let dueBasis
  let inferrable = false
  if (subjectId !== undefined && timetable !== undefined) {
    const inference = inferDueAt({
      timetable,
      subjectId,
      now,
      courseChoices: rules.courseChoices,
      deadlineTime: rules.ddlTime,
      daysBefore: rules.ddlDaysBefore,
    })
    if (inference.dueAt !== undefined) {
      dueAt = inference.dueAt
      dueSource = 'inferred'
      dueConfidence = inference.confidence
      dueBasis = inference.basis
      inferrable = true
    }
  }
  const task = createTask(
    {
      title: text,
      subjectId,
      dueAt,
      dueSource,
      dueConfidence,
      dueBasis,
      source: { kind: 'manual', ref, capturedAt: formatIsoWithOffset(now) },
      rawSnippets: [text],
    },
    now,
  )
  const outcome = store.upsert(task, { threshold: rules.dedupeThreshold, now })
  return { outcome, subjectId, inferrable }
}

/** 判断一行该本地处理，还是留给模型 */
function classify(item) {
  const text = item.text
  const marked = item.marker === 'task' || /^(#|作业|待办|要交)/.test(item.raw.trim())
  const resolved = resolveSubject(text)
  const hasSubject = resolved.subjectId !== undefined
  // 「时间不明」：没写日期/钟点 → 由 A5 能不能推出来决定（推不出来就是时间不明）
  const hasExplicitTime = /(\d{1,2}\s*[:：]\s*\d{2})|(\d{1,2}\s*月\s*\d{1,2})|(周[一二三四五六日天])/.test(text)

  if (text.length > MAX_CHARS) {
    return { local: false, why: `超过 ${MAX_CHARS} 字（要总结/可能没 HW 栏目 → 按规矩先问主人）` }
  }
  if (marked) {
    return { local: hasSubject, why: hasSubject ? '带明确标记 + 认得出科目' : '带明确标记但认不出科目（留给模型/问主人）' }
  }
  if (hasSubject && hasExplicitTime) return { local: true, why: '认得出科目 + 看得出时间' }
  if (hasSubject) return { local: true, why: `认得出科目、${MAX_CHARS} 字以内（DDL 交给 A5 按课表推）` }
  return { local: false, why: '认不出科目（要判断是不是作业 → 留给模型）' }
}

// ⚠️ store 必须**无条件**打开（哪怕这次没有新条目）—— 因为后面刷新三份文件要读它。
//    一开始写成"有条目才打开"，导致非干跑时 store 是 undefined → 刷文件那步报错。
let store
if (!DRY) store = TaskStore.open(DATA)

for (const item of inbox.items) {
  const verdict = classify(item)
  if (!verdict.local) {
    leftForModel.push({ line: item.line, text: item.text, why: verdict.why })
    continue
  }
  if (DRY) {
    // ⚠️ 干跑时**不能**把它算进"留给模型" —— 它其实是本地能处理的，
    //    只是干跑不写磁盘而已（一开始写错了，会让 agent-loop 误以为要叫模型）。
    wouldCreate.push({ line: item.line, text: item.text, why: verdict.why })
    continue
  }
  try {
    const { outcome, subjectId, inferrable } = addTask(store, item.text, `收件箱第 ${item.line} 行`)
    created.push({
      line: item.line,
      title: item.text,
      action: outcome.action,
      subject: subjectId ?? '(未识别)',
      due: outcome.task.dueAt ?? '(无)',
      why: verdict.why,
    })
    if (!inferrable) notes.push(`第 ${item.line} 行：科目认出来了但按课表推不出下一节 → 截止时间留空（时间不明）`)
  } catch (cause) {
    leftForModel.push({ line: item.line, text: item.text, why: `建待办失败：${cause.message}` })
  }
}

// ── 刷新三份给人看的文件（本地渲染，不叫模型）────────────────────────────────

let written = []
if (!DRY) {
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
  // 2026-10-22：通知写进「本周安排」（浮窗的「通知」窗读它）
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
  written = result.written.map((f) => f.path)
  for (const issue of result.issues) notes.push(issue)
  // 处理掉的记账
  if (created.length > 0) {
    const byLine = new Map(inbox.items.map((i) => [i.line, i.fingerprint]))
    ledger.markProcessed(created.map((c) => byLine.get(c.line)).filter(Boolean))
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────────

if (AS_JSON) {
  console.log(JSON.stringify({ dryRun: DRY, rulesFound: found, read: inbox.items.length, created, wouldCreate, leftForModel, written, notes }))
} else {
  console.log(`本地处理${DRY ? '（--dry-run，什么都没写）' : ''}：收件箱有 ${inbox.items.length} 条新的`)
  console.log(`规则文件：${found ? '读到' : '没读到（用内置默认值）'}  ${RULES}`)
  if (DRY && wouldCreate.length > 0) {
    console.log(`\n[干跑] 本地会建 ${wouldCreate.length} 条（真跑时不花 token）：`)
    for (const c of wouldCreate) console.log(`  · 第 ${c.line} 行 ${c.text}  ← ${c.why}`)
  }
  if (created.length > 0) {
    console.log(`\n本地建了 ${created.length} 条待办（**没花 token**）：`)
    for (const c of created) console.log(`  · 第 ${c.line} 行 [${c.action}] ${c.subject} · ${c.due} · ${c.title}  ← ${c.why}`)
  } else {
    console.log('\n没有可以本地处理的（都是「过长 / 时间不明 / 认不出科目」或没有新内容）。')
  }
  if (leftForModel.length > 0) {
    console.log(`\n留给模型的 ${leftForModel.length} 条（这些才需要花 token）：`)
    for (const l of leftForModel) console.log(`  · 第 ${l.line} 行 ${l.text}  ← ${l.why}`)
  }
  for (const n of notes) console.log(`注意：${n}`)
  if (written.length > 0) console.log(`\n已刷新：${written.join('、')}`)
}
