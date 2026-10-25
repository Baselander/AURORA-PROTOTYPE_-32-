/**
 * apps/desktop/main.mjs —— 新应用的主进程（2026-10-22 晚，P1）
 * =============================================================================
 *
 * 这一版把「壳」从 WinForms 换成 Electron + 我们自己的页面，**数据层一个字都没动**：
 *   · 取数据 = 跑 info\brief-json.mjs / info\study-lite.mjs（和浮窗用的是同一套）
 *   · 她 = info\pet 里的 Live2D 引擎，只当渲染层用（她的工具栏/选择面板被我们藏掉）
 *
 * 它负责：
 *   · 起/复用宿主 serve.mjs（端口在 out\pet-port.json）
 *   · 开一个**无边框、透明、无阴影**的窗口，加载 `http://127.0.0.1:<port>/app`
 *   · 窗口尺寸 = 她 + 卡片区（卡片是往上开的，得给她头顶留地方）
 *   · 拖动 / 点击穿透 / 位置记忆 / 右键菜单（跟旧的透明外壳同一套口径）
 *   · 给页面供数据：`her:data` / `her:act`（页面不许自己摸文件）
 *   · 自检 `--selftest`：屏幕外开窗 → 让页面自己断言 DOM → 截图验 alpha → 写日志
 *
 * 用法（正常由 info\pet-window.ps1 拉起）：
 *   electron.exe apps/desktop --h=340 [--topmost=1] [--selftest] [--mock]
 *
 * ⚠️ ESM（package.json 里 "type":"module"）。
 * =============================================================================
 */

import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, shell, Notification } from 'electron'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync , cpSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve , isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { createHash } from 'node:crypto'
// 方括号 = 控制模型 / 小括号 = 给人看（规则在 info\brackets.mjs，brain 和这里共用；纯 ESM，没有副作用）
import { makeBracketBroom, stripBracketControls } from '../../info/brackets.mjs'
// ```board 画图块：从念稿里剥掉（画图块里的 JSON 绝不能被念出来）—— 解析在 info\board.mjs
import { stripBoardBlocks } from '../../info/board.mjs'
// 语音（Edge / piper）整段在 main\tts.mjs（2026-10-25 P1-2 拆出来的）
import { createTts } from './main/tts.mjs'
// 归档（已完成的待办只留一周）在 main\archive.mjs
import { createArchive } from './main/archive.mjs'
// 她自己的打扮在 main\look.mjs
import { createLook } from './main/look.mjs'
// 对话（流式 / 主题 / 方括号控制）在 main\chat.mjs
import { createChat } from './main/chat.mjs'
// 提醒（DDL 提醒/提醒队列/每日/每周/学科计划）在 main\remind.mjs
import { createRemind } from './main/remind.mjs'
// 窗口摆位（几何 / 浮窗位置）在 main\windows.mjs
import { createWindows } from './main/windows.mjs'
// 窗口 / 托盘 / 浮窗在 main\windows.mjs（2026-10-25 P2④）；状态也是从那边 import 的活绑定
import {
  win,
  panelWin,
  panelPage,
  panelSaveTimer,
  panelShown,
  port,
  ignoring,
  gotHitMsg,
  saveTimer,
  measured,
  quitting,
  tray,
  setPanelWin,
  markHitMsg,
  markMeasured,
  setPort,
  setTray,
} from './main/windows.mjs'


const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..', '..')
const INFO_DIR = join(PROJECT_ROOT, 'info')
const OUT = join(PROJECT_ROOT, 'out')
const POS_FILE = join(OUT, 'pet-window.pos')
const PORT_FILE = join(OUT, 'pet-port.json')
const STATE_FILE = join(OUT, 'ui-state.json')
const LOG_FILE = join(OUT, 'her-app.log')
const SELFTEST_LOG = join(OUT, 'her-app-selftest.log')
const HOOK_FILE = join(HERE, 'inject.js')
const PRELOAD_FILE = join(HERE, 'preload.mjs')
const SERVE_FILE = join(INFO_DIR, 'pet', 'serve.mjs')
const BRIEF_TOOL = join(INFO_DIR, 'brief-json.mjs')
const AGENDA_TOOL = join(INFO_DIR, 'agenda-json.mjs')
const BRAIN = join(INFO_DIR, 'brain.mjs')
const STUDY_LITE = join(INFO_DIR, 'study-lite.mjs')
const TASK_ADD = join(INFO_DIR, 'task-add.mjs')
const LOCAL_PROCESS = join(INFO_DIR, 'local-process.mjs')
const SETTINGS_LITE = join(INFO_DIR, 'settings-lite.ps1')
const FLOAT_LAUNCH = join(INFO_DIR, 'launch.ps1')
/** 界面上的小配置（卡片透明度等）：单独一个文件，跨启动记住 */
const UI_FILE = join(OUT, 'her-app.ui.json')
/** 卡片背景的不透明度（0.55~1.00）。1 = 完全不透明，0.55 = 很透 */
function cardAlpha() {
  const j = readJson(UI_FILE) || {}
  const v = Number(j.cardAlpha)
  return Number.isFinite(v) && v >= 0.55 && v <= 1 ? Math.round(v * 100) / 100 : 0.97
}

// ── 卡片位置（2026-10-23 多卡片：每张卡片记自己那一份）───────────────────────
/** 她多大（跨启动记住）：单独一个文件，免得和窗口位置纠缠 */
const MODEL_FILE = join(OUT, 'her-app.model.json')

/** 她和窗口的比例口径，跟 pet.js 的 PAD / VIEW_ASPECT 对齐（改那边记得改这里）。 */
const VIEW_PAD = 0.1
const VIEW_ASPECT = 1.15

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
/**
 * 自检两档（2026-10-25 P2）：
 *   默认 = 快速档（~40 秒）：不真跑 task-add / mistake-add / archive / chat 模拟那些脚本
 *   --selftest-slow = 完整档（实测整轮 80.9 秒）：全部跑，连"真落一条任务/真改 docx"都验
 * 两档断言条数一样（跳过记成 ✅ … 跳过），所以"176 项全绿"这个口径不变。
 */
const SELFTEST_SLOW = ARGV.has('selftest-slow')
/** 假数据（截图 / 看图复核 / 自检用）：**绝不**把主人的真名真事送出去 */
const MOCK = ARGV.has('mock')
const MODEL_H = Math.round(num('h', 340))
// 2026-10-22 深夜（主人："还是改成置顶吧，也不占空间"）：默认置顶，命令/菜单可以关。
// 2026-10-23：设置页也能改（右键菜单只留主要项了），所以是 let。
let TOPMOST = ARGV.get('topmost') !== '0'
/** 她多大：优先用上次在设置页选的那档，其次命令行，最后默认 340。 */
let currentModelH = (() => {
  try {
    const j = readJson(MODEL_FILE)
    const v = Number(j && j.modelHeight)
    return Number.isFinite(v) && v >= 140 && v <= 700 ? Math.round(v) : Math.round(num('h', 340))
  } catch {
    return Math.round(num('h', 340))
  }
})()

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

/**
 * 便携包 / 安装包带的配置（JSON），优先级低于环境变量、高于内置默认。
 * 这样**快捷方式可以直接指向 electron.exe**（不用 .cmd 包一层，也就没有黑框一闪）。
 */
function readPortableConfig() {
  const candidates = [join(PROJECT_ROOT, 'her-config.json'), join(HERE, 'her-config.json')]
  for (const file of candidates) {
    try {
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
    } catch {}
  }
  return null
}
const PORTABLE_CFG = readPortableConfig()
/** 把这几个变量显式喂给子进程用（跑 study-core 的 CLI 时要用） */
function childEnv() {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_PROJECT_ROOT: PROJECT_ROOT,
    DSH_G10_ROOT: G10,
    DSH_DATA: DATA_ROOT,
  }
}

/**
 * Electron 自己的 userData（缓存 / localStorage）**按安装位置隔离**。
 * 为什么：Electron 默认按 package.json 的 name 取目录（`her-desktop`），
 * 开发版和打包版会抢同一个 Cache → 实测报 `Unable to move the cache: 拒绝访问`。
 * 开发版落到 `<项目>\out\electron-userdata`，打包版由 her-config.json 指到 LOCALAPPDATA。
 */
const USER_DATA_DIR =
  process.env.DSH_USERDATA || (PORTABLE_CFG && PORTABLE_CFG.userData) || join(OUT, 'electron-userdata')

function applyUserData() {
  try {
    mkdirSync(USER_DATA_DIR, { recursive: true })
    app.setPath('userData', USER_DATA_DIR)
  } catch {}
}

// ── 数据目录 / 她的配色（和浮窗同一份规则文件）────────────────────────────────
const G10 = process.env.DSH_G10_ROOT || (PORTABLE_CFG && PORTABLE_CFG.g10Root) || 'AURORA_DATA'
const DATA_ROOT =
  process.env.DSH_DATA || (PORTABLE_CFG && PORTABLE_CFG.dataRoot) || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const LOOK_RULES = `${DATA_ROOT}/mystery/DSH/她的限制-形象与互动.txt`
/** 错题本（主人真数据，只读）：跟旧浮窗「错题」页同一个文件 */
const MISTAKE_FILE = `${DATA_ROOT}/新建/_AURORA工作区/错题本生成器/entries.json`
const MISTAKE_DIR = `${DATA_ROOT}/新建/_AURORA工作区/错题本生成器`
const MISTAKE_ADD = join(INFO_DIR, 'mistake-add.mjs')
/** 收件箱（主人手写的一行一件事）：和旧浮窗同一个文件 */
const INBOX_FILE = `${DATA_ROOT}/_study-core/收件箱.txt`
/** 「今天带什么」的勾选状态（一行一件；按 日期 + 原文 记，不改 tasks.json） */
const CHECK_FILE = `${DATA_ROOT}/_study-core/每日勾选.json`

/** 投放区（主人 2026-10-22 深夜要的）：错题材料/截图直接丢这里，界面能看到 */
const DROP_DIR = `${DATA_ROOT}/_study-core/投放区`
/** 她的大脑的会话记忆（一行一条 {at,role,content}） */
const SESSION_FILE = `${DATA_ROOT}/_study-core/brain-session.jsonl`
/** 一轮对话的输入落在这里（用 --ask-file，避免命令行转义/长度问题） */
const CHAT_IN_FILE = join(OUT, 'her-chat-in.txt')
/** 语音：常驻 piper 服务（和旧浮窗同一套） */
const TTS_SCRIPT = join(INFO_DIR, 'tts', 'piper_serve.py')
const TTS_DIR = join(OUT, 'tts')
const SPEAK_RULES = `${DATA_ROOT}/mystery/DSH/她的限制-说话.txt`
/** 语言开关（2026-10-25 P2）：她自己的状态文件，和 brain.mjs 读的是同一份 */
const LANG_FILE = `${DATA_ROOT}/_study-core/她的语言.json`

function readLangMode() {
  const j = readJson(LANG_FILE) || {}
  const m = String(j.mode || '').toLowerCase()
  return m === 'zh' || m === 'en' ? m : 'follow'
}

