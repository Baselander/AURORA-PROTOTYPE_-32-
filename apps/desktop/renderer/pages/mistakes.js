/**
 * apps\desktop\renderer\pages\mistakes.js —— 「错题」页（2026-10-24 晚：顶部改成「错题趋势」表格）
 *
 * **只读**：这一页不会改主人的错题本（旧浮窗也是这个规矩）。
 * 数据：`<数据目录>\新建\_AURORA工作区\错题本生成器\entries.json`
 *   { summary:{heading,lines,trio}, entries:[{title, rows:[[标签, 内容], …]}] }
 *
 * 主人 2026-10-24 晚的原话：「错题最上面的总结栏太乱了（有点挤到一起；我在想要不要把这个改成错题趋势、
 * 然后做成表格的形式）」→ 于是顶部不再是"一大段用 ｜ 串起来的字"，而是三张小表：
 *   ① 按科目（条数 / 占比 / 最近一次）
 *   ② 按测验批次（最近的在前，带一条小柱条 = 趋势）
 *   ③ 错因分布（从原来那条小结里拆成表格：类别 / 条数 / 明细）
 * 原来那几行原文**不丢**，折进「原始小结（点开看）」里；trio（备用主线）也一样。
 *
 * 主人 2026-10-24：「把每道错题都框起来、点击可以进入更详细的页面」
 *   → 列表里每条 = 一个 `.her-item` 框，点框 → 详情浮层（四轮全文 + 「让她出相似题」）。
 */

import { h, clear } from './dom.js'
import { openSheet, closeSheet, sheetRow, sheetHead } from './sheet.js'

/** 从 rows 里按标签前缀找一行（错题本的行是 [标签, 内容]，内容**可能是数组**） */
function rowByLabel(rows, re) {
  for (const r of rows) {
    if (!Array.isArray(r)) continue
    if (re.test(String(r[0] || ''))) return { label: String(r[0] || ''), text: rowsText(r[1]) }
  }
  return null
}

/**
 * 一栏的内容 → 一段文字。
 * ⚠️ 2026-10-24 修：主人的真数据里每一栏都是**字符串数组**（一栏可能好几行），
 *   原来这里写 `String(r[1])` → 数组被拼成逗号串（"…。」，（归类：审题…"），看着像挤在一起。
 *   现在数组按行接起来，才是他写的样子。
 */
function rowsText(value) {
  if (Array.isArray(value)) return value.map((v) => String(v == null ? '' : v)).join('\n')
  return String(value == null ? '' : value)
}

/** 多行文字 → 一行一行的 div（保留原来的分行/缩进） */
function preLines(host, text) {
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    host.appendChild(h('div', 'her-sheet-pre', line))
  }
  return host
}

function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

const WD = ['日', '一', '二', '三', '四', '五', '六']
const pad2 = (v) => String(v).padStart(2, '0')

/**
 * 「＋ 新增」的表单浮层（批次 2.2b，2026-10-24 主人拍板的口径）
 *   · 写进 `entries.json`（走 info\mistake-add.mjs → MistakeBook：序号接着排、先压快照、轮次不动）
 *   · `错题本.docx` **默认只出预览**（out\错题本-预览.docx）；要真覆盖得点第二个按钮
 *   · 「让她先读一遍」只把草稿**填进输入框**，一个字都不写盘
 */
