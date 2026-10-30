'use strict'
// Run with: npm test   (or node test/tasks.test.js)
// Covers: request judgment, liking vs kindness, kill requests, conflicts, forgetting, partial work
const path = require('path')
const R = path.join(__dirname, '..') + path.sep
const assert = require('assert')
const { DEFAULT_CONFIG, deepMerge } = require(R + 'index.js')
const { EmotionEngine } = require(R + 'emotions.js')
const { SocialModel } = require(R + 'social.js')
const { TaskManager } = require(R + 'tasks.js')

const config = deepMerge(DEFAULT_CONFIG, { behavior: { owners: ['Boss'] } })
const personality = { baselineMood: 'calm', forgiveness: 0.5, helpfulness: 0.6, patience: 1, forgetfulness: 0.3, violence: 0.35, generosity: 0.5, temperament: {} }
const inv = []
const pos = { distanceTo: () => 5 }
const ent = (name) => ({ username: name, position: pos, type: 'player' })
const names = ['Boss', 'Alex', 'Bob', 'Steve', 'Carl', 'Dan', 'Eve', 'Kind', 'Fun', 'Wanderer']
const agent = {
  config, personality, events: [],
  memory: { addEvent: (t, x) => agent.events.push(x), chat: [] },
  log: { info: () => {}, debug: () => {}, warn: console.warn },
  reactor: { trigger: (t, d) => agent.events.push(`[${t}]`) },
  brain: { onNewGoal () {}, wake () {}, fightOrFlight: () => 'fight' },
  bot: {
    username: 'Wanderer', food: 20, health: 20, entity: { position: pos }, entities: {},
    players: Object.fromEntries(names.map((n) => [n, { username: n, entity: ent(n) }])),
    registry: { foodsByName: {}, entitiesByName: { zombie: {}, creeper: {} } },
    inventory: { items: () => inv }
  },
  runtimeAdmins: []
}
agent.emotions = new EmotionEngine(() => config.emotions, () => personality)
agent.social = new SocialModel(agent, {})
agent.tasks = new TaskManager(agent, {})
const { social, tasks } = agent
const tally = (from, req, n = 1500) => {
  const t = { comply: 0, partial: 0, defer: 0, refuse: 0 }
  for (let i = 0; i < n; i++) t[tasks.appraise(from, req).outcome]++
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v / n * 100) + '%']))
}
const logs = { kind: 'gather', description: 'get 10 oak logs', item: 'oak_log', count: 10, effort: 'small', risk: 'none' }

console.log('== Favours depend on LIKING, not kindness ==')
social.profile('Kind').trust = 95; social.profile('Kind').affinity = 35
social.profile('Fun').trust = 62; social.profile('Fun').affinity = 85
console.log('10 logs  | stranger (like 50):', tally('Carl', logs))
console.log('10 logs  | kind but dull (trust 95, like 35):', tally('Kind', logs))
console.log('10 logs  | rough but liked (trust 62, like 85):', tally('Fun', logs))
console.log('10 logs  | owner:', tally('Boss', logs))
const pKind = parseInt(tally('Kind', logs).comply); const pFun = parseInt(tally('Fun', logs).comply)
assert(pFun > pKind + 20, 'liked player should get more help than merely kind one')

console.log('\n== Effort matters ==')
const diamonds = { kind: 'gather', description: 'get me 64 diamonds', item: 'diamond', count: 64, effort: 'small', risk: 'low' }
console.log('64 diamonds | liked friend:', tally('Fun', diamonds), '| estimated effort:', tasks.normalize('Fun', diamonds).effort, tasks.normalize('Fun', diamonds).minutes + 'min')
const partial = (() => { let d; do { d = tasks.appraise('Fun', { ...logs, count: 128, description: 'get 128 logs' }) } while (d.outcome !== 'partial'); return d })()
console.log('128 logs partial example:', partial.commitCount, 'of 128 —', partial.reason)

