/**
 * info/pet/shell/main.mjs —— 她的透明外壳（Electron 主进程），2026-10-22 晚
 * =============================================================================
 *
 * 为什么要有这一层（主人原话：「她的单独形象旁边有一大圈黑色的色块；分辨率也很低」）：
 *   WebView2 是**原生子窗口**，分层窗口不合成子窗口 → 页面里能把背景设成透明，
 *   贴到桌面上还是那块深色方框。要"只看见人、看不见窗"，只能换 Electron
 *   （它自己的合成器 + 逐像素 alpha）。这就是原版桌宠在 Windows/macOS 上的做法。
 *
 * 它做什么：
 *   · 起/复用桌宠宿主 `info/pet/serve.mjs`（端口在 out/pet-port.json）
 *   · 开一个**无边框、透明、没有阴影**的窗口，加载她的页面
 *   · 窗口大小按"她"来定（模型多高 → 窗口多大），底下是她，上面留给气泡/面板
 *   · 拖她 = 拖窗口（页面报位移，见 page-hook.js）；位置记在 out/pet-window.pos
 *   · **点空气穿过去**：页面用像素掩码判断鼠标在不在她身上，壳子开关 setIgnoreMouseEvents
 *   · 右键 = 原生菜单（置顶 / 大小 / 重载 / 今天要做什么 / 打开浮窗 / 关掉她）
 *   · 自检：`--selftest` 开个屏幕外的窗口、截图、**按 alpha 通道验证真透明**、写日志、退出
 *
 * 用法（正常由 info\pet-window.ps1 拉起，不直接调用）：
 *   electron.exe info/pet/shell --h=360 [--topmost=1] [--selftest] [--url=...]
 *
 * 注意：本文件是 ESM（package.json 里 "type":"module"）。Electron 38 支持。
 * =============================================================================
 */

import { app, BrowserWindow, Menu, ipcMain, screen, nativeImage } from 'electron'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..', '..', '..')
const INFO_DIR = join(PROJECT_ROOT, 'info')
const OUT = join(PROJECT_ROOT, 'out')
const POS_FILE = join(OUT, 'pet-window.pos')
const PORT_FILE = join(OUT, 'pet-port.json')
const STATE_FILE = join(OUT, 'ui-state.json')
const LOG_FILE = join(OUT, 'pet-shell.log')
const SELFTEST_LOG = join(OUT, 'pet-shell-selftest.log')
const HOOK_FILE = join(HERE, 'page-hook.js')
const PRELOAD_FILE = join(HERE, 'preload.mjs')
const SERVE_FILE = join(INFO_DIR, 'pet', 'serve.mjs')

/** 面板/气泡要往上开，所以窗口比她本身高出一截（这一段是透明的、点得穿）。 */
const PANEL_ROOM = 340

// ── 命令行 ────────────────────────────────────────────────────────────────────
const ARGV = new Map()
for (const a of process.argv.slice(1)) {
  if (!a.startsWith('--')) continue
  const eq = a.indexOf('=')
  if (eq < 0) ARGV.set(a.slice(2), '1')
  else ARGV.set(a.slice(2, eq), a.slice(eq + 1))
}
const num = (k, d) => {
  const v = Number(ARGV.get(k))
  return Number.isFinite(v) && v > 0 ? v : d
}
const SELFTEST = ARGV.has('selftest')
const MODEL_H = Math.round(num('h', 360))
const TOPMOST = ARGV.get('topmost') === '1'

mkdirSync(OUT, { recursive: true })

function log(msg) {
  const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${msg}`
  try {
    appendFileSync(LOG_FILE, line + '\r\n', 'utf8')
  } catch {}
  console.log(`[her] ${msg}`)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, obj) {
  try {
    writeFileSync(file, JSON.stringify(obj), 'utf8')
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 宿主：起了就用，没起自己起（用 electron 自带的 node 跑，装完也不用额外 node）──
let host = { port: 0, started: false, child: null }

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-pet/health`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    const j = await r.json()
    return !!j.ok
  } catch {
    return false
  }
}

