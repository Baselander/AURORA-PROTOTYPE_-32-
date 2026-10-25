/**
 * info/pet/serve.mjs —— 桌宠本体的「自己的宿主」（2026-10-22，模型/浮窗分离第一块）
 *
 * 原版（github.com/Andersen216/dsh-whale-girl-live2d）是一个 **DSH 插件**：页面固定向
 * `/dsh-pet/events` 开 SSE，由 DSH 的 agent 事件驱动她"跟着干活"。我们不再跑 DSH，
 * 所以这里**把宿主那一层自己实现掉**：
 *
 *   GET  /                    → 桌宠页面（透明、铺满窗口）
 *   GET  /dsh-pet/pet.js      → 原版 pet.js（前面注入 window.__DSH_PET_BOOT__）
 *   GET  /dsh-pet/vendor/*    → pixi / cubism 运行时
 *   GET  /dsh-pet/model/*     → AURORA模型（c_0120）
 *   GET  /dsh-pet/events      → SSE：hello + 之后的事件（把她当成"agent 在干活"来喂）
 *   POST /dsh-pet/control     → 直接发一条 control 事件（表情/动作/说话/道具）
 *   GET  /dsh-pet/health      → { ok, clients, port }
 *
 * 事件从哪来（两种，都只追加）：
 *   ① 别的进程（brain / 脚本）往 `out/pet-events.jsonl` 追加一行 JSON → 这里每 250ms 增量读出去广播；
 *   ② 直接 POST /dsh-pet/control。
 *
 * 事件格式（原版认的）：{ "t":"turn-start" } / { "t":"delta","text":"…" } / { "t":"turn-end","ok":true }
 *   / { "t":"user","text":"…" } / { "t":"control","mood":"happy","expression":"星星眼","motion":"selfie","say":"…" }
 *
 * 用法：node info/pet/serve.mjs [--port 8790] [--root <项目根>]
 * 退出：Ctrl+C / 进程被杀；端口信息写到 `out/pet-port.json`（壳子/脚本据此找它）。
 */

import http from 'node:http'
import { existsSync, readFileSync, statSync, createReadStream, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const PROJECT_ROOT = resolve(opt('root', DEFAULT_ROOT))
const PORT = Number.parseInt(opt('port', process.env.DSH_PET_PORT || '8790'), 10)
const PET_ROOT = join(PROJECT_ROOT, 'info', 'pet')
const ASSETS = join(PET_ROOT, 'assets')
/** 我们自己的应用页（apps\desktop\renderer）——她只是这一页里的"渲染层"，界面是我们的。 */
const APP_DIR = join(PROJECT_ROOT, 'apps', 'desktop', 'renderer')
const OUT_DIR = join(PROJECT_ROOT, 'out')
const EVENTS_FILE = join(OUT_DIR, 'pet-events.jsonl')
const PORT_FILE = join(OUT_DIR, 'pet-port.json')

/**
 * control 事件的默认持续时间（毫秒）。pet.js 自己的默认是 5000，一眨眼就没了
 * （主人 2026-10-23：「平时形象的状态（表情和动作）持续时间过短」）。
 * 想换口径只改这一行：气泡留 18 秒，表情也跟着留 18 秒；下一条 control 来了照样立刻顶掉。
 */
const CONTROL_HOLD_MS = 18000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
  '.moc3': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

/** 事件流客户端（每个 SSE 连接一个 res）。 */
const clients = new Set()
let seq = 0

function send(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    clients.delete(res)
  }
}

function broadcast(payload) {
  seq += 1
  const event = { ...payload, seq }
  for (const res of [...clients]) send(res, event)
}

/** 安全地拼静态文件路径：只允许 PET_ROOT 里的文件。 */
function safeJoin(base, rel) {
  const cleaned = decodeURIComponent(rel).replace(/^\/+/, '').replace(/\\/g, '/')
  const abs = resolve(base, cleaned)
  if (abs !== base && !abs.startsWith(base + sep)) return null
  return abs
}

function serveFile(res, abs, headers = {}) {
  if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(statSync(abs).size),
    'Cache-Control': 'no-cache',
    ...headers,
  })
  createReadStream(abs).pipe(res)
}

/**
 * `?h=380&maxW=0.98` 的注入脚本：**在她自己的脚本跑之前**把大小写进她的存档
 * （localStorage 键 `dsh-live2d-pet:layout`）。
 *   · h     = 她多大（pet.js 的 layout.height，单位 CSS 像素）
 *   · maxW  = pet.js 里 CFG.maxWidthRatio（原版 0.5 会把她在窄窗口里压小一半）
 *
 * 为什么不放在 Electron 壳子的 preload 里写：preload 跑的时候 localStorage 不一定就绪，
 * 而且这是我们自己的页面，直接塞一段内联脚本最稳（踩过：写了没生效，她还是 261×227）。
 * 现在两处都用它：`/`（原版桌宠页）和 `/app`（我们自己的应用页）。
 */
