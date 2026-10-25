/**
 * apps\desktop\renderer\pages\settings.js —— 「设置」页（2026-10-23 改）
 *
 * 主人 2026-10-23：「右键之后只有主要的界面、把所有只要不是主要的东西都放到浮窗卡片里面」
 * → 右键菜单只剩 浮窗开合 + 六个页面 + 关掉她；
 *   剩下的（置顶 / 大小 / 声音 / 透明度 / 读钉钉 / 备份 / 规矩文件 / 重载 / 旧浮窗 / 退出）
 *   **全部搬到这里**。
 *
 * 还有「她今天的打扮」：她自己挑的（在她自己的 `她的打扮.json` 里），
 * 这里也能替她改某一组 —— 但"她决定自己穿什么"这件事归她自己，不是我们去摆弄模型。
 */

import { h, clear } from './dom.js'
import { openSheet, closeSheet, sheetHead, sheetRow } from './sheet.js'

/** 周一 … 周日（每日提醒里 days 用的是 1~7） */
const WD_ZH = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 学科学习计划的编辑浮层（2026-10-24 · Tevela F）
 * plan 为空 = 新增一门；有值 = 改这一门（科目名不给改，免得把两条合成一条）。
 */
function openPlanSheet(plan, ctx) {
  const cur = plan || { subject: '', plan: '', progress: 0 }
  const subjInput = document.createElement('input')
  subjInput.type = 'text'
  subjInput.className = 'her-input'
  subjInput.id = 'her-plan-subject'
  subjInput.value = cur.subject || ''
  subjInput.placeholder = '科目名（例：Pre-AP Biology）'
  if (plan) subjInput.readOnly = true

  const planInput = document.createElement('textarea')
  planInput.className = 'her-textarea'
  planInput.id = 'her-plan-text'
  planInput.value = cur.plan || ''
  planInput.placeholder = '打算怎么学（例：先把第 4 章概念过一遍 → 做 10 道题 → 错题抄进错题本）'

  const progLabel = h('span', 'her-slider-val', `${cur.progress}%`)
  const prog = document.createElement('input')
  prog.type = 'range'
  prog.className = 'her-range'
  prog.min = '0'
  prog.max = '100'
  prog.step = '5'
  prog.value = String(cur.progress)
  prog.id = 'her-plan-progress'
  prog.addEventListener('input', () => {
    progLabel.textContent = `${prog.value}%`
  })

  const actions = [
    {
      label: '存下来',
      primary: true,
      onClick: async (btn) => {
        const subject = String(subjInput.value || '').trim()
        if (!subject) {
          subjInput.focus()
          btn.textContent = '先写科目'
          return
        }
        btn.disabled = true
        btn.textContent = '正在存…'
        try {
          const r = await window.herShell.act('plan-set', { subject, plan: String(planInput.value || ''), progress: Number(prog.value) })
          if (r && r.ok !== false) {
            btn.textContent = '存好了'
            closeSheetAnd(() => ctx && ctx.refresh && ctx.refresh())
          } else {
            btn.textContent = '没存成：' + ((r && r.error) || '')
            btn.disabled = false
          }
        } catch (err) {
          btn.textContent = '没存成：' + ((err && err.message) || err)
          btn.disabled = false
        }
      },
    },
  ]
  if (plan) {
    actions.push({
      label: '删掉这门',
      onClick: async (btn) => {
        btn.disabled = true
        try {
          const r = await window.herShell.act('plan-remove', plan.subject)
          if (r && r.ok !== false) closeSheetAnd(() => ctx && ctx.refresh && ctx.refresh())
          else {
            btn.textContent = '没删成：' + ((r && r.error) || '')
            btn.disabled = false
          }
        } catch (err) {
          btn.textContent = '没删成：' + ((err && err.message) || err)
          btn.disabled = false
        }
      },
    })
  }

  openSheet({
    title: cur.subject || '新增一门课的打算',
    subtitle: '打算怎么学 + 现在到哪一步（0~100）',
    actions,
    build: (body) => {
      body.appendChild(sheetHead('哪门课'))
      body.appendChild(subjInput)
      body.appendChild(sheetHead('打算怎么学'))
      body.appendChild(planInput)
      body.appendChild(sheetHead('进度'))
      const row = h('div', 'her-slider-row')
      row.append(prog, progLabel)
      body.appendChild(row)
      body.appendChild(sheetRow('注意', '这是你自己写的计划，不是作业；进度也由你自己调。'))
    },
    footer: '存进 _study-core\\学科计划.json。',
  })
}

/** 关掉浮层，再刷新页面（刷新也会收浮层，所以先关再刷） */
function closeSheetAnd(after) {
  try {
    closeSheet()
  } catch {}
  if (typeof after === 'function') setTimeout(after, 60)
}

function kv(el, key, value) {
  const row = h('div', 'her-kv')
  row.appendChild(h('span', 'her-kv-k', key))
  row.appendChild(h('span', 'her-kv-v', value))
  el.appendChild(row)
}

