#!/usr/bin/env node
/**
 * info/mistake-add.mjs —— 从界面「＋新增」记一条错题（2026-10-24 晚，批次 2.2b）
 *
 * 走的是**已经写好、已经有测试**的那套：`packages/study-core/src/core/mistakes.ts` 的 `MistakeBook`
 *   → 维护 `新建\_AURORA工作区\错题本生成器\entries.json`（序号接最大 +1、不复用；动手前压快照栈）
 *   → 调主人自己的 `make_cuotiben.js` 重新排版 `新建\错题本.docx`
 * 这个脚本不自创数据形状，只当"界面 → MistakeBook"的窄口通道。
 *
 * 用法：
 *   node info/mistake-add.mjs --subject bio --question "题干…" --mine B --right C [--cause "…"]
 *        [--date 2026-10-24] [--source "AP Bio Unit 2 Quiz 第 7 题"] [--apply] [--out <预览 docx>]
 *
 * 默认**不动正式 docx**：只写到 `--out`（默认 out\错题本-预览.docx）；加 `--apply` 才覆盖
 * `新建\错题本.docx`（覆盖前会把旧的复制到 `_AURORA工作区\备份\错题本_<N>条_<日期>.docx`）。
 *
 * 主人 2026-10-24 拍的三条：
 *   ① 不动 `round-state.json` 的轮次（不让已定稿的 19 条被打回第 1 轮）—— 这里写盘后恢复成原来的轮次
 *   ② docx 先出预览，点头才 `--apply`
 *   ③ 长期方案写 REMINDER 只在他明说时做 —— 这个脚本**根本不碰** reminder.json
 *
 * 输出一行 JSON：{ok, seq, count, entries, preview, applied, warnings:[], markdown}
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_PROJECT_ROOT || 'AURORA_DATA web/DSH-PROJECT'
const lib = (name) => new URL(`packages/study-core/lib/src/core/${name}`, pathToFileURL(`${ROOT}/`)).href

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const DATA_ROOT = opt('data-root', process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`)
const GENERATOR = opt('generator', join(DATA_ROOT, '新建', '_AURORA工作区', '错题本生成器'))
const PREVIEW = opt('out', join(ROOT, 'out', '错题本-预览.docx'))
const APPLY = flag('apply')

const out = (obj) => console.log(JSON.stringify(obj))
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

try {
  const { MistakeBook } = await import(lib('mistakes.js'))
  const { resolveSubjectId } = await import(lib('subjects.js'))

  const question = String(opt('question', '') || '').trim()
  const mine = String(opt('mine', '') || '').trim()
  const right = String(opt('right', '') || '').trim()
  const cause = String(opt('cause', '') || '').trim()
  const solutions = String(opt('solutions', '') || '')
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*[·•\-*]\s*/, '').trim())
    .filter(Boolean)
  const date = String(opt('date', '') || '').trim() || ymd(new Date())
  const subjectText = String(opt('subject', '') || '').trim()
  const source = String(opt('source', '') || '').trim()
  if (!question) {
    out({ ok: false, error: '题面是空的（要至少把题干抄进来；看不清就留空也能记，但会进 1.5 轮）' })
    process.exit(0)
  }

  const subjectId = subjectText ? resolveSubjectId(subjectText) || undefined : undefined
  const sourceText = source || [subjectText || '（没写科目）', '界面上记的'].filter(Boolean).join(' · ')

  // ① 动手前留一份（沿用主人目录里 .bak- 的老规矩）
  const entriesPath = join(GENERATOR, 'entries.json')
  const statePath = join(GENERATOR, 'round-state.json')
  let backup = null
  if (existsSync(entriesPath)) {
    backup = `${entriesPath}.bak-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
    copyFileSync(entriesPath, backup)
  }
  // ② 记下"原来的轮次"，写盘以后恢复（主人拍的第 ① 条）
  const stateBefore = (() => {
    try {
      return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null
    } catch {
      return null
    }
  })()

  const book = MistakeBook.open({ generatorDir: GENERATOR, reminderJson: join(GENERATOR, 'reminder.json') })
  const before = book.allEntries().length
  const result = book.addEntries([
    { sourceText, questionText: question, myAnswer: mine, correctAnswer: right, subjectId, date },
  ])
  const added = book.allEntries()[book.allEntries().length - 1]
  const seq = added ? added.seq : -1

  // ③ 表单里写了错因就顺手回填（第 2 轮那一步，但不改轮次）
  if (cause && seq > 0) {
    book.recordCauses({
      causes: [{ seq, cause }],
      solutions: solutions.length > 0 ? [{ seq, points: solutions }] : undefined,
    })
  }

  // ④ 把轮次恢复成写之前的样子（没有 state 文件就写回默认第 1 轮 + 空 openSeqs）
  try {
    const now = JSON.parse(readFileSync(statePath, 'utf8'))
    const keep = stateBefore && stateBefore.state ? stateBefore.state : { round: 1, openSeqs: [] }
    now.state = {
      ...now.state,
      round: keep.round ?? 1,
      openSeqs: Array.isArray(keep.openSeqs) ? keep.openSeqs : [],
      lastAction: `界面＋新增：记了第 ${seq} 条错题（轮次未动）`,
      // 水位必须保留（不然"删掉的序号不复用"会静默失效）
      seqHighWater: Math.max(Number(now.state && now.state.seqHighWater) || 0, seq),
    }
    writeFileSync(statePath, `${JSON.stringify(now, null, 1)}\n`, 'utf8')
  } catch (err) {
    out({ ok: false, error: '轮次没恢复成功（entries 已经写好了）：' + (err && err.message) })
    process.exit(0)
  }

  // ⑤ docx：默认只出预览；--apply 才覆盖正式文件（覆盖前备份旧的）
  let preview = null
  let applied = null
  const wantReal = APPLY
  const target = wantReal ? null : PREVIEW
  try {
    mkdirSync(dirname(target || PREVIEW), { recursive: true })
    process.env.CUOTIBEN_OUT = target || PREVIEW
    const regen = book.regenerate()
    preview = { path: target || PREVIEW, ok: regen.ok, message: regen.message }
  } catch (err) {
    preview = { path: target || PREVIEW, ok: false, message: String((err && err.message) || err) }
  }
  if (wantReal) {
    const realOut = join(DATA_ROOT, '新建', '错题本.docx')
    try {
      if (existsSync(realOut)) {
        const bakDir = join(DATA_ROOT, '新建', '_AURORA工作区', '备份')
        mkdirSync(bakDir, { recursive: true })
        const bak = join(bakDir, `错题本_${before}条_${ymd(new Date()).replace(/-/g, '')}.docx`)
        copyFileSync(realOut, bak)
      }
      delete process.env.CUOTIBEN_OUT
      const regen = book.regenerate()
      applied = { path: realOut, ok: regen.ok, message: regen.message }
    } catch (err) {
      applied = { path: realOut, ok: false, message: String((err && err.message) || err) }
    }
  }

  out({
    ok: true,
    seq,
    count: book.allEntries().length,
    before,
    preview,
    applied,
    entriesPath,
    backup: backup ? basename(backup) : null,
    round: '未动（' + (stateBefore && stateBefore.state ? stateBefore.state.round : 1) + ' 轮）',
    cause,
    solutions,
    warnings: result.warnings || [],
    markdown: String(result.markdown || '').slice(0, 400),
  })
} catch (cause) {
  out({ ok: false, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) })
  process.exitCode = 1
}
