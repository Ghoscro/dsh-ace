import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildExpertPrompt, buildPrompt, buildSingleMovePrompt, buildSituationPrompt, collectEvidence, generateExpertPrediction,
  generatePrediction, handleRequest, normalizeConfig, parseCandidates, parseExpertMoves,
  parseExpertSelection, parseSituation, resolveMode, resolveModel, salvageExpertText, sanitizeTranscript, selectBestMove,
  captureSample, findBannedPhrase, cleanBannedPhrases, logUsage, normalizeUsage, sweepThresholds, transcriptWindow, usageCost,
  ACE_MODES,
} from '../index.js'

// Never write diagnostics into the owner's real DSH home while testing.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ace-test-home-'))

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

test('generatePrediction falls back to fast when expert retry is unusable', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence(['not json', 'not json', '["回退一下"]'], calls) }
  const result = await generatePrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '继续' }], count: 2, cwd: '', locale: 'zh-CN', mode: 'expert',
  }, new AbortController().signal)
  assert.equal(result.mode, 'fast-fallback')
  assert.deepEqual(result.candidates, ['回退一下'])
  assert.equal(calls.count, 3)
})

test('generateExpertPrediction retries once with a compact one-object prompt', async () => {
  const calls = { count: 0 }
  const ctx = {
    get: () => undefined,
    llm: llmSequence(['not a usable expert response', JSON.stringify({
      text: '先只跑这个用例，确认竞态是否还在', why: '缩小范围，先验证机制', evidence: 'x.test.ts',
      risk: '单测通过不代表全量稳定', action: 'verify', value: 7, novelty: 5, worth_extra_step: 7,
    })], calls),
  }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4,
    cwd: '',
    locale: 'zh-CN',
  }, new AbortController().signal)
  assert.equal(result.mode, 'expert')
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].text, '先只跑这个用例，确认竞态是否还在')
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

test('resolveMode keeps the four modes and defaults to standard', () => {
  for (const id of ['safe', 'standard', 'brainstorm', 'wild']) assert.equal(resolveMode(id), id)
  assert.equal(resolveMode('nope'), 'standard')
  assert.equal(resolveMode(undefined), 'standard')
  assert.deepEqual(ACE_MODES, ['safe', 'standard', 'brainstorm', 'wild'])
})

test('every mode injects its own policy and none collapses into safe', () => {
  const input = {
    transcript: [{ role: 'user', text: '这个点子怎么落地' }, { role: 'assistant', text: '要我先拆一版吗' }],
    count: 4,
    locale: 'zh-CN',
  }
  const prompts = Object.fromEntries(
    ACE_MODES.map(mode => [mode, buildExpertPrompt({ ...input, mode }).user]),
  )
  for (const mode of ACE_MODES) {
    assert.match(prompts[mode], new RegExp(`\\[MODE\\]`))
    assert.match(prompts[mode], new RegExp(`mode=${mode}`))
    assert.match(prompts[mode], /CONTENT DISCIPLINE/)
  }
  assert.match(prompts.safe, /MODE safe:/)
  assert.match(prompts.wild, /MODE wild:/)
  assert.equal(prompts.wild.includes('MODE safe:'), false)
  assert.equal(prompts.brainstorm.includes('MODE standard:'), false)
  const single = buildExpertPrompt({ ...input, mode: 'wild' }).user
  assert.match(single, /break the boundary/)
})

