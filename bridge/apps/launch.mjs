/**
 * Launching a RESOLVED catalogue entry - and nothing else.
 *
 * This takes an entry object that came out of the catalogue, never a string
 * from the model. No arguments are ever passed to the launched program, and no
 * shell is ever involved: opening PowerShell opens PowerShell, and there is no
 * way to make it run anything.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

const WINDIR = process.env.SystemRoot ?? 'C:\\Windows'
const EXPLORER = `${WINDIR}\\explorer.exe`

/** How each entry type is started: [program, argv]. */
export function launchCommand(entry) {
  if (!entry || typeof entry.target !== 'string' || !entry.target) throw new Error('no launch target')
  if (/["\r\n]/.test(entry.target) || entry.target.includes(String.fromCharCode(0))) {
    throw new Error('launch target contains forbidden characters')
  }
  switch (entry.type) {
    case 'exe':
      if (!isAbsolute(entry.target) || !/\.exe$/i.test(entry.target)) throw new Error('not an absolute .exe')
      if (!existsSync(entry.target)) throw new Error('the program is no longer there')
      return [entry.target, []]
    case 'shortcut':
      if (!isAbsolute(entry.target)) throw new Error('not an absolute shortcut path')
      if (!existsSync(entry.target)) throw new Error('the shortcut is no longer there')
      return [EXPLORER, [entry.target]]
    case 'startapp':
      return [EXPLORER, [`shell:AppsFolder\\${entry.target}`]]
    case 'uri':
      if (!/^ms-settings:[a-z-]*$/i.test(entry.target)) throw new Error('unsupported uri')
      return [EXPLORER, [entry.target]]
    default:
      throw new Error(`unknown entry type ${entry.type}`)
  }
}

/**
 * @returns {Promise<{ ok: boolean, dryRun?: boolean, error?: string, command?: string[] }>}
 */
export function launchApp(entry, { dryRun = false, spawnFn = spawn } = {}) {
  let file, args
  try {
    ;[file, args] = launchCommand(entry)
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message })
  }
  if (dryRun) return Promise.resolve({ ok: true, dryRun: true, command: [file, ...args] })
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, {
        cwd: entry.type === 'exe' ? dirname(file) : undefined,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/** A web address, opened in the default browser. Only http(s). */
export function openUrlCommand(url) {
  return [`${WINDIR}\\System32\\rundll32.exe`, ['url.dll,FileProtocolHandler', url]]
}

export function openUrl(url, { dryRun = false, spawnFn = spawn } = {}) {
  const [file, args] = openUrlCommand(url)
  if (dryRun) return Promise.resolve({ ok: true, dryRun: true, command: [file, ...args] })
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { detached: true, stdio: 'ignore', shell: false })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}

/**
 * Sign out of Windows. Fixed: no argument reaches the command line, so this
 * can only ever end the current session - never run anything else.
 */
export function signOutCommand() {
  return [`${WINDIR}\\System32\\shutdown.exe`, ['/l']]
}

export function signOut({ dryRun = false, spawnFn = spawn } = {}) {
  const [file, args] = signOutCommand()
  if (dryRun) return Promise.resolve({ ok: true, dryRun: true, command: [file, ...args] })
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true })
    } catch (err) {
      return resolve({ ok: false, error: err.message })
    }
    child.once('error', (err) => resolve({ ok: false, error: err.message }))
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true })
    })
  })
}
