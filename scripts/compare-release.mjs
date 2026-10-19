#!/usr/bin/env node
/**
 * Compare a freshly packed tarball with the one attached to a release.
 *
 * The v0.2.0 release shipped a tarball that predated the tag's commits and
 * nobody noticed. This script makes that class of mistake loud: it extracts both
 * tarballs, compares the file list and every file hash, and exits non-zero on
 * any difference, including a different tarball name (a stale version).
 *
 * Usage: node scripts/compare-release.mjs <fresh-dir> <published-dir>
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const [freshDir, publishedDir] = process.argv.slice(2)

function findTarball(dir) {
  const files = readdirSync(dir).filter(name => name.endsWith('.tgz'))
  if (files.length !== 1) {
    console.error(`expected exactly one .tgz in ${dir}, found ${files.length}`)
    process.exit(2)
  }
  return files[0]
}

function extract(tarball) {
  const out = mkdtempSync(join(tmpdir(), 'ace-release-'))
  execFileSync('tar', ['-xzf', tarball, '-C', out], { stdio: 'ignore' })
  return join(out, 'package')
}

function walk(dir, base = dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, base, files)
    else files.push(relative(base, path))
  }
  return files.sort()
}

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')

const freshName = findTarball(freshDir)
const publishedName = findTarball(publishedDir)
const problems = []

if (freshName !== publishedName) {
  problems.push(`tarball name differs: fresh=${freshName} published=${publishedName}`)
}

const freshRoot = extract(join(freshDir, freshName))
const publishedRoot = extract(join(publishedDir, publishedName))
const freshFiles = walk(freshRoot)
const publishedFiles = walk(publishedRoot)

for (const file of freshFiles) {
  if (!publishedFiles.includes(file)) {
    problems.push(`missing from the release: ${file}`)
    continue
  }
  const a = hash(join(freshRoot, file))
  const b = hash(join(publishedRoot, file))
  if (a !== b) problems.push(`content differs: ${file} (fresh ${a.slice(0, 8)} vs release ${b.slice(0, 8)})`)
}
for (const file of publishedFiles) {
  if (!freshFiles.includes(file)) problems.push(`only in the release: ${file}`)
}

rmSync(freshRoot, { recursive: true, force: true })
rmSync(publishedRoot, { recursive: true, force: true })

if (problems.length > 0) {
  console.error(`release tarball does not match this commit (${problems.length} problem(s)):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`release tarball matches this commit: ${freshFiles.length} files, ${freshName}`)
