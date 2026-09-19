<#
.SYNOPSIS
    Start JARVIS automatically when the current user logs in.

.DESCRIPTION
    Registers a per-user scheduled task that runs scripts\jarvis.ps1 at logon.
    Ported from the previous implementation's fast-start task, which was the
    shape that actually worked on this machine:

      - current user only, Limited run level: no admin rights, no elevation,
        nothing that needs a password stored;
      - allowed to run on battery and not stopped when the machine unplugs,
        because a desktop assistant that dies when the charger comes out is
        not an assistant;
      - no execution time limit, because it is meant to run all day;
      - IgnoreNew, so a second logon cannot start a second JARVIS fighting the
        first one for port 8787.

    The repository path is derived from this script's own location, never
    hard-coded. Nothing outside the current user's task store is modified.
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'JarvisAssistant',
    [switch] $Open,
    [int] $Monitor = 0,
    [switch] $Fullscreen
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'jarvis.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "The JARVIS launcher was not found: $launcher"
}

$launcherArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`"", '-Source', 'logon')
if ($Open) { $launcherArgs += '-Open' }
if ($Monitor -gt 0) { $launcherArgs += @('-Monitor', $Monitor) }
if ($Fullscreen) { $launcherArgs += '-Fullscreen' }

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument ($launcherArgs -join ' ') `
    -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -RunOnlyIfIdle:$false `
    -RunOnlyIfNetworkAvailable:$false `
    -Hidden:$false `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Start the JARVIS assistant at current-user logon' `
    -Force | Out-Null

Write-Host "JARVIS logon task installed for the current user."
Write-Host "Task:        $TaskName"
Write-Host "Trigger:     at logon for $currentUser"
Write-Host "Launcher:    powershell.exe $($launcherArgs -join ' ')"
Write-Host "Working dir: $repo"
Write-Host ''
Write-Host "Remove it again with: scripts\uninstall-startup.ps1"
