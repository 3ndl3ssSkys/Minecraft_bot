'use strict'
// Run with: npm test   (or node test/pointing.test.js)
// Covers: clicking or circling things in the browser view → which blocks and creatures the person meant;
// the browser's icons for the inventory; smooth head turning.
const path = require('path')
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { rayDir, project, inside, resolvePointing, describePointing } = require(path.join(__dirname, '..', 'pointing.js'))
const { wrap } = require(path.join(__dirname, '..', 'look.js'))
const { iconResolver } = require(path.join(__dirname, '..', 'viewer.js'))

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

// --- camera math matches Mineflayer's yaw/pitch ---
for (const [yaw, pitch] of [[0, 0], [Math.PI / 2, 0], [1.1, -0.4], [-2.5, 0.7]]) {
  const d = rayDir({ yaw, pitch, fov: 70, aspect: 1.6 }, 0, 0)
  close(d.x, -Math.sin(yaw) * Math.cos(pitch))
  close(d.y, Math.sin(pitch))
  close(d.z, -Math.cos(yaw) * Math.cos(pitch))
}
// project() is the inverse of rayDir()
{
  const cam = { pos: { x: 3, y: 70, z: -2 }, yaw: 0.8, pitch: -0.3, fov: 70, aspect: 16 / 9 }
  for (const [x, y] of [[0, 0], [0.5, -0.3], [-0.9, 0.8]]) {
    const d = rayDir(cam, x, y)
    const p = project(cam, { x: cam.pos.x + d.x * 10, y: cam.pos.y + d.y * 10, z: cam.pos.z + d.z * 10 })
    close(p.x, x, 1e-9)
    close(p.y, y, 1e-9)
  }
  // behind the camera: not on screen
  const d = rayDir(cam, 0, 0)
  assert.equal(project(cam, { x: cam.pos.x - d.x * 5, y: cam.pos.y - d.y * 5, z: cam.pos.z - d.z * 5 }), null)
}
assert.ok(inside({ x: 0, y: 0 }, [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]))
assert.ok(!inside({ x: 2, y: 0 }, [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]))

// --- a small world: the bot looks north (-z) at a wall of logs with a cow in front ---
const mcData = require('minecraft-data')('1.21.4')
const World = require('prismarine-world')('1.21.4')
const Chunk = require('prismarine-chunk')('1.21.4')
const world = new World(null).sync
for (const cx of [-1, 0]) for (const cz of [-1, 0]) world.setColumn(cx, cz, new Chunk())
for (let x = -3; x <= 3; x++) for (let y = 64; y <= 68; y++) world.setBlockStateId(new Vec3(x, y, -10), mcData.blocksByName.oak_log.defaultState)
world.setBlockStateId(new Vec3(0, 66, -10), mcData.blocksByName.diamond_ore.defaultState)
const eye = new Vec3(0.5, 65.62, 0.5)
const bot = {
  world,
  entity: { position: new Vec3(0.5, 64, 0.5) },
  entities: {
    7: { id: 7, name: 'cow', type: 'animal', displayName: 'Cow', position: new Vec3(-1.5, 64, -5.5), width: 0.9, height: 1.4 },
    8: { id: 8, name: 'zombie', type: 'hostile', displayName: 'Zombie', position: new Vec3(0.5, 64, 6), width: 0.6, height: 1.95 } // behind
  }
}
const cam = { pos: eye, yaw: 0, pitch: 0, fov: 70, aspect: 16 / 9 }
const aim = (p) => project(cam, p)
{
  // click straight at the diamond ore
  const s = aim(new Vec3(0.5, 66.5, -10))
  const r = resolvePointing(bot, cam, { point: s })
  assert.equal(r.kind, 'point')
  assert.equal(r.blocks[0].name, 'diamond_ore')
  assert.deepEqual(r.blocks[0].pos.toArray(), [0, 66, -10])
  assert.equal(r.entities.length, 0)
}
{
  // click on the cow: the cow, not the wall behind it
  const s = aim(new Vec3(-1.5, 64.7, -5.5))
  const r = resolvePointing(bot, cam, { point: s })
  assert.equal(r.entities[0]?.name, 'cow')
  const words = describePointing(r, bot.entity.position, { coords: false })
  assert.match(words, /Cow \(cow\)|a cow/)
  assert.match(words, /west/)
  assert.match(words, /north/)
}
{
  // circle the left half of the wall, cow included; the zombie behind the bot is not on screen
  const a = aim(new Vec3(-4, 69, -10))
  const b = aim(new Vec3(0.2, 63.5, -10))
  const outline = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }]
  const r = resolvePointing(bot, cam, { outline })
  assert.equal(r.kind, 'circle')
  assert.equal(r.blocks[0].name, 'oak_log')
  assert.ok(r.blocks[0].count >= 4, `several logs (${r.blocks[0].count})`)
  assert.deepEqual(r.entities.map((e) => e.name), ['cow'])
  const words = describePointing(r, bot.entity.position, { coords: true })
  assert.match(words, /oak_log blocks, the nearest \d+ blocks away at -?\d+ \d+ -10/)
  console.log('circle →', words)
}

