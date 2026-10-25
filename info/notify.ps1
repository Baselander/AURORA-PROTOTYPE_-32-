# =============================================================================
#  notify.ps1 —— 给主人弹一条 Windows 通知（我自己在跑完长任务后调用）
# =============================================================================
#
#  用法：
#    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<本文件>" -Title "标题" -Body "内容"
#
#  为什么单独写一个：主人写作业时不会盯着屏幕，长任务跑完要主动叫他一下。
#  注意「专注助手 / 勿扰模式」开着时通知不会弹——所以调用方还会把内容写进日志。
#
#  本机环境：只有 Windows PowerShell 5.1（没装 PS7）。WinRT 通知在 5.1 上可用。
#  本文件是 UTF-8 带 BOM 保存的，去掉 BOM 会让中文变乱码。
# =============================================================================

param(
  [string]$Title = 'DSH',
  [string]$Body = '任务完成'
)

$ErrorActionPreference = 'Stop'

$safeTitle = $Title.Replace("'", "''")
$safeBody = $Body.Replace("'", "''")

$script = @"
`$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
`$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
`$nodes = `$template.GetElementsByTagName('text')
`$nodes.Item(0).AppendChild(`$template.CreateTextNode('$safeTitle')) | Out-Null
`$nodes.Item(1).AppendChild(`$template.CreateTextNode('$safeBody')) | Out-Null
`$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(`$appId).Show([Windows.UI.Notifications.ToastNotification]::new(`$template))
"@

$encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($script))
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -EncodedCommand $encoded | Out-Null

Write-Output "NOTIFIED: $Title | $Body"
