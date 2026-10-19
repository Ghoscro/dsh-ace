import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = require('react-dom/test-utils')

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
      if (url.endsWith('/stream')) return {
        body: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"full":"跑通再说"}\n\nevent: done\ndata: {"completion":"跑通再说"}\n\n'))
          controller.close()
        } }),
      }
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
    TextDecoder,
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
  window.localStorage.setItem('dsh.composer-predict.settings.v1', JSON.stringify({ mode: 'wild' }))
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

  // A quiet card stays quiet: no placeholder sentence before or after a turn.
  assert.equal(container.textContent.includes('empty'), false)

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
  assert.equal(fetchCalls[0].body.style, 'wild', 'the saved mode is sent with the request')

  const settingsButton = [...container.querySelectorAll('button')]
    .find(button => button.getAttribute('title') === 'settings')
  await act(async () => { settingsButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const modeButtons = [...container.querySelectorAll('.dcp-mode')]
  assert.equal(modeButtons.length, 4)
  assert.deepEqual(modeButtons.map(button => button.textContent), ['mode_safe', 'mode_standard', 'mode_brainstorm', 'mode_wild'])
  assert.equal(modeButtons.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1)

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

  // The shipped DSH composer is Lexical; a pet textarea must never win lookup.
  const petInput = document.createElement('textarea')
  petInput.value = '鲸鱼娘草稿'
  document.body.append(petInput)
  editor.textContent = '这个功能先'
  inputSnapshot.draft = '这个功能先'
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  window.getSelection().removeAllRanges()
  window.getSelection().addRange(range)
  await act(async () => {
    editor.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'F1', bubbles: true, cancelable: true }))
    await sleep(250)
  })
  assert.equal(fetchCalls.find(call => call.url.endsWith('/stream')).body.draft, '这个功能先')
  const ghost = document.querySelector('.dcp-ghost')
  assert.equal(ghost.style.display, 'block')
  assert.match(ghost.textContent, /这个功能先跑通再说/)
  const ghostTab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  await act(async () => { editor.dispatchEvent(ghostTab) })
  assert.equal(ghostTab.defaultPrevented, true)
  assert.equal(draftCalls.at(-1), '这个功能先跑通再说')
  assert.equal(petInput.value, '鲸鱼娘草稿')
  const beforePet = fetchCalls.length
  petInput.dispatchEvent(new window.InputEvent('input', { bubbles: true }))
  await act(async () => { await sleep(180) })
  assert.equal(fetchCalls.length, beforePet)

  await act(async () => { root.unmount() })
})




