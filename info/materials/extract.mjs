/**
 * info/materials/extract.mjs —— 抽取文字（docx / pptx / txt / md 零依赖；pdf 走可选 Python）
 *
 * 零依赖路线：
 *   · docx / pptx = ZIP + XML。用 node:zlib inflateRawSync 解包，再用正则取 `<w:t>` / `<a:t>`
 *     的文本。**不装** python-docx / python-pptx（不需要，也不想多一层依赖）。
 *   · txt / md 直接按 UTF-8 读。
 *   · pdf 没有零依赖方案：探测 PyMuPDF（fitz）。有就用 `_pdf_text.py` 子进程（输出 JSON）；
 *     没有就返回 null 并给出“为什么不可用”，由调用方记 warning 并跳过，绝不静默产出空文本。
 *
 * 边界与失败原因（都写成人话，进 warnings.reason）：
 *   · 不是 ZIP（密码加密的 Office 文档是 OLE 复合文档，会走到这里）/ 文件损坏 / ZIP64
 *   · 压缩方法不支持（多为加密）
 *   · ZIP 里缺 word/document.xml 或 ppt/slides/slideN.xml
 *   · 抽取结果全空（扫描图片版 PDF、纯图 PPT）
 *   · 单个 slide 的 XML 坏了：只跳过这一页并记原因，其余页照常
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findPythonWith } from './paths.mjs'
import { readZipEntries, readZipEntry, ZipError } from './zip.mjs'
import { collectTagText, replaceSelfClosing } from './xml.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PDF_SCRIPT = join(HERE, '_pdf_text.py')

/** 支持的扩展名（本卡交付范围）。 */
export const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.pptx', '.txt', '.md', '.html', '.htm'])

/** 抽取失败：message 就是给人看的原因（会原样进 warnings.reason）。 */
export class ExtractError extends Error {
  /** @param {string} reason @param {string} code */
  constructor(reason, code = 'extract') {
    super(reason)
    this.name = 'ExtractError'
    this.code = code
  }
}

/** PyMuPDF 探测结果（进程内缓存，避免每个文件都起一次 python）。 */
let pdfProbe = null

/**
 * 探测 PDF 抽取能力。
 * @returns {{ python: string | null, reason: string }}
 */
export function pdfCapability() {
  if (pdfProbe) return pdfProbe
  const found = findPythonWith('fitz')
  pdfProbe = found
    ? { python: found.python, reason: '' }
    : {
        python: null,
        reason:
          'PDF 抽取未启用：没探测到 PyMuPDF（python -c "import fitz" 失败）。' +
          '要支持 pdf，把 PyMuPDF 装进 info\\materials\\.venv（见 NOTICE.md），不改系统 python。',
      }
  return pdfProbe
}

/**
 * 从文件抽文字。txt/md/html/docx/pptx 直接读；pdf 交给 python 子进程。
 * @param {string} absPath
 * @param {{ buf?: Buffer }} [options] 已经读好的文件内容（index-files 复用它算指纹）
 * @returns {{ kind: 'docx'|'pptx'|'txt'|'html'|'pdf', pages: { page?: number, slide?: number, text: string }[] }}
 * @throws {ExtractError}
 */
export function extractFile(absPath, options = {}) {
  const ext = extname(absPath).toLowerCase()
  if (!SUPPORTED_EXTS.has(ext)) {
    throw new ExtractError(`不支持的扩展名 ${ext || '（无扩展名）'}`, 'unsupported')
  }
  if (ext === '.pdf') return extractPdf(absPath)

  let buf = options.buf
  if (!buf) {
    try {
      buf = readFileSync(absPath)
    } catch (cause) {
      throw new ExtractError(`读不了文件：${cause instanceof Error ? cause.message : String(cause)}`, 'read')
    }
  }

  if (ext === '.docx') return extractDocx(buf)
  if (ext === '.pptx') return extractPptx(buf)
  if (ext === '.html' || ext === '.htm') return extractHtml(buf)
  return { kind: 'txt', pages: [{ page: 1, text: decodeText(buf) }] }
}

