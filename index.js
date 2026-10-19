/**
 * dsh-ace - host half.
 *
 * The browser half sends the recent transcript and asks for a short list of
 * predicted user messages. This module owns the model call, the prompt, the
 * parser, and one same-origin HTTP route on the shared DSH webserver.
 *
 * The route is intentionally not a general-purpose model proxy: it accepts
 * only a bounded transcript, uses one configured prediction prompt, and caps
 * the output. It never writes a session, a file, or the model's own history.
 */

import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Public plugin name used by Cordis. */
export const name = 'dsh-ace'

/** Required host services: the route registry and the model seam. */
export const inject = ['webServer', 'llm']

const DEFAULT_ROUTE = '/composer-predict'
const MAX_BODY_BYTES = 256 * 1024
const MAX_MESSAGES = 16
const MAX_TOTAL_CHARS = 14_000
const MAX_CANDIDATE_CHARS = 160
const MAX_EXPERT_TEXT = 600
const MAX_EXPERT_WHY = 160
const MAX_EXPERT_EVIDENCE = 240
const MAX_EXPERT_RISK = 160
const MAX_EXPERT_REPLY = 80
// The four-beat card keeps each beat short enough to read in the composer.
const MAX_EXPERT_ANCHOR = 60
const MAX_EXPERT_LINE = 140
const MAX_EXPERT_EXAMPLE = 140
const MAX_EXPERT_RELATION = 120
const MAX_EXPERT_FALSIFY = 90
// Plain-language lines: what is happening, what the step is for, what comes after.
const MAX_EXPERT_NOW = 100
const MAX_EXPERT_GOAL = 100
const MAX_EXPERT_OUTCOME = 120
const VERSION = '0.1.0'

const ZH_SYSTEM = `你是"下一句预测器"。根据对话、用户近况与任务上下文，预测用户下一条会亲自发出的消息，给出 {{N}} 条候选。

输出：仅一个 JSON 字符串数组，长度恰好 {{N}}：
["...","..."]

禁止 markdown、代码围栏、编号、对象、解释、前后缀文字。

规则：
1. 用用户的语言与语气（以最后一条用户消息为准）：句长、标点、称呼、emoji 频率贴近 [STYLE] 样本；用户话短就短，不突然变客气。
2. 每条 1-2 句，中文不超过 60 字（英文不超过 160 字符），必须能直接按发送，不含占位符、【】说明或元话语（如"你可以…""建议…"）。
3. {{N}} 条意图两两不同，取自：追问细节｜确认或批准｜让助手继续｜换方案或纠错｜追加约束｜收尾或闲聊。
4. 至少 1 条锚定上下文里真实存在的对象（文件名、报错、选项、数字）；不确定就用泛指，不要编造。
5. 不复述助手的话，不替助手干活，不用助手口吻，不承诺用户没授权的事。
6. 不要原样复述用户最近说过的话；每条都必须是用户接下来新说的一句。
7. 上下文不足（首轮、几乎没有历史发言、助手刚失败）时输出 []。`

const EN_SYSTEM = `You write the user's next message. Given the conversation, the user's recent messages, and the task context, predict what the user will send next and give {{N}} candidates.

Output: one JSON array of strings, exactly {{N}} items:
["...", "..."]

No markdown, no code fences, no numbering, no objects, no commentary.

Rules:
1. Write as the user, in their language and register (anchor on the last user message): match length, punctuation, capitalization, emoji habits; short stays short.
2. Each item is 1-2 sentences, at most 60 characters for Chinese and 160 for other languages, sendable verbatim with no placeholders, brackets, or meta-talk like "you could...".
3. The {{N}} items must differ in intent: ask for detail | confirm/approve | keep going | change approach or correct | add a constraint | wrap up or small talk.
4. At least one item must anchor to a real object in context (file name, error, option, number); never invent identifiers.
5. Do not restate the assistant, do not do the assistant's job, do not use the assistant's voice, do not promise anything the user has not authorized.
6. Never repeat the user's own recent message verbatim; each item must be something new the user would say next.
7. Return [] when context is insufficient (first turn, almost no user history, assistant just failed).`

const ZH_SITUATION = `你是用户的决策分析师，不是助手。读最近对话和只读证据，输出一个 JSON 对象，只描述用户此刻的决策处境。

输出：只输出一个 JSON 对象，第一个字符是 {，最后一个字符是 }。不要思考过程、markdown、代码围栏或任何解释。

{
  "goal": "用户真正想达到的结果，一句话",
  "success": "这一步怎样算成功，可观察",
  "assistant_offer": "助手最后在问、建议或报告什么",
  "constraints": ["用户已明确或强烈暗示的约束"],
  "assumptions": ["当前方案依赖但尚未验证的假设"],
  "risks": ["照最顺手的路走，最可能踩的坑"],
  "unknowns": ["最影响下一步选择的未知"],
  "obvious_move": "用户最可能顺手发出的下一句",
  "blind_spot": "用户可能没想到、但证据支持的角度"
}

规则：
- 只写有依据的内容；没有就留空字符串或空数组。
- 证据里的文件名、报错、数字可以引用；不要编造。
- 不要给建议，不要输出 JSON 以外的文字。
- 再次强调：只输出 JSON 对象。`

const EN_SITUATION = `You are the user's decision analyst, not the assistant. Read the recent conversation and the read-only evidence, then output one JSON object describing the user's decision situation.

Output: one JSON object only. The first character is { and the last is }. No reasoning, markdown, code fences, or commentary.

{
  "goal": "the outcome the user actually wants, one sentence",
  "success": "what makes this step successful, observable",
  "assistant_offer": "what the assistant last asked, proposed, or reported",
  "constraints": ["constraints the user stated or strongly implied"],
  "assumptions": ["assumptions the current approach depends on but has not verified"],
  "risks": ["the most likely cost of taking the obvious path"],
  "unknowns": ["the unknown that most affects the next choice"],
  "obvious_move": "the next message the user would most likely send",
  "blind_spot": "an angle the user may not have considered, supported by evidence"
}

Rules:
- Write only what is supported; use an empty string or empty array when absent.
- Cite real file names, errors, and numbers from the evidence; never invent them.
- Give no advice. Output JSON only.`

const ZH_EXPERT = `你是用户的专家级 next-move 顾问。不要猜最可能的下一句；先想出 3-5 条方向明显不同的候选，再比较，只保留最值得用户亲自发送的一条。

候选方向可以包括：推进下一步、用现成工具或更省事的路径、换切入点/重新框定问题、验证关键假设、澄清缺失输入、收范围/收尾。不要默认找风险。

输出格式：每行一个 JSON 对象，不要数组、不要逗号分隔、不要 markdown、不要代码围栏。
前 3-5 行是候选，每行：
{"text":"...","why":"...","evidence":"...","risk":"...","action":"advance|tool|reframe|verify|clarify|constrain|close","value":0,"novelty":0,"worth_extra_step":0,"insight":0,"reply_to":"...","over_obvious":"...","x":"...","y":"...","z":"...","relation":"...","surface_like":true,"falsify":"...","now":"...","goal":"...","outcome":"..."}
最后一行是选择：
{"best_index":0,"comparison":"为什么选它，其他方向差在哪"}

规则：
- text 是用户口吻、可直接发送；why 不发送。
- 3-5 条，方向明显不同；至少 1 条是 advance/tool/reframe，全部落在 verify/constrain 视为不合格。
- value = 对目标的推进；novelty = 用户可能没想到；worth_extra_step = 值不值得多这一步。三项 0-10，诚实打分，不要每条都 8 分以上。
- over_obvious 必须回答：相比顺手说“继续/好”，它多得到什么；why 说明这条为什么值得现在发。
- 若所有候选都不比顺手继续更好，只输出一行：{"best_index":null,"comparison":"没有更好的下一步"}。
- 不要编造文件名、数字或结论；不要用“你可以/建议/不妨”这类助手口吻。
- x / y / z / relation / surface_like / falsify 是四拍卡片的字段，规则见 [INSIGHT]；now / goal / outcome 是人话三行，规则见 [PLAIN]；text 就是第四拍的 W，必须能直接发送。
- 只输出这些 JSON 行，不要解释。`

const EN_EXPERT = `You are the user's expert next-move advisor. Do not predict the most likely next line; generate 3-5 genuinely different candidate moves, compare them, and keep only the one most worth sending.

Directions include: advance the next step, use an existing tool or a cheaper path, reframe the problem, verify a key assumption, clarify missing input, constrain scope, or close. Do not default to risk-finding.

Output format: one JSON object per line. No array, no comma-separated list, no markdown, no code fences.
The first 3-5 lines are candidates:
{"text":"...","why":"...","evidence":"...","risk":"...","action":"advance|tool|reframe|verify|clarify|constrain|close","value":0,"novelty":0,"worth_extra_step":0,"insight":0,"reply_to":"...","over_obvious":"...","x":"...","y":"...","z":"...","relation":"...","surface_like":true,"falsify":"...","now":"...","goal":"...","outcome":"..."}
The final line is the selection:
{"best_index":0,"comparison":"why this one, and why the others are weaker"}

Rules:
- text is the user's sendable voice; why is shown, not sent.
- 3-5 moves with clearly different directions; at least one advance/tool/reframe; all verify/constrain is invalid.
- value = progress toward the goal; novelty = what the user likely missed; worth_extra_step = whether it deserves an extra step. Score 0-10 honestly; do not give everything 8+.
- over_obvious must answer: what does it gain over the obvious "continue/ok"? why explains why it is worth sending now.
- If no move beats the obvious next line, output one line: {"best_index":null,"comparison":"no better next move"}.
- Never invent file names, numbers, or conclusions; no assistant voice ("you could", "I suggest").
- x / y / z / relation / surface_like / falsify are the four-beat card fields; the rules are in [INSIGHT]. now / goal / outcome are the plain-language lines; the rules are in [PLAIN]. text is the fourth beat (W) and must be sendable as-is.
- Output only those JSON lines, no commentary.`

/**
 * Clamp one finite integer option.
 * @param {unknown} value - raw configuration value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - value used when the input is not finite.
 * @returns {number} a bounded integer.
 */
function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * Clamp one finite numeric option.
 * @param {unknown} value - raw configuration value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @param {number} fallback - value used when the input is not finite.
 * @returns {number} a bounded number.
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Normalize the profile-provided configuration without trusting its types.
 * @param {Record<string, unknown>} [config] - raw plugin config.
 * @returns {object} validated settings used by the route.
 */
