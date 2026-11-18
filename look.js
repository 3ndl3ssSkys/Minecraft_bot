'use strict'

/**
 * look.js — mouse and keyboard, like a person: the camera and the movement keys behave the way they do for someone
 * playing with a mouse and WASD, not like a bot that sets its yaw and walks in exact straight lines.
 *
 * Mouse (every look goes through bot.look):
 *   - A look at something new is a flick: its duration follows Fitts's law (farther = longer, faster for better
 *     players), the speed has a smooth bell shape (minimum-jerk curve), the hand lands a little short (sometimes a bit
 *     past) and makes a small correction, and the path bends slightly instead of being a perfect line.
 *   - Rotation comes in Minecraft's own mouse steps (Mineflayer rounds every change to 0.15°, vanilla's default
 *     sensitivity), only while the mouse moves: a resting hand doesn't jitter.
 *   - Fights: the crosshair follows the target (smooth pursuit), always a little behind, faster for better players.
 *   - `force` looks (a reflex clutch, a precise placement) stay instant while `precise()` says so: muscle memory.
 *
 * Keyboard (while the pathfinder walks):
 *   - The pathfinder says where the next step is; the camera turns there smoothly, looking a few steps ahead and a
 *     little down at the ground (beginners look down more), and the movement keys make up the difference:
 *     W, W+A, A, S+A, S, S+D, D or W+D, whichever goes closest to the next step from where the camera points.
 *     Players curve around corners with W+A/D while the mouse catches up; they don't stop and spin.
 *   - Key combos don't flicker every tick, and sprint starts a moment after walking does (the double-tap/ctrl).
 *   - Narrow ledges, parkour jumps and blocks to dig or place switch back to exact steering: careful players line up.
 */

const { Vec3 } = require('vec3')

const TAU = Math.PI * 2
const DEG = Math.PI / 180
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t) // 0..1 → 0..1, bell-shaped speed
const rand = (a, b) => a + Math.random() * (b - a)
const gauss = () => { let u = 0; let v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v) }

// Movement key combos and the direction each moves in, relative to the camera (left turns yaw up, right down).
const COMBOS = [
  { keys: { forward: true }, off: 0 },
  { keys: { forward: true, left: true }, off: 45 * DEG },
  { keys: { left: true }, off: 90 * DEG },
  { keys: { back: true, left: true }, off: 135 * DEG },
  { keys: { back: true }, off: 180 * DEG },
  { keys: { back: true, right: true }, off: -135 * DEG },
  { keys: { right: true }, off: -90 * DEG },
  { keys: { forward: true, right: true }, off: -45 * DEG }
]

/**
 * Fitts's law: how long a flick of `deg` degrees takes (seconds) for a player of skill 0..1, to a target `width`
 * degrees wide. Casual looking, not max-speed aiming: about 0.85 s for a beginner and 0.45 s for a master on 90°.
 */
function flickTime (deg, skill = 0.5, width = 4, hurry = 1) {
  const a = 0.12 - 0.05 * skill
  const b = 0.16 - 0.08 * skill
  return (a + b * Math.log2(1 + Math.abs(deg) / width)) * hurry
}

/**
 * Plan a flick: per-tick [yaw, pitch] points from (y0, p0) to (y1, p1), the way a hand on a mouse does it
 * (the stochastic optimised-submovement model of aimed movements, Meyer et al.):
 *   - a reaction before a big turn to something new (shorter for better players);
 *   - big turns in swipes with a lift between them: good players use a low sensitivity and aim with the arm
 *     (a 180 needs two swipes), beginners a high one with the wrist (one swipe, less accurate);
 *   - a primary movement whose landing error grows with its size (signal-dependent noise) and shrinks with skill,
 *     usually a little short, sometimes past;
 *   - corrective submovements until it's on target: masters usually land it in one, beginners need two or three;
 *   - a last tiny settle onto the exact spot (what it's mining or placing needs the exact aim).
 * @param {{ react?: boolean }} opt react: false for a look it saw coming (no reaction pause)
 */