console.log('\n== Kill requests: does it WANT to? ==')
social.profile('Alex').affinity = 82; social.profile('Alex').trust = 85
let d = tasks.appraise('Bob', { kind: 'attack', description: 'kill Alex', target: 'Alex' })
console.log('Bob: "kill Alex" (Alex is a friend) →', d.outcome, '—', d.reason, '| side effects:', d.sideEffects.map((x) => x.join(' ')).join('; '))
assert.equal(d.outcome, 'refuse')
tasks.accept('Bob', d)
console.log('   Bob after asking: trust', social.profile('Bob').trust, 'liking', social.profile('Bob').affinity)
social.onKilledBy('Steve')
social.profile('Fun').affinity = 85
console.log('Fun: "kill Steve" (Steve killed you) →', tally('Fun', { kind: 'attack', description: 'kill Steve', target: 'Steve' }))
console.log('Fun: "kill Carl" (Carl never did anything) →', tally('Fun', { kind: 'attack', description: 'kill Carl', target: 'Carl' }))
console.log('Boss (owner): "kill Carl" →', tally('Boss', { kind: 'attack', description: 'kill Carl', target: 'Carl' }))
agent.brain.fightOrFlight = () => 'flee'
console.log('Fun: "kill Steve" but Steve would win →', tally('Fun', { kind: 'attack', description: 'kill Steve', target: 'Steve' }))
agent.brain.fightOrFlight = () => 'fight'

console.log('\n== Conflicts with an earlier promise ==')
social.profile('Eve').affinity = 80
const prot = tasks.appraise('Eve', { kind: 'protect', description: 'protect Dan', target: 'Dan', effort: 'medium' })
prot.outcome = 'comply'; tasks.accept('Eve', prot)
social.profile('Dan').trust = 30 // even someone we don't trust much
d = tasks.appraise('Fun', { kind: 'attack', description: 'kill Dan', target: 'Dan' })
console.log('Fun: "kill Dan" while protecting Dan for Eve →', d.outcome, '—', d.reason)
assert.equal(d.outcome, 'refuse'); assert(/promised Eve/.test(d.reason))
tasks.tasks = []

console.log('\n== Forgetting & recall ==')
personality.forgetfulness = 0.9
social.profile('Carl').affinity = 40
const later = tasks.appraise('Carl', logs); later.outcome = 'defer'
const busy = tasks.appraise('Fun', logs); busy.outcome = 'comply'; tasks.accept('Fun', busy)
tasks.accept('Carl', later)
const real = Date.now; let fake = real()
Date.now = () => fake
for (let m = 0; m < 120 && tasks.queued().length; m++) { fake += 60000; tasks.lastTick = fake - 60000; tasks.tick(); if (tasks.active()) tasks.active().lastProgressAt = fake; tasks.active() && (tasks.active().startedAt = fake) }
const f = tasks.history.find((t) => t.from === 'Carl')
console.log("Carl's deferred task:", f ? `${f.status} after ~${Math.round((f.forgottenAt - f.createdAt) / 60000)} min (${f.forgotWhy})` : 'still remembered')
assert(f && f.status === 'forgotten')
console.log('aboutPlayer(Carl):\n' + tasks.aboutPlayer('Carl'))
const back = tasks.recall('Carl')
console.log('Carl reminds the bot → recalled:', Boolean(back), '| queued now:', tasks.queued().map((t) => t.description))
Date.now = real
personality.forgetfulness = 0.3
tasks.tasks = []

console.log('\n== Partial completion when patience runs out ==')
const job = tasks.appraise('Fun', { ...logs, count: 10 }); job.outcome = 'comply'; job.commitCount = 10
const t = tasks.accept('Fun', job)
inv.push({ name: 'oak_log', count: 4 })
t.startedAt = Date.now() - t.budgetMs - 1000
tasks.lastTick = 0; tasks.tick()
console.log('status after budget:', t.status, '| commit now', t.commitCount, '| reason:', t.partialReason)
const act = tasks.nextForcedAction()
console.log('forced action:', JSON.stringify(act.action))
assert.equal(act.action.name, 'giveItem'); assert.equal(act.action.args.count, 4)
inv.length = 0
tasks.onGave('Fun', 'oak_log', 4)
console.log('final:', tasks.history.at(-1).status, '| events:', agent.events.slice(-2).join(' / '))
assert.equal(tasks.history.at(-1).status, 'partial')

console.log('\n== Bossiness: constant requests lower liking ==')
const before = social.profile('Kind').affinity
for (let i = 0; i < 6; i++) social.noteRequest('Kind')
console.log('Kind liking', before, '→', social.profile('Kind').affinity)
console.log('\nALL TASK CHECKS PASSED')
