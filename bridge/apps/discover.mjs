/**
 * Where installed applications are found - and, as importantly, where not.
 *
 * Sources, all of them places Windows itself lists as "installed":
 *   - the current user's Start Menu      %APPDATA%\Microsoft\Windows\Start Menu\Programs
 *   - the all-users Start Menu           %PROGRAMDATA%\Microsoft\Windows\Start Menu\Programs
 *   - registered App Paths               HKCU / HKLM ...\CurrentVersion\App Paths
 *   - Start apps, including packaged (UWP / MSIX) apps, via Get-StartApps
 *   - a handful of Windows built-ins, as a fallback when the above fail
 *
 * Never: a recursive scan of the drive for .exe files. An executable sitting in
 * Downloads is not an installed program, and treating it as one would let any
 * file with a plausible name become something JARVIS launches by voice.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/** Start Menu entries that are not applications. */
const NOT_AN_APP =
  /\b(uninstall|uninstaller|readme|read me|release notes|help|documentation|docs|manual|manuals|website|web site|licen[cs]e|changelog|faq|faqs|what'?s new|support|user guide|sample|samples)\b/i

export const isAppName = (name) => Boolean(name) && !NOT_AN_APP.test(name)

const LAUNCHABLE = new Set(['.lnk', '.appref-ms', '.exe'])

/** Start Menu shortcuts, bounded in depth. */
export function scanStartMenu(dir, source, maxDepth = 4) {
  const out = []
  const walk = (d, depth) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const full = join(d, ent.name)
      if (ent.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
        continue
      }
      const ext = extname(ent.name).toLowerCase()
      if (!LAUNCHABLE.has(ext)) continue
      const name = basename(ent.name, extname(ent.name))
      if (!isAppName(name)) continue
      out.push({ name, type: ext === '.exe' ? 'exe' : 'shortcut', target: full, source })
    }
  }
  if (dir && existsSync(dir)) walk(dir, 0)
  return out
}

/** Parse `reg query "<App Paths>" /s` output. */
export function parseAppPaths(text, source) {
  const out = []
  let key = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (/^HKEY_/i.test(line)) {
      const m = /\\App Paths\\([^\\]+)$/i.exec(line)
      key = m ? m[1] : null
      continue
    }
    if (!key) continue
    const m = /^\s+\(Default\)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i.exec(line)
    if (!m) continue
    const target = m[1]
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`)
    if (!/\.exe$/i.test(target)) {
      key = null
      continue
    }
    out.push({ name: basename(key, extname(key)), type: 'exe', target, source })
    key = null
  }
  return out
}

/** `Get-StartApps | ConvertTo-Json` -> entries. Documents and web links are dropped. */
export function parseStartApps(json) {
  let rows
  try {
    rows = JSON.parse(String(json || '[]'))
  } catch {
    return []
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : []
  return rows
    .filter((r) => r && typeof r.Name === 'string' && typeof r.AppID === 'string')
    .filter((r) => isAppName(r.Name))
    .filter((r) => !/^[a-z]+:\/\//i.test(r.AppID))
    .filter((r) => !/\.(url|chm|html?|pdf|txt|rtf|docx?|md)$/i.test(r.AppID))
    .filter((r) => !/["\r\n]/.test(r.AppID))
    .map((r) => ({ name: r.Name, type: 'startapp', target: r.AppID, source: 'start-apps' }))
}

/**
 * What a batch of .lnk files point at, read through the Windows shell. Paths
 * are passed in, never searched for, and results come back by index so a
 * name the console encoding mangles still lines up with its row.
 */
export function shortcutCommand(paths) {
  const list = paths.map((p) => `'${String(p).replace(/'/g, "''")}'`).join(',')
  return (
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8;$s=New-Object -ComObject WScript.Shell;$x=@(' +
    list +
    ');@(for($i=0;$i -lt $x.Count;$i++){try{$l=$s.CreateShortcut($x[$i]);[pscustomobject]@{i=$i;t=$l.TargetPath;a=$l.Arguments;w=$l.WorkingDirectory}}catch{}})|ConvertTo-Json -Compress'
  )
}