function layoutSeedScript(params) {
  const h = Number(params.get('h'))
  const maxW = Number(params.get('maxW'))
  const patch = {}
  if (Number.isFinite(h) && h >= 100) patch.height = Math.round(h)
  const cfg = {}
  if (Number.isFinite(maxW) && maxW > 0 && maxW <= 1) cfg.maxWidthRatio = maxW
  if (!Object.keys(patch).length && !Object.keys(cfg).length) return ''
  return `<script>(function(){try{
  var K='dsh-live2d-pet:layout';
  var cur={}; try{cur=JSON.parse(localStorage.getItem(K)||'{}')||{}}catch(e){cur={}}
  var p=${JSON.stringify(patch)}, c=${JSON.stringify(cfg)};
  for (var k in p) cur[k]=p[k];
  cur.cfg=Object.assign({},cur.cfg||{},c);
  localStorage.setItem(K,JSON.stringify(cur));
}catch(e){}})();</script>`
}

function indexHtml(params) {
  const seed = layoutSeedScript(params)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>她 · 桌宠</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  body { --dsh-pet-standalone: 1; }
</style>
</head>
<body>${seed}
<script>window.__DSH_PET_BOOT__ = { config: {}, version: 'local-serve', desktop: true, port: ${PORT} };</script>
<script src="/dsh-pet/pet.js"></script>
</body>
</html>`
}

/**
 * 我们自己的应用页：`apps\desktop\renderer\index.html`（里面有 `<!--HER-SEED-->` 占位）。
 * 为什么要从这儿出而不是 file://：pet.js 从 `/dsh-pet/*` 取模型、从 `/dsh-pet/events` 取事件，
 * 同源最省事；file:// 下 fetch json / WebGL 纹理都会撞同源限制。
 */
function appHtml(params) {
  const seed = layoutSeedScript(params)
  try {
    const raw = readFileSync(join(APP_DIR, 'index.html'), 'utf8')
    return raw.replace('<!--HER-SEED-->', seed)
  } catch (e) {
    return `<!doctype html><html><body style="font:14px sans-serif;color:#e7edff;background:#080a17;padding:20px">
apps\\desktop\\renderer\\index.html 读不到：${e && e.message}</body></html>`
  }
}

/** pet.js：原版正文 + 末尾补一次 boot（原版是"正文 + boot"拼在一起发的，保持一致）。 */
function petJs() {
  const body = readFileSync(join(ASSETS, 'pet.js'), 'utf8')
  const boot = `\n;window.__DSH_PET_BOOT__ = Object.assign(window.__DSH_PET_BOOT__ || {}, { config: {}, version: 'local-serve', desktop: true, port: ${PORT} });\n`
  return `${body}${boot}`
}

// ── 事件文件：增量读（只吃新增的行）──────────────────────────────────────────
let eventsOffset = 0
try {
  if (existsSync(EVENTS_FILE)) eventsOffset = statSync(EVENTS_FILE).size
} catch {}

function tailEvents() {
  if (!existsSync(EVENTS_FILE)) return
  let size = 0
  try {
    size = statSync(EVENTS_FILE).size
  } catch {
    return
  }
  if (size < eventsOffset) eventsOffset = 0 // 文件被截断/换掉
  if (size === eventsOffset) return
  try {
    const buf = readFileSync(EVENTS_FILE)
    const chunk = buf.subarray(eventsOffset)
    eventsOffset = size
    for (const raw of chunk.toString('utf8').split('\n')) {
      const line = raw.trim()
      if (line.length === 0) continue
      let obj = null
      try {
        obj = JSON.parse(line)
      } catch {
        continue // 坏行跳过
      }
      // 2026-10-25 主人：「工作简报还没删掉」——这里把 report 一律丢掉（POST /control 那条路已经拦了，
      //   但脚本可能直接往事件文件里写）。想彻底不要它，这是最后一道闸。
      if (obj && (obj.report !== undefined || obj.kind === 'report')) continue
      // 我们自己从 HTTP 写进文件的 control 已经广播过了，别弹两次
      if (obj && obj._fromHttp === true) continue
      broadcast(obj)
    }
  } catch {
    /* 读失败就下轮再来 */
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  // CORS（壳子/调试页可能从别的源来）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  if (path === '/' || path === '/dsh-pet' || path === '/dsh-pet/' || path === '/dsh-pet/standalone') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    res.end(indexHtml(url.searchParams))
    return
  }

  // ── 我们自己的应用页（新界面）：/app 与 /app/* ──────────────────────────────
  if (path === '/app' || path === '/app/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    res.end(appHtml(url.searchParams))
    return
  }
  if (path.startsWith('/app/')) {
    serveFile(res, safeJoin(APP_DIR, path.replace(/^\/app\/?/, '')))
    return
  }

  // ── 语音：把 out\tts 里的 wav 给页面（页面是 http 源，不能直接加载 file://）──────
  if (path.startsWith('/tts/')) {
    serveFile(res, safeJoin(join(OUT_DIR, 'tts'), path.replace(/^\/tts\/?/, '')))
    return
  }

  if (path === '/dsh-pet/pet.js') {
    try {
      const doc = petJs()
      res.writeHead(200, {
        'Content-Type': MIME['.js'],
        'Content-Length': String(Buffer.byteLength(doc)),
        'Cache-Control': 'no-store',
      })
      res.end(doc)
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`pet.js 读不到：${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }

  if (path.startsWith('/dsh-pet/vendor/')) {
    serveFile(res, safeJoin(join(ASSETS, 'vendor'), path.replace(/^\/dsh-pet\/vendor\/?/, '')))
    return
  }
  if (path.startsWith('/dsh-pet/model/')) {
    serveFile(res, safeJoin(join(ASSETS, 'model'), path.replace(/^\/dsh-pet\/model\/?/, '')))
    return
  }
  if (path === '/dsh-pet/config') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ enabled: true, height: 420 }))
    return
  }
  if (path === '/dsh-pet/health') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, clients: clients.size, port: PORT, eventsFile: EVENTS_FILE }))
    return
  }

  // ── SSE：事件流 ────────────────────────────────────────────────────────────
  if (path === '/dsh-pet/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    clients.add(res)
    send(res, { t: 'hello', status: 'idle' })
    req.on('close', () => clients.delete(res))
    return
  }

  // ── 控制：POST /dsh-pet/control ────────────────────────────────────────────
  if (path === '/dsh-pet/control' && req.method === 'POST') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        res.writeHead(400, { 'Content-Type': MIME['.json'] })
        res.end(JSON.stringify({ ok: false, error: 'body 不是 JSON' }))
        return
      }
      // 2026-10-25 主人：「头顶有时冒出一个叫收件箱/工作汇报的东西……要么融进聊天，要么舍弃」
      //   → 这里**不再放行 `report`**：脚本里那些汇报面板不会再弹（气泡 say 照旧）。
      //     信息都还在：今日页/任务页/设置页都能看到；真要看原文就开 out\ 里那三份报告。
      const allowed = ['mood', 'expression', 'motion', 'say', 'bubble', 'props', 'clearProps', 'attention', 'bubbleMs', 'look']
      const control = { t: 'control' }
      for (const key of allowed) if (body[key] !== undefined) control[key] = body[key]
      // 2026-10-23（主人：「平时形象的状态（表情和动作）持续时间过短」）：
      //   pet.js 那边的默认是 5000ms，一眨眼就过去了。这里给所有 control 一个更长的默认值：
      //   气泡留得住、脸上的表情也留得住（谁下一条 control 来了就顶掉，不会糊住）。
      if (control.bubbleMs === undefined) control.bubbleMs = CONTROL_HOLD_MS
      broadcast(control)
      // 2026-10-25（主人：「点她头上的聊天框还是没有语音，有的有、大部分没有」）：
      //   **根因**：主进程的 startBubbleWatch 只盯 `out\pet-events.jsonl`，而 HTTP 这条路
      //   以前只广播给 SSE 客户端、**从不写文件** → 脚本说的那些话她不会念。
      //   现在也落一行到事件文件（带 _fromHttp 标记，tailEvents 见到就跳过广播，不会弹两次）。
      try {
        appendFileSync(EVENTS_FILE, `${JSON.stringify({ ...control, _fromHttp: true })}\n`, 'utf8')
      } catch {}
      res.writeHead(200, { 'Content-Type': MIME['.json'] })
      res.end(JSON.stringify({ ok: true, clients: clients.size, sent: control }))
    })
    return
  }

  // 其它静态（NOTICE/AUTHORS 之类，方便查看授权）
  if (path.startsWith('/dsh-pet/')) {
    serveFile(res, safeJoin(PET_ROOT, path.replace(/^\/dsh-pet\/?/, '')))
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

// 事件文件轮询：250ms 一次，便宜
setInterval(tailEvents, 250).unref?.()
// SSE 心跳：每 15 秒一个注释行，保持连接
setInterval(() => {
  for (const res of [...clients]) {
    try {
      res.write(': ping\n\n')
    } catch {
      clients.delete(res)
    }
  }
}, 15000).unref?.()

server.listen(PORT, '127.0.0.1', () => {
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(PORT_FILE, JSON.stringify({ port: PORT, pid: process.pid, startedAt: new Date().toISOString() }, null, 1), 'utf8')
  } catch {}
  console.log(`[pet] 桌宠宿主已启动：http://127.0.0.1:${PORT}/`)
  console.log(`[pet] 事件文件：${EVENTS_FILE}`)
  console.log(`[pet] 端口信息：${PORT_FILE}`)
})

// 收到 SIGTERM 时把端口文件清掉（壳子据此判断"宿主不在了"）
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      if (existsSync(PORT_FILE)) {
        const info = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
        if (info.pid === process.pid) writeFileSync(PORT_FILE, JSON.stringify({ port: 0, pid: 0, stoppedAt: new Date().toISOString() }), 'utf8')
      }
    } catch {}
    process.exit(0)
  })
}

export { broadcast, appendEvent }

/** 给同进程/测试用：追加一条事件到队列文件并立刻广播。 */
function appendEvent(event) {
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8')
  } catch {}
  broadcast(event)
}
