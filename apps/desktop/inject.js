// apps/desktop/inject.js —— 加载完注入到页面里的那一小段（2026-10-23 改：两个窗口都注入）
//
// 三件事，跟旧壳一样：
//   ① 拖动：按在「不是控件」的地方拖 → 主进程移**发消息的这个窗口**（浮窗靠原生 app-region 拖，走不到这）
//   ② 命中：鼠标在不在她身上 → 主进程开关"点击穿透"（只对形象窗有意义）
//   ③ 右键：没被页面处理就交给主进程弹原生菜单
//
// 2026-10-23 补的那一刀（主人：「还是会出现有时无法选中的情况（必须得点击任务栏里面的图标才能再点到）」）：
//   光等页面自己收到 pointermove 不可靠 —— 窗口不是前台、刚 show 出来、鼠标停在原地没动的时候，
//   转发过来的鼠标事件可能压根不到，于是命中一直停在"穿过去"，看着就是**永远点不到她**。
//   所以主进程每 150ms 拿光标位置来问一句（her:probe），我们在这边算同一个判定再回报。
//   两条路，坏一条还有另一条。
(function () {
  if (window.__herShellHook) return
  window.__herShellHook = true
  var api = window.herShell || {}
  var ROOT_ID = 'dsh-live2d-pet'
  /** 浮窗那个窗口：不是"点穿"的场景，也不需要自己拖窗口（标题条是原生拖动区） */
  var IS_PANEL = api.mode === 'panel' || /(\?|&)panel=1/.test(location.search)

  function isUi(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var cls = (n.className && String(n.className)) || ''
      if (/(btn|button|menu|bubble|pane|panel|input|link|toggle|tab|chip|mail|report|hud|dock|her-)/i.test(cls)) return true
      var role = n.getAttribute && n.getAttribute('role')
      if (role === 'button' || role === 'menuitem') return true
    }
    return false
  }

  /** 鼠标现在是不是"落在她身上" */
  function isOverHer(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      if (el && el !== document.body && el !== document.documentElement) return true
    } catch (e) {}
    try {
      var root = document.getElementById(ROOT_ID)
      if (root && root.classList.contains('dshp-hidden')) return false
      if (window.DSHPet && typeof window.DSHPet.hitTest === 'function') {
        // ⚠️ 2026-10-22 深夜（主人反馈「她经常忽然点不动」）：
        //   原来的判定是**逐像素**问她身上的不透明像素，可她的轮廓里本来就有洞
        //   （头发缝、桌沿和身体之间的空隙、举起来的道具周围）—— 点在洞上就"穿"过去了，
        //   感觉就是"她对我没反应"。现在按 **±PAD 像素的邻域**取一次（等价于把掩码胖一圈），
        //   只要附近有她就算点到了她。
        var PAD = 9
        var offs = [
          [0, 0],
          [-PAD, 0],
          [PAD, 0],
          [0, -PAD],
          [0, PAD],
          [-6, -6],
          [6, -6],
          [-6, 6],
          [6, 6],
          [0, -PAD * 2],
          [-PAD, -6],
          [PAD, -6],
          [-PAD, 6],
          [PAD, 6],
        ]
        for (var i = 0; i < offs.length; i++) {
          if (window.DSHPet.hitTest(x + offs[i][0], y + offs[i][1])) return true
        }
        return false
      }
    } catch (e) {}
    return false
  }

  // ① 拖动（浮窗不掺和：它的标题条用 CSS app-region 原生拖）
  var drag = null
  if (!IS_PANEL) {
    window.addEventListener(
      'pointerdown',
      function (e) {
        if (e.button !== 0 || e.pointerType === 'touch') return
        if (isUi(e.target)) return
        drag = { x: e.screenX, y: e.screenY }
        if (api.dragStart)
          try {
            api.dragStart()
          } catch (err) {}
      },
      true,
    )
    window.addEventListener(
      'pointermove',
      function (e) {
        if (!drag) return
        var dx = e.screenX - drag.x
        var dy = e.screenY - drag.y
        if (dx === 0 && dy === 0) return
        drag.x = e.screenX
        drag.y = e.screenY
        if (api.drag)
          try {
            api.drag(dx, dy)
          } catch (err) {}
      },
      true,
    )
    var endDrag = function () {
      drag = null
    }
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', endDrag, true)
    window.addEventListener('blur', endDrag, true)
  }

  // ② 命中 → 点击穿透（形象窗才有）
  var lastHit = null
  function reportHit(hit) {
    if (hit === lastHit) return
    lastHit = hit
    if (api.hit)
      try {
        api.hit(hit)
      } catch (e) {}
  }
  if (!IS_PANEL) {
    window.addEventListener(
      'pointermove',
      function (e) {
        window.__herLastX = e.clientX
        window.__herLastY = e.clientY
        reportHit(isOverHer(e.clientX, e.clientY))
      },
      true,
    )
    // 按下去那一刻也重算一次：鼠标"停着没动"但还是想点她的情况
    window.addEventListener(
      'pointerdown',
      function (e) {
        window.__herLastX = e.clientX
        window.__herLastY = e.clientY
        reportHit(isOverHer(e.clientX, e.clientY))
      },
      true,
    )
    // 主进程那边也会来问（它拿 screen.getCursorScreenPoint 算，不依赖鼠标事件到不到）
    try {
      if (api.onProbe) {
        api.onProbe(function (pt) {
          if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return
          window.__herLastX = pt.x
          window.__herLastY = pt.y
          reportHit(isOverHer(pt.x, pt.y))
        })
      }
    } catch (e) {}
  }

  // ③ 右键 → 主进程菜单（"主要界面"的选择栏就在这个菜单里）
  //
  // ⚠️ 2026-10-24（主人：「右键形象也能打开和选择栏；现在只有右键任务栏的图标才有用」）：
  //   真因不是菜单坏了，是 **pet.js 自己在 document 上挂了 contextmenu（capture）**：
  //   点到她身上就 `preventDefault() + stopPropagation()`，去开它那个"余额/本轮消耗"的 HUD
  //   （我们早把 .dshp-hud 藏在 CSS 里了，所以人看到的是"右键什么都没发生"）。
  //   我们这条挂在 window 上、capture 阶段本来就比 document 先跑，但以前会等一拍再看
  //   `defaultPrevented` —— 那一拍里 pet.js 已经把它标掉了，于是被自己跳过。
  //   → 现在**不看 defaultPrevented**，直接报给主进程弹菜单。
  //   唯一例外：输入框（浮窗里的"记一条"、对话输入框）要留着系统的复制/粘贴菜单。
  window.addEventListener(
    'contextmenu',
    function (e) {
      var t = e.target
      var onInput = !!(t && t.closest && t.closest('input, textarea, [contenteditable]'))
      setTimeout(function () {
        if (onInput) return
        if (api.menu)
          try {
            api.menu()
          } catch (err) {}
      }, 0)
    },
    true,
  )
})()