function openMistakeForm(ctx) {
  const mk = (tag, cls, id, ph) => {
    const e = document.createElement(tag)
    e.className = cls
    e.id = id
    if (ph) e.placeholder = ph
    return e
  }
  const subject = mk('input', 'her-input', 'her-mk-subject', '科目（可写缩写：bio / econ / 数学）')
  const question = mk('textarea', 'her-textarea', 'her-mk-question', '题面（尽量抄全：选项/图表说明也写上；实在看不清就留空，会进 1.5 轮等你补）')
  const mine = mk('input', 'her-input', 'her-mk-mine', '我的选项（例：B）')
  const right = mk('input', 'her-input', 'her-mk-right', '正确选项（例：C）')
  const cause = mk('textarea', 'her-textarea', 'her-mk-cause', '错因（可以先空着，或点上面的「让她先读一遍」当草稿再改）')

  const hint = h('div', 'her-note')
  hint.id = 'her-mk-hint'
  hint.textContent = ''

  const draftBtn = {
    label: '让她先读一遍（只出草稿）',
    title: '拿题面 + 我的/正确选项 去问她的脑子：只把错因和方案填进框里，不写盘',
    onClick: async (btn) => {
      const q = String(question.value || '').trim()
      if (!q) {
        question.focus()
        btn.textContent = '先把题面抄进来'
        return
      }
      btn.disabled = true
      btn.textContent = '她在读…'
      hint.textContent = '（她出草稿要十几秒）'
      try {
        const r = await window.herShell.act('mistake-draft', {
          question: q,
          subject: String(subject.value || '').trim(),
          mine: String(mine.value || '').trim(),
          right: String(right.value || '').trim(),
        })
        if (r && r.ok && r.text) {
          cause.value = String(r.text)
          btn.textContent = '草稿填进去了，你改改'
          hint.textContent = '这只是草稿 —— 你看过、改过才存。'
        } else {
          btn.textContent = '没读成：' + ((r && r.error) || '')
          hint.textContent = ''
        }
      } catch (err) {
        btn.textContent = '没读成：' + ((err && err.message) || err)
      } finally {
        btn.disabled = false
      }
    },
  }

  const save = (applyDocx) => ({
    label: applyDocx ? '就这样存（连 docx 一起）' : '就这样存',
    primary: !applyDocx,
    title: applyDocx ? '写 entries.json，并覆盖 新建\\错题本.docx（覆盖前自动备份旧 docx）' : '写 entries.json + 出一份 docx 预览（不动正式文件）',
    onClick: async (btn) => {
      const q = String(question.value || '').trim()
      if (!q) {
        question.focus()
        btn.textContent = '题面先写一行'
        return
      }
      btn.disabled = true
      btn.textContent = '正在存…'
      try {
        const r = await window.herShell.act('mistake-add', {
          subject: String(subject.value || '').trim(),
          question: q,
          mine: String(mine.value || '').trim(),
          right: String(right.value || '').trim(),
          cause: String(cause.value || '').trim(),
          apply: applyDocx === true,
        })
        if (r && r.ok !== false) {
          btn.textContent = `存好了（第 ${r.seq} 条）`
          hint.textContent = applyDocx ? 'docx 已重新生成（旧的自动备份了）。' : 'json 写好了，docx 只出了预览：out\\错题本-预览.docx'
          try {
            closeSheet()
          } catch {}
          if (ctx && typeof ctx.refresh === 'function') setTimeout(() => ctx.refresh(), 100)
        } else {
          btn.textContent = '没存成：' + ((r && r.error) || '')
          btn.disabled = false
        }
      } catch (err) {
        btn.textContent = '没存成：' + ((err && err.message) || err)
        btn.disabled = false
      }
    },
  })

  openSheet({
    title: '记一条错题',
    subtitle: '写 entries.json（序号接着排、先压快照、轮次不动）；docx 默认只出预览',
    actions: [draftBtn, save(false), save(true)],
    build: (body) => {
      body.appendChild(sheetHead('哪门课'))
      body.appendChild(subject)
      body.appendChild(sheetHead('题面（②）'))
      body.appendChild(question)
      const row = h('div', 'her-slider-row')
      row.append(mine, right)
      body.appendChild(sheetHead('我的选项 / 正确选项（③）'))
      body.appendChild(row)
      body.appendChild(sheetHead('错因（④，可以先空着）'))
      body.appendChild(cause)
      body.appendChild(hint)
      body.appendChild(sheetRow('注意', '看不清的题面不要猜 —— 留空它就会进 1.5 轮等你说。'))
    },
    footer: '写入走 info\\mistake-add.mjs → study-core 的 MistakeBook（同一套校验；写盘前先 entries.json.bak-*）。',
  })
  setTimeout(() => {
    try {
      question.focus()
    } catch {}
  }, 60)
}


/**
 * 解析一条错题 → { date:'2026-10-07', week:'三', subject:'AP Physics 1', where:'…' }
 * 标题格式是「01｜2026-10-07（周三）· 科目 · 说明」，① 行里也有一份同样的信息；
 * 两处都认，认不出就给空（**不猜**，宁可表里显示「—」）。
 */
