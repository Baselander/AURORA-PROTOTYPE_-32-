/**
 * info/materials/stats.mjs —— 看课件库现状（CLI，只读）
 *
 * 用法：node info/materials/stats.mjs [--json]
 * 输出：已索引多少文件 / 多少块 / 最后更新时间 / 引擎（+ 各类型块数、索引大小、上次跑的情况）
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { indexDir, manifestPath, chunksPath, loadManifest, loadChunks } from './store.mjs'

function parseArgs(argv) {
  const args = { json: false, root: null }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--json') args.json = true
    else if (arg === '--root') args.root = next()
    else if (arg.startsWith('--')) throw new Error(`不认识的参数：${arg}`)
  }
  return args
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (cause) {
    process.stderr.write(`${cause.message}\n`)
    process.exitCode = 2
    return
  }

  const indexDirAbs = indexDir(args.root)
  const hasIndex = existsSync(manifestPath(indexDirAbs)) || existsSync(chunksPath(indexDirAbs))

  if (!hasIndex) {
    const empty = {
      ok: true,
      engine: 'bm25',
      files: 0,
      chunks: 0,
      updatedAt: null,
      indexDir: indexDirAbs,
      sizeBytes: 0,
      byKind: {},
      lastRun: null,
      note: '还没有建过索引（先跑 info/materials/index-files.mjs --dir "<目录>"）',
    }
    if (args.json) process.stdout.write(`${JSON.stringify(empty)}\n`)
    else {
      process.stdout.write(
        `课件库还没建过索引\n  索引目录 ${indexDirAbs}\n  先跑：node info/materials/index-files.mjs --dir "<某个目录>"\n`,
      )
    }
    return
  }

  const manifest = loadManifest(indexDirAbs)
  const { chunks, badLines } = loadChunks(indexDirAbs)

  const byKind = {}
  for (const chunk of chunks) {
    const kind = chunk.kind || 'unknown'
    byKind[kind] = (byKind[kind] || 0) + 1
  }

  const payload = {
    ok: true,
    engine: manifest.engine || 'bm25',
    files: Object.keys(manifest.files || {}).length,
    chunks: chunks.length,
    updatedAt: manifest.updatedAt || null,
    indexDir: indexDirAbs,
    sizeBytes: fileSize(manifestPath(indexDirAbs)) + fileSize(chunksPath(indexDirAbs)),
    byKind,
    badLines,
    lastRun: manifest.lastRun
      ? {
          at: manifest.lastRun.at || null,
          dir: manifest.lastRun.dir || null,
          added: manifest.lastRun.added ?? null,
          skipped: manifest.lastRun.skipped ?? null,
          warnings: Array.isArray(manifest.lastRun.warnings) ? manifest.lastRun.warnings.length : 0,
        }
      : null,
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    return
  }

  const lines = []
  lines.push(`课件库 · 引擎 ${payload.engine}`)
  lines.push(`  已索引文件 ${payload.files} · 块 ${payload.chunks}`)
  if (Object.keys(byKind).length) {
    lines.push(`  按类型 ${Object.entries(byKind).map(([kind, count]) => `${kind} ${count}`).join(' / ')}`)
  }
  lines.push(`  最后更新 ${payload.updatedAt || '（未知）'}`)
  lines.push(`  索引目录 ${payload.indexDir}（${(payload.sizeBytes / 1024 / 1024).toFixed(2)} MB）`)
  if (payload.badLines > 0) lines.push(`  ⚠️ chunks.jsonl 里有 ${payload.badLines} 行坏数据（读取时已跳过）`)
  if (payload.lastRun) {
    const run = payload.lastRun
    lines.push(
      `  上次跑 ${run.dir || '（未知目录）'}：added ${run.added} / skipped ${run.skipped} / warnings ${run.warnings}（${run.at || ''}）`,
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
