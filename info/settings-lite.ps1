# =============================================================================
#  settings-lite.ps1 —— 限制文件的「读 / 改」小库（给权限中心用）
#
#  为什么不用 study_config（TS 插件那个）：它每次要起一个 dsh 进程，一次 10 秒以上 ——
#  在界面上"点一下开关"等 10 秒是不能接受的。所以这里做一个 PS 侧的最小实现，
#  但**语义和它对齐**：先存快照（同一个 `配置快照` 目录）、只改那一行、原子写回（tmp + rename）。
#  这样界面上点的每一个开关，都能用 study_config action=rollback 回滚。
#
#  ── 用法 ─────────────────────────────────────────────────────────────────────
#    settings-lite.ps1 -ShowAll                     # 所有限制文件的键和值（只读）
#    settings-lite.ps1 -Json                        # 同上，JSON（给浮窗用）
#    settings-lite.ps1 -Toggle "她的限制-说话.txt|allow_speak"
#    settings-lite.ps1 -Set   "她的限制-看一眼.txt|look_at" "ocr"
#    settings-lite.ps1 -Snapshots                   # 看看有哪些快照
#
#  规矩：
#    · 只认白名单里的文件（下面 $script:Files），不许乱写别人
#    · 只改**文件里已经有的那一行**；文件里没有这个键 → 明确报错，不追加
#      （追加会造出"看着改了其实没人读"的键 —— 项目里反复强调过这个坑）
#    · 值只在 on/off 之间切时用 -Toggle；其它用 -Set
#  副作用：-Toggle / -Set 会写限制文件（先存快照）。
#  ⚠️ 本文件必须 UTF-8 带 BOM。
# =============================================================================

param(
  [switch]$ShowAll,
  [switch]$Json,
  [string]$Toggle = '',
  [string]$Set = '',
  [string]$Value = '',
  [switch]$Snapshots
)

. (Join-Path $PSScriptRoot 'paths.ps1')   # 2026-10-20：数据目录的唯一真相（见 info\paths.ps1）

$ErrorActionPreference = 'Stop'

$script:Dir = ("$script:DSH_DATA\mystery\DSH")
$script:SnapshotDir = ("$script:DSH_DATA\_study-core\配置快照")

# 白名单：权限中心能碰的文件（顺序 = 界面上显示的顺序）
$script:Files = @(
  @{ Name = '她的限制-说话.txt';        Label = '她说话（音色/语速/安静时段）' },
  @{ Name = '她的限制-形象与互动.txt';  Label = '形象与互动（点她一下会怎样）' },
  @{ Name = '她的限制-看一眼.txt';      Label = '看一眼（能不能看你在干什么）' },
  @{ Name = '她的限制-闲聊.txt';        Label = '闲聊主动性（她会不会自己找你说话）' },
  @{ Name = '她的限制-文件整理.txt';    Label = '文件整理（G10 里能动多少）' },
  @{ Name = '她的限制-操作电脑.txt';    Label = '操作电脑（媒体/浏览）' },
  @{ Name = '钉钉未读-限制.txt';        Label = '钉钉未读信号' },
  @{ Name = '她的规矩.txt';             Label = '她的规矩（名字/称呼/语气）' },
  @{ Name = 'study-rules.txt';          Label = '学业规则（DDL/文件夹/携带物）' }
)

<# 读一份限制文件：返回 @{ Name; Label; Path; Entries=@(@{Key;Value;OnOff;Line;Comment}) } #>
function Read-LimitFile {
  param($Spec)
  $path = Join-Path $script:Dir $Spec.Name
  $out = @{ Name = $Spec.Name; Label = $Spec.Label; Path = $path; Exists = (Test-Path -LiteralPath $path); Entries = @() }
  if (-not $out.Exists) { return $out }
  $entries = @()
  $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $raw = [string]$lines[$i]
    $line = $raw.Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    $isOnOff = ($v -match '^(on|off)$')
    $entries += [pscustomobject]@{
      Key    = $k
      Value  = $v
      OnOff  = $isOnOff
      Line   = ($i + 1)
      File   = $Spec.Name
      Label  = $Spec.Label
      Text   = (@($raw -split '\s*=\s*', 2) | Select-Object -Last 1)   # 原值（给界面显示）
    }
  }
  $out.Entries = $entries
  return $out
}

<# 所有文件 → 结构化清单。 #>
function Get-AllSettings {
  $all = @()
  foreach ($spec in $script:Files) { $all += (Read-LimitFile -Spec $spec) }
  return $all
}

