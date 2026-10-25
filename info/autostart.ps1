# =============================================================================
#  enable-autostart.ps1 / disable-autostart.ps1
#  —— 让浮窗开机自启（**当前没有启用**，等你说要）
# =============================================================================
#
#  做法：在「启动」文件夹里放一个指向 floating-window.cmd 的快捷方式。
#    · 不用管理员
#    · 不动注册表
#    · 删掉快捷方式就恢复（所以 disable 就是删那一个文件）
#
#  怎么用（想让浮窗开机自启时）：
#    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本文件路径>"
#
#  不想了：
#    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<同目录\disable-autostart.ps1>"
#
#  本文件是 UTF-8 带 BOM 保存的（5.1 认 BOM）。
# =============================================================================

param(
  [switch]$Disable
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $RepoRoot 'info\floating-window.cmd'
$StartupDir = [Environment]::GetFolderPath('Startup')
$LinkPath = Join-Path $StartupDir 'DSH 浮窗.lnk'

if ($Disable) {
  if (Test-Path -LiteralPath $LinkPath) {
    Remove-Item -LiteralPath $LinkPath -Force
    Write-Output "已取消开机自启（删掉了 $LinkPath）"
  } else {
    Write-Output "本来就没启用（找不到 $LinkPath）"
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $Target)) {
  throw "找不到浮窗启动器：$Target"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($LinkPath)
$shortcut.TargetPath = $Target
$shortcut.WorkingDirectory = Split-Path -Parent $Target
$shortcut.Description = 'DSH 学业助手桌面浮窗'
$shortcut.Save()

Write-Output "已启用开机自启：$LinkPath"
Write-Output "（取消：同一个脚本加 -Disable，或者直接删掉那个 .lnk）"
