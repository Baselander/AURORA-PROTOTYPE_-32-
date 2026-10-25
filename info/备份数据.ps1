# =============================================================================
#  备份数据.ps1 —— 把她「会写的东西」整体备份一份（2026-10-20，主人问"信息会不会丢"）
#
#  为什么要有它：主人最担心的一件事是「我写进去的信息，会不会因为她在开发中而丢」。
#  数据其实全在 G10 里（代码在 DSH-PROJECT 里，两边不重叠），但"知道"不等于"安心" ——
#  所以给一个一句话就能用的备份/查看工具，任何动手之前先打一份。
#
#  ── 用法 ─────────────────────────────────────────────────────────────────────
#    powershell -File info\备份数据.ps1                 # = -Backup（打完打印清单）
#    ... 备份数据.ps1 -Backup                          # 同上
#    ... 备份数据.ps1 -List                            # 看有哪些备份（不写任何东西）
#    ... 备份数据.ps1 -Verify <名字或前缀>              # 校验某份备份的文件与清单是否对得上
#    ... 备份数据.ps1 -Restore <名字或前缀>             # **只打印恢复方案**，不动文件（默认 dry-run）
#    ... 备份数据.ps1 -Restore <名字或前缀> -Apply      # 真恢复（会先把当前状态再备份一次）
#
#  ── 备份什么（全是她会写/主人会写的东西）─────────────────────────────────────
#    _study-core\           *.json / *.txt / *.md（tasks、收件箱、对话、三份报告、钉钉台账…）
#    新建\                  错题本.docx、REMINDER.docx、_AURORA工作区\错题本生成器\{entries,reminder}.json
#    mystery\DSH\           *.txt + 她的记忆.md（规矩/限制/人格）
#    mystery\NORM.txt
#
#  ── 保留几份 ─────────────────────────────────────────────────────────────────
#    默认保留最近 10 份，更早的只在 -List 里提示，**不自动删**（删东西这种手最好不要有）。
#
#  副作用：-Backup 往 <数据目录>\_备份\<时间戳>\ 写文件；-Restore -Apply 会覆盖数据（先自动再备份）。
#  ⚠️ 本文件必须 UTF-8 带 BOM。
# =============================================================================

param(
  [switch]$Backup,
  [switch]$List,
  [string]$Verify = '',
  [string]$Restore = '',
  [switch]$Apply
)

. (Join-Path $PSScriptRoot 'paths.ps1')   # 2026-10-20：数据目录的唯一真相（见 info\paths.ps1）

$ErrorActionPreference = 'Stop'

$script:DataRoot = ("$script:DSH_DATA")
$script:BackupRoot = Join-Path $script:DataRoot '_备份'
$script:Keep = 10

# 要备份的东西：源目录（相对 DataRoot）+ 通配 + 说明。**只列具体文件/后缀，不整目录拷**。
$script:Sources = @(
  @{ Dir = '_study-core'; Filter = '*.json';  What = '待办/台账' },
  @{ Dir = '_study-core'; Filter = '*.txt';   What = '收件箱/对话/钉钉原文' },
  @{ Dir = '_study-core'; Filter = '*.md';    What = '三份日报' },
  @{ Dir = '新建';        Filter = '*.docx';  What = '错题本 / REMINDER' },
  @{ Dir = '新建\_AURORA工作区\错题本生成器'; Filter = 'entries.json';   What = '错题本数据（真相源）' },
  @{ Dir = '新建\_AURORA工作区\错题本生成器'; Filter = 'reminder.json';  What = '长期方案' },
  @{ Dir = 'mystery\DSH'; Filter = '*.txt';   What = '规矩/四份限制/人格' },
  @{ Dir = 'mystery\DSH'; Filter = '*.md';    What = '她的记忆' },
  @{ Dir = 'mystery';     Filter = 'NORM.txt'; What = '协作规矩' }
)

<# 一份备份的名字（字典序 = 时间序）。 #>
function New-BackupName {
  return (Get-Date -Format 'yyyyMMdd-HHmmss')
}

