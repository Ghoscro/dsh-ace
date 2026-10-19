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
  captureSample, countAnchors, estimateLevel, findBannedPhrase, judgeRelation, readProjectShape, repliesTo, cleanBannedPhrases, scoreMove, logUsage, normalizeUsage, sweepThresholds, transcriptWindow, usageCost,
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

test('concrete anchors are counted, vague prose is not', () => {
  assert.equal(countAnchors('继续推进一下'), 0)
  assert.equal(countAnchors('再看看'), 0)
  const concrete = '把 x.test.ts 里的 retry 去掉，跑 `npm test -- --test-name-pattern 竞态` 一次'
  assert.ok(countAnchors(concrete) >= 2, `expected at least two anchors, got ${countAnchors(concrete)}`)
  assert.equal(countAnchors('a.ts b.ts c.ts d.ts e.ts f.ts'), 3, 'capped at three')
})

test('a concrete step beats a vague one at equal scores', () => {
  const base = { action: 'advance', value: 7, novelty: 5, worth_extra_step: 7, evidence: '', over_obvious: '' }
  const vague = { ...base, text: '继续优化一下' }
  const concrete = { ...base, text: '把 x.test.ts 的 retry 去掉，跑 npm test 一次看还挂不挂' }
  assert.ok(scoreMove(concrete) > scoreMove(vague) + 0.5)
  const chosen = selectBestMove({ moves: [vague, concrete], bestIndex: null, comparison: '' }, 5)
  assert.equal(chosen.text, concrete.text)
})

