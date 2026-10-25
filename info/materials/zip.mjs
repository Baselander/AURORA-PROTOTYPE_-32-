/**
 * info/materials/zip.mjs —— 只读 ZIP 解包（零依赖：node:zlib）
 *
 * docx / pptx 本质就是 ZIP：读中央目录 → 按本地头重算数据起点 → inflateRawSync。
 * 思路参考我们自己的 packages/study-core/src/core/zip.ts（同一套中央目录约定），
 * 但这里是**独立实现**，不 import 那边的代码，也不要求它是 ESM。
 *
 * 明确**不支持** ZIP64（Office 正常文件不会用；超过 4 GB / 65535 条目才会触发），
 * 遇到就抛错而不是悄悄读错数据。
 */

import { inflateRawSync } from 'node:zlib'

/** ZIP 相关错误：code 给程序判断，message 给人看（会原样进 warnings.reason 的前半句）。 */
export class ZipError extends Error {
  /** @param {'too-short'|'no-eocd'|'zip64-unsupported'|'corrupt'|'unsupported-method'|'out-of-range'} code */
  constructor(code, message) {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_ZIP_COMMENT = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff
const ZIP64_SENTINEL_16 = 0xffff
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/**
 * 从尾部向前找 EOCD（扫描范围上限 22 + 65535 字节，即最长注释）。
 * @param {Buffer} buf
 * @returns {number} EOCD 在 buf 中的偏移
 */
function findEndOfCentralDirectory(buf) {
  if (buf.length < EOCD_MIN_SIZE) {
    throw new ZipError('too-short', `文件只有 ${buf.length} 字节，短于 ZIP 最小结构（22 字节）`)
  }
  const lowest = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_ZIP_COMMENT)
  for (let offset = buf.length - EOCD_MIN_SIZE; offset >= lowest; offset--) {
    if (buf.readUInt32LE(offset) === SIG_EOCD) return offset
  }
  throw new ZipError('no-eocd', '末尾 64 KB 内找不到 ZIP 中央目录结尾签名')
}

/**
 * 遍历中央目录，取出全部文件条目（目录条目忽略）。
 * @param {Buffer} buf
 * @returns {{ name: string, method: number, compressedSize: number, uncompressedSize: number, localHeaderOffset: number }[]}
 */
export function readZipEntries(buf) {
  const eocd = findEndOfCentralDirectory(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)

  if (centralOffset === ZIP64_SENTINEL_32 || entryCount === ZIP64_SENTINEL_16) {
    throw new ZipError('zip64-unsupported', 'ZIP64 档案不支持')
  }
  if (centralOffset >= buf.length) {
    throw new ZipError('corrupt', `中央目录偏移 ${centralOffset} 超出文件长度 ${buf.length}`)
  }

  const entries = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buf.length) {
      throw new ZipError('corrupt', `中央目录第 ${index + 1} 项越界`)
    }
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipError('corrupt', `中央目录第 ${index + 1} 项签名错误`)
    }
    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localHeaderOffset = buf.readUInt32LE(cursor + 42)

    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buf.length) {
      throw new ZipError('corrupt', `中央目录第 ${index + 1} 项文件名越界`)
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw new ZipError('zip64-unsupported', `条目 ${buf.toString('utf8', nameStart, nameEnd)} 使用了 ZIP64 长度字段`)
    }
    const name = buf.toString('utf8', nameStart, nameEnd)
    if (!name.endsWith('/')) {
      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
    }
    cursor = nameEnd + extraLength + commentLength
  }
  return entries
}

/**
 * 解出一个条目。数据起点用**本地头自己的**长度字段重算（本地头的 extra 长度常与中央目录不同）。
 * @param {Buffer} buf
 * @param {{ name: string, method: number, compressedSize: number, localHeaderOffset: number }} entry
 * @returns {Buffer}
 */
export function readZipEntry(buf, entry) {
  const offset = entry.localHeaderOffset
  if (offset + 30 > buf.length) {
    throw new ZipError('corrupt', `条目 ${entry.name} 的本地头越界`)
  }
  if (buf.readUInt32LE(offset) !== SIG_LOCAL) {
    throw new ZipError('corrupt', `条目 ${entry.name} 的本地头签名错误`)
  }
  const localNameLength = buf.readUInt16LE(offset + 26)
  const localExtraLength = buf.readUInt16LE(offset + 28)
  const dataStart = offset + 30 + localNameLength + localExtraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > buf.length) {
    throw new ZipError('out-of-range', `条目 ${entry.name} 的数据区间超出文件长度`)
  }
  const raw = buf.subarray(dataStart, dataEnd)
  if (entry.method === METHOD_STORE) return Buffer.from(raw)
  if (entry.method === METHOD_DEFLATE) {
    try {
      return inflateRawSync(raw)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new ZipError('corrupt', `条目 ${entry.name} 的 deflate 数据流损坏：${detail}`)
    }
  }
  throw new ZipError('unsupported-method', `条目 ${entry.name} 使用了不支持的压缩方法 ${entry.method}（可能是加密）`)
}

/**
 * 一次解出多个条目：条目名集合 → 内容 Buffer。只解需要的部分，不做全量解压。
 * @param {Buffer} buf
 * @param {Set<string>} names
 * @returns {Map<string, Buffer>}
 */
export function unzipToMap(buf, names) {
  const out = new Map()
  for (const entry of readZipEntries(buf)) {
    if (names.has(entry.name)) out.set(entry.name, readZipEntry(buf, entry))
  }
  return out
}
