'use strict'
// Run with: npm test   (or node test/strategy.test.js)
// Covers: the menu of good options each decision gets (strategy.js), and the item planner choosing a player's way to
// get things (acquire.js): sheep for wool, charcoal for torches, never someone's wall torch or campfire.
const path = require('path')
const assert = require('assert')
const { options } = require(path.join(__dirname, '..', 'strategy.js'))
const { nextAcquireStep } = require(path.join(__dirname, '..', 'acquire.js'))
const registry = require('minecraft-data')('1.21.4')

const ids = (v) => options(v).map((o) => o.id)
const base = { tier: 1, health: 20, food: 20, time: 6000, dim: 'overworld', layout: 'outdoors', freeSlots: 20 }

// Fresh spawn: tools first.
assert.deepEqual(ids({ ...base, inv: {} }).slice(0, 2), ['wooden_pickaxe', 'stone_pickaxe'])
// Stone tools and a sword: food, then a bed and iron.
const stone = { stone_pickaxe: 1, stone_sword: 1, bread: 8 }
assert.deepEqual(ids({ ...base, inv: stone }).slice(0, 2), ['bed', 'iron_pickaxe'])
// A beginner (tier 0) doesn't know about beds or iron yet.
assert.ok(!ids({ ...base, tier: 0, inv: stone }).includes('bed'))
// Iron pickaxe, shield etc. at tier 2: diamonds come up once the earlier things are done.
const geared = { iron_pickaxe: 1, iron_sword: 1, shield: 1, bread: 10, white_bed: 1, torch: 30, bucket: 1, iron_chestplate: 1, iron_leggings: 1, iron_helmet: 1, iron_boots: 1 }
assert.ok(ids({ ...base, tier: 2, inv: geared, homeKnown: true })[0] === 'diamonds', JSON.stringify(ids({ ...base, tier: 2, inv: geared, homeKnown: true })))
const diamond = options({ ...base, tier: 2, inv: { ...geared, diamond: 3 }, homeKnown: true })[0]
assert.deepEqual(diamond.action, { name: 'obtainItem', args: { itemName: 'diamond_pickaxe', count: 1 } })

// Urgent things come first: hungry with food → eat; night outdoors without a bed → shelter; full → drop junk.
assert.equal(ids({ ...base, food: 10, inv: stone })[0], 'eat')
assert.equal(ids({ ...base, time: 15000, inv: stone })[0], 'shelter')
assert.equal(ids({ ...base, time: 15000, inv: { ...stone, white_bed: 1 } })[0], 'sleep')
assert.equal(ids({ ...base, freeSlots: 1, inv: stone })[0], 'drop')
assert.equal(ids({ ...base, freeSlots: 1, chestKnown: true, inv: stone })[0], 'store')
assert.equal(ids({ ...base, food: 12, inv: { stone_pickaxe: 1, beef: 4 } })[0], 'eat')
assert.ok(ids({ ...base, food: 12, inv: { stone_pickaxe: 1, beef: 4 } }).includes('cook'), 'raw meat: cook it')
// A fight worth it, or one to get away from (threat.js verdicts).
assert.equal(options({ ...base, inv: stone, threat: { verdict: 'fight', list: [{ id: 5, name: 'zombie', hostile: true, verdict: 'fight', distance: 6, danger: 0.2 }] } })[0].action.name, 'attackTarget')
assert.equal(options({ ...base, inv: stone, threat: { verdict: 'flee', list: [{ id: 6, name: 'vindicator', hostile: true, verdict: 'flee', distance: 5, danger: 1.2 }] } })[0].action.name, 'retreat')
// Only actions it has right now.
assert.ok(!ids({ ...base, inv: stone, tools: new Set(['explore']) }).length)
// At most five.
assert.ok(options({ ...base, food: 10, time: 15000, freeSlots: 1, inv: { beef: 2 } }).length <= 5)

// Item planning like a player.
const step = (item, inv = { stone_pickaxe: 1, oak_log: 5 }, mobs = []) => nextAcquireStep({ item, count: 1, inv, near: {}, registry, knows: () => true, mobs })
assert.equal(step('stick').name, 'craftItem', 'sticks from the planks it can make, not a dead bush')
assert.equal(step('white_wool', undefined, [{ id: 1, name: 'sheep', distance: 8 }]).name, 'attackTarget', 'wool from the sheep right there')
assert.equal(step('white_wool').name, 'explore', 'no sheep in sight: go and find one, not string')
assert.equal(step('white_bed', undefined, [{ id: 1, name: 'sheep', distance: 8 }]).args.entityId, 1, 'a bed starts with the sheep, not with dye')
for (const item of ['torch', 'charcoal']) {
  const s = step(item)
  assert.ok(!/torch|campfire/.test(s.args.blockType || ''), `${item}: never someone's torch or campfire (${JSON.stringify(s)})`)
}
assert.equal(step('sand', {}).args.blockType, 'sand', 'natural blocks are still mined')
console.log('All strategy checks passed')
