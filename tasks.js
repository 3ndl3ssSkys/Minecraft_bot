'use strict'

/**
 * tasks.js — things other players asked the bot to do, and whether it wants to.
 *
 * When someone asks for something, the bot appraises the request the way a
 * person would, and the answer depends on WHAT is asked:
 *
 *   - favours (gather / craft / give / come / follow): mostly how much it
 *     LIKES the person, how much work it is, how risky, how busy it is and
 *     whether it has its own needs to take care of first;
 *   - fights ("go kill Steve"): whether it actually wants to — grudges
 *     against the target, friendship with them, whether it would conflict with
 *     something it already promised (protecting or helping that person),
 *     whether it could even win, and its own appetite for violence.
 *
 * On top of its own willingness sits an obedience level (per role, or per
 * player, set by owners/admins): chance = own + (1 - own) × obedience. At 0
 * it's purely its own call; at 1 it does whatever it physically can — though
 * its conscience (not killing friends, keeping promises) still holds unless
 * obedience.overrideConscience is on.
 *
 * Accepted requests become tasks with progress, a patience budget and a
 * "salience" that fades: queued tasks can be forgotten (and remembered again
 * when the player brings them up), and long jobs can end half-done — the bot
 * hands over what it has when it runs out of patience or has its own things
 * to do.
 */

const KINDS = ['gather', 'craft', 'give_item', 'come', 'follow', 'attack', 'protect', 'build', 'explore', 'other']
const EFFORTS = ['trivial', 'small', 'medium', 'large', 'huge']
const RISKS = ['none', 'low', 'medium', 'high']
const EFFORT_FACTOR = { trivial: 1, small: 0.95, medium: 0.8, large: 0.6, huge: 0.4 }
const EFFORT_MINUTES = { trivial: 0.5, small: 2, medium: 6, large: 15, huge: 35 }
const RISK_FACTOR = { none: 1, low: 0.95, medium: 0.75, high: 0.45 }
const DANGEROUS_MOBS = new Set(['creeper', 'enderman', 'warden', 'wither', 'ender_dragon', 'ravager', 'evoker', 'vindicator', 'piglin_brute', 'blaze', 'ghast', 'witch', 'elder_guardian', 'breeze'])

/** Rough minutes per item for a gathering job, so "get me 64 diamonds" is understood as huge. */
const ITEM_MINUTES = [
  [/_log$|_stem$|_wood$/, 0.15], [/_planks$|^stick$/, 0.05],
  [/^(cobblestone|dirt|sand|gravel|stone|netherrack|cobbled_deepslate|clay_ball)$/, 0.05],
  [/coal/, 0.3], [/iron/, 0.6], [/copper/, 0.4], [/gold/, 1.2], [/redstone|lapis/, 0.5], [/quartz/, 0.4],
  [/diamond/, 4], [/emerald/, 5], [/netherite|ancient_debris/, 15], [/obsidian/, 1],
  [/wool/, 0.6], [/^(beef|porkchop|mutton|chicken|rabbit|cooked_\w+)$/, 0.6], [/wheat|carrot|potato|beetroot|melon|pumpkin/, 0.2],
  [/leather|feather|string|bone|gunpowder|ender_pearl|blaze_rod|slime_ball/, 1]
]
const VALUABLE_ITEMS = /diamond|netherite|emerald|golden_apple|totem|elytra|enchanted|ender_pearl|beacon|nether_star/

