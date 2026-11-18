'use strict'

/**
 * motion.js — moving like a player of its level, on top of the pathfinder.
 *
 *   sprint-jumping  experienced players sprint-jump down long straight flat stretches (it's faster); beginners
 *                   just walk (sprinting itself is unlocked by skill elsewhere). Only on a straight, flat path with
 *                   headroom, never in water, never hungry. Nodes flown over mid-jump are dropped from the path, or the
 *                   pathfinder would turn back for them.
 *   ender eyes      players who know endermen never look one in the face: a look that would land on an enderman's
 *                   head is lowered to its feet (see adjustLook, used by look.js).
 */

const { Vec3 } = require('vec3')

/** Next nodes form a straight, flat line ahead, at the bot's level, with nothing to dig or place. */
function straightFlat (path, pos, n = 4) {
  if (!path || path.length < n) return false
  const y = Math.floor(pos.y + 0.01)
  const nodes = path.slice(0, n)
  if (nodes.some((p) => Math.floor(p.y) !== y || (p.toBreak && p.toBreak.length) || (p.toPlace && p.toPlace.length))) return false
  const dir = { x: Math.sign(nodes[1].x - nodes[0].x), z: Math.sign(nodes[1].z - nodes[0].z) }
  if (!dir.x && !dir.z) return false
  for (let i = 1; i < nodes.length; i++) {
    if (Math.sign(nodes[i].x - nodes[i - 1].x) !== dir.x || Math.sign(nodes[i].z - nodes[i - 1].z) !== dir.z) return false
  }
  // heading roughly along the line (not about to turn)
  const tx = nodes.at(-1).x - pos.x
  const tz = nodes.at(-1).z - pos.z
  const len = Math.hypot(tx, tz)
  if (len < 3) return false
  const along = (tx * dir.x + tz * dir.z) / (len * Math.hypot(dir.x, dir.z))
  return along > 0.93
}

/** Nodes behind it now (flown over mid-jump): safe to drop. */
function passedNodes (path, pos) {
  let n = 0
  while (path.length - n > 1) {
    const a = path[n]
    const b = path[n + 1]
    if ((a.toBreak && a.toBreak.length) || (a.toPlace && a.toPlace.length)) break
    const dx = b.x - a.x
    const dz = b.z - a.z
    const len = Math.hypot(dx, dz) || 1
    const ahead = ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / len // how far past node a, along the path
    const side = Math.abs((pos.x - a.x) * dz - (pos.z - a.z) * dx) / len
    if (ahead > 0.2 && side < 0.6 && Math.abs(pos.y - a.y) < 2) n++
    else break
  }
  return n
}

function installMotion (bot, { canSprintJump = () => false } = {}) {
  if (bot._motion) return bot._motion
  let path = null
  let jumping = false
  bot.on('path_update', (r) => { path = r?.path || null })
  bot.on('goal_reached', () => { path = null })
  bot.on('path_reset', () => { path = null })
  bot.on('path_stop', () => { path = null })
  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e || !path || !path.length || !bot.pathfinder?.isMoving?.()) { jumping = false; return }
    if (!e.onGround) { // in the air: drop the nodes flown over, or the pathfinder turns back for them
      if (jumping) { const n = passedNodes(path, e.position); if (n) path.splice(0, n) }
      return
    }
    // On the ground: jump again if the next stretch is straight and flat. (The pathfinder sets jump itself every
    // tick, so there is nothing to release: when this says no, its own choice stands.)
    jumping = canSprintJump() && bot.getControlState('sprint') && bot.getControlState('forward') && !e.isInWater && !e.isInLava &&
      (bot.food ?? 20) > 6 && straightFlat(path, e.position) && headroom(bot, path)
    if (jumping) bot.setControlState('jump', true)
  })
  bot._motion = { straightFlat, passedNodes }
  return bot._motion
}

function headroom (bot, path) {
  for (const p of path.slice(0, 3)) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + 2, Math.floor(p.z)))
    if (b && b.boundingBox !== 'empty') return false
  }
  return true
}

/**
 * Would looking along (yaw, pitch) from eye meet an enderman's eyes? Then look at its feet instead.
 * Returns [yaw, pitch] (unchanged when it's safe).
 */
function adjustLook (bot, yaw, pitch) {
  const e = bot.entity
  if (!e) return [yaw, pitch]
  const eye = e.position.offset(0, e.eyeHeight ?? 1.62, 0)
  const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  for (const m of Object.values(bot.entities)) {
    if (m.name !== 'enderman' || !m.position) continue
    const head = m.position.offset(0, 2.55, 0)
    const to = head.minus(eye)
    const d = to.norm()
    if (d > 64 || d < 0.5) continue
    const dot = (to.x * dir.x + to.y * dir.y + to.z * dir.z) / d
    if (dot > 1 - 0.035 / d - 0.004) { // about Minecraft's own test, with a little margin
      const feet = m.position.minus(eye)
      return [yaw, Math.min(pitch, Math.atan2(feet.y, Math.hypot(feet.x, feet.z)))]
    }
  }
  return [yaw, pitch]
}

module.exports = { installMotion, straightFlat, passedNodes, adjustLook }
