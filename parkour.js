'use strict'

/**
 * parkour.js — real parkour: skill tiers, a jump finder, a jump executor and learning.
 *
 * "N-block jump" = the landing block is N blocks from the take-off block (N-1 air blocks between).
 * Vertical jumps: standing on a block and jumping forward to a block ONE higher (a jump only clears 1 block of
 * height). Tier field `upD` = the longest forward jump onto a higher block: simple 2, mediocre 2 (sometimes 3),
 * complicated 3, advanced sometimes 4, hardcore 4.
 *
 * Skill ladder (index = intelligence level, the `parkour` domain, so practice raises it):
 *   beginning   basic 1-gap walking jumps, sloppy timing
 *   simple      the same, cleaner, plus a 2-block jump onto a block one higher
 *   mediocre    2-3 block jumps, learns sprint jumps (almost always), 2-block (sometimes 3) jumps onto a higher block
 *   complicated up to 4 block jumps, up to 3 onto a higher block, learns ceiling hopping (when it spams it), timed sprint jumps
 *   advanced    sometimes 5 block jumps (with a drop), sometimes 4 onto a higher block, odd-height blocks (slabs, stairs, fences, soul sand...)
 *   hardcore    reliable on nearly everything, diagonals, momentum
 *   master      every standard jump players do
 *   impossible  angle-perfect boosts, speed potions, 6 block jumps
 */

const { Vec3 } = require('vec3')
const { ActionError } = require('./util')

const T = (o) => o
const TIERS = [
  /* 0 beginning    */ T({ walk: 2, sprint: 2, upD: 0, drop: 3, sprintRate: 0, momentum: 0, boost: 0, odd: 0, diag: 0, air: 0, timed: 0 }),
  /* 1 simple       */ T({ walk: 2, sprint: 2, upD: 2, drop: 3, sprintRate: 0, momentum: 0, boost: 0, odd: 0, diag: 0, air: 0, timed: 0 }),
  /* 2 mediocre     */ T({ walk: 2, sprint: 3, upD: 2.3, drop: 4, sprintRate: 0.9, momentum: 0, boost: 0, odd: 0, diag: 0, air: 1, timed: 0 }),
  /* 3 complicated  */ T({ walk: 2, sprint: 4, upD: 3, drop: 5, sprintRate: 0.97, momentum: 0.2, boost: 0, odd: 0, diag: 0, air: 1, timed: 1 }),
  /* 4 advanced     */ T({ walk: 2, sprint: 4.4, upD: 3.4, drop: 6, sprintRate: 1, momentum: 0.5, boost: 0, odd: 1, diag: 0, air: 1, timed: 1 }),
  /* 5 hardcore     */ T({ walk: 2, sprint: 5, upD: 4, drop: 6, sprintRate: 1, momentum: 0.6, boost: 0, odd: 1, diag: 1, air: 1, timed: 1 }),
  /* 6 master       */ T({ walk: 2, sprint: 5, upD: 4, drop: 8, sprintRate: 1, momentum: 0.8, boost: 0, odd: 1, diag: 1, air: 1, timed: 1 }),
  /* 7 impossible   */ T({ walk: 2, sprint: 6, upD: 4, drop: 8, sprintRate: 1, momentum: 0.8, boost: 0, odd: 1, diag: 1, air: 1, timed: 1 })
]
const TIER_NAMES = ['basic gap hops', 'clean 1-gap hops and 2-block jumps onto a higher block', '2-3 block sprint jumps', 'up to 4 block jumps, 3 onto a higher block, and ceiling hopping',
  'sometimes 5 block jumps and odd-height blocks', 'reliable parkour with diagonals', 'every standard jump', 'angle-perfect boosts and potions']

const hasSpeed = (bot) => Object.values(bot?.entity?.effects || {}).some((e) => /speed/i.test(String(e?.name || e?.id || '')) || e?.id === 1)
const HAZARDS = /lava|magma|fire|cactus|sweet_berry|powder_snow|campfire|wither_rose|pointed_dripstone|cobweb/
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

function heightOf (block) {
  if (!block || block.boundingBox !== 'block') return 0
  let h = 0
  for (const s of block.shapes || []) h = Math.max(h, s[4])
  return h || 1
}
const solid = (b) => Boolean(b) && b.boundingBox === 'block'
const free = (b) => !b || (b.boundingBox === 'empty' && !HAZARDS.test(b.name))

