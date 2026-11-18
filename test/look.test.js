'use strict'
// Run with: npm test   (or node test/look.test.js)
// Covers: mouse movement by level (look.js) — the submovement model: beginners need more corrections and land
// farther off, big turns come in swipes with a lift, every flick ends exactly on target, tracking lags behind.
const path = require('path')
const assert = require('assert')
const { EventEmitter } = require('events')
const { planFlick } = require(path.join(__dirname, '..', 'look.js'))
const DEG = Math.PI / 180

// Movements in a flick: runs of motion (more than half a degree) separated by a pause or a change of direction.
function movements (pts) {
  const runs = []; let run = null; let lastDir = null
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i][0] - pts[i - 1][0]
    const dir = Math.sign(d)
    if (Math.abs(d) < 1e-6) { run = null; continue }
    if (!run || dir !== lastDir) { run = { total: 0 }; runs.push(run) }
    run.total += Math.abs(d); lastDir = dir
  }
  return runs.filter((r) => r.total > 0.5 * DEG).length
}
const stats = (skill, deg, N = 600) => {
  let moves = 0; let firstPause = 0; let midPause = 0
  for (let i = 0; i < N; i++) {
    const p = planFlick(0, 0, deg * DEG, -5 * DEG, skill)
    const same = (a, b) => Math.abs(((a - b + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI) < 1e-9 // 180° and -180° are the same way
    assert.ok(same(p.at(-1)[0], deg * DEG) && Math.abs(p.at(-1)[1] + 5 * DEG) < 1e-9, 'ends exactly on target')
    moves += movements(p)
    if (Math.abs(p[0][0]) < 1e-9) firstPause++
    const mid = p.slice(2, -3).some((q, j, a) => j > 0 && Math.abs(q[0] - a[j - 1][0]) < 1e-9 && Math.abs(q[0]) > 30 * DEG && Math.abs(q[0]) < (deg - 30) * DEG)
    if (mid) midPause++
  }
  return { moves: moves / N, firstPause: firstPause / N, midPause: midPause / N }
}

const beginner = stats(0.08, 60)
const master = stats(0.97, 60)
assert.ok(beginner.moves > master.moves + 0.3, `beginners correct more (${beginner.moves.toFixed(2)} vs ${master.moves.toFixed(2)})`)
assert.ok(master.moves < 1.6, `a master usually lands it in about one (${master.moves.toFixed(2)})`)
// a reaction before a big turn to something new; none when it saw it coming
assert.ok(stats(0.5, 120).firstPause > 0.9)
assert.ok(planFlick(0, 0, 120 * DEG, 0, 0.5, 1, { react: false })[0][0] !== 0)
// a 180 by a low-sensitivity master: two swipes with a lift between
assert.ok(stats(0.97, 180).midPause > 0.8, 'a lift in the middle of a 180')

// Tracking: follows where the target was a moment ago; a master keeps up better than a beginner.
async function track (skill) {
  const b = new EventEmitter()
  b.entity = { yaw: 0, pitch: 0, position: { x: 0, y: 64, z: 0 } }
  b.look = async (yaw, pitch) => { b.entity.yaw = yaw; b.entity.pitch = pitch }
  require(path.join(__dirname, '..', 'look.js')).installHumanInput(b, { skill: () => skill, combat: () => true })
  let err = 0
  for (let i = 0; i < 60; i++) { // a target circling at 90°/s
    const t = i * 0.05 * 90 * DEG
    b.look(t, 0)
    await new Promise((r) => setTimeout(r, 50)) // game ticks
    b.emit('physicsTick')
    if (i > 20) err += Math.abs(((t - b.entity.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI)
  }
  return err / 39 / DEG
}
;(async () => {
  const eb = await track(0.08)
  const em = await track(0.97)
  assert.ok(em < eb, `a master tracks closer (${em.toFixed(1)}° vs ${eb.toFixed(1)}° behind)`)
  console.log(`All mouse checks passed (corrections: beginner ${beginner.moves.toFixed(2)}, master ${master.moves.toFixed(2)}; tracking error: beginner ${eb.toFixed(1)}°, master ${em.toFixed(1)}°)`)
})().catch((err) => { console.error(err); process.exit(1) })
