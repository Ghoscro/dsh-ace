import {test} from 'node:test'
import assert from 'node:assert/strict'
import {parseExpertSelection, selectBestMove, buildExpertPrompt} from '../index.js'
const sample = {text:'给候选标出来源，再对照关闭 salvage 的结果',why:'隐藏回流可能绕过过滤',fact:'用户报告仍有27张卡',fact_source:'THREAD 最后用户消息',hypothesis:'salvage 可能让被过滤候选重新出现',verification:'固定同一输入，对照候选来源与关闭回流的结果',falsify:'关闭后来源和卡片不变，则降低回流假设的可信度',x:'卡片持续出现',y:'隐藏回流可能补回被过滤的候选',z:'消防通道的堵塞可能比摄像头数量更影响逃生',relation:'卡片回流和消防堵塞同样指向显眼指标以外的实际路径',surface_like:false,action:'reframe',value:10,novelty:10,worth_extra_step:10,insight:10}
test('epistemic roles survive parsing and winner selection with a far analogy',()=>{
 const selection=parseExpertSelection(JSON.stringify(sample));const card=selectBestMove(selection)
 assert.ok(card)
 for(const key of ['fact','fact_source','hypothesis','verification','falsify','z','relation'])assert.equal(card[key],sample[key])
})
test('missing provenance never becomes an observation; legacy cards remain compatible',()=>{
 const parsed=parseExpertSelection(JSON.stringify({...sample,fact_source:''})).moves[0]
 assert.equal(parsed.fact,'');assert.equal(parsed.hypothesis,sample.hypothesis)
 const old=parseExpertSelection(JSON.stringify({text:'试试另一个方向',why:'打开不同可能'})).moves[0]
 assert.equal(old.fact,'');assert.equal(old.hypothesis,'')
})
test('all modes keep epistemic distinctions without taming bold exploration',()=>{
 for(const mode of ['safe','standard','brainstorm','wild']){
  const prompt=buildExpertPrompt({transcript:[{role:'user',text:'帮我打开思路'}],locale:'zh-CN',mode,count:4})
  assert.match(prompt.user,/analogy is not evidence/)
  assert.match(prompt.user,/weakens or rejects THIS hypothesis/)
  assert.match(prompt.user,/Preserve bold hypotheses, far analogies/)
 }
})
