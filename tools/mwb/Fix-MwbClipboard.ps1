<#
.SYNOPSIS
    Safely enable Mouse Without Borders clipboard sharing (ShareClipboard = true).

.DESCRIPTION
    Why this script exists:
    MWB's CheckClipboardEx() returns false immediately when ShareClipboard is false,
    so a machine with the switch off can still RECEIVE clipboard but never SEND it.
    That looks like "copy on PC0 does not reach PC1, but the reverse works".
    See local-pc SKILL.md section 2.12.

    Why it is written this way:
    A previous attempt rewrote the whole settings.json (ConvertFrom-Json ->
    ConvertTo-Json, or Set-Content -Encoding UTF8). That blanked MachinePool /
    Name2IP / SecurityKey and instantly broke mouse sharing across screens.
    Those fields do NOT self-heal. So this script:
      1. backs up settings.json first
      2. stops PowerToys (otherwise its in-memory copy overwrites the file)
      3. replaces exactly the 5 characters false -> true, byte for byte
      4. hard-validates JSON parse + pairing fields before anything starts
      5. restarts PowerToys through the Highest-integrity scheduled task
      6. restores the backup automatically if validation fails

.PARAMETER TaskName
    Scheduled task that launches PowerToys at Highest integrity.
    Default: "Autorun for $env:USERNAME". See SKILL.md section 2.7.

.PARAMETER DryRun
    Report what would change without writing anything.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File Fix-MwbClipboard.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File Fix-MwbClipboard.ps1 -DryRun
#>
[CmdletBinding()]
param(
    [string]$TaskName = "Autorun for $env:USERNAME",
    [string]$TaskPath = '\PowerToys\',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Say([string]$m) { Write-Output $m }

# MWB settings belong to the INTERACTIVE user, which may differ from the account
# this script runs as (an SSH session as 'share' is a common case). Search every
# profile and take the most recently written settings.json.
$hits = Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    Join-Path $_.FullName 'AppData\Local\Microsoft\PowerToys\MouseWithoutBorders\settings.json'
} | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ } | Sort-Object LastWriteTime -Descending
if (-not $hits) { throw 'No MouseWithoutBorders settings.json found under C:\Users' }
$cfg = $hits[0].FullName
$dir = Split-Path $cfg
Say ('settings: ' + $cfg)

# ---- read current value without touching the file ----
$text  = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($cfg))
$idx   = $text.IndexOf('"ShareClipboard"')
if ($idx -lt 0) { throw 'ShareClipboard key not found in settings.json' }
$rel   = $text.Substring($idx, 90).IndexOf('false')
$relT  = $text.Substring($idx, 90).IndexOf('true')
if ($relT -ge 0 -and ($rel -lt 0 -or $relT -lt $rel)) {
    Say 'ShareClipboard is already true. Nothing to do.'
    exit 0
}
if ($rel -lt 0) { throw 'Could not locate the false token after ShareClipboard' }
$abs = $idx + $rel
Say "ShareClipboard = false at offset $abs"

if ($DryRun) {
    Say 'DryRun: would stop PowerToys, flip false -> true, validate, restart.'
    exit 0
}

# ---- 1. backup ----
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bak   = Join-Path $dir "settings.json.bak-clipfix-$stamp"
Copy-Item $cfg $bak -Force
Say "backup -> $bak"

# ---- 2. stop PowerToys ----
Get-Process PowerToys* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5
Say 'PowerToys stopped'

# ---- 3. byte-level replacement ----
$new = $text.Remove($abs, 5).Insert($abs, 'true')
[System.IO.File]::WriteAllBytes($cfg, [System.Text.Encoding]::ASCII.GetBytes($new))
Say 'settings.json patched (5 characters only)'

# ---- 4. hard validation, restore on failure ----
$ok = $true
try {
    $j = ([System.IO.File]::ReadAllText($cfg)) | ConvertFrom-Json
} catch {
    Say ('JSON parse FAILED: ' + $_.Exception.Message)
    $ok = $false
}
if ($ok) {
    if ([string]::IsNullOrWhiteSpace($j.properties.MachinePool.value)) { Say 'MachinePool EMPTY'; $ok = $false }
    if ([string]::IsNullOrWhiteSpace($j.properties.Name2IP.value))    { Say 'Name2IP EMPTY';    $ok = $false }
    if ([string]::IsNullOrWhiteSpace($j.properties.SecurityKey.value)){ Say 'SecurityKey EMPTY'; $ok = $false }
    if ($j.properties.ShareClipboard.value -ne $true)                 { Say 'ShareClipboard not true'; $ok = $false }
}

if (-not $ok) {
    Copy-Item $bak $cfg -Force
    Say 'VALIDATION FAILED - settings.json restored from backup. PowerToys NOT started.'
    exit 1
}
Say 'validation passed: JSON ok, pairing fields intact, ShareClipboard = true'

# ---- 5. restart through the Highest task ----
if (Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Say "PowerToys started via task $TaskPath$TaskName (Highest integrity)"
} else {
    Start-Process -FilePath (Join-Path $env:LOCALAPPDATA 'PowerToys\PowerToys.exe')
    Say 'WARNING: scheduled task not found, used Start-Process (Medium integrity, see SKILL.md 2.7)'
}

# ---- 6. report final state ----
Start-Sleep -Seconds 25
$j2 = ([System.IO.File]::ReadAllText($cfg)) | ConvertFrom-Json
Say ("FINAL ShareClipboard = " + $j2.properties.ShareClipboard.value)
Say ("FINAL MachinePool    = " + $j2.properties.MachinePool.value)
$est = Get-NetTCPConnection -LocalPort 15101 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Established' }
if ($est) { Say ('FINAL link: established -> ' + ($est | ForEach-Object { $_.RemoteAddress }) -join ',') } else { Say 'FINAL link: NOT established (check the peer / firewall)' }
exit 0