'use strict'
// Run with: npm test   (or node test/pickup.test.js)
// Covers: taking or leaving items on the ground (pickup.js)
const path = require('path')
const assert = require('assert')
const { judgeDrop } = require(path.join(__dirname, '..', 'pickup.js'))

const base = { count: 1, distance: 5, freeSlots: 10, carried: 0 }
const j = (o) => judgeDrop({ ...base, ...o })
const cases = [
  [{ item: 'diamond' }, true, 'valuable'],
  [{ item: 'oak_log' }, true, 'useful'],
  [{ item: 'rotten_flesh' }, false, 'junk'],
  [{ item: 'wheat_seeds', wanted: 'your goal' }, true, 'need'],
  [{ item: 'iron_sword', from: { player: 'Steve', gift: true } }, true, 'threw it to you'],
  [{ item: 'iron_sword', from: { player: 'Steve', gift: false }, present: true }, false, "Steve dropped it; it's theirs"],
  [{ item: 'iron_sword', from: { player: 'Steve', gift: false }, present: false }, true, 'valuable'],
  [{ item: 'diamond_pickaxe', deathOf: 'Alex', present: true }, false, 'lost it when they died'],
  [{ item: 'diamond_pickaxe', ownDeath: true }, true, 'your own things'],
  [{ item: 'emerald', hostileNear: 'creeper' }, false, 'creeper'],
  [{ item: 'emerald', hazard: 'lava' }, false, 'lava'],
  [{ item: 'cobblestone', freeSlots: 0 }, false, 'inventory is full'],
  [{ item: 'cobblestone', freeSlots: 0, carried: 20 }, true, 'useful'], // stacks onto what it has
  [{ item: 'diamond', freeSlots: 0 }, true, 'valuable'],
  [{ item: 'cobblestone', carried: 200 }, false, 'plenty']
]
for (const [d, take, why] of cases) {
  const v = j(d)
  console.log(`${d.item.padEnd(16)} → ${v.take ? 'take' : 'leave'}: ${v.why}`)
  assert.equal(v.take, take, d.item)
  assert(v.why.includes(why), `${d.item}: "${v.why}" should mention "${why}"`)
}
console.log('\nAll pickup checks passed')
