/**
 * A Windows toast for the batched job-search update. The script is fixed; the
 * text travels in environment variables and is XML-escaped by .NET inside the
 * script, so no value is ever part of a command line or of the script.
 */

import { spawn } from 'node:child_process'

const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$t = [Security.SecurityElement]::Escape($env:JARVIS_TOAST_TITLE)',
  '$b = [Security.SecurityElement]::Escape($env:JARVIS_TOAST_TEXT)',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")',
  '$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('; ')

export function showToast(title, text, { spawnFn = spawn } = {}) {
  if (process.platform !== 'win32' && spawnFn === spawn) return Promise.resolve({ ok: false, error: 'not Windows' })
  return new Promise((resolve) => {
    const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    let child
    try {
      child = spawnFn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        // No secrets in the child's environment.
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(k))), JARVIS_TOAST_TITLE: String(title).slice(0, 80), JARVIS_TOAST_TEXT: String(text).slice(0, 400) },
      })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('close', (code) => resolve({ ok: code === 0 }))
  })
}