<# 列出备份目录（新的在前）。 #>
function Get-Backups {
  if (-not (Test-Path -LiteralPath $script:BackupRoot)) { return @() }
  return @(Get-ChildItem -LiteralPath $script:BackupRoot -Directory | Sort-Object Name -Descending)
}

<# 按名字/前缀找一份备份。 #>
function Resolve-Backup {
  param([string]$Key)
  $all = Get-Backups
  if ($all.Count -eq 0) { return $null }
  if ([string]::IsNullOrWhiteSpace($Key)) { return $all[0] }
  $hits = @($all | Where-Object { $_.Name -eq $Key -or $_.Name.StartsWith($Key) })
  if ($hits.Count -eq 0) { return $null }
  return $hits[0]
}

<#
  打一份备份。
  返回 @{ Ok; Name; Path; Count; Bytes; Missed[] }
#>
function New-DataBackup {
  param([string]$Reason = '')

  if (-not (Test-Path -LiteralPath $script:DataRoot)) {
    return @{ Ok = $false; Name = ''; Path = ''; Count = 0; Bytes = 0; Missed = @("数据目录不在：$script:DataRoot") }
  }
  $name = New-BackupName
  $dest = Join-Path $script:BackupRoot $name
  New-Item -ItemType Directory -Force -Path $dest | Out-Null

  $manifest = New-Object System.Collections.Generic.List[object]
  $missed = New-Object System.Collections.Generic.List[string]
  $bytes = 0
  $count = 0

  foreach ($src in $script:Sources) {
    $dir = Join-Path $script:DataRoot $src.Dir
    if (-not (Test-Path -LiteralPath $dir)) { $missed.Add("目录不在：$($src.Dir)"); continue }
    $files = @(Get-ChildItem -LiteralPath $dir -Filter $src.Filter -File -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -First 200 | Sort-Object Name)
    foreach ($f in $files) {
      $rel = Join-Path $src.Dir $f.Name
      $target = Join-Path $dest $rel
      $targetDir = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }
      try {
        Copy-Item -LiteralPath $f.FullName -Destination $target -Force
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        $bytes += $f.Length
        $count++
        $manifest.Add([ordered]@{
            相对路径 = ($rel -replace '\\', '/')
            字节 = [int64]$f.Length
            sha256 = $hash
            说明 = $src.What
            源修改时间 = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
          })
      } catch {
        $missed.Add("复制失败：$rel（$($_.Exception.Message)）")
      }
    }
  }

  $meta = [ordered]@{
    备份名 = $name
    时间 = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    数据目录 = $script:DataRoot
    文件数 = $count
    总字节 = [int64]$bytes
    原因 = $Reason
    机器 = $env:COMPUTERNAME
    清单 = $manifest
  }
  $json = $meta | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $dest '备份清单.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

  return @{ Ok = $true; Name = $name; Path = $dest; Count = $count; Bytes = $bytes; Missed = $missed.ToArray() }
}

# ── 主流程 ────────────────────────────────────────────────────────────────────

if ($Verify.Length -gt 0) {
  $b = Resolve-Backup -Key $Verify
  if ($null -eq $b) { Write-Output "找不到备份：$Verify（用 -List 看有哪些）"; exit 1 }
  $manifestPath = Join-Path $b.FullName '备份清单.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Output "这份备份没有清单文件：$($b.Name)"; exit 1 }
  $meta = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  $bad = 0
  foreach ($item in $meta.清单) {
    $rel = ([string]$item.相对路径) -replace '/', '\'
    $full = Join-Path $b.FullName $rel
    if (-not (Test-Path -LiteralPath $full)) { $bad++; Write-Output ("  ✗ 缺文件：$rel"); continue }
    $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    if ($hash -ne [string]$item.sha256) { $bad++; Write-Output ("  ✗ 内容对不上：$rel") }
  }
  Write-Output ("备份 {0}：{1} 个文件，坏 {2} 个 —— {3}" -f $meta.备份名, @($meta.清单).Count, $bad, $(if ($bad -eq 0) { '完整 ✔' } else { '有损坏 ✘' }))
  if ($bad -gt 0) { exit 1 }
  exit 0
}

