'use strict'

/**
 * senses.js — what the bot can actually see and hear.
 *
 * Sight: an entity is perceived only if there's a line of sight to it (glass,
 * leaves and bars don't block), or it's right next to the bot. Invisible
 * entities are hidden unless their armor/held item shows, their potion swirls
 * are visible close in front of the bot, or they're bumping into it.
 * Lower intelligence notices less at the edges; Impossible tracks every entity
 * the server sends, through walls.
 *
 * Hearing: every sound the server sends (≈16 blocks, through walls) is
 * classified — mob noises, footsteps, chests and doors, mining, combat, the
 * creeper hiss — and checked against what the bot can see. A sound with no
 * visible source is "unexplained". Unexplained player-ish sounds (footsteps,
 * a chest opening, blocks breaking) make the bot suspicious; knowing other
 * players are around makes that much less likely. Past a threshold it goes
 * to investigate.
 *
 * Particles: world particles close by and roughly in front of the bot (and in
 * line of sight) are noticed: someone's crits, block-breaking dust, smoke,
 * portal particles, hearts...
 */

const { Vec3 } = require('vec3')

/** Ways of perceiving that count as actually seeing something. */
const SEEN = new Set(['sight', 'close', 'armor', 'swirls', 'tracked', 'tracked (invisible)'])

const SEE_THROUGH = /glass|leaves|iron_bars|fence|chain|ladder|vine|scaffolding|trapdoor|door|torch|flower|grass|fern|sapling|carpet|snow$|rail|pane/

const an = (thing) => { const t = thing.replace(/_/g, ' '); return `${/^[aeiou]/.test(t) ? 'an' : 'a'} ${t}` }

/** Sound name → { kind, who, weight (suspicion), text } */
function classifySound (name) {
  const n = String(name).replace(/^minecraft:/, '')
  if (/^(ambient|music|weather|block\.(water|lava|fire|portal|bubble|campfire|furnace|beacon|conduit|respawn_anchor)|entity\.(generic\.splash|item\.pickup|experience_orb)|ui\.)/.test(n)) return { kind: 'ambient' }
  if (n === 'entity.creeper.primed') return { kind: 'danger', who: 'creeper', weight: 0, text: 'a creeper hissing' }
  if (/^entity\.tnt\.primed/.test(n)) return { kind: 'danger', who: 'tnt', weight: 0.5, text: 'TNT fizzing' }
  if (/^entity\.player\./.test(n)) return { kind: 'player', who: 'player', weight: 0.8, text: `a player (${n.split('.').slice(2).join(' ')})` }
  if (/^block\.(\w+)\.step$/.test(n)) return { kind: 'steps', who: 'player or mob', weight: 0.6, text: 'footsteps' }
  if (/^block\.(chest|barrel|ender_chest|shulker_box|\w+_shulker_box|trapped_chest)\.(open|close)/.test(n)) return { kind: 'container', who: 'player', weight: 1.2, text: `${an(n.split('.')[1])} ${n.endsWith('open') ? 'opening' : 'closing'}` }
  if (/^block\.(\w+_door|\w+_trapdoor|\w+_fence_gate)\.(open|close)/.test(n)) return { kind: 'door', who: 'player', weight: 0.9, text: `${an(n.split('.')[1])} ${n.endsWith('open') ? 'opening' : 'closing'}` }
  if (/^block\.(\w+)\.break$/.test(n)) return { kind: 'mining', who: 'player', weight: 0.8, text: `${n.split('.')[1].replace(/_/g, ' ')} being broken` }
  if (/^block\.(\w+)\.place$/.test(n)) return { kind: 'placing', who: 'player', weight: 0.7, text: `${n.split('.')[1].replace(/_/g, ' ')} being placed` }
  if (/^(entity\.arrow\.shoot|item\.crossbow\.shoot|entity\.player\.attack|item\.shield\.block|entity\.snowball\.throw|entity\.ender_pearl\.throw|item\.trident\.throw|entity\.wind_charge)/.test(n)) return { kind: 'combat', who: 'player', weight: 1, text: n.replace(/\./g, ' ') }
  if (/^entity\.generic\.(explode|eat|drink)|^entity\.(lightning|firework)/.test(n)) return { kind: 'event', who: '?', weight: 0.4, text: n.split('.').slice(1).join(' ') }
  const mob = n.match(/^entity\.([a-z_]+)\./)
  if (mob) return { kind: 'mob', who: mob[1], weight: 0, text: an(mob[1]) }
  if (/^block\.(note_block|bell|lever|button|\w+_button|\w+_pressure_plate|dispenser|piston|anvil|enchantment_table|grindstone|smithing_table|crafter)/.test(n)) return { kind: 'device', who: 'player', weight: 0.8, text: n.split('.')[1].replace(/_/g, ' ') }
  return { kind: 'other', weight: 0 }
}

