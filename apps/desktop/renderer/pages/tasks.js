/**
 * apps\desktop\renderer\pages\tasks.js —— 「任务」页（2026-10-24：每条一个框 + 点进详情 + 按科目看）
 *
 * 数据来自 `info\study-lite.mjs --list`（和旧浮窗同一套）：
 *   { tasks:[{id,title,kind,status,subjectName,dueDate,dueTime,overdue,createdAt}], warnings }
 *
 * 分组（顺序就是"该先看什么"）：已经迟了 → 今天 → 接下来（7 天内）→ 其它 → 已完成
 * 主人 2026-10-24：「每个项都加上边框，点击可以进入更详细的页面」
 *   → 每条 = 一个 `.her-item` 框（勾选框 + 标题 + 徽章），点框 → 详情浮层（完整信息 + 勾掉/撤销）。
 *   ⚠️ 勾选框自己 stopPropagation，点勾选框不会开详情。
 *
 * 主人 2026-10-24 晚（Tevela C）：「按科目分类找」→ 顶上一个切换：
 *   「按时间」= 迟了/今天/接下来/其它（原来的样子）；「按科目」= 一门课一组。
 *   科目**从数据里现取**（`subjectName`），没写科目的归到「没写科目」。
 */

import { h, clear, humanDate, todayLocal } from './dom.js'
import { openSheet, closeSheet, sheetRow, sheetHead } from './sheet.js'

const KIND_LABEL = { homework: '作业', todo: '自己记的' }

/** 这页自己的状态：分组维度（时间 / 科目）。换页再回来还记着上次选的。 */
const view = { by: 'time' }

function sortKey(t) {
  if (!t.dueDate) return '9999-99-99'
  return t.dueDate + ' ' + (t.dueTime || '99:99')
}

/** 一门课在"按科目"里的排序权：迟了最多 → 越靠前（用得上的先看） */
function subjectStats(items) {
  const overdue = items.filter((t) => t.overdue).length
  const soonest = items.map(sortKey).sort()[0] || '9999-99-99'
  return { overdue, soonest }
}

/** 一条任务的详情浮层 */
function openTaskSheet(task, ctx, rowNode) {
  const done = String(task.status || 'open') === 'done'
  const when = task.dueDate ? `${humanDate(task.dueDate, todayLocal())}${task.dueTime ? ' ' + task.dueTime : ''}` : '没写 DDL'
  const actions = []
  if (task.id) {
    actions.push({
      label: done ? '撤销（改回没做完）' : '勾掉（做完了）',
      primary: !done,
      title: '跟列表里那个勾选框是同一件事（会真的写回 tasks.json）',
      onClick: async (btn) => {
        btn.disabled = true
        btn.textContent = '正在写…'
        const ok = ctx && typeof ctx.onToggle === 'function' ? await ctx.onToggle(task.id, rowNode, () => {}) : false
        btn.textContent = ok ? '写好了' : '没写成'
        // 写完自动回列表（列表那边会刷新）
        if (ok) setTimeout(() => openSheetWrapSheet(), 300)
        else btn.disabled = false
      },
    })
  }
  openSheet({
    title: task.title || '(没写标题)',
    subtitle: `${task.subjectName || '没写科目'} · ${KIND_LABEL[task.kind] || task.kind || '任务'}`,
    badge: done ? '已完成' : task.overdue ? '迟了' : '',
    actions,
    build: (body) => {
      body.appendChild(sheetHead('什么时候'))
      body.appendChild(sheetRow('截止', when))
      if (task.dueDate) body.appendChild(sheetRow('日期', task.dueDate))
      if (task.overdue && !done) body.appendChild(sheetRow('状态', '已经过点了（列表里标红就是这条）'))
      else body.appendChild(sheetRow('状态', done ? '已完成' : '没做完'))
      body.appendChild(sheetHead('这是哪一条'))
      body.appendChild(sheetRow('科目', task.subjectName || '—'))
      body.appendChild(sheetRow('类型', KIND_LABEL[task.kind] || task.kind || '—'))
      if (task.id) body.appendChild(sheetRow('id', task.id))
      if (task.createdAt) body.appendChild(sheetRow('记下来', String(task.createdAt).slice(0, 16).replace('T', ' ')))
      if (task.raw) {
        body.appendChild(sheetHead('原文'))
        body.appendChild(sheetRow('', task.raw))
      }
    },
    footer: '这一条来自你的任务数据（tasks.json）；勾掉会写回去，不是只在界面上变。',
  })
}