function parseEntry(entry) {
  const rows = Array.isArray(entry.rows) ? entry.rows : []
  const title = String(entry.title || '')
  const first = rowByLabel(rows, /日期|时间/)
  const source = `${title}｜${first ? first.text : ''}`
  const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(source)
  const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : null
  let week = /\d{4}-\d{2}-\d{2}[（(]周([日一二三四五六])/.exec(source)
  if (!week && date) {
    const d = new Date(`${date}T00:00:00`)
    if (!Number.isNaN(d.getTime())) week = [null, WD[d.getDay()]]
  }
  // 科目：标题 / ① 行里按「·」切开后的第二段（第一段是编号+日期）
  let subject = ''
  for (const src of [title, first ? first.text : '']) {
    const parts = String(src || '')
      .split(/[·・]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length >= 2) {
      const cand = parts[1].replace(/[（(].*?[)）]/g, '').trim()
      if (cand && !/^\d{4}-\d{2}-\d{2}/.test(cand)) {
        subject = cand
        break
      }
    }
  }
  return { date, week: week && week[1] ? week[1] : '', subject: subject || '没写科目' }
}

/** 表格：小标题 + <table>（主人要的"表格的形式"） */
function table(headers, rows, opts) {
  const o = opts || {}
  const wrap = h('div', 'her-trend-tbl' + (o.cls ? ' ' + o.cls : ''))
  if (o.caption) wrap.appendChild(h('div', 'her-trend-cap', o.caption))
  const t = document.createElement('table')
  t.className = 'her-table'
  const thead = document.createElement('thead')
  const tr = document.createElement('tr')
  for (const hd of headers) tr.appendChild(h('th', null, hd))
  thead.appendChild(tr)
  t.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const row of rows) {
    const r = document.createElement('tr')
    for (const cell of row) {
      const td = document.createElement('td')
      if (cell && typeof cell === 'object' && cell.nodeType === 1) td.appendChild(cell)
      else td.textContent = String(cell == null ? '' : cell)
      r.appendChild(td)
    }
    tbody.appendChild(r)
  }
  t.appendChild(tbody)
  wrap.appendChild(t)
  return wrap
}

/** 小柱条（趋势用；纯 CSS 宽度，不画图） */
function bar(n, max, cls) {
  const d = h('div', 'her-bar' + (cls ? ' ' + cls : ''))
  const f = h('span', 'her-bar-fill')
  const pct = max > 0 ? Math.round((n / max) * 100) : 0
  f.style.width = Math.max(6, pct) + '%'
  d.appendChild(f)
  return d
}

/** 从原来那条"类别 N（明细）｜类别 N（…）"的小结里拆出表格行 */
function parseCauseLine(text) {
  const out = []
  for (const seg of String(text || '').split(/[｜|]/)) {
    const s = seg.trim()
    if (!s) continue
    const dm = /^(.*?)[\s　]*(\d+)\s*(?:条)?\s*[（(](.*)[)）]\s*$/.exec(s)
    if (dm) {
      out.push({ name: dm[1].trim(), count: Number(dm[2]), detail: dm[3].trim() })
    } else {
      const dm2 = /^(.*?)[\s　]*(\d+)\s*(?:条)?$/.exec(s)
      if (dm2) out.push({ name: dm2[1].trim(), count: Number(dm2[2]), detail: '' })
    }
  }
  return out
}

/**
 * 「错题趋势」那一块（三张表）。
 * 数字全是从 entries 现算的，不依赖 summary；summary 只贡献第三张表（错因分布）。
 */
