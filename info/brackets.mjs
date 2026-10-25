/**
 * info\brackets.mjs —— 方括号 = 控制模型，小括号 = 给人看（2026-10-25 主人定的口径）
 *
 *   `[动作：吹泡泡]` / `[表情：脸红]` / `[造型：马尾]` / `[道具：菜单板]`
 *        → 变成**控制指令**（`{kind, value}`），并**从正文里剥掉**
 *          （不然会原样显示、还会被 TTS 念出来）
 *   `(旁白……)` → 原样留着 —— 那是她给人看的，不产生任何实际动作
 *
 * 单独放一个文件是为了让 brain.mjs 和 apps\desktop\main.mjs 都能用同一套规则，
 * 而且**能单独测**（brain.mjs 一 import 就会跑 main()，没法当库用）。
 */

const BRACKET_RE = /^\s*(动作|表情|造型|道具|motion|expression|props)\s*[:：]\s*(.+?)\s*$/

/**
 * 流式用的"扫把"：一个控制标记可能被拆在两个 delta 里，所以遇到 `[` 先攒着，
 * 等 `]` 到了再判断；攒太久（>60 字）就当普通方括号吐出去，免得卡住正文。
 */
export function makeBracketBroom() {
  let pending = ''
  const controls = []
  return {
    feed(chunk) {
      pending += String(chunk == null ? '' : chunk)
      let text = ''
      for (;;) {
        const open = pending.indexOf('[')
        if (open < 0) {
          text += pending
          pending = ''
          break
        }
        text += pending.slice(0, open)
        pending = pending.slice(open)
        const close = pending.indexOf(']')
        if (close < 0) {
          if (pending.length > 60) {
            text += pending
            pending = ''
          }
          break
        }
        const inner = pending.slice(1, close)
        pending = pending.slice(close + 1)
        const m = BRACKET_RE.exec(inner)
        if (m) controls.push({ kind: m[1], value: m[2] })
        else text += `[${inner}]`
      }
      return text
    },
    flush() {
      const tail = pending
      pending = ''
      return tail
    },
    controls,
  }
}

/** 整段处理（不流式的地方用：气泡、念稿） */
export function stripBracketControls(text) {
  const broom = makeBracketBroom()
  const clean = broom.feed(text) + broom.flush()
  return { text: clean, controls: broom.controls }
}