/**
 * HTML 课件页（2026-10-24 加：主人 PreAP-Biology\HW 就是一堆 .html 页面）
 * 零依赖：去掉 script/style/noscript/注释，块级标签换行，剩下的标签全剥掉，再解实体、压空白。
 * 为什么不进浏览器/不用 DOM：这是索引阶段，几千个页面也要几秒跑完，正则够用且不引依赖。
 */
function extractHtml(buf) {
  let text = decodeText(buf)
  text = text.replace(/<!--[\s\S]*?-->/g, ' ')
  text = text.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
  // 块级元素 → 换行（不然段落会粘成一行）
  text = text.replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
  text = text.replace(
    /<\/?\s*(p|div|li|tr|td|th|table|ul|ol|dl|dt|dd|h[1-6]|section|article|header|footer|nav|aside|figure|figcaption|blockquote|pre|form|fieldset|label|option|address|main)\b[^>]*>/gi,
    '\n',
  )
  // 剩下所有标签一律剥掉（保留其中的文字）
  text = text.replace(/<[^>]+>/g, ' ')
  text = decodeHtmlEntities(text)
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
  const body = lines.join('\n')
  if (!body.trim()) throw new ExtractError('html 里没抽到文字（可能是纯图片页）', 'empty')
  return { kind: 'html', pages: [{ page: 1, text: body }] }
}

/** 只解最常见的几种实体（够用；不引库） */
function decodeHtmlEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&times;/gi, '×')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, code) => {
      const n = Number(code)
      return Number.isFinite(n) && n > 0 && n < 0x10000 ? String.fromCharCode(n) : ' '
    })
}

/** 正则前先把标签换成换行/空格，减少拼接处粘连。 */
function prepareParagraphXml(xml, selfClosingMap) {
  let out = xml
  for (const [tags, replacement] of selfClosingMap) out = replaceSelfClosing(out, tags, replacement)
  return out
}

