'use strict'

/**
 * pointing.js — someone watching in the browser clicks or circles something on the bot's screen, and the bot
 * learns exactly what they meant: the blocks and creatures under the click or inside the circle.
 *
 * The browser only sends the camera it drew (eye position, yaw, pitch, field of view, aspect) and the click or the
 * outline in screen coordinates (-1..1, y up). Rays are cast through the bot's own copy of the world, so no image
 * recognition is needed: the world data already says what every pixel shows.
 *
 * Camera convention (three.js Euler 'ZYX' with z = 0, as prismarine-viewer sets it): world = Ry(yaw) · Rx(pitch) · v,
 * camera looking down -z. That matches Mineflayer's yaw/pitch (forward = (-sin yaw · cos pitch, sin pitch, -cos yaw · cos pitch)).
 */

const { Vec3 } = require('vec3')

/** Direction (unit vector) through a point on the screen. nx, ny in -1..1 (y up). */
function rayDir (cam, nx, ny) {
  const t = Math.tan((cam.fov * Math.PI / 180) / 2)
  let x = nx * t * (cam.aspect || 1)
  let y = ny * t
  let z = -1
  // Rx(pitch)
  const cp = Math.cos(cam.pitch)
  const sp = Math.sin(cam.pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp]
  // Ry(yaw)
  const cy = Math.cos(cam.yaw)
  const sy = Math.sin(cam.yaw);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy]
  const len = Math.hypot(x, y, z)
  return { x: x / len, y: y / len, z: z / len }
}

/** Where a world point lands on the screen ({ x, y } in -1..1, y up), or null if it is behind the camera. */
function project (cam, p) {
  let x = p.x - cam.pos.x
  let y = p.y - cam.pos.y
  let z = p.z - cam.pos.z
  // inverse yaw, then inverse pitch
  const cy = Math.cos(-cam.yaw)
  const sy = Math.sin(-cam.yaw);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy]
  const cp = Math.cos(-cam.pitch)
  const sp = Math.sin(-cam.pitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp]
  if (z >= -0.05) return null
  const t = Math.tan((cam.fov * Math.PI / 180) / 2)
  return { x: (x / -z) / (t * (cam.aspect || 1)), y: (y / -z) / t, depth: -z }
}

/** Point-in-polygon (even-odd rule). */
function inside (pt, poly) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) hit = !hit
  }
  return hit
}

/** Screen points to sample inside an outline: a grid over its bounding box, kept if inside, plus the centre. */
function samplePoints (poly, n = 9) {
  const xs = poly.map((p) => p.x)
  const ys = poly.map((p) => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const out = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = { x: x0 + (x1 - x0) * (i + 0.5) / n, y: y0 + (y1 - y0) * (j + 0.5) / n }
      if (inside(p, poly)) out.push(p)
    }
  }
  const c = { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length }
  if (inside(c, poly)) out.unshift(c)
  return out
}

/** Distance from a point to a ray (and how far along it). */
function rayDistance (origin, dir, p) {
  const v = { x: p.x - origin.x, y: p.y - origin.y, z: p.z - origin.z }
  const along = v.x * dir.x + v.y * dir.y + v.z * dir.z
  if (along < 0) return { off: Infinity, along }
  const off = Math.hypot(v.x - dir.x * along, v.y - dir.y * along, v.z - dir.z * along)
  return { off, along }
}

const RANGE = 96

/**
 * What the person pointed at. `shape` is { point: {x,y} } for a click or { outline: [{x,y}...] } for a circle.
 * Returns { kind, blocks: [{ name, pos, count }], entities: [{ id, name, label, pos, distance }] }.
 */
