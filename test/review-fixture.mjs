// Synthetic second-stage response for older routing/format/style tests.
// This is deliberately not a semantic reviewer; claim-review.test.mjs tests
// the real guard and adversarial second-stage responses separately.
export function reviewFixture(options) {
  if (!options.system?.includes('[ACE CLAIM REVIEW v1]')) return null
  const { DRAFT: draft, THREAD: thread } = JSON.parse(options.messages[0].content[0].text)
  const quote = thread.find(row => row.text)?.text || 'fixture observation'
  return JSON.stringify({ card: {
    ...draft,
    text: draft.text,
    why: draft.why || '尝试一个不同机制',
    risk: draft.risk || '需要对照样本才能判断',
    fact: '用户提出了这个请求', fact_source: 'THREAD 用户消息', fact_quote: quote,
    x: draft.x || '当前请求', y: draft.y || '尝试将补偿机制映射到当前问题',
    z: '设想：水池一边漏水一边补水，水位看起来稳定',
    relation: '补水和重试同样可能补偿未处理的损耗',
    hypothesis: '当前现象可能由补偿过程造成', alternative: '也可能是观测记录本身有误',
    verification: '在相同输入下对照有无补偿的记录',
    supports: '关闭补偿后异常增加会提高这个解释的可信度',
    falsify: '关闭补偿后仍稳定，会削弱这个解释',
    unresolved: '仍不能排除观测误差和延迟',
    now: draft.now || '当前有一个待判断的现象', goal: draft.goal || '区分两种可能机制',
    outcome: draft.outcome || '得到可以比较的观察记录',
  } })
}
