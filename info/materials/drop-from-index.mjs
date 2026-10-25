#!/usr/bin/env node
/**
 * info\materials\drop-from-index.mjs —— 从索引里剔掉指定的文件（2026-10-25）
 *
 * 主人 2026-10-24 深夜：「索引里那 2 个冒烟 docx 没用，直接删了吧」。
 * ⚠️ **只动索引，不动源文件**（删别人的文件要先问）。
 *
 * 用法：
 *   node info\materials\drop-from-index.mjs --match "AP-Physics1/U1-Review_Pack" [--dry]
 *   （--match 是**文件名子串**，可以给多个 --match；--dry 只报告不改）
 *
 * 输出一行 JSON：{ok, dry, removedFiles:[…], removedChunks:N, leftFiles:N, chunksLeft:N}
 */
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⚠️ 项目路径里有空格（"dsh web"），url.pathname 会带 %20 → 必须用 fileURLToPath
const HERE = fileURLToPath(new URL('.', import.meta.url))
const mod = (name) => pathToFileURL(join(HERE, name)).href
const { indexDir, loadManifest, saveManifest, loadChunks, saveChunks } = await import(mod('store.mjs'))

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const matches = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--match' && args[i + 1]) matches.push(String(args[i + 1]))
}
const out = (o) => console.log(JSON.stringify(o))

if (matches.length === 0) {
  out({ ok: false, error: '要给至少一个 --match（文件名子串）' })
  process.exit(0)
}

const dirAbs = resolve(indexDir())
const manifest = loadManifest(dirAbs)
const files = manifest && manifest.files ? manifest.files : {}
const removed = []
for (const key of Object.keys(files)) {
  const norm = key.replace(/\\/g, '/')
  if (matches.some((m) => norm.includes(String(m).replace(/\\/g, '/')))) removed.push(key)
}
const chunks = loadChunks(dirAbs).chunks
const keep = []
let dropped = 0
for (const c of chunks) {
  const src = String((c && c.source) || '').replace(/\\/g, '/')
  if (removed.some((r) => r.replace(/\\/g, '/') === src)) dropped += 1
  else keep.push(c)
}

if (!DRY && removed.length > 0) {
  for (const key of removed) delete files[key]
  manifest.files = files
  manifest.updatedAt = new Date().toISOString()
  saveManifest(dirAbs, manifest)
  saveChunks(dirAbs, keep)
}
out({
  ok: true,
  dry: DRY,
  removedFiles: removed.map((r) => r.split(/[\\/]/).slice(-2).join('/')),
  removedChunks: dropped,
  leftFiles: Object.keys(files).length,
  chunksLeft: keep.length,
  chunksBefore: chunks.length,
})
