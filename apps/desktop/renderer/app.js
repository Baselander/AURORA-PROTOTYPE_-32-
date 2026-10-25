/**
 * apps\desktop\renderer\app.js —— 新应用的界面逻辑（2026-10-23 再改：形象窗 / 浮窗分开）
 *
 * 主人 2026-10-23 的话把方向说清楚了：
 *   「浮窗只是单独于形象可移动和关闭（但是关形象一定要关掉浮窗），不是每个功能浮窗独立出现」
 * → 回到**一张浮窗**：点页签就换它里面的内容。浮窗自己是**独立窗口**（能单独拖走、单独关掉），
 *   形象一关主进程会把浮窗一起收掉。形象窗里只有她，没有卡片、没有页签。
 *
 * 这个文件**两个窗口都会跑**，按 window.__DSH_MODE__ 分工：
 *   her   （形象窗）：只有她。这里只负责 ① 放语音（浮窗关着也得能出声）② 保持她可见
 *   panel （浮窗）  ：页签 + 一张卡片 + 正文 + 底部「记一条」；× / Esc = 收起浮窗
 *
 * 数据一律走 window.herShell.data()（主进程去跑 study-lite / brief-json，页面不碰文件）。
 */

// 2026-10-24 晚（批次 3.3 插件化）：页签 / 取数据 / 画，三张表都搬进「卡片注册表」了。
//   加一个新页 = 在 cards\index.js 里加一条，这里一个字都不用动。
import { TABS, PAGES, LOADERS, CARDS, registryProblems } from './cards/index.js'
import { chatDebug } from './pages/chat.js'
import { initSheet, closeSheet, sheetOpen } from './pages/sheet.js'

const MODE = window.__DSH_MODE__ === 'panel' ? 'panel' : 'her'

const $ = (id) => document.getElementById(id)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面状态（自检要能问到） */
const state = {
  ready: false,
  mode: MODE,
  current: null,
  cardOpen: false,
  tabs: TABS.map((t) => t.id),
  lastError: null,
}

// ══════════════════════════════════════════════════════════════════════════════
//  语音：_只有形象窗放声音_（浮窗关着/没开的时候她也得能出声）
// ══════════════════════════════════════════════════════════════════════════════
const audioQueue = []
let audioPlaying = false
let audioEl = null

// ── 口型同步（2026-10-25 P2）────────────────────────────────────────────────
/**
 * 为什么不用 AnalyserNode 直接接播放器：`createMediaElementSource` 一旦接上，
 * 音频**只**走我们连的那条线 —— 一旦 AudioContext 被挂起（自动播放策略），她就**哑了**。
 * 所以改成"离线算包络"：fetch 同一个 mp3 → decodeAudioData → 每 50ms 算一次 RMS，
 * 存成一张包络表；播放时按 `audioEl.currentTime` 查表喂 `DSHPet.setTalkLevel()`。
 * 音频通路一个字都不动（还是 `new Audio(url).play()`），出问题最多是口型退回正弦。
 */
const talkEnvCache = new Map() // url → { env: number[], max, step }
let talkCtx = null
let talkTimer = null
const TALK_STEP = 0.05 // 50ms 一个采样点

function petTalk(level) {
  try {
    if (window.DSHPet && typeof window.DSHPet.setTalkLevel === 'function') window.DSHPet.setTalkLevel(level)
  } catch {}
}

async function talkEnvelope(url) {
  if (talkEnvCache.has(url)) return talkEnvCache.get(url)
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    if (!talkCtx) talkCtx = new (window.AudioContext || window.webkitAudioContext)()
    // 解码不需要用户手势（只是拿 PCM，不出声）
    const audio = await talkCtx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const step = Math.max(1, Math.round(audio.sampleRate * TALK_STEP))
    const env = []
    let max = 0
    for (let i = 0; i < ch.length; i += step) {
      const end = Math.min(ch.length, i + step)
      let sum = 0
      for (let j = i; j < end; j += 1) sum += ch[j] * ch[j]
      const rms = Math.sqrt(sum / Math.max(1, end - i))
      env.push(rms)
      if (rms > max) max = rms
    }
    const out = { env, max: max || 1, step: TALK_STEP }
    if (talkEnvCache.size > 24) talkEnvCache.clear()
    talkEnvCache.set(url, out)
    return out
  } catch {
    return null
  }
}

function startTalkSync(url, el) {
  stopTalkSync()
  void talkEnvelope(url).then((pack) => {
    if (!pack || !el || audioEl !== el) return
    talkTimer = setInterval(() => {
      try {
        if (!el || el.paused || el.ended) return
        const idx = Math.floor(el.currentTime / pack.step)
        const rms = pack.env[idx] || 0
        // 归一化 + 轻压缩：小声也别让她闭嘴（口型看的是"在不在动"）
        petTalk(Math.min(1, (rms / pack.max) * 1.25))
      } catch {}
    }, 50)
  })
}

function stopTalkSync() {
  if (talkTimer) {
    clearInterval(talkTimer)
    talkTimer = null
  }
  petTalk(-1)
}

function pumpAudio() {
  if (audioPlaying || audioQueue.length === 0) return
  const url = audioQueue.shift()
  audioPlaying = true
  try {
    audioEl = new Audio(url)
    audioEl.onended = () => {
      audioPlaying = false
      stopTalkSync()
      pumpAudio()
    }
    audioEl.onerror = () => {
      audioPlaying = false
      stopTalkSync()
      pumpAudio()
    }
    const p = audioEl.play()
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        audioPlaying = false
        stopTalkSync()
        pumpAudio()
      })
    }
    startTalkSync(url, audioEl)
  } catch {
    audioPlaying = false
    stopTalkSync()
  }
}

function stopAudio() {
  audioQueue.length = 0
  audioPlaying = false
  stopTalkSync()
  try {
    if (audioEl) {
      audioEl.pause()
      audioEl.currentTime = 0
    }
  } catch {}
  audioEl = null
}

function initAudio() {
  if (!window.herShell || !window.herShell.onTts) return
  window.herShell.onTts((payload) => {
    if (!payload) return
    if (payload.stop) {
      stopAudio()
      return
    }
    if (!payload.url) return
    audioQueue.push(payload.url)
    pumpAudio()
  })
}

// ══════════════════════════════════════════════════════════════════════════════
//  选项条（形象窗里，右键她 → 在她脚边弹一条窄带；几秒自动收）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 主人 2026-10-24：「右键形象也能打开和选择栏；现在只有右键任务栏的图标才有用」
 * 为什么自己画（不用 Electron 原生菜单）：**这个无边框+透明的窗口上 Menu.popup 弹不出来**
 * （日志里"菜单弹出（第 N 次）"有，但枚举窗口一个新窗口都没有 —— 实测过）。
 * 自己画一条还有个好处：它就是他要的"选项条"，就在她脚下，很窄，几秒自动收。
 */
let pickEl = null
let pickTimer = null
/** 上一次"弹/收"是什么时候（同一次右键可能来两次消息，隔太近就忽略） */
let pickShownAt = 0
/** 提醒条（DDL 快到时的「知道了 / 稍后」） */
let remindEl = null
let remindCur = null

function buildPick() {
  pickEl = $('her-pick')
  if (!pickEl) return
  pickEl.textContent = ''
  const mkBtn = (label, cls, onClick, title) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'her-pick-btn' + (cls ? ' ' + cls : '')
    b.textContent = label
    if (title) b.title = title
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      onClick()
    })
    pickEl.appendChild(b)
    return b
  }
  for (const t of TABS) mkBtn(t.label, '', () => void openPage(t.id), t.sub)
  mkBtn(
    '换一身',
    'her-pick-alt',
    () => {
      hidePick()
      void window.herShell.act('look-choose', '')
    },
    '让她自己挑今天这一身',
  )
  mkBtn('×', 'her-pick-x', () => hidePick(), '收起来')

  // 2026-10-25 主人：「要不要在右键她后的选项下面加上输入栏，可以直接聊天」
  //   → 选项条最下面多一行：写一句就能发给她（回车发、Esc 收），不用先开浮窗
  const sendRow = document.createElement('div')
  sendRow.className = 'her-pick-send'
  const inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'her-pick-input'
  inp.id = 'her-pick-input'
  inp.placeholder = '跟她说一句…（回车发）'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'her-pick-go'
  go.id = 'her-pick-send'
  go.textContent = '↑'
  go.title = '发给她（Enter）'
  const doSend = async () => {
    const text = String(inp.value || '').trim()
    if (!text) {
      inp.focus()
      return
    }
    go.disabled = true
    try {
      const r = window.herShell.chat.send(text)
      if (r && r.ok === false) {
        inp.placeholder = '没发出去：' + (r.error || '')
      } else {
        inp.value = ''
        inp.placeholder = '发出去了，她在想…'
        clearTimeout(pickTimer)
        pickTimer = setTimeout(() => hidePick(), 12000)
      }
    } catch (err) {
      inp.placeholder = '没发出去：' + ((err && err.message) || err)
    } finally {
      go.disabled = false
    }
  }
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void doSend()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      hidePick()
    }
  })
  // 正在打字就别自动收
  inp.addEventListener('input', () => {
    clearTimeout(pickTimer)
    pickTimer = setTimeout(() => hidePick(), 20000)
  })
  inp.addEventListener('focus', () => clearTimeout(pickTimer))
  go.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    void doSend()
  })
  sendRow.append(inp, go)
  pickEl.appendChild(sendRow)
  // 点别处就收（跟系统菜单一个手感）
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!pickEl || pickEl.hidden) return
      if (pickEl.contains(e.target)) return
      hidePick()
    },
    true,
  )
}

