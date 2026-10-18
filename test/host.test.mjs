import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import {
  buildExpertPrompt, buildPrompt, buildSituationPrompt, collectEvidence, generateExpertPrediction,
  generatePrediction, handleRequest, normalizeConfig, parseCandidates, parseExpertMoves,
  parseExpertSelection, parseSituation, resolveModel, sanitizeTranscript, selectBestMove,
} from '../index.js'

test('normalizeConfig bounds every numeric field and keeps the route local', () => {
  const cfg = normalizeConfig({
    count: 99, maxTokens: 1, temperature: 9, timeoutMs: 1, maxAttempts: 5,
    maxBodyBytes: 1, maxMessages: 99, maxChars: 1, routePrefix: '/x/',
  })
  assert.equal(cfg.count, 4)
  assert.equal(cfg.maxTokens, 80)
  assert.equal(cfg.temperature, 1.5)
  assert.equal(cfg.timeoutMs, 2000)
  assert.equal(cfg.maxAttempts, 2)
  assert.equal(cfg.maxBodyBytes, 4096)
  assert.equal(cfg.maxMessages, 24)
  assert.equal(cfg.maxChars, 2000)
  assert.equal(cfg.routePrefix, '/x')
  assert.equal(normalizeConfig({ enabled: false }).enabled, false)
})

test('sanitizeTranscript keeps recent human/assistant turns and drops junk', () => {
  const cfg = normalizeConfig({ maxMessages: 4, maxChars: 20_000 })
  const rows = sanitizeTranscript([
    null, 'x', { role: 'system', text: 'ignored' },
    { role: 'user', text: '  first  ' },
    { role: 'assistant', text: 'answer' },
    { role: 'user', text: 'x'.repeat(5000) },
    { role: 'user', text: '' },
    { role: 'assistant', text: 'last' },
  ], cfg)
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(rows[0].text, 'first')
  assert.equal(rows[2].text.length, 4000)
})

test('sanitizeTranscript truncates a long newest message to the character budget', () => {
  const cfg = normalizeConfig({ maxMessages: 4, maxChars: 2000 })
  const rows = sanitizeTranscript([
    { role: 'user', text: 'old' },
    { role: 'assistant', text: 'y'.repeat(3000) },
  ], cfg)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text.length, 1984)
})

test('buildPrompt carries style, thread, cwd, and N into both languages', () => {
  const transcript = [
    { role: 'user', text: '先别改' },
    { role: 'assistant', text: '已改为 fake timers' },
  ]
  const zhPrompt = buildPrompt({ transcript, cwd: 'E:\\proj', count: 4, locale: 'zh-CN' })
  assert.match(zhPrompt.system, /4 条候选/)
  assert.match(zhPrompt.user, /\[STYLE\]/)
  assert.match(zhPrompt.user, /- 先别改/)
  assert.match(zhPrompt.user, /cwd=E:\\proj/)
  const enPrompt = buildPrompt({ transcript, count: 2, locale: 'en-US' })
  assert.match(enPrompt.system, /2 candidates/)
  assert.match(enPrompt.user, /N=2, language=en/)
})

test('parseCandidates accepts JSON, fenced JSON, prose-wrapped arrays, and dedupes', () => {
  assert.deepEqual(parseCandidates('["a","b"]', 4), ['a', 'b'])
  assert.deepEqual(parseCandidates('```json\n["a","b"]\n```', 1), ['a'])
  assert.deepEqual(parseCandidates('here: ["x", "x", "y"] done', 4), ['x', 'y'])
  assert.deepEqual(parseCandidates('[{"text":"obj"}]', 4), ['obj'])
  assert.throws(() => parseCandidates('not json', 4))
  assert.throws(() => parseCandidates('[]', 4))
})

test('resolveModel prefers config, then the agent default, then the account fallback', () => {
  const configured = resolveModel({ get: () => undefined }, normalizeConfig({ provider: 'p', model: 'm' }))
  assert.deepEqual(configured, { provider: 'p', model: 'm' })
  const selected = resolveModel({
    get: () => ({ currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }),
  }, normalizeConfig())
  assert.deepEqual(selected, { provider: 'deepseek-account', model: 'deepseek-flash' })
  const fallback = resolveModel({ get: () => undefined }, normalizeConfig())
  assert.deepEqual(fallback, { provider: 'deepseek-account', model: 'deepseek-flash' })
})