function resolvePointing (bot, cam, shape) {
  const origin = new Vec3(cam.pos.x, cam.pos.y, cam.pos.z)
  const circle = Array.isArray(shape.outline) && shape.outline.length >= 3
  const points = circle ? samplePoints(shape.outline) : [shape.point || { x: 0, y: 0 }]
  const blocks = new Map()
  let firstHit = null
  for (const p of points) {
    const d = rayDir(cam, p.x, p.y)
    let b = null
    try { b = bot.world.raycast(origin, new Vec3(d.x, d.y, d.z), RANGE) } catch { b = null }
    if (!b) continue
    const key = `${b.position.x},${b.position.y},${b.position.z}`
    if (!firstHit) firstHit = { block: b, dist: b.position.offset(0.5, 0.5, 0.5).distanceTo(origin) }
    const e = blocks.get(b.name) || { name: b.name, pos: b.position.clone(), count: 0, keys: new Set() }
    if (!e.keys.has(key)) { e.keys.add(key); e.count++ }
    if (b.position.distanceTo(origin) < e.pos.distanceTo(origin)) e.pos = b.position.clone() // keep the nearest one
    blocks.set(b.name, e)
  }

  // Creatures: inside the outline (and not hidden behind the wall the outline hit), or close to the click's ray.
  const entities = []
  const center = circle ? null : rayDir(cam, points[0].x, points[0].y)
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity || e.type === 'orb') continue
    const mid = e.position.offset(0, (e.height || 1) / 2, 0)
    const dist = mid.distanceTo(origin)
    if (dist > RANGE) continue
    let hit = false
    if (circle) {
      const s = project(cam, mid)
      hit = Boolean(s && inside(s, shape.outline))
    } else {
      const { off, along } = rayDistance(origin, center, mid)
      hit = off <= Math.max(0.6, (e.width || 0.6) / 2 + 0.35) + along * 0.01
    }
    if (!hit) continue
    if (!circle && firstHit && firstHit.dist + 0.5 < dist) continue // behind the block the click hit
    entities.push({ id: e.id, name: e.name || e.type, label: e.username || (e.name === 'item' ? itemName(e) : e.displayName || e.name), pos: e.position.clone(), distance: Math.round(dist) })
  }
  entities.sort((a, b) => a.distance - b.distance)
  const list = [...blocks.values()].map(({ name, pos, count }) => ({ name, pos, count })).sort((a, b) => b.count - a.count)
  return { kind: circle ? 'circle' : 'point', blocks: circle ? list : list.slice(0, 1), entities: circle ? entities.slice(0, 8) : entities.slice(0, 1) }
}

function itemName (e) {
  try { return `${e.getDroppedItem()?.name || 'item'} (dropped)` } catch { return 'dropped item' }
}

/**
 * Words for the bot: "the oak_log 6 blocks away (x 12, y 70, z -3)". Coordinates only if it can see them (F3),
 * otherwise "6 east, 2 up" like the rest of its world view.
 */
function describePointing (r, from, { coords = true } = {}) {
  const here = from
  const where = (p) => {
    const d = Math.round(p.distanceTo ? p.distanceTo(here) : 0)
    if (coords) return `${d} blocks away at ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`
    const dx = Math.floor(p.x) - Math.floor(here.x)
    const dy = Math.floor(p.y) - Math.floor(here.y)
    const dz = Math.floor(p.z) - Math.floor(here.z)
    const parts = []
    if (dx) parts.push(`${Math.abs(dx)} ${dx > 0 ? 'east' : 'west'}`)
    if (dz) parts.push(`${Math.abs(dz)} ${dz > 0 ? 'south' : 'north'}`)
    if (dy) parts.push(`${Math.abs(dy)} ${dy > 0 ? 'up' : 'down'}`)
    return `${d} blocks away (${parts.join(', ') || 'right here'} from you)`
  }
  const bits = []
  for (const e of r.entities) bits.push(`${e.label === e.name ? `a ${e.name}` : `${e.label}${/player/.test(e.name) ? '' : ` (${e.name})`}`} ${where(e.pos)}`)
  for (const b of r.blocks) bits.push(r.kind === 'circle' && b.count > 1 ? `${b.count} ${b.name} blocks, the nearest ${where(b.pos)}` : `the ${b.name} ${where(b.pos)}`)
  return bits.length ? bits.join('; ') : 'nothing (just the sky)'
}

module.exports = { rayDir, project, inside, samplePoints, resolvePointing, describePointing }