function planFlick (y0, p0, y1, p1, skill = 0.5, hurry = 1, opt = {}) {
  const dy = wrap(y1 - y0)
  const dp = p1 - p0
  const deg = Math.hypot(dy, dp) / DEG
  const ticks = Math.max(1, Math.round(flickTime(deg, skill, 4, hurry) * 20))
  if (deg < 3 || ticks <= 2) { // a small adjustment: one smooth move
    return Array.from({ length: ticks }, (_, i) => { const s = minJerk((i + 1) / ticks); return [y0 + dy * s, p0 + dp * s] })
  }
  const pts = []
  let cy = y0
  let cp = p0
  const hold = (n) => { for (let i = 0; i < n; i++) pts.push([cy, cp]) }
  // One submovement from where the hand is to (ty, tp): bell-shaped speed, a slight bow.
  const move = (ty, tp, h) => {
    const my = wrap(ty - cy)
    const mp = tp - cp
    const d = Math.hypot(my, mp) / DEG
    const n = Math.max(1, Math.round(flickTime(d, skill, 4, h) * 20 * rand(0.9, 1.1)))
    const bend = gauss() * 0.03 * (1.3 - skill)
    const sy = cy
    const sp = cp
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const s = minJerk(t)
      const side = Math.sin(Math.PI * t) * bend
      pts.push([sy + my * s - mp * side, sp + mp * s + my * side])
    }
    cy = sy + my
    cp = sp + mp
  }

  // Reaction: a big turn to something it didn't see coming starts a moment late.
  if (opt.react !== false && hurry >= 1 && deg > 40) hold(Math.round((0.3 - 0.16 * skill) * rand(0.8, 1.25) * 20 * 0.5))
  // Swipes: more than one hand-sweep's worth of turning needs a lift and re-place of the mouse in between.
  const sweep = (190 - 80 * skill) * DEG
  const swipes = Math.max(1, Math.ceil(Math.abs(dy) / sweep))
  for (let k = 1; k < swipes; k++) {
    move(y0 + dy * k / swipes * rand(0.92, 1.0), p0 + dp * k / swipes, hurry * 0.85)
    hold(Math.round(rand(1.5, 3))) // the lift
  }
  // Primary movement: the landing error grows with the distance (and shrinks with skill), usually a little short.
  const ry = wrap(y1 - cy)
  const rp = p1 - cp
  const amp = Math.hypot(ry, rp)
  const sd = (0.035 + 0.075 * (1 - skill)) * Math.min(1.6, hurry)
  const along = 1 - (0.02 + 0.03 * (1 - skill)) + gauss() * sd // mean slightly short; past the target sometimes
  const across = gauss() * sd * 0.45
  const ux = amp ? ry / amp : 0
  const uz = amp ? rp / amp : 0
  move(cy + ry * along - uz * across * amp, cp + rp * along + ux * across * amp, hurry)
  // Corrections: each one aimed at the target, with less noise, until it's close enough. Beginners need more.
  const tolerance = (0.6 + 2.2 * (1 - skill)) * DEG
  const maxCorr = 1 + Math.round(2 * (1 - skill))
  for (let c = 0; c < maxCorr; c++) {
    const ey = wrap(y1 - cy)
    const ep = p1 - cp
    const err = Math.hypot(ey, ep)
    if (err < tolerance) break
    if (skill < 0.5) hold(1) // seeing the miss takes a moment
    const n = gauss() * 0.15
    move(cy + ey * (1 + n), cp + ep * (1 + n * 0.7), hurry * 0.8)
  }
  // Settle exactly on the spot.
  pts.push([y0 + dy, p0 + dp])
  return pts
}

/** The movement keys that walk closest to `moveYaw` when the camera points at `camYaw`. */
function pickKeys (camYaw, moveYaw) {
  const want = wrap(moveYaw - camYaw)
  let best = COMBOS[0]
  for (const c of COMBOS) if (Math.abs(wrap(want - c.off)) < Math.abs(wrap(want - best.off))) best = c
  return best
}

/**
 * @param {object} bot
 * @param {object} o
 *   enabled()  human input on (behavior.smoothTurning)
 *   skill()    0..1, how good a player it is (movement)
 *   precise()  true when looks must be instant (a reflex in progress, a parkour run)
 *   combat()   true while fighting: the crosshair tracks instead of flicking
 *   adjust(yaw, pitch) → [yaw, pitch]: where it may look (motion.js: never into an enderman's eyes)
 *   keyboard() true to steer paths with the movement keys (behavior.humanKeys)
 */