/** Chance (0..1) that tier `t` clears jump `j` if it tries (before reliability). */
function tierChance (t, j, opts = {}) {
  const { d, up = 0, drop = 0 } = j
  const sprintOK = opts.sprintOK !== false && t.sprint > t.walk
  const cap = sprintOK ? t.sprint : t.walk
  const fl = Math.floor(cap + 1e-9)
  const capC = d <= fl ? 1 : d <= fl + 1 ? cap - fl : 0
  // Measured on the real physics engine: flat sprint jump tops out at 4, a 1-block drop adds 1, a 1-block rise costs little for
  // sprint jumps but a lot for walking ones; walking jumps reach 3 flat.
  let reach = (sprintOK ? 4.0 : 3.0) + (drop >= 1 ? (sprintOK ? 1.0 : 0.5 * Math.min(drop, 2)) : 0) - up * (sprintOK ? 0.25 : 0.7)
  if (sprintOK && j.ceiling) reach += t.momentum // head-hitter momentum
  if (sprintOK && opts.potion) reach += 0.8 // Speed potion
  if (sprintOK && (j.runUp ?? 5) < 3) reach -= (3 - (j.runUp ?? 0)) * 0.4
  let c = capC * clamp(reach - d + 1)
  if (up > 0 && d >= 2) { // a forward jump onto a higher block: only 1 block of height is possible, and only so far forward
    const ufl = Math.floor(t.upD + 1e-9)
    c *= up > 1 ? 0 : d <= ufl ? 1 : d <= ufl + 1 ? t.upD - ufl : 0
  }
  if (sprintOK && d > 2) c *= t.sprintRate
  if (j.odd && !t.odd) c *= 0.15
  if (j.diag && !t.diag) c = 0
  if (drop > t.drop) c = 0
  return c
}

/** Reliability of execution from continuous skill (0..1) and habit (past successes of this kind). */
function reliability (skill, okCount = 0) {
  const base = 0.55 + 0.45 * Math.pow(skill, 0.8)
  return base + (1 - base) * 0.5 * (1 - Math.exp(-okCount / 10))
}

/** Timing of a sprint-jump: how far from the ideal take-off point it presses jump (blocks). */
function timingError (skill, tier) {
  const bias = tier.timed ? 0 : -0.45 * Math.pow(1 - skill, 0.8) // untimed jumpers go early
  return bias + gauss() * 0.5 * Math.pow(1 - skill, 1.2)
}

/** Block shape helpers over a bot's world (works with a mineflayer bot or any object with blockAt). */
function makeWorld (bot) {
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  return {
    at,
    floor: (x, y, z) => at(x, y - 1, z),
    standable (x, y, z) {
      return solid(this.floor(x, y, z)) && free(at(x, y, z)) && free(at(x, y + 1, z))
    },
    /** Ground within 3 blocks under (x,y-1), not hazardous: a missed jump costs no health. */
    safeBelow (x, y, z) {
      for (let dy = 2; dy <= 4; dy++) {
        const b = at(x, y - dy, z)
        if (b && HAZARDS.test(b.name)) return false
        if (solid(b) || (b && /water|bubble/.test(b.name))) return true
      }
      return false
    }
  }
}

/** All real gaps around the bot that it could jump: { from, to, dx, dz, k, d, up, drop, runUp, odd, diag }. */
function findJumps (bot, { radius = 7, diag = false, maxK = 6 } = {}) {
  const w = makeWorld(bot)
  const p = bot.entity.position
  const bx = Math.floor(p.x); const by = Math.floor(p.y); const bz = Math.floor(p.z)
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  if (diag) dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1])
  const out = []
  for (let x = bx - radius; x <= bx + radius; x++) {
    for (let z = bz - radius; z <= bz + radius; z++) {
      for (let y = by - 2; y <= by + 2; y++) {
        if (!w.standable(x, y, z)) continue
        for (const [dx, dz] of dirs) {
          if (w.floor(x + dx, y, z + dz) && solid(w.floor(x + dx, y, z + dz))) continue // not an edge
          if (!free(w.at(x + dx, y, z + dz)) || !free(w.at(x + dx, y + 1, z + dz))) continue
          let ok = true
          for (let k = 2; k <= maxK && ok; k++) {
            const gx = x + dx * (k - 1); const gz = z + dz * (k - 1)
            if (solid(w.floor(gx, y, gz)) || !free(w.at(gx, y, gz)) || !free(w.at(gx, y + 1, gz)) || !w.safeBelow(gx, y, gz)) { ok = false; break }
            const lx = x + dx * k; const lz = z + dz * k
            for (const dy of [0, 1, -1, -2]) {
              if (!w.standable(lx, y + dy, lz)) continue
              if (dy > 0 && !(free(w.at(gx, y + 2, gz)) && free(w.at(x, y + 2, z)))) continue
              let runUp = 0
              for (let r = 1; r <= 5; r++) { if (w.standable(x - dx * r, y, z - dz * r)) runUp = r; else break }
              const diagJ = dx !== 0 && dz !== 0
              const hFrom = heightOf(w.floor(x, y, z)); const hTo = heightOf(w.floor(lx, y + dy, lz))
              out.push({
                from: new Vec3(x, y, z), to: new Vec3(lx, y + dy, lz), dx, dz, k,
                d: diagJ ? k * Math.SQRT2 - 0.6 : k, up: Math.max(0, dy), drop: Math.max(0, -dy), runUp,
                odd: hFrom !== 1 || hTo !== 1, diag: diagJ
              })
              ok = false // first landing along this line
              break
            }
          }
        }
      }
    }
  }
  return out
}

