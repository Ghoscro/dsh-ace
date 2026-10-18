window.__ModuleLoader__.load({id:'@ghoscro/dsh-ace',factory:(require)=>{
/** Predict the user's next message after an assistant turn. */
const React = require('react')
const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
const NS = 'dsh-ace'
const SETTINGS_KEY = 'dsh.composer-predict.settings.v1'
const ROUTE = '/composer-predict/predict'

const zh = {
  title: 'ACE Move', loading: 'ACE 正在预测下一句…', refresh: '重新推演', close: '关闭 ACE',
  empty: '这轮没有比顺手继续更好的 ACE Move', error: 'ACE 失败', retry: '重试', inserted: 'ACE 建议已填入',
  undo: '撤销', settings: 'ACE 设置', auto: '自动生成 ACE', pause: '暂停 ACE',
  count: '候选数量', privacy: 'ACE 会把最近几轮对话发给当前模型；不写入会话记录，不跨会话学习。',
  button: '✦ ACE', buttonTitle: '生成一条 ACE Move（Tab 采用）',
  deep: 'ACE', deepTitle: '生成一条 ACE Move（约 10–50 秒，可取消）',
  deepLoading: 'ACE 正在推演下一步…', autoExpert: '每轮自动生成 ACE 建议',
  card: 'ACE Move', ace: 'ACE',
  recommended: '推荐', evidence: '依据', risk: '风险', fallback: 'ACE 推演失败，已回退一条快速建议',
}
const en = {
  title: 'ACE Move', loading: 'ACE is predicting your next move…', refresh: 'Think again',
  close: 'Dismiss ACE', empty: 'No ACE Move beats the obvious next line this time', error: 'ACE failed',
  retry: 'Retry', inserted: 'ACE Move inserted', undo: 'Undo', settings: 'ACE settings',
  auto: 'Generate ACE automatically', pause: 'Pause ACE', count: 'Candidates',
  privacy: 'ACE sends the recent turns to the current model. Nothing is written to the session and nothing is learned across sessions.',
  button: '✦ ACE', buttonTitle: 'Generate one ACE Move (Tab accepts it)',
  deep: 'ACE', deepTitle: 'Generate one ACE Move (about 10–50 seconds, cancelable)',
  deepLoading: 'ACE is reasoning about the next move…', autoExpert: 'Generate one ACE suggestion every turn',
  card: 'ACE Move', ace: 'ACE',
  recommended: 'Recommended', evidence: 'Evidence', risk: 'Risk', fallback: 'ACE failed; showed one fast suggestion',
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
  const fallback = { enabled: true, paused: false, count: 4, autoExpert: true }
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
    }
  } catch {
    return fallback
  }
}

function createStore() {
  let state = {
    status: 'idle', candidates: [], error: '', model: '', mode: 'expert', warning: '', startedAt: 0,
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
  status: 'idle', candidates: [], error: '', model: '', mode: 'expert', warning: '', startedAt: 0,
  turnSeq: -1, triggeredTurnSeq: -1, accepted: null,
})
const EMPTY_STORE = { get: () => EMPTY_STATE, subscribe: () => () => {} }

function apply(ctx) {
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
          store.set({ status: 'idle', candidates: [] })
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
          return {
            text: item.text.trim(),
            slot: typeof item.slot === 'string' ? item.slot : '',
            why: typeof item.why === 'string' ? item.why : '',
            evidence: typeof item.evidence === 'string' ? item.evidence : '',
            risk: typeof item.risk === 'string' ? item.risk : '',
            intent: typeof item.intent === 'string' ? item.intent : '',
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
          warning: typeof payload.value?.warning === 'string' ? payload.value.warning : '',
          turnSeq: end ? end.seq : store.get().turnSeq,
          triggeredTurnSeq: end ? end.seq : store.get().triggeredTurnSeq,
          error: '',
        })
      } catch (error) {
        if (mine.signal.aborted) {
          const reason = mine.signal.reason
          if (reason && reason.message === 'prediction timed out') {
            store.set({ status: 'error', error: mode === 'expert' ? '深度推演超时，请重试或切回快速' : '预测超时，请重试' })
          }
          return
        }
        store.set({ status: 'error', error: String(error?.message ?? error) })
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
    '.dcp-dock{box-sizing:border-box;width:100%;margin:0 0 6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.24));border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 2px 10px rgba(0,0,0,.06);font:inherit;font-size:13px;line-height:1.45}',
    '.dcp-head{display:flex;align-items:center;gap:8px;min-height:22px;margin-bottom:3px}',
    '.dcp-title{font-size:11px;letter-spacing:.02em;opacity:.68;white-space:nowrap}',
    '.dcp-loading{font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dcp-spacer{flex:1}',
    '.dcp-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:1;cursor:pointer;opacity:.65}',
    '.dcp-icon:hover,.dcp-icon:focus-visible{background:var(--dsw-specific-bubble,#ffffff12);opacity:1}',
    '.dcp-row{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;width:100%;min-height:32px;padding:5px 6px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.dcp-row:hover,.dcp-row:focus-visible{background:var(--dsw-specific-bubble,#ffffff10)}',
    '.dcp-row[data-first=true] .dcp-text{font-weight:500}',
    '.dcp-key{flex:none;min-width:38px;padding:0 4px;margin-top:2px;border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.32));border-radius:4px;font-size:10px;line-height:16px;text-align:center;opacity:.6}',
    '.dcp-body{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}',
    '.dcp-text{min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}',
    '.dcp-why{font-size:11px;line-height:1.35;opacity:.62;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.dcp-meta{font-size:10px;line-height:1.3;opacity:.48;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dcp-warning{font-size:11px;line-height:1.35;color:#b8860b;margin:2px 6px 0}',
    '.dcp-skeleton{height:12px;margin:7px 6px;border-radius:6px;background:linear-gradient(90deg,var(--dsw-specific-bubble,#ffffff0c),#ffffff18,var(--dsw-specific-bubble,#ffffff0c));background-size:200% 100%;animation:dcp-shimmer 1.4s linear infinite}',
    '.dcp-skeleton:nth-child(2){width:82%}.dcp-skeleton:nth-child(3){width:66%}',
    '@keyframes dcp-shimmer{0%{background-position:180% 0}100%{background-position:-20% 0}}',
    '@media (prefers-reduced-motion:reduce){.dcp-skeleton{animation:none}}',
    '.dcp-error{display:flex;align-items:center;gap:8px;padding:3px 6px;color:#f0a0a0;font-size:12px}',
    '.dcp-error span{min-width:0;overflow:hidden;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
    '.dcp-undo{display:flex;align-items:center;gap:8px;margin-top:4px;padding:3px 6px;font-size:11px;opacity:.72}',
    '.dcp-undo button{border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;cursor:pointer;padding:0}',
    '.dcp-settings{margin-top:6px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.2));display:grid;gap:5px;font-size:12px}',
    '.dcp-settings label{display:flex;align-items:center;gap:6px}',
    '.dcp-settings select{border:1px solid var(--dsw-alias-border-primary,rgba(127,127,127,.32));border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:1px 4px}',
    '.dcp-settings small{opacity:.55;line-height:1.4;font-size:10px}',
    '.dcp-button{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;opacity:.72;white-space:nowrap}',
    '.dcp-button:hover,.dcp-button:focus-visible{background:var(--dsw-specific-bubble,#ffffff10);opacity:1}',
    '.dcp-button[disabled]{opacity:.35;cursor:default}',
    '.dcp-mini-spinner{display:inline-block;width:10px;height:10px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dcp-spin .7s linear infinite}',
    '@keyframes dcp-spin{to{transform:rotate(360deg)}}',
    '@media (max-width:640px){.dcp-button span{display:none}.dcp-key{min-width:30px}.dcp-dock{padding:7px 8px}}',
  ].join('')
  document.head.append(style)

  function PredictionDock(props) {
    const { sessionId, useInput, useSession, inputActions } = props
    const t = typeof props.t === 'function' ? props.t : key => key
    const face = useMemo(() => faceFor(sessionId), [sessionId])
    const store = face ? face.store : EMPTY_STORE
    const state = useSyncExternalStore(store.subscribe, store.get, store.get)
    const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
    const input = useInput(snapshot => snapshot)
    const session = useSession(snapshot => snapshot)
    const [settingsOpen, setSettingsOpen] = useState(false)

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
      const why = item && typeof item === 'object' && typeof item.why === 'string' ? item.why : ''
      const evidence = item && typeof item === 'object' && typeof item.evidence === 'string' ? item.evidence : ''
      const risk = item && typeof item === 'object' && typeof item.risk === 'string' ? item.risk : ''
      const meta = [
        evidence ? `${t('evidence')}：${evidence}` : '',
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
        React.createElement('span', { className: 'dcp-text' }, text),
        why ? React.createElement('span', { className: 'dcp-why' }, why) : null,
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

    return React.createElement('section', {
      className: 'dcp-dock',
      'aria-label': t('title'),
      'aria-live': 'polite',
    },
    React.createElement('div', { className: 'dcp-head' },
      React.createElement('span', { className: 'dcp-title' }, state.mode === 'expert' ? t('card') : t('title')),
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
    state.warning && state.mode === 'fast-fallback'
      ? React.createElement('div', { className: 'dcp-warning' }, `${t('fallback')}：${state.warning}`)
      : null,
    rows,
    state.status === 'idle' && state.candidates.length === 0 && state.accepted === null
      ? React.createElement('div', { className: 'dcp-loading' }, t('empty'))
      : null,
    state.accepted !== null
      ? React.createElement('div', { className: 'dcp-undo' },
        React.createElement('span', null, t('inserted')),
        React.createElement('button', { type: 'button', onClick: undo }, t('undo')))
      : null,
    settingsOpen
      ? React.createElement('div', { className: 'dcp-settings' },
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
  __test: { extractTranscript, pickTurnEnd, pickTailEvent, readSettings, clampCount },
}
}})
