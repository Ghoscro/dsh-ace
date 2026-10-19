import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig, streamInlineCompletion, generateInlineCompletion } from '../index.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ace-inline-test-'))
const input = { draft: '这个功能先', transcript: [] }

for (const mode of ['stream', 'batch']) {
  for (const advertised of [true, false]) {
    test(`${mode} inline chooses only advertised off and never inherits card low`, async () => {
      let request
      const ctx = { llm: {
        async resolveModelInfo() { return advertised ? { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } } : {} },
        async *stream(options) {
          request = options
          yield { type: 'text-delta', text: '跑通再说' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      } }
      const config = normalizeConfig({ reasoningEffort: 'low' })
      const signal = new AbortController().signal
      if (mode === 'stream') assert.equal(await streamInlineCompletion(ctx, config, input, () => {}, signal), '跑通再说')
      else assert.equal((await generateInlineCompletion(ctx, config, input, signal)).completion, '跑通再说')
      assert.equal(request.reasoningEffort, advertised ? 'off' : undefined)
    })
  }
}

test('explicit inline effort survives normalization and preserves provider failure code', async () => {
  const config = normalizeConfig({ inlineReasoningEffort: 'none' })
  assert.equal(config.inlineReasoningEffort, 'none')
  const ctx = { llm: { async *stream(options) {
    assert.equal(options.reasoningEffort, 'none')
    yield { type: 'text-delta', text: '半截' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'unsupported none' } } }
  } } }
  await assert.rejects(streamInlineCompletion(ctx, config, input, () => {}, new AbortController().signal), /UNSUPPORTED_REASONING_EFFORT: unsupported none/)
})

test('stream cancellation does not wait indefinitely on a stalled provider', async () => {
  const ctx = { llm: { stream() { return { [Symbol.asyncIterator]() { return {
    next: () => new Promise(() => {}), return: async () => ({ done: true }),
  } } } } } }
  const controller = new AbortController()
  const pending = streamInlineCompletion(ctx, normalizeConfig({}), input, () => {}, controller.signal)
  setTimeout(() => controller.abort(new Error('inline timed out')), 20)
  await assert.rejects(pending, /timed out|aborted/)
})
