'use strict'
// Run with: npm test   (or node test/places.test.js)
// Covers: the mental map — picking up the stations it placed when it leaves, home, deaths
const path = require('path')
const assert = require('assert')
const { Places } = require(path.join(__dirname, '..', 'places.js'))

const D = 'overworld'
const at = (x, y, z) => ({ x, y, z })
{
  const pl = new Places({}, () => 1) // always remembers
  pl.onPlaced(at(10, 64, 10), 'crafting_table', 'placed', D)
  pl.onPlaced(at(12, 64, 10), 'furnace', 'placed', D)
  pl.onPlaced(at(30, 64, 30), 'oak_planks', 'build', D) // a build stays
  pl.onPlaced(at(11, 64, 11), 'chest', 'placed', D) // holds things: not picked up automatically
  const here = at(11, 64, 12)
  const there = (p) => ({ crafting_table: 'crafting_table', furnace: 'furnace', chest: 'chest' })[pl.placed.find((x) => x.x === p.x && x.z === p.z)?.name]
  let list = pl.reclaimable(here, D, { blockName: there })
  assert.deepEqual(list.map((p) => p.name), ['crafting_table', 'furnace'])
  // a furnace still cooking stays
  list = pl.reclaimable(here, D, { blockName: there, cooking: (p) => p.name === 'furnace' })
  assert.deepEqual(list.map((p) => p.name), ['crafting_table'])
  // gone (someone broke it): forgotten
  list = pl.reclaimable(here, D, { blockName: (p) => p.name === 'furnace' ? 'air' : there(p) })
  assert.deepEqual(list.map((p) => p.name), ['crafting_table'])
  assert.ok(!pl.placed.some((p) => p.name === 'furnace'))
  // far away already: it left them behind long ago
  assert.equal(pl.reclaimable(at(200, 64, 200), D, { blockName: there }).length, 0)
  // another dimension
  assert.equal(pl.reclaimable(here, 'the_nether', { blockName: there }).length, 0)
  // at home they stay
  pl.onSlept(at(14, 64, 14), D)
  assert.equal(pl.reclaimable(here, D, { blockName: there }).length, 0)
}
{
  // beginners forget theirs
  const pl = new Places({}, () => 0)
  pl.onPlaced(at(0, 64, 0), 'crafting_table', 'placed', D)
  assert.equal(pl.reclaimable(at(1, 64, 1), D, { blockName: () => 'crafting_table' }).length, 0)
}
{
  // leaving: explore, a far walk, following someone far away; not a short walk
  const pl = new Places()
  const here = at(0, 64, 0)
  assert.ok(pl.leaving({ name: 'explore', args: {} }, here))
  assert.ok(pl.leaving({ name: 'moveToBlock', args: { x: 100, y: 64, z: 0 } }, here))
  assert.ok(!pl.leaving({ name: 'moveToBlock', args: { x: 5, y: 64, z: 3 } }, here))
  assert.ok(pl.leaving({ name: 'followPlayer', args: { playerName: 'Steve' } }, here, { players: { Steve: { entity: { position: at(80, 64, 0) } } } }))
  assert.ok(!pl.leaving({ name: 'mineBlock', args: { blockType: 'stone' } }, here))
}
{
  // deaths: a run back for the things, unless they burned
  const pl = new Places()
  pl.onDeath(at(5, 40, 5), D, 'TheBestWanderer was slain by Zombie')
  assert.ok(pl.freshDeath(D))
  assert.equal(pl.freshDeath(D, Date.now() + 5 * 60000), null, 'items despawned')
  pl.onDeath(at(5, 12, 5), D, 'TheBestWanderer tried to swim in lava')
  assert.equal(pl.freshDeath(D), null)
  // the prompt line
  const pl2 = new Places({}, () => 1)
  pl2.onPlaced(at(3, 64, 0), 'crafting_table', 'placed', D)
  const lines = pl2.forPrompt(at(0, 64, 0), D, (p) => `${p.x - 0} east`)
  assert.match(lines.join(' | '), /your crafting table: 3 east/)
}
console.log('All places checks passed')