const clamp = (v, min, max) => Math.max(min, Math.min(max, v))
const now = () => Date.now()
const normItem = (s) => String(s || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')

function effortBucket (minutes) {
  if (minutes <= 0.75) return 'trivial'
  if (minutes <= 3) return 'small'
  if (minutes <= 10) return 'medium'
  if (minutes <= 25) return 'large'
  return 'huge'
}

function minutesPerItem (item) {
  return (ITEM_MINUTES.find(([re]) => re.test(item)) || [null, 0.3])[1]
}

class TaskManager {
  constructor (agent, data = {}) {
    this.agent = agent
    // After a restart, an in-progress task is remembered a little less clearly.
    this.tasks = (data.tasks || []).filter((t) => ['active', 'queued', 'delivering'].includes(t.status))
    for (const t of this.tasks) if (t.status !== 'queued') { t.status = 'queued'; t.salience = (t.salience ?? 1) * 0.8 }
    this.history = data.history || []
    this.seq = [...this.tasks, ...this.history].reduce((m, t) => Math.max(m, t.id || 0), 0)
    this.lastTick = now()
  }

  get cfg () { return this.agent.config.judgment }
  get obey () { return this.agent.config.obedience }

  /** Obedience level for this player: their own override, else their role's level. */
  obedienceFor (name) {
    const o = this.obey
    const own = o.players?.[String(name).toLowerCase()]
    if (Number.isFinite(own)) return clamp(own, 0, 1)
    const { social, config } = this.agent
    const role = social.role(name)
    const p = social.profile(name)
    const tier = role !== 'player' ? role : (p.trust >= config.trust.trustedAbove || p.affinity >= 70) ? 'trusted' : 'player'
    return clamp(o.levels[tier] ?? 0, 0, 1)
  }

  /** May this player ask at all (obedience.whoCanInstruct)? Others only get favours. */
  mayInstruct (name) {
    const { social, config } = this.agent
    const who = this.obey.whoCanInstruct
    const role = social.role(name)
    if (who === 'nobody') return false
    if (who === 'everyone' || role === 'owner') return true
    if (who === 'owners') return false
    if (who === 'admins') return role === 'admin'
    const p = social.profile(name)
    return role === 'admin' || p.trust >= config.trust.trustedAbove || p.affinity >= 70 // 'trusted'
  }
  get personality () { return this.agent.personality }

  active () { return this.tasks.find((t) => t.status === 'active' || t.status === 'delivering') || null }
  queued () { return this.tasks.filter((t) => t.status === 'queued') }

  // -------------------------------------------------------------------------
  // Understanding a request
  // -------------------------------------------------------------------------

  normalize (from, raw = {}) {
    const kind = KINDS.includes(raw.kind) ? raw.kind : 'other'
    const req = {
      kind,
      description: String(raw.description || kind).slice(0, 160),
      item: raw.item ? normItem(raw.item) : '',
      count: clamp(Math.round(Number(raw.count) || 0), 0, 64 * 36),
      target: String(raw.target || '').trim(),
      effort: EFFORTS.includes(raw.effort) ? raw.effort : 'medium',
      risk: RISKS.includes(raw.risk) ? raw.risk : 'low'
    }
    if (['gather', 'craft', 'give_item'].includes(kind) && !req.count) req.count = 1
    if (['come', 'follow', 'protect'].includes(kind) && !req.target) req.target = from
    if (req.target.toLowerCase() === 'me') req.target = from

    // Our own estimate of the work, because "just grab me a stack of diamonds" is not small.
    const bot = this.agent.bot
    let minutes = EFFORT_MINUTES[req.effort]
    if (kind === 'gather') minutes = Math.max(0.5, req.count * minutesPerItem(req.item))
    if (kind === 'craft') minutes = Math.max(0.5, req.count * minutesPerItem(req.item) * 1.5)
    if (kind === 'give_item') minutes = 0.5
    if (kind === 'come' || kind === 'follow') {
      const e = bot.players[from]?.entity
      const dist = e && bot.entity ? e.position.distanceTo(bot.entity.position) : 200
      minutes = (kind === 'follow' ? 3 : 0) + dist / 240
    }
    if (kind === 'attack') minutes = this.isPlayerName(req.target) ? 2 : 1
    if (kind === 'protect') minutes = 10
    req.minutes = Math.round(minutes * 10) / 10
    if (['gather', 'craft', 'give_item', 'come', 'follow'].includes(kind)) req.effort = effortBucket(minutes)
    if (kind === 'attack' && DANGEROUS_MOBS.has(normItem(req.target))) req.risk = 'high'
    return req
  }

  isPlayerName (name) {
    return Boolean(name && Object.keys(this.agent.bot.players).some((n) => n.toLowerCase() === name.toLowerCase()))
  }

  playerName (name) {
    return Object.keys(this.agent.bot.players).find((n) => n.toLowerCase() === String(name).toLowerCase()) || name
  }

  countItem (item) {
    if (!item) return 0
    return this.agent.bot.inventory.items()
      .filter((i) => i.name === item || i.name.endsWith(`_${item}`) || i.name.includes(item))
      .reduce((a, i) => a + i.count, 0)
  }

  // -------------------------------------------------------------------------
  // The appraisal: does the bot WANT to do this?
  // -------------------------------------------------------------------------

  /**
   * @returns {{ outcome: 'comply'|'partial'|'defer'|'refuse', chance: number, reason: string,
   *             commitCount?: number, sideEffects: Array<[string, number, string]>, req: object }}
   */
  appraise (from, rawReq) {
    const req = this.normalize(from, rawReq)
    const { social, emotions, bot, config } = this.agent
    const p = this.personality
    const me = social.profile(from)
    const role = social.role(from)
    const sideEffects = [] // [kind ('trust'|'like'), delta, reason] applied to the requester
    const verdict = (outcome, chance, reason, extra = {}) => ({ outcome, chance: Math.round(chance * 100) / 100, reason, sideEffects, req, ...extra })

    if (social.isHostile(from)) return verdict('refuse', 0, `you don't do anything for ${from} after what they did to you`)
    const authorized = this.mayInstruct(from)
    const ob = authorized ? this.obedienceFor(from) : 0
    const blend = (c) => clamp(c + (1 - c) * ob, 0, 1)
    if (req.kind === 'attack') return this.appraiseFight(from, req, verdict, sideEffects, { ob, blend, authorized })

    // ---- Favours: mostly "do I like this person enough for this much work?"
    const liking = clamp((me.affinity - 25) / 50, 0, 1.2) // 50 → 0.5, 75 → 1
    const helpful = p.helpfulness ?? 0.6
    let base = 0.15 + 0.6 * liking + 0.35 * (helpful - 0.5) + (role === 'owner' ? this.cfg.ownerLoyalty : 0)

    const factors = {
      effort: EFFORT_FACTOR[req.effort] * (0.75 + 0.25 * (p.patience ?? 1)),
      risk: RISK_FACTOR[req.risk],
      trust: me.trust < config.trust.waryBelow ? 0.55 : 1,
      mood: emotions.modifiers().compliance,
      busy: 1,
      needs: 1
    }
    const current = this.active()
    if (current && current.from.toLowerCase() !== from.toLowerCase()) factors.busy = 0.75
    factors.busy *= 0.85 ** this.queued().length
    if (bot.food <= 6 || bot.health <= 8) factors.needs = 0.55

    // Giving away our own stuff: depends on what it is and how much we have.
    if (req.kind === 'give_item') {
      const have = this.countItem(req.item)
      if (have === 0) return verdict('refuse', 0, `you don't have any ${req.item || 'of that'}`)
      if (VALUABLE_ITEMS.test(req.item)) base *= 0.45 + 0.6 * (p.generosity ?? 0.5) * liking
      if (have < req.count) req.count = have
    }
    if (req.kind === 'protect' && req.target.toLowerCase() !== from.toLowerCase()) {
      const t = social.profile(req.target)
      if (social.isHostile(req.target)) return verdict('refuse', 0, `${req.target} has been hostile to you; you're not protecting them`)
      base *= 0.6 + 0.6 * clamp((t.affinity - 25) / 50, 0, 1)
    }

    let chance = base * factors.effort * factors.risk * factors.trust * factors.mood * factors.busy * factors.needs * (authorized ? 1 : 0.6)
    chance = blend(clamp(chance + (Math.random() * 2 - 1) * this.cfg.randomness, 0, 1))

    // The weakest factor explains a "no" (or a "some of it").
    const reasons = {
      effort: `that's a lot of work (${req.minutes} min) for ${from}`,
      risk: 'it sounds dangerous',
      trust: `you don't trust ${from} much`,
      mood: "you're not in the mood",
      busy: current ? `you're busy with ${current.description} for ${current.from}` : 'you have other stuff lined up',
      needs: 'you need to take care of yourself first (food/health)'
    }
    const weakest = Object.entries(factors).sort((a, b) => a[1] - b[1])[0]
    const reason = !authorized ? `${from} isn't someone you take requests from — it'd only be a favour`
      : liking < 0.4 && weakest[1] > 0.7 ? `you don't know or like ${from} that well`
        : reasons[weakest[0]]

    const measurable = ['gather', 'craft', 'give_item'].includes(req.kind)
    const roll = Math.random()
    if (roll < chance) {
      // Willing — but for big jobs, maybe only part of it.
      if (measurable && req.count > 1 && ['large', 'huge'].includes(req.effort) && chance < 0.85) {
        const commitCount = Math.max(1, Math.round(req.count * clamp(chance * 1.1, 0.2, 0.9)))
        return verdict('partial', chance, `${reasons.effort}, so you'll only do part of it`, { commitCount })
      }
      return verdict('comply', chance, '', { commitCount: req.count })
    }
    if (roll < chance + (1 - chance) * 0.4 && chance >= 0.12) {
      if (factors.busy < 1 || factors.needs < 1) return verdict('defer', chance, reason, { commitCount: req.count })
      if (measurable && req.count > 1) {
        return verdict('partial', chance, reason, { commitCount: Math.max(1, Math.round(req.count * clamp(chance * 0.7, 0.1, 0.6))) })
      }
    }
    return verdict('refuse', chance, reason)
  }

  /** "Go kill X": would the bot actually want to? */
  appraiseFight (from, req, verdict, sideEffects, { ob = 0, blend = (c) => c } = {}) {
    const { social, config, bot, emotions } = this.agent
    const p = this.personality
    const target = req.target
    const requester = social.profile(from)
    const role = social.role(from)

    const isMob = Boolean(bot.registry.entitiesByName?.[normItem(target)])
    if (!this.isPlayerName(target) && !isMob) {
      return verdict(social.players[normItem(target)] ? 'defer' : 'refuse', 0, `${target} isn't even around right now`)
    }
    if (!this.isPlayerName(target)) {
      // A mob: a normal favour with risk.
      const liking = clamp((requester.affinity - 25) / 50, 0, 1.2)
      let chance = (0.3 + 0.5 * liking + 0.2 * (p.violence ?? 0.35)) * RISK_FACTOR[req.risk] * emotions.modifiers().compliance
      chance = blend(clamp(chance + (Math.random() * 2 - 1) * this.cfg.randomness, 0, 1))
      return Math.random() < chance
        ? verdict('comply', chance, '')
        : verdict('refuse', chance, req.risk === 'high' ? `a ${target} is too dangerous to go after` : 'you can\'t be bothered')
    }

    const name = this.playerName(target)
    const t = social.profile(name)
    if (name === bot.username) return verdict('refuse', 0, 'they literally want you to kill yourself')
    if (name.toLowerCase() === from.toLowerCase()) {
      req.kind = 'attack'
      req.sparring = true
      const chance = clamp(0.2 + 0.6 * clamp((requester.affinity - 25) / 50, 0, 1) + 0.2 * (p.violence ?? 0.35), 0, 1)
      return Math.random() < chance ? verdict('comply', chance, '') : verdict('refuse', chance, "you're not in the mood for a duel")
    }
    if (!config.judgment.requestedFights || config.pvp.mode === 'never') return verdict('refuse', 0, "you don't go around killing people")
    if (config.behavior.protectedPlayers.some((n) => n.toLowerCase() === name.toLowerCase()) ||
      (config.pvp.neverAttackOwners && social.role(name) === 'owner')) {
      return verdict('refuse', 0, `${name} is off-limits to you`)
    }

    // Would it conflict with something we already promised?
    const conflict = this.tasks.find((x) => ['active', 'queued', 'delivering'].includes(x.status) &&
      ((x.kind === 'protect' && x.target.toLowerCase() === name.toLowerCase()) || x.from.toLowerCase() === name.toLowerCase()))
    const conscienceOff = this.obey.overrideConscience && ob >= 0.9
    if (conflict && !conscienceOff) {
      return verdict('refuse', 0, conflict.kind === 'protect'
        ? `you promised ${conflict.from} you'd protect ${name}`
        : `you're in the middle of doing something for ${name} (${conflict.description})`)
    }

    // Grudge vs friendship.
    const grudge = clamp(clamp((config.trust.initial - t.trust) / 50, 0, 1) + (social.isHostile(name) ? 0.5 : 0) +
      (t.stats.harmedNearby > 0 ? 0.2 : 0) + (t.stats.killedMe > 0 ? 0.3 : 0), 0, 1)
    const friendship = clamp((t.affinity - 50) / 35, 0, 1) + (t.trust >= config.trust.trustedAbove ? 0.3 : 0)
    if (friendship >= 0.6 && grudge < 0.5 && !conscienceOff) {
      sideEffects.push(['trust', -4, `asked you to kill ${name}, your friend`], ['like', -8, `asked you to kill your friend ${name}`])
      this.agent.emotions.stimulate({ anger: 0.15, surprise: 0.15 }, `${from} wants you to kill ${name}`)
      return verdict('refuse', 0, `${name} is your friend`)
    }

    const loyalty = clamp((requester.affinity - 40) / 45, 0, 1) * 0.5 + (role === 'owner' ? this.cfg.ownerLoyalty : 0)
    let want = grudge * 0.7 + loyalty * 0.5 + (p.violence ?? 0.35) * 0.3 - friendship * 0.8
    if (config.pvp.mode === 'defensive' && grudge < 0.4) want -= 0.3 // doesn't like starting fights
    if (requester.trust < config.trust.waryBelow) want -= 0.25 // probably a set-up

    // Could we even win?
    const entity = bot.players[name]?.entity
    const brain = this.agent.brain
    let outmatched = false
    if (entity && brain) outmatched = brain.fightOrFlight(entity) === 'flee'
    if (outmatched) want *= 0.35 // a grudge isn't worth dying for — maybe later, with better gear

    const chance = blend(clamp(want + (Math.random() * 2 - 1) * this.cfg.randomness, 0, 1))
    if (Math.random() < chance) return verdict('comply', chance, '')
    const reason = outmatched ? `${name} would probably beat you`
      : grudge < 0.3 ? `${name} never did anything to you`
        : 'you\'re not sure it\'s worth it'
    return verdict(chance >= 0.25 && grudge >= 0.4 ? 'defer' : 'refuse', chance, reason)
  }

  // -------------------------------------------------------------------------
  // Task lifecycle
  // -------------------------------------------------------------------------

  /** Turn an accepted appraisal into a task. Returns the task (or null for refusals). */
  accept (from, decision) {
    const { social, memory, log } = this.agent
    for (const [kind, delta, why] of decision.sideEffects) {
      if (kind === 'trust') social.adjustTrust(from, delta, why)
      else social.adjustAffinity(from, delta, why)
    }
    social.noteRequest(from)
    if (decision.outcome === 'refuse') {
      memory.addEvent('refused', `You turned down ${from}: ${decision.req.description} (${decision.reason})`)
      return null
    }
    if (this.queued().length >= this.cfg.maxQueuedTasks && decision.outcome === 'defer') {
      // Too much on our plate: an older, less important thing quietly slips.
      const oldest = this.queued().sort((a, b) => a.salience - b.salience)[0]
      if (oldest) this.forget(oldest, 'too many things to remember')
    }
    const req = decision.req
    const t = {
      id: ++this.seq,
      from,
      kind: req.kind,
      description: req.description,
      item: req.item,
      count: req.count,
      target: req.target,
      sparring: Boolean(req.sparring),
      effort: req.effort,
      minutes: req.minutes,
      commitCount: decision.commitCount ?? req.count,
      outcome: decision.outcome,
      createdAt: now(),
      startedAt: 0,
      lastProgressAt: now(),
      startCount: 0,
      delivered: 0,
      attempts: 0,
      salience: 0.7 + 0.3 * clamp(social.profile(from).affinity / 100, 0, 1),
      status: 'queued'
    }
    this.tasks.push(t)
    memory.addEvent('task', `${from} asked you to: ${t.description}. You ${{ comply: 'agreed', partial: `agreed to do part of it (${t.commitCount} of ${t.count})`, defer: 'said later' }[decision.outcome]}.`)
    log.info(`Task #${t.id} from ${from}: ${t.description} → ${decision.outcome}${t.count && t.commitCount !== t.count ? ` (${t.commitCount}/${t.count})` : ''}`)

    const current = this.active()
    if (decision.outcome !== 'defer') {
      // A newer request from the same person ("actually, come here") takes over; so can someone
      // we like a lot more, if we haven't really started yet.
      const sameAsker = current && current.from.toLowerCase() === from.toLowerCase()
      const bump = current && (sameAsker || (!this.hasProgress(current) &&
        social.profile(from).affinity > social.profile(current.from).affinity + 15))
      if (!current || bump) {
        if (current) { current.status = 'queued'; current.salience -= 0.1 }
        this.start(t)
      }
    }
    this.distract(0.1)
    this.agent.learning?.markDirty()
    return t
  }

  start (t) {
    t.status = 'active'
    t.startedAt = now()
    t.lastProgressAt = now()
    t.startCount = this.countItem(t.item)
    t.attempts = 0
    // Patience: estimated time for what we committed to, stretched by personality and liking.
    const liking = clamp(this.agent.social.profile(t.from).affinity / 100, 0, 1)
    const committedMinutes = t.count ? t.minutes * (t.commitCount / Math.max(1, t.count)) : t.minutes
    t.budgetMs = Math.max(60000, committedMinutes * 60000 * (1.3 + liking) * (this.personality.patience ?? 1))
    this.agent.brain?.onNewGoal()
  }

  hasProgress (t) { return this.progress(t) > 0 || t.delivered > 0 }

  progress (t) {
    if (!['gather', 'craft'].includes(t.kind)) return t.delivered
    return Math.max(0, this.countItem(t.item) - t.startCount + t.delivered)
  }

  /** Called every perception tick. */
  tick () {
    const minutes = (now() - this.lastTick) / 60000
    if (minutes < 0.25) return
    this.lastTick = now()
    const { social, bot } = this.agent
    const forgetfulness = this.cfg.forgetting ? (this.personality.forgetfulness ?? 0.3) : 0

    for (const t of this.queued()) {
      // Things we said we'd do "later" fade, faster for people we care less about.
      const liking = clamp(social.profile(t.from).affinity / 100, 0, 1)
      t.salience -= minutes * 0.02 * (0.5 + forgetfulness) * (1.4 - liking)
      if (forgetfulness && t.salience < 0.35 && Math.random() < forgetfulness * 0.25 * minutes) this.forget(t, 'faded')
      if (now() - t.createdAt > 3 * 3600000) this.forget(t, 'too long ago')
    }

    const a = this.active()
    if (a) {
      const p = this.progress(a)
      if (p > (a.lastProgress || 0)) { a.lastProgress = p; a.lastProgressAt = now() }
      // Drifted off: no progress for a long time.
      if (now() - a.lastProgressAt > 8 * 60000) a.salience -= minutes * 0.05 * (0.5 + forgetfulness)
      if (forgetfulness && a.salience < 0.3 && Math.random() < forgetfulness * 0.3 * minutes) { this.forget(a, 'got distracted'); return this.next() }
      if (a.status === 'active' && now() - a.startedAt > a.budgetMs) this.wrapUp(a, 'it was taking too long')
      if (a.status === 'active' && a.kind === 'protect' && now() - a.startedAt > a.budgetMs * 0.9) this.finish(a, 'done')
      if (!bot.players[a.from] && a.status === 'delivering' && now() - (a.offlineSince ||= now()) > 10 * 60000) this.forget(a, `${a.from} left`)
      if (bot.players[a.from]) a.offlineSince = 0
    } else {
      this.next()
    }
  }

  /** Pick the next remembered task, favouring people we like. */
  next () {
    if (this.active()) return
    const { social } = this.agent
    const t = this.queued().sort((a, b) => (b.salience + social.profile(b.from).affinity / 200) - (a.salience + social.profile(a.from).affinity / 200))[0]
    if (t) {
      this.agent.memory.addEvent('task', `You're getting to what ${t.from} asked earlier: ${t.description}`)
      this.start(t)
    }
  }

  /** Something big happened (death, a fight, a new request): memory of plans gets shakier. */
  distract (amount) {
    const f = this.personality.forgetfulness ?? 0.3
    for (const t of this.tasks) t.salience -= amount * f
  }

  /** Stop: hand over what we have, or give up if nothing. */
  wrapUp (t, reason) {
    t.partialReason = reason
    if (['gather', 'craft'].includes(t.kind)) {
      const have = Math.min(this.progress(t) - t.delivered, this.countItem(t.item))
      if (have > 0) {
        t.commitCount = Math.min(t.commitCount, t.delivered + have)
        t.status = 'delivering'
        return
      }
    }
    if (t.delivered > 0 || (t.kind === 'protect' && now() - t.startedAt > 60000)) return this.finish(t, 'partial')
    return this.finish(t, 'abandoned')
  }

  finish (t, status) {
    const { social, memory, reactor, emotions, log } = this.agent
    t.status = status
    t.finishedAt = now()
    this.tasks = this.tasks.filter((x) => x !== t)
    this.history.push(t)
    if (this.history.length > 25) this.history.shift()
    log.info(`Task #${t.id} (${t.description}) for ${t.from}: ${status}${t.partialReason ? ` — ${t.partialReason}` : ''}`)
    const data = { player: t.from, task: t.description, item: t.item, count: t.count, done: t.delivered || this.progress(t), reason: t.partialReason || '' }
    if (status === 'done') {
      memory.addEvent('task', `You finished ${t.description} for ${t.from}.`)
      social.adjustAffinity(t.from, 1, `you did ${t.description} for them`, { quiet: true })
      emotions.stimulate({ joy: 0.1 })
      reactor?.trigger('taskDone', data)
    } else if (status === 'partial') {
      memory.addEvent('task', `You only partly did ${t.description} for ${t.from} (${t.partialReason}).`)
      reactor?.trigger('taskPartial', data)
    } else if (status === 'abandoned' || status === 'failed') {
      memory.addEvent('task', `You gave up on ${t.description} for ${t.from} (${t.partialReason || 'it didn\'t work out'}).`)
      reactor?.trigger('taskAbandoned', data)
    }
    this.agent.learning?.markDirty()
    this.next()
  }

  /** Forgotten tasks vanish from the prompt — until the player brings them up. */
  forget (t, why) {
    t.status = 'forgotten'
    t.forgottenAt = now()
    t.forgotWhy = why
    this.tasks = this.tasks.filter((x) => x !== t)
    this.history.push(t)
    if (this.history.length > 25) this.history.shift()
    this.agent.log.info(`Forgot task #${t.id} (${t.description}) for ${t.from} — ${why}`)
    this.agent.learning?.markDirty()
  }

  /** The player reminded us. Bring it back (sheepishly). */
  recall (from) {
    const t = [...this.history].reverse().find((x) => x.status === 'forgotten' && x.from.toLowerCase() === from.toLowerCase() && now() - x.forgottenAt < 6 * 3600000)
    if (t) {
      this.history = this.history.filter((x) => x !== t)
      t.status = 'queued'
      t.salience = 1
      this.tasks.push(t)
      this.agent.memory.addEvent('task', `${from} reminded you about ${t.description} — you had completely forgotten.`)
      this.agent.emotions.stimulate({ surprise: 0.15, sadness: 0.05 })
      this.next()
      return t
    }
    // Not forgotten, just pending: the reminder makes it stick.
    const pending = this.tasks.find((x) => x.from.toLowerCase() === from.toLowerCase())
    if (pending) pending.salience = Math.min(1.2, pending.salience + 0.3)
    return null
  }

  // -------------------------------------------------------------------------
  // Driving the work
  // -------------------------------------------------------------------------

  /**
   * An action the Brain should run for the current task without asking the LLM
   * (deliveries, coming over, following). Null means "let the LLM work on it".
   */
  nextForcedAction () {
    const t = this.active()
    if (!t) return null
    const { bot } = this.agent
    const online = Boolean(bot.players[t.from])
    if (t.attempts >= 3) { this.wrapUp(t, 'it kept not working'); return null }

    if (['gather', 'craft'].includes(t.kind) && t.status === 'active' && this.progress(t) >= t.commitCount) t.status = 'delivering'
    if (t.status === 'delivering' || t.kind === 'give_item') {
      if (!online) return null
      const owed = t.commitCount - t.delivered
      const have = this.countItem(t.item)
      if (owed <= 0 || have <= 0) { this.finish(t, t.delivered >= t.count ? 'done' : t.delivered > 0 ? 'partial' : 'abandoned'); return null }
      const item = bot.inventory.items().find((i) => i.name === t.item || i.name.includes(t.item))
      return this.forced(t, `bringing ${t.from} their ${t.item}`, { name: 'giveItem', args: { playerName: t.from, itemName: item?.name || t.item, count: Math.min(owed, have) } })
    }
    if (t.kind === 'come' && online) return this.forced(t, `${t.from} asked me to come over`, { name: 'moveToPlayer', args: { playerName: t.from } })
    if (t.kind === 'follow' && online) return this.forced(t, `following ${t.from} like they asked`, { name: 'followPlayer', args: { playerName: t.from, durationSeconds: 60 } })
    if (t.kind === 'protect') {
      const e = bot.players[this.playerName(t.target)]?.entity
      if (e && bot.entity && e.position.distanceTo(bot.entity.position) > 10) {
        return this.forced(t, `staying close to ${t.target} to protect them`, { name: 'followPlayer', args: { playerName: this.playerName(t.target), durationSeconds: 30 } }, false)
      }
    }
    if (t.kind === 'attack') {
      const name = this.playerName(t.target)
      const e = bot.players[name]?.entity || Object.values(bot.entities).find((x) => x.name === normItem(t.target) && x.position.distanceTo(bot.entity.position) < 24)
      if (e) return this.forced(t, `going after ${t.target} for ${t.from}`, { name: 'attackTarget', args: { entityId: e.id, maxSeconds: 40, sparring: t.sparring } })
    }
    return null
  }

  forced (t, thought, action, counts = true) {
    if (counts) t.attempts++
    return { source: 'task', taskId: t.id, thought, emotion: 'focused', action }
  }

  /** Results of actions that can complete tasks. */
  onActionResult (name, args, result) {
    const t = this.active()
    if (!t) return
    if (result.ok) t.lastProgressAt = now()
    if (name === 'moveToPlayer' && t.kind === 'come' && result.ok && args.playerName?.toLowerCase() === t.from.toLowerCase()) return this.finish(t, 'done')
    if (name === 'followPlayer' && t.kind === 'follow' && result.ok) return this.finish(t, 'done')
  }

  onGave (player, item, count) {
    const t = this.active()
    if (!t || t.from.toLowerCase() !== player.toLowerCase()) return
    if (t.item && !item.includes(t.item) && !t.item.includes(item)) return
    t.delivered += count
    t.attempts = 0
    if (t.delivered >= t.commitCount) this.finish(t, t.delivered >= t.count ? 'done' : 'partial')
  }

  onFightEnded (d) {
    const t = this.active()
    const label = String(d.label).toLowerCase()
    if (!t || t.kind !== 'attack' || (label !== this.playerName(t.target).toLowerCase() && label !== normItem(t.target))) return
    if (d.outcome === 'win') this.finish(t, 'done')
    else if (d.outcome === 'fled' || d.outcome === 'loss') { t.partialReason = `${t.target} was too strong`; this.finish(t, 'failed') }
  }

  onDeath () {
    this.distract(0.5)
    const a = this.active()
    const f = this.personality.forgetfulness ?? 0.3
    if (a && this.cfg.forgetting && Math.random() < f * 0.5) this.forget(a, 'died and lost track')
  }

  /** The LLM's own call on non-measurable tasks ("done", or "I'd rather do something else"). */
  onLlmUpdate (update) {
    const t = this.active()
    if (!t || !update?.status || update.status === 'none' || update.status === 'working') return
    if (update.status === 'done') return this.finish(t, ['gather', 'craft', 'give_item'].includes(t.kind) ? 'partial' : 'done')
    if (update.status === 'gave_up') this.wrapUp(t, update.note || 'you had other things you wanted to do')
  }

  /** May we fight this player because of a task (requested fight, or they attacked someone we protect)? */
  mayFight (name) {
    const n = String(name).toLowerCase()
    const t = this.active()
    if (t?.kind === 'attack' && this.playerName(t.target).toLowerCase() === n) return true
    const alert = this.agent.protectAlert
    return Boolean(alert && alert.attacker.toLowerCase() === n && now() - alert.at < 30000)
  }

  isProtecting (name) {
    return this.tasks.some((t) => t.kind === 'protect' && t.status === 'active' && t.target.toLowerCase() === String(name).toLowerCase())
  }

  // -------------------------------------------------------------------------
  // Prompt summaries
  // -------------------------------------------------------------------------

  /** For the decision prompt. */
  statusForPrompt () {
    const t = this.active()
    const out = { task: null, queuedTasks: this.queued().map((q) => `${q.from}: ${q.description} (asked ${Math.round((now() - q.createdAt) / 60000)}m ago)`) }
    if (t) {
      out.task = {
        for: t.from,
        what: t.description,
        kind: t.kind,
        ...(t.item ? { item: t.item } : {}),
        ...(t.target && t.target !== t.from ? { target: t.target } : {}),
        ...(['gather', 'craft'].includes(t.kind) ? { progress: `${this.progress(t)}/${t.commitCount}` } : {}),
        ...(t.commitCount < t.count ? { note: `they asked for ${t.count}, you only agreed to ${t.commitCount}` } : {}),
        patienceLeftMinutes: Math.max(0, Math.round((t.budgetMs - (now() - t.startedAt)) / 60000)),
        ...(t.status === 'delivering' ? { delivering: true } : {})
      }
    }
    return out
  }

  /** For replying to a player: what we're doing for them, and what we forgot. */
  aboutPlayer (name) {
    const n = name.toLowerCase()
    const lines = this.tasks.filter((t) => t.from.toLowerCase() === n).map((t) =>
      `- ${t.status === 'queued' ? 'you said you\'d do this later' : 'you are working on this now'}: ${t.description}` +
      (['gather', 'craft'].includes(t.kind) && t.status !== 'queued' ? ` (${this.progress(t)}/${t.commitCount} so far)` : ''))
    const forgotten = this.history.filter((t) => t.status === 'forgotten' && t.from.toLowerCase() === n && now() - t.forgottenAt < 6 * 3600000)
    for (const t of forgotten.slice(-2)) lines.push(`- (you had completely forgotten about this until it comes up) ${t.description}`)
    const recent = this.history.filter((t) => t.from.toLowerCase() === n && ['done', 'partial', 'abandoned', 'failed'].includes(t.status) && now() - t.finishedAt < 3600000)
    for (const t of recent.slice(-2)) lines.push(`- earlier you ${t.status === 'done' ? 'finished' : t.status === 'partial' ? 'partly did' : 'gave up on'}: ${t.description}`)
    return lines.join('\n')
  }

  toJSON () {
    return { tasks: this.tasks, history: this.history.slice(-25) }
  }
}

module.exports = { TaskManager, KINDS, EFFORTS, RISKS }
