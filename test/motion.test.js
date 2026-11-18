'use strict'
// Run with: npm test   (or node test/motion.test.js)
// Covers: when to sprint-jump along a path, dropping nodes flown over, never looking an enderman in the eyes
const path = require('path')
const assert = require('assert')
const { Vec3 } = require('vec3')
const { straightFlat, passedNodes, adjustLook } = require(path.join(__dirname, '..', 'motion.js'))

const node = (x, y, z) => Object.assign(new Vec3(x + 0.5, y, z + 0.5), { toBreak: [], toPlace: [] })
const line = (n, dx = 1, dz = 0, y = 64) => Array.from({ length: n }, (_, i) => node(i * dx + 1, y, i * dz))
const pos = new Vec3(0.5, 64, 0.5)
assert.ok(straightFlat(line(6), pos), 'long straight flat stretch: sprint-jump')
assert.ok(!straightFlat(line(3), pos), 'too short')
const bend = [...line(3), node(3, 64, 1), node(3, 64, 2)]
assert.ok(!straightFlat(bend, pos), 'about to turn')
const step = [...line(2), node(3, 65, 0), node(4, 65, 0)]
assert.ok(!straightFlat(step, pos), 'a step up')
const dig = line(6); dig[2].toBreak = [{ x: 3, y: 64, z: 0 }]
assert.ok(!straightFlat(dig, pos), 'something to dig')
assert.ok(straightFlat(line(6, 1, 1), pos), 'diagonal is fine')

// flown past the first two nodes
const p = line(6)
assert.equal(passedNodes(p, new Vec3(3.1, 65, 0.5)), 2)
assert.equal(passedNodes(p, new Vec3(1.2, 64, 0.5)), 0)
assert.equal(passedNodes(p, new Vec3(3.1, 65, 4)), 0, 'off to the side: not on the path')

// endermen
const bot = { entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, entities: { 1: { name: 'enderman', position: new Vec3(0, 64, -10) } } }
const head = new Vec3(0, 66.55, -10).minus(new Vec3(0, 65.62, 0))
const pitchToHead = Math.atan2(head.y, Math.hypot(head.x, head.z))
const [, pitch] = adjustLook(bot, 0, pitchToHead)
assert.ok(pitch < pitchToHead - 0.1, 'looks down at its feet instead')
const [, other] = adjustLook(bot, Math.PI / 2, 0)
assert.equal(other, 0, 'looking elsewhere: unchanged')
console.log('All motion checks passed')
