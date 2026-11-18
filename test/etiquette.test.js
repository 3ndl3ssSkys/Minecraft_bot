'use strict'
// Run with: npm test   (or node test/etiquette.test.js)
// Covers: rules people set (who it listens to, by personality), checking actions against them, and leaving farms,
// pens, pets, villagers and towns alone without being told.
const path = require('path')
const assert = require('assert')
const { Vec3 } = require('vec3')
const { Etiquette, matchTarget } = require(path.join(__dirname, '..', 'etiquette.js'))

const mc = require('minecraft-data')('1.21.4')
const World = require('prismarine-world')('1.21.4')
const Chunk = require('prismarine-chunk')('1.21.4')
const world = new World(null).sync
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) world.setColumn(cx, cz, new Chunk())
const set = (x, y, z, name) => world.setBlockStateId(new Vec3(x, y, z), mc.blocksByName[name].defaultState)
for (let x = -30; x <= 30; x++) for (let z = -30; z <= 30; z++) set(x, 63, z, 'grass_block') // flat ground at y 63

// An iron farm: a zombie in a 1x1 glass box with villagers next to it.
for (let y = 64; y <= 66; y++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) set(10 + dx, y, 10 + dz, 'glass')
set(10, 66, 10, 'glass')
// A cow pen: fences around a 3x3 field.
for (let x = -12; x <= -8; x++) for (let z = -12; z <= -8; z++) if (x === -12 || x === -8 || z === -12 || z === -8) set(x, 64, z, 'oak_fence')
// A town: a block of planks houses.
for (let x = 18; x <= 26; x++) for (let z = -26; z <= -18; z++) for (let y = 64; y <= 65; y++) if (x === 18 || x === 26 || z === -26 || z === -18) set(x, y, z, 'oak_planks')

const ent = (id, name, x, z, extra = {}) => ({ id, name, kind: /zombie|skeleton/.test(name) ? 'Hostile mobs' : 'Passive mobs', type: 'mob', position: new Vec3(x + 0.5, 64, z + 0.5), height: name === 'cow' ? 1.4 : 1.95, width: 0.6, ...extra })
const entities = {
  1: ent(1, 'zombie', 10, 10),
  2: ent(2, 'villager', 13, 10),
  3: ent(3, 'cow', -10, -10),
  4: ent(4, 'zombie', 0, 5), // a free zombie in the open
  5: ent(5, 'cow', 5, -5) // a wild cow
}
const bot = {
  world,
  entities,
  entity: { position: new Vec3(0.5, 64, 0.5) },
  game: { dimension: 'overworld' },
  registry: mc,
  blockAt: (p) => world.getBlock(p),
  findBlocks: ({ matching, maxDistance, count, point }) => {
    const ids = new Set(matching); const out = []
    for (let x = -maxDistance; x <= maxDistance; x++) for (let y = -3; y <= 3; y++) for (let z = -maxDistance; z <= maxDistance; z++) {
      const p = point.floored().offset(x, y, z); const b = world.getBlock(p)
      if (b && ids.has(b.type) && out.length < count) out.push(p)
    }
    return out
  }
}
const profiles = { Steve: { trust: 50, affinity: 55 }, Rando: { trust: 40, affinity: 30 }, Griefer: { trust: 5, affinity: 10 }, Mod: { trust: 60, affinity: 50 } }
const agent = (personality = {}, etiquette = {}) => ({
  bot,
  config: { etiquette: { enabled: true, serverType: 'auto', lawfulness: null, ...etiquette }, server: { host: 'friends.example.net' }, trust: { trustedAbove: 70 } },
  personality: { lawfulness: 0.75, ...personality },
  social: {
    role: (n) => n === 'EndlessSkys' ? 'owner' : n === 'Mod' ? 'admin' : 'player',
    profile: (n) => profiles[n] || { trust: 50, affinity: 50 },
    isHostile: (n) => n === 'Griefer'
  },
  senses: { readTag: () => null },
  containers: { signsNear: () => [] },
  places: { isHome: () => false },
  memory: { addEvent () {} },
  learning: { markDirty () {} }
})