/** 详情里点"勾掉"以后要回到列表（刷新由 app.js 那边做，这里只负责收浮层） */
function openSheetWrapSheet() {
  // openSheet 会自动先关旧的
  void 0
}

function itemEl(task, ctx, group) {
  const done = String(task.status || 'open') === 'done'
  const item = h('div', 'her-item' + (done ? ' her-item-done' : '') + (task.overdue && !done ? ' her-item-late' : ''))
  item.dataset.taskId = task.id || ''
  item.dataset.group = group
  item.tabIndex = 0
  item.title = '点一下看这条的详情'

  const cb = h('button', 'her-check')
  cb.type = 'button'
  cb.title = done ? '点一下撤销（改回未完成）' : '点一下勾掉'
  cb.dataset.taskId = task.id || ''
  cb.addEventListener('click', async (e) => {
    e.stopPropagation()
    const wasDone = item.classList.contains('her-item-done')
    // 先动界面，写盘回来再确认（点一下要立刻有反应）
    item.classList.toggle('her-item-done', !wasDone)
    item.classList.toggle('her-row-done', !wasDone)
    const ok =
      ctx && typeof ctx.onToggle === 'function'
        ? await ctx.onToggle(task.id, item, (success, msg) => {
            if (!success) {
              item.classList.toggle('her-item-done', wasDone)
              item.classList.toggle('her-row-done', wasDone)
              item.title = msg || '没写成'
            }
          })
        : false
    void ok
  })
  item.appendChild(cb)

  const main = h('div', 'her-item-main')
  main.appendChild(h('div', 'her-item-title', task.title || '(没写标题)'))

  const meta = h('div', 'her-item-meta')
  if (task.subjectName) meta.appendChild(h('span', 'her-pill', task.subjectName))
  if (task.kind) {
    meta.appendChild(h('span', 'her-pill' + (task.kind === 'homework' ? ' her-pill-homework' : ''), KIND_LABEL[task.kind] || task.kind))
  }
  if (task.overdue && !done) meta.appendChild(h('span', 'her-pill her-pill-overdue', '迟了'))
  else if (task.dueDate) {
    const when = humanDate(task.dueDate, todayLocal()) + (task.dueTime ? ' ' + task.dueTime : '')
    meta.appendChild(h('span', 'her-pill', when))
  }
  if (meta.childNodes.length > 0) main.appendChild(meta)
  item.appendChild(main)

  const arrow = h('span', 'her-item-arrow', '›')
  item.appendChild(arrow)

  item.addEventListener('click', () => openTaskSheet(task, ctx, item))
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openTaskSheet(task, ctx, item)
    }
  })
  return item
}

/** 一个分组：外面一个框（`.her-group`），里面几条 `.her-item` */
function groupEl(label, items, ctx, groupKey, extra) {
  const box = h('section', 'her-group')
  const head = h('div', 'her-group-h')
  head.appendChild(h('span', 'her-group-label', label))
  head.appendChild(h('span', 'her-group-n', String(items.length)))
  box.appendChild(head)
  for (const t of items) box.appendChild(itemEl(t, ctx, groupKey))
  if (extra) box.appendChild(extra)
  return box
}

/** 「按时间 / 按科目」那个切换（这页的最上面一条）+ 「＋新增」 */
function groupBySwitch(el, counts, ctx) {
  const row = h('div', 'her-chips her-groupby')
  row.dataset.by = view.by
  const mk = (key, label, n) => {
    const b = h('button', 'her-chip' + (view.by === key ? ' her-chip-on' : ''), `${label}（${n}）`)
    b.type = 'button'
    b.dataset.by = key
    b.title = key === 'time' ? '迟了 / 今天 / 接下来 / 其它' : '一门课一组（科目从数据里现取）'
    b.addEventListener('click', (e) => {
      e.preventDefault()
      if (view.by === key) return
      view.by = key
      // 重画这一块：拿回上一次的数据（页面不碰文件，只重画）
      if (row.__redraw) row.__redraw()
    })
    row.appendChild(b)
    return b
  }
  mk('time', '按时间', counts.open)
  mk('subject', '按科目', counts.subjects)
  // 主人 2026-10-24 晚（批次 2.2）：不用再跑去收件箱，直接在这儿加一条
  const add = h('button', 'her-chip her-chip-send her-task-add', '＋ 新增')
  add.type = 'button'
  add.id = 'her-task-add'
  add.title = '直接加一条任务（走同一套校验，会真的写进 tasks.json）'
  add.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    openTaskForm(ctx)
  })
  row.appendChild(add)
  return row
}

