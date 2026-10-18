/**
 * Cognitive ledger: one append-only record per session of what the predictor
 * actually saw. The prompt is rebuilt from this ledger instead of from whatever
 * window the browser happens to send, so the prefix only grows (better provider
 * prefix-cache hits) until an archive event rewrites the head.
 *
 * Files live under `<DSH_HOME>/diagnostics/ledger/`:
 *   <session>.jsonl          live entries
 *   <session>-archive-<ts>.jsonl  archived entries, never read back
 *
 * Everything here is best-effort: a broken ledger must never fail a prediction.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Strip anything that could escape the ledger directory. */
export function sessionFile(sessionId) {
  const safe = String(sessionId ?? 'anonymous').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'anonymous'
  return safe
}

const rowKey = row => `${row?.role ?? ''}\u0000${String(row?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}`

/**
 * Append only the rows the ledger does not already end with.
 * @param {object[]} existing - ledger rows.
 * @param {object[]} incoming - transcript from the browser.
 * @returns {{rows: object[], gap: boolean, added: number}} merged rows, gap flag, added count.
 */
export function mergeLedger(existing, incoming) {
  const rows = Array.isArray(existing) ? existing : []
  const next = Array.isArray(incoming) ? incoming : []
  if (next.length === 0) return { rows, gap: false, added: 0 }

  let overlap = 0
  for (let size = Math.min(rows.length, next.length); size > 0; size -= 1) {
    let match = true
    for (let index = 0; index < size; index += 1) {
      if (rowKey(rows[rows.length - size + index]) !== rowKey(next[index])) { match = false; break }
    }
    if (match) { overlap = size; break }
  }

  if (overlap === 0 && rows.length > 0) {
    // The browser normally sends a window that ends where our ledger ends, even
    // after an archive replaced the head. Anchor on the last ledger row instead.
    const lastKey = rowKey(rows[rows.length - 1])
    for (let index = next.length - 1; index >= 0; index -= 1) {
      if (rowKey(next[index]) === lastKey) {
        const known = new Set(rows.map(rowKey))
        const freshPrefix = next.slice(0, index).filter(row => !known.has(rowKey(row)))
        const gap = freshPrefix.length > 0
        const added = freshPrefix.concat(next.slice(index + 1))
        return { rows: rows.concat(added), gap, added: added.length }
      }
    }
    // Nothing anchors: append what is new and mark the gap so a reader can see
    // the ledger is not contiguous.
    const recent = new Set(rows.slice(-30).map(rowKey))
    const fresh = next.filter(row => !recent.has(rowKey(row)))
    return { rows: rows.concat(fresh), gap: true, added: fresh.length }
  }
  const added = next.slice(overlap)
  return { rows: rows.concat(added), gap: false, added: added.length }
}

/**
 * Build a deterministic digest for archived rows: no model call, no invention.
 * @param {object[]} rows - archived rows.
 * @param {number} [budget] - maximum digest characters.
 * @returns {string} digest text.
 */
export function digestRows(rows, budget = 1200) {
  const list = Array.isArray(rows) ? rows : []
  const parts = []
  let used = 0
  for (const row of list) {
    const line = `${row?.role ?? '?'}: ${String(row?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`
    if (used + line.length + 1 > budget) break
    parts.push(line)
    used += line.length + 1
  }
  return `[archived ${list.length} earlier turns]\n${parts.join('\n')}`
}

/**
 * Ingest a transcript into the session ledger, archiving old entries when the
 * ledger grows past the limit.
 * @param {{ dir: string, sessionId: string, transcript: object[], maxEntries?: number, keep?: number, autoArchive?: boolean }} input - ingestion input.
 * @returns {{ rows: object[], archived: number, gap: boolean }} ledger rows to prompt with.
 */
export function ingestLedger({ dir, sessionId, transcript, maxEntries = 160, keep = 60, autoArchive = true }) {
  const rows = Array.isArray(transcript) ? transcript : []
  if (!dir || !sessionId || sessionId === 'anonymous') return { rows, archived: 0, gap: false }
  try {
    const directory = join(dir, 'ledger')
    mkdirSync(directory, { recursive: true })
    const name = sessionFile(sessionId)
    const file = join(directory, `${name}.jsonl`)
    const existing = existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line) } catch { return null }
      }).filter(Boolean)
      : []
    const merged = mergeLedger(existing, rows)
    let current = merged.rows
    let archived = 0
    if (autoArchive && current.length > maxEntries) {
      const cut = current.length - keep
      const removed = current.slice(0, cut)
      writeFileSync(join(directory, `${name}-archive-${Date.now()}.jsonl`), removed.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
      current = [{ role: 'system', text: digestRows(removed), at: new Date().toISOString() }, ...current.slice(cut)]
      archived = removed.length
    }
    if (merged.added > 0 || archived > 0) {
      writeFileSync(file, current.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    }
    return { rows: current.map(row => ({ role: row.role, text: row.text })), archived, gap: merged.gap }
  } catch {
    return { rows, archived: 0, gap: false }
  }
}
