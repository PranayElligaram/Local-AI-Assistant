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

function Get-MonitorRect {
    param([int] $Index)
    if ($Index -le 0) { return $null }
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if (-not $screens) { return $null }
    # Left to right, then top to bottom  -  the same ordering the previous
    # implementation used, so a monitor number means the same thing it did.
    $ordered = $screens | Sort-Object { $_.Bounds.X }, { $_.Bounds.Y }
    if ($Index -gt $ordered.Count) {
        Write-Warning "Monitor $Index does not exist; Windows will choose."
        return $null
    }
    return $ordered[$Index - 1].WorkingArea
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

$browser = Find-Browser
if (-not $browser) {
    Write-Warning 'Neither Chrome nor Edge was found. Open the URL yourself, in a real browser window.'
    exit 1
}

$argumentList = @("--app=$Url", '--new-window')
$rect = Get-MonitorRect -Index $Monitor
if ($rect) {
    $argumentList += "--window-position=$($rect.X),$($rect.Y)"
    if ($Fullscreen) {
        $argumentList += "--window-size=$($rect.Width),$($rect.Height)"
    }
} elseif ($Fullscreen) {
    $argumentList += '--start-maximized'
}

Start-Process -FilePath $browser -ArgumentList $argumentList | Out-Null
Write-Host "JARVIS interface opened in $(Split-Path -Leaf $browser)."
