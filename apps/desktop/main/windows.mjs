/**
 * apps\desktop\main\windows.mjs —— 窗口摆位：算多大 / 算在哪儿 / 夹回屏幕 / 存位置
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 整段搬出来（几何 + 浮窗摆位两段，逻辑原样）。
 *
 * 这里只管"摆哪里"这一类**纯计算**：
 *   · 形象窗多大（planGeometry / headRoom）—— 她头顶要留气泡空间
 *   · 浮窗默认摆哪、存档位置在屏幕外怎么办（readPanelBox / fitPanelBox / defaultPanelBox）
 *   · 夹进工作区（clampInto）、按坐标找显示器（workAreaFor）、上次的位置还能不能用（loadSavedPos）
 *
 * ⚠️ **窗口创建本身还在 main.mjs**（createHerWindow / createPanelWindow / 菜单 / 托盘 / show-hide）：
 *    它们和 win / panelWin / port / quitting 这些活状态、IPC、自检绑得太深（区间外引用 270+ 处），
 *    硬搬风险太高，下一轮单独做。这里故意只搬"不会动状态"的部分 —— 所以拆完自检仍然全绿。
 *
 * 依赖：readJson / writeJson / POS_FILE / OUT / SELFTEST / MOCK / VIEW_PAD / VIEW_ASPECT，
 *       win 用 getter 传（"她"那个窗口在不在，决定浮窗默认往哪边摆）。
 */

