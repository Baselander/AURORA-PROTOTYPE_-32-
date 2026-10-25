/**
 * info/materials/index-files.mjs —— 把课件目录抽成索引（CLI）
 *
 * 用法：
 *   node info/materials/index-files.mjs --dir "<某个目录>" [--rebuild] [--json]
 *   可选：--root "<数据目录>"（默认按 DSH_DATA → 旧路径 → 端口样例 解析）
 *         --size 450 --overlap 50（切块口径，默认就用这两个）
 *
 * 输出（--json 时就是下面这个对象，成功与失败都保证是合法 JSON）：
 *   { ok, added, skipped, totalChunks, warnings: [{ file, reason }] }
 *
 * 行为：
 *   · 递归子目录；支持 .pdf .docx .pptx .txt .md
 *   · 已索引且 size+mtime+sha1前16位都没变 → 跳过（不算 added）
 *   · 坏文件 / 加密 / 抽取为空 → 进 warnings（写清楚是格式问题还是文件损坏），不崩，继续处理别的
 *   · 人类可读输出只打文件名，**不打正文**
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'

import { SUPPORTED_EXTS, ExtractError, extractFile, pdfCapability } from './extract.mjs'
import { chunkPage } from './chunk.mjs'
import {
  fingerprint,
  indexDir,
  loadChunks,
  loadManifest,
  saveChunks,
  saveManifest,
  ensureIndexDir,
} from './store.mjs'

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.venv', '__pycache__', '.tmp', 'chroma'])
const MAX_WARNING_LINES_IN_HUMAN = 50

function parseArgs(argv) {
  const args = { dir: null, rebuild: false, json: false, root: null, size: undefined, overlap: undefined }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--dir') args.dir = next()
    else if (arg === '--rebuild') args.rebuild = true
    else if (arg === '--json') args.json = true
    else if (arg === '--root') args.root = next()
    else if (arg === '--size') args.size = Number.parseInt(next(), 10)
    else if (arg === '--overlap') args.overlap = Number.parseInt(next(), 10)
    else if (arg.startsWith('--')) throw new Error(`不认识的参数：${arg}`)
  }
  return args
}

/** 递归扫目录，返回全部文件绝对路径（跟随符号链接？不跟随，避免环）。 */
function walkFiles(dirAbs, files, warnings) {
  let entries
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true })
  } catch (cause) {
    warnings.push({ file: dirAbs, reason: `读不了目录：${cause instanceof Error ? cause.message : String(cause)}` })
    return
  }
  for (const entry of entries) {
    const full = join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name.toLowerCase())) continue
      walkFiles(full, files, warnings)
      continue
    }
    if (!entry.isFile()) continue
    files.push(full)
  }
}

function relOf(dirAbs, fileAbs) {
  return fileAbs.startsWith(dirAbs + sep) ? fileAbs.slice(dirAbs.length + 1) : fileAbs
}

function isUnder(dirAbs, fileAbs) {
  return fileAbs.startsWith(dirAbs + sep)
}

