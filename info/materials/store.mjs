/**
 * info/materials/store.mjs —— 索引落盘（<数据目录>\_study-core\课件库\）
 *
 * 只写这一个新目录里的两个文件：
 *   · manifest.json —— 每个文件一条：size / mtimeMs / sha1_16 / chunks / kind / indexedAt，
 *                      外加 lastRun（上次跑了哪个目录、加了几个、warnings 原文）
 *   · chunks.jsonl  —— 一行一块：{ source, kind, page, slide, chunkIndex, text }
 *
 * 写盘一律“先写 .tmp 再 rename”，中途断电也不会留下半个索引。
 * 指纹 = size + mtime + sha1 前 16 位：三者都没变就跳过这个文件。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CHROMA_DIR_NAME, INDEX_DIR_NAME, resolveIndexDir } from './paths.mjs'

const MANIFEST_NAME = 'manifest.json'
const CHUNKS_NAME = 'chunks.jsonl'

/** IndexError：给 CLI 输出 ok:false + 人话原因。 */
export class IndexError extends Error {
  constructor(message) {
    super(message)
    this.name = 'IndexError'
  }
}

/** @param {string} [rootOverride] */
export function indexDir(rootOverride) {
  return join(resolveIndexDir(rootOverride))
}

export function manifestPath(indexDirAbs) {
  return join(indexDirAbs, MANIFEST_NAME)
}

export function chunksPath(indexDirAbs) {
  return join(indexDirAbs, CHUNKS_NAME)
}

export function ensureIndexDir(indexDirAbs) {
  try {
    mkdirSync(indexDirAbs, { recursive: true })
  } catch (cause) {
    throw new IndexError(`建不了索引目录 ${indexDirAbs}：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/** 指纹：sha1(文件内容) 前 16 位 + size + mtime（mtime 用毫秒整数）。 */
export function fingerprint(buf, stat) {
  return {
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    sha1_16: createHash('sha1').update(buf).digest('hex').slice(0, 16),
  }
}

/**
 * 读 manifest。文件不存在 / 内容坏了都返回空 manifest（坏内容单独报，不覆盖用户的错误）。
 * @param {string} indexDirAbs
 * @returns {{ version: number, engine: string, updatedAt: string | null, lastRun: object | null, files: Record<string, object> }}
 */
export function loadManifest(indexDirAbs) {
  const file = manifestPath(indexDirAbs)
  const empty = { version: 1, engine: 'bm25', updatedAt: null, lastRun: null, files: {} }
  if (!existsSync(file)) return empty
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.files !== 'object' || parsed.files === null) {
      return empty
    }
    return { ...empty, ...parsed, files: parsed.files }
  } catch {
    return empty
  }
}

export function saveManifest(indexDirAbs, manifest) {
  const target = manifestPath(indexDirAbs)
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

/**
 * 读 chunks.jsonl。坏行跳过并计数（不因为一行坏了整库读不出来）。
 * @param {string} indexDirAbs
 * @param {{ containsAny?: string[] }} [options]
 *   containsAny：只要 source 路径里含这些词之一的块（2026-10-25 P1-1：索引 37,279 块以后
 *   提问前检索变慢 —— 按科目过滤能少读一大半。过滤在 JSON.parse **之前**用字符串包含做，
 *   不命中的行连解析都省了）。
 * @returns {{ chunks: object[], badLines: number, total: number }}
 */
export function loadChunks(indexDirAbs, options) {
  const file = chunksPath(indexDirAbs)
  if (!existsSync(file)) return { chunks: [], badLines: 0, total: 0 }
  const raw = readFileSync(file, 'utf8')
  if (raw.length === 0) return { chunks: [], badLines: 0, total: 0 }
  const needles = Array.isArray(options && options.containsAny)
    ? options.containsAny.map((s) => String(s || '').toLowerCase()).filter((s) => s.length > 0)
    : []
  // ⚠️ 只查每行**开头那一段**（source 是每行第一个键，路径就在最前面）：
  //    这样不用把整份 23MB 再小写一遍（那一步要 100~200ms），也不用担心偏移对不上。
  const HEAD = needles.length > 0 ? 260 : 0
  const chunks = []
  let badLines = 0
  let total = 0
  let start = 0
  for (;;) {
    let end = raw.indexOf('\n', start)
    if (end < 0) end = raw.length
    if (end > start) {
      total += 1
      const line = raw.slice(start, end)
      if (line.trim().length > 0) {
        let keep = true
        if (needles.length > 0) {
          const head = line.length > HEAD ? line.slice(0, HEAD) : line
          const lhead = /[A-Z]/.test(head) ? head.toLowerCase() : head
          keep = false
          for (const n of needles) {
            if (lhead.includes(n)) {
              keep = true
              break
            }
          }
        }
        if (keep) {
          try {
            const item = JSON.parse(line)
            if (item && typeof item.text === 'string' && typeof item.source === 'string') chunks.push(item)
            else badLines++
          } catch {
            badLines++
          }
        }
      }
    }
    if (end >= raw.length) break
    start = end + 1
  }
  return { chunks, badLines, total }
}

export function saveChunks(indexDirAbs, chunks) {
  const target = chunksPath(indexDirAbs)
  const tmp = `${target}.tmp-${process.pid}`
  const body = chunks.map((chunk) => JSON.stringify(chunk)).join('\n')
  writeFileSync(tmp, body ? `${body}\n` : '', 'utf8')
  renameSync(tmp, target)
}

/** 删除过期/坏掉的索引（--rebuild 时用；只删这两个文件，不动目录里别的东西）。 */
export function wipeIndex(indexDirAbs) {
  for (const file of [manifestPath(indexDirAbs), chunksPath(indexDirAbs)]) {
    if (existsSync(file)) rmSync(file)
  }
}

/** chroma 子目录（本卡默认不建；--engine chroma 探测通过才会用到）。 */
export function chromaDir(indexDirAbs) {
  return join(indexDirAbs, CHROMA_DIR_NAME)
}

export { INDEX_DIR_NAME }
