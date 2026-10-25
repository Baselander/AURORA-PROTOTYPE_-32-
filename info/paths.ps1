# =============================================================================
#  paths.ps1 —— **数据目录的唯一真相**（2026-10-20 晚）
#
#  为什么要有它：项目里原来约 44 处写死了开发机的私人路径
#  （`AURORA_DATA`）。
#  那样发布版装到**别人的机器**上必然跑不起来 —— 而这正是"可推广版"的第一道坎。
#
#  ── 解析优先级（改了这里就等于改了全局）──────────────────────────────────────
#    ① `$env:DSH_DATA`  —— 最高优先级。发布版/安装包用它指向用户自己的数据目录。
#    ② 开发机旧路径      —— **存在就用**。所以开发机上行为**零变化**（这条很重要：
#                          我不能因为"要支持发布"就把主人现在能用的东西改出问题）。
#    ③ `<项目根>\端口样例` —— 发布版的样例数据（`安装\示例数据.ps1` 生成的那套假数据）。
#
#  ── 怎么用 ───────────────────────────────────────────────────────────────────
#    `. (Join-Path $PSScriptRoot 'paths.ps1')`   # 点号加载（只定义函数 + 设变量，不 exit）
#    然后：
#      $script:DSH_DATA                       # 数据根目录（字符串，直接拼进双引号里也行）
#      Resolve-DshPath 'mystery\DSH\她的规矩.txt'
#      Get-DshPaths                           # 一次拿全（见下）
#
#  ⚠️ 直接跑（不带点号）会**打印当前解析结果**然后 exit 0 —— 用来排查"她读的到底是哪个目录"。
#  ⚠️ 本文件必须 UTF-8 带 BOM。
# =============================================================================

$script:DshLegacyDataRoot = 'AURORA_DATA'

<#
  数据根目录（三个优先级，见文件头）。**不会返回不存在路径**：
  三个候选都不存在时，返回 `<项目根>\端口样例`（哪怕它也不存在 —— 调用方自己判）。
#>
function Get-DshDataRoot {
  param([string]$ProjectRoot = '')

  if ($env:DSH_DATA -and $env:DSH_DATA.Trim().Length -gt 0) {
    return $env:DSH_DATA.Trim().TrimEnd('\')
  }
  if (Test-Path -LiteralPath $script:DshLegacyDataRoot) {
    return $script:DshLegacyDataRoot
  }
  if (-not $ProjectRoot) {
    if ($PSScriptRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
    else { $ProjectRoot = (Get-Location).Path }
  }
  return (Join-Path $ProjectRoot '端口样例')
}

<#
  把"数据目录里的相对路径"变成绝对路径。例：Resolve-DshPath 'mystery\DSH\她的规矩.txt'
  ⚠️ 只拼路径，不判断存在（调用方本来就常常要处理"文件不存在"）。
#>
function Resolve-DshPath {
  param([Parameter(Mandatory = $true)][string]$Relative)
  $root = Get-DshDataRoot
  return (Join-Path $root $Relative)
}

<#
  课表目录（z-info）。⚠️ 它**不在**数据根下面：
    G10\z-info\            ← 课表在这
    G10\AURORA_DATA\   ← 数据在这
  所以顺序：数据根\z-info → 数据根的父目录\z-info → 数据根（兜底，调用方自己判存在）。
#>
function Get-DshZinfoDir {
  param([string]$DataRoot = '')
  if (-not $DataRoot) { $DataRoot = Get-DshDataRoot }
  $a = Join-Path $DataRoot 'z-info'
  if (Test-Path -LiteralPath $a) { return $a }
  $parent = Split-Path -Parent $DataRoot
  if ($parent) {
    $b = Join-Path $parent 'z-info'
    if (Test-Path -LiteralPath $b) { return $b }
  }
  return $a
}

<#
  一次拿全（给需要一堆路径的脚本用）。字段名就是用途，不用猜。
#>
function Get-DshPaths {
  param([string]$ProjectRoot = '')
  if (-not $ProjectRoot) {
    if ($PSScriptRoot) { $ProjectRoot = Split-Path -Parent $PSScriptRoot }
    else { $ProjectRoot = (Get-Location).Path }
  }
  $data = Get-DshDataRoot -ProjectRoot $ProjectRoot
  return [pscustomobject]@{
    ProjectRoot   = $ProjectRoot
    DataRoot      = $data
    Source        = $(if ($env:DSH_DATA) { 'env:DSH_DATA' }
      elseif (Test-Path -LiteralPath $script:DshLegacyDataRoot) { '开发机旧路径' }
      else { '端口样例（发布版样例数据）' })
    StudyCoreDir  = Join-Path $data '_study-core'
    PersonaDir    = Join-Path $data 'mystery\DSH'
    NormFile      = Join-Path $data 'mystery\NORM.txt'
    RuleFile      = Join-Path $data 'mystery\DSH\她的规矩.txt'
    MemoryFile    = Join-Path $data 'mystery\DSH\她的记忆.md'
    PersonaFile   = Join-Path $data 'mystery\DSH\性格.txt'
    RulesFile     = Join-Path $data 'mystery\DSH\study-rules.txt'
    TasksFile     = Join-Path $data '_study-core\tasks.json'
    InboxFile     = Join-Path $data '_study-core\收件箱.txt'
    ChatFile      = Join-Path $data '_study-core\对话.md'
    ZinfoDir      = Get-DshZinfoDir -DataRoot $data
    MistakeGenDir = Join-Path $data '新建\_AURORA工作区\错题本生成器'
    MistakeDocx   = Join-Path $data '新建\错题本.docx'
    ReminderDocx  = Join-Path $data '新建\REMINDER.docx'
  }
}

# 点号加载时**只**定义函数 + 设一个方便的变量，不打印、不 exit（exit 会把浮窗进程关掉）
$script:DSH_DATA = Get-DshDataRoot
$script:DSH_ZINFO = Get-DshZinfoDir -DataRoot $script:DSH_DATA

if ($MyInvocation.InvocationName -ne '.') {
  $p = Get-DshPaths
  Write-Output '==== 数据路径解析（paths.ps1）===='
  Write-Output ("  来源      ：{0}" -f $p.Source)
  Write-Output ("  项目根    ：{0}（{1}）" -f $p.ProjectRoot, $(if (Test-Path -LiteralPath $p.ProjectRoot) { '在' } else { '❌ 不在' }))
  Write-Output ("  数据根    ：{0}（{1}）" -f $p.DataRoot, $(if (Test-Path -LiteralPath $p.DataRoot) { '在' } else { '❌ 不在' }))
  Write-Output ''
  Write-Output '  用它拼出来的常用路径：'
  foreach ($k in @('StudyCoreDir', 'PersonaDir', 'RuleFile', 'MemoryFile', 'PersonaFile', 'RulesFile',
      'TasksFile', 'InboxFile', 'ChatFile', 'ZinfoDir', 'MistakeGenDir', 'MistakeDocx', 'ReminderDocx')) {
    $v = $p.$k
    Write-Output ("    {0,-14} {1,-4} {2}" -f $k, $(if (Test-Path -LiteralPath $v) { '✔' } else { '·' }), $v)
  }
  Write-Output ''
  Write-Output '  要换数据目录：设环境变量 DSH_DATA 再启动她（或在 她的规矩.txt 那边以后加个键）'
  exit 0
}
