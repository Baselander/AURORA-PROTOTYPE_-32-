/**
 * info/materials/query.mjs —— 检索（CLI）
 *
 * 用法：
 *   node info/materials/query.mjs --q "<问题>" [--k 5] [--json]
 *   可选：--subject <科目>   只在这个科目的课件里找（2026-10-25 P1-1）
 *         --engine bm25|chroma（默认 bm25）   --root "<数据目录>"
 *
 * 输出（--json）：
 *   { ok: true, hits: [{ source, page, score, text }] }
 * 人类可读输出只打：文件名 + 分数 + 正文前 20 字（**不把正文贴到终端/日志里**）。
 *
 * 引擎：
 *   · bm25  —— 纯本地、零依赖（默认）
 *   · chroma —— 必须探测到 chromadb 才允许；探测不到就**明确报错**，绝不静默降级
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Bm25Index } from './bm25.mjs'
import { findPythonWith, preview } from './paths.mjs'
import { indexDir, loadChunks, loadManifest } from './store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROMA_SCRIPT = join(HERE, '_chroma_query.py')

/**
 * 科目缩写 → 课件目录名（目录名就是 G10 下面那一层，见 index-all.mjs 的口径）。
 * 为什么要它：索引 37,279 块以后每次提问前的检索要 1.1 秒以上（读 23MB + 给 37k 块切词）；
 * 按科目过滤以后生物只剩 746 块、经济 3,320 块，命中一样准、快好几倍（2026-10-25 P1-1）。
 */
export const SUBJECT_ALIASES = {
  physics: 'AP-Physics1',
  phys: 'AP-Physics1',
  ap1: 'AP-Physics1',
  '物理': 'AP-Physics1',
  calc: 'AP-CalculusBC',
  calculus: 'AP-CalculusBC',
  math: 'AP-CalculusBC',
  '数学': 'AP-CalculusBC',
  '微积分': 'AP-CalculusBC',
  econ: 'AP-Microeconomic',
  economics: 'AP-Microeconomic',
  micro: 'AP-Microeconomic',
  '经济': 'AP-Microeconomic',
  '微观': 'AP-Microeconomic',
  bio: 'PreAP-Biology',
  biology: 'PreAP-Biology',
  '生物': 'PreAP-Biology',
  seminar: 'PreAP-Seminar',
  '研讨': 'PreAP-Seminar',
  history: 'PreAP-WorldHistory',
  '历史': 'PreAP-WorldHistory',
}

/** 把一个 --subject 值（缩写 / 目录名 / 逗号串都行）收成目录名数组 */
export function resolveSubjects(value) {
  const out = []
  for (const piece of String(value || '').split(/[,，;；\s]+/)) {
    const s = piece.trim()
    if (!s) continue
    const name = SUBJECT_ALIASES[s.toLowerCase()] || s
    if (!out.includes(name)) out.push(name)
  }
  return out
}

function parseArgs(argv) {
  const args = { q: null, k: 5, json: false, engine: 'bm25', root: null, subjects: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--q') args.q = next()
    else if (arg === '--k') args.k = Number.parseInt(next(), 10)
    else if (arg === '--json') args.json = true
    else if (arg === '--engine') args.engine = String(next() || '').toLowerCase()
    else if (arg === '--root') args.root = next()
    else if (arg === '--subject' || arg === '--subjects') {
      for (const name of resolveSubjects(next())) if (!args.subjects.includes(name)) args.subjects.push(name)
    }
    else if (arg.startsWith('--')) throw new Error(`不认识的参数：${arg}`)
  }
  if (!Number.isInteger(args.k) || args.k <= 0) args.k = 5
  return args
}

function fail(message, json, code = 2) {
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`)
  else process.stderr.write(`${message}\n`)
  process.exitCode = code
  return { ok: false, error: message }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (cause) {
    return fail(cause.message, false)
  }

  if (args.engine !== 'bm25' && args.engine !== 'chroma') {
    return fail(`不认识的引擎：${args.engine}（只支持 bm25 / chroma）`, args.json)
  }

  const question = String(args.q || '').trim()
  if (!question) return fail('缺少 --q（要检索的问题）', args.json)

  const indexDirAbs = indexDir(args.root)

  if (args.engine === 'chroma') {
    const chroma = findPythonWith('chromadb')
    if (!chroma) {
      return fail(
        'chroma 引擎不可用：没探测到 chromadb（python -c "import chromadb" 失败）。不会静默降级到 bm25。' +
          '本卡交付的索引是 bm25；要用 chroma 请先装 chromadb（建议装在 info\\materials\\.venv）并重建 chroma 索引。',
        args.json,
      )
    }
    const result = spawnSync(
      chroma.python,
      [CHROMA_SCRIPT, join(indexDirAbs, 'chroma'), question, String(args.k)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    )
    if (result.error || result.status !== 0) {
      return fail(`chroma 子进程失败：${result.error?.message || `退出码 ${result.status}`}`, args.json)
    }
    let payload
    try {
      payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || 'null')
    } catch {
      return fail('chroma 子进程输出不是 JSON', args.json)
    }
    if (!payload || payload.ok !== true) return fail(payload?.error || 'chroma 查询失败', args.json)
    return emit(payload.hits, args)
  }

  // bm25
  if (!existsSync(join(indexDirAbs, 'chunks.jsonl'))) {
    return fail(
      `索引是空的（${indexDirAbs} 里没有 chunks.jsonl）。先跑 index-files.mjs 建索引。`,
      args.json,
      0,
    )
  }
  const manifest = loadManifest(indexDirAbs)
  // 2026-10-25 P1-1：给了 --subject 就只读这些科目的块（JSON.parse 之前就按字符串筛掉，省时间）
  const { chunks, total } = loadChunks(indexDirAbs, { containsAny: args.subjects })
  if (!chunks.length) {
    const scope = args.subjects.length ? `（科目：${args.subjects.join(' / ')}）` : ''
    return fail(`索引是空的${scope}（${indexDirAbs} 里没有可用的块）。先跑 index-files.mjs 建索引。`, args.json, 0)
  }

  const index = new Bm25Index(chunks)
  const hits = index.search(question, args.k).map((hit) => ({
    source: hit.source,
    page: hit.page ?? hit.slide ?? null,
    score: hit.score,
    text: hit.text,
  }))

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, hits, scanned: index.size, total, subjects: args.subjects, filtered: args.subjects.length > 0 })}\n`,
    )
    return { ok: true, hits }
  }

  const lines = []
  const filterNote = args.subjects.length > 0 ? ` · 科目 ${args.subjects.join('/')}（${index.size}/${total} 块）` : ''
  lines.push(
    `问题：${preview(question, 60)}  · 引擎 bm25 · 库内 ${index.size} 块${filterNote} · 命中 ${hits.length}（更新于 ${manifest.updatedAt || '未知'}）`,
  )
  hits.forEach((hit, order) => {
    const page = hit.page === null || hit.page === undefined ? '' : ` 第 ${hit.page} 页/张`
    lines.push(`${order + 1}. ${hit.score.toFixed(4)} · ${basenameOf(hit.source)}${page} · ${preview(hit.text, 20)}`)
  })
  process.stdout.write(`${lines.join('\n')}\n`)
  return { ok: true, hits }
}

function basenameOf(filePath) {
  const parts = String(filePath || '').split(/[\\/]/)
  return parts[parts.length - 1] || String(filePath || '')
}

main()