function setLangMode(mode) {
  const m = String(mode || '').toLowerCase()
  if (!['follow', 'zh', 'en'].includes(m)) return { ok: false, error: '只认 follow / zh / en' }
  try {
    writeJson(LANG_FILE, { mode: m, at: new Date().toISOString() })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  log(`语言 → ${m === 'follow' ? '跟着主人走' : m === 'zh' ? '只说中文' : '只说英文'}（下一句生效）`)
  return { ok: true, mode: m }
}

/** 现在挂的那个形象包叫什么（只有一个包时也知道它是哪个；以后放新包进来这里会显示出来） */
/** 当前模型的全部动作名（manifest.motions 的键）—— 设置页"待机动作"列它 */
function readModelMotions() {
  const f = join(INFO_DIR, 'pet', 'assets', 'model', 'manifest.json')
  try {
    const j = readJson(f) || {}
    const m = j.motions && typeof j.motions === 'object' ? j.motions : {}
    return Object.keys(m)
  } catch {
    return []
  }
}

// ── 形象包（2026-10-25 第 7 项）──────────────────────────────────────────────
/** 现在生效的形象包目录（pet.js / serve.mjs 都写死了这个路径，所以"切包"= 换这里的文件） */
const MODEL_DIR = join(INFO_DIR, 'pet', 'assets', 'model')
/** 可选包放这里，一个包一个子目录（里面要有 *.model3.json） */
const MODEL_PACKS_DIR = join(INFO_DIR, 'pet', 'assets', 'model-packs')
/** 选了哪个包（她自己的状态） */
const PACK_STATE = `${DATA_ROOT}/_study-core/她的形象包.json`

/** 列出可选的形象包（只认"里面真有 *.model3.json"的目录） */
function readModelPacks() {
  const out = []
  try {
    if (existsSync(MODEL_PACKS_DIR)) {
      for (const d of readdirSync(MODEL_PACKS_DIR)) {
        const dir = join(MODEL_PACKS_DIR, d)
        try {
          if (!statSync(dir).isDirectory()) continue
        } catch {
          continue
        }
        const model = readdirSync(dir).find((f) => f.endsWith('.model3.json'))
        if (model) out.push({ name: d, model, from: 'model-packs/' + d })
      }
    }
  } catch {}
  return out
}

/** 现在用的是哪个包 */
function activeModelPack() {
  const j = readJson(PACK_STATE) || {}
  return String(j.name || 'c_0120（当前目录）')
}

/**
 * 切形象包：把选中的包**整目录拷进 assets/model/**（pet.js 与 serve.mjs 只认这一条路径），
 * 动之前先把现在的包备份成 `model.bak-<时间戳>`，然后重载形象窗让模型重新加载。
 * 参数：字符串包名 / { name } / { path: 绝对路径 }（本机试用放在项目外的包走 path）。
 */
function setModelPack(arg) {
  const a = arg && typeof arg === 'object' ? arg : { name: String(arg || '') }
  const wantName = String(a.name || '').trim()
  const wantPath = String(a.path || '').trim()
  let src = ''
  let label = wantName
  if (wantPath) {
    if (!isAbsolute(wantPath)) return { ok: false, error: 'path 必须给绝对路径' }
    src = wantPath
    label = wantPath.split(/[\\/]/).filter(Boolean).pop() || wantPath
  } else {
    const hit = readModelPacks().find((x) => x.name === wantName)
    if (!hit) return { ok: false, error: '没有这个包：' + wantName, packs: readModelPacks().map((x) => x.name) }
    src = hit.from ? join(INFO_DIR, 'pet', 'assets', hit.from) : hit.path
  }
  try {
    if (!existsSync(src)) return { ok: false, error: '包目录不存在：' + src }
    const modelFile = readdirSync(src).find((f) => f.endsWith('.model3.json'))
    if (!modelFile) return { ok: false, error: '这个目录里没有 *.model3.json（不是 Live2D 包）：' + src }
    if (resolve(src) === resolve(MODEL_DIR)) return { ok: false, error: '这就是现在这个包，不用切' }
    // ① 备份现在这个包
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '').replace(/-/g, '')
    const backup = MODEL_DIR + '.bak-' + stamp
    if (existsSync(MODEL_DIR)) {
      cpSync(MODEL_DIR, backup, { recursive: true })
      log(`形象包：先把现在这个备份到 ${backup.split(/[\\/]/).pop()}`)
    }
    // ② 换内容（先清空再拷，避免新旧文件混在一起）
    rmSync(MODEL_DIR, { recursive: true, force: true })
    cpSync(src, MODEL_DIR, { recursive: true })
    // ③ 记账
    writeJson(PACK_STATE, { name: label, model: modelFile, at: new Date().toISOString() })
    log(`形象包 → ${label}（${modelFile}）；形象窗重载中`)
    // ④ 重载形象窗（did-finish-load 会再注一次钩子）
    try {
      if (win && !win.isDestroyed()) win.reload()
    } catch {}
    return { ok: true, name: label, model: modelFile, backup: backup.split(/[\\/]/).pop(), packs: readModelPacks().map((x) => x.name) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function readModelPack() {
  const dir = join(INFO_DIR, 'pet', 'assets', 'model')
  try {
    const files = readdirSync(dir)
    const model = files.find((f) => f.endsWith('.model3.json'))
    if (!model) return { name: '', file: '' }
    const base = model.replace(/\.model3\.json$/, '')
    let nickname = base
    try {
      const j = readJson(join(dir, 'manifest.json'))
      const nm = j && (j.name || j.Name || j.title)
      if (nm) nickname = String(nm)
    } catch {}
    return { name: nickname, file: `assets/model/${model}` }
  } catch {
    return { name: '', file: '' }
  }
}

function readThemeName() {
  const fallback = '电光蓝'
  try {
    const text = readFileSync(LOOK_RULES, 'utf8')
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim()
      if (t.startsWith('#')) continue
      const m = /^主题配色\s*=\s*(.+)$/.exec(t)
      if (m) {
        const want = m[1].trim()
        return ['电光蓝', '暗紫', '青绿', '少女粉'].includes(want) ? want : fallback
      }
    }
  } catch {}
  return fallback
}

/** 跑一个 node 脚本（用 electron 自带的 node：装完不用额外 node）。返回 stdout。 */
function runNode(scriptPath, args = [], timeoutMs = 25000) {
  if (!existsSync(scriptPath)) return ''
  try {
    const r = spawnSync(process.execPath, [scriptPath, ...args], {
      env: childEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    return (r.stdout || '').trim()
  } catch (err) {
    log(`跑 ${scriptPath} 失败：${err && err.message}`)
    return ''
  }
}

function lastJson(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('{'))
    .pop()
  try {
    return JSON.parse(line || '{}')
  } catch {
    return {}
  }
}

// ── 假数据（只有 --mock 时用；内容全是编的）──────────────────────────────────
const MOCK_TODAY = {
  ok: true,
  mock: true,
  date: '2026-10-22',
  weekdayZh: '星期四',
  isSchoolDay: true,
  classId: '111A',
  sections: [
    { heading: '携带物', lines: ['· 生物：实验报告册（第 3 章）', '· 经济：计算器'] },
    { heading: '课程', lines: ['① 08:00–09:30 AP Physics 1 · B201', '② 10:00–11:30 Pre-AP Biology · B105', '③ 13:00–14:30 自习 · 图书馆'] },
    { heading: '今天要交', lines: ['· 生物 · 实验报告 第 3 章（今天 22:00）'] },
    { heading: '已经迟了', lines: ['· 经济 · 习题 4.2（昨天 22:00）'] },
    { heading: '接下来', lines: ['· 明天：数学 · 练习册 P.42'] },
    { heading: '要确认', lines: ['· 周五的物理测验教室还没写'] },
  ],
}

/** mock 模式下"已勾掉"的东西（自检点一下就能验证） */
const MOCK_CHECKED = []

/** 假数据里的"今天"（自检要验「今天做完了 N 条」，所以这条得是真今天，不能用写死的假日期） */
function mockToday() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const MOCK_TASKS = {
  ok: true,
  mock: true,
  tasks: [
    { id: 't-mock-1', title: '实验报告 第 3 章', kind: 'homework', status: 'open', subjectName: 'Pre-AP Biology', dueDate: '2026-10-22', dueTime: '22:00', overdue: false },
    { id: 't-mock-2', title: '习题 4.2', kind: 'homework', status: 'open', subjectName: 'AP Microeconomics', dueDate: '2026-10-21', dueTime: '22:00', overdue: true },
    { id: 't-mock-3', title: '练习册 P.42', kind: 'homework', status: 'open', subjectName: '数学', dueDate: '2026-10-23', dueTime: '22:00', overdue: false },
    { id: 't-mock-4', title: '整理错题（自己的）', kind: 'todo', status: 'open', subjectName: null, dueDate: null, dueTime: null, overdue: false },
    { id: 't-mock-5', title: '背单词 30 个', kind: 'todo', status: 'done', subjectName: null, dueDate: '2026-10-22', dueTime: '20:00', overdue: false },
    { id: 't-mock-6', title: '自检：今天做完的一条', kind: 'homework', status: 'done', subjectName: 'Pre-AP Biology', dueDate: mockToday(), dueTime: '18:00', overdue: false },
  ],
}

const MOCK_AGENDA = (() => {
  const base = [
    { date: '2026-10-21', weekdayZh: '周三', isSchoolDay: true, items: [{ time: '08:00', label: 'AP Calculus BC', room: 'B201', kind: 'course' }] },
    { date: '2026-10-22', weekdayZh: '周四', isSchoolDay: true, items: [
      { time: '08:00', label: 'AP Microeconomics', room: '5310', kind: 'course' },
      { time: '10:40', label: '物理', room: '阶梯教室', kind: 'course' },
      { time: '13:00', label: '自习', room: '图书馆', kind: 'non-course', isSelfStudy: true },
    ] },
    { date: '2026-10-23', weekdayZh: '周五', isSchoolDay: true, items: [{ time: '09:00', label: 'Pre-AP Seminar', room: '5209', kind: 'course' }] },
    { date: '2026-10-24', weekdayZh: '周六', isSchoolDay: false, items: [] },
    { date: '2026-10-25', weekdayZh: '周日', isSchoolDay: false, items: [] },
    { date: '2026-10-26', weekdayZh: '周一', isSchoolDay: true, items: [{ time: '08:00', label: 'Pre-AP Biology', room: 'B105', kind: 'course' }] },
    { date: '2026-10-27', weekdayZh: '周二', isSchoolDay: true, items: [{ time: '08:00', label: '数学', room: 'B301', kind: 'course' }] },
  ]
  return {
    ok: true,
    mock: true,
    source: 'mock',
    from: '2026-10-21',
    days: base.map((d) => ({
      ...d,
      isToday: d.date === '2026-10-22',
      selfStudyRoom: null,
      hasSelfStudy: d.items.some((i) => i.isSelfStudy),
      materials: [],
      dueTasks:
        d.date === '2026-10-22'
          ? [MOCK_TASKS.tasks[0]]
          : d.date === '2026-10-23'
            ? [MOCK_TASKS.tasks[2]]
            : [],
    })),
    overdue: [MOCK_TASKS.tasks[1]],
    reminders: [],
    notices: [
      { text: '周五物理测验改到下午第三节', date: '2026-10-23' },
      { text: '下周一早读换到 5209', date: null },
    ],
    noticeList: [
      { id: 'n-mock-1', text: '周五物理测验改到下午第三节', date: '2026-10-23' },
      { id: 'n-mock-2', text: '下周一早读换到 5209', date: null },
    ],
    rulesFound: true,
    timetableFound: true,
  }
})()

function loadToday() {
  if (MOCK) return Object.assign({}, MOCK_TODAY, { checkedMaterials: checkedToday() })
  const data = lastJson(runNode(BRIEF_TOOL))
  if (!data || !Array.isArray(data.sections)) {
    return { ok: false, sections: [], error: '今日提醒拿不到（info/brief-json.mjs）' }
  }
  return Object.assign({}, data, { checkedMaterials: checkedToday() })
}

function loadTasks() {
  if (MOCK) return MOCK_TASKS
  const data = lastJson(runNode(STUDY_LITE, ['--list']))
  if (!data || !Array.isArray(data.tasks)) return { ok: false, tasks: [], error: '待办拿不到（info/study-lite.mjs）' }
  return data
}

function loadAgenda() {
  if (MOCK) return MOCK_AGENDA
  const data = lastJson(runNode(AGENDA_TOOL))
  if (!data || !Array.isArray(data.days)) return { ok: false, days: [], error: '本周安排拿不到（info/agenda-json.mjs）' }
  return data
}

// ── 每日勾选（「今天要带的」点一下勾掉）────────────────────────────────────────
function todayKey() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 今天勾掉的条目（原文数组）。文件不存在 = 什么都没勾。 */
function checkedToday() {
  if (MOCK) return MOCK_CHECKED.slice()
  const j = readJson(CHECK_FILE) || {}
  const day = j[todayKey()]
  return Array.isArray(day) ? day.slice() : []
}

function toggleCheck(text) {
  const item = String(text || '').trim()
  if (!item) return { ok: false, error: '空的' }
  if (MOCK) {
    const i = MOCK_CHECKED.indexOf(item)
    if (i >= 0) MOCK_CHECKED.splice(i, 1)
    else MOCK_CHECKED.push(item)
    return { ok: true, checked: MOCK_CHECKED.indexOf(item) >= 0, mock: true }
  }
  const j = readJson(CHECK_FILE) || {}
  const day = todayKey()
  let list = Array.isArray(j[day]) ? j[day].slice() : []
  const i = list.indexOf(item)
  const nowChecked = i < 0
  if (nowChecked) list.push(item)
  else list.splice(i, 1)
  // 只留最近 14 天，别把文件养胖
  const keys = Object.keys(j).sort().slice(-14)
  const next = {}
  for (const k of keys) next[k] = j[k]
  next[day] = list
  writeJson(CHECK_FILE, next)
  return { ok: true, checked: nowChecked }
}

// ── 错题本（只读）─────────────────────────────────────────────────────────────
const MOCK_MISTAKES = {
  ok: true,
  mock: true,
  // 假数据也照真数据的形状来：小结第一行是「类别 N（明细）｜…」，错题页要把它拆成表格
  summary: {
    heading: '错因分布小结（假数据 · 共 3 条）',
    lines: [
      '知识遗忘 / 概念条件缺失 1（假：历史课的概念混淆）｜粗心 1（假：点斜式坐标串位）｜审题 1（假：看错图像）',
      '（假数据）这一行就是原来那种"一整段串起来"的小结 —— 现在折进「原始小结」里了。',
    ],
    trio: ['（未采纳 · 备用）主线一：假数据里的备用主线'],
  },
  entries: [
    {
      title: '01｜2026-10-07（周三）· 假课 · 样例题 第 3 题',
      rows: [
        ['① 日期时间 · 科目/来源', '2026-10-07（周三）· 假课 · 样例测验 · 第 3 题'],
        ['② 错误题目（完整原文）', 'Which of the following best explains ... ？A) … B) … C) … D) …'],
        ['③ 我的选项 / 正确选项', '我选 B；正确 C'],
        ['④ 错因', '把"同一批材料"误读成"同一批人"。'],
        ['⑤ 方案', '· 先找题干里的时间/地点限定词\n· 再排除跨时间的选项'],
      ],
    },
    {
      title: '02｜2026-10-09（周五）· 假课 · 样例题 第 7 题',
      rows: [
        ['② 错误题目（完整原文）', 'Solve for x: …'],
        ['③ 我的选项 / 正确选项', '我填 3；正确 −3'],
        ['④ 错因', '移项时漏了符号。'],
        ['⑤ 方案', '· 移项后立刻回代验算'],
      ],
    },
    {
      title: '03｜2026-10-09（周五）· 假数学 · 样例题 第 2 题',
      rows: [
        ['① 日期时间 · 科目/来源', '2026-10-09（周五）· 假数学 · 样例练习 · 第 2 题'],
        ['② 错误题目（完整原文）', 'Compute the limit …'],
        ['③ 我的选项 / 正确选项', '我算 0；正确 2'],
        ['④ 错因', '审题时把"分母"看成了"分子"。'],
        ['⑤ 方案', '· 先圈出要求的那一项再看式子'],
      ],
    },
  ],
}

function loadMistakes() {
  if (MOCK) return MOCK_MISTAKES
  if (!existsSync(MISTAKE_FILE)) {
    return { ok: false, entries: [], error: '找不到错题本数据：' + MISTAKE_FILE }
  }
  const j = readJson(MISTAKE_FILE)
  if (!j || !Array.isArray(j.entries)) return { ok: false, entries: [], error: '错题本格式看不懂（没有 entries）' }
  return {
    ok: true,
    summary: j.summary || null,
    entries: j.entries,
    total: j.entries.length,
  }
}

// ── 对话：挪进 main\chat.mjs（2026-10-25 P1-2，逻辑原样；act 名和 her:* 通道没动）
const chat = createChat({
  log,
  spawn,
  MOCK,
  SELFTEST,
  DATA_ROOT,
  OUT,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  join,
  basename,
  dirname,
  petControl,
  BRAIN,
  CHAT_IN_FILE,
  SESSION_FILE,
  readJson,
  writeJson,
  maybeLearnFromReply,
  maybeRememberFromReply,
  makeSpeaker,
  get LOOK_GROUPS() {
    return LOOK_GROUPS
  },
  get win() {
    return win
  },
  get panelWin() {
    return panelWin
  },
})
const {
  MOCK_HISTORY,
  CHAT_TOPIC_FILE,
  DEFAULT_TOPIC,
  chatTopicFile,
  safeTopic,
  topicSessionFile,
  readCurrentTopic,
  setCurrentTopic,
  listChatTopics,
  readRuleNumber,
  scheduleExpressionReset,
  applyBracketControls,
  startTurn,
  loadChatHistory,
  killTurn,
} = chat
const chatKillTurn = () => chat.killTurn()


// ── 语音：挪进 main\tts.mjs（2026-10-25 P1-2，逻辑原样；act 名和 her:* 通道没动）
const tts = createTts({
  log,
  sleep,
  readJson,
  writeJson,
  MOCK,
  INFO_DIR,
  OUT,
  TTS_DIR,
  TTS_SCRIPT,
  SPEAK_RULES,
  get win() {
    return win
  },
})
const {
  speak,
  speakBubble,
  startBubbleWatch,
  setVoiceConfig,
  buildTtsCache,
  stopTts,
  ensureTts,
  readVoiceConfig,
  voiceAllowed,
  ttsCachePath,
  readCacheIndex,
  DAILY_LINES,
  TTS_CACHE,
  VOICE_PRESETS,
  EDGE_SCRIPT,
} = tts

// 语音那几个"活状态"不 destructure（拿到的是快照），统一走这几个小口子
const ttsActiveEngine = () => tts.activeEngine()
const ttsStopBubbleWatch = () => tts.stopBubbleWatch()
const ttsCacheSpeakAllowed = (allowed) => tts.cacheSpeakAllowed(allowed)


/** 直接给她的页面发一条 control（表情 / 动作 / 道具 / 气泡） */
function petControl(payload) {
  try {
    return fetch(`http://127.0.0.1:${port}/dsh-pet/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

// ── 她的成长回路：经验本 ① 记 → ② 炼 → ③ 影子规矩（2026-10-24 接进新应用）
/**
 * 主人 2026-10-24：「保证这个不会影响她的学习机制 —— 越用越了解我、敢自己决定的机制」。
 * 现状（我查过）：三件套都在（learn.ps1 / learn-digest.mjs / 影子规矩），但**没有任何人自动喂它** ——
 * 经验本里只有示例行、从来没有"提炼"产物。所以这里把回路接上（**不动 她的规矩.txt**）：
 *   ① 记：她在回答里单独写一行 `经验：<一句话结论>` → 主进程自动落进经验本（learn.ps1）
 *   ② 炼：经验本一变就自动跑一次 learn-digest（用 mtime 令牌挡重复，不会天天堆重复条目）
 *   ③ 影子规矩照旧由 learn-digest 维护；**转正仍然只能主人点头**（learn-promote.ps1）
 */
const LEARN_PS = join(INFO_DIR, 'learn.ps1')
const LEARN_DIGEST = join(INFO_DIR, 'learn-digest.mjs')
const LEARN_BOOK = `${DATA_ROOT}/mystery/DSH/她的经验本.txt`
/** 自检 / 假数据时写 out\ 的临时本，绝不写主人的真经验本 */
function learnBookPath() {
  return SELFTEST || MOCK ? join(OUT, '她的经验本.mock.txt') : LEARN_BOOK
}
const LEARN_STATE = join(OUT, 'learn-digest.state.json')

function learnBookMtime() {
  try {
    return Math.round(statSync(learnBookPath()).mtimeMs)
  } catch {
    return 0
  }
}

/** ① 记一条：走 learn.ps1（它自己会建本子、写一行 时间|场景|她做了什么|纠正成什么|结论） */
function learnNote(entry) {
  const e = entry || {}
  const scene = String(e.scene || '对话').slice(0, 20)
  const did = String(e.did || '（她自己在对话里判断的）').slice(0, 200)
  const should = String(e.should || '').slice(0, 200)
  const lesson = String(e.lesson || should || '').slice(0, 300)
  if (!lesson.trim()) return { ok: false, error: '没有结论，不记' }
  if (!existsSync(LEARN_PS)) return { ok: false, error: '找不到 info\\learn.ps1' }
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', LEARN_PS, '-Scene', scene, '-Did', did, '-Should', should || lesson, '-Lesson', lesson,
        '-File', learnBookPath(),
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    const ok = r.status === 0
    log(`经验本 +1（${scene}）：${lesson.slice(0, 40)}${ok ? '' : '（exit=' + r.status + '）'}`)
    return { ok, scene, lesson, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-200) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** ② 炼一遍（经验本没变就跳过；force=true 强制） */
function learnDigest(force) {
  if (!existsSync(LEARN_DIGEST)) return { ok: false, error: '找不到 info\\learn-digest.mjs' }
  const mtime = learnBookMtime()
  const st = readJson(LEARN_STATE) || {}
  if (!force && mtime && Number(st.mtime) === mtime) return { ok: true, skipped: 'unchanged' }
  try {
    // 自检 / 假数据：只读 out\ 里的临时经验本、只往 out\ 写提炼稿（绝不碰主人的数据目录）
    const digestArgs = [LEARN_DIGEST]
    if (SELFTEST || MOCK) digestArgs.push('--file', learnBookPath(), '--out', join(OUT, '经验本-提炼.mock.md'))
    const r = spawnSync(process.execPath, digestArgs, { encoding: 'utf8', timeout: 60000, windowsHide: true, env: childEnv() })
    const ok = r.status === 0
    if (ok) writeJson(LEARN_STATE, { mtime, at: new Date().toISOString().slice(0, 19).replace('T', ' ') })
    log(`经验提炼${ok ? '完成' : '失败（exit=' + r.status + '）'}：${String(r.stdout || '').trim().split(/\r?\n/).slice(-1)[0] || ''}`)
    return { ok, tail: `${r.stdout || ''}${r.stderr || ''}`.slice(-400), mtime }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

/** 她这一轮回答里如果写了 `经验：…`，就记一条（值不值得记由她自己判断——这是她的主动权） */
/** 她说「记住：…」时，把那行追加进 她的记忆.md（2026-10-25 从旧 chat.ps1 搬过来） */
function maybeRememberFromReply(reply) {
  const text = String(reply || '')
  const m = /(?:记住|记牢|记得)[:：]\s*(.{2,120})/.exec(text)
  if (!m) return false
  const line = `- ${m[1].trim()}（${todayKey()}，她自己在对话里记下的）`
  const file = join(DATA_ROOT, 'mystery', 'DSH', '她的记忆.md')
  try {
    let cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (!cur.endsWith('\n')) cur += '\n'
    // 往「主人告诉过我（长期）」那一节末尾塞；找不到就追加到文件尾
    const anchor = '## 主人告诉过我（长期）'
    const at = cur.indexOf(anchor)
    if (at >= 0) {
      const nextSec = cur.indexOf('\n## ', at + anchor.length)
      const insertAt = nextSec >= 0 ? nextSec : cur.length
      cur = cur.slice(0, insertAt) + line + '\n' + cur.slice(insertAt)
    } else {
      cur += line + '\n'
    }
    writeFileSync(file, cur, 'utf8')
    log('她记住了：' + m[1].trim().slice(0, 40))
    return true
  } catch (err) {
    log('写记忆失败：' + ((err && err.message) || err))
    return false
  }
}

function maybeLearnFromReply(reply) {
  const text = String(reply || '')
  const m = /^[ \t]*[#＃@]?(?:经验|记一条经验)[:：][ \t]*(.+)$/m.exec(text)
  if (!m) return null
  const lesson = String(m[1]).trim().replace(/\s+/g, ' ').slice(0, 300)
  if (lesson.length < 4) return null
  /**
   * 2026-10-25（第 9 项「她主动判断该记什么」）：**去重**。
   * 她会自己决定写「经验：…」，但同一句结论说过三遍就会在经验本里堆三行 ——
   * 这里按"指纹"挡：最近 200 行里已经有几乎一样的结论（前 24 字相同）就跳过。
   */
  try {
    const book = learnBookPath()
    if (existsSync(book)) {
      const tail = readFileSync(book, 'utf8').split(/\r?\n/).slice(-200)
      const fp = lesson.slice(0, 24)
      if (tail.some((line) => line.includes(fp))) {
        log('（经验本里已经有这条结论了 → 不重复记）：' + fp)
        return { ok: true, skipped: 'duplicate', lesson }
      }
    }
  } catch {}
  return learnNote({ scene: '对话', did: '（对话中她自己判断的）', should: lesson, lesson })
}

let learnTimer = null
/** 每 6 小时看一眼：经验本变了就炼一遍（不用她/主人操心） */
function startLearnLoop() {
  if (learnTimer) return
  learnTimer = setInterval(() => {
    try {
      learnDigest(false)
    } catch {}
  }, 6 * 3600 * 1000)
  setTimeout(() => {
    try {
      learnDigest(false)
    } catch {}
  }, 45000)
  log('成长回路接上了：她写「经验：…」→ 自动进经验本；经验本一变 → 自动提炼到影子规矩')
}

// ── 每日总结（2026-10-24，主人第 7 个页签：她先写、他再改）─────────────────────
/**
 * 借了同学 Tevela（StudyOS）的「每日总结 + 按天归档」那一页的做法，但数据不吃 localStorage：
 *   存 `<数据核心>\每日总结.jsonl`，一天一行 {date, text, by, at}
 *   by = she（她写的）/ master（主人改过的）
 * 自动写：每天 summary_at（默认 21:30）之后、当天还没有总结 → 让她写（清单+通知+课表都给它看）
 * 手动：总结页的「让她写今天」「我自己改」
 */
const SUMMARY_FILE = `${DATA_ROOT}/_study-core/每日总结.jsonl`
function summaryPath() {
  return SELFTEST || MOCK ? join(OUT, '每日总结.mock.jsonl') : SUMMARY_FILE
}

function readSummaries() {
  const out = new Map()
  try {
    const text = existsSync(summaryPath()) ? readFileSync(summaryPath(), 'utf8') : ''
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj && typeof obj.date === 'string') out.set(obj.date, obj)
    }
  } catch {}
  return out
}

/** 写/改某一天的总结（同一天只留一条，后写的盖前面的） */
function writeSummary(date, text, by) {
  const d = String(date || todayKey())
  const body = String(text || '').trim()
  if (!body) return { ok: false, error: '空的总结不存' }
  const all = readSummaries()
  const rec = { date: d, text: body, by: String(by || 'master'), at: new Date().toISOString().slice(0, 19).replace('T', ' ') }
  all.set(d, rec)
  try {
    mkdirSync(dirname(summaryPath()), { recursive: true })
    const lines = Array.from(all.values())
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-120) // 只留最近 120 天
      .map((x) => JSON.stringify(x))
    writeFileSync(summaryPath(), lines.join('\r\n') + '\r\n', 'utf8')
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  log(`每日总结 ${d} ← ${by}（${body.length} 字）`)
  return { ok: true, item: rec }
}

function loadSummaries() {
  if (MOCK) return MOCK_SUMMARY
  const items = Array.from(readSummaries().values()).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return { ok: true, items, today: todayKey(), mock: MOCK || SELFTEST }
}

/** 假数据（截图/自检）：两条，一条她写的、一条主人改过的 */
const MOCK_SUMMARY = {
  ok: true,
  mock: true,
  today: '2026-10-22',
  items: [
    {
      date: '2026-10-22',
      text: '（假数据）今天把生物实验报告的第 3 章写完了；经济习题 4.2 迟到了，晚上补上。\n物理课讲的是斜面受力，笔记记在 G10 里。\n明天第一件：把数学练习册 P.42 收掉。',
      by: 'she',
      at: '2026-10-22 21:35',
    },
    {
      date: '2026-10-21',
      text: '（假数据·我改过）今天效率一般，主要在补上周的历史 PPT。\n明天第一件：先做数学。',
      by: 'master',
      at: '2026-10-21 22:04',
    },
  ],
}

/** 给她的"今天发生了什么"（给写总结用；只用我们自己已有的数据） */
function summaryContext(dateStr) {
  const d = String(dateStr || todayKey())
  const lines = [`【日期】${d}`]
  try {
    const tasks = (loadTasks() || {}).tasks || []
    const done = tasks.filter((t) => String(t.status) === 'done' && String(t.dueDate || '') === d)
    const openToday = tasks.filter((t) => String(t.status || 'open') !== 'done' && String(t.dueDate || '') === d)
    const created = tasks.filter((t) => String(t.createdAt || '').slice(0, 10) === d)
    if (done.length) lines.push(`【今天做完的】${done.map((t) => t.title).slice(0, 12).join('；')}`)
    if (openToday.length) lines.push(`【今天到期但没做完】${openToday.map((t) => t.title).slice(0, 12).join('；')}`)
    if (created.length) lines.push(`【今天新记下的】${created.map((t) => t.title).slice(0, 12).join('；')}`)
  } catch {}
  try {
    const ag = loadAgenda()
    const day = (ag.days || []).find((x) => x.date === d)
    if (day) {
      const cls = (day.items || []).filter((i) => i && i.label).map((i) => `${i.time || ''} ${i.label}`.trim())
      if (cls.length) lines.push(`【今天的课/安排】${cls.slice(0, 12).join('；')}`)
      if (day.selfStudyRoom) lines.push(`【自习室】${day.selfStudyRoom}`)
      const due = (day.dueTasks || []).map((t) => t.title).filter(Boolean)
      if (due.length) lines.push(`【今天要交的】${due.slice(0, 12).join('；')}`)
    }
  } catch {}
  try {
    const j = readJson(join(OUT, 'notices.json'))
    const list = Array.isArray(j) ? j : Array.isArray(j && j.items) ? j.items : []
    const mine = list.filter((n) => n && String(n.date || '') === d).map((n) => n.text).filter(Boolean)
    if (mine.length) lines.push(`【今天的通知】${mine.slice(0, 8).join('；')}`)
  } catch {}
  try {
    const checked = (readJson(CHECK_FILE) || {})[d]
    if (Array.isArray(checked) && checked.length) lines.push(`【今天勾掉要带的】${checked.slice(0, 10).join('；')}`)
  } catch {}
  return lines.join('\n')
}

/** 让她写某一天的总结（走她自己的脑子） */
async function generateSummary(dateStr) {
  const d = String(dateStr || todayKey())
  const ctxText = summaryContext(d)
  if (MOCK) {
    const rec = writeSummary(
      d,
      `（假数据）今天把 ${d} 的事过了一遍：作业按计划推进，有一件差点忘了交——已经提醒过我了。\n明天先把没做完的那件收尾。`,
      'she',
    )
    return rec.ok ? { ok: true, item: rec.item, mock: true } : rec
  }
  const ask =
    `（帮我写今天的学习总结，用我自己的口气，别用"用户"这种词。）\n\n${ctxText}\n\n` +
    `要求：\n1) 3~6 行，一行为一件事，别写成小作文；\n2) 只写上面出现的东西，不编造；\n3) 最后一行写"明天第一件要做的"；\n4) 不要复述要求、不要标题、不要 Markdown。`
  const inFile = join(OUT, 'her-summary-in.txt')
  try {
    writeFileSync(inFile, ask, 'utf8')
  } catch (err) {
    return { ok: false, error: '写不进临时文件：' + ((err && err.message) || err) }
  }
  const text = await runBrainCollect(inFile, 120000)
  if (!text.trim()) return { ok: false, error: '她没写出来（可能没联网或超时）', context: ctxText }
  const saved = writeSummary(d, text.trim(), 'she')
  return saved.ok ? { ok: true, item: saved.item, context: ctxText } : saved
}

let summaryTimer = null
/** 每天到点（summary_at）之后、当天还没有总结 → 让她写 */
function startSummaryScheduler() {
  if (summaryTimer) return
  summaryTimer = setInterval(() => {
    try {
      const r = readRemindRules()
      if (!r.summaryOn) return
      const now = new Date()
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      if (hm < r.summaryAt) return
      const today = todayKey()
      if (readSummaries().has(today)) return
      log(`到点了（${r.summaryAt}）→ 让她写今天的总结`)
      void generateSummary(today)
    } catch {}
  }, 5 * 60000)
}

// ── 提醒：挪进 main\remind.mjs（2026-10-25 P1-2，逻辑原样；act 名和 her:* 通道没动）
const remind = createRemind({
  log,
  MOCK,
  SELFTEST,
  DATA_ROOT,
  OUT,
  readJson,
  writeJson,
  petControl,
  speakBubble,
  speak,
  loadTasks,
  loadAgenda,
  todayKey,
  get win() {
    return win
  },
})
const {
  remindRulesPath,
  dailyFile,
  planFile,
  remindLedgerPath,
  readRemindRules,
  remindTick,
  readDaily,
  readPlans,
  weeklyFile,
  ymdLocal,
  REMIND_DEFAULTS,
  renderRemindRules,
  ensureRemindRules,
  setRemindRule,
  notifyDesktop,
  ackReminder,
  snoozeReminder,
  startReminders,
  DAILY_WD,
  addDailyReminder,
  setDailyReminder,
  removeDailyReminder,
  weekInfo,
  readWeekly,
  addWeeklyGoal,
  toggleWeeklyGoal,
  removeWeeklyGoal,
  setPlan,
  removePlan,
} = remind


// ── 归档：挪进 main\archive.mjs（2026-10-25 P1-2，逻辑原样）
const archive = createArchive({
  log,
  MOCK,
  SELFTEST,
  INFO_DIR,
  DATA_ROOT,
  existsSync,
  join,
  spawnSync,
  runNode,
  lastJson,
  STUDY_LITE,
})
const { ARCHIVE_FILE, ARCHIVE_TOOL, archiveDoneTasks, startArchiveScheduler } = archive

/**
 * 每天 21:00 自动备份一次（2026-10-25 P2）
 *   以前只有"手动"和"归档动手前"两种备份，机器要是那几天坏了就什么都没有。
 *   做法：每 10 分钟看一眼，命中 21:0x 且今天还没备过 → 跑 `info\备份数据.ps1 -Backup`。
 *   台账 `out\her-backup.state.json` 记最后备份日期（重启也不会一天备好几次）。
 *   自检 / 假数据下一律不动（不碰主人数据）。
 */
const BACKUP_STATE = join(OUT, 'her-backup.state.json')

function backupNow(reason) {
  if (MOCK || SELFTEST) return { ok: false, skipped: 'mock/selftest' }
  const tool = join(INFO_DIR, '备份数据.ps1')
  if (!existsSync(tool)) return { ok: false, error: '找不到 info\\备份数据.ps1' }
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tool, '-Backup'], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    })
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
    const ok = r.status === 0
    log(`备份数据（${reason}）：exit=${r.status}${tail ? ' / ' + tail.slice(0, 120) : ''}`)
    if (ok) writeJson(BACKUP_STATE, { lastBackupDate: todayStr(), at: new Date().toISOString(), reason })
    return { ok, exit: r.status, tail: tail.slice(0, 300), file: BACKUP_STATE }
  } catch (err) {
    log('备份数据出错：' + ((err && err.message) || err))
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function startBackupScheduler() {
  if (MOCK || SELFTEST) return
  const tick = () => {
    try {
      const now = new Date()
      if (now.getHours() !== 21) return
      const state = readJson(BACKUP_STATE) || {}
      if (state.lastBackupDate === todayStr()) return
      backupNow('每天 21:00')
    } catch (err) {
      log('备份调度出错：' + ((err && err.message) || err))
    }
  }
  setInterval(tick, 10 * 60 * 1000)
  const state = readJson(BACKUP_STATE) || {}
  log(
    `备份定时起来了：每天 21:00 备一次（上次 ${state.lastBackupDate || '还没备过'}）` +
      '；想立刻备就点设置页「备份一次数据」',
  )
}




// ── 她自己的打扮：挪进 main\look.mjs（2026-10-25 P1-2，逻辑原样）
const look = createLook({
  log,
  MOCK,
  SELFTEST,
  DATA_ROOT,
  INFO_DIR,
  OUT,
  existsSync,
  readFileSync,
  writeFileSync,
  join,
  spawn,
  petControl,
  readJson,
  writeJson,
  BRAIN,
  speakBubble,
  evalIn: (target, script, timeoutMs) => evalIn(target, script, timeoutMs),
  get win() {
    return win
  },
})
const {
  LOOK_FILE,
  LOOK_GROUPS,
  LOOK_MOODS,
  lookFile,
  todayStr,
  readLookFile,
  todayLook,
  sanitizeLook,
  applyLook,
  fallbackLook,
  readLookMode,
  setLookMode,
  chooseLook,
  askBrainForLook,
  runBrainCollect,
  setLookItem,
} = look

function makeSpeaker() {
  let buf = ''
  return {
    push(delta) {
      buf += String(delta || '')
      // 在标点处切；剩下的短尾巴等下一批或 done 时再念
      let idx = -1
      for (let i = buf.length - 1; i >= 0; i--) {
        if ('。！？!?\n'.includes(buf[i])) {
          idx = i
          break
        }
      }
      if (idx < 0) {
        if (buf.length > 60) {
          speak(buf)
          buf = ''
        }
        return
      }
      const head = buf.slice(0, idx + 1)
      buf = buf.slice(idx + 1)
      const parts = head.split(/[。！？!?\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2)
      for (const s of parts) speak(s)
    },
    flush() {
      const rest = buf.trim()
      buf = ''
      if (rest.length >= 2) speak(rest)
    },
  }
}

// ── 投放区：列出用户丢进来的文件（只读，不改）────────────────────────────────
const DROP_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.docx', '.doc', '.md', '.txt', '.xlsx', '.pptx', '.zip']

function loadDropbox() {
  try {
    mkdirSync(DROP_DIR, { recursive: true })
  } catch {}
  const files = []
  try {
    for (const name of readdirSync(DROP_DIR)) {
      if (name.startsWith('.')) continue
      const full = join(DROP_DIR, name)
      try {
        const st = statSync(full)
        if (!st.isFile()) continue
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
        files.push({
          name,
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' '),
          kind: DROP_EXT.includes(ext) ? ext.slice(1) : 'other',
        })
      } catch {}
    }
  } catch {}
  files.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
  return { ok: true, dir: DROP_DIR, files, total: files.length, mock: MOCK }
}

// ── 设置页要的：配色 / 她的大小 / 诊断 ────────────────────────────────────────
const THEME_PRESETS = ['电光蓝', '暗紫', '青绿', '少女粉']
const SIZE_PRESETS = [
  { h: 260, label: '小' },
  { h: 340, label: '中' },
  { h: 460, label: '大' },
  { h: 580, label: '很大' },
]

/** 现在生效的配色名（页面切换后也要立刻反映，所以缓存一份） */
let currentTheme = ''
function getTheme() {
  if (!currentTheme) currentTheme = readThemeName()
  return currentTheme
}

/** 改配色：走 info\settings-lite.ps1（自带快照 + 只改那一行 + 原子写） */
function setTheme(name) {
  if (!THEME_PRESETS.includes(name)) return { ok: false, error: '不认识的配色：' + name }
  if (MOCK) {
    currentTheme = name
    return { ok: true, theme: name, mock: true }
  }
  if (!existsSync(SETTINGS_LITE)) return { ok: false, error: '找不到 info\\settings-lite.ps1' }
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SETTINGS_LITE, '-Set', '她的限制-形象与互动.txt|主题配色', name],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    )
    const text = `${r.stdout || ''}${r.stderr || ''}`.trim()
    log(`换配色 → ${name}（exit=${r.status}）${text ? '｜' + text.slice(-160) : ''}`)
    currentTheme = name
    return { ok: true, theme: name, detail: text.slice(-300) }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// ── 宿主 ──────────────────────────────────────────────────────────────────────
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

/**
 * 找一个能用的端口。
 * 为什么要：开发版和"打包版"可能同时在跑，它们各自有自己的 out\pet-port.json，
 * 但**默认端口都是 8790** → 后来那个宿主 listen 失败、等 15 秒超时、整个应用起不来（exit=3）。
 * 2026-10-22 在打包版上真踩到了。
 */
async function findFreePort(start = 8790, tries = 12) {
  for (let p = start; p < start + tries; p += 1) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      srv.listen(p, '127.0.0.1')
    })
    if (free) return p
  }
  return start
}

async function ensureHost() {
  const info = readJson(PORT_FILE)
  if (info && Number(info.port) > 0 && (await health(Number(info.port)))) {
    return { port: Number(info.port), started: false, child: null }
  }
  if (!existsSync(SERVE_FILE)) return { port: 0, started: false, child: null }
  const wantPort = await findFreePort(8790)
  let child = null
  try {
    child = spawn(process.execPath, [SERVE_FILE, '--port', String(wantPort)], {
      env: childEnv(),
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
    if (cur && Number(cur.port) > 0 && Number(cur.pid) === child.pid && (await health(Number(cur.port)))) {
      log(`宿主端口 ${cur.port}（默认 8790 被占就往后找）`)
      return { port: Number(cur.port), started: true, child }
    }
  }
  try {
    child.kill()
  } catch {}
  return { port: 0, started: false, child: null }
}

// ── 窗口摆位：挪进 main\windows.mjs（2026-10-25 P1-2，只搬"纯计算"那部分）
const winGeom = createWindows({
  readJson,
  writeJson,
  POS_FILE,
  OUT,
  SELFTEST,
  MOCK,
  VIEW_PAD,
  VIEW_ASPECT,
  get win() {
    return win
  },
  get panelWin() {
    return panelWin
  },
  log,
  ARGV,
  TOPMOST,
  MODEL_H,
  INFO_DIR,
  STATE_FILE,
  HOOK_FILE,
  PRELOAD_FILE,
  STUDY_LITE,
  currentModelH,
  readThemeName,
  host,
  chatKillTurn,
  sleep,
  spawn,
  cardAlpha,
  chooseLook,
  existsSync,
  lastJson,
  runNode,
})
const {
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
} = winGeom


// ── 窗口 / 托盘 / 浮窗：整段挪进 main\windows.mjs（2026-10-25 P2④，逻辑原样）
//    状态（win / panelWin / port / panelShown …）也在那边 export，这里是活绑定
// ── 自检 ──────────────────────────────────────────────────────────────────────
/**
 * 自检（2026-10-23 重写：现在是两个窗口）
 *   ① 形象窗：她在、尺寸对、**命中判定能自愈**（这条是修"有时点不到"的证据）
 *   ② 浮窗：独立一个窗口、能开能关、位置/大小记得住、关掉以后她还在
 *   ③ 页面自己的断言（页签、六个页面、设置页里的工具和打扮…）
 *   ④ 截图（形象 + 浮窗）留给看图复核；假数据，绝不送真实内容出去
 */
async function selfTest() {
  const lines = []
  const say = (m) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`
    lines.push(line)
    console.log(line)
    try {
      writeFileSync(SELFTEST_LOG, `==== 她的桌面应用自检（${new Date().toISOString()}）====\r\n${lines.join('\r\n')}\r\n`, 'utf8')
    } catch {}
  }
  let fails = 0
  const check = (name, ok, extra = '') => {
    if (!ok) fails += 1
    say(`${ok ? '✅' : '❌'} ${name}${extra ? '　' + extra : ''}`)
  }
  /**
   * 快速档专用（2026-10-25 P2）：这些"真跑脚本"的块在默认档跳过。
   * 但**断言条数不变**（记成"跳过=通过"，报告里看得见）—— 这样 176 这个数在两档都一样，
   * 也不会出现"跳过就当没这回事"的自欺。
   */
  const skipSlow = (names) => {
    for (const n of names) check(n, true, '跳过（完整档用 --selftest-slow）')
  }
  const shoot = async (target, file, label) => {
    try {
      const img = await Promise.race([
        target.webContents.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage 超时')), 15000)),
      ])
      writeFileSync(join(OUT, file), img.toPNG())
      say(`截图（${label}）：out\\${file}`)
      return img
    } catch (err) {
      say(`截图（${label}）失败：` + (err && err.message))
      return null
    }
  }
  /** 主进程直接问页面"这一点算点在她身上吗"，再回读"现在是不是在点穿透" */
  const probeAt = async (x, y) => {
    if (!win || win.isDestroyed()) return null
    try {
      win.webContents.send('her:probe', { x: Math.round(x), y: Math.round(y) })
    } catch {}
    await sleep(360)
    return ignoring
  }

  try {
    say('自检开始（两个窗口都开在屏幕外，假数据=' + MOCK + '，' + (SELFTEST_SLOW ? '完整档：连真跑脚本的重块一起验' : '快速档：真跑脚本的重块跳过，用 --selftest-slow 跑完整档') + '）')
    // 两个 .mock 存档都从干净状态起（不然上一轮留下的东西会让断言白捡通过）
    try {
      writeJson(PANEL_MOCK_FILE, {})
      writeJson(join(OUT, 'her-look.mock.json'), {})
      writeJson(remindLedgerPath(), {})
      // 提醒规则也从默认起（上一轮可能被改成别的值）
      writeFileSync(remindRulesPath(), renderRemindRules(REMIND_DEFAULTS), 'utf8')
      // 批次 1（2026-10-24）的三个新文件也从头起 —— 自检只碰 out\*.mock.*，绝不写主人的数据目录
      writeJson(dailyFile(), { version: 1, items: [] })
      writeJson(planFile(), { version: 1, items: [] })
      // 每周计划：塞一个"上一周"，用来验「按周归档」——旧目标换周以后还在文件里
      const wiNow = weekInfo(new Date())
      const lastMon = new Date(new Date(`${wiNow.start}T00:00:00`).getTime() - 7 * 86400000)
      const lastKey = ymdLocal(lastMon)
      writeJson(weeklyFile(), {
        version: 1,
        weeks: {
          [lastKey]: {
            start: lastKey,
            end: ymdLocal(new Date(lastMon.getTime() + 6 * 86400000)),
            goals: [{ id: 'g-past-self', text: '上一周：把化学实验报告写完', done: true, createdAt: new Date().toISOString() }],
          },
        },
      })
    } catch {}
    await createHerWindow()

    // ① 形象窗
    let st = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      await sleep(500)
      st = await evalJson('JSON.stringify(window.herApp ? { ready: !!window.herApp.ready, mode: window.herApp.mode } : null)')
      if (st && st.ready) break
    }
    check('形象窗 ready', !!(st && st.ready), st ? `mode=${st.mode}` : '拿不到 herApp')
    check('形象窗就是"只有她"（页面知道自己是谁）', !!(st && st.mode === 'her'), st && st.mode)

    let view = null
    const viewDeadline = Date.now() + 20000
    while (Date.now() < viewDeadline) {
      view = await evalJson(
        'JSON.stringify({ view: (window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null, err: window.__DSHPetError || null, root: (function(){var e=document.getElementById("dsh-live2d-pet");if(!e)return null;var r=e.getBoundingClientRect();return {left:Math.round(r.left),top:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}})() })',
      )
      if (view && view.view) break
      await sleep(400)
    }
    check('她在（模型载入）', !!(view && view.view), view && view.view ? `${Math.round(view.view.w)}×${Math.round(view.view.h)}` : '等了 20 秒还没 view')
    const expectH = Math.round(currentModelH * 0.9)
    check(
      '她的大小按存档来',
      !!(view && view.view && Math.abs(view.view.h - expectH) <= 60),
      view && view.view ? `高 ${Math.round(view.view.h)}（期望约 ${expectH}）` : 'null',
    )
    const wb = win.getBounds()
    check('形象窗很紧凑（只装她）', wb.width <= Math.max(320, Math.round((view && view.view ? view.view.w : 400)) + 80), `${wb.width}×${wb.height}（她 ${view && view.root ? view.root.w : '?'} 宽）`)

    // 命中自愈：问她中心 → 应该"能吃鼠标"；问她左上角 → 应该"点穿透"
    const root = (view && view.root) || null
    if (root) {
      const hitCenter = await probeAt(root.left + root.w / 2, root.top + root.h / 2)
      check('问她身上一点 → 窗口解除点击穿透（能点到了）', hitCenter === false, `ignoring=${hitCenter}`)
      const hitCorner = await probeAt(2, 2)
      check('问她窗口角落 → 又回到点击穿透（点空气会穿过去）', hitCorner === true, `ignoring=${hitCorner}`)
      check('命中判定能自愈（不靠鼠标事件也该有结论）', hitCenter === false && hitCorner === true)
    } else {
      check('命中自愈测试', false, '拿不到她的矩形')
    }

    // 形象窗的页面自检
    const herReport = await evalJson('window.herApp.selftest().then((r) => JSON.stringify(r))', 30000)
    if (herReport && Array.isArray(herReport.checks)) {
      for (const c of herReport.checks) check(c.name, !!c.ok, c.detail || '')
    } else {
      check('形象窗页面自检报告', false, '拿不到 herApp.selftest() 的结果')
    }

    // 右键形象 → 菜单（第 9 条：主人说"只有右键任务栏图标才有用"）
    // 真派发一次 contextmenu：以前 pet.js 会把它 preventDefault + stopPropagation 掉，
    // 害得 inject.js 看见 defaultPrevented 就跳过 → 右键她什么都不发生。
    try {
      const before = menuPopCount
      const fired = await evalJson(
        '(function(){var el=document.getElementById("dsh-live2d-pet")||document.body;' +
          'var r=(document.getElementById("dsh-live2d-pet")||document.body).getBoundingClientRect();' +
          'var ev=new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:Math.round(r.left+r.width/2),clientY:Math.round(r.top+r.height/2)});' +
          'el.dispatchEvent(ev);return JSON.stringify({prevented:ev.defaultPrevented})})()',
        15000,
      )
      await sleep(700)
      const picked = await evalJson(
        'JSON.stringify({ visible: !!(window.herApp && window.herApp.pickVisible), n: document.querySelectorAll("#her-pick .her-pick-btn").length })',
        15000,
      )
      check(
        '右键形象能打开那条选项条（选择栏）',
        menuPopCount > before && !!(picked && picked.visible) && (picked.n || 0) >= 6,
        `菜单请求 ${before} → ${menuPopCount}；选项条 ${picked ? (picked.visible ? '露出来了' : '没露') + ' / ' + picked.n + ' 个按钮' : '问不到'}${fired && fired.prevented ? '（pet.js 依然 preventDefault，但不影响我们）' : ''}`,
      )
      // 露出来的样子拍一张（给看图复核：窄带、在她脚下、没挡住脸）
      await shoot(win, 'her-app-shot-pickbar.png', '形象窗（右键 → 选项条）')
      // 点一下选项条上的「设置」→ 浮窗应该开在设置页
      const clicked = await evalJson(
        '(function(){var bs=document.querySelectorAll("#her-pick .her-pick-btn");for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf("设置")>=0){bs[i].click();return JSON.stringify({ok:true,label:bs[i].textContent})}}return JSON.stringify({ok:false})})()',
        15000,
      )
      await sleep(1600)
      const panelPageNow = await evalIn(panelWin, 'JSON.stringify({current: window.herApp.current, open: window.herApp.cardOpen})', 15000)
      check(
        '点选项条上的「设置」→ 浮窗开到设置页',
        !!(clicked && clicked.ok && panelPageNow && panelPageNow.current === 'settings'),
        `点了 ${clicked && clicked.label}；浮窗当前页 = ${panelPageNow && panelPageNow.current}`,
      )
    } catch (err) {
      check('右键形象能打开菜单（选择栏那条路是通的）', false, (err && err.message) || String(err))
    }

    // 它说话时要有气泡（形象窗的截图也给看图复核）
    await fetch(`http://127.0.0.1:${port}/dsh-pet/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        say: '这一句是故意长一点的气泡，用来量她的对话气泡在窗口里到底被截掉多少。第二行、第三行都写满，看看会不会超出窗口。',
        mood: 'happy',
        bubbleMs: 60000,
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
    await sleep(1200)
    const geo = await evalJson(
      'JSON.stringify({' +
        'vh: window.innerHeight, vw: window.innerWidth,' +
        'root: (function(){var e=document.getElementById("dsh-live2d-pet");if(!e)return null;var r=e.getBoundingClientRect();return {top:Math.round(r.top),h:Math.round(r.height)}})(),' +
        'bubbles: Array.from(document.querySelectorAll("[class*=bubble]")).map(function(e){var r=e.getBoundingClientRect();return {cls:String(e.className),left:Math.round(r.left),right:Math.round(r.right),top:Math.round(r.top),bottom:Math.round(r.bottom),h:Math.round(r.height),vis:getComputedStyle(e).visibility}})' +
        '})',
    )
    say('几何（形象窗）：' + JSON.stringify(geo))
    const bub = geo && Array.isArray(geo.bubbles) ? geo.bubbles[0] : null
    if (bub && bub.h > 4) {
      const insideV = bub.top >= -2 && bub.bottom <= geo.vh + 2
      const insideH = bub.left >= -2 && bub.right <= geo.vw + 2
      check('气泡完整在窗口里（上下没被切）', insideV, `气泡 y ${bub.top}~${bub.bottom} / 窗口高 ${geo.vh}`)
      check('气泡完整在窗口里（左右没被切）', insideH, `气泡 x ${bub.left}~${bub.right} / 窗口宽 ${geo.vw}（${bub.cls}）`)
    } else {
      check('她说话时有气泡（DOM 在）', !!(geo && Array.isArray(geo.bubbles) && geo.bubbles.length > 0), geo ? `bubble 类元素 ${(geo.bubbles || []).length} 个` : '问不到')
    }
    await shoot(win, 'her-app-shot-her.png', '形象窗（带气泡）')

    // ② 浮窗（独立窗口）
    const opened = await showPanel('calendar')
    check('浮窗能开（独立窗口）', !!(opened && opened.ok && panelWin && !panelWin.isDestroyed()), opened ? `created=${opened.created}` : '没开成')
    let pst = null
    const pDeadline = Date.now() + 30000
    while (Date.now() < pDeadline) {
      await sleep(400)
      pst = await evalIn(panelWin, 'JSON.stringify(window.herApp ? { ready: !!window.herApp.ready, mode: window.herApp.mode, tabs: (window.herApp.tabs || []).length } : null)')
      if (pst && pst.ready) break
    }
    check('浮窗 ready（它自己那一份页面）', !!(pst && pst.ready), pst ? `mode=${pst.mode} / 页签 ${pst.tabs}` : '拿不到 herApp')
    check('浮窗窗口是可见的', !!(panelWin && panelWin.isVisible()))
    const pb = panelWin.getBounds()
    const hb = win.getBounds()
    const overlap =
      Math.min(pb.x + pb.width, hb.x + hb.width) - Math.max(pb.x, hb.x) > 0 &&
      Math.min(pb.y + pb.height, hb.y + hb.height) - Math.max(pb.y, hb.y) > 0
    check('浮窗和形象窗是两个窗口（能各自摆）', !!(panelWin.getMediaSourceId ? true : true) && pb.width !== hb.width, `浮窗 ${pb.width}×${pb.height} / 形象 ${hb.width}×${hb.height}`)
    say('两个窗口的位置：浮窗 ' + JSON.stringify({ x: pb.x, y: pb.y }) + ' 形象 ' + JSON.stringify({ x: hb.x, y: hb.y }) + (overlap ? '（有重叠，正常）' : '（没重叠）'))

    // 浮窗的位置记得住（拖了以后写盘 + 回读）
    panelWin.setBounds({ x: pb.x + 60, y: pb.y + 40, width: pb.width, height: pb.height })
    await sleep(1400)
    const savedPanel = readJson(panelFile())
    const movedOk = !!savedPanel && Number(savedPanel.left) === pb.x + 60 && Number(savedPanel.top) === pb.y + 40
    if (movedOk) {
      check('浮窗位置写进存档了（out\\her-app.panel*.json）', true, `存的是 ${savedPanel.left},${savedPanel.top}`)
    } else {
      // 屏幕外的窗口不一定会收到系统 'moved'（自检把窗口放在 -3200），那就直接验写盘那一段
      savePanelBox()
      const forced = readJson(panelFile())
      check(
        '浮窗位置写盘函数可用（系统 moved 事件在屏幕外可能不来）',
        !!forced && Number.isFinite(Number(forced.left)) && Number.isFinite(Number(forced.top)),
        forced ? `手动存了 ${forced.left},${forced.top}（系统事件没来）` : '连手动都没写进去',
      )
    }

    // 收起浮窗：她还在
    hidePanelNow()
    await sleep(900)
    const hiddenNow = !panelShown
    check('浮窗能单独收起', !!(panelWin && !panelWin.isDestroyed()) && hiddenNow, `panelShown=${panelShown} / isVisible=${panelWin && !panelWin.isDestroyed() ? panelWin.isVisible() : 'n/a'}`)
    check('收起浮窗以后她还在（形象窗没动）', !!(win && !win.isDestroyed() && win.isVisible()), `形象窗可见=${win.isVisible()}`)
    const again = await showPanel('today')
    await sleep(900)
    check('浮窗能再打开', !!(again && again.ok && panelShown), `panelShown=${panelShown}`)

    // 浮窗重新定位（主人 2026-10-24 深夜：「关闭后不会重新定位……我差点没找到」）
    try {
      hidePanelNow()
      await sleep(300)
      writeJson(panelFile(), { left: 99999, top: 99999, width: 470, height: 660 })
      if (panelWin && !panelWin.isDestroyed()) panelWin.destroy()
      setPanelWin(null)
      await sleep(300)
      const reopened = await showPanel('today')
      await sleep(1200)
      // ⚠️ 自检里 createPanelWindow 会把窗口故意挪到 (-3200,-2000)（看不见的地方），
      //    所以再 showPanel 一次 —— 走的是"窗口已存在 → 露出来之前夹回屏幕"那条路（就是修的那个 bug）
      await showPanel('today')
      await sleep(900)
      const fitTest = await evalIn(panelWin, 'window.herShell.act("panel-fit-test", "").then((r) => JSON.stringify(r))', 20000)
      const b2 = panelWin && !panelWin.isDestroyed() ? panelWin.getBounds() : null
      const areas = screen.getAllDisplays().map((d) => d.workArea)
      // 容差跟 fitPanelBox 自己的判定一致（8px）：主人手拖过的位置**故意不动**，
      // 所以存档里 left=-13 这种"中心还在屏幕上"的位置是被允许的 ——
      // 以前这里只给 2px，偶发会红（Windows 还会把窗口再挪几像素）。
      const TOL = 10
      const inside =
        !!b2 &&
        areas.some(
          (a) =>
            b2.x >= a.x - TOL &&
            b2.y >= a.y - TOL &&
            b2.x + b2.width <= a.x + a.width + TOL &&
            b2.y + b2.height <= a.y + a.height + TOL,
        )
      check(
        '浮窗存档在屏幕外时，算出来的位置在屏幕里',
        !!(fitTest && fitTest.inside === true),
        fitTest ? `存的 (99999,99999) → 算出 (${fitTest.fit.x},${fitTest.fit.y})` : '问不到',
      )
      check('真窗口也被摆回屏幕里（不是只算了个数字）', inside, b2 ? `实际 (${b2.x},${b2.y}) ${b2.width}×${b2.height}` : '拿不到窗口')
    } catch (err) {
      check('浮窗重新定位', false, (err && err.message) || String(err))
    }

    // 装扮「她自主 / 你选择」（主人 2026-10-24 深夜）
    try {
      const m1 = await evalIn(panelWin, 'window.herShell.act("look-mode", {mode:"master"}).then((r) => JSON.stringify(r))', 20000)
      const s1 = await evalIn(panelWin, 'window.herShell.data("settings").then((d) => JSON.stringify(d))', 25000)
      check('装扮能切到「你选择」', !!(m1 && m1.ok && m1.mode === 'master' && s1 && s1.lookMode === 'master'), `lookMode=${s1 && s1.lookMode}`)
      const daily = await evalIn(panelWin, 'window.herShell.act("look-daily", "").then((r) => JSON.stringify(r))', 40000)
      check(
        '「你选择」模式下她不会自己换一身',
        !!(daily && daily.skipped === 'master-mode'),
        daily ? `skipped=${daily.skipped || '（没跳过）'} / mode=${daily.mode}` : '问不到',
      )
      const back = await evalIn(panelWin, 'window.herShell.act("look-mode", {mode:"she"}).then((r) => JSON.stringify(r))', 20000)
      check('能切回「她自主」', !!(back && back.ok && back.mode === 'she'), `mode=${back && back.mode}`)
    } catch (err) {
      check('装扮模式（她自主 / 你选择）', false, (err && err.message) || String(err))
    }

    // 方括号 = 控制模型 / 小括号 = 给人看（2026-10-25 主人定的口径）
    try {
      const bt = await evalIn(panelWin, 'window.herShell.act("bracket-test", "").then((r) => JSON.stringify(r))', 20000)
      const ctl = bt && Array.isArray(bt.controls) ? bt.controls : []
      check(
        '方括号里的控制被剥掉了（不显示、不念）',
        !!(bt && bt.text && !/表情：脸红/.test(bt.text) && /她把笔放下/.test(bt.text)),
        bt ? String(bt.text).slice(0, 40) : '问不到',
      )
      check(
        '控制指令被认出来了（表情：脸红）',
        ctl.some((c) => c.kind === '表情' && c.value === '脸红'),
        JSON.stringify(ctl),
      )
      check(
        '普通方括号不被吃掉（[备注] 原样留着）',
        !!(bt && /\[备注\]/.test(String(bt.text))),
        bt ? String(bt.text).slice(-16) : '问不到',
      )
    } catch (err) {
      check('方括号 = 控制模型（第 4 条）', false, (err && err.message) || String(err))
    }

    // ③ 浮窗页面的断言（页签 / 六个页面 / 设置页里的工具和打扮）
    const panelReport = await evalIn(panelWin, 'window.herApp.selftest().then((r) => JSON.stringify(r))', 120000)
    if (panelReport && Array.isArray(panelReport.checks)) {
      for (const c of panelReport.checks) check(c.name, !!c.ok, c.detail || '')
    } else {
      check('浮窗页面自检报告', false, '拿不到 herApp.selftest() 的结果')
    }

    // 她自己的打扮（第 7 条）：主人替她改一组 → 立刻写盘 + 回读
    const lookSet = await evalIn(
      panelWin,
      'window.herShell.act("look-set", {group:"hair", key:"ponytail"}).then((r) => JSON.stringify(r))',
      20000,
    )
    check('能改她的打扮（发型）', !!(lookSet && lookSet.ok), lookSet ? JSON.stringify(lookSet.look && lookSet.look.look) : '失败了')
    const settingsData = await evalIn(panelWin, 'window.herShell.data("settings").then((d) => JSON.stringify(d))', 25000)
    check(
      '打扮写进她的打扮.json（今天这一身）',
      !!(settingsData && settingsData.look && settingsData.look.look && settingsData.look.look.hair === 'ponytail'),
      settingsData && settingsData.look ? `${settingsData.look.date} / ${settingsData.look.by}` : '没有',
    )
    check(
      '设置页里带着打扮白名单',
      !!(settingsData && Array.isArray(settingsData.lookGroups) && settingsData.lookGroups.length >= 5),
      settingsData && Array.isArray(settingsData.lookGroups) ? `${settingsData.lookGroups.length} 组` : '没有',
    )
    // 嗓子（2026-10-24 主人：「语音换成 edge 的」）：配置读得到 + Edge 那个脚本在
    {
      const vcfg = readVoiceConfig()
      check(
        '语音用 Edge（更自然），脚本和配置都在',
        vcfg.engine === 'edge' && existsSync(EDGE_SCRIPT) && vcfg.voice.length > 0,
        `${vcfg.engine} / ${vcfg.voice} / ${existsSync(EDGE_SCRIPT) ? 'edge_serve.py 在' : '缺 edge_serve.py'}`,
      )
      check(
        '设置页把嗓子带出来了（能切回本地 piper）',
        !!(settingsData && settingsData.voice && settingsData.voice.engine === 'edge' && Array.isArray(settingsData.voicePresets) && settingsData.voicePresets.length >= 2),
        settingsData && settingsData.voice ? `${settingsData.voice.engine} / ${settingsData.voice.voice}（${(settingsData.voicePresets || []).length} 个音色）` : '没有',
      )
      // 语言开关（2026-10-25 P2）：能切、能读回、设置页真有那三个按钮
      try {
        const back0 = setLangMode('follow')
        const zh = setLangMode('zh')
        const readZh = readLangMode()
        // 设置页得先真的停在"设置"这一页，才问得到那几个按钮
        await evalIn(panelWin, 'window.herApp.openTab("settings").then(() => 1)', 15000)
        await sleep(800)
        const pageHasLang = await evalIn(
          panelWin,
          'JSON.stringify({ chip: !!document.getElementById("her-lang-row"), modes: Array.from(document.querySelectorAll("#her-lang-row .her-chip")).map((b) => b.dataset.lang) })',
          15000,
        )
        const settingsNow = await evalIn(panelWin, 'window.herShell.data("settings").then((d) => JSON.stringify({ lang: d && d.lang, pack: d && d.modelPack && d.modelPack.name }))', 20000)
        const restored = setLangMode('follow')
        check(
          '语言开关能切（中文 → 读回来是中文，切回跟着主人走）',
          !!(back0 && back0.ok && zh && zh.ok && readZh === 'zh' && restored && restored.mode === 'follow'),
          `写 zh → 读回 ${readZh} → 复位 ${restored && restored.mode}`,
        )
        check(
          '设置页有「语言」三个按钮（跟主人走 / 中文 / 英文），设置数据也带着当前值',
          !!(
            pageHasLang &&
            pageHasLang.chip &&
            (pageHasLang.modes || []).join(',') === 'follow,zh,en' &&
            settingsNow &&
            ['follow', 'zh', 'en'].includes(String(settingsNow.lang))
          ),
          pageHasLang ? `${(pageHasLang.modes || []).join('/')} ｜ data.lang=${settingsNow && settingsNow.lang}` : '问不到页面',
        )
        check(
          '设置页知道现在挂的是哪个形象包',
          !!(settingsNow && settingsNow.pack),
          settingsNow && settingsNow.pack ? String(settingsNow.pack) : '没有',
        )
      } catch (err) {
        check('语言开关 / 形象包（P2）', false, (err && err.message) || String(err))
      }
      // 2026-10-25 第 8 项：待机动作（选中 → 写盘 → 她那边真换掉动作组；乱名字要拒）
      try {
        const motions = readModelMotions()
        const pickMe = motions.find((m) => m !== 'idle') || motions[0] || ''
        const setOk = pickMe ? await evalIn(panelWin, `window.herShell.act('set-idle', ${JSON.stringify(pickMe)}).then((r) => JSON.stringify(r))`, 20000) : null
        await sleep(500)
        const nowOnPage = await evalIn(win, 'JSON.stringify(window.DSHPet.idleMotion())', 12000)
        const bad = pickMe
          ? await evalIn(panelWin, "window.herShell.act('set-idle', '../../evil').then((r) => JSON.stringify(r))", 12000)
          : null
        const back = await evalIn(panelWin, "window.herShell.act('set-idle', '').then((r) => JSON.stringify(r))", 12000)
        check(
          '待机动作能设（写盘 + 她那边真的换掉了动作组）',
          !!(setOk && setOk.ok !== false && nowOnPage && pickMe && (nowOnPage.now === pickMe || (nowOnPage.motions || []).includes(pickMe))),
          setOk ? `设成 ${pickMe} → 页面报 now=${nowOnPage && nowOnPage.now}` : '没设成',
        )
        check(
          '待机动作会挡非法名字（越界路径一律拒）',
          !!(bad && bad.ok === false),
          bad ? `'../../evil' → ${bad.ok === false ? '被拒' : '居然通过了！'}` : '没测到',
        )
        if (back) check('待机动作能恢复默认', back.ok !== false, `恢复 → ${back.ok !== false ? 'ok' : '失败'}`)
      } catch (err) {
        check('待机动作（第 8 项）', false, (err && err.message) || String(err))
      }
      // 2026-10-25 第 7 项：形象包真切换（拷包 → 备份 → 重载；越界/假包要拒）
      try {
        const packs = readModelPacks()
        const target = packs[0] ? packs[0].name : ''
        const before = readModelPack()
        const swapped = target
          ? await evalIn(panelWin, `window.herShell.act('set-model-pack', { name: ${JSON.stringify(target)} }).then((r) => JSON.stringify(r))`, 60000)
          : null
        await sleep(1500)
        const bad1 = await evalIn(panelWin, "window.herShell.act('set-model-pack', { path: 'not-absolute' }).then((r) => JSON.stringify(r))", 12000)
        const bad2 = await evalIn(panelWin, "window.herShell.act('set-model-pack', { name: '不存在的包' }).then((r) => JSON.stringify(r))", 12000)
        check(
          '形象包能真切（拷进 assets\\model\\ + 备份旧的 + 重载形象窗）',
          !!(swapped && swapped.ok !== false && swapped.model && swapped.backup),
          swapped
            ? `切到 ${swapped.name}（${swapped.model}），旧包备份成 ${swapped.backup}`
            : `没有可选包（model-packs 是空的；现在是 ${before && before.name}）`,
        )
        check(
          '形象包会挡非法输入（相对路径 / 不存在的包）',
          !!(bad1 && bad1.ok === false && bad2 && bad2.ok === false),
          `相对路径 → ${bad1 && bad1.ok === false ? '拒' : '过'}；不存在的包 → ${bad2 && bad2.ok === false ? '拒' : '过'}`,
        )
        if (target) {
          await evalIn(panelWin, `window.herShell.act('set-model-pack', { name: ${JSON.stringify(target)} }).then((r) => JSON.stringify(r))`, 60000)
        }
      } catch (err) {
        check('形象包真切换（第 7 项）', false, (err && err.message) || String(err))
      }
    }
    // 打扮不只是写了个文件：**真的戴到她身上**（读 pet.js 的 userProps）
    try {
      await petControl({ clearProps: true, props: { ponytail: true, glassesSquare: true } })
      await sleep(700)
      const props = await evalJson(
        'JSON.stringify((window.DSHPet && window.DSHPet.menu && window.DSHPet.menu().userProps) || [])',
        15000,
      )
      check(
        '她挑的这一身真戴到模型上了（pet.js 的 props 生效）',
        Array.isArray(props) && props.includes('单边马尾') && props.includes('方眼镜'),
        Array.isArray(props) ? props.join(' / ') || '（空）' : '问不到',
      )
    } catch (err) {
      check('她挑的这一身真戴到模型上了（pet.js 的 props 生效）', false, (err && err.message) || String(err))
    }

    // 截图：待办列表（每条一个框）+ 错题详情浮层（主人 2026-10-24 要的"点进去看更详细"）
    await evalIn(panelWin, 'window.herApp.openTab("tasks").then(() => JSON.stringify({ok:true}))', 20000)
    await sleep(900)
    await shoot(panelWin, 'her-app-shot-tasks.png', '浮窗（待办：每条一个框）')
    await evalIn(panelWin, 'window.herApp.openTab("mistakes").then(() => JSON.stringify({ok:true}))', 20000)
    await sleep(900)
    // 错题趋势（2026-10-24 晚：主人说总结栏太乱 → 三张表）先拍一张，再拍点开详情那张
    await shoot(panelWin, 'her-app-shot-trend.png', '浮窗（错题：趋势表格）')
    // 「＋新增」表单也拍一张（批次 2.2b：表单 + 她出草稿你确认）
    try {
      const opened = await evalIn(
        panelWin,
        'JSON.stringify((function(){var b=document.getElementById("her-mistake-add");if(!b)return{ok:false};b.click();return{ok:!!document.getElementById("her-mk-question")}})())',
        15000,
      )
      await sleep(500)
      await shoot(panelWin, 'her-app-shot-mk-add.png', '浮窗（错题：＋新增表单）')
      await evalIn(panelWin, 'JSON.stringify((function(){var b=document.querySelector(".her-sheet-back");if(b)b.click();return{ok:true}})())', 15000)
      await sleep(300)
      say('错题＋新增表单：' + JSON.stringify(opened))
    } catch (err) {
      say('错题表单截图失败：' + ((err && err.message) || err))
    }
    // 对话主题（第 12 条）那张
    try {
      await evalIn(panelWin, 'window.herApp.openTab("chat").then(() => JSON.stringify({ok:true}))', 20000)
      await sleep(700)
      await shoot(panelWin, 'her-app-shot-chat-topics.png', '浮窗（对话：主题切换）')
      await evalIn(panelWin, 'window.herApp.openTab("mistakes").then(() => JSON.stringify({ok:true}))', 20000)
      await sleep(500)
    } catch (err) {
      say('对话主题截图失败：' + ((err && err.message) || err))
    }
    const openedSheet = await evalIn(
      panelWin,
      'JSON.stringify((function(){var it=document.querySelector(".her-item-mk");if(!it)return{ok:false};it.click();return{ok:!!document.getElementById("her-sheet")}})())',
      15000,
    )
    check('浮窗截图前：错题详情浮层打开了', !!(openedSheet && openedSheet.ok), openedSheet ? 'ok' : '没开')
    await sleep(500)
    await shoot(panelWin, 'her-app-shot-sheet.png', '浮窗（错题详情浮层）')
    await evalIn(panelWin, 'JSON.stringify((function(){var b=document.querySelector(".her-sheet-back");if(b)b.click();return{ok:true}})())', 15000)
    await sleep(300)

    // 截图：日历那页 / 设置那页（设置页就是"右键菜单搬进来的家"）
    await evalIn(panelWin, 'window.herApp.openTab("calendar").then(() => JSON.stringify({ok:true}))', 20000)
    await sleep(900)
    await shoot(panelWin, 'her-app-shot-panel.png', '浮窗（日历）')
    await evalIn(panelWin, 'window.herApp.openTab("settings").then(() => JSON.stringify({ok:true}))', 20000)
    await sleep(900)
    await shoot(panelWin, 'her-app-shot-settings.png', '浮窗（设置：打扮 + 工具）')
    // 批次 1（2026-10-24）新加的三块在设置页下半截：滚过去再拍一张，给看图复核用
    try {
      const scrolled = await evalIn(
        panelWin,
        'JSON.stringify((function(){var b=document.getElementById("her-card-body");if(!b)return{ok:false};' +
          'var hs=Array.from(b.querySelectorAll(".her-group-h"));' +
          'var t=hs.filter(function(e){return /每日提醒/.test(e.textContent)})[0];' +
          'if(!t)return{ok:false,heads:hs.map(function(e){return e.textContent.slice(0,8)})};' +
          'b.scrollTop = b.scrollTop + (t.getBoundingClientRect().top - b.getBoundingClientRect().top) - 6;' +
          'return{ok:true,scrollTop:Math.round(b.scrollTop)}})())',
        15000,
      )
      await sleep(600)
      await shoot(panelWin, 'her-app-shot-daily.png', '浮窗（设置：每日提醒 / 学科计划 / 嗓子）')
      say('设置页滚到「每日提醒」那块：' + JSON.stringify(scrolled))
    } catch (err) {
      say('设置页滚动截图失败：' + ((err && err.message) || err))
    }

    // ▸「浮窗还有一定模糊边框」（主人 2026-10-23）：**量出来**，别凭嘴说
    //   做法：抓一张浮窗的位图，横着扫中间那一行，数"半透明过渡"有几列。
    //   圆角抗锯齿最多 1~3 列；成片的渐变（几十列）才是真的外发光/模糊边。
    try {
      const imgPanel = await Promise.race([
        panelWin.webContents.capturePage(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage 超时')), 15000)),
      ])
      const bmp = imgPanel.toBitmap()
      const size = imgPanel.getSize()
      const row = Math.floor(size.height / 2)
      let partial = 0
      let lastOpaque = -1
      for (let x = 0; x < size.width; x += 1) {
        const a = bmp[(row * size.width + x) * 4 + 3]
        if (a > 240) lastOpaque = x
      }
      for (let x = lastOpaque + 1; x < size.width; x += 1) {
        const a = bmp[(row * size.width + x) * 4 + 3]
        if (a > 8 && a <= 240) partial += 1
      }
      check('浮窗右边缘没有模糊过渡（半透明像素 ≤3 列）', partial <= 3, `右边缘半透明过渡 ${partial} 列（图像 ${size.width}×${size.height}）`)
    } catch (err) {
      check('浮窗右边缘没有模糊过渡（半透明像素 ≤3 列）', false, (err && err.message) || String(err))
    }

    // ── 主动提醒（第 8 条）：会提醒 / 不重复 / 上课不弹 ─────────────────────────
    try {
      // 干净台账：不然上一轮留下的指纹会让"会提醒"这条白捡通过
      writeJson(remindLedgerPath(), {})
      const sim = await evalIn(panelWin, 'window.herShell.act("remind-simulate", {inMinutes: 25, inClass: false}).then((r) => JSON.stringify(r))', 30000)
      check(
        '提前 25 分钟 → 会提醒（第 8 条）',
        !!(sim && sim.ok && sim.first && sim.first.fired === 1),
        sim && sim.first ? `第 1 次发出 ${sim.first.fired} 条` : '模拟失败',
      )
      check(
        '同一条不重复提醒（去重台账）',
        !!(sim && sim.second && sim.second.fired === 0),
        sim && sim.second ? `第 2 次发出 ${sim.second.fired} 条` : '问不到',
      )
      const ledger = readJson(remindLedgerPath()) || {}
      check('去重台账写盘了', Object.keys(ledger).length >= 1, `${Object.keys(ledger).length} 条：${Object.keys(ledger)[0] || ''}`)
      const simClass = await evalIn(panelWin, 'window.herShell.act("remind-simulate", {inMinutes: 30, inClass: true, tag: "class"}).then((r) => JSON.stringify(r))', 30000)
      check(
        '上课时间不弹（第 8 条"上课不弹"）',
        !!(simClass && simClass.first && simClass.first.skipped === 'class' && simClass.first.fired === 0),
        simClass && simClass.first ? `skipped=${simClass.first.skipped || '（没跳过）'} / fired=${simClass.first.fired}` : '问不到',
      )
      // 「稍后 10 分钟」：台账改成"10 分钟后才允许再说" → 立刻再查不响；把它改成"现在就可以"→ 又响
      const snoozeKey = (sim && sim.first && sim.first.fired_items && sim.first.fired_items[0] && sim.first.fired_items[0].key) || ''
      const snoozed = await evalIn(
        panelWin,
        'window.herShell.act("remind-snooze", {key:' + JSON.stringify(snoozeKey) + ', minutes: 10}).then((r) => JSON.stringify(r))',
        20000,
      )
      check('「稍后 10 分钟」写进台账了', !!(snoozed && snoozed.ok && snoozed.minutes === 10), snoozed ? `到 ${snoozed.until} 才再说` : '没成')
      const afterSnooze = await evalIn(
        panelWin,
        'window.herShell.act("remind-simulate", {inMinutes: 25, tag: "remind"}).then((r) => JSON.stringify(r))',
        30000,
      )
      check(
        '稍后期间不会再说（snooze 生效）',
        !!(afterSnooze && afterSnooze.first && afterSnooze.first.fired === 0),
        afterSnooze && afterSnooze.first ? `fired=${afterSnooze.first.fired}` : '问不到',
      )
      const snoozeZero = await evalIn(
        panelWin,
        'window.herShell.act("remind-snooze", {key:' + JSON.stringify(snoozeKey) + ', minutes: 0}).then((r) => JSON.stringify(r))',
        20000,
      )
      const afterSnoozeZero = await evalIn(
        panelWin,
        'window.herShell.act("remind-simulate", {inMinutes: 25, tag: "remind"}).then((r) => JSON.stringify(r))',
        30000,
      )
      check(
        '“稍后”到点后会重新说一次',
        !!(snoozeZero && snoozeZero.ok && afterSnoozeZero && afterSnoozeZero.first && afterSnoozeZero.first.fired === 1),
        afterSnoozeZero && afterSnoozeZero.first ? `fired=${afterSnoozeZero.first.fired}` : '问不到',
      )
      // 排队：同时两条 → 队列里 2 条
      await evalIn(
        panelWin,
        'Promise.all([window.herShell.act("remind-simulate", {inMinutes: 20, tag: "q1"}), window.herShell.act("remind-simulate", {inMinutes: 21, tag: "q2"})]).then((r) => JSON.stringify(r))',
        40000,
      )
      await sleep(600)
      const herRemind = await evalJson('JSON.stringify({ visible: !!(window.herApp && window.herApp.remindVisible), text: (window.herApp && window.herApp.remindText) || "" })', 15000)
      check(
        '多条同时来 → 一条一条弹（她脚边有提醒条）',
        !!(herRemind && herRemind.visible),
        herRemind ? `提醒条：${String(herRemind.text).slice(0, 24)}` : '问不到',
      )
      // 跨零点也算得对：把"现在"假成 23:40，DDL 在 50 分钟后（= 明天 00:30）→ 该提醒
      const simCross = await evalIn(
        panelWin,
        'window.herShell.act("remind-simulate", {nowAt:"23:40", inMinutes: 50, inClass: false, tag: "cross"}).then((r) => JSON.stringify(r))',
        30000,
      )
      check(
        '跨零点的 DDL 也算得对（23:40 时提醒明天 00:30 的）',
        !!(simCross && simCross.ok && simCross.first && simCross.first.fired === 1),
        simCross && simCross.task ? `现在=${simCross.nowAt}，DDL=${simCross.task.dueDate} ${simCross.task.dueTime}，发出 ${simCross.first.fired} 条` : '问不到',
      )
      // 规则可配：改"提前多久"→ 落盘 → 回读
      const setRule = await evalIn(
        panelWin,
        'window.herShell.act("set-remind", {key:"remind_lead_minutes", value: "45"}).then((r) => JSON.stringify(r))',
        20000,
      )
      check('提醒规则可配（提前多久改完能回读）', !!(setRule && setRule.ok && setRule.rules && setRule.rules.lead === 45), setRule ? `lead=${setRule.rules && setRule.rules.lead}` : '失败了')
      const rulesText = existsSync(remindRulesPath()) ? readFileSync(remindRulesPath(), 'utf8') : ''
      check('规则文件里有 key = value（主人能照着改）', /remind_lead_minutes\s*=\s*45/.test(rulesText) && /remind_quiet_in_class\s*=/.test(rulesText), `文件 ${rulesText.length} 字节`)
      // 还原成默认，别把自检改动留在 .mock 里
      await evalIn(panelWin, 'window.herShell.act("set-remind", {key:"remind_lead_minutes", value: "60"}).then((r) => JSON.stringify(r))', 20000)
    } catch (err) {
      check('主动提醒（第 8 条）', false, (err && err.message) || String(err))
    }

    // ── 每日提醒清单（批次 1.4）：加 → 到点会弹 → 不重复 → 能关 → 能删 ──────────
    try {
      const beforeN = readDaily().items.length
      const added = await evalIn(
        panelWin,
        'window.herShell.act("daily-add", {title:"自检：每日提醒", time:"20:30", days:[1,3,5]}).then((r) => JSON.stringify(r))',
        20000,
      )
      const addedItems = added && Array.isArray(added.items) ? added.items : []
      const mine = addedItems.find((x) => /自检：每日提醒/.test(String(x.title))) || null
      check(
        '每日提醒能加（提醒清单多一条）',
        !!(added && added.ok !== false && mine && addedItems.length === beforeN + 1),
        mine ? `${mine.time} ${mine.title}（周${mine.days.map((d) => DAILY_WD[d - 1]).join('/')}）` : `${addedItems.length} 条（之前 ${beforeN}）`,
      )
      const dailyBack = readJson(dailyFile()) || {}
      check(
        '提醒清单落盘了（out\\提醒清单.mock.json）',
        Array.isArray(dailyBack.items) && dailyBack.items.some((x) => /自检：每日提醒/.test(String(x.title))),
        `${Array.isArray(dailyBack.items) ? dailyBack.items.length : 0} 条`,
      )
      const simDaily = await evalIn(
        panelWin,
        'window.herShell.act("remind-simulate", {inMinutes: 0, daily:{title:"自检：喝水"}, tag:"daily"}).then((r) => JSON.stringify(r))',
        30000,
      )
      const df = simDaily && simDaily.first && Array.isArray(simDaily.first.fired_items) ? simDaily.first.fired_items[0] : null
      check(
        '每日提醒到点会弹（跟 DDL 走同一条提醒条）',
        !!(df && df.daily === true),
        simDaily && simDaily.first ? `发出 ${simDaily.first.fired} 条${df ? '：' + df.title + ' @ ' + df.dueTime : ''}` : '问不到',
      )
      check(
        '每日提醒同一时刻不重复弹（去重台账）',
        !!(simDaily && simDaily.second && simDaily.second.fired === 0),
        simDaily && simDaily.second ? `第 2 次发出 ${simDaily.second.fired} 条` : '问不到',
      )
      const offIt = await evalIn(
        panelWin,
        'window.herShell.act("daily-set", {id:' + JSON.stringify(mine ? mine.id : '') + ', patch:{enabled:false}}).then((r) => JSON.stringify(r))',
        20000,
      )
      check(
        '每日提醒能关掉（enabled=false 写盘）',
        !!(offIt && offIt.ok !== false && (offIt.items || []).some((x) => x.id === (mine && mine.id) && x.enabled === false)),
        offIt ? `那条 enabled=${((offIt.items || []).find((x) => x.id === (mine && mine.id)) || {}).enabled}` : '改不了',
      )
      const rmIt = await evalIn(
        panelWin,
        'window.herShell.act("daily-remove", ' + JSON.stringify(mine ? mine.id : '') + ').then((r) => JSON.stringify(r))',
        20000,
      )
      check(
        '每日提醒能删掉（总数回到加之前）',
        !!(rmIt && rmIt.ok !== false && (rmIt.items || []).length === beforeN),
        rmIt ? `${(rmIt.items || []).length} 条（加之前 ${beforeN}）` : '删不了',
      )
    } catch (err) {
      check('每日提醒（批次 1.4）', false, (err && err.message) || String(err))
    }

    // ── 每周计划（批次 1.5）：能加 / 能勾 / 上一周还在 ─────────────────────────
    try {
      const w0 = await evalIn(panelWin, 'window.herShell.data("weekly").then((d) => JSON.stringify(d))', 20000)
      check(
        '每周计划读得到（当前这一周 + 往周归档）',
        !!(w0 && w0.current && Array.isArray(w0.past) && w0.past.length >= 1),
        w0 && w0.current ? `本周 ${w0.current.key}（${w0.current.goals.length} 条）/ 往周 ${w0.past.length} 个` : '读不到',
      )
      const goalsBefore = w0 && w0.current ? w0.current.goals.length : 0
      const wAdd = await evalIn(
        panelWin,
        'window.herShell.act("weekly-add", "自检：这一周把错题看一遍").then((r) => JSON.stringify(r))',
        20000,
      )
      const mineGoal = wAdd && wAdd.current ? wAdd.current.goals.find((g) => /自检：这一周把错题看一遍/.test(String(g.text))) : null
      check(
        '每周计划能加一条',
        !!(wAdd && wAdd.ok !== false && mineGoal && wAdd.current.goals.length === goalsBefore + 1),
        mineGoal ? `id=${mineGoal.id} / 现在 ${wAdd.current.goals.length} 条` : '没加上',
      )
      const wTog = await evalIn(
        panelWin,
        'window.herShell.act("weekly-toggle", ' + JSON.stringify(mineGoal ? mineGoal.id : '') + ').then((r) => JSON.stringify(r))',
        20000,
      )
      check(
        '每周计划能勾掉（done 真的写盘）',
        !!(wTog && wTog.ok !== false && wTog.goal && wTog.goal.done === true),
        wTog && wTog.goal ? `${wTog.goal.text} → done=${wTog.goal.done}` : '勾不了',
      )
      const wFile = readJson(weeklyFile()) || {}
      const wkKeys = wFile.weeks && typeof wFile.weeks === 'object' ? Object.keys(wFile.weeks) : []
      check(
        '换周不删东西（上一周的目标还在每周计划.json 里）',
        wkKeys.length >= 2 && !!(wFile.weeks[wkKeys[0]] && (wFile.weeks[wkKeys[0]].goals || []).length > 0),
        `${wkKeys.length} 周：${wkKeys.join(' / ')}`,
      )
    } catch (err) {
      check('每周计划（批次 1.5）', false, (err && err.message) || String(err))
    }

    // ── 学科学习计划（批次 1.6）：能存 / 能改 / 能读回 ────────────────────────
    try {
      const beforeN = readPlans().items.length
      const p1 = await evalIn(
        panelWin,
        'window.herShell.act("plan-set", {subject:"自检：生物", plan:"先过概念，再做 5 道题", progress: 30}).then((r) => JSON.stringify(r))',
        20000,
      )
      check(
        '学科计划能存（读回来 plan + 进度都对）',
        !!(p1 && p1.ok !== false && (p1.items || []).some((x) => x.subject === '自检：生物' && x.progress === 30 && /先过概念/.test(x.plan))),
        p1 && Array.isArray(p1.items) ? `${p1.items.length} 门：${p1.items.map((x) => x.subject + ' ' + x.progress + '%').join(' / ').slice(0, 60)}` : '没存成',
      )
      const p2 = await evalIn(
        panelWin,
        'window.herShell.act("plan-set", {subject:"自检：生物", progress: 70}).then((r) => JSON.stringify(r))',
        20000,
      )
      check(
        '同一门课再存是"改"不是"再加一条"',
        !!(p2 && p2.ok !== false && (p2.items || []).length === beforeN + 1 && (p2.items || []).some((x) => x.subject === '自检：生物' && x.progress === 70)),
        p2 && Array.isArray(p2.items) ? `${p2.items.length} 门（存之前 ${beforeN}）` : '改不了',
      )
      const planBack = readJson(planFile()) || {}
      check(
        '学科计划落盘了（out\\学科计划.mock.json）',
        Array.isArray(planBack.items) && planBack.items.some((x) => x.subject === '自检：生物'),
        `${Array.isArray(planBack.items) ? planBack.items.length : 0} 门`,
      )
    } catch (err) {
      check('学科学习计划（批次 1.6）', false, (err && err.message) || String(err))
    }

    // ── 归档（批次 2.1）：满一周的挪走、没满的留着、文件里还在（隔离目录，绝不动真数据）──
    if (!SELFTEST_SLOW) {
      skipSlow([
        '归档干跑不动数据（只报告"有几条该归档"）',
        '归档真动手：满一周的挪走、没满的和没做完的都留着',
        '归档是"不真删"：tasks.archive.jsonl 里整条还在',
      ])
    } else try {
      const sim = await evalIn(panelWin, 'window.herShell.act("archive-simulate", "").then((r) => JSON.stringify(r))', 90000)
      check(
        '归档干跑不动数据（只报告"有几条该归档"）',
        !!(sim && sim.dryKeptAll && sim.dry && sim.dry.dry === true && sim.dry.wouldArchive === 1),
        sim && sim.dry ? `wouldArchive=${sim.dry.wouldArchive} / 干跑后目录里还是 ${(sim.dryIds || []).length} 条` : '问不到',
      )
      check(
        '归档真动手：满一周的挪走、没满的和没做完的都留着',
        !!(
          sim &&
          sim.applied &&
          sim.applied.archived === 1 &&
          (sim.keptIds || []).length === 2 &&
          (sim.keptIds || []).includes('arch-new') &&
          (sim.keptIds || []).includes('arch-open')
        ),
        sim ? `archived=${sim.applied && sim.applied.archived} / 留下 ${(sim.keptIds || []).join(' / ')}` : '问不到',
      )
      check(
        '归档是"不真删"：tasks.archive.jsonl 里整条还在',
        !!(sim && sim.archiveHasOld && sim.archiveLines >= 1 && !sim.archiveHasNew),
        sim ? `${sim.archiveLines} 行 / 旧的那条在=${sim.archiveHasOld} / 昨天那条没进=${!sim.archiveHasNew}` : '问不到',
      )
      const simFile = sim && sim.dir ? join(sim.dir, 'tasks.archive.jsonl') : ''
      writeJson(join(OUT, 'archive-selftest.json'), { sim, at: new Date().toISOString() })
      if (simFile && existsSync(simFile)) say('归档账（自检用）：' + simFile)
    } catch (err) {
      check('归档（批次 2.1）', false, (err && err.message) || String(err))
    }

    // ── 界面「＋新增」任务（批次 2.2a）：脚本真跑一遍（隔离目录）───────────────
    if (!SELFTEST_SLOW) {
      skipSlow([
        '「＋新增」真能落一条任务（带科目 + DDL）',
        '认不出科目的那条按 to-do 存（不瞎认科目）',
        '同一秒连加两条，id 也不撞（踩过：CLI 每次新进程，计数器从 0 开始）',
      ])
    } else try {
      const sim = await evalIn(panelWin, 'window.herShell.act("task-add-simulate", "").then((r) => JSON.stringify(r))', 90000)
      check(
        '「＋新增」真能落一条任务（带科目 + DDL）',
        !!(sim && sim.count === 2 && sim.one && sim.one.ok && sim.one.task && String(sim.one.task.dueAt || '').includes('2026-11-02')),
        sim && sim.one ? `${sim.one.action} / ${sim.one.task && sim.one.task.title} / DDL ${sim.one.task && sim.one.task.dueAt}` : '问不到',
      )
      check(
        '认不出科目的那条按 to-do 存（不瞎认科目）',
        !!(sim && Array.isArray(sim.kinds) && sim.kinds.includes('homework') && sim.kinds.includes('todo') && sim.subjects.includes(null)),
        sim ? `kind=${(sim.kinds || []).join('/')} / subject=${JSON.stringify(sim.subjects || [])}` : '问不到',
      )
      check(
        '同一秒连加两条，id 也不撞（踩过：CLI 每次新进程，计数器从 0 开始）',
        !!(sim && sim.count === 2 && sim.uniqueIds === 2),
        sim ? `${sim.count} 条 / ${sim.uniqueIds} 个不同的 id：${(sim.ids || []).join(' , ')}` : '问不到',
      )
      if (sim && sim.dir) writeJson(join(OUT, 'task-add-selftest.json'), { sim, at: new Date().toISOString() })
    } catch (err) {
      check('界面「＋新增」任务（批次 2.2a）', false, (err && err.message) || String(err))
    }

    // ── 错题本「＋新增」（批次 2.2b）：隔离夹具里真跑 → 序号/预览/备份/轮次 ──────────
    if (!SELFTEST_SLOW) {
      skipSlow([
        '错题能记一条（序号接着排，不重排）',
        '默认只出预览：正式 docx 一个字节都没动',
        '点了「连 docx 一起存」才覆盖正式文件，而且先备份旧的',
        '轮次没被打回第 1 轮（主人定的：不动他的轮次）',
        '写之前留了 entries.json.bak-*',
      ])
    } else try {
      const sim = await evalIn(panelWin, 'window.herShell.act("mistake-add-simulate", "").then((r) => JSON.stringify(r))', 180000)
      check(
        '错题能记一条（序号接着排，不重排）',
        !!(sim && sim.one && sim.one.ok && sim.one.seq === 2 && sim.one.count === 2),
        sim && sim.one ? `第 ${sim.one.seq} 条（原来 ${sim.one.before} 条，现在 ${sim.one.count} 条）` : '问不到',
      )
      check(
        '默认只出预览：正式 docx 一个字节都没动',
        !!(sim && sim.previewWritten && sim.previewText.includes('STUB-DOCX 2') && sim.realAfterPreview === 'OLD-DOCX'),
        sim ? `预览=${sim.previewWritten ? '有' : '没有'} / 正式 docx=${String(sim.realAfterPreview).slice(0, 12)}` : '问不到',
      )
      check(
        '点了「连 docx 一起存」才覆盖正式文件，而且先备份旧的',
        !!(sim && sim.applied && sim.applied.ok && String(sim.realAfterApply).includes('STUB-DOCX 3') && Array.isArray(sim.backups) && sim.backups.length >= 1),
        sim ? `正式 docx=${String(sim.realAfterApply).slice(0, 14)} / 备份=${(sim.backups || []).join(',')}` : '问不到',
      )
      check(
        '轮次没被打回第 1 轮（主人定的：不动他的轮次）',
        !!(sim && sim.round === 1 && Number(sim.seqHighWater) >= 3 && sim.entryCount === 3),
        sim ? `round=${sim.round} / 水位=${sim.seqHighWater} / 条目 ${sim.entryCount}` : '问不到',
      )
      check(
        '写之前留了 entries.json.bak-*',
        !!(sim && sim.one && /entries\.json\.bak-/.test(String(sim.one.backup || sim.backupFile || ''))),
        sim && sim.one ? String(sim.one.backup || sim.backupFile || '（没写）') : '问不到',
      )
      if (sim && sim.root) writeJson(join(OUT, 'mistake-selftest.json'), { sim, at: new Date().toISOString() })
    } catch (err) {
      check('错题本「＋新增」（批次 2.2b）', false, (err && err.message) || String(err))
    }

    // ── 对话按主题分上下文（第 12 条）：两个主题各写一句，读回来不许串 ──────────────
    if (!SELFTEST_SLOW) {
      skipSlow([
        '两个主题用**不同的**会话文件',
        '主题甲的话只在甲里，主题乙的话只在乙里（不串）',
        '切完主题以后当前主题能读回来 / 列表里有这两个',
        '每一轮真的按主题把会话文件传给了她的大脑（日志里能看到路由）',
      ])
    } else try {
      const sim = await evalIn(panelWin, 'window.herShell.act("chat-topic-simulate", "").then((r) => JSON.stringify(r))', 120000)
      const aText = sim && sim.histA && Array.isArray(sim.histA.items) ? sim.histA.items.map((i) => i.text).join(' / ') : ''
      const bText = sim && sim.histB && Array.isArray(sim.histB.items) ? sim.histB.items.map((i) => i.text).join(' / ') : ''
      check(
        '两个主题用**不同的**会话文件',
        !!(sim && sim.files && sim.files.a !== sim.files.b && sim.sameFile === false),
        sim && sim.files ? `${sim.files.a} ≠ ${sim.files.b}` : '问不到',
      )
      check(
        '主题甲的话只在甲里，主题乙的话只在乙里（不串）',
        !!(
          sim &&
          (sim.histA.items || []).some((i) => /主题甲/.test(i.text)) &&
          !(sim.histA.items || []).some((i) => /主题乙/.test(i.text)) &&
          (sim.histB.items || []).some((i) => /主题乙/.test(i.text)) &&
          !(sim.histB.items || []).some((i) => /主题甲/.test(i.text))
        ),
        `甲：${aText.slice(0, 30)} ｜ 乙：${bText.slice(0, 30)}`,
      )
      check(
        '切完主题以后当前主题能读回来 / 列表里有这两个',
        !!(sim && sim.restored && Array.isArray(sim.topics) && sim.topics.length >= 1),
        sim ? `当前=${sim.restored} / 列表 ${(sim.topics || []).join(',')}` : '问不到',
      )
      check(
        '每一轮真的按主题把会话文件传给了她的大脑（日志里能看到路由）',
        !!(sim && sim.routedA && sim.routedB),
        sim ? `甲路由=${sim.routedA} / 乙路由=${sim.routedB}` : '问不到',
      )
    } catch (err) {
      check('对话按主题分上下文（第 12 条）', false, (err && err.message) || String(err))
    }

    // ── 课件库检索链路（A4：数据侧是同学的 info\materials，我只验"通"）──────────
    try {
      const qPath = join(INFO_DIR, 'materials', 'query.mjs')
      if (!existsSync(qPath)) {
        check('课件库检索（info\\materials）', true, '还没有 info\\materials（跳过）')
      } else {
        // 2026-10-25 第 10 项：`process.execPath` 在 Electron 里是 **electron.exe**，
        //   不带 ELECTRON_RUN_AS_NODE 的话子进程会去抢 GUI/一直不退出 → 这里活等满 30 秒超时
        //   （自检里足足 30 秒白花在这）。加上这个环境变量，它就按普通 node 跑脚本。
        const q = spawnSync(process.execPath, [qPath, '--q', '细胞呼吸 cellular respiration', '--k', '3', '--json'], {
          encoding: 'utf8',
          timeout: 30000,
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DATA: DATA_ROOT },
        })
        const line = String(q.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}'
        let j = null
        try {
          j = JSON.parse(line)
        } catch {}
        const hits = j && Array.isArray(j.hits) ? j.hits : []
        check(
          '课件库检索能命中（A4：回答前先翻课件）',
          hits.length > 0,
          hits.length ? `${hits.length} 条，头一条 ${String(hits[0].source || '').split(/[\\/]/).pop()}#P${hits[0].page}` : '没命中（可能还没建索引）',
        )
      }
    } catch (err) {
      check('课件库检索能命中（A4：回答前先翻课件）', false, (err && err.message) || String(err))
    }

    // ── 成长回路（主人 2026-10-24：不许影响"越用越了解我"）──────────────
    if (!SELFTEST_SLOW) {
      skipSlow(['她能把经验记进经验本（① 记）', '经验本能被提炼（② 炼 → 影子规矩）'])
    } else try {
      const book = learnBookPath()
      try { writeFileSync(book, '', 'utf8') } catch {}
      const note = await evalIn(panelWin, "window.herShell.act(\"learn-note\", {lesson:\"自检：只有科目名不算作业\"}).then((r) => JSON.stringify(r))", 30000)
      const bookText = existsSync(book) ? readFileSync(book, 'utf8') : ''
      check('她能把经验记进经验本（① 记）', !!(note && note.ok) && /只有科目名不算作业/.test(bookText), note ? (bookText.trim().split(/\r?\n/).slice(-1)[0] || '').slice(0, 50) : '没记成')
      const dig = await evalIn(panelWin, "window.herShell.act(\"learn-digest\", \"force\").then((r) => JSON.stringify(r))", 60000)
      check('经验本能被提炼（② 炼 → 影子规矩）', !!(dig && dig.ok), dig ? String(dig.tail || '').trim().split(/\r?\n/).slice(-1)[0].slice(0, 60) : '没炼成')
    } catch (err) {
      check('她的成长回路（经验本 ① 记 / ② 炼）', false, (err && err.message) || String(err))
    }

    // ④ 气泡要出声（第 4 条）+ 状态留得住（第 5 条）
    try {
      appendFileSync(
        join(OUT, 'pet-events.jsonl'),
        JSON.stringify({ t: 'control', say: '自检：这一句是气泡，应该走到语音那一步' }) + '\n',
        'utf8',
      )
      await sleep(1000)
      const logText = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : ''
      check(
        '她自己在气泡里说的话会走到语音（第 4 条）',
        logText.includes('本该念') && logText.includes('自检：这一句是气泡'),
        logText.includes('自检：这一句是气泡') ? '日志里看到了"本该念"' : '日志里没有',
      )
    } catch (err) {
      check('她自己在气泡里说的话会走到语音（第 4 条）', false, (err && err.message) || String(err))
    }
    // 2026-10-25 M2：**点她一下** —— 她那句"页面自己挑的话"也得念（以前只弹气泡、不出声）
    try {
      const prior = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').length : 0
      await evalIn(win, 'JSON.stringify(window.DSHPet.pokeAt(80, 120))', 15000)
      await sleep(1400)
      const fresh = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8').slice(prior) : ''
      const hit = /（页面说的）念：([^\r\n]*)/.exec(fresh)
      check(
        '点她一下 → 她那句话也走语音（页面说的那句，以前是哑的）',
        !!hit,
        hit ? `念的是：${hit[1].slice(0, 26)}` : '日志里没出现"（页面说的）念"',
      )
    } catch (err) {
      check('点她一下 → 她那句话也走语音（页面说的那句，以前是哑的）', false, (err && err.message) || String(err))
    }
    // 2026-10-25 M3：点她要"接得上" —— 上一句是喷水的引子，下一次点击一定接喷水那条
    try {
      await evalIn(win, 'JSON.stringify(window.DSHPet.debugSetLastLine("鲸鱼是会喷水的！"))', 10000)
      await evalIn(win, 'JSON.stringify(window.DSHPet.pokeAt(80, 120))', 10000)
      await sleep(800)
      const bub = await evalIn(
        win,
        'JSON.stringify({ text: (document.querySelector(".dshp-bubble") || {}).textContent || "", last: window.DSHPet.lastLine() })',
        10000,
      )
      const txt = String((bub && bub.text) || '')
      check(
        '点她要接得上（"鲸鱼是会喷水的！"之后再点 → 一定接喷水那句 + 动画）',
        /这次真喷了/.test(txt),
        txt ? `气泡：${txt.slice(0, 30)}` : '气泡里没东西',
      )
    } catch (err) {
      check('点她要接得上（"鲸鱼是会喷水的！"之后再点 → 一定接喷水那句 + 动画）', false, (err && err.message) || String(err))
    }
    // 口型同步（2026-10-25 P2）：拿 out\tts 里**真的一句 mp3**，让页面把它解成响度包络 ——
    // 这一步通了，播放时嘴就真的跟着声音张合（接口本身在渲染层自检里另有两条）。
    try {
      let probeFile = ''
      try {
        const mp3s = readdirSync(TTS_DIR).filter((f) => f.endsWith('.mp3'))
        if (mp3s.length > 0) {
          mp3s.sort((a, b) => statSync(join(TTS_DIR, b)).mtimeMs - statSync(join(TTS_DIR, a)).mtimeMs)
          probeFile = mp3s[0]
        }
      } catch {}
      if (!probeFile) {
        check('口型那条链是通的（真解码一句 mp3 → 响度包络）', true, `out\\tts 里还没有 mp3（跳过；先让她说一句话）`)
      } else {
        const probe = await evalIn(win, `window.herApp.talkProbe(${JSON.stringify('/tts/' + probeFile)}).then((r) => JSON.stringify(r))`, 30000)
        check(
          '口型那条链是通的（真解码一句 mp3 → 响度包络）',
          !!(probe && probe.ok && probe.points > 5 && probe.peak > 0),
          probe ? `${probeFile} → ${probe.points} 个采样点 / 峰值 ${probe.peak}` : '问不到',
        )
        // 2026-10-25 第 11 项：光"能算包络"还不够 —— 要证明**响声和安静处嘴张得不一样**
        //   （pet.js 的映射是 0.1 + 0.55×level；这里看这条映射在这句真实音频上跨了多大）
        check(
          '口型真的跟音量走（最响处嘴张 ≤ 最静处，差得开）',
          !!(probe && probe.ok && Number(probe.mouthRange) >= 0.15 && Number(probe.mouthLoud) > Number(probe.mouthQuiet)),
          probe
            ? `最响处嘴 ${probe.mouthLoud} / 最静处 ${probe.mouthQuiet}（跨度 ${probe.mouthRange}）`
            : '问不到',
        )
      }
    } catch (err) {
      check('口型那条链是通的（真解码一句 mp3 → 响度包络）', false, (err && err.message) || String(err))
    }
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/dsh-pet/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ say: '自检：量一下 control 默认留多久' }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)
      const j = resp ? await resp.json().catch(() => null) : null
      const hold = j && j.sent ? Number(j.sent.bubbleMs) : 0
      check('control 的状态默认留得久（第 5 条：不再是 5 秒）', hold >= 12000, `bubbleMs=${hold}`)
    } catch (err) {
      check('control 的状态默认留得久（第 5 条：不再是 5 秒）', false, (err && err.message) || String(err))
    }

    // ⑤ 透明 / 没有模糊边框
    const imgHer = await shoot(win, 'her-app-selftest.png', '形象窗（整窗）')
    if (imgHer) {
      const bmp = imgHer.toBitmap()
      let opaque = 0
      let clear = 0
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] > 16) opaque += 1
        else clear += 1
      }
      const total = Math.max(1, opaque + clear)
      check('形象窗是真透明（有大片 alpha=0）', clear > total * 0.05, `不透明 ${((opaque / total) * 100).toFixed(1)}%`)
      check('形象窗左上角透明（没有黑框）', bmp.length >= 4 && bmp[3] <= 16, `alpha=${bmp.length >= 4 ? bmp[3] : -1}`)
    } else {
      fails += 1
    }

    // ⑥ 关掉她 → 浮窗一起关（先记下浮窗在，最后真的关一次）
    const beforeQuit = !!(panelWin && !panelWin.isDestroyed())
    check('关她之前浮窗是开着的（下一步要验证会一起收）', beforeQuit)
  } catch (err) {
    fails += 1
    say('自检崩了：' + (err && err.message))
  }
  try {
    writeFileSync(SELFTEST_LOG, `==== 她的桌面应用自检（${new Date().toISOString()}）====\r\n${lines.join('\r\n')}\r\n==== 结束：失败 ${fails} 项 ====\r\n`, 'utf8')
  } catch {}
  console.log(`==== 失败 ${fails} 项 ====`)
  const code = fails === 0 ? 0 : 1
  try {
    chatKillTurn()
  } catch {}
  try {
    if (host.child && host.started) host.child.kill()
  } catch {}
  try {
    ttsStopBubbleWatch()
  } catch {}
  try {
    if (probeTick) clearInterval(probeTick)
  } catch {}
  try {
    if (panelWin && !panelWin.isDestroyed()) panelWin.destroy()
  } catch {}
  try {
    if (win && !win.isDestroyed()) win.destroy()
  } catch {}
  setTimeout(() => {
    try {
      process.exit(code)
    } catch {}
  }, 2000)
  app.exit(code)
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
/** 语音文件只增不减会撑爆 out\tts：启动时清掉一天前的 */
function cleanOldTts() {
  try {
    if (!existsSync(TTS_DIR)) return
    const cutoff = Date.now() - 24 * 3600 * 1000
    let n = 0
    for (const name of readdirSync(TTS_DIR)) {
      const file = join(TTS_DIR, name)
      try {
        const st = statSync(file)
        if (st.isFile() && st.mtimeMs < cutoff) {
          unlinkSync(file)
          n += 1
        }
      } catch {}
    }
    if (n > 0) log(`清掉 ${n} 个一天前的语音文件`)
  } catch {}
}

