/**
 * The promises this fork makes about the machine it runs on.
 *
 * Every test here guards something that would be invisible if it regressed:
 * JARVIS has no Claude/Anthropic runtime at all, nothing reads the user's
 * global Claude Code configuration, no secret is tracked by git, and the
 * launcher works on Windows. A code review catches
 * these once; a test catches them every time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

test('there is no Claude or Anthropic runtime dependency', () => {
  const pkg = JSON.parse(read('package.json'))
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  assert.deepEqual(deps.filter((d) => /anthropic|claude/i.test(d)), [])
  const lock = read('package-lock.json')
  assert.ok(!/node_modules\/@anthropic-ai\//.test(lock), 'the lockfile still carries an Anthropic package')
  const runtime = sources().filter((f) => /^(bridge|src|scripts)[\\/]/.test(f.slice(ROOT.length + 1)))
  assert.ok(runtime.length > 20, 'the runtime sources were found')
  const offenders = runtime.filter((f) => {
    const c = code(f)
    return (
      /from\s+['"]@anthropic-ai|import\(\s*['"]@anthropic-ai|claude-agent-sdk/.test(c) ||
      /spawn(?:Sync)?\(\s*['"]claude/.test(c) ||
      /ANTHROPIC_API_KEY|api\.anthropic\.com/.test(c)
    )
  })
  assert.deepEqual(offenders.map((f) => f.slice(ROOT.length + 1)), [])
})

test('the bridge starts with no Claude login, key, config or home directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'jarvis-nohome-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC|CLAUDE)/i.test(k)))
  const port = 8795
  const child = spawn(process.execPath, ['bridge/server.mjs'], {
    cwd: ROOT,
    env: {
      ...env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData'),
      JARVIS_BRIDGE_PORT: String(port),
      JARVIS_RUN_DIR: join(home, 'run'),
      JARVIS_OLLAMA_URL: 'http://127.0.0.1:9',
      JARVIS_WARM_MODEL: '0',
      JARVIS_UNLOAD_ON_EXIT: '0',
      JARVIS_APPS_FILE: join(home, 'apps.json'),
      ELEVENLABS_API_KEY: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d))
  child.stderr.on('data', (d) => (log += d))
  try {
    let ok = false
    for (let i = 0; i < 100 && !ok; i++) {
      try {
        ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    assert.ok(ok, log)
    assert.doesNotMatch(log, /claude login|anthropic|api key required/i)
  } finally {
    child.stdin.end()
    await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)))
  }
})

test('secrets and machine-local files are ignored by git', () => {
  const ignored = read('.gitignore')
  for (const entry of ['.env', '.env.local', 'jarvis.apps.json', 'jarvis.mcp.json', '.jarvis/']) {
    assert.ok(ignored.includes(entry), `${entry} must be git-ignored`)
  }
})

test('no secret file is actually tracked', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (const name of ['.env', '.env.local', 'jarvis.apps.json', 'jarvis.mcp.json']) {
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
    'scripts/apps.mjs',
    'scripts/e2e.mjs',
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
