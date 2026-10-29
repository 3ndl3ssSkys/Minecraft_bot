'use strict'

/**
 * social.js — how the bot feels about each player, and why.
 *
 * Every player gets two separate scores:
 *
 *   trust   (0..100, starts high) — are they safe and reliable? Moves with what they DO.
 *   liking  (0..100, starts neutral) — do I enjoy them? Personal chemistry: fun to talk to,
 *           shared interests, time spent together. Being polite doesn't make you likeable,
 *           and a rude-but-funny friend can be well liked.
 *
 * Trust moves with what they *do*, not just what they say:
 *
 *   - hitting the bot (worse with a weapon, worse when repeated, much worse
 *     when the bot is nearly dead), killing it,
 *   - hurting things near it (friends, pets, villagers), killing players nearby,
 *   - breaking promises ("I'll bring you iron" and then never doing it),
 *   + gifts, kept promises, helping it fight, apologies, friendly body language.
 *
 * Trust slowly recovers when nothing bad happens (scaled by the personality's
 * forgiveness). It drives how the bot talks to someone, whether it follows
 * their instructions, and whether it fights back or keeps its distance.
 *
 * Profiles are plain objects so they can be persisted by learning.js.
 */

const WEAPON = /_sword$|_axe$|^mace$|^trident$|_spear$|^bow$|^crossbow$/
const PETS = new Set(['wolf', 'cat', 'parrot', 'horse', 'donkey', 'mule', 'llama', 'trader_llama', 'fox', 'axolotl', 'allay', 'camel', 'ocelot', 'sniffer', 'armadillo'])
const VILLAGERS = new Set(['villager', 'iron_golem', 'wandering_trader', 'snow_golem'])
const VALUABLE = {
  netherite_ingot: 8, netherite_scrap: 4, diamond: 4, emerald: 2, gold_ingot: 1, iron_ingot: 1.2, golden_apple: 4,
  enchanted_golden_apple: 10, ender_pearl: 1.5, totem_of_undying: 10, diamond_sword: 8, diamond_pickaxe: 8, iron_sword: 3, iron_pickaxe: 3
}
const PROMISE_DEFAULT_MINUTES = { give_item: 10, come: 5, stop_attacking: 5, help: 20, other: 20 }
const PROMISE_KINDS = Object.keys(PROMISE_DEFAULT_MINUTES)

