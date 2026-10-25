/**
 * apps\desktop\renderer\pages\dom.js —— 几个小工具（不想为了三行代码引框架）
 */

export function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}

export function clear(el) {
  if (el) el.textContent = ''
  return el
}

/** 「2026-10-23」→「10/23 周四」；今天/明天/昨天用大白话 */
export function humanDate(dateStr, today) {
  if (!dateStr) return ''
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  const base = today ? new Date(`${today}T00:00:00`) : new Date()
  const md = `${d.getMonth() + 1}/${d.getDate()}`
  if (!Number.isNaN(base.getTime())) {
    const diff = Math.round((d.getTime() - new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()) / 86400000)
    if (diff === 0) return `今天 ${md}`
    if (diff === 1) return `明天 ${md}`
    if (diff === -1) return `昨天 ${md}`
    if (diff > 1 && diff <= 6) return `${md}（${diff} 天后）`
  }
  return md
}

export function todayLocal() {
  const n = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`
}
