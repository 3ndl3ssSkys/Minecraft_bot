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

/** Plan a flick: per-tick [yaw, pitch] points from (y0, p0) to (y1, p1). */
function planFlick (y0, p0, y1, p1, skill = 0.5, hurry = 1) {
  const dy = wrap(y1 - y0)
  const dp = p1 - p0
  const deg = Math.hypot(dy, dp) / DEG
  const ticks = Math.max(1, Math.round(flickTime(deg, skill, 4, hurry) * 20))
  if (deg < 3 || ticks <= 2) { // a small adjustment: one smooth move
    return Array.from({ length: ticks }, (_, i) => { const s = minJerk((i + 1) / ticks); return [y0 + dy * s, p0 + dp * s] })
  }
  // Primary move: lands short (usually) or a bit past (sometimes, more for beginners), slightly curved.
  const over = Math.random() < 0.12 + 0.12 * (1 - skill)
  const reach = over ? 1 + Math.abs(gauss()) * 0.03 * (1.5 - skill) : 1 - Math.abs(gauss()) * (0.07 - 0.04 * skill)
  const bend = gauss() * 0.035 // sideways bow as a fraction of the distance
  const nPrim = Math.max(1, Math.round(ticks * 0.75))
  const nCorr = Math.max(1, ticks - nPrim)
  const pts = []
  for (let i = 1; i <= nPrim; i++) {
    const t = i / nPrim
    const s = minJerk(t) * reach
    const side = Math.sin(Math.PI * t) * bend
    pts.push([y0 + dy * s - dp * side, p0 + dp * s + dy * side])
  }
  const [cy, cp] = pts.at(-1)
  for (let i = 1; i <= nCorr; i++) { const s = minJerk(i / nCorr); pts.push([cy + (y0 + dy - cy) * s, cp + (p0 + dp - cp) * s]) }
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
    if (safe(combat)) { pursuit = { yaw, pitch }; return Promise.resolve() } // tracking: never blocks the fight loop
    pursuit = null
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
    // 3. Tracking a target in a fight.
    if (pursuit && safe(combat)) {
      const s = skill()
      const dy = wrap(pursuit.yaw - e.yaw)
      const dp = pursuit.pitch - e.pitch
      const k = (0.35 + 0.4 * s) * rand(0.85, 1.1)
      const max = (18 + 42 * s) * DEG
      const len = Math.hypot(dy, dp)
      if (len < 0.003) return
      const f = Math.min(len * k, max) / len
      send(e.yaw + dy * f, e.pitch + dp * f)
    } else pursuit = null
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
