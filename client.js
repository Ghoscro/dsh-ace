window.__ModuleLoader__.load({id:'@ghoscro/dsh-ace',factory:(require)=>{
/** Predict the user's next message after an assistant turn. */
const React = require('react')
const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
const NS = 'dsh-ace'
const SETTINGS_KEY = 'dsh.composer-predict.settings.v1'
const ROUTE = '/composer-predict/predict'
/* Build-time version literal. install-version.test.ts fails the suite when this
   drifts from package.json or from what the desktop profile actually installed. */
const ACE_VERSION = '0.5.2'
/** Four equal-status advisory modes; the host owns the prompt policy. */
const MODES = ['safe', 'standard', 'brainstorm', 'wild']
const clampMode = value => (MODES.includes(value) ? value : 'standard')

const zh = {
  title: '深度预测', loading: '正在预测下一句…', refresh: '重新推演', close: '关闭深度预测',
  error: '深度预测失败', retry: '重试', inserted: '深度预测建议已填入',
  undo: '撤销', settings: '深度预测设置', auto: '自动生成深度预测', pause: '暂停深度预测',
  count: '候选数量', fontSize: '字号', privacy: '深度预测会把最近几轮对话发给当前模型；不写入会话记录，不跨会话学习。',
  button: '深度预测', buttonTitle: '生成一条深度预测（Tab 采用）',
  deep: '深度预测', deepTitle: '生成一条深度预测（约 10–50 秒，可取消）',
  deepLoading: '深度预测正在推演下一步…', autoExpert: '每轮自动生成深度预测建议',
  card: '深度预测', ace: '深度预测',
  recommended: '推荐', evidence: '依据', risk: '风险', fallback: '深度预测推演失败，已回退一条快速建议',
  salvaged: '模型没按结构化格式返回，已把原文放进卡片',
  beatX: '你刚说：', beatY: '背后：', beatZ: '还会：', relation: '怎么对上：', falsify: '错了会这样',
  now: '现在：', goal: '目的：', outcome: '做完：',
  mode: '模式', mode_safe: '保守安全', mode_standard: '常规推理', mode_brainstorm: '脑暴思维', mode_wild: '王牌预测',
}
const en = {
  title: 'ACE Move', loading: 'ACE is predicting your next move…', refresh: 'Think again',
  close: 'Dismiss ACE', error: 'ACE failed',
  retry: 'Retry', inserted: 'ACE Move inserted', undo: 'Undo', settings: 'ACE settings',
  auto: 'Generate ACE automatically', pause: 'Pause ACE', count: 'Candidates', fontSize: 'Text size',
  privacy: 'ACE sends the recent turns to the current model. Nothing is written to the session and nothing is learned across sessions.',
  button: '✦ ACE', buttonTitle: 'Generate one ACE Move (Tab accepts it)',
  deep: 'ACE', deepTitle: 'Generate one ACE Move (about 10–50 seconds, cancelable)',
  deepLoading: 'ACE is reasoning about the next move…', autoExpert: 'Generate one ACE suggestion every turn',
  card: 'ACE Move', ace: 'ACE',
  recommended: 'Recommended', evidence: 'Evidence', risk: 'Risk', fallback: 'ACE failed; showed one fast suggestion',
  salvaged: 'The model did not return structured JSON; its raw answer is in the card',
  beatX: 'You said: ', beatY: 'Behind it: ', beatZ: 'Also: ', relation: 'How it maps: ', falsify: 'Wrong if',
  now: 'Now: ', goal: 'Why: ', outcome: 'After: ',
  mode: 'Mode', mode_safe: 'Safe', mode_standard: 'Standard', mode_brainstorm: 'Brainstorm', mode_wild: 'ACE',
}

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

function blocksToText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(block => block && block.type === 'text' ? String(block.text ?? '') : '').filter(Boolean).join('\n').trim()
}

/** Turn the event window into the small transcript the host prompt needs. */
function extractTranscript(events) {
  const rows = []
  for (const entry of events) {
    if (!entry || entry.type !== 'event' || !entry.event) continue
    const event = entry.event
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = blocksToText(event.data.content)
      if (text !== '') rows.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = blocksToText(event.data?.message?.content)
      if (text !== '') rows.push({ role: 'assistant', text })
    }
  }
  return rows
}

/** Last completed or failed turn boundary in the window. */
function pickTurnEnd(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (!entry || entry.type !== 'event' || !entry.event) continue
    const event = entry.event
    if (event.type === 'turn/end') {
      return { seq: event.seq, turn: event.data?.turn, reason: event.data?.reason?.kind ?? 'unknown' }
    }
  }
  return null
}

/** Last durable event, used to clear stale candidates when a new turn starts. */
function pickTailEvent(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index]
    if (entry && entry.type === 'event' && entry.event) return entry.event
  }
  return null
}

function clampCount(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(4, Math.max(1, Math.round(number))) : 4
}

