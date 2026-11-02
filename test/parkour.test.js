'use strict'
// Parkour: tiers, jump finder, learning, and the executor on the REAL physics engine (no server needed).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { makeWorld, makeBot } = require('./tools/simbot')
const { ParkourSkill, TIERS, tierChance, findJumps, runJump } = require('../parkour')
const { Intelligence, skillAt } = require('../intelligence')

const mk = (level) => {
  const cfg = { level, learn: true, learnRate: 1 }
  const intel = new Intelligence(() => cfg)
  const agent = { intelligence: intel, config: { behavior: { pathfinding: { allow1by1towers: true } } }, log: { debug () {} }, bot: { food: 20 } }
  return { intel, skill: new ParkourSkill(agent, {}), agent }
}
const J = (d, up = 0, drop = 0, extra = {}) => ({ d, up, drop, runUp: 5, ...extra })
const world = (k, dy = 0) => {
  const w = makeWorld()
  w.fill(-8, 59, -3, 0, 59, 3, 'stone')
  w.fill(k, 59 + dy, -3, k + 4, 59 + dy, 3, 'stone')
  return w
}

console.log('== Tier table: what each level will attempt ==')
const at = (level, j) => mk(level).skill.chance(j)
assert.ok(at('beginning', J(2)) > 0.5, 'beginner does basic 1-gap jumps')
assert.equal(at('beginning', J(3)), 0, 'beginner does not attempt 2-gap jumps')
assert.equal(at('beginning', J(2, 1)), 0, 'beginner cannot jump forward onto a higher block')
assert.ok(at('simple', J(2, 1)) > 0.6, 'simple: 2 blocks forward onto a block one higher')
assert.equal(at('simple', J(3, 1)), 0)
assert.equal(at('simple', J(3)), 0)
assert.ok(at('mediocre', J(3)) > 0.7, 'mediocre does 2-3 block jumps')
assert.equal(at('mediocre', J(4)), 0)
assert.ok(at('mediocre', J(2, 1)) > 0.8, 'mediocre: 2-block jump onto a higher block')
assert.ok(at('mediocre', J(3, 1)) > 0 && at('mediocre', J(3, 1)) < 0.5, 'mediocre: sometimes 3 onto a higher block')
assert.equal(at('mediocre', J(2, 2)), 0, 'a jump cannot gain 2 blocks of height')
assert.ok(at('complicated', J(4)) > 0.8, 'complicated does 4 block jumps')
assert.equal(at('complicated', J(5)), 0)
assert.ok(at('complicated', J(3, 1)) > 0.8, 'complicated: up to 3 onto a higher block')
assert.equal(at('complicated', J(4, 1)), 0)
assert.ok(at('advanced', J(4, 1)) > 0 && at('advanced', J(4, 1)) < 0.6, 'advanced: sometimes 4 onto a higher block')
assert.ok(at('hardcore', J(4, 1)) > 0.7)
assert.equal(at('complicated', J(5, 0, 1)), 0)
assert.ok(at('advanced', J(5, 0, 1)) > 0 && at('advanced', J(5, 0, 1)) < 0.6, 'advanced: sometimes 5 block jumps')
assert.equal(at('advanced', J(5)), 0, 'a flat 5-block jump is not possible without a boost')
assert.ok(at('hardcore', J(5, 0, 1)) > 0.9, 'hardcore is reliable')
assert.ok(at('advanced', J(3, 0, 0, { odd: true })) > 0.8 && at('complicated', J(3, 0, 0, { odd: true })) < 0.2, 'odd-height blocks need advanced')
assert.equal(at('master', J(4, 0, 0, { diag: true })) > 0.9, true)
assert.equal(at('complicated', J(4, 0, 0, { diag: true })), 0, 'diagonals are hardcore and up')
assert.equal(mk('impossible').skill.chance(J(6, 0, 1)) > 0 || mk('impossible').skill.chance(J(6, 0, 1), { potion: true }) > 0.5, true, 'impossible uses a Speed potion for 6')
for (const lv of ['beginning', 'mediocre', 'complicated', 'hardcore', 'impossible']) console.log(' ', lv.padEnd(12), mk(lv).skill.describe())

console.log('== Forward jumps onto a higher block get longer with level ==')
assert.ok(TIERS.every((x, i) => i === 0 || x.upD >= TIERS[i - 1].upD) && TIERS[0].upD === 0 && TIERS[1].upD === 2)

