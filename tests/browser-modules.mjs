import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let sequence = 0
export async function loadBrowserModule(file, stubs) {
  let code = ts.transpileModule(readFileSync(resolve(ROOT, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  code = code.replace(/from ['"]([^'"]+)['"]/g, (_, name) => {
    const url = name in stubs
      ? 'data:text/javascript;base64,' + Buffer.from(stubs[name]).toString('base64')
      : pathToFileURL(resolve(ROOT, dirname(file), name + '.ts')).href
    return 'from ' + JSON.stringify(url)
  })
  return import('data:text/javascript;base64,' + Buffer.from(code + '\n// ' + sequence++).toString('base64'))
}
