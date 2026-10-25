/**
 * apps\desktop\main\tts.mjs —— 语音（Edge 在线 / piper 本地兜底）
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 里整段搬出来的（原样搬，一个字没改写逻辑）。
 * 规矩：**act() 名字和 her:* IPC 通道都在 main.mjs 里，这段只管"把字变成声音"**。
 *
 * 工厂式（createTts(deps)）：因为它要用主进程的 log / 窗口 / 路径 / 读配置的小工具，
 * 这些不能在这里 import（会绕成环），一律由 main.mjs 传进来。
 * deps = { log, sleep, readJson, writeJson, MOCK, INFO_DIR, OUT, TTS_DIR, TTS_SCRIPT,
 *          SPEAK_RULES, win（活引用，getter） }
 *
 * 关键背景（§31.56 / §31.57）：常驻的 Edge 进程跑久了会一直回 NoAudioReceived，
 * 所以这里"每合成 20 句主动换新进程"，并且进程刚起时请求排队、等 {"ok":true,"ready":true} 再发。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
// 方括号 = 控制模型 / 小括号 = 给人看；```board 画图块绝不能念出来
import { stripBracketControls } from '../../../info/brackets.mjs'
import { stripBoardBlocks } from '../../../info/board.mjs'

export function createTts(deps) {
  // 主进程传进来的东西（都在 main.mjs 里，不能在这里 import —— 会绕成环）
  const { log, sleep, readJson, writeJson, MOCK, INFO_DIR, OUT, TTS_DIR, TTS_SCRIPT, SPEAK_RULES } = deps
// ── 语音：她说的每一句都念出来（常驻 piper 服务）────────────────────────────
/** 现在能不能出声：读 `她的限制-说话.txt`（allow_speak / quiet_hours），10 秒缓存 */
let voiceCache = { at: 0, allowed: true }
function voiceAllowed() {
  const now = Date.now()
  if (now - voiceCache.at < 10000) return voiceCache.allowed
  let allowed = true
  try {
    if (existsSync(SPEAK_RULES)) {
      const text = readFileSync(SPEAK_RULES, 'utf8')
      for (const raw of text.split(/\r?\n/)) {
        const t = raw.trim()
        if (!t || t.startsWith('#')) continue
        const m1 = /^allow_speak\s*=\s*(.+)$/.exec(t)
        // 2026-10-22 深夜（主人：「声音直接改成要说话就会有、要调就只能关掉」）：
        //   **只看这个开关**，不再按 quiet_hours 自动闭嘴。想安静就关掉它。
        if (m1 && ['off', 'false', 'no', '关'].includes(m1[1].trim())) allowed = false
      }
    }
  } catch {}
  voiceCache = { at: now, allowed }
  return allowed
}

let ttsProc = null
let ttsSeq = 0
let speakMutedLogged = false
/** 刚念过的短句（8 秒内不重复；对话流和气泡共用 —— 修"念两遍"） */
const recentlySaid = new Map()

// ── 语音引擎：Edge（在线、更像人说话）↔ piper（本地离线兜底）──────────────────
/**
 * 主人 2026-10-24：「顺带把语音换成 edge 的（更自然一些）」
 *   · 配置在 `info\tts\voice.json`（engine / voice / rate / pitch）——**不是**主人的限制文件，随便改
 *   · Edge 要联网；连续失败 2 次就自动退回本地 piper（不至于一个字都念不出来）
 *   · 两个引擎走**同一条 stdin/stdout 管道**（edge_serve.py 照抄了 piper_serve.py 的协议），
 *     区别只有输出扩展名：edge → .mp3，piper → .wav（宿主 MIME 表两个都认）
 */