const NOTABLE_PARTICLES = {
  crit: 'critical-hit sparks (someone fighting)', enchanted_hit: 'enchanted hit sparks', damage_indicator: 'damage particles', sweep_attack: 'a sword sweep',
  block: 'block-breaking dust (someone mining?)', smoke: 'smoke', large_smoke: 'thick smoke', campfire_cosy_smoke: 'campfire smoke', campfire_signal_smoke: 'signal smoke',
  portal: 'portal particles', reverse_portal: 'crying obsidian particles', heart: 'hearts (animals breeding)', angry_villager: 'an angry villager',
  happy_villager: 'green sparkles (bone meal or trading)', explosion: 'an explosion', explosion_emitter: 'a big explosion', flame: 'flames', soul_fire_flame: 'soul fire',
  witch: 'witch magic', effect: 'potion effect swirls', entity_effect: 'potion effect swirls', instant_effect: 'a splash potion', note: 'music notes', totem_of_undying: 'a totem popping',
  dragon_breath: 'dragon breath', sonic_boom: 'a warden sonic boom', sculk_charge: 'sculk spreading', trial_spawner_detection: 'a trial spawner waking up', gust: 'a wind gust'
}

/** World event ids (vanilla LevelEvent) worth noticing. */
const WORLD_EVENTS = {
  2001: { kind: 'mining', who: 'player', weight: 0.8, text: 'a block being broken' },
  2002: { kind: 'combat', who: 'player', weight: 0.9, text: 'a splash potion shattering' },
  2007: { kind: 'combat', who: 'player', weight: 0.9, text: 'a splash potion shattering' },
  2004: { kind: 'event', who: 'spawner', weight: 0.2, text: 'a mob spawner spawning something' },
  1030: { kind: 'device', who: 'player', weight: 0.9, text: 'an anvil being used' },
  1042: { kind: 'device', who: 'player', weight: 0.8, text: 'a grindstone being used' },
  1044: { kind: 'device', who: 'player', weight: 0.8, text: 'a smithing table being used' },
  1043: { kind: 'device', who: 'player', weight: 0.6, text: 'a book page turning' },
  1003: { kind: 'event', who: 'player', weight: 0.9, text: 'an eye of ender being thrown' },
  1503: { kind: 'event', who: 'player', weight: 1, text: 'an eye of ender going into an end portal frame' },
  1019: { kind: 'mob', who: 'zombie', weight: 0, text: 'a zombie bashing a door' },
  1021: { kind: 'mob', who: 'zombie', weight: 0, text: 'a zombie breaking a door down' },
  1015: { kind: 'mob', who: 'ghast', weight: 0, text: 'a ghast about to shoot' },
  1018: { kind: 'mob', who: 'blaze', weight: 0, text: 'a blaze shooting' },
  1023: { kind: 'event', global: true, text: 'a wither being spawned' },
  1028: { kind: 'event', global: true, text: 'the ender dragon dying' },
  1038: { kind: 'event', global: true, text: 'an end portal opening' }
}

class Senses {
  constructor (agent) {
    this.agent = agent
    this.heard = [] // { at, name, kind, text, pos, source, explained }
    this.seen = [] // particles: { at, name, text, pos, explained }
    this.lastSeen = new Map() // entity id -> { at, pos, name } (memory after losing sight)
    this.suspicion = 0
    this.suspicionAt = Date.now()
    this.lastInvestigateAt = 0
    this.perceivedCache = { at: 0, list: [] }
  }

  get cfg () { return this.agent.config.senses }
  get intel () { return this.agent.intelligence }