/**
 * Do one jump for real: run up, press jump at the edge (timing depends on skill), steer in the air, land.
 * `info` = { skill, tier, sprint(bool) }. Resolves { ok, reason, landed }.
 */
async function runJump (bot, jump, info, { signal, tick } = {}) {
  const wait = tick || (() => bot.waitForTicks(1))
  const aborted = () => { if (signal?.aborted) throw new ActionError('ABORTED', 'Parkour was interrupted.') }
  const len = Math.hypot(jump.dx, jump.dz)
  const ux = jump.dx / len; const uz = jump.dz / len
  const cx = jump.from.x + 0.5; const cz = jump.from.z + 0.5
  const tx = jump.to.x + 0.5; const tz = jump.to.z + 0.5
  const yawTo = (px, pz) => Math.atan2(-(tx - px), -(tz - pz))
  // Sprint only when the gap needs it: short gaps (and jumps onto a higher block over 1 gap) are cleaner as walking jumps.
  const sprint = info.sprint && jump.d >= 3 && info.tier.sprint > info.tier.walk && (bot.food ?? 20) > 6
  const jumpAt = 0.5 + 0.12 + timingError(info.skill, info.tier) // centre of the block to the point it presses jump
  await bot.look(Math.atan2(-ux, -uz), 0, true)
  bot.setControlState('forward', true)
  bot.setControlState('sprint', sprint)
  let jumped = false; let air = 0; let result = null
  try {
    for (let t = 0; t < 120 && !result; t++) {
      aborted()
      await wait()
      const p = bot.entity.position
      const along = (p.x - cx) * ux + (p.z - cz) * uz
      if (!jumped) {
        if (along >= jumpAt && bot.entity.onGround) { bot.setControlState('jump', true); jumped = true } else if (along > 0.95 && bot.entity.onGround && p.y <= jump.from.y + 0.01) { /* ran off the edge: the fall decides */ jumped = true }
        continue
      }
      air++
      if (air === 2) bot.setControlState('jump', false)
      if (info.tier.air && !bot.entity.onGround) bot.look(yawTo(p.x, p.z) + (info.skill < 0.6 ? gauss() * 0.04 : 0), 0, true) // steer toward the landing
      const toLand = Math.hypot(tx - p.x, tz - p.z)
      if (info.tier.air && !bot.entity.onGround && toLand < 0.9 && info.skill > 0.5) { bot.setControlState('sprint', false); bot.setControlState('forward', false) } // don't overshoot a small platform
      if (air > 3 && bot.entity.onGround) {
        const lat = Math.abs((p.x - cx) * -uz + (p.z - cz) * ux)
        const need = Math.hypot(jump.to.x - jump.from.x, jump.to.z - jump.from.z) - 0.8
        const near = ((p.x - cx) * ux + (p.z - cz) * uz) >= need && lat <= 1.0 && Math.abs(p.y - jump.to.y) <= 0.7 // on the far platform, overshoot is fine
        result = { ok: near, reason: near ? 'landed' : 'landed short', landed: p.clone() }
      } else if (p.y < jump.to.y - 1.2 && p.y < jump.from.y - 1.2) {
        result = { ok: false, reason: 'fell', landed: p.clone() }
      }
    }
    return result || { ok: false, reason: 'timeout', landed: bot.entity.position.clone() }
  } finally {
    bot.setControlState('jump', false)
    bot.setControlState('sprint', false)
    bot.setControlState('forward', false)
  }
}

