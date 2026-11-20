'use strict'
// Run with: npm test   (or node test/mindcraft.test.js)
// Covers: reading answers from models trained for Mindcraft (mindcraft.js), and the model comparison's questions
// (scripts/compare-models.js): answers taken from the game's data, situations with one clear answer.
const path = require('path')
const assert = require('assert')
const mc = require(path.join(__dirname, '..', 'mindcraft.js'))
const { knowledgeQuestions, judgmentQuestions, picked } = require(path.join(__dirname, '..', 'scripts', 'compare-models.js'))

const c = mc.find('<think>hmm</think>I need wood first. !collectBlocks("oak_log", 10)')
assert.equal(c.thought, 'I need wood first.')
assert.deepEqual(mc.toAction(c), { name: 'mineBlock', args: { blockType: 'oak_log', count: 10 } })
assert.deepEqual(mc.toAction(mc.find('!craftRecipe("wooden_pickaxe", 1)')), { name: 'craftItem', args: { itemName: 'wooden_pickaxe', count: 1 } })
assert.deepEqual(mc.toAction(mc.find("ok !goToPlayer('EndlessSkys', 3)")), { name: 'moveToPlayer', args: { playerName: 'EndlessSkys', range: 3 } })
assert.deepEqual(mc.toAction(mc.find('!attack("zombie")'), { entity: (t) => (t === 'zombie' ? 42 : null) }), { name: 'attackTarget', args: { entityId: 42 } })
assert.equal(mc.toAction(mc.find('!attack("zombie")'), { entity: () => null }), null, 'nothing to attack')
assert.deepEqual(mc.toAction(mc.find('!searchForBlock("iron_ore", 32)'), { block: () => ({ x: 1, y: 12, z: 3 }) }), { name: 'moveToBlock', args: { x: 1, y: 12, z: 3, range: 2 } })
assert.deepEqual(mc.toAction(mc.find('!stop')), { name: 'wait', args: { seconds: 5 } })
assert.equal(mc.toAction(mc.find('!newAction("build a house")')), null, 'writing code has no counterpart')
assert.equal(mc.find('no command here'), null)
assert.deepEqual(mc.splitArgs('"a, b", 3, true'), ['a, b', 3, true])
// In a decision: Ollama's JSON mode makes such a model write JSON, with the command inside a text field.
const { Brain } = require(path.join(__dirname, '..', 'index.js'))
const warned = []
const brain = new Brain({
  config: { logging: { logThoughts: false }, loop: { errorBackoffMs: 1000 } },
  log: { warn: (m) => warned.push(m), info () {}, debug () {}, mind () {} },
  memory: { addEvent () {} },
  emotions: { fromLabel () {} },
  goals: { onDecision () {} },
  tasks: { onLlmUpdate () {} },
  mindcraftLookup: () => ({})
})
const tools = ['mineBlock', 'craftItem', 'wait', 'explore']
let d = brain.finishDecision({ thought: 'wood first', action: '!collectBlocks("birch_log", 6)' }, tools)
assert.deepEqual(d.action, { name: 'mineBlock', args: { blockType: 'birch_log', count: 6 } })
d = brain.finishDecision({ response: 'Sure! !craftRecipe("crafting_table", 1)' }, tools)
assert.deepEqual(d.action, { name: 'craftItem', args: { itemName: 'crafting_table', count: 1 } })
d = brain.finishDecision({ thought: 'mine', action: { name: 'mineBlock', args: { blockType: 'stone' } } }, tools)
assert.deepEqual(d.action, { name: 'mineBlock', args: { blockType: 'stone' } }, 'a normal answer is untouched')
console.log('mindcraft commands ok')

const k = knowledgeQuestions(40, '1.21.4')
assert.ok(k.length >= 30)
for (const q of k) { assert.equal(q.choices.length, 4); assert.equal(new Set(q.choices).size, 4, q.q) }
const obs = k.find((q) => /obsidian so/.test(q.q))
if (obs) assert.equal(obs.choices[obs.answer], 'diamond pickaxe')
const tq = k.find((q) => /crafting torch/.test(q.q))
if (tq) assert.ok(['coal', 'stick'].includes(tq.choices[tq.answer]))
assert.deepEqual(knowledgeQuestions(40, '1.21.4'), k, 'the same questions every run')
const j = judgmentQuestions()
assert.equal(j.length, 10)
assert.ok(j.every((x) => x.answer >= 0 && x.answer < x.n))
assert.equal(picked({ json: { answer: 'c' }, text: '' }, 'answer'), 2)
assert.equal(picked({ json: null, text: 'The answer is B.' }, 'answer'), 1)
assert.equal(picked({ json: { choose: 3 }, text: '' }, 'choose', 4), 2)
assert.equal(picked({ json: { choose: 7 }, text: '' }, 'choose', 4), null)
console.log('comparison questions ok')
console.log('mindcraft tests passed')