  attach (bot) {
    bot.on('soundEffectHeard', (name, pos, volume) => this.onSound(bot, name, pos, volume))
    bot.on('hardcodedSoundEffectHeard', (id, category, pos, volume) => {
      const name = bot.registry.sounds?.[id]?.name
      if (name) this.onSound(bot, name, pos, volume)
    })
    bot.on('particle', (p) => this.onParticle(bot, p))
    // Block breaking, splash potions, spawners, anvils, door-bashing zombies and world-wide
    // events arrive as "world events", not sounds. Mineflayer doesn't surface them.
    bot._client.on('world_event', (pk) => this.onWorldEvent(bot, pk))
    // Cracks spreading on a block = someone mining it. That's visual: only if we can see the block.
    bot.on('blockBreakProgressObserved', (block, stage, entity) => {
      if (!this.cfg.particles || !bot.entity || stage !== 1 || !block?.position) return
      const center = block.position.offset(0.5, 0.5, 0.5)
      if (center.distanceTo(bot.entity.position) > 20 || !this.canSee(bot, center)) return
      const miner = entity && this.perceive(bot, 48).some((p) => p.entity === entity && SEEN.has(p.how))
      const entry = { at: Date.now(), name: 'cracks', text: `cracks spreading on ${block.name.replace(/_/g, ' ')} (someone mining)`, pos: block.position, source: miner ? entity.username || entity.name : null, explained: Boolean(miner) }
      this.seen.push(entry)
      if (this.seen.length > 30) this.seen.shift()
      if (!miner) this.raiseSuspicion(bot, 0.9, { ...entry, kind: 'particles' })
    })
  }

  onWorldEvent (bot, pk) {
    const pos = pk.location && new Vec3(pk.location.x, pk.location.y, pk.location.z)
    const ev = WORLD_EVENTS[pk.effectId]
    if (!ev || !pos) return
    if (pk.global || ev.global) {
      // Heard from anywhere in the world (wither spawning, the dragon dying, an end portal opening).
      this.agent.memory.addEvent('world', `You heard ${ev.text} somewhere in the world${this.intel.can('soundTracking', 'senses') ? ` (direction: towards ${pos.x}, ${pos.z})` : ''}.`)
      return
    }
    const name = ev.kind === 'mining' ? bot.registry.blocksByStateId?.[pk.data]?.name : null
    this.onSound(bot, `world_event.${ev.kind}`, pos.offset(0.5, 0.5, 0.5), 1, { ...ev, text: name ? `${name.replace(/_/g, ' ')} being broken` : ev.text })
  }

  // ---------------------------------------------------------------------------
  // Sight
  // ---------------------------------------------------------------------------

