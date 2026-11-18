'use strict'
// Run with: npm test   (or node test/habits.test.js)
// Covers: housekeeping habits — armor, shield, replacing worn tools, junk, a tidy hotbar
const path = require('path')
const assert = require('assert')
const { armorStep, shieldStep, toolStep, junkStep, hotbarMoves } = require(path.join(__dirname, '..', 'habits.js'))

const it = (name, count = 1, used = 0, max = 0) => ({ name, count, durabilityUsed: used, maxDurability: max || undefined })

// armor: iron over leather, anything over nothing, elytra stays
assert.deepEqual(armorStep([it('iron_helmet')], { head: 'leather_helmet' }).args, { itemName: 'iron_helmet', destination: 'head' })
assert.deepEqual(armorStep([it('leather_boots')], {}).args, { itemName: 'leather_boots', destination: 'feet' })
assert.equal(armorStep([it('leather_helmet')], { head: 'iron_helmet' }), null)
assert.equal(armorStep([it('iron_chestplate')], { torso: 'elytra' }), null)
// shield
assert.equal(shieldStep([it('shield')], {}, 3).args.destination, 'off-hand')
assert.equal(shieldStep([it('shield')], { offHand: 'torch' }, 3), null)
assert.equal(shieldStep([it('shield')], {}, 1), null, 'a beginner does not think of it')
// tools: about to break, no spare → a new one; beginners let it break
const worn = [it('iron_pickaxe', 1, 245, 250)]
assert.deepEqual(toolStep(worn, (n) => n === 'iron_pickaxe', 3).args, { itemName: 'iron_pickaxe', count: 1 })
assert.deepEqual(toolStep(worn, (n) => n === 'stone_pickaxe', 3).args, { itemName: 'stone_pickaxe', count: 1 }, 'no iron: stone will do')
assert.equal(toolStep(worn, () => true, 1), null)
assert.equal(toolStep([...worn, it('stone_pickaxe', 1, 0, 131)], () => true, 3), null, 'has a spare')
assert.equal(toolStep([it('iron_pickaxe', 1, 20, 250)], () => true, 3), null, 'still fine')
// junk: only when full, keeps a little
const j = junkStep([it('rotten_flesh', 30), it('dirt', 64), it('diamond', 3)], 0)
assert.match(j.args.itemNames, /rotten_flesh/)
assert.match(j.args.itemNames, /dirt/)
assert.ok(!/diamond/.test(j.args.itemNames))
assert.equal(junkStep([it('rotten_flesh', 30)], 5), null)
// hotbar: sword to slot 1, pickaxe to slot 2
const slots = new Array(46).fill(null)
slots[36] = it('dirt', 20); slots[37] = it('iron_sword'); slots[12] = it('stone_pickaxe'); slots[13] = it('iron_pickaxe')
const moves = hotbarMoves(slots)
assert.deepEqual(moves[0], { from: 37, to: 36 }, 'sword first')
assert.deepEqual(moves[1], { from: 13, to: 37 }, 'the better pickaxe second')
const tidy = new Array(46).fill(null)
tidy[36] = it('iron_sword'); tidy[37] = it('iron_pickaxe')
assert.equal(hotbarMoves(tidy).length, 0)
console.log('All habit checks passed')
