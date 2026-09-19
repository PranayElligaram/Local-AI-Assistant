<#
.SYNOPSIS
    Start JARVIS (the bridge and the interface) on Windows.

.DESCRIPTION
    The supported way to start JARVIS on this machine. It picks a Node 20+
    interpreter itself (see node.ps1), starts both halves through
    scripts/start.mjs, and optionally opens the interface in a real Chrome or
    Edge window  -  which matters, because an embedded preview pane cannot use
    the microphone, and JARVIS then looks perfectly alive and never hears you.

.PARAMETER Writes
    Allow effectful tools (shell, files, the browser, sending). Off by default.

.PARAMETER Open
    Open the interface in Chrome or Edge once the dev server answers.

.PARAMETER Monitor
    1-based monitor to place that window on, left to right, then top to bottom.
    Carried over from the previous implementation's placement behaviour.

.PARAMETER Source
    Who started JARVIS, for diagnostics: 'manual' (default) or 'logon', which
    the logon task passes. It changes nothing about what starts.
.PARAMETER Fullscreen
    Open the window filling the chosen monitor's work area.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\jarvis.ps1 -Open -Monitor 1
#>
[CmdletBinding()]
param(
    [switch] $Writes,
    [switch] $Open,
    [int] $Monitor = 0,
    [switch] $Fullscreen,
    [ValidateSet('manual', 'logon')] [string] $Source = 'manual'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'node.ps1')

Push-Location $repo
try { $node = Find-JarvisNode } finally { Pop-Location }
if (-not $node) {
    throw @'
No Node.js 20 or newer was found on this machine.

JARVIS needs it for the bridge. Install it once from https://nodejs.org (the
LTS build is fine), or, if you use Volta or nvm-for-windows, install a 20+
version there. Nothing else needs to change.
'@
}

Write-Host "JARVIS: using $node" -ForegroundColor DarkCyan

if (-not (Test-Path -LiteralPath (Join-Path $repo 'node_modules'))) {
    throw "Dependencies are not installed. Run `npm ci` in $repo first."
}

# Read by the bridge through start.mjs's inherited environment.
$env:JARVIS_START_SOURCE = $Source

$startArgs = @((Join-Path $repo 'scripts\start.mjs'))
if ($Writes) { $startArgs += '--writes' }

if ($Open) {
    # Started before the launcher blocks, and it waits for the dev server on
    # its own. Placement lives in open-ui.ps1 so `npm start` users can call it
    # separately without going through this script.
    $openArgs = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (Join-Path $PSScriptRoot 'open-ui.ps1')
    )
    if ($Monitor -gt 0) { $openArgs += @('-Monitor', $Monitor) }
    if ($Fullscreen) { $openArgs += '-Fullscreen' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $openArgs -WindowStyle Hidden | Out-Null
}

Push-Location $repo
try {
    & $node @startArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
