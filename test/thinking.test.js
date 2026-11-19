'use strict'
// Run with: npm test   (or node test/thinking.test.js)
// Covers: thinking time by situation (Brain.thinkingBudget), the split-second option pick on the small model
// (Brain.quickChoice) with its deadline, and the deadline on calm decisions (the best option goes ahead and the late
// answer is kept for right after it).
const path = require('path')
const assert = require('assert')
const { Brain, DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'index.js'))

const opt = (id, urgent = false) => ({ id, why: `because ${id}`, urgent, action: { name: id === 'eat' ? 'eatFood' : 'explore', args: {} } })

function agentStub ({ danger = 'none', options = [], llm } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  config.busyWork.enabled = false
  const logs = []
  return {
    config,
    logs,
    log: { info: (m) => logs.push(m), debug: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    bot: { username: 'Tester', health: 18, food: 12, entities: {}, entity: {} },
    memory: { events: [{ at: Date.now(), text: 'A zombie appeared.' }], chat: [], goal: 'get iron' },
    intelligence: { name: 'advanced' },
    dangerInfo: () => ({ level: danger, reason: danger === 'none' ? '' : 'a zombie is nearby' }),
    dangerLevel: () => danger,
    strategyOptions: () => options,
    threat: () => ({ list: [], verdict: 'safe' }),
    llm,
    executor: { abort: () => {} }
  }
}

;(async () => {
  // Calm, nothing urgent: a full decision with the deadline from the config.
  let b = new Brain(agentStub({ options: [opt('iron_pickaxe')] }))
  assert.equal(b.thinkingBudget().mode, 'full')
  assert.equal(b.thinkingBudget().ms, 12000)
  // Something urgent with a choice: a quick pick.
  b = new Brain(agentStub({ options: [opt('eat', true), opt('iron_pickaxe')] }))
  assert.equal(b.thinkingBudget().mode, 'quick')
  // Only one thing to do: no model at all.
  b = new Brain(agentStub({ options: [opt('eat', true)] }))
  assert.equal(b.thinkingBudget().mode, 'instant')
  // High danger with an urgent option: instant, whatever else there is.
  b = new Brain(agentStub({ danger: 'high', options: [opt('eat', true), opt('iron_pickaxe')] }))
  assert.equal(b.thinkingBudget().mode, 'instant')
  assert.equal(b.thinkingBudget().options[0].id, 'eat')
  // Switched off: always full, no deadline.
  const off = agentStub({ options: [opt('eat', true), opt('x')] })
  off.config.loop.thinking.enabled = false
  assert.deepEqual(new Brain(off).thinkingBudget(), { mode: 'full', ms: 0 })

  // The quick pick: a tiny prompt to the small model, its number taken.
  let asked = null
  const quickLlm = { chat: async (messages, o) => { asked = { messages, o }; return { choose: 2 } } }
  b = new Brain(agentStub({ options: [opt('eat', true), opt('iron_pickaxe')], llm: quickLlm }))
  let d = await b.quickChoice(b.thinkingBudget())
  assert.equal(d.chosen, 'iron_pickaxe')
  assert.equal(d.source, 'quick')
  assert.ok(asked.o.fast && asked.o.maxTokens <= 16, 'small model, a few tokens out')
  const promptChars = asked.messages.reduce((a, m) => a + m.content.length, 0)
  assert.ok(promptChars < 1200, `tiny prompt (${promptChars} chars)`)
  assert.ok(/1\. eatFood/.test(asked.messages[1].content) && /2\. explore/.test(asked.messages[1].content))

  // Late or confused: the best option, within the budget.
  const slowLlm = { chat: (messages, o) => new Promise((resolve, reject) => { const t = setTimeout(() => resolve({ choose: 2 }), 2000); o.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('gave up')) }) }) }
  b = new Brain(agentStub({ options: [opt('eat', true), opt('iron_pickaxe')], llm: slowLlm }))
  const budget = { ...b.thinkingBudget(), ms: 150 }
  let t0 = Date.now()
  d = await b.quickChoice(budget)
  assert.equal(d.chosen, 'eat')
  assert.ok(Date.now() - t0 < 600, `decided in ${Date.now() - t0} ms`)
  b = new Brain(agentStub({ options: [opt('eat', true), opt('x')], llm: { chat: async () => ({ choose: 9 }) } }))
  assert.equal((await b.quickChoice(b.thinkingBudget())).chosen, 'eat', 'a number out of range: the best option')

  // A reflex during the quick pick wins.
  b = new Brain(agentStub({ options: [opt('eat', true), opt('x')], llm: slowLlm }))
  setTimeout(() => b.interruptFn({ source: 'reflex', action: { name: 'retreat', args: {} } }), 50)
  assert.equal((await b.quickChoice({ ...b.thinkingBudget(), ms: 1000 })).source, 'reflex')

  // A calm decision past its deadline: the best option goes ahead, the late answer is kept as the next decision.
  b = new Brain(agentStub({ options: [opt('iron_pickaxe')] }))
  let finish
  b.decide = () => new Promise((resolve) => { finish = resolve })
  t0 = Date.now()
  d = await b.thinkWhileBusy({ mode: 'full', ms: 120, options: [opt('iron_pickaxe')] })
  assert.equal(d.chosen, 'iron_pickaxe')
  assert.ok(Date.now() - t0 < 500)
  assert.ok(b.prethought, 'the late answer is waited for after this action')
  finish({ source: 'llm', action: { name: 'mineBlock', args: {} } })
  assert.equal((await b.usePrethought()).action.name, 'mineBlock')
  // In time: the model's own answer.
  b = new Brain(agentStub({ options: [opt('iron_pickaxe')] }))
  b.decide = async () => ({ source: 'llm', action: { name: 'craftItem', args: {} } })
  d = await b.thinkWhileBusy({ mode: 'full', ms: 2000, options: [opt('iron_pickaxe')] })
  assert.equal(d.action.name, 'craftItem')
  assert.ok(!b.prethought)

  console.log('thinking tests passed')
})().catch((err) => { console.error(err); process.exit(1) })
