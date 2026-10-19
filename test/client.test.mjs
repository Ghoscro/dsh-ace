import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const source = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

function loadClient() {
  let captured
  const window = {
    __ModuleLoader__: {
      load(entry) { captured = entry },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      value: null,
      getItem() { return this.value },
      setItem(_key, value) { this.value = value },
    },
  }
  const appended = []
  const rootStyle = {
    values: {},
    setProperty(name, value) { this.values[name] = value },
  }
  const document = {
    head: { append: element => appended.push(element) },
    createElement: () => ({ textContent: '', remove: () => {} }),
    querySelector: () => null,
    documentElement: { style: rootStyle },
  }
  const context = {
    window,
    document,
    navigator: { language: 'zh-CN' },
    localStorage: window.localStorage,
    fetch: async () => ({ json: async () => ({ ok: true, value: { candidates: [] } }) }),
    Node: class Node {},
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    requestAnimationFrame: window.requestAnimationFrame,
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  assert.equal(captured?.id, '@ghoscro/dsh-ace')
  const react = {
    createElement: () => null,
    useCallback: fn => fn,
    useEffect: () => {},
    useMemo: fn => fn(),
    useRef: value => ({ current: value }),
    useState: value => [value, () => {}],
    useSyncExternalStore: () => ({}),
  }
  const exports = captured.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  })
  return { exports, document, window, appended, rootStyle }
}

test('client module exposes the cordis face and pure helpers', () => {
  const { exports } = loadClient()
  assert.deepEqual(JSON.parse(JSON.stringify(exports.inject)), ['slots', 'locale', 'sessions'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.__test.clampCount(9), 4)
  assert.equal(exports.__test.clampCount(0), 1)
})

test('extractTranscript keeps human prompts and assistant text only', () => {
  const { exports } = loadClient()
  const events = [
    { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } } },
    { type: 'event', event: { type: 'user/message', data: { source: { kind: 'agent' }, content: [{ type: 'text', text: 'synthetic' }] } } },
    { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在' }, { type: 'tool-call' }] } } } },
    { type: 'transient', event: { type: 'assistant/live-chunk', data: {} } },
  ]
  assert.deepEqual(JSON.parse(JSON.stringify(exports.__test.extractTranscript(events))), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '在' },
  ])
})

test('pickTurnEnd finds the latest turn boundary and its reason', () => {
  const { exports } = loadClient()
  const events = [
    { type: 'event', event: { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } } },
    { type: 'event', event: { type: 'assistant/message', seq: 3, data: {} } },
    { type: 'event', event: { type: 'turn/end', seq: 8, data: { turn: 2, reason: { kind: 'interrupted' } } } },
    { type: 'event', event: { type: 'turn/start', seq: 9, data: { turn: 3 } } },
  ]
  assert.deepEqual(JSON.parse(JSON.stringify(exports.__test.pickTurnEnd(events))), { seq: 8, turn: 2, reason: 'interrupted' })
  assert.equal(exports.__test.pickTailEvent(events)?.type, 'turn/start')
})

test('readSettings falls back safely and normalizes count', () => {
  const { exports, window } = loadClient()
  const base = { enabled: true, paused: false, count: 4, autoExpert: true, mode: 'standard' }
  assert.deepEqual(JSON.parse(JSON.stringify(exports.__test.readSettings())), base)
  window.localStorage.value = JSON.stringify({ enabled: false, paused: true, count: 99, autoExpert: true, mode: 'wild' })
  assert.deepEqual(JSON.parse(JSON.stringify(exports.__test.readSettings())), { ...base, enabled: false, paused: true, mode: 'wild' })
  window.localStorage.value = JSON.stringify({ mode: 'nope' })
  assert.equal(exports.__test.readSettings().mode, 'standard')
  window.localStorage.value = '{broken'
  assert.deepEqual(JSON.parse(JSON.stringify(exports.__test.readSettings())), base)
})

test('apply registers both composer slots and the locale dictionary', () => {
  const { exports } = loadClient()
  const slots = []
  const dictionaries = []
  const effects = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    locale: {
      register(namespace, dictionary) {
        dictionaries.push({ namespace, dictionary })
        return () => {}
      },
    },
    slots: {
      inject(name, install) {
        slots.push(name)
        install()
        return () => {}
      },
      register(options) {
        slots.push(`${options.name}:${options.id}`)
        return () => {}
      },
    },
    sessions: {},
  }
  exports.apply(ctx)
  assert.deepEqual(slots, [
    'conversation.input.dock',
    'conversation.input.dock:ace',
    'conversation.input.right',
    'conversation.input.right:ace-deep',
  ])
  assert.equal(dictionaries[0].namespace, 'dsh-ace')
  assert.equal(dictionaries[0].dictionary.zh.title, '深度预测')
  assert.equal(dictionaries[0].dictionary.zh.button, '深度预测')
  assert.equal(dictionaries[0].dictionary.zh.ace, '深度预测')
  assert.equal(dictionaries[0].dictionary.en.title, 'ACE Move')
  assert.equal(dictionaries[0].dictionary.zh.mode_wild, '王牌预测')
  assert.equal(dictionaries[0].dictionary.en.mode_wild, 'ACE')
  assert.equal(dictionaries[0].dictionary.zh.mode_brainstorm, '脑暴思维')
  assert.equal(dictionaries[0].dictionary.zh.beatX, '你刚说：')
  assert.equal(dictionaries[0].dictionary.zh.beatZ, '还会：')
  assert.equal(dictionaries[0].dictionary.zh.relation, '怎么对上：')
  assert.equal(dictionaries[0].dictionary.en.beatZ, 'Also: ')
  assert.equal(dictionaries[0].dictionary.en.relation, 'How it maps: ')
  assert.equal(dictionaries[0].dictionary.zh.falsify, '错了会这样')
  effects.forEach(dispose => { if (typeof dispose === 'function') dispose() })
})

test('the card styles cover the four beats', () => {
  const { exports, appended } = loadClient()
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject(_name, install) {
        install()
        return () => {}
      },
      register: () => () => {},
    },
    sessions: {},
  }
  exports.apply(ctx)
  const css = appended.map(element => element.textContent).join('')
  assert.match(css, /\.dcp-x\{/)
  assert.match(css, /\.dcp-z\{/)
  assert.match(css, /\.dcp-rel\{/)
  assert.match(css, /\.dcp-beat\{/)
})

test('the type scale is written to the document root at runtime', () => {
  const { exports, rootStyle } = loadClient()
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject(_name, install) {
        install()
        return () => {}
      },
      register: () => () => {},
    },
    sessions: {},
  }
  exports.apply(ctx)
  assert.equal(rootStyle.values['--dsh-fs-w'], '15px')
  assert.equal(rootStyle.values['--dsh-fs-meta'], '13px')
  assert.equal(rootStyle.values['--dsh-fs-x'], '12px')
})

test('the type scale clamps and stays proportional', () => {
  const { exports } = loadClient()
  const normalize = value => JSON.parse(JSON.stringify(exports.__test.normalizeFont(value)))
  assert.deepEqual(normalize({ w: 18 }), { w: 18, meta: 16, x: 15 })
  assert.deepEqual(normalize({ w: 99 }), { w: 20, meta: 18, x: 17 })
  assert.deepEqual(normalize({ w: 1 }), { w: 12, meta: 12, x: 12 })
  assert.deepEqual(normalize({ w: 15, meta: 14, x: 11 }), { w: 15, meta: 14, x: 12 })
})