const EDGE_SCRIPT = join(INFO_DIR, 'tts', 'edge_serve.py')
const VOICE_CFG = join(INFO_DIR, 'tts', 'voice.json')
const VOICE_PRESETS = [
  { key: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温柔女声）' },
  { key: 'zh-CN-XiaoyiNeural', label: '晓伊（年轻女声）' },
  { key: 'zh-CN-XiaochenNeural', label: '晓辰（成熟女声）' },
  { key: 'zh-CN-YunxiNeural', label: '云希（少年男声）' },
]
let ttsEngineActive = null // 'edge' | 'piper'（自动降级后保持，不会一句话就换回去）
let ttsFailStreak = 0
/** 上一次发给语音服务的请求（Edge 进程失效时用它重发一次） */
let lastTtsReq = null
let ttsRetriedOnce = false
/** 我们自己在关这个进程（换嗓子）—— close 事件里据此区分"主动关"和"它自己挂了" */
let ttsStopping = false
/**
 * 2026-10-25（§31.56 的根因）：常驻的 Edge 进程**跑久了会失效**，一直回 NoAudioReceived；
 * 换一个全新进程立刻 12/12 成功（`node info\tts\warm-cache.mjs --force` 验过两遍）。
 * 所以这里不再"等它挂了再救"，改成两条：
 *   ① 每合成 N 句**主动换一个新进程**（TTS_RESTART_EVERY，默认 20；0 = 不换）
 *      —— 有请求还在飞的时候不换（不然那一句会被吞掉，既不报错也没音频）
 *   ② 进程刚起/刚换新时，请求**排进队列**，等它吐出 {"ok":true,"ready":true} 再发
 *      （以前靠固定 500ms，太快 → 那句就丢了，日志里既没音频也没失败）
 */
let ttsReady = false
/** 等着进程就绪才发出去的请求：[{ req, retried }] */
const ttsQueue = []
/** 这个进程已经成功合成多少句 */
let ttsSinceRestart = 0
/** 已经发出去、还没回话的请求数 */
let ttsInflight = 0
const TTS_RESTART_EVERY = (() => {
  const n = Number.parseInt(process.env.DSH_TTS_RESTART_EVERY || '20', 10)
  return Number.isFinite(n) && n >= 0 ? n : 20
})()

/**
 * 语音缓存（2026-10-25 主人：「把语音模型中念这段的直接录音保存，省的每次都生成了」）
 *   · 常用句（脚本日常话）预生成一次存 `out\tts\cache\<hash>.mp3`；以后说话先查缓存，命中就直接播
 *   · 键 = 文本的 hash（同句式同声音 = 同一个文件）
 *   · 只缓存**短句**（≤40 字、且是预录音清单里的），聊天回复不缓存（每句都不一样，缓存没意义）
 */
const TTS_CACHE = join(TTS_DIR, 'cache')
const DAILY_LINES = [
  '在的在的',
  '我盯着呢',
  '这题我先看一眼',
  '等我一下',
  '记下来了',
  '该喝水啦',
  '先吃饭还是先写？',
  '作业没写完不许玩',
  '我在，别怕',
  '收拾书包去',
  '今天也辛苦啦',
  '早点睡，明天还上课',
]
function ttsCachePath(text) {
  const key = createHash('sha1').update(String(text || '').trim()).digest('hex').slice(0, 16)
  return join(TTS_CACHE, key + '.mp3')
}
function readCacheIndex() {
  try {
    if (!existsSync(TTS_CACHE)) return []
    return readdirSync(TTS_CACHE).filter((f) => f.endsWith('.mp3'))
  } catch {
    return []
  }
}
/** 预录一遍日常话（会联网；一句话 1~2 秒） */
async function buildTtsCache() {
  if (!existsSync(EDGE_SCRIPT)) return { ok: false, error: '找不到 info\\tts\\edge_serve.py' }
  try {
    mkdirSync(TTS_CACHE, { recursive: true })
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  const p = ensureTts()
  if (!p) return { ok: false, error: '语音服务没起来' }
  // 要连着发 12 句：**先等它就绪**（不然头几句会排在队列里，甚至被挤掉）
  const ready = await waitTtsReady(15000)
  if (!ready) log('（语音缓存）等就绪超时，还是照发（排队的会自动补发）')
  const engine = ttsEngineActive || readVoiceConfig().engine
  const voice = readVoiceConfig().voice
  let done = 0
  let skipped = 0
  for (const line of DAILY_LINES) {
    const out = ttsCachePath(line)
    if (existsSync(out)) {
      skipped += 1
      continue
    }
    if (!ttsSend(engine === 'edge' ? { text: line, out, voice } : { text: line, out }, { quiet: true })) {
      return { ok: false, error: '给语音服务写不进去（进程起不来）' }
    }
    done += 1
    await sleep(260)
  }
  log(`语音缓存：排了 ${done} 句去合成（已有 ${skipped} 句），文件在 out\\tts\\cache`)
  return { ok: true, queued: done, skipped, dir: TTS_CACHE, lines: DAILY_LINES.length }
}

function readVoiceConfig() {
  const j = readJson(VOICE_CFG) || {}
  const want = String(process.env.DSH_TTS || j.engine || 'edge').toLowerCase()
  return {
    engine: want === 'piper' ? 'piper' : 'edge',
    voice: String(j.voice || 'zh-CN-XiaoxiaoNeural'),
    rate: String(j.rate || '+0%'),
    pitch: String(j.pitch || '+0Hz'),
    volume: String(j.volume || '+0%'),
  }
}

/** 换个嗓子 / 换个引擎（设置页那个按钮走这里）；换完下次说话就按新的来 */
function setVoiceConfig(arg) {
  const a = arg && typeof arg === 'object' ? arg : {}
  const cur = readVoiceConfig()
  const next = Object.assign({}, readJson(VOICE_CFG) || {}, cur)
  if (a.engine !== undefined) next.engine = String(a.engine).toLowerCase() === 'piper' ? 'piper' : 'edge'
  if (a.voice !== undefined) {
    const v = String(a.voice || '').trim()
    if (!v) return { ok: false, error: '音色名不能是空的' }
    next.voice = v
  }
  if (a.rate !== undefined) next.rate = String(a.rate)
  try {
    writeJson(VOICE_CFG, next)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  stopTts()
  const after = readVoiceConfig()
  log(`语音 → ${after.engine}${after.engine === 'edge' ? '（' + after.voice + '）' : '（本地 piper）'}`)
  return { ok: true, voice: after, presets: VOICE_PRESETS.map((p) => ({ ...p })) }
}

function stopTts() {
  ttsStopping = true
  ttsReady = false
  ttsInflight = 0
  if (ttsProc && !ttsProc.killed) {
    try {
      ttsProc.stdin.write(JSON.stringify({ quit: true }) + '\n')
    } catch {}
    try {
      ttsProc.kill()
    } catch {}
  }
  ttsProc = null
  ttsEngineActive = null
  ttsFailStreak = 0
  setTimeout(() => {
    ttsStopping = false
  }, 1200)
}

/** 真的把一行请求写进进程；写不进去就把进程当挂了（下次 ensureTts 会重起） */
function ttsWriteTo(p, req) {
  try {
    p.stdin.write(JSON.stringify(req) + '\n')
    ttsInflight += 1
    return true
  } catch (err) {
    log('给语音服务写不进去：' + ((err && err.message) || err))
    ttsProc = null
    ttsReady = false
    return false
  }
}

/**
 * 发一句去合成（所有地方都走这里，别再直接 p.stdin.write）：
 *   · 该换进程了（满 TTS_RESTART_EVERY 句、且没有在飞的请求）→ 先换，再排队
 *   · 进程还没就绪 → 排队，等 ready 事件到了自动补发（最多留 8 句，太旧的丢掉）
 */
function ttsSend(req, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  if (TTS_RESTART_EVERY > 0 && ttsSinceRestart >= TTS_RESTART_EVERY && ttsInflight === 0) {
    log(`Edge 已经合成 ${ttsSinceRestart} 句 → 主动换一个新进程（绕开长连接到期，§31.56）`)
    stopTts()
  }
  const p = ensureTts()
  if (!p) return false
  if (!ttsReady) {
    ttsQueue.push({ req, retried: !!o.retried })
    while (ttsQueue.length > 8) ttsQueue.shift()
    if (!o.quiet) log('语音进程刚起（还没 ready）→ 这句话先排着，就绪后自己发出去')
    return true
  }
  return ttsWriteTo(p, req)
}

/** 把排队的请求在"就绪"之后按顺序补发 */
function flushTtsQueue() {
  const list = ttsQueue.splice(0, ttsQueue.length)
  for (const item of list) {
    if (ttsProc && ttsReady) {
      try {
        ttsWriteTo(ttsProc, item.req)
      } catch {}
    }
  }
}

/** 等语音服务就绪（预录缓存那种"要连着发一串"的地方用；超时就返回 false，不卡死） */
function waitTtsReady(timeoutMs) {
  if (ttsReady && ttsProc && !ttsProc.killed) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + (Number(timeoutMs) || 8000)
    const tick = () => {
      if (ttsReady && ttsProc && !ttsProc.killed) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 120)
    }
    tick()
  })
}