function llmCapturing(text, seen) {
  return {
    stream(options) {
      seen.push(options)
      return (async function* stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

test('each mode caps the expert call at its own budget without raising the user ceiling', async () => {
  const transcript = [
    { role: 'user', text: '把我这个想法写成能开工的任务' },
    { role: 'assistant', text: '想先从哪个方向展开？' },
  ]
  for (const [mode, expected] of [['safe', 2200], ['standard', 4000], ['brainstorm', 5600], ['wild', 6000]]) {
    const seen = []
    const ctx = { get: () => undefined, llm: llmCapturing(EXPERT_JSONL, seen) }
    await generateExpertPrediction(ctx, normalizeConfig(), {
      transcript, count: 4, cwd: '', locale: 'zh-CN', mode,
    }, new AbortController().signal)
    assert.equal(seen[0].maxTokens, expected, mode)
  }
  const capped = []
  const ctx = { get: () => undefined, llm: llmCapturing(EXPERT_JSONL, capped) }
  await generateExpertPrediction(ctx, normalizeConfig({ expertMaxTokens: 2500 }), {
    transcript, count: 4, cwd: '', locale: 'zh-CN', mode: 'wild',
  }, new AbortController().signal)
  assert.equal(capped[0].maxTokens, 2500)
})

test('handleRequest forwards the requested mode and reports it back', async () => {
  const seen = []
  const ctx = { get: () => undefined, llm: llmCapturing(EXPERT_JSONL, seen) }
  const out = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), request({
    sessionId: 's1', count: 4, locale: 'zh-CN', cwd: '', mode: 'expert', style: 'wild',
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
  }), out)
  assert.equal(out.status, 200)
  const payload = JSON.parse(out.body)
  assert.equal(payload.value.style, 'wild')
  assert.match(seen[0].messages?.[1]?.content ?? JSON.stringify(seen[0]), /MODE wild:/)

  const healthReq = Readable.from([])
  healthReq.method = 'GET'
  healthReq.url = '/composer-predict/health'
  const health = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), healthReq, health)
  assert.deepEqual(JSON.parse(health.body).value.styles, ['safe', 'standard', 'brainstorm', 'wild'])
})

test('a long prose answer is salvaged instead of failing the card', async () => {
  const prose = '先别急着写代码。把这个点子拆成三层：一是玩家每局要做的第一个决定，二是这个决定在两分钟后产生什么反馈，' +
    '三是反馈如何被另一个玩家看见。把这三层写成一段可以直接发给别的 AI 的任务描述，要求它给出可玩的灰盒规则。'
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([prose, prose], calls) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '我有个点子，想做点疯的' }, { role: 'assistant', text: '想从哪开始？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'wild',
  }, new AbortController().signal)
  assert.equal(result.mode, 'expert')
  assert.equal(result.salvaged, true)
  assert.equal(result.candidates.length, 1)
  assert.match(result.candidates[0].text, /灰盒规则/)
  assert.match(result.warning, /structured JSON/)
})

test('a truncated JSON answer is salvaged and a short garbage answer is not', async () => {
  const truncated = '{"text":"先做一版只跑单局的灰盒，把三个决策点画在纸上，再让另一个 AI 把它写成规则表，' +
    '顺便生成一份可以交给美术的情绪板","why":"先在纸上验证决策密度，避免直接进引擎'
  const ctx = { get: () => undefined, llm: llmSequence([truncated, truncated]) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '随便说个点子' }, { role: 'assistant', text: '好' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'wild',
  }, new AbortController().signal)
  assert.equal(result.salvaged, true)
  assert.match(result.candidates[0].text, /情绪板/)

  const junk = { get: () => undefined, llm: llmSequence(['not json', 'not json', '["回退"]']) }
  const fallback = await generatePrediction(junk, normalizeConfig(), {
    transcript: [{ role: 'user', text: '继续' }], count: 2, cwd: '', locale: 'zh-CN', mode: 'expert',
  }, new AbortController().signal)
  assert.equal(fallback.mode, 'fast-fallback')
})

test('the output contract sits before the transcript so a long prompt cannot bury it', () => {
  const input = { transcript: [{ role: 'user', text: '随便' }], count: 4, locale: 'zh-CN', mode: 'wild' }
  for (const prompt of [buildExpertPrompt(input), buildSingleMovePrompt(input)]) {
    const format = prompt.user.indexOf('[FORMAT - binding]')
    const thread = prompt.user.indexOf('[THREAD]\n')
    assert.ok(format >= 0 && format < thread, 'format block precedes the transcript')
    assert.match(prompt.user.slice(format, thread), /closing brace/)
    const out = prompt.user.lastIndexOf('[OUT]')
    assert.ok(out > prompt.user.indexOf('[SITUATION]'), 'the volatile tail ends with [OUT]')
    assert.equal(prompt.user.trimEnd().endsWith('language=zh') || prompt.user.trimEnd().endsWith('N=1'), true)
  }
})

