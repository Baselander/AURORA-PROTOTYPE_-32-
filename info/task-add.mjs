#!/usr/bin/env node
/**
 * info/task-add.mjs —— 从界面「＋新增」加一条任务（2026-10-24 晚，批次 2.2a）
 *
 * 为什么单独一个脚本：加任务要**走 study-core 的同一套校验/去重/原子写**（不然和收件箱、
 * 和她自己的工具 `study_task_add` 会写出两种形状的数据）。这个脚本就是那条窄口通道：
 * 参数进 → createTask + store.upsert → 一行 JSON 出。
 *
 * 用法：
 *   node info/task-add.mjs --title "bio WS 第 4 章" [--subject biology] [--due 2026-10-27] [--time 22:00]
 *                          [--detail "老师说要写过程"] [--kind homework|todo] [--data <目录>]
 *
 * 输出（一行 JSON）：{ok, action:'created'|'merged', task:{id,title,dueAt,kind,subjectId}, notes:[], file}
 * 失败：{ok:false,error}
 *
 * ⚠️ 认不出科目 → 就当 to-do（主人 2026-10-21 的口径）；这里**不猜科目**，认不出就留空。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_PROJECT_ROOT || 'AURORA_DATA web/DSH-PROJECT'
const lib = (name) => new URL(`packages/study-core/lib/src/core/${name}`, pathToFileURL(`${ROOT}/`)).href

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const G10 = process.env.DSH_G10_ROOT || 'AURORA_DATA'
const DATA_ROOT = process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const DATA = opt('data', `${DATA_ROOT}/_study-core`)

const out = (obj) => console.log(JSON.stringify(obj))

try {
  const { TaskStore } = await import(lib('store.js'))
  const { createTask } = await import(lib('tasks.js'))
  const { resolveSubjectId, subjectDisplayName } = await import(lib('subjects.js'))
  const { makeLocalDateTime, formatIsoWithOffset } = await import(lib('datetime.js'))

  const title = String(opt('title', '') || '').trim()
  if (!title) {
    out({ ok: false, error: '标题不能是空的' })
    process.exit(0)
  }
  const subjectText = String(opt('subject', '') || '').trim()
  let subjectId
  if (subjectText) {
    // 界面可能给缩写（bio）、中文名（生物）、也可能给 id（biology）：三种都试
    subjectId = resolveSubjectId(subjectText)
    if (!subjectId) {
      const all = (await import(lib('subjects.js'))).allSubjects()
      const hit = all.find((s) => s.id === subjectText || s.name === subjectText || s.name.includes(subjectText))
      subjectId = hit ? hit.id : undefined
    }
  }
  const dueDate = String(opt('due', '') || '').trim()
  const dueTime = String(opt('time', '') || '').trim() || '22:00'
  let dueAt
  let dueBasis
  if (dueDate) {
    const dt = makeLocalDateTime(dueDate, dueTime)
    if (!dt) {
      out({ ok: false, error: `认不出这个日期/时间：${dueDate} ${dueTime}` })
      process.exit(0)
    }
    dueAt = formatIsoWithOffset(dt)
    dueBasis = '在界面上手动加的（＋新增）'
  }
  const kindOpt = String(opt('kind', '') || '').trim()

  const store = TaskStore.open(DATA)
  const inputs = {
    title,
    subjectId,
    detail: String(opt('detail', '') || '').trim() || undefined,
    dueAt,
    dueSource: dueAt ? 'explicit' : 'none',
    dueConfidence: dueAt ? 'high' : 'low',
    dueBasis,
    kind: kindOpt === 'homework' || kindOpt === 'todo' ? kindOpt : undefined,
    source: { kind: 'manual', ref: '界面＋新增', capturedAt: new Date().toISOString() },
    rawSnippets: [],
  }
  /**
   * ⚠️ 2026-10-24 踩到：`createTask` 的 id 是"时间戳 + 进程内计数器"，
   *   而**每次 CLI 都是一个新进程**，计数器从 0 开始 —— 同一秒里连着加两条就会撞 id
   *   （两条任务共用一个 id，勾一条等于勾两条，删一条会删错）。
   *   → 这里对着库里的 id 查一遍，撞了就换成同一时间戳下的下一个空号。
   */
  const existing = new Set(store.list().map((t) => t.id))
  let task = createTask(inputs)
  if (existing.has(task.id)) {
    const stem = task.id.replace(/-[0-9]+$/, '')
    let n = 1
    let cand = ''
    do {
      cand = `${stem}-${String(n).padStart(3, '0')}`
      n += 1
    } while (existing.has(cand) && n < 999)
    task = createTask({ ...inputs, id: cand })
  }
  const outcome = store.upsert(task)
  out({
    ok: true,
    action: outcome.action,
    mergedInto: outcome.mergedInto,
    notes: outcome.notes,
    file: store.filePath,
    task: {
      id: outcome.task.id,
      title: outcome.task.title,
      kind: outcome.task.kind,
      status: outcome.task.status,
      subjectId: outcome.task.subjectId ?? null,
      subjectName: outcome.task.subjectId ? subjectDisplayName(outcome.task.subjectId) : null,
      dueAt: outcome.task.dueAt ?? null,
      createdAt: outcome.task.createdAt,
    },
  })
} catch (cause) {
  out({ ok: false, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) })
  process.exitCode = 1
}
