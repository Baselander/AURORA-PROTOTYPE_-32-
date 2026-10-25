/**
 * apps\desktop\renderer\cards\index.js —— **卡片注册表**（2026-10-24 晚，批次 3.3 插件化）
 *
 * 以前：`TABS` / `PAGES` / `LOADERS` 三张表写死在 `app.js` 里，加一页要改三处 + 记得同步页签文案。
 * 现在：**一张卡 = 一个对象**（id / 文案 / 取数据 / 画）。`app.js` 只从这里读。
 *   → 想加一页：在这个数组里加一条（+ 在 apps\desktop\renderer\pages\ 放它的 render 函数），
 *     **别的地方一个字都不用动**。
 *
 * 字段：
 *   id      页签 id（也是 `herShell.data()` / `openTab()` 用的名字）
 *   label   页签上那两个字
 *   sub     鼠标悬停的说明
 *   load    () => Promise<任意>   取数据（**页面自己不许碰文件**，全走主进程）
 *   render  (el, data, ctx) => void   画出来；ctx 里有 onToggle/onCheck/refresh/mock
 *   order   排序（不写就按数组顺序）
 */

import { renderToday } from '../pages/today.js'
import { renderTasks } from '../pages/tasks.js'
import { renderCalendar } from '../pages/calendar.js'
import { renderChat } from '../pages/chat.js'
import { renderMistakes } from '../pages/mistakes.js'
import { renderSummary } from '../pages/summary.js'
import { renderSettings } from '../pages/settings.js'

export const CARDS = [
  {
    id: 'today',
    label: '今日',
    sub: '今天要带什么、上什么、要交什么',
    // 今日页顺带把任务取回来 —— 「今天做完了 N 条」要现算（2026-10-24）
    // ⚠️ 字段叫 taskList 不能叫 tasks：fill() 会把 `data.tasks.ok === false` 当成"整页拿不到数据"
    load: async () => {
      const [todayData, taskData, agendaData] = await Promise.all([
        window.herShell.data('today'),
        window.herShell.data('tasks'),
        // 通知（2026-10-25 主人：把「通知」也搬到今日页）
        window.herShell.data('agenda'),
      ])
      return Object.assign({}, todayData || {}, {
        taskList: taskData && Array.isArray(taskData.tasks) ? taskData.tasks : [],
        tasksOk: !!(taskData && taskData.ok !== false),
        notices: agendaData && Array.isArray(agendaData.noticeList) ? agendaData.noticeList : [],
      })
    },
    render: renderToday,
  },
  {
    id: 'tasks',
    label: '任务',
    sub: '还没做完的（点一下勾掉；可以按科目看；＋新增直接加一条）',
    load: () => window.herShell.data('tasks'),
    render: renderTasks,
  },
  {
    id: 'calendar',
    label: '日历',
    sub: '本周安排 + 本周计划 + 通知',
    load: async () => ({
      agenda: await window.herShell.data('agenda'),
      tasks: await window.herShell.data('tasks'),
      weekly: await window.herShell.data('weekly'),
    }),
    render: renderCalendar,
  },
  {
    id: 'chat',
    label: '对话',
    sub: '跟她说话（可以按主题分上下文）',
    load: async () => ({
      ok: true,
      history: await window.herShell.chat.history(),
      meta: await window.herShell.data('chat-meta'),
    }),
    render: renderChat,
  },
  {
    id: 'mistakes',
    label: '错题',
    sub: '错题趋势 + 错题本（点进去看四轮；可以记新的）',
    // 错题页顺带把"投放区"的文件一起取回来（主人丢进去的错题照片/材料）
    load: async () => {
      const [mk, drop] = await Promise.all([window.herShell.data('mistakes'), window.herShell.data('dropbox')])
      return Object.assign({}, mk || {}, { dropbox: drop })
    },
    render: renderMistakes,
  },
  {
    id: 'summary',
    label: '总结',
    sub: '每天的总结：她先写，你要改就点开改',
    load: () => window.herShell.data('summary'),
    render: renderSummary,
  },
  {
    id: 'settings',
    label: '设置',
    sub: '窗口 / 配色 / 打扮 / 嗓子 / 提醒 / 计划 / 工具',
    load: () => window.herShell.data('settings'),
    render: renderSettings,
  },
]

/** 页签表（app.js 的 TABS：只留 id/label/sub） */
export const TABS = CARDS.map(({ id, label, sub }) => ({ id, label, sub }))

/** id → 取数据（app.js 的 LOADERS） */
export const LOADERS = Object.fromEntries(CARDS.map((c) => [c.id, c.load]))

/** id → 画（app.js 的 PAGES） */
export const PAGES = Object.fromEntries(CARDS.map((c) => [c.id, c.render]))

/** 自检用：注册表本身有没有毛病（缺字段 / id 重复） */
export function registryProblems() {
  const problems = []
  const seen = new Set()
  for (const c of CARDS) {
    if (!c || !c.id) problems.push('有一张卡没有 id')
    else if (seen.has(c.id)) problems.push(`id 重复：${c.id}`)
    else seen.add(c.id)
    if (c && (!c.label || typeof c.render !== 'function' || typeof c.load !== 'function')) {
      problems.push(`卡 ${c.id} 缺 label/render/load`)
    }
  }
  return problems
}