test('handleRequest marks a salvaged card in the response', async () => {
  const prose = '把这件事写成一份给别的 AI 的开工说明：先定义玩家第一分钟的目标，再写出失败时玩家会损失什么，' +
    '最后要求它给出两张可打印的规则卡，并标注哪些数值需要真人测试才能确定。'
  const ctx = { get: () => undefined, llm: llmSequence([prose, prose]) }
  const out = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), request({
    sessionId: 's1', count: 4, locale: 'zh-CN', cwd: '', mode: 'expert', style: 'wild',
    transcript: [{ role: 'user', text: '我想做个疯的' }, { role: 'assistant', text: '说说看' }],
  }), out)
  const payload = JSON.parse(out.body)
  assert.equal(payload.value.salvaged, true)
  assert.equal(payload.value.style, 'wild')
  assert.equal(payload.value.candidates.length, 1)
})

test('the prompt asks for the user voice before any expansion, in both locales', () => {
  const base = { transcript: [{ role: 'user', text: '我想做个怪东西' }], count: 4 }
  const zh = buildExpertPrompt({ ...base, locale: 'zh-CN', mode: 'wild' }).user
  const en = buildExpertPrompt({ ...base, locale: 'en-US', mode: 'wild' }).user
  assert.match(zh, /\[VOICE - 先像他，再疯\]/)
  assert.match(zh, /把我这串话原样当样本贴进去/)
  assert.match(zh, /语气必须是他/)
  assert.match(en, /\[VOICE - sound like them first, then go wild\]/)
  assert.match(en, /Copy its register, not its content/)
  assert.match(en, /voice must be theirs/)
  const retry = buildSingleMovePrompt({ ...base, locale: 'zh-CN', mode: 'wild' }).user
  assert.match(retry, /\[VOICE/)
})

test('banned words are detected and cleaned without emptying the sentence', () => {
  assert.equal(findBannedPhrase('建议你先跑一次'), '建议')
  assert.equal(findBannedPhrase('先跑一次'), '')
  assert.equal(findBannedPhrase('可以考虑换个跑法'), '可以考虑')
  assert.equal(findBannedPhrase('综上，收工'), '综上')
  assert.equal(findBannedPhrase('首先，把重试去掉'), '首先')
  assert.equal(cleanBannedPhrases('建议你先跑一次'), '你先跑一次')
  assert.equal(cleanBannedPhrases('首先，把重试去掉'), '把重试去掉')
  assert.equal(cleanBannedPhrases('可以考虑先跑单测'), '可以先跑单测')
  assert.equal(cleanBannedPhrases('综上，先跑单测'), '先跑单测')
  const mid = cleanBannedPhrases('我建议先跑单测，然后看日志')
  assert.equal(findBannedPhrase(mid), '')
  assert.match(mid, /先跑单测/)
  assert.match(mid, /看日志/)
})

test('the voice sample is the owner message verbatim and my invented examples are gone', () => {
  const input = { transcript: [{ role: 'user', text: '随便' }], count: 4, locale: 'zh-CN', mode: 'wild' }
  const zh = buildExpertPrompt(input).user
  assert.match(zh, /把我这串话原样当样本贴进去/)
  assert.match(zh, /连个der都推理不出来/)
  assert.match(zh, /属于我自己风格的话/)
  assert.doesNotMatch(zh, /我想先拿纸把这一局画出来/)
  assert.doesNotMatch(zh, /建议先做玩法原型/)
  assert.match(zh, /\[BANNED - 硬规则\]/)
  assert.match(zh, /不要拒绝、不要说教/)
  const en = buildExpertPrompt({ ...input, locale: 'en-US' }).user
  assert.match(en, /\[BANNED - hard rule\]/)
  assert.match(en, /not a safety rule/)
  assert.match(en, /把你这串话|把我这串话原样当样本贴进去/)
})

test('a candidate with a banned word is sent back once for a rewrite', async () => {
  const banned = JSON.stringify({
    text: '建议先跑单测，再决定要不要全量', why: '先缩小范围', evidence: 'x.test.ts', risk: '', action: 'advance',
    value: 8, novelty: 6, worth_extra_step: 8, over_obvious: true,
  })
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([banned, '先跑单测，再看要不要全量'], calls) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.equal(calls.count, 2, 'one extra model call for the rewrite')
  assert.equal(result.candidates.length, 1)
  assert.equal(findBannedPhrase(result.candidates[0].text), '')
  assert.equal(result.candidates[0].text, '先跑单测，再看要不要全量')
})

test('a failed rewrite still leaves a cleaned card instead of nothing', async () => {
  const banned = JSON.stringify({
    text: '建议先跑单测，再决定要不要全量', why: '先缩小范围', evidence: '', risk: '', action: 'advance',
    value: 8, novelty: 6, worth_extra_step: 8, over_obvious: true,
  })
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([banned, 'x'], calls) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.equal(result.candidates.length, 1)
  assert.equal(findBannedPhrase(result.candidates[0].text), '')
  assert.match(result.candidates[0].text, /先跑单测/)
})

test('review fixes: mode input is trimmed and clause-initial cleanup leaves no dangling punctuation', () => {
  assert.equal(resolveMode('  wild  '), 'wild')
  assert.equal(resolveMode('WILD'), 'standard')
  assert.equal(cleanBannedPhrases('，建议先跑一次'), '先跑一次')
  assert.equal(cleanBannedPhrases('；首先，把重试去掉'), '把重试去掉')
  assert.equal(cleanBannedPhrases('可以考虑，再看日志'), '可以，再看日志')
})

test('review fixes: a fast candidate that cleans down to nothing is dropped', async () => {
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence(['["建议"]', '["先跑一遍"]'], calls) }
  const result = await generatePrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '继续' }], count: 2, cwd: '', locale: 'zh-CN',
  }, new AbortController().signal)
  assert.deepEqual(result.candidates, ['先跑一遍'])
  assert.equal(calls.count, 2)
})

