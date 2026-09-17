<#
.SYNOPSIS
    Restart JARVIS: stop whatever is running, then start it again.

.DESCRIPTION
    A restart is its own command rather than two typed in sequence because the
    interesting part is the wait in the middle: the bridge has to release port
    8787 before the new one can bind it, and a start that races the stop fails
    with "port already in use" — which reads as a bug rather than as impatience.
#>
[CmdletBinding()]
param(
    [switch] $Writes,
    [switch] $Open,
    [int] $Monitor = 0,
    [switch] $Fullscreen,
    [int] $Port = 8787
)

$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop.ps1')

# Wait for the port to actually come free.
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $inUse = $null
    try {
        $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    } catch {
        # Get-NetTCPConnection is unavailable on some SKUs; the start will
        # report the conflict itself if there still is one.
        break
    }
    if (-not $inUse) { break }
    Start-Sleep -Milliseconds 400
}

$startArgs = @()
if ($Writes) { $startArgs += '-Writes' }
if ($Open) { $startArgs += '-Open' }
if ($Monitor -gt 0) { $startArgs += @('-Monitor', $Monitor) }
if ($Fullscreen) { $startArgs += '-Fullscreen' }

& (Join-Path $PSScriptRoot 'jarvis.ps1') @startArgs
