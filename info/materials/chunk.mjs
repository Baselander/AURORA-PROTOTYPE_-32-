/**
 * info/materials/chunk.mjs —— 切块（中文约 400~500 字，重叠 50 字）
 *
 * 做法（比参考实现的 split_text 多几层保护，但参数口径一致）：
 *   1. 先按段落/句子边界切（中文标点 。！？； 与换行；英文 . ! ? 后接空格）
 *   2. 逐句往当前块里放：放不下（会超过 size）就收块，下一块**从上一块末尾 overlap 字**起头
 *   3. 单句本身超过 size：按 size 硬切，块间留 overlap
 *
 * 为什么不用定长窗口：课件里一句话常常是关键定义，切一半会让检索命中“半句话”。
 */

const DEFAULT_SIZE = 450
const DEFAULT_OVERLAP = 50
/** 单页文本短于这个长度就直接整页成一块（避免碎块）。 */
const MIN_CHUNK_SOFT = 120
/** 短于这个长度的“块”基本是幻灯片页码 / 页眉残渣，直接丢掉（检索里只会是噪音）。 */
const MIN_CHUNK_CHARS = 20

/**
 * 规整空白：保留段落换行，去掉行首尾空白、把 3 个以上换行压成 2 个。
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按句子边界切（保留标点）。英文句号只有后面跟空白/结尾时才切，避免切坏 1.5、U.S.A 之类。
 * @param {string} paragraph
 * @returns {string[]}
 */
function splitSentences(paragraph) {
  const parts = []
  let start = 0
  const pushable = /[。！？；!?;]|\n/
  for (let index = 0; index < paragraph.length; index++) {
    const ch = paragraph[index]
    if (ch === '\n') {
      const piece = paragraph.slice(start, index + 1)
      if (piece.trim()) parts.push(piece)
      start = index + 1
      continue
    }
    if (ch === '.' || ch === '…') {
      const next = paragraph[index + 1]
      const next2 = paragraph[index + 2]
      const isBoundary =
        ch === '…' || next === undefined || /\s/.test(next) || (next === '.' && next2 === '.')
      if (isBoundary) {
        const piece = paragraph.slice(start, index + 1)
        if (piece.trim()) parts.push(piece)
        start = index + 1
      }
      continue
    }
    if (pushable.test(ch)) {
      const piece = paragraph.slice(start, index + 1)
      if (piece.trim()) parts.push(piece)
      start = index + 1
    }
  }
  const tail = paragraph.slice(start)
  if (tail.trim()) parts.push(tail)
  return parts.length ? parts : paragraph.trim() ? [paragraph] : []
}

/**
 * 切块。
 * @param {string} text 归一化前的原始文本
 * @param {{ size?: number, overlap?: number }} [options]
 * @returns {string[]}
 */
export function chunkText(text, options = {}) {
  const size = Math.max(80, Number.parseInt(options.size ?? DEFAULT_SIZE, 10) || DEFAULT_SIZE)
  const overlap = Math.max(0, Math.min(Number.parseInt(options.overlap ?? DEFAULT_OVERLAP, 10) || DEFAULT_OVERLAP, Math.floor(size / 2)))
  const normalized = normalizeText(text)
  if (!normalized) return []
  if (normalized.length <= size) return [normalized]

  const sentences = []
  for (const paragraph of normalized.split(/\n+/)) {
    const parts = splitSentences(paragraph)
    // 段落末尾补一个换行：下一段的第一句就不会和前一段最后一句粘在一起
    // （docx 表格/段落抽出来常常没有句号，丢了分隔会把两段拼成一句）
    if (parts.length) {
      parts[parts.length - 1] += '\n'
      sentences.push(...parts)
    }
  }

  const chunks = []
  let current = ''
  const flush = () => {
    const value = current.trim()
    if (value) chunks.push(value)
    current = ''
  }

  for (const sentence of sentences) {
    if (sentence.length > size) {
      // 超长句（英文长段落、无标点的整段）：硬切，块间留 overlap
      flush()
      let index = 0
      while (index < sentence.length) {
        const piece = sentence.slice(index, index + size).trim()
        if (piece) chunks.push(piece)
        index += Math.max(1, size - overlap)
      }
      continue
    }

    const joinedLength = current.length + sentence.length + 1
    if (joinedLength <= size + Math.floor(size * 0.1)) {
      current += sentence
      continue
    }

    const tail = current.length > overlap ? current.slice(-overlap) : current
    flush()
    current = overlap > 0 ? tail + sentence : sentence
    // 万一 overlap 本身就把新块顶满了（极端短句），直接收掉，别死循环
    if (current.length >= size) flush()
  }
  flush()
  return chunks
}

/**
 * 给“一页”文本切块，并带上位置元数据。
 * @param {string} text
 * @param {{ source: string, kind: string, page?: number, slide?: number, size?: number, overlap?: number }} base
 * @returns {{ source: string, kind: string, page: number | null, slide: number | null, chunkIndex: number, text: string }[]}
 */
export function chunkPage(text, base) {
  const flat = normalizeText(text)
  if (!flat) return []
  if (flat.length < MIN_CHUNK_CHARS) return []
  if (flat.length <= MIN_CHUNK_SOFT) {
    return [
      {
        source: base.source,
        kind: base.kind,
        page: base.page ?? null,
        slide: base.slide ?? null,
        chunkIndex: 0,
        text: flat,
      },
    ]
  }
  return chunkText(text, { size: base.size, overlap: base.overlap }).map((chunk, chunkIndex) => ({
    source: base.source,
    kind: base.kind,
    page: base.page ?? null,
    slide: base.slide ?? null,
    chunkIndex,
    text: chunk,
  }))
}