function installHumanInput (bot, o = {}) {
  if (bot._human) return bot._human
  const enabled = o.enabled || (() => true)
  const skill = () => Math.max(0, Math.min(1, safe(o.skill) ?? 0.5))
  const precise = o.precise || (() => false)
  const combat = o.combat || (() => false)
  const keyboard = o.keyboard || (() => true)
  const raw = bot.look
  let job = null // { pts, i, resolve }
  let pursuit = null // { yaw, pitch }
  let walk = null // { moveYaw, at } from the pathfinder
  let path = null
  let combo = null
  let comboTicks = 0
  let movingTicks = 0
  const walkPitch = { drift: 0 }
  const history = [] // where the target was, for tracking with a human lag
  const wander = { y: 0, p: 0 } // the crosshair never sits perfectly still on a moving target
  let lastLookAt = Date.now()
  let nextGlance = rand(3000, 7000)

  bot.on('path_update', (r) => { path = r?.path || null })
  for (const ev of ['goal_reached', 'path_reset', 'path_stop']) bot.on(ev, () => { path = null; walk = null })

  const send = (yaw, pitch) => raw.call(bot, yaw, Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch)), false).catch(() => {})
  const finish = () => { if (job) { const j = job; job = null; j.resolve() } }

  bot.look = function (yaw, pitch, force) {
    if (o.adjust) { try { [yaw, pitch] = o.adjust(yaw, pitch) } catch { /* keep it */ } }
    if (!bot.entity || !enabled()) { finish(); return raw.call(bot, yaw, pitch, force) }
    // The pathfinder steering (it looks at the next step, level, every tick): the keyboard layer handles it, or,
    // with the keyboard layer off or a precise moment, it steers exactly as it always did.
    if (!force && pitch === 0 && bot.pathfinder?.isMoving?.()) {
      if (keyboard() && !safe(precise)) { walk = { moveYaw: yaw, at: Date.now() }; return Promise.resolve() }
      finish()
      return raw.call(bot, yaw, pitch, force)
    }
    finish()
    if (force && safe(precise)) { pursuit = null; return raw.call(bot, yaw, pitch, force) }
    if (safe(combat)) { // tracking: never blocks the fight loop
      history.push({ yaw, pitch, at: Date.now() })
      if (history.length > 30) history.shift()
      pursuit = { yaw, pitch }
      return Promise.resolve()
    }
    pursuit = null
    history.length = 0
    lastLookAt = Date.now()
    const pts = planFlick(bot.entity.yaw, bot.entity.pitch, yaw, pitch, skill(), force ? 0.6 : 1)
    if (pts.length === 1) return raw.call(bot, yaw, pitch, force)
    return new Promise((resolve) => {
      job = { pts, i: 0, resolve }
      setTimeout(() => { if (job?.resolve === resolve) finish() }, 3000).unref?.() // physics stops on death: never hang
    })
  }

  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e || !enabled()) return
    // 1. Walking a path: camera eases toward where it's going, keys make up the difference.
    const pathing = walk && Date.now() - walk.at < 250 && bot.pathfinder?.isMoving?.()
    if (pathing) {
      movingTicks++
      if (safe(precise) || exactSteering(bot, path)) { send(walk.moveYaw, 0); combo = null; return }
      const s = skill()
      const ahead = lookAhead(e.position, path, walk.moveYaw)
      walkPitch.drift += (gauss() * 0.4 - walkPitch.drift * 0.05) * DEG // the view wanders a little
      const base = -(22 - 14 * s) * DEG // where the eyes rest while walking: beginners watch their feet, good players the way ahead
      const targetPitch = Math.max(-0.9, Math.min(0.3, base + walkPitch.drift + ahead.slope))
      const dy = wrap(ahead.yaw - e.yaw)
      const k = (0.22 + 0.3 * s) * rand(0.85, 1.15) // how much of the gap the mouse closes per tick
      const max = (10 + 30 * s) * DEG
      const stepY = Math.sign(dy) * Math.min(Math.abs(dy) * k, max)
      send(e.yaw + stepY, e.pitch + (targetPitch - e.pitch) * 0.2)
      if (bot.getControlState('forward') || bot.getControlState('back')) applyKeys(e.yaw + stepY, walk.moveYaw)
      return
    }
    movingTicks = 0
    combo = null
    // 2. A flick in progress.
    if (job) {
      const [y, p] = job.pts[job.i++]
      send(y, p)
      if (job.i >= job.pts.length) finish()
      return
    }
    // 3. Tracking a target in a fight: the hand follows where the target was a moment ago (reaction lag: ~220 ms
    //    for a beginner, ~60 ms for a master), closes part of the gap each tick, and when it has fallen well behind
    //    it catches up in one quick move (like the eyes' catch-up saccades). The aim wanders a little around it.
    if (pursuit && safe(combat)) {
      const s = skill()
      const lag = 220 - 160 * s
      const now = Date.now()
      let goal = history[0] || pursuit
      for (const h of history) if (now - h.at >= lag) goal = h
      wander.y = wander.y * 0.85 + gauss() * (0.5 - 0.4 * s) * DEG
      wander.p = wander.p * 0.85 + gauss() * (0.3 - 0.25 * s) * DEG
      const dy = wrap(goal.yaw + wander.y - e.yaw)
      const dp = goal.pitch + wander.p - e.pitch
      const len = Math.hypot(dy, dp)
      if (len < 0.003) return
      const behind = len > (10 - 7 * s) * DEG // fell behind: catch up in one go
      const k = (behind ? 0.75 : 0.35 + 0.4 * s) * rand(0.85, 1.1)
      const max = (behind ? 45 + 45 * s : 18 + 42 * s) * DEG
      const f = Math.min(len * k, max) / len
      send(e.yaw + dy * f, e.pitch + dp * f)
      lastLookAt = now
      return
    }
    pursuit = null
    // 4. Nothing to look at: glance around now and then, like a player standing still (at someone nearby, or a
    //    relaxed look along the horizon). Only when nothing it's doing needs the aim.
    if (o.idle && safe(o.idle) && Date.now() - lastLookAt > nextGlance) {
      lastLookAt = Date.now()
      nextGlance = rand(2500, 8000)
      const target = o.glanceAt ? safe(o.glanceAt) : null
      let gy
      let gp
      if (target && target.position) {
        const dx = target.position.x - e.position.x
        const dz = target.position.z - e.position.z
        gy = Math.atan2(-dx, -dz)
        gp = Math.atan2((target.position.y + (target.height || 1.6) * 0.85) - (e.position.y + 1.62), Math.hypot(dx, dz))
      } else {
        gy = e.yaw + rand(-1, 1) * rand(20, 80) * DEG
        gp = rand(-12, 6) * DEG
      }
      const pts = planFlick(e.yaw, e.pitch, gy, gp, skill(), 1.5, { react: false }) // unhurried
      if (pts.length > 1) job = { pts, i: 0, resolve: () => {} }
    }
  })

  /** Hold the key combo that walks toward moveYaw; keep it a few ticks (fingers don't flicker), sprint a beat late. */
  function applyKeys (camYaw, moveYaw) {
    const best = pickKeys(camYaw, moveYaw)
    if (combo && best !== combo && comboTicks < 2 && Math.abs(wrap(wrap(moveYaw - camYaw) - combo.off)) < 50 * DEG) comboTicks++
    else { if (best !== combo) comboTicks = 0; combo = best }
    const k = combo.keys
    const wanted = bot.getControlState('sprint')
    for (const c of ['forward', 'back', 'left', 'right']) bot.setControlState(c, Boolean(k[c]))
    bot.setControlState('sprint', Boolean(wanted && k.forward && !k.back && movingTicks > 3)) // sprint needs W, and a moment
  }

  bot._human = { raw, busy: () => Boolean(job), cancel: finish, planFlick, pickKeys }
  bot._smoothLook = bot._human
  return bot._human
}