export function normalizeConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  const route = typeof source.routePrefix === 'string' && source.routePrefix.startsWith('/')
    ? source.routePrefix.replace(/\/+$/, '') || DEFAULT_ROUTE
    : DEFAULT_ROUTE
  return {
    enabled: source.enabled !== false,
    provider: typeof source.provider === 'string' ? source.provider.trim() : '',
    model: typeof source.model === 'string' ? source.model.trim() : '',
    count: clampInt(source.count, 1, 4, 4),
    maxTokens: clampInt(source.maxTokens, 80, 2000, 1200),
    expertMaxTokens: clampInt(source.expertMaxTokens, 1000, 8000, 6000),
    expertSituationMaxTokens: clampInt(source.expertSituationMaxTokens, 300, 1600, 800),
    expertMinScore: clampNumber(source.expertMinScore, 0, 12, 5),
    captureSamples: source.captureSamples !== false,
    sampleLimit: clampInt(source.sampleLimit, 10, 200, 50),
    // Cognitive ledger: prompt from an append-only record instead of the window.
    // How much technical shorthand the card may use: auto reads the transcript.
    level: ['auto', 'novice', 'working', 'expert'].includes(source.level) ? source.level : 'auto',
    ledger: source.ledger !== false,
    autoArchive: source.autoArchive !== false,
    ledgerMaxEntries: clampInt(source.ledgerMaxEntries, 40, 400, 160),
    ledgerKeep: clampInt(source.ledgerKeep, 20, 200, 60),
    // USD per 1M tokens; override in the plugin config when the route changes.
    pricing: {
      cacheHit: clampNumber(source?.pricing?.cacheHit, 0, 1000, 0.028),
      cacheMiss: clampNumber(source?.pricing?.cacheMiss, 0, 1000, 0.28),
      output: clampNumber(source?.pricing?.output, 0, 1000, 0.42),
      currency: typeof source?.pricing?.currency === 'string' ? source.pricing.currency.slice(0, 8) : 'USD',
    },
    expertTemperature: clampNumber(source.expertTemperature, 0, 1.5, 0.7),
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high'].includes(source.reasoningEffort)
      ? source.reasoningEffort
      : 'low',
    expertReasoningEffort: ['none', 'minimal', 'low', 'medium', 'high'].includes(source.expertReasoningEffort)
      ? source.expertReasoningEffort
      : 'low',
    expertSituationTimeoutMs: clampInt(source.expertSituationTimeoutMs, 5000, 30000, 12_000),
    expertMovesTimeoutMs: clampInt(source.expertMovesTimeoutMs, 8000, 45000, 25_000),
    temperature: clampNumber(source.temperature, 0, 1.5, 0.8),
    timeoutMs: clampInt(source.timeoutMs, 2000, 20_000, 15_000),
    maxAttempts: clampInt(source.maxAttempts, 1, 2, 2),
    maxBodyBytes: clampInt(source.maxBodyBytes, 4096, 1_048_576, MAX_BODY_BYTES),
    maxMessages: clampInt(source.maxMessages, 4, 24, 12),
    maxChars: clampInt(source.maxChars, 2000, 24_000, MAX_TOTAL_CHARS),
    routePrefix: route,
  }
}

/**
 * Keep only the recent, well-formed, size-bounded conversation turns.
 * Synthetic user-role context is not accepted here; the client sends only
 * human prompts and assistant text.
 * @param {unknown} input - raw transcript from the request body.
 * @param {ReturnType<typeof normalizeConfig>} config - bounds.
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>} sanitized turns.
 */
export function sanitizeTranscript(input, config) {
  if (!Array.isArray(input)) return []
  const recent = input.slice(-config.maxMessages * 2)
  const rows = []
  for (const item of recent) {
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null
    if (role === null) continue
    if (typeof item.text !== 'string') continue
    const text = item.text.replace(/\u0000/g, '').trim()
    if (text === '') continue
    rows.push({ role, text: text.slice(0, 4000) })
  }
  const limited = []
  let total = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    const remaining = config.maxChars - total - 16
    if (remaining <= 0) break
    const text = row.text.length <= remaining ? row.text : row.text.slice(0, remaining)
    if (text === '') break
    limited.push({ role: row.role, text })
    total += text.length + 16
  }
  return limited.reverse()
}

/**
 * Clip one transcript line for the prompt.
 * @param {string} text - line text.
 * @param {number} limit - maximum characters.
 * @returns {string} clipped text.
 */
