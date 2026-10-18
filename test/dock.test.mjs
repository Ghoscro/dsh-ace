import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const sourcePath = 'E:/我的文档/程序/sakurabot/projects/deepseek-harness-next/source'
const sourceRequire = createRequire(`${sourcePath}/package.json`)
const reactRequire = createRequire(`${sourcePath}/node_modules/.pnpm/react@18.3.1/node_modules/react/package.json`)
const reactDomRequire = createRequire(`${sourcePath}/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/package.json`)
const { JSDOM } = sourceRequire('jsdom')
const React = reactRequire('react')
const { createRoot } = reactDomRequire('react-dom/client')
const { act } = reactDomRequire('react-dom/test-utils')

const clientSource = readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8')

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function event(type, seq, data) {
  return { type: 'event', event: { type, seq, data } }
}

test('dock predicts after a new turn and Tab fills the first candidate', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const window = dom.window
  const document = window.document
  const listeners = new Set()
  const entries = [
    event('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修测试' }] }),
    event('assistant/message', 2, { message: { content: [{ type: 'text', text: '改好了' }] } }),
    event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const eventWindow = { entries, hasMore: false }
  const eventSource = {
    getSnapshot: () => eventWindow,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
  }
  const session = {
    getSnapshot: () => ({ running: false }),
    subscribe: () => () => {},
    async loadOlder() {},
  }
  const binding = { sessionId: 's1', eventSource, session }
  let captured
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(0), 0)
  window.cancelAnimationFrame = id => window.clearTimeout(id)
  window.__ModuleLoader__ = { load(entry) { captured = entry } }
  const fetchCalls = []
  const context = {
    window, document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    Node: window.Node,
    KeyboardEvent: window.KeyboardEvent,
    AbortController: globalThis.AbortController,
    fetch: async (url, options) => {
      fetchCalls.push({ url, body: JSON.parse(options.body) })
      return {
        status: 200,
        async json() {
          return {
            ok: true,
            value: {
              mode: 'expert',
              candidates: [
                { text: '跑一遍测试', why: '先确认范围，避免重试掩盖问题', evidence: 'x.test.ts', risk: '', slot: 'recommended' },
                { text: '先看 diff', why: '确认改动没有扩大', evidence: 'git diff', risk: '', slot: 'quick' },
                { text: '别加重试', why: '重试会把竞态盖住', evidence: '', risk: '可能暴露更多失败', slot: 'non_obvious' },
                { text: '顺手改 CI', why: '把同类问题一次收掉', evidence: 'ci.yml', risk: '', slot: 'risk' },
              ],
              model: 'fake',
            },
          }
        },
      }
    },
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    requestAnimationFrame: callback => window.setTimeout(() => callback(0), 0),
    console,
  }
  vm.runInNewContext(clientSource, context, { filename: 'client.js' })
  const exports = captured.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })

  const components = {}
  const ctx = {
    effect(fn) { return fn() },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name, install) { install(); return () => {} },
      register(options, component) { components[options.name + ':' + options.id] = component; return () => {} },
    },
    sessions: {
      binding: id => id === 's1' ? binding : undefined,
      list: { getSnapshot: () => ({ byId: { s1: { cwd: 'E:/project' } } }) },
    },
  }
  exports.apply(ctx)
  const Dock = components['conversation.input.dock:ace']
  assert.equal(typeof Dock, 'function')

  const inputSnapshot = { draft: '', phase: 'plain', attachmentIds: [], draftRev: 0, occurrences: [], queue: [] }
  const draftCalls = []
  const inputActions = {
    setDraft(text) { draftCalls.push(text) },
    submit() {}, addAttachments() { return true }, removeAttachment() {}, pruneAttachments() {},
  }
  const props = {
    sessionId: 's1',
    useInput: selector => selector(inputSnapshot),
    useSession: selector => selector({ running: false }),
    inputActions,
    t: key => key,
  }

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.window = window
  globalThis.document = document
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(Dock, props))
  })

  // A new assistant turn completes after the dock mounted.
  await act(async () => {
    entries.push(event('turn/end', 9, { turn: 2, reason: { kind: 'completed' } }))
    for (const listener of [...listeners]) listener()
  })
  await act(async () => { await sleep(700) })
  await act(async () => { await sleep(100) })

  const rows = [...container.querySelectorAll('.dcp-row')]
  assert.equal(rows.length, 1)
  assert.match(container.textContent, /跑一遍测试/)
  assert.match(container.textContent, /先确认范围/)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].body.cwd, 'E:/project')
  assert.equal(fetchCalls[0].body.count, 4)
  assert.equal(fetchCalls[0].body.mode, 'expert')

  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const editor = document.createElement('div')
  editor.setAttribute('data-composer-input', '')
  editor.setAttribute('contenteditable', 'true')
  card.append(editor)
  document.body.append(card)
  editor.focus()

  const keydown = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  await act(async () => {
    editor.dispatchEvent(keydown)
  })
  assert.equal(keydown.defaultPrevented, true)
  assert.deepEqual(draftCalls, ['跑一遍测试'])
  assert.equal(container.querySelectorAll('.dcp-row').length, 0)
  assert.match(container.textContent, /inserted/)

  await act(async () => { root.unmount() })
})