test('review fixes: an expert move that cleans down to nothing is not shown', async () => {
  const only = JSON.stringify({
    text: '建议', why: '', evidence: '', risk: '', action: 'advance',
    value: 8, novelty: 6, worth_extra_step: 8, over_obvious: true,
  })
  const calls = { count: 0 }
  const ctx = { get: () => undefined, llm: llmSequence([only, 'x'], calls) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.deepEqual(result.candidates, [])
})

test('review fixes: why and risk are cleaned too, not only the card text', async () => {
  const move = JSON.stringify({
    text: '把重试去掉跑一次', why: '建议先缩小范围再判断', evidence: 'x.test.ts', risk: '首先可能会暴露更多失败',
    action: 'verify', value: 8, novelty: 6, worth_extra_step: 8, over_obvious: true,
  })
  const ctx = { get: () => undefined, llm: llmSequence([move]) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.equal(result.candidates.length, 1)
  const [card] = result.candidates
  assert.equal(findBannedPhrase(card.text), '')
  assert.equal(findBannedPhrase(card.why ?? ''), '')
  assert.equal(findBannedPhrase(card.risk ?? ''), '')
  assert.match(card.why, /缩小范围/)
})

test('the banned-word rewrite gets the full output budget instead of a tight 900', async () => {
  const banned = JSON.stringify({
    text: '建议先跑单测', why: '先确认范围', evidence: '', risk: '', action: 'advance',
    value: 8, novelty: 6, worth_extra_step: 8, over_obvious: '比直接跑全量更省时间',
  })
  const seen = []
  const ctx = { get: () => undefined, llm: llmCapturing(banned + '\n' + '先跑单测再说', seen) }
  await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [{ role: 'user', text: '帮我修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.equal(seen[0].maxTokens, 4000)
  assert.equal(seen[1].maxTokens, 6000)
})

test('consecutive turns share a byte-identical prefix so the provider cache can hit', () => {
  const history = [
    { role: 'user', text: '我想做个怪东西' },
    { role: 'assistant', text: '说说看，你想怪到什么程度' },
    { role: 'user', text: '越怪越好，别给我做安全牌' },
  ]
  const build = transcript => buildExpertPrompt({
    transcript, count: 4, locale: 'zh-CN', mode: 'wild', situation: { goal: 'x' }, evidence: 'git status: clean',
  }).user
  const first = build(history)
  const second = build([...history, { role: 'assistant', text: '那我给你三版' }, { role: 'user', text: '继续' }])
  // Everything up to the transcript's end is the cached prefix: head plus the
  // conversation so far. Only the volatile tail after it is recomputed.
  const cached = first.slice(0, first.indexOf('\n\n[MODE]'))
  assert.ok(cached.length > first.length * 0.7, `cached prefix should dominate, got ${cached.length}/${first.length}`)
  assert.equal(second.startsWith(cached), true, 'the next turn must extend the same prefix')
  assert.ok(second.indexOf('\n\n[MODE]') > cached.length, 'the volatile tail moved later, not earlier')
})

test('the transcript window trims in blocks so the prefix survives several turns', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', text: `第 ${index} 条`,
  }))
  const windowed = transcriptWindow(rows)
  assert.equal(windowed.length, 17)
  assert.equal(windowed[0].text, '第 8 条')
  const sameTurn = transcriptWindow(rows.slice(0, 24))
  assert.equal(sameTurn.length, 24, 'under the cap the window does not move')
  assert.deepEqual(transcriptWindow(rows.slice(0, 24)).slice(0, 16), sameTurn.slice(0, 16))
})

