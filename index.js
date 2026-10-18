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
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Public plugin name used by Cordis. */
export const name = 'dsh-ace'

/** Required host services: the route registry and the model seam. */
export const inject = ['webServer', 'llm']

const DEFAULT_ROUTE = '/composer-predict'
const MAX_BODY_BYTES = 256 * 1024
const MAX_MESSAGES = 16
const MAX_TOTAL_CHARS = 14_000
const MAX_CANDIDATE_CHARS = 160
const MAX_EXPERT_TEXT = 90
const MAX_EXPERT_WHY = 160
const MAX_EXPERT_EVIDENCE = 240
const MAX_EXPERT_RISK = 160
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
{"text":"...","why":"...","evidence":"...","risk":"...","action":"advance|tool|reframe|verify|clarify|constrain|close","value":0,"novelty":0,"worth_extra_step":0,"over_obvious":"..."}
最后一行是选择：
{"best_index":0,"comparison":"为什么选它，其他方向差在哪"}

规则：
- text 是用户口吻、可直接发送；why 不发送。
- 3-5 条，方向明显不同；至少 1 条是 advance/tool/reframe，全部落在 verify/constrain 视为不合格。
- value = 对目标的推进；novelty = 用户可能没想到；worth_extra_step = 值不值得多这一步。三项 0-10，诚实打分，不要每条都 8 分以上。
- over_obvious 必须回答：相比顺手说“继续/好”，它多得到什么；why 说明这条为什么值得现在发。
- 若所有候选都不比顺手继续更好，只输出一行：{"best_index":null,"comparison":"没有更好的下一步"}。
- 不要编造文件名、数字或结论；不要用“你可以/建议/不妨”这类助手口吻。
- 只输出这些 JSON 行，不要解释。`

const EN_EXPERT = `You are the user's expert next-move advisor. Do not predict the most likely next line; generate 3-5 genuinely different candidate moves, compare them, and keep only the one most worth sending.

Directions include: advance the next step, use an existing tool or a cheaper path, reframe the problem, verify a key assumption, clarify missing input, constrain scope, or close. Do not default to risk-finding.

Output format: one JSON object per line. No array, no comma-separated list, no markdown, no code fences.
The first 3-5 lines are candidates:
{"text":"...","why":"...","evidence":"...","risk":"...","action":"advance|tool|reframe|verify|clarify|constrain|close","value":0,"novelty":0,"worth_extra_step":0,"over_obvious":"..."}
The final line is the selection:
{"best_index":0,"comparison":"why this one, and why the others are weaker"}

Rules:
- text is the user's sendable voice; why is shown, not sent.
- 3-5 moves with clearly different directions; at least one advance/tool/reframe; all verify/constrain is invalid.
- value = progress toward the goal; novelty = what the user likely missed; worth_extra_step = whether it deserves an extra step. Score 0-10 honestly; do not give everything 8+.
- over_obvious must answer: what does it gain over the obvious "continue/ok"? why explains why it is worth sending now.
- If no move beats the obvious next line, output one line: {"best_index":null,"comparison":"no better next move"}.
- Never invent file names, numbers, or conclusions; no assistant voice ("you could", "I suggest").
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
  standard: 'MODE standard: the next step a competent engineer would actually take. Be direct and opinionated, name the concrete file, command or decision, and skip hedging.',
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
下面两段是用户本人写的，不是范例，是语气样本。学他怎么断句、怎么省略、怎么骂、怎么突然换话题；不要学内容，也不要回答它们。
<sample>
${VOICE_SAMPLES_ZH}
</sample>
- 用他在 [THREAD] 里的词和句子长度。他口语就口语，他粗糙就粗糙；不要替他加礼貌、加总结。
- text 里不要小标题、不要项目符号、不要书面连接词。
- 疯批也要用他的口吻疯：他爱短句就用短句，他爱絮叨就絮叨。想法可以离谱，语气必须是他。`

const VOICE_EN = `[VOICE - sound like them first, then go wild]
The sample below is the user's own writing. Copy its register, not its content; do not answer it.
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

