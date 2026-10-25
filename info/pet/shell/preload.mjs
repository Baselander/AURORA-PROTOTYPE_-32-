/**
 * info/pet/shell/preload.mjs —— 页面 ↔ 壳子的小桥（2026-10-22 晚）
 *
 * 只做三件事，别的什么都不给（页面是本地页，但也别开大权限）：
 *   ① 拖动：页面判断"按在的不是按钮"，就把鼠标位移报给壳子，壳子移窗口
 *   ② 命中：页面用她自己的像素掩码判断"鼠标是不是在她身上/面板上"，
 *      壳子据此开/关 `setIgnoreMouseEvents` —— 这就是**点了空气会穿到桌面**的那个效果
 *   ③ 右键菜单：页面把右键交给壳子，壳子弹原生菜单
 *
 * 另外：启动时把「她多大」写进页面的 localStorage（pet.js 的存档口径），
 * 必须在页面脚本跑起来**之前**写，所以放在 preload 里。
 */

import { contextBridge, ipcRenderer } from 'electron'

const LAYOUT_KEY = 'dsh-live2d-pet:layout'

/** 从命令行取 --her-layout={"height":380} ；取不到就算了。 */
function readLayoutPatch() {
  try {
    for (const a of process.argv) {
      if (!a.startsWith('--her-layout=')) continue
      const obj = JSON.parse(a.slice('--her-layout='.length))
      return obj && typeof obj === 'object' ? obj : null
    }
  } catch {}
  return null
}

/**
 * 把补丁并进她的存档（保留主人自己调过的东西：主题、道具、位置…）。
 * 只动三个键：height（模型多高）、cfg.maxWidthRatio（别被窄窗口卡小）。
 */
function seedLayout() {
  const patch = readLayoutPatch()
  if (!patch) return
  try {
    let cur = {}
    try {
      cur = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') || {}
    } catch {}
    const next = { ...cur }
    if (Number.isFinite(patch.height)) next.height = Math.round(patch.height)
    // 窗口是按模型尺寸开的，再让 pet.js 自己按 50% 窗宽压一遍就白缩了
    const cfg = typeof cur.cfg === 'object' && cur.cfg ? { ...cur.cfg } : {}
    cfg.maxWidthRatio = Number.isFinite(patch.maxWidthRatio) ? patch.maxWidthRatio : 0.98
    next.cfg = cfg
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
  } catch {}
}

try {
  seedLayout()
} catch {}

contextBridge.exposeInMainWorld('herShell', {
  version: 1,
  /** 一次拖动位移（屏幕像素） */
  drag: (dx, dy) => ipcRenderer.send('her:drag', Number(dx) || 0, Number(dy) || 0),
  dragStart: () => ipcRenderer.send('her:drag-start'),
  /** 鼠标现在是不是"在她/面板上"（false = 该让点击穿过去） */
  hit: (on) => ipcRenderer.send('her:hit', !!on),
  /** 右键：壳子弹菜单 */
  menu: () => ipcRenderer.send('her:menu'),
  /** 页面里的"大小"滑块拖完了：把新高度记下来，壳子跟着改窗口大小 */
  modelHeight: (h) => ipcRenderer.send('her:model-height', Number(h) || 0),
})
