/**
 * apps\desktop\renderer\pages\calendar.js —— 「日历」页（2026-10-22 晚，P2）
 *
 * 两块东西：
 *   ① 月历（自己画，七天一行）：格子里有 DDL 小圆点（迟了的那天用警示色）
 *   ② 点某一天 → 下面出「那天有什么」：课（时间/教室）、要交的、要带的东西
 *
 * 数据：`agenda-json.mjs`（接下来 N 天的结构化安排）+ `study-lite --list`（整月 DDL 角标）。
 * 月历翻页只用本地计算，不重新读盘；"回到今天"同理。
 */

import { h, clear } from './dom.js'

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

const state = { monthOffset: 0, selected: null, lastData: null, lastCtx: null }

const pad2 = (v) => String(v).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
/** '2026-10-19' → '10/19'（每周计划那块用，短） */
const md = (s) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(s || ''))
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(s || '')
}

/** 迟了的日子（只按日期，不按时间） */
function todayLocal() {
  return ymd(new Date())
}

function tasksByDate(tasks) {
  const map = new Map()
  for (const t of tasks || []) {
    if (!t || !t.dueDate) continue
    if (String(t.status || 'open') === 'done' || String(t.status) === 'dropped') continue
    if (!map.has(t.dueDate)) map.set(t.dueDate, [])
    map.get(t.dueDate).push(t)
  }
  return map
}

function buildMonth(offset) {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const year = first.getFullYear()
  const month = first.getMonth()
  const firstWeekday = (first.getDay() + 6) % 7 // 周一 = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d))
  while (cells.length % 7 !== 0) cells.push(null)
  return { year, month, cells }
}

export function renderCalendar(el, payload, ctx) {
  state.lastData = payload
  state.lastCtx = ctx || {}
  if (state.selected === null) state.selected = todayLocal()
  paint(el)
}

