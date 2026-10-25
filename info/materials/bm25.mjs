/**
 * info/materials/bm25.mjs —— 纯本地 BM25 检索（零依赖，不联网、不用 key）
 *
 * 为什么不用 Chroma：参考实现走 sentence-transformers 向量检索，要装 chromadb +
 * torch/onnx 一整套；本卡的原则是“零新依赖先能跑”。BM25 对“课件里找一个概念/一句话”
 * 这类检索够用，而且完全可解释（每个命中都能说清是哪些词撞上了）。
 *
 * 中文切词：按 2-gram（“细胞膜” → 细胞/胞膜）。英文/数字按 [a-z0-9][a-z0-9'_-]* 切并小写。
 * 2-gram 不需要词典、对断词不敏感，是本地检索的稳妥选择。
 */

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const LATIN_RUN = /[a-z0-9][a-z0-9'’_-]*/g

/**
 * 切词（BM25 的 token 流）。
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const lower = String(text || '').toLowerCase()
  const tokens = []

  for (const match of lower.matchAll(LATIN_RUN)) {
    if (match[0].length > 0) tokens.push(match[0])
  }
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let index = 0; index < run.length - 1; index++) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

const K1 = 1.5
const B = 0.75

/**
 * 建 BM25 索引（内存里建，单次查询用；块数几千时构建 < 100ms）。
 */
export class Bm25Index {
  /**
   * @param {{ text: string, source: string, kind?: string, page?: number | null, slide?: number | null, chunkIndex?: number }[]} chunks
   */
  constructor(chunks) {
    this.chunks = chunks
    this.docTokens = [] // 每块 token 流
    this.docLengths = []
    /** @type {Map<string, number>} 词 → 出现过的文档数 */
    this.df = new Map()
    this.totalLength = 0

    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text)
      this.docTokens.push(tokens)
      this.docLengths.push(tokens.length)
      this.totalLength += tokens.length
      for (const token of new Set(tokens)) {
        this.df.set(token, (this.df.get(token) || 0) + 1)
      }
    }
    this.avgLength = chunks.length ? this.totalLength / chunks.length : 0
    this.size = chunks.length
  }

  /**
   * @param {string} query
   * @param {number} k
   * @returns {{ source: string, page: number | null, slide: number | null, chunkIndex: number, kind: string, score: number, text: string }[]}
   */
  search(query, k) {
    const queryTokens = tokenize(query)
    if (!queryTokens.length || !this.size) return []

    // 查询词的权重：查询里重复出现的词，多算一点（但不要放大到离谱）
    const queryTf = new Map()
    for (const token of queryTokens) queryTf.set(token, (queryTf.get(token) || 0) + 1)

    const limit = Math.max(1, Math.min(Number(k) || 5, 50))
    const scored = []
    for (let doc = 0; doc < this.size; doc++) {
      const tokens = this.docTokens[doc]
      if (!tokens.length) continue
      let score = 0
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
      for (const [token, qtf] of queryTf) {
        const freq = tf.get(token)
        if (!freq) continue
        const docFreq = this.df.get(token) || 1
        const idf = Math.log(1 + (this.size - docFreq + 0.5) / (docFreq + 0.5))
        const denom = freq + K1 * (1 - B + (B * tokens.length) / (this.avgLength || 1))
        score += qtf * idf * ((freq * (K1 + 1)) / denom)
      }
      if (score > 0) scored.push({ doc, score })
    }

    scored.sort((a, b) => b.score - a.score)
    const top = scored.slice(0, limit)
    return top.map(({ doc, score }) => {
      const chunk = this.chunks[doc]
      return {
        source: chunk.source,
        kind: chunk.kind || 'unknown',
        page: Number.isInteger(chunk.page) ? chunk.page : null,
        slide: Number.isInteger(chunk.slide) ? chunk.slide : null,
        chunkIndex: Number.isInteger(chunk.chunkIndex) ? chunk.chunkIndex : 0,
        score: Number(score.toFixed(4)),
        text: chunk.text,
      }
    })
  }
}