/** 「＋新增」的表单浮层：标题 / 科目 / 截止 / 备注 */
function openTaskForm(ctx) {
  const titleInput = document.createElement('input')
  titleInput.type = 'text'
  titleInput.className = 'her-input'
  titleInput.id = 'her-task-title'
  titleInput.placeholder = '这条任务叫什么（例：bio WS 第 4 章）'

  const subjectInput = document.createElement('input')
  subjectInput.type = 'text'
  subjectInput.className = 'her-input'
  subjectInput.id = 'her-task-subject'
  subjectInput.placeholder = '科目（可写缩写：bio / econ / 数学）'

  const dueInput = document.createElement('input')
  dueInput.type = 'date'
  dueInput.className = 'her-input'
  dueInput.id = 'her-task-due'

  const timeInput = document.createElement('input')
  timeInput.type = 'time'
  timeInput.className = 'her-input her-input-time'
  timeInput.id = 'her-task-time'
  timeInput.value = '22:00'

  const detailInput = document.createElement('textarea')
  detailInput.className = 'her-textarea'
  detailInput.id = 'her-task-detail'
  detailInput.placeholder = '备注（老师说要写过程 / 交到哪里…可以不填）'

  const submit = {
    label: '存进任务',
    primary: true,
    title: '写进 tasks.json（跟你自己勾掉、收件箱处理是同一份数据）',
    onClick: async (btn) => {
      const title = String(titleInput.value || '').trim()
      if (!title) {
        titleInput.focus()
        btn.textContent = '先写标题'
        return
      }
      btn.disabled = true
      btn.textContent = '正在存…'
      try {
        const r = await window.herShell.act('task-add', {
          title,
          subject: String(subjectInput.value || '').trim(),
          due: String(dueInput.value || '').trim(),
          time: String(timeInput.value || '').trim() || '22:00',
          detail: String(detailInput.value || '').trim(),
        })
        if (r && r.ok !== false) {
          btn.textContent = r.action === 'merged' ? '合并进已有那条了' : '存好了'
          try {
            closeSheet()
          } catch {}
          if (ctx && typeof ctx.refresh === 'function') setTimeout(() => ctx.refresh(), 80)
        } else {
          btn.textContent = '没存成：' + ((r && r.error) || '')
          btn.disabled = false
        }
      } catch (err) {
        btn.textContent = '没存成：' + ((err && err.message) || err)
        btn.disabled = false
      }
    },
  }

  openSheet({
    title: '新增一条任务',
    subtitle: '写进 tasks.json —— 跟勾掉、收件箱处理是同一份数据',
    actions: [submit],
    build: (body) => {
      body.appendChild(sheetHead('叫什么'))
      body.appendChild(titleInput)
      body.appendChild(sheetHead('哪门课（认不出就当自己的 to-do）'))
      body.appendChild(subjectInput)
      const row = h('div', 'her-slider-row')
      row.append(dueInput, timeInput)
      body.appendChild(sheetHead('什么时候交'))
      body.appendChild(row)
      body.appendChild(sheetHead('备注'))
      body.appendChild(detailInput)
      body.appendChild(sheetRow('提示', '不写日期也可以 —— 那就是一条自己的待办。'))
    },
    footer: '真正的写入在 info\\task-add.mjs（study-core 的 createTask + 去重 + 原子写）。',
  })
  setTimeout(() => {
    try {
      titleInput.focus()
    } catch {}
  }, 60)
}

