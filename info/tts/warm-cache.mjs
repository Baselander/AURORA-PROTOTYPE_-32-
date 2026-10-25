#!/usr/bin/env node
/**
 * info\tts\warm-cache.mjs —— 把"日常话"预录进 out\tts\cache（2026-10-25）
 *
 * 主人：「把语音模型中念这段的直接录音保存，省的每次都生成了」。
 * 这个脚本走 edge_serve.py 的同一套 stdin/stdout 协议，把 DAILY_LINES 里没录过的句子合成成 mp3。
 * ⚠️ 要联网；一句话 1~2 秒。文件名 = sha1(文本).slice(0,16) + .mp3 —— 跟 apps\desktop\main.mjs 的
 *    `ttsCachePath()` 必须一致（改了这里也要改那边）。
 *
 * 用法：node info\tts\warm-cache.mjs [--force]
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', '..', 'out', 'tts', 'cache')
const EDGE = join(HERE, 'edge_serve.py')

// ⚠️ 必须和 apps\desktop\main.mjs 的 DAILY_LINES 一致
const DAILY_LINES = [
  '在的在的',
  '我盯着呢',
  '这题我先看一眼',
  '等我一下',
  '记下来了',
  '该喝水啦',
  '先吃饭还是先写？',
  '作业没写完不许玩',
  '我在，别怕',
  '收拾书包去',
  '今天也辛苦啦',
  '早点睡，明天还上课',
]

const force = process.argv.includes('--force')
const cachePath = (text) => join(OUT_DIR, createHash('sha1').update(String(text).trim()).digest('hex').slice(0, 16) + '.mp3')

mkdirSync(OUT_DIR, { recursive: true })
const todo = DAILY_LINES.filter((line) => force || !existsSync(cachePath(line)))
if (todo.length === 0) {
  console.log(JSON.stringify({ ok: true, queued: 0, skipped: DAILY_LINES.length, dir: OUT_DIR }))
  process.exit(0)
}
if (!existsSync(EDGE)) {
  console.log(JSON.stringify({ ok: false, error: '找不到 info\\tts\\edge_serve.py' }))
  process.exit(1)
}

const proc = spawn('python', ['-u', EDGE], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buf = ''
let ok = 0
let fail = 0
const lines = []
const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 180000)
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) {
        try {
          const j = JSON.parse(line)
          if (j.ok && j.out) ok += 1
          else if (j.ok === false) {
            fail += 1
            lines.push(String(j.error || '').slice(0, 80))
          }
        } catch {}
      }
      nl = buf.indexOf('\n')
    }
    if (ok + fail >= todo.length) {
      clearTimeout(timer)
      resolve('done')
    }
  })
  proc.stderr.on('data', (c) => lines.push('stderr:' + c.toString('utf8').trim().slice(0, 80)))
})

for (const text of todo) {
  proc.stdin.write(JSON.stringify({ text, out: cachePath(text) }) + '\n')
}
console.log(JSON.stringify({ ok: true, queued: todo.length, dir: OUT_DIR, ...(await done) }))
try {
  proc.stdin.write(JSON.stringify({ quit: true }) + '\n')
} catch {}
setTimeout(() => {
  try {
    proc.kill()
  } catch {}
  console.log(JSON.stringify({ ok: fail === 0, made: ok, failed: fail, problems: lines.slice(0, 3), dir: OUT_DIR }))
  process.exit(fail === 0 ? 0 : 1)
}, 1200)