function ensureTts() {
  if (ttsProc && !ttsProc.killed) return ttsProc
  const cfg = readVoiceConfig()
  // 自动降级后保持降级（不然断网时会每句都试一次 edge、每句都卡一下）
  const engine = ttsEngineActive || cfg.engine
  const script = engine === 'edge' ? EDGE_SCRIPT : TTS_SCRIPT
  if (!existsSync(script)) {
    if (engine === 'edge' && existsSync(TTS_SCRIPT)) {
      ttsEngineActive = 'piper'
      return ensureTts()
    }
    log(`没有 ${script} → 不出声`)
    return null
  }
  try {
    mkdirSync(TTS_DIR, { recursive: true })
    ttsProc = spawn('python', ['-u', script], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    log(`起 ${engine} 语音失败：` + ((err && err.message) || err))
    return null
  }
  const activeEngine = engine
  ttsEngineActive = engine
  const myProc = ttsProc
  // 新进程：还没就绪、计数清零（等它吐 ready 再发，见 ttsSend / flushTtsQueue）
  ttsReady = false
  ttsSinceRestart = 0
  ttsInflight = 0
  let buf = ''
  ttsProc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        let obj = null
        try {
          obj = JSON.parse(line)
        } catch {}
        if (obj && obj.ok && obj.ready) {
          ttsReady = true
          ttsSinceRestart = 0
          log(`${activeEngine} 语音服务就绪${obj.voice ? '（' + obj.voice + '）' : ''}`)
          // 排在队列里的（刚起进程时说的那些）现在补发
          flushTtsQueue()
        } else if (obj && obj.ok && obj.out) {
          ttsFailStreak = 0
          ttsInflight = Math.max(0, ttsInflight - 1)
          ttsSinceRestart += 1
          const name = String(obj.out).split(/[\\/]/).pop()
          try {
            if (deps.win && !win.isDestroyed()) win.webContents.send('her:tts', { ok: true, url: `/tts/${name}`, seconds: obj.seconds, engine: activeEngine })
          } catch {}
        } else if (obj && obj.ok === false) {
          ttsFailStreak += 1
          ttsInflight = Math.max(0, ttsInflight - 1)
          log(`${activeEngine} 合成失败（第 ${ttsFailStreak} 次）：` + (obj.error || ''))
          // 2026-10-25 实测：**常驻的 Edge 进程跑久了会失效**（一直 NoAudioReceived），
          //   换个新进程立刻 12/12 成功（`info\tts\warm-cache.mjs --force` 验过）。
          //   → 失败就杀掉旧进程、把刚才那句**排队**等新进程 ready 再发（只重发一次，避免死循环）。
          //   ⚠️ 以前用固定 500ms 重发，新进程还没就绪 → 那句既没音频也没第二条日志（§31.56 的坑）。
          if (activeEngine === 'edge' && lastTtsReq && !ttsRetriedOnce) {
            ttsRetriedOnce = true
            const req = lastTtsReq
            log('Edge 常驻进程失效 → 换新进程重发那句（这次等它就绪再发）')
            stopTts()
            ttsQueue.push({ req, retried: true })
            ensureTts() // 立刻起一个新的；它吐 ready 时 flushTtsQueue 会把这句补发出去
            setTimeout(() => {
              ttsRetriedOnce = false
            }, 8000)
          }
        }
      }
      nl = buf.indexOf('\n')
    }
  })
  ttsProc.stderr.on('data', (c) => {
    const t = c.toString('utf8').trim()
    if (t) log(`${activeEngine} stderr：` + t.slice(0, 200))
  })
  ttsProc.on('close', () => {
    // ⚠️ 只有"还是这个进程"才把 ttsProc 清掉：换嗓子时我们主动 kill 旧的、
    //    紧跟着又会起一个新的，不能让它被旧的 close 事件清成 null（那会念到一半哑掉）
    if (ttsProc === myProc) {
      ttsProc = null
      ttsReady = false
      ttsInflight = 0
    }
    if (ttsStopping) return
    // 没人叫它退，它自己没了 = Edge 这条路断了（断网 / 代理挂了 / 包出错）→ 退回本地 piper
    if (activeEngine === 'edge' && existsSync(TTS_SCRIPT)) {
      ttsEngineActive = 'piper'
      ttsFailStreak = 0
      log('Edge 语音这条路断了（可能没网）→ 自动退回本地 piper')
    }
  })
  log(`${engine === 'edge' ? 'edge 语音服务起来了（在线，第一句要等一会儿）' : 'piper 语音服务起来了（模型第一次加载要几秒）'}`)
  return ttsProc
}

