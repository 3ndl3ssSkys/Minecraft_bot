'use strict'
// Run with: npm test   (or node test/social.test.js)
// Covers: trust changes and hostility, promises, apologies, combat-style learning, lesson dedupe
const path = require('path')
const R = path.join(__dirname, '..') + path.sep
const { DEFAULT_CONFIG, deepMerge } = require(R + 'index.js')
const { EmotionEngine } = require(R + 'emotions.js')
const { SocialModel } = require(R + 'social.js')
const { CombatLearner, LessonBook } = require(R + 'learning.js')
const assert = require('assert')

const config = deepMerge(DEFAULT_CONFIG, { behavior: { owners: ['Boss'], admins: ['Mod'] }, learning: { file: path.join(require('os').tmpdir(), `bot-test-${process.pid}.json`) } })
const personality = { baselineMood: 'calm', forgiveness: 0.5, trustSensitivity: 1, temperament: {} }
const events = []
const triggers = []
const agent = {
  config, personality,
  memory: { addEvent: (t, x) => events.push(x), chat: [] },
  log: { info: () => {}, debug: () => {}, warn: console.warn },
  reactor: { trigger: (t, d) => triggers.push(t) },
  bot: { username: 'Wanderer', entity: { position: { distanceTo: () => 3 } }, players: {}, registry: { foodsByName: { bread: {} } }, food: 20, entities: {} },
  runtimeAdmins: []
}
agent.emotions = new EmotionEngine(() => config.emotions, () => personality)
const social = agent.social = new SocialModel(agent, {})

// Roles
assert.equal(social.role('boss'), 'owner'); assert.equal(social.role('Mod'), 'admin'); assert.equal(social.role('Steve'), 'player')

// One friendly punch from a trusted player barely matters
social.profile('Alex').trust = 80
social.onHurtBy({ username: 'Alex', heldItem: null }, { botHealthBefore: 20 })
console.log('Alex after one punch:', social.profile('Alex').trust, '| hostile:', social.isHostile('Alex'))
assert(social.profile('Alex').trust >= 79)

// Repeated sword hits while low → big drop + hostile
for (let i = 0; i < 3; i++) social.onHurtBy({ username: 'Steve', heldItem: { name: 'diamond_sword' } }, { botHealthBefore: i === 2 ? 6 : 15 })
const steve = social.profile('Steve')
console.log('Steve after 3 sword hits (last at low hp):', steve.trust, '| hostile:', social.isHostile('Steve'), '| notes:', steve.notes.map(n => n.text))
assert(steve.trust < 60 && social.isHostile('Steve'))
console.log('feelings:', agent.emotions.describe())

// Killed by Steve → enemy
social.onKilledBy('Steve')
console.log('Steve after killing bot:', steve.trust, social.tier(steve.trust))
assert(steve.trust < 20)

// Promises: give_item kept via gift; expired 'help' gets a softer penalty
social.onChatAnalysis('Alex', { playerEmotion: 'friendly', playerIntent: 'friendly', trustImpact: 1, promise: { made: true, kind: 'give_item', description: 'give you 3 iron', item: 'iron_ingot', count: 3, withinMinutes: 5 } })
social.onGift('Alex', 'iron_ingot', 3)
console.log('Alex promise status:', social.profile('Alex').promises.map(p => p.status), 'trust', social.profile('Alex').trust)
assert.equal(social.profile('Alex').promises[0].status, 'kept')
social.onChatAnalysis('Bob', { promise: { made: true, kind: 'come', description: 'come back to help', withinMinutes: 1 } })
social.profile('Bob').promises[0].dueAt = Date.now() - 1
social.checkPromises()
console.log('Bob after broken "come" promise:', social.profile('Bob').trust, social.profile('Bob').promises[0].status)

// Apology recovers some trust, less the second time
social.profile('Carl').trust = 75
for (let i = 0; i < 3; i++) social.onHurtBy({ username: 'Carl', heldItem: { name: 'iron_axe' } }, { botHealthBefore: 18 })
const low = social.profile('Carl').trust
social.onChatAnalysis('Carl', { playerIntent: 'apologetic', trustImpact: 0 })
const after1 = social.profile('Carl').trust
social.onChatAnalysis('Carl', { playerIntent: 'apologetic', trustImpact: 0 })
console.log(`Carl: ${low} → sorry → ${after1} → sorry again → ${social.profile('Carl').trust}`)
assert(after1 > low && social.profile('Carl').trust - after1 < after1 - low)

console.log('relationship line:', social.relationshipLine('Steve'))
console.log('triggers:', [...new Set(triggers)].join(', '))

// Combat learner prefers what works
const cl = new CombatLearner({}, () => ({ epsilon: 0 }))
for (let i = 0; i < 6; i++) cl.record('zombie', 'aggressive', 'win', { hitsLanded: 4, hitsTaken: 1, healthLost: 2 })
for (let i = 0; i < 6; i++) cl.record('zombie', 'cautious', 'fled', { hitsLanded: 1, hitsTaken: 4, healthLost: 12 })
const picks = {}; for (let i = 0; i < 200; i++) { const s = cl.chooseStyle('zombie').name; picks[s] = (picks[s] || 0) + 1 }
console.log('style picks vs zombie:', picks, '| summary:', cl.summary())
assert(picks.aggressive > 150)
assert.equal(cl.chooseStyle('creeper', { available: ['aggressive', 'balanced', 'cautious', 'hitAndRun'] }).name, 'hitAndRun')

const lb = new LessonBook({}, () => ({ maxLessons: 3 }))
lb.add('Creepers explode if you stand still next to them'); lb.add('creepers explode if you stand still near them')
console.log('lessons (deduped):', lb.lessons.map(l => `${l.text} x${l.times}`))
assert.equal(lb.lessons.length, 1)
console.log('ALL UNIT CHECKS PASSED')
