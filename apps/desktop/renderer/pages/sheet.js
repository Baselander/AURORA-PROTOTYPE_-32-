/**
 * apps\desktop\renderer\pages\sheet.js —— 「详情浮层」（2026-10-24，主人要的"点进去看更详细"）
 *
 * 主人原话：「尤其是里面每个项都加上边框的设计（比如把每道错题都框起来、点击可以进入更详细的页面等）」
 * 所以列表里每一条是一个**框**（`.her-item`），点一下 → 浮窗里升起一张铺满正文区的**详情浮层**
 * （`.her-sheet`，顶部有「← 返回」）。
 *
 * 为什么用浮层而不是再开一个窗口：
 *   · 浮窗本身已经能单独拖/关了，再开窗口就成"三层窗口"，人容易晕；
 *   · 浮层能立刻返回，翻错题/待办最快；
 *   · 浮层不挡标题条 → 看详情时浮窗还能拖。
 *
 * 实现要点：浮层是 `.her-card` 的 flex 子元素（挂在标题条下面），打开时给卡片加
 * `.her-has-sheet` 把"正文 + 页签 + 底部记一条"藏掉，关掉再放出来。
 */

import { h } from './dom.js'

let hostCard = null
let sheetEl = null
let onCloseHook = null

/** 主进程/页面启动时告诉它"浮层挂在哪张卡片上"（就是 #her-card） */
export function initSheet(cardEl) {
  hostCard = cardEl || null
}

export function sheetOpen() {
  return !!sheetEl
}

/** 关掉浮层（没有就返回 false）。Esc / 返回键 / 换页 / 刷新都会调它。 */
export function closeSheet() {
  if (!sheetEl) return false
  try {
    sheetEl.remove()
  } catch {}
  sheetEl = null
  try {
    if (hostCard) hostCard.classList.remove('her-has-sheet')
  } catch {}
  const cb = onCloseHook
  onCloseHook = null
  if (typeof cb === 'function') {
    try {
      cb()
    } catch {}
  }
  return true
}

/**
 * 开一张详情浮层。
 * @param {object} opts
 *   title    标题（必填）
 *   subtitle 副标题（小字，一行）
 *   badge    右上角一枚小标签（可选）
 *   hidden   true → 打开后立刻藏起来（自检用，测完再决定要不要露）
 *   build    (bodyEl) => void   正文内容（自己往里 append）
 *   actions  [{label, primary?, onClick}]  正文上方的按钮条（可选）
 *   footer   string | (footEl) => void    底部一行说明（可选）
 *   onClose  () => void   关掉时回调
 */
export function openSheet(opts) {
  const o = opts || {}
  if (!hostCard) return null
  closeSheet()

  const el = h('section', 'her-sheet')
  el.id = 'her-sheet'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', String(o.title || '详情'))

  // 头：← 返回 + 标题 + 可选标签
  const head = h('header', 'her-sheet-head')
  const back = h('button', 'her-chip her-sheet-back', '← 返回')
  back.type = 'button'
  back.title = '回到列表（Esc 也行）'
  back.addEventListener('click', () => closeSheet())
  head.appendChild(back)
  const titles = h('div', 'her-sheet-titles')
  titles.appendChild(h('div', 'her-sheet-title', String(o.title || '详情')))
  if (o.subtitle) titles.appendChild(h('div', 'her-sheet-sub', String(o.subtitle)))
  head.appendChild(titles)
  if (o.badge) head.appendChild(h('span', 'her-pill her-sheet-badge', String(o.badge)))
  el.appendChild(head)

  // 按钮条（可选）
  if (Array.isArray(o.actions) && o.actions.length > 0) {
    const row = h('div', 'her-chips her-sheet-acts')
    for (const a of o.actions) {
      if (!a) continue
      const b = h('button', 'her-chip' + (a.primary ? ' her-chip-send' : ''), String(a.label || ''))
      b.type = 'button'
      if (a.title) b.title = String(a.title)
      b.addEventListener('click', () => {
        try {
          a.onClick ? a.onClick(b) : null
        } catch (err) {
          b.title = String((err && err.message) || err)
        }
      })
      row.appendChild(b)
    }
    el.appendChild(row)
  }

  // 正文
  const bodyEl = h('div', 'her-sheet-body')
  if (typeof o.build === 'function') {
    o.build(bodyEl)
  } else if (o.build && o.build.nodeType) {
    bodyEl.appendChild(o.build)
  }
  el.appendChild(bodyEl)

  // 底部说明（可选）
  if (o.footer) {
    const foot = h('div', 'her-sheet-foot')
    if (typeof o.footer === 'function') o.footer(foot)
    else foot.textContent = String(o.footer)
    el.appendChild(foot)
  }

  hostCard.appendChild(el)
  hostCard.classList.add('her-has-sheet')
  sheetEl = el
  bodyEl.scrollTop = 0
  onCloseHook = typeof o.onClose === 'function' ? o.onClose : null
  if (o.hidden) el.style.visibility = 'hidden'
  return el
}

/** 详情里"一行：标签 + 内容"（错题的四轮、待办的元信息都用它） */
export function sheetRow(label, text) {
  const row = h('div', 'her-sheet-row')
  if (label) row.appendChild(h('span', 'her-sheet-k', String(label)))
  row.appendChild(h('span', 'her-sheet-v', String(text == null ? '' : text)))
  return row
}

/** 详情里的一个分区小标题 */
export function sheetHead(text) {
  return h('div', 'her-sheet-h', String(text || ''))
}