function llmReturning(text, calls = { count: 0 }) {
  return {
    stream(options) {
      calls.count += 1
      assert.equal(typeof options.maxTokens, 'number')
      return (async function* stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function llmSequence(texts, calls = { count: 0 }) {
  return {
    stream() {
      const text = texts[Math.min(calls.count, texts.length - 1)]
      calls.count += 1
      return (async function* stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('generatePrediction parses a normal model response', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmReturning('["跑一遍测试","先看 diff"]', calls) }
  const result = await generatePrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '改好了吗' }, { role: 'assistant', text: '改好了' }],
    count: 4,
    locale: 'zh-CN',
  }, new AbortController().signal)
  assert.deepEqual(result.candidates, ['跑一遍测试', '先看 diff'])
  assert.equal(result.model, 'deepseek-account/deepseek-flash')
  assert.equal(calls.count, 1)
})

test('generatePrediction drops a candidate that repeats the last user message', async () => {
  const ctx = {
    get: () => undefined,
    llm: llmReturning('["帮我修测试","再跑一次"]'),
  }
  const result = await generatePrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '改好了' }],
    count: 2,
    locale: 'zh-CN',
  }, new AbortController().signal)
  assert.deepEqual(result.candidates, ['再跑一次'])
})

test('generatePrediction retries once after an unusable first answer', async () => {
  const calls = { count: 0 }
  const ctx = {
    get: () => undefined,
    llm: {
      stream() {
        calls.count += 1
        const text = calls.count === 1 ? 'not json' : '["再试一次"]'
        return (async function* stream() {
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  const result = await generatePrediction(ctx, normalizeConfig({ maxAttempts: 2 }), {
    transcript: [{ role: 'user', text: 'hi' }], count: 1, locale: 'en',
  }, new AbortController().signal)
  assert.deepEqual(result.candidates, ['再试一次'])
  assert.equal(calls.count, 2)
})

const SITUATION_JSON = JSON.stringify({
  goal: '让测试稳定', success: '全量测试连续通过', assistant_offer: '问要不要跑全量',
  constraints: ['先别改'], assumptions: ['fake timers 已足够'], risks: ['重试掩盖竞态'],
  unknowns: ['竞态是否真实存在'], obvious_move: '跑吧', blind_spot: '重试会掩盖问题',
})
const EXPERT_JSON = JSON.stringify({
  moves: [
    {
      text: '先只跑这个用例，确认竞态真的消失', why: '缩小验证范围，避免重试掩盖问题',
      evidence: 'x.test.ts', risk: '单测通过不代表全量稳定', action: 'verify',
      value: 6, novelty: 4, worth_extra_step: 6, over_obvious: '比直接跑全量更快定位',
    },
    {
      text: '先把重试去掉跑一次，确认不是重试掩盖了竞态', why: '直接验证根因，避免用重试把问题盖住',
      evidence: 'fake timers', risk: '可能暴露更多失败', action: 'advance',
      value: 9, novelty: 8, worth_extra_step: 9, over_obvious: '比顺手“继续”多验证了根因',
    },
    {
      text: '先别跑全量，只跑这个用例并保留日志', why: '先拿到失败证据再扩大范围',
      evidence: 'x.test.ts', risk: '', action: 'constrain',
      value: 5, novelty: 3, worth_extra_step: 4, over_obvious: '范围更可控',
    },
  ],
  best_index: 1,
  comparison: '第二条直接验证根因；第一条只是缩小范围，第三条只是收范围。',
})
const EXPERT_JSONL = [
  JSON.stringify({
    text: '先把重试去掉跑一次，确认不是重试掩盖了竞态', why: '直接验证根因，避免用重试把问题盖住',
    evidence: 'fake timers', risk: '可能暴露更多失败', action: 'advance',
    value: 9, novelty: 8, worth_extra_step: 9, over_obvious: '比顺手“继续”多验证了根因',
  }),
  JSON.stringify({
    text: '先只跑这个用例，确认竞态真的消失', why: '缩小验证范围，避免重试掩盖问题',
    evidence: 'x.test.ts', risk: '单测通过不代表全量稳定', action: 'verify',
    value: 6, novelty: 4, worth_extra_step: 6, over_obvious: '比直接跑全量更快定位',
  }),
  JSON.stringify({ best_index: 0, comparison: '第一条直接验证根因。' }),
].join('\n')

test('parseSituation and parseExpertSelection bound the expert JSON', () => {
  const situation = parseSituation(`\`\`\`json\n${SITUATION_JSON}\n\`\`\``)
  assert.equal(situation.goal, '让测试稳定')
  assert.deepEqual(situation.constraints, ['先别改'])
  const selection = parseExpertSelection(EXPERT_JSON, 5)
  assert.equal(selection.moves.length, 3)
  assert.equal(selection.bestIndex, 1)
  assert.equal(selection.moves[1].action, 'advance')
  const moves = parseExpertMoves(EXPERT_JSON, 5)
  assert.equal(moves.length, 3)
  assert.equal(moves[1].why.includes('直接验证根因'), true)
  assert.throws(() => parseSituation('{}'))
  assert.equal(parseExpertMoves('[{"text":"x"}]', 4).length, 0)
})

test('parseExpertSelection accepts JSONL and skips a truncated line', () => {
  const selection = parseExpertSelection(EXPERT_JSONL, 5)
  assert.equal(selection.moves.length, 2)
  assert.equal(selection.bestIndex, 0)
  const truncated = `${JSON.stringify({
    text: '先只跑这个用例', why: '缩小范围', action: 'verify', value: 6, novelty: 4, worth_extra_step: 6,
  })}\n{"text":"这行被截断","why":"`
  const salvaged = parseExpertSelection(truncated, 5)
  assert.equal(salvaged.moves.length, 1)
  assert.equal(salvaged.moves[0].text, '先只跑这个用例')
})

test('selectBestMove picks the higher-value move, not the first slot', () => {
  const selection = parseExpertSelection(EXPERT_JSON, 5)
  const best = selectBestMove(selection, 5)
  assert.equal(best.text, '先把重试去掉跑一次，确认不是重试掩盖了竞态')
  assert.equal(best.intent, 'advance')
  assert.equal(best.score > 5, true)
  const low = parseExpertSelection(JSON.stringify({
    moves: [{ text: '再检查一下', why: '更稳一点', action: 'verify', value: 3, novelty: 1, worth_extra_step: 2 }],
    best_index: 0,
    comparison: '',
  }), 5)
  assert.equal(selectBestMove(low, 5), null)
})

test('generateExpertPrediction uses deterministic situation and one model call', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([EXPERT_JSONL], calls) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '改好了，要跑全量吗？' }],
    count: 4,
    cwd: '',
    locale: 'zh-CN',
  }, new AbortController().signal)
  assert.equal(result.mode, 'expert')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].text, '先把重试去掉跑一次，确认不是重试掩盖了竞态')
  assert.equal(result.candidates[0].why.includes('直接验证根因'), true)
  assert.equal(calls.count, 1)
})