<# 存快照（和 study_config 同一个目录，文件名带时间戳）。 #>
function Save-Snapshot {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $script:SnapshotDir)) { New-Item -ItemType Directory -Force -Path $script:SnapshotDir | Out-Null }
  $name = ('{0}-{1}.bak' -f [System.IO.Path]::GetFileNameWithoutExtension($Path), (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  $dest = Join-Path $script:SnapshotDir $name
  Copy-Item -LiteralPath $Path -Destination $dest -Force
  return $name
}

<#
  改一行。返回 @{ Ok; File; Key; Before; After; Snapshot; Message }
  只会替换**第一处**匹配的键；同一个键写了多行的会把后面的注释掉（和 study_config 一样的处理）。
#>
function Set-LimitValue {
  param([string]$FileKey, [string]$NewValue)

  $parts = $FileKey -split '\|', 2
  if ($parts.Count -ne 2) { return @{ Ok = $false; Message = '写法要像 "文件名.txt|键名"' } }
  $fileName = $parts[0].Trim()
  $key = $parts[1].Trim()
  if (-not ($script:Files | Where-Object { $_.Name -eq $fileName })) {
    return @{ Ok = $false; Message = "「$fileName」不在白名单里，不碰" }
  }
  $path = Join-Path $script:Dir $fileName
  if (-not (Test-Path -LiteralPath $path)) { return @{ Ok = $false; Message = "文件不在：$path" } }

  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $rows = $text -split "`r?`n"
  $hit = -1
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $line = ([string]$rows[$i]).Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    if ($line.Substring(0, $eq).Trim() -ne $key) { continue }
    $hit = $i
    break
  }
  if ($hit -lt 0) {
    return @{ Ok = $false; Message = "「$fileName」里没有 `"$key`" 这个键 —— 不追加（追加会造出没人读的假开关）" }
  }

  $oldLine = ([string]$rows[$hit]).Trim()
  $before = ($oldLine.Substring($oldLine.IndexOf('=') + 1)).Trim()
  $snapshot = Save-Snapshot -Path $path

  $rows[$hit] = ('{0} = {1}' -f $key, $NewValue)
  # 同一个键还有第二处 → 注释掉（避免两行打架）
  for ($j = $hit + 1; $j -lt $rows.Count; $j++) {
    $line = ([string]$rows[$j]).Trim()
    if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { continue }
    if ($line.Substring(0, $eq).Trim() -ne $key) { continue }
    $rows[$j] = ('# {0}   ← 权限中心合并到上一行（{1}）' -f $line, (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  }

  # 原子写：先写 tmp 再改名（别写坏 —— 2026-10-20 吃过这个亏）
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, ($rows -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  Move-Item -LiteralPath $tmp -Destination $path -Force

  return @{ Ok = $true; File = $fileName; Key = $key; Before = $before; After = $NewValue; Snapshot = $snapshot; Message = ('{0} 的 {1}：{2} → {3}' -f $fileName, $key, $before, $NewValue) }
}

# ── 主流程 ────────────────────────────────────────────────────────────────────

if ($Toggle.Length -gt 0) {
  $parts = $Toggle -split '\|', 2
  if ($parts.Count -ne 2) { Write-Output '写法要像 -Toggle "她的限制-说话.txt|allow_speak"'; exit 1 }
  $path = Join-Path $script:Dir $parts[0].Trim()
  if (-not (Test-Path -LiteralPath $path)) { Write-Output "文件不在：$path"; exit 1 }
  $res = Read-LimitFile -Spec @{ Name = $parts[0].Trim(); Label = '' }
  $entry = @($res.Entries | Where-Object { $_.Key -eq $parts[1].Trim() }) | Select-Object -First 1
  if ($null -eq $entry) { Write-Output "没这个键：$($parts[1])"; exit 1 }
  if (-not $entry.OnOff) {
    Write-Output ("「{0}」现在的值是「{1}」，不是 on/off —— 用 -Set 改，别用 -Toggle" -f $entry.Key, $entry.Value)
    exit 1
  }
  $newValue = if ($entry.Value -eq 'on') { 'off' } else { 'on' }
  $r = Set-LimitValue -FileKey $Toggle -NewValue $newValue
  Write-Output $r.Message
  if ($r.Ok) { Write-Output ("  （快照：{0}）" -f $r.Snapshot) }
  if (-not $r.Ok) { exit 1 }
  exit 0
}

if ($Set.Length -gt 0) {
  if ($Value.Length -eq 0) { Write-Output '用法：-Set "文件|键" "新值"'; exit 1 }
  $r = Set-LimitValue -FileKey $Set -NewValue $Value
  Write-Output $r.Message
  if ($r.Ok) { Write-Output ("  （快照：{0}）" -f $r.Snapshot) }
  if (-not $r.Ok) { exit 1 }
  exit 0
}

if ($Snapshots) {
  if (-not (Test-Path -LiteralPath $script:SnapshotDir)) { Write-Output "还没有快照（目录：$script:SnapshotDir）"; exit 0 }
  $items = @(Get-ChildItem -LiteralPath $script:SnapshotDir -Filter '*.bak' | Sort-Object Name -Descending)
  Write-Output ("共 {0} 份快照（新→旧）" -f $items.Count)
  $items | Select-Object -First 20 | ForEach-Object { Write-Output ("  {0}" -f $_.Name) }
  exit 0
}

$all = Get-AllSettings

if ($Json) {
  $payload = [ordered]@{ generated = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'); files = @() }
  foreach ($f in $all) {
    $payload.files += [ordered]@{
      name  = $f.Name
      label = $f.Label
      exists = $f.Exists
      entries = @($f.Entries | ForEach-Object { [ordered]@{ key = $_.Key; value = $_.Value; onoff = $_.OnOff } })
    }
  }
  $payload | ConvertTo-Json -Depth 6
  exit 0
}

Write-Output '==== 权限中心 · 现在的设置 ===='
foreach ($f in $all) {
  $mark = if ($f.Exists) { '' } else { '（文件不在）' }
  Write-Output ''
  Write-Output ("── {0}  {1}" -f $f.Name, $(if ($f.Exists) { $mark } else { '（文件不在）' }))
  foreach ($e in @($f.Entries)) {
    $flag = if ($e.OnOff) { if ($e.Value -eq 'on') { '[开]' } else { '[关]' } } else { '    ' }
    Write-Output ("   {0} {1,-28} = {2}" -f $flag, $e.Key, $e.Value)
  }
}
Write-Output ''
Write-Output '改： settings-lite.ps1 -Toggle "文件|键"    或  -Set "文件|键" "值"'
Write-Output '看： -Snapshots（快照都在 _study-core\配置快照，能和 study_config rollback 共用）'