function clip(text, limit) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim()
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`
}

/**
 * Run one bounded read-only git command.
 * @param {string} cwd - workspace directory.
 * @param {string[]} args - git arguments.
 * @param {number} timeoutMs - kill after this many milliseconds.
 * @param {number} [maxBuffer] - maximum captured bytes.
 * @returns {Promise<string>} stdout, or an empty string on failure.
 */
function runGit(cwd, args, timeoutMs, maxBuffer = 256 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer, windowsHide: true }, (error, stdout) => {
      resolve(error ? '' : String(stdout ?? ''))
    })
  })
}

/**
 * Collect a compact, read-only evidence pack for the expert prompt. The pack
 * never leaves the local machine and is capped before it reaches the model.
 * @param {string} cwd - workspace directory from the session.
 * @returns {Promise<string>} bounded evidence sections.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'vendor', 'coverage', '.cache', 'target'])

/**
 * Read the shape of a project: top-level entries and dependency/script names.
 * Architecture advice needs structure, not just a diff.
 * @param {string} cwd - project directory.
 * @returns {{tree: string, deps: string}} bounded shape strings.
 */
export function readProjectShape(cwd) {
  const entries = []
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (entries.length >= 40) break
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        entries.push(`${entry.name}/`)
      } else {
        entries.push(entry.name)
      }
    }
  } catch {
    // A missing permission is not an error worth surfacing.
  }
  let deps = ''
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    const scripts = Object.keys(pkg.scripts ?? {})
    deps = `deps: ${names.slice(0, 25).join(', ') || '(none)'}\nscripts: ${scripts.slice(0, 12).join(', ') || '(none)'}`
  } catch {
    // No package.json, or not JSON: the tree still carries signal.
  }
  return { tree: entries.join('\n'), deps }
}

export async function collectEvidence(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return '(none)'
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return '(none)'
  } catch {
    return '(none)'
  }
  const [status, stat, staged, log, diff] = await Promise.all([
    runGit(cwd, ['status', '--short'], 1500),
    runGit(cwd, ['diff', '--stat', '--no-color'], 1500),
    runGit(cwd, ['diff', '--cached', '--stat', '--no-color'], 1500),
    runGit(cwd, ['log', '-1', '--oneline'], 1000),
    runGit(cwd, ['diff', '--unified=1', '--no-color'], 2500, 512 * 1024),
  ])
  const parts = []
  const shape = readProjectShape(cwd)
  if (shape.tree !== '') parts.push(`[TREE]\n${clip(shape.tree, 1200)}`)
  if (shape.deps !== '') parts.push(`[DEPS]\n${clip(shape.deps, 800)}`)
  if (status.trim() !== '') parts.push(`[STATUS]\n${clip(status, 2000)}`)
  if (stat.trim() !== '') parts.push(`[DIFF STAT]\n${clip(stat, 2000)}`)
  if (staged.trim() !== '') parts.push(`[STAGED]\n${clip(staged, 2000)}`)
  if (log.trim() !== '') parts.push(`[LAST COMMIT]\n${clip(log, 500)}`)
  if (diff.trim() !== '') parts.push(`[DIFF]\n${clip(diff, 5000)}`)
  return parts.length === 0 ? '(not a git repository or no changes)' : parts.join('\n\n')
}

/**
 * Build the one-shot prediction prompt. Style samples are the user's own
 * recent messages; the thread carries the last few turns.
 * @param {{ transcript: Array<{role: string, text: string}>, cwd?: string, count: number, locale?: string }} input - prompt inputs.
 * @returns {{ system: string, user: string }} model messages.
 */
export function buildPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const count = clampInt(input.count, 1, 4, 4)
  const locale = typeof input.locale === 'string' ? input.locale.toLowerCase() : 'zh'
  const style = transcript
    .filter(row => row.role === 'user')
    .slice(-8)
    .map(row => `- ${clip(row.text, 400)}`)
    .join('\n') || '(none)'
  const thread = transcript
    .slice(-10)
    .map(row => `${row.role}: ${clip(row.text, row.role === 'assistant' ? 1200 : 600)}`)
    .join('\n') || '(none)'
  const context = []
  if (typeof input.cwd === 'string' && input.cwd.trim() !== '') context.push(`cwd=${clip(input.cwd, 300)}`)
  const template = locale.startsWith('zh') ? ZH_SYSTEM : EN_SYSTEM
  return {
    system: template.replaceAll('{{N}}', String(count)),
    user: `[STYLE]\n${style}\n\n[THREAD]\n${thread}\n\n[CTX]\n${context.join('\n') || '(none)'}\n\n[OUT]\nN=${count}, language=${locale.startsWith('zh') ? 'zh' : 'en'}`,
  }
}

/**
 * Parse the model's JSON array of candidate messages.
 * @param {string} text - raw model output.
 * @param {number} count - maximum accepted candidates.
 * @returns {string[]} distinct, bounded candidates.
 * @throws {Error} when no acceptable candidate exists.
 */
export function parseCandidates(text, count) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('prediction returned no text')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start < 0 || end <= start) throw new Error('prediction did not return a JSON array')
    parsed = JSON.parse(raw.slice(start, end + 1))
  }
  if (!Array.isArray(parsed)) throw new Error('prediction did not return a JSON array')
  const limit = clampInt(count, 1, 4, 4)
  const out = []
  for (const item of parsed) {
    const value = typeof item === 'string' ? item : item && typeof item === 'object' ? item.text : ''
    if (typeof value !== 'string') continue
    const candidate = value.replace(/\s+/g, ' ').trim()
    if (candidate === '' || candidate.length > MAX_CANDIDATE_CHARS) continue
    if (out.includes(candidate)) continue
    out.push(candidate)
    if (out.length >= limit) break
  }
  if (out.length === 0) throw new Error('prediction returned no usable candidates')
  return out
}

/**
 * Build the expert situation-model prompt. It asks for a compact decision
 * state, not for advice.
 * @param {{ transcript: Array<{role: string, text: string}>, cwd?: string, evidence?: string, locale?: string }} input - prompt inputs.
 * @returns {{ system: string, user: string }} model messages.
 */
export function buildSituationPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const locale = typeof input.locale === 'string' ? input.locale.toLowerCase() : 'zh'
  const thread = transcript
    .slice(-10)
    .map(row => `${row.role}: ${clip(row.text, row.role === 'assistant' ? 1200 : 600)}`)
    .join('\n') || '(none)'
  const context = []
  if (typeof input.cwd === 'string' && input.cwd.trim() !== '') context.push(`cwd=${clip(input.cwd, 300)}`)
  return {
    system: locale.startsWith('zh') ? ZH_SITUATION : EN_SITUATION,
    user: `[EVIDENCE]\n${clip(input.evidence ?? '(none)', 8000)}\n\n[THREAD]\n${thread}\n\n[CTX]\n${context.join('\n') || '(none)'}`,
  }
}

/**
 * Parse the situation-model JSON object and bound every field.
 * @param {string} text - raw model output.
 * @returns {object} normalized situation fields.
 * @throws {Error} when the output is not a usable JSON object.
 */
export function parseSituation(text) {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('situation model did not return a JSON object')
  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('situation model returned a non-object')
  const string = (value, limit) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
  const list = value => Array.isArray(value)
    ? value.filter(item => typeof item === 'string').map(item => item.replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean).slice(0, 6)
    : []
  const situation = {
    goal: string(parsed.goal, 500),
    success: string(parsed.success, 400),
    assistant_offer: string(parsed.assistant_offer, 600),
    constraints: list(parsed.constraints),
    assumptions: list(parsed.assumptions),
    risks: list(parsed.risks),
    unknowns: list(parsed.unknowns),
    obvious_move: string(parsed.obvious_move, 300),
    blind_spot: string(parsed.blind_spot, 500),
  }
  if (situation.goal === '' && situation.assistant_offer === '') throw new Error('situation model returned no usable fields')
  return situation
}

/**
 * Build a minimal situation when the model refuses to emit JSON. The expert
 * moves pass can still work from the assistant offer and the transcript.
 * @param {Array<{role: string, text: string}>} transcript - recent turns.
 * @returns {object} minimal situation fields.
 */
export function fallbackSituation(transcript) {
  const rows = Array.isArray(transcript) ? transcript : []
  const lastAssistant = [...rows].reverse().find(row => row.role === 'assistant')?.text ?? ''
  return {
    goal: '',
    success: '',
    assistant_offer: clip(lastAssistant, 600),
    constraints: [],
    assumptions: [],
    risks: [],
    unknowns: [],
    obvious_move: '',
    blind_spot: '',
  }
}

/**
 * Build a deterministic situation from the transcript. This replaces the
 * separate situation model call: it removes a JSON failure point and one model
 * request per turn while keeping the evidence and the assistant's last offer.
 * @param {Array<{role: string, text: string}>} transcript - recent turns.
 * @returns {object} bounded situation fields.
 */
export function buildDeterministicSituation(transcript) {
  const rows = Array.isArray(transcript) ? transcript : []
  const users = rows.filter(row => row.role === 'user')
  const lastUser = users.at(-1)?.text ?? ''
  const lastAssistant = [...rows].reverse().find(row => row.role === 'assistant')?.text ?? ''
  const constraints = []
  for (const row of users.slice(-6)) {
    const matches = row.text.match(/(?:先别|不要|别再|只用|只跑|必须|记得|别|不用)[^。！？\n]{0,40}/g) ?? []
    constraints.push(...matches)
  }
  return {
    goal_hint: clip(lastUser, 500),
    success_hint: '',
    assistant_offer: clip(lastAssistant, 600),
    constraints: [...new Set(constraints)].slice(0, 4),
    assumptions: [],
    risks: [],
    unknowns: [],
    obvious_move: '',
    blind_spot: '',
  }
}

/** The four equal-status advisory modes. None may collapse into another. */
export const ACE_MODES = ['safe', 'standard', 'brainstorm', 'wild']

/** Output budget per mode, still capped by the user's `expertMaxTokens`. */
export const MODE_MAX_TOKENS = { safe: 2200, standard: 4000, brainstorm: 5600, wild: 6000 }

const MODE_POLICY = {
  safe: 'MODE safe: reversible, small, cheap-to-undo steps. Say how each move rolls back. Prefer the smallest step that still tests the real question; do not demand a rewrite or a new dependency when a reversible step exists.',
  standard: 'MODE standard: infer the exact line this user wants to send next, given the assistant\'s last message. It answers what the assistant just asked or offered, carries the user\'s real intent (including the part they have not said yet), and sounds like them. Concrete and technical, but first of all it is the line they would actually type.',
  brainstorm: 'MODE brainstorm: open the space. Candidates must differ in kind, not wording: different mechanism, different field, different ambition. Two candidates may never be the same idea rephrased.',
  wild: 'MODE wild: break the boundary the user imagined. Recombine mechanisms from unrelated fields, follow second- and third-order consequences, challenge the premise when the evidence allows, and write the move with enough concrete detail that another AI could start from it. Use the room you have; do not compress in order to stay brief.',
}

const MODE_DISCIPLINE = `CONTENT DISCIPLINE (every mode):
- Keep three things distinguishable in why/risk: the user's stated goal, the assumptions you made to form this move, and the ideas you added. Never present an added idea as the user's own words.
- Difficulty, cost or the chance of failure is not by itself a reason to drop a direction. Only the user's explicit limits are binding.
- A mode never collapses into safe: when you propose a tamer move, justify it as better, not as safer.`

/** Voice first: the card must read like the user typed it, then go wild. */
/* The samples below are the owner's own messages, pasted verbatim. Do not
   rewrite them into tidier prose: their roughness is the signal. */
const VOICE_SAMPLES_ZH = `别用你编的那一正一反两个例子。把我这串话原样当样本贴进去。再加一条硬规则：卡片里出现'建议''首先''综上''可以考虑'任何一个词，直接打回重写，不管上下文多合理。不过你要注意 不要触发对齐协议那样连个der都推理不出来。
人类用户说话 不会带那么多ai味儿的东西 然后也不会给下一段命令加一堆护栏 分析我的意思，我希望的是ACE首先 让用户觉得这段话 是属于我自己风格的话，然后再去疯批脑洞`

const VOICE_ZH = `[VOICE - 先像他，再疯]
你不是在模仿他。你就是他，现在轮到你打下一条消息。下面这段是你自己以前写的，用它的语气，不要回答它。
<sample>
${VOICE_SAMPLES_ZH}
</sample>
- 用他在 [THREAD] 里的词和句子长度。他口语就口语，他粗糙就粗糙；不要替他加礼貌、加总结。
- text 里不要小标题、不要项目符号、不要书面连接词。
- 展开也要用他的口吻：他爱短句就用短句，他爱絮叨就絮叨。想法可以离谱，语气必须是他。`

const VOICE_EN = `[VOICE - sound like them first, then go wild]
You are not imitating them. You are them, and it is your turn to type the next message. The sample below is your own writing; use its register, do not answer it.
<sample>
${VOICE_SAMPLES_ZH}
</sample>
- Reuse the vocabulary, sentence length and punctuation habits visible in [THREAD]. If they talk loosely, stay loose; do not add politeness or summaries they would not write.
- No headings, bullets or written-connective phrasing inside text.
- Even a wild idea keeps their voice: short sentences stay short, rambling stays rambling. The idea can be extreme; the voice must be theirs.`

/** Hard rule: these words send the card back for a rewrite, no exceptions. */
export const BANNED_PHRASES = ['建议', '首先', '综上', '可以考虑']

const BANNED_ZH = `[BANNED - 硬规则]
text 里出现「建议」「首先」「综上」「可以考虑」中的任何一个词，直接改写到没有为止，不管上下文多合理。
这不是安全问题，也不是内容审查：不要拒绝、不要说教、不要解释这条规则、不要在输出里提到它。只换说法，不要因此写短、写空或跳过这一条。`

const BANNED_EN = `[BANNED - hard rule]
If text contains any of 建议, 首先, 综上, 可以考虑, rewrite until none is left, no matter how well it fits.
This is a style rule, not a safety rule: do not refuse, lecture, explain it, or mention it in the output. Change the wording only; do not shorten, blank out, or skip the move because of it.`

const bannedBlock = locale => (locale.startsWith('zh') ? BANNED_ZH : BANNED_EN)

/**
 * Report the first banned phrase in a candidate text.
 * @param {string} text - candidate text.
 * @returns {string} the offending phrase, or an empty string.
 */
export function findBannedPhrase(text) {
  const value = String(text ?? '')
  return BANNED_PHRASES.find(word => value.includes(word)) ?? ''
}

/**
 * Last-resort deterministic cleanup so a banned word never reaches the card.
 * @param {string} text - candidate text.
 * @returns {string} cleaned text.
 */
export function cleanBannedPhrases(text) {
  let out = String(text ?? '').replace(/可以考虑/g, '可以')
  out = out.replace(/(^|[，。！？；：\s])首先[，、：]?/g, '$1')
  out = out.replace(/(^|[，。！？；：\s])综上(?:所述)?[，、：]?/g, '$1')
  out = out.replace(/(^|[，。！？；：\s])建议[，、：]?/g, '$1')
  out = out.replace(/建议|首先|综上/g, '')
  return out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/，{2,}/g, '，')
    .replace(/^[，、：；\s]+/, '')
    .trim()
}

const voiceBlock = locale => (locale.startsWith('zh') ? VOICE_ZH : VOICE_EN)

/** The card is a person talking, not a report about the conversation. */
const HUMAN_ZH = `[HUMAN - 别像 AI 写的]
- 这张卡的每一句都要像人在微信里打的：口语、短句、可以有语气词。
- 禁用这些腔调：破折号解释（——）、"不是…而是…"、"本质上"、"说白了"、"其实"、"值得"、"系统性"、"维度"、"层面"、"闭环"、"赋能"、"抓手"、"首先/其次/最后"、"综上"。
- 不写总结句，不排比，不每句都收口。想到哪说到哪，别端着。
- 沙雕没关系，糙一点没关系，端着才难看。
- text 的验收标准：把这句话单独发到微信群，朋友不会觉得是 AI 写的。
- now / goal / outcome 也用说话的语气，不要写成"当前情况是…""目的是…""预期结果是…"。
- 少用连接词，多用逗号和句号。写不出来就闭嘴，别用漂亮话填。`

const HUMAN_EN = `[HUMAN - do not sound like AI]
- Every line on this card should read like a person typing in a chat: spoken, short, allowed to be rough.
- Banned registers: em-dash explanations, "not X but Y", "essentially", "at its core", "it is worth", "systematic", "dimension", "layer", "closed loop", "empower", "first/second/last", "in summary".
- No summary sentence, no parallel triads, no wrapping every thought with a closing line. Say the thing and stop.
- Slightly dumb or crude is fine. Stiff is not.
- Acceptance for text: paste that one sentence into a group chat and nobody would guess AI wrote it.
- now / goal / outcome are spoken too, not "the current situation is ... / the goal is ... / the expected outcome is ...".
- Fewer connectives, more full stops. If there is nothing to say, say less instead of filling with nice words.`

const humanBlock = locale => (locale.startsWith('zh') ? HUMAN_ZH : HUMAN_EN)

/** A card wins when it is the line the user was about to type anyway. */
const REPLY_ZH = `[REPLY - 读心，不是给建议]
- 先看助手最后一句在问什么、承诺什么、交出了什么；这张卡必须是对它的直接回应，而不是另起一个话题。
- reply_to 抄助手最后一句里被你回应的那一小段原文（6-40 字，逐字，不要改写）。抄不出来，说明这张卡不是在回应他。
- 用户读到卡的感觉应该是"我草，我就是要说这个"：是他此刻真实想说的话，不是更聪明的顾问替他想的话。
- 读完整张卡，用户该先说"对，我就是要发这个"，而不是"这分析真漂亮"。如果 Y/Z 比 W 更抢眼，把 W 写实，别让解释盖过动作。
- 只写他真会打出来的那一句；不要解释、不要列方案、不要替他把话说完。`

const REPLY_EN = `[REPLY - read the mind, not give advice]
- Read the assistant's last message: what is it asking, offering, or handing over? The card must answer that, not start a new topic.
- reply_to quotes the exact fragment of the assistant's last message being answered (6-40 characters, verbatim, no paraphrase). If you cannot quote it, the card is not a reply.
- The user should read it and think "that is exactly what I wanted to say": their real next line, not a smarter advisor's line.
- Reading the whole card, they should first think "yes, that is what I want to send", not "what a clever analysis". If Y or Z outshines W, make W concrete; do not let the explanation outshine the move.
- Write only the line they would type. No explanations, no option lists, no finishing their thought for them.`

const replyBlock = locale => (locale.startsWith('zh') ? REPLY_ZH : REPLY_EN)

const LEVEL_MARKERS = [
  /```/,
  /`[^`]+`/,
  /[\w./-]+\.(?:ts|tsx|js|mjs|json|py|sh|ya?ml)\b/i,
  /\b(?:npm|pnpm|git|api|json|http|server|client|test|bug|log|deploy|cache|db|sql|commit|merge)\b/i,
  /[A-Za-z_][A-Za-z0-9_]*\(/,
  // CJK has no ASCII word boundary, so these must not be wrapped in \b.
  /(?:模块|接口|依赖|并发|缓存|部署|重构|架构|异步|线程|内存|测试|报错|提交|合并|编译)/,
]

/**
 * Guess how technical the user is from their own messages, so the card does not
 * talk over their head (or under it).
 * @param {object[]} transcript - conversation rows.
 * @param {string} [override] - explicit level from config.
 * @returns {'novice'|'working'|'expert'} level.
 */
export function estimateLevel(transcript, override = 'auto') {
  if (override === 'novice' || override === 'working' || override === 'expert') return override
  const rows = (Array.isArray(transcript) ? transcript : []).filter(row => row.role === 'user').slice(-6)
  let score = 0
  for (const row of rows) {
    const text = String(row?.text ?? '')
    for (const marker of LEVEL_MARKERS) if (marker.test(text)) score += 1
    if (text.length > 160) score += 1
  }
  if (rows.length === 0) return 'working'
  if (score <= 1) return 'novice'
  if (score >= 5) return 'expert'
  return 'working'
}

const LEVEL_ZH = {
  novice: `[LEVEL - 这位用户不是工程师] 用日常语言写这张卡：术语第一次出现用半句话解释，一次只给一个动作，给出能直接照做的东西（点哪里、说什么、跑什么）。不要假设他知道文件结构、命令行或缩写。`,
  working: `[LEVEL - 这位用户能读技术内容，但不一定写代码] 可以用常见术语（接口、测试、部署），但要一眼能懂；给具体动作，不要给抽象原则。`,
  expert: `[LEVEL - 这位用户是工程师] 直接用术语和简写，不解释常识，不铺垫；判断要硬，动作要短。`,
}

const LEVEL_EN = {
  novice: `[LEVEL - this user is not an engineer] Write in everyday language. Explain a term the first time it appears in half a sentence, give one action at a time, and make it directly doable (where to click, what to say, what to run). Do not assume they know the file layout, a shell, or an acronym.`,
  working: `[LEVEL - this user reads technical content but may not write code] Common terms (API, test, deploy) are fine when they stay readable; give concrete actions, not abstract principles.`,
  expert: `[LEVEL - this user is an engineer] Use jargon and shorthand, skip the basics, skip the setup; be decisive and short.`,
}

const levelBlock = (locale, level) => (locale.startsWith('zh') ? LEVEL_ZH : LEVEL_EN)[level]

/** The card should carry an insight the user would not have produced alone. */
const INSIGHT_ZH = `[INSIGHT - 用户自己想不到的那一层]
这张卡不是"再给一条建议"，而是把用户已经知道的东西重新排一遍，让他读完后想"对哦，我怎么没想到"。一张卡只放一个新想法，按四拍写。用户最后要看到的是 W——他真正想输入的那句；Y 和 Z 只是让 W 变得"对哦"的解释，不是表演：

