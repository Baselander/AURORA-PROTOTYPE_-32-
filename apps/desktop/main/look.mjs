/**
 * apps\desktop\main\look.mjs —— 她自己的打扮（穿什么 / 发型 / 情绪摆件）
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 整段搬出来（逻辑原样，一个判断都没改）。
 * 主人 2026-10-23：「模型自由度…她自己决定穿什么/发型」；
 * 2026-10-24 又加了「她自主 / 你选择」两种模式（master 模式下她不再自己换）。
 * 白名单 LOOK_GROUPS 就是 pet.js 里那些 PROPS/SCENES 的键。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function createLook (deps) {
  const { log, MOCK, SELFTEST, DATA_ROOT, INFO_DIR, OUT, existsSync, readFileSync, writeFileSync, join, spawn, petControl, readJson, writeJson, BRAIN, speakBubble, evalIn } = deps
// ── 她自己的打扮（2026-10-23 主人："模型自由度…她自己决定穿什么/发型"）──────────
/**
 * 能做到这件事的前提：这个模型自带一堆**可以一直挂着的装饰**（pet.js 的 PROPS/SCENES），
 * 白名单就在下面。她自己每天挑一组，记在 `_study-core\她的打扮.json`，下次启动还穿那一身；
 * 想换就右键「让她今天换一身」或设置页里点。
 */
const LOOK_FILE = `${DATA_ROOT}/_study-core/她的打扮.json`
/** 自检 / 假数据时写 out\ 里那份，绝不碰主人真数据目录 */
function lookFile() {
  return SELFTEST || MOCK ? join(OUT, 'her-look.mock.json') : LOOK_FILE
}
const LOOK_GROUPS = [
  { key: 'hair', label: '头发', items: [{ key: '', label: '照常' }, { key: 'ponytail', label: '单边马尾' }] },
  {
    key: 'headwear',
    label: '头饰',
    items: [
      { key: '', label: '不戴' },
      { key: 'headband', label: '发箍' },
      { key: 'flower', label: '情绪花花' },
      { key: 'whaleHat', label: '头顶鲸鱼' },
    ],
  },
  {
    key: 'sticker',
    label: '贴纸',
    items: [
      { key: '', label: '不贴' },
      { key: 'stickerCat', label: '猫猫贴纸' },
      { key: 'stickerRabbit', label: '兔兔贴纸' },
      { key: 'stickerBow', label: '蝴蝶结贴纸' },
    ],
  },
  {
    key: 'glasses',
    label: '眼镜',
    items: [
      { key: '', label: '不戴' },
      { key: 'glassesRound', label: '圆眼镜' },
      { key: 'glassesSquare', label: '方眼镜' },
      { key: 'glassesOval', label: '椭圆眼镜' },
      { key: 'glassesSun', label: '墨镜' },
    ],
  },
  {
    key: 'desk',
    label: '桌面',
    items: [
      { key: '', label: '原样' },
      { key: 'darkCloth', label: '深色桌布' },
      { key: 'whaleOnDesk', label: '鲸鱼放桌上' },
      { key: 'parfait', label: '桌面巴菲' },
    ],
  },
]
const LOOK_MOODS = ['neutral', 'happy', 'smug', 'playful', 'shy', 'excited', 'love']

