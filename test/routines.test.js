'use strict'
// Run with: npm test   (or node test/routines.test.js)
// Covers: reading what a step is after ("chop 20 logs", "find a village") so the code keeps at it without asking the
// model after every block, and the decision state ordered from slow- to fast-changing (for the prompt cache).
const path = require('path')
const assert = require('assert')
const { stepCount, seekTarget, seen } = require(path.join(__dirname, '..', 'routines.js'))
const { stableFirst } = require(path.join(__dirname, '..', 'index.js'))
const registry = require('minecraft-data')('1.21.4')

const c = (t) => stepCount(t, registry)
assert.deepEqual(c('chop 20 oak logs'), { item: 'oak_log', count: 20, anyWood: true })
assert.deepEqual(c('collect 16 wood'), { item: 'oak_log', count: 16, anyWood: true })
assert.deepEqual(c('mine 8 cobblestone'), { item: 'cobblestone', count: 8, anyWood: false })
assert.deepEqual(c('get 3 iron ingots'), { item: 'iron_ingot', count: 3, anyWood: false })
assert.equal(c('mine 5 iron').item, 'raw_iron')
assert.equal(c('smelt 3 iron').item, 'iron_ingot')
assert.equal(c('craft a stone pickaxe'), null, 'no amount: nothing to keep at')
assert.equal(c('find trees'), null)

assert.equal(seekTarget('find trees').label, 'trees')
assert.equal(seekTarget('look for a village').label, 'a village')
assert.equal(seekTarget('search for cows').label, 'cows')
assert.equal(seekTarget('explore east'), null, 'just exploring: no target')
assert.equal(seekTarget('chop 20 logs'), null)

const state = { nearbyBlocks: { birch_log: { count: 5, distance: 9, visible: true } }, nearbyEntities: [{ name: 'cow', distance: 12 }] }
assert.match(seen(seekTarget('find trees'), state), /birch log 9 blocks/)
assert.match(seen(seekTarget('look for cows'), state), /cow 12/)
assert.equal(seen(seekTarget('find a village'), state), null)
assert.equal(seen(seekTarget('find trees'), { nearbyBlocks: { oak_log: { distance: 20, visible: false } } }), null, 'remembered, not in sight')

// Slow-changing first, fast-changing last; nothing dropped.
const s = stableFirst({ self: { position: 1 }, recentActions: [1], rules: ['x'], inventory: { items: {} }, status: { feelings: 'calm', goals: {}, currentAction: 'wait' }, world: { timeOfDay: 6420, phase: 'day' }, extra: 1 })
assert.deepEqual(Object.keys(s), ['rules', 'inventory', 'status', 'world', 'self', 'recentActions', 'extra'])
assert.deepEqual(Object.keys(s.status), ['goals', 'currentAction', 'feelings'])
assert.equal(s.world.timeOfDay, 6000, 'the hour, not the tick')
console.log('All routine checks passed')