test('generatePrediction falls back to fast when expert output is unusable', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence(['not json', '["回退建议"]'], calls) }
  const result = await generatePrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '继续' }], count: 2, cwd: '', locale: 'zh-CN', mode: 'expert',
  }, new AbortController().signal)
  assert.equal(result.mode, 'fast-fallback')
  assert.deepEqual(result.candidates, ['回退建议'])
  assert.equal(calls.count, 2)
})

test('handleRequest returns expert cards and health advertises both modes', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([EXPERT_JSONL], calls) }
  const out = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), request({
    sessionId: 's1', count: 4, locale: 'zh-CN', cwd: '', mode: 'expert',
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
  }), out)
  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.value.mode, 'expert')
  assert.equal(payload.value.candidates.length, 1)
  assert.equal(payload.value.candidates[0].text, '先把重试去掉跑一次，确认不是重试掩盖了竞态')

  const healthReq = Readable.from([])
  healthReq.method = 'GET'
  healthReq.url = '/composer-predict/health'
  const health = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), healthReq, health)
  assert.deepEqual(JSON.parse(health.body).value.modes, ['fast', 'expert'])
})

test('collectEvidence returns a bounded pack or a safe sentinel', async () => {
  assert.equal(await collectEvidence(''), '(none)')
  assert.equal(await collectEvidence('E:/this/path/does/not/exist'), '(none)')
  const evidence = await collectEvidence(process.cwd())
  assert.equal(typeof evidence, 'string')
  assert.equal(evidence.length > 0, true)
})

function request(body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = 'POST'
  stream.url = '/composer-predict/predict'
  return stream
}

function response() {
  return {
    writableEnded: false,
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body; this.writableEnded = true },
  }
}

test('handleRequest returns the candidate envelope and the health route', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmReturning('["好，继续","先停一下"]', calls) }
  const cfg = normalizeConfig()
  const out = response()
  await handleRequest(ctx, cfg, new Map(), request({
    sessionId: 's1', count: 2, locale: 'zh-CN', cwd: 'E:\\x',
    transcript: [{ role: 'user', text: '继续吗' }, { role: 'assistant', text: '可以继续' }],
  }), out)
  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.value.candidates, ['好，继续', '先停一下'])

  const healthReq = Readable.from([])
  healthReq.method = 'GET'
  healthReq.url = '/composer-predict/health'
  const health = response()
  await handleRequest(ctx, cfg, new Map(), healthReq, health)
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.body).value.version, '0.1.0')
})

test('handleRequest does not call the model without a user message', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmReturning('["x"]', calls) }
  const out = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), request({
    transcript: [{ role: 'assistant', text: 'hello' }],
  }), out)
  assert.equal(out.status, 200)
  assert.deepEqual(JSON.parse(out.body).value.candidates, [])
  assert.equal(calls.count, 0)
})

test('handleRequest rejects a disabled plugin and unknown routes', async () => {
  const ctx = { get: () => undefined, llm: llmReturning('["x"]') }
  const disabled = response()
  await handleRequest(ctx, normalizeConfig({ enabled: false }), new Map(), request({
    transcript: [{ role: 'user', text: 'hi' }],
  }), disabled)
  assert.equal(disabled.status, 503)

  const unknownReq = Readable.from([])
  unknownReq.method = 'GET'
  unknownReq.url = '/composer-predict/nope'
  const unknown = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), unknownReq, unknown)
  assert.equal(unknown.status, 404)
})
