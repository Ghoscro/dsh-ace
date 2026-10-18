#!/usr/bin/env node
/**
 * Offline threshold sweep over captured predictions.
 *
 * Reads diagnostics/dsh-ace-samples.jsonl (written by the plugin when
 * `captureSamples` is on), re-scores every stored selection at several
 * thresholds and reports how many cards the current threshold is leaving on
 * the table. No model calls: everything is recomputed from the stored moves.
 *
 * Usage: node scripts/threshold-sweep.mjs [samples.jsonl] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { selectBestMove, sweepThresholds } from '../index.js'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json')
const pathArg = args.find(arg => !arg.startsWith('--'))
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const file = pathArg ?? join(home, 'diagnostics', 'dsh-ace-samples.jsonl')

if (!existsSync(file)) {
  console.error(`no samples yet: ${file}`)
  console.error('turn captureSamples on (default) and let a few turns run first')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
const samples = []
for (const line of lines) {
  try { samples.push(JSON.parse(line)) } catch { /* skip a torn line */ }
}

const thresholds = [0, 2, 3, 4, 5, 6, 7, 8, 10]
const shownAtCapture = samples.filter(row => row.shown).length
const report = sweepThresholds(samples, thresholds)

const dropped = samples.filter(row => !row.shown && Array.isArray(row.moves) && row.moves.length > 0)
const examples = dropped.slice(-8).map(row => {
  const best = selectBestMove({ moves: row.moves, bestIndex: Number.isInteger(row.bestIndex) ? row.bestIndex : null, comparison: '' }, 0)
  return {
    at: row.at,
    style: row.style,
    capturedThreshold: row.threshold,
    score: best?.score ?? null,
    text: (best?.text ?? '').slice(0, 160),
    why: (best?.why ?? '').slice(0, 120),
  }
})

if (jsonOut) {
  console.log(JSON.stringify({ file, samples: samples.length, shownAtCapture, report, examples }, null, 2))
} else {
  console.log(`file: ${file}`)
  console.log(`samples: ${samples.length}  cards shown at capture: ${shownAtCapture}  no-card turns: ${dropped.length}\n`)
  console.log('threshold  cards  vs now  silent')
  for (const row of report) {
    console.log(`${String(row.threshold).padStart(9)}  ${String(row.cards).padStart(5)}  ${String(row.gained >= 0 ? '+' + row.gained : row.gained).padStart(6)}  ${String(row.silent).padStart(6)}`)
  }
  if (examples.length) {
    console.log('\ndropped moves worth a look (score at threshold 0):')
    for (const item of examples) {
      console.log(`- [${item.style}] score=${item.score} at=${item.at}`)
      console.log(`  ${item.text}`)
      if (item.why) console.log(`  why: ${item.why}`)
    }
  }
}