// --- who it listens to ---
{
  const e = new Etiquette(agent())
  const rule = { kind: 'forbid', acts: ['kill'], target: 'cows', what: "don't kill my cows", here: false }
  assert.ok(e.consider('Steve', rule).accept, 'a fair request about their own animals')
  assert.ok(!e.consider('Griefer', rule).accept, 'not from someone hostile')
  assert.ok(e.consider('Mod', { kind: 'require', acts: ['other'], target: '', what: 'always close doors' }).accept, 'staff rules')
  assert.ok(!e.consider('Rando', { kind: 'require', acts: ['other'], target: '', what: 'always build in sandstone' }).accept, "someone it barely likes doesn't get to tell it how to play")
  assert.ok(e.consider('Steve', { kind: 'require', acts: ['other'], target: '', what: 'always close the door' }).accept, 'a friend asking something reasonable')
  const anarchist = new Etiquette(agent({ lawfulness: 0.05 }))
  assert.ok(!anarchist.consider('Steve', rule).accept)
  assert.ok(!anarchist.consider('Mod', rule).accept, 'an anarchist ignores staff too')
  assert.ok(anarchist.consider('EndlessSkys', rule).accept, 'but its owner is its owner')
  const onAnarchy = new Etiquette(agent({}, { serverType: 'anarchy' }))
  assert.ok(!onAnarchy.consider('Steve', rule).accept, 'anarchy server: no rules')
}

// --- rules against actions ---
{
  const e = new Etiquette(agent())
  e.consider('Steve', { kind: 'forbid', acts: ['kill'], target: 'cows', what: "don't kill my cows", here: false })
  e.consider('Steve', { kind: 'forbid', acts: ['break'], target: '', what: 'stop mining here', here: true }, new Vec3(0, 64, 0))
  const ctx = { entity: (id) => entities[id], pos: bot.entity.position, dim: 'overworld' }
  assert.equal(e.check({ source: 'llm', action: { name: 'attackTarget', args: { entityId: 5 } } }, ctx).code, 'RULE', 'the wild cow is off-limits now')
  assert.equal(e.check({ source: 'llm', action: { name: 'mineBlock', args: { blockType: 'stone' } } }, ctx).code, 'RULE')
  assert.equal(e.check({ source: 'llm', action: { name: 'mineBlock', args: { blockType: 'stone' } } }, { ...ctx, pos: new Vec3(200, 64, 200) }), null, 'only around there')
  assert.equal(e.check({ source: 'command', action: { name: 'mineBlock', args: { blockType: 'stone' } } }, ctx), null, 'its owner told it to')
  assert.ok(matchTarget('the trees', 'oak_log'))
  assert.ok(matchTarget('my cows', 'cow'))
  assert.ok(!matchTarget('cows', 'pig'))
  assert.ok(matchTarget('', 'anything'))
}

// --- understanding without being told ---
{
  const e = new Etiquette(agent())
  assert.match(e.protectedMob(entities[1]), /iron farm/, 'the zombie in the glass box next to villagers')
  assert.match(e.protectedMob(entities[2]), /part of the place/, 'villagers')
  assert.match(e.protectedMob(entities[3]), /pen/, 'the penned cow')
  assert.equal(e.protectedMob(entities[4]), null, 'a free zombie is fair game')
  assert.equal(e.protectedMob(entities[5]), null, 'a wild cow is fair game')
  const ctx = { entity: (id) => entities[id], pos: bot.entity.position, dim: 'overworld' }
  assert.equal(e.check({ source: 'llm', action: { name: 'attackTarget', args: { entityId: 1 } } }, ctx).code, 'NOT_YOURS')
  assert.equal(e.check({ source: 'llm', action: { name: 'attackTarget', args: { entityId: 4 } } }, ctx), null)
  // the town: no digging there; out in the field is fine
  assert.match(e.builtUp(new Vec3(22, 64, -22)) || '', /town or base/)
  assert.equal(e.check({ source: 'llm', action: { name: 'mineBlock', args: { blockType: 'oak_planks', x: 22, y: 64, z: -22 } } }, ctx).code, 'NOT_YOURS')
  assert.equal(e.builtUp(new Vec3(0, 64, 0)), null)
  // an anarchist doesn't care
  const a = new Etiquette(agent({ lawfulness: 0.05 }))
  assert.equal(a.protectedMob(entities[1]), null)
  assert.equal(a.builtUp(new Vec3(22, 64, -22)), null)
}

// --- signs ---
{
  const ag = agent()
  ag.containers.signsNear = () => [{ pos: new Vec3(5, 64, 5), text: 'No griefing! Welcome to spawn' }]
  const e = new Etiquette(ag)
  e.readSigns(new Vec3(0, 64, 0))
  assert.equal(e.rules.length, 1)
  assert.match(e.rules[0].what, /no griefing/)
  e.readSigns(new Vec3(0, 64, 0))
  assert.equal(e.rules.length, 1, 'read once')
  assert.match(e.forPrompt(new Vec3(0, 64, 0), 'overworld').join(' '), /Never: no griefing/)
}
console.log('All etiquette checks passed')