/** 抽一个文件 → 页面数组；失败抛 ExtractError。 */
function extractPages(absPath, buf) {
  return extractFile(absPath, buf ? { buf } : {})
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (cause) {
    return finish({ ok: false, error: cause.message, added: 0, skipped: 0, totalChunks: 0, warnings: [] }, false)
  }

  const dirAbs = args.dir ? resolve(args.dir) : ''
  if (!dirAbs) {
    return finish(
      { ok: false, error: '缺少 --dir（要索引哪个目录）', added: 0, skipped: 0, totalChunks: 0, warnings: [] },
      args.json,
    )
  }
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return finish(
      {
        ok: false,
        error: `目录不存在或不是目录：${dirAbs}`,
        added: 0,
        skipped: 0,
        totalChunks: 0,
        warnings: [],
      },
      args.json,
    )
  }

  const indexDirAbs = indexDir(args.root)
  ensureIndexDir(indexDirAbs)

  if (args.rebuild) {
    // 只作废“这个目录下”的登记（库是多个目录共用的，别把别的目录的指纹一起抹掉）
    const manifest = loadManifest(indexDirAbs)
    for (const knownSource of Object.keys(manifest.files)) {
      if (isUnder(dirAbs, knownSource)) delete manifest.files[knownSource]
    }
    saveManifest(indexDirAbs, manifest)
  }

  const manifest = loadManifest(indexDirAbs)
  const { chunks: allChunks, badLines } = loadChunks(indexDirAbs)

  const warnings = []
  if (badLines > 0) {
    warnings.push({ file: join(indexDirAbs, 'chunks.jsonl'), reason: `索引文件里有 ${badLines} 行坏数据（已跳过）` })
  }

  /** 已有块数（按 source 统计）—— 用来识别“manifest 说有、chunks 却丢了”的情况。 */
  const chunkCountBySource = new Map()
  for (const chunk of allChunks) {
    chunkCountBySource.set(chunk.source, (chunkCountBySource.get(chunk.source) || 0) + 1)
  }

  const files = []
  walkFiles(dirAbs, files, warnings)

  const seenSources = new Set()
  /** @type {Map<string, object[]>} 新抽出来的块 */
  const freshChunks = new Map()
  const removedSources = new Set()
  let added = 0
  let skipped = 0

  // --rebuild：这个目录下的旧块先整批作废（哪怕某个文件这次抽取失败，也不留旧块）
  if (args.rebuild) {
    for (const chunk of allChunks) {
      if (isUnder(dirAbs, chunk.source)) removedSources.add(chunk.source)
    }
  }

  const sortedFiles = files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const unsupported = []
  const pdfCap = pdfCapability()

  for (const fileAbs of sortedFiles) {
    const ext = extname(fileAbs).toLowerCase()
    const rel = relOf(dirAbs, fileAbs)

    if (basename(fileAbs).startsWith('~$')) {
      warnings.push({ file: rel, reason: 'Office 临时锁文件（跳过）' })
      continue
    }
    if (!SUPPORTED_EXTS.has(ext)) {
      unsupported.push(rel)
      continue
    }

    let stat
    try {
      stat = statSync(fileAbs)
    } catch (cause) {
      warnings.push({ file: rel, reason: `stat 失败：${cause instanceof Error ? cause.message : String(cause)}` })
      continue
    }
    if (!stat.isFile()) continue

    const known = manifest.files[fileAbs]
    const haveChunks = (chunkCountBySource.get(fileAbs) || 0) > 0

    // pdf 没 PyMuPDF：不读文件内容，直接记原因（省几百 MB 的无谓读取）
    if (ext === '.pdf' && !pdfCap.python) {
      seenSources.add(fileAbs)
      warnings.push({ file: rel, reason: pdfCap.reason })
      if (known) {
        delete manifest.files[fileAbs]
        removedSources.add(fileAbs)
      }
      continue
    }

    let buf = null
    try {
      buf = readFileSync(fileAbs)
    } catch (cause) {
      warnings.push({ file: rel, reason: `读不了文件（可能被占用）：${cause instanceof Error ? cause.message : String(cause)}` })
      continue
    }

    const fp = fingerprint(buf, stat)
    const sameFingerprint =
      known && known.size === fp.size && known.mtimeMs === fp.mtimeMs && known.sha1_16 === fp.sha1_16
    if (!args.rebuild && sameFingerprint && haveChunks) {
      seenSources.add(fileAbs)
      skipped++
      continue
    }

    let extracted
    try {
      extracted = extractPages(fileAbs, buf)
    } catch (cause) {
      const reason =
        cause instanceof ExtractError ? cause.message : `抽取失败：${cause instanceof Error ? cause.message : String(cause)}`
      warnings.push({ file: rel, reason })
      if (known) {
        delete manifest.files[fileAbs]
        removedSources.add(fileAbs)
      }
      continue
    }

    if (extracted.partialWarning) {
      warnings.push({ file: rel, reason: extracted.partialWarning })
    }

    const pages = extracted.pages.filter((page) => page && String(page.text || '').trim())
    const totalText = pages.reduce((sum, page) => sum + String(page.text).length, 0)
    if (!pages.length || totalText === 0) {
      warnings.push({
        file: rel,
        reason: '抽取为空：文件里没有可读文字（可能是扫描图片版 / 纯图 PPT / 只放了图片和公式）',
      })
      if (known) {
        delete manifest.files[fileAbs]
        removedSources.add(fileAbs)
      }
      continue
    }

    const fileChunks = []
    for (const page of pages) {
      const pieces = chunkPage(String(page.text), {
        source: fileAbs,
        kind: extracted.kind,
        page: page.page,
        slide: page.slide,
        size: args.size,
        overlap: args.overlap,
      })
      fileChunks.push(...pieces)
    }
    if (!fileChunks.length) {
      warnings.push({ file: rel, reason: '抽取到文字但切块后为空（文本太短或全是空白字符）' })
      if (known) {
        delete manifest.files[fileAbs]
        removedSources.add(fileAbs)
      }
      continue
    }

    freshChunks.set(fileAbs, fileChunks)
    seenSources.add(fileAbs)
    manifest.files[fileAbs] = {
      size: fp.size,
      mtimeMs: fp.mtimeMs,
      sha1_16: fp.sha1_16,
      chunks: fileChunks.length,
      kind: extracted.kind,
      indexedAt: new Date().toISOString(),
    }
    added++
  }

  if (unsupported.length) {
    const shown = unsupported.slice(0, MAX_WARNING_LINES_IN_HUMAN)
    for (const rel of shown) warnings.push({ file: rel, reason: '不支持的扩展名（跳过）' })
    if (unsupported.length > shown.length) {
      warnings.push({ file: dirAbs, reason: `另有 ${unsupported.length - shown.length} 个不支持的文件未列出` })
    }
  }

  // 目录里已经没有的文件 → 从索引里摘掉（防止 stats 报大小对不上）
  for (const knownSource of Object.keys(manifest.files)) {
    if (!isUnder(dirAbs, knownSource)) continue
    if (seenSources.has(knownSource)) continue
    removedSources.add(knownSource)
    delete manifest.files[knownSource]
  }

  const keptChunks = allChunks.filter(
    (chunk) => !removedSources.has(chunk.source) && !freshChunks.has(chunk.source),
  )
  const newChunks = []
  for (const [, list] of freshChunks) newChunks.push(...list)
  const mergedChunks = keptChunks.concat(newChunks)

  saveChunks(indexDirAbs, mergedChunks)
  const nowIso = new Date().toISOString()
  manifest.engine = 'bm25'
  manifest.updatedAt = nowIso
  manifest.lastRun = {
    at: nowIso,
    dir: dirAbs,
    added,
    skipped,
    totalChunks: mergedChunks.length,
    warnings,
  }
  saveManifest(indexDirAbs, manifest)

  return finish(
    { ok: true, added, skipped, totalChunks: mergedChunks.length, warnings },
    args.json,
    { dirAbs, indexDirAbs, removed: removedSources.size },
  )
}

function finish(result, json, extra) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result.ok !== true) process.exitCode = 1
    return
  }

  if (result.ok === false) {
    process.stderr.write(`索引失败：${result.error}\n`)
    process.exitCode = 1
    return
  }

  const lines = []
  lines.push(`索引完成 · ${extra?.dirAbs || ''}`)
  lines.push(`  added ${result.added} · skipped ${result.skipped} · totalChunks ${result.totalChunks}`)
  if (extra?.removed) lines.push(`  （从索引里摘掉 ${extra.removed} 个文件）`)
  if (extra?.indexDirAbs) lines.push(`  索引目录 ${extra.indexDirAbs}`)
  if (result.warnings.length) {
    lines.push(`  warnings ${result.warnings.length}：`)
    for (const warning of result.warnings.slice(0, MAX_WARNING_LINES_IN_HUMAN)) {
      lines.push(`    - ${basename(warning.file) || warning.file}：${warning.reason}`)
    }
    if (result.warnings.length > MAX_WARNING_LINES_IN_HUMAN) {
      lines.push(`    ……另 ${result.warnings.length - MAX_WARNING_LINES_IN_HUMAN} 条（--json 看全）`)
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