console.log('== Jump finder on a real layout ==')
{
  const w = world(4, 1); w.fill(-8, 56, -3, 12, 56, 3, 'stone') // a floor a few blocks down: a missed jump costs nothing
  const bot = makeBot(w, { x: -1.5, y: 60, z: 0.5 }); bot.settle()
  const jumps = findJumps(bot, { radius: 6 })
  const j = jumps.find((x) => x.from.x === 0 && x.from.z === 0 && x.dx === 1)
  assert.ok(j, 'finds the gap')
  assert.ok(findJumps(makeBot(world(4, 1), { x: -1.5, y: 60, z: 0.5 }), { radius: 6 }).every((x) => x.k !== 4), 'a void under the gap (long fall) is never offered')
  assert.equal(j.k, 4); assert.equal(j.up, 1); assert.equal(j.drop, 0); assert.ok(j.runUp >= 4)
  // a lava pit under the gap is never offered
  const w2 = world(3); w2.fill(-8, 56, -3, 12, 56, 3, 'stone'); w2.fill(1, 58, -3, 2, 58, 3, 'lava')
  const b2 = makeBot(w2, { x: -1.5, y: 60, z: 0.5 }); b2.settle()
  assert.ok(!findJumps(b2, { radius: 6 }).some((x) => x.from.x === 0 && x.dx === 1), 'no jumps over lava')
  console.log('  found', jumps.length, 'jumps; lava pit rejected')
}

console.log('== Executor on real physics: success by level ==')
const rate = async (level, k, dy = 0, n = 30) => {
  const { intel, skill } = mk(level)
  let ok = 0
  for (let i = 0; i < n; i++) {
    const w = world(k, dy)
    const bot = makeBot(w, { x: -4.5, y: 60, z: 0.5 }); bot.settle()
    const j = { from: new Vec3(0, 60, 0), to: new Vec3(k, 60 + dy, 0), dx: 1, dz: 0, k, d: k, up: Math.max(0, dy), drop: Math.max(0, -dy), runUp: 5 }
    if ((await runJump(bot, j, { skill: skill.skill(), tier: skill.tier(), sprint: skill.tierIndex() >= 2 }, {})).ok) ok++
  }
  return ok / n
}
;(async () => {
  const table = [['beginning', 2], ['simple', 2], ['mediocre', 3], ['complicated', 4], ['hardcore', 4]]
  for (const [lv, k] of table) {
    const r = await rate(lv, k)
    console.log(' ', lv.padEnd(12), `${k}-block jump:`, Math.round(r * 100) + '%')
    assert.ok(r >= 0.85, `${lv} should usually make a ${k}-block jump (got ${r})`)
  }
  assert.ok(await rate('simple', 2, 1) >= 0.85, 'simple: 2 blocks forward onto a higher block')
  assert.ok(await rate('mediocre', 2, 1) >= 0.85)
  assert.ok(await rate('complicated', 3, 1) >= 0.85, 'complicated: 3 blocks forward onto a higher block')
  assert.ok(await rate('complicated', 4, 1) >= 0.5, 'a 4-block jump up one is hard but doable at complicated')
  assert.ok(await rate('hardcore', 5, -1) >= 0.9, 'hardcore makes 5-block jumps with a drop')
  assert.equal(await rate('mediocre', 4, 0, 10) >= 0.5, true, 'physics allows 4 blocks; the tier just does not attempt it')

  console.log('== Learning: repetition and failing at harder jumps raise the level ==')
  const { intel, skill } = mk('simple')
  const before = skill.level()
  for (let i = 0; i < 40; i++) skill.record(J(2), true)
  const afterEasy = skill.level()
  for (let i = 0; i < 40; i++) skill.record(J(3), i % 2 === 0)
  const afterHard = skill.level()
  console.log(`  level ${before.toFixed(2)} -> ${afterEasy.toFixed(2)} (easy reps) -> ${afterHard.toFixed(2)} (harder, with failures)`)
  assert.ok(afterEasy > before && afterHard > afterEasy)
  assert.ok(skill.chance(J(2)) > mk('simple').skill.chance(J(2)), 'repetition makes the same jump more reliable')
  const learned = mk('simple'); learned.intel.addXp('parkour', 400)
  assert.ok(learned.skill.level() > 2.5, 'a simple player who keeps practising becomes mediocre or better')
  const off = new Intelligence(() => ({ level: 'simple', learn: false })); off.addXp('parkour', 400)
  assert.equal(off.level('parkour'), 1, 'learning off: no growth')
  console.log('\nALL PARKOUR CHECKS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
