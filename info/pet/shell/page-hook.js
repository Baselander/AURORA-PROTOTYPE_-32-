// info/pet/shell/page-hook.js —— 塞进桌宠页面的那一小段（2026-10-22 晚）
//
// 为什么不改 pet.js 本体：那是别人的页面（MIT，但改了就跟着上游对不上）。
// 所以壳子在 did-finish-load 之后把这段执行一次，只加"监听"，不改页面自己的逻辑。
//
// 它干三件事：
//   ① 拖动 —— 按在「不是控件」的地方拖，窗口跟着走（按控件不放，免得点按钮变成拖窗）
//   ② 命中 —— 用 pet.js 自己的像素掩码（DSHPet.hitTest）判断鼠标是不是在她身上；
//      再加上 elementFromPoint 判断是不是在面板/气泡上。壳子据此开关点击穿透。
//   ③ 右键 —— 交给壳子弹原生菜单（页面自己处理了就让它处理，看 defaultPrevented）。
(function () {
  if (window.__herShellHook) return
  window.__herShellHook = true
  var api = window.herShell || {}
  var ROOT_ID = 'dsh-live2d-pet'

  function isUi(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var cls = (n.className && String(n.className)) || ''
      if (/(btn|button|menu|bubble|pane|panel|input|link|toggle|tab|chip|mail|report|hud|dock)/i.test(cls)) return true
      var role = n.getAttribute && n.getAttribute('role')
      if (role === 'button' || role === 'menuitem') return true
    }
    return false
  }

  /** 鼠标现在是不是"落在她身上（或她自己的面板上）" */
  function isOverHer(x, y) {
    try {
      var el = document.elementFromPoint(x, y)
      if (el && el !== document.body && el !== document.documentElement) return true
    } catch (e) {}
    try {
      var root = document.getElementById(ROOT_ID)
      if (root && root.classList.contains('dshp-hidden')) return false
      if (window.DSHPet && typeof window.DSHPet.hitTest === 'function') {
        return !!window.DSHPet.hitTest(x, y)
      }
    } catch (e) {}
    return false
  }

  // ── ① 拖动 ────────────────────────────────────────────────────────────────
  var drag = null
  window.addEventListener(
    'pointerdown',
    function (e) {
      if (e.button !== 0 || e.pointerType === 'touch') return
      if (isUi(e.target)) return
      drag = { x: e.screenX, y: e.screenY }
      if (api.dragStart) try { api.dragStart() } catch (err) {}
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
      if (api.drag) try { api.drag(dx, dy) } catch (err) {}
    },
    true,
  )
  var endDrag = function () { drag = null }
  window.addEventListener('pointerup', endDrag, true)
  window.addEventListener('pointercancel', endDrag, true)
  window.addEventListener('blur', endDrag, true)

  // ── ② 命中 → 点击穿透 ────────────────────────────────────────────────────
  var lastHit = null
  function reportHit(hit) {
    if (hit === lastHit) return
    lastHit = hit
    if (api.hit) try { api.hit(hit) } catch (e) {}
  }
  window.addEventListener(
    'pointermove',
    function (e) {
      reportHit(isOverHer(e.clientX, e.clientY))
    },
    true,
  )
  // 控件出现/消失（面板弹出）后，鼠标不动也应该更新一次
  setInterval(function () {
    try {
      var el = document.elementFromPoint(window.__herLastX || -1, window.__herLastY || -1)
      if (el) reportHit(isOverHer(window.__herLastX, window.__herLastY))
    } catch (e) {}
  }, 1200)
  window.addEventListener(
    'pointermove',
    function (e) {
      window.__herLastX = e.clientX
      window.__herLastY = e.clientY
    },
    true,
  )

  // ── ③ 右键 → 壳子菜单 ────────────────────────────────────────────────────
  window.addEventListener(
    'contextmenu',
    function (e) {
      // 等这一轮事件派发完再看：页面自己要弹菜单的话会 preventDefault
      setTimeout(function () {
        if (e.defaultPrevented) return
        if (api.menu) try { api.menu() } catch (err) {}
      }, 0)
    },
    true,
  )

  // 页面里的"大小"滑块改过之后，通知壳子跟着改窗口（不然她会伸到窗外）
  var lastH = 0
  setInterval(function () {
    try {
      var v = window.DSHPet && window.DSHPet.state && window.DSHPet.state.view
      var h = v && v.h
      if (!h) return
      if (lastH && Math.abs(h - lastH) > 12 && api.modelHeight) api.modelHeight(h)
      lastH = h
    } catch (e) {}
  }, 1500)
})()