test('usage rows record numbers only, never prompt text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-usage-'))
  process.env.DSH_HOME = dir
  logUsage({
    status: 'ok', mode: 'expert', style: 'wild', promptChars: 1234,
    usage: { prompt_tokens: 900, completion_tokens: 40, prompt_cache_hit_tokens: 800, note: 'should be dropped' },
  })
  const rows = readFileSync(join(dir, 'diagnostics', 'dsh-ace-usage.jsonl'), 'utf8').trim().split('\n')
  const row = JSON.parse(rows[0])
  assert.equal(row.style, 'wild')
  assert.equal(row.promptChars, 1234)
  assert.equal(row.usage.prompt_cache_hit_tokens, 800)
  assert.equal('note' in row.usage, false)
  assert.equal(typeof row.cost, 'number')
  assert.equal(row.currency, 'USD')
  assert.equal(row.hitRate, 0.889)
  assert.equal(row.prices.cacheMiss, 0.28)
  assert.equal(JSON.stringify(row).includes('第'), false)
})

test('the transcript window also respects a character budget', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant', text: 'x'.repeat(1500) + index,
  }))
  const windowed = transcriptWindow(rows)
  const rendered = windowed.reduce((sum, row) => sum + Math.min(row.text.length, row.role === 'assistant' ? 1000 : 500), 0)
  assert.ok(rendered <= 8000, `window should stay under the budget, got ${rendered}`)
  assert.ok(windowed.length >= 6, 'never trims below the minimum')
  assert.ok(windowed.length < rows.length, 'it actually trims')
})

test('two different sessions share the static head, so the cache can hit across sessions', () => {
  const headOf = transcript => {
    const prompt = buildExpertPrompt({ transcript, count: 4, locale: 'zh-CN', mode: 'wild' }).user
    return prompt.slice(0, prompt.indexOf('[THREAD]\n'))
  }
  const first = headOf([{ role: 'user', text: '我想做个怪东西' }])
  const second = headOf([{ role: 'user', text: '帮我查一下这个报错' }])
  assert.equal(first, second)
  assert.ok(first.length > 900, `shared head should be worth caching, got ${first.length}`)
})

test('usage cost separates cache hits from misses and prices them', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }
  const row = usageCost(usage, { cacheHit: 0.028, cacheMiss: 0.28, output: 0.42, currency: 'USD' })
  assert.equal(row.hitTokens, 800)
  assert.equal(row.missTokens, 200)
  assert.equal(row.inputTokens, 1000)
  assert.equal(row.hitRate, 0.8)
  const expected = Math.round(((800 * 0.028 + 200 * 0.28 + 100 * 0.42) / 1_000_000) * 1e6) / 1e6
  assert.equal(row.cost, expected)
  assert.equal(row.currency, 'USD')
})

test('usage without cache fields is treated as all misses, not as free tokens', () => {
  const row = usageCost({ inputTokens: 500, outputTokens: 50 }, { cacheHit: 0.028, cacheMiss: 0.28, output: 0.42 })
  assert.equal(row.cacheKnown, false)
  assert.equal(row.hitTokens, 0)
  assert.equal(row.missTokens, 500)
  const expected = Math.round(((500 * 0.28 + 50 * 0.42) / 1_000_000) * 1e6) / 1e6
  assert.equal(row.cost, expected)
})