/** 把一段 XML 按 `</w:p>` / `</a:p>` 切段，每段只留指定标签的文本。 */
function paragraphsOf(xml, paragraphClose, textTag) {
  const paragraphs = []
  for (const raw of xml.split(paragraphClose)) {
    const text = collectTagText(raw, textTag).replace(/\s+/g, ' ').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs
}

/** 抽 docx：一个“页”（docx 没有可靠页码，按参考实现记 page=1）。 */
function extractDocx(buf) {
  const entries = zipEntriesOrThrow(buf, '.docx')
  const doc = entries.find((entry) => entry.name === 'word/document.xml')
  if (!doc) {
    throw new ExtractError(
      'ZIP 里没有 word/document.xml（不是 Word 文档 / 可能是 .doc 或加密文档 / 或已损坏）',
      'no-entries',
    )
  }
  const xml = readEntryOrThrow(buf, doc).toString('utf8')
  const prepared = prepareParagraphXml(xml, [
    [['w:tab'], ' '],
    [['w:br', 'w:cr'], '\n'],
  ])
  const paragraphs = paragraphsOf(prepared, '</w:p>', 'w:t')
  return { kind: 'docx', pages: [{ page: 1, text: paragraphs.join('\n') }] }
}

/** 抽 pptx：一页一张幻灯片（slide 从文件名里的数字来，按数字排序）。 */
function extractPptx(buf) {
  const entries = zipEntriesOrThrow(buf, '.pptx')
  const slideEntries = entries
    .map((entry) => ({ entry, match: /^ppt\/slides\/slide(\d+)\.xml$/.exec(entry.name) }))
    .filter((item) => item.match !== null)
    .map((item) => ({ entry: item.entry, slide: Number.parseInt(item.match[1], 10) }))
    .sort((a, b) => a.slide - b.slide)

  if (!slideEntries.length) {
    throw new ExtractError(
      'ZIP 里没有 ppt/slides/slideN.xml（不是 .pptx / 可能是 .ppt 或加密文档 / 或已损坏）',
      'no-entries',
    )
  }

  const pages = []
  const badPages = []
  for (const { entry, slide } of slideEntries) {
    let xml
    try {
      xml = readEntryOrThrow(buf, entry).toString('utf8')
    } catch (cause) {
      badPages.push(`${slide} (${cause instanceof Error ? cause.message : String(cause)})`)
      continue
    }
    const prepared = prepareParagraphXml(xml, [[['a:br'], '\n']])
    const paragraphs = paragraphsOf(prepared, '</a:p>', 'a:t')
    pages.push({ slide, text: paragraphs.join('\n') })
  }

  const result = { kind: 'pptx', pages }
  if (badPages.length) {
    // 单页坏了不算整个文件失败：把原因挂到返回值上，由调用方记 warning 但继续索引好页
    result.partialWarning = `第 ${badPages.join('、')} 张幻灯片读取失败，已跳过`
  }
  return result
}

/** 抽 pdf：可选 Python 子进程（PyMuPDF）。不可用时抛错，由调用方记 warning。 */
function extractPdf(absPath) {
  const capability = pdfCapability()
  if (!capability.python) throw new ExtractError(capability.reason, 'pdf_unavailable')

  const result = spawnSync(capability.python, [PDF_SCRIPT, absPath], {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.error) {
    throw new ExtractError(`PDF 子进程起不来：${result.error.message}`, 'pdf_subprocess')
  }
  if (result.status !== 0) {
    const detail = (result.stderr || '').trim().split(/\r?\n/).slice(-2).join(' / ')
    throw new ExtractError(`PDF 子进程异常退出（${result.status}）${detail ? `：${detail}` : ''}`, 'pdf_subprocess')
  }

  let payload
  try {
    payload = JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || 'null')
  } catch {
    throw new ExtractError('PDF 子进程输出不是 JSON（可能是中文编码问题）', 'pdf_parse')
  }

  if (!payload || payload.ok !== true) {
    const reason = payload && payload.error ? payload.error : 'PDF 抽取失败（原因未知）'
    throw new ExtractError(reason, payload && payload.code ? String(payload.code) : 'pdf_failed')
  }

  const pages = (payload.pages || []).map((page) => ({
    page: Number(page.page) || 1,
    text: String(page.text || '').trim(),
  }))
  if (!pages.length) throw new ExtractError('PDF 里没有可抽取的文字（可能是扫描图片版）', 'pdf_empty')
  return { kind: 'pdf', pages }
}

function zipEntriesOrThrow(buf, ext) {
  try {
    return readZipEntries(buf)
  } catch (cause) {
    throw new ExtractError(describeZipError(cause, ext), 'zip')
  }
}

function readEntryOrThrow(buf, entry) {
  try {
    return readZipEntry(buf, entry)
  } catch (cause) {
    throw new ExtractError(describeZipError(cause, ''), 'zip')
  }
}

/** 把 ZIP 错误翻成人话（区分“格式问题”和“文件坏了”）。 */
export function describeZipError(cause, ext) {
  if (!(cause instanceof ZipError)) {
    return `解析失败：${cause instanceof Error ? cause.message : String(cause)}`
  }
  switch (cause.code) {
    case 'too-short':
      return `不是有效的 ZIP/Office 文件（${cause.message}）`
    case 'no-eocd':
      return `不是有效的 ZIP/Office 文件：可能被密码加密（加密的 Office 文档不是 ZIP），或文件损坏 —— ${cause.message}`
    case 'zip64-unsupported':
      return `ZIP64 格式不支持（不是 Office 正常文件？）：${cause.message}`
    case 'unsupported-method':
      return `压缩方式不支持（可能被加密）：${cause.message}`
    case 'corrupt':
    case 'out-of-range':
      return `ZIP 结构损坏：${cause.message}`
    default:
      return `ZIP 解析失败${ext ? `（${ext}）` : ''}：${cause.message}`
  }
}

function decodeText(buf) {
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n/g, '\n')
}
