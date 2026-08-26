[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$startupDirectory = [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::Startup
)
if ([string]::IsNullOrWhiteSpace($startupDirectory)) {
    throw "The current user's Windows Startup folder could not be located."
}

$shortcutPath = Join-Path $startupDirectory "Jarvis.lnk"
if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Jarvis Startup shortcut removed for the current user:"
    Write-Host $shortcutPath
} else {
    Write-Host "Jarvis Startup shortcut is not installed for the current user."
}
