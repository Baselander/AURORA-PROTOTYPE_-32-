/**
 * info/learn-digest.mjs —— 「经验本」的第 ② 步：**提炼**（2026-10-22，P0.5）
 *
 * 主人 2026-10-21 定的三件套：① 记（learn.ps1）② 炼（本脚本）③ 试（影子模式，还没做）。
 *
 * 这个脚本**只写一份"提议草稿"，不动任何规矩文件**：
 *   · 读 `<数据根>\mystery\DSH\她的经验本.txt`（一行一条：时间 | 场景 | 她做了什么 | 纠正成什么 | 结论）
 *   · 按场景分组、把"同样的结论"数出来
 *   · 输出 `<数据根>\mystery\DSH\经验本-提炼-<日期>.md`：
 *       出现 ≥2 次的结论 → 「建议进 `她的规矩.txt` 的候选」（⚠️ 要主人点头才会真写）
 *       只出现 1 次的 → 列出来备查
 *   · 纯本地、0 token（不调模型也能出草稿；以后可以让 brain 再把草稿润色成人话）
 *
 * 用法：
 *   node info/learn-digest.mjs            # 默认读真经验本、写真草稿
 *   node info/learn-digest.mjs --dry-run  # 只打印，不写文件
 *   node info/learn-digest.mjs --file <经验本> --out <输出 md>
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const has = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const ROOT = opt('root', process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`)
const SOURCE = opt('file', join(ROOT, 'mystery', 'DSH', '她的经验本.txt'))
const DRY = has('dry-run')
const stamp = new Date()
const pad = (n) => String(n).padStart(2, '0')
const today = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
const OUT = opt('out', join(ROOT, 'mystery', 'DSH', `经验本-提炼-${today}.md`))
// 2026-10-22（P0.5 第 ③ 步的雏形）：**影子模式**。
//   重复 ≥2 次的结论会追加到这里，brain 会读它、按它说话——但**涉及动作的（建待办/改文件）先只说不动**。
//   要"转正"（真写进 她的规矩.txt）必须主人点头，所以这里只管"影子"。
const SUGGEST = opt('suggest', join(ROOT, 'mystery', 'DSH', '她的规矩-建议.txt'))

function readLines() {
  if (!existsSync(SOURCE)) return []
  return readFileSync(SOURCE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** 一行 → { at, scene, did, should, lesson }；格式不对就当"整行"塞进 lesson。 */
function parseLine(line) {
  const parts = line.split('|').map((part) => part.trim())
  if (parts.length < 2) return { at: '', scene: '其它', did: line, should: '', lesson: line }
  return {
    at: parts[0] ?? '',
    scene: parts[1] || '其它',
    did: parts[2] ?? '',
    should: parts[3] ?? '',
    lesson: parts[4] ?? '',
  }
}

const items = readLines().map(parseLine)
const byScene = new Map()
for (const item of items) {
  if (!byScene.has(item.scene)) byScene.set(item.scene, [])
  byScene.get(item.scene).push(item)
}

// 结论去重计数（空结论不算）
const lessonCounts = new Map()
for (const item of items) {
  const key = (item.lesson || item.should || item.did).trim()
  if (key.length === 0) continue
  lessonCounts.set(key, (lessonCounts.get(key) ?? 0) + 1)
}
const repeated = [...lessonCounts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1])
const singles = [...lessonCounts.entries()].filter(([, count]) => count === 1)

const lines = []
lines.push(`# 经验本提炼草稿（${today}）`, '')
lines.push('> 自动生成：只提"候选"，**不会改任何规矩文件**。要进 `她的规矩.txt` 得主人点头（影子模式也还没开）。', '')
lines.push(`来源：${SOURCE}`, `共 ${items.length} 条记录`, '')
lines.push('## 一、反复出现的结论（≥2 次）→ 建议进规矩的候选', '')
if (repeated.length === 0) {
  lines.push('- （还没有重复出现的结论：继续记，攒够 2 次才会冒出来）')
} else {
  for (const [text, count] of repeated) lines.push(`- **${text}**（出现 ${count} 次）`)
}
lines.push('', '## 二、按场景看（每条只出现一次的结论）', '')
if (items.length === 0) {
  lines.push('- （经验本还是空的）')
} else {
  for (const [scene, list] of byScene) {
    lines.push(`### ${scene}（${list.length} 条）`)
    for (const item of list.slice(-20)) {
      const lesson = (item.lesson || item.should || item.did || '').trim()
      lines.push(`- ${item.at !== '' ? item.at + '　' : ''}${lesson}`)
    }
    lines.push('')
  }
}
lines.push('## 三、还单着的结论（出现 1 次）', '')
if (singles.length === 0) lines.push('- （无）')
else for (const [text] of singles) lines.push(`- ${text}`)

const markdown = `${lines.join('\n')}\n`
if (DRY) {
  console.log(markdown)
} else {
  writeFileSync(OUT, markdown, 'utf8')
  // 影子模式：把重复的结论追加进建议文件（去重；带"影子"标记，brain 读它但只"软跟随"）
  let suggested = 0
  try {
    const existing = existsSync(SUGGEST) ? readFileSync(SUGGEST, 'utf8') : ''
    const have = new Set(existing.split('\n').map((line) => line.split('|').slice(2).join('|').trim()))
    const add = []
    for (const [text, count] of repeated) {
      if (have.has(text)) continue
      add.push(`${today} | 影子 | ${text} | (出现 ${count} 次)`)
    }
    if (add.length > 0) {
      const header = existing.trim().length > 0 ? '' : '# 她的规矩-建议（影子模式：brain 会读，但"动作类"只说不做；转正要主人点头）\n'
      writeFileSync(SUGGEST, existing + (existing.endsWith('\n') || existing.length === 0 ? '' : '\n') + header + add.join('\n') + '\n', 'utf8')
      suggested = add.length
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: true, source: SOURCE, entries: items.length, repeated: repeated.length, out: OUT, suggestError: String(e) }))
    process.exit(0)
  }
  console.log(JSON.stringify({ ok: true, source: SOURCE, entries: items.length, repeated: repeated.length, out: OUT, suggested, suggestFile: SUGGEST }))
}
