<#
.SYNOPSIS
    Stop the running JARVIS.

.DESCRIPTION
    Stops exactly the processes this repository's launcher started, using the
    PID file it writes to .jarvis\jarvis.pid. That precision is the point: "stop
    every node.exe" also stops the editor's language server and whatever else
    the machine is quietly running.

    Each process is asked to close first and killed only if it is still there,
    so the bridge gets the chance to close its sockets and reap the agent's own
    child process.
#>
[CmdletBinding()]
param(
    [int] $GraceSeconds = 5
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $repo '.jarvis\jarvis.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'JARVIS does not appear to be running (no .jarvis\jarvis.pid).'
    exit 0
}

$state = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json

# Ask before insisting.
#
# On Windows, stopping a process is TerminateProcess: no handler runs, sockets
# are not closed, and the agent's own `claude` child is orphaned and keeps
# running after JARVIS is supposedly stopped. The bridge therefore accepts a
# shutdown request authorised by the token it wrote to .jarvis\bridge.json —
# holding that token means already being this user.
$bridgeFile = Join-Path $repo '.jarvis\bridge.json'
if (Test-Path -LiteralPath $bridgeFile) {
    try {
        $bridge = Get-Content -LiteralPath $bridgeFile -Raw | ConvertFrom-Json
        Invoke-RestMethod `
            -Method Post `
            -Uri "http://127.0.0.1:$($bridge.port)/shutdown" `
            -Headers @{ 'x-jarvis-token' = $bridge.token } `
            -TimeoutSec 3 | Out-Null
        Write-Host 'Asked the bridge to stop.'
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
        Write-Warning "PID $target is now $($process.ProcessName) — leaving it alone."
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
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
if ($stopped.Count -gt 0) {
    Write-Host "JARVIS stopped ($($stopped.Count) process(es))."
} else {
    Write-Host 'JARVIS was not running; cleared the stale PID file.'
}
