# =============================================================================
#  launch.ps1 —— 把「她」叫出来（快捷键 / 桌面图标点一下都走这里）
# =============================================================================
#
#  行为（这才是"叫出来"该有的样子）：
#    · 她**没在跑** → 启动浮窗
#    · 她**在跑**（比如被别的窗口挡了、或者最小化了）→ **顶到最前面**，不另开一个
#
#  为什么要这样：Windows 快捷方式的热键只能"启动程序"，直接指到浮窗脚本的话，
#  按两次就会开出两个窗口。所以中间加这一层。
#
#  副作用：可能启动浮窗进程；不改任何文件。
#  ⚠️ 本文件必须 UTF-8 **带 BOM**。
# =============================================================================

$ErrorActionPreference = 'Stop'

$FloatingScript = Join-Path $PSScriptRoot 'floating-window.ps1'
$PowerShellExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if ([string]::IsNullOrWhiteSpace($PSScriptRoot) -or -not (Test-Path -LiteralPath $FloatingScript)) {
  # 从快捷方式调用时 $PSScriptRoot 一般是对的；万一不对就用绝对路径兜底
  $FloatingScript = Join-Path $PSScriptRoot 'floating-window.ps1'   # 2026-10-20：不再写死项目路径
}

if (-not ('DshFront' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DshFront {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static IntPtr MainWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      uint o; GetWindowThreadProcessId(h, out o);
      if (o == pid) { RECT r; GetWindowRect(h, out r); if (r.Right - r.Left > 200) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@ -Language CSharp
}

$existing = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*-File*floating-window.ps1*' -and $_.ProcessId -ne $PID })

if ($existing.Count -gt 0) {
  $hwnd = [DshFront]::MainWindow([uint32]$existing[0].ProcessId)
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][DshFront]::ShowWindow($hwnd, 9)   # SW_RESTORE：从最小化恢复
    [void][DshFront]::SetForegroundWindow($hwnd)
  }
  Write-Output '她已经在跑了 —— 已经把你叫到前面。'
  exit 0
}

# ⚠️ 2026-10-18 晚加 `-WindowStyle Hidden`（两处都要）：
#    以前起浮窗时那个 powershell 的**黑控制台窗口是看得见的**，主人点了快捷方式会先看到
#    一个黑窗口（而且关掉它时里面的报错才闪一下）。浮窗本来就不需要控制台：
#    它的错误都写 `out\live2d-window.log`。
Start-Process -FilePath $PowerShellExe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$FloatingScript`"") -WindowStyle Hidden
Write-Output '她起来了。'
exit 0
