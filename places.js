'use strict'

/**
 * places.js — where things are, the way a player keeps a mental map.
 *
 *   placed   blocks it put down itself (crafting tables, furnaces, beds, chests, scaffolding): before it walks off for
 *            good it picks the useful ones back up, like a player who doesn't leave a trail of crafting tables.
 *            Whether it remembers is decided when it places the block, by skill: beginners often forget theirs.
 *   home     where it lives (its bed, or its base): things placed there stay.
 *   deaths   where it died, so it can run back for its things before they despawn (5 minutes).
 *
 * Positions carry the dimension. Saved with the rest of the brain.
 */

const STATION = /^(crafting_table|furnace|smoker|blast_furnace|stonecutter|loom|smithing_table|cartography_table|grindstone|\w+_bed|chest|barrel)$/
const HOME_RADIUS = 32
const NEAR_FOR_RECLAIM = 24 // only things it is still close to: further away, it has already left them
const LEAVING = 32 // an action that ends this far from the block takes it away

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

class Places {
  /**
   * @param {object} data saved { placed, home, bed, deaths }
   * @param {() => number} rememberChance 0..1, how likely it is to remember a block it placed (from skill)
   */
  constructor (data = {}, rememberChance = () => 0.8) {
    this.placed = data.placed || [] // { x, y, z, dim, name, kind, at, remember }
    this.home = data.home || null // { x, y, z, dim, why }
    this.bed = data.bed || null
    this.deaths = data.deaths || [] // { x, y, z, dim, at, cause, recovered }
    this.sleptDay = data.sleptDay ?? null // the game day it last slept (phantoms come after three nights without)
    this.rememberChance = rememberChance
  }

  /** It put a block down. kind: station | scaffold | build | shelter | torch */
  onPlaced (pos, name, kind, dim) {
    const station = STATION.test(name)
    if (!station) return // dirt, cobble, torches: nobody goes back for those (and builds would crowd out the rest)
    const k = key(pos)
    this.placed = this.placed.filter((p) => !(key(p) === k && p.dim === dim))
    this.placed.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dim, name, kind: station && kind !== 'build' ? 'station' : kind, at: Date.now(), remember: Math.random() < this.rememberChance() })
    if (this.placed.length > 80) this.placed.splice(0, this.placed.length - 80)
  }

  /** It took a block back (or it's gone). */
  forget (pos, dim) {
    const k = key(pos)
    this.placed = this.placed.filter((p) => !(key(p) === k && p.dim === dim))
  }

  /** It slept in a bed: that's where it respawns, so that's home unless it set up somewhere else. */
  onSlept (pos, dim, day = null) {
    this.bed = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dim }
    if (Number.isFinite(day)) this.sleptDay = day
    if (!this.home || this.home.why === 'bed') this.home = { ...this.bed, why: 'bed' }
  }

  setHome (pos, dim, why = 'base') {
    this.home = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), dim, why }
  }

  isHome (pos, dim) {
    return Boolean(this.home && this.home.dim === dim && dist(this.home, pos) <= HOME_RADIUS)
  }

  onDeath (pos, dim, cause = '') {
    this.deaths.push({ x: pos.x, y: pos.y, z: pos.z, dim, at: Date.now(), cause: String(cause).slice(0, 120), recovered: false })
    if (this.deaths.length > 10) this.deaths.shift()
  }

  /** The last death whose items are still lying there (they despawn after 5 minutes), if worth a run. */
  freshDeath (dim, now = Date.now()) {
    const d = this.deaths.at(-1)
    if (!d || d.recovered || d.dim !== dim || now - d.at > 4 * 60000) return null
    if (/lava|void|fell out of the world|burned|blew up|explo/i.test(d.cause)) return null // nothing to get back
    return d
  }

  /**
   * Blocks it placed that are worth picking up before leaving: stations and beds it still remembers, not at home,
   * still standing (blockName(pos) says what's there now), not a furnace still cooking.
   */
  reclaimable (here, dim, { blockName, cooking = () => false, bases = [], now = Date.now() } = {}) {
    const out = []
    for (const p of this.placed) {
      if (p.dim !== dim || p.kind !== 'station' || !p.remember) continue
      if (dist(p, here) > NEAR_FOR_RECLAIM) continue
      if (this.isHome(p, dim) || bases.some((b) => dist(b, p) <= HOME_RADIUS)) continue
      if (p.triedAt && now - p.triedAt < 5 * 60000) continue // tried and failed a moment ago
      const now = blockName?.(p)
      if (now !== undefined && now !== null && now !== p.name && !(/_bed$/.test(p.name) && /_bed$/.test(now))) { this.forget(p, dim); continue }
      if (/furnace|smoker/.test(p.name) && cooking(p)) continue
      if (/^(chest|barrel)$/.test(p.name)) continue // holds things: emptying it is its own decision
      out.push(p)
    }
    return out.sort((a, b) => dist(a, here) - dist(b, here))
  }

  /** Will this action take it away from the spot (so placed things should come along first)? */
  leaving (action, here, { players = {} } = {}) {
    const { name, args = {} } = action || {}
    if (name === 'explore') return true
    if (name === 'moveToBlock' && [args.x, args.z].every(Number.isFinite)) return Math.hypot(args.x - here.x, args.z - here.z) > LEAVING
    if (name === 'moveToPlayer' || name === 'followPlayer') {
      const p = players[args.playerName]?.entity?.position
      return Boolean(p && dist(p, here) > LEAVING)
    }
    if (name === 'stripMine') return true
    return false
  }

  /** Lines for the prompt: home, bed, a fresh death, stations it has left around. */
  forPrompt (here, dim, where) {
    const out = []
    const at = (p) => where(p)
    if (this.home && this.home.dim === dim) out.push(`home (${this.home.why}): ${at(this.home)}`)
    if (this.bed && this.bed.dim === dim && (!this.home || key(this.bed) !== key(this.home))) out.push(`your bed: ${at(this.bed)}`)
    const d = this.freshDeath(dim)
    if (d) out.push(`you died ${Math.round((Date.now() - d.at) / 60000)} min ago ${at(d)}: your things are still there for a few minutes`)
    const stations = this.placed.filter((p) => p.dim === dim && p.kind === 'station' && p.remember && dist(p, here) <= 96).slice(-4)
    for (const s of stations) out.push(`your ${s.name.replace(/_/g, ' ')}: ${at(s)}`)
    return out
  }

  toJSON () {
    return { placed: this.placed, home: this.home, bed: this.bed, deaths: this.deaths, sleptDay: this.sleptDay }
  }
}

module.exports = { Places, STATION }
