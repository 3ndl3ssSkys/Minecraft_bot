'use strict'
// Run with: npm test   (or node test/senses-chests.test.js)
// Covers: sound classification, plugin chat formats, intelligence gates, chest classification
const path = require('path')
const R = path.join(__dirname, '..') + path.sep
const assert = require('assert')
const { Vec3 } = require('vec3')
const { classifySound } = require(R + 'senses.js')
const { ContainerIntel } = require(R + 'containers.js')
const { Intelligence } = require(R + 'intelligence.js')
const { parsePluginChat } = require(R + 'index.js')

console.log('== sounds ==')
for (const n of ['minecraft:block.chest.open', 'block.stone.step', 'entity.zombie.ambient', 'entity.creeper.primed', 'block.deepslate.break', 'ambient.cave', 'entity.player.attack.crit', 'block.oak_door.open', 'weather.rain'])
  console.log(n.padEnd(30), JSON.stringify(classifySound(n)))
assert.equal(classifySound('entity.creeper.primed').kind, 'danger')
assert.equal(classifySound('ambient.cave').kind, 'ambient')

console.log('\n== plugin chat formats ==')
for (const t of ['[Member] Steve: anyone got iron?', 'Steve » hi Wanderer', '<Steve> hello', '[Admin] [VIP] <Alex> sup', 'Alex -> me: psst', 'Steve whispers to you: meet at spawn', 'From Alex: come here', 'Server restarting in 5 minutes', '[Server] Welcome!'])
  console.log(t.padEnd(40), JSON.stringify(parsePluginChat(t)))
assert.deepEqual(parsePluginChat('[Member] Steve: anyone got iron?'), { user: 'Steve', msg: 'anyone got iron?', whisper: false })
assert.equal(parsePluginChat('Alex -> me: psst').whisper, true)

console.log('\n== intelligence gates ==')
for (const level of ['beginning', 'mediocre', 'advanced', 'hardcore', 'master', 'impossible']) {
  const i = new Intelligence(() => ({ level, learn: false }), {})
  const p = i.combatProfile()
  const abil = ['crit', 'strafe', 'wtap', 'axeVsShield', 'combo', 'throwPotions', 'pearlEscape', 'cobweb', 'maceBasic', 'maceGood', 'seeThroughWalls'].filter((a) => p.can(a))
  console.log(level.padEnd(11), `reaction ${p.reactionMs}ms aim±${p.aimErrorDeg.toFixed(1)}° miss ${(p.missChance * 100).toFixed(0)}% | ${abil.join(' ')}`)
}
assert(!new Intelligence(() => ({ level: 'advanced', learn: true, maxLearnedLevels: 3 }), { xp: { combat: 9999 } }).can('maceBasic'))

console.log('\n== chest classification ==')
// Fake world: a map of blocks, signs, players.
function fakeBot (blocks, signs = {}) {
  const at = (p) => blocks[`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`]
  return {
    username: 'Wanderer', players: { Steve: {}, Alex: {}, Wanderer: {} }, entities: {},
    registry: { blocksArray: [{ name: 'oak_sign', id: 1 }], itemsByName: new Proxy({}, { get: () => ({ stackSize: 64 }) }) },
    blockAt: (p) => { const name = at(p); if (!name) return { name: 'air' }; const b = { name, position: p }; const t = signs[`${p.x},${p.y},${p.z}`]; if (t) b.getSignText = () => [t, '']; return b },
    findBlocks: ({ point }) => Object.keys(signs).map((k) => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) }).filter((p) => p.distanceTo(point) <= 6)
  }
}
const agent = { config: { behavior: { owners: ['Boss'], respectPrivateChests: true } }, memory: { addEvent: (t, x) => console.log('   event:', x) }, social: { players: {}, adjustTrust: (n, d, r) => console.log(`   trust ${n} ${d}: ${r}`) }, emotions: { stimulate () {} }, learning: { markDirty () {} } }
const chestAt = new Vec3(0, 64, 0)
const chest = { name: 'chest', position: chestAt }
const cases = [
  ['community sign', fakeBot({ '0,65,1': 'oak_sign' }, { '0,65,1': 'Community chest - take what you need' }), { bread: 12, cobblestone: 30 }],
  ["Steve's sign", fakeBot({ '1,65,0': 'oak_sign', '2,64,0': 'oak_planks', '2,65,0': 'oak_planks', '3,64,0': 'glass', '2,66,0': 'oak_planks', '-2,64,0': 'oak_planks', '-2,65,0': 'crafting_table', '0,64,2': 'furnace' }, { '1,65,0': "Steve's stuff - keep out" }), { diamond: 5, iron_ingot: 64 }],
  ['dungeon, full of loot', fakeBot({ '2,64,2': 'spawner', '1,63,1': 'mossy_cobblestone' }), { saddle: 1, bone: 7, string: 3, music_disc_13: 1, golden_apple: 1 }],
  ['dungeon, emptied', fakeBot({ '2,64,2': 'spawner' }), {}],
  ['in the open, unknown', fakeBot({}), { dirt: 3 }]
]
for (const [label, bot, contents] of cases) {
  const intel = new ContainerIntel(agent, {})
  const r = intel.inspect(bot, chest, contents)
  console.log(label.padEnd(24), '→', r.kind.padEnd(10), '|', r.label, '|', r.reasons.join('; '))
  if (label.startsWith('Steve')) { const m = intel.mayTake(chestAt); console.log('   may take?', m.ok, m.reason || ''); assert(!m.ok) }
}
// Our own chest gets raided.
agent.bot = fakeBot({}); const intel = new ContainerIntel(agent, {})
intel.onPlaced(chestAt, 'chest')
const bot = fakeBot({})
intel.inspect(bot, chest, { diamond: 10, bread: 5 })
intel.onOpenedBy(chestAt, 'Alex')
const r = intel.inspect(bot, chest, { diamond: 2, bread: 5 })
console.log('own chest raided →', r.kind, '|', r.changes)
assert.equal(r.kind, 'mine')
console.log('\nALL SENSE/CHEST CHECKS PASSED')