class ParkourSkill {
  /** @param {object} agent needs intelligence, bot (set later), log, config; @param {object} data persisted */
  constructor (agent, data = {}) {
    this.agent = agent
    this.data = { buckets: data.buckets || {}, ceilingHops: data.ceilingHops || 0, jumps: data.jumps || 0, falls: data.falls || 0 }
    this.pending = []
    this.active = null
    this.wasOnGround = true
    this.hopping = false
  }

  get intel () { return this.agent.intelligence }
  level () { return this.intel.level('parkour') }
  skill () { return this.intel.skill('parkour') }
  tierIndex () { return Math.min(7, Math.floor(this.level())) }
  tier () { return TIERS[this.tierIndex()] }
  describe () { return `${TIER_NAMES[this.tierIndex()]} (parkour ${this.level().toFixed(1)}/7)` }

  bucket (j) { return `${Math.round(j.d)}|${j.up}|${j.drop}` }

  /** Chance it clears this jump now, from tier, skill and past successes of the same kind. */
  chance (j, extra = {}) {
    const L = this.level(); const idx = Math.min(7, Math.floor(L)); const f = L - idx
    const sprintOK = (this.agent.bot?.food ?? 20) > 6
    const o = { sprintOK, potion: hasSpeed(this.agent.bot), ...extra }
    const c = (1 - f) * tierChance(TIERS[idx], j, o) + f * tierChance(TIERS[Math.min(7, idx + 1)], j, o)
    return c * reliability(this.skill(), this.data.buckets[this.bucket(j)]?.ok || 0)
  }

  jumpsHere (bot, radius = 7) {
    return findJumps(bot, { radius, diag: this.tier().diag > 0 })
      .map((j) => ({ ...j, chance: this.chance(j) }))
  }

  /** XP: a little for easy successes, more for hard ones, most for failing at something hard. */
  record (j, ok, source = 'practice') {
    const key = this.bucket(j)
    const b = (this.data.buckets[key] = this.data.buckets[key] || { n: 0, ok: 0 })
    const hard = this.chance(j) < 0.8
    b.n++
    if (ok) b.ok++
    this.data.jumps++
    const xp = ok ? (hard ? 0.45 : 0.15) : (hard ? 0.8 : 0.2)
    this.intel.addXp('parkour', xp)
    this.agent.learning?.markDirty?.()
    this.agent.log?.debug?.(`parkour ${source}: ${key} ${ok ? 'ok' : 'failed'} (+${xp} xp, level ${this.level().toFixed(2)})`)
  }

  /** Limit the pathfinder's jumps to what this player can do, and price in the risk. */
  attach (movements, bot) {
    this.bot = bot
    const orig = movements.getMoveParkourForward.bind(movements)
    const self = this
    movements.getMoveParkourForward = function (node, dir, neighbors) {
      const tmp = []
      orig(node, dir, tmp)
      for (const m of tmp) {
        const dxm = m.x - node.x; const dzm = m.z - node.z
        const d = Math.max(Math.abs(dxm), Math.abs(dzm)); const dy = m.y - node.y
        const hFrom = movements.getBlock(node, 0, -1, 0).height; const hTo = movements.getBlock(m, 0, -1, 0).height
        const j = { d, up: Math.max(0, dy), drop: Math.max(0, -dy), runUp: 3, odd: hFrom !== 1 || hTo !== 1 }
        const c = self.chance(j)
        if (c < 0.5) continue
        m.cost += (1 - c) * 12
        m.parkourJump = j
        neighbors.push(m)
      }
    }
    // Pathfinder jumps teach it too: watch take-offs and landings.
    bot.on('path_update', (r) => { this.pending = this.collect(r?.path || [], bot) })
    bot.on('physicsTick', () => { try { this.tick(bot) } catch { /* never break movement */ } })
    this.refresh(movements)
  }

  collect (path, bot) {
    const out = []
    let prev = bot.entity.position.floored()
    for (const m of path) {
      if (m.parkour) {
        out.push({ start: prev.clone(), to: new Vec3(m.x, m.y, m.z), j: m.parkourJump || { d: Math.max(Math.abs(m.x - prev.x), Math.abs(m.z - prev.z)), up: Math.max(0, m.y - prev.y), drop: Math.max(0, prev.y - m.y), odd: false } })
      }
      prev = new Vec3(m.x, m.y, m.z)
    }
    return out
  }

