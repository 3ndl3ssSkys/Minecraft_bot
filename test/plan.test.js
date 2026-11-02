'use strict'
// The "next" follow-up plan: runs without asking the model again, only while nothing has changed.
const assert = require('assert')
const { Brain } = require('../index.js')
const mk = (over = {}) => {
  const agent = {
    bot: { health: 20 }, memory: { chat: [], goal: 'get stone tools' },
    dangerLevel: () => 'none', executor: { availableTools: () => ['craftItem', 'mineBlock', 'wait'] }, ...over
  }
  return Object.assign(Object.create(Brain.prototype), { agent, plan: null })
}
const llm = { source: 'llm', action: { name: 'mineBlock', args: {} }, next: [{ name: 'craftItem', args: { itemName: 'stone_pickaxe' } }, { name: 'wait', args: { seconds: 1 } }] }
const ok = { ok: true }

let b = mk(); b.trackPlan(llm, ok)
let step = b.nextPlanned()
assert.equal(step.source, 'plan'); assert.equal(step.action.name, 'craftItem')
b.trackPlan(step, ok)
step = b.nextPlanned(); assert.equal(step.action.name, 'wait')
b.trackPlan(step, ok)
assert.equal(b.nextPlanned(), null, 'plan used up: ask the model again')

b = mk(); b.trackPlan(llm, { ok: false }); assert.equal(b.nextPlanned(), null, 'a failed action cancels the plan')
b = mk(); b.trackPlan(llm, ok); b.agent.memory.chat.push({}); assert.equal(b.nextPlanned(), null, 'new chat cancels the plan')
b = mk(); b.trackPlan(llm, ok); b.agent.bot.health = 15; assert.equal(b.nextPlanned(), null, 'getting hurt cancels the plan')
b = mk(); b.trackPlan(llm, ok); b.agent.dangerLevel = () => 'high'; assert.equal(b.nextPlanned(), null, 'danger cancels the plan')
b = mk(); b.trackPlan(llm, ok); b.agent.memory.goal = 'something else'; assert.equal(b.nextPlanned(), null, 'a changed goal cancels the plan')
b = mk(); b.trackPlan(llm, ok); b.plan.at -= 100000; assert.equal(b.nextPlanned(), null, 'an old plan is dropped')
b = mk(); b.trackPlan(llm, ok); b.trackPlan({ source: 'reflex', action: {} }, ok); assert.equal(b.nextPlanned(), null, 'a reflex interrupts the plan')
console.log('ALL PLAN CHECKS PASSED')
