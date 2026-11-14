<#
.SYNOPSIS
    Read-only check of Mouse Without Borders clipboard sharing.

.DESCRIPTION
    Answers one question: is ShareClipboard true?
    A false value means this machine can RECEIVE clipboard but never SEND it,
    which shows up as "copy works one way only" (PC0 -> PC1 dead, PC1 -> PC0 fine).
    See local-pc SKILL.md section 2.12.

    Ctrl+V and right-click paste fail identically when this is the cause:
    the data never crosses the wire, so no paste method can help.

    This script NEVER writes anything. Run it first when clipboard sync breaks.

.PARAMETER Peer
    Also check the peer: copies this script over SSH, runs it there, removes it.
    Requires the passwordless SSH channel (SKILL.md 7.6).

.PARAMETER PeerUser
    SSH user on the peer. Default 'share'.

.PARAMETER PeerHost
    Peer IP. Default 192.168.1.37 (PC0). On PC0 pass 192.168.1.38.

.PARAMETER KeyPath
    SSH private key. Default $HOME\.ssh\id_ed25519_pc0

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File Test-MwbClipboard.ps1 -Peer
#>
[CmdletBinding()]
param(
    [switch]$Peer,
    [string]$PeerUser = 'share',
    [string]$PeerHost = '192.168.1.37',
    [string]$KeyPath  = (Join-Path $HOME '.ssh\id_ed25519_pc0')
)

$ErrorActionPreference = 'Continue'

function Get-ShareClipboard {
    # The MWB settings belong to the INTERACTIVE user, which may differ from the
    # account this shell runs as (e.g. an SSH session as 'share'). Search all profiles
    # and use the most recently written settings.json.
    $hits = Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        Join-Path $_.FullName 'AppData\Local\Microsoft\PowerToys\MouseWithoutBorders\settings.json'
    } | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ } | Sort-Object LastWriteTime -Descending
    if (-not $hits) { return 'NO_SETTINGS' }
    $cfg = $hits[0].FullName
    $script:ResolvedSettings = $cfg
    $t = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($cfg))
    $i = $t.IndexOf('"ShareClipboard"')
    if ($i -lt 0) { return 'KEY_MISSING' }
    $w = $t.Substring($i, 90)
    $pF = $w.IndexOf('false')
    $pT = $w.IndexOf('true')
    if ($pT -ge 0 -and ($pF -lt 0 -or $pT -lt $pF)) { return 'true' }
    if ($pF -ge 0) { return 'false' }
    return 'UNKNOWN'
}
$local = Get-ShareClipboard
Write-Output ('THIS MACHINE (' + $env:COMPUTERNAME + ') ShareClipboard = ' + $local)
if ($script:ResolvedSettings) { Write-Output ('  settings: ' + $script:ResolvedSettings) }

$link = Get-NetTCPConnection -LocalPort 15101 -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Established' }
if ($link) { Write-Output ('LINK 15101 = established -> ' + (($link | ForEach-Object { $_.RemoteAddress }) -join ',')) } else { Write-Output 'LINK 15101 = NOT established' }

$remoteVal = $null
if ($Peer) {
    # Ship the probe as a PowerShell -EncodedCommand (UTF-16LE base64).
    # This sidesteps every quoting/escaping problem and needs no temp file on the peer.
    $probeBody = @(
        '$hits = Get-ChildItem ''C:\Users'' -Directory -ErrorAction SilentlyContinue | ForEach-Object {'
        '    Join-Path $_.FullName ''AppData\Local\Microsoft\PowerToys\MouseWithoutBorders\settings.json'''
        '} | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ } | Sort-Object LastWriteTime -Descending'
        'if (-not $hits) { Write-Output ''NO_SETTINGS''; exit }'
        '$cfg = $hits[0].FullName'
        '$t = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($cfg))'
        '$i = $t.IndexOf(''ShareClipboard'')'
        'if ($i -lt 0) { Write-Output ''KEY_MISSING''; exit }'
        '$w = $t.Substring($i, 90)'
        '$pF = $w.IndexOf(''false''); $pT = $w.IndexOf(''true'')'
        '$v = if ($pT -ge 0 -and ($pF -lt 0 -or $pT -lt $pF)) { ''true'' } else { ''false'' }'
        'Write-Output (''RESULT='' + $v)'
    ) -join [Environment]::NewLine

    $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($probeBody))
    $target = $PeerUser + '@' + $PeerHost
    $out = & ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=8 -i $KeyPath $target ('powershell -NoProfile -EncodedCommand ' + $enc) 2>&1
    $out = $out | Where-Object { $_ -notmatch 'post-quantum|vulnerable|openssh\.com/pq' }
    $joined = ($out -join ' ')
    $mm = [regex]::Match($joined, 'RESULT=(true|false)')
    if ($mm.Success) { $remoteVal = $mm.Groups[1].Value } else { $remoteVal = 'UNREADABLE' }
    Write-Output ('PEER ' + $PeerHost + ' ShareClipboard = ' + $remoteVal)
}
Write-Output ''
$bad = @()
if ($local -ne 'true') { $bad += $env:COMPUTERNAME }
if ($Peer -and $remoteVal -ne 'true') { $bad += $PeerHost }
if ($bad.Count -eq 0) {
    if ($Peer) { Write-Output 'RESULT: both sides ShareClipboard = true. If copy still fails, look elsewhere.' }
    else { Write-Output 'RESULT: this machine ShareClipboard = true. Re-run with -Peer to check the other side.' }
} else {
    Write-Output ('RESULT: ShareClipboard is NOT true on: ' + ($bad -join ', '))
    Write-Output 'That machine can receive clipboard but never send it.'
    Write-Output 'FIX: run Fix-MwbClipboard.ps1 ON THAT MACHINE.'
}