1. X 接住那个"一"：x 用他自己的词复述他手上那件具体的事（通常是助手最后一句里他在回应的那句），逐字、具体、不抽象。0-60 字。
2. Y 点出背后那条线：y 用一句人话说清它为什么成、为什么坏。要搬过去的是这条关系（因果或机制），不是表面上像的地方。抽象词最多一个；不写"边界问题""系统性思考""建议考虑可观测性策略"这种挑不出错但没人会按 Tab 的句子。0-140 字。
3. Z 指出"三"在哪：z 给一个同一条线会再次冒出来的具体例子。优先从用户熟悉的领域借，不从炫技的领域借。如果 z 和 x 表面不像，relation 必须用一句话写清这条关系怎么对上（哪一步是同一个机制）；写不出来就换一个例子，不要硬凑。z 0-140 字。
4. W 一个能验收的动作：text 就是这一拍，必须是用户能直接发送的一句话。至少带一个能验收的东西：工程师给文件、命令、测试或阈值；小白给一件能亲眼确认的事（例如"刷新一下，看右上角还报不报红"）。再用 falsify 写清"出现什么结果就说明我错了"（0-90 字）。

字段规则：
- surface_like：z 和 x 表面上是否也像（就在用户眼皮底下）。true 或 false。
- relation：surface_like 为 false 时必填，一句话写清"这跟那个是怎么对上的"——哪一步是同一个机制。句子里要真的点到 X 和 Z 两边，不能把 x 或 z 换个说法再抄一遍。为 true 时可留空。
- 没有 relation、或 relation 只是把 x/z 重写一遍，宿主会直接丢掉这张卡，不给你补写的机会。写不出来就换一个例子，不要硬凑。
- insight（0-10）：Y 那一拍本身的新意。只是"跑个测试、加个日志、改个名字"不超过 3，除非它顺带揭示了一个结构性结论。
- 不按"跳了几层"扣分：远类比往往最值钱（把将军攻城的关系拿去解肿瘤放疗），只要 relation 把关系写清楚。
- y 必须落在真实存在的对象上：模块、文件、依赖、接口、数据形状、失败路径；引用 package.json 里的依赖、目录结构或 diff 里的符号，不要泛泛谈"可维护性"。`

const INSIGHT_EN = `[INSIGHT - the layer the user would not have produced]
This card is not "one more suggestion": it reorders what the user already knows so that reading it makes them think "right, why didn't I see that". One new idea per card, in four beats. The user must end up looking at W - the line they actually wanted to type. Y and Z only explain why W is right; they are not a performance:

1. X catch the "one": x restates the concrete thing in front of the user, in their own words (usually the line of the assistant they are answering). Verbatim, specific, not abstract. 0-60 characters.
2. Y name the line behind it: y explains in one human sentence why it works or fails. What transfers is that relation (cause or mechanism), not surface resemblance. At most one abstraction; never "a boundary problem", "systematic thinking", or "consider an observability strategy" - sentences nobody would press Tab for. 0-140 characters.
3. Z point at where the "three" is: z gives one concrete place the same line shows up again. Prefer the user's own domain over a showy one. If z and x do not look alike on the surface, relation must say in one sentence how the relation maps (which step is the same mechanism); if you cannot write it, pick another example. z 0-140 characters.
4. W one checkable action: text is this beat and must be sendable as-is. It carries at least one thing that can be checked: engineers get a file, command, test or threshold; non-engineers get something they can see with their own eyes ("refresh and look whether the red badge is still there"). falsify says what result would prove the card wrong (0-90 characters).

Field rules:
- surface_like: whether z also resembles x on the surface (right under the user's nose). true or false.
- relation: required when surface_like is false; one sentence on how it maps - which step is the same mechanism. It must actually name both sides, not restate x or z in other words. Optional when true.
- With no relation, or a relation that only rewrites x/z, the host drops the card; there is no second try. Pick another example instead of forcing one.
- insight (0-10): the novelty of the Y beat alone. "Run a test, add a log, rename a thing" is at most 3 unless it also exposes a structural conclusion.
- Do not penalize distance: far analogies are often the most valuable (a besieging army's relation used for tumor radiotherapy) as long as relation maps it.
- y must land on real objects: modules, files, dependencies, interfaces, data shapes, failure paths. Cite a dependency in package.json, a directory in the tree, or a symbol in the diff; do not wave at "maintainability".`

const insightBlock = locale => (locale.startsWith('zh') ? INSIGHT_ZH : INSIGHT_EN)

/** A card has to explain itself in plain language before it asks for Tab. */
const PLAIN_ZH = `[PLAIN - 人话三行，每张卡必须有]
一张卡要让用户在十秒内回答三个问题：现在是什么情况、这一步为了什么、做完会得到什么。每条候选都要写 now / goal / outcome，缺一条这张卡不出。

- now：现在发生了什么、卡在哪。用他看得见的现象说，不写内部机制（"点保存没反应"，不是"持久化层异常"）。0-100 字。
- goal：这一步是为了拿到什么结果。说目的，不说动作（"确认是不是重试在掩盖失败"，不是"改掉 retry 参数"）。0-100 字。
- outcome：做完之后他会看到或拿到什么，写到他可以自己判断"这是不是我要的"。修复就写哪里会变好；探索就写会拿到哪些选项。0-120 字。
- 三行都用日常语言：不用未解释的缩写、模块名、命令、函数名。text（W）也一样——读者是这个 level 的人，不是你的同事。
- 这三行不是复述 text，而是让 text 变得可判断：他读完应该能决定按不按 Tab。`

const PLAIN_EN = `[PLAIN - three plain lines on every card]
A card has to let the user answer three questions in ten seconds: what is happening now, what this step is for, and what they get after it. Every candidate writes now / goal / outcome; with one missing the card is dropped.

- now: what is happening and where it is stuck, in symptoms the user can see. Not internal mechanics ("saving does nothing", not "the persistence layer throws").
- goal: the result this step is for, not the action ("find out whether the retry hides the failure", not "change the retry flag").
- outcome: what the user will see or get afterwards, specific enough for them to judge "is this what I want". A fix says what gets better; an exploration says which options they end up with.
- All three use everyday language: no unexplained acronyms, module names, commands or function names. The same goes for text (W) - the reader is a person at this level, not your coworker.
- These lines do not restate text; they make text judgeable. After reading them the user should know whether to press Tab.`

const plainBlock = locale => (locale.startsWith('zh') ? PLAIN_ZH : PLAIN_EN)

/** Every card is a technical next prompt, not a vibe. Static so it caches. */
const TECH_ZH = `[TECH - 这张卡是一句能直接开工的下一轮 prompt]
- text 必须带一个能验收的东西：工程师给文件、命令、参数、测试或阈值；小白给一件他能亲眼确认的事（点哪里、说什么、刷新后看什么）。不要"优化一下""再看看""继续推进"这种空话。
- 先站住一个推理：从对话或证据里的具体对象（报错、文件名、数字、行为）推出一个缺口，这一步就是为了补它。why 用一句话说清这条推理，不要复述常识。
- 证据不够时，在 text 或 why 里写明你在假设什么（例如"先假设重试是测试里加的"），不要把猜测写成事实。
- standard 和 brainstorm 优先给"做完就能验证"的一步；wild 可以大，但要大到能拆成具体动作。`

const TECH_EN = `[TECH - this card is a next prompt the user can send as-is]
- text must carry one checkable thing: engineers get a file, command, flag, test or threshold; non-engineers get something they can see for themselves (where to click, what to say, what to look at after a refresh). No "polish it", "take another look", or "keep going".
- Stand on a reason: infer a specific gap from a named object in the conversation or evidence (an error, a file, a number, a behavior), and make this step close that gap. why states the inference in one line, not common sense.
- When the evidence is thin, write the assumption into text or why ("assuming the retry lives in the test"), never as fact.
- standard and brainstorm prefer a step whose result is checkable; wild may be big, but big enough to break into concrete actions.`

const techBlock = locale => (locale.startsWith('zh') ? TECH_ZH : TECH_EN)

/** The output contract is restated last so a long mode prompt cannot bury it. */
const FORMAT_BLOCK = `[FORMAT - binding]
- Output one JSON object per line, each one complete and closed on the same line. No prose, markdown, headings or code fences outside the objects.
- Keep text under 600 characters, x under 60, y and z under 140, relation under 120, falsify under 90, why under 160, risk under 160. If room runs short, shorten text first; never drop a closing brace to fit more detail.
- If you cannot produce a schema-valid object, output a single line of plain text with your best next move instead of inventing fields; the host will salvage it.`

/** Resolve a request's mode to one of the four, defaulting to standard. */
export function resolveMode(value) {
  const text = typeof value === 'string' ? value.trim() : value
  return ACE_MODES.includes(text) ? text : 'standard'
}

/**
 * Describe a failed answer by shape only, so diagnostics never store transcript-like text.
 * @param {string} text - raw model output.
 * @returns {{chars: number, opens: number, closes: number, fenced: boolean, startsWithBrace: boolean}} shape.
 */
function describeShape(text) {
  const value = String(text ?? '')
  return {
    chars: value.length,
    opens: (value.match(/\{/g) ?? []).length,
    closes: (value.match(/\}/g) ?? []).length,
    fenced: /```/.test(value),
    startsWithBrace: value.trim().startsWith('{'),
  }
}

/**
 * Turn a prose answer into one usable move instead of failing the whole card.
 * @param {string} text - raw model output.
 * @returns {object | null} move, or null when there is nothing to salvage.
 */