async function main() {
  log(`==== 她的桌面应用启动（pid ${process.pid}）模型 ${MODEL_H}px 置顶=${TOPMOST} 自检=${SELFTEST} 假数据=${MOCK} ====`)
  applyUserData()
  cleanOldTts()

  ipcMain.on('her:drag', (e, dx, dy) => {
    // 移的是**发消息的那个窗口**（形象窗拖她；浮窗靠原生 app-region 拖，走不到这里）
    const target = BrowserWindow.fromWebContents(e.sender)
    if (!target || target.isDestroyed()) return
    const b = target.getBounds()
    const nx = Math.round(b.x + (Number(dx) || 0))
    const ny = Math.round(b.y + (Number(dy) || 0))
    // 2026-10-22：拖的时候夹在屏幕里（一甩手把窗口拖出屏幕 → "她不见了/点不动"）。
    // 2026-10-23（主人："不能太往左或往右"）：夹的是**整个桌面**，所以能一直拖到屏幕最左/最右/最上。
    const area = workAreaFor(nx + b.width / 2, ny + b.height / 2)
    const pos = clampInto(area, nx, ny, b.width, b.height)
    target.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height })
  })
  ipcMain.on('her:drag-start', (e) => {
    try {
      const target = BrowserWindow.fromWebContents(e.sender)
      if (target && !target.isDestroyed()) target.focus()
    } catch {}
  })
  ipcMain.on('her:hit', (e, on) => {
    // 只有形象窗才谈得上"点穿透"；浮窗是个正常窗口，永远吃鼠标
    if (!win || win.isDestroyed() || e.sender !== win.webContents) return
    if (!gotHitMsg) {
      markHitMsg()
      log('命中回报已通（点击穿透按她身上的像素走）')
    }
    setIgnore(!on)
  })
  ipcMain.on('her:menu', (e) => {
    // 右键（形象 / 浮窗空白处）
    // 实测这台机器上一次物理右键会来两次请求（差 ~2 秒），这里先挡掉 400ms 内的重复；
    // 页面那边还有一道 600ms 的防抖（renderer\app.js 的 pickShownAt），双保险。
    const nowMs = Date.now()
    if (nowMs - lastMenuAt < 400) return
    lastMenuAt = nowMs
    menuPopCount += 1
    const fromHer = !!(win && !win.isDestroyed() && e.sender === win.webContents)
    if (SELFTEST) {
      // 自检里不真的弹原生菜单（会挂在屏幕上等人点），只记一笔，让自检能验这条路
      log('（自检）收到右键菜单请求 → 第 ' + menuPopCount + ' 次' + (fromHer ? '（形象窗）' : '（浮窗）'))
      if (fromHer) {
        try {
          win.webContents.send('her:pick', {})
        } catch {}
      }
      return
    }
    if (fromHer) {
      // 形象窗：弹**我们自己画的那条选项条**（就在她脚下、窄带、几秒自动收）
      // 为什么不用 Menu.popup：这个无边框 + 透明的窗口上实测弹不出来（日志"菜单弹出"了，
      // 但枚举窗口一个新窗口都没有）。DOM 版本 100% 可靠，还正好是主人要的"选项条"。
      log(`右键她 → 弹选项条（第 ${menuPopCount} 次）`)
      try {
        win.webContents.send('her:pick', {})
      } catch {}
      return
    }
    try {
      const target = BrowserWindow.fromWebContents(e.sender) || win
      log(`右键菜单弹出（第 ${menuPopCount} 次，浮窗上）`)
      buildMenu().popup({ window: target })
    } catch (err) {
      log('菜单弹不出来：' + (err && err.message))
    }
  })

  // 浮窗（独立窗口）开合
  ipcMain.handle('her:panel-open', async (_e, page) => showPanel(String(page || 'today')))
  ipcMain.handle('her:panel-hide', async () => hidePanelNow())
  ipcMain.handle('her:panel-state', async () => ({
    ok: true,
    visible: !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible()),
    page: panelPage,
  }))

  ipcMain.handle('her:chat-history', async (_e, topic) => loadChatHistory(40, topic))
  ipcMain.handle('her:chat-send', async (_e, text) => startTurn(text))

  ipcMain.handle('her:data', async (_e, kind) => {
    if (kind === 'today') return loadToday()
    if (kind === 'tasks') return loadTasks()
    if (kind === 'agenda') return loadAgenda()
    if (kind === 'mistakes') return loadMistakes()
    if (kind === 'dropbox') return loadDropbox()
    if (kind === 'summary') return loadSummaries()
    // 对话主题（第 12 条，2026-10-24 晚）
    if (kind === 'chat-meta') return listChatTopics()
    // 批次 1（2026-10-24）：每日提醒清单 / 每周计划 / 学科学习计划
    if (kind === 'daily') return readDaily()
    if (kind === 'weekly') return readWeekly()
    if (kind === 'plans') return readPlans()
    if (kind === 'settings') {
      const view = await evalJson(
        'JSON.stringify((window.DSHPet && window.DSHPet.state && window.DSHPet.state.view) || null)',
      )
      return {
        ok: true,
        theme: getTheme(),
        themes: THEME_PRESETS.slice(),
        modelHeight: currentModelH,
        sizes: SIZE_PRESETS.map((s) => ({ ...s })),
        view: view || null,
        speakOn: voiceAllowed(),
        cardAlpha: cardAlpha(),
        dataRoot: DATA_ROOT,
        rulesFound: existsSync(LOOK_RULES),
        topMost: TOPMOST,
        panelVisible: !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible()),
        look: todayLook(),
        lookMode: readLookMode(),
        lookGroups: LOOK_GROUPS.map((g) => ({ key: g.key, label: g.label, items: g.items.map((i) => ({ ...i })) })),
        remind: (() => {
          const r = readRemindRules()
          return { on: r.on, lead: r.lead, atDue: r.atDue, quietInClass: r.quietInClass, everySec: r.everySec, speak: r.speak }
        })(),
        remindFile: remindRulesPath(),
        summary: (() => { const r = readRemindRules(); return { on: r.summaryOn, at: r.summaryAt } })(),
        // 批次 1.4 / 1.6：设置页要能增删改每日提醒、编学科学习计划
        daily: readDaily().items,
        dailyFile: dailyFile(),
        plans: readPlans().items,
        planFile: planFile(),
        // 嗓子：edge（在线，更自然）还是 piper（本地）
        voice: readVoiceConfig(),
        voicePresets: VOICE_PRESETS.map((p) => ({ ...p })),
        voiceActive: ttsActiveEngine(),
        archiveFile: ARCHIVE_FILE,
        // 语言开关 + 现在挂的形象包（2026-10-25 P2，设置页两组按钮）
        lang: readLangMode(),
        modelPack: readModelPack(),
        modelPacks: readModelPacks(),
        modelPackActive: activeModelPack(),
        idleMotions: readModelMotions(),
        idleNow: (todayLook() && todayLook().look && todayLook().look.idle) || '',
        mock: MOCK,
      }
    }
    return { ok: false, error: '不认识的 kind：' + kind }
  })

  ipcMain.handle('her:act', async (_e, name, arg) => {
    if (name === 'refresh') {
      const r = lastJson(runNode(STUDY_LITE, ['--refresh']))
      log('刷新三份文件：' + JSON.stringify(r?.ok))
      return { ok: !!(r && r.ok) }
    }
    if (name === 'toggle') {
      const id = String(arg || '')
      if (!id || MOCK) return { ok: true, mock: MOCK }
      const r = lastJson(runNode(STUDY_LITE, ['--toggle', id]))
      log(`勾掉待办 ${id} → ${JSON.stringify(r?.task?.status ?? r?.status ?? r?.ok)}`)
      return r
    }
    if (name === 'open-file') {
      openReport(String(arg || 'brief'))
      return { ok: true }
    }
    if (name === 'notice-remove') {
      const id = String(arg || '')
      if (!id || MOCK) return { ok: true, mock: MOCK }
      const r = lastJson(runNode(STUDY_LITE, ['--notice-remove', id]))
      log(`撤掉通知 ${id} → ok=${r?.ok}`)
      return r
    }
    if (name === 'check-material') return toggleCheck(arg)
    if (name === 'ui-ready') {
      // 页面自己报到（2026-10-23）：真应用里也能从日志看出"界面真的起来了、几寸大"
      const a = arg && typeof arg === 'object' ? arg : {}
      log(`界面起来了（${a.mode || '?'}）：页签 ${a.tabs || '?'} 个，窗口 ${a.w || '?'}×${a.h || '?'}`)
      return { ok: true }
    }
    if (name === 'panel-open') return showPanel(String(arg || panelPage || 'today'))
    if (name === 'panel-close') return hidePanelNow()
    if (name === 'stop-speak') {
      // 「念这一页」停：声音在形象窗那边放，让它停
      if (win && !win.isDestroyed()) win.webContents.send('her:tts', { stop: true })
      return { ok: true }
    }
    if (name === 'set-topmost') {
      const want = arg === true || arg === 'on' || arg === '1'
      TOPMOST = want
      try {
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(want)
        if (panelWin && !panelWin.isDestroyed()) panelWin.setAlwaysOnTop(want)
      } catch {}
      log('置顶 = ' + want)
      return { ok: true, topMost: want }
    }
    if (name === 'look-choose') {
      // 「让她今天换一身」：她自己的脑子来挑（挑不到就按日期兜底，不会空着）
      return chooseLook({ reason: 'manual' })
    }
    if (name === 'look-set') {
      // 主人自己点某一项（group + key），立刻生效并记下来
      const a = arg && typeof arg === 'object' ? arg : {}
      return setLookItem(String(a.group || ''), String(a.key || ''))
    }
    if (name === 'look-mode') {
      // 「她自主」/「你选择」（主人 2026-10-24 深夜要的开关）
      const a = arg && typeof arg === 'object' ? arg : { mode: String(arg || '') }
      return setLookMode(a.mode)
    }
    if (name === 'look-daily') {
      // 自检用：模拟"启动那天她自己挑一身"（在「你选择」模式下必须被跳过）
      return chooseLook({ reason: 'daily' })
    }
    if (name === 'tts-cache-status') {
      const files = readCacheIndex()
      return { ok: true, dir: TTS_CACHE, cached: files.length, lines: DAILY_LINES.length, engine: readVoiceConfig().engine }
    }
    if (name === 'tts-cache-build') {
      // 把日常话预录一遍（会联网；一句话 1~2 秒）
      return buildTtsCache()
    }
    if (name === 'bracket-test') {
      // 自检用：验"方括号=控制（且从正文剥掉）/ 小括号=原样留着"
      const sample = '先看题。[表情：脸红]这题先配方 (她把笔放下) 再代入。[备注]方括号里的普通备注要留着'
      const clean = stripBracketControls(sample)
      return { ok: true, sample, text: clean.text, controls: clean.controls }
    }
    if (name === 'panel-fit-test') {
      // 自检用：把"屏幕外"的存档喂进去，看会不会被夹回屏幕（不碰真窗口）
      const box = { left: 99999, top: 99999, width: 470, height: 660 }
      const fit = fitPanelBox(box)
      const areas = screen.getAllDisplays().map((d) => ({ x: d.workArea.x, y: d.workArea.y, w: d.workArea.width, h: d.workArea.height }))
      const inside = areas.some((a) => fit.x >= a.x && fit.y >= a.y && fit.x + fit.width <= a.x + a.w + 2 && fit.y + fit.height <= a.y + a.h + 2)
      return { ok: true, box, fit, areas, inside }
    }
    // ── 对话主题（第 12 条，2026-10-24 晚）────────────────────────────────
    if (name === 'chat-topic') {
      const a = arg && typeof arg === 'object' ? arg : { name: String(arg || '') }
      const r = setCurrentTopic(a.name)
      if (r.ok) log(`对话主题 → ${r.topic}（会话文件：${basename(topicSessionFile(r.topic))}）`)
      return Object.assign({ ok: r.ok, error: r.error }, listChatTopics(), { history: loadChatHistory(40, r.topic).items || [] })
    }
    if (name === 'chat-topics') return listChatTopics()
    if (name === 'chat-topic-simulate') {
      // 自检专用：两个主题的会话文件互不相干
      //   ⚠️ brain.mjs 的 --mock 只吐假流、**不写会话文件**，所以这里按同一格式自己写标记行，
      //     验的是"主进程按主题分文件"这条路（startTurn 传没传 --session 看日志里的那一行）。
      const A = safeTopic('自检主题甲')
      const B = safeTopic('自检主题乙')
      const wa = topicSessionFile(A)
      const wb = topicSessionFile(B)
      try {
        for (const f of [wa, wb]) if (existsSync(f)) unlinkSync(f)
        mkdirSync(dirname(wa), { recursive: true })
      } catch {}
      const before = readCurrentTopic()
      const sw1 = setCurrentTopic(A)
      const sendA = startTurn('自检：这是主题甲里的一句')
      appendFileSync(wa, JSON.stringify({ at: new Date().toISOString(), role: 'user', content: '自检：这是主题甲里的一句' }) + '\n', 'utf8')
      appendFileSync(wa, JSON.stringify({ at: new Date().toISOString(), role: 'assistant', content: '（假）主题甲的回答' }) + '\n', 'utf8')
      await sleep(600)
      const sw2 = setCurrentTopic(B)
      const sendB = startTurn('自检：这是主题乙里的一句')
      appendFileSync(wb, JSON.stringify({ at: new Date().toISOString(), role: 'user', content: '自检：这是主题乙里的一句' }) + '\n', 'utf8')
      appendFileSync(wb, JSON.stringify({ at: new Date().toISOString(), role: 'assistant', content: '（假）主题乙的回答' }) + '\n', 'utf8')
      await sleep(600)
      const histA = loadChatHistory(40, A)
      const histB = loadChatHistory(40, B)
      const logText = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : ''
      const routedA = logText.includes(`主题「${A}」→ ${basename(wa)}`)
      const routedB = logText.includes(`主题「${B}」→ ${basename(wb)}`)
      setCurrentTopic(before)
      return {
        ok: true,
        sw1,
        sw2,
        sendA,
        sendB,
        files: { a: basename(wa), b: basename(wb) },
        sameFile: wa === wb,
        routedA,
        routedB,
        histA: { items: histA.items, file: histA.file },
        histB: { items: histB.items, file: histB.file },
        topics: listChatTopics().topics.map((t) => t.name),
        restored: readCurrentTopic(),
      }
    }
    // ── 错题本「＋新增」+ 她出草稿（批次 2.2b）───────────────────────────────
    if (name === 'mistake-add') {
      const a = arg && typeof arg === 'object' ? arg : {}
      const question = String(a.question || '').trim()
      if (!question) return { ok: false, error: '题面是空的（至少把题干抄一行；看不清就留空，会进 1.5 轮）' }
      if (MOCK) {
        return { ok: true, mock: true, seq: 3, count: 3, round: '未动（假数据）', preview: { ok: true, path: '（假数据）out\\错题本-预览.docx' }, warnings: [] }
      }
      const argv = ['--question', question]
      if (a.subject) argv.push('--subject', String(a.subject))
      if (a.mine) argv.push('--mine', String(a.mine))
      if (a.right) argv.push('--right', String(a.right))
      if (a.cause) argv.push('--cause', String(a.cause))
      if (a.solutions) argv.push('--solutions', String(a.solutions))
      if (a.source) argv.push('--source', String(a.source))
      if (a.apply === true) argv.push('--apply')
      const r = lastJson(runNode(MISTAKE_ADD, argv, 90000)) || {}
      if (r && r.ok) {
        log(`界面记了一条错题：第 ${r.seq} 条（现在 ${r.count} 条，轮次${r.round}）${a.apply === true ? '，docx 已重生成' : '，只出了预览'}`)
      } else {
        log('界面记错题失败：' + ((r && r.error) || '未知原因'))
      }
      return r
    }
    if (name === 'mistake-draft') {
      // 「让她先读一遍」：只出草稿（错因归类 + 3 条方案），**一个字都不写盘**
      const a = arg && typeof arg === 'object' ? arg : {}
      const question = String(a.question || '').trim()
      if (!question) return { ok: false, error: '先把题目抄进题面，她才知道要读什么' }
      if (MOCK) {
        return {
          ok: true,
          mock: true,
          text: '错因归类：（假数据）审题型 —— 被"本身正确但不回答题干"的干扰项带走。\n· （假数据）先圈出题干到底在问什么，再看选项\n· （假数据）每个选项回读一遍：它回答的是被问的那个问题吗\n· （假数据）把"题干问什么"写在草稿纸角上',
        }
      }
      const ask =
        `（下面是我错题本里刚记下的一道题。请你**先读一遍**，替我想错因和方案，我只当草稿，会自己改。）\n\n` +
        `【科目】${String(a.subject || '（没写）')}\n【题面】\n${question.slice(0, 2000)}\n` +
        `【我的选项】${String(a.mine || '（没记）')}　【正确选项】${String(a.right || '（没记）')}\n\n` +
        `要求（严格按这个格式，别写别的）：\n` +
        `第一行以「错因归类：」开头，一句话归类（审题不清 / 概念混淆 / 计算失误 / 方法选择错误 / 表达不规范 / 知识遗忘 / 粗心大意 / 其他），后面用破折号接具体原因；\n` +
        `接着 3 条以「· 」开头的方案（能落地的动作，不要空话）；\n` +
        `不要复述题目，不要道歉，不要写"我建议"这种开场白。`
      const inFile = join(OUT, 'her-mistake-draft-in.txt')
      try {
        writeFileSync(inFile, ask, 'utf8')
      } catch (err) {
        return { ok: false, error: '写不进临时文件：' + ((err && err.message) || err) }
      }
      const text = await runBrainCollect(inFile, 120000)
      if (!text.trim()) return { ok: false, error: '她没出出来（可能没联网或超时）' }
      log('错题草稿：出好了（' + text.length + ' 字，未写盘）')
      return { ok: true, text: text.trim() }
    }
    if (name === 'similar-questions') {
      // 错题详情里的「让她出相似题」：拿这道题的内容去问她自己（走 brain.mjs，是她的脑子在出题）
      const a = arg && typeof arg === 'object' ? arg : {}
      if (MOCK) {
        return {
          ok: true,
          mock: true,
          text:
            '（假数据）1. 若把题中的条件换成相反方向，结论会怎样变化？\n2. 下面哪一项与题干给的条件等价？\nA… B… C… D…\n答案：1. 反向；2. B（自检用的假题）',
        }
      }
      const title = String(a.title || '').slice(0, 200)
      const question = String(a.question || '').slice(0, 1500)
      const cause = String(a.cause || '').slice(0, 400)
      const rows = Array.isArray(a.rows) ? a.rows.map((x) => String(x || '')).filter(Boolean).slice(0, 12) : []
      const body = rows.length > 0 ? rows.join('\n') : question
      if (!title && !body) return { ok: false, error: '这一条没有题面，出不了' }
      const ask =
        `（下面是我错题本里的一道题。请出 3 道**同格式、同概念**的新题，AP 风格选择题，每题给答案和一句解析。）\n\n` +
        `【标题】${title}\n【我的选项/正确答案】${cause || '（没记）'}\n【题目与四轮】\n${body.slice(0, 3000)}\n\n` +
        `要求：\n1) 只考这里出现的概念，别扩展新知识点；\n2) 每题 4 个选项，标出正确答案；\n3) 每题后面跟一句"为什么"（不超过 40 字）；\n4) 直接给题目，不要复述要求。`
      const inFile = join(OUT, 'her-similar-in.txt')
      try {
        writeFileSync(inFile, ask, 'utf8')
      } catch (err) {
        return { ok: false, error: '写不进临时文件：' + ((err && err.message) || err) }
      }
      const text = await runBrainCollect(inFile, 120000)
      if (!text.trim()) return { ok: false, error: '她没出出来（可能没联网或超时）' }
      log('相似题：出好了（' + text.length + ' 字）')
      return { ok: true, text: text.trim() }
    }
    if (name === 'set-remind') {
      // 设置页里提醒的那几个开关（写进 她的限制-提醒.txt）
      const a = arg && typeof arg === 'object' ? arg : {}
      return setRemindRule(String(a.key || ''), a.value)
    }
    // ── 每日提醒清单（批次 1.4）────────────────────────────────────────────
    if (name === 'daily-add') return addDailyReminder(arg)
    if (name === 'daily-set') return setDailyReminder(arg)
    if (name === 'daily-remove') return removeDailyReminder(arg && typeof arg === 'object' ? arg.id : arg)
    // ── 每周计划（批次 1.5）──────────────────────────────────────────────
    if (name === 'weekly-add') return addWeeklyGoal(arg)
    if (name === 'weekly-toggle') return toggleWeeklyGoal(arg && typeof arg === 'object' ? arg.id : arg)
    if (name === 'weekly-remove') return removeWeeklyGoal(arg && typeof arg === 'object' ? arg.id : arg)
    // ── 学科学习计划（批次 1.6）──────────────────────────────────────────
    if (name === 'plan-set') return setPlan(arg)
    if (name === 'plan-remove') return removePlan(arg && typeof arg === 'object' ? arg.subject : arg)
    // ── 归档（批次 2.1）：设置页那个按钮 / 自检的隔离模拟 ────────────────────
    if (name === 'archive-now') return archiveDoneTasks({})
    // ── 备份（2026-10-25 P2）：平时每天 21:00 自动备；这个口子是"我现在就想备一次" ──
    if (name === 'backup-now') return backupNow('手动')
    // ── 界面上「＋新增」一条任务（批次 2.2a）：走 info\task-add.mjs（同一套校验/去重/原子写）──
    if (name === 'task-add') {
      const a = arg && typeof arg === 'object' ? arg : {}
      const title = String(a.title || '').trim()
      if (!title) return { ok: false, error: '标题不能是空的' }
      if (MOCK) {
        // 假数据：不落盘，只把该有的形状回给页面（自检靠它验"表单这条路通"）
        return {
          ok: true,
          mock: true,
          action: 'created',
          task: {
            id: 'mock-add-1',
            title,
            kind: a.subject ? 'homework' : 'todo',
            status: 'open',
            subjectName: a.subject ? String(a.subject) : null,
            dueAt: a.due ? `${a.due}T${String(a.time || '22:00')}:00+08:00` : null,
          },
        }
      }
      const argv = ['--title', title]
      if (a.subject) argv.push('--subject', String(a.subject))
      if (a.due) argv.push('--due', String(a.due))
      if (a.time) argv.push('--time', String(a.time))
      if (a.detail) argv.push('--detail', String(a.detail))
      const r = lastJson(runNode(TASK_ADD, argv, 30000)) || {}
      if (r && r.ok) {
        log(`界面加了任务：${(r.task && r.task.title) || title}（${r.action || '?'}）→ ${(r.task && r.task.dueAt) || '没写 DDL'}`)
        try {
          runNode(STUDY_LITE, ['--refresh'], 25000)
        } catch {}
      } else {
        log('界面加任务失败：' + ((r && r.error) || '未知原因'))
      }
      return r
    }
    if (name === 'mistake-add-simulate') {
      // 自检专用：在 out\mistake-selftest 造一个"假错题本 + 假排版脚本"，验
      //   ① 预览模式不动正式 docx ② --apply 会备份旧 docx 再覆盖 ③ 轮次没被打回 ④ 序号接着排
      const root = join(OUT, 'mistake-selftest')
      const gen = join(root, '新建', '_AURORA工作区', '错题本生成器')
      try {
        mkdirSync(gen, { recursive: true })
        mkdirSync(join(root, '新建'), { recursive: true })
        writeJson(join(gen, 'entries.json'), {
          summary: { heading: '错因分布小结（自检）', lines: ['粗心 1（自检）｜审题 1（自检）'] },
          entries: [
            {
              title: '01｜2026-10-07（周三）· 假课 · 样例题 第 3 题',
              rows: [
                ['① 日期时间 · 科目/来源', '2026-10-07（周三）· 假课 · 样例测验 · 第 3 题'],
                ['② 错误题目（完整原文）', ['题干第一行', '题干第二行']],
                ['③ 我的选项 / 正确选项', '我选 B；正确 C'],
                ['④ 错因', '把"同一批材料"误读成"同一批人"。'],
                ['⑤ 方案', ['先找限定词', '再排除']],
              ],
            },
          ],
        })
        writeJson(join(gen, 'reminder.json'), { title: 'REMINDER', subtitle: '', intro: [], sections: [] })
        // ⚠️ 上一轮自检留下的 round-state.json 里记着序号水位（seqHighWater），不清掉的话
        //    这一轮记的就不是第 2 条而是第 4 条（断言会冤枉代码）
        for (const leftover of ['round-state.json', 'entries.removed.json']) {
          try {
            const f = join(gen, leftover)
            if (existsSync(f)) unlinkSync(f)
          } catch {}
        }
        writeFileSync(
          join(gen, 'make_cuotiben.js'),
          'const fs=require("fs"),p=require("path");' +
            'const O=process.env.CUOTIBEN_OUT||p.join(__dirname,"..","..","错题本.docx");' +
            'fs.writeFileSync(O,"STUB-DOCX "+require("./entries.json").entries.length+"\\n","utf8");' +
            'console.log("WROTE",O);\n',
          'utf8',
        )
        writeFileSync(join(root, '新建', '错题本.docx'), 'OLD-DOCX', 'utf8')
      } catch (err) {
        return { ok: false, error: '搭夹具失败：' + ((err && err.message) || err) }
      }
      const previewOut = join(OUT, 'mistake-selftest-preview.docx')
      const one = lastJson(
        runNode(
          MISTAKE_ADD,
          ['--data-root', root, '--out', previewOut, '--subject', 'bio', '--question', '自检题干\n第二行', '--mine', 'B', '--right', 'C', '--cause', '把分母看成分子', '--solutions', '先圈出要求的那一项\n再看式子'],
          90000,
        ),
      )
      const realAfterPreview = existsSync(join(root, '新建', '错题本.docx')) ? readFileSync(join(root, '新建', '错题本.docx'), 'utf8') : ''
      const applied = lastJson(runNode(MISTAKE_ADD, ['--data-root', root, '--subject', 'econ', '--question', '自检：apply 那条', '--apply'], 90000))
      // 状态文件要在**两次都跑完**以后再读（第一次跑完时水位还只是 2）
      const stateFile = readJson(join(gen, 'round-state.json')) || {}
      const realAfterApply = existsSync(join(root, '新建', '错题本.docx')) ? readFileSync(join(root, '新建', '错题本.docx'), 'utf8') : ''
      const backupDir = join(root, '新建', '_AURORA工作区', '备份')
      const backups = existsSync(backupDir) ? readdirSync(backupDir) : []
      const entriesNow = readJson(join(gen, 'entries.json')) || {}
      return {
        ok: true,
        root,
        one,
        applied,
        previewWritten: existsSync(previewOut),
        previewText: existsSync(previewOut) ? readFileSync(previewOut, 'utf8').trim() : '',
        realAfterPreview,
        realAfterApply,
        backups,
        round: stateFile.state ? stateFile.state.round : null,
        seqHighWater: stateFile.state ? stateFile.state.seqHighWater : null,
        entryCount: Array.isArray(entriesNow.entries) ? entriesNow.entries.length : 0,
        backupFile: one ? one.backup : null,
      }
    }
    if (name === 'task-add-simulate') {
      // 自检专用：在 out\task-add-selftest 里真跑两次脚本（含"同一秒连加两条 id 也不许撞"）
      const dir = join(OUT, 'task-add-selftest')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {}
      try {
        if (existsSync(join(dir, 'tasks.json'))) unlinkSync(join(dir, 'tasks.json'))
      } catch {}
      const one = lastJson(
        runNode(
          TASK_ADD,
          ['--data', dir, '--title', '自检：界面加的一条', '--subject', 'bio', '--due', '2026-11-02', '--time', '22:00', '--detail', '带科目和 DDL'],
          30000,
        ),
      )
      const two = lastJson(runNode(TASK_ADD, ['--data', dir, '--title', '自检：没科目的 to-do'], 30000))
      const after = readJson(join(dir, 'tasks.json'))
      const tasks = after && Array.isArray(after.tasks) ? after.tasks : []
      return {
        ok: true,
        dir,
        file: join(dir, 'tasks.json'),
        one,
        two,
        count: tasks.length,
        ids: tasks.map((t) => t.id),
        uniqueIds: new Set(tasks.map((t) => t.id)).size,
        kinds: tasks.map((t) => t.kind),
        dueAts: tasks.map((t) => t.dueAt || null),
        subjects: tasks.map((t) => t.subjectId || null),
      }
    }    if (name === 'archive-simulate') {
      // 自检专用：在 out\archive-selftest 造一个小数据目录，验
      //   "干跑不动数据" / "满一周的挪走、没满的留着" / "不真删（archive.jsonl 里还在）"
      const dir = join(OUT, 'archive-selftest')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {}
      const ago = (n) => new Date(Date.now() - n * 86400000).toISOString()
      writeJson(join(dir, 'tasks.json'), {
        version: 1,
        tasks: [
          { id: 'arch-old', title: '自检：十天前做完的', kind: 'homework', status: 'done', subjectId: 'biology', createdAt: ago(11), updatedAt: ago(10) },
          { id: 'arch-new', title: '自检：昨天做完的', kind: 'homework', status: 'done', subjectId: 'biology', createdAt: ago(2), updatedAt: ago(1) },
          { id: 'arch-open', title: '自检：还没做完的', kind: 'todo', status: 'open', createdAt: ago(3), updatedAt: ago(3) },
        ],
      })
      try {
        if (existsSync(join(dir, 'tasks.archive.jsonl'))) unlinkSync(join(dir, 'tasks.archive.jsonl'))
      } catch {}
      const dryRun = lastJson(runNode(ARCHIVE_TOOL, ['--data', dir, '--days', '7'], 30000))
      const afterDry = readJson(join(dir, 'tasks.json'))
      const dryIds = afterDry && Array.isArray(afterDry.tasks) ? afterDry.tasks.map((t) => t.id) : []
      const applied = lastJson(runNode(ARCHIVE_TOOL, ['--data', dir, '--days', '7', '--apply'], 40000))
      const afterApply = readJson(join(dir, 'tasks.json'))
      const keptIds = afterApply && Array.isArray(afterApply.tasks) ? afterApply.tasks.map((t) => t.id) : []
      const archPath = join(dir, 'tasks.archive.jsonl')
      const archText = existsSync(archPath) ? readFileSync(archPath, 'utf8') : ''
      return {
        ok: true,
        dir,
        dry: dryRun,
        applied,
        dryKeptAll: dryIds.length === 3,
        dryIds,
        keptIds,
        archiveLines: archText.trim() ? archText.trim().split(/\r?\n/).length : 0,
        archiveHasOld: /自检：十天前做完的/.test(archText),
        archiveHasNew: /自检：昨天做完的/.test(archText),
      }
    }
    if (name === 'remind-now') {
      // "现在查一遍"（设置页的按钮 / 自检）
      const r = await remindTick({})
      return r
    }
    if (name === 'learn-note') {
      // 记一条经验（设置页/她自己的对话都能调）
      const a = arg && typeof arg === 'object' ? arg : { lesson: String(arg || '') }
      return learnNote(a)
    }
    if (name === 'learn-digest') {
      // 把经验本炼一遍（force：不看 mtime 令牌）
      return learnDigest(arg === 'force' || arg === true)
    }
    if (name === 'summary-generate') {
      const a = arg && typeof arg === 'object' ? arg : {}
      return generateSummary(String(a.date || todayKey()))
    }
    if (name === 'summary-write') {
      const a = arg && typeof arg === 'object' ? arg : {}
      return writeSummary(String(a.date || todayKey()), a.text, 'master')
    }
    if (name === 'remind-ack') {
      // 「知道了」：收掉这条提醒，弹下一条
      return ackReminder()
    }
    if (name === 'remind-snooze') {
      // 「稍后 N 分钟」：到点会再说一次（台账里记"什么时候之后才允许再说"）
      const a = arg && typeof arg === 'object' ? arg : {}
      return snoozeReminder({ key: a.key, minutes: a.minutes })
    }
    if (name === 'notify-test') {
      // "试一下通知"：让主人自己确认系统通知是不是真能弹（Windows 的专注助手会挡）
      notifyDesktop('试一下通知', '你要是看到这条，说明通知这条路是通的')
      const line = '通知试一下，你看见了吗？'
      if (!MOCK) petControl({ say: line, mood: 'happy' })
      speakBubble(line)
      log('试了一下桌面通知')
      return { ok: true, supported: (() => { try { return Notification.isSupported() } catch { return false } })() }
    }
    if (name === 'remind-simulate') {
      // 自检用：假一个"现在"和一条假待办，跑两次 tick —— 验"会提醒"和"不重复提醒"
      const a = arg && typeof arg === 'object' ? arg : {}
      const mins = Number.isFinite(Number(a.inMinutes)) ? Number(a.inMinutes) : 25
      let now = new Date()
      // nowAt: '23:40' → 把"现在"假成今天这个时刻（用来验跨零点）
      const at = /^(\d{1,2}):(\d{2})$/.exec(String(a.nowAt || ''))
      if (at) {
        now = new Date()
        now.setHours(Number(at[1]), Number(at[2]), 0, 0)
      }
      const due = new Date(now.getTime() + mins * 60000)
      const p2 = (v) => String(v).padStart(2, '0')
      const fake = {
        id: 'sim-' + String(a.tag || 'remind'),
        title: String(a.title || '自检：模拟作业'),
        kind: 'homework',
        status: 'open',
        subjectName: '自检',
        dueDate: `${due.getFullYear()}-${p2(due.getMonth() + 1)}-${p2(due.getDate())}`,
        dueTime: `${p2(due.getHours())}:${p2(due.getMinutes())}`,
        overdue: false,
      }
      const opts = { now, tasks: [fake], classNow: null }
      if (a.inClass === true) opts.classNow = { label: '自检：假装在上课' }
      // 每日提醒也走同一条路（批次 1.4）：把一条"到 N 分钟后"的提醒塞进去，看它会不会响
      let dailyFake = null
      if (a.daily) {
        const at2 = new Date(now.getTime() + mins * 60000)
        dailyFake = {
          id: 'sim-daily-' + String(a.tag || 'daily'),
          title: String((a.daily && a.daily.title) || '自检：每日提醒'),
          time: `${p2(at2.getHours())}:${p2(at2.getMinutes())}`,
          days: [],
          enabled: true,
        }
        opts.daily = [dailyFake]
        opts.tasks = []
      }
      const first = await remindTick(opts)
      const second = await remindTick(opts)
      return { ok: true, task: fake, daily: dailyFake, nowAt: `${p2(now.getHours())}:${p2(now.getMinutes())}`, first, second }
    }
    if (name === 'run-helper') {
      // 设置页里的工具（原来在右键菜单里）：读钉钉 / 备份
      const a = arg && typeof arg === 'object' ? arg : {}
      const script = String(a.script || '')
      if (!script || script.includes('..') || /[\\/]/.test(script)) return { ok: false, error: '脚本名不合法' }
      runHelper(script, Array.isArray(a.args) ? a.args.map(String) : [], String(a.label || script))
      return { ok: true, started: script }
    }
    if (name === 'reload-ui') {
      try {
        if (panelWin && !panelWin.isDestroyed()) panelWin.reload()
        if (win && !win.isDestroyed()) win.reload()
      } catch {}
      log('重新加载界面')
      return { ok: true }
    }
    if (name === 'open-legacy-float') {
      if (!existsSync(FLOAT_LAUNCH)) return { ok: false, error: '找不到 info\\launch.ps1' }
      try {
        spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', FLOAT_LAUNCH], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        log('打开旧浮窗（WinForms 备份）')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }
    if (name === 'quit-her') {
      // 关掉她 → 浮窗跟着关（win 的 close/closed 里统一收）
      log('主人从设置页点了「关掉她」')
      setTimeout(() => {
        try {
          if (win && !win.isDestroyed()) win.close()
        } catch {}
      }, 50)
      return { ok: true }
    }
    if (name === 'set-card-alpha') {
      const v = Number(arg)
      if (!Number.isFinite(v) || v < 0.55 || v > 1) return { ok: false, error: '只认 0.55 ~ 1' }
      const cur = readJson(UI_FILE) || {}
      writeJson(UI_FILE, Object.assign({}, cur, { cardAlpha: Math.round(v * 100) / 100 }))
      log('卡片不透明度 → ' + Math.round(v * 100) + '%')
      return { ok: true, cardAlpha: Math.round(v * 100) / 100 }
    }
    if (name === 'set-voice') {
      // 设置页：换个嗓子 / 换回本地 piper（写 info\tts\voice.json，不是主人的限制文件）
      return setVoiceConfig(arg)
    }
    // 语言开关（2026-10-25 P2）：follow / zh / en —— 写 _study-core\她的语言.json，brain 每轮读
    if (name === 'set-lang') return setLangMode(arg)
    // 2026-10-25 第 7 项：切形象包（本机试用可以给项目外的绝对路径）
    if (name === 'set-model-pack') return setModelPack(arg)
    // 2026-10-25 第 8 项：待机动作（她闲着时演哪个 motion）
    if (name === 'set-idle') {
      const want = String(arg || '').trim()
      const list = readModelMotions()
      if (want && !list.includes(want)) return { ok: false, error: '这个模型里没有这个动作：' + want, motions: list }
      return setLookItem('idle', want)
    }
    /**
     * 2026-10-25 M2：页面自己说的话（点她、菜单、她自己挑的一句）也让它念出来。
     * 以前这些只弹气泡不出声 —— 因为主进程那条"念稿"的路只接对话流式和脚本写的 say。
     */
    if (name === 'say') {
      const t = String((arg && arg.text) || arg || '').trim()
      if (t.length < 1) return { ok: false, error: '空的' }
      log(`（页面说的）念：${t.slice(0, 30)}`)
      speak(t)
      return { ok: true, spoke: t.slice(0, 40) }
    }
    if (name === 'set-speak') {
      const want = String(arg || '').toLowerCase()
      if (!['on', 'off'].includes(want)) return { ok: false, error: '只认 on / off' }
      if (MOCK) {
        ttsCacheSpeakAllowed(want === 'on')
        return { ok: true, mock: true, speakOn: want === 'on' }
      }
      if (!existsSync(SETTINGS_LITE)) return { ok: false, error: '找不到 info\\settings-lite.ps1' }
      try {
        const r = spawnSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SETTINGS_LITE, '-Set', '她的限制-说话.txt|allow_speak', want],
          { encoding: 'utf8', timeout: 20000, windowsHide: true },
        )
        ttsCacheSpeakAllowed(want === 'on')
        log(`声音 → ${want}（exit=${r.status}）`)
        return { ok: true, speakOn: want === 'on', detail: `${r.stdout || ''}${r.stderr || ''}`.slice(-200) }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }
    if (name === 'set-theme') return setTheme(String(arg || ''))
    if (name === 'speak') {
      // 「念这一页」：直接让她念（不走大脑，不花 token）
      const text = String(arg || '').trim()
      if (!text) return { ok: false, error: '没有可念的内容' }
      if (!voiceAllowed()) return { ok: false, error: '现在不该出声（allow_speak=off 或安静时段）' }
      speak(text)
      return { ok: true }
    }
    if (name === 'note') {
      const text = String(arg || '').trim()
      if (!text) return { ok: false, error: '空的' }
      if (MOCK) return { ok: true, mock: true }
      try {
        let prefix = ''
        try {
          const cur = existsSync(INBOX_FILE) ? readFileSync(INBOX_FILE, 'utf8') : ''
          if (cur && !cur.endsWith('\n')) prefix = '\r\n'
        } catch {}
        appendFileSync(INBOX_FILE, prefix + text + '\r\n', 'utf8')
        log('记进收件箱：' + text.slice(0, 40))
        return { ok: true, file: INBOX_FILE }
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) }
      }
    }
    if (name === 'process') {
      if (MOCK) return { ok: true, mock: true, created: [], leftForModel: [] }
      const raw = runNode(LOCAL_PROCESS, [], 40000)
      const r = lastJson(raw)
      log(`处理收件箱：本地建了 ${Array.isArray(r && r.created) ? r.created.length : '?'} 条，留给模型 ${Array.isArray(r && r.leftForModel) ? r.leftForModel.length : '?'} 条`)
      return {
        ok: r && r.error ? false : true,
        created: Array.isArray(r && r.created) ? r.created : [],
        leftForModel: Array.isArray(r && r.leftForModel) ? r.leftForModel : [],
        written: Array.isArray(r && r.written) ? r.written : [],
        error: r && r.error ? String(r.error) : undefined,
      }
    }
    if (name === 'model-size') {
      const h = Number(arg)
      if (!Number.isFinite(h) || h < 140 || h > 700) return { ok: false, error: '尺寸不合法：' + arg }
      currentModelH = Math.round(h)
      writeJson(MODEL_FILE, { modelHeight: currentModelH, at: new Date().toISOString() })
      log(`她的大小 → ${currentModelH}px（请窗口按新尺寸开）`)
      if (win && !win.isDestroyed()) {
        const u = `http://127.0.0.1:${port}/app?h=${currentModelH}&maxW=0.98`
        setTimeout(() => {
          try {
            markMeasured(false)
            win.loadURL(u)
            // 重载后按新的"她"改窗口尺寸
            setTimeout(() => measureAndFit().catch(() => {}), 2600)
          } catch {}
        }, 120)
      }
      return { ok: true, modelHeight: currentModelH }
    }
    if (name === 'open-drop-file') {
      const rel = String(arg || '')
      const safe = rel.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
      if (!safe || safe.includes('..')) return { ok: false, error: '文件名不合法' }
      const full = join(DROP_DIR, safe)
      if (!existsSync(full)) return { ok: false, error: '找不到：' + safe }
      shell.openPath(full)
      return { ok: true, opened: full }
    }
    if (name === 'open-path') {
      const kind = String(arg || '')
      // 2026-10-24 晚（批次 3.5 设置页补全）：备份目录 / 经验本
      if (kind === 'backups' || kind === 'learnbook') {
        const target = kind === 'backups' ? join(DATA_ROOT, '_备份') : join(DATA_ROOT, 'mystery', 'DSH', '她的经验本.txt')
        if (!existsSync(target)) return { ok: false, error: '找不到：' + target }
        shell.openPath(target)
        return { ok: true, opened: target }
      }
      if (kind === 'rules' || kind === 'limits' || kind === 'persona' || kind === 'memory' || kind === 'data' || kind === 'drop') {
        const target =
          kind === 'rules'
            ? join(DATA_ROOT, 'mystery', 'DSH', '她的规矩.txt')
            : kind === 'persona'
              ? join(DATA_ROOT, 'mystery', 'DSH', '她的人设.txt')
              : kind === 'memory'
                ? join(DATA_ROOT, 'mystery', 'DSH', '她的记忆.md')
                : kind === 'limits'
                  ? LOOK_RULES
                  : kind === 'drop'
                    ? DROP_DIR
                    : DATA_ROOT
        if (!existsSync(target)) return { ok: false, error: '找不到：' + target }
        shell.openPath(target)
        return { ok: true, opened: target }
      }
      openReport(kind)
      return { ok: true }
    }
    return { ok: false, error: '不认识的 action：' + name }
  })

  host = await ensureHost()
  setPort(host.port)
  if (!port) {
    log('宿主起不来（info/pet/serve.mjs）→ 退出')
    app.exit(3)
    return
  }
  log(`宿主端口 ${port}（自己起的=${host.started}）`)
  // 气泡说话要出声（第 4 条）：自检也要开，不然"气泡→语音"这条路自检验不到
  startBubbleWatch()

  if (SELFTEST) {
    await selfTest()
    return
  }
  buildTray()
  await createHerWindow()
  startHitPolling()
  startBubbleWatch()
  // 提醒：规则文件没有就先建一份（新文件，不动主人已有的规矩），然后起定时器
  ensureRemindRules()
  startReminders()
  startSummaryScheduler()
  startLearnLoop()
  // 已完成满一周的待办：归档（不真删）；启动 + 每 6 小时扫
  startArchiveScheduler()
  // 每天 21:00 自动备一次数据（2026-10-25 P2）：以前只有手动 + 归档前的自动备份
  startBackupScheduler()
  // 今天的打扮：她自己的脑子挑（挑不到就按日期兜底），不阻塞启动
  setTimeout(() => {
    const cur = todayLook()
    if (cur) void applyLook(cur.look)
    else void chooseLook({ reason: 'daily' })
  }, 4000)
}