  /** Hook for skill-dependent movement switches (none at the moment: jump limits live in the wrapper above). */
  refresh () {}

  tick (bot) {
    const e = bot.entity
    if (!e) return
    const onGround = e.onGround
    if (this.wasOnGround && !onGround && !this.active && this.pending.length) {
      const i = this.pending.findIndex((m) => Math.hypot(e.position.x - (m.start.x + 0.5), e.position.z - (m.start.z + 0.5)) < 1.7 && Math.abs(e.position.y - m.start.y) < 1.2)
      if (i >= 0) this.active = { m: this.pending[i], at: Date.now(), air: 0 }
    }
    if (this.active) {
      const a = this.active
      a.air++
      const { to, j } = a.m
      const near = Math.hypot(e.position.x - (to.x + 0.5), e.position.z - (to.z + 0.5)) <= 1.3 && Math.abs(e.position.y - to.y) <= 0.8
      if (onGround && a.air > 3) { this.record(j, near, 'path'); this.active = null } else if (e.position.y < to.y - 2.5 || Date.now() - a.at > 4000) { this.record(j, false, 'path'); this.data.falls++; this.active = null }
    }
    this.wasOnGround = onGround
    this.ceilingHop(bot)
  }

  /** Hop under low ceilings while running: faster than plain sprinting. Learned by spamming it. */
  ceilingHop (bot) {
    const c = bot.controlState
    const e = bot.entity
    const can = this.tierIndex() >= 3 && c.forward && c.sprint && e.onGround && bot.pathfinder?.goal && !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.()
    let under = false
    if (can) {
      const x = Math.floor(e.position.x); const y = Math.floor(e.position.y); const z = Math.floor(e.position.z)
      const ahead = new Vec3(x + Math.round(-Math.sin(e.yaw)), y + 2, z + Math.round(-Math.cos(e.yaw)))
      under = solid(bot.blockAt(new Vec3(x, y + 2, z))) && solid(bot.blockAt(ahead)) && free(bot.blockAt(new Vec3(x, y + 1, z)))
    }
    if (under) {
      if (!this.hopping) this.hopping = this.data.ceilingHops >= 30 || Math.random() < 0.35 // it experiments until it has learned that it works
      if (this.hopping) { bot.setControlState('jump', true); this.data.ceilingHops++ }
    } else if (this.hopping) {
      this.hopping = false
      bot.setControlState('jump', false)
    }
  }

  /**
   * Practice real jumps nearby (an action): pick a gap it might just manage, run up and jump.
   * `goto(pos)` walks to a spot (supplied by actions.js).
   */
  async practice (ctx, { goto, seconds = 20, maxJumps = 3 } = {}) {
    const bot = ctx.bot
    const end = Date.now() + seconds * 1000
    if (bot.health < 12) throw new ActionError('TOO_HURT', 'Too hurt to practice parkour.')
    const log = []
    for (let n = 0; n < maxJumps && Date.now() < end; n++) {
      const cands = this.jumpsHere(bot).filter((j) => j.chance >= 0.2 && j.safe !== false)
      if (!cands.length) {
        if (!n) throw new ActionError('NO_GAPS', 'There is no gap here to jump across.')
        break
      }
      cands.sort((a, b) => Math.abs(a.chance - 0.65) - Math.abs(b.chance - 0.65) + (Math.random() - 0.5) * 0.3)
      const j = cands[0]
      const need = Math.min(j.runUp, j.d >= 3 ? 5 : 2)
      const start = new Vec3(j.from.x - Math.sign(j.dx) * need, j.from.y, j.from.z - Math.sign(j.dz) * need)
      if (goto) await goto(start.offset(0.5, 0, 0.5))
      const r = await runJump(bot, j, { skill: this.skill(), tier: this.tier(), sprint: j.d > 2 || this.tierIndex() >= 2 }, { signal: ctx.signal })
      this.record(j, r.ok)
      log.push(`${j.k}-block${j.up ? ` +${j.up}` : ''}${j.drop ? ` -${j.drop}` : ''} jump: ${r.reason}`)
      if (!r.ok && goto) await goto(j.from.offset(0.5, 0, 0.5)).catch(() => {})
    }
    return log.length ? `Practiced parkour: ${log.join('; ')}. Level now ${this.level().toFixed(1)}.` : 'No jumps done.'
  }

  toJSON () { return this.data }
}

module.exports = { ParkourSkill, TIERS, tierChance, reliability, findJumps, runJump, makeWorld, timingError }