/** 念一句：写一行 JSON 给合成服务，音频文件由宿主 /tts/ 路由给页面播 */
function speak(text) {
  // 念之前先剥两样：```board 画图块（里面是 JSON，绝不能念）＋ 方括号里的控制标记
  const say = stripBracketControls(stripBoardBlocks(String(text || ''))).text.trim()
  if (say.length < 2) return
  // ② 同一条文本 8 秒内只念一次：**对话流和头顶气泡共用这一张表**
  //   （主人 2026-10-25：「如果发消息会念两边同一段文字」—— 以前两边各去各的重，撞一起就念两遍）
  const dedupeKey = say.slice(0, 60)
  const nowMs = Date.now()
  const saidAt = recentlySaid.get(dedupeKey)
  if (saidAt && nowMs - saidAt < 8000) return
  recentlySaid.set(dedupeKey, nowMs)
  if (recentlySaid.size > 200) {
    for (const [k, t] of recentlySaid) if (nowMs - t > 60000) recentlySaid.delete(k)
  }
  if (!voiceAllowed()) {
    if (!speakMutedLogged) {
      speakMutedLogged = true
      log('现在不出声（allow_speak=off 或安静时段）')
    }
    return
  }
  if (MOCK) {
    // 假数据 / 自检：不真合成，但留一行痕迹 —— 自检靠它证明"气泡说的话真的走到语音那一步了"
    log('（假数据）本该念：' + say.slice(0, 30))
    return
  }
  ttsSeq += 1
  const engine = ttsEngineActive || readVoiceConfig().engine
  const ext = engine === 'edge' ? '.mp3' : '.wav'
  // ① 常用句先查缓存（预录过就直接播，不再合成）
  try {
    const cached = ttsCachePath(say)
    if (engine === 'edge' && existsSync(cached)) {
      const name = cached.split(/[\\/]/).pop()
      if (deps.win && !win.isDestroyed()) win.webContents.send('her:tts', { ok: true, url: `/tts/cache/${name}`, cached: true })
      return
    }
  } catch {}
  const out = join(TTS_DIR, `her-${Date.now()}-${ttsSeq % 1000}${ext}`)
  const req = { text: say, out }
  if (engine === 'edge') req.voice = readVoiceConfig().voice
  lastTtsReq = req // Edge 进程失效时用它重发（见 ensureTts 的失败分支）
  // 统一走 ttsSend：该换进程就换、没就绪就排队（见 TTS_RESTART_EVERY 的说明）
  ttsSend(req)
}