function readSettings() {
  const fallback = { enabled: true, paused: false, count: 4, autoExpert: true, mode: 'standard' }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY)
    if (raw === null) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      enabled: parsed.enabled !== false,
      paused: parsed.paused === true,
      count: clampCount(parsed.count),
      autoExpert: parsed.autoExpert !== false,
      mode: clampMode(parsed.mode),
    }
  } catch {
    return fallback
  }
}

function createStore() {
  let state = {
    status: 'idle', candidates: [], error: '', model: '', mode: 'expert', style: '', salvaged: false, warning: '', startedAt: 0,
    turnSeq: -1, triggeredTurnSeq: -1, accepted: null,
  }
  const listeners = new Set()
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch }
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

const EMPTY_STATE = Object.freeze({
  status: 'idle', candidates: [], error: '', model: '', mode: 'expert', style: '', salvaged: false, warning: '', startedAt: 0,
  turnSeq: -1, triggeredTurnSeq: -1, accepted: null,
})
const EMPTY_STORE = { get: () => EMPTY_STATE, subscribe: () => () => {} }

/* Type scale. The card reads three CSS variables so the size can change at
   runtime; no rebuild and no new tarball. Defaults live in the var() fallbacks. */
const FONT_KEY = 'dsh-ace.font'
const FONT_DEFAULT = { w: 15, meta: 13, x: 12 }
const FONT_MIN = 12
const FONT_MAX = 20
const clampFont = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(number * 2) / 2))
}
function normalizeFont(value) {
  const w = clampFont(value?.w) ?? FONT_DEFAULT.w
  return {
    w,
    meta: clampFont(value?.meta) ?? Math.max(FONT_MIN, w - 2),
    x: clampFont(value?.x) ?? Math.max(FONT_MIN, w - 3),
  }
}
function readFontSync() {
  try {
    const raw = window.localStorage.getItem(FONT_KEY)
    return raw ? normalizeFont(JSON.parse(raw)) : { ...FONT_DEFAULT }
  } catch {
    return { ...FONT_DEFAULT }
  }
}
/* chrome.storage.local is the requested store; DSH's web container does not
   always expose the extension API, so localStorage is the fallback. Either way
   the change only touches CSS variables on documentElement. */
