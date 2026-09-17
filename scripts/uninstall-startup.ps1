<#
.SYNOPSIS
    Remove the JARVIS logon task.

.DESCRIPTION
    Removes exactly the task install-startup.ps1 registered, and nothing else.
    An exact-name match, deliberately: the previous implementation's uninstaller
    had the same rule, because a wildcard here is how an unrelated scheduled
    task gets deleted by a script nobody reads twice.
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'JarvisAssistant'
)

$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "No scheduled task named '$TaskName' is installed; nothing to remove."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed the scheduled task '$TaskName'."
Write-Host 'JARVIS will no longer start at logon. Start it by hand with scripts\jarvis.ps1.'
