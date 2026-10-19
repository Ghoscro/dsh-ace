import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

/** Run npm pack without depending on a .cmd shim: npm exposes its own CLI path. */
function pack(destination) {
  const args = ['pack', '--pack-destination', destination, '--json']
  const cli = process.env.npm_execpath
  if (cli && cli.endsWith('.js')) {
    return execFileSync(process.execPath, [cli, ...args], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  })
}

/**
 * Pack exactly what a user would install, unpack it somewhere empty, and import
 * the host half from there. This is the check that would have caught a sibling
 * module missing from the `files` list (or from a pnpm-materialized copy):
 * `node_modules` and the working tree are not on the resolution path.
 */
test('the packed tarball imports on its own, with every relative import inside it', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-pack-'))
  try {
    const packed = JSON.parse(pack(dir))
    const filename = packed?.[0]?.filename
    assert.ok(filename, 'npm pack should report the tarball name')
    const tarball = join(dir, filename)
    assert.ok(existsSync(tarball), `expected ${tarball}`)

    execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'ignore' })
    const packageDir = join(dir, 'package')
    const hostFile = join(packageDir, 'index.js')
    assert.ok(existsSync(hostFile), 'the tarball should contain index.js')

    const source = readFileSync(hostFile, 'utf8')
    const relativeImports = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g)]
      .map(match => match[1])
    assert.ok(relativeImports.length === 0, `the host half must stay a single file, found: ${relativeImports.join(', ')}`)

    const module = await import(pathToFileURL(hostFile).href)
    assert.equal(typeof module.apply, 'function')
    assert.equal(typeof module.buildExpertPrompt, 'function')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