/** `shortcutCommand` output -> Map(index -> { target, args, workDir }). */
export function parseShortcuts(json) {
  let rows
  try {
    rows = JSON.parse(String(json || '[]'))
  } catch {
    return new Map()
  }
  if (!Array.isArray(rows)) rows = rows ? [rows] : []
  const out = new Map()
  for (const r of rows) {
    if (!r || !Number.isInteger(r.i) || typeof r.t !== 'string' || !r.t) continue
    out.set(r.i, { target: r.t, args: typeof r.a === 'string' ? r.a : '', workDir: typeof r.w === 'string' ? r.w : '' })
  }
  return out
}

/** Attach each Start Menu shortcut's real target, so equivalent shortcuts can be told apart from different apps. */
async function readShortcuts(rows, exec, timeoutMs) {
  const links = rows.filter((r) => r.type === 'shortcut' && /\.lnk$/i.test(r.target))
  const BATCH = 60
  for (let at = 0; at < links.length; at += BATCH) {
    const batch = links.slice(at, at + BATCH)
    const json = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', shortcutCommand(batch.map((r) => r.target))], timeoutMs)
    for (const [i, link] of parseShortcuts(json ?? '[]')) {
      if (!batch[i]) continue
      let exists = false
      try {
        exists = statSync(link.target).isFile()
      } catch {
        /* a dangling shortcut */
      }
      batch[i].link = { ...link, exists }
    }
  }
}

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

/** Windows built-ins, for when discovery itself is unavailable. */
export function builtinApps() {
  return [
    { name: 'Notepad', type: 'exe', target: join(SYSTEM32, 'notepad.exe') },
    { name: 'Paint', type: 'exe', target: join(SYSTEM32, 'mspaint.exe') },
    { name: 'Calculator', type: 'exe', target: join(SYSTEM32, 'calc.exe') },
    { name: 'Command Prompt', type: 'exe', target: join(SYSTEM32, 'cmd.exe') },
    { name: 'Windows PowerShell', type: 'exe', target: join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') },
    { name: 'File Explorer', type: 'exe', target: join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe') },
    { name: 'Task Manager', type: 'exe', target: join(SYSTEM32, 'Taskmgr.exe') },
    { name: 'Settings', type: 'uri', target: 'ms-settings:' },
  ].map((a) => ({ ...a, source: 'builtin' }))
}

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    )
  })
}

/**
 * Collect every source. Each is independent and bounded: one failing (no
 * PowerShell, a locked registry hive) never empties the catalogue.
 */
export async function discoverApps({
  env = process.env,
  platform = process.platform,
  exec = run,
  timeoutMs = 20_000,
} = {}) {
  const sources = {}
  const all = []
  const add = (name, list) => {
    sources[name] = list.length
    all.push(...list)
  }

  add('startmenu-user', scanStartMenu(env.APPDATA && join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 'startmenu-user'))
  add(
    'startmenu-system',
    scanStartMenu(env.ProgramData && join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'), 'startmenu-system'),
  )

  if (platform === 'win32') {
    const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\App Paths'
    const [hkcu, hklm, startApps] = await Promise.all([
      exec('reg.exe', ['query', `HKCU\\${key}`, '/s'], timeoutMs),
      exec('reg.exe', ['query', `HKLM\\${key}`, '/s'], timeoutMs),
      exec(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
        timeoutMs,
      ),
    ])
    const exists = (e) => {
      try {
        return statSync(e.target).isFile()
      } catch {
        return false
      }
    }
    await readShortcuts(all, exec, timeoutMs)
    add('app-paths', [...parseAppPaths(hkcu ?? '', 'app-paths'), ...parseAppPaths(hklm ?? '', 'app-paths')].filter(exists))
    add('start-apps', parseStartApps(startApps ?? '[]'))
    add('builtin', builtinApps().filter((e) => e.type === 'uri' || exists(e)))
  }
  return { entries: all, sources }
}