function trendBlock(entries, summary) {
  const box = h('section', 'her-group her-trend')
  const head = h('div', 'her-group-h')
  head.appendChild(h('span', 'her-group-label', '错题趋势'))
  head.appendChild(h('span', 'her-group-n', String(entries.length)))
  box.appendChild(head)

  const parsed = entries.map((e) => parseEntry(e))

  // ① 按科目
  const bySub = new Map()
  for (let i = 0; i < parsed.length; i += 1) {
    const p = parsed[i]
    if (!bySub.has(p.subject)) bySub.set(p.subject, [])
    bySub.get(p.subject).push(p)
  }
  const subRows = Array.from(bySub.entries())
    .map(([subject, list]) => {
      const dates = list.map((x) => x.date).filter(Boolean).sort()
      return { subject, n: list.length, last: dates.length ? dates[dates.length - 1] : '' }
    })
    .sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)))
  const maxSub = subRows.reduce((m, r) => Math.max(m, r.n), 0)
  const total = entries.length
  box.appendChild(
    table(
      ['科目', '条数', '占比', '最近一次'],
      subRows.map((r) => [
        r.subject,
        String(r.n),
        total > 0 ? Math.round((r.n / total) * 100) + '%' : '—',
        r.last || '—',
      ]),
      { caption: `按科目（共 ${total} 条）` },
    ),
  )

  // ② 按测验批次（最近的在最上面）+ 小柱条
  const byDate = new Map()
  for (const p of parsed) {
    const key = p.date || '日期没认出来'
    if (!byDate.has(key)) byDate.set(key, { n: 0, subs: new Set(), week: p.week })
    const g = byDate.get(key)
    g.n += 1
    g.subs.add(p.subject)
  }
  const dateRows = Array.from(byDate.entries()).sort((a, b) => String(b[0]).localeCompare(String(a[0])))
  const maxDate = dateRows.reduce((m, [, v]) => Math.max(m, v.n), 0)
  box.appendChild(
    table(
      ['日期', '条数', '趋势', '考了什么'],
      dateRows.map(([date, v]) => [
        date + (v.week ? `（周${v.week}）` : ''),
        String(v.n),
        bar(v.n, maxDate),
        Array.from(v.subs).join(' / '),
      ]),
      { caption: '按测验批次（最近的在上）' },
    ),
  )

  // ③ 错因分布（从原来的小结里拆出来）
  const lines = summary && Array.isArray(summary.lines) ? summary.lines : []
  let causeRows = []
  for (const line of lines) {
    const rows2 = parseCauseLine(line)
    if (rows2.length >= 2) {
      causeRows = rows2
      break
    }
  }
  if (causeRows.length > 0) {
    const maxC = causeRows.reduce((m, r) => Math.max(m, r.count), 0)
    const sum = causeRows.reduce((s, r) => s + r.count, 0)
    box.appendChild(
      table(
        ['错因类别', '条数', '趋势', '明细'],
        causeRows.map((r) => [r.name, String(r.count), bar(r.count, maxC, 'her-bar-warn'), clip(r.detail, 46)]),
        { caption: `错因分布（小结里 ${sum} 条被打过标签）` },
      ),
    )
  }

  // 一句提醒：哪一类最多 —— 只在真算得出来的时候说
  if (causeRows.length > 0) {
    const top = causeRows.slice().sort((a, b) => b.count - a.count)[0]
    box.appendChild(
      h('div', 'her-trend-note', `最常栽的是「${top.name}」（${top.count} 条）—— 复习时先盯这一类。`),
    )
  }
  return box
}

/** 原来的小结原文：折起来，不占地方但一个字都不丢 */
function rawSummaryBlock(summary) {
  const lines = summary && Array.isArray(summary.lines) ? summary.lines.filter(Boolean) : []
  const trio = summary && Array.isArray(summary.trio) ? summary.trio.filter(Boolean) : []
  if (lines.length === 0 && trio.length === 0) return null
  const box = h('section', 'her-group her-raw-sum')
  const det = document.createElement('details')
  det.className = 'her-detail'
  det.dataset.rawSummary = '1'
  const sm = document.createElement('summary')
  sm.textContent = `原始小结（${lines.length + trio.length} 段，点开看）`
  det.appendChild(sm)
  const inner = h('div', 'her-detail-body')
  if (summary.heading) inner.appendChild(h('div', 'her-detail-h', String(summary.heading)))
  for (const line of lines) inner.appendChild(h('div', 'her-line', line))
  if (trio.length > 0) {
    inner.appendChild(h('div', 'her-detail-h', '备用主线（未采纳）'))
    for (const t of trio) inner.appendChild(h('div', 'her-line', t))
  }
  det.appendChild(inner)
  box.appendChild(det)
  return box
}