// --- inventory icons from the shipped textures ---
{
  const dir = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public', 'textures', '1.21.4')
  const icons = iconResolver(dir)
  assert.deepEqual(icons.iconFor('diamond_sword'), { flat: 'items/diamond_sword.png' })
  assert.deepEqual(icons.iconFor('clock'), { flat: 'items/clock_00.png' })
  const log = icons.iconFor('oak_log')
  assert.equal(log.cube.up, 'blocks/oak_log_top.png')
  assert.equal(log.cube.left, 'blocks/oak_log.png')
  const table = icons.iconFor('crafting_table')
  assert.equal(table.cube.up, 'blocks/crafting_table_top.png')
  assert.equal(table.cube.left, 'blocks/crafting_table_front.png')
  assert.equal(table.cube.right, 'blocks/crafting_table_side.png')
  const grass = icons.iconFor('grass_block')
  assert.equal(grass.cube.up, 'blocks/grass_block_top.png')
  assert.ok(grass.tint, 'grass top is tinted green')
  assert.equal(icons.iconFor('oak_slab').half, true)
  assert.ok(icons.iconFor('oak_leaves').tintSides)
  assert.ok(icons.iconFor('torch')?.flat, 'torch has a flat icon')
  assert.equal(icons.iconFor('no_such_item_from_the_future'), null)
  console.log('icons ok:', JSON.stringify(icons.iconFor('furnace')))
}

// --- mouse and keyboard ---
;(async () => {
  const { planFlick, flickTime, pickKeys, installHumanInput } = require(path.join(__dirname, '..', 'look.js'))
  // Fitts: farther takes longer; better players are faster
  assert.ok(flickTime(90, 0.2) > flickTime(20, 0.2))
  assert.ok(flickTime(90, 1) < flickTime(90, 0))
  // a 120° flick: several ticks, bell-shaped (slow-fast-slow), ends exactly on target
  for (let n = 0; n < 20; n++) {
    const pts = planFlick(0, 0, 2.1, -0.3, 0.5)
    assert.ok(pts.length >= 5, `${pts.length} ticks`)
    close(pts.at(-1)[0], 2.1, 1e-9)
    close(pts.at(-1)[1], -0.3, 1e-9)
    const steps = pts.map((p, i) => Math.abs(p[0] - (i ? pts[i - 1][0] : 0)))
    assert.ok(Math.max(...steps) > steps[0] * 1.5, 'speeds up after the start')
  }
  // keys: target 45° to the left of the camera → W+A; behind → S; right → D
  assert.deepEqual(pickKeys(0, Math.PI / 4).keys, { forward: true, left: true })
  assert.deepEqual(pickKeys(0, -Math.PI / 2).keys, { right: true })
  assert.deepEqual(pickKeys(1, 1 + Math.PI).keys, { back: true })

  const b = new EventEmitter()
  b.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 } }
  const sent = []
  b.look = async (yaw, pitch) => { b.entity.yaw = yaw; b.entity.pitch = pitch; sent.push(yaw) }
  let precise = false
  installHumanInput(b, { skill: () => 0.5, precise: () => precise })
  const done = b.look(Math.PI, 0) // 180°: a flick over several ticks
  assert.equal(sent.length, 0, 'nothing sent before the next tick')
  for (let i = 0; i < 40; i++) b.emit('physicsTick')
  await done
  close(Math.abs(wrap(b.entity.yaw)), Math.PI, 1e-9)
  assert.ok(sent.length >= 6, `turned over ${sent.length} ticks`)
  // a reflex: instant
  precise = true
  sent.length = 0
  await b.look(0, 0.3, true)
  assert.equal(sent.length, 1)
  precise = false
  // a new look replaces one under way
  const first = b.look(-1, 0)
  b.emit('physicsTick')
  const second = b.look(1.5, 0.2)
  await first
  for (let i = 0; i < 40; i++) b.emit('physicsTick')
  await second
  close(b.entity.yaw, 1.5, 1e-9)
  close(b.entity.pitch, 0.2, 1e-9)
  console.log('pointing, icons, mouse and keyboard ok')
})().catch((err) => { console.error(err); process.exit(1) })
