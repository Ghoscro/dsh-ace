// Measure real prompt/output token usage for the live prediction route.
// Usage comes from the provider's `usage` stream chunk, not a character estimate.
// The transcripts are synthetic; no session content is sent.

const base = process.env.COMPOSER_PREDICT_BASE ?? 'http://127.0.0.1:14787'
const runs = Number(process.env.TOKEN_TIER_RUNS ?? 3)
const cwd = process.cwd()
const filler = '这是一个用于测量上下文长度的合成段落，不包含真实会话内容。'.repeat(24)

function transcript(long) {
  const short = [
    { role: 'user', text: '这个测试一直偶发失败，帮我定位一下。' },
    { role: 'assistant', text: '我怀疑是计时器和异步清理的竞态，已把测试改成 fake timers。要我先只跑这个用例，还是直接跑全量？' },
  ]
  if (!long) return short
  return [
    { role: 'user', text: filler },
    { role: 'assistant', text: filler },
    { role: 'user', text: filler },
    { role: 'assistant', text: filler },
    ...short,
  ]
}

const tiers = [
  { name: 'fast-short', mode: 'fast', long: false },
  { name: 'fast-long', mode: 'fast', long: true },
  { name: 'expert-short', mode: 'expert', long: false },
  { name: 'expert-long', mode: 'expert', long: true },
]

async function one(tier) {
  const started = Date.now()
  const response = await fetch(`${base}/composer-predict/predict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: `token-tier-${tier.name}`,
      cwd,
      locale: 'zh-CN',
      count: 4,
      mode: tier.mode,
      transcript: transcript(tier.long),
    }),
  })
  const text = await response.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { ok: false, error: { message: text.slice(0, 200) } } }
  const value = payload.value ?? {}
  return {
    status: response.status,
    mode: value.mode ?? tier.mode,
    candidates: Array.isArray(value.candidates) ? value.candidates.length : 0,
    inputTokens: value.usage?.inputTokens ?? null,
    outputTokens: value.usage?.outputTokens ?? null,
    totalTokens: value.usage?.totalTokens ?? null,
    reasoningTokens: value.usage?.reasoningTokens ?? null,
    cacheReadTokens: value.usage?.cacheReadTokens ?? null,
    cacheWriteTokens: value.usage?.cacheWriteTokens ?? null,
    latencyMs: Date.now() - started,
    warning: value.warning ?? '',
    error: payload.error?.message ?? '',
  }
}

function median(values) {
  const sorted = values.filter(value => typeof value === 'number').sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.floor(sorted.length / 2)]
}

const rows = []
for (const tier of tiers) {
  const samples = []
  for (let index = 0; index < runs; index += 1) {
    samples.push(await one(tier))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  rows.push({
    tier: tier.name,
    samples,
    median: {
      inputTokens: median(samples.map(sample => sample.inputTokens)),
      outputTokens: median(samples.map(sample => sample.outputTokens)),
      totalTokens: median(samples.map(sample => sample.totalTokens)),
      latencyMs: median(samples.map(sample => sample.latencyMs)),
    },
  })
}

console.log(JSON.stringify({ base, runs, rows }, null, 2))

const lines = [
  '# Token tiers',
  '',
  `Measured against ${base} with ${runs} run(s) per tier. Tokens come from the provider usage chunk; transcripts are synthetic.`,
  '',
  '| tier | median input | median output | median total | median latency | candidates | warning |',
  '|---|---:|---:|---:|---:|---:|---|',
]
for (const row of rows) {
  const m = row.median
  const warning = row.samples.map(sample => sample.warning).filter(Boolean)[0] ?? ''
  const candidates = row.samples.map(sample => sample.candidates).join('/')
  lines.push(`| ${row.tier} | ${m.inputTokens ?? 'n/a'} | ${m.outputTokens ?? 'n/a'} | ${m.totalTokens ?? 'n/a'} | ${m.latencyMs ?? 'n/a'} ms | ${candidates} | ${warning} |`)
}
lines.push('', 'No usage value means the provider stream did not emit a usage chunk; do not substitute a character estimate in the published table.')
console.log(lines.join('\n'))
