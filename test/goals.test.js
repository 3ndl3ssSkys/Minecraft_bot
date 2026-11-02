'use strict'
// Run with: npm test   (or node test/goals.test.js)
// Covers: the goal hierarchy (config goals, owner goals, its own goals), progress from decisions,
// detours around set goals, planning merges, when it replans, saving, the respawn action's limits
const path = require('path')
const assert = require('assert')
const R = path.join(__dirname, '..') + path.sep
const { DEFAULT_CONFIG, deepMerge } = require(R + 'index.js')
const { Goals, similar } = require(R + 'goals.js')
const { ACTIONS } = require(R + 'actions.js')

function agentWith (goals = {}) {
  const config = deepMerge(DEFAULT_CONFIG, { goals })
  const events = []
  return { config, events, memory: { addEvent: (t, x) => events.push(x), events: [] }, log: { info: () => {}, debug: () => {} }, learning: { markDirty: () => {} } }
}

console.log('== similar ==')
assert(similar('gather 64 cobblestone', 'get some cobblestone'))
assert(!similar('build a castle', 'go fishing'))
console.log('ok')

console.log('\n== goals from config ==')
let a = agentWith({ overarching: 'become the best builder on the server', longTerm: ['build a castle on the hill'], current: 'gather 64 cobblestone' })
let g = new Goals(a, {})
assert.equal(g.life.text, 'become the best builder on the server')
assert(g.life.fixed && g.current.fixed)
assert.equal(g.longTerm[0].text, 'build a castle on the hill')
assert.equal(g.current.parent, g.longTerm[0].id) // the current goal serves the castle
console.log(g.oneLine())
console.log('ok')

console.log('\n== progress from decisions ==')
g.setSteps(['craft a stone pickaxe', 'mine cobblestone', 'bring it to the hill'])
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: 'craft a stone pickaxe', goalStatus: 'subgoal_done' })
assert(g.current.steps[0].done && g.current.now === 1)
// Something urgent: a set goal waits as a detour instead of being replaced.
g.onDecision({ goal: 'eat something, I am starving', subgoal: 'cook the beef', goalStatus: 'working' })
assert.equal(g.current.text, 'gather 64 cobblestone')
assert.equal(g.currentText(), 'eat something, I am starving')
console.log('detour:', g.oneLine())
g.onDecision({ goal: 'eat something', subgoal: '', goalStatus: 'goal_done' }) // done eating → back to the real goal
assert.equal(g.currentText(), 'gather 64 cobblestone')
// A step it makes up on the way is slotted in.
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: 'find a cave entrance', goalStatus: 'working' })
assert(g.current.steps.some((s) => s.text === 'find a cave entrance'))
assert.equal(g.current.steps[g.current.now].text, 'find a cave entrance')
// Stuck twice → it wants to rethink.
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: 'mine cobblestone', goalStatus: 'blocked' })
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: 'mine cobblestone', goalStatus: 'blocked' })
assert(/stuck/.test(g.needsPlan()))
g.lastPlanAt = 0
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: '', goalStatus: 'goal_done' })
assert.equal(g.current, null)
assert(a.events.some((e) => /finished your goal: gather 64 cobblestone/.test(e)))
console.log('ok')

console.log('\n== its own goals change with its mind ==')
a = agentWith({})
g = new Goals(a, {})
g.onDecision({ goal: 'explore the forest', subgoal: 'walk north', goalStatus: 'working' })
assert.equal(g.current.source, 'self')
g.onDecision({ goal: 'drink some milk', subgoal: '', goalStatus: 'working' })
assert.equal(g.current.text, 'explore the forest') // under way: a quick detour doesn't wipe the plan
assert.equal(g.currentText(), 'drink some milk')
g.onDecision({ goal: 'build a little hut', subgoal: 'get logs', goalStatus: 'new_goal' })
assert.equal(g.current.text, 'explore the forest') // a fresh goal is kept for a couple of minutes: no flip-flopping
g.current.at -= 3 * 60000
g.onDecision({ goal: 'build a little hut', subgoal: 'get logs', goalStatus: 'new_goal' })
assert.equal(g.current.text, 'build a little hut') // changed its mind after a while: replaced
assert(g.history.some((h) => h.status === 'changed' && h.text === 'explore the forest'))
console.log('ok')