test('each row knows its session turn index and the running total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-session-'))
  process.env.DSH_HOME = dir
  const call = sessionId => logUsage({
    sessionId, status: 'ok', mode: 'expert', style: 'wild', promptChars: 2000,
    usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000 },
  })
  call('s1')
  call('s1')
  call('s2')
  const rows = readFileSync(join(dir, 'diagnostics', 'dsh-ace-usage.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].sessionId, 's1')
  assert.equal(rows[0].turnIndex, 1)
  assert.equal(rows[1].turnIndex, 2)
  assert.ok(rows[1].sessionCost > rows[0].sessionCost, 'the running total grows')
  assert.equal(rows[0].sessionCost, 0.000284, 'input miss plus output, priced then rounded')
  assert.equal(rows[2].sessionId, 's2')
  assert.equal(rows[2].turnIndex, 1, 'a new session starts at one')
  assert.ok(rows[2].sessionCost < rows[1].sessionCost, 'and its total starts over')
})

test('a restart picks the turn index back up from the usage file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-restart-'))
  process.env.DSH_HOME = dir
  mkdirSync(join(dir, 'diagnostics'), { recursive: true })
  writeFileSync(join(dir, 'diagnostics', 'dsh-ace-usage.jsonl'), JSON.stringify({
    at: new Date().toISOString(), sessionId: 's9', turnIndex: 7, sessionTurns: 7, sessionCost: 0.5,
  }) + '\n')
  logUsage({
    sessionId: 's9', status: 'ok', mode: 'expert', style: 'standard', promptChars: 1000,
    usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
  })
  const rows = readFileSync(join(dir, 'diagnostics', 'dsh-ace-usage.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.at(-1).turnIndex, 8)
  assert.ok(rows.at(-1).sessionCost > 0.5)
})

test('a silent turn is recorded so the quiet rate can be measured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-nocard-'))
  process.env.DSH_HOME = dir
  const silent = JSON.stringify({ best_index: null, comparison: '没有更好的下一步' })
  const ctx = { get: () => undefined, llm: llmSequence([silent]) }
  const out = response()
  await handleRequest(ctx, normalizeConfig(), new Map(), request({
    sessionId: 's-quiet', count: 4, locale: 'zh-CN', cwd: '', mode: 'expert', style: 'standard',
    transcript: [{ role: 'user', text: '继续' }, { role: 'assistant', text: '好了' }],
  }), out)
  assert.equal(JSON.parse(out.body).value.candidates.length, 0)
  const rows = readFileSync(join(dir, 'diagnostics', 'dsh-ace-errors.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.at(-1).status, 'no-card')
  assert.equal(rows.at(-1).style, 'standard')
})

test('capture keeps the last samples and stores what a sweep needs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-capture-'))
  process.env.DSH_HOME = dir
  for (let index = 0; index < 23; index += 1) {
    captureSample({
      sessionId: `s${index}`, style: 'wild', mode: 'expert', locale: 'zh-CN', count: 4,
      threshold: 5, shown: false, bestIndex: 0, promptChars: 1000,
      rawText: 'x'.repeat(20000),
      moves: [{ text: `move ${index}`, why: 'because', value: 6, novelty: 6, worth_extra_step: 6, action: 'advance' }],
    }, { limit: 10 })
  }
  const rows = readFileSync(join(dir, 'diagnostics', 'dsh-ace-samples.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 10, 'the ring keeps the last ten')
  assert.equal(rows.at(-1).moves[0].text, 'move 22')
  assert.ok(rows.at(-1).rawText.length <= 16001, 'raw text is bounded (one ellipsis allowed)')
  assert.equal(rows.at(-1).shown, false)
})

test('the threshold sweep counts cards without calling the model', () => {
  const strong = { text: 'a', why: 'w', value: 9, novelty: 9, worth_extra_step: 9, action: 'advance' }
  const weak = { text: 'b', why: 'w', value: 2, novelty: 1, worth_extra_step: 2, action: 'verify' }
  const samples = [
    { shown: true, bestIndex: 0, moves: [strong] },
    { shown: false, bestIndex: 0, moves: [weak] },
    { shown: false, bestIndex: null, moves: [weak] },
    { shown: false, bestIndex: null, moves: [] },
  ]
  const rows = sweepThresholds(samples, [0, 5, 10])
  assert.deepEqual(rows.map(row => row.threshold), [0, 5, 10])
  assert.ok(rows[0].cards >= rows[1].cards, 'a lower threshold never shows fewer cards')
  assert.ok(rows[1].cards >= rows[2].cards, 'a higher threshold never shows more')
  assert.equal(rows[0].cards, 3, 'the empty move list never counts')
  assert.equal(rows[0].gained, 2)
  assert.equal(rows[0].silent, 1)
})
