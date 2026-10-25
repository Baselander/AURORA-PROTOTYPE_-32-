/**
 * apps\desktop\preload.mjs —— 窗口页 ↔ 主进程的小桥（2026-10-23 改：两个窗口共用一份）
 *
 * 原则：**只开用得着的口子**。页面是本地页，但也别给 node。
 *   · 拖动 / 命中 / 右键菜单 —— 跟旧的透明外壳同一套口径（见 inject.js）
 *   · data(kind)     取数据（今日 / 待办 …）—— 主进程去跑我们现有的 CLI，页面只管画
 *   · act(name, arg) 做动作（勾掉待办、刷新、改打扮 …）—— 同样是主进程代劳
 *   · theme()        我们那套配色名（来自 她的限制-形象与互动.txt）
 *   · panel.{open,hide} / onShow —— 浮窗自己开合（它是一个独立窗口，2026-10-23）
 *   · onProbe        —— 主进程拿光标位置来问"这一下算点在她身上吗"（修"有时点不到"）
 */

import { contextBridge, ipcRenderer } from 'electron'

/** 命令行里取 --her-theme=电光蓝 */
function readArg(name) {
  try {
    for (const a of process.argv) {
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
    }
  } catch {}
  return ''
}

contextBridge.exposeInMainWorld('herShell', {
  version: 2,
  /** 这个窗口是谁：'her'（她）| 'panel'（浮窗） */
  mode: readArg('her-mode') || 'her',
  /** 一次拖动位移（屏幕像素）—— 移的是**发消息的这个窗口**（主进程按 sender 找窗口） */
  drag: (dx, dy) => ipcRenderer.send('her:drag', Number(dx) || 0, Number(dy) || 0),
  dragStart: () => ipcRenderer.send('her:drag-start'),
  /** 鼠标现在是不是"在她身上"（false = 该让点击穿过去）。只对形象窗有意义 */
  hit: (on) => ipcRenderer.send('her:hit', !!on),
  /** 主进程问"这一点（窗口内坐标）算点在她身上吗" → 页面算完用 hit() 回话 */
  onProbe: (cb) => {
    const fn = (_e, pt) => {
      try {
        cb(pt || {})
      } catch {}
    }
    ipcRenderer.on('her:probe', fn)
    return () => ipcRenderer.removeListener('her:probe', fn)
  },
  /** 右键她 → 主进程说"弹选项条"（原生菜单在这个透明窗口上弹不出来，见 renderer\app.js 的说明） */
  onPick: (cb) => {
    const fn = (_e, payload) => {
      try {
        cb(payload || {})
      } catch {}
    }
    ipcRenderer.on('her:pick', fn)
    return () => ipcRenderer.removeListener('her:pick', fn)
  },
  /** 右键：主进程弹原生菜单（浮窗那一边还在用；形象窗改用 onPick 那条 DOM 选项条） */
  menu: () => ipcRenderer.send('her:menu'),
  /** 取数据：'today' | 'tasks' | … */
  data: (kind) => ipcRenderer.invoke('her:data', String(kind || '')),
  /** 做动作：'toggle'（勾掉/撤销一条待办）| 'refresh' | 'open-file' | … */
  act: (name, arg) => ipcRenderer.invoke('her:act', String(name || ''), arg),
  /** 卡片背景的不透明度（0.55~1.00，主进程从 out\her-app.ui.json 读） */
  cardAlpha: Number(readArg('her-card-alpha')) || 0.97,
  /** 她头顶留了多少空间（px，主进程按气泡高度算的） */
  headroom: Number(readArg('her-headroom')) || 260,
  /** 我们这套配色的名字（电光蓝 / 暗紫 / 青绿 / 少女粉） */
  theme: readArg('her-theme') || '电光蓝',
  /** 浮窗（独立窗口）：自己开、自己关、自己换页 */
  panel: {
    open: (page) => ipcRenderer.invoke('her:panel-open', String(page || '')),
    hide: () => ipcRenderer.invoke('her:panel-hide', ''),
    isOpen: () => ipcRenderer.invoke('her:panel-state', ''),
    /** 主进程说"把浮窗拿来、显示这一页" */
    onShow: (cb) => {
      const fn = (_e, payload) => {
        try {
          cb(payload || {})
        } catch {}
      }
      ipcRenderer.on('her:panel-show', fn)
      return () => ipcRenderer.removeListener('her:panel-show', fn)
    },
  },
  /** 对话：历史 + 发一句（流式结果走 her:chat 事件） */
  chat: {
    history: () => ipcRenderer.invoke('her:chat-history'),
    send: (text) => ipcRenderer.invoke('her:chat-send', String(text || '')),
    on: (cb) => {
      const fn = (_e, payload) => {
        try {
          cb(payload)
        } catch {}
      }
      ipcRenderer.on('her:chat', fn)
      return () => ipcRenderer.removeListener('her:chat', fn)
    },
  },
  /** 语音：一句合成好了（{url} 由宿主的 /tts/ 提供）——**只有形象窗放声音**（浮窗关着也要能出声） */
  onTts: (cb) => {
    const fn = (_e, payload) => {
      try {
        cb(payload)
      } catch {}
    }
    ipcRenderer.on('her:tts', fn)
    return () => ipcRenderer.removeListener('her:tts', fn)
  },
})
