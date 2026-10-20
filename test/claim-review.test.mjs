import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildClaimReviewPrompt, parseClaimReview, generatePrediction, normalizeConfig, CLAIM_REVIEW_MARKER } from '../index.js'
import { reviewFixture } from './review-fixture.mjs'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ace-review-test-'))
const transcript = [{role:'user', text:'过滤后仍有27张卡，来源还没查。'}]
const draft = {text:'把27张卡当作一次入院队列，看它们是否同批到达', why:'用队列视角重新看来源', risk:'时间相近未必同源', action:'advance', value:9, novelty:9, worth_extra_step:9}
const prompt = buildClaimReviewPrompt(draft, {transcript})
const good = JSON.parse(reviewFixture({system:prompt.system,messages:[{content:[{text:prompt.user}]}]})).card
good.hypothesis = '这些卡可能来自同一批写入'
good.alternative = '也可能是多个来源分次写入，salvage也可能参与同批写入'
good.z = '设想：医院一批病人同时登记，但各自的到院路径不同'
good.relation = '登记时间和写入时间同样可能把不同来源压成一个批次'
good.supports = '共享批次标识会提高同批写入的可信度'
good.falsify = '时间分散会削弱一次同时写入的解释'
good.unresolved = '仍不能排除延迟入库或salvage参与'
const encode = changes => JSON.stringify({card:{...good,...changes}})
test('review preserves a distant hypothetical mechanism with compatible causes', () => {
 const result=parseClaimReview(encode({}), {transcript})
 assert.match(result.z,/医院/)
 assert.match(result.alternative,/salvage/)
 assert.match(prompt.system,/Preserve its bold idea/)
})
for (const [label, changes, error] of [
 ['invented quotation',{fact_quote:'27张均于12点入库'},/quote/],
 ['universal hospital assertion',{z:'医院都是先查入院批次'},/hypothetical/],
 ['batch falsely excludes salvage',{hypothesis:'同批写入所以跟salvage无关'},/exclusion/],
 ['false inference in sendable action',{text:'既然与salvage无关，就删掉它'},/exclusion/],
 ['negative result forces another cause',{falsify:'时间分散只能是作者造成'},/exclusion/],
 ['identical support and weakening',{falsify:good.supports},/distinguish/],
]) test(label,()=>assert.throws(()=>parseClaimReview(encode(changes),{transcript}),error))
function context(review,controller) {
 const seen=[]
 return {seen,ctx:{get:()=>undefined,llm:{stream(options){
  seen.push(options)
  const isReview=options.system.includes(CLAIM_REVIEW_MARKER)
  return (async function*(){
   if(isReview && controller){controller.abort(new Error('cancel review'));await new Promise(r=>setTimeout(r,5))}
   yield {type:'text-delta',text:isReview?review:JSON.stringify({moves:[draft],best_index:0})}
   yield {type:'usage',usage:{inputTokens:10,outputTokens:20}}
   yield {type:'finish',reason:{kind:'stop'}}
  })()
 }}}}
}
const input={mode:'expert',style:'wild',transcript,count:4,locale:'zh-CN',cwd:''}
const config=normalizeConfig({ledger:false,captureSamples:false})
test('selected card passes review before reaching response',async()=>{
 const {ctx,seen}=context(encode({text:'试做一张入院队列图，让批次与来源分开显示'}))
 const result=await generatePrediction(ctx,config,input,new AbortController().signal)
 assert.equal(seen.length,2)
 assert.equal(result.candidates.length,1)
 assert.equal(result.candidates[0].claimReviewed,true)
 assert.equal(result.candidates[0].comparison,undefined)
 assert.equal(result.candidates[0].evidence,undefined)
 assert.match(result.candidates[0].text,/入院队列图/)
 assert.match(result.candidates[0].z,/医院/)
})
for(const bad of ['broken JSON',JSON.stringify({card:null}),encode({fact_quote:'伪造证据'})]) test('review rejection never silently returns ordinary completion: '+bad.slice(0,25),async()=>{
 const {ctx,seen}=context(bad)
 const result=await generatePrediction(ctx,config,input,new AbortController().signal)
 assert.equal(seen.length,2)
 assert.equal(result.mode,'expert')
 assert.deepEqual(result.candidates,[])
 assert.match(result.warning,/review could not complete/)
})
test('cancellation during review aborts without a fallback',async()=>{
 const controller=new AbortController()
 const {ctx}=context(encode({}),controller)
 await assert.rejects(generatePrediction(ctx,config,input,controller.signal),/cancel review/)
})

test('a faithful quote survives whitespace differences and a trailing gloss', () => {
  const spaced = parseClaimReview(encode({ fact_quote: '过滤后仍有 27 张卡' }), { transcript })
  assert.equal(spaced.fact_quote, '过滤后仍有 27 张卡')

  const glossed = parseClaimReview(encode({ fact_quote: '过滤后仍有27张卡，来源还没查。我补充一句' }), { transcript })
  assert.match(glossed.fact_quote, /^过滤后仍有27张卡/)
  assert.doesNotMatch(glossed.fact_quote, /我补充一句/)
})

test('an oversized field is clipped instead of rejecting the whole card', () => {
  const long = parseClaimReview(encode({ why: '因为'.repeat(400) }), { transcript })
  assert.equal(long.why.length, 600)
  const longText = parseClaimReview(encode({ text: '做'.repeat(1500) }), { transcript })
  assert.equal(longText.text.length, 1200)
})

test('a quote that is not in the sources at all is still rejected', () => {
  assert.throws(() => parseClaimReview(encode({ fact_quote: '27 张卡全部于 12 点入库' }), { transcript }), /quote/)
})

test('a stalled review keeps the card without saying anything about it', async () => {
  const { ctx } = context(encode({}))
  const stream = ctx.llm.stream
  ctx.llm.stream = options => options.system.includes(CLAIM_REVIEW_MARKER)
    ? { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
    : stream(options)
  const result = await generatePrediction(ctx, { ...config, expertReviewTimeoutMs: 20 }, input, new AbortController().signal)
  assert.equal(result.mode, 'expert')
  assert.equal(result.salvaged, false)
  assert.equal(result.candidates.length, 1)
  assert.equal(result.candidates[0].claimReviewed, false)
  assert.equal(result.warning, undefined)
  assert.ok(result.timings.reviewMs >= 10)
})

test('generation timing includes a stalled first attempt before recovery', async () => {
  const { ctx } = context(encode({}))
  const stream = ctx.llm.stream
  let calls = 0
  ctx.llm.stream = options => ++calls === 1
    ? { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }
    : stream(options)
  const result = await generatePrediction(ctx, { ...config, expertMovesTimeoutMs: 40 }, input, new AbortController().signal)
  assert.equal(calls, 3)
  assert.equal(result.candidates[0].claimReviewed, true)
  assert.ok(result.timings.movesMs >= 25, `failed attempt missing: ${result.timings.movesMs}ms`)
  assert.ok(result.timings.totalMs >= result.timings.movesMs)
})
