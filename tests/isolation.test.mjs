/**
 * The promises this fork makes about the machine it runs on.
 *
 * Every test here guards something that would be invisible if it regressed:
 * nothing reads the user's global Claude Code configuration, no secret is
 * tracked by git, and the launcher works on Windows. A code review catches
 * these once; a test catches them every time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

/** Every source file we ship, excluding dependencies and build output. */
function sources(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (
      ['node_modules', '.git', 'dist', 'public', '.jarvis', 'workspace'].includes(entry)
    ) {
      continue
    }
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.(mjs|js|ts|tsx|ps1|json)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Comments stripped, so a test about what the CODE does is not fooled by a
 * paragraph explaining what the code deliberately does not do. Rough, and
 * rough is fine: it only has to be right about string literals and calls.
 */
function code(path) {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^#.*$/gm, '')
}

test('nothing in the project reads the global Claude Code configuration', () => {
  // `.claude.json` is the user's global config: MCP servers, project history,
  // and in some setups API keys. Upstream reads it; this fork must not, in any
  // file, for any purpose. That isolation is the whole reason this fork exists
  // and it would regress invisibly.
  // Matched where the name is USED as a path — a read, a join, an existence
  // check. The banner text that explains the isolation mentions the file by
  // name on purpose, and must not count as a violation of it.
  const reads =
    /(?:readFileSync|readFile|existsSync|statSync|writeFileSync|openSync|join|resolve|homedir\(\))[^\n]*\.claude\.json/
  const offenders = sources()
    .filter((f) => !f.includes(`${'tests'}`))
    .filter((f) => reads.test(code(f)))
  assert.deepEqual(
    offenders.map((f) => f.slice(ROOT.length + 1)),
    [],
    'these files reference the global ~/.claude.json in code',
  )
})

test('the global Claude configuration is never written or modified', () => {
  const writes = sources().filter((f) => /writeFileSync\([^)]*claude/i.test(code(f)))
  assert.deepEqual(writes, [])
})

test('the bridge hands the agent only the project-local servers', () => {
  const server = code(join(ROOT, 'bridge/server.mjs'))
  assert.ok(server.includes('projectServers()'), 'servers come from the project config')
  // settingSources: [] is what stops the SDK loading filesystem settings —
  // including a global bypassPermissions default that would sit in front of
  // the tool gate and make it unreachable.
  assert.ok(/settingSources:\s*\[\]/.test(server))
})

test('secrets and machine-local files are ignored by git', () => {
  const ignored = read('.gitignore')
  for (const entry of ['.env', '.env.local', 'jarvis.mcp.json', '.jarvis/', 'workspace/']) {
    assert.ok(ignored.includes(entry), `${entry} must be git-ignored`)
  }
})

test('no secret file is actually tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const name of ['.env', '.env.local', 'jarvis.mcp.json']) {
    assert.ok(!tracked.includes(name), `${name} must not be tracked`)
  }
  // The example file is tracked on purpose, and must stay free of real values.
  assert.ok(tracked.includes('.env.example'))
  const example = read('.env.example')
  assert.ok(
    !/^\s*ELEVENLABS_API_KEY\s*=\s*\S/m.test(example),
    'the example file must not carry a key',
  )
})

test('the repository contains no nested git repository', () => {
  // The upstream import must not have brought its own .git along.
  const nested = sources().filter((f) => f.includes(`${'.git'}${'/'}`))
  assert.deepEqual(nested, [])
})

test('npm scripts run on Windows PowerShell', () => {
  const pkg = JSON.parse(read('package.json'))
  for (const [name, command] of Object.entries(pkg.scripts)) {
    // `VAR=1 node x.js` is a POSIX-ism: on PowerShell it is a parse error, and
    // this is the primary target platform.
    assert.ok(
      !/^[A-Z_]+=\S+\s/.test(command),
      `the "${name}" script uses POSIX inline environment syntax: ${command}`,
    )
  }
  assert.equal(pkg.scripts['bridge:writes'], 'node bridge/server.mjs --writes')
})

test('the launcher starts its children with the Node it is running under', () => {
  // On a machine with several Node versions — normal — spawning bare `node`
  // finds whichever one a previous project pinned, and the bridge then dies
  // inside a dependency.
  const start = read('scripts/start.mjs')
  assert.ok(start.includes('process.execPath'))
  assert.ok(!/spawn\(\s*'node'/.test(start), 'do not spawn a bare `node`')
})

test('the Windows scripts the documentation promises all exist', () => {
  for (const script of [
    'scripts/jarvis.ps1',
    'scripts/stop.ps1',
    'scripts/restart.ps1',
    'scripts/open-ui.ps1',
    'scripts/install-startup.ps1',
    'scripts/uninstall-startup.ps1',
    'scripts/node.ps1',
    'scripts/diagnostics.mjs',
  ]) {
    assert.doesNotThrow(() => read(script), `${script} is missing`)
  }
})

test('the startup task is installed and removed by exact name', () => {
  const install = read('scripts/install-startup.ps1')
  const uninstall = read('scripts/uninstall-startup.ps1')
  assert.ok(install.includes("'JarvisAssistant'"))
  assert.ok(uninstall.includes("'JarvisAssistant'"))
  // Per-user, no elevation: the previous implementation's rule, kept.
  assert.ok(install.includes('-RunLevel Limited'))
  assert.ok(install.includes('-MultipleInstances IgnoreNew'))
  // A wildcard here is how an unrelated scheduled task gets deleted.
  assert.ok(!/Unregister-ScheduledTask[^\n]*\*/.test(uninstall))
})

test('stop.ps1 stops this instance, not every node on the machine', () => {
  const stop = read('scripts/stop.ps1')
  assert.ok(stop.includes('jarvis.pid'))
  assert.ok(!/Get-Process\s+node/i.test(stop), 'never target every node process')
})

test('the write gate is off in the committed configuration', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.scripts.bridge, 'node bridge/server.mjs')
  assert.equal(pkg.scripts.start, 'node scripts/start.mjs')
  const launch = JSON.parse(read('.claude/launch.json'))
  assert.deepEqual(launch.configurations[0].runtimeArgs, ['start'])
})
