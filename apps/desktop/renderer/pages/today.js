/**
 * apps\desktop\renderer\pages\today.js —— 「今日」页（2026-10-22 晚，P1）
 *
 * 数据来自 `info\brief-json.mjs`（study-core 的 buildDailyBrief），结构化的：
 *   { date, weekdayZh, isSchoolDay, sections:[{heading, lines}], tasksOverdue, reminders, … }
 *
 * 刻意做的两件事：
 *   ① 段落顺序、标题、文字**完全照数据来**（不在前端另起一套说法）
 *   ② 「已经迟了」这类段落给个警示色 —— 一眼能看出要命的那几条
 */

import { h, clear, todayLocal } from './dom.js'

const WARN_SECTIONS = /迟|要确认|注意/

/**
 * 今天的进度条（主人 2026-10-25：「每日进度的可以像同学的项目加上一个进度条」）
 * 分子/分母 = 今天到期的任务（status 不是 dropped）；今天的没有了就直说"今天没排任务"。
 */
function progressBlock(data) {
  const list = Array.isArray(data.taskList) ? data.taskList : []
  const todayStr = todayLocal()
  const todays = list.filter((t) => String(t.dueDate || '') === todayStr && String(t.status) !== 'dropped')
  const done = todays.filter((t) => String(t.status) === 'done')
  const late = list.filter((t) => t.overdue && String(t.status || 'open') !== 'done')
  const left = todays.length - done.length
  const pct = todays.length > 0 ? Math.round((done.length / todays.length) * 100) : 0

  const box = h('div', 'her-progress')
  box.dataset.done = String(done.length)
  box.dataset.total = String(todays.length)
  const head = h('div', 'her-progress-head')
  head.appendChild(h('span', 'her-progress-title', todays.length > 0 ? `今天 ${done.length}/${todays.length} 条做完` : '今天没排任务'))
  head.appendChild(h('span', 'her-progress-pct', todays.length > 0 ? `${pct}%` : '—'))
  box.appendChild(head)
  const bar = h('div', 'her-progress-bar')
  const fill = h('span', 'her-progress-fill')
  fill.style.width = `${todays.length > 0 ? Math.max(2, pct) : 0}%`
  bar.appendChild(fill)
  box.appendChild(bar)
  const bits = []
  if (late.length > 0) bits.push(`迟了 ${late.length} 条`)
  if (left > 0) bits.push(`今天还剩 ${left} 条`)
  if (bits.length > 0) box.appendChild(h('div', 'her-progress-sub', bits.join(' · ')))
  return box
}

/** 通知（2026-10-25：今日页也来一块；和日历页同一份数据，两处显示） */
function noticeBlock(data) {
  const list = Array.isArray(data.notices) ? data.notices.filter((n) => n && n.text) : []
  if (list.length === 0) return null
  const frag = document.createDocumentFragment()
  const head = h('div', 'her-sec-h', `通知（${list.length}）`)
  head.dataset.todayNotices = String(list.length)
  frag.appendChild(head)
  for (const n of list) frag.appendChild(h('div', 'her-line', (n.date ? n.date + '　' : '') + String(n.text)))
  return frag
}

/**
 * 今天做完了 N 条（主人 2026-10-24 · Tevela A：「今日任务完成情况」）
 * 数据是 tasks 现算的（app.js 的 LOADERS.today 顺手把任务一起取回来），不看缓存。
 * 「做完」的判据：status = done 且 dueDate 是今天 —— 跟任务页「已完成」那一组同一套口径。
 */
function doneTodayBlock(data) {
  const frag = document.createDocumentFragment()
  const list = Array.isArray(data.taskList) ? data.taskList : []
  const todayStr = todayLocal()
  const done = list.filter((t) => String(t.status) === 'done' && String(t.dueDate || '') === todayStr)
  const left = list.filter((t) => String(t.status || 'open') !== 'done' && String(t.dueDate || '') === todayStr)

  const head = h('div', 'her-sec-h', `今天做完了 ${done.length} 条`)
  head.dataset.doneToday = String(done.length)
  frag.appendChild(head)
  if (data.tasksOk === false) {
    frag.appendChild(h('div', 'her-line her-line-warn', '任务数据没读到，这块可能不准。'))
    return frag
  }
  if (done.length === 0) {
    frag.appendChild(h('div', 'her-line', '今天还没有勾掉的 —— 在「任务」页勾一下，这里就会算进去。'))
  } else {
    for (const t of done) {
      frag.appendChild(h('div', 'her-line her-line-done', (t.subjectName ? t.subjectName + ' · ' : '') + String(t.title || '(没写标题)')))
    }
  }
  if (left.length > 0) {
    frag.appendChild(h('div', 'her-line her-line-warn', `今天还有 ${left.length} 条没做完（去「任务」页看）。`))
  }
  return frag
}

