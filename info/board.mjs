/**
 * info\board.mjs —— ```board 画图块：解析 strokes + 从正文里剥掉（2026-10-25，P0-2）
 *
 * 背景：人设里写着她「讲题可以附一块 board 画图」，`info\brain.mjs` 的提示词也把格式写死了
 * （画布 860×560，每笔是 line / ellipse / text / pen 之一），但**新应用没有渲染器** ——
 * 那段 JSON 会原样显示在聊天气泡里、还会被 TTS 一个字一个字念出来（"大括号 引号 strokes…"）。
 *
 * 这个文件管三件事（brain.mjs 和 apps\desktop\main.mjs 共用，纯 ESM、没有副作用，能单独测）：
 *   1. `splitBoardBlocks(text)`  整段处理：拿回 { text: 剥干净的正文, board: {strokes} | null }
 *   2. `makeBoardBroom()`        流式处理：一个 ```board 块可能被拆在好几个 delta 里，
 *                                遇到 ```board 先攒着，等收尾的 ``` 到了再一次性抠出来
 *   3. `normalizeStrokes(raw)`   把模型给的 JSON 收成"能直接画"的形状（越界坐标夹回来、脏笔画丢掉）
 *
 * ⚠️ 只认 ```board / ~~~board 这一种围栏；普通 ```js 之类一个字都不动。
 * ⚠️ 安全阀：攒了 6000 字还没等到收尾围栏 → 当成普通正文吐出去（不能把回复卡死）。
 */

