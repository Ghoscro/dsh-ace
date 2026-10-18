import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mergeLedger, digestRows, ingestLedger, sessionFile } from '../ledger.js'

const conv = texts => texts.map((text, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text }))
const rows = list => conv(list)
const all = conv(['a', 'b', 'c', 'd', 'e', 'f'])
const texts = list => list.map(row => row.text)

test('the ledger appends only what the browser window has not covered yet', () => {
  const existing = all.slice(0, 3)
  const merged = mergeLedger(existing, all.slice(0, 4))
  assert.equal(merged.added, 1)
  assert.deepEqual(texts(merged.rows), ['a', 'b', 'c', 'd'])
  assert.equal(merged.gap, false)
})

test('a window that already starts mid-history does not duplicate rows', () => {
  const existing = all.slice(0, 4)
  const merged = mergeLedger(existing, all.slice(1, 4))
  assert.equal(merged.added, 0)
  assert.deepEqual(texts(merged.rows), ['a', 'b', 'c', 'd'])
})

test('a window anchored on the ledger tail appends the new turns', () => {
  const existing = all.slice(0, 4)
  const merged = mergeLedger(existing, all.slice(0, 6))
  assert.equal(merged.added, 2)
  assert.deepEqual(texts(merged.rows), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(merged.gap, false)
})

test('a genuine gap is appended and flagged', () => {
  const existing = all.slice(0, 2)
  const incoming = [...conv(['x', 'y']), all[1], ...conv(['z'])]
  const merged = mergeLedger(existing, incoming)
  assert.equal(merged.gap, true)
  assert.equal(merged.rows.at(-1).text, 'z')
  assert.equal(merged.rows.filter(row => row.text === 'y').length, 1)
})

test('the digest is extractive and bounded', () => {
  const digest = digestRows(rows(Array.from({ length: 40 }, (_, index) => `第 ${index} 条很长的内容`.repeat(6))), 300)
  assert.ok(digest.length <= 320, `digest should stay bounded, got ${digest.length}`)
  assert.match(digest, /archived 40 earlier turns/)
  assert.match(digest, /第 0 条/)
})

test('ingesting writes one file per session and archives past the limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-ledger-'))
  const transcript = rows(Array.from({ length: 30 }, (_, index) => `turn ${index}`))
  const first = ingestLedger({ dir, sessionId: 'session/one', transcript, maxEntries: 20, keep: 8, autoArchive: false })
  assert.equal(first.rows.length, 30)
  assert.equal(sessionFile('session/one'), 'session_one')

  const archived = ingestLedger({ dir, sessionId: 'session/one', transcript, maxEntries: 20, keep: 8, autoArchive: true })
  assert.ok(archived.archived > 0)
  assert.equal(archived.rows[0].role, 'system')
  assert.match(archived.rows[0].text, /archived \d+ earlier turns/)
  assert.equal(archived.rows.length, 9)

  const files = readdirSync(join(dir, 'ledger'))
  assert.ok(files.some(name => name === 'session_one.jsonl'))
  assert.ok(files.some(name => name.startsWith('session_one-archive-')))
  const live = readFileSync(join(dir, 'ledger', 'session_one.jsonl'), 'utf8').trim().split('\n')
  assert.equal(live.length, 9)
})

test('ingesting the same transcript twice does not grow the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-ledger2-'))
  const transcript = rows(['a', 'b', 'c', 'd'])
  ingestLedger({ dir, sessionId: 's', transcript, maxEntries: 100, keep: 50 })
  const again = ingestLedger({ dir, sessionId: 's', transcript, maxEntries: 100, keep: 50 })
  assert.equal(again.rows.length, 4)
  assert.equal(again.archived, 0)
})

test('an anonymous session or a missing home is passed through untouched', () => {
  const transcript = rows(['a', 'b'])
  assert.deepEqual(ingestLedger({ dir: '', sessionId: 's', transcript }).rows, transcript)
  assert.deepEqual(ingestLedger({ dir: '/tmp/x', sessionId: 'anonymous', transcript }).rows, transcript)
})
