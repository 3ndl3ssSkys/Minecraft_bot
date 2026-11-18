'use strict'
// Run with: npm test   (or node test/redstone.test.js)
// Covers: the redstone simulator (gates, clock, timing), finding cheaper circuits that do the same job, reading a
// circuit back out of a world, and recognising farms and contraptions.
const path = require('path')
const assert = require('assert')
const { Vec3 } = require('vec3')
const r = require(path.join(__dirname, '..', 'redstone.js'))
const mechanics = require(path.join(__dirname, '..', 'mechanics.js'))

// --- every known design does what its name says ---
const expect = { not: 'NOT gate (inverter)', or: 'OR gate', nor: 'NOR gate', and: 'AND gate', nand: 'NAND gate' }
for (const [k, name] of Object.entries(expect)) assert.equal(r.analyze(r.DESIGNS[k].parts).name, name, k)
const clock = r.analyze(r.DESIGNS.clock.parts)
assert.equal(clock.kind, 'clock')
assert.equal(clock.period, 6, 'period = 2 x (torch 1 + repeater 2)')
// a slower repeater makes a slower clock
const slow = r.analyze(r.DESIGNS.clock.parts.map((p) => p.block === 'repeater' ? { ...p, delay: 4 } : p))
assert.equal(slow.period, 10)
// timing: an AND gate goes through two torches
assert.equal(r.analyze(r.DESIGNS.and.parts).delay, 2)
// turning a design keeps what it does
for (const f of ['north', 'south', 'west']) assert.equal(r.analyze(r.place(r.DESIGNS.and.parts, { x: 10, y: 64, z: -3 }, f)).name, 'AND gate', f)

// --- a clumsy OR gate gets cheaper and stays an OR gate ---
const clumsy = [...r.DESIGNS.or.parts.filter((p) => !(p.x === 2 && p.z === 1)),
  { x: 2, y: 0, z: 1, block: 'repeater', facing: 'west', delay: 3 },
  { x: 1, y: 0, z: -1, block: 'redstone_wire' }, { x: 2, y: 0, z: -1, block: 'redstone_wire' },
  { x: 2, y: 0, z: 3, block: 'stone' }]
assert.equal(r.analyze(clumsy).name, 'OR gate')
const o = r.optimize(clumsy, { budgetMs: 3000 })
assert.equal(o.after.name, 'OR gate')
assert.ok(o.after.cost < o.before.cost / 2, `${o.before.cost} → ${o.after.cost}`)
assert.ok(o.after.delay < o.before.delay, 'and faster')
assert.match(r.describe(clumsy).text, /could be cheaper/)
// a wrongly built circuit is seen for what it really does
const backwards = clumsy.map((p) => p.block === 'repeater' ? { ...p, facing: 'east' } : p)
assert.notEqual(r.analyze(backwards).name, 'OR gate')

// --- reading a circuit out of a world ---
const mc = require('minecraft-data')('1.21.4')
const Block = require('prismarine-block')('1.21.4')
const World = require('prismarine-world')('1.21.4')
const Chunk = require('prismarine-chunk')('1.21.4')
const world = new World(null).sync
for (const cx of [-1, 0, 1]) for (const cz of [-1, 0, 1]) world.setColumn(cx, cz, new Chunk())
const put = (x, y, z, name, props = {}) => world.setBlockStateId(new Vec3(x, y, z), Block.fromProperties(name, props, 0).stateId)
for (let x = -3; x <= 8; x++) for (let z = -3; z <= 6; z++) put(x, 63, z, 'stone') // floor
const nor = r.place(r.DESIGNS.nor.parts, { x: 0, y: 64, z: 0 }, 'east')
for (const p of nor) {
  const props = {}
  if (p.facing) props.facing = p.facing
  if (p.face) props.face = p.face
  if (p.block === 'repeater') props.delay = p.delay
  put(p.x, p.y, p.z, p.block, props)
}
const read = r.readFromWorld((p) => world.getBlock(new Vec3(p.x, p.y, p.z)), new Vec3(1, 64, 1), 8)
assert.equal(r.analyze(read).name, 'NOR gate', 'built in a world, read back, still a NOR gate')
assert.ok(read.length <= nor.length + 8, `only the circuit and the blocks under it (${read.length} parts)`)

// --- farms and contraptions ---
for (let x = -3; x <= 8; x++) for (let z = -3; z <= 6; z++) for (let y = 64; y <= 66; y++) put(x, y, z, 'air')
put(0, 64, 0, 'lava'); put(2, 64, 0, 'water'); put(1, 64, 0, 'cobblestone') // a cobble generator
put(4, 64, 4, 'sugar_cane'); put(3, 65, 4, 'piston', { facing: 'east' }); put(3, 66, 4, 'observer', { facing: 'east' }) // a cane farm
const bot = {
  registry: mc,
  entities: {},
  blockAt: (p) => world.getBlock(p),
  findBlocks: ({ matching, maxDistance, count, point }) => {
    const ids = new Set(matching); const out = []
    for (let x = -maxDistance; x <= maxDistance; x++) for (let y = -4; y <= 4; y++) for (let z = -maxDistance; z <= maxDistance; z++) {
      const p = point.offset(x, y, z); const b = world.getBlock(p)
      if (b && ids.has(b.type) && out.length < count) out.push(p)
    }
    return out
  }
}
const seen = mechanics.scan(bot, new Vec3(2, 64, 2), 6, 8)
const ids = seen.map((m) => m.id)
assert.ok(ids.includes('cobble_generator'), JSON.stringify(ids))
assert.ok(ids.includes('observer_crop_farm'), JSON.stringify(ids))
assert.match(seen.find((m) => m.id === 'observer_crop_farm').text, /sugar cane .*observer.*Better:/s)
// a beginner sees much less
assert.ok(mechanics.scan(bot, new Vec3(2, 64, 2), 1, 8).length < seen.length)
console.log('cane farm, as a master sees it:', seen.find((m) => m.id === 'observer_crop_farm').text.slice(0, 160), '...')
console.log('All redstone checks passed')