/**
 * 命中的兜底（2026-10-23 主人：「还是会出现有时无法选中的情况（必须得点击任务栏里面的图标才能再点到）」）
 *
 * 真因：她的窗口默认 `setIgnoreMouseEvents(true, {forward:true})`，靠页面收到的 pointermove 回报
 * "现在算点在她身上"才放开鼠标。可**转发过来的鼠标事件不一定到**（窗口不是前台、刚 show、
 * 鼠标停在原地没动…）——一卡住就永远"点不到她"，点一下任务栏图标激活它才恢复。
 *
 * 所以加一道主进程自己的轮询：光标在她窗口里、而且正穿过去时 → 问页面"这一点算你的吗"
 * （页面回 her:hit）。两条路，坏一条还有另一条。
 */
let probeTick = null
/** 右键菜单被请求了几次（自检要验"右键形象也能弹菜单"这条路） */
let menuPopCount = 0
/** 上一次右键请求的时间（挡重复：一次物理右键会来两次） */
let lastMenuAt = 0
function startHitPolling() {
  if (probeTick) return
  probeTick = setInterval(() => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible()) return
      if (!win.webContents || win.webContents.isDestroyed()) return
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      if (!inside) {
        if (!ignoring) setIgnore(true)
        return
      }
      // 已经能吃鼠标了就不用问：页面那边的 pointermove 会把"离开她"报回来
      if (!ignoring) return
      win.webContents.send('her:probe', { x: p.x - b.x, y: p.y - b.y })
    } catch {}
  }, 150)
}

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
  // Windows 上要一个 AppUserModelID，Toast 通知才认这个应用（否则 new Notification() 静默失败）
  try {
    app.setAppUserModelId('com.dsh.her.desktop')
  } catch {}
  main().catch((err) => {
    log('启动失败：' + (err && err.message))
    app.exit(1)
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  try {
    if (tray) {
      tray.destroy()
      setTray(null)
    }
  } catch {}
})