async function ensureHost() {
  const info = readJson(PORT_FILE)
  if (info && Number(info.port) > 0 && (await health(Number(info.port)))) {
    return { port: Number(info.port), started: false, child: null }
  }
  if (!existsSync(SERVE_FILE)) return { port: 0, started: false, child: null }
  let child = null
  try {
    child = spawn(process.execPath, [SERVE_FILE], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch (err) {
    log('起宿主失败：' + (err && err.message))
    return { port: 0, started: false, child: null }
  }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    await sleep(300)
    const cur = readJson(PORT_FILE)
    if (cur && Number(cur.port) > 0 && Number(cur.pid) === child.pid) {
      if (await health(Number(cur.port))) return { port: Number(cur.port), started: true, child }
    }
  }
  try {
    child.kill()
  } catch {}
  return { port: 0, started: false, child: null }
}

// ── 几何：她多大 → 窗口多大 ────────────────────────────────────────────────────
/** pet.js 的取景口径（和 assets/pet.js 里的 PAD / VIEW_ASPECT 对齐，改那边记得改这里）。 */
const VIEW_PAD = 0.1
const VIEW_ASPECT = 1.15

function planGeometry(modelH, area) {
  const areaH = area ? area.height : 800
  const usable = Math.max(320, areaH - 24)
  // 面板（表情菜单/输入框/简报）是往上开的，得给她头顶留地方；
  // 但小屏幕（比如 1080p 开到 200% 缩放 → 桌面只有 ~540 CSS 高）不能把她挤没，
  // 所以最多只留 45%。
  const room = Math.min(PANEL_ROOM, Math.round(usable * 0.45))
  let h = Math.round(modelH)
  const maxRootH = usable - room
  if (h * (1 + VIEW_PAD * 2) > maxRootH) h = Math.max(140, Math.floor(maxRootH / (1 + VIEW_PAD * 2)))
  const rootH = Math.round(h * (1 + VIEW_PAD * 2))
  const rootW = Math.round(rootH * VIEW_ASPECT)
  const winW = Math.max(rootW + 24, 380)
  const winH = rootH + room
  return { modelH: h, rootW, rootH, winW, winH, room }
}

/** 面板空间：跟 planGeometry 同一套口径（改一处别忘另一处）。 */
function panelRoom(area) {
  const usable = Math.max(320, (area ? area.height : 800) - 24)
  return Math.min(PANEL_ROOM, Math.round(usable * 0.45))
}

function workAreaFor(x, y) {
  try {
    const d = screen.getDisplayNearestPoint({ x, y })
    return d.workArea
  } catch {
    return screen.getPrimaryDisplay().workArea
  }
}

function clampInto(area, x, y, w, h) {
  const nx = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - w))
  const ny = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - h))
  return { x: Math.round(nx), y: Math.round(ny) }
}