  /** Line of sight from the bot's eyes to a point (glass/leaves don't block). */
  canSee (bot, target) {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0)
    const delta = target.minus(eye)
    const dist = delta.norm()
    if (dist < 0.5) return true
    try {
      const hit = bot.world.raycast(eye, delta.normalize(), dist, (b) => b.boundingBox === 'block' && !SEE_THROUGH.test(b.name))
      return !hit
    } catch {
      return true
    }
  }

  /** Angle (radians) between where the bot looks and a point. */
  angleTo (bot, target) {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const d = target.minus(eye)
    const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
    const look = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    const len = d.norm() || 1
    return Math.acos(Math.max(-1, Math.min(1, (look.x * d.x + look.y * d.y + look.z * d.z) / len)))
  }

  isInvisible (entity) {
    return Boolean((entity.metadata?.[0] ?? 0) & 0x20)
  }

  /** Visible potion swirls (entity effect particles in metadata). */
  hasSwirls (bot, entity) {
    const keys = bot.registry.entitiesByName?.[entity.name]?.metadataKeys
    if (!keys) return false
    for (const key of ['effect_particles', 'effect_color', 'potion_color']) {
      const i = keys.indexOf(key)
      if (i < 0) continue
      const v = entity.metadata?.[i]
      if (Array.isArray(v) ? v.length > 0 : Boolean(v)) return true
    }
    return false
  }

  /**
   * Entities the bot actually perceives, each with how it knows:
   * 'sight', 'close', 'armor' (invisible but armor shows), 'swirls', 'heard', 'tracked' (impossible: through walls), 'memory'.
   */
  perceive (bot, radius) {
    if (Date.now() - this.perceivedCache.at < 400) return this.perceivedCache.list
    const me = bot.entity.position
    const realistic = this.cfg.realisticSight
    const throughWalls = this.intel.can('seeThroughWalls', 'senses')
    const attention = this.intel.attention()
    const out = []
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue
      const d = e.position.distanceTo(me)
      if (d > radius) continue
      const head = e.position.offset(0, (e.height || 1) * 0.85, 0)
      let how = null
      const invisible = this.isInvisible(e)
      if (!realistic || throughWalls) how = invisible ? 'tracked (invisible)' : 'tracked'
      else if (d <= 1.6) how = 'close'
      else if (invisible) {
        const gear = (e.equipment || []).some((x) => x && x.name)
        const inFront = d <= 8 && this.angleTo(bot, head) < 0.6
        if (gear && this.canSee(bot, head)) how = 'armor'
        else if (inFront && this.hasSwirls(bot, e) && this.canSee(bot, head)) how = 'swirls'
      } else if (d <= 3 || this.canSee(bot, head) || this.canSee(bot, e.position.offset(0, 0.2, 0))) {
        // Things far away at the edge of attention can go unnoticed by weaker players.
        how = d < 12 || Math.random() < attention + 0.3 ? 'sight' : null
      }
      if (!how && this.intel.can('soundTracking', 'senses')) {
        // Good players can place an unseen entity by its sounds.
        const sound = this.heard.find((h) => h.sourceId === e.id && Date.now() - h.at < 8000)
        if (sound) how = 'heard'
      }
      if (how) {
        this.lastSeen.set(e.id, { at: Date.now(), pos: e.position.clone(), name: e.username || e.name })
        out.push({ entity: e, how, invisible })
      }
    }
    // Things we lost sight of a moment ago: remembered position.
    for (const [id, m] of this.lastSeen) {
      if (Date.now() - m.at > 20000) { this.lastSeen.delete(id); continue }
      if (!out.some((o) => o.entity.id === id) && bot.entities[id]) out.push({ entity: bot.entities[id], how: 'memory', lastPos: m.pos, lastAt: m.at })
    }
    this.perceivedCache = { at: Date.now(), list: out }
    return out
  }

  // ---------------------------------------------------------------------------
  // Hearing
  // ---------------------------------------------------------------------------

  onSound (bot, name, pos, volume, preset) {
    if (!this.cfg.hearing || !bot.entity || !pos) return
    const c = preset || classifySound(name)
    if (c.kind === 'ambient' || c.kind === 'other') return
    const me = bot.entity.position
    const dist = pos.distanceTo(me)
    if (dist < 1.2) return // our own noise
    if (dist > 16 * Math.max(1, volume || 1) + 4) return
    // Weaker players don't notice every little sound (except the important ones).
    if (c.kind !== 'danger' && Math.random() > this.intel.attention() + (c.kind === 'container' ? 0.2 : 0)) return

    // Who made it? Anything within a couple of blocks of the sound's position.
    const radius = c.kind === 'container' || c.kind === 'door' ? 5 : 3
    const source = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && (e.type === 'player' || /mobs/.test(e.kind || '')) && e.position.distanceTo(pos) <= radius)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0] || null
    const visible = source && this.perceive(bot, 48).some((p) => p.entity === source && SEEN.has(p.how))
    const explained = Boolean(source && (visible || c.kind === 'mob'))
    const entry = { at: Date.now(), name, kind: c.kind, text: c.text, pos: pos.floored(), sourceId: source?.id, source: explained ? source.username || source.name : null, explained, dist: Math.round(dist) }
    this.heard.push(entry)
    if (this.heard.length > 40) this.heard.shift()

    if (c.kind === 'container' && source?.type === 'player') this.agent.containers?.onOpenedBy(pos.floored(), source.username)
    if (c.kind === 'danger' && c.who === 'creeper' && dist < 7) this.agent.creeperAlert = { pos: pos.clone(), at: Date.now(), id: source?.id }
    if (!explained && c.weight > 0) this.raiseSuspicion(bot, c.weight, entry)
  }

  // ---------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------

  onParticle (bot, p) {
    if (!this.cfg.particles || !bot.entity || !p?.position) return
    const text = NOTABLE_PARTICLES[p.name]
    if (!text) return
    const d = p.position.distanceTo(bot.entity.position)
    // Only close by and roughly in front — like noticing something out of the corner of your eye.
    if (d > this.cfg.particleRange || this.angleTo(bot, p.position) > (d < 4 ? 1.2 : 0.8)) return
    if (Math.random() > this.intel.attention() + 0.1) return
    if (!this.canSee(bot, p.position)) return
    const last = this.seen[this.seen.length - 1]
    if (last && last.name === p.name && Date.now() - last.at < 1500 && last.pos.distanceTo(p.position) < 2) return // same burst
    const near = this.perceive(bot, 32).find((x) => SEEN.has(x.how) && x.entity.position.distanceTo(p.position) < 3)
    const entry = { at: Date.now(), name: p.name, text, pos: p.position.floored(), source: near ? near.entity.username || near.entity.name : null, explained: Boolean(near) }
    this.seen.push(entry)
    if (this.seen.length > 30) this.seen.shift()
    const playerish = /crit|enchanted_hit|sweep|block|instant_effect|effect/.test(p.name)
    if (!entry.explained && playerish) this.raiseSuspicion(bot, 0.6, { ...entry, kind: 'particles' })
  }

  // ---------------------------------------------------------------------------
  // Suspicion
  // ---------------------------------------------------------------------------

  /** Other players around make strange noises much less strange. */
  othersFactor (bot) {
    const others = Object.keys(bot.players).filter((n) => n !== bot.username)
    if (!others.length) return 1.4 // nobody else is even online — very odd
    const nearby = this.perceive(bot, 32).some((p) => p.entity.type === 'player' && (SEEN.has(p.how) || p.how === 'memory'))
    return nearby ? 0.15 : 0.5
  }

  raiseSuspicion (bot, weight, entry) {
    this.decay()
    const add = weight * this.othersFactor(bot) * (0.6 + 0.6 * this.intel.attention())
    this.suspicion = Math.min(3, this.suspicion + add)
    this.lastClue = entry
    if (this.suspicion >= this.cfg.suspicionThreshold && Date.now() - this.lastInvestigateAt > 45000 && entry.pos) {
      this.lastInvestigateAt = Date.now()
      this.agent.investigation = { pos: entry.pos, reason: `${entry.text}${entry.kind === 'particles' ? ' with nobody there' : ' and you can\'t see who'}`, at: Date.now() }
      this.agent.memory.addEvent('suspicious', `You noticed ${entry.text} at (${entry.pos.x}, ${entry.pos.y}, ${entry.pos.z}) and can't see anyone there. Something's off.`)
      this.agent.emotions.stimulate({ fear: 0.12, surprise: 0.15 }, `you heard ${entry.text} with nobody around`)
      this.agent.brain?.wake()
    }
  }

  decay () {
    const dt = (Date.now() - this.suspicionAt) / 1000
    this.suspicionAt = Date.now()
    this.suspicion = Math.max(0, this.suspicion - dt * 0.05)
  }

  /** For the decision prompt. */
  summary () {
    this.decay()
    const recent = (list, ms) => list.filter((x) => Date.now() - x.at < ms)
    const fmt = (h) => `${h.text} ${h.dist !== undefined ? `${h.dist}m away ` : ''}at (${h.pos.x}, ${h.pos.y}, ${h.pos.z})${h.explained && h.source ? ` — ${h.source}` : ' — source unseen'}`
    // Collapse repeats ("footsteps" ×6 → one line).
    const uniq = (items) => {
      const seen = new Map()
      for (const h of items) seen.set(`${h.text}|${h.explained ? h.source : '?'}`, h)
      return [...seen.values()]
    }
    return {
      heard: uniq(recent(this.heard, 20000)).slice(-6).map(fmt),
      noticed: uniq(recent(this.seen, 15000)).slice(-4).map(fmt),
      suspicion: this.suspicion >= 0.5 ? (this.suspicion >= this.cfg.suspicionThreshold ? 'high' : 'some') : 'none'
    }
  }
}

module.exports = { Senses, classifySound, NOTABLE_PARTICLES, WORLD_EVENTS }
