<#
.SYNOPSIS
    Open the JARVIS interface in a real Chrome or Edge window, optionally on a
    chosen monitor.

.DESCRIPTION
    Two things this exists for, both learned from the previous implementation:

      1. A REAL browser window. Embedded preview panes (editors, Claude Code's
         own preview) block getUserMedia, so the page renders perfectly and
         never hears a word. Chrome's --app window is a real window.
      2. Placement. The old assistant placed each window on a numbered monitor,
         left to right then top to bottom, and that ordering is kept here.

    It waits for the dev server to answer before opening anything, so the first
    paint is the interface rather than a connection error.
#>
[CmdletBinding()]
param(
    [string] $Url = "http://localhost:5173",
    [int] $Monitor = 0,
    [switch] $Fullscreen,
    [int] $TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

function Find-Browser {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path -LiteralPath $path)) { return $path }
    }
    return $null
}

$helper = Join-Path $PSScriptRoot 'workspace-windows.ps1'

function Get-Snapshot { & $helper -Op Snapshot | ConvertFrom-Json }

# The dedicated window: an --app window is titled by the page alone. The same
# page in an ordinary tab reads "J.A.R.V.I.S. - Google Chrome" and is not it.
function Find-JarvisWindow($snap) {
    @($snap.windows) | Where-Object { $_.process -match '^(chrome|msedge)$' -and $_.title -ceq 'J.A.R.V.I.S.' } | Select-Object -First 1
}

# Wait for the face to be up. A browser opened too early lands on a connection
# error page and the user has to reload, which is exactly the sort of small
# friction that makes an assistant feel unreliable.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
        if ($response.StatusCode -ge 200) { $ready = $true; break }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
if (-not $ready) {
    Write-Warning "The interface at $Url did not answer within $TimeoutSeconds seconds."
    exit 1
}

# Reuse before launching: a second logon, a restart or a second run of this
# script must not stack up JARVIS windows.
$snap = Get-Snapshot
$window = Find-JarvisWindow $snap
if ($window) {
    Write-Host 'JARVIS interface already open; reusing its window.'
} else {
    $browser = Find-Browser
    if (-not $browser) {
        Write-Warning 'Neither Chrome nor Edge was found. Open the URL yourself, in a real browser window.'
        exit 1
    }
    # The user's own profile, so the microphone permission already granted to
    # this origin still applies. --app gives JARVIS its own top-level window,
    # never a tab in somebody's browsing window.
    Start-Process -FilePath $browser -ArgumentList @("--app=$Url") | Out-Null
    Write-Host "JARVIS interface opened in $(Split-Path -Leaf $browser)."
    $deadline = (Get-Date).AddSeconds(20)
    while (-not $window -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 750
        $snap = Get-Snapshot
        $window = Find-JarvisWindow $snap
    }
    if (-not $window) {
        Write-Warning 'The JARVIS window did not appear in time; it was not placed.'
        exit 1
    }
}

# Monitors numbered left to right, then top to bottom - the ordering the
# workspace uses too. A missing monitor falls back to the primary. -Fullscreen
# is kept for existing task definitions: a placed window is always maximised.
if ($Monitor -gt 0) {
    $monitors = @($snap.monitors | Sort-Object x, y)
    $target = if ($Monitor -le $monitors.Count) { $monitors[$Monitor - 1] } else {
        Write-Warning "Monitor $Monitor does not exist; using the primary display."
        @($monitors | Where-Object { $_.primary })[0]
    }
    if ($target) {
        $placed = & $helper -Op Place -Hwnd $window.hwnd -X $target.work.x -Y $target.work.y -Width $target.work.width -Height $target.work.height | ConvertFrom-Json
        if ($placed.ok) { Write-Host "JARVIS placed on monitor $Monitor." } else { Write-Warning "JARVIS was not placed: $($placed.error)" }
    }
}