import { screen, BrowserWindow, Menu, Tray, nativeImage, app, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'


// ── 窗口状态（ESM 的 export let 是活绑定：main.mjs import 之后直接读，不用改那 277 处引用）──
export let win = null
/** 浮窗（2026-10-23 独立窗口） */
export let panelWin = null
export let panelPage = 'today'
export let panelSaveTimer = null
/** 浮窗"露着还是收着"（用 show/hide 事件记，比 isVisible() 更早更稳） */
export let panelShown = false
export let port = 0
export let ignoring = true
export let gotHitMsg = false
export let saveTimer = null
export let measured = false
export let quitting = false
export let tray = null
// （tray 原来在下面的托盘节里声明，2026-10-25 一起搬上来）

/** 少数几处要从外面改的，走这几个口子（import 进来的绑定是只读的） */
export function setPanelWin(v) {
  panelWin = v
}
export function markHitMsg() {
  gotHitMsg = true
}
export function markMeasured(v) {
  measured = !!v
}
export function setPort(v) {
  port = v
}
export function setTray(v) {
  tray = v
}

export function createWindows (deps) {
  const { readJson, writeJson, POS_FILE, OUT, SELFTEST, MOCK, VIEW_PAD, VIEW_ASPECT, log, ARGV, TOPMOST, MODEL_H, INFO_DIR, STATE_FILE, HOOK_FILE, PRELOAD_FILE, STUDY_LITE, currentModelH, readThemeName, host, chatKillTurn, sleep, spawn , cardAlpha, chooseLook, lastJson, runNode } = deps

// ── 几何 ──────────────────────────────────────────────────────────────────────
/**
 * 布局（2026-10-23 改：形象窗 / 浮窗分开）
 *   形象窗 = **就只有她**：窗口 = 她的视图 + 头顶一点气泡空间（+24 边距）。
 *   浮窗是**另一个窗口**（createPanelWindow），位置/大小各自记。
 *   好处：① 透明的大方块小了 → "点空气穿过去"的那片区域小得多，也就不容易"点不到她"；
 *         ② 浮窗能单独拖到屏幕任何地方（以前被窗口箍着，左右挪不动）。
 */
const CARD_W = 470
const CARD_GAP = 16
/**
 * 她头顶留给气泡的空间。
 * 2026-10-22 深夜实测：pet.js 的气泡正文最大 150px、加头尾约 **216px**；原来只留 120
 * → 气泡顶部被窗口切掉 174px（实测 bubble.top = -174，主人看到"上半部分像被框挡住"）。
 * 现在按 260 留（216 + 余量），页签条要抬到气泡之上（见 renderer/app.js 的 BUBBLE_RESERVE）。
 */
const HEAD_ROOM = 250

function headRoom(area, rootH) {
  const usable = Math.max(320, (area ? area.height : 900) - 24)
  // 2026-10-22 深夜：原来写 `usable * 0.25`（他那块屏≈207px）—— 比气泡的 216 还小，
  //   所以"留了空间但不够"，气泡照样被切。现在按"可用高度减她身高"给，上限 260。
  const cap = rootH ? Math.max(150, usable - rootH - 24) : Math.round(usable * 0.55)
  return Math.min(HEAD_ROOM, cap)
}

/** 屏幕放得下"浮窗 + 她"并排吗？（浮窗现在是独立窗口，只用来决定默认摆哪儿） */
function useSideLayout(area) {
  const usableW = Math.max(320, (area ? area.width : 1440) - 24)
  return usableW >= CARD_W + CARD_GAP + 380
}

function planGeometry(modelH, area) {
  const areaH = area ? area.height : 900
  const usable = Math.max(320, areaH - 24)
  let h = Math.round(modelH)
  const maxRootH = usable - HEAD_ROOM
  if (h * (1 + VIEW_PAD * 2) > maxRootH) h = Math.max(140, Math.floor(maxRootH / (1 + VIEW_PAD * 2)))
  const rootH = Math.round(h * (1 + VIEW_PAD * 2))
  const room = headRoom(area, rootH)
  const rootW = Math.round(rootH * VIEW_ASPECT)
  // 形象窗**只装她**（浮窗是另一个窗口，不占这里的地方）
  const winW = Math.max(300, rootW + 24)
  const winH = rootH + room
  return { modelH: h, rootW, rootH, winW, winH, room }
}

function workAreaFor(x, y) {
  try {
    return screen.getDisplayNearestPoint({ x, y }).workArea
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
  if (!Number.isFinite(Number(p.left)) || !Number.isFinite(Number(p.top))) return null
  const area = workAreaFor(Number(p.left) + w / 2, Number(p.top) + h / 2)
  const inter =
    Number(p.left) + w > area.x &&
    Number(p.left) < area.x + area.width &&
    Number(p.top) + h > area.y &&
    Number(p.top) < area.y + area.height
  return inter ? p : null
}

const PANEL_FILE = join(OUT, 'her-app.panel.json')
const PANEL_MOCK_FILE = join(OUT, 'her-app.panel.mock.json')
/** 自检 / 假数据时用 .mock 那份，绝不写主人的真存档（开发守则第三节） */
function panelFile() {
  return SELFTEST || MOCK ? PANEL_MOCK_FILE : PANEL_FILE
}

function readPanelBox() {
  const j = readJson(panelFile()) || {}
  const n = (v, d) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? Math.round(x) : d
  }
  return {
    left: Number.isFinite(Number(j.left)) ? Math.round(Number(j.left)) : null,
    top: Number.isFinite(Number(j.top)) ? Math.round(Number(j.top)) : null,
    width: n(j.width, CARD_W),
    height: n(j.height, 660),
  }
}

function savePanelBox() {
  if (!deps.panelWin || deps.panelWin.isDestroyed()) return
  try {
    const b = deps.panelWin.getBounds()
    writeJson(panelFile(), {
      left: b.x,
      top: b.y,
      width: b.width,
      height: b.height,
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
  } catch {}
}

/**
 * 把一个浮窗框**夹进当前屏幕**（主人 2026-10-24 深夜：「浮窗关闭后不会重新定位……我差点没找到」）
 *   ① 存档位置在当前某个屏幕上 → 夹进那个屏幕的工作区
 *   ② 存档位置**根本不在任何屏幕上**（换过分辨率 / 拔过外接屏 / 以前拖出去过）→ **重新摆到她旁边**
 *   ③ 宽高比屏幕还大 → 压到能放下
 * 纯几何函数，不碰窗口，方便自检直接验。
 */
function fitPanelBox(box) {
  const displays = screen.getAllDisplays()
  const area0 = displays[0] ? displays[0].workArea : screen.getPrimaryDisplay().workArea
  const minW = Math.max(320, Math.min(...displays.map((d) => d.workArea.width)) || CARD_W)
  const minH = Math.max(300, Math.min(...displays.map((d) => d.workArea.height)) || 660)
  const w = Math.max(320, Math.min(Math.round(Number(box.width) || CARD_W), minW - 24))
  const h = Math.max(300, Math.min(Math.round(Number(box.height) || 660), minH - 48))
  const hasPos = Number.isFinite(Number(box.left)) && Number.isFinite(Number(box.top))
  const cx = hasPos ? Number(box.left) + w / 2 : NaN
  const cy = hasPos ? Number(box.top) + h / 2 : NaN
  const onScreen = hasPos
    ? displays.some((d) => {
        const a = d.workArea
        return cx >= a.x - 8 && cx <= a.x + a.width + 8 && cy >= a.y - 8 && cy <= a.y + a.height + 8
      })
    : false
  if (onScreen) {
    // ⚠️ 2026-10-25 主人：「浮窗再出来我会挪到左屏外面」——**他自己挪的位置不许我拉回来**。
    //   所以只要窗口中心还在某个屏幕上（哪怕只露一半、贴着左边缘），就原样不动；
    //   只有尺寸比屏幕还大时才压一下。
    const area = workAreaFor(cx, cy)
    const tooBig = w > area.width - 8 || h > area.height - 8
    if (!tooBig) return { x: Number(box.left), y: Number(box.top), width: w, height: h, moved: false, reason: 'ok' }
    const p = clampInto(area, Number(box.left), Number(box.top), w, h)
    return { x: p.x, y: p.y, width: w, height: h, moved: true, reason: 'clamped' }
  }
  const hb =
    deps.win && !deps.win.isDestroyed()
      ? deps.win.getBounds()
      : { x: area0.x + area0.width - 360, y: area0.y + area0.height - 470, width: 300, height: 470 }
  const area = workAreaFor(hb.x + hb.width / 2, hb.y + hb.height / 2)
  const p = clampInto(area, hb.x - w - 16, hb.y + hb.height - h, w, h)
  return { x: p.x, y: p.y, width: w, height: h, moved: true, reason: hasPos ? 'offscreen' : 'first' }
}

function defaultPanelBox() {
  return fitPanelBox(readPanelBox())
}

// ── 窗口 ──────────────────────────────────────────────────────────────────────

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

function saveUiState(open) {
  if (SELFTEST) return
  const cur = readJson(STATE_FILE) || {}
  writeJson(STATE_FILE, { showChar: cur.showChar !== false, petWindow: !!open, topMost: !!TOPMOST })
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

async function evalJson(script, timeoutMs = 10000) {
  return evalIn(win, script, timeoutMs)
}

/** 在指定的窗口里跑一段 JS 并把结果当 JSON 读回来（浮窗 / 形象窗各自一份） */
async function evalIn(target, script, timeoutMs = 10000) {
  if (!target || target.isDestroyed()) return null
  try {
    const raw = await Promise.race([
      target.webContents.executeJavaScript(script, true),
      new Promise((_, rej) => setTimeout(() => rej(new Error('executeJavaScript 超时')), timeoutMs)),
    ])
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (err) {
    log('evalIn 失败：' + (err && err.message))
    return null
  }
}

/**
 * 右键菜单（2026-10-23 主人：「右键之后只有主要的界面、把所有只要不是主要的东西都放到浮窗卡片里面」）
 * → 这里**只留主要入口**：浮窗开合、六个页面、关掉她。
 *   读钉钉 / 备份 / 规矩文件 / 置顶 / 大小 … 全部搬进设置页（浮窗里的「设置」）。
 */
function buildMenu() {
  const pages = [
    { label: '今日', page: 'today' },
    { label: '任务', page: 'tasks' },
    { label: '日历', page: 'calendar' },
    { label: '对话', page: 'chat' },
    { label: '错题', page: 'mistakes' },
    { label: '设置', page: 'settings' },
  ]
  const panelVisible = !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible())
  return Menu.buildFromTemplate([
    {
      label: panelVisible ? '收起浮窗' : '打开浮窗',
      click: () => {
        if (panelVisible) hidePanelNow()
        else void showPanel(panelPage || 'today')
      },
    },
    { type: 'separator' },
    ...pages.map((p) => ({ label: p.label, click: () => void showPanel(p.page) })),
    { type: 'separator' },
    { label: '让她今天换一身', click: () => void chooseLook({ reason: 'menu' }) },
    { type: 'separator' },
    { label: '关掉她', click: () => win && win.close() },
  ])
}

/**
 * 打开我们那三份 txt 之一。路径靠 study-lite 的 `--refresh` 返回的 written 列表反查：
 * 它是**同一套规则**算出来的，我们不去重复解析规则文件。
 */
function openReport(kind) {
  try {
    const r = lastJson(runNode(STUDY_LITE, ['--refresh']))
    const written = Array.isArray(r?.reports?.written) ? r.reports.written : []
    const want = kind === 'brief' ? '今日提醒' : kind === 'tasks' ? '待办总览' : '本周安排'
    const hit = written.find((p) => String(p).includes(want))
    if (!hit) {
      log(`找不到 ${want} 的文件（--refresh 没返回）`)
      return
    }
    shell.openPath(hit)
  } catch (err) {
    log('打开文件失败：' + (err && err.message))
  }
}

/** 跑一个 info\ 下的 PS 脚本（钉钉读屏 / 备份），跑完让她在气泡里说一句结果 */
function runHelper(script, args = [], label = '脚本') {
  const scriptPath = join(INFO_DIR, script)
  if (!existsSync(scriptPath)) {
    log(`找不到 info\\${script}`)
    return
  }
  log(`跑${label}：${script}`)
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString('utf8')))
    child.stderr.on('data', (c) => log(`  ${script} stderr：` + c.toString('utf8').trim().slice(0, 200)))
    child.on('close', (code) => {
      const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
      log(`${label}结束（exit=${code}）${tail ? '：' + tail.slice(0, 200) : ''}`)
      // 让她在自己的窗口里说一句（走宿主的 /control → 气泡）
      fetch(`http://127.0.0.1:${port}/dsh-pet/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          say: code === 0 ? `${label}好了` : `${label}好像出错了（exit=${code}）`,
          mood: code === 0 ? 'happy' : 'confused',
        }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => {})
    })
  } catch (err) {
    log(`跑${label}失败：` + ((err && err.message) || err))
  }
}

// ── 托盘：她自己的入口（P5 前先把工具都搬过来，好让旧浮窗能退休）───────────────
const TRAY_ICON = join(INFO_DIR, 'pet', 'assets', 'model', 'icon.png')

function buildTray() {
  if (tray) return
  try {
    let img = nativeImage.createFromPath(TRAY_ICON)
    if (!img.isEmpty()) img = img.resize({ width: 20, height: 20 })
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  } catch (err) {
    log('托盘做不出来：' + ((err && err.message) || err))
    return
  }
  tray.setToolTip('她（学业助手）')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏她',
        click: () => {
          if (!win || win.isDestroyed()) return
          if (win.isVisible()) win.hide()
          else {
            win.show()
            win.focus()
          }
        },
      },
      {
        label: '打开 / 收起浮窗',
        click: () => {
          if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) hidePanelNow()
          else void showPanel(panelPage || 'today')
        },
      },
      {
        label: '六个页面',
        submenu: [
          { label: '今日', click: () => void showPanel('today') },
          { label: '任务', click: () => void showPanel('tasks') },
          { label: '日历', click: () => void showPanel('calendar') },
          { label: '对话', click: () => void showPanel('chat') },
          { label: '错题', click: () => void showPanel('mistakes') },
          { label: '设置', click: () => void showPanel('settings') },
        ],
      },
      { label: '今天要做什么', click: () => openReport('brief') },
      { type: 'separator' },
      // 2026-10-24：托盘也照"右键只留主要项"的口径收拾过 —— 读钉钉/备份/规矩/投放区/旧浮窗
      //   全部在浮窗的「设置」页里；这里只留最常用的三个 + 退出。
      { label: '退出（连她和浮窗一起关）', click: () => win && win.close() },
    ]),
  )
  tray.on('click', () => {
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    win.focus()
  })
  log('托盘起来了（' + TRAY_ICON + '）')
}

function applySize(modelH) {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const area = workAreaFor(b.x + b.width / 2, b.y + b.height / 2)
  const g = planGeometry(modelH, area)
  const pos = clampInto(area, b.x, b.y + b.height - g.winH, g.winW, g.winH)
  win.setBounds({ x: pos.x, y: pos.y, width: g.winW, height: g.winH })
  log(`改大小：模型 ${g.modelH}px → 窗口 ${g.winW}×${g.winH} @ (${pos.x},${pos.y})`)
}

async function injectHook(target) {
  const w = target || win
  if (!w || w.isDestroyed()) return
  try {
    await w.webContents.executeJavaScript(readFileSync(HOOK_FILE, 'utf8'), true)
    log('钩子已注入（拖动 / 命中穿透 / 右键菜单）→ ' + (w === win ? '形象窗' : '浮窗'))
  } catch (err) {
    log('钩子注入失败：' + (err && err.message))
  }
}

async function measureAndFit() {
  if (measured) return
  measured = true
  const st = await evalJson(
    'JSON.stringify({ view: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null })',
  )
  if (!st || !st.view) {
    log('量不到她的视图尺寸 → 保持当前窗口大小')
    return
  }
  const b = win.getBounds()
  const area = workAreaFor(b.x + b.width / 2, b.y + b.height / 2)
  const wantW = Math.max(300, Math.round(st.view.w) + 24)
  const wantH = Math.round(st.view.h) + headRoom(area, Math.round(st.view.h))
  if (Math.abs(wantW - b.width) <= 10 && Math.abs(wantH - b.height) <= 10) {
    log(`窗口尺寸已合适：${b.width}×${b.height}（她 ${Math.round(st.view.w)}×${Math.round(st.view.h)}）`)
    return
  }
  const pos = clampInto(area, b.x + (b.width - wantW) / 2, b.y + b.height - wantH, wantW, wantH)
  win.setBounds({ x: pos.x, y: pos.y, width: wantW, height: wantH })
  // 程序自己改的尺寸也要记下来（实测这台机器上 setBounds 不一定会触发 'resized' → 存档一直停在旧尺寸）
  savePos()
  log(`按她量出来的尺寸改窗口：${b.width}×${b.height} → ${wantW}×${wantH} @ (${pos.x},${pos.y})（她 ${Math.round(st.view.w)}×${Math.round(st.view.h)}）`)
}

/**
 * 形象窗（2026-10-23）：**只装她**。
 * 窗口 = 她的视图 + 头顶气泡空间，所以透明区域很小 —— 以前窗口有 820 宽，
 * 一大片"空气"压在桌面上，命中又偶尔抽风，人就会觉得"她点不到 / 被什么挡住了"。
 */
async function createHerWindow() {
  const saved = SELFTEST ? null : loadSavedPos()
  const area0 = screen.getPrimaryDisplay().workArea
  const probeArea = saved ? workAreaFor(Number(saved.left) + 40, Number(saved.top) + 40) : area0
  const modelHeight = currentModelH
  const g = planGeometry(modelHeight, probeArea)

  const width = saved && Number(saved.width) > 200 ? Number(saved.width) : g.winW
  const height = saved && Number(saved.height) > 200 ? Number(saved.height) : g.winH
  let x
  let y
  if (saved) {
    const p = clampInto(probeArea, Number(saved.left), Number(saved.top), width, height)
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

  const theme = readThemeName()
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
      additionalArguments: [
        `--her-mode=her`,
        `--her-layout=${JSON.stringify({ height: modelHeight, maxWidthRatio: 0.98 })}`,
        `--her-theme=${theme}`,
        `--her-headroom=${HEAD_ROOM}`,
        `--her-card-alpha=${cardAlpha()}`,
      ],
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
    log(`形象窗出现：${width}×${height} @ (${x},${y})，模型 ${modelHeight}px，配色 ${theme}，置顶=${TOPMOST}`)
  })

  win.webContents.on('did-finish-load', async () => {
    log('形象窗页面加载完了 → 注入钩子')
    await injectHook(win)
    setTimeout(() => measureAndFit().catch(() => {}), 2200)
    // 保险：只有"钩子根本没跑起来"才放开鼠标。
    //   ⚠️ 别只看"有没有收到命中消息"——鼠标没动过就不会有消息（踩过：一开窗就误判，
    //   结果整个窗口都吃掉桌面点击，看着像"她的空气挡着你了"）。
    setTimeout(async () => {
      if (gotHitMsg) return
      const probe = await evalJson('JSON.stringify({ hook: !!window.__herShellHook, shell: !!window.herShell })')
      if (probe && probe.hook && probe.shell) {
        log('钩子在，鼠标还没动过 → 保持点击穿透（点空气会穿过去）')
        return
      }
      setIgnore(false)
      log('⚠️ 钩子没跑起来 → 先放开鼠标（不做点击穿透），请查 apps\\desktop\\inject.js')
    }, 6000)
  })

  win.webContents.on('render-process-gone', (_e, d) => log('形象窗页面进程没了：' + JSON.stringify(d)))

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
    chatKillTurn()
    if (host.started && host.child) {
      try {
        host.child.kill()
        log('宿主是自己起的 → 一起收掉')
      } catch {}
    }
  })

  win.on('closed', () => {
    // 2026-10-25：这条以前只记一句"关了"，查不出是谁关的（主人问过两次"她自己关了？"）。
    //   现在把 pid / 是不是自检 / 是不是我们主动收工 都记上，下次再现就能对上号。
    log(`形象窗 closed（pid=${process.pid} 自检=${SELFTEST} 主动收工=${quitting} 假数据=${MOCK}）`)
    win = null
    // 主人：「关形象一定要关掉浮窗」→ 她没了，浮窗不许留着
    try {
      if (panelWin && !panelWin.isDestroyed()) {
        panelWin.destroy()
        log('形象窗关了 → 浮窗一起收掉')
      }
    } catch {}
    panelWin = null
    app.quit()
  })

  // 她的布局种子（?h= / ?maxW=）+ 我们的页面（her=1 → 这个窗口只画她）
  const url = ARGV.get('url') || `http://127.0.0.1:${port}/app?h=${modelHeight}&maxW=0.98&her=1`
  log('加载 ' + url)
  win.loadURL(url).catch((err) => log('loadURL 失败：' + (err && err.message)))
}

// ── 浮窗（独立窗口，2026-10-23）───────────────────────────────────────────────
/**
 * 主人：「浮窗只是单独于形象可移动和关闭（但是关形象一定要关掉浮窗），
 *        不是每个功能浮窗独立出现」
 * → 就一个窗口。标题条按住 = 移这个窗口（Chromium 原生 app-region 拖动）；
 *   位置和大小记在 out\her-app.panel.json；关掉只是 hide()，形象关掉时整个应用一起退。
 */
// （浮窗摆位：挪进 main\windows.mjs，见下面的 createWindows）


async function createPanelWindow(page) {
  const box = defaultPanelBox()
  const theme = readThemeName()
  panelWin = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    minWidth: 320,
    minHeight: 240,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    // 最小化要留着：主人偶尔要把它按下去
    minimizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: '她 · 浮窗',
    alwaysOnTop: TOPMOST,
    webPreferences: {
      preload: PRELOAD_FILE,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [
        `--her-mode=panel`,
        `--her-theme=${theme}`,
        `--her-card-alpha=${cardAlpha()}`,
        `--her-headroom=${HEAD_ROOM}`,
      ],
    },
  })
  panelWin.setMenuBarVisibility(false)
  panelWin.on('show', () => {
    panelShown = true
  })
  panelWin.on('hide', () => {
    panelShown = false
  })
  panelWin.webContents.on('did-finish-load', async () => {
    await injectHook(panelWin)
    if (SELFTEST) panelWin.setPosition(-3200, -2000)
    panelWin.webContents.send('her:panel-show', { page: panelPage })
  })
  panelWin.webContents.on('render-process-gone', (_e, d) => log('浮窗页面进程没了：' + JSON.stringify(d)))
  panelWin.on('moved', () => {
    clearTimeout(panelSaveTimer)
    panelSaveTimer = setTimeout(savePanelBox, 400)
  })
  panelWin.on('resized', () => {
    clearTimeout(panelSaveTimer)
    panelSaveTimer = setTimeout(savePanelBox, 400)
  })
  panelWin.on('close', (e) => {
    // 关浮窗 ≠ 退出应用：只藏起来（她的形象还在）
    if (quitting) return
    e.preventDefault()
    panelWin.hide()
    log('浮窗收起（她还在）')
  })
  panelWin.on('closed', () => {
    panelWin = null
  })

  const url = `http://127.0.0.1:${port}/app?panel=1&h=${currentModelH}&maxW=0.98`
  log('加载浮窗 ' + url)
  panelPage = String(page || panelPage || 'today')
  await panelWin.loadURL(url).catch((err) => log('浮窗 loadURL 失败：' + (err && err.message)))
  return panelWin
}

/** 打开浮窗并显示某一页（第一次调用就是在建窗口） */
async function showPanel(page) {
  const want = String(page || 'today')
  const changed = want !== panelPage
  panelPage = want
  try {
    if (!panelWin || panelWin.isDestroyed()) {
      await createPanelWindow(want)
      panelWin.show()
      if (!SELFTEST) panelWin.focus()
      log('浮窗开了（' + want + '）')
      return { ok: true, page: want, created: true }
    }
    // ⚠️ 只在"换页 / 刚露出来"时才告诉页面 —— 每次都发会和页面的 openTab 撞成死循环
    //    （2026-10-24 自检里撞过：内容一直清空重画，最后每页都是空的）
    if (changed || !panelWin.isVisible()) panelWin.webContents.send('her:panel-show', { page: want })
    // 露出来之前再看一眼：窗口可能被拖出屏幕 / 上次存档在别的显示器上（主人 2026-10-24 深夜）
    try {
      const cur = panelWin.getBounds()
      const fit = fitPanelBox({ left: cur.x, top: cur.y, width: cur.width, height: cur.height })
      if (fit.moved && (fit.reason === 'offscreen' || Math.abs(fit.x - cur.x) > 2 || Math.abs(fit.y - cur.y) > 2)) {
        panelWin.setBounds({ x: fit.x, y: fit.y, width: fit.width, height: fit.height })
        log(`浮窗本来在 (${cur.x},${cur.y}) 放不回来（${fit.reason}）→ 挪到 (${fit.x},${fit.y})`)
        savePanelBox()
      }
    } catch {}
    if (!panelWin.isVisible()) panelWin.show()
    panelWin.moveTop()
    log('浮窗显示（' + want + '）')
    return { ok: true, page: want, created: false }
  } catch (err) {
    log('开浮窗失败：' + ((err && err.message) || err))
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function hidePanelNow() {
  try {
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) {
      // 收起前把位置记下来（不然"什么都没动过"的那种关闭之后，存档还是旧的）
      savePanelBox()
      panelWin.hide()
      log('浮窗收起（她还在）')
    }
  } catch {}
  return { ok: true }
}


  return {
    CARD_W,
    CARD_GAP,
    HEAD_ROOM,
    headRoom,
    useSideLayout,
    planGeometry,
    workAreaFor,
    clampInto,
    loadSavedPos,
    PANEL_FILE,
    PANEL_MOCK_FILE,
    panelFile,
    readPanelBox,
    savePanelBox,
    fitPanelBox,
    defaultPanelBox,
    savePos,
    saveUiState,
    setIgnore,
    evalJson,
    evalIn,
    buildMenu,
    openReport,
    runHelper,
    buildTray,
    applySize,
    injectHook,
    measureAndFit,
    createHerWindow,
    createPanelWindow,
    showPanel,
    hidePanelNow,
  }
}