/** Where to look while walking: a few steps ahead (around gentle bends), and up or down a slope. */
function lookAhead (pos, path, moveYaw) {
  if (!path || !path.length) return { yaw: moveYaw, slope: 0 }
  let target = path[0]
  for (let i = 1; i < Math.min(path.length, 4); i++) {
    const n = path[i]
    const yaw = Math.atan2(-(n.x - pos.x), -(n.z - pos.z))
    if (Math.abs(wrap(yaw - moveYaw)) > 50 * DEG) break
    target = n
  }
  const dx = target.x - pos.x
  const dz = target.z - pos.z
  const dist = Math.hypot(dx, dz)
  if (dist < 0.3) return { yaw: moveYaw, slope: 0 }
  return { yaw: Math.atan2(-dx, -dz), slope: Math.atan2(Math.floor(target.y) - Math.floor(pos.y + 0.01), Math.max(2, dist)) * 0.7 }
}

/** Places where a person lines up carefully: a parkour jump, something to dig or place, a ledge with a drop beside it. */
function exactSteering (bot, path) {
  if (!path || !path.length) return false
  const n = path[0]
  if (n.parkour || n.toBreak?.length || n.toPlace?.length || path[1]?.parkour) return true
  if (bot.entity.isInWater) return true
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const fx = Math.floor(n.x)
  const fy = Math.floor(n.y)
  const fz = Math.floor(n.z)
  for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const b1 = safeBlock(() => at(fx + ox, fy - 1, fz + oz))
    const b2 = safeBlock(() => at(fx + ox, fy - 2, fz + oz))
    if (b1 && b2 && b1.boundingBox === 'empty' && b2.boundingBox === 'empty') return true // a drop right beside the path
  }
  return false
}

function safeBlock (fn) { try { return fn() } catch { return null } }
function safe (fn) { try { return fn() } catch { return false } }

/** Degrees per tick at most (kept for older callers). */
function turnSpeed (skill) {
  return Math.round(25 + 45 * Math.max(0, Math.min(1, skill || 0)))
}

module.exports = { installHumanInput, installSmoothLook: installHumanInput, planFlick, flickTime, pickKeys, lookAhead, minJerk, turnSpeed, wrap, COMBOS }