export function renderToday(el, data, ctx) {
  clear(el)
  const today = data.mock ? data.date : null

  // 开头那行：星期几 + 上课/放假
  const lead = h('div', 'her-lead')
  lead.appendChild(h('span', 'her-badge-day', data.weekdayZh || data.date || '今天'))
  if (data.date && data.weekdayZh) lead.appendChild(h('span', null, data.date))
  lead.appendChild(
    h('span', data.isSchoolDay === false ? 'her-badge-rest' : 'her-badge-day', data.isSchoolDay === false ? '放假' : '上课日'),
  )
  el.appendChild(lead)

  // 进度条（先看今天做到哪）
  el.appendChild(progressBlock(data))

  // 今天做完了 N 条（放最上面：一打开今日页就知道今天干成多少）
  el.appendChild(doneTodayBlock(data))

  const sections = Array.isArray(data.sections) ? data.sections : []
  if (sections.length === 0) {
    const note = h('div', 'her-note')
    note.textContent = data.markdown
      ? '今天这份是纯文本，先按原文贴上来（读不到段落结构）。'
      : '今天没有提醒内容（可能是数据没同步）。'
    el.appendChild(note)
    if (data.markdown) {
      for (const line of String(data.markdown).split(/\r?\n/)) {
        if (!line.trim()) continue
        el.appendChild(h('div', 'her-line', line))
      }
    }
    return
  }

  const checked = new Set(Array.isArray(data.checkedMaterials) ? data.checkedMaterials.map((s) => String(s)) : [])
  for (const sec of sections) {
    const heading = String(sec.heading || '')
    el.appendChild(h('div', 'her-sec-h', heading))
    const warn = WARN_SECTIONS.test(heading)
    // 2026-10-23：主人要「今日里面要带的」和待办一样能勾（勾=今天带了/准备好了）
    const isCarry = /携带|要带/.test(heading)
    for (const line of sec.lines || []) {
      const text = String(line)
      if (isCarry && typeof ctx.onCheck === 'function') {
        const row = h('div', 'her-line her-line-check' + (checked.has(text) ? ' her-line-done' : ''))
        const cb = h('button', 'her-check')
        cb.type = 'button'
        cb.title = checked.has(text) ? '点一下取消' : '点一下勾掉（今天带了）'
        cb.dataset.material = text
        if (checked.has(text)) cb.style.background = 'rgba(var(--good), .85)'
        cb.addEventListener('click', async (e) => {
          e.stopPropagation()
          const wasDone = row.classList.contains('her-line-done')
          row.classList.toggle('her-line-done', !wasDone)
          cb.style.background = !wasDone ? 'rgba(var(--good), .85)' : ''
          const ok = await ctx.onCheck(text, (success) => {
            if (!success) {
              row.classList.toggle('her-line-done', wasDone)
              cb.style.background = wasDone ? 'rgba(var(--good), .85)' : ''
            }
          })
          void ok
        })
        row.appendChild(cb)
        row.appendChild(h('span', 'her-line-text', text))
        el.appendChild(row)
        continue
      }
      el.appendChild(h('div', 'her-line' + (warn ? ' her-line-warn' : ''), text))
    }
  }

  // 底部：需要主人确认的事（如果有，且没被段落覆盖）
  const reminders = Array.isArray(data.reminders) ? data.reminders.filter(Boolean) : []
  const hasReminderSection = sections.some((s) => /确认|注意/.test(String(s.heading || '')))
  if (reminders.length > 0 && !hasReminderSection) {
    el.appendChild(h('div', 'her-sec-h', '要确认'))
    for (const r of reminders) el.appendChild(h('div', 'her-line her-line-warn', '· ' + r))
  }

  // 通知（2026-10-25：主人要把通知也搬到今日页；日历页那份照旧）
  const nb = noticeBlock(data)
  if (nb) el.appendChild(nb)

  if (data.rulesFound === false || data.timetableFound === false) {
    const note = h('div', 'her-note')
    note.textContent =
      (data.rulesFound === false ? '规则文件没找到；' : '') + (data.timetableFound === false ? '课表文件没找到（所以今天没课）。' : '')
    el.appendChild(note)
  }
  if (ctx && ctx.mock) {
    const note = h('div', 'her-note')
    note.textContent = '这是假数据（截图 / 自检用）。'
    el.appendChild(note)
  }
  void today
}