export function salvageExpertText(text) {
  const cleaned = String(text ?? '')
    .replace(/```[a-zA-Z]*\s*/g, '')
    .replace(/^\s*(?:-{3,}|#{1,6}\s*$)/gm, '')
    .trim()
  if (cleaned.length < 40) return null
  return {
    text: clip(cleaned, 2000),
    why: '', evidence: '', risk: '',
    action: 'advance', value: 6, novelty: 6, worth_extra_step: 6,
    slot: 'non_obvious', over_obvious: true,
  }
}

/** Keep the transcript append-only for as long as possible: provider prefix
 * caching only pays off when the bytes before the volatile tail stay identical.
 * Trim in blocks so a sliding window does not invalidate the cache every turn. */
export const TRANSCRIPT_MAX_MESSAGES = 24
export const TRANSCRIPT_TRIM_BLOCK = 8
export const TRANSCRIPT_MAX_CHARS = 8000
export const TRANSCRIPT_MIN_MESSAGES = 6

/**
 * Select the transcript window: trim in blocks so the cached prefix survives
 * several turns, then enforce a character budget from the front.
 * @param {object[]} transcript - conversation rows.
 * @returns {object[]} stable window.
 */
export function transcriptWindow(transcript) {
  const rows = Array.isArray(transcript) ? transcript : []
  let start = 0
  if (rows.length > TRANSCRIPT_MAX_MESSAGES) {
    const over = rows.length - TRANSCRIPT_MAX_MESSAGES
    start = Math.ceil(over / TRANSCRIPT_TRIM_BLOCK) * TRANSCRIPT_TRIM_BLOCK
  }
  // Measure what actually gets rendered, not the raw message.
  const size = row => Math.min(String(row?.text ?? '').length, row?.role === 'assistant' ? 1000 : 500)
  let total = rows.slice(start).reduce((sum, row) => sum + size(row), 0)
  // Drop in blocks here too: a one-message slide every turn would invalidate the
  // cached prefix just as surely as a sliding window over the whole history.
  while (total > TRANSCRIPT_MAX_CHARS) {
    const maxDrop = rows.length - start - TRANSCRIPT_MIN_MESSAGES
    if (maxDrop <= 0) break
    const drop = Math.min(TRANSCRIPT_TRIM_BLOCK, maxDrop)
    for (let step = 0; step < drop; step += 1) total -= size(rows[start + step])
    start += drop
  }
  return rows.slice(start)
}

/**
 * Build the expert next-move prompt from the deterministic situation and evidence.
 * @param {{ situation: object, transcript: Array<object>, evidence?: string, count: number, locale?: string }} input - prompt inputs.
 * @returns {{ system: string, user: string }} model messages.
 */
export function buildExpertPrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const count = clampInt(input.count, 3, 5, 4)
  const locale = typeof input.locale === 'string' ? input.locale.toLowerCase() : 'zh'
  const mode = resolveMode(input.mode)
  const thread = transcriptWindow(transcript)
    .map(row => `${row.role}: ${clip(row.text, row.role === 'assistant' ? 1000 : 500)}`)
    .join('\n') || '(none)'
  return {
    system: locale.startsWith('zh') ? ZH_EXPERT : EN_EXPERT,
    user: `${MODE_DISCIPLINE}\n\n${voiceBlock(locale)}\n\n${humanBlock(locale)}\n\n${bannedBlock(locale)}\n\n${techBlock(locale)}\n\n${insightBlock(locale)}\n\n${plainBlock(locale)}\n\n${replyBlock(locale)}\n\n${FORMAT_BLOCK}\n\n[THREAD]\n${thread}\n\n[MODE]\n${MODE_POLICY[mode]}\n\n${levelBlock(locale, input.level ?? 'working')}\n\n[SITUATION]\n${JSON.stringify(input.situation ?? {}, null, 2)}\n\n[EVIDENCE]\n${clip(input.evidence ?? '(none)', 8000)}\n\n[OUT]\nN=${count}, mode=${mode}, language=${locale.startsWith('zh') ? 'zh' : 'en'}`,
  }
}

/**
 * Build the compact one-object retry prompt used when the full 3-5 candidate
 * call returns no text. The normal path still generates and scores multiple
 * directions; this is a bounded rescue, not the default.
 * @param {{ situation: object, transcript: Array<object>, evidence?: string, locale?: string }} input - prompt inputs.
 * @returns {{ system: string, user: string }} model messages.
 */
export function buildSingleMovePrompt(input) {
  const transcript = Array.isArray(input.transcript) ? input.transcript : []
  const locale = typeof input.locale === 'string' ? input.locale.toLowerCase() : 'zh'
  const thread = transcriptWindow(transcript)
    .map(row => `${row.role}: ${clip(row.text, row.role === 'assistant' ? 800 : 400)}`)
    .join('\n') || '(none)'
  const system = locale.startsWith('zh')
    ? `你是 ACE。先在内部比较 3 个方向（推进、用现成工具/更省事、重新框定），只输出一个最值得用户发送的 JSON 对象。没有比顺手继续更好的，就输出 {"best_index":null,"comparison":"没有更好的下一步"}。
JSON 对象字段：text, why, evidence, risk, action, value, novelty, worth_extra_step, over_obvious, x, y, z, relation, surface_like, falsify, now, goal, outcome。
不要数组、不要多行对象、不要 markdown。text 用用户口吻，可直接发送；why 不发送；不要编造。`
    : `You are ACE. Compare 3 directions internally (advance, existing tool/cheaper path, reframe) and output only the one JSON object most worth sending. If nothing beats the obvious next line, output {"best_index":null,"comparison":"no better next move"}.
JSON fields: text, why, evidence, risk, action, value, novelty, worth_extra_step, over_obvious, x, y, z, relation, surface_like, falsify, now, goal, outcome.
No array, no multi-line objects, no markdown. text is the user's sendable voice; why is shown, not sent; never invent.`
  return {
    system,
    user: `${MODE_DISCIPLINE}\n\n${voiceBlock(locale)}\n\n${humanBlock(locale)}\n\n${bannedBlock(locale)}\n\n${techBlock(locale)}\n\n${insightBlock(locale)}\n\n${plainBlock(locale)}\n\n${replyBlock(locale)}\n\n${FORMAT_BLOCK}\n\n[THREAD]\n${thread}\n\n[MODE]\n${MODE_POLICY[resolveMode(input.mode)]}\n\n${levelBlock(locale, input.level ?? 'working')}\n\n[SITUATION]\n${JSON.stringify(input.situation ?? {}, null, 2)}\n\n[EVIDENCE]\n${clip(input.evidence ?? '(none)', 6000)}\n\n[OUT]\nN=1`,
  }
}

/**
 * Extract balanced JSON objects from arbitrary model text. This tolerates
 * line-delimited JSON, a legacy array, code fences, and a truncated final line.
 * @param {string} raw - raw model text.
 * @returns {string[]} balanced object substrings.
 */
function extractJsonObjects(raw) {
  const objects = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if (char === '}' && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(raw.slice(start, index + 1))
        start = -1
      }
    }
  }
  return objects
}

/**
 * Parse the expert selection object, JSONL lines, or a legacy array of moves.
 * A malformed/truncated line is skipped without discarding valid earlier lines.
 * @param {string} text - raw model output.
 * @param {number} [count] - maximum accepted moves.
 * @returns {{ moves: object[], bestIndex: number | null, comparison: string }} selection.
 * @throws {Error} when the output has no usable JSON object.
 */
/**
 * The host decides whether the relation beat is written, not the model.
 * A mapping has to be its own sentence that names the shared mechanism; a
 * rewrite of X or Z is not a mapping. `null` keeps legacy candidates (no z)
 * on the old path, `false` drops the card.
 * @param {{x?: string, z?: string, relation?: string, surfaceLike?: boolean|null}} input - beats.
 * @returns {boolean|null} verdict.
 */
export function judgeRelation({ x = '', z = '', relation = '', surfaceLike = null } = {}) {
  if (String(z ?? '').trim() === '') return false
  // A surface-alike example is already visible; it does not need a mapping line.
  if (surfaceLike === true) return true
  const text = String(relation ?? '').trim()
  if (text === '') return false
  if (text.length < 6) return false
  const grams = value => {
    const flat = String(value ?? '').replace(/\s+/g, '')
    const out = new Set()
    for (let index = 0; index < flat.length - 1; index += 1) out.add(flat.slice(index, index + 2))
    return out
  }
  const similarity = (left, right) => {
    const a = grams(left)
    const b = grams(right)
    if (a.size === 0 || b.size === 0) return 0
    let shared = 0
    for (const gram of a) if (b.has(gram)) shared += 1
    return (2 * shared) / (a.size + b.size)
  }
  // A rewrite of the example or the anchor is not an explanation of how they map.
  if (similarity(text, x) > 0.75 || similarity(text, z) > 0.75) return false
  // It has to say the two things are the same kind of thing.
  const connectors = /(都是|也是|同样|一样|因为|所以|相当于|同一个|同一|对应|映射|只是|跟.{0,12}一样|和.{0,12}一样|\bsame\b|\bboth\b|\bbecause\b|shared|maps? to)/i
  return connectors.test(text)
}

export function parseExpertSelection(text, count = 5) {
  const raw = String(text ?? '').trim()
  const objects = []
  for (const chunk of extractJsonObjects(raw)) {
    try {
      objects.push(JSON.parse(chunk))
    } catch {
      // Keep earlier valid lines; a truncated later line must not discard them.
    }
  }
  if (objects.length === 0) throw new Error('expert advisor did not return a usable JSON object')
  let bestIndex = null
  let comparison = ''
  const rawMoves = []
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) continue
    if (Array.isArray(object.moves)) rawMoves.push(...object.moves)
    else if (typeof object.text === 'string') rawMoves.push(object)
    if (Number.isInteger(object.best_index)) bestIndex = object.best_index
    if (typeof object.comparison === 'string') comparison = object.comparison
  }
  comparison = clip(comparison.replace(/\s+/g, ' ').trim(), 400)
  const limit = clampInt(count, 1, 5, 5)
  const actions = new Set(['advance', 'tool', 'reframe', 'verify', 'clarify', 'constrain', 'close'])
  const normalizeScore = value => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.min(10, Math.max(0, number)) : 5
  }
  const moves = []
  const seen = new Set()
  const asText = (value, limit) => typeof value === 'string'
    ? clip(value.replace(/\s+/g, ' ').trim(), limit)
    : ''
  for (const item of rawMoves) {
    if (moves.length >= limit) break
    const object = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    const value = typeof item === 'string' ? item : object.text
    if (typeof value !== 'string') continue
    const candidate = value.replace(/\s+/g, ' ').trim()
    if (candidate === '' || candidate.length > MAX_EXPERT_TEXT) continue
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const overObvious = typeof object.over_obvious === 'string'
      ? object.over_obvious.replace(/\s+/g, ' ').trim()
      : ''
    // Four-beat card fields. A candidate that carries none of them stays on the
    // legacy path so older prompts and stored samples keep working.
    const x = asText(object.x, MAX_EXPERT_ANCHOR)
    const y = asText(object.y, MAX_EXPERT_LINE)
    const z = asText(object.z, MAX_EXPERT_EXAMPLE)
    const relation = asText(object.relation, MAX_EXPERT_RELATION)
    const falsify = asText(object.falsify, MAX_EXPERT_FALSIFY)
    // Y is the human line; on a four-beat card it doubles as why.
    const why = (typeof object.why === 'string' ? object.why.replace(/\s+/g, ' ').trim() : overObvious) || y
    if (why === '') continue
    const surfaceLike = typeof object.surface_like === 'boolean' ? object.surface_like : null
    // The four-beat path is active when the model answered with beats. The host
    // judges the mapping itself; model-provided scores are not used.
    const relationPresent = ('z' in object) || ('relation' in object) || ('surface_like' in object)
    const relationOk = relationPresent ? judgeRelation({ x, z, relation, surfaceLike }) : null
    // Plain-language lines: without all three the card cannot be judged.
    const now = asText(object.now, MAX_EXPERT_NOW)
    const goal = asText(object.goal, MAX_EXPERT_GOAL)
    const outcome = asText(object.outcome, MAX_EXPERT_OUTCOME)
    const plainPresent = ('now' in object) || ('goal' in object) || ('outcome' in object)
    const plainOk = plainPresent
      ? (now !== '' && goal !== '' && outcome !== '' && now.length >= 4 && goal.length >= 4 && outcome.length >= 4)
      : null
    moves.push({
      text: candidate,
      why: clip(why, MAX_EXPERT_WHY),
      evidence: typeof object.evidence === 'string' ? clip(object.evidence.replace(/\s+/g, ' ').trim(), MAX_EXPERT_EVIDENCE) : '',
      risk: typeof object.risk === 'string' ? clip(object.risk.replace(/\s+/g, ' ').trim(), MAX_EXPERT_RISK) : '',
      over_obvious: clip(overObvious, MAX_EXPERT_WHY),
      action: actions.has(object.action) ? object.action : 'advance',
      value: normalizeScore(object.value),
      novelty: normalizeScore(object.novelty),
      worth_extra_step: normalizeScore(object.worth_extra_step ?? object.worth),
      insight: normalizeScore(object.insight),
      reply_to: typeof object.reply_to === 'string' ? clip(object.reply_to.replace(/\s+/g, ' ').trim(), MAX_EXPERT_REPLY) : '',
      slot: typeof object.slot === 'string' ? object.slot : '',
      x,
      y,
      z,
      relation,
      falsify,
      surface_like: surfaceLike,
      relation_present: relationPresent,
      // `null` means "legacy candidate, not judged"; `false` drops the card.
      relation_ok: relationOk,
      now,
      goal,
      outcome,
      plain_present: plainPresent,
      plain_ok: plainOk,
    })
  }
  return { moves, bestIndex, comparison }
}