/** 一道错题的详情浮层 */
function openMistakeSheet(entry, index) {
  const rows = Array.isArray(entry.rows) ? entry.rows : []
  const question = rowByLabel(rows, /题目|题干|错题/)
  const cause = rowByLabel(rows, /错因|为什么/)
  const actions = [
    {
      label: '让她出相似题',
      title: '按这道题的概念出新题（用她自己的脑子，会花一点 token；答案在后面）',
      onClick: async (btn) => {
        btn.disabled = true
        const out = h('div', 'her-sheet-block')
        const box = document.querySelector('.her-sheet-body')
        const host = box || out
        const wait = h('div', 'her-busy', '她在出题…（这个要等十几秒）')
        host.appendChild(wait)
        try {
          const r = await window.herShell.act('similar-questions', {
            title: entry.title || '',
            question: question ? question.text : '',
            cause: cause ? cause.text : '',
            rows: rows.slice(0, 12).map((x) => (Array.isArray(x) ? String(x[1] || '') : String(x))),
          })
          wait.remove()
          const t = h('div', 'her-sheet-block')
          if (r && r.ok && r.text) {
            t.appendChild(sheetHead('她出的相似题'))
            t.appendChild(h('div', 'her-sheet-pre', r.text))
          } else {
            t.appendChild(h('div', 'her-note', '没出成：' + ((r && r.error) || '未知原因')))
          }
          host.appendChild(t)
          host.scrollTop = host.scrollHeight
        } catch (err) {
          wait.remove()
          host.appendChild(h('div', 'her-note', '没出成：' + ((err && err.message) || err)))
        } finally {
          btn.disabled = false
        }
      },
    },
  ]

  openSheet({
    title: entry.title || '(没有标题)',
    subtitle: `第 ${index + 1} 条 · 只读（不会改你的错题本）`,
    actions,
    build: (body) => {
      for (const r of rows) {
        const label = Array.isArray(r) ? String(r[0] || '') : ''
        const text = Array.isArray(r) ? rowsText(r[1]) : String(r || '')
        if (!text.trim()) continue
        const block = h('div', 'her-sheet-block')
        if (label) block.appendChild(sheetHead(label))
        preLines(block, text)
        body.appendChild(block)
      }
      if (rows.length === 0) body.appendChild(h('div', 'her-empty', '这条错题里没有内容。'))
    },
    footer: '四轮流程的原文都在这儿；错题本本身是只读的。',
  })
}

function itemEl(entry, index) {
  const rows = Array.isArray(entry.rows) ? entry.rows : []
  const question = rowByLabel(rows, /题目|题干|错题/)
  const cause = rowByLabel(rows, /错因|为什么/)
  const subject = rowByLabel(rows, /科目|来源|出处/)
  const date = rowByLabel(rows, /日期|时间/)

  const item = h('div', 'her-item her-item-mk')
  item.dataset.mkIndex = String(index)
  item.tabIndex = 0
  item.title = '点一下看这道题的完整四轮'

  const no = h('span', 'her-item-no', String(index + 1))
  item.appendChild(no)

  const main = h('div', 'her-item-main')
  main.appendChild(h('div', 'her-item-title', String(entry.title || '(没有标题)')))
  if (question && question.text) main.appendChild(h('div', 'her-item-sub', clip(question.text, 70)))
  const meta = h('div', 'her-item-meta')
  if (subject) meta.appendChild(h('span', 'her-pill', clip(subject.text, 18)))
  if (date) meta.appendChild(h('span', 'her-pill', clip(date.text, 14)))
  const mine = rowByLabel(rows, /我的|我选|选了/)
  const right = rowByLabel(rows, /正确|答案/)
  if (mine) meta.appendChild(h('span', 'her-pill her-pill-overdue', '我的：' + clip(mine.text, 12)))
  if (right) meta.appendChild(h('span', 'her-pill her-pill-homework', '对：' + clip(right.text, 12)))
  if (cause) meta.appendChild(h('span', 'her-pill', '错因：' + clip(cause.text, 16)))
  if (meta.childNodes.length > 0) main.appendChild(meta)
  item.appendChild(main)
  item.appendChild(h('span', 'her-item-arrow', '›'))

  const open = () => openMistakeSheet(entry, index)
  item.addEventListener('click', open)
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
  return item
}