function chip(label, on, onClick, title) {
  const b = h('button', 'her-chip' + (on ? ' her-chip-on' : ''), label)
  b.type = 'button'
  if (title) b.title = title
  b.addEventListener('click', onClick)
  return b
}

function note(el, text) {
  el.appendChild(h('div', 'her-note', text))
}

export function renderSettings(el, data, ctx) {
  clear(el)

  // ── 配色 ──────────────────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h', '配色'))
  const themes = Array.isArray(data.themes) ? data.themes : []
  const box = h('div', 'her-chips')
  for (const name of themes) {
    const b = chip(name, name === data.theme, async () => {
      if (name === data.theme) return
      b.disabled = true
      try {
        const r = await window.herShell.act('set-theme', name)
        if (r && r.ok !== false) {
          data.theme = name
          document.documentElement.dataset.theme = name
          renderSettings(el, data, ctx)
        } else {
          b.title = (r && r.error) || '没改成'
        }
      } catch (err) {
        b.title = String((err && err.message) || err)
      } finally {
        b.disabled = false
      }
    })
    box.appendChild(b)
  }
  el.appendChild(box)
  note(el, '配色写在 `她的限制-形象与互动.txt` 的「主题配色」；改之前会自动存快照，能回滚。')

  // ── 她的大小（滑动栏）─────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h', '她的大小'))
  const sizeRow = h('div', 'her-slider-row')
  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'her-range'
  range.min = '180'
  range.max = '560'
  range.step = '20'
  range.value = String(data.modelHeight || 340)
  const sizeLabel = h('span', 'her-slider-val', `${range.value}px`)
  range.addEventListener('input', () => {
    sizeLabel.textContent = `${range.value}px`
  })
  // 松手才真的换：换尺寸要重开一次形象窗，拖的过程中不能一直重载
  range.addEventListener('change', async () => {
    const h2 = Number(range.value)
    sizeLabel.textContent = `${h2}px（正在重开…）`
    try {
      const r = await window.herShell.act('model-size', h2)
      if (r && r.ok === false) sizeLabel.textContent = '没改成：' + (r.error || '')
    } catch (err) {
      sizeLabel.textContent = '没改成：' + ((err && err.message) || err)
    }
  })
  sizeRow.append(range, sizeLabel)
  el.appendChild(sizeRow)
  note(el, '拖到头松手才生效（换大小要重开一次形象窗，她得重新量自己多高）。')

  // ── 她今天的打扮（她自己挑的）──────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '她今天的打扮'))
  const look = data.look
  const groups = Array.isArray(data.lookGroups) ? data.lookGroups : []
  if (look && look.look) {
    const names = {}
    for (const g of groups) for (const it of g.items) names[it.key || ''] = it.label
    const parts = []
    for (const g of groups) {
      const key = look.look[g.key]
      if (key) parts.push(names[key] || key)
    }
    kv(el, '今天穿', parts.length > 0 ? parts.join(' · ') : '还是平时那一身')
    if (look.why) kv(el, '她自己说', look.why)
    kv(el, '谁定的', look.by === 'she' ? '她自己挑的' : look.by === 'master' ? '主人改的' : '按日期先定了一身（她的大脑没连上）')
    kv(el, '日期', look.date || '—')
  } else {
    note(el, '今天这一身还没定（启动几秒后她会自己挑；也可以点下面那个按钮）。')
  }
  // 装扮听谁的（主人 2026-10-24 深夜：可以选「她自主」和「你选择」）
  const lookMode = data.lookMode === 'master' ? 'master' : 'she'
  const modeRow = h('div', 'her-chips her-look-mode')
  modeRow.dataset.mode = lookMode
  const setMode = async (mode) => {
    try {
      const r = await window.herShell.act('look-mode', { mode })
      if (r && r.ok !== false) {
        data.lookMode = r.mode
        if (ctx && ctx.refresh) ctx.refresh()
      }
    } catch {}
  }
  const mkMode = (mode, label, hint) => {
    const b = chip(label, lookMode === mode, () => void setMode(mode), hint)
    b.dataset.lookMode = mode
    return b
  }
  modeRow.append(
    mkMode('she', '她自主（每天自己挑）', '她自己决定穿什么、发型怎么弄；跨天会换一身'),
    mkMode('master', '你选择（她不动）', '她一直穿你定的那一身，不自己换、也不追问为什么'),
  )
  el.appendChild(modeRow)
  note(
    el,
    lookMode === 'she'
      ? '现在：她自己挑。你改某一组会立刻生效，但她第二天还会自己再挑一身。'
      : '现在：她不动。你点下面任意一组就是最终结果；想让她自己来就切回「她自主」。',
  )

  const lookRow = h('div', 'her-chips')
  lookRow.appendChild(
    chip('让她今天换一身', false, async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.textContent = '她在挑…'
      try {
        const r = await window.herShell.act('look-choose', '')
        if (r && r.ok === false) btn.textContent = '没挑成：' + (r.error || '')
        else if (ctx && ctx.refresh) ctx.refresh()
      } catch (err) {
        btn.textContent = '没挑成：' + ((err && err.message) || err)
      } finally {
        btn.disabled = false
      }
    }),
  )
  el.appendChild(lookRow)
  for (const g of groups) {
    el.appendChild(h('div', 'her-kv-k', g.label))
    const row = h('div', 'her-chips')
    for (const it of g.items) {
      const cur = look && look.look ? look.look[g.key] === it.key : it.key === ''
      row.appendChild(
        chip(it.label, cur, async () => {
          try {
            await window.herShell.act('look-set', { group: g.key, key: it.key })
            if (ctx && ctx.refresh) ctx.refresh()
          } catch {}
        }),
      )
    }
    el.appendChild(row)
  }
  note(el, '她自己挑的那份记在 `_study-core\\她的打扮.json`；这里点一下 = 主人替她改这一组，别的照旧。')

  // ── 声音 ──────────────────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '声音'))
  const speakOn = data.speakOn !== false
  const speakRow = h('div', 'her-chips')
  const setSpeak = async (on) => {
    try {
      const r = await window.herShell.act('set-speak', on ? 'on' : 'off')
      if (r && r.ok === false) data.lastError = (r && r.error) || '没改成'
      else {
        data.speakOn = on
        data.lastError = null
      }
    } catch (err) {
      data.lastError = String((err && err.message) || err)
    }
    renderSettings(el, data, ctx)
  }
  speakRow.append(
    chip('🔊 说话就出声', speakOn, () => {
      if (!speakOn) void setSpeak(true)
    }),
    chip('🔇 不让她出声', !speakOn, () => {
      if (speakOn) void setSpeak(false)
    }),
  )
  el.appendChild(speakRow)
  note(el, '写的是 `她的限制-说话.txt` 的 allow_speak。她自己在气泡里说话也会出声（2026-10-23 修好的）。')

  // ── 嗓子用哪个引擎（2026-10-24 主人：「语音换成 edge 的，更自然一些」）────────
  const voice = data.voice || { engine: 'edge', voice: '' }
  const presets = Array.isArray(data.voicePresets) ? data.voicePresets : []
  const engineLabel =
    (data.voiceActive || voice.engine) === 'edge' ? 'Edge 在线（更像人说话，要联网）' : '本地 piper（离线兜底）'
  kv(el, '现在的嗓子', engineLabel)
  if (voice.engine === 'edge') {
    const hit = presets.find((p) => p.key === voice.voice)
    kv(el, '音色', hit ? hit.label : voice.voice || '—')
  }
  const setVoice = async (patch) => {
    try {
      const r = await window.herShell.act('set-voice', patch)
      if (r && r.ok !== false) {
        if (ctx && ctx.refresh) ctx.refresh()
      } else if (typeof ctx === 'object') {
        data.lastError = (r && r.error) || '没改成'
      }
    } catch (err) {
      data.lastError = String((err && err.message) || err)
    }
  }
  const vEngineRow = h('div', 'her-chips')
  vEngineRow.append(
    chip('用 Edge 的声音', voice.engine === 'edge', () => void setVoice({ engine: 'edge' }), '更自然，但要联网'),
    chip('用本地 piper', voice.engine === 'piper', () => void setVoice({ engine: 'piper' }), '断网 / 装不上 Edge 时的兜底'),
    // 2026-10-25 主人：「把语音模型中念这段的直接录音保存，省的每次都生成了」
    chip(
      '把日常话预录一遍',
      false,
      async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = '正在录…'
        try {
          const r = await window.herShell.act('tts-cache-build', '')
          btn.textContent = r && r.ok !== false ? `录好了 ${r.queued || 0} 句（已有 ${r.skipped || 0}）` : '没录成：' + ((r && r.error) || '')
        } catch (err) {
          btn.textContent = '没录成：' + ((err && err.message) || err)
        } finally {
          btn.disabled = false
        }
      },
      '把「我在的」「该喝水啦」这类日常短句预生成一次，以后直接播（不再每次现合成）',
    ),
  )
  el.appendChild(vEngineRow)
  if (voice.engine === 'edge' && presets.length > 0) {
    const vRow = h('div', 'her-chips')
    for (const p of presets) {
      vRow.appendChild(
        chip(p.label, voice.voice === p.key, () => void setVoice({ engine: 'edge', voice: p.key }), p.key),
      )
    }
    el.appendChild(vRow)
  }
  note(el, '嗓子写在 `info\\tts\\voice.json`（engine / voice / rate）。Edge 连不上会自动退回本地 piper，不会突然哑掉。')

  // ── 语言（2026-10-25 P2）：她这一阵用哪种语言说话 ──────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '语言'))
  {
    const lang = ['follow', 'zh', 'en'].includes(data.lang) ? data.lang : 'follow'
    const langRow = h('div', 'her-chips')
    langRow.id = 'her-lang-row'
    langRow.dataset.lang = lang
    const setLang = async (mode) => {
      try {
        const r = await window.herShell.act('set-lang', mode)
        if (r && r.ok !== false) {
          data.lang = r.mode
          const box = document.getElementById('her-lang-row')
          if (box) {
            box.dataset.lang = r.mode
            for (const b of box.querySelectorAll('.her-chip')) {
              b.classList.toggle('her-chip-on', b.dataset.lang === r.mode)
            }
          }
        }
      } catch {}
    }
    for (const [mode, label, hint] of [
      ['follow', '跟着主人走', '他说中文她中文、他说英文她英文、混着说她也混着说（默认）'],
      ['zh', '只说中文', '这一阵她只用中文回（科目名/术语保留英文原词）'],
      ['en', '只说英文', '这一阵她只用英文回'],
    ]) {
      const b = chip(label, lang === mode, () => void setLang(mode), hint)
      b.dataset.lang = mode
      b.id = 'her-lang-' + mode
      langRow.appendChild(b)
    }
    el.appendChild(langRow)
    note(el, '存在 `_study-core\\她的语言.json`（她自己的状态，不动你写的规矩文件）；改完下一句话就生效。')
  }

  // ── 待机动作（2026-10-25 第 8 项）：她闲着时循环演哪个动作 ──────────────────
  {
    const motions = Array.isArray(data.idleMotions) ? data.idleMotions : []
    const idleNow = String(data.idleNow || '')
    el.appendChild(h('div', 'her-sec-h her-sec-split', '待机动作'))
    const row = h('div', 'her-chips')
    row.id = 'her-idle-row'
    row.dataset.idle = idleNow
    const pickIdle = async (name) => {
      try {
        const r = await window.herShell.act('set-idle', name)
        if (r && r.ok !== false) {
          const box = document.getElementById('her-idle-row')
          if (box) {
            box.dataset.idle = name
            for (const b of box.querySelectorAll('.her-chip')) b.classList.toggle('her-chip-on', (b.dataset.idle || '') === name)
          }
        }
      } catch {}
    }
    const def = chip('（默认 idle）', idleNow === '', () => void pickIdle(''), '模型自带的那条待机动作')
    def.dataset.idle = ''
    def.id = 'her-idle-default'
    row.appendChild(def)
    for (const m of motions) {
      if (m === 'idle') continue
      const b = chip(m, idleNow === m, () => void pickIdle(m), '待机时循环演这个动作')
      b.dataset.idle = m
      b.id = 'her-idle-' + m
      row.appendChild(b)
    }
    el.appendChild(row)
    note(
      el,
      `她闲着时循环演这个动作（可选：${motions.join(' / ') || '读不到 manifest'}）。存在 \`_study-core\\她的打扮.json\` 的 \`look.idle\`，点完立刻生效。`,
    )
  }

  // ── 形象包（2026-10-25 P2）：现在只有一个包，先让她"看得见现状" ─────────────
  {
    const pack = data.modelPack || {}
    el.appendChild(h('div', 'her-sec-h her-sec-split', '形象包'))
    const row = h('div', 'her-chips')
    const b = chip(pack.name ? `现在：${pack.name}` : '现在：默认的那一个', true, () => {}, pack.file || '')
    b.id = 'her-model-pack'
    row.appendChild(b)
    el.appendChild(row)
    // 2026-10-25 第 7 项：真的能切（可选包放 info\pet\assets\model-packs\<名字>\）
    {
      const packs = Array.isArray(data.modelPacks) ? data.modelPacks : []
      const active = String(data.modelPackActive || '')
      const swapRow = h('div', 'her-chips')
      swapRow.id = 'her-model-packs'
      for (const p of packs) {
        const cb = chip(`切到 ${p.name}`, active.startsWith(p.name), async (e) => {
          const btn = e.currentTarget
          btn.disabled = true
          const old = btn.textContent
          btn.textContent = '切…（形象窗要重载）'
          try {
            const r = await window.herShell.act('set-model-pack', { name: p.name })
            btn.textContent = r && r.ok !== false ? `已切到 ${p.name}` : '没切成功：' + ((r && r.error) || '')
          } catch (err) {
            btn.textContent = '没切成功：' + ((err && err.message) || err)
          } finally {
            btn.disabled = false
            setTimeout(() => {
              btn.textContent = old
            }, 2500)
          }
        }, `把这个包装到 assets\\model\\（现在的包会先备份成 model.bak-时间戳）`)
        cb.id = 'her-model-pack-' + p.name
        swapRow.appendChild(cb)
      }
      if (packs.length > 0) el.appendChild(swapRow)
      note(
        el,
        (pack.file ? `模型文件：${pack.file}。` : '') +
          (packs.length > 0
            ? `可选包：${packs.map((x) => x.name).join(' / ')}（放 info\\pet\\assets\\model-packs\\<名字>\\，里面有 *.model3.json 就行）。切换会把选中的包整目录拷进 assets\\model\\、备份旧的、再重载形象窗。`
            : '现在只有一个包。想加新的一身：把 Live2D 包放进 info\\pet\\assets\\model-packs\\<名字>\\（里面有 *.model3.json），刷新这个页面就能看到"切到"。'),
      )
    }
  }
  if (data.lastError) note(el, '上一次操作没成功：' + data.lastError)

  // ── 浮窗（透明度 / 置顶 / 收起来）─────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '浮窗'))
  const alphaRow = h('div', 'her-slider-row')
  const alpha = document.createElement('input')
  alpha.type = 'range'
  alpha.className = 'her-range'
  alpha.min = '55'
  alpha.max = '100'
  alpha.step = '1'
  const startPct = Math.round(Number(data.cardAlpha || 0.97) * 100)
  alpha.value = String(startPct)
  const alphaLabel = h('span', 'her-slider-val', `${startPct}% 不透明`)
  alpha.addEventListener('input', () => {
    alphaLabel.textContent = `${alpha.value}% 不透明`
    document.documentElement.style.setProperty('--card-alpha', String(Number(alpha.value) / 100))
  })
  alpha.addEventListener('change', async () => {
    const v = Number(alpha.value) / 100
    try {
      const r = await window.herShell.act('set-card-alpha', v)
      if (r && r.ok === false) alphaLabel.textContent = '没改成：' + (r.error || '')
      else data.cardAlpha = v
    } catch (err) {
      alphaLabel.textContent = '没改成：' + ((err && err.message) || err)
    }
  })
  alphaRow.append(alpha, alphaLabel)
  el.appendChild(alphaRow)

  const topRow = h('div', 'her-chips')
  topRow.appendChild(
    chip('置顶（压在最上面）', !!data.topMost, async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      try {
        const r = await window.herShell.act('set-topmost', data.topMost ? 'off' : 'on')
        if (r && r.ok !== false) {
          data.topMost = !!r.topMost
          renderSettings(el, data, ctx)
        }
      } catch {} finally {
        btn.disabled = false
      }
    }),
  )
  topRow.appendChild(
    chip('收起这个浮窗', false, () => {
      void window.herShell.panel.hide()
    }),
  )
  el.appendChild(topRow)
  kv(el, '怎么拖', '按住标题条拖 —— 浮窗自己走，不动她')
  kv(el, '怎么关', '标题条上的 × 或 Esc，只收浮窗；关掉她时浮窗跟着关')
  note(el, '拖的时候立刻能看到透明度；松手才记进 out\\her-app.ui.json。')

  // ── 主动提醒（DDL 前）──────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '主动提醒（快到 DDL 时）'))
  const rm = data.remind || {}
  const setRemind = async (key, value) => {
    try {
      const r = await window.herShell.act('set-remind', { key, value })
      if (r && r.ok === false) data.lastError = (r && r.error) || '没改成'
      else {
        const nr = (r && r.rules) || {}
        data.remind = { on: nr.on, lead: nr.lead, atDue: nr.atDue, quietInClass: nr.quietInClass, everySec: nr.everySec, speak: nr.speak }
        data.lastError = null
      }
    } catch (err) {
      data.lastError = String((err && err.message) || err)
    }
    renderSettings(el, data, ctx)
  }
  kv(el, '总开关', rm.on ? '开着（到点前会提醒）' : '关着')
  kv(el, '提前多久', rm.lead ? `${rm.lead} 分钟` : '—')
  kv(el, '到点再提醒', rm.atDue ? '会' : '不会')
  kv(el, '上课时', rm.quietInClass ? '不弹（等你下课）' : '照样弹')
  kv(el, '多久查一次', rm.everySec ? `${rm.everySec} 秒` : '—')
  const leadRow = h('div', 'her-slider-row')
  const lead = document.createElement('input')
  lead.type = 'range'
  lead.className = 'her-range'
  lead.min = '10'
  lead.max = '240'
  lead.step = '5'
  lead.value = String(rm.lead || 60)
  const leadLabel = h('span', 'her-slider-val', `提前 ${lead.value} 分钟`)
  lead.addEventListener('input', () => {
    leadLabel.textContent = `提前 ${lead.value} 分钟`
  })
  lead.addEventListener('change', () => void setRemind('remind_lead_minutes', lead.value))
  leadRow.append(lead, leadLabel)
  el.appendChild(leadRow)
  const rmRow = h('div', 'her-chips')
  rmRow.appendChild(
    chip(rm.on ? '提醒：开' : '提醒：关', !!rm.on, () => void setRemind('remind_on', rm.on ? 'off' : 'on'), '总开关'),
    chip(`到点再提醒：${rm.atDue ? '开' : '关'}`, !!rm.atDue, () => void setRemind('remind_at_due', rm.atDue ? 'off' : 'on')),
    chip(`上课不弹：${rm.quietInClass ? '开' : '关'}`, !!rm.quietInClass, () =>
      void setRemind('remind_quiet_in_class', rm.quietInClass ? 'off' : 'on'),
    ),
    chip(`提醒时念出来：${rm.speak ? '开' : '关'}`, !!rm.speak, () => void setRemind('remind_speak', rm.speak ? 'off' : 'on')),
  )
  el.appendChild(rmRow)
  const rmRow2 = h('div', 'her-chips')
  rmRow2.appendChild(
    chip('现在查一遍', false, async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      try {
        const r = await window.herShell.act('remind-now', '')
        btn.textContent = r && r.skipped === 'class' ? '在上课，先不提醒' : r && r.skipped === 'off' ? '提醒是关着的' : `查完了（发出 ${(r && r.fired) || 0} 条）`
      } catch (err) {
        btn.textContent = '没查成：' + ((err && err.message) || err)
      } finally {
        btn.disabled = false
      }
    }),
  )
  rmRow2.appendChild(
    chip(
      '试一下通知',
      false,
      async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        try {
          const r = await window.herShell.act('notify-test', '')
          btn.textContent = r && r.ok ? (r.supported ? '弹了一条，看见没' : '这台机器不支持通知') : '没弹出来'
        } catch (err) {
          btn.textContent = '没弹出来：' + ((err && err.message) || err)
        } finally {
          btn.disabled = false
        }
      },
      '确认系统通知能不能弹（Windows 的专注助手会挡通知）',
    ),
  )
  el.appendChild(rmRow2)
  note(el, `规则写在 \`${String(data.remindFile || '').split(/[\\/]/).slice(-2).join('\\')}\`（一行一条 key = value，改完存盘就生效）。同一条待办的"提前/到点"各只提醒一次。`)

  // ── 每日提醒（2026-10-24 · Tevela D：喝水 / 背单词这种，不是作业）──────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '每日提醒'))
  const dailies = Array.isArray(data.daily) ? data.daily : []
  if (dailies.length === 0) {
    note(el, '还没有每日提醒。下面写一句 + 选个钟点，就是"每天到点她提醒你"（和 DDL 那条是同一根提醒条）。')
  }
  for (const d of dailies) {
    const row = h('div', 'her-kv her-daily-item')
    row.dataset.dailyId = d.id
    row.appendChild(h('span', 'her-kv-k', `${d.time}　${d.title}`))
    row.appendChild(
      h('span', 'her-kv-v', d.days && d.days.length ? '周' + d.days.map((x) => WD_ZH[x - 1]).join('/') : '每天'),
    )
    const acts = h('div', 'her-chips')
    const onOff = h('button', 'her-chip' + (d.enabled ? ' her-chip-on' : ''), d.enabled ? '开' : '关')
    onOff.type = 'button'
    onOff.dataset.dailyToggle = d.id
    onOff.title = d.enabled ? '点一下暂时关掉（不删）' : '点一下打开'
    onOff.addEventListener('click', async (e) => {
      e.stopPropagation()
      onOff.disabled = true
      try {
        const r = await window.herShell.act('daily-set', { id: d.id, patch: { enabled: !d.enabled } })
        if (r && r.ok !== false && ctx && ctx.refresh) ctx.refresh()
      } catch {}
      onOff.disabled = false
    })
    const del = h('button', 'her-notice-x', '×')
    del.type = 'button'
    del.dataset.dailyRemove = d.id
    del.title = '删掉这条每日提醒'
    del.addEventListener('click', async (e) => {
      e.stopPropagation()
      del.disabled = true
      try {
        const r = await window.herShell.act('daily-remove', d.id)
        if (r && r.ok !== false && ctx && ctx.refresh) ctx.refresh()
      } catch {}
      del.disabled = false
    })
    acts.append(onOff, del)
    row.appendChild(acts)
    el.appendChild(row)
  }
  const dAddRow = h('div', 'her-slider-row')
  const dTitle = document.createElement('input')
  dTitle.type = 'text'
  dTitle.className = 'her-input'
  dTitle.id = 'her-daily-title'
  dTitle.placeholder = '提醒什么（例：喝一杯水）'
  const dTime = document.createElement('input')
  dTime.type = 'time'
  dTime.className = 'her-input her-input-time'
  dTime.id = 'her-daily-time'
  dTime.value = '21:00'
  const dAdd = h('button', 'her-chip her-chip-send', '加上')
  dAdd.type = 'button'
  dAdd.id = 'her-daily-add'
  dAdd.title = '每天到这个钟点，她就提醒你一句'
  dAdd.addEventListener('click', async () => {
    const title = String(dTitle.value || '').trim()
    const time = String(dTime.value || '').trim()
    if (!title) {
      dTitle.focus()
      dAdd.textContent = '先写提醒什么'
      return
    }
    dAdd.disabled = true
    dAdd.textContent = '正在存…'
    try {
      const r = await window.herShell.act('daily-add', { title, time, days: [] })
      if (r && r.ok !== false) {
        dTitle.value = ''
        dAdd.textContent = '加上了'
        if (ctx && ctx.refresh) ctx.refresh()
      } else {
        dAdd.textContent = '没加上：' + ((r && r.error) || '')
      }
    } catch (err) {
      dAdd.textContent = '没加上：' + ((err && err.message) || err)
    } finally {
      dAdd.disabled = false
    }
  })
  dAddRow.append(dTitle, dTime, dAdd)
  el.appendChild(dAddRow)
  note(el, `存在 \`${String(data.dailyFile || '').split(/[\\/]/).slice(-2).join('\\')}\`；到点会弹她脚边那条提醒条（「知道了 / 稍后」都在）。上课时按上面那条设置不弹。`)

  // ── 学科学习计划（2026-10-24 · Tevela F）────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '学科学习计划'))
  const plans = Array.isArray(data.plans) ? data.plans : []
  if (plans.length === 0) note(el, '每门课写一句"打算怎么学 + 现在到哪一步"。点下面的「新增一门」开始。')
  for (const p of plans) {
    const row = h('div', 'her-kv her-plan-item')
    row.dataset.planSubject = p.subject
    row.title = '点一下改这门课的打算 / 进度'
    row.appendChild(h('span', 'her-kv-k', `${p.subject} · ${p.progress}%`))
    row.appendChild(h('span', 'her-kv-v', String(p.plan || '（还没写打算）').slice(0, 40)))
    row.addEventListener('click', () => openPlanSheet(p, ctx))
    el.appendChild(row)
  }
  const planRow = h('div', 'her-chips')
  planRow.appendChild(chip('新增一门', false, () => openPlanSheet(null, ctx), '写一门课的打算 + 进度'))
  el.appendChild(planRow)
  note(el, '存进 `_study-core\\学科计划.json`；进度 0~100 是你自己填的，不会自动变。')

  // ── 工具（原来在右键菜单里的，全搬这儿）────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '工具'))
  const toolBox = h('div', 'her-chips')
  const tool = (label, act, arg, hint) => {
    toolBox.appendChild(chip(label, false, () => window.herShell.act(act, arg), hint))
  }
  tool('读一下钉钉', 'run-helper', { script: 'dingtalk-read.ps1', label: '钉钉读屏' }, '截当前钉钉窗口 → 本地 OCR → 进任务/通知')
  tool('备份一次数据', 'run-helper', { script: '备份数据.ps1', args: ['-Backup'], label: '备份数据' }, '和以前右键菜单里的「备份一次数据」同一件事')
  tool('重新加载界面', 'reload-ui', '', '界面卡住的时候用')
  // 归档（批次 2.1，2026-10-24 主人拍板「一周后归档不真删」）
  toolBox.appendChild(
    chip(
      '归档一周前的已完成',
      false,
      async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = '正在看…'
        try {
          const r = await window.herShell.act('archive-now', '')
          if (r && r.ok !== false) {
            btn.textContent = r.archived > 0 ? `挪走了 ${r.archived} 条` : '没有满一周的'
            if (r.archived > 0 && ctx && ctx.refresh) ctx.refresh()
          } else {
            btn.textContent = '没成：' + ((r && r.error) || '')
          }
        } catch (err) {
          btn.textContent = '没成：' + ((err && err.message) || err)
        } finally {
          btn.disabled = false
        }
      },
      '完成满一周的任务挪进 tasks.archive.jsonl（不真删，文件里还在）；动手前会自动备份一次',
    ),
  )
  el.appendChild(toolBox)
  // 2026-10-24 晚（批次 3.5）：备份的"看有哪些"和"白板"入口（原来只能命令行）
  const toolBox2 = h('div', 'her-chips')
  toolBox2.appendChild(
    chip('看有哪些备份', false, () => window.herShell.act('run-helper', { script: '备份数据.ps1', args: ['-List'], label: '看备份' }), '打印备份清单（写进 out\\her-app.log）'),
  )
  toolBox2.appendChild(
    chip('打开白板', false, () => window.herShell.act('run-helper', { script: 'whiteboard.ps1', args: [], label: '白板' }), '她讲题时那张白板（WinForms）'),
  )
  el.appendChild(toolBox2)

  // 从「底栏」搬过来的两个口子（主人 2026-10-25：底栏删掉，但脚本建任务那条路不许断）
  el.appendChild(h('div', 'her-sec-h her-sec-split', '收件箱（以前在底栏那两个按钮）'))
  const noteRow = h('div', 'her-slider-row')
  const noteIn = document.createElement('input')
  noteIn.type = 'text'
  noteIn.className = 'her-input'
  noteIn.id = 'her-note-input2'
  noteIn.placeholder = '记一条（一句话一件事）'
  const noteBtn = chip('记一条', false, async (e) => {
    const btn = e.currentTarget
    const text = String(noteIn.value || '').trim()
    if (!text) {
      noteIn.focus()
      btn.textContent = '先写一句'
      return
    }
    btn.disabled = true
    try {
      const r = await window.herShell.act('note', text)
      btn.textContent = r && r.ok !== false ? '记下了（她下次扫到会处理）' : '没记上：' + ((r && r.error) || '')
      if (r && r.ok !== false) noteIn.value = ''
    } catch (err) {
      btn.textContent = '没记上：' + ((err && err.message) || err)
    } finally {
      btn.disabled = false
    }
  }, '写进 收件箱.txt（跟以前底栏那个「记下」一样）')
  const procBtn = chip('处理收件箱', false, async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = '正在处理…'
    try {
      const r = await window.herShell.act('process')
      const n = Array.isArray(r && r.created) ? r.created.length : 0
      btn.textContent = r && r.ok !== false ? `建了 ${n} 条` : '处理失败：' + ((r && r.error) || '')
      if (r && r.ok !== false && ctx && ctx.refresh) ctx.refresh()
    } catch (err) {
      btn.textContent = '处理失败：' + ((err && err.message) || err)
    } finally {
      btn.disabled = false
    }
  }, '跑 info\\local-process.mjs：把收件箱里认得出的直接建成任务（不花 token）')
  noteRow.append(noteIn, noteBtn, procBtn)
  el.appendChild(noteRow)
  note(el, '以前这两个在浮窗最下面那条；底栏删了，脚本那条「信息太简单就直接建任务、不走 LLM」完全没变。')

  kv(el, '归档账', String(data.archiveFile || 'tasks.archive.jsonl').split(/[\\/]/).slice(-1)[0])
  note(el, '归档 = 从 tasks.json 挪进 tasks.archive.jsonl（整条留档，随时能抄回来）；启动 + 每 6 小时自动扫一次，手动也可以点上面那个按钮。')

  // 她的成长回路（2026-10-24 接上）：经验本 ① 记 → ② 炼。转正仍然只能主人点头。
  el.appendChild(h('div', 'her-sec-h her-sec-split', '她的成长（经验本）'))
  const growRow = h('div', 'her-chips')
  growRow.appendChild(
    chip('把经验炼一遍', false, async (e) => {
      const btn = e.currentTarget
      btn.disabled = true
      btn.textContent = '正在炼…'
      try {
        const r = await window.herShell.act('learn-digest', 'force')
        btn.textContent = r && r.ok ? (r.skipped ? '没变化' : '炼好了（看 经验本-提炼-*.md）') : '没炼成：' + ((r && r.error) || '')
      } catch (err) {
        btn.textContent = '没炼成：' + ((err && err.message) || err)
      } finally {
        btn.disabled = false
      }
    }),
  )
  el.appendChild(growRow)
  kv(el, '怎么长', '她在回答里写一行「经验：…」→ 自动进经验本；经验本一变 → 自动提炼成影子规矩；转正要你点头')
  note(el, '经验本：mystery\\\\DSH\\\\她的经验本.txt（原始流水）→ 提炼：经验本-提炼-<日期>.md → 影子规矩：她的规矩-建议.txt（她会软跟随）')

  // ── 文件 ──────────────────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '文件'))
  const fileBox = h('div', 'her-chips')
  const fileBtn = (label, kind, hint) => {
    fileBox.appendChild(chip(label, false, () => window.herShell.act('open-path', kind), hint))
  }
  fileBtn('她的规矩', 'rules')
  fileBtn('她的人设', 'persona')
  fileBtn('她的记忆', 'memory')
  fileBtn('形象与互动', 'limits')
  fileBtn('今日提醒', 'brief')
  // 主人 2026-10-24：「待办」改叫「任务」——文件名还是 待办总览.txt（程序生成的那份，别改）
  fileBtn('任务总览', 'tasks', '打开 待办总览.txt（文件是老名字，内容就是任务总览）')
  fileBtn('本周安排', 'agenda')
  fileBtn('投放区', 'drop')
  fileBtn('数据目录', 'data')
  // 2026-10-24 晚（批次 3.5 设置页补全）：备份目录 + 经验本
  fileBtn('备份目录', 'backups', '打开 <数据目录>\\_备份（每份备份一个时间戳文件夹）')
  fileBtn('她的经验本', 'learnbook', '她自己在回答里写的「经验：…」都记在这儿')
  el.appendChild(fileBox)
  const miscBox = h('div', 'her-chips')
  miscBox.appendChild(
    chip('打开旧浮窗（过渡期）', false, () => window.herShell.act('open-legacy-float', ''), '原来的 WinForms 浮窗，还没删'),
  )
  miscBox.appendChild(chip('关掉她（浮窗一起关）', false, () => window.herShell.act('quit-her', ''), '退出整个应用'))
  el.appendChild(miscBox)

  // ── 诊断 ──────────────────────────────────────────────────────────────────
  el.appendChild(h('div', 'her-sec-h her-sec-split', '她现在什么样'))
  const view = data.view
  kv(el, '模型视图', view ? `${Math.round(view.w)}×${Math.round(view.h)}` : '（还没量出来）')
  kv(el, '规则文件', data.rulesFound ? '找到了' : '没找到（配色会退回默认）')
  kv(el, '数据目录', data.dataRoot || '—')
  if (data.mock) note(el, '这是假数据（截图 / 自检用）；真数据下改配色会写进规则文件。')
}
