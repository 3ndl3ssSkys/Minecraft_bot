'use strict'
// Run with: npm test   (or node test/reflexes.test.js)
// Covers: landing prediction, fall damage, which saves each level knows and picks, success chances,
// learning saves (experience, chat), beginners growing past master, truces
const path = require('path')
const R = path.join(__dirname, '..') + path.sep
const assert = require('assert')
const { Vec3 } = require('vec3')
const { DEFAULT_CONFIG, deepMerge, Brain } = require(R + 'index.js')
const { Reflexes, predictLanding, fallDamage, landingFactor } = require(R + 'reflexes.js')
const { Intelligence, skillAt } = require(R + 'intelligence.js')
const { SocialModel } = require(R + 'social.js')
const { EmotionEngine } = require(R + 'emotions.js')

const SOLID = new Set(['stone', 'dirt', 'cobblestone', 'hay_block', 'slime_block'])

/** A tiny world: a stone floor at y=63 (top at 64), anything else from `blocks`. */
function fakeBot ({ y = 84, vy = -0.6, blocks = {}, items = [], boots = null } = {}) {
  const at = (p) => {
    const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = blocks[`${f.x},${f.y},${f.z}`] || (f.y <= 63 ? 'stone' : 'air')
    return { name, position: f, boundingBox: SOLID.has(name) ? 'block' : 'empty', diggable: true, hardness: 1 }
  }
  const slots = []
  if (boots) slots[8] = boots
  return {
    entity: { position: new Vec3(0.5, y, 0.5), velocity: new Vec3(0, vy, 0), onGround: false, effects: {}, yaw: 0, pitch: 0, metadata: [] },
    registry: { effectsByName: {}, blocksByName: { water: { id: 1 } } },
    blockAt: at,
    inventory: { slots, items: () => items },
    game: { dimension: 'overworld', minY: -64 },
    health: 20,
    findBlocks: () => [],
    findBlock: () => null,
    nearestEntity: () => null,
    getEquipmentDestSlot: () => 45
  }
}

function fakeAgent (level, bot, xp = {}) {
  const config = deepMerge(DEFAULT_CONFIG, { intelligence: { level } })
  const events = []
  return {
    config,
    bot,
    events,
    intelligence: new Intelligence(() => config.intelligence, { xp }),
    memory: { addEvent: (t, x) => events.push(x) },
    log: { info: () => {}, debug: () => {}, warn: () => {} },
    executor: { abort: () => {} },
    learning: { markDirty: () => {} }
  }
}

console.log('== landing and damage ==')
const bot = fakeBot()
const land = predictLanding(bot)
console.log(`from y=84: lands on ${land.block.name} at y=${land.surfaceY} after ${land.ticks} ticks (vy ${land.vy.toFixed(2)})`)
assert.equal(land.surfaceY, 64)
assert.equal(land.block.name, 'stone')
assert.equal(fallDamage(bot, 20), 17)
assert.equal(fallDamage(bot, 3), 0)
// Feather Falling IV boots: 12 EPF → 48% less.
const booted = fakeBot({ boots: { name: 'diamond_boots', enchants: [{ name: 'feather_falling', lvl: 4 }] } })
assert(Math.abs(fallDamage(booted, 20) - 17 * 0.52) < 0.01)
// Into water: no damage; hay bale: 80% less.
const wet = fakeBot({ blocks: { '0,64,0': 'water' } })
const wl = predictLanding(wet)
assert(wl.pass && wl.block.name === 'water')
assert.equal(landingFactor('water'), 0)
assert.equal(landingFactor('hay_block'), 0.2)
assert.equal(landingFactor('stone'), null)
console.log('ok')

console.log('\n== who knows which saves ==')
const all = [{ name: 'water_bucket', count: 1 }, { name: 'ender_pearl', count: 4 }, { name: 'oak_boat', count: 1 }, { name: 'slime_block', count: 2 }, { name: 'cobblestone', count: 32 }]
for (const level of ['beginning', 'simple', 'mediocre', 'complicated', 'advanced', 'hardcore', 'master', 'impossible']) {
  const b = fakeBot({ items: all })
  const r = new Reflexes(fakeAgent(level, b), {})
  const l = predictLanding(b)
  const opts = r.fallOptions(l, 17, b.entity.position.y - l.surfaceY).map((o) => `${o.trick} ${Math.round(r.chance(o.trick, o.window) * 100)}%`)
  console.log(level.padEnd(12), opts.join(', ') || '(no idea what to do)')
}
const tricks = (level, items) => {
  const b = fakeBot({ items })
  const r = new Reflexes(fakeAgent(level, b), {})
  const l = predictLanding(b)
  return r.fallOptions(l, 17, 20).map((o) => o.trick)
}
assert.deepEqual(tricks('beginning', all), []) // has to learn everything
assert(!tricks('mediocre', all).includes('waterBucket'))
assert(tricks('complicated', all).includes('waterBucket'))
assert(tricks('advanced', all).includes('pearl'))
assert(!tricks('advanced', all).includes('boat')) // advanced doesn't know boat clutches...
assert(tricks('master', all).includes('boat')) // ...masters do
console.log('ok')