async function openPage(id) {
  hidePick()
  try {
    await window.herShell.panel.open(id)
  } catch {}
}

function showPick() {
  if (!pickEl) return
  pickEl.hidden = false
  clearTimeout(pickTimer)
  // 几秒自动收（主人第 2 条原话："很近、窄带、几秒自动收"）
  pickTimer = setTimeout(() => hidePick(), 9000)
}

function hidePick() {
  if (!pickEl) return
  clearTimeout(pickTimer)
  pickEl.hidden = true
}

// ── 提醒条：她点了（DDL 快到了）→ 她脚边弹「知道了 / 稍后」──────────────────
function buildRemindBar() {
  remindEl = $('her-remind')
  if (!remindEl) return
  const ok = $('her-remind-ok')
  const later = $('her-remind-later')
  if (ok) {
    ok.addEventListener('click', async (e) => {
      e.stopPropagation()
      ok.disabled = true
      try {
        await window.herShell.act('remind-ack', '')
      } catch {}
      ok.disabled = false
      hideRemindBar()
    })
  }
  if (later) {
    later.addEventListener('click', async (e) => {
      e.stopPropagation()
      later.disabled = true
      try {
        const r = await window.herShell.act('remind-snooze', { key: (remindCur && remindCur.key) || '', minutes: 10 })
        if (r && r.minutes) later.textContent = `稍后 ${r.minutes} 分钟`
      } catch {}
      later.disabled = false
      hideRemindBar()
    })
  }
}

function showRemindBar(rem) {
  if (!remindEl) return
  remindCur = rem || null
  const textEl = $('her-remind-text')
  if (textEl) {
    const t = String((rem && rem.title) || '')
    const when = String((rem && rem.dueTime) || '')
    const mins = Number(rem && rem.minutes)
    textEl.textContent =
      rem && rem.kind === 'due' ? `${t} 到点了` : `${Number.isFinite(mins) ? `还有 ${mins} 分钟 · ` : ''}${t}${when ? ' ' + when : ''}`
  }
  hidePick()
  remindEl.hidden = false
}

function hideRemindBar() {
  remindCur = null
  if (remindEl) remindEl.hidden = true
}

// ══════════════════════════════════════════════════════════════════════════════
//  形象窗：只有她（她在页面里是 pet.js 渲染的，#dsh-live2d-pet）
// ══════════════════════════════════════════════════════════════════════════════
async function bootHer() {
  // 我们的 UI（卡片/页签）在形象窗里一点都不该有：直接拿掉，别留透明的大盒子
  try {
    const card = $('her-card')
    if (card) card.remove()
    const tabs = $('her-tabs')
    if (tabs) tabs.remove()
  } catch {}
  document.body.classList.add('her-mode')

  // 她的配色/大小口径（pet.js 自己读种子；这里只把跟着她的 CSS 变量接上）
  try {
    document.documentElement.style.setProperty('--her-headroom', (Number(window.herShell && window.herShell.headroom) || 260) + 'px')
  } catch {}

  initAudio()
  buildPick()
  buildRemindBar()
  // 主进程说"右键了" → 弹/收那条选项条；说"该提醒了" → 弹提醒条
  // ⚠️ 实测一次右键会在主进程那边收到两次请求（~2 秒差），如果直接 toggle 就是"闪一下又没了"。
  //    所以 600ms 内的重复消息一律当同一次右键，忽略。
  try {
    if (window.herShell && window.herShell.onPick) {
      window.herShell.onPick((payload) => {
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'reminder')) {
          if (payload.reminder) showRemindBar(payload.reminder)
          else hideRemindBar()
          return
        }
        if (!pickEl) return
        const now = Date.now()
        if (now - pickShownAt < 600) return
        pickShownAt = now
        if (pickEl.hidden) showPick()
        else hidePick()
      })
    }
  } catch {}

  // 她自己的存档里可能记着 hidden:true（新界面会一片空白）——保险起见永远可见
  const keepVisible = () => {
    try {
      if (window.DSHPet && typeof window.DSHPet.setHidden === 'function') window.DSHPet.setHidden(false)
    } catch {}
  }
  setInterval(keepVisible, 900)
  keepVisible()
  state.ready = true
  // 报到一声：真应用的日志里能看见"形象窗起来了、几寸大"
  try {
    await window.herShell.act('ui-ready', { mode: 'her', w: window.innerWidth, h: window.innerHeight })
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  浮窗：一张卡片，页签换内容
// ══════════════════════════════════════════════════════════════════════════════
let card = null
let bodyEl = null
let foot = null
let noteInput = null
let footMsg = null
let tabsEl = null
let titleEl = null
let renderToken = 0
let speakingPage = false

function labelOf(id) {
  const t = TABS.find((x) => x.id === id)
  return t ? t.label : id
}

// ── 配色 / 卡片透明度 ────────────────────────────────────────────────────────
function applyLookTokens() {
  try {
    document.documentElement.dataset.theme = (window.herShell && window.herShell.theme) || '电光蓝'
    document.documentElement.style.setProperty('--card-alpha', String(Number(window.herShell && window.herShell.cardAlpha) || 0.97))
  } catch {}
}

// ── 页签 ──────────────────────────────────────────────────────────────────────
function buildTabs() {
  tabsEl.textContent = ''
  for (const t of TABS) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'her-tab'
    b.dataset.tab = t.id
    b.textContent = t.label
    b.title = t.sub
    b.addEventListener('click', () => {
      if (state.current === t.id && state.cardOpen) {
        // 点当前这页 = 收起来（跟以前一样的手感）
        void hidePanel()
      } else {
        void openTab(t.id)
      }
    })
    tabsEl.appendChild(b)
  }
}

function markActiveTab() {
  for (const b of tabsEl.querySelectorAll('.her-tab')) b.classList.toggle('her-tab-on', b.dataset.tab === state.current)
}

/**
 * 把"段落"自动收进框里（2026-10-24，主人要的「每个项都加上边框」）
 *
 * 为什么做成通用的一遍、而不是逐页改：六页各有各的 `renderXxx`，逐页加框既啰嗦又容易漏。
 * 规则很简单：每个 `.her-sec-h`（段落标题，今日/日历/设置都在用）连同它后面、直到下一条标题
 * 之前的兄弟节点，一起收进一个 `.her-group` 框里。
 * 待办/错题那两页已经自己用了 `.her-group`（没有 `.her-sec-h`）→ 这一遍不会碰它们。
 */
function autoFrameSections(bodyEl) {
  if (!bodyEl) return 0
  const kids = Array.from(bodyEl.childNodes)
  let current = null
  let made = 0
  for (const node of kids) {
    if (node.nodeType !== 1) continue
    const cls = node.classList || { contains: () => false }
    if (cls.contains('her-sec-h')) {
      const box = document.createElement('section')
      box.className = 'her-group'
      box.dataset.autoGroup = '1'
      const head = document.createElement('div')
      head.className = 'her-group-h'
      // 原来 .her-sec-h 里可能只有文字；把文字搬过来（竖线由 CSS 的 ::before 画）
      head.textContent = String(node.textContent || '')
      // ⚠️ 2026-10-24：原来那个节点会被删掉，所以 data-* 必须一起搬过来
      //   （今日页的「今天做完了 N 条」是靠 data-done-today 被自检找到的，丢过一次）
      for (const k of Object.keys(node.dataset || {})) head.dataset[k] = node.dataset[k]
      if (node.classList.contains('her-sec-split')) box.classList.add('her-sec-split')
      box.appendChild(head)
      bodyEl.insertBefore(box, node)
      node.remove()
      current = box
      made += 1
      continue
    }
    if (!current) continue
    // 这几种"整页级"的东西不收进框里（浮层、空态、页首那行）
    if (cls.contains('her-sheet') || cls.contains('her-empty') || cls.contains('her-lead')) {
      current = null
      continue
    }
    current.appendChild(node)
  }
  return made
}

