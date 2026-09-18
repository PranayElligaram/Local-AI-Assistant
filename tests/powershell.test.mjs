/**
 * Do the PowerShell scripts actually parse?
 *
 * They are the supported way to start, stop and restart JARVIS on Windows, and
 * nothing else in this suite executes them — so a syntax error sits there
 * undetected until the moment someone needs to stop a running assistant. That
 * is not the moment to find out. (It happened: an innocent-looking
 * "process(es)" in a stop message was a parse error, and `stop.ps1` could not
 * run at all.)
 *
 * The parser is asked for a verdict, nothing is executed.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(ROOT, 'scripts')
const windows = process.platform === 'win32'

const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.ps1'))

test('there are PowerShell scripts to check', () => {
  assert.ok(files.length >= 6, `found only ${files.length}`)
})

test('the PowerShell scripts are pure ASCII', () => {
  // Not pedantry. Windows PowerShell 5.1 reads a BOM-less file as ANSI, so a
  // UTF-8 em dash arrives as three Windows-1252 characters — one of which is a
  // smart quote, which OPENS A STRING. Measured here: one em dash in a comment
  // made stop.ps1 fail to parse, with the error reported thirty lines away
  // from the actual character.
  for (const file of files) {
    const text = readFileSync(join(SCRIPTS, file), 'utf8')
    const offenders = [...new Set([...text].filter((c) => c.charCodeAt(0) > 127))]
    assert.deepEqual(
      offenders,
      [],
      `${file} contains non-ASCII characters: ${offenders.map((c) => JSON.stringify(c)).join(', ')}`,
    )
  }
})

for (const file of files) {
  test(`${file} parses`, { skip: windows ? false : 'Windows only' }, () => {
    const path = join(SCRIPTS, file)
    // Tokenise and parse without running a line of it.
    const check = `
      $ErrorActionPreference = 'Stop'
      $errors = $null
      $null = [System.Management.Automation.Language.Parser]::ParseFile(
        '${path.replace(/'/g, "''")}', [ref]$null, [ref]$errors)
      if ($errors -and $errors.Count -gt 0) {
        $errors | ForEach-Object { Write-Output $_.Message }
        exit 1
      }
      exit 0`
    const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', check], {
      encoding: 'utf8',
      timeout: 60000,
    })
    assert.equal(res.status, 0, `${file} does not parse:\n${res.stdout}${res.stderr}`)
  })
}