console.log('\n== success chances (skill + timing) ==')
const chanceAt = (level, trick, window = 10) => new Reflexes(fakeAgent(level, fakeBot()), {}).chance(trick, window)
for (const [level, trick] of [['complicated', 'waterBucket'], ['advanced', 'waterBucket'], ['advanced', 'boat'], ['master', 'boat'], ['master', 'wallPearl'], ['impossible', 'wallPearl'], ['impossible', 'crouchClutch']]) {
  console.log(`${level.padEnd(12)} ${trick.padEnd(13)} ${Math.round(chanceAt(level, trick) * 100)}%  (from very high up: ${Math.round(chanceAt(level, trick, 0.7) * 100)}%)`)
}
assert(chanceAt('advanced', 'waterBucket') > 0.9)
assert(chanceAt('advanced', 'boat') < chanceAt('master', 'boat')) // the skill's there, the timing isn't
assert(chanceAt('impossible', 'wallPearl') > 0.75)
assert(chanceAt('master', 'waterBucket', 1.7) > 0.95) // a 20-block water clutch is routine for a master
assert(chanceAt('master', 'waterBucket', 0.7) < chanceAt('master', 'waterBucket', 10)) // from very high up it's hard...
assert.equal(chanceAt('impossible', 'waterBucket', 0.7), chanceAt('impossible', 'waterBucket', 10)) // ...except for frame-perfect players
const ra = new Reflexes(fakeAgent('impossible', fakeBot()), {})
const rb = new Reflexes(fakeAgent('beginning', fakeBot()), {})
console.log('reaction: beginner', rb.reactionMs(), 'ms, impossible', ra.reactionMs(), 'ms')
assert(rb.reactionMs() > 250 && ra.reactionMs() < 130)
console.log('ok')

console.log('\n== learning saves ==')
const beginner = fakeAgent('beginning', fakeBot({ items: [{ name: 'water_bucket', count: 1 }] }))
const rl = new Reflexes(beginner, {})
const realRandom = Math.random
Math.random = () => 0.1
const learned = rl.discover('falling 20 blocks', ['waterBucket', 'boat'])
Math.random = realRandom
console.log('after a bad fall it learned:', learned, '|', beginner.events.at(-1))
assert.equal(learned, 'waterBucket')
assert(rl.knows('waterBucket') && rl.toJSON().known.waterBucket.how === 'experience')
Math.random = () => 0.1
assert.equal(rl.discover('falling 20 blocks', ['boat']), null) // boat clutches are too far beyond a beginner to work out alone
Math.random = realRandom
// Being told works too (and sticks in the saved data).
const rt = new Reflexes(fakeAgent('beginning', fakeBot()), {})
rt.learnFromText('when you fall, place a water bucket right before you land', 'Alex')
assert(rt.knows('waterBucket'))
assert.equal(rt.toJSON().known.waterBucket.how, 'Alex')
rt.learnFromText('boats are fun', 'Alex') // not about falling: nothing
assert(!rt.knows('boat'))
console.log('ok')

console.log('\n== a beginner can grow past a master ==')
const grown = new Intelligence(() => ({ level: 'beginning', learn: true }), { xp: { survival: 300 } })
const master = new Intelligence(() => ({ level: 'master', learn: true }), { xp: { survival: 300 } })
console.log(`beginner with 300 xp: level ${grown.level('survival').toFixed(2)} (skill ${grown.skill('survival').toFixed(2)}), master: ${master.level('survival').toFixed(2)}`)
assert(grown.level('survival') > 6)
assert(new Intelligence(() => ({ level: 'beginning', learn: true }), { xp: { survival: 40 } }).level('survival') < 2.5) // but slowly
assert(skillAt(6) < skillAt(7))
console.log('ok')

console.log('\n== truces ==')
const config = deepMerge(DEFAULT_CONFIG, { learning: { file: path.join(require('os').tmpdir(), `bot-reflex-${process.pid}.json`) } })
const personality = { forgiveness: 0.6, trustSensitivity: 1, temperament: {} }
const memory = []
const triggers = []
const aborted = []
const steveEntity = { username: 'Steve' }
const agent = {
  config, personality,
  memory: { addEvent: (t, x) => memory.push(x), chat: [] },
  log: { info: () => {}, debug: () => {}, warn: () => {} },
  reactor: { trigger: (t, d) => triggers.push(t) },
  bot: { username: 'Wanderer', entity: { position: { distanceTo: () => 3 } }, players: {}, registry: { foodsByName: {} }, food: 20, entities: { 7: steveEntity } },
  executor: { current: { name: 'attackTarget', args: { entityId: 7 } }, abort: (r) => aborted.push(r) },
  runtimeAdmins: []
}
agent.emotions = new EmotionEngine(() => config.emotions, () => personality)
agent.social = new SocialModel(agent, {})
const brain = new Brain(agent)
agent.social.profile('Steve').affinity = 70
agent.social.profile('Steve').trust = 70
assert.equal(brain.considerTruce('Steve', 'nice weather'), false) // not a truce
Math.random = () => 0.2
assert.equal(brain.considerTruce('Steve', 'ok ok sorry, truce?'), true)
Math.random = realRandom
console.log('liked player asks to stop → stops:', aborted, triggers)
assert(aborted[0].includes('truce') && triggers.includes('truce'))
// Someone it can't stand, still swinging, gets ignored.
agent.social.profile('Grief').affinity = 15
agent.social.profile('Grief').trust = 20
agent.bot.entities[8] = { username: 'Grief' }
agent.executor.current = { name: 'attackTarget', args: { entityId: 8 } }
agent.social.t('Grief').hits.push({ at: Date.now() }, { at: Date.now() }, { at: Date.now() })
Math.random = () => 0.5
assert.equal(brain.considerTruce('Grief', 'sorry sorry stop'), false)
Math.random = realRandom
console.log('disliked player who keeps hitting →', memory.at(-1))
console.log('ok')

console.log('\nAll reflex checks passed')
