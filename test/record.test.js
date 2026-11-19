'use strict'
// Run with: npm test   (or node test/record.test.js)
// Covers: reading the packet stream (scripts/record.js), measuring aim from motion recordings
// (scripts/analyze-motion.js: it should recover the skill of flicks made by look.js), the compact state (observe.js),
// and people's recordings in the training set.
const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const assert = require('assert')
const { execFileSync } = require('child_process')
const { Frames, readHandshake, readVarInt, versionFor } = require(path.join(__dirname, '..', 'scripts', 'record.js'))
const { analyze } = require(path.join(__dirname, '..', 'scripts', 'analyze-motion.js'))
const { planFlick } = require(path.join(__dirname, '..', 'look.js'))
const observe = require(path.join(__dirname, '..', 'observe.js'))

// ---- Packet frames: length-prefixed, compressed above a threshold ----
const varint = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b) } while (n); return Buffer.from(out) }
const frame = (payload) => Buffer.concat([varint(payload.length), payload])
const got = []
let threshold = -1
const f = new Frames(() => threshold, (p) => got.push(p.toString('hex')))
const a = Buffer.from([0x01, 0x02, 0x03])
const both = Buffer.concat([frame(a), frame(Buffer.from([0x09]))])
f.feed(both.subarray(0, 2)) // split anywhere
f.feed(both.subarray(2))
assert.deepEqual(got, ['010203', '09'])
threshold = 64
const big = Buffer.alloc(200, 7)
f.feed(frame(Buffer.concat([varint(200), zlib.deflateSync(big)])))
f.feed(frame(Buffer.concat([varint(0), Buffer.from([0x05])])))
assert.equal(got[2], big.toString('hex'))
assert.equal(got[3], '05')
assert.deepEqual(readVarInt(varint(300), 0), { value: 300, size: 2 })
// The handshake: protocol 769 (1.21.4), "localhost", 25565, login.
const host = Buffer.from('localhost')
const hs = Buffer.concat([varint(0), varint(769), varint(host.length), host, Buffer.from([0x63, 0xdd]), varint(2)])
assert.deepEqual(readHandshake(hs), { protocol: 769, nextState: 2 })
assert.equal(versionFor(769), '1.21.4')
console.log('packet stream ok')

// ---- Aim: flicks made by look.js at a known skill, measured back ----
function synth (skill, seed) {
  let s = seed
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const orig = Math.random
  Math.random = rnd
  const rows = []
  let t = 1e12
  let yaw = 0
  let pitch = 0
  const DEG = Math.PI / 180
  try {
    for (let i = 0; i < 80; i++) {
      const ty = yaw + (rnd() < 0.5 ? -1 : 1) * (15 + rnd() * 120) * DEG
      const tp = Math.max(-1.2, Math.min(1.2, (rnd() - 0.5) * 60 * DEG))
      for (const [y, p] of planFlick(yaw, pitch, ty, tp, skill, 1, { react: false })) {
        t += 50
        rows.push([t, 'm', 0, 64, 0, -y / DEG, -p / DEG, 1]) // as the client sends it: degrees
      }
      yaw = ty; pitch = tp
      for (let k = 0; k < 8; k++) { t += 50; rows.push([t, 'm', 0, 64, 0, -yaw / DEG, -pitch / DEG, 1]) } // still a moment
    }
  } finally { Math.random = orig }
  return rows
}
const good = analyze(synth(0.9, 7))
const poor = analyze(synth(0.15, 7))
console.log(`skill 0.9 measured as ${good.aimSkill} (a ${good.a}, b ${good.b}, ${good.submovements} movements); skill 0.15 as ${poor.aimSkill} (a ${poor.a}, b ${poor.b}, ${poor.submovements})`)
assert.ok(good.flicks >= 40 && poor.flicks >= 40, 'flicks found')
assert.ok(good.aimSkill > poor.aimSkill + 0.3, 'a good aim measures clearly better than a poor one')
assert.ok(Math.abs(good.aimSkill - 0.9) < 0.3 && Math.abs(poor.aimSkill - 0.15) < 0.3, 'close to the real skill')
// Clicks per second and strafing in a fight.
const fight = []
let t = 1e12
for (let i = 0; i < 20; i++) { t += 600; fight.push([t, 'k', i % 2 ? 'fl' : 'fr']); fight.push([t + 1, 'h', 9, 1, 0, 65, 2, 'zombie']) }
const fp = analyze(fight)
assert.ok(fp.cps > 1.5 && fp.cps < 1.8, `cps ${fp.cps}`)
assert.equal(fp.strafeWhileHitting, 1)
console.log('motion analysis ok')

// ---- The compact state: short, and relative when coordinates aren't known ----
const snap = {
  self: { position: { x: 100.4, y: 64, z: -20.2 }, health: 14, food: 9, dimension: 'overworld' },
  world: { timeOfDay: 13500, phase: 'night' },
  equipment: { hand: 'stone_sword (80% durability)', head: 'iron_helmet' },
  inventory: { items: { cobblestone: 40, bread: 3, oak_log: 5 }, freeSlots: 20 },
  nearbyBlocks: { iron_ore: { distance: 6 }, stone: { distance: 1 }, oak_log: { distance: 9, visible: false } },
  nearbyEntities: [{ id: 41, kind: 'hostile', name: 'zombie', distance: 7.2 }, { id: 7, kind: 'player', name: 'Steve', distance: 4, holding: 'bow' }],
  layout: 'Outdoors.',
  status: { goal: 'get iron armor', threats: ['zombie 7m: danger low → fight'] },
  recentActions: [{ action: 'mineBlock', args: { blockType: 'stone' }, ok: true }],
  recentChat: ['<Steve> careful'],
  recentEvents: []
}
const text = observe.compact(snap, { coords: false, options: ['1. attackTarget({"entityId":41}) — a zombie you can take [urgent]'] })
assert.ok(/health 14\/20, food 9\/20/.test(text) && /night/.test(text))
assert.ok(!/100 64 -20/.test(text), 'no coordinates without F3')
assert.ok(/iron_ore 6m/.test(text) && !/oak_log 9m/.test(text) && !/stone 1m/.test(text), 'notable blocks it can see')
assert.ok(/zombie #41 7m, hostile/.test(text) && /Steve #7 4m, holding bow/.test(text))
assert.ok(/Goal: get iron armor/.test(text) && /Good options/.test(text))
assert.ok(text.length < 1200, `compact (${text.length} chars)`)
assert.ok(/at 100 64 -20/.test(observe.compact(snap, { coords: true })))
console.log('compact state ok')

// ---- People's recordings go into the short training set ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-'))
fs.mkdirSync(path.join(dir, 'demos'))
const demo = (n, ok = true) => JSON.stringify({ model: 'human', level: 'advanced', short: 'You are Alex.', compact: `You: health 20/20 ${n}`, answer: { thought: 'mining', action: { name: 'mineBlock', args: { blockType: 'stone', count: n } } }, ok })
fs.writeFileSync(path.join(dir, 'demos', 'a.jsonl'), [demo(3), demo(4), demo(5, false)].join('\n') + '\n')
const outText = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'training-set.js'), path.join(dir, 'decisions.jsonl'), '--short'], { encoding: 'utf8' })
assert.ok(/from people playing: 2/.test(outText), outText)
const train = fs.readFileSync(path.join(dir, 'train-short.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
assert.equal(train.length, 2)
assert.equal(train[0].messages[0].content, 'You are Alex.')
assert.ok(/Choose your next action/.test(train[0].messages[1].content))
fs.rmSync(dir, { recursive: true, force: true })
console.log('training set with recordings ok')
console.log('record tests passed')
