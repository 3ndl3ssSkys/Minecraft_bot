'use strict'
// Run with: npm test   (or node test/instructions.test.js)
// Covers: plain directions from the owner the code carries out itself (so a misread never loses them), and the
// leaner state the model reads before each decision.
const path = require('path')
const assert = require('assert')
const { instructionFromText, pruneState } = require(path.join(__dirname, '..', 'index.js'))

const i = (t) => instructionFromText(t)
assert.equal(i('mine down please').plan.name, 'stripMine')
assert.equal(i('look for iron').plan.args.ore, 'iron')
assert.equal(i('look for iron').plan.needs, 'stone_pickaxe', 'iron needs a stone pickaxe first')
assert.equal(i('go find diamonds').plan.needs, 'iron_pickaxe')
assert.equal(i('mine down please look for iron').description, 'mine down and look for iron')
assert.ok(i('staircase instead of mining straight down now'), 'a correction about how to dig down')
assert.ok(i('can you dig down a bit'))
for (const t of ['nice base', 'how are you', 'lol', 'come here', 'iron golem over there']) assert.equal(i(t), null, t)

const s = pruneState({ self: { health: 20, onGround: true, inWater: false }, equipment: { hand: null, head: null }, inventory: { items: {}, freeSlots: 36 }, nearbyEntities: [], places: [], recentActions: [{ action: 'wait', ok: false, code: 'X' }], hints: ['a'] })
assert.deepEqual(s, { self: { health: 20, onGround: true }, inventory: { items: {}, freeSlots: 36 }, recentActions: [{ action: 'wait', ok: false, code: 'X' }], hints: ['a'] })
console.log('All instruction checks passed')