if ($Restore.Length -gt 0) {
  $b = Resolve-Backup -Key $Restore
  if ($null -eq $b) { Write-Output "找不到备份：$Restore（用 -List 看有哪些）"; exit 1 }
  $manifestPath = Join-Path $b.FullName '备份清单.json'
  $meta = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
  Write-Output ("恢复方案：把 {0}（{1} 个文件）写回数据目录" -f $meta.备份名, @($meta.清单).Count)
  Write-Output "  数据目录：$script:DataRoot"
  foreach ($item in $meta.清单) {
    $rel = ([string]$item.相对路径) -replace '/', '\'
    $live = Join-Path $script:DataRoot $rel
    $state = if (Test-Path -LiteralPath $live) { '会覆盖现文件' } else { '现在没有，会新建' }
    Write-Output ("  {0,-46} {1}" -f $rel, $state)
  }
  if (-not $Apply) {
    Write-Output ''
    Write-Output '这是**只打印**（dry-run）。确认要恢复，再加 -Apply；我会先把当前状态再备份一份。'
    exit 0
  }
  $snap = New-DataBackup -Reason '恢复前先备份当前状态'
  if (-not $snap.Ok) { Write-Output "恢复前备份失败：$($snap.Missed -join '；') → 中止，什么都没动"; exit 1 }
  Write-Output ("已先备份当前状态：{0}" -f $snap.Name)
  $restored = 0
  foreach ($item in $meta.清单) {
    $rel = ([string]$item.相对路径) -replace '/', '\'
    $srcFile = Join-Path $b.FullName $rel
    $dstFile = Join-Path $script:DataRoot $rel
    $dstDir = Split-Path -Parent $dstFile
    if (-not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    try { Copy-Item -LiteralPath $srcFile -Destination $dstFile -Force; $restored++ }
    catch { Write-Output ("  ✗ 恢复失败：$rel（$($_.Exception.Message)）") }
  }
  Write-Output ("恢复完成：{0} 个文件" -f $restored)
  exit 0
}

if ($List) {
  $all = Get-Backups
  if ($all.Count -eq 0) { Write-Output "还没有备份。打一份：备份数据.ps1 -Backup"; exit 0 }
  Write-Output ''
  Write-Output ('  {0,-18} {1,-8} {2}' -f '备份名', '文件数', '大小')
  Write-Output ('  ' + ('-' * 50))
  foreach ($b in $all) {
    $m = Join-Path $b.FullName '备份清单.json'
    $n = '?'; $size = '?'
    try {
      $meta = Get-Content -LiteralPath $m -Raw -Encoding utf8 | ConvertFrom-Json
      $n = @($meta.清单).Count
      $size = ('{0:N0} KB' -f ([double]$meta.总字节 / 1KB))
    } catch { }
    Write-Output ('  {0,-18} {1,-8} {2}' -f $b.Name, $n, $size)
  }
  Write-Output ''
  if ($all.Count -gt $script:Keep) {
    Write-Output ("  ⚠ 已经 {0} 份了（本来打算留 {1} 份）。**我不会自动删** —— 你自己看看要不要清。" -f $all.Count, $script:Keep)
  }
  Write-Output "  校验：备份数据.ps1 -Verify <名字>    恢复方案：-Restore <名字>（只打印）"
  exit 0
}

# 默认 = 打一份备份
$result = New-DataBackup -Reason '手动备份'
if (-not $result.Ok) {
  Write-Output ("备份失败：{0}" -f ($result.Missed -join '；'))
  exit 1
}
Write-Output ("✔ 备份好了：{0}" -f $result.Name)
Write-Output ("   位置：{0}" -f $result.Path)
Write-Output ("   内容：{0} 个文件，{1:N0} KB" -f $result.Count, ($result.Bytes / 1KB))
if (@($result.Missed).Count -gt 0) {
  Write-Output '   注意（这些没备份到）：'
  foreach ($m in $result.Missed) { Write-Output ("     - {0}" -f $m) }
}
Write-Output ''
Write-Output '   看有哪些备份：-List　校验：-Verify <名字>　恢复（只打印）：-Restore <名字>'
