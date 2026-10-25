# =============================================================================
#  pet-window.ps1 —— 「她」的窗口启动器（2026-10-22 晚 · 换成 Electron 透明外壳）
# =============================================================================
#
#  为什么换（主人原话）：「她的单独形象旁边有一大圈黑色的色块；分辨率也很低」
#    → WebView2 是原生子窗口，分层窗口不合成子窗口，页面里背景设成透明也没用，
#      贴到桌面上永远是一块深色方框。要"只看见人、看不见窗"，必须用 Electron
#      （自己的合成器 + 逐像素 alpha）—— 这就是原版桌宠的做法。
#
#  现在这个文件**只做三件事**：
#    ① 找到 Electron（info\pet\shell\node_modules\electron\dist\electron.exe）
#    ② 拉起来，然后**留在这里等它退**（浮窗靠「这个 powershell 进程还在不在」
#       判断桌宠开没开，见 floating-window.ps1 的 Get-PetWindowRunning）
#    ③ 它退了就把 out\ui-state.json 的 petWindow 置 false（下次启动不自动带出来）
#
#  找不到 Electron（或者给了 -NoElectron）→ 自动退回 `pet-window-webview.ps1`
#  （旧的那套：WebView2 + 深色小窗。功能都在，只是不透明。）
#
#  参数：
#    -SelfTest      屏幕外跑一遍自检（壳子那边会截图 + 按 alpha 通道验真透明）
#    -TopMost       一开就置顶
#    -ModelHeight   她多大（像素高）；不给就用上次存的
#    -NoElectron    强制走旧的 WebView2 版
#    -Url           换个地址加载（调试用）
#
#  ⚠️ 本文件必须 UTF-8 带 BOM（PS 5.1 不认无 BOM 的中文）。
# =============================================================================

param(
  [switch]$SelfTest,
  [switch]$TopMost,
  [int]$ModelHeight = 0,
  [switch]$NoElectron,
  [string]$Url = '',
  # 旧版的两个参数（-NoElectron 时才用得上），留着免得外面调用报错
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $ProjectRoot 'out'
$ShellDir = Join-Path $PSScriptRoot 'pet\shell'
$ElectronExe = Join-Path $ShellDir 'node_modules\electron\dist\electron.exe'
$LegacyScript = Join-Path $PSScriptRoot 'pet-window-webview.ps1'
$StateFile = Join-Path $OutDir 'ui-state.json'
$SelfTestLog = Join-Path $OutDir 'pet-shell-selftest.log'

if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

<# 她关了：把「下次自动开」这个记号抹掉（只改 petWindow，别动 showChar / topMost）。 #>
function Set-PetWindowOff {
  if ($SelfTest) { return }
  try {
    if (-not (Test-Path -LiteralPath $StateFile)) { return }
    $st = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $obj = [ordered]@{
      showChar  = $(if ($null -ne $st.showChar) { [bool]$st.showChar } else { $true })
      petWindow = $false
      topMost   = $(if ($null -ne $st.topMost) { [bool]$st.topMost } else { $false })
    }
    [IO.File]::WriteAllText($StateFile, ($obj | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# ── 退回旧版（WebView2）─────────────────────────────────────────────────────
if ($NoElectron -or -not (Test-Path -LiteralPath $ElectronExe)) {
  if (-not (Test-Path -LiteralPath $LegacyScript)) {
    Write-Output ("找不到 Electron（{0}），也没有旧的 pet-window-webview.ps1" -f $ElectronExe)
    exit 4
  }
  $argLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $LegacyScript
  if ($SelfTest) { $argLine += ' -SelfTest' }
  if ($TopMost) { $argLine += ' -TopMost' }
  if (-not [string]::IsNullOrWhiteSpace($Url)) { $argLine += (' -Url "{0}"' -f $Url) }
  if ($Width -gt 0) { $argLine += (' -Width {0}' -f $Width) }
  if ($Height -gt 0) { $argLine += (' -Height {0}' -f $Height) }
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argLine -PassThru -Wait
  exit $p.ExitCode
}

# ── 正常路径：Electron 外壳 ─────────────────────────────────────────────────
#   2026-10-22 晚起，**优先用新应用** `apps\desktop`（我们自己的页面 + 她的渲染层）；
#   它不在（或者只是跟着上游升级时）才退回旧的透明外壳 `info\pet\shell`。
$AppDir = Join-Path $ProjectRoot 'apps\desktop'
$launchDir = $ShellDir
if (Test-Path -LiteralPath (Join-Path $AppDir 'main.mjs')) {
  $launchDir = $AppDir
  # 新应用的日志/自检文件名不同，下面判自检要用它自己的
  $SelfTestLog = Join-Path $OutDir 'her-app-selftest.log'
}
$shellArgs = @(('"{0}"' -f $launchDir))
if ($ModelHeight -gt 0) { $shellArgs += ('--h={0}' -f $ModelHeight) }
if ($TopMost) { $shellArgs += '--topmost=1' }
if ($SelfTest) { $shellArgs += '--selftest'; $shellArgs += '--mock' }
if (-not [string]::IsNullOrWhiteSpace($Url)) { $shellArgs += ('--url={0}' -f $Url) }

if ($SelfTest) { try { Remove-Item -LiteralPath $SelfTestLog -Force -ErrorAction SilentlyContinue } catch { } }

try {
  $proc = Start-Process -FilePath $ElectronExe -ArgumentList $shellArgs -PassThru -WindowStyle Hidden
} catch {
  Write-Output ('Electron 起不来：' + $_.Exception.Message)
  exit 5
}

# 留在这里等它：浮窗用「这个进程在不在」判断桌宠开没开
#   ⚠️ 别用 $proc.WaitForExit()（不带超时那个）：Start-Process 起的 GUI 进程
#   在 Electron 这种「有子进程、句柄被继承」的情况下会**永远等不到**，自检就卡死。
#   改成 HasExited 轮询。踩过：2026-10-22，自检日志都写完了，启动器还在那儿杵着。
while ($true) {
  try { if ($proc.HasExited) { break } } catch { break }
  Start-Sleep -Milliseconds 400
}
$code = 0
try { $code = [int]$proc.ExitCode } catch { }

if ($SelfTest) {
  $ok = $false
  try {
    if (Test-Path -LiteralPath $SelfTestLog) {
      $tail = Get-Content -LiteralPath $SelfTestLog -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -Last 1
      Write-Output ([string]$tail)
      if ([string]$tail -match '失败 0 项') { $ok = $true }
    } else {
      Write-Output '自检日志没出来（out\pet-shell-selftest.log）'
    }
  } catch { }
  if ($ok) { exit 0 } else { exit 1 }
}

Set-PetWindowOff
exit $code
