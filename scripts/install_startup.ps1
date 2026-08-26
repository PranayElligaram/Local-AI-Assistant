[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repositoryDirectory = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $repositoryDirectory "start_jarvis.bat"
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Jarvis launcher was not found: $launcherPath"
}

$startupDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Startup
)
if ([string]::IsNullOrWhiteSpace($startupDirectory)) {
    throw "The current user's Windows Startup folder could not be located."
}

$shortcutPath = Join-Path $startupDirectory "Jarvis.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $repositoryDirectory
$shortcut.Description = "Start the Jarvis desktop assistant"
$shortcut.Save()

Write-Host "Jarvis Startup shortcut installed for the current user:"
Write-Host $shortcutPath
