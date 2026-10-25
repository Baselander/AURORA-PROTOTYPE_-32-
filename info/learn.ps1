# =============================================================================
#  learn.ps1 —— 「她的经验本」记账口（2026-10-22）P0.5 的第一步：**只记，不生效**
# =============================================================================
#
#  为什么要它（主人 2026-10-21 定的）：
#    保守模式要「演进」——早期保守（拿不准就问），靠积累经验越来越贴合，后期不用问。
#    所以先有一条**只追加的流水**：她哪次判错、主人怎么纠正的。
#
#  三件套里的第 ① 件（记）：
#    ① 记（本脚本，纯追加，不花 token、不改任何规矩）
#    ② 炼（每晚上一次）：把重复出现的模式提炼成 ①规矩条目 ②规则参数 ③代码规则+测试
#    ③ 试（影子模式）：新规则先"只提示不执行"，连续 N 天没冲突才转正
#
#  用法：
#    powershell -NoProfile -File info\learn.ps1 -Scene 待办 -Did "把「econ 好难」当作业" -Should "那只是聊天，不建" -Lesson "只有科目不算作业"
#    powershell -NoProfile -File info\learn.ps1 -List            # 看最近 20 条
#    powershell -NoProfile -File info\learn.ps1 -Scene 测试 -File out\_learn-test.txt   # 写别处（测试用）
#
#  ⚠️ 规矩：**别抄主人聊天原文**。这里记的是"规则性结论"，不是对话存档。
#  ⚠️ 本文件必须 UTF-8 带 BOM。
# =============================================================================

param(
  # 在什么场景发生（待办 / 日历 / 错题 / 钉钉 / 对话…）
  [string]$Scene = '其它',
  # 她当时做了什么（错了什么）
  [string]$Did = '',
  # 主人纠正成什么 / 本应该怎样
  [string]$Should = '',
  # 结论（一句话，给"提炼"那一步用的种子）
  [string]$Lesson = '',
  # 看最近几条
  [switch]$List,
  # 本子放哪；留空 = <数据根>\mystery\DSH\她的经验本.txt
  [string]$File = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'paths.ps1')

if ([string]::IsNullOrWhiteSpace($File)) {
  $File = (Join-Path $script:DSH_DATA 'mystery\DSH\她的经验本.txt')
}

$HEADER = @'
# 她的经验本 —— 「她做错了什么 / 主人怎么纠正的」原始流水（2026-10-22 起）
#
# 一行一条：时间 | 场景 | 她做了什么 | 主人纠正成什么 | 结论
# ⚠️ 这是**原始流水**，不直接生效。提炼那一步才把它变成：
#   ① 她的规矩.txt 的提议（要主人点头）② study-rules.txt 参数 ③ 代码规则 + 测试
# ⚠️ 别抄主人聊天原文；只记"规则性结论"。
#
# 例子：
# 2026-10-22 07:40 | 待办 | 把「econ 好难」当作业要建 | 那只是聊天，不建 | 只有科目不算作业，要有 WS/作业/日期之一
'@

function Ensure-LearnFile {
  param([string]$Path)
  if (Test-Path -LiteralPath $Path) { return }
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [IO.File]::WriteAllText($Path, ($HEADER + "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
}

function Read-LearnLines {
  param([string]$Path, [int]$Take = 20)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $lines = Get-Content -LiteralPath $Path -Encoding UTF8 | Where-Object { $_.Trim().Length -gt 0 -and -not $_.Trim().StartsWith('#') }
  return @($lines | Select-Object -Last $Take)
}

if ($List) {
  $recent = Read-LearnLines -Path $File -Take 20
  if ($recent.Count -eq 0) {
    Write-Output "经验本还是空的：$File"
    exit 0
  }
  Write-Output ("经验本（最近 {0} 条）：{1}" -f $recent.Count, $File)
  foreach ($line in $recent) { Write-Output ("  " + $line) }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Did) -and [string]::IsNullOrWhiteSpace($Should)) {
  Write-Output '至少要给 -Did（她做了什么）或 -Should（应该怎样）。'
  exit 2
}

Ensure-LearnFile -Path $File
$clean = { param($s) (([string]$s) -replace '\r?\n', ' ').Trim() }
$lineText = ('{0} | {1} | {2} | {3} | {4}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), (& $clean $Scene), (& $clean $Did), (& $clean $Should), (& $clean $Lesson))
Add-Content -LiteralPath $File -Value $lineText -Encoding utf8
Write-Output ('已记进经验本：' + $lineText)
Write-Output ('文件：' + $File)
