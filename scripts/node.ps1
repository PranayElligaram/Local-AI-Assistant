<#
.SYNOPSIS
    Find a Node.js 20+ interpreter on this machine.

.DESCRIPTION
    Dot-source this file to get Find-JarvisNode. It exists because a Windows
    machine that has done any JavaScript work usually has several Node versions
    installed, and the one first on PATH is whichever a previous project pinned.
    JARVIS needs 20 or newer; failing with "node is too old" while a perfectly
    good Node 22 sits in Volta's or nvm's store is a bad way to start.

    Search order: PATH, Volta's image store, nvm-for-windows, Program Files.
    Nothing is installed and nothing is changed  -  this only looks.
#>

function Get-NodeMajor {
    param([string] $Exe)
    try {
        $raw = & $Exe -v 2>$null
    } catch {
        return 0
    }
    if (-not $raw) { return 0 }
    $text = ($raw | Select-Object -First 1).ToString().Trim().TrimStart('v')
    $first = $text.Split('.')[0]
    $parsed = 0
    if ([int]::TryParse($first, [ref] $parsed)) { return $parsed }
    return 0
}

function Find-JarvisNode {
    param([int] $Minimum = 20)

    $candidates = New-Object System.Collections.Generic.List[string]

    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { $candidates.Add($onPath.Source) }

    $voltaImages = Join-Path $env:LOCALAPPDATA 'Volta\tools\image\node'
    if (Test-Path -LiteralPath $voltaImages) {
        Get-ChildItem -LiteralPath $voltaImages -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object {
                $exe = Join-Path $_.FullName 'node.exe'
                if (Test-Path -LiteralPath $exe) { $candidates.Add($exe) }
            }
    }

    $nvmRoot = Join-Path $env:LOCALAPPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmRoot) {
        Get-ChildItem -LiteralPath $nvmRoot -Directory -Filter 'v*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object {
                $exe = Join-Path $_.FullName 'node.exe'
                if (Test-Path -LiteralPath $exe) { $candidates.Add($exe) }
            }
    }

    foreach ($fixed in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')
    )) {
        if ($fixed -and (Test-Path -LiteralPath $fixed)) { $candidates.Add($fixed) }
    }

    foreach ($candidate in $candidates) {
        if (-not $candidate) { continue }
        if ((Get-NodeMajor -Exe $candidate) -lt $Minimum) { continue }
        $rawVersion = (& $candidate -v 2>$null | Select-Object -First 1)
        if (-not $rawVersion) { continue }
        $version = [version]$rawVersion.Trim().TrimStart('v')
        if (($version.Major -eq 20 -and $version.Minor -ge 19) -or
            ($version.Major -eq 22 -and $version.Minor -ge 12) -or
            $version.Major -gt 22) { return $candidate }
    }
    return $null
}