function paint(el) {
  const payload = state.lastData || {}
  const agenda = payload.agenda || {}
  const tasks = payload.tasks && Array.isArray(payload.tasks.tasks) ? payload.tasks.tasks : []
  const byDate = tasksByDate(tasks)
  const agendaDays = new Map()
  for (const d of agenda.days || []) agendaDays.set(d.date, d)
  const today = todayLocal()

  clear(el)

  // ── 本周计划（2026-10-24 · Tevela E）：日历最上面一块 ──────────────────────
  paintWeekly(el, el, payload.weekly)

  // ── 月历头 ────────────────────────────────────────────────────────────────
  const { year, month, cells } = buildMonth(state.monthOffset)
  const head = h('div', 'her-cal-head')
  const prev = h('button', 'her-ico', '‹')
  prev.type = 'button'
  prev.title = '上个月'
  const title = h('div', 'her-cal-title', `${year} 年 ${month + 1} 月`)
  const next = h('button', 'her-ico', '›')
  next.type = 'button'
  next.title = '下个月'
  const back = h('button', 'her-tab', '回到今天')
  back.type = 'button'
  prev.addEventListener('click', () => {
    state.monthOffset -= 1
    paint(el)
  })
  next.addEventListener('click', () => {
    state.monthOffset += 1
    paint(el)
  })
  back.addEventListener('click', () => {
    state.monthOffset = 0
    state.selected = today
    paint(el)
  })
  head.append(prev, title, next, back)
  el.appendChild(head)

  // ── 星期行 + 格子 ─────────────────────────────────────────────────────────
  const grid = h('div', 'her-cal-grid')
  for (const w of WEEK) grid.appendChild(h('div', 'her-cal-wd', w))
  for (const cell of cells) {
    if (!cell) {
      grid.appendChild(h('div', 'her-cal-cell her-cal-out'))
      continue
    }
    const date = ymd(cell)
    const due = byDate.get(date) || []
    const overdueHere = due.some((t) => t.overdue || (t.dueDate && t.dueDate < today))
    const cls =
      'her-cal-cell' +
      (date === today ? ' her-cal-today' : '') +
      (date === state.selected ? ' her-cal-sel' : '')
    const c = h('div', cls)
    c.dataset.date = date
    c.appendChild(h('div', 'her-cal-day', String(cell.getDate())))
    const marks = h('div', 'her-cal-marks')
    for (let i = 0; i < Math.min(due.length, 4); i++) {
      marks.appendChild(h('div', 'her-cal-dot' + (overdueHere ? ' her-cal-dot-overdue' : '')))
    }
    if (marks.childNodes.length > 0) c.appendChild(marks)
    c.addEventListener('click', () => {
      state.selected = date
      paint(el)
    })
    grid.appendChild(c)
  }
  el.appendChild(grid)

  // ── 选中那天的详情 ────────────────────────────────────────────────────────
  const sel = state.selected
  const day = agendaDays.get(sel)
  const selDate = new Date(`${sel}T00:00:00`)
  const wd = Number.isNaN(selDate.getTime()) ? '' : '周' + WEEK[(selDate.getDay() + 6) % 7]
  el.appendChild(h('div', 'her-cal-day-h', `${sel} ${wd}${sel === today ? '（今天）' : ''}`))

  const dayTasks = byDate.get(sel) || []
  if (day && day.isSchoolDay === false && day.items.length === 0 && dayTasks.length === 0) {
    el.appendChild(h('div', 'her-empty', '这天没课，也没有要交的。'))
  } else if (day) {
    for (const item of day.items) {
      const row = h('div', 'her-cal-item')
      row.appendChild(h('span', 'her-cal-time', item.time || '—'))
      const label = item.label + (item.room ? `　${item.room}` : '')
      row.appendChild(h('span', null, label))
      el.appendChild(row)
    }
  } else if (agendaDays.size > 0) {
    el.appendChild(
      h('div', 'her-note', '这一天不在「接下来几天」的范围里，只显示待办角标（翻回本周能看课程）。'),
    )
  }

  if (dayTasks.length > 0) {
    el.appendChild(h('div', 'her-sec-h her-sec-split', `要交（${dayTasks.length}）`))
    for (const t of dayTasks) {
      const row = h('div', 'her-cal-item')
      row.appendChild(h('span', 'her-cal-time', t.dueTime || '—'))
      row.appendChild(h('span', null, [t.subjectName, t.title].filter(Boolean).join(' · ')))
      el.appendChild(row)
    }
  }

  // ── 通知（可撤掉一条）────────────────────────────────────────────────────
  const noticeList = Array.isArray(agenda.noticeList) ? agenda.noticeList : []
  if (noticeList.length > 0) {
    el.appendChild(h('div', 'her-sec-h her-sec-split', `通知（${noticeList.length}）`))
    for (const n of noticeList) {
      const row = h('div', 'her-notice')
      const text = h('span', null, (n.date ? n.date + '　' : '') + n.text)
      row.appendChild(text)
      const x = h('button', 'her-notice-x', '×')
      x.type = 'button'
      x.title = ctx_isMock() ? '假数据不能撤' : '撤掉这条通知'
      x.addEventListener('click', async () => {
        if (ctx_isMock()) return
        try {
          const r = await window.herShell.act('notice-remove', n.id)
          if (r && r.ok !== false) {
            state.lastData.agenda.noticeList = noticeList.filter((k) => k.id !== n.id)
            paint(el)
          }
        } catch {}
      })
      row.appendChild(x)
      el.appendChild(row)
    }
  }

  // ── 结尾的小实话 ─────────────────────────────────────────────────────────
  const notes = []
  if (agenda.ok === false) notes.push('本周安排没读到：' + (agenda.error || '未知原因'))
  if (payload.tasks && payload.tasks.ok === false) notes.push('待办没读到：' + (payload.tasks.error || '未知原因'))
  if (payload.agenda && payload.agenda.mock) notes.push('这是假数据（截图 / 自检用）。')
  if (notes.length > 0) {
    const box = h('div', 'her-note')
    box.textContent = notes.join('；')
    el.appendChild(box)
  }
}

