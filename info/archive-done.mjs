#!/usr/bin/env node
/**
 * info/archive-done.mjs —— 「已完成的待办只留一周」：**归档，不真删**（2026-10-24）
 *
 * 主人 2026-10-24 拍板的口径：
 *   「一周后：**归档不真删**（tasks.archive.jsonl，按完成时间算，启动+每天扫，动手前先备份）」
 *
 * 所以这个脚本只做一件确定的事：
 *   status = done 且「完成时间」早于 N 天（默认 7）→ 从 tasks.json 里**挪走**，
 *   整条追加进 `<数据目录>\tasks.archive.jsonl`（一行一条，带 archivedAt / reason）。
 *   → 界面上看不见了，但文件里还在，随时能抄回 tasks.json。
 *
 * 完成时间怎么认（不猜，按顺序取第一个说得通的）：
 *   1) `updatedAt` —— 我们勾掉（withStatus）时就是这个时刻（最准）
 *   2) `doneAt`（万一以后加了）
 *   3) `dueAt`   —— 兜底：至少不会比截止时间晚一周
 *
 * 用法：
 *   node info/archive-done.mjs                 # 只报告，不改任何东西（dry run，默认）
 *   node info/archive-done.mjs --apply         # 真动手（删之前请自己先跑 备份数据.ps1 -Backup）
 *   node info/archive-done.mjs --days 14       # 换阈值
 *   node info/archive-done.mjs --data <目录>   # 换数据目录（自检用隔离目录，绝不碰主人的）
 *   node info/archive-done.mjs --apply --data <目录>
 *
 * 输出永远是一行 JSON：{ok, dry, days, archived, ids:[…], file, kept, errors:[]}
 */

import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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
const DATA_ROOT = process.env.DSH_DATA || `(process.env.AURORA_DATA || 'D:/AURORA/data')`
const DATA = opt('data', `${DATA_ROOT}/_study-core`)
const DAYS = (() => {
  const n = Number(opt('days', '7'))
  return Number.isFinite(n) && n >= 0 ? n : 7
})()
const APPLY = flag('apply')
const FILE = join(DATA, 'tasks.archive.jsonl')

const out = (obj) => console.log(JSON.stringify(obj))

/** 一条已完成任务的"完成时间"（毫秒）；认不出返回 NaN */
function completedMs(task) {
  for (const key of ['doneAt', 'updatedAt', 'dueAt']) {
    const v = task && task[key]
    if (typeof v === 'string' && v.trim()) {
      const ms = Date.parse(v)
      if (Number.isFinite(ms)) return ms
    }
  }
  return NaN
}

try {
  const { TaskStore } = await import(lib('store.js'))
  const store = TaskStore.open(DATA)
  const now = Date.now()
  const cutoff = now - DAYS * 86400000
  const all = store.list()
  const hit = []
  const errors = []
  for (const task of all) {
    if (!task || String(task.status) !== 'done') continue
    const ms = completedMs(task)
    if (!Number.isFinite(ms)) {
      errors.push(`认不出完成时间：${task.id}（${task.title}）—— 不动它`)
      continue
    }
    if (ms <= cutoff) hit.push({ task, doneMs: ms })
  }

  let archived = 0
  if (APPLY && hit.length > 0) {
    const lines = []
    for (const { task, doneMs } of hit) {
      lines.push(
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          reason: `已完成满 ${DAYS} 天`,
          completedAt: new Date(doneMs).toISOString(),
          task,
        }),
      )
    }
    appendFileSync(FILE, lines.join('\n') + '\n', 'utf8')
    // 追加成功以后才动 tasks.json（先留档、再删；删错了还能捞回来）
    for (const { task } of hit) {
      if (store.remove(task.id)) archived += 1
      else errors.push(`挪走了但 remove 失败：${task.id}`)
    }
  }

  out({
    ok: true,
    dry: !APPLY,
    days: DAYS,
    archived: APPLY ? archived : hit.length,
    wouldArchive: hit.length,
    ids: hit.map((h) => h.task.id),
    titles: hit.map((h) => h.task.title),
    file: FILE,
    fileExists: existsSync(FILE),
    kept: store.list().length,
    total: all.length,
    errors,
  })
} catch (cause) {
  out({ ok: false, error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause), file: FILE, days: DAYS })
  process.exitCode = 1
}
