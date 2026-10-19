import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sourceVersion = () => readJson(join(repoRoot, 'package.json')).version

test('the client build version literal matches package.json', () => {
  // The literal is what `<html data-ace-version>` reports at runtime; if it
  // drifts, the DOM lies about which build is loaded.
  const source = readFileSync(join(repoRoot, 'client.js'), 'utf8')
  const match = source.match(/const ACE_VERSION = '([^']+)'/)
  assert.ok(match, 'client.js must declare ACE_VERSION')
  assert.equal(match[1], sourceVersion())
})

test('the desktop profile installs the version it claims', t => {
  // Three independent sources must agree: the profile dependency spec, the
  // materialized package, and the lockfile resolution. A hand-installed build
  // (or a stale lockfile) fails here instead of being discovered in the UI.
  const profile = join(homedir(), '.dsh', 'profiles', 'desktop')
  const manifest = join(profile, 'package.json')
  const installed = join(profile, 'node_modules', '@ghoscro', 'dsh-ace', 'package.json')
  const lock = join(profile, 'pnpm-lock.yaml')
  if (!existsSync(manifest) || !existsSync(installed) || !existsSync(lock)) {
    t.skip('no desktop profile on this machine')
    return
  }

  const spec = readJson(manifest).dependencies?.['@ghoscro/dsh-ace'] ?? ''
  const specVersion = spec.match(/(\d+\.\d+\.\d+)\.tgz/)?.[1] ?? ''
  const installedVersion = readJson(installed).version ?? ''
  const lockVersions = [...new Set(
    [...readFileSync(lock, 'utf8').matchAll(/ghoscro-dsh-ace-(\d+\.\d+\.\d+)\.tgz/g)].map(match => match[1]),
  )]

  assert.equal(lockVersions.length, 1, `lockfile must resolve exactly one ACE version, got ${lockVersions.join(', ') || '(none)'}`)
  assert.equal(specVersion, installedVersion, `profile spec ${specVersion} != installed ${installedVersion}`)
  assert.equal(lockVersions[0], installedVersion, `lock ${lockVersions[0]} != installed ${installedVersion}`)
  assert.equal(installedVersion, sourceVersion(), `installed ${installedVersion} != source ${sourceVersion()}`)
})