// ── 她头上的气泡也要出声（2026-10-23 主人："平时头上的对话框出现时不会出声"）───
/**
 * 她"自己开口"（brain 的 control{say}、菜单里的通知）走的是
 *   brain → out\pet-events.jsonl → 宿主 serve.mjs → 页面气泡
 * 这条路上**没有人去调语音**，所以她只张嘴不出声（对话页的流式回复是另一条路，那条会念）。
 * 这里盯着事件文件新长出来的行，见到带 say 的 control 就念一遍；同一句 25 秒内不重复念。
 */
const SPEAKED = new Map()
function speakBubble(text) {
  const raw = String(text || '').trim()
  // 方括号是给模型的指令，**不该念出来**（小括号是给人看的旁白，照念）
  // ```board 画图块同理：那是给界面画的，念出来就是"大括号 引号 strokes…"
  const say = stripBracketControls(stripBoardBlocks(raw)).text.trim()
  if (say.length < 2) return
  const key = say.slice(0, 80)
  const now = Date.now()
  const last = SPEAKED.get(key) || 0
  if (now - last < 25000) return
  SPEAKED.set(key, now)
  if (SPEAKED.size > 200) {
    for (const [k, t] of SPEAKED) if (now - t > 120000) SPEAKED.delete(k)
  }
  speak(say)
}