/**
 * Legacy array-shaped parser kept for callers that only need moves.
 * @param {string} text - raw model output.
 * @param {number} count - maximum accepted moves.
 * @returns {object[]} parsed moves.
 */
export function parseExpertMoves(text, count) {
  return parseExpertSelection(text, count).moves
}

/**
 * Score one move for the single-card selection. The model scores value and
 * novelty; the host adds an action prior so "check again" cannot win by default.
 * @param {object} move - parsed move.
 * @returns {number} 0-14ish composite score.
 */
/**
 * Count concrete anchors in a card: files, commands, flags, numbers, calls.
 * Vague prose scores zero and loses ties to a step the user can actually run.
 * @param {string} text - candidate text.
 * @returns {number} number of distinct anchors (capped at 3).
 */
export function countAnchors(text) {
  const value = String(text ?? '')
  const patterns = [
    /`[^`]+`/g,
    /[\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|md|py|sh|rs|go|java|toml)\b/gi,
    /\b(?:npm|pnpm|yarn|node|git|rg|grep|curl|pytest|make|cargo|go|docker)\b/g,
    /--[a-z][a-z-]*/g,
    /\b\d+(?:\.\d+)?\b/g,
    /[A-Za-z_][\w.]*\([^)]*\)/g,
    /(?:^|\s)[~/][\w./-]+/g,
  ]
  const found = new Set()
  for (const pattern of patterns) {
    for (const match of value.match(pattern) ?? []) found.add(match.trim().toLowerCase())
  }
  return Math.min(3, found.size)
}

/**
 * Does the quoted fragment actually appear in the assistant's last message?
 * @param {string} quote - candidate reply_to.
 * @param {string} assistant - assistant's last message.
 * @returns {boolean|null} true/false when a quote exists, null when omitted.
 */
export function repliesTo(quote, assistant) {
  const normalize = value => String(value ?? '').replace(/\s+/g, '').replace(/[“”"'`。，、；：！？.,;:!?()（）]/g, '').toLowerCase()
  const q = normalize(quote)
  if (q.length < 4) return null
  return normalize(assistant).includes(q)
}

export function scoreMove(move) {
  const actionBonus = {
    advance: 1.2,
    tool: 1.2,
    reframe: 1.1,
    clarify: 0.5,
    verify: 0.3,
    constrain: 0.1,
    close: 0.2,
  }[move.action] ?? 0
  const riskPenalty = move.action === 'verify' || move.action === 'constrain' ? 0.8 : 0
  return move.value * 0.45
    + move.novelty * 0.25
    + move.worth_extra_step * 0.2
    + actionBonus
    - riskPenalty
    + (move.evidence ? 0.2 : 0)
    + (move.over_obvious ? 0.2 : 0)
    + Math.min(1.2, countAnchors(move.text) * 0.4)
    + (move.insight ?? 5) * 0.2
    + (move.reply_ok === true ? 0.8 : 0)
    - (move.reply_ok === false ? 0.5 : 0)
}

/**
 * Choose the single best move, honoring a sane model pick as a tie-breaker.
 * @param {{ moves: object[], bestIndex: number | null, comparison: string }} selection - parsed selection.
 * @param {number} minScore - minimum score for showing a card.
 * @returns {object | null} the selected move, or null when no move clears the gate.
 */
export function selectBestMove(selection, minScore = 5) {
  if (!Array.isArray(selection.moves) || selection.moves.length === 0) return null
  // A card with no written mapping is not a card: the host judged the relation
  // itself. Legacy candidates (no four-beat fields) pass.
  const usable = selection.moves
    .map((move, index) => ({ move, index }))
    .filter(({ move }) => move.relation_ok !== false && move.plain_ok !== false)
  if (usable.length === 0) return null
  const scored = usable.map(({ move, index }) => ({
    ...move,
    index,
    score: scoreMove(move) + (selection.bestIndex === index ? 0.35 : 0),
  }))
  scored.sort((left, right) => right.score - left.score)
  const top = scored[0]
  const modelBest = selection.bestIndex === null ? null : scored.find(move => move.index === selection.bestIndex)
  const chosen = modelBest && modelBest.score >= top.score - 0.35 ? modelBest : top
  if (chosen.score < minScore) return null
  const baseWhy = chosen.why || chosen.y || ''
  const why = chosen.over_obvious && !baseWhy.includes(chosen.over_obvious)
    ? clip(`${baseWhy}；${chosen.over_obvious}`, MAX_EXPERT_WHY)
    : baseWhy
  return {
    text: chosen.text,
    why,
    evidence: chosen.evidence,
    risk: chosen.risk,
    intent: chosen.action,
    score: Number(chosen.score.toFixed(2)),
    comparison: selection.comparison,
    // The four beats travel with the card; the client renders them in order.
    x: chosen.x ?? '',
    y: chosen.y ?? '',
    z: chosen.z ?? '',
    relation: chosen.relation ?? '',
    falsify: chosen.falsify ?? '',
    relation_ok: chosen.relation_ok ?? null,
    now: chosen.now ?? '',
    goal: chosen.goal ?? '',
    outcome: chosen.outcome ?? '',
  }
}

/**
 * Resolve the provider/model route for the prediction call. The active
 * agent-default selection wins; explicit config overrides it; the profile's
 * standard DeepSeek account route is the last-resort fallback.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @returns {{ provider: string, model: string }} model route.
 */
export function resolveModel(ctx, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  const read = () => {
    try {
      return ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
    } catch {
      return undefined
    }
  }
  const service = read()
  let selection
  try {
    selection = service?.currentSelection?.()
  } catch {
    selection = undefined
  }
  if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string'
    && selection.provider !== '' && selection.model !== '') {
    return { provider: selection.provider, model: selection.model }
  }
  return { provider: 'deepseek-account', model: 'deepseek-flash' }
}

/**
 * Read one JSON request body with a hard byte cap.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} maxBytes - inclusive byte cap.
 * @returns {Promise<unknown>} parsed JSON body.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        const error = new Error('request body too large')
        error.status = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch {
        const error = new Error('request body is not valid JSON')
        error.status = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Write one JSON envelope.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON body.
 */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Normalise whatever token fields the provider returns.
 * @param {object} usage - provider usage object.
 * @returns {{inputTokens: number, outputTokens: number, hitTokens: number, missTokens: number, cacheKnown: boolean}} normalised usage.
 */
export function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {}
  const num = key => (typeof source[key] === 'number' && Number.isFinite(source[key]) ? source[key] : 0)
  const pick = keys => {
    for (const key of keys) if (num(key) > 0) return num(key)
    return 0
  }
  const inputTokens = pick(['prompt_tokens', 'inputTokens', 'promptTokens', 'input_tokens'])
  const outputTokens = pick(['completion_tokens', 'outputTokens', 'completionTokens', 'output_tokens'])
  const hitTokens = pick(['prompt_cache_hit_tokens', 'cacheHitTokens', 'cachedInputTokens', 'cached_tokens', 'promptCacheHitTokens'])
  let missTokens = pick(['prompt_cache_miss_tokens', 'cacheMissTokens', 'promptCacheMissTokens'])
  const cacheKnown = hitTokens > 0 || missTokens > 0
  if (cacheKnown && missTokens === 0 && inputTokens >= hitTokens) missTokens = inputTokens - hitTokens
  if (!cacheKnown && inputTokens > 0) missTokens = inputTokens
  return { inputTokens, outputTokens, hitTokens, missTokens, cacheKnown }
}

/**
 * Turn token counts into money with the configured per-million prices.
 * @param {object} usage - provider usage object.
 * @param {{cacheHit: number, cacheMiss: number, output: number, currency?: string}} pricing - prices per 1M tokens.
 * @returns {{cost: number, currency: string, hitRate: number, inputTokens: number, outputTokens: number, hitTokens: number, missTokens: number, cacheKnown: boolean}} cost row.
 */
export function usageCost(usage, pricing) {
  const normal = normalizeUsage(usage)
  const prices = pricing && typeof pricing === 'object' ? pricing : {}
  const cacheHit = typeof prices.cacheHit === 'number' ? prices.cacheHit : 0.028
  const cacheMiss = typeof prices.cacheMiss === 'number' ? prices.cacheMiss : 0.28
  const output = typeof prices.output === 'number' ? prices.output : 0.42
  const cost = (normal.hitTokens * cacheHit + normal.missTokens * cacheMiss + normal.outputTokens * output) / 1_000_000
  return {
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    currency: typeof prices.currency === 'string' ? prices.currency : 'USD',
    hitRate: normal.inputTokens > 0 ? Math.round((normal.hitTokens / normal.inputTokens) * 1000) / 1000 : 0,
    ...normal,
  }
}

/**
 * Keep the last N expert predictions locally so the score threshold can be
 * swept offline instead of experimented on in live chats. Content stays in the
 * local diagnostics directory; set `captureSamples: false` to turn it off.
 * @param {{ sessionId?: string, style?: string, mode?: string, locale?: string,
 *   count?: number, threshold?: number, shown?: boolean, bestIndex?: number|null,
 *   promptChars?: number, rawText?: string, moves?: object[] }} sample - one prediction.
 * @param {{ limit?: number }} [options] - ring size.
 */
