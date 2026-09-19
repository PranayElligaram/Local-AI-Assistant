<#
.SYNOPSIS
    The Win32 half of the development workspace: list displays and windows, or
    place one window. Called only by bridge/workspace.mjs.

.DESCRIPTION
    Two fixed operations and nothing else - no program is started from here:

      -Op Snapshot   JSON { monitors, windows } for the whole virtual desktop
      -Op Place      move -Hwnd into the given rectangle and maximise it there

    The process opts into per-monitor DPI awareness first, so monitor bounds
    and window coordinates are both physical pixels. Without that, a scaled
    display reports virtualised numbers and windows land on the wrong screen.
#>
[CmdletBinding()]
param(
    [ValidateSet('Snapshot', 'Place')] [string] $Op = 'Snapshot',
    [long] $Hwnd = 0,
    [int] $X = 0,
    [int] $Y = 0,
    [int] $Width = 0,
    [int] $Height = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class JarvisWorkspaceWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    public delegate bool EnumMonitorsProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr l);

    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, EnumMonitorsProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    public static List<MONITORINFO> Monitors() {
        var list = new List<MONITORINFO>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr dc, ref RECT r, IntPtr l) => {
            var mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetMonitorInfo(m, ref mi)) list.Add(mi);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    // Visible, unowned top-level windows: the ones with a taskbar presence.
    public static List<IntPtr> TopLevel() {
        var list = new List<IntPtr>();
        EnumWindows((h, l) => {
            if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, s.Capacity); return s.ToString(); }
    public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, s.Capacity); return s.ToString(); }
}
'@

# PER_MONITOR_AWARE_V2. Fails harmlessly if the process is already aware.
[void][JarvisWorkspaceWin]::SetProcessDpiAwarenessContext([IntPtr](-4))

if ($Op -eq 'Snapshot') {
    $monitors = @(foreach ($m in [JarvisWorkspaceWin]::Monitors()) {
        [ordered]@{
            x = $m.rcMonitor.Left; y = $m.rcMonitor.Top
            width = $m.rcMonitor.Right - $m.rcMonitor.Left; height = $m.rcMonitor.Bottom - $m.rcMonitor.Top
            work = [ordered]@{
                x = $m.rcWork.Left; y = $m.rcWork.Top
                width = $m.rcWork.Right - $m.rcWork.Left; height = $m.rcWork.Bottom - $m.rcWork.Top
            }
            primary = [bool]($m.dwFlags -band 1)
        }
    })
    $names = @{}
    $windows = @(foreach ($h in [JarvisWorkspaceWin]::TopLevel()) {
        $title = [JarvisWorkspaceWin]::Text($h)
        if (-not $title) { continue }
        [uint32] $procId = 0
        [void][JarvisWorkspaceWin]::GetWindowThreadProcessId($h, [ref] $procId)
        if (-not $names.ContainsKey($procId)) {
            $names[$procId] = ''
            try { $names[$procId] = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
        }
        [ordered]@{
            hwnd = $h.ToInt64(); pid = $procId; process = $names[$procId]
            className = [JarvisWorkspaceWin]::Class($h); title = $title
        }
    })
    ConvertTo-Json -Compress -Depth 4 -InputObject ([ordered]@{ monitors = $monitors; windows = $windows })
    exit 0
}

# Place
$h = [IntPtr] $Hwnd
if (-not [JarvisWorkspaceWin]::IsWindow($h)) {
    ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'the window has gone' }
    exit 0
}
if ($Width -le 0 -or $Height -le 0) {
    ConvertTo-Json -Compress -InputObject @{ ok = $false; error = 'no target rectangle' }
    exit 0
}
# Restore first: a maximised window ignores SetWindowPos, and maximising after
# the move is what makes it maximise on the destination monitor.
[void][JarvisWorkspaceWin]::ShowWindow($h, 9)           # SW_RESTORE
[void][JarvisWorkspaceWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0014)  # NOZORDER|NOACTIVATE
[void][JarvisWorkspaceWin]::ShowWindow($h, 3)           # SW_MAXIMIZE
[void][JarvisWorkspaceWin]::SetForegroundWindow($h)

$r = New-Object JarvisWorkspaceWin+RECT
[void][JarvisWorkspaceWin]::GetWindowRect($h, [ref] $r)
$cx = [int](($r.Left + $r.Right) / 2)
$cy = [int](($r.Top + $r.Bottom) / 2)
$inside = $cx -ge $X -and $cx -lt ($X + $Width) -and $cy -ge $Y -and $cy -lt ($Y + $Height)
ConvertTo-Json -Compress -InputObject ([ordered]@{
    ok = $inside
    rect = [ordered]@{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
    error = $(if ($inside) { '' } else { 'the window did not land on the target monitor' })
})
