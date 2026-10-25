// info/pet/drag.js —— 给桌宠页注入的「拖动窗口」脚本（2026-10-22）
//
// 为什么在页面里做：宿主在 WebView2 的 MouseDown 上直接拖会**抢走页面里的点击**
// （表情菜单、道具按钮一点就变成拖窗口）。所以反过来：页面判断"按在的是不是 UI"，
// 不是 UI（比如按在她身上/画布上）就 postMessage 让宿主移窗口。
(function () {
  if (window.__petDragInstalled) return
  window.__petDragInstalled = true
  var drag = null
  function isUi(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var cls = (n.className && String(n.className)) || ''
      if (/(btn|button|menu|bubble|pane|panel|input|link|toggle|tab)/i.test(cls)) return true
      var role = n.getAttribute && n.getAttribute('role')
      if (role === 'button' || role === 'menuitem') return true
    }
    return false
  }
  window.addEventListener(
    'pointerdown',
    function (e) {
      if (e.button !== 0 || e.pointerType === 'touch') return
      if (isUi(e.target)) return
      drag = { x: e.screenX, y: e.screenY }
      try {
        window.chrome.webview.postMessage({ type: 'drag-start' })
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
      try {
        window.chrome.webview.postMessage({ type: 'drag', dx: dx, dy: dy })
      } catch (err) {}
    },
    true,
  )
  window.addEventListener('pointerup', function () { drag = null }, true)
  window.addEventListener('pointercancel', function () { drag = null }, true)
})()