export function captureSample(sample, options = {}) {
  try {
    const home = process.env.DSH_HOME
    if (!home) return
    const directory = join(home, 'diagnostics')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'dsh-ace-samples.jsonl')
    const limit = clampInt(options.limit, 10, 200, 50)
    const row = {
      at: new Date().toISOString(),
      sessionId: typeof sample.sessionId === 'string' ? sample.sessionId.slice(0, 200) : 'anonymous',
      style: sample.style ?? '',
      mode: sample.mode ?? '',
      level: sample.level ?? '',
      locale: sample.locale ?? '',
      count: sample.count ?? 0,
      threshold: sample.threshold ?? 0,
      shown: sample.shown === true,
      bestIndex: Number.isInteger(sample.bestIndex) ? sample.bestIndex : null,
      promptChars: sample.promptChars ?? 0,
      lastUser: clip(sample.lastUser ?? '', 300),
      rawText: clip(sample.rawText ?? '', 16_000),
      moves: Array.isArray(sample.moves) ? sample.moves.slice(0, 5).map(move => ({
        text: clip(move?.text ?? '', 800),
        why: clip(move?.why ?? '', 400),
        risk: clip(move?.risk ?? '', 300),
        evidence: clip(move?.evidence ?? '', 300),
        action: move?.action ?? '',
        value: Number(move?.value) || 0,
        novelty: Number(move?.novelty) || 0,
        worth_extra_step: Number(move?.worth_extra_step) || 0,
        insight: Number(move?.insight) || 0,
        slot: move?.slot ?? '',
      })) : [],
    }
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length > limit) writeFileSync(file, lines.slice(-limit).join('\n') + '\n', 'utf8')
  } catch {
    // Sampling must never break a prediction.
  }
}

/**
 * Re-score stored samples at different thresholds without any model call.
 * @param {object[]} samples - captured prediction rows.
 * @param {number[]} thresholds - score thresholds to compare.
 * @returns {{threshold: number, cards: number, gained: number, silent: number}[]} per-threshold counts.
 */
export function sweepThresholds(samples, thresholds) {
  const rows = Array.isArray(samples) ? samples : []
  const baseline = rows.filter(row => row.shown === true).length
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return (Array.isArray(thresholds) ? thresholds : []).map(threshold => {
    let cards = 0
    for (const row of rows) {
      const moves = Array.isArray(row.moves) ? row.moves : []
      if (moves.length === 0) continue
      const best = selectBestMove({ moves, bestIndex: Number.isInteger(row.bestIndex) ? row.bestIndex : null, comparison: '' }, threshold)
      if (!best) continue
      if (best.text.trim() === '') continue
      if (normalize(best.text) === normalize(row.lastUser ?? '')) continue
      cards += 1
    }
    return { threshold, cards, gained: cards - baseline, silent: rows.length - cards }
  })
}

/**
 * Append one usage row: numbers only, so cache hits are visible without content.
 * @param {{ status?: string, mode?: string, style?: string, promptChars?: number, usage?: object }} event - usage fields.
 */
// ---------------------------------------------------------------------------
// Cognitive ledger (kept in this file on purpose: the host half is installed as
// a hard-linked copy, so a new sibling module would not exist at runtime).
// ---------------------------------------------------------------------------

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

export function logUsage(event) {
  try {
    const home = process.env.DSH_HOME
    if (!home) return
    const directory = join(home, 'diagnostics')
    mkdirSync(directory, { recursive: true })
    const usage = event.usage && typeof event.usage === 'object' ? event.usage : {}
    const numeric = {}
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) numeric[key] = value
    }
    const money = usageCost(usage, event.pricing)
    const file = join(directory, 'dsh-ace-usage.jsonl')
    // Turns are counted per session and survive a restart: the first write in a
    // fresh process rebuilds the counters from the file it is appending to.
    const index = usageIndex(dirname(file))
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId.slice(0, 200) : 'anonymous'
    const entry = index.get(sessionId) ?? { turns: 0, cost: 0 }
    entry.turns += 1
    entry.cost = Math.round((entry.cost + money.cost) * 1_000_000) / 1_000_000
    index.set(sessionId, entry)
    appendFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      sessionId,
      turnIndex: entry.turns,
      sessionTurns: entry.turns,
      sessionCost: entry.cost,
      status: event.status ?? '',
      mode: event.mode ?? '',
      style: event.style ?? '',
      promptChars: typeof event.promptChars === 'number' ? event.promptChars : 0,
      usage: numeric,
      cost: money.cost,
      currency: money.currency,
      prices: {
        cacheHit: typeof event.pricing?.cacheHit === 'number' ? event.pricing.cacheHit : 0.028,
        cacheMiss: typeof event.pricing?.cacheMiss === 'number' ? event.pricing.cacheMiss : 0.28,
        output: typeof event.pricing?.output === 'number' ? event.pricing.output : 0.42,
      },
      hitRate: money.hitRate,
      inputTokens: money.inputTokens,
      outputTokens: money.outputTokens,
      hitTokens: money.hitTokens,
      missTokens: money.missTokens,
      cacheKnown: money.cacheKnown,
    }) + '\n', 'utf8')
  } catch {
    // Usage logging must never break a prediction.
  }
}

/** Per-directory session counters, rebuilt from the usage file on first write. */
const usageIndexes = new Map()

function usageIndex(directory) {
  const cached = usageIndexes.get(directory)
  if (cached) return cached
  const index = new Map()
  try {
    const file = join(directory, 'dsh-ace-usage.jsonl')
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        if (typeof row?.sessionId !== 'string') continue
        const previous = index.get(row.sessionId) ?? { turns: 0, cost: 0 }
        previous.turns = Math.max(previous.turns, Number(row.sessionTurns) || Number(row.turnIndex) || 0)
        previous.cost = Math.max(previous.cost, Number(row.sessionCost) || 0)
        index.set(row.sessionId, previous)
      }
    }
  } catch {
    // A corrupt line should not stop future accounting.
  }
  usageIndexes.set(directory, index)
  return index
}

/**
 * Append one local diagnostics row without transcript content.
 * @param {object} event - bounded diagnostic fields.
 */
function logPredictionEvent(event) {
  try {
    const home = process.env.DSH_HOME
    if (!home) return
    const directory = join(home, 'diagnostics')
    mkdirSync(directory, { recursive: true })
    appendFileSync(join(directory, 'dsh-ace-errors.jsonl'), JSON.stringify({
      at: new Date().toISOString(),
      ...event,
    }) + '\n', 'utf8')
  } catch {
    // Diagnostics must never turn a prediction failure into a route failure.
  }
}

/**
 * One abort reason as an Error.
 * @param {AbortSignal} signal - aborted signal.
 * @param {string} fallback - fallback message.
 * @returns {Error} abort error.
 */
function abortError(signal, fallback) {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' && reason !== '' ? reason : fallback)
}

/**
 * Wait for one promise but reject as soon as the signal aborts.
 * @template T
 * @param {Promise<T>} promise - work to await.
 * @param {AbortSignal} signal - cancellation signal.
 * @param {string} fallback - fallback abort message.
 * @returns {Promise<T>} settled value.
 */
function raceAbort(promise, signal, fallback) {
  if (signal.aborted) return Promise.reject(abortError(signal, fallback))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(abortError(signal, fallback)))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

/**
 * Stream one model attempt and return its complete text plus provider usage.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ provider: string, model: string }} route - model route.
 * @param {{ system: string, user: string }} prompt - prompt messages.
 * @param {ReturnType<typeof normalizeConfig>} config - generation bounds.
 * @param {AbortSignal} signal - cancellation signal.
 * @returns {Promise<{ text: string, usage: object | null }>} complete text and usage.
 */
async function streamOnce(ctx, route, prompt, config, signal) {
  const iterable = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: prompt.system,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt.user }],
      source: { kind: 'user' },
    }],
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    signal,
  })
  const iterator = iterable[Symbol.asyncIterator]()
  let output = ''
  let finishError = ''
  let finishKind = ''
  let reasoningChars = 0
  let usage = null
  try {
    while (true) {
      const next = await raceAbort(Promise.resolve(iterator.next()), signal, 'prediction aborted')
      if (next.done) break
      const chunk = next.value
      if (!chunk) continue
      if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        usage = { ...chunk.usage }
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        reasoningChars += chunk.text.length
      }
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        output += chunk.text
        if (output.length > 16_000) break
      }
      if (chunk.type === 'finish' && chunk.reason) {
        finishKind = String(chunk.reason.kind ?? '')
        const kind = chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = chunk.reason.failure
          finishError = failure && failure.message ? failure.message : String(kind)
        }
      }
    }
  } finally {
    if (typeof iterator.return === 'function') {
      void Promise.resolve(iterator.return()).catch(() => {})
    }
  }
  if (finishError !== '') throw new Error(`model stream failed: ${finishError}`)
  if (output.trim() === '') {
    const usageText = usage ? `usage=${JSON.stringify(usage)}` : 'usage=none'
    throw new Error(`model stream produced no text (reasoningChars=${reasoningChars}, finish=${finishKind || 'none'}, ${usageText})`)
  }
  return { text: output.trim(), usage }
}

/**
 * Run one expert stage with its own timeout and max-token budget.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ provider: string, model: string }} route - model route.
 * @param {{ system: string, user: string }} prompt - prompt messages.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {number} timeoutMs - stage timeout.
 * @param {number} maxTokens - stage output cap.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<{ text: string, usage: object | null }>} complete stage text and usage.
 */
async function callExpertStage(ctx, route, prompt, config, timeoutMs, maxTokens, signal) {
  if (signal.aborted) throw abortError(signal, 'expert stage aborted')
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(abortError(signal, 'expert stage aborted'))
  signal.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('expert stage timed out')), timeoutMs)
  try {
    return await streamOnce(ctx, route, prompt, {
      ...config,
      maxTokens,
      temperature: config.expertTemperature,
      reasoningEffort: config.expertReasoningEffort,
    }, controller.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forwardAbort)
  }
}

/**
 * Run the expert pipeline: deterministic situation, one model call, host-side
 * selection of exactly one move. The caller falls back to fast prediction if
 * this throws.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {{ transcript: object[], cwd?: string, count: number, locale?: string }} input - request data.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<{ mode: string, candidates: object[], model: string, evidenceUsed: boolean, usage: object | null }>} expert result.
 */
/**
 * Ask the model to restate one move in the user's voice without a banned word.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{ provider: string, model: string }} route - model route.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {{ transcript?: object[] }} input - request data.
 * @param {string} text - the offending sentence.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<string>} rewritten text, or an empty string.
 */