export function renderMistakes(el, data, ctx) {
  clear(el)
  const entries = Array.isArray(data.entries) ? data.entries : []

  const lead = h('div', 'her-lead')
  lead.appendChild(h('span', 'her-badge-day', `${entries.length} 条`))
  lead.appendChild(h('span', null, '每条一个框，点一下看完整四轮'))
  // 2026-10-24 晚（批次 2.2b）：主人点头「开写权限」——但只走"表单 + 她出草稿你确认"，绝不静默写
  const addBtn = h('button', 'her-chip her-chip-send', '＋ 新增')
  addBtn.type = 'button'
  addBtn.id = 'her-mistake-add'
  addBtn.title = '记一条错题（写 entries.json；docx 默认只出预览）'
  addBtn.addEventListener('click', (e) => {
    e.preventDefault()
    openMistakeForm(ctx)
  })
  lead.appendChild(addBtn)
  el.appendChild(lead)

  // 错题趋势（2026-10-24 晚：把原来挤成一坨的总结栏换成三张表）
  el.appendChild(trendBlock(entries, data.summary))

  // 原来的小结原文折起来（不丢，但不占地方）
  const raw = rawSummaryBlock(data.summary)
  if (raw) el.appendChild(raw)

  if (entries.length === 0) {
    el.appendChild(h('div', 'her-empty', '错题本里还没有条目。'))
  }

  if (entries.length > 0) {
    const box = h('section', 'her-group')
    const head = h('div', 'her-group-h')
    head.appendChild(h('span', 'her-group-label', '全部错题'))
    head.appendChild(h('span', 'her-group-n', String(entries.length)))
    box.appendChild(head)
    entries.forEach((entry, i) => box.appendChild(itemEl(entry, i)))
    el.appendChild(box)
  }

  if (data.dropbox) renderDropbox(el, data.dropbox)

  if (ctx && ctx.mock) {
    el.appendChild(h('div', 'her-note', '这是假数据（截图 / 自检用），不是你的错题本。'))
  }
  if (data.ok === false && data.error) {
    el.appendChild(h('div', 'her-note', data.error))
  }
}

function humanSize(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(0) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * 投放区（主人 2026-10-22 深夜：错题本想发文件）。
 * 他不传文件给我们 —— 他往**一个文件夹里丢**，界面这边看见、点开就行（只读，不改他的东西）。
 */
function renderDropbox(el, drop) {
  const box = h('section', 'her-group her-sec-split')
  box.appendChild(h('div', 'her-group-h', '投放区（把文件丢进那个文件夹就能在这看到）'))
  const bar = h('div', 'her-chips')
  const btnOpen = h('button', 'her-chip', '打开文件夹')
  btnOpen.type = 'button'
  btnOpen.addEventListener('click', () => window.herShell.act('open-path', 'drop'))
  const btnRefresh = h('button', 'her-chip', '刷新')
  btnRefresh.type = 'button'
  btnRefresh.addEventListener('click', () => {
    void window.herApp.refreshCard('mistakes')
  })
  bar.append(btnOpen, btnRefresh)
  box.appendChild(bar)

  const files = Array.isArray(drop && drop.files) ? drop.files : []
  if (files.length === 0) {
    const note = h('div', 'her-note')
    note.textContent = '这里还没有文件。路径：' + ((drop && drop.dir) || '(未知)')
    box.appendChild(note)
    el.appendChild(box)
    return
  }
  for (const f of files) {
    const item = h('div', 'her-item her-item-file')
    item.title = '点一下用系统打开'
    item.appendChild(h('span', 'her-item-no', humanSize(f.size)))
    const main = h('div', 'her-item-main')
    main.appendChild(h('div', 'her-item-title', String(f.name || '')))
    const meta = h('div', 'her-item-meta')
    if (f.mtime) meta.appendChild(h('span', 'her-pill', String(f.mtime)))
    if (meta.childNodes.length) main.appendChild(meta)
    item.appendChild(main)
    item.appendChild(h('span', 'her-item-arrow', '›'))
    item.addEventListener('click', () => window.herShell.act('open-drop-file', f.name))
    box.appendChild(item)
  }
  el.appendChild(box)
}