function ctx_isMock() {
  const a = (state.lastData && state.lastData.agenda) || {}
  const t = (state.lastData && state.lastData.tasks) || {}
  return !!(a.mock || t.mock)
}

/**
 * 本周计划（2026-10-24 · 主人点名批次 1.5，借 Tevela E）
 * 一条目标 = 一个能勾的行；加一条就回车。换周不删东西（上一周的目标留在它那一格里 = 按周归档）。
 */
function paintWeekly(host, el, weekly) {
  if (!weekly || weekly.ok === false || !weekly.current) return
  const wk = weekly.current
  const doneN = wk.goals.filter((g) => g.done).length
  const box = h('section', 'her-group her-weekly')
  const head = h('div', 'her-week-h')
  head.appendChild(h('span', null, `本周计划　${md(wk.start)} – ${md(wk.end)}`))
  head.appendChild(h('span', 'her-group-n', `${doneN}/${wk.goals.length}`))
  box.appendChild(head)

  const redraw = (next) => {
    if (next) state.lastData.weekly = next
    paint(el)
  }

  if (wk.goals.length === 0) {
    box.appendChild(h('div', 'her-note', '这一周还没写目标 —— 下面写一句、回车就加上。'))
  }
  for (const g of wk.goals) {
    const row = h('div', 'her-line her-line-check her-week-goal' + (g.done ? ' her-line-done' : ''))
    row.dataset.weekGoal = g.id
    const cb = h('button', 'her-check')
    cb.type = 'button'
    cb.title = g.done ? '点一下取消（还没做）' : '点一下勾掉（这一周做完了）'
    if (g.done) cb.style.background = 'rgba(var(--good, 120 220 160), .85)'
    cb.addEventListener('click', async (e) => {
      e.stopPropagation()
      cb.disabled = true
      try {
        const r = await window.herShell.act('weekly-toggle', g.id)
        if (r && r.ok !== false) redraw(r)
      } catch {}
      cb.disabled = false
    })
    row.appendChild(cb)
    row.appendChild(h('span', 'her-line-text', g.text))
    const x = h('button', 'her-notice-x', '×')
    x.type = 'button'
    x.title = '删掉这一条'
    x.addEventListener('click', async (e) => {
      e.stopPropagation()
      x.disabled = true
      try {
        const r = await window.herShell.act('weekly-remove', g.id)
        if (r && r.ok !== false) redraw(r)
      } catch {}
      x.disabled = false
    })
    row.appendChild(x)
    box.appendChild(row)
  }

  const addRow = h('div', 'her-slider-row')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'her-input'
  input.id = 'her-weekly-input'
  input.placeholder = '这一周想做成什么（回车加上）'
  const addBtn = h('button', 'her-chip her-chip-send', '加上')
  addBtn.type = 'button'
  addBtn.id = 'her-weekly-add'
  const submit = async () => {
    const text = String(input.value || '').trim()
    if (!text) {
      input.focus()
      return
    }
    addBtn.disabled = true
    try {
      const r = await window.herShell.act('weekly-add', text)
      if (r && r.ok !== false) {
        input.value = ''
        redraw(r)
      } else {
        addBtn.textContent = '没加上：' + ((r && r.error) || '')
      }
    } catch (err) {
      addBtn.textContent = '没加上：' + ((err && err.message) || err)
    } finally {
      addBtn.disabled = false
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    }
  })
  addBtn.addEventListener('click', () => void submit())
  addRow.append(input, addBtn)
  box.appendChild(addRow)

  if (Array.isArray(weekly.past) && weekly.past.length > 0) {
    const arch = weekly.past
      .slice(0, 3)
      .map((w) => `${md(w.start)}–${md(w.end)}（${w.done}/${w.total}）`)
      .join('　')
    box.appendChild(h('div', 'her-week-arch', '往周归档：' + arch))
  }
  if (weekly.mock) box.appendChild(h('div', 'her-note', '这是假数据（截图 / 自检用）。'))
  host.appendChild(box)
}
