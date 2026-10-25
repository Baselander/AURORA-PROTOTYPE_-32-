/**
 * info/materials/xml.mjs —— 极小的 XML 取值工具（零依赖）
 *
 * 只做三件事：解实体、取某个标签里的文本、把标签换成换行/空格。
 * 不是通用 XML 解析器：不处理 CDATA / 处理指令 / 良构性校验（docx、pptx 是机器生成的规整 XML）。
 * 思路参考 packages/study-core/src/core/xml.ts（单趟实体替换），独立实现。
 */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const ENTITY_PATTERN = /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g

function safeFromCodePoint(codePoint, fallback) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return fallback
  return String.fromCodePoint(codePoint)
}

/**
 * 解码 XML 实体（命名实体 + 十进制/十六进制数值实体）。非法实体原样保留，不抛错。
 * @param {string} text
 * @returns {string}
 */
export function decodeXmlEntities(text) {
  if (!text) return ''
  return text.replace(ENTITY_PATTERN, (whole, hex, dec, name) => {
    if (hex !== undefined) return safeFromCodePoint(Number.parseInt(hex, 16), whole)
    if (dec !== undefined) return safeFromCodePoint(Number.parseInt(dec, 10), whole)
    if (name !== undefined && NAMED_ENTITIES[name] !== undefined) return NAMED_ENTITIES[name]
    return whole
  })
}

/** 把标签名里的正则元字符转义（只允许 [A-Za-z0-9_:]）。 */
function escapeTagName(name) {
  return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 收集一段 XML 里某个标签的全部文本内容（按出现顺序拼接）。未闭合的标签不参与匹配。
 * @param {string} xml
 * @param {string} tag 标签名，如 'w:t' / 'a:t'
 * @returns {string}
 */
export function collectTagText(xml, tag) {
  const re = new RegExp(`<${escapeTagName(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTagName(tag)}>`, 'g')
  let out = ''
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1])
  }
  return out
}

/**
 * 把自闭合标签替换成指定文本（`<w:tab/>` → 空格、`<w:br/>` → 换行）。
 * @param {string} xml
 * @param {string[]} tags 标签名列表
 * @param {string} replacement
 * @returns {string}
 */
export function replaceSelfClosing(xml, tags, replacement) {
  if (!tags.length) return xml
  const re = new RegExp(`<(?:${tags.map(escapeTagName).join('|')})\\b[^>]*/>`, 'g')
  return xml.replace(re, replacement)
}