test('the technical-grounding block is in both prompts and both locales', () => {
  const base = { transcript: [{ role: 'user', text: '修测试' }], count: 4 }
  const zh = buildExpertPrompt({ ...base, locale: 'zh-CN', mode: 'standard' }).user
  const en = buildExpertPrompt({ ...base, locale: 'en-US', mode: 'standard' }).user
  assert.match(zh, /\[TECH - 这张卡是一句能直接开工的下一轮 prompt\]/)
  assert.match(zh, /至少带一个能验收的东西/)
  assert.match(zh, /小白给一件他能亲眼确认的事/)
  assert.match(en, /\[TECH - this card is a next prompt the user can send as-is\]/)
  assert.match(en, /one checkable thing/)
  assert.match(en, /non-engineers get something they can see for themselves/)
  assert.match(buildSingleMovePrompt({ ...base, locale: 'zh-CN', mode: 'wild' }).user, /\[TECH/)
})

test('the evidence pack carries project shape, not only a diff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ace-shape-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'left-pad'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '18' }, scripts: { test: 'node --test' } }))
  writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1\n')
  const shape = readProjectShape(dir)
  assert.match(shape.tree, /src\//)
  assert.doesNotMatch(shape.tree, /node_modules/)
  assert.match(shape.deps, /react/)
  assert.match(shape.deps, /test/)
  const evidence = await collectEvidence(dir)
  assert.match(evidence, /\[TREE\]/)
  assert.match(evidence, /\[DEPS\]/)
})

test('a technical prompt longer than 90 characters is no longer dropped', () => {
  const long = '把 x.test.ts 里包着 retry 的那层辅助函数整个删掉，只跑一次并发用例；如果它挂了，就说明重试一直在掩盖竞态，把日志和结论写进 notes/race.md 再决定下一步'
  assert.ok(long.length > 90)
  const selection = parseExpertSelection(JSON.stringify({
    text: long, why: '测试里的重试会掩盖竞态', evidence: 'x.test.ts', risk: '可能暴露更多失败',
    action: 'verify', value: 8, novelty: 7, worth_extra_step: 8, insight: 8, over_obvious: '验证机制而不是增加样本',
  }), 5)
  assert.equal(selection.moves.length, 1)
  assert.equal(selection.moves[0].text, long)
})

test('insight is parsed and outranks mechanics at equal scores', () => {
  const base = { action: 'advance', value: 7, novelty: 5, worth_extra_step: 7, evidence: '', over_obvious: '' }
  const shallow = { ...base, text: '跑 npm test 看看', insight: 2 }
  const deep = { ...base, text: '把 session 和 event 拆成两个模块，先跑 npm test 确认边界', insight: 9 }
  assert.ok(scoreMove(deep) > scoreMove(shallow) + 0.8)
  const selection = parseExpertSelection(JSON.stringify({
    text: '把 session 和 event 拆开', why: '两者耦合让缓存失效', evidence: 'src/session.js', risk: '',
    action: 'reframe', value: 6, novelty: 8, worth_extra_step: 6, insight: 9,
  }), 5)
  assert.equal(selection.moves[0].insight, 9)
})

test('the insight block reaches both prompts', () => {
  const base = { transcript: [{ role: 'user', text: '这个模块越来越乱' }], count: 4 }
  const zh = buildExpertPrompt({ ...base, locale: 'zh-CN', mode: 'standard' }).user
  const en = buildExpertPrompt({ ...base, locale: 'en-US', mode: 'standard' }).user
  assert.match(zh, /\[INSIGHT - 用户自己想不到的那一层\]/)
  assert.match(zh, /四拍/)
  assert.match(zh, /没有 relation、或 relation 只是把 x\/z 重写一遍/)
  assert.match(en, /\[INSIGHT - the layer the user would not have produced\]/)
  assert.match(en, /four beats/)
  assert.match(en, /surface_like/)
})

test('the host judges the relation itself, not the model', () => {
  const base = {
    why: '测试里的重试会掩盖偶发失败', evidence: '', risk: '', action: 'advance',
    value: 7, novelty: 6, worth_extra_step: 7, insight: 6,
    text: '把重试去掉，只跑一次 x.test.ts',
  }
  // Surface-alike: the example is already visible, no mapping line required.
  const surface = parseExpertSelection(JSON.stringify({
    ...base, x: '重试过了吗', y: '重试会掩盖偶发失败', z: '上次那个上传重试也是',
    relation: '', surface_like: true, falsify: '去掉重试后一次就过',
  }), 5).moves[0]
  assert.equal(surface.relation_ok, true)

  // Surface-unlike with no mapping line: dropped by the host.
  const missing = parseExpertSelection(JSON.stringify({
    ...base, x: '重试过了吗', y: '重试会掩盖偶发失败', z: '肿瘤放疗的分次照射',
    relation: '', surface_like: false, falsify: '',
  }), 5).moves[0]
  assert.equal(missing.relation_ok, false)

  // A rewrite of Z is not a mapping.
  const rewritten = parseExpertSelection(JSON.stringify({
    ...base, x: '重试过了吗', y: '重试会掩盖偶发失败', z: '上次那个上传重试也是',
    relation: '上次那个上传重试也是', surface_like: false, falsify: '',
  }), 5).moves[0]
  assert.equal(rewritten.relation_ok, false)

  // A sentence naming the shared mechanism passes.
  const mapped = parseExpertSelection(JSON.stringify({
    ...base, x: '重试过了吗', y: '重试会掩盖偶发失败', z: '肿瘤放疗的分次照射',
    relation: '都是把一个整体失败拆成多次小机会', surface_like: false, falsify: '',
  }), 5).moves[0]
  assert.equal(mapped.relation_ok, true)
})

test('judgeRelation is strict about what counts as a mapping', () => {
  assert.equal(judgeRelation({ x: '重试过了吗', z: '肿瘤放疗分次', relation: '都是把整体失败拆成多次小机会', surfaceLike: false }), true)
  assert.equal(judgeRelation({ x: '重试过了吗', z: '肿瘤放疗分次', relation: '肿瘤放疗分次', surfaceLike: false }), false)
  assert.equal(judgeRelation({ x: '重试过了吗', z: '肿瘤放疗分次', relation: '', surfaceLike: false }), false)
  assert.equal(judgeRelation({ x: '重试过了吗', z: '肿瘤放疗分次', relation: '同一件事', surfaceLike: false }), false)
  assert.equal(judgeRelation({ x: '重试过了吗', z: '肿瘤放疗分次', relation: '', surfaceLike: true }), true)
  assert.equal(judgeRelation({ x: '重试过了吗', z: '', relation: '都是同一件事', surfaceLike: false }), false)
})

test('a four-beat card without a written mapping never reaches the composer', () => {
  const selection = parseExpertSelection(JSON.stringify({
    text: '把重试去掉再跑一次 x.test.ts', why: '重试掩盖竞态', action: 'advance',
    value: 9, novelty: 9, worth_extra_step: 9, insight: 9,
    x: '重试过了吗', y: '重试掩盖偶发失败', z: '肿瘤放疗分次',
    surface_like: false, relation: '',
  }), 5)
  assert.equal(selection.moves.length, 1)
  assert.equal(selectBestMove(selection, 5), null)
})

test('the prompt asks for the four beats and the falsifier', () => {
  const base = { transcript: [{ role: 'user', text: '界面又卡了' }], count: 4, mode: 'standard' }
  const zh = buildExpertPrompt({ ...base, locale: 'zh-CN' }).user
  assert.match(zh, /X 接住那个"一"/)
  assert.match(zh, /Y 点出背后那条线/)
  assert.match(zh, /Z 指出"三"在哪/)
  assert.match(zh, /W 一个能验收的动作/)
  assert.match(zh, /falsify/)
  const en = buildExpertPrompt({ ...base, locale: 'en-US' }).user
  assert.match(en, /catch the "one"/)
  assert.match(en, /one concrete place the same line shows up again/)
})

test('a quoted reply must actually appear in the assistant message', () => {
  const assistant = '改好了。要跑全量吗？要不要先看 diff。'
  assert.equal(repliesTo('要跑全量吗', assistant), true)
  assert.equal(repliesTo('“要跑全量吗？”', assistant), true)
  assert.equal(repliesTo('要不要先看 diff', assistant), true)
  assert.equal(repliesTo('先部署到线上', assistant), false)
  assert.equal(repliesTo('', assistant), null)
  assert.equal(repliesTo('短', assistant), null)
})

test('answering the assistant beats an unrelated move at equal strength', () => {
  const base = { action: 'advance', value: 7, novelty: 5, worth_extra_step: 7, insight: 7, evidence: '', over_obvious: '' }
  const replies = { ...base, text: '先跑单个用例看竞态还在不在', reply_ok: true }
  const unrelated = { ...base, text: '把 session 拆开', reply_ok: false }
  assert.ok(scoreMove(replies) > scoreMove(unrelated) + 1)
})

test('generation prefers the candidate that quotes the assistant, end to end', async () => {
  const moves = [
    { text: '先只跑那个用例，确认竞态还在不在', why: '缩小范围先验证机制', evidence: 'x.test.ts', risk: '',
      action: 'advance', value: 7, novelty: 5, worth_extra_step: 7, insight: 7, reply_to: '要跑全量吗' },
    { text: '把 session 和 event 拆成两个模块', why: '边界不清', evidence: 'src/session.js', risk: '',
      action: 'advance', value: 7, novelty: 5, worth_extra_step: 7, insight: 7, reply_to: '先部署到线上' },
  ].map(JSON.stringify).join('\n') + '\n' + JSON.stringify({ best_index: 1, comparison: '' })
  const ctx = { get: () => undefined, llm: llmSequence([moves]) }
  const result = await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [
      { role: 'user', text: '修一下测试' },
      { role: 'assistant', text: '改好了。要跑全量吗？' },
    ],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  assert.equal(result.candidates.length, 1)
  assert.match(result.candidates[0].text, /跑那个用例/)
})

test('the reply block and the predictive standard policy are in the prompt', () => {
  const prompt = buildExpertPrompt({
    transcript: [{ role: 'user', text: '修测试' }, { role: 'assistant', text: '要跑全量吗？' }],
    count: 4, locale: 'zh-CN', mode: 'standard',
  }).user
  assert.match(prompt, /\[REPLY - 读心，不是给建议\]/)
  assert.match(prompt, /reply_to 抄助手最后一句/)
  assert.match(prompt, /我草，我就是要说这个/)
  assert.match(prompt, /MODE standard: infer the exact line this user wants to send next/)
  assert.match(buildExpertPrompt({ transcript: [], count: 4, locale: 'en-US', mode: 'standard' }).user, /\[REPLY - read the mind/)
})

test('the technical level is inferred from the user messages, with a manual override', () => {
  assert.equal(estimateLevel([{ role: 'user', text: '我想做个记账的小工具，但我不太会写代码，能帮我一下吗' }]), 'novice')
  assert.equal(estimateLevel([
    { role: 'user', text: '把 src/cache.ts 里的 TTL 改成 30 秒，跑 npm test 看并发下会不会重复回源' },
    { role: 'user', text: '顺便补个单测，别动 api 接口' },
  ]), 'expert')
  assert.equal(estimateLevel([], 'novice'), 'novice')
  assert.equal(estimateLevel([{ role: 'assistant', text: 'hello' }]), 'working')
})

test('the prompt carries a level block that matches the inferred level', () => {
  const base = { transcript: [{ role: 'user', text: '修一下测试' }], count: 4, locale: 'zh-CN', mode: 'standard' }
  assert.match(buildExpertPrompt({ ...base, level: 'novice' }).user, /\[LEVEL - 这位用户不是工程师\]/)
  assert.match(buildExpertPrompt({ ...base, level: 'expert' }).user, /\[LEVEL - 这位用户是工程师\]/)
  assert.match(buildExpertPrompt({ ...base, level: 'working' }).user, /\[LEVEL - 这位用户能读技术内容/)
  assert.match(buildExpertPrompt({ ...base, locale: 'en-US', level: 'novice' }).user, /\[LEVEL - this user is not an engineer\]/)
})

test('the novice card asks for something visible, not a command', () => {
  const prompt = buildExpertPrompt({
    transcript: [{ role: 'user', text: '这个按钮老是点不动，我也不懂代码' }],
    count: 4, locale: 'zh-CN', level: 'novice', mode: 'standard',
  }).user
  assert.match(prompt, /\[LEVEL - 这位用户不是工程师\]/)
  // TECH still names a concrete object for engineers, but now accepts a visible
  // check for everyone else. The 0.4.0 "must name a file or command" gate was
  // the conflict the review flagged.
  assert.match(prompt, /小白给一件他能亲眼确认的事/)
  assert.match(prompt, /刷新一下，看右上角还报不报红/)
})

test('generation passes the inferred level into the real prompt', async () => {
  const seen = []
  const ctx = { get: () => undefined, llm: llmCapturing(EXPERT_JSONL, seen) }
  await generateExpertPrediction(ctx, normalizeConfig(), {
    transcript: [
      { role: 'user', text: '把 src/cache.ts 的 TTL 改成 30 秒，跑 npm test 看并发下会不会重复回源' },
      { role: 'assistant', text: '改好了，要跑全量吗？' },
      { role: 'user', text: '顺便补个单测，别动 api 接口' },
    ],
    count: 4, cwd: '', locale: 'zh-CN', style: 'standard',
  }, new AbortController().signal)
  const prompt = seen[0].messages[0].content[0].text
  assert.match(prompt, /\[LEVEL - 这位用户是工程师\]/)
})