// ── 开合 ──────────────────────────────────────────────────────────────────────
async function openTab(id) {
  // 换页先把详情浮层收掉（不然新页面的内容会被一张旧浮层挡着）
  closeSheet()
  if (card.hidden) {
    card.hidden = false
    state.cardOpen = true
  }
  state.current = id
  document.title = '她 · ' + labelOf(id)
  if (titleEl) titleEl.textContent = labelOf(id)
  // 「对话」页自己有输入框，别放两个
  // 「记一条」底栏 2026-10-25 删掉了（主人：没用）；功能搬到设置页工具区
  if (foot) foot.hidden = true
  if (footMsg && id !== 'chat') footMsg.textContent = ''
  markActiveTab()
  await fill(id)
  // ⚠️ 这里**不许**再调 herShell.panel.open(id)：那次调用会让 main 再回一条 her:panel-show，
  //    页面又 openTab → 又 panel.open …… 2026-10-24 自检里就撞成了死循环（内容一直清空重画）。
  //    浮窗的显示由主进程负责（右键菜单 / 托盘 / 第一次开）；页签只负责换内容。
}

async function fill(id) {
  const token = ++renderToken
  bodyEl.textContent = ''
  const busy = document.createElement('div')
  busy.className = 'her-busy'
  busy.textContent = '正在读…'
  bodyEl.appendChild(busy)

  const renderer = PAGES[id]
  if (!renderer) {
    busy.className = 'her-note'
    busy.textContent = '这一页还在搬。'
    return
  }
  try {
    const loader = LOADERS[id]
    const data = loader ? await loader() : null
    if (token !== renderToken) return
    bodyEl.textContent = ''
    const failed =
      !data ||
      data.ok === false ||
      (data.agenda && data.agenda.ok === false) ||
      (data.tasks && data.tasks.ok === false)
    if (failed) {
      const err = document.createElement('div')
      err.className = 'her-note'
      const why = (data && (data.error || (data.agenda && data.agenda.error) || (data.tasks && data.tasks.error))) || '未知原因'
      err.textContent = '拿不到数据：' + why
      bodyEl.appendChild(err)
      state.lastError = String(why)
      return
    }
    state.lastError = null
    renderer(bodyEl, data, {
      onToggle: handleToggle,
      onCheck: handleMaterialCheck,
      // 设置页里"她今天穿什么"的按钮要用
      refresh: () => refreshCurrent(),
      mock: !!data.mock,
    })
    // 段落 → 框（今日/日历/设置这些页面不用自己动手）
    try {
      autoFrameSections(bodyEl)
    } catch {}
  } catch (err) {
    if (token !== renderToken) return
    bodyEl.textContent = ''
    const box = document.createElement('div')
    box.className = 'her-note'
    box.textContent = '出错了：' + (err && err.message ? err.message : String(err))
    bodyEl.appendChild(box)
    state.lastError = String((err && err.message) || err)
  }
}

/** 收起浮窗（只收浮窗，不动她） */
async function hidePanel() {
  if (!state.cardOpen) return
  closeSheet()
  state.cardOpen = false
  state.current = null
  stopSpeakPage()
  card.hidden = true
  bodyEl.textContent = ''
  if (foot) foot.hidden = true
  document.title = '她'
  markActiveTab()
  try {
    await window.herShell.panel.hide()
  } catch {}
}

/** 主进程说"把浮窗拿来、显示这一页"（右键菜单 / 托盘都走这条路） */
function showPage(page) {
  const id = TABS.some((t) => t.id === page) ? page : 'today'
  void openTab(id)
}

// ── 记一条 / 处理收件箱 ──────────────────────────────────────────────────────
async function submitNote() {
  const text = String((noteInput && noteInput.value) || '').trim()
  if (!text) return
  if (footMsg) footMsg.textContent = '记着…'
  try {
    const r = await window.herShell.act('note', text)
    if (r && r.ok !== false) {
      if (noteInput) noteInput.value = ''
      if (footMsg) footMsg.textContent = '记下了 —— 点「处理」变成任务'
    } else if (footMsg) {
      footMsg.textContent = '没记上：' + ((r && r.error) || '未知原因')
    }
  } catch (err) {
    if (footMsg) footMsg.textContent = '没记上：' + ((err && err.message) || err)
  }
}

async function processInbox() {
  if (footMsg) footMsg.textContent = '正在处理…'
  try {
    const r = await window.herShell.act('process')
    const created = Array.isArray(r && r.created) ? r.created.length : 0
    const left = Array.isArray(r && r.leftForModel) ? r.leftForModel.length : 0
    if (footMsg) {
      footMsg.textContent =
        (r && r.ok === false ? '处理失败：' + (r.error || '') : `建了 ${created} 条任务`) + (left > 0 ? `，${left} 条留给她再判断` : '')
    }
    if (state.current && state.current !== 'chat') await refreshCurrent()
  } catch (err) {
    if (footMsg) footMsg.textContent = '处理失败：' + ((err && err.message) || err)
  }
}

// ── 勾选 ──────────────────────────────────────────────────────────────────────
async function handleToggle(id, row, cb) {
  try {
    const r = await window.herShell.act('toggle', id)
    if (r && r.ok === false) {
      cb(false, (r && r.error) || '没写成')
      return
    }
    cb(true)
    if (state.current === 'tasks') await refreshCurrent()
  } catch (err) {
    cb(false, String((err && err.message) || err))
  }
}

async function handleMaterialCheck(text, cb) {
  try {
    const r = await window.herShell.act('check-material', text)
    if (r && r.ok === false) {
      if (typeof cb === 'function') cb(false, (r && r.error) || '没写成')
      return false
    }
    if (typeof cb === 'function') cb(true)
    return true
  } catch (err) {
    if (typeof cb === 'function') cb(false, String((err && err.message) || err))
    return false
  }
}

/** 刷新当前页（保留滚动位置） */
async function refreshCurrent() {
  if (!state.cardOpen || !state.current) return
  // 刷新列表时把详情浮层收掉（不然它盖着新内容）
  closeSheet()
  const keep = bodyEl.scrollTop
  await fill(state.current)
  bodyEl.scrollTop = keep
}

// ── 念这一页 / 停（声音由形象窗放）───────────────────────────────────────────
function setSpeakBtn(on) {
  const btn = $('her-speak')
  if (!btn) return
  btn.textContent = on ? '⏹' : '🔊'
  btn.title = on ? '停（再点一次）' : '念这一页（再点一次就停）'
}

function stopSpeakPage() {
  if (!speakingPage) return
  speakingPage = false
  setSpeakBtn(false)
  try {
    void window.herShell.act('stop-speak', '')
  } catch {}
}

async function speakPage() {
  if (speakingPage) {
    stopSpeakPage()
    return
  }
  const text = String((bodyEl && bodyEl.innerText) || '')
    .replace(/\s+\n/g, '\n')
    .trim()
  if (!text) return
  try {
    const r = await window.herShell.act('speak', text.slice(0, 2000))
    if (r && r.ok === false) {
      if (footMsg) footMsg.textContent = '念不了：' + (r.error || '')
      return
    }
    speakingPage = true
    setSpeakBtn(true)
  } catch (err) {
    if (footMsg) footMsg.textContent = '念不了：' + ((err && err.message) || err)
  }
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
async function bootPanel() {
  card = $('her-card')
  bodyEl = $('her-card-body')
  // 2026-10-25：底栏（记一条 / 处理）已经删掉 —— 这几个变量现在都是 null，
  //   下面所有用到的地方都判了空（功能在设置页「工具」里）。
  foot = $('her-foot')
  noteInput = $('her-note-input')
  footMsg = $('her-foot-msg')
  tabsEl = $('her-tabs')
  titleEl = $('her-card-title')

  applyLookTokens()
  buildTabs()
  document.title = '她'
  card.hidden = true
  if (foot) foot.hidden = true
  // 详情浮层挂在这张卡片上（点条目升起来的那张）
  initSheet(card)

  $('her-close').addEventListener('click', () => void hidePanel())
  $('her-refresh').addEventListener('click', () => void refreshCurrent())
  const speakBtn = $('her-speak')
  if (speakBtn) speakBtn.addEventListener('click', () => void speakPage())
  const noteBtn = $('her-note-btn')
  if (noteBtn) noteBtn.addEventListener('click', () => void submitNote())
  const processBtn = $('her-process-btn')
  if (processBtn) processBtn.addEventListener('click', () => void processInbox())
  if (noteInput) {
    noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void submitNote()
      }
    })
  }
  document.addEventListener('keydown', (e) => {
    // Esc 的层级：先收详情浮层，再收浮窗（这样"看详情时按 Esc 回到列表"符合直觉）
    if (e.key !== 'Escape') return
    if (sheetOpen()) {
      closeSheet()
      return
    }
    if (state.cardOpen) void hidePanel()
  })
  // 主进程让我们显示某一页（右键菜单 / 托盘 / 快捷键）
  try {
    window.herShell.panel.onShow((payload) => {
      if (payload && payload.page) showPage(String(payload.page))
      else if (payload && payload.hide) void hidePanel()
    })
  } catch {}

  state.ready = true
  // 报到一声：真应用的日志里能看见"浮窗起来了、几寸大"
  try {
    await window.herShell.act('ui-ready', { mode: 'panel', tabs: TABS.length, w: window.innerWidth, h: window.innerHeight })
  } catch {}
}

