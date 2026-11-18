'use strict'

/**
 * reach.js — what a player can actually click. A block counts only if the crosshair can land on it: a straight line
 * from the eyes to a point on one of its faces, with nothing in between that the crosshair would hit first (leaves,
 * glass, another block). Used before placing, opening, using and mining, so the bot never builds through a tree or
 * opens a chest behind a wall.
 *
 *   clickableFace(bot, block, { reach, normal }) → { normal, point, distance } or null
 *   obstacle(bot, block)                         → the block in the way of its nearest face, or null
 */

const { Vec3 } = require('vec3')

const NORMALS = [new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
// prismarine-world BlockFace numbers → outward normals
const FACE_NORMAL = { 0: new Vec3(0, -1, 0), 1: new Vec3(0, 1, 0), 2: new Vec3(0, 0, -1), 3: new Vec3(0, 0, 1), 4: new Vec3(-1, 0, 0), 5: new Vec3(1, 0, 0) }

const eyeOf = (bot) => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)

/** Points on a face, centre first, then towards its corners (a face half hidden behind a leaf still counts). */
function facePoints (pos, n) {
  const c = pos.offset(0.5 + n.x * 0.5, 0.5 + n.y * 0.5, 0.5 + n.z * 0.5)
  const [u, v] = n.y ? [new Vec3(1, 0, 0), new Vec3(0, 0, 1)] : n.x ? [new Vec3(0, 1, 0), new Vec3(0, 0, 1)] : [new Vec3(1, 0, 0), new Vec3(0, 1, 0)]
  const out = [c]
  for (const [a, b] of [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) out.push(c.plus(u.scaled(a)).plus(v.scaled(b)))
  return out
}

/** Cast the crosshair at a point: the block it lands on (or null). */
function aim (bot, eye, point) {
  const d = point.minus(eye)
  const dist = d.norm()
  if (dist < 1e-3) return null
  // A little past the point: lower blocks (beds, chests, slabs, carpets) sit below the full-cube face we aim at. Only a
  // hit on the block itself counts, so running on can't turn a miss into a click.
  try { return bot.world.raycast(eye, d.scaled(1 / dist), dist + 0.6) } catch { return null }
}

/**
 * The face of `block` the bot can click from where it stands, nearest first. `normal` limits it to one face (placing
 * against a block means clicking the face that points at the new spot). Partial blocks (slabs, chests) are hit by
 * their real shape, so any face the ray lands on counts.
 */
function clickableFace (bot, block, { reach = 4.5, normal = null } = {}) {
  if (!bot.entity || !block) return null
  const eye = eyeOf(bot)
  const pos = block.position
  let best = null
  for (const n of normal ? [normal] : NORMALS) {
    const centre = pos.offset(0.5 + n.x * 0.5, 0.5 + n.y * 0.5, 0.5 + n.z * 0.5)
    if (eye.minus(centre).dot(n) <= 0.01) continue // facing away: can't see that side
    for (const p of facePoints(pos, n)) {
      const distance = eye.distanceTo(p)
      if (distance > reach || (best && distance >= best.distance)) continue
      const hit = aim(bot, eye, p)
      if (!hit || !hit.position.equals(pos)) continue
      const hn = FACE_NORMAL[hit.face]
      if (normal && hn && !hn.equals(normal)) continue
      best = { normal: hn || n, point: hit.intersect || p, distance }
      break
    }
  }
  return best
}

/** What's in the way of the block's nearest face: the first thing the crosshair would hit instead. */
function obstacle (bot, block) {
  if (!bot.entity || !block) return null
  const eye = eyeOf(bot)
  let best = null
  for (const n of NORMALS) {
    const centre = block.position.offset(0.5 + n.x * 0.5, 0.5 + n.y * 0.5, 0.5 + n.z * 0.5)
    if (eye.minus(centre).dot(n) <= 0.01) continue
    const d = eye.distanceTo(centre)
    if (best && d >= best.d) continue
    const hit = aim(bot, eye, centre)
    if (hit && !hit.position.equals(block.position)) best = { d, block: hit }
  }
  return best?.block || null
}

module.exports = { clickableFace, obstacle, facePoints, FACE_NORMAL }
