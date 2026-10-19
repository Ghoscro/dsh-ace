/**
 * Build a long-lived profile of the user from their real messages across DSH
 * sessions: how they write, what they keep asking for, which constraints they
 * repeat. ACE reads it once per prediction so the card is written from that
 * person's position instead of from the last ten lines alone.
 *
 *   node tools/user-profile.ts            # print the profile
 *   node tools/user-profile.ts --write    # also write $DSH_HOME/diagnostics/ace-profile.json
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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
const STOP_PHRASES = new Set(['这个', '那个', '就是', '什么', '怎么', '可以', '不是', '一个', '我们', '你们', '他们', '因为', '所以', '然后', '还是', '已经', '现在', '自己', '没有', '这样', '那样', '一下'])
const CONSTRAINTS = /(^|[，。；\s])(?:别(?!的|人|处|再)|不要|必须|先[^。！？\n]{0,14}再|只要|记得|不准|不能|只能)/
const TOPIC_STOP = new Set(['with', 'https', 'http', 'this', 'that', 'from', 'have', 'will', 'your', 'the', 'and', 'for', 'are', 'not', 'you', 'can', 'but'])
const PUNCTUATION = /[，。！？；：、]|——|\.\.\./g

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
      // False magic hit inside payload bytes; skip that frame.
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

function humanMessages(root: string, limitFiles = 400): string[] {
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
      } else if (entry.isFile() && /session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name)) {
        try {
          files.push({ path, mtime: statSync(path).mtimeMs })
        } catch {
          // Raced with cleanup; skip.
        }
      }
    }
  }
  walk(root, 0)
  files.sort((left, right) => right.mtime - left.mtime)
  const out: string[] = []
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
      // source.kind === 'user' is the only marker for text a human typed;
      // runtime-context and reminders are logged as user messages too.
      if (object.data?.source?.kind !== 'user') continue
      const message = textOf(object.data?.content).trim()
      if (message.length < 8) continue
      if (SYSTEM_PREFIXES.some(prefix => message.startsWith(prefix))) continue
      if (message.startsWith('[Image ')) continue
      out.push(message)
    }
  }
  return out
}

function topPhrases(messages: string[], limit = 12): string[] {
  // Openers beat arbitrary n-grams: they capture how someone starts a thought
  // ("嗯", "其实", "别"), which is what the card has to sound like.
  const counts = new Map<string, number>()
  for (const message of messages) {
    const clean = message.replace(/[^\u4e00-\u9fa5]/g, ' ').trim()
    const head = (clean.split(/\s+/)[0] ?? '').slice(0, 3)
    if (head.length < 2 || STOP_PHRASES.has(head)) continue
    counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([phrase]) => phrase)
}

function topics(messages: string[], limit = 10): string[] {
  const counts = new Map<string, number>()
  for (const message of messages) {
    for (const token of message.match(/[A-Za-z][A-Za-z0-9_./-]{3,}/g) ?? []) {
      const key = token.toLowerCase()
      if (TOPIC_STOP.has(key)) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token)
}

function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const value = lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  return Math.round(value)
}

function build(messages: string[]) {
  const lengths = messages.map(message => message.length).sort((a, b) => a - b)
  const punctuation = (messages.join('').match(PUNCTUATION) ?? []).length
  const constraints = messages
    .filter(message => CONSTRAINTS.test(message) && message.length <= 120)
    .slice(-4)
  const short = messages.filter(message => message.length <= 24).length / messages.length
  return {
    updatedAt: new Date().toISOString(),
    messages: messages.length,
    corpusHash: createHash('sha1').update(messages.join('\u0000')).digest('hex').slice(0, 12),
    avgChars: Math.round(lengths.reduce((sum, value) => sum + value, 0) / lengths.length),
    p90Chars: quantile(lengths, 0.9),
    shortRatio: Number(short.toFixed(2)),
    punctuationPer100: Number(((punctuation / Math.max(1, lengths.reduce((sum, v) => sum + v, 0))) * 100).toFixed(1)),
    phrases: topPhrases(messages),
    topics: topics(messages),
    constraints,
  }
}

function summaryOf(profile: ReturnType<typeof build>): string {
  const lines = [
    `- Writes ${profile.avgChars} chars on average (p90 ${profile.p90Chars}); ${Math.round(profile.shortRatio * 100)}% of messages are 24 chars or shorter.`,
    `- Punctuation density ${profile.punctuationPer100} per 100 chars.`,
    profile.phrases.length ? `- Recurring wording: ${profile.phrases.join(' / ')}.` : '',
    profile.topics.length ? `- Keeps working on: ${profile.topics.join(', ')}.` : '',
    profile.constraints.length ? `- Constraints stated before: ${profile.constraints.map(text => text.replace(/\s+/g, ' ').slice(0, 80)).join(' || ')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

const root = process.argv.includes('--corpus')
  ? process.argv[process.argv.indexOf('--corpus') + 1]
  : join(homedir(), '.dsh', 'sessions')
const messages = humanMessages(root)
if (messages.length < 50) {
  console.error(`only ${messages.length} human messages under ${root}`)
  process.exit(1)
}
const profile = build(messages)
const summary = summaryOf(profile)
console.log(JSON.stringify(profile, null, 2))
console.log('\n[summary]\n' + summary)

if (process.argv.includes('--write')) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const directory = join(home, 'diagnostics')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'ace-profile.json')
  writeFileSync(path, JSON.stringify({ ...profile, summary }, null, 2) + '\n', 'utf8')
  console.log(`\nwrote ${path}`)
}
