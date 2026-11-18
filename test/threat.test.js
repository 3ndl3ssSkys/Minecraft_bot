'use strict'
// Run with: npm test   (or node test/threat.test.js)
// Covers: sizing up creatures — danger against its own gear and health, whether a fight is worth it, and the verdict.
const path = require('path')
const assert = require('assert')
const { assess, describe, ownDps } = require(path.join(__dirname, '..', 'threat.js'))

const z = (id, d, extra = {}) => ({ id, name: 'zombie', distance: d, ...extra })
const one = (mobs, me, ctx) => assess(mobs, me, ctx).list[0]
const stone = { health: 20, armor: 0, weapon: 'stone_sword', skill: 0.5 }

// Better gear and skill hit harder.
assert.ok(ownDps({ weapon: 'diamond_sword', skill: 0.9 }) > ownDps({ weapon: 'stone_sword', skill: 0.5 }))
assert.ok(ownDps({ weapon: 'stone_sword', skill: 0.5 }) > ownDps({ weapon: null, skill: 0.5 }))

// One zombie: a stone sword takes it, bare fists back off; full iron barely notices four of them.
assert.equal(one([z(1, 4)], stone).verdict, 'fight')
assert.equal(one([z(1, 4)], { ...stone, weapon: null }).verdict, 'flee')
const four = [z(1, 4), z(2, 5), z(3, 6), z(4, 7)]
assert.equal(assess(four, stone).verdict, 'flee', 'four zombies with a stone sword and no armour: too many')
assert.equal(assess(four, { health: 20, armor: 15, weapon: 'iron_sword', shield: true, skill: 0.7 }).verdict, 'fight')
// Low health changes the picture.
assert.equal(one([{ id: 5, name: 'vindicator', distance: 5 }], { ...stone, health: 8 }).verdict, 'flee')

// Creepers: shoot them, or keep away.
assert.equal(one([{ id: 6, name: 'creeper', distance: 3 }], stone).verdict, 'flee')
assert.equal(one([{ id: 6, name: 'creeper', distance: 8 }], { ...stone, bow: true, arrows: 12 }).verdict, 'fight')

// Neutral mobs are left alone unless provoked; animals are worth it for food when hungry, not otherwise.
assert.equal(one([{ id: 7, name: 'enderman', distance: 6 }], stone).verdict, 'ignore')
assert.equal(one([{ id: 7, name: 'enderman', distance: 6, hurtMe: true }], { health: 20, armor: 15, weapon: 'diamond_sword', skill: 0.8 }).verdict, 'fight', 'it attacked: fight back with good gear')
assert.equal(one([{ id: 8, name: 'cow', distance: 5 }], { ...stone, food: 8, foodCount: 0 }).verdict, 'fight')
assert.equal(one([{ id: 8, name: 'cow', distance: 5 }], { ...stone, food: 20, foodCount: 12 }).verdict, 'ignore')
assert.equal(one([{ id: 8, name: 'cow', distance: 5, baby: true }], { ...stone, food: 20, foodCount: 12 }).verdict, 'ignore')
// Spiders are calm by day; worth it when it wants string.
assert.equal(one([{ id: 9, name: 'spider', distance: 6 }], stone, { day: true }).verdict, 'ignore')
assert.equal(one([{ id: 9, name: 'spider', distance: 6 }], stone, { day: true, wants: new Set(['string']) }).verdict, 'fight')
// Gold armour keeps piglins calm.
assert.equal(one([{ id: 10, name: 'piglin', distance: 5 }], stone, { wearingGold: true }).verdict, 'ignore')

// Protected (an iron farm's zombie, a pet): left alone, and not counted as a threat.
const farm = assess([z(11, 3, { protected: 'trapped in a farm' })], stone)
assert.equal(farm.list[0].verdict, 'leave')
assert.equal(farm.verdict, 'safe')
// Never fight a warden, whatever the gear.
assert.equal(one([{ id: 12, name: 'warden', distance: 12 }], { health: 20, armor: 20, weapon: 'netherite_sword', skill: 1 }).verdict, 'flee')

// Braver personalities take on more; a scared one less.
const borderline = [z(1, 4), z(2, 5)]
const brave = assess(borderline, { ...stone, health: 12 }, { risk: 1 })
const scared = assess(borderline, { ...stone, health: 12 }, { risk: 0.1, fear: 0.8 })
assert.ok(brave.nerve > scared.nerve)
// The prompt lines say why.
const lines = describe(assess([z(1, 4), { id: 8, name: 'cow', distance: 5 }], { ...stone, food: 8 }))
assert.ok(lines.some((l) => /zombie 4m: danger \w+, worth fighting \(it will come for you anyway\) → fight/.test(l)), lines.join('\n'))
assert.ok(lines.some((l) => /cow 5m: worth hunting \(food\) → hunt/.test(l)), lines.join('\n'))
console.log('All threat checks passed')
