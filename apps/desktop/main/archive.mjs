/**
 * apps\desktop\main\archive.mjs —— 已完成的待办「只留一周」：归档，不真删
 *
 * 2026-10-25 P1-2：从 apps\desktop\main.mjs 整段搬出来（逻辑原样）。
 * 主人的口径：一周后**归档不真删**（tasks.archive.jsonl，按完成时间算，启动+每 6 小时扫，动手前先备份）。
 * 实现在 info\archive-done.mjs；这里只负责：干跑 → 有东西才备份 → 真归档 + 重刷三份文件。
 */

export function createArchive (deps) {
  const { log, MOCK, SELFTEST, INFO_DIR, DATA_ROOT, existsSync, join, spawnSync, runNode, lastJson, STUDY_LITE } = deps
// ══════════════════════════════════════════════════════════════════════════════
//  已完成的待办「只留一周」：归档，不真删（2026-10-24 主人拍板 · 批次 2.1）
// ══════════════════════════════════════════════════════════════════════════════
/**
 * 主人的口径：「一周后：**归档不真删**（tasks.archive.jsonl，按完成时间算，启动+每天扫，动手前先备份）」
 * 实现在 `info\archive-done.mjs`（读 study-core 的 store，动作确定、可 CLI 单跑）。
 * 这里的职责只有三件：**先干跑**（不悄悄动数据）→ **有东西就先备份** → **真归档 + 重刷三份文件**。
 */
const ARCHIVE_TOOL = join(INFO_DIR, 'archive-done.mjs')
const BACKUP_TOOL = join(INFO_DIR, '备份数据.ps1')
const ARCHIVE_FILE = `${DATA_ROOT}/_study-core/tasks.archive.jsonl`

function archiveDoneTasks(opts) {
  const o = opts || {}
  if (!existsSync(ARCHIVE_TOOL)) return { ok: false, error: '找不到 info\\archive-done.mjs' }
  const days = Number.isFinite(Number(o.days)) ? Math.max(0, Math.round(Number(o.days))) : 7
  // ① 干跑：先看清有几条，别上来就动
  const dry = lastJson(runNode(ARCHIVE_TOOL, ['--days', String(days)], 30000)) || {}
  if (!dry || dry.ok === false) return { ok: false, error: (dry && dry.error) || '干跑失败（见 out\\her-app.log）', dry }
  if (Number(dry.wouldArchive) === 0) {
    return { ok: true, archived: 0, wouldArchive: 0, days, file: dry.file, kept: dry.kept, note: '没有满一周的已完成待办' }
  }
  // ② 动手前先备份（主人定的规矩；自检 / 假数据不碰真备份）
  let backup = null
  if (!MOCK && !SELFTEST && existsSync(BACKUP_TOOL)) {
    try {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BACKUP_TOOL, '-Backup'], {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      })
      backup = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || ''
      log(`归档前备份：exit=${r.status}${backup ? ' / ' + backup.slice(0, 100) : ''}`)
    } catch (err) {
      log('归档前备份失败（照样归档，但请留意 tasks.json 的 .bak）：' + ((err && err.message) || err))
    }
  }
  // ③ 真归档（先追加 archive 文件、再动 tasks.json，删错了能抄回来）
  const applied = lastJson(runNode(ARCHIVE_TOOL, ['--days', String(days), '--apply'], 40000)) || {}
  if (applied && applied.ok !== false && Number(applied.archived) > 0) {
    log(
      `归档了 ${applied.archived} 条（已完成满 ${days} 天）：${(applied.titles || []).join(' / ').slice(0, 90)} → ${applied.file}`,
    )
    // 三份给人看的文件跟着重刷，别让界面还挂着已经归档的那几条
    try {
      runNode(STUDY_LITE, ['--refresh'], 25000)
    } catch {}
  } else if (applied && applied.ok === false) {
    log('归档失败：' + (applied.error || '未知原因'))
  }
  return Object.assign({ ok: applied.ok !== false, days, backup }, applied)
}

/** 启动 + 每 6 小时扫一次（"每天扫"的自然实现；干跑没东西时几乎不花时间） */
function startArchiveScheduler() {
  if (MOCK || SELFTEST) return
  const run = () => {
    try {
      const r = archiveDoneTasks({})
      if (r && r.archived > 0) log(`归档：这次挪走 ${r.archived} 条（满 7 天的已完成）`)
    } catch (err) {
      log('归档出错：' + ((err && err.message) || err))
    }
  }
  setTimeout(run, 25000)
  setInterval(run, 6 * 3600 * 1000)
  log('归档起来了：已完成的待办满 7 天挪进 tasks.archive.jsonl（启动 + 每 6 小时扫；动手前先备份）')
}

  return {
    ARCHIVE_FILE,
    ARCHIVE_TOOL,
    BACKUP_TOOL,
    archiveDoneTasks,
    startArchiveScheduler,
  }
}