const now = () => Date.now()
const minutesAgo = (ts) => {
  const m = Math.round((now() - ts) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}
const clamp = (v, min, max) => Math.max(min, Math.min(max, v))

class SocialModel {
  /**
   * @param {object} agent  the Agent (config, emotions, memory, reactor, bot, log, personality)
   * @param {object} data   persisted { players: { name: profile } }
   */
  constructor (agent, data = {}) {
    this.agent = agent
    this.players = data.players || {}
    this.transient = new Map() // name -> { hits: [], swingAt, crouches: [], lastGreetAt, ... }
    this.harmCooldowns = new Map()
    this.lastRecoveryAt = now()
    this.promiseSeq = Object.values(this.players).reduce((m, p) => Math.max(m, ...(p.promises || []).map((x) => x.id || 0)), 0)
  }

  get cfg () { return this.agent.config.trust }
  get likeCfg () { return this.agent.config.affinity }

  // -------------------------------------------------------------------------
  // Profiles & roles
  // -------------------------------------------------------------------------

  key (name) { return String(name || '').toLowerCase() }

  profile (name) {
    const k = this.key(name)
    if (!this.players[k]) {
      this.players[k] = {
        name,
        trust: this.cfg.initial,
        affinity: this.role(name) === 'owner' ? this.likeCfg.ownerInitial : this.likeCfg.initial,
        firstSeen: now(),
        lastSeen: now(),
        hostileUntil: 0,
        lastIncidentAt: 0,
        stats: { hitsTaken: 0, killedMe: 0, gifts: 0, promisesKept: 0, promisesBroken: 0, helped: 0, harmedNearby: 0, apologies: 0, kindMessages: 0, rudeMessages: 0 },
        perceived: null, // { emotion, intent, source, at }
        notes: [], // { at, text, delta }
        promises: []
      }
    }
    const p = this.players[k]
    p.name = name // keep latest capitalisation
    if (!Number.isFinite(p.affinity)) p.affinity = this.role(name) === 'owner' ? this.likeCfg.ownerInitial : this.likeCfg.initial
    return p
  }

  t (name) {
    const k = this.key(name)
    if (!this.transient.has(k)) this.transient.set(k, { hits: [], swingAt: 0, crouches: [], lastGreetAt: 0, lastRepeatPenaltyAt: 0, armedNearSince: 0, followingSince: 0, lookingSince: 0, lastBodyNoteAt: 0, requests: [], togetherSince: 0 })
    return this.transient.get(k)
  }

  role (name) {
    const n = this.key(name)
    const { owners = [], admins = [] } = this.agent.config.behavior
    if (n === '@console' || owners.some((o) => o.toLowerCase() === n)) return 'owner'
    if (admins.some((a) => a.toLowerCase() === n) || (this.agent.runtimeAdmins || []).some((a) => a.toLowerCase() === n)) return 'admin'
    return 'player'
  }

  tier (trust) {
    if (trust >= 92) return 'close friend'
    if (trust >= this.cfg.trustedAbove) return 'trusted friend'
    if (trust >= 60) return 'friendly'
    if (trust >= this.cfg.waryBelow) return 'unsure about them'
    if (trust >= this.cfg.hostileBelow) return 'wary of them'
    return 'enemy'
  }

  likeTier (affinity) {
    if (affinity >= 85) return 'one of your best friends'
    if (affinity >= 70) return 'a good friend'
    if (affinity >= 57) return 'you like them'
    if (affinity >= 43) return 'no strong feelings'
    if (affinity >= 28) return "you don't really like them"
    return "you can't stand them"
  }

  isHostile (name) {
    if (!this.cfg.enabled) return false
    const p = this.players[this.key(name)]
    return Boolean(p && (p.hostileUntil > now() || p.trust < this.cfg.hostileBelow))
  }

  /** Is this player actively attacking us right now (last few seconds)? */
  isAttackingNow (name, windowMs = 6000) {
    return this.t(name).hits.some((h) => now() - h.at < windowMs)
  }

  // -------------------------------------------------------------------------
  // Trust changes
  // -------------------------------------------------------------------------

  /**
   * Change trust with a reason. Negative changes are scaled by personality
   * sensitivity; positive ones by forgiveness when recovering from an incident.
   */
  adjustTrust (name, delta, reason, { incident = delta < 0, quiet = false } = {}) {
    if (!this.cfg.enabled || !name || !Number.isFinite(delta) || delta === 0) return null
    const p = this.profile(name)
    const pers = this.agent.personality
    let d = delta
    if (d < 0) d *= pers.trustSensitivity ?? 1
    if (d > 0 && p.trust < this.cfg.initial && now() - p.lastIncidentAt < 30 * 60000) d *= 0.5 + (pers.forgiveness ?? 0.5)
    const before = p.trust
    p.trust = clamp(Math.round((p.trust + d) * 10) / 10, 0, 100)
    const applied = Math.round((p.trust - before) * 10) / 10
    if (incident) p.lastIncidentAt = now()
    this.addNote(p, reason, applied, 'trust')

    const crossed = this.tier(before) !== this.tier(p.trust)
    if (!quiet) {
      this.agent.memory.addEvent('trust', `${name} ${reason} (trust ${Math.round(before)} → ${Math.round(p.trust)}${crossed ? `, now: ${this.tier(p.trust)}` : ''})`)
      this.agent.log.info(`Trust ${name}: ${Math.round(before)} → ${Math.round(p.trust)} (${reason})`)
    }
    this.agent.learning?.markDirty()
    return p.trust
  }

  /** Change how much the bot likes someone (personal chemistry, not safety). */
  adjustAffinity (name, delta, reason, { quiet = false } = {}) {
    if (!name || !Number.isFinite(delta) || delta === 0) return null
    const p = this.profile(name)
    const before = p.affinity
    p.affinity = clamp(Math.round((p.affinity + delta) * 10) / 10, 0, 100)
    if (Math.abs(delta) >= 1 && reason) this.addNote(p, reason, Math.round((p.affinity - before) * 10) / 10, 'like')
    if (!quiet && this.likeTier(before) !== this.likeTier(p.affinity)) {
      this.agent.memory.addEvent('liking', `How you feel about ${name} changed: ${this.likeTier(p.affinity)} (${reason}).`)
    }
    if (Math.abs(delta) >= 1) this.agent.log.debug(`Liking ${name}: ${Math.round(before)} → ${Math.round(p.affinity)} (${reason})`)
    this.agent.learning?.markDirty()
    return p.affinity
  }

  /** History notes; the same thing again within 10 minutes is merged ("punched you (x3)"). */
  addNote (p, text, delta, kind) {
    const last = p.notes[p.notes.length - 1]
    if (last && last.text === text && last.kind === kind && now() - last.at < 10 * 60000) {
      last.times = (last.times || 1) + 1
      last.delta = Math.round((last.delta + delta) * 10) / 10
      last.at = now()
      return
    }
    p.notes.push({ at: now(), text, delta, kind })
    if (p.notes.length > 15) p.notes.shift()
  }

  /** People who constantly ask for things get on your nerves. */
  noteRequest (name) {
    const t = this.t(name)
    t.requests = t.requests.filter((ts) => now() - ts < 30 * 60000)
    t.requests.push(now())
    if (t.requests.length > 3) this.adjustAffinity(name, -1, 'keeps asking you for things')
  }

  markHostile (name, minutes = this.cfg.hostileMemoryMinutes) {
    const p = this.profile(name)
    p.hostileUntil = Math.max(p.hostileUntil, now() + minutes * 60000)
  }

  /** Slow forgiveness. Call every perception tick. */
  tickRecovery () {
    const elapsedMin = (now() - this.lastRecoveryAt) / 60000
    if (elapsedMin < 1) return
    this.lastRecoveryAt = now()
    const forgiveness = this.agent.personality.forgiveness ?? 0.5
    for (const p of Object.values(this.players)) {
      if (p.trust >= this.cfg.initial || now() - p.lastIncidentAt < 10 * 60000) continue
      p.trust = Math.min(this.cfg.initial, p.trust + this.cfg.recoveryPerHour * forgiveness * (elapsedMin / 60) * 2)
    }
  }

  // -------------------------------------------------------------------------
  // Incidents (called from bot events in index.js)
  // -------------------------------------------------------------------------

  onSwing (entity) {
    if (entity?.type === 'player') this.t(entity.username).swingAt = now()
  }

  /** Who probably hit us when the server didn't say (pre-1.20 servers)? */
  guessAttacker (bot) {
    const me = bot.entity.position
    return Object.values(bot.players)
      .map((p) => p.entity)
      .filter((e) => e && e !== bot.entity && e.position.distanceTo(me) < 5 && now() - this.t(e.username).swingAt < 600)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
  }

  /** A player hit the bot. Figures out how malicious that looked. */
  onHurtBy (attacker, { botHealthBefore }) {
    if (!attacker?.username || attacker.username === this.agent.bot.username) return
    const name = attacker.username
    const p = this.profile(name)
    const t = this.t(name)
    const pen = this.cfg.penalties
    const item = attacker.heldItem?.name
    const weapon = Boolean(item && WEAPON.test(item))
    const lowHealth = botHealthBefore <= this.cfg.lowHealthThreshold

    t.hits = t.hits.filter((h) => now() - h.at < 20000)
    t.hits.push({ at: now(), weapon })
    p.stats.hitsTaken++
    const streak = t.hits.length

    // Broke a "I'll stop" promise?
    for (const pr of p.promises) {
      if (pr.status === 'open' && pr.kind === 'stop_attacking' && now() > pr.madeAt + 2000) this.resolvePromise(name, pr, 'broken')
    }

    const reasons = []
    let delta = -(weapon ? pen.weaponHit : pen.fistHit)
    reasons.push(weapon ? `hit you with a ${item}` : 'punched you')

    if (streak === 1 && !weapon && !lowHealth && (p.trust >= this.cfg.trustedAbove || p.affinity >= 70)) {
      // One punch from a friend is probably horseplay.
      delta = -0.5
      reasons[0] = 'punched you (maybe just messing around)'
      this.agent.emotions.stimulate({ surprise: 0.2, anger: 0.05 }, `${name} punched you`)
    } else {
      this.agent.emotions.stimulate({ fear: 0.12, anger: weapon ? 0.18 : 0.1, surprise: streak === 1 ? 0.15 : 0 }, `${name} is hitting you`)
    }
    if (streak >= 3 && now() - t.lastRepeatPenaltyAt > 20000) {
      delta -= pen.repeatedHits
      reasons.push('and kept attacking you')
      t.lastRepeatPenaltyAt = now()
      this.markHostile(name)
      this.agent.emotions.stimulate({ anger: 0.25, fear: 0.1 }, `${name} keeps attacking you`)
    }
    if (lowHealth) {
      delta -= pen.hitWhileLow
      reasons.push('while you were almost dead')
      this.markHostile(name)
      this.agent.emotions.stimulate({ anger: 0.2, fear: 0.25 }, `${name} attacked you when you were nearly dead`)
    }
    if (weapon && streak >= 2) this.markHostile(name)
    if (delta <= -5) this.adjustAffinity(name, delta / 3, 'attacked you', { quiet: true })

    this.adjustTrust(name, delta, reasons.join(' '))
    this.agent.reactor?.trigger('attackedByPlayer', { player: name, item: item || 'fist', streak, trust: Math.round(p.trust) })
  }

  onKilledBy (name) {
    const p = this.profile(name)
    p.stats.killedMe++
    this.markHostile(name, this.cfg.hostileMemoryMinutes * 2)
    const repeat = p.stats.killedMe > 1 ? ` (that's ${p.stats.killedMe} times now)` : ''
    this.adjustTrust(name, -this.cfg.penalties.killedMe, `killed you${repeat}`)
    this.adjustAffinity(name, -10, 'killed you', { quiet: true })
    this.agent.emotions.stimulate({ anger: 0.45, sadness: 0.3, fear: 0.15 }, `${name} killed you`)
  }

  /** Something near the bot got hurt by a player. */
  onEntityHarmed (victim, attacker) {
    const bot = this.agent.bot
    if (!attacker?.username || attacker === bot.entity || victim === bot.entity || victim === attacker) return
    if (!bot.entity || victim.position.distanceTo(bot.entity.position) > this.cfg.protectRadius) return
    const name = attacker.username
    const cdKey = `${this.key(name)}:${victim.id}`
    if (now() - (this.harmCooldowns.get(cdKey) || 0) < 10000) return
    this.harmCooldowns.set(cdKey, now())
    if (this.harmCooldowns.size > 500) this.harmCooldowns.clear()

    const pen = this.cfg.penalties
    const p = this.profile(name)
    if (victim.type === 'player') {
      const victimName = victim.username
      // Someone we promised to protect is being attacked: that's on us now.
      if (this.agent.tasks?.isProtecting(victimName)) {
        this.agent.protectAlert = { attacker: name, id: attacker.id, victim: victimName, at: now() }
        this.agent.brain?.wake()
      }
      if (this.isHostile(victimName) || this.isAttackingNow(victimName, 10000)) {
        // They're fighting someone who's been attacking us — that's help.
        p.stats.helped++
        this.adjustTrust(name, this.cfg.rewards.helpedFight, `fought ${victimName}, who has been hostile to you`)
        return
      }
      const victimTrust = this.players[this.key(victimName)]?.trust ?? this.cfg.initial
      p.stats.harmedNearby++
      this.adjustTrust(name, -pen.harmedPlayerNearby * (0.5 + victimTrust / 100), `attacked ${victimName} right next to you`)
      const victimLiking = this.players[this.key(victimName)]?.affinity ?? this.likeCfg.initial
      if (victimTrust >= this.cfg.trustedAbove || victimLiking >= 70) {
        this.agent.emotions.stimulate({ anger: 0.15 }, `${name} attacked your friend ${victimName}`)
        this.adjustAffinity(name, -3, `attacked your friend ${victimName}`)
      }
      this.agent.reactor?.trigger('harmNearby', { player: name, victim: victimName })
    } else if (PETS.has(victim.name)) {
      p.stats.harmedNearby++
      this.adjustTrust(name, -pen.harmedPet, `hurt a ${victim.name} near you`)
      this.agent.emotions.stimulate({ anger: 0.12, sadness: 0.08 }, `${name} hurt a ${victim.name}`)
      this.agent.reactor?.trigger('harmNearby', { player: name, victim: victim.name })
    } else if (VILLAGERS.has(victim.name)) {
      p.stats.harmedNearby++
      this.adjustTrust(name, -pen.harmedVillager, `attacked a ${victim.name} near you`)
    } else if (victim.kind === 'Hostile mobs' && victim.position.distanceTo(bot.entity.position) < 8) {
      p.stats.helped++
      this.adjustTrust(name, this.cfg.rewards.helpedFight, `helped fight a ${victim.name} near you`, { incident: false, quiet: true })
    } else if (pen.harmedAnimal > 0 && victim.kind === 'Passive mobs') {
      this.adjustTrust(name, -pen.harmedAnimal, `hurt a ${victim.name} near you`)
    }
  }

  /** "Alex was slain by Steve" — a player killed another player. */
  onPlayerKilled (victimName, killerName) {
    const bot = this.agent.bot
    if (!killerName || killerName === bot.username || !bot.players[killerName]) return
    const victimEntity = bot.players[victimName]?.entity
    const near = victimEntity && bot.entity && victimEntity.position.distanceTo(bot.entity.position) < 32
    if (!near) return
    if (this.isHostile(victimName)) {
      this.adjustTrust(killerName, this.cfg.rewards.helpedFight * 2, `took down ${victimName}, who was hostile to you`, { incident: false })
      return
    }
    const victimTrust = this.players[this.key(victimName)]?.trust ?? this.cfg.initial
    this.adjustTrust(killerName, -this.cfg.penalties.killedPlayerNearby * (0.4 + victimTrust / 100), `killed ${victimName} near you`)
    this.agent.emotions.stimulate({ fear: 0.15, sadness: victimTrust >= 70 ? 0.2 : 0.05 }, `${killerName} killed ${victimName}`)
  }

  onGift (name, item, count) {
    const p = this.profile(name)
    p.stats.gifts++
    const value = (VALUABLE[item] ?? (this.agent.bot.registry.foodsByName[item] ? (this.agent.bot.food < 14 ? 1.5 : 0.7) : 0.3)) * count
    const delta = Math.min(12, this.cfg.rewards.gift + Math.sqrt(value) * 1.5)
    this.adjustTrust(name, delta, `gave you ${count} ${item}`, { incident: false })
    this.adjustAffinity(name, Math.min(2, 0.5 + Math.sqrt(value) * 0.3), null, { quiet: true }) // nice, but gifts don't buy friendship
    this.agent.emotions.stimulate({ joy: Math.min(0.4, 0.12 + value / 40) }, `${name} gave you ${item}`)
    this.agent.reactor?.trigger('gift', { player: name, item, count })

    for (const pr of p.promises) {
      if (pr.status !== 'open' || pr.kind !== 'give_item') continue
      if (pr.item && !item.includes(pr.item) && !pr.item.includes(item)) continue
      pr.delivered = (pr.delivered || 0) + count
      if (pr.delivered >= (pr.count || 1)) this.resolvePromise(name, pr, 'kept')
    }
  }

  /** Rapid crouching near the bot is the universal Minecraft "hello". */
  onCrouch (entity) {
    const bot = this.agent.bot
    if (entity?.type !== 'player' || !bot.entity || entity.position.distanceTo(bot.entity.position) > 8) return
    const t = this.t(entity.username)
    t.crouches = t.crouches.filter((ts) => now() - ts < 3000)
    t.crouches.push(now())
    if (t.crouches.length >= 3 && now() - t.lastGreetAt > 60000) {
      t.lastGreetAt = now()
      this.perceive(entity.username, 'happy', 'friendly greeting (crouch-spamming at you)', 'body')
      this.adjustTrust(entity.username, this.cfg.rewards.crouchGreeting, 'crouch-greeted you', { incident: false, quiet: true })
      this.adjustAffinity(entity.username, 0.5, null, { quiet: true })
      this.agent.reactor?.trigger('crouchGreeting', { player: entity.username, entityId: entity.id })
    }
  }

  perceive (name, emotion, intent, source = 'chat') {
    this.profile(name).perceived = { emotion, intent, source, at: now() }
  }

  /**
   * Body language, every perception tick: armed approach, following, staring.
   * Only sets "perceived" impressions (and a little fear) — no trust change,
   * since none of this is harmful by itself.
   */
  observe (state) {
    const bot = this.agent.bot
    const me = bot.entity
    const moving = Boolean(this.agent.executor?.busy)
    for (const e of state.nearbyEntities) {
      if (e.kind !== 'player') continue
      const p = this.profile(e.name)
      p.lastSeen = now()
      const t = this.t(e.name)
      // Hanging out near each other without trouble slowly builds a bond.
      if (e.distance < 16 && !this.isHostile(e.name)) {
        if (!t.togetherSince) t.togetherSince = now()
        if (now() - t.togetherSince >= 60000) {
          this.adjustAffinity(e.name, this.likeCfg.perMinuteTogether, null, { quiet: true })
          t.togetherSince = now()
        }
      } else {
        t.togetherSince = 0
      }
      const entity = bot.entities[e.id]
      if (!entity) continue
      const armed = Boolean(entity.heldItem && WEAPON.test(entity.heldItem.name))

      // Armed and close, from someone we don't trust → threatening.
      if (armed && e.distance < 6 && p.trust < this.cfg.waryBelow) {
        if (!t.armedNearSince) t.armedNearSince = now()
        if (now() - t.armedNearSince > 2000 && now() - t.lastBodyNoteAt > 30000) {
          t.lastBodyNoteAt = now()
          this.perceive(e.name, 'unknown', `approaching you with a ${entity.heldItem.name} out (threatening)`, 'body')
          this.agent.emotions.stimulate({ fear: 0.12 }, `${e.name} is coming at you armed`)
        }
      } else {
        t.armedNearSince = 0
      }

      // Following us around while we move.
      if (moving && e.distance < 7) {
        if (!t.followingSince) t.followingSince = now()
        if (now() - t.followingSince > 20000 && now() - t.lastBodyNoteAt > 60000) {
          t.lastBodyNoteAt = now()
          this.perceive(e.name, p.perceived?.emotion || 'unknown', 'following you around', 'body')
        }
      } else if (e.distance > 12) {
        t.followingSince = 0
      }

      // Staring at us from close by.
      if (e.distance < 10 && isLookingAt(entity, me)) {
        if (!t.lookingSince) t.lookingSince = now()
        if (now() - t.lookingSince > 5000 && now() - t.lastBodyNoteAt > 60000) {
          t.lastBodyNoteAt = now()
          this.perceive(e.name, p.perceived?.emotion || 'unknown', 'staring at you', 'body')
        }
      } else {
        t.lookingSince = 0
      }
    }
    this.checkPromises(state)
  }

  // -------------------------------------------------------------------------
  // Chat analysis & promises
  // -------------------------------------------------------------------------

  /** Apply the LLM's read of a player's message. */
  onChatAnalysis (name, a) {
    if (!a) return
    const p = this.profile(name)
    if (a.playerIntent || a.playerEmotion) this.perceive(name, a.playerEmotion || 'unknown', a.playerIntent || 'neutral', 'chat')

    if (a.playerIntent === 'apologetic' && now() - p.lastIncidentAt < 20 * 60000 && p.trust < this.cfg.initial) {
      // Apologies work, but less each time ("you said that last time").
      const lost = this.cfg.initial - p.trust
      const effect = Math.min(lost * 0.5, this.cfg.rewards.apology * (this.agent.personality.forgiveness ?? 0.5) * 2 * 0.5 ** p.stats.apologies)
      p.stats.apologies++
      if (effect > 0.5) this.adjustTrust(name, effect, p.stats.apologies > 1 ? 'apologised again' : 'apologised', { incident: false })
      if (p.stats.apologies === 1) this.adjustAffinity(name, 1, null, { quiet: true })
      this.agent.emotions.stimulate({ anger: -0.15 })
    } else {
      const impact = clamp(Number(a.trustImpact) || 0, -10, 4)
      if (impact <= -1) {
        p.stats.rudeMessages++
        this.adjustTrust(name, impact, a.playerIntent === 'threatening' ? 'threatened you' : 'was rude to you')
        this.agent.emotions.stimulate({ anger: Math.min(0.3, -impact / 25), fear: a.playerIntent === 'threatening' ? 0.15 : 0 }, `${name} was rude`)
      } else if (impact >= 1) {
        p.stats.kindMessages++
        this.adjustTrust(name, impact * 0.5, 'was nice to you', { incident: false, quiet: true })
        this.agent.emotions.stimulate({ joy: 0.08 })
      }
    }

    // Chemistry: did this character actually enjoy that? (not the same as politeness)
    const like = clamp(Number(a.likeImpact) || 0, -5, 5)
    if (like) this.adjustAffinity(name, like, like > 0 ? 'was fun to talk to' : 'got on your nerves', { quiet: Math.abs(like) < 2 })

    if (a.promise?.made && PROMISE_KINDS.includes(a.promise.kind)) this.addPromise(name, a.promise)
  }

  addPromise (name, pr) {
    const p = this.profile(name)
    const open = p.promises.filter((x) => x.status === 'open')
    if (open.length >= 5) return
    const minutes = clamp(Number(pr.withinMinutes) || PROMISE_DEFAULT_MINUTES[pr.kind], 1, 120)
    const promise = {
      id: ++this.promiseSeq,
      kind: pr.kind,
      description: String(pr.description || pr.kind).slice(0, 120),
      item: pr.item ? String(pr.item).toLowerCase().replace(/\s+/g, '_').replace(/^minecraft:/, '') : null,
      count: clamp(Math.round(Number(pr.count) || 1), 1, 64 * 9),
      madeAt: now(),
      dueAt: now() + minutes * 60000,
      status: 'open'
    }
    p.promises.push(promise)
    if (p.promises.length > 15) p.promises.shift()
    this.agent.memory.addEvent('promise', `${name} promised: ${promise.description} (within ${minutes} min)`)
    this.agent.learning?.markDirty()
  }

  resolvePromise (name, pr, status) {
    if (pr.status !== 'open') return
    pr.status = status
    pr.resolvedAt = now()
    const p = this.profile(name)
    if (status === 'kept') {
      p.stats.promisesKept++
      this.adjustTrust(name, this.cfg.rewards.keptPromise, `kept their promise (${pr.description})`, { incident: false })
      this.adjustAffinity(name, 2, null, { quiet: true })
      this.agent.emotions.stimulate({ joy: 0.15 }, `${name} kept their word`)
      this.agent.reactor?.trigger('promiseKept', { player: name, promise: pr.description })
    } else {
      p.stats.promisesBroken++
      const soft = status === 'expired' ? 0.5 : 1
      this.adjustTrust(name, -this.cfg.penalties.brokenPromise * soft, `broke their promise (${pr.description})`)
      this.adjustAffinity(name, -2 * soft, null, { quiet: true })
      this.agent.emotions.stimulate({ sadness: 0.15 * soft, anger: 0.15 * soft }, `${name} broke a promise`)
      this.agent.reactor?.trigger('promiseBroken', { player: name, promise: pr.description })
    }
  }

  checkPromises () {
    const bot = this.agent.bot
    for (const p of Object.values(this.players)) {
      for (const pr of p.promises) {
        if (pr.status !== 'open') continue
        if (pr.kind === 'come') {
          const e = bot.players[p.name]?.entity
          if (e && bot.entity && e.position.distanceTo(bot.entity.position) < 8) { this.resolvePromise(p.name, pr, 'kept'); continue }
        }
        if (now() < pr.dueAt) continue
        if (pr.kind === 'stop_attacking') this.resolvePromise(p.name, pr, 'kept')
        else if (pr.kind === 'give_item' || pr.kind === 'come') this.resolvePromise(p.name, pr, 'broken')
        else this.resolvePromise(p.name, pr, 'expired') // can't verify "help"/"other": softer penalty
      }
    }
  }

  // -------------------------------------------------------------------------
  // Summaries for prompts
  // -------------------------------------------------------------------------

  relationshipLine (name, { notes = 4 } = {}) {
    const p = this.profile(name)
    const role = this.role(name)
    const parts = [`${name}: trust ${Math.round(p.trust)}/100 (${this.tier(p.trust)}), liking ${Math.round(p.affinity)}/100 (${this.likeTier(p.affinity)})${role !== 'player' ? `, your ${role}` : ''}`]
    if (this.isHostile(name)) parts.push('they have been HOSTILE to you recently')
    const recent = p.notes.slice(-notes).map((n) => `${n.text}${n.times > 1 ? ` (x${n.times})` : ''} (${minutesAgo(n.at)})`)
    if (recent.length) parts.push(`history: ${recent.join('; ')}`)
    if (p.perceived && now() - p.perceived.at < 10 * 60000) parts.push(`they seem ${describePerceived(p.perceived)}`)
    const open = p.promises.filter((x) => x.status === 'open')
    if (open.length) parts.push(`their open promises: ${open.map((x) => `${x.description} (due in ${Math.max(0, Math.round((x.dueAt - now()) / 60000))}m)`).join(', ')}`)
    const broken = p.promises.filter((x) => x.status !== 'open' && x.status !== 'kept' && now() - x.resolvedAt < 60 * 60000)
    if (broken.length) parts.push(`broke ${broken.length} promise(s) recently`)
    return parts.join('. ')
  }

  /** Short per-entity annotation merged into nearbyEntities. */
  annotate (name) {
    const p = this.profile(name)
    const out = { trust: Math.round(p.trust), liking: Math.round(p.affinity), relationship: `${this.tier(p.trust)}; ${this.likeTier(p.affinity)}` }
    const role = this.role(name)
    if (role !== 'player') out.role = role
    if (this.isHostile(name)) out.hostile = true
    if (p.perceived && now() - p.perceived.at < 5 * 60000) out.seems = describePerceived(p.perceived)
    return out
  }

  peopleSummary (names) {
    return names.map((n) => `- ${this.relationshipLine(n, { notes: 3 })}`).join('\n')
  }

  setTrust (name, value) {
    const p = this.profile(name)
    p.trust = clamp(Number(value), 0, 100)
    if (p.trust >= this.cfg.hostileBelow) p.hostileUntil = 0
    p.notes.push({ at: now(), text: `trust set to ${p.trust} by an admin`, delta: 0 })
    this.agent.learning?.markDirty()
  }

  setAffinity (name, value) {
    this.profile(name).affinity = clamp(Number(value), 0, 100)
    this.agent.learning?.markDirty()
  }

  forget (name) {
    delete this.players[this.key(name)]
    this.transient.delete(this.key(name))
    this.agent.learning?.markDirty()
  }

  toJSON () { return { players: this.players } }
}

/** "annoyed, rude" — skipping the emotion when it adds nothing. */
function describePerceived ({ emotion, intent }) {
  return !emotion || ['unknown', 'neutral', intent].includes(emotion) ? intent : `${emotion}, ${intent}`
}

/** Is `viewer` looking roughly at `target`? */
function isLookingAt (viewer, target) {
  if (!viewer?.position || !target?.position) return false
  const dx = target.position.x - viewer.position.x
  const dz = target.position.z - viewer.position.z
  const dy = target.position.y + 1.6 - (viewer.position.y + 1.6)
  const yawToTarget = Math.atan2(-dx, -dz) // Minecraft yaw convention used by mineflayer
  const pitchToTarget = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz))
  let dyaw = Math.abs(((viewer.yaw - yawToTarget + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI)
  if (!Number.isFinite(dyaw)) dyaw = Math.PI
  return dyaw < 0.35 && Math.abs((viewer.pitch || 0) - pitchToTarget) < 0.4
}

module.exports = { SocialModel, WEAPON, PETS, PROMISE_KINDS }
