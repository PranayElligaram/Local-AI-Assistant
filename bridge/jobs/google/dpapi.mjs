/**
 * Windows DPAPI (CurrentUser) for the Google refresh token.
 *
 * The PowerShell script is a fixed string; the data travels over stdin as
 * base64 and nothing is ever placed on a command line, so no value can become
 * part of a command. There is deliberately no plaintext fallback: on a
 * platform without DPAPI the token is simply not stored.
 */

import { spawn } from 'node:child_process'

const SCRIPT = (op) =>
  [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    '$bytes = [Convert]::FromBase64String($in)',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('; ')

function run(op, inputB64, spawnFn) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32' && spawnFn === spawn) return reject(new Error('DPAPI is only available on Windows'))
    const exe = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const child = spawnFn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT(op)], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.once('error', reject)
    child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`DPAPI ${op} failed (${code}): ${err.split('\n')[0].slice(0, 120)}`))))
    child.stdin.end(inputB64)
  })
}

export const protect = async (text, { spawnFn = spawn } = {}) => run('Protect', Buffer.from(text, 'utf8').toString('base64'), spawnFn)
export const unprotect = async (b64, { spawnFn = spawn } = {}) => Buffer.from(await run('Unprotect', b64, spawnFn), 'base64').toString('utf8')
