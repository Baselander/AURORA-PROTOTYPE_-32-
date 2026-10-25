#!/usr/bin/env node
/**
 * info\materials\index-all.mjs —— 一次把 G10 下所有"真科目"目录建进索引（2026-10-25）
 *
 * 主人的口径（2026-10-24 拍过）：
 *   「**只索引名字以 `AP` / `PreAP` 开头的目录**（其余开头的都是别的东西）」
 *   「你其实可以直接引到 New/G10 里面」
 *
 * 干什么：扫 `<G10>\*` 顶层目录，只挑名字匹配 `^(AP|PreAP)` 的（大小写不敏感），
 *   对每个目录跑一次 `index-files.mjs --dir <那个目录>`（同一个脚本、同一套切块/去重）。
 *
 * 用法（默认**干跑**，只报告会加多少，不动索引）：
 *   node info\materials\index-all.mjs                 # 干跑：列出每个科目"这次会加几个文件/块"
 *   node info\materials\index-all.mjs --apply         # 真跑
 *   node info\materials\index-all.mjs --apply --dir "D:\...\AP-Physics1"   # 只跑一个
 *   node info\materials\index-all.mjs --list           # 只看会扫到哪些目录
 *
 * ⚠️ 真跑会**变大**（现在 143 文件 / 11,570 块 / 7.2MB；全量可能翻倍）—— 所以默认干跑。
 * ⚠️ 会跳过 `_study-core`（那是她自己数据，不是课件）。
 * 输出：逐目录一行 JSON + 最后一行汇总 {ok, dirs, addedFiles, addedChunks, ms}
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const INDEXER = join(HERE, 'index-files.mjs')
// index-files.mjs / extract.mjs 认的这些（干跑时也就数这些）
const EXTS = /\.(docx|pptx|pdf|html|htm)$/i

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const LISTONLY = args.includes('--list')
const only = (() => {
  const i = args.indexOf('--dir')
  return i >= 0 && args[i + 1] ? args[i + 1] : ''
})()
const SKIP = /^(_|\$|\.)/

const out = (o) => console.log(JSON.stringify(o))

/** 走一遍目录，数"认得格式"的文件（干跑用；真跑交给 index-files.mjs） */
function walkCount(dir) {
  let n = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (EXTS.test(e.name)) n += 1
    }
  }
  return n
}

/** 索引里已经有哪些文件（干跑时用来算"还差多少"） */
async function indexedPaths() {
  try {
    const store = await import(pathToFileURL(join(HERE, 'store.mjs')).href)
    const { resolve } = await import('node:path')
    const dirAbs = resolve(store.indexDir())
    const manifest = store.loadManifest(dirAbs) || {}
    return new Set(Object.keys(manifest.files || {}).map((k) => k.replace(/\\/g, '/').toLowerCase()))
  } catch {
    return new Set()
  }
}

function walkFiles(dir) {
  const files = []
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (EXTS.test(e.name)) files.push(p)
    }
  }
  return files
}

/** 顶层目录里，名字以 AP / PreAP 开头的那些 */
function subjectDirs() {
  if (!existsSync(G10)) return []
  return readdirSync(G10, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !SKIP.test(name) && /^(AP|PreAP)/i.test(name))
    .map((name) => ({ name, dir: join(G10, name) }))
    .filter((d) => {
      try {
        return statSync(d.dir).isDirectory()
      } catch {
        return false
      }
    })
}

const all = subjectDirs()
const targets = only ? all.filter((d) => d.dir.replace(/\\/g, '/').toLowerCase() === only.replace(/\\/g, '/').toLowerCase()) : all

if (LISTONLY) {
  out({ ok: true, g10: G10, count: targets.length, dirs: targets.map((t) => t.name) })
  process.exit(0)
}
if (targets.length === 0) {
  out({ ok: false, error: `在 ${G10} 下没找到名字以 AP / PreAP 开头的目录`, count: 0 })
  process.exit(0)
}
if (!existsSync(INDEXER)) {
  out({ ok: false, error: '找不到 info\\materials\\index-files.mjs' })
  process.exit(1)
}

const started = Date.now()
let addedFiles = 0
let addedChunks = 0
let skipped = 0
const errors = []

if (!APPLY) {
  // ── 干跑：只数"会加多少"，一个字都不写 ────────────────────────────────
  const known = await indexedPaths()
  for (const t of targets) {
    const files = walkFiles(t.dir)
    const fresh = files.filter((f) => !known.has(f.replace(/\\/g, '/').toLowerCase()))
    addedFiles += fresh.length
    out({
      dir: t.name,
      ok: true,
      dry: true,
      files: files.length,
      notIndexedYet: fresh.length,
      skipped: files.length - fresh.length,
    })
  }
  out({
    ok: true,
    apply: false,
    dirs: targets.length,
    addedFiles,
    addedChunks: null,
    skipped,
    ms: Date.now() - started,
    note: '这是干跑：只数了"还没进索引的文件数"。要真跑加 --apply（会写索引，体积会变大）。',
  })
  process.exit(0)
}

for (const t of targets) {
  // index-files.mjs 的 --dir 接受目录；默认它是"增量"（已索引且没变的会跳过）
  // ⚠️ index-files.mjs 只有带 --json 才吐 JSON（不带是给人看的中文），
  //    踩过一次：没给 --json → 解析失败 → 明明索引进去了却报"每个目录都失败"。
  const argv = [INDEXER, '--dir', t.dir, '--json']
  if (!APPLY) argv.push('--dry')
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 600000, windowsHide: true })
  const line = String(r.stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop()
  let j = null
  try {
    j = JSON.parse(line || '{}')
  } catch {}
  if (r.status !== 0 || !j || j.ok === false) {
    errors.push({ dir: t.name, error: (j && j.error) || String(r.stderr || '').slice(0, 200) || `exit=${r.status}` })
    out({ dir: t.name, ok: false, error: (j && j.error) || '见 errors' })
    continue
  }
  const added = Number(j.added || 0)
  const chunks = Number(j.addedChunks || j.chunks || 0)
  addedFiles += added
  addedChunks += chunks
  skipped += Number(j.skipped || 0)
  out({
    dir: t.name,
    ok: true,
    dry: !APPLY,
    added,
    addedChunks: chunks,
    skipped: Number(j.skipped || 0),
    totalChunks: j.totalChunks ?? null,
    warnings: Array.isArray(j.warnings) ? j.warnings.length : 0,
  })
}

out({
  ok: errors.length === 0,
  apply: APPLY,
  dirs: targets.length,
  addedFiles,
  addedChunks,
  skipped,
  ms: Date.now() - started,
  errors,
})
