<#
.SYNOPSIS
    Stop the running JARVIS.

.DESCRIPTION
    Stops exactly the processes this repository's launcher started, using the
    PID file it writes to .jarvis\jarvis.pid. That precision is the point: "stop
    every node.exe" also stops the editor's language server and whatever else
    the machine is quietly running.

    Each process is asked to close first and killed only if it is still there,
    so the bridge gets the chance to cancel in-flight turns, release the local
    model and close its sockets.
#>
[CmdletBinding()]
param(
    [int] $GraceSeconds = 5
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $repo '.jarvis'
if ($env:JARVIS_RUN_DIR) { $runDir = $env:JARVIS_RUN_DIR }
$pidFile = Join-Path $runDir 'jarvis.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'JARVIS does not appear to be running (no .jarvis\jarvis.pid).'
    exit 0
}

$state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json

# Ask before insisting.
#
# On Windows, stopping a process is TerminateProcess: no handler runs, sockets
# are not closed, and in-flight model requests keep running after JARVIS is
# supposedly stopped. The bridge therefore accepts a
# shutdown request authorised by the token it wrote to .jarvis\bridge.json  - 
# holding that token means already being this user.
$bridgeFile = Join-Path $runDir 'bridge.json'
$asked = $false
if (Test-Path -LiteralPath $bridgeFile) {
    try {
        $bridge = Get-Content -LiteralPath $bridgeFile -Raw | ConvertFrom-Json
        Invoke-RestMethod `
            -Method Post `
            -Uri "http://127.0.0.1:$($bridge.port)/shutdown" `
            -Headers @{ 'x-jarvis-token' = $bridge.token } `
            -TimeoutSec 3 | Out-Null
        Write-Host 'Asked the bridge to stop.'
        $asked = $true
        Start-Sleep -Milliseconds 700
    } catch {
        # Already gone, or not listening. The PID path below handles it.
    }
}

$targets = @()
if ($state.children) { $targets += $state.children }
if ($state.launcher) { $targets += $state.launcher }

$stopped = @()
foreach ($target in $targets) {
    $process = Get-Process -Id $target -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    # Only ever a node process. A PID is reused by Windows once the original
    # exits, and stopping whatever inherited it would be a genuinely nasty bug.
    if ($process.ProcessName -notmatch '^(node|vite)$') {
        Write-Warning "PID $target is now $($process.ProcessName)  -  leaving it alone."
        continue
    }
    # A stale PID may now belong to another node process. Compare its creation
    # time with when the launcher recorded starting it (per child when known:
    # a bridge restarted by voice starts later than the launcher did).
    $launchText = $state.startedAt
    if ($state.childStartedAt -and $state.childStartedAt."$target") {
        $launchText = $state.childStartedAt."$target"
    }
    if ($launchText) {
        $launched = [DateTimeOffset]::Parse($launchText).UtcDateTime
        $created = $process.StartTime.ToUniversalTime()
        if ($created -lt $launched.AddSeconds(-10) -or $created -gt $launched.AddSeconds(10)) {
            Write-Warning "PID $target was reused - leaving it alone."
            continue
        }
    } else {
        Write-Warning "PID $target has no launch timestamp - leaving it alone."
        continue
    }
    try {
        $null = $process.CloseMainWindow()
    } catch {
        # A console-less child has no window to close; the kill below covers it.
    }
    $stopped += $process
}

foreach ($process in $stopped) {
    if (-not $process.WaitForExit($GraceSeconds * 1000)) {
        Write-Host "PID $($process.Id) did not exit in time; stopping it."
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        if (-not $process.WaitForExit(5000)) {
            throw "PID $($process.Id) is still running. Retaining the PID file for another stop attempt."
        }
    }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
if ($stopped.Count -gt 0) {
    Write-Host "JARVIS stopped. Processes ended: $($stopped.Count)."
} elseif ($asked) {
    Write-Host 'JARVIS stopped.'
} else {
    Write-Host 'JARVIS was not running; cleared the stale PID file.'
}
