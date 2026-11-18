'use strict'
// Run with: npm test   (or node test/commonsense.test.js)
// Covers: the common-sense check before actions (no fourth crafting table, no downgrades, no eating when full...)
const path = require('path')
const assert = require('assert')
const { review, carryHints } = require(path.join(__dirname, '..', 'commonsense.js'))

const act = (name, args = {}, source = 'llm') => ({ source, action: { name, args } })
const base = { inv: {}, items: [], equipped: {}, recent: [], wants: () => false, food: 15, health: 20, time: 6000 }
const view = (extra) => ({ ...base, ...extra })
const tool = (name, used = 0, max = 250) => ({ name, count: 1, maxDurability: max, durabilityUsed: used })

// The bug from the user's log: three crafting tables in the pocket, crafting a fourth.
let r = review(act('craftItem', { itemName: 'crafting_table' }), view({ inv: { crafting_table: 3, oak_planks: 12 } }))
assert.equal(r.code, 'ALREADY_HAVE')
assert.match(r.message, /3 crafting tables/)
assert.equal(review(act('obtainItem', { itemName: 'furnace' }), view({ inv: { furnace: 1 } })).code, 'ALREADY_HAVE')
// ...unless someone actually asked for one
assert.equal(review(act('craftItem', { itemName: 'crafting_table' }), view({ inv: { crafting_table: 1 }, wants: (i) => i === 'crafting_table' })), null)
// none yet: fine
assert.equal(review(act('craftItem', { itemName: 'crafting_table' }), view({ inv: { oak_planks: 4 } })), null)

// Tools: no downgrade, no duplicate unless it's worn out
assert.equal(review(act('craftItem', { itemName: 'wooden_pickaxe' }), view({ items: [tool('iron_pickaxe')] })).code, 'ALREADY_HAVE')
assert.equal(review(act('craftItem', { itemName: 'stone_pickaxe' }), view({ items: [tool('stone_pickaxe', 10, 131)] })).code, 'ALREADY_HAVE')
assert.equal(review(act('craftItem', { itemName: 'stone_pickaxe' }), view({ items: [tool('stone_pickaxe', 125, 131)] })), null, 'nearly broken: a replacement is fine')
assert.equal(review(act('craftItem', { itemName: 'iron_pickaxe' }), view({ items: [tool('stone_pickaxe')] })), null, 'an upgrade is fine')
assert.equal(review(act('craftItem', { itemName: 'stone_sword' }), view({ items: [tool('iron_pickaxe')] })), null, 'another kind of tool is fine')
// Armor
assert.equal(review(act('craftItem', { itemName: 'leather_helmet' }), view({ equipped: { head: 'iron_helmet' } })).code, 'ALREADY_HAVE')
assert.equal(review(act('craftItem', { itemName: 'iron_boots' }), view({ equipped: { head: 'iron_helmet' } })), null)

// The same thing failing twice
const failed = { action: 'mineBlock', args: { blockType: 'iron_ore', count: 3 }, ok: false, code: 'NOT_FOUND', message: 'no iron ore nearby' }
assert.equal(review(act('mineBlock', { blockType: 'iron_ore', count: 3 }), view({ recent: [failed, failed] })).code, 'TRIED_TWICE')
assert.equal(review(act('mineBlock', { blockType: 'iron_ore', count: 3 }), view({ recent: [failed] })), null)
assert.equal(review(act('mineBlock', { blockType: 'coal_ore', count: 3 }), view({ recent: [failed, failed] })), null, 'something else is fine')
const skipped = { ...failed, code: 'TRIED_TWICE', message: 'skipped' }
assert.equal(review(act('mineBlock', { blockType: 'iron_ore', count: 3 }), view({ recent: [failed, skipped, skipped] })), null, 'its own skips are not failures')

// Plenty of wood already
assert.equal(review(act('mineBlock', { blockType: 'oak_log', count: 8 }), view({ inv: { oak_log: 20, oak_planks: 40 } })).code, 'ENOUGH')
assert.equal(review(act('mineBlock', { blockType: 'log', count: 8 }), view({ inv: { birch_log: 30 } })).code, 'ENOUGH')
assert.equal(review(act('mineBlock', { blockType: 'oak_log', count: 8 }), view({ inv: { oak_log: 30 }, building: true })), null, 'a build needs it')
assert.equal(review(act('mineBlock', { blockType: 'oak_log', count: 4 }), view({ inv: { oak_log: 3 } })), null)

// Made three times in a row
const made = { action: 'craftItem', args: { itemName: 'stick', count: 4 }, ok: true }
assert.equal(review(act('craftItem', { itemName: 'stick', count: 4 }), view({ inv: { stick: 48 }, recent: [made, made, made] })).code, 'ENOUGH')

// Body
assert.equal(review(act('eatFood', { foodName: 'bread' }), view({ food: 20 })).code, 'NOT_HUNGRY')
assert.equal(review(act('eatFood', { foodName: 'golden_apple' }), view({ food: 20 })), null)
assert.equal(review(act('eatFood', {}), view({ food: 12 })), null)
assert.equal(review(act('sleepInBed'), view({ time: 6000 })).code, 'NOT_NIGHT')
assert.equal(review(act('sleepInBed'), view({ time: 18000 })), null)
assert.equal(review(act('sleepInBed'), view({ time: 6000, thundering: true })), null)
const eq = review(act('equipItem', { itemName: 'iron_sword' }), view({ equipped: { hand: 'iron_sword' } }))
assert.ok(eq.soft, 'already holding it: nothing to do, not a failure')

// A second furnace next to the first; throwing away diamonds
assert.equal(review(act('placeBlock', { blockType: 'furnace', x: 1, y: 2, z: 3 }), view({ nearBlocks: { furnace: { distance: 3 } } })).code, 'ALREADY_HERE')
assert.equal(review(act('dropItems', { itemNames: 'dirt, diamond' }), view()).code, 'VALUABLE')
assert.equal(review(act('dropItems', { itemNames: 'diamond' }, 'command'), view()), null, 'an owner told it to')
assert.equal(review(act('dropItems', { itemNames: 'rotten_flesh' }), view()), null)

// Hints
const h = carryHints({ crafting_table: 2 }, [tool('iron_pickaxe', 240, 250)])
assert.match(h[0], /never craft another/)
assert.match(h[1], /almost broken/)
console.log('All common-sense checks passed')
