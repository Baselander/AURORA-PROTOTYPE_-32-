/**
 * apps\desktop\renderer\pages\summary.js —— 「总结」页（2026-10-24，第 7 个页签）
 *
 * 主人 2026-10-24 确认：「她先写、你再改」。
 * 借了同学 Tevela（StudyOS）的「每日总结 + 按天归档」的形态；数据不在 localStorage，
 * 在 `<数据核心>\每日总结.jsonl`（一天一行），所以换机器/重装都还在。
 *
 * 每条 = 一个框（`.her-item`）：
 *   日期 + 谁写的（她 / 我改过） + 头两行预览
 * 点开 → 详情浮层：全文 + 「让她重写今天」+ 「我自己改」（textarea + 存）
 */

import { h, clear, humanDate, todayLocal } from './dom.js'
import { openSheet, sheetHead } from './sheet.js'

function dayLabel(dateStr, today) {
  if (!dateStr) return '没写日期'
  const h1 = humanDate(dateStr, today)
  return h1 === dateStr ? dateStr : `${h1}`
}

function preview(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 一天总结的详情浮层：全文 + 她能重写 + 主人能改 */
function openSummarySheet(item, ctx) {
  let text = String(item.text || '')
  const actions = [
    {
      label: '让她重写这一天的',
      title: '用当天数据让她重写（会花一点 token；写完直接替换）',
      onClick: async (btn) => {
        btn.disabled = true
        const wait = h('div', 'her-busy', '她在写…（十几秒）')
        const body = document.querySelector('.her-sheet-body')
        if (body) body.insertBefore(wait, body.firstChild)
        try {
          const r = await window.herShell.act('summary-generate', { date: item.date })
          if (r && r.ok && r.item) {
            text = String(r.item.text || '')
            if (body) {
              body.textContent = ''
              body.appendChild(sheetHead(`她写的（${String(r.item.at || '').slice(0, 16)}）`))
              body.appendChild(h('div', 'her-sheet-pre', text))
            }
            if (ctx && ctx.refresh) ctx.refresh()
          } else if (body) {
            body.appendChild(h('div', 'her-note', '没写出来：' + ((r && r.error) || '未知原因')))
          }
        } catch (err) {
          if (body) body.appendChild(h('div', 'her-note', '没写出来：' + ((err && err.message) || err)))
        } finally {
          try {
            wait.remove()
          } catch {}
          btn.disabled = false
        }
      },
    },
    {
      label: '我自己改',
      title: '在下面直接改，存了就覆盖这一天的',
      onClick: async (btn) => {
        const body = document.querySelector('.her-sheet-body')
        if (!body) return
        if (body.querySelector('.her-summary-edit')) {
          body.querySelector('.her-summary-edit').focus()
          return
        }
        const ta = document.createElement('textarea')
        ta.className = 'her-summary-edit'
        ta.value = text
        ta.rows = 8
        const row = h('div', 'her-chips')
        const save = h('button', 'her-chip her-chip-send', '存下来')
        save.type = 'button'
        save.addEventListener('click', async () => {
          save.disabled = true
          try {
            const r = await window.herShell.act('summary-write', { date: item.date, text: ta.value })
            if (r && r.ok) {
              text = String(ta.value || '')
              save.textContent = '存好了'
              if (ctx && ctx.refresh) ctx.refresh()
            } else {
              save.textContent = '没存上：' + ((r && r.error) || '')
            }
          } catch (err) {
            save.textContent = '没存上：' + ((err && err.message) || err)
          } finally {
            save.disabled = false
          }
        })
        row.appendChild(save)
        body.appendChild(sheetHead('我自己改'))
        body.appendChild(ta)
        body.appendChild(row)
        ta.focus()
        btn.disabled = false
      },
    },
  ]
  openSheet({
    title: dayLabel(item.date, todayLocal()) + ' 的总结',
    subtitle: item.by === 'she' ? '她自己写的' : '我改过的',
    badge: item.date || '',
    actions,
    build: (body) => {
      body.appendChild(sheetHead(`正文（${text.length} 字）`))
      body.appendChild(h('div', 'her-sheet-pre', text))
    },
    footer: '存的是 `_study-core\\每日总结.jsonl`（一天一行）；她每天到点（默认 21:30）会自己写一份。',
  })
}

function itemEl(item, ctx) {
  const box = h('div', 'her-item her-item-sum')
  box.dataset.sumDate = String(item.date || '')
  box.tabIndex = 0
  box.title = '点一下看全文 / 改它'
  box.appendChild(h('span', 'her-item-no', item.by === 'she' ? '她' : '我'))
  const main = h('div', 'her-item-main')
  main.appendChild(h('div', 'her-item-title', dayLabel(item.date, todayLocal())))
  main.appendChild(h('div', 'her-item-sub', preview(item.text, 96)))
  const meta = h('div', 'her-item-meta')
  meta.appendChild(h('span', 'her-pill', item.by === 'she' ? '她写的' : '我改过'))
  if (item.at) meta.appendChild(h('span', 'her-pill', String(item.at).slice(5, 16)))
  main.appendChild(meta)
  box.appendChild(main)
  box.appendChild(h('span', 'her-item-arrow', '›'))
  const open = () => openSummarySheet(item, ctx)
  box.addEventListener('click', open)
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  })
  return box
}

export function renderSummary(el, data, ctx) {
  clear(el)
  const items = Array.isArray(data.items) ? data.items : []
  const today = String(data.today || todayLocal())

  const lead = h('div', 'her-lead')
  lead.appendChild(h('span', 'her-badge-day', `${items.length} 天`))
  lead.appendChild(h('span', null, '她先写，你要改就点开改'))
  el.appendChild(lead)

  // 今天还没有 → 给一个"让她写"的按钮
  const hasToday = items.some((x) => String(x.date) === today)
  const bar = h('div', 'her-chips')
  const gen = h('button', 'her-chip' + (hasToday ? '' : ' her-chip-send'), hasToday ? '让她重写今天的' : '让她写今天的')
  gen.type = 'button'
  gen.addEventListener('click', async () => {
    gen.disabled = true
    gen.textContent = '她在写…'
    try {
      const r = await window.herShell.act('summary-generate', { date: today })
      if (r && r.ok) {
        gen.textContent = '写好了'
        if (ctx && ctx.refresh) ctx.refresh()
      } else {
        gen.textContent = '没写出来：' + ((r && r.error) || '')
      }
    } catch (err) {
      gen.textContent = '没写出来：' + ((err && err.message) || err)
    } finally {
      gen.disabled = false
    }
  })
  bar.appendChild(gen)
  el.appendChild(bar)

  if (items.length === 0) {
    el.appendChild(h('div', 'her-empty', '还没有任何一天的总结。点上面那个按钮，让她先写今天这一份。'))
  } else {
    const box = h('section', 'her-group')
    const head = h('div', 'her-group-h')
    head.appendChild(h('span', 'her-group-label', hasToday ? '这些天' : '这些天（今天还没有）'))
    head.appendChild(h('span', 'her-group-n', String(items.length)))
    box.appendChild(head)
    for (const it of items) box.appendChild(itemEl(it, ctx))
    el.appendChild(box)
  }

  if (data.mock) el.appendChild(h('div', 'her-note', '这是假数据（截图 / 自检用）。'))
}