/** 收尾围栏：``` 或 ~~~（允许后面跟空格） */
const FENCE_CLOSE_RE = /\n[ \t]*(?:```|~~~)[ \t]*(?:\n|$)/
/** 开头围栏（大小写不敏感；允许 ```board 后面跟空格） */
const FENCE_OPEN_RE = /^(?:```|~~~)[ \t]*board[ \t]*\r?\n/i

/** 画布尺寸（跟 brain.mjs 提示词里写给模型的一致） */
export const BOARD_W = 860
export const BOARD_H = 560
/** 最多几笔（提示词里写的是 8；这里放宽到 16，别让她的画突然消失） */
export const BOARD_MAX_STROKES = 16

/** 允许的颜色（模型爱写 black/red/blue；也允许简单 #rrggbb，别的颜色一律换成 black） */
const COLOR_RE = /^(?:black|red|blue|green|orange|purple|brown|gray|grey|white|yellow|pink|cyan|magenta|#(?:[0-9a-f]{3}|[0-9a-f]{6}))$/i

function clampNum(v, lo, hi, dft) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dft
  return Math.max(lo, Math.min(hi, n))
}

function cleanColor(c) {
  const s = String(c == null ? '' : c).trim()
  if (s && COLOR_RE.test(s)) return s.toLowerCase()
  return 'black'
}

/**
 * 把模型吐出来的东西收成能直接画的笔画列表。
 * 接受 `{strokes:[...]}`、直接一个数组、甚至被包了一层的 JSON 字符串。
 * @param {any} raw
 * @returns {{ tool: string, color: string, x1?: number, y1?: number, x2?: number, y2?: number, x?: number, y?: number, text?: string, points?: number[][], width?: number }[]}
 */
export function normalizeStrokes(raw) {
  let data = raw
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch {
      return []
    }
  }
  if (data && !Array.isArray(data) && Array.isArray(data.strokes)) data = data.strokes
  if (data && !Array.isArray(data) && data.board && Array.isArray(data.board.strokes)) data = data.board.strokes
  if (!Array.isArray(data)) return []
  const out = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const tool = String(item.tool || item.type || '').trim().toLowerCase()
    const color = cleanColor(item.color)
    if (tool === 'line') {
      out.push({
        tool,
        color,
        x1: clampNum(item.x1, 0, BOARD_W, 0),
        y1: clampNum(item.y1, 0, BOARD_H, 0),
        x2: clampNum(item.x2, 0, BOARD_W, 0),
        y2: clampNum(item.y2, 0, BOARD_H, 0),
      })
    } else if (tool === 'ellipse' || tool === 'rect' || tool === 'circle') {
      out.push({
        tool: tool === 'circle' ? 'ellipse' : tool,
        color,
        x1: clampNum(item.x1, 0, BOARD_W, 0),
        y1: clampNum(item.y1, 0, BOARD_H, 0),
        x2: clampNum(item.x2, 0, BOARD_W, 0),
        y2: clampNum(item.y2, 0, BOARD_H, 0),
      })
    } else if (tool === 'text') {
      const text = String(item.text == null ? '' : item.text).trim().slice(0, 120)
      if (!text) continue
      out.push({
        tool,
        color,
        x: clampNum(item.x, 0, BOARD_W, 0),
        y: clampNum(item.y, 0, BOARD_H, 0),
        text,
      })
    } else if (tool === 'pen') {
      const pts = Array.isArray(item.points) ? item.points : []
      const points = []
      for (const p of pts) {
        if (Array.isArray(p) && p.length >= 2) {
          points.push([clampNum(p[0], 0, BOARD_W, 0), clampNum(p[1], 0, BOARD_H, 0)])
        } else if (p && typeof p === 'object') {
          points.push([clampNum(p.x, 0, BOARD_W, 0), clampNum(p.y, 0, BOARD_H, 0)])
        }
      }
      if (points.length < 2) continue
      out.push({ tool, color, width: clampNum(item.width, 1, 12, 3), points })
    }
    if (out.length >= BOARD_MAX_STROKES) break
  }
  return out
}

/** 把整块（围栏里的那些字）解析成 strokes；解析不出来就当没有这块图（正文里也不留它） */
function parseBoardBody(body) {
  const strokes = normalizeStrokes(String(body || '').trim())
  return strokes.length > 0 ? { strokes } : null
}

/**
 * 流式"扫把"：```board 块可能被拆在好几个 delta 里。
 * 用法：每来一段 delta 就 feed 一次，拿回"能立刻显示的正文"；最后 flush 一次。
 */
export function makeBoardBroom() {
  let pending = ''
  let inBlock = false
  let body = ''
  let board = null
  return {
    feed(chunk) {
      pending += String(chunk == null ? '' : chunk)
      let text = ''
      for (;;) {
        if (!inBlock) {
          const open = pending.indexOf('```')
          const openT = pending.indexOf('~~~')
          const at = open < 0 ? openT : openT < 0 ? open : Math.min(open, openT)
          if (at < 0) {
            // 没有围栏：但如果尾巴可能是半个 "``"，先留 2 个字符攒着
            if (pending.length > 2) {
              text += pending.slice(0, pending.length - 2)
              pending = pending.slice(pending.length - 2)
            }
            break
          }
          text += pending.slice(0, at)
          pending = pending.slice(at)
          // 开头那行得完整才知道是不是 board（```board\n）
          const nl = pending.indexOf('\n')
          if (nl < 0) {
            if (pending.length > 40) {
              text += pending
              pending = ''
            }
            break
          }
          const head = pending.slice(0, nl + 1)
          if (FENCE_OPEN_RE.test(head)) {
            inBlock = true
            body = ''
            pending = pending.slice(nl + 1)
          } else {
            // 不是画图块：原样吐出去（普通代码块不动）
            text += head
            pending = pending.slice(nl + 1)
          }
          continue
        }
        // 在块里：等收尾围栏
        const close = FENCE_CLOSE_RE.exec(pending)
        if (close) {
          body += pending.slice(0, close.index + 1)
          pending = pending.slice(close.index + close[0].length)
          inBlock = false
          const parsed = parseBoardBody(body)
          if (parsed) board = parsed
          body = ''
          continue
        }
        if (pending.length > 6000) {
          // 安全阀：太久没等到收尾 → 当普通正文吐出去
          text += pending
          pending = ''
          inBlock = false
          body = ''
          break
        }
        break
      }
      return text
    },
    /** 收尾：把还攒着的那点吐完（没闭合的 board 块就当普通正文，内容不丢） */
    flush() {
      let tail = ''
      if (inBlock) tail += body + pending
      else tail += pending
      pending = ''
      body = ''
      inBlock = false
      return tail
    },
    get board() {
      return board
    },
    get inBlock() {
      return inBlock
    },
  }
}

/**
 * 整段处理（不流式的地方用：气泡文案、念稿、会话文件）。
 * @param {string} text
 * @returns {{ text: string, board: { strokes: any[] } | null }}
 */
export function splitBoardBlocks(text) {
  const broom = makeBoardBroom()
  const clean = broom.feed(text) + broom.flush()
  return { text: clean, board: broom.board }
}

/** 只要正文、不要画（念稿 / 存会话 / 老数据兜底） */
export function stripBoardBlocks(text) {
  return splitBoardBlocks(text).text
}