const fontStorage = {
  chromeStore() {
    try {
      return typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null
    } catch {
      return null
    }
  },
  read(handler) {
    const store = this.chromeStore()
    if (store) {
      try {
        const result = store.get(FONT_KEY, value => handler(normalizeFont(value?.[FONT_KEY])))
        if (result && typeof result.then === 'function') {
          result.then(value => handler(normalizeFont(value?.[FONT_KEY]))).catch(() => {})
        }
        return
      } catch { /* fall back to localStorage */ }
    }
    handler(readFontSync())
  },
  write(value) {
    const store = this.chromeStore()
    if (store) {
      try {
        const result = store.set({ [FONT_KEY]: value })
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch { /* fall back to localStorage */ }
    }
    try { window.localStorage.setItem(FONT_KEY, JSON.stringify(value)) } catch { /* storage can be unavailable */ }
  },
  watch(handler) {
    try {
      if (typeof chrome !== 'undefined' && chrome?.storage?.onChanged) {
        const listener = (changes, area) => {
          if (area === 'local' && changes?.[FONT_KEY]) handler(normalizeFont(changes[FONT_KEY].newValue))
        }
        chrome.storage.onChanged.addListener(listener)
        return () => chrome.storage.onChanged.removeListener(listener)
      }
    } catch { /* fall back to the DOM event */ }
    const onStorage = event => {
      if (event.key !== FONT_KEY || !event.newValue) return
      try { handler(normalizeFont(JSON.parse(event.newValue))) } catch { /* ignore a broken value */ }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  },
}
function applyFont(value) {
  const root = document?.documentElement?.style
  if (!root || typeof root.setProperty !== 'function') return
  root.setProperty('--dsh-fs-w', `${value.w}px`)
  root.setProperty('--dsh-fs-meta', `${value.meta}px`)
  root.setProperty('--dsh-fs-x', `${value.x}px`)
}

/* The card sits in the composer dock but not in the same slot as Todo/Goal, and
   equal width does not mean aligned edges: the parent paddings differ. Measure
   both rects and publish the left/right insets the CSS margins use. */
const COMPOSER_SELECTOR = '[data-composer-card]'
function dockInsets(cardRect, seatRect) {
  const number = value => Number.isFinite(Number(value)) ? Number(value) : 0
  const left = Math.max(0, Math.round(number(cardRect?.left) - number(seatRect?.left)))
  const right = Math.max(0, Math.round(number(seatRect?.right) - number(cardRect?.right)))
  return { left, right }
}
function applyComposerInsets() {
  const root = document?.documentElement?.style
  if (!root || typeof document?.querySelector !== 'function') return
  const card = document.querySelector(COMPOSER_SELECTOR)
  if (!card || typeof card.getBoundingClientRect !== 'function') return
  const seat = typeof card.closest === 'function' ? card.closest('[data-composer-seat]') : null
  if (!seat || typeof seat.getBoundingClientRect !== 'function') return
  const cardRect = card.getBoundingClientRect()
  const seatRect = seat.getBoundingClientRect()
  if (!cardRect.width || !seatRect.width) return
  const { left, right } = dockInsets(cardRect, seatRect)
  root.setProperty('--dsh-ace-inset-left', `${left}px`)
  root.setProperty('--dsh-ace-inset-right', `${right}px`)
}

function apply(ctx) {
  // Surface the loaded build on <html data-ace-version> so the version can be
  // checked from the DOM instead of guessed from the UI.
  try {
    if (document?.documentElement?.dataset) document.documentElement.dataset.aceVersion = ACE_VERSION
  } catch { /* a non-DOM host simply has no marker */ }
  const stores = new Map()
  const faces = new Map()
  let settings = readSettings()
  const settingsListeners = new Set()
  const settingsStore = {
    get: () => settings,
    set: (patch) => {
      settings = { ...settings, ...patch }
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* storage can be unavailable */ }
      for (const listener of settingsListeners) listener()
    },
    subscribe: (listener) => {
      settingsListeners.add(listener)
      return () => { settingsListeners.delete(listener) }
    },
  }

  /* Runtime type scale: the slider writes the store, the store writes the
     documentElement variables, and a storage listener keeps other windows in
     sync. Changing the size never needs a rebuild. */
  const fontListeners = new Set()
  let font = readFontSync()
  const fontStore = {
    get: () => font,
    set: (next) => {
      font = normalizeFont(next)
      for (const listener of fontListeners) listener()
    },
    subscribe: (listener) => {
      fontListeners.add(listener)
      return () => { fontListeners.delete(listener) }
    },
  }
  const stopFontWatch = fontStorage.watch(next => fontStore.set(next))
  fontStorage.read(next => fontStore.set(next))
  ctx.effect(() => {
    applyFont(font)
    const stop = fontStore.subscribe(value => applyFont(value))
    return () => {
      stop()
      stopFontWatch()
    }
  }, 'dsh-ace font variables')

  function getStore(sessionId) {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = createStore()
      stores.set(sessionId, store)
    }
    return store
  }

  function faceFor(sessionId) {
    const cached = faces.get(sessionId)
    if (cached !== undefined) return cached
    let binding
    try {
      binding = ctx.sessions.binding(sessionId)
    } catch {
      return null
    }
    if (!binding) return null
    const face = createFace(sessionId, binding, getStore(sessionId))
    faces.set(sessionId, face)
    return face
  }

  function createFace(sessionId, binding, store) {
    const source = binding.eventSource
    const session = binding.session
    let controller = null
    let disposed = false

    const readEvents = () => source.getSnapshot().entries
    const readTurnEnd = () => pickTurnEnd(readEvents())
    const readTailEvent = () => pickTailEvent(readEvents())
    const readTranscript = () => extractTranscript(readEvents())
    const readCwd = () => {
      try {
        const row = ctx.sessions.list?.getSnapshot?.()?.byId?.[sessionId]
        return typeof row?.cwd === 'string' ? row.cwd : ''
      } catch {
        return ''
      }
    }
    const subscribe = listener => source.subscribe(listener)
    const subscribeSession = listener => session.subscribe(listener)

    async function ensureHistory() {
      if (!source.getSnapshot().hasMore) return
      for (let page = 0; page < 3; page += 1) {
        if (readTranscript().length >= 8) return
        if (typeof session.loadOlder !== 'function') return
        await session.loadOlder()
        if (!source.getSnapshot().hasMore) return
      }
    }

    function abort() {
      if (controller !== null) {
        controller.abort(new Error('prediction superseded'))
        controller = null
      }
    }

    async function predict(options = {}) {
      if (disposed) return
      const current = store.get()
      if (current.status === 'loading') return
      const count = clampCount(options.count ?? settings.count)
      const mode = options.mode === 'fast' ? 'fast' : 'expert'
      const style = clampMode(options.style ?? settings.mode)
      abort()
      const mine = new AbortController()
      controller = mine
      const timer = window.setTimeout(
        () => mine.abort(new Error('prediction timed out')),
        mode === 'expert' ? 58_000 : 20_000,
      )
      store.set({ status: 'loading', error: '', accepted: null, mode, warning: '', startedAt: Date.now() })
      try {
        await ensureHistory()
        const transcript = readTranscript()
        if (!transcript.some(row => row.role === 'user')) {
          store.set({ status: 'idle', candidates: [], warning: '', salvaged: false })
          return
        }
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            cwd: readCwd(),
            locale: typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN',
            count,
            mode,
            style,
            transcript,
          }),
          signal: mine.signal,
        })
        let payload
        try {
          payload = await response.json()
        } catch {
          throw new Error(`prediction route returned HTTP ${response.status}`)
        }
        if (!payload || payload.ok !== true) {
          throw new Error(payload?.error?.message || `prediction failed (HTTP ${response.status})`)
        }
        if (mine.signal.aborted) return
        const rawCandidates = Array.isArray(payload.value?.candidates) ? payload.value.candidates : []
        const candidates = rawCandidates.map(item => {
          if (typeof item === 'string') return item.trim() === '' ? null : { text: item.trim(), slot: '', why: '', evidence: '', risk: '', intent: '' }
          if (!item || typeof item !== 'object' || typeof item.text !== 'string' || item.text.trim() === '') return null
          const str = key => typeof item[key] === 'string' ? item[key] : ''
          return {
            text: item.text.trim(),
            slot: str('slot'),
            why: str('why'),
            evidence: str('evidence'),
            risk: str('risk'),
            intent: str('intent'),
            // Four-beat card: X, Y, Z, W(=text), plus the falsifier.
            x: str('x'),
            y: str('y'),
            z: str('z'),
            relation: str('relation'),
            falsify: str('falsify'),
            now: str('now'),
            goal: str('goal'),
            outcome: str('outcome'),
          }
        }).filter(Boolean).slice(0, count)
        if (candidates.length === 0) {
          store.set({ status: 'idle', candidates: [], model: payload.value?.model ?? '', mode: payload.value?.mode ?? mode })
          return
        }
        const end = readTurnEnd()
        store.set({
          status: 'ready', candidates,
          model: typeof payload.value?.model === 'string' ? payload.value.model : '',
          mode: typeof payload.value?.mode === 'string' ? payload.value.mode : mode,
          style: typeof payload.value?.style === 'string' ? payload.value.style : style,
          salvaged: payload.value?.salvaged === true,
          warning: typeof payload.value?.warning === 'string' ? payload.value.warning : '',
          turnSeq: end ? end.seq : store.get().turnSeq,
          triggeredTurnSeq: end ? end.seq : store.get().triggeredTurnSeq,
          error: '',
        })
      } catch (error) {
        if (mine.signal.aborted) {
          const reason = mine.signal.reason
          if (reason && reason.message === 'prediction timed out') {
            store.set({ status: 'error', warning: '', salvaged: false, error: mode === 'expert' ? '深度推演超时，请重试或切回快速' : '预测超时，请重试' })
          }
          return
        }
        store.set({ status: 'error', warning: '', salvaged: false, error: String(error?.message ?? error) })
      } finally {
        window.clearTimeout(timer)
        if (controller === mine) controller = null
      }
    }

    return {
      sessionId, store, session, source,
      readTurnEnd, readTailEvent, readTranscript,
      subscribe, subscribeSession, predict, abort,
      dispose() {
        disposed = true
        abort()
      },
    }
  }

  const style = document.createElement('style')
  style.textContent = [
    '.dcp-dock{box-sizing:border-box;flex:none;width:auto;margin:0 var(--dsh-ace-inset-right,0px) 0 var(--dsh-ace-inset-left,0px);padding:10px 12px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 2px 10px rgba(0,0,0,.06);font:inherit;font-size:var(--dsh-fs-w,15px);line-height:1.5}',
    '.dcp-head{display:flex;align-items:center;gap:8px;min-height:26px;margin-bottom:4px}',
    '.dcp-title{font-size:var(--dsh-fs-x,12px);letter-spacing:.02em;opacity:.68;white-space:nowrap}',
    '.dcp-loading{font-size:var(--dsh-fs-meta,13px);opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dcp-spacer{flex:1}',
    '.dcp-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-fs-meta,13px);line-height:1;cursor:pointer;opacity:.65}',
    '.dcp-icon:hover,.dcp-icon:focus-visible{background:var(--dsw-specific-bubble,#ffffff12);opacity:1}',
    '.dcp-row{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;width:100%;min-height:36px;padding:7px 6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.dcp-row:hover,.dcp-row:focus-visible{background:var(--dsw-specific-bubble,#ffffff10)}',
    '.dcp-row[data-first=true] .dcp-text{font-weight:500}',
    '.dcp-key{flex:none;min-width:42px;padding:0 5px;margin-top:2px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.32));border-radius:4px;font-size:var(--dsh-fs-x,12px);line-height:1.6;text-align:center;opacity:.6}',
    '.dcp-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
    '.dcp-text{min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere;font-size:var(--dsh-fs-w,15px);line-height:1.5}',
    '.dcp-why{font-size:var(--dsh-fs-meta,13px);line-height:1.45;opacity:.66;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-x{font-size:var(--dsh-fs-meta,13px);line-height:1.4;opacity:.6;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-plain{font-size:var(--dsh-fs-meta,13px);line-height:1.45;opacity:.8;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-z{font-size:var(--dsh-fs-meta,13px);line-height:1.45;opacity:.64;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-rel{font-size:var(--dsh-fs-meta,13px);line-height:1.45;opacity:.72;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-beat{font-weight:700;opacity:.82;margin-right:2px}',
    '.dcp-meta{font-size:var(--dsh-fs-meta,13px);line-height:1.4;opacity:.52;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
    '.dcp-warning{font-size:var(--dsh-fs-meta,13px);line-height:1.4;color:#b8860b;margin:3px 6px 0}',
    '.dcp-skeleton{height:12px;margin:7px 6px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-specific-bubble,#ffffff0c),#ffffff18,var(--dsw-specific-bubble,#ffffff0c));background-size:200% 100%;animation:dcp-shimmer 1.4s linear infinite}',
    '.dcp-skeleton:nth-child(2){width:82%}.dcp-skeleton:nth-child(3){width:66%}',
    '@keyframes dcp-shimmer{0%{background-position:180% 0}100%{background-position:-20% 0}}',
    '@media (prefers-reduced-motion:reduce){.dcp-skeleton{animation:none}}',
    '.dcp-error{display:flex;align-items:center;gap:8px;padding:3px 6px;color:#f0a0a0;font-size:var(--dsh-fs-meta,13px)}',
    '.dcp-error span{min-width:0;overflow:hidden;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
    '.dcp-undo{display:flex;align-items:center;gap:8px;margin-top:4px;padding:3px 6px;font-size:var(--dsh-fs-x,12px);opacity:.72}',
    '.dcp-undo button{border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;padding:0}',
    '.dcp-settings{margin-top:6px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.2));display:grid;gap:6px;font-size:var(--dsh-fs-meta,13px)}',
    '.dcp-modes{display:flex;flex-wrap:wrap;gap:4px;align-items:center}',
    '.dcp-modes-label{opacity:.6;margin-right:2px}',
    '.dcp-mode{height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.28));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-fs-x,12px);cursor:pointer;opacity:.75}',
    '.dcp-mode:hover,.dcp-mode:focus-visible{opacity:1}',
    '.dcp-mode-on{background:var(--dsw-specific-bubble,#ffffff14);opacity:1;font-weight:600}',
    '.dcp-mode-chip{font-size:var(--dsh-fs-x,12px);opacity:.6;margin-left:2px}',
    '.dcp-settings label{display:flex;align-items:center;gap:6px}',
    '.dcp-settings select{border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.32));border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-fs-meta,13px);padding:2px 5px}',
    '.dcp-settings small{opacity:.55;line-height:1.45;font-size:var(--dsh-fs-x,12px)}',
    '.dcp-font{display:flex;align-items:center;gap:8px}',
    '.dcp-font input[type=range]{flex:1;min-width:0;accent-color:var(--dsw-alias-label-primary,#0f1115)}',
    '.dcp-font-value{min-width:38px;text-align:right;opacity:.6;font-variant-numeric:tabular-nums}',
    '.dcp-button{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:var(--dsh-fs-x,12px);cursor:pointer;opacity:.72;white-space:nowrap}',
    '.dcp-button:hover,.dcp-button:focus-visible{background:var(--dsw-specific-bubble,#ffffff10);opacity:1}',
    '.dcp-button[disabled]{opacity:.35;cursor:default}',
    '.dcp-mini-spinner{display:inline-block;width:10px;height:10px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dcp-spin .7s linear infinite}',
    '@keyframes dcp-spin{to{transform:rotate(360deg)}}',
    '@media (width <= 640px){.dcp-button span{display:none}.dcp-key{min-width:34px}.dcp-dock{padding:9px 10px}}',
  ].join('')
  document.head.append(style)

  function PredictionDock(props) {
    const { sessionId, useInput, useSession, inputActions } = props
    const t = typeof props.t === 'function' ? props.t : key => key
    const face = useMemo(() => faceFor(sessionId), [sessionId])
    const store = face ? face.store : EMPTY_STORE
    const state = useSyncExternalStore(store.subscribe, store.get, store.get)
    const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    const font = useSyncExternalStore(fontStore.subscribe, fontStore.get, fontStore.get)
    const input = useInput(snapshot => snapshot)
    const session = useSession(snapshot => snapshot)
    const [settingsOpen, setSettingsOpen] = useState(false)

    // Keep --dsh-ace-inset-left/right equal to the live composer card edges.
    // This dock is not the Todo/Goal slot, so no CSS math is assumed: measure, then set.
    useEffect(() => {
      if (typeof document === 'undefined') return undefined
      let card = null
      let resize = null
      let frame = 0
      const bind = () => {
        const next = document.querySelector(COMPOSER_SELECTOR)
        if (next && next !== card) {
          card = next
          if (resize) resize.disconnect()
          if (typeof ResizeObserver !== 'undefined') {
            resize = new ResizeObserver(() => applyComposerInsets())
            resize.observe(card)
          }
        }
        applyComposerInsets()
      }
      bind()
      const schedule = () => {
        if (frame) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          bind()
        })
      }
      const mutation = typeof MutationObserver !== 'undefined' && document.body
        ? new MutationObserver(schedule)
        : null
      if (mutation) mutation.observe(document.body, { childList: true, subtree: true })
      return () => {
        if (frame) window.cancelAnimationFrame(frame)
        if (resize) resize.disconnect()
        if (mutation) mutation.disconnect()
      }
    }, [])

    const stateRef = useRef(state)
    stateRef.current = state
    const settingsRef = useRef(settings)
    settingsRef.current = settings
    const inputRef = useRef(input)
    inputRef.current = input
    const sessionRef = useRef(session)
    sessionRef.current = session
    const draftRef = useRef(input?.draft ?? '')
    draftRef.current = input?.draft ?? ''
    const acceptRef = useRef(() => {})
    const dismissRef = useRef(() => {})
    const undoTimer = useRef(null)

    useEffect(() => {
      if (!face) return undefined
      const local = face.store
      const current = face.readTurnEnd()
      if (local.get().turnSeq < 0) {
        local.set({ turnSeq: current ? current.seq : -1, triggeredTurnSeq: current ? current.seq : -1 })
      }
      let timer = null
      const maybe = () => {
        const end = face.readTurnEnd()
        const tail = face.readTailEvent()
        if (end) {
          if (end.seq !== local.get().turnSeq) local.set({ turnSeq: end.seq })
          if (end.seq !== local.get().triggeredTurnSeq) {
            if (end.reason !== 'completed') {
              local.set({ triggeredTurnSeq: end.seq })
            } else {
              const now = settingsRef.current
              if (now.enabled && !now.paused && draftRef.current.trim() === '') {
                if (timer !== null) window.clearTimeout(timer)
                let attempts = 0
                const fire = () => {
                  timer = null
                  const live = settingsRef.current
                  if (!live.enabled || !live.autoExpert || live.paused || draftRef.current.trim() !== '') return
                  const latest = face.readTurnEnd()
                  if (!latest || latest.seq !== end.seq) return
                  // The turn/end event can land just before the session reports
                  // running=false; wait for settlement without depending on a
                  // session notification that may never arrive.
                  if (sessionRef.current?.running && attempts < 8) {
                    attempts += 1
                    timer = window.setTimeout(fire, 400)
                    return
                  }
                  local.set({ triggeredTurnSeq: end.seq })
                  face.predict({ mode: 'expert', count: live.count })
                }
                timer = window.setTimeout(fire, 600)
              }
            }
          }
        }
        if (tail && (tail.type === 'turn/start' || tail.type === 'user/message') && local.get().status !== 'loading') {
          local.set({ candidates: [], status: 'idle', error: '', accepted: null })
        }      }
      const offSource = face.subscribe(maybe)
      const offSession = face.subscribeSession(maybe)
      return () => {
        offSource()
        offSession()
        if (timer !== null) window.clearTimeout(timer)
        face.abort()
      }
    }, [face, sessionId])

    useEffect(() => () => {
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    }, [])

    const accept = index => {
      const current = stateRef.current
      const item = current.candidates[index]
      const text = typeof item === 'string' ? item : item && typeof item === 'object' ? item.text : ''
      if (!text || !inputActions) return
      const previous = inputRef.current?.draft ?? ''
      inputActions.setDraft(text)
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      undoTimer.current = window.setTimeout(() => {
        undoTimer.current = null
        if (face) face.store.set({ accepted: null })
      }, 8000)
      currentStoreSet({ candidates: [], status: 'idle', accepted: { text, previous, candidates: current.candidates } })
      window.requestAnimationFrame(() => {
        const editor = document.querySelector('[data-composer-input]')
        if (editor && typeof editor.focus === 'function') editor.focus()
      })
    }
    function currentStoreSet(patch) {
      if (face) face.store.set(patch)
    }
    acceptRef.current = accept

    const dismiss = () => {
      if (face) {
        face.abort()
        face.store.set({ candidates: [], status: 'idle', error: '', accepted: null })
      }
    }
    dismissRef.current = dismiss

    const undo = () => {
      const accepted = stateRef.current.accepted
      if (!accepted || !inputActions) return
      if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
      undoTimer.current = null
      inputActions.setDraft(accepted.previous)
      currentStoreSet({ accepted: null, candidates: accepted.candidates, status: 'ready' })
    }

    useEffect(() => {
      const onKeyDown = event => {
        const current = stateRef.current
        if (!current.candidates.length) return
        if (event.defaultPrevented) return
        if (event.isComposing || event.keyCode === 229 || document.querySelector('[data-composer-composing]')) return
        const card = document.querySelector('[data-composer-card]')
        const target = event.target
        const inside = card && target instanceof Node && card.contains(target)
        if (!inside) return
        const live = inputRef.current
        if (!live || live.phase !== 'plain') return
        if ((live.draft ?? '').trim() !== '') return
        if (document.querySelector('[data-composer-card] [role="listbox"]')) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          dismissRef.current()
          return
        }
        if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current(0)
          return
        }
        if (event.altKey && /^[1-4]$/.test(event.key)) {
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current(Number(event.key) - 1)
          return
        }
        if (event.altKey && /^Digit[1-4]$/.test(event.code ?? '')) {
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current(Number(event.code.slice(5)) - 1)
        }
      }
      window.addEventListener('keydown', onKeyDown, false)
      return () => window.removeEventListener('keydown', onKeyDown, false)
    }, [])

    const visible = state.status === 'loading' || state.status === 'error'
      || state.candidates.length > 0 || state.accepted !== null

    if (!visible && !settingsOpen) return null

    const textOf = item => typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.text ?? '') : ''
    const rows = state.candidates.slice(0, 1).map((item, index) => {
      const text = textOf(item)
      const field = key => item && typeof item === 'object' && typeof item[key] === 'string' ? item[key] : ''
      const why = field('why')
      const evidence = field('evidence')
      const risk = field('risk')
      const x = field('x')
      const y = field('y')
      const z = field('z')
      const relation = field('relation')
      const falsify = field('falsify')
      const now = field('now')
      const goal = field('goal')
      const outcome = field('outcome')
      // Four-beat cards replace why with a structured line, then add Z and W.
      const line = y || why
      const meta = [
        falsify ? `${t('falsify')}：${falsify}` : '',
        risk ? `${t('risk')}：${risk}` : '',
      ].filter(Boolean).join(' · ')
      return React.createElement('button', {
        key: `candidate-${index}-${text.slice(0, 16)}`,
        type: 'button',
        className: 'dcp-row',
        'data-first': index === 0 ? 'true' : 'false',
        title: why ? `${text}\n${why}` : text,
        onClick: () => accept(index),
      },
      React.createElement('span', { className: 'dcp-key' }, index === 0 ? 'Tab' : `Alt+${index + 1}`),
      React.createElement('span', { className: 'dcp-body' },
        x ? React.createElement('span', { className: 'dcp-x' },
          React.createElement('span', { className: 'dcp-beat' }, t('beatX')), x) : null,
        now ? React.createElement('span', { className: 'dcp-plain' },
          React.createElement('span', { className: 'dcp-beat' }, t('now')), now) : null,
        goal ? React.createElement('span', { className: 'dcp-plain' },
          React.createElement('span', { className: 'dcp-beat' }, t('goal')), goal) : null,
        outcome ? React.createElement('span', { className: 'dcp-plain' },
          React.createElement('span', { className: 'dcp-beat' }, t('outcome')), outcome) : null,
        line ? React.createElement('span', { className: 'dcp-why' },
          y ? React.createElement('span', { className: 'dcp-beat' }, t('beatY')) : null, line) : null,
        z ? React.createElement('span', { className: 'dcp-z' },
          React.createElement('span', { className: 'dcp-beat' }, t('beatZ')), z) : null,
        relation ? React.createElement('span', { className: 'dcp-rel' },
          React.createElement('span', { className: 'dcp-beat' }, t('relation')), relation) : null,
        React.createElement('span', { className: 'dcp-text' }, text),
        meta ? React.createElement('span', { className: 'dcp-meta' }, meta) : null))
    })

    const refresh = () => {
      if (!face) return
      face.predict({ mode: 'expert', count: settingsRef.current.count, manual: true })
    }
    const deep = () => {
      if (!face) return
      face.predict({ mode: 'expert', count: settingsRef.current.count, manual: true })
    }

    const update = patch => settingsStore.set(patch)
    const updateFont = value => {
      const next = normalizeFont(value)
      fontStore.set(next)
      fontStorage.write(next)
    }

    return React.createElement('section', {
      className: 'dcp-dock',
      'aria-label': t('title'),
      'aria-live': 'polite',
    },
    React.createElement('div', { className: 'dcp-head' },
      React.createElement('span', { className: 'dcp-title' }, state.mode === 'expert' ? t('card') : t('title')),
      React.createElement('span', { className: 'dcp-mode-chip' }, t(`mode_${state.style || settings.mode}`)),
      state.status === 'loading'
        ? React.createElement('span', { className: 'dcp-loading' }, state.mode === 'expert' ? t('deepLoading') : t('loading'))
        : state.status === 'ready'
          ? React.createElement('span', { className: 'dcp-loading' }, `${state.candidates.length}`)
          : null,
      React.createElement('span', { className: 'dcp-spacer' }),
      React.createElement('button', {
        type: 'button', className: 'dcp-icon', title: t('deepTitle'), 'aria-label': t('deepTitle'),
        disabled: state.status === 'loading', onClick: deep,
      }, '✦'),
      React.createElement('button', {
        type: 'button', className: 'dcp-icon', title: t('refresh'), 'aria-label': t('refresh'),
        disabled: state.status === 'loading', onClick: refresh,
      }, '↻'),
      React.createElement('button', {
        type: 'button', className: 'dcp-icon', title: t('settings'), 'aria-label': t('settings'),
        'aria-expanded': settingsOpen, onClick: () => setSettingsOpen(open => !open),
      }, '⚙'),
      React.createElement('button', {
        type: 'button', className: 'dcp-icon', title: t('close'), 'aria-label': t('close'), onClick: dismiss,
      }, '×')),
    state.status === 'loading'
      ? [0, 1, 2].map(index => React.createElement('div', { key: `skeleton-${index}`, className: 'dcp-skeleton' }))
      : null,
    state.status === 'error'
      ? React.createElement('div', { className: 'dcp-error' },
        React.createElement('span', { title: state.error }, `${t('error')}：${state.error}`),
        React.createElement('button', {
          type: 'button', className: 'dcp-icon', title: t('retry'), 'aria-label': t('retry'), onClick: refresh,
        }, '↻'))
      : null,
    state.warning && (state.mode === 'fast-fallback' || state.salvaged)
      ? React.createElement('div', { className: 'dcp-warning' },
        `${state.salvaged ? t('salvaged') : t('fallback')}：${state.warning}`)
      : null,
    rows,
    state.accepted !== null
      ? React.createElement('div', { className: 'dcp-undo' },
        React.createElement('span', null, t('inserted')),
        React.createElement('button', { type: 'button', onClick: undo }, t('undo')))
      : null,
    settingsOpen
      ? React.createElement('div', { className: 'dcp-settings' },
        React.createElement('div', { className: 'dcp-modes', role: 'group', 'aria-label': t('mode') },
          React.createElement('span', { className: 'dcp-modes-label' }, t('mode')),
          MODES.map(id => React.createElement('button', {
            key: id,
            type: 'button',
            className: settings.mode === id ? 'dcp-mode dcp-mode-on' : 'dcp-mode',
            'aria-pressed': settings.mode === id,
            onClick: () => update({ mode: id }),
          }, t(`mode_${id}`)))),
        React.createElement('label', null,
          React.createElement('input', {
            type: 'checkbox', checked: settings.enabled,
            onChange: event => update({ enabled: event.target.checked }),
          }), t('auto')),
        React.createElement('label', null,
          React.createElement('input', {
            type: 'checkbox', checked: settings.paused,
            onChange: event => update({ paused: event.target.checked }),
          }), t('pause')),
        React.createElement('label', null,
          React.createElement('input', {
            type: 'checkbox', checked: settings.autoExpert,
            onChange: event => update({ autoExpert: event.target.checked }),
          }), t('autoExpert')),
        React.createElement('label', { className: 'dcp-font' },
          React.createElement('span', null, t('fontSize')),
          React.createElement('input', {
            type: 'range', min: FONT_MIN, max: FONT_MAX, step: 0.5,
            value: font.w, 'aria-label': t('fontSize'),
            onChange: event => updateFont({ w: Number(event.target.value) }),
          }),
          React.createElement('span', { className: 'dcp-font-value' }, `${font.w}px`)),
        React.createElement('small', null, t('privacy')))
      : null)
  }

  function PredictButton(props) {
    const { sessionId } = props
    const t = typeof props.t === 'function' ? props.t : key => key
    const face = useMemo(() => faceFor(sessionId), [sessionId])
    const store = face ? face.store : EMPTY_STORE
    const state = useSyncExternalStore(store.subscribe, store.get, store.get)
    const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    const run = () => {
      if (!face) return
      face.predict({ mode: 'fast', count: settings.count, manual: true })
    }
    return React.createElement('button', {
      type: 'button', className: 'dcp-button', title: t('buttonTitle'),
      'aria-label': t('buttonTitle'), disabled: state.status === 'loading', onClick: run,
    },
    state.status === 'loading'
      ? React.createElement('span', { className: 'dcp-mini-spinner', 'aria-hidden': 'true' })
      : React.createElement('span', { 'aria-hidden': 'true' }, '✦'),
    React.createElement('span', null, t('button')))
  }

  function DeepButton(props) {
    const { sessionId } = props
    const t = typeof props.t === 'function' ? props.t : key => key
    const face = useMemo(() => faceFor(sessionId), [sessionId])
    const store = face ? face.store : EMPTY_STORE
    const state = useSyncExternalStore(store.subscribe, store.get, store.get)
    const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    const run = () => {
      if (!face) return
      face.predict({ mode: 'expert', count: settings.count, manual: true })
    }
    return React.createElement('button', {
      type: 'button', className: 'dcp-button', title: t('deepTitle'),
      'aria-label': t('deepTitle'), disabled: state.status === 'loading', onClick: run,
    },
    state.status === 'loading'
      ? React.createElement('span', { className: 'dcp-mini-spinner', 'aria-hidden': 'true' })
      : React.createElement('span', { 'aria-hidden': 'true' }, '✦'),
    React.createElement('span', null, t('ace')))
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-ace dictionaries')
  ctx.effect(() => () => {
    style.remove()
    for (const face of faces.values()) face.dispose()
    faces.clear()
    stores.clear()
  }, 'dsh-ace styles and faces')
  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'ace', order: 30, locale: NS,
    inject: sessionId => faceFor(sessionId),
  }, PredictionDock)), 'dsh-ace dock')
  ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'ace-deep', order: 24, locale: NS,
    inject: sessionId => faceFor(sessionId),
  }, DeepButton)), 'dsh-ace button')
}

return {
  inject: ['slots', 'locale', 'sessions'],
  apply,
  __test: { extractTranscript, pickTurnEnd, pickTailEvent, readSettings, clampCount, normalizeFont, applyFont, dockInsets, applyComposerInsets },
}
}})