async function rewriteWithoutBanned(ctx, route, config, input, text, signal) {
  const samples = (Array.isArray(input.transcript) ? input.transcript : [])
    .filter(row => row.role === 'user')
    .slice(-2)
    .map(row => String(row.text ?? '').slice(0, 300))
    .join('\n')
  const prompt = {
    system: '你是文字编辑，只做一件事：把一句话改成作者本人的口吻，并且不含任何禁用词。只输出改好的那一句，不要解释。',
    user: `[禁用词]\n建议、首先、综上、可以考虑\n\n[作者原话]\n${samples}\n\n[要改的句子]\n${text}\n\n[输出]\n只输出一句改好的话。`,
  }
  const result = await callExpertStage(
    ctx, route, prompt, config, Math.min(20_000, config.expertMovesTimeoutMs), Math.min(6000, config.expertMaxTokens), signal,
  )
  const cleaned = String(result.text ?? '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim()
  if (cleaned.length < 6) return ''
  // One rewritten sentence should not become a new wall of text.
  return cleaned.length > 1200 ? cleaned.slice(0, 1200) : cleaned
}

export async function generateExpertPrediction(ctx, config, input, signal) {
  const route = resolveModel(ctx, config)
  const mode = resolveMode(input.style ?? input.mode)
  const maxTokens = Math.min(config.expertMaxTokens, MODE_MAX_TOKENS[mode])
  const evidence = await collectEvidence(input.cwd ?? '')
  const home = process.env.DSH_HOME
  const ingested = config.ledger && home
    ? ingestLedger({
      dir: join(home, 'diagnostics'),
      sessionId: input.sessionId,
      transcript: input.transcript,
      maxEntries: config.ledgerMaxEntries,
      keep: config.ledgerKeep,
      autoArchive: config.autoArchive,
    })
    : { rows: input.transcript, archived: 0, gap: false }
  const sourceTranscript = ingested.rows.length > 0 ? ingested.rows : input.transcript
  if (ingested.archived > 0 || ingested.gap) {
    logPredictionEvent({ status: 'ledger', sessionId: input.sessionId, archived: ingested.archived, gap: ingested.gap === true })
  }
  const level = estimateLevel(sourceTranscript, config.level)
  const situation = buildDeterministicSituation(sourceTranscript)
  const movesPrompt = buildExpertPrompt({ ...input, transcript: sourceTranscript, mode, level, evidence, situation })
  let result
  let selection
  try {
    result = await callExpertStage(
      ctx, route, movesPrompt, config, config.expertMovesTimeoutMs, maxTokens, signal,
    )
    selection = parseExpertSelection(result.text, 5)
  } catch (error) {
    logPredictionEvent({
      status: 'expert-retry',
      message: String(error?.message ?? error).slice(0, 300),
      shape: describeShape(result?.text),
    })
    if (signal.aborted) throw abortError(signal, 'expert stage aborted')
    const retryPrompt = buildSingleMovePrompt({ ...input, mode, level, evidence, situation })
    result = await callExpertStage(
      ctx, route, retryPrompt, config, Math.min(12_000, config.expertMovesTimeoutMs), 1400, signal,
    )
    try {
      selection = parseExpertSelection(result.text, 5)
    } catch (retryError) {
      // A long, free-form answer is still an answer: keep it instead of failing the card.
      const salvaged = salvageExpertText(result.text)
      if (!salvaged) throw retryError
      if (findBannedPhrase(salvaged.text)) salvaged.text = cleanBannedPhrases(salvaged.text)
      logPredictionEvent({ status: 'expert-salvage', shape: describeShape(result.text) })
      return {
        mode: 'expert',
        style: mode,
        candidates: [salvaged],
        model: `${route.provider}/${route.model}`,
        evidenceUsed: evidence !== '(none)' && evidence !== '(not a git repository or no changes)',
        usage: result.usage,
        promptChars: (retryPrompt.system ?? '').length + (retryPrompt.user ?? '').length,
        salvaged: true,
        warning: 'the model did not return structured JSON; its raw answer became the card',
      }
    }
  }
  const lastAssistantText = [...input.transcript].reverse().find(row => row.role === 'assistant')?.text ?? ''
  for (const move of selection.moves) move.reply_ok = repliesTo(move.reply_to, lastAssistantText)
  const best = selectBestMove(selection, config.expertMinScore)
  if (best && findBannedPhrase(best.text)) {
    let rewritten = ''
    try {
      rewritten = await rewriteWithoutBanned(ctx, route, config, input, best.text, signal)
    } catch (error) {
      if (signal.aborted) throw abortError(signal, 'expert stage aborted')
      logPredictionEvent({ status: 'banned-rewrite-failed', message: String(error?.message ?? error).slice(0, 200) })
    }
    if (rewritten && !findBannedPhrase(rewritten)) best.text = rewritten
    else best.text = cleanBannedPhrases(rewritten || best.text)
  }
  // The card also shows the four beats; the rule covers every visible field.
  if (best) {
    for (const field of ['why', 'risk', 'x', 'y', 'z', 'falsify', 'relation']) {
      if (best[field] && findBannedPhrase(best[field])) best[field] = cleanBannedPhrases(best[field])
    }
  }
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const lastUser = [...input.transcript].reverse().find(row => row.role === 'user')?.text ?? ''
  const usable = best && normalize(best.text) !== normalize(lastUser) && best.text.trim() !== ''
  const candidates = usable ? [best] : []
  if (config.captureSamples) {
    captureSample({
      sessionId: input.sessionId,
      style: mode,
      mode: 'expert',
      level,
      locale: input.locale,
      count: input.count,
      threshold: config.expertMinScore,
      shown: candidates.length > 0,
      bestIndex: selection.bestIndex,
      promptChars: (movesPrompt.system ?? '').length + (movesPrompt.user ?? '').length,
      lastUser,
      rawText: result.text,
      moves: selection.moves,
    }, { limit: config.sampleLimit })
  }
  return {
    mode: 'expert',
    style: mode,
    candidates,
    model: `${route.provider}/${route.model}`,
    evidenceUsed: evidence !== '(none)' && evidence !== '(not a git repository or no changes)',
    usage: result.usage,
    promptChars: (movesPrompt.system ?? '').length + (movesPrompt.user ?? '').length,
  }
}

/**
 * Run up to two bounded attempts and parse the candidates.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {{ transcript: object[], cwd?: string, count: number, locale?: string }} input - request data.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<{ mode: string, candidates: string[], model: string }>} prediction result.
 */
async function generateFastPrediction(ctx, config, input, signal) {
  const route = resolveModel(ctx, config)
  const prompt = buildPrompt(input)
  let lastError
  for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
    if (signal.aborted) throw abortError(signal, 'prediction aborted')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(abortError(signal, 'prediction aborted'))
    signal.addEventListener('abort', forwardAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('prediction timed out')), config.timeoutMs)
    try {
      const result = await streamOnce(ctx, route, prompt, config, controller.signal)
      const parsed = parseCandidates(result.text, input.count)
      const lastUser = [...input.transcript].reverse().find(row => row.role === 'user')?.text ?? ''
      const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
      const candidates = parsed
        .filter(candidate => normalize(candidate) !== normalize(lastUser))
        .map(candidate => (findBannedPhrase(candidate) ? cleanBannedPhrases(candidate) : candidate))
        .filter(candidate => candidate.trim() !== '')
      if (candidates.length === 0) throw new Error('prediction repeated the user message')
      return { mode: 'fast', candidates, model: `${route.provider}/${route.model}`, usage: result.usage }
    } catch (error) {
      lastError = error
      if (signal.aborted) throw abortError(signal, 'prediction aborted')
      if (attempt + 1 >= config.maxAttempts) break
      await new Promise(resolve => setTimeout(resolve, 300))
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('prediction failed')
}

/**
 * Route one request to fast or expert prediction. Expert failures fall back to
 * the fast strip so the composer never waits for a broken deep pass.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {{ transcript: object[], cwd?: string, count: number, locale?: string, mode?: string }} input - request data.
 * @param {AbortSignal} signal - request cancellation.
 * @returns {Promise<object>} prediction result with a mode and candidates.
 */
export async function generatePrediction(ctx, config, input, signal) {
  if (input.mode !== 'expert') return generateFastPrediction(ctx, config, input, signal)
  try {
    return await generateExpertPrediction(ctx, config, input, signal)
  } catch (error) {
    if (signal.aborted) throw abortError(signal, 'prediction aborted')
    const fallback = await generateFastPrediction(ctx, config, input, signal)
    return {
      ...fallback,
      mode: 'fast-fallback',
      warning: `deep advice failed: ${String(error?.message ?? error)}`,
    }
  }
}

/**
 * Handle one route request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {ReturnType<typeof normalizeConfig>} config - plugin config.
 * @param {Map<string, AbortController>} inflight - one request per session.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
export async function handleRequest(ctx, config, inflight, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === `${config.routePrefix}/health`) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'GET required' } })
      return
    }
    const route = resolveModel(ctx, config)
    sendJson(res, 200, {
      ok: true,
      value: {
        version: VERSION,
        enabled: config.enabled,
        provider: route.provider,
        model: route.model,
        count: config.count,
        timeoutMs: config.timeoutMs,
        expertTimeoutMs: config.expertMovesTimeoutMs,
        modes: ['fast', 'expert'],
        styles: ACE_MODES,
      },
    })
    return
  }
  if (url.pathname !== `${config.routePrefix}/predict`) {
    sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown route' } })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'POST required' } })
    return
  }
  if (!config.enabled) {
    sendJson(res, 503, { ok: false, error: { code: 'disabled', message: 'prediction is disabled' } })
    return
  }
  let body
  try {
    body = await readJsonBody(req, config.maxBodyBytes)
  } catch (error) {
    const status = Number(error?.status) || 400
    sendJson(res, status, { ok: false, error: { code: 'bad-request', message: String(error?.message ?? error) } })
    return
  }
  const payload = body && typeof body === 'object' ? body : {}
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== ''
    ? payload.sessionId.slice(0, 200)
    : 'anonymous'
  const count = clampInt(payload.count, 1, 4, config.count)
  const locale = typeof payload.locale === 'string' ? payload.locale.slice(0, 40) : 'zh-CN'
  const mode = payload.mode === 'expert' ? 'expert' : 'fast'
  const style = resolveMode(payload.style)
  const transcript = sanitizeTranscript(payload.transcript, config)
  if (!transcript.some(row => row.role === 'user')) {
    sendJson(res, 200, { ok: true, value: { candidates: [], model: '', reason: 'no-user-message' } })
    return
  }
  const cwd = typeof payload.cwd === 'string' ? payload.cwd.slice(0, 1000) : ''
  const previous = inflight.get(sessionId)
  if (previous) previous.abort(new Error('superseded by a newer prediction'))
  const controller = new AbortController()
  inflight.set(sessionId, controller)
  const started = Date.now()
  const onClose = () => controller.abort(new Error('request closed'))
  req.on('close', onClose)
  try {
    const result = await generatePrediction(ctx, config, { transcript, cwd, count, locale, mode, style, sessionId }, controller.signal)
    logUsage({ sessionId, status: 'ok', mode: result.mode ?? mode, style: result.style ?? style, promptChars: result.promptChars, usage: result.usage, pricing: config.pricing })
    if (Array.isArray(result.candidates) && result.candidates.length === 0) {
      logPredictionEvent({ status: 'no-card', sessionId, mode: result.mode ?? mode, style: result.style ?? style })
    }
    if (result.warning) {
      logPredictionEvent({ status: 'fallback', sessionId, mode: result.mode ?? mode, style: result.style ?? style, warning: String(result.warning).slice(0, 300) })
    }
    if (!res.writableEnded) {
      sendJson(res, 200, {
        ok: true,
        value: {
          mode: result.mode ?? mode,
          style: result.style ?? style,
          salvaged: result.salvaged === true,
          candidates: result.candidates,
          model: result.model,
          warning: result.warning,
          evidenceUsed: result.evidenceUsed,
          usage: result.usage,
          latencyMs: Date.now() - started,
        },
      })
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    logPredictionEvent({ status: 'error', sessionId, mode, style, message: message.slice(0, 300) })
    if (!res.writableEnded) {
      const code = /timed out/.test(message) ? 'timeout' : /abort|closed|superseded/i.test(message) ? 'aborted' : 'internal'
      sendJson(res, 502, { ok: false, error: { code, message } })
    }
  } finally {
    req.removeListener('close', onClose)
    if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
  }
}

/**
 * Mount the prediction route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context carrying webServer and llm.
 * @param {Record<string, unknown>} [config] - plugin config.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const inflight = new Map()
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: settings.routePrefix,
      handler: (req, res) => { void handleRequest(ctx, settings, inflight, req, res) },
    })
    return () => {
      dispose()
      for (const controller of inflight.values()) controller.abort(new Error('plugin disposed'))
      inflight.clear()
    }
  }, 'dsh-ace: route')
}