function todayStr() {
  const d = new Date()
  const p = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function readLookFile() {
  const j = readJson(lookFile())
  return j && typeof j === 'object' ? j : null
}

/** 今天穿的这身（没有 / 不是今天的 → null，调用方决定要不要让她自己挑） */
function todayLook() {
  const j = readLookFile()
  if (!j || j.date !== todayStr()) return null
  return j
}

/**
 * 白名单校验：只留认得的 key。
 * 也认中文名 —— 她（大模型）有时候会老老实实回「单边马尾」而不是 `ponytail`，
 * 2026-10-24 实跑就撞上过：`why` 里说"扎个马尾、顶只鲸鱼"，可三个 key 全是空的。
 */
function sanitizeLook(look) {
  const out = {}
  for (const g of LOOK_GROUPS) {
    const raw = String((look && look[g.key]) || '').trim()
    if (!raw) {
      out[g.key] = ''
      continue
    }
    const byKey = g.items.find((i) => i.key === raw)
    const byLabel = g.items.find((i) => i.label === raw)
    const byLoose = g.items.find((i) => i.key && (raw.includes(i.key) || raw.includes(i.label)))
    out[g.key] = (byKey || byLabel || byLoose || { key: '' }).key
  }
  // 2026-10-25 第 8 项：待机动作（她闲着时演哪个 motion）。这里只收"安全名字"，
  //   真名字（是不是这个模型里有的动作）由 main.mjs 对着 manifest 再校一遍。
  const idleRaw = String((look && look.idle) || '').trim()
  out.idle = /^[A-Za-z0-9_-]{1,32}$/.test(idleRaw) ? idleRaw : ''
  return out
}

/** 把一身打扮发给她（clearProps 先摘干净，再挂上今天这身） */
function applyLook(look) {
  const props = {}
  // 2026-10-25 第 8 项：idle（待机动作）不是一个"戴在身上的道具"，它是动作组的名字，
  //   要单独走 DSHPet.setIdleMotion，不能混进 props 里（混进去会被当成表达式名）。
  for (const [k, v] of Object.entries(look || {})) {
    if (k === 'idle') continue
    if (v) props[v] = true
  }
  const out = petControl({ clearProps: true, props })
  const idle = String((look && look.idle) || '').trim()
  if (idle) {
    try {
      void evalIn(deps.win, `JSON.stringify(window.DSHPet.setIdleMotion(${JSON.stringify(idle)}))`, 8000)
    } catch {}
  }
  return out
}

/** 按日期定一份（她的大脑不可用时的兜底：稳定、每天不一样、不会是烂值） */
function fallbackLook(dateStr) {
  let h = 0
  for (const ch of String(dateStr)) h = (h * 31 + ch.charCodeAt(0)) % 100000
  const pick = (arr, salt) => arr[(h + salt) % arr.length]
  return {
    look: {
      hair: pick(['', 'ponytail'], 1),
      headwear: pick(['', '', 'headband', 'flower', 'whaleHat'], 3),
      sticker: pick(['', '', 'stickerCat', 'stickerRabbit', 'stickerBow'], 7),
      glasses: pick(['', '', '', 'glassesRound', 'glassesSquare', 'glassesOval'], 11),
      desk: pick(['', 'darkCloth', 'whaleOnDesk', 'parfait'], 13),
    },
    mood: pick(LOOK_MOODS, 17),
    why: '（她的大脑这会儿没连上，先按日期定了一身）',
  }
}

/**
 * 装扮的"谁说了算"（主人 2026-10-24 深夜：「就形象服装而言可以完全让她来；不如先改成设置里可以选
 * 『她自主』和『你选择』」）
 *   · she    （默认）：她自己每天挑一身（跨天会换，这是预期）
 *   · master （你选择）：她不再自己换，一直穿你定的那一身；只有你点「让她今天换一身」才破例
 * 记在 `她的打扮.json` 的 `mode` 字段里（同一个文件，跟着她走）。
 */
function readLookMode() {
  const j = readLookFile()
  return j && j.mode === 'master' ? 'master' : 'she'
}

function setLookMode(mode) {
  const want = String(mode || '').toLowerCase() === 'master' ? 'master' : 'she'
  const j = readLookFile() || {}
  const rec = Object.assign({}, j, { mode: want, modeAt: new Date().toISOString().slice(0, 19).replace('T', ' ') })
  try {
    mkdirSync(dirname(lookFile()), { recursive: true })
    writeJson(lookFile(), rec)
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
  log(`装扮：以后${want === 'she' ? '她自己挑（她自主）' : '只穿你定的那一身（你选择）'}`)
  return { ok: true, mode: want, look: todayLook() }
}

/** 让她的脑子自己挑一身；挑不到就兜底。写盘 → 立刻穿上。 */
async function chooseLook(opts) {
  const reason = (opts && opts.reason) || 'auto'
  // 「你选择」模式：她自己不许换（只有你点「让她今天换一身」时才破例）
  if (readLookMode() === 'master' && reason !== 'manual' && reason !== 'menu') {
    log('打扮：现在是「你选择」模式，她不自作主张换（reason=' + reason + '）')
    return { ok: true, skipped: 'master-mode', look: todayLook(), mode: 'master' }
  }
  const date = todayStr()
  let result = null
  if (!MOCK) {
    try {
      result = await askBrainForLook(date)
    } catch (err) {
      log('让她挑打扮失败：' + ((err && err.message) || err))
    }
  }
  const chosen = result || fallbackLook(date)
  const look = sanitizeLook(chosen.look)
  const rec = {
    date,
    look,
    mood: LOOK_MOODS.includes(chosen.mood) ? chosen.mood : 'neutral',
    why: String(chosen.why || '').slice(0, 120),
    by: result ? 'she' : 'fallback',
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  try {
    mkdirSync(dirname(lookFile()), { recursive: true })
  } catch {}
  writeJson(lookFile(), rec)
  await applyLook(look)
  log(`打扮（${reason}）：${JSON.stringify(look)}${rec.why ? ' —— ' + rec.why : ''}`)
  if (rec.why) {
    petControl({ say: rec.why, mood: rec.mood })
    speakBubble(rec.why)
  }
  return { ok: true, look: rec }
}

/** 问她的脑子：今天这一身你穿什么（只回一行 JSON） */
async function askBrainForLook(dateStr) {
  if (!existsSync(BRAIN)) return null
  const lines = LOOK_GROUPS.map(
    (g) => `- ${g.label}：${g.items.map((i) => i.label + (i.key ? `(${i.key})` : '')).join(' / ')}`,
  ).join('\n')
  const ask =
    `（今天 ${dateStr}。这是你自己的事，不用问我。）\n` +
    `请你给自己挑今天这一身穿什么、头发怎么弄。只能在下面这些里挑，不许编别的：\n${lines}\n\n` +
    `只回一行 JSON，不要解释、不要代码块：\n` +
    `{"hair":"","headwear":"","sticker":"","glasses":"","desk":"","mood":"${LOOK_MOODS.join('|')}","why":"一句你自己的口气"}\n` +
    `每一项只填括号里的英文 key，或者留空。`
  const inFile = join(OUT, 'her-look-in.txt')
  try {
    writeFileSync(inFile, ask, 'utf8')
  } catch {
    return null
  }
  const text = await runBrainCollect(inFile, 45000)
  if (!text) return null
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let obj = null
  try {
    obj = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  return { look: obj, mood: obj.mood, why: obj.why }
}

/** 跑一轮大脑，把它的输出收成一整段文字（不推给界面） */
function runBrainCollect(inFile, timeoutMs) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve(out.trim())
    }
    let child = null
    try {
      child = spawn(process.execPath, [BRAIN, '--ask-file', inFile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      finish()
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      for (const raw of chunk.toString('utf8').split('\n')) {
        const line = raw.trim()
        if (!line) continue
        let obj = null
        try {
          obj = JSON.parse(line)
        } catch {
          out += line
          continue
        }
        if (obj && obj.t === 'delta') out += String(obj.d || '')
        if (obj && obj.t === 'done' && typeof obj.reply === 'string' && !out.trim()) out = obj.reply
      }
    })
    child.on('close', () => {
      clearTimeout(timer)
      finish()
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish()
    })
  })
}

/** 主人自己点某一项（改一组，立刻穿上并记下来） */
function setLookItem(group, key) {
  // 2026-10-25 第 8 项：待机动作也走这个口子（group = 'idle'，key = motion 名）
  if (String(group) === 'idle') {
    const name = String(key || '').trim()
    if (name && !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { ok: false, error: '待机动作的名字不合法：' + name }
    const cur0 = todayLook()
    const look0 = Object.assign({}, sanitizeLook(cur0 && cur0.look), { idle: name })
    const rec0 = {
      date: todayStr(),
      look: look0,
      mood: (cur0 && cur0.mood) || 'neutral',
      why: (cur0 && cur0.why) || '',
      by: 'master',
      mode: readLookMode(),
      at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }
    try {
      mkdirSync(dirname(lookFile()), { recursive: true })
    } catch {}
    writeJson(lookFile(), rec0)
    applyLook(look0)
    log(`待机动作 → ${name || '（默认）'}`)
    return { ok: true, look: rec0, idle: name }
  }
  const g = LOOK_GROUPS.find((x) => x.key === group)
  if (!g) return { ok: false, error: '不认识的一组：' + group }
  if (!g.items.some((i) => i.key === key)) return { ok: false, error: '这一组里没有：' + key }
  const cur = todayLook()
  const look = Object.assign({}, sanitizeLook(cur && cur.look), { [group]: key })
  const rec = {
    date: todayStr(),
    look,
    mood: (cur && cur.mood) || 'neutral',
    why: (cur && cur.why) || '',
    by: 'master',
    mode: readLookMode(),
    at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  try {
    mkdirSync(dirname(lookFile()), { recursive: true })
  } catch {}
  writeJson(lookFile(), rec)
  applyLook(look)
  log(`打扮（主人改的 ${group}）→ ${key || '（摘掉）'}`)
  return { ok: true, look: rec }
}

/** 把流式文字切成句子念（够长 + 遇到标点就念） */

  return {
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
  }
}