let bubbleWatch = null
function startBubbleWatch() {
  if (bubbleWatch) return
  const file = join(OUT, 'pet-events.jsonl')
  let offset = 0
  try {
    if (existsSync(file)) offset = statSync(file).size
  } catch {
    offset = 0
  }
  bubbleWatch = setInterval(() => {
    try {
      if (!existsSync(file)) return
      const size = statSync(file).size
      if (size < offset) offset = 0 // 被截断/轮转过
      if (size === offset) return
      const n = size - offset
      const buf = Buffer.alloc(n)
      const fd = openSync(file, 'r')
      try {
        readSync(fd, buf, 0, n, offset)
      } finally {
        closeSync(fd)
      }
      offset = size
      for (const raw of buf.toString('utf8').split('\n')) {
        const line = raw.trim()
        if (!line) continue
        let obj = null
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        if (obj && obj.t === 'control' && (obj.say || obj.bubble)) speakBubble(obj.say || obj.bubble)
      }
    } catch {}
  }, 400)
}
  return {
    // 主进程和设置页要用的那几样（名字照旧：main.mjs 里 destructure 之后，调用处一个字都不用改）
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
    VOICE_CFG,
    EDGE_SCRIPT,
    /** 现在真在用的引擎（自动降级到 piper 之后也是这个值） */
    activeEngine() {
      return ttsEngineActive || readVoiceConfig().engine
    },
    /** 主进程收工时把盯事件文件的那个定时器停掉 */
    stopBubbleWatch() {
      if (bubbleWatch) {
        clearInterval(bubbleWatch)
        bubbleWatch = null
      }
    },
    /** 设置页切「出声开/关」之后把这个缓存直接改掉（省得等 10 秒过期） */
    cacheSpeakAllowed(allowed) {
      voiceCache = { at: Date.now(), allowed: !!allowed }
    },
    /** 自检用：现在挂在哪个引擎上、合成过几句、进程活着没 */
    debug() {
      return {
        engine: ttsEngineActive,
        ready: ttsReady,
        proc: !!(ttsProc && !ttsProc.killed),
        sinceRestart: ttsSinceRestart,
        inflight: ttsInflight,
        queued: ttsQueue.length,
        failStreak: ttsFailStreak,
        restartEvery: TTS_RESTART_EVERY,
      }
    },
  }
}