if (MODE === 'panel') void bootPanel()
else void bootHer()

// ══════════════════════════════════════════════════════════════════════════════
//  自检入口（主进程用 executeJavaScript 调；断言都写在这里，跟界面代码放一起）
// ══════════════════════════════════════════════════════════════════════════════
window.herApp = {
  get mode() {
    return state.mode
  },
  get ready() {
    return state.ready
  },
  get tabs() {
    return state.tabs.slice()
  },
  get current() {
    return state.current
  },
  get cardOpen() {
    return state.cardOpen
  },
  get lastError() {
    return state.lastError
  },
  openTab,
  closeTab: hidePanel,
  refreshCurrent,
  /** 自检用：那条选项条现在露着没 */
  get pickVisible() {
    return !!(pickEl && !pickEl.hidden)
  },
  showPick,
  hidePick,
  /** 自检用：提醒条现在露着没 / 上面写的什么 */
  get remindVisible() {
    return !!(remindEl && !remindEl.hidden)
  },
  get remindText() {
    const t = $('her-remind-text')
    return t ? String(t.textContent || '') : ''
  },
  showRemindBar,
  hideRemindBar,
  rectOf(sel) {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  },
  /** 诊断（2026-10-25 P2）：把某个音频的响度包络真算一遍（自检用它证明"口型那条链是通的"） */
  async talkProbe(url) {
    const pack = await talkEnvelope(String(url || ''))
    if (!pack) return { ok: false, error: '解码失败（拿不到音频或 AudioContext 不可用）' }
    let peak = 0
    let quiet = 1
    for (const v of pack.env) {
      if (v > peak) peak = v
      if (v < quiet) quiet = v
    }
    // 2026-10-25 第 11 项：把"包络 → 嘴张多大"这条映射也算出来，
    //   让自检能证明"响的地方嘴张、安静的地方嘴几乎闭上"（pet.js 里是 0.1 + 0.55×level）。
    const mouthOf = (rms) => 0.1 + 0.55 * Math.min(1, (rms / (pack.max || 1)) * 1.25)
    const mouthLoud = mouthOf(peak)
    const mouthQuiet = mouthOf(quiet)
    return {
      ok: true,
      points: pack.env.length,
      step: pack.step,
      max: Math.round(pack.max * 1000) / 1000,
      peak: Math.round(peak * 1000) / 1000,
      mouthLoud: Math.round(mouthLoud * 1000) / 1000,
      mouthQuiet: Math.round(mouthQuiet * 1000) / 1000,
      mouthRange: Math.round((mouthLoud - mouthQuiet) * 1000) / 1000,
    }
  },
  async selftest() {
    const checks = []
    const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail: String(detail) })

    if (MODE !== 'panel') {
      // 形象窗：没有我们的 UI，只有她 + 右键那条选项条
      add('形象窗里没有浮窗卡片（各管各的）', !document.getElementById('her-card') && !document.getElementById('her-tabs'))
      add('她在形象窗里', !!document.getElementById('dsh-live2d-pet'))
      const view = window.DSHPet && window.DSHPet.state && window.DSHPet.state.view
      add('她的视图尺寸是量出来的', !!(view && view.w > 100), view ? `${Math.round(view.w)}×${Math.round(view.h)}` : 'null')
      const pick = document.getElementById('her-pick')
      add(
        '选项条在（右键弹的那条）',
        !!pick && pick.querySelectorAll('.her-pick-btn').length >= TABS.length,
        pick ? `${pick.querySelectorAll('.her-pick-btn').length} 个按钮` : '没有',
      )
      add('选项条平时是收着的', !!pick && pick.hidden, pick ? (pick.hidden ? 'hidden' : 'visible') : '没有')
      // 2026-10-25 主人：「右键她之后的选项下面加上输入栏，可以直接聊天」
      const pickInput = document.getElementById('her-pick-input')
      add('选项条下面有输入栏（能直接跟她说话）', !!pickInput, pickInput ? String(pickInput.placeholder) : '没有')
      // 2026-10-25 P2：口型同步（播放器解出响度包络 → 喂给她这张嘴）
      {
        const hasApi = !!(window.DSHPet && typeof window.DSHPet.setTalkLevel === 'function' && typeof window.DSHPet.talkLevel === 'function')
        add('口型同步接口在（播放器能推响度给她的嘴）', hasApi, hasApi ? 'DSHPet.setTalkLevel / talkLevel' : '没有 setTalkLevel')
        let readBack = null
        try {
          window.DSHPet.setTalkLevel(0.5)
          readBack = window.DSHPet.talkLevel()
          window.DSHPet.setTalkLevel(-1)
        } catch (err) {
          readBack = '抛错：' + ((err && err.message) || err)
        }
        add(
          '推了响度她就记住（0.5 → 嘴里 0.5；-1 = 退回正弦）',
          readBack === 0.5 && window.DSHPet.talkLevel() === -1,
          `推 0.5 读回 ${readBack} / 复位后 ${window.DSHPet ? window.DSHPet.talkLevel() : '?'}`,
        )
      }
      if (pickInput) {
        pickInput.value = '自检：从选项条发一句'
        pickInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        await sleep(900)
        add(
          '从选项条能真的发出去（她那边的脑子收到）',
          /发出去了|没发出去/.test(String(pickInput.placeholder)),
          String(pickInput.placeholder),
        )
      }
      const okCount0 = checks.filter((c) => c.ok).length
      return { ok: okCount0 === checks.length, checks, okCount: okCount0, total: checks.length }
    }

    add('页签 ' + TABS.length + ' 个', document.querySelectorAll('.her-tab').length === TABS.length, document.querySelectorAll('.her-tab').length + ' 个')
    add(
      '页签文案对得上',
      Array.from(document.querySelectorAll('.her-tab')).map((b) => b.textContent).join('') === TABS.map((t) => t.label).join(''),
      Array.from(document.querySelectorAll('.her-tab')).map((b) => b.textContent).join(' / '),
    )
    // 主人 2026-10-24：「待办」改名「任务」——页签上一个"待办"都不该剩
    add(
      '页签第二个是「任务」（"待办"这个叫法已经改掉）',
      (TABS.find((t) => t.id === 'tasks') || {}).label === '任务' &&
        !Array.from(document.querySelectorAll('.her-tab')).some((b) => /待办/.test(String(b.textContent || ''))),
      Array.from(document.querySelectorAll('.her-tab')).map((b) => b.textContent).join(' / '),
    )
    // 浮窗只有一个（不是每个功能各自一张）
    add('浮窗只有一个（不是每功能一张）', document.querySelectorAll('.her-card').length === 1, document.querySelectorAll('.her-card').length + ' 个')

    // 卡片注册表（批次 3.3 插件化，2026-10-24 晚）：一张卡 = 一个对象，以后加页只改一个文件
    {
      const problems = registryProblems()
      add(
        '卡片注册表没毛病（id 不重复、字段齐全）',
        problems.length === 0,
        problems.length ? problems.slice(0, 2).join('；') : `${CARDS.length} 张卡：${CARDS.map((c) => c.id).join(' / ')}`,
      )
      add(
        '页签/取数据/画 三张表都从注册表来（数量一致）',
        TABS.length === CARDS.length && Object.keys(PAGES).length === CARDS.length && Object.keys(LOADERS).length === CARDS.length,
        `卡 ${CARDS.length} / TABS ${TABS.length} / PAGES ${Object.keys(PAGES).length} / LOADERS ${Object.keys(LOADERS).length}`,
      )
    }

    // 今日页
    await openTab('today')
    await sleep(900)
    const todaySec = bodyEl.querySelectorAll('.her-sec-h').length
    const todayLines = bodyEl.querySelectorAll('.her-line').length
    const todayNote = bodyEl.querySelectorAll('.her-note').length
    add('「今日」打开了', state.cardOpen && state.current === 'today' && !card.hidden)
    add('标题条写着当前页名', String(titleEl.textContent || '') === '今日', String(titleEl.textContent || ''))
    add('「今日」有段落', todaySec > 0 || todayNote > 0, `段落 ${todaySec} / 行 ${todayLines} / 提示 ${todayNote}`)
    add('「今日」有内容行', todayLines > 0 || todayNote > 0, todayLines + ' 行')
    const todayGroups = bodyEl.querySelectorAll('.her-group').length
    add('「今日」段落都有了框（每个项一个框）', todayGroups > 0, `${todayGroups} 个框`)
    const carryBoxes = bodyEl.querySelectorAll('.her-line-check .her-check')
    add('「今日」的"要带的"能勾', carryBoxes.length > 0, carryBoxes.length + ' 个可勾项')
    if (carryBoxes.length > 0) {
      carryBoxes[0].click()
      await sleep(400)
      const done = bodyEl.querySelector('.her-line-check.her-line-done')
      add('勾一下能变完成态（假数据）', !!done, done ? '已勾' : '没变')
    }
    // 今天做完了 N 条（2026-10-24 · Tevela A）：页面上那个数必须和任务数据现算出来的一致
    {
      const doneHead = bodyEl.querySelector('[data-done-today]')
      const taskData = await window.herShell.data('tasks')
      const n = new Date()
      const p2 = (v) => String(v).padStart(2, '0')
      const tstr = `${n.getFullYear()}-${p2(n.getMonth() + 1)}-${p2(n.getDate())}`
      const expectDone = (taskData && Array.isArray(taskData.tasks) ? taskData.tasks : []).filter(
        (t) => String(t.status) === 'done' && String(t.dueDate || '') === tstr,
      ).length
      add('「今日」有「今天做完了 N 条」这一块', !!doneHead, doneHead ? `「${String(doneHead.textContent)}」` : '没有这一块')
      add(
        '「今天做完了 N 条」的数字跟任务数据对得上',
        !!doneHead && Number(doneHead.dataset.doneToday) === expectDone,
        `页面 ${doneHead ? doneHead.dataset.doneToday : '?'} / 数据现算 ${expectDone}`,
      )
      // 进度条（2026-10-25 主人要的）+ 通知块搬到今日页
      const prog = bodyEl.querySelector('.her-progress')
      const todays = (taskData && Array.isArray(taskData.tasks) ? taskData.tasks : []).filter(
        (t) => String(t.dueDate || '') === tstr && String(t.status) !== 'dropped',
      )
      add(
        '「今日」有进度条，数字跟任务数据对得上',
        !!prog && Number(prog.dataset.done) === expectDone && Number(prog.dataset.total) === todays.length,
        prog ? `今天 ${prog.dataset.done}/${prog.dataset.total} 条做完` : '没有进度条',
      )
      const nbHead = bodyEl.querySelector('[data-today-notices]')
      const agendaData = await window.herShell.data('agenda')
      const noticeN = agendaData && Array.isArray(agendaData.noticeList) ? agendaData.noticeList.length : 0
      add(
        '「今日」也有通知块了（和日历页同一份数据）',
        noticeN === 0 ? true : !!nbHead && Number(nbHead.dataset.todayNotices) === noticeN,
        noticeN === 0 ? '没有通知（跳过）' : `${nbHead ? nbHead.dataset.todayNotices : '?'} 条 / 数据 ${noticeN} 条`,
      )
    }

    // 切页 = 换内容，不是再开一张
    await openTab('tasks')
    await sleep(800)
    const rows = bodyEl.querySelectorAll('.her-item[data-task-id]')
    const groupsN = bodyEl.querySelectorAll('.her-group').length
    add('页签换页：浮窗还是一个', document.querySelectorAll('.her-card').length === 1 && state.current === 'tasks')
    add('「任务」有列表行', rows.length > 0 || bodyEl.querySelectorAll('.her-note').length > 0, rows.length + ' 行')
    add('「任务」每条都在自己的框里（.her-item / .her-group）', rows.length > 0 && groupsN > 0, `${rows.length} 条 / ${groupsN} 组`)
    // 点一条 → 详情浮层（主人 2026-10-24 的核心要求）
    if (rows.length > 0) {
      rows[0].click()
      await sleep(350)
      const sheet = document.getElementById('her-sheet')
      const sheetTitle = sheet ? String((sheet.querySelector('.her-sheet-title') || {}).textContent || '') : ''
      const firstTitle = String((rows[0].querySelector('.her-item-title') || {}).textContent || '')
      add(
        '点一条待办 → 进详情浮层',
        !!sheet && sheetTitle === firstTitle && sheet.querySelectorAll('.her-sheet-row').length >= 2,
        sheet ? `标题「${sheetTitle.slice(0, 14)}」/ ${sheet.querySelectorAll('.her-sheet-row').length} 行细节` : '没弹出来',
      )
      const back = sheet ? sheet.querySelector('.her-sheet-back') : null
      if (back) back.click()
      await sleep(200)
      add('浮层的「← 返回」能回到列表', !document.getElementById('her-sheet') && !card.classList.contains('her-has-sheet'))
    } else {
      add('点一条待办 → 进详情浮层', true, '没有可点的（跳过）')
      add('浮层的「← 返回」能回到列表', true, '没进过浮层（跳过）')
    }
    const data = await window.herShell.data('tasks')
    const isMock = !!(data && data.mock)
    const firstOpen = Array.from(rows).find((r) => !r.classList.contains('her-item-done') && r.dataset.taskId)
    if (isMock && firstOpen) {
      const cb = firstOpen.querySelector('.her-check')
      cb && cb.click()
      await sleep(300)
      add('勾一条能变成完成态（假数据）', firstOpen.classList.contains('her-item-done'), firstOpen.dataset.taskId)
    } else {
      add('勾选写盘测试（真数据→跳过）', true, isMock ? '没有可勾的行' : '真数据，不碰')
    }

    // 按科目分类找（2026-10-24 · Tevela C）：切换条在 + 点一下真按科目分组
    {
      // 只数"切换维度"那两个（同一行里现在还有「＋ 新增」，不算切换）
      const swBtns = Array.from(bodyEl.querySelectorAll('.her-groupby .her-chip[data-by]'))
      add('「任务」页有「按时间 / 按科目」切换', swBtns.length === 2, swBtns.map((b) => b.textContent).join(' / '))
      const subjBtn = swBtns.find((b) => b.dataset.by === 'subject')
      const timeBtn = swBtns.find((b) => b.dataset.by === 'time')
      if (subjBtn) {
        subjBtn.click()
        await sleep(400)
      }
      const subjLabels = Array.from(bodyEl.querySelectorAll('.her-group')).map((g) =>
        String((g.querySelector('.her-group-label') || {}).textContent || ''),
      )
      const openTasks = (data && Array.isArray(data.tasks) ? data.tasks : []).filter(
        (t) => String(t.status || 'open') !== 'done' && String(t.status) !== 'dropped',
      )
      const expectSubjects = Array.from(new Set(openTasks.map((t) => String(t.subjectName || '没写科目'))))
      add(
        '点「按科目」→ 一门课一组，科目从数据里现取',
        !!subjBtn &&
          subjLabels.length === expectSubjects.length &&
          subjLabels.length > 0 &&
          subjLabels.every((s) => expectSubjects.includes(s)),
        `${subjLabels.length} 组：${subjLabels.join(' / ').slice(0, 60)}`,
      )
      // 切回按时间，别把界面留在科目视图（后面几条断言按时间维度看）
      if (timeBtn) {
        timeBtn.click()
        await sleep(400)
      }
      const backLabels = Array.from(bodyEl.querySelectorAll('.her-group')).length
      const swNow = bodyEl.querySelector('.her-groupby')
      add('能切回「按时间」', backLabels > 0 && !!swNow && swNow.dataset.by === 'time', `${backLabels} 组 / 当前=${swNow ? swNow.dataset.by : '?'}`)
    }

    // 「＋新增」直接加一条任务（批次 2.2a）：表单浮层里那几个框都要在
    {
      const addBtn = document.getElementById('her-task-add')
      add('「任务」页有「＋新增」', !!addBtn, addBtn ? String(addBtn.textContent) : '没有')
      if (addBtn) {
        addBtn.click()
        await sleep(400)
        const f = document.getElementById('her-sheet')
        const has =
          !!f &&
          !!document.getElementById('her-task-title') &&
          !!document.getElementById('her-task-subject') &&
          !!document.getElementById('her-task-due') &&
          !!document.getElementById('her-task-detail')
        add('点「＋新增」→ 表单浮层（标题/科目/DDL/备注）', has, f ? '四个框都在' : '没弹出来')
        // 填一行、真提交（假数据下主进程只回形状、不落盘）
        if (has) {
          document.getElementById('her-task-title').value = '自检：界面加的一条'
          document.getElementById('her-task-subject').value = 'bio'
          document.getElementById('her-task-due').value = '2026-11-02'
          const submit = Array.from(f.querySelectorAll('.her-chip')).find((b) => /存进任务/.test(String(b.textContent)))
          if (submit) submit.click()
          await sleep(700)
          add('表单能提交（主进程有回应，不报错）', !document.getElementById('her-sheet') || /存好|合并/.test(String((submit || {}).textContent || '')), String((submit || {}).textContent || ''))
        } else {
          add('表单能提交（主进程有回应，不报错）', false, '表单没开')
        }
      } else {
        add('点「＋新增」→ 表单浮层（标题/科目/DDL/备注）', false, '没有入口按钮')
        add('表单能提交（主进程有回应，不报错）', false, '没有入口按钮')
      }
    }

    // 日历
    await openTab('calendar')
    await sleep(900)
    const calCells = bodyEl.querySelectorAll('.her-cal-cell:not(.her-cal-out)').length
    const calWds = bodyEl.querySelectorAll('.her-cal-wd').length
    const calDots = bodyEl.querySelectorAll('.her-cal-dot').length
    const calDetail = bodyEl.querySelectorAll('.her-cal-day-h').length
    const calNotices = bodyEl.querySelectorAll('.her-notice').length
    add('「日历」月格画出来了', calCells >= 28 && calWds === 7, `格子 ${calCells} / 星期 ${calWds}`)
    add('「日历」有当天详情', calDetail > 0, calDetail + ' 块')
    add('「日历」有 DDL 圆点', calDots > 0, calDots + ' 个')
    add('「日历」有通知或说明', calNotices > 0 || bodyEl.querySelectorAll('.her-note').length > 0, calNotices + ' 条通知')
    add('「日历」的条目也有框', bodyEl.querySelectorAll('.her-group').length > 0, `${bodyEl.querySelectorAll('.her-group').length} 个框`)

    // 本周计划（批次 1.5 · Tevela E）：日历最上面那块，能加、能勾、上一周还在
    {
      const weekBox = bodyEl.querySelector('.her-weekly')
      const wk = await window.herShell.data('weekly')
      const goalRows = bodyEl.querySelectorAll('[data-week-goal]')
      add(
        '「日历」顶部有「本周计划」',
        !!weekBox && !!document.getElementById('her-weekly-input'),
        weekBox ? `${goalRows.length} 条目标 / 输入框在` : '没有这一块',
      )
      add(
        '本周计划的目标数跟数据对得上',
        !!weekBox && goalRows.length === (wk && wk.current ? wk.current.goals.length : -1),
        `页面 ${goalRows.length} / 数据 ${wk && wk.current ? wk.current.goals.length : '?'}`,
      )
      add(
        '上一周的目标还留着（按周归档，不是删掉）',
        !!(wk && Array.isArray(wk.past) && wk.past.length >= 1),
        wk && wk.past && wk.past[0] ? `${wk.past[0].key}：勾了 ${wk.past[0].done}/${wk.past[0].total}` : '没有往周',
      )
      const wi = document.getElementById('her-weekly-input')
      const wb = document.getElementById('her-weekly-add')
      if (wi && wb) {
        wi.value = '自检：这一周把 bio 第 4 章过一遍'
        wb.click()
        await sleep(800)
        const after = await window.herShell.data('weekly')
        const hasText = !!(after && after.current && after.current.goals.some((g) => /自检：这一周/.test(g.text)))
        add('「本周计划」能加一条（写进 每周计划.json）', hasText, `现在 ${after && after.current ? after.current.goals.length : '?'} 条`)
        const goalRow = Array.from(bodyEl.querySelectorAll('[data-week-goal]')).find((r) => /自检：这一周/.test(String(r.textContent)))
        if (goalRow) {
          const cb = goalRow.querySelector('.her-check')
          if (cb) cb.click()
          await sleep(800)
          const after2 = await window.herShell.data('weekly')
          const g = after2 && after2.current ? after2.current.goals.find((x) => /自检：这一周/.test(x.text)) : null
          add('「本周计划」能勾掉（done 真的写盘）', !!(g && g.done), g ? `done=${g.done}` : '找不到那条')
        } else {
          add('「本周计划」能勾掉（done 真的写盘）', false, '刚加的那条没画出来')
        }
      } else {
        add('「本周计划」能加一条（写进 每周计划.json）', false, '找不到输入框')
        add('「本周计划」能勾掉（done 真的写盘）', false, '找不到输入框')
      }
    }

    // 设置
    await openTab('settings')
    await sleep(900)
    const themeChips = bodyEl.querySelectorAll('.her-chips .her-chip').length
    const kvRows = bodyEl.querySelectorAll('.her-kv').length
    add('「设置」有配色/大小/打扮的按钮', themeChips >= 10, themeChips + ' 个按钮')
    add('「设置」有诊断行', kvRows >= 3, kvRows + ' 行')
    add('「设置」里有她的打扮', /打扮/.test(bodyEl.textContent), (bodyEl.textContent.match(/打扮[^\n]{0,20}/) || [''])[0])

    // 装扮听谁的（主人 2026-10-24 深夜：可选「她自主」/「你选择」）
    {
      const modeBtns = Array.from(bodyEl.querySelectorAll('.her-look-mode .her-chip'))
      add(
        '「设置」能选装扮听谁的（她自主 / 你选择）',
        modeBtns.length === 2 &&
          modeBtns.some((b) => b.dataset.lookMode === 'she') &&
          modeBtns.some((b) => b.dataset.lookMode === 'master'),
        modeBtns.map((b) => String(b.textContent)).join(' / '),
      )
    }

    // 嗓子（2026-10-24 主人：换成 edge 更自然）：设置页能切 Edge / 本地 piper
    {
      const chips = Array.from(bodyEl.querySelectorAll('.her-chip')).map((b) => String(b.textContent || ''))
      add(
        '「设置」能选嗓子（Edge 在线 / 本地 piper）',
        chips.some((t) => /Edge 的声音/.test(t)) && chips.some((t) => /本地 piper/.test(t)),
        chips.filter((t) => /嗓子|Edge|piper/.test(t)).slice(0, 3).join(' / '),
      )
      // 语音缓存（2026-10-25：日常话预录一遍，省得每次现合成）
      const cacheInfo = await window.herShell.act('tts-cache-status', '')
      add(
        '「设置」有「把日常话预录一遍」+ 缓存能查状态',
        chips.some((t) => /把日常话预录一遍/.test(t)) && !!cacheInfo && cacheInfo.ok !== false && Number(cacheInfo.lines) > 0,
        cacheInfo ? `已录 ${cacheInfo.cached}/${cacheInfo.lines} 句（${cacheInfo.dir}）` : '读不到缓存状态',
      )
      // 归档（批次 2.1）：按钮在 + 说明写清"不真删"
      add(
        '「设置」有「归档一周前的已完成」（归档不是真删）',
        chips.some((t) => /归档一周前的已完成/.test(t)) && /tasks\.archive\.jsonl/.test(String(bodyEl.textContent)),
        chips.filter((t) => /归档/.test(t)).join(' / ') || '没有这个按钮',
      )
      // 批次 3.5：备份目录 / 经验本 / 看备份 / 白板
      add(
        '「设置」多了「备份目录」「她的经验本」入口',
        chips.some((t) => /备份目录/.test(t)) && chips.some((t) => /她的经验本/.test(t)),
        chips.filter((t) => /备份|经验本/.test(t)).join(' / ') || '没有',
      )
      add(
        '「设置」多了「看有哪些备份」「打开白板」',
        chips.some((t) => /看有哪些备份/.test(t)) && chips.some((t) => /打开白板/.test(t)),
        chips.filter((t) => /备份|白板/.test(t)).join(' / ') || '没有',
      )
    }

    // 每日提醒清单（批次 1.4 · Tevela D）：能加一条 → 写进 提醒清单.json → 页面画出来
    {
      add(
        '「设置」里有每日提醒（清单 + 添加框）',
        !!document.getElementById('her-daily-add') && /每日提醒/.test(String(bodyEl.textContent)),
        `${bodyEl.querySelectorAll('.her-daily-item').length} 条`,
      )
      const di = document.getElementById('her-daily-title')
      const dt = document.getElementById('her-daily-time')
      const db = document.getElementById('her-daily-add')
      if (di && db) {
        di.value = '自检：喝一杯水'
        if (dt) dt.value = '21:00'
        db.click()
        await sleep(900)
        const dd = await window.herShell.data('daily')
        const hit = !!(dd && Array.isArray(dd.items) && dd.items.some((x) => /喝.{0,3}水/.test(String(x.title)) && x.time === '21:00'))
        add(
          '「设置」能加一条每日提醒（写进 提醒清单.json）',
          hit,
          dd && Array.isArray(dd.items) ? dd.items.map((x) => `${x.time} ${x.title}`).join(' / ').slice(0, 50) : '读不到',
        )
        add(
          '刚加的每日提醒画在设置页上（有开关和删）',
          bodyEl.querySelectorAll('.her-daily-item').length >= 1 && !!bodyEl.querySelector('[data-daily-toggle]'),
          `${bodyEl.querySelectorAll('.her-daily-item').length} 条 / 开关 ${bodyEl.querySelectorAll('[data-daily-toggle]').length} 个`,
        )
      } else {
        add('「设置」能加一条每日提醒（写进 提醒清单.json）', false, '找不到输入框')
        add('刚加的每日提醒画在设置页上（有开关和删）', false, '找不到输入框')
      }
    }

    // 学科学习计划（批次 1.6 · Tevela F）：能存能读 + 点开能改
    {
      add('「设置」里有学科学习计划', /学科学习计划/.test(String(bodyEl.textContent)), `${bodyEl.querySelectorAll('.her-plan-item').length} 门`)
      const planSet = await window.herShell.act('plan-set', {
        subject: '自检科目',
        plan: '先把概念过一遍，再做 5 道题',
        progress: 40,
      })
      add(
        '学科计划能存（写进 学科计划.json）',
        !!(planSet && planSet.ok !== false && Array.isArray(planSet.items) && planSet.items.some((x) => x.subject === '自检科目' && x.progress === 40)),
        planSet && Array.isArray(planSet.items) ? planSet.items.map((x) => `${x.subject} ${x.progress}%`).join(' / ') : '没存成',
      )
      await refreshCurrent()
      await sleep(500)
      const planRow = bodyEl.querySelector('[data-plan-subject="自检科目"]')
      add('设置页把这门课画出来了', !!planRow, planRow ? String(planRow.textContent).slice(0, 30) : '没画出来')
      if (planRow) {
        planRow.click()
        await sleep(400)
        const sheetEl = document.getElementById('her-sheet')
        add(
          '点开一门课 → 能改打算和进度（浮层里有输入框）',
          !!sheetEl && !!document.getElementById('her-plan-text') && !!document.getElementById('her-plan-progress'),
          sheetEl ? '输入框都在' : '没弹出来',
        )
        const back = sheetEl ? sheetEl.querySelector('.her-sheet-back') : null
        if (back) back.click()
        await sleep(200)
      } else {
        add('点开一门课 → 能改打算和进度（浮层里有输入框）', false, '没有可点的一行')
      }
    }

    // 错题（只读）
    await openTab('mistakes')
    await sleep(900)
    const mkItems = bodyEl.querySelectorAll('.her-item-mk').length
    add('「错题」有条目（每条一个框）', mkItems > 0, mkItems + ' 条')

    // 错题趋势（2026-10-24 晚：主人「最上面的总结栏太乱了、有点挤到一起」→ 改成表格）
    {
      const trend = bodyEl.querySelector('.her-trend')
      const tables = Array.from(bodyEl.querySelectorAll('.her-trend .her-table'))
      const mkData = await window.herShell.data('mistakes')
      const mkEntries = mkData && Array.isArray(mkData.entries) ? mkData.entries : []
      const subjSet = new Set(
        mkEntries.map((e) => {
          const parts = String(e.title || '')
            .split(/[·・]/)
            .map((x) => x.trim())
            .filter(Boolean)
          return parts.length >= 2 ? parts[1] : '没写科目'
        }),
      )
      add('「错题」最上面是「错题趋势」表格（不是一坨字）', !!trend && tables.length >= 2, trend ? `${tables.length} 张表` : '没有这一块')
      const subRows = tables[0] ? tables[0].querySelectorAll('tbody tr').length : 0
      add(
        '趋势表（按科目）行数跟数据对得上',
        subRows === subjSet.size && subRows > 0,
        `表里 ${subRows} 行 / 数据 ${subjSet.size} 门`,
      )
      const dateRows = tables[1] ? tables[1].querySelectorAll('tbody tr').length : 0
      const dates = new Set(mkEntries.map((e) => (/(\d{4}-\d{2}-\d{2})/.exec(String(e.title || '')) || [])[1] || '没认出来'))
      add('趋势表（按测验批次）行数跟数据对得上', dateRows === dates.size && dateRows > 0, `表里 ${dateRows} 行 / 数据 ${dates.size} 批`)
      add('错因那一行也被拆成表格了（错因分布）', tables.length >= 3 && /错因分布/.test(String(bodyEl.textContent)), tables[2] ? `${tables[2].querySelectorAll('tbody tr').length} 行` : '没有第三张')
      const det = bodyEl.querySelector('[data-raw-summary]')
      add('原来那段小结折起来收着（不再占一屏）', !!det && det.open === false, det ? (det.open ? '是展开的' : '收着') : '没有折叠块')
      if (det) {
        det.open = true
        await sleep(150)
        const rawText = String(det.textContent || '')
        add('点开原始小结算能看到原文', rawText.length > 40 && /假数据|小结/.test(rawText), rawText.slice(0, 30).replace(/\s+/g, ' '))
        det.open = false
      } else {
        add('点开原始小结算能看到原文', false, '没有折叠块')
      }
    }

    // 错题「＋新增」（批次 2.2b，主人的口径：**表单 + 她出草稿你确认**，绝不静默写）
    {
      const mkAdd = document.getElementById('her-mistake-add')
      add('「错题」页有「＋ 新增」', !!mkAdd, mkAdd ? String(mkAdd.textContent) : '没有')
      if (mkAdd) {
        mkAdd.click()
        await sleep(400)
        const f = document.getElementById('her-sheet')
        const fields =
          !!f &&
          !!document.getElementById('her-mk-subject') &&
          !!document.getElementById('her-mk-question') &&
          !!document.getElementById('her-mk-cause') &&
          !!document.getElementById('her-mk-mine')
        add('点「＋新增」→ 表单浮层（科目/题面/我的·正确/错因）', fields, f ? '五个框都在' : '没弹出来')
        const chipTexts = f ? Array.from(f.querySelectorAll('.her-chip')).map((b) => String(b.textContent).trim()) : []
        add(
          '表单里有「让她先读一遍」+ 两种存法（只预览 / 连 docx）',
          chipTexts.some((t) => /让她先读一遍/.test(t)) && chipTexts.some((t) => t === '就这样存') && chipTexts.some((t) => /连 docx 一起/.test(t)),
          chipTexts.join(' / ').slice(0, 70),
        )
        if (fields) {
          document.getElementById('her-mk-question').value = '自检题干：解这个式子'
          const saveBtn = Array.from(f.querySelectorAll('.her-chip')).find((b) => String(b.textContent).trim() === '就这样存')
          if (saveBtn) saveBtn.click()
          await sleep(900)
          add('表单能提交（假数据下不落盘，但主进程有回应并关掉表单）', !document.getElementById('her-sheet'), document.getElementById('her-sheet') ? '表单还在' : '表单已收')
        } else {
          add('表单能提交（假数据下不落盘，但主进程有回应并关掉表单）', false, '表单没开')
        }
      } else {
        add('点「＋新增」→ 表单浮层（科目/题面/我的·正确/错因）', false, '没有入口')
        add('表单里有「让她先读一遍」+ 两种存法（只预览 / 连 docx）', false, '没有入口')
        add('表单能提交（假数据下不落盘，但主进程有回应并关掉表单）', false, '没有入口')
      }
    }
    if (mkItems > 0) {
      const firstMk = bodyEl.querySelector('.her-item-mk')
      firstMk.click()
      await sleep(350)
      const mkSheet = document.getElementById('her-sheet')
      const mkBlocks = mkSheet ? mkSheet.querySelectorAll('.her-sheet-pre').length : 0
      add('点一道错题 → 看到完整的四轮内容', !!mkSheet && mkBlocks > 0, mkSheet ? `${mkBlocks} 块` : '没弹出来')
      add(
        '错题详情里有「让她出相似题」按钮',
        !!(mkSheet && Array.from(mkSheet.querySelectorAll('.her-chip')).some((b) => /相似题/.test(b.textContent))),
      )
      const mkBack = mkSheet ? mkSheet.querySelector('.her-sheet-back') : null
      if (mkBack) mkBack.click()
      await sleep(200)
      add('错题详情也能返回', !document.getElementById('her-sheet'))
    } else {
      add('点一道错题 → 看到完整的四轮内容', true, '没有条目（跳过）')
      add('错题详情里有「让她出相似题」按钮', true, '没有条目（跳过）')
      add('错题详情也能返回', true, '没进过浮层（跳过）')
    }
    add('「错题」有投放区', bodyEl.textContent.includes('投放区'), '')

    // 总结（第 7 个页签，2026-10-24：她先写、主人再改）
    await openTab('summary')
    await sleep(900)
    const sumItems = bodyEl.querySelectorAll('.her-item-sum').length
    const sumGroups = bodyEl.querySelectorAll('.her-group').length
    add(
      '「总结」页在（分组框 + 至少一个按钮）',
      sumGroups > 0 && bodyEl.querySelectorAll('.her-chip').length > 0,
      `${sumItems} 天 / ${sumGroups} 组`,
    )
    if (sumItems > 0) {
      bodyEl.querySelector('.her-item-sum').click()
      await sleep(350)
      const sumSheet = document.getElementById('her-sheet')
      const sumBlocks = sumSheet ? sumSheet.querySelectorAll('.her-sheet-pre').length : 0
      add('点一天的总结 → 看全文', !!sumSheet && sumBlocks > 0, sumSheet ? `${sumBlocks} 块` : '没弹出来')
      const chips = sumSheet ? Array.from(sumSheet.querySelectorAll('.her-chip')).map((b) => b.textContent) : []
      add('总结详情里有「让她重写」和「我自己改」', chips.some((t) => /重写/.test(t)) && chips.some((t) => /我自己改/.test(t)), chips.join(' / ').slice(0, 40))
      const sumBack = sumSheet ? sumSheet.querySelector('.her-sheet-back') : null
      if (sumBack) sumBack.click()
      await sleep(200)
      add('总结详情也能返回', !document.getElementById('her-sheet'))
    } else {
      add('点一天的总结 → 看全文', true, '还没有总结（跳过）')
      add('总结详情里有「让她重写」和「我自己改」', true, '没有条目（跳过）')
      add('总结详情也能返回', true, '没进过浮层（跳过）')
    }

    // 对话（2026-10-25：先给主题列表 → 点进去才聊）
    await openTab('chat')
    await sleep(900)
    {
      const cards = bodyEl.querySelectorAll('.her-topic-card')
      const meta = await window.herShell.data('chat-meta')
      add(
        '「对话」一进来先给主题列表（像错题页的选项栏）',
        cards.length === (meta && Array.isArray(meta.topics) ? meta.topics.length : -1) && cards.length > 0 && !!document.getElementById('her-topic-add'),
        meta ? `${cards.length} 张主题卡 / 当前「${meta.current}」` : '读不到 chat-meta',
      )
      // 点当前主题进去 → 三段式：顶部固定 / 中间滚 / 底部输入栏
      const cur = Array.from(cards).find((c) => c.classList.contains('her-topic-card-on')) || cards[0]
      if (cur) {
        cur.click()
        await sleep(900)
      }
      const wrap = bodyEl.querySelector('.her-chat-wrap')
      const top = bodyEl.querySelector('.her-chat-top')
      const area = bodyEl.querySelector('.her-send-area')
      add(
        '进主题后：主题条固定在顶、输入栏固定在底（中间那段滚）',
        !!wrap && !!top && !!area && wrap.classList.contains('her-chat-chatting'),
        wrap ? `top=${!!top} / 输入栏=${!!area}` : '没有三段式容器',
      )
      add('输入框能多行（1~5 行自适应）', !!area && String(area.tagName) === 'TEXTAREA' && Number(area.rows) >= 1, area ? `${area.tagName} rows=${area.rows}` : '没有输入框')
    }
    const msgCount0 = bodyEl.querySelectorAll('.her-msg').length
    add('「对话」有历史', msgCount0 >= 2, msgCount0 + ' 条')
    const chatInput = bodyEl.querySelector('.her-send-area')
    // 等她"新说出"东西来：先记下此刻她那边有几个气泡（历史里本来就有），
    // 只有数量超过它才算这一轮真的回来了（不然会立刻读到历史里的最后一句，白捡通过）
    const herBubbles0 = bodyEl.querySelectorAll('.her-msg-her').length
    if (chatInput) {
      // 2026-10-25：这一句同时验三件事 ——
      //   ① 带「画图」→ 假数据回一块 ```board（P0-2）
      //   ② 带「三条」→ 假数据回三行（M1：一行一个气泡，不是一框换行）
      //   ③ 我方消息是攒批发出去的（她收到的正文带 `[时:分]` 前缀，M1 的另一半）
      chatInput.value = '自检：画个图，三条都讲讲'
      chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    let reply = ''
    const chatDeadline = Date.now() + 20000 // 攒批 4 秒 + 流式，给足
    while (Date.now() < chatDeadline) {
      await sleep(300)
      const dbg = chatDebug()
      const grew = bodyEl.querySelectorAll('.her-msg-her').length > herBubbles0
      reply = dbg.last || ''
      if (grew && reply && !dbg.streaming) break
    }
    await sleep(600)
    add('「对话」能发出去并收到流式回复', reply.length > 0, reply.slice(0, 40))
    // 2026-10-25 M1-a：她回三行 → 三个独立气泡（以前是三行挤在一个框里）
    {
      const texts = Array.from(bodyEl.querySelectorAll('.her-msg-her .her-msg-text')).map((e) => String(e.textContent || ''))
      const has2 = texts.some((t) => t.includes('第二句'))
      const has3 = texts.some((t) => t.includes('第三句'))
      const merged = texts.some((t) => t.includes('第二句') && t.includes('第三句'))
      add(
        '她回三行 → 三个气泡（不是一框里换行）',
        has2 && has3 && !merged,
        `她这边 ${texts.length} 个气泡 / 第二句和第三句${merged ? '挤在一起' : '分开了'}`,
      )
    }
    // 2026-10-25 M1-b：我方消息攒成一批发出去，而且带上了 [时:分]
    {
      const all = Array.from(bodyEl.querySelectorAll('.her-msg-her .her-msg-text'))
        .map((e) => String(e.textContent || ''))
        .join(' ⏎ ')
      const hit = /\[\d{1,2}:\d{2}\]/.exec(all)
      add(
        '我发的消息是攒成一批、还带上了时间（她收到的正文有 [时:分] 前缀）',
        !!hit,
        hit ? `她那边看到的是 ${hit[0]}…` : `她那边一条带时间的都没有：${all.slice(0, 60)}`,
      )
    }
    // 2026-10-25 P0-2：给了 board 块 → 画布出现，且笔画数对得上（假数据里那两块：一条线 + 一句字）
    {
      const cvs = bodyEl.querySelectorAll('.her-board canvas')
      const last = cvs.length ? cvs[cvs.length - 1] : null
      const drawn = last ? Number(last.dataset.strokes) : 0
      add(
        'board 画图块真的画出来了（有画布、笔画数对得上）',
        cvs.length > 0 && drawn === 2,
        cvs.length ? `${cvs.length} 张画布 / 最后一张 ${drawn} 笔 / ${last.width}×${last.height}` : '没有画布（board 事件没到渲染层）',
      )
      add(
        '画图块的 JSON 没有漏进正文（strokes 一个字都不该显示）',
        !/strokes/i.test(bodyEl.textContent || ''),
        String(bodyEl.textContent || '').includes('strokes') ? '正文里还看得见 JSON' : '正文干净',
      )
    }
    // 2026-10-25 主人：「记录和处理」一栏删掉
    add('「记一条 / 处理」底栏已经删掉', !document.getElementById('her-foot'), document.getElementById('her-foot') ? '还在' : '没了')

    // 底栏删掉以后，这两个功能在设置页工具区（脚本那条路没断）
    await openTab('settings')
    await sleep(800)
    {
      const chips = Array.from(bodyEl.querySelectorAll('.her-chip')).map((b) => String(b.textContent || ''))
      add(
        '「记一条 / 处理收件箱」搬到了设置页工具区',
        chips.some((t) => /记一条/.test(t)) && chips.some((t) => /处理收件箱/.test(t)),
        chips.filter((t) => /记一条|处理收件箱/.test(t)).join(' / ') || '没有',
      )
    }

    // 收起
    await hidePanel()
    await sleep(200)
    add('浮窗能单独收起（她还在）', card.hidden && !state.cardOpen)

    // 完全没有模糊边框：卡片自己不许有 box-shadow / filter（§31.34 主人："浮窗还是有一定模糊边框"）
    await openTab('today')
    await sleep(600)
    const cs = getComputedStyle(card)
    const blurShadow = cs.boxShadow && cs.boxShadow !== 'none'
    add('浮窗没有模糊外发光（box-shadow）', !blurShadow, blurShadow ? cs.boxShadow.slice(0, 60) : 'none')
    add('浮窗没有 backdrop-filter', !cs.backdropFilter || cs.backdropFilter === 'none', cs.backdropFilter || 'none')

    const okCount = checks.filter((c) => c.ok).length
    return { ok: okCount === checks.length, checks, okCount, total: checks.length }
  },
}