export function renderTasks(el, data, ctx) {
  clear(el)
  const all = Array.isArray(data.tasks) ? data.tasks.slice() : []
  const today = todayLocal()
  const in7 = new Date(`${today}T00:00:00`)
  in7.setDate(in7.getDate() + 7)
  const in7Str = `${in7.getFullYear()}-${String(in7.getMonth() + 1).padStart(2, '0')}-${String(in7.getDate()).padStart(2, '0')}`

  const open = all.filter((t) => String(t.status || 'open') !== 'done' && String(t.status) !== 'dropped')
  const done = all.filter((t) => String(t.status) === 'done')
  open.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))

  // ── 按科目：科目从数据里现取（没写科目的单独一组）────────────────────────────
  const bySubject = new Map()
  for (const t of open) {
    const key = String(t.subjectName || '没写科目')
    if (!bySubject.has(key)) bySubject.set(key, [])
    bySubject.get(key).push(t)
  }
  const subjectGroups = Array.from(bySubject.entries())
    .map(([subject, items]) => Object.assign({ subject, items }, subjectStats(items)))
    .sort((a, b) => b.overdue - a.overdue || String(a.soonest).localeCompare(String(b.soonest)) || a.subject.localeCompare(b.subject))

  // 切换条永远在最上面（自检靠 `.her-groupby` 找它）
  const draw = () => {
    clear(el)
    const sw = groupBySwitch(el, { open: open.length, subjects: subjectGroups.length }, ctx)
    sw.__redraw = draw
    el.appendChild(sw)

    if (view.by === 'subject') {
      if (subjectGroups.length === 0) {
        el.appendChild(h('div', 'her-empty', '没有还没做完的任务 —— 今天可以歇一会儿。'))
      }
      for (const g of subjectGroups) {
        el.appendChild(groupEl(g.subject, g.items, ctx, 'subject:' + g.subject))
      }
      // 做完的也照"按科目"排一遍（勾完还能在自己那门课下面找到，撤销方便）
      const doneSel = h('div', 'her-chips')
      const doneToggle = h('button', 'her-chip', `已完成 ${done.length} 条（点开看）`)
      doneToggle.type = 'button'
      doneToggle.dataset.doneToggle = '1'
      let doneOpen = false
      doneToggle.addEventListener('click', () => {
        doneOpen = !doneOpen
        doneToggle.classList.toggle('her-chip-on', doneOpen)
        if (doneOpen) {
          const doneBy = new Map()
          for (const t of done) {
            const key = String(t.subjectName || '没写科目')
            if (!doneBy.has(key)) doneBy.set(key, [])
            doneBy.get(key).push(t)
          }
          for (const [subject, items] of doneBy) {
            const box = groupEl(subject, items, ctx, 'subject-done:' + subject)
            box.dataset.doneGroup = '1'
            el.appendChild(box)
          }
        } else {
          for (const box of Array.from(el.querySelectorAll('[data-done-group="1"]'))) box.remove()
        }
      })
      doneSel.appendChild(doneToggle)
      if (done.length > 0) el.appendChild(doneSel)
    } else {
      const groups = [
        { key: 'overdue', label: '已经迟了', items: open.filter((t) => t.overdue) },
        { key: 'today', label: '今天', items: open.filter((t) => !t.overdue && t.dueDate === today) },
        {
          key: 'next',
          label: '接下来',
          items: open.filter((t) => !t.overdue && t.dueDate && t.dueDate > today && t.dueDate <= in7Str),
        },
        {
          key: 'later',
          label: '其它',
          items: open.filter((t) => !t.overdue && (!t.dueDate || t.dueDate > in7Str)),
        },
      ]
      let shown = 0
      for (const g of groups) {
        if (g.items.length === 0) continue
        el.appendChild(groupEl(g.label, g.items, ctx, g.key))
        shown += g.items.length
      }
      if (shown === 0) {
        el.appendChild(h('div', 'her-empty', '没有还没做完的任务 —— 今天可以歇一会儿。'))
      }
    }

    const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : []
    if (warnings.length > 0) {
      const note = h('div', 'her-note')
      note.textContent = '数据里有点问题：' + warnings.slice(0, 3).join('；')
      el.appendChild(note)
    }
    if (ctx && ctx.mock) {
      const note = h('div', 'her-note')
      note.textContent = '这是假数据（截图 / 自检用，不会写进你的任务数据）。'
      el.appendChild(note)
    }
  }

  draw()

  // 「按时间」下，做完的照旧单独一组（时间维度不按科目拆）
  if (view.by !== 'subject' && done.length > 0) {
    const extra = done.length > 20 ? h('div', 'her-note', `还有 ${done.length - 20} 条已完成的没列出来。`) : null
    el.appendChild(groupEl('已完成', done.slice(0, 20), ctx, 'done', extra))
  }
}

/** 自检用：这页现在按什么分组（'time' | 'subject'） */
export function tasksViewMode() {
  return view.by
}