/** The output contract is restated last so a long mode prompt cannot bury it. */
const FORMAT_BLOCK = `[FORMAT - binding]
- Output one JSON object per line, each one complete and closed on the same line. No prose, markdown, headings or code fences outside the objects.
- Keep text under 800 characters, why under 300, risk under 200. If room runs short, shorten text first; never drop a closing brace to fit more detail.
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
    user: `${MODE_DISCIPLINE}\n\n${voiceBlock(locale)}\n\n${bannedBlock(locale)}\n\n${FORMAT_BLOCK}\n\n[THREAD]\n${thread}\n\n[MODE]\n${MODE_POLICY[mode]}\n\n[SITUATION]\n${JSON.stringify(input.situation ?? {}, null, 2)}\n\n[EVIDENCE]\n${clip(input.evidence ?? '(none)', 8000)}\n\n[OUT]\nN=${count}, mode=${mode}, language=${locale.startsWith('zh') ? 'zh' : 'en'}`,
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
JSON 对象字段：text, why, evidence, risk, action, value, novelty, worth_extra_step, over_obvious。
不要数组、不要多行对象、不要 markdown。text 用用户口吻，可直接发送；why 不发送；不要编造。`
    : `You are ACE. Compare 3 directions internally (advance, existing tool/cheaper path, reframe) and output only the one JSON object most worth sending. If nothing beats the obvious next line, output {"best_index":null,"comparison":"no better next move"}.
JSON fields: text, why, evidence, risk, action, value, novelty, worth_extra_step, over_obvious.
No array, no multi-line objects, no markdown. text is the user's sendable voice; why is shown, not sent; never invent.`
  return {
    system,
    user: `${MODE_DISCIPLINE}\n\n${voiceBlock(locale)}\n\n${bannedBlock(locale)}\n\n${FORMAT_BLOCK}\n\n[THREAD]\n${thread}\n\n[MODE]\n${MODE_POLICY[resolveMode(input.mode)]}\n\n[SITUATION]\n${JSON.stringify(input.situation ?? {}, null, 2)}\n\n[EVIDENCE]\n${clip(input.evidence ?? '(none)', 6000)}\n\n[OUT]\nN=1`,
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
    const why = typeof object.why === 'string' ? object.why.replace(/\s+/g, ' ').trim() : overObvious
    if (why === '') continue
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
      slot: typeof object.slot === 'string' ? object.slot : '',
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
}

/**
 * Choose the single best move, honoring a sane model pick as a tie-breaker.
 * @param {{ moves: object[], bestIndex: number | null, comparison: string }} selection - parsed selection.
 * @param {number} minScore - minimum score for showing a card.
 * @returns {object | null} the selected move, or null when no move clears the gate.
 */
export function selectBestMove(selection, minScore = 5) {
  if (!Array.isArray(selection.moves) || selection.moves.length === 0) return null
  const scored = selection.moves.map((move, index) => ({
    ...move,
    index,
    score: scoreMove(move) + (selection.bestIndex === index ? 0.35 : 0),
  }))
  scored.sort((left, right) => right.score - left.score)
  const top = scored[0]
  const modelBest = selection.bestIndex === null ? null : scored.find(move => move.index === selection.bestIndex)
  const chosen = modelBest && modelBest.score >= top.score - 0.35 ? modelBest : top
  if (chosen.score < minScore) return null
  const why = chosen.over_obvious && !chosen.why.includes(chosen.over_obvious)
    ? clip(`${chosen.why}；${chosen.over_obvious}`, MAX_EXPERT_WHY)
    : chosen.why
  return {
    text: chosen.text,
    why,
    evidence: chosen.evidence,
    risk: chosen.risk,
    intent: chosen.action,
    score: Number(chosen.score.toFixed(2)),
    comparison: selection.comparison,
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
 * Append one usage row: numbers only, so cache hits are visible without content.
 * @param {{ status?: string, mode?: string, style?: string, promptChars?: number, usage?: object }} event - usage fields.
 */
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
    appendFileSync(join(directory, 'dsh-ace-usage.jsonl'), JSON.stringify({
      at: new Date().toISOString(),
      status: event.status ?? '',
      mode: event.mode ?? '',
      style: event.style ?? '',
      promptChars: typeof event.promptChars === 'number' ? event.promptChars : 0,
      usage: numeric,
    }) + '\n', 'utf8')
  } catch {
    // Usage logging must never break a prediction.
  }
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
  const situation = buildDeterministicSituation(input.transcript)
  const movesPrompt = buildExpertPrompt({ ...input, mode, evidence, situation })
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
    const retryPrompt = buildSingleMovePrompt({ ...input, mode, evidence, situation })
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
  // The card also shows why and risk; the rule covers every visible field.
  if (best) {
    for (const field of ['why', 'risk']) {
      if (best[field] && findBannedPhrase(best[field])) best[field] = cleanBannedPhrases(best[field])
    }
  }
  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const lastUser = [...input.transcript].reverse().find(row => row.role === 'user')?.text ?? ''
  const usable = best && normalize(best.text) !== normalize(lastUser) && best.text.trim() !== ''
  const candidates = usable ? [best] : []
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
    const result = await generatePrediction(ctx, config, { transcript, cwd, count, locale, mode, style }, controller.signal)
    logUsage({ status: 'ok', mode: result.mode ?? mode, style: result.style ?? style, promptChars: result.promptChars, usage: result.usage })
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