function loadSavedPos() {
  const p = readJson(POS_FILE)
  if (!p) return null
  const w = Number(p.width) || 0
  const h = Number(p.height) || 0
  if (Number(p.left) === 0 && Number(p.top) === 0) return null
  // 自检曾经写进屏幕外（-3200,-3200），这里再挡一道：必须和某块屏幕有交集
  if (!Number.isFinite(Number(p.left)) || !Number.isFinite(Number(p.top))) return null
  const area = workAreaFor(Number(p.left) + w / 2, Number(p.top) + h / 2)
  const inter = Number(p.left) + w > area.x && Number(p.left) < area.x + area.width &&
    Number(p.top) + h > area.y && Number(p.top) < area.y + area.height
  return inter ? p : null
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
let win = null
let port = 0
let ignoring = true
let gotHitMsg = false
let saveTimer = null
let measured = false
let quitting = false

function savePos() {
  if (SELFTEST || !win) return
  try {
    const b = win.getBounds()
    writeJson(POS_FILE, {
      left: b.x,
      top: b.y,
      width: b.width,
      height: b.height,
      modelHeight: MODEL_H,
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
  } catch {}
}

function saveUiState(petWindow) {
  if (SELFTEST) return
  const cur = readJson(STATE_FILE) || {}
  writeJson(STATE_FILE, {
    showChar: cur.showChar !== false,
    petWindow: !!petWindow,
    topMost: !!TOPMOST,
  })
}

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  const want = !!on
  if (want === ignoring) return
  ignoring = want
  try {
    win.setIgnoreMouseEvents(want, { forward: true })
  } catch {}
}

async function evalJson(script, timeoutMs = 8000) {
  if (!win || win.isDestroyed()) return null
  try {
    const raw = await Promise.race([
      win.webContents.executeJavaScript(script, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('executeJavaScript 超时')), timeoutMs)),
    ])
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (err) {
    log('evalJson 失败：' + (err && err.message))
    return null
  }
}

async function pushReport(title, body, say) {
  try {
    const payload = { report: { title, body } }
    if (say) payload.say = say
    const r = await fetch(`http://127.0.0.1:${port}/dsh-pet/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2000),
    })
    const j = await r.json().catch(() => null)
    log(`推简报「${title}」→ 客户端 ${j ? j.clients : '?'} 个`)
    return !!(j && j.ok)
  } catch (err) {
    log('推简报失败：' + (err && err.message))
    return false
  }
}

/** 我们的内容塞进她的窗口：今天要做什么（读 study-lite 的待办，做成她头上那封信）。 */
function todayReport() {
  const script = join(INFO_DIR, 'study-lite.mjs')
  if (!existsSync(script)) return null
  let out = ''
  try {
    const r = spawnSync(process.execPath, [script, '--list'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    out = (r.stdout || '').trim()
  } catch (err) {
    log('study-lite 跑不动：' + (err && err.message))
    return null
  }
  const line = out.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop()
  let data = null
  try {
    data = JSON.parse(line || '{}')
  } catch {}
  const tasks = (data && Array.isArray(data.tasks) ? data.tasks : []).filter((t) => {
    const st = String(t.status || 'open')
    return st === 'open'
  })
  const when = (t) => String(t.dueFormatted || t.dueLocal || t.due || '')
  tasks.sort((a, b) => String(when(a)).localeCompare(String(when(b))))
  if (tasks.length === 0) {
    return { title: '今天要做什么', body: '没有还没做完的待办 —— 今天可以歇一会儿。' }
  }
  const lines = tasks.slice(0, 12).map((t) => {
    const subj = t.subject ? `${t.subject} · ` : ''
    const d = when(t)
    return `· ${subj}${t.title || '(没写标题)'}${d ? `　（${d}）` : ''}`
  })
  const more = tasks.length > 12 ? `\n…还有 ${tasks.length - 12} 条，点开浮窗看全部` : ''
  return { title: '今天要做什么', body: `还有 ${tasks.length} 条要交的：\n${lines.join('\n')}${more}` }
}

function applySize(modelH, keepBottom = true) {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const area = workAreaFor(b.x + b.width / 2, b.y + b.height / 2)
  const g = planGeometry(modelH, area)
  const newH = g.winH
  const newW = g.winW
  let y = b.y
  if (keepBottom) y = b.y + b.height - newH
  const pos = clampInto(area, b.x, y, newW, newH)
  win.setBounds({ x: pos.x, y: pos.y, width: newW, height: newH })
  log(`改大小：模型 ${g.modelH}px → 窗口 ${newW}×${newH} @ (${pos.x},${pos.y})`)
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '置顶（一直压在最上面）',
      type: 'checkbox',
      checked: !!win.isAlwaysOnTop(),
      click: (mi) => {
        win.setAlwaysOnTop(!!mi.checked)
        saveUiState(true)
        log('置顶 = ' + mi.checked)
      },
    },
    { type: 'separator' },
    {
      label: '大小',
      submenu: [
        { label: '小（260）', click: () => applySize(260) },
        { label: '中（360）', click: () => applySize(360) },
        { label: '大（480）', click: () => applySize(480) },
        { label: '很大（600）', click: () => applySize(600) },
      ],
    },
    { type: 'separator' },
    {
      label: '今天要做什么（信封）',
      click: async () => {
        const r = todayReport()
        if (!r) {
          log('今天要做什么：拿不到待办')
          return
        }
        await pushReport(r.title, r.body, '给，今天的清单～')
      },
    },
    { label: '重新加载她', click: () => win.reload() },
    { type: 'separator' },
    {
      label: '打开浮窗',
      click: () => {
        try {
          spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', join(INFO_DIR, 'launch.ps1')], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          })
        } catch (err) {
          log('打开浮窗失败：' + (err && err.message))
        }
      },
    },
    { label: '关掉她', click: () => win.close() },
  ])
}

async function injectHook() {
  try {
    const src = readFileSync(HOOK_FILE, 'utf8')
    await win.webContents.executeJavaScript(src, true)
    log('钩子已注入（拖动 / 命中穿透 / 右键菜单）')
  } catch (err) {
    log('钩子注入失败：' + (err && err.message))
  }
}

async function measureAndFit() {
  if (measured) return
  measured = true
  const st = await evalJson(
    'JSON.stringify({ view: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null, model: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.modelSize) || null })',
  )
  if (!st || !st.view) {
    log('量不到她的视图尺寸（页面可能还没 ready）→ 保持当前窗口大小')
    return
  }
  const b = win.getBounds()
  const wantW = Math.max(380, Math.round(st.view.w) + 24)
  const area = workAreaFor(b.x + b.width / 2, b.y + b.height / 2)
  const wantH = Math.round(st.view.h) + panelRoom(area)
  if (Math.abs(wantW - b.width) <= 10 && Math.abs(wantH - b.height) <= 10) {
    log(`窗口尺寸已合适：${b.width}×${b.height}（她 ${Math.round(st.view.w)}×${Math.round(st.view.h)}）`)
    return
  }
  const pos = clampInto(area, b.x + (b.width - wantW) / 2, b.y + b.height - wantH, wantW, wantH)
  win.setBounds({ x: pos.x, y: pos.y, width: wantW, height: wantH })
  log(`按她量出来的尺寸改窗口：${b.width}×${b.height} → ${wantW}×${wantH}（她 ${Math.round(st.view.w)}×${Math.round(st.view.h)}）`)
}

async function createWindow() {
  const saved = SELFTEST ? null : loadSavedPos()
  const area0 = screen.getPrimaryDisplay().workArea
  const probeArea = saved ? workAreaFor(Number(saved.left) + 40, Number(saved.top) + 40) : area0
  const g = planGeometry(saved && Number(saved.modelHeight) ? Number(saved.modelHeight) : MODEL_H, probeArea)

  const width = saved && Number(saved.width) > 200 ? Number(saved.width) : g.winW
  const height = saved && Number(saved.height) > 200 ? Number(saved.height) : g.winH
  let x
  let y
  if (saved) {
    x = Number(saved.left)
    y = Number(saved.top)
    const p = clampInto(probeArea, x, y, width, height)
    x = p.x
    y = p.y
  } else {
    const p = clampInto(probeArea, probeArea.x + probeArea.width - width - 24, probeArea.y + probeArea.height - height - 8, width, height)
    x = p.x
    y = p.y
  }
  if (SELFTEST) {
    x = -3200
    y = -3200
  }

  const modelHeight = saved && Number(saved.modelHeight) ? Number(saved.modelHeight) : g.modelH
  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: '她',
    alwaysOnTop: TOPMOST,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [`--her-layout=${JSON.stringify({ height: modelHeight, maxWidthRatio: 0.98 })}`],
    },
  })

  win.setMenuBarVisibility(false)
  try {
    win.setIgnoreMouseEvents(true, { forward: true })
  } catch {}
  ignoring = true

  win.once('ready-to-show', () => {
    if (SELFTEST) win.showInactive()
    else win.show()
    log(`窗口出现：${width}×${height} @ (${x},${y})，模型 ${modelHeight}px，置顶=${TOPMOST}`)
  })

  win.webContents.on('did-finish-load', async () => {
    log('页面加载完了 → 注入钩子')
    await injectHook()
    setTimeout(() => {
      measureAndFit().catch(() => {})
    }, 2200)
    // 保险：万一页面里的命中脚本没跑起来（报错/被挡），窗口会一直是"点得穿"= 她永远点不动。
    // 6 秒内一次命中消息都没收到 → 索性放开鼠标（正常可点），日志里记一笔。
    setTimeout(() => {
      if (!gotHitMsg) {
        setIgnore(false)
        log('⚠️ 6 秒内没收到命中回报 → 先放开鼠标（不做点击穿透），请查钩子')
      }
    }, 6000)
  })

  win.webContents.on('render-process-gone', (_e, d) => log('页面进程没了：' + JSON.stringify(d)))

  win.on('moved', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(savePos, 500)
  })
  win.on('resized', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(savePos, 500)
  })

  win.on('close', () => {
    if (quitting) return
    quitting = true
    savePos()
    saveUiState(false)
    if (host.started && host.child) {
      try {
        host.child.kill()
        log('宿主是自己起的 → 一起收掉')
      } catch {}
    }
  })

  win.on('closed', () => {
    win = null
    app.quit()
  })

  // 把她多大写进页面存档（见 info/pet/serve.mjs 的 ?h= / ?maxW=）：默认 0.5 的窗宽上限
  // 会把她压小一半，这里显式给 0.98。
  const autoUrl = `http://127.0.0.1:${port}/?h=${modelHeight}&maxW=0.98`
  const url = ARGV.get('url') || autoUrl
  log('加载 ' + url)
  win.loadURL(url).catch((err) => log('loadURL 失败：' + (err && err.message)))
}

// ── 自检 ──────────────────────────────────────────────────────────────────────
async function selfTest() {
  const lines = []
  const say = (m) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`
    lines.push(line)
    console.log(line)
    // 边跑边写：万一后面卡住，日志里还能看到卡在哪一步
    try {
      writeFileSync(SELFTEST_LOG, `==== 透明外壳自检（${new Date().toISOString()}）====\r\n${lines.join('\r\n')}\r\n`, 'utf8')
    } catch {}
  }
  let fails = 0
  const check = (name, ok, extra = '') => {
    if (!ok) fails += 1
    say(`${ok ? '✅' : '❌'} ${name}${extra ? '　' + extra : ''}`)
  }
  try {
    say('自检开始（窗口开在屏幕外）')
    await createWindow()
    let st = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await sleep(500)
      st = await evalJson(
        'JSON.stringify({ view: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null, model: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.modelSize) || null, hook: !!window.__herShellHook, err: window.__DSHPetError || null, expr: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.expressions) ? window.DSHPet.state.expressions.length : -1 })',
      )
      if (st && st.view) break
    }
    check('页面 ready 且模型载入', !!(st && st.view), st ? `她 ${Math.round(st.view.w)}×${Math.round(st.view.h)}` : '拿不到状态')
    if (st && st.err) say('页面报错：' + st.err)
    // 诊断：她的存档（layout）、视口、DPI —— 尺寸不对时看这三个
    const diag = await evalJson(
      'JSON.stringify({ layout: (function(){try{return localStorage.getItem("dsh-live2d-pet:layout")}catch(e){return "ERR:"+e.message}})(), w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, bodyW: document.body ? document.body.clientWidth : -1 })',
    )
    say('诊断：' + JSON.stringify(diag))
    check('钩子注入成功', !!(st && st.hook))
    const model = st && st.model
    check('模型尺寸合理（不是 0）', !!(model && model.w > 100), model ? `${Math.round(model.w)}×${Math.round(model.h)}` : 'null')

    // 透明验证：截图 → 读像素 alpha
    await sleep(800)
    const img = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage 超时（15 秒）')), 15000)),
    ]).catch((err) => {
      say('截图失败：' + (err && err.message))
      return null
    })
    if (!img) throw new Error('拿不到画面，透明没法验')
    const pngPath = join(OUT, 'pet-shell-selftest.png')
    try {
      writeFileSync(pngPath, img.toPNG())
      say('截图：' + pngPath)
    } catch (err) {
      say('截图写不下来：' + (err && err.message))
    }
    const size = img.getSize()
    const bmp = img.toBitmap()
    let opaque = 0
    let clear = 0
    for (let i = 3; i < bmp.length; i += 4) {
      if (bmp[i] > 16) opaque += 1
      else clear += 1
    }
    const total = Math.max(1, opaque + clear)
    const opaquePct = (opaque / total) * 100
    const alphaCorner = bmp.length >= 4 ? bmp[3] : 0
    check('窗口是真透明（有大片 alpha=0 的像素）', clear > total * 0.1, `不透明 ${opaquePct.toFixed(1)}% / 透明 ${(100 - opaquePct).toFixed(1)}%`)
    check('左上角是透明的（没有黑框）', alphaCorner <= 16, `alpha=${alphaCorner}`)
    check('她真的画出来了（不透明像素不太少）', opaquePct > 1.5, `不透明 ${opaquePct.toFixed(1)}%`)
    check('窗口大于零', size.width > 100 && size.height > 100, `${size.width}×${size.height}`)
  } catch (err) {
    fails += 1
    say('自检崩了：' + (err && err.message))
  }
  try {
    writeFileSync(SELFTEST_LOG, `==== 透明外壳自检（${new Date().toISOString()}）====\r\n${lines.join('\r\n')}\r\n==== 结束：失败 ${fails} 项 ====\r\n`, 'utf8')
  } catch {}
  console.log(`==== 失败 ${fails} 项 ====`)
  try {
    if (win && !win.isDestroyed()) win.destroy()
  } catch {}
  app.exit(fails === 0 ? 0 : 1)
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
async function main() {
  log(`==== 透明外壳启动（pid ${process.pid}）模型 ${MODEL_H}px 置顶=${TOPMOST} 自检=${SELFTEST} ====`)
  ipcMain.on('her:drag', (_e, dx, dy) => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    win.setBounds({ x: Math.round(b.x + (Number(dx) || 0)), y: Math.round(b.y + (Number(dy) || 0)), width: b.width, height: b.height })
  })
  ipcMain.on('her:drag-start', () => {
    try {
      win.focus()
    } catch {}
  })
  ipcMain.on('her:hit', (_e, on) => {
    if (!gotHitMsg) {
      gotHitMsg = true
      log('命中回报已通（点击穿透按她身上的像素走）')
    }
    setIgnore(!on)
  })
  ipcMain.on('her:menu', () => {
    try {
      buildMenu().popup({ window: win })
    } catch (err) {
      log('菜单弹不出来：' + (err && err.message))
    }
  })
  ipcMain.on('her:model-height', async (_e, h) => {
    const st = await evalJson('JSON.stringify((window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null)')
    if (st && st.w) {
      const b = win.getBounds()
      const area = workAreaFor(b.x + b.width / 2, b.y + b.height / 2)
      const wantW = Math.max(380, Math.round(st.w) + 24)
      const wantH = Math.round(st.h) + panelRoom(area)
      const pos = clampInto(area, b.x + (b.width - wantW) / 2, b.y + b.height - wantH, wantW, wantH)
      win.setBounds({ x: pos.x, y: pos.y, width: wantW, height: wantH })
      log(`页面里改了大小（${Math.round(h)}）→ 窗口 ${wantW}×${wantH}`)
    }
  })

  host = await ensureHost()
  port = host.port
  if (!port) {
    log('宿主起不来（info/pet/serve.mjs）→ 退出')
    app.exit(3)
    return
  }
  log(`宿主端口 ${port}（自己起的=${host.started}）`)

  if (SELFTEST) {
    await selfTest()
    return
  }
  await createWindow()
}

// 只允许一个她（自检除外，免得挡住真实窗口）
if (!SELFTEST) {
  const got = app.requestSingleInstanceLock()
  if (!got) {
    console.log('[her] 已经有一个她在跑了')
    app.exit(0)
  } else {
    app.on('second-instance', () => {
      if (win && !win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })
  }
}

app.whenReady().then(() => {
  main().catch((err) => {
    log('启动失败：' + (err && err.message))
    app.exit(1)
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
