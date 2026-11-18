'use strict'
// Run with: npm test   (or node test/sight.test.js)
// Covers: what it can see (blocks in sight range, partly hidden creatures, ores sealed in rock) versus what it can
// click (never through leaves or a wall), and that placing picks a face it can see.
const path = require('path')
const assert = require('assert')
const { Vec3 } = require('vec3')
const { clickableFace, obstacle } = require(path.join(__dirname, '..', 'reach.js'))
const { Senses } = require(path.join(__dirname, '..', 'senses.js'))

const mcData = require('minecraft-data')('1.21.4')
const World = require('prismarine-world')('1.21.4')
const Chunk = require('prismarine-chunk')('1.21.4')
const world = new World(null).sync
for (const cx of [-1, 0]) for (const cz of [-1, 0]) world.setColumn(cx, cz, new Chunk())
const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), mcData.blocksByName[name].defaultState)
for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) set(x, 63, z, 'grass_block') // flat ground at y 63

const bot = { world, entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.8 }, entities: {} }
const senses = new Senses({ config: { senses: { realisticSight: true } }, intelligence: { can: () => false, attention: () => 0.5 } })

// 1. A crafting table 8 blocks away in the open: seen (the old centre ray hit the table itself and called it hidden).
set(0, 64, -8, 'crafting_table')
assert.ok(senses.canSeeBlock(bot, new Vec3(0, 64, -8)), 'a table 8 blocks away in plain view is seen')
assert.equal(clickableFace(bot, world.getBlock(new Vec3(0, 64, -8))), null, 'but it is out of reach')

// 2. Leaves between the bot and a table 3 blocks away: seen through the leaves, but not clickable.
set(0, 64, -3, 'crafting_table')
for (const y of [64, 65, 66]) for (const x of [-1, 0, 1]) set(x, y, -2, 'oak_leaves')
const table = world.getBlock(new Vec3(0, 64, -3))
assert.ok(senses.canSeeBlock(bot, table.position), 'leaves do not hide it')
assert.equal(clickableFace(bot, table), null, 'the crosshair hits the leaves first: no clicking through them')
assert.match(obstacle(bot, table).name, /leaves/, 'and it knows what is in the way')

// 3. Placing: the ground behind the leaves can't be clicked; the ground in front can.
assert.equal(clickableFace(bot, world.getBlock(new Vec3(0, 63, -3)), { normal: new Vec3(0, 1, 0) }), null, 'no placing on the far side of the leaves')
assert.ok(clickableFace(bot, world.getBlock(new Vec3(1, 63, 0)), { normal: new Vec3(0, 1, 0) }), 'the ground right next to it is fine')

// 4. A stone wall: hides the block behind it from sight too.
set(5, 64, 0, 'iron_ore')
for (const y of [64, 65, 66, 67]) for (const z of [-1, 0, 1]) set(4, y, z, 'stone')
assert.ok(!senses.canSeeBlock(bot, new Vec3(5, 64, 0)), 'behind a wall: not seen')

// 5. A block partly hidden (only its top corner shows over a low wall) still counts.
set(-6, 64, 0, 'chest')
set(-5, 64, 0, 'cobblestone')
assert.ok(senses.canSeeBlock(bot, new Vec3(-6, 64, 0)), 'the top of a chest over a 1-high wall is seen')

// 6. Creatures: legs showing under a leaf canopy count; fully behind the wall doesn't.
const zombie = { position: new Vec3(0.5, 64, -6.5), width: 0.6, height: 1.95 }
for (const x of [-1, 0, 1]) for (const z of [-5, -6, -7]) set(x, 65, z, 'stone') // a roof at head height in front of it
assert.ok(senses.visibleShare(bot, zombie) > 0, 'part of the zombie is visible')
const hidden = { position: new Vec3(6.5, 64, 0.5), width: 0.6, height: 1.95 }
assert.equal(senses.visibleShare(bot, hidden), 0, 'nothing of it shows behind the wall')

// 7. Clicking picks a face it can actually reach, and the hit point is on that block.
set(2, 64, 0, 'furnace')
const f = clickableFace(bot, world.getBlock(new Vec3(2, 64, 0)))
assert.ok(f && f.normal.equals(new Vec3(-1, 0, 0)), `the side facing the bot (${f && f.normal})`)
assert.ok(f.point.x >= 1.99 && f.point.x <= 2.01, 'the click lands on that face')

// 8. Lower blocks: a bed seen from above can be clicked on its top (the ray reaches its real, lower surface).
set(-1, 64, 1, 'red_bed')
const bed = clickableFace(bot, world.getBlock(new Vec3(-1, 64, 1)))
assert.ok(bed, 'the bed right next to it can be clicked')
assert.ok(bed.point.y < 64.6, `on its real shape (${bed.point.y})`)

console.log('All sight checks passed')