// A detour that goes on for minutes becomes the new goal (its own goals only).
g.onDecision({ goal: 'go mining', subgoal: '', goalStatus: 'working' })
g.current.detourAt -= 4 * 60000
g.onDecision({ goal: 'go mining', subgoal: 'find a cave', goalStatus: 'working' })
assert.equal(g.current.text, 'go mining')
g.onDecision({ goal: 'build a little hut', subgoal: 'get logs', goalStatus: 'new_goal' })
console.log('ok')

console.log('\n== planning ==')
g.lastPlanAt = 0
console.log('needs a plan because:', g.needsPlan())
assert(g.needsPlan())
g.addLongTerm('get full iron armor', 'EndlessSkys') // set by an owner: kept
g.applyPlan({
  overarching: 'have a cozy base and good gear',
  longTerm: [{ text: 'build a cozy base by the lake', status: 'active' }, { text: 'get full iron armor', status: 'active' }],
  current: 'build a little hut',
  steps: ['chop 20 logs', 'craft planks', 'build walls and a roof'],
  why: 'I want somewhere safe to sleep first.'
})
assert.equal(g.life.text, 'have a cozy base and good gear')
assert(g.longTerm.some((x) => x.status === 'active' && x.text === 'get full iron armor' && x.fixed))
assert(g.longTerm.some((x) => x.status === 'active' && /cozy base/.test(x.text)))
assert.deepEqual(g.current.steps.map((s) => s.text), ['chop 20 logs', 'craft planks', 'build walls and a roof'])
// A plan that "forgets" the owner's goal can't drop it; one that says it's done can finish it.
g.applyPlan({ overarching: '', longTerm: [{ text: 'build a cozy base by the lake', status: 'active' }], current: '', steps: [], why: '' })
assert(g.longTerm.some((x) => x.status === 'active' && x.text === 'get full iron armor'))
g.applyPlan({ overarching: '', longTerm: [{ text: 'get full iron armor', status: 'done' }, { text: 'build a cozy base by the lake', status: 'active' }], current: '', steps: [], why: '' })
assert(!g.longTerm.some((x) => x.status === 'active' && x.text === 'get full iron armor'))
console.log('prompt view:', JSON.stringify(g.forPrompt()))
console.log('ok')

console.log('\n== not self-directed: only what it was given ==')
a = agentWith({ selfDirected: false, longTerm: ['beat the ender dragon'] })
g = new Goals(a, {})
g.applyPlan({ overarching: 'rule the world', longTerm: [{ text: 'collect every flower', status: 'active' }], current: 'get eyes of ender', steps: ['kill endermen', 'get blaze rods'], why: '' })
assert.equal(g.life, null)
assert(!g.longTerm.some((x) => /flower/.test(x.text)))
assert.equal(g.current.text, 'get eyes of ender')
console.log('ok')

console.log('\n== saving ==')
a = agentWith({ current: 'gather 64 cobblestone' })
g = new Goals(a, {})
g.onDecision({ goal: 'gather 64 cobblestone', subgoal: 'mine cobblestone', goalStatus: 'subgoal_done' })
const saved = JSON.parse(JSON.stringify(g.toJSON()))
const again = new Goals(agentWith({ current: 'gather 64 cobblestone' }), saved)
assert(again.current.steps.some((s) => s.done)) // same config: progress kept
const changed = new Goals(agentWith({ current: 'build a bridge' }), saved)
assert.equal(changed.current.text, 'build a bridge') // config changed: it wins
console.log('ok')

console.log('\n== dying on purpose has limits ==')
const run = (over) => ACTIONS.respawn.run({ bot: { game: { hardcore: over.hardcore }, chat: () => {}, clearControlStates: () => {} }, config: deepMerge(DEFAULT_CONFIG, { behavior: { allowRespawnOnPurpose: over.allowed } }), memory: { addEvent: () => {} } }, { reason: 'stuck' })
;(async () => {
  await assert.rejects(run({ hardcore: true, allowed: true }), /hardcore/)
  await assert.rejects(run({ hardcore: false, allowed: false }), /switched off/)
  console.log('ok')
  console.log('\nAll goal checks passed')
})()
