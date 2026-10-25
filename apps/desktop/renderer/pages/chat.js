/**
 * apps\desktop\renderer\pages\chat.js —— 「对话」页（2026-10-22 晚，P3）
 *
 * 她说的话从哪来：主进程起 `info\brain.mjs --ask-file …`（我们原来那个大脑，一行没改），
 * 它吐 NDJSON（start / delta / done / error），主进程原样转成 `her:chat` 事件，这里往上贴字。
 *
 * 顺带白拿的：`brain.mjs` 每轮还会往 `out\pet-events.jsonl` 写 user / turn-start / delta /
 * assistant / control —— 宿主广播给她的页面，所以她**边想边在气泡里说话**，界面这层不用另做一套。
 *
 * 状态跨页签保留（切走再回来不丢）；DOM 每次都按状态重画，流式时只改最后一条气泡的文字。
 */

import { h, clear } from './dom.js'

/**
 * ```board 画图块（2026-10-25 P0-2）
 * 人设里写着"讲题可以附 board 画图块"，`info\brain.mjs` 也把格式写进了提示词
 * （{"strokes":[{"tool":"line"|"ellipse"|"text"|"pen", …}]}，画布 860×560），
 * 但新应用一直没有渲染器 —— 那段 JSON 会原样出现在聊天气泡里。
 *
 * 现在三层各管一段：
 *   · brain.mjs：流式扫把把整块抠出来，`done` 事件里带 `board: {strokes:[…]}`，正文里一个字不留；
 *   · 主进程：念稿前再剥一次（画图块的 JSON 绝不能被念出来）；
 *   · 这里：把 strokes 照着画到 <canvas> 上，并且对**老会话**里残留的围栏再兜一层。
 */
const BOARD_W = 860
const BOARD_H = 560

