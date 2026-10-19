/**
 * Voice likeness: score how much a piece of text sounds like the user instead
 * of like a model. Human corpus = real user messages from the DSH session logs;
 * the score is a character 3-gram model's bits-per-character (lower = closer to
 * how this user writes). Run with:
 *
 *   node tools/voice-likeness.ts
 *   node tools/voice-likeness.ts --sample path/to/text.txt
 *   node tools/voice-likeness.ts --text "some sentence"
 *
 * The baseline is shown first; a score only means something relative to the
 * holdout distribution, never as an absolute threshold.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SYSTEM_PREFIXES = [
  '<system-reminder',
  'Time sampled while preparing',
  'Current runtime context.',
  'The approval policy changed',
  'background job ',
  'Additional instructions from:',
]
const MIN_HUMAN_CHARS = 8

function decodeFrames(buffer: Buffer): string {
  const starts: number[] = []
  let index = 0
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) !== -1) {
    starts.push(index)
    index += 4
  }
  if (starts.length === 0) return buffer.toString('utf8')
  let text = ''
  for (let frame = 0; frame < starts.length; frame += 1) {
    const end = frame + 1 < starts.length ? starts[frame + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(starts[frame], end)).toString('utf8')
    } catch {
      // A false magic hit inside payload data: skip that frame only.
    }
  }
  return text
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function isHumanMessage(text: string): boolean {
  if (text.length < MIN_HUMAN_CHARS) return false
  if (SYSTEM_PREFIXES.some(prefix => text.startsWith(prefix))) return false
  if (text.startsWith('[Image ')) return false
  return true
}
function collectMessages(root: string, limitFiles = 200): string[] {
  const files: Array<{ path: string; mtime: number }> = []
  const walk = (directory: string, depth: number): void => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (!/session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name)) continue
      try {
        files.push({ path, mtime: statSync(path).mtimeMs })
      } catch {
        // A session that vanished between readdir and stat is simply skipped.
      }
    }
  }
  walk(root, 0)
  files.sort((left, right) => right.mtime - left.mtime)
  const messages: string[] = []
  for (const file of files.slice(0, limitFiles)) {
    let raw: Buffer
    try {
      raw = readFileSync(file.path)
    } catch {
      continue
    }
    const text = file.path.endsWith('.zstd') ? decodeFrames(raw) : raw.toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      let object: any
      try {
        object = JSON.parse(line)
      } catch {
        continue
      }
      if (object?.type !== 'user/message') continue
      // Only messages the human actually typed carry source.kind === 'user';
      // runtime-context and system reminders are also logged as user messages.
      if (object.data?.source?.kind !== 'user') continue
      const message = textOf(object.data?.content)
      if (isHumanMessage(message)) messages.push(message)
    }
  }
  return messages
}

interface Model {
  alphabet: Set<string>
  vocab: number
  contextCounts: Map<string, number>
  gramCounts: Map<string, number>
}

function train(texts: string[], order = 3): Model {
  const alphabet = new Set<string>()
  const contextCounts = new Map<string, number>()
  const gramCounts = new Map<string, number>()
  for (const text of texts) {
    const padded = '\u0002\u0002' + text.replace(/\s+/g, ' ') + '\u0003'
    for (const char of padded) alphabet.add(char)
    for (let index = 2; index < padded.length; index += 1) {
      const context = padded.slice(index - order + 1, index)
      const gram = context + padded[index]
      contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1)
      gramCounts.set(gram, (gramCounts.get(gram) ?? 0) + 1)
    }
  }
  return { alphabet, vocab: alphabet.size + 1, contextCounts, gramCounts }
}

function bitsPerChar(model: Model, text: string, order = 3): number {
  const padded = '\u0002\u0002' + text.replace(/\s+/g, ' ') + '\u0003'
  const alpha = 0.1
  let bits = 0
  let count = 0
  for (let index = 2; index < padded.length; index += 1) {
    const context = padded.slice(index - order + 1, index)
    const gram = context + padded[index]
    const contextCount = model.contextCounts.get(context) ?? 0
    const gramCount = model.gramCounts.get(gram) ?? 0
    const probability = (gramCount + alpha) / (contextCount + alpha * model.vocab)
    bits += -Math.log2(probability)
    count += 1
  }
  return count === 0 ? Number.NaN : bits / count
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function percentileOf(sorted: number[], value: number): number {
  const below = sorted.filter(item => item <= value).length
  return below / sorted.length
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const root = readArg('--corpus') ?? join(homedir(), '.dsh', 'sessions')
const messages = collectMessages(root)
if (messages.length < 20) {
  console.error(`only ${messages.length} human messages found under ${root}`)
  process.exit(1)
}

// Hold out every fifth message so the baseline is measured on unseen text.
const training = messages.filter((_, index) => index % 5 !== 0)
const holdout = messages.filter((_, index) => index % 5 === 0)
const model = train(training)
const humanBits = holdout.map(text => bitsPerChar(model, text)).filter(Number.isFinite).sort((a, b) => a - b)

console.log(`corpus: ${messages.length} human messages from ${root}`)
console.log(`holdout: ${holdout.length} | bits/char p10=${quantile(humanBits, 0.1).toFixed(2)} p50=${quantile(humanBits, 0.5).toFixed(2)} p90=${quantile(humanBits, 0.9).toFixed(2)}`)

const samplePath = readArg('--sample')
const sampleText = samplePath ? readFileSync(samplePath, 'utf8') : readArg('--text')
if (sampleText) {
  const bits = bitsPerChar(model, sampleText)
  const percentile = percentileOf(humanBits, bits)
  console.log(`sample: ${bits.toFixed(2)} bits/char (perplexity ${Math.pow(2, bits).toFixed(1)})`)
  console.log(`percentile vs human holdout: ${(percentile * 100).toFixed(0)}% (0 = most human, 100 = least)`)
}