/** 兜底：正文里还残留的 ```board 围栏整块切掉（老会话 / 别的通道漏进来的） */
function stripBoardFences(text) {
  const raw = String(text == null ? '' : text)
  if (!/```|~~~/.test(raw)) return raw
  const lines = raw.split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const t = line.trim()
    if (!inBlock && /^(?:```|~~~)\s*board\s*$/i.test(t)) {
      inBlock = true
      continue
    }
    if (inBlock) {
      if (/^(?:```|~~~)\s*$/.test(t)) inBlock = false
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function strokeColor(c) {
  const s = String(c || '').trim()
  return /^[a-z]{3,12}$/i.test(s) || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : '#111827'
}

/**
 * 照着 strokes 画一张图；拿回包好的元素（canvas 上记着 dataset.strokes = 真画了几笔，自检靠它）
 * @param {any[]} strokes
 */
export function boardCanvas(strokes) {
  const wrap = h('div', 'her-board')
  const cv = document.createElement('canvas')
  cv.width = BOARD_W
  cv.height = BOARD_H
  cv.className = 'her-board-canvas'
  const ctx = cv.getContext('2d')
  let drawn = 0
  if (ctx) {
    ctx.fillStyle = '#fffdf7'
    ctx.fillRect(0, 0, BOARD_W, BOARD_H)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of Array.isArray(strokes) ? strokes : []) {
      if (!s || typeof s !== 'object') continue
      const tool = String(s.tool || '').toLowerCase()
      const color = strokeColor(s.color)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      if (tool === 'line') {
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(Number(s.x1) || 0, Number(s.y1) || 0)
        ctx.lineTo(Number(s.x2) || 0, Number(s.y2) || 0)
        ctx.stroke()
      } else if (tool === 'ellipse') {
        const x1 = Number(s.x1) || 0
        const y1 = Number(s.y1) || 0
        const x2 = Number(s.x2) || 0
        const y2 = Number(s.y2) || 0
        const cx = (x1 + x2) / 2
        const cy = (y1 + y2) / 2
        const rx = Math.abs(x2 - x1) / 2
        const ry = Math.abs(y2 - y1) / 2
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.ellipse(cx, cy, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2)
        ctx.stroke()
      } else if (tool === 'rect') {
        ctx.lineWidth = 3
        ctx.strokeRect(Number(s.x1) || 0, Number(s.y1) || 0, (Number(s.x2) || 0) - (Number(s.x1) || 0), (Number(s.y2) || 0) - (Number(s.y1) || 0))
      } else if (tool === 'text') {
        const txt = String(s.text || '').trim()
        if (!txt) continue
        ctx.font = '600 26px "Microsoft YaHei", "Segoe UI", sans-serif'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(txt.slice(0, 120), Number(s.x) || 0, Number(s.y) || 24)
      } else if (tool === 'pen') {
        const pts = Array.isArray(s.points) ? s.points : []
        if (pts.length < 2) continue
        ctx.lineWidth = Number(s.width) || 3
        ctx.beginPath()
        for (let i = 0; i < pts.length; i += 1) {
          const p = pts[i] || []
          const x = Number(p[0]) || 0
          const y = Number(p[1]) || 0
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      } else {
        continue
      }
      drawn += 1
    }
  }
  cv.dataset.strokes = String(drawn)
  wrap.appendChild(cv)
  wrap.appendChild(h('div', 'her-board-cap', `她画的（${drawn} 笔）`))
  return wrap
}

const state = {
  items: [],
  streaming: false,
  unsub: null,
  /** 现在这个会话属于哪个主题（切主题时用它判断"该不该重新灌历史"） */
  topic: null,
  /** 'topics'（先给主题列表）/ 'chat'（进去聊）—— 主人 2026-10-25 要的"像错题页那样先进选项栏" */
  view: 'topics',
  /** 正在流进来的那条（微信式：遇到换行就定稿一条气泡） */
  streamBuf: '',
  /** 现在画着的气泡列表（流式时往里追加） */
  listEl: null,
  /**
   * 攒着还没发出去的我方消息（2026-10-25 主人：「我发送的信息提取就每一段时间查看一次、
   * 一旦发现新消息就让她（并把时间告诉她）」）。
   * 每条 { text, at }；攒够 BATCH_MS、或她那边回完了，才整批带时间发出去。
   */
  pendingUser: [],
  pendingTimer: null,
  pendingList: null,
  pendingEl: null,
  /** 对话卡片自己的那个滚动容器（2026-10-23 多卡片：不许再 querySelector('.her-card-body')——
   *  窗口里同时开着好几张卡片时，那样取到的是**第一张**，文字会贴到别人身上去） */
  body: null,
}

/** 订阅一次就够（多次 openTab 不要重复订阅，否则一个字会贴两遍） */
function ensureSubscription() {
  if (state.unsub || !window.herShell || !window.herShell.chat) return
  state.unsub = window.herShell.chat.on((ev) => onEvent(ev))
}

function bubble(role, text) {
  const row = h('div', 'her-msg ' + (role === 'user' ? 'her-msg-user' : 'her-msg-her'))
  row.appendChild(h('div', 'her-msg-who', role === 'user' ? '我' : '她'))
  row.appendChild(h('div', 'her-msg-text', stripBoardFences(text) || ''))
  return row
}

/**
 * 一张画图块单独占一条消息（跟文字气泡分开：
 * 图是给人看的，文字才是"消息"，混在一起她画的东西会被当成一条长消息念出来）
 */
function boardRow(strokes) {
  const row = h('div', 'her-msg her-msg-her her-msg-board')
  row.appendChild(h('div', 'her-msg-who', '她画的'))
  row.appendChild(boardCanvas(strokes))
  return row
}

/** 把 strokes 贴进某个消息列表（自检和流式收尾都用它） */
function appendBoard(list, strokes) {
  if (!list || !Array.isArray(strokes) || strokes.length === 0) return null
  const row = boardRow(strokes)
  list.appendChild(row)
  const scroller = state.listEl || list
  if (scroller) scroller.scrollTop = scroller.scrollHeight
  return row
}

/** 只改"最后一条她说的话"那一段文字（流式用），顺带跟到底部 */
function paintLastAssistant(text) {
  const scroller = state.body
  if (!scroller) return
  const nodes = scroller.querySelectorAll('.her-msg-her .her-msg-text')
  const last = nodes[nodes.length - 1]
  if (last) last.textContent = text || '…'
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48
  if (atBottom) scroller.scrollTop = scroller.scrollHeight
}

/** 粘住顶部（主题条）和底部（输入栏），只有中间那段滚 —— 主人 2026-10-25 要的 */
function shell(el, cls) {
  const wrap = h('div', 'her-chat-wrap' + (cls ? ' ' + cls : ''))
  el.appendChild(wrap)
  return wrap
}

/** 主题入口列表（先进这一屏，点一个再进去聊） */
function topicsView(el, meta, topicNow, ctx) {
  const wrap = shell(el)
  const head = h('div', 'her-chat-top-head')
  head.appendChild(h('span', 'her-chat-top-title', '对话 · 选一个主题'))
  const newInput = document.createElement('input')
  newInput.type = 'text'
  newInput.className = 'her-input her-topic-new'
  newInput.id = 'her-topic-new'
  newInput.placeholder = '新主题名'
  const newBtn = h('button', 'her-chip her-chip-send', '＋ 新主题')
  newBtn.type = 'button'
  newBtn.id = 'her-topic-add'
  newBtn.title = '新建一个主题：之后聊的都记进它自己的会话文件'
  newBtn.addEventListener('click', async (e) => {
    e.preventDefault()
    const name = String(newInput.value || '').trim()
    if (!name) {
      newInput.focus()
      return
    }
    newBtn.disabled = true
    try {
      await window.herShell.act('chat-topic', { name })
      state.items = []
      state.topic = name
      state.view = 'chat'
      if (ctx && ctx.refresh) ctx.refresh()
    } catch {}
    newBtn.disabled = false
  })
  head.append(newInput, newBtn)
  wrap.appendChild(head)

  const listEl = h('div', 'her-chat-topic-list')
  const topics = Array.isArray(meta.topics) ? meta.topics : []
  for (const t of topics) {
    const card = h('button', 'her-item her-topic-card' + (t.current ? ' her-topic-card-on' : ''))
    card.type = 'button'
    card.dataset.topicName = t.name
    card.title = '点进去聊（' + (t.file || '') + '）'
    const main = h('div', 'her-item-main')
    main.appendChild(h('div', 'her-item-title', t.name + (t.current ? '（现在就这个）' : '')))
    const metaRow = h('div', 'her-item-meta')
    metaRow.appendChild(h('span', 'her-pill', `${t.lines || 0} 条`))
    if (t.current) metaRow.appendChild(h('span', 'her-pill her-pill-homework', '当前'))
    main.appendChild(metaRow)
    card.appendChild(main)
    card.appendChild(h('span', 'her-item-arrow', '›'))
    card.addEventListener('click', async () => {
      card.disabled = true
      try {
        await window.herShell.act('chat-topic', { name: t.name })
        state.items = []
        state.topic = t.name
        state.view = 'chat'
        if (ctx && ctx.refresh) ctx.refresh()
      } catch {}
      card.disabled = false
    })
    listEl.appendChild(card)
  }
  if (topics.length === 0) listEl.appendChild(h('div', 'her-empty', '还没有主题。上面写个名字点「＋ 新主题」。'))
  wrap.appendChild(listEl)
  void topicNow
}

export function renderChat(el, data, ctx) {
  ensureSubscription()
  state.body = el

  const meta = (data && data.meta) || { topics: [], current: state.topic || '主线' }
  const topicNow = meta.current || state.topic || '主线'

  // 历史只灌一次（之后的对话由事件流往上加）
  const hist = data && data.history
  if (hist && Array.isArray(hist.items) && (state.items.length === 0 || state.topic !== topicNow)) {
    state.items = hist.items.map((i) => ({ role: i.role, text: i.text }))
    state.topic = topicNow
  }

  clear(el)
  if (state.view !== 'chat') {
    topicsView(el, meta, topicNow, ctx)
    return
  }

  // ── 聊天页：顶部固定 / 中间滚 / 底部固定 ────────────────────────────────
  const wrap = shell(el, 'her-chat-chatting')
  const top = h('div', 'her-chat-top')
  const back = h('button', 'her-chip her-chat-back', '← 主题们')
  back.type = 'button'
  back.title = '回到主题列表'
  back.addEventListener('click', () => {
    state.view = 'topics'
    if (ctx && ctx.refresh) ctx.refresh()
  })
  top.appendChild(back)
  top.appendChild(h('span', 'her-chat-topic-name', String(topicNow)))
  const list = h('div', 'her-msgs')
  for (const it of state.items) {
    // 画图块单独一条（切走再回来还在）
    if (it && it.role === 'board') appendBoard(list, it.strokes)
    else list.appendChild(bubble(it.role, it.text))
  }
  if (state.items.length === 0) list.appendChild(h('div', 'her-empty', '还没聊过。下面说一句试试。'))
  wrap.appendChild(top)
  wrap.appendChild(list)
  state.listEl = list

  // 输入框：1~5 行自适应（主人 2026-10-25）
  const inputRow = h('div', 'her-send')
  const box = document.createElement('textarea')
  box.rows = 1
  box.className = 'her-send-input her-send-area'
  box.placeholder = state.streaming ? '她想事情的时候……' : '说点什么…（Enter 发送，Shift+Enter 换行）'
  const autosize = () => {
    const lines = String(box.value || '').split('\n').length
    box.rows = Math.max(1, Math.min(5, lines))
  }
  box.addEventListener('input', autosize)
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(el, box, list)
      setTimeout(autosize, 0)
    }
  })
  const btn = h('button', 'her-chip her-chip-send', '发')
  btn.type = 'button'
  btn.addEventListener('click', () => {
    void send(el, box, list)
    setTimeout(autosize, 0)
  })
  inputRow.append(box, btn)
  wrap.appendChild(inputRow)
  list.scrollTop = list.scrollHeight
}

/** 攒批的窗口（毫秒）：主人在 4 秒里连发几条，就当成"一串话"一次性交给她 */
const BATCH_MS = 4000
const pad2 = (n) => String(n).padStart(2, '0')
const stamp = (ms) => {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/**
 * 把攒着的那几条一起发给她（每条前面带 `[时:分]`，让她知道"这些是隔了一会儿分别说的"）。
 * 她那边正在回话时不发（会把她正在写的那轮掐掉）—— 等 done 事件回来再发。
 */
function flushPendingUser() {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer)
    state.pendingTimer = null
  }
  if (state.pendingUser.length === 0 || state.streaming) return
  const list = state.pendingUser.slice()
  state.pendingUser = []
  const combined = list.map((m) => `[${stamp(m.at)}] ${m.text}`).join('\n')
  state.streaming = true
  state.streamBuf = ''
  if (state.pendingList) state.listEl = state.pendingList
  const el = state.pendingEl
  try {
    const r = window.herShell.chat.send(combined)
    if (r && typeof r.then === 'function') {
      r.then((res) => {
        if (res && res.ok === false) onEvent({ t: 'error', message: (res && res.error) || '发不出去' })
      }).catch((err) => onEvent({ t: 'error', message: String((err && err.message) || err) }))
    }
  } catch (err) {
    onEvent({ t: 'error', message: String((err && err.message) || err) })
  }
  if (el) el.scrollTop = el.scrollHeight
}

/** 我方发一条：先亮出自己的气泡，然后进攒批队列 */
function queueUserTurn(el, box, list) {
  const text = String(box.value || '').trim()
  if (!text) return { ok: false, reason: 'empty' }
  box.value = ''
  const empty = el.querySelector('.her-empty')
  if (empty) empty.remove()
  list.appendChild(bubble('user', text))
  el.scrollTop = el.scrollHeight
  state.items.push({ role: 'user', text })
  state.pendingUser.push({ text, at: Date.now() })
  state.pendingList = list
  state.pendingEl = el
  if (state.pendingTimer) clearTimeout(state.pendingTimer)
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null
    flushPendingUser()
  }, BATCH_MS)
  return { ok: true, queued: state.pendingUser.length }
}

function send(el, box, list) {
  return queueUserTurn(el, box, list)
}

function currentAssistant() {
  const last = state.items[state.items.length - 1]
  return last && last.role === 'assistant' ? last : null
}

/**
 * 微信式流式：她一次回好几条短消息（每条一行），这里把流进来的文字**按换行拆成多个气泡**。
 * 主人 2026-10-25：「我可以一次发多条信息、她也会回比较多条，而不是现在的我发很多、她会很多」。
 * 做法：攒 `streamBuf`，遇到换行就"定稿"一条气泡；还没写完的那条挂在 `.her-streaming` 上边写边显示。
 */
function flushStream() {
  const list = state.listEl
  if (!list) return
  const parts = String(state.streamBuf).split('\n')
  state.streamBuf = parts.pop() || ''
  for (const raw of parts) {
    const line = stripBoardFences(raw).trim()
    if (!line) continue
    state.items.push({ role: 'assistant', text: line })
    list.appendChild(bubble('assistant', line))
  }
  let cur = list.querySelector('.her-msg-her.her-streaming')
  if (!cur) {
    cur = bubble('assistant', '…')
    cur.classList.add('her-streaming')
    list.appendChild(cur)
  }
  const textEl = cur.querySelector('.her-msg-text')
  if (textEl) textEl.textContent = state.streamBuf || '…'
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 48
  if (atBottom) list.scrollTop = list.scrollHeight
}

/** 收尾：把还挂着的那条变成正式气泡 */
function finishStream() {
  const list = state.listEl
  const tailRaw = stripBoardFences(String(state.streamBuf || ''))
  state.streamBuf = ''
  const pages = tailRaw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  if (list) {
    const cur = list.querySelector('.her-msg-her.her-streaming')
    if (cur) cur.remove()
    // 2026-10-25 主人：「现在还是换行只是一个信息框内，并没有换信息框」
    //   真因就在这一句：收尾时把还挂着的整段尾巴塞进了**一个**气泡（里面带 \n）。
    //   → 现在尾巴也按行拆，一行一个气泡（和流式中途的行为一致）。
    for (const line of pages) {
      state.items.push({ role: 'assistant', text: line })
      list.appendChild(bubble('assistant', line))
    }
  } else {
    for (const line of pages) state.items.push({ role: 'assistant', text: line })
  }
}

function onEvent(ev) {
  if (!ev || !ev.t) return
  const t = ev.t
  if (t === 'start') {
    state.streamBuf = ''
    return
  }
  if (t === 'delta') {
    state.streamBuf += String(ev.d || '')
    flushStream()
    return
  }
  if (t === 'done') {
    // 有的通道不吐 delta（只给整段 reply）：那就整段按行拆
    if (!state.streamBuf && typeof ev.reply === 'string') state.streamBuf = ev.reply
    finishStream()
    state.streaming = false
    if (state.pendingUser.length > 0) flushPendingUser()
    // ```board 画图块：画布照 strokes 画出来（2026-10-25 P0-2）
    const strokes = ev.board && Array.isArray(ev.board.strokes) ? ev.board.strokes : null
    if (strokes && strokes.length > 0) {
      appendBoard(state.listEl || state.body, strokes)
      state.items.push({ role: 'board', text: '', strokes })
    }
    return
  }
  if (t === 'error' || t === 'stderr' || t === 'raw') {
    const msg = String(ev.message || ev.text || '')
    state.streamBuf = '（出错了：' + msg.slice(0, 200) + '）'
    flushStream()
    finishStream()
    state.streaming = false
    if (state.pendingUser.length > 0) flushPendingUser()
    return
  }
  if (t === 'exit') {
    finishStream()
    state.streaming = false
    if (state.pendingUser.length > 0) flushPendingUser()
  }
}

/** 自检用：现在状态里有几条、最后一条她说了什么 */
export function chatDebug() {
  const lastItem = [...state.items].reverse().find((i) => i.role === 'assistant')
  return { items: state.items.length, streaming: state.streaming, last: String(state.streamBuf || (lastItem && lastItem.text) || '') }
}
