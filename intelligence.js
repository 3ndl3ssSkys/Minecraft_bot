'use strict'

/**
 * intelligence.js — how good a player the bot is.
 *
 * Eight levels, from someone who has never played to someone who exploits
 * every niche mechanic. Skill follows a concave curve — each level is better
 * than the last, but the gains shrink as you go up:
 *
 *   level        skill   (beginning starts low but can learn a lot)
 *   beginning    0.08
 *   simple       0.41
 *   mediocre     0.63
 *   complicated  0.78
 *   advanced     0.87
 *   hardcore     0.93
 *   master       0.97
 *   impossible   1.00
 *
 * Skill is tracked per domain (combat, building, survival, knowledge,
 * senses). With learning on, experience raises a domain's effective level
 * along the same diminishing curve: a beginner can grow into a solid player,
 * a master barely improves, impossible can't.
 *
 * Abilities unlock at levels (a beginner doesn't know about w-tapping), and
 * their execution quality comes from the continuous skill value.
 */

const LEVELS = ['beginning', 'simple', 'mediocre', 'complicated', 'advanced', 'hardcore', 'master', 'impossible']
const LABELS = {
  beginning: 'Beginning', simple: 'Simple', mediocre: 'Mediocre', complicated: 'Complicated',
  advanced: 'Advanced', hardcore: 'Hardcore Player', master: 'Master', impossible: 'Impossible'
}
const DOMAINS = ['combat', 'building', 'survival', 'knowledge', 'senses']

/** Concave-down skill curve over level index 0..7 (fractional levels allowed). */
function skillAt (index) {
  const k = 0.42
  const curve = (1 - Math.exp(-k * index)) / (1 - Math.exp(-k * 7))
  return Math.min(1, 0.08 + 0.92 * Math.max(0, curve))
}

/** How each level thinks and plays — goes into the system prompt. */
const MINDSETS = {
  beginning: 'You are brand new to Minecraft. You only know the very basics (punch trees, place blocks). You don\'t know most recipes, ore levels, mobs or mechanics yet: you figure things out by trying, watching other players and asking. You make beginner mistakes unless you\'ve learned better (see "What you\'ve learned").',
  simple: 'You\'ve played a little: wood → tools, eat when hungry, sleep at night, avoid creepers. Anything beyond that you have to work out or ask about.',
  mediocre: 'You\'re an average casual player: you can mine, craft the usual stuff, smelt, farm a bit and fight normal mobs, but you don\'t know advanced tricks.',
  complicated: 'You\'re a decent player: you know most crafting, smelting, enchanting basics, mob behaviours and how to stay safe underground.',
  advanced: 'You\'re an experienced survival player: efficient mining, brewing, enchanting, villager trading, the Nether, and solid combat habits.',
  hardcore: 'You\'re a hardcore player: you play near-optimally, know PvP mechanics (crits, w-taps, axe vs shield, combos, mace), speedrun-style strategies and how to survive anything.',
  master: 'You know everything the game gives normal players: every recipe, mob, structure, drop, potion and mechanic, and you use them well — including precise mace PvP.',
  impossible: 'You know and exploit extremely niche mechanics: tracking players and mobs by sound and particles, entity tracking through walls, reading terrain and biomes to find structures, eye-of-ender triangulation, pearl tricks. If something is possible in the game, you can do it.'
}

/** Ability unlock levels (index into LEVELS). */
const UNLOCKS = {
  sprint: 1, crit: 1, bow: 1, gaps: 1, strafe: 2, parkour: 2, shieldBlock: 2, crossbow: 2, drinkPotions: 2, mobTactics: 2,
  wtap: 3, axeVsShield: 3, totemSwap: 3, splitChase: 3, combo: 4, throwPotions: 4, undeadAware: 4, preBuffs: 4,
  pearlEscape: 4, cobweb: 5, waterClutch: 5, maceBasic: 5, soundTracking: 5, maceGood: 6, seeThroughWalls: 7
}

const BASE_ONLY = new Set(['maceBasic', 'maceGood', 'seeThroughWalls'])

class Intelligence {
  /**
   * @param {() => object} getConfig returns config.intelligence (read live)
   * @param {object} data persisted { xp: { domain: number } }
   */
  constructor (getConfig, data = {}) {
    this.getConfig = getConfig
    this.xp = { ...Object.fromEntries(DOMAINS.map((d) => [d, 0])), ...(data.xp || {}) }
  }

  get cfg () { return this.getConfig() }
  get name () { return LEVELS.includes(this.cfg.level) ? this.cfg.level : 'mediocre' }
  get label () { return LABELS[this.name] }
  get baseIndex () { return LEVELS.indexOf(this.name) }

  /** Most a domain can grow through learning (in levels). */
  maxGain () {
    if (!this.cfg.learn) return 0
    if (Number.isFinite(this.cfg.maxLearnedLevels)) return this.cfg.maxLearnedLevels
    // Beginners can learn a lot; masters barely improve; impossible is already at the top.
    return [4, 3, 2.5, 2, 1.5, 1, 0.5, 0][this.baseIndex]
  }

  /** Effective (fractional) level for a domain, including what it has learned. */
  level (domain = 'combat') {
    const gain = this.maxGain() * (1 - Math.exp(-(this.xp[domain] || 0) / 40))
    return Math.min(7, this.baseIndex + gain)
  }

  skill (domain = 'combat') { return skillAt(this.level(domain)) }

  /** Can it do this at all yet? (a beginner has never heard of w-tapping) */
  can (ability, domain = 'combat') {
    // Some things depend on what kind of player it IS, not on practice: mace PvP is for
    // hardcore players and up (and only masters do it well); packet tricks are impossible-only.
    if (BASE_ONLY.has(ability)) return this.baseIndex >= UNLOCKS[ability]
    return this.level(domain) >= (UNLOCKS[ability] ?? 0)
  }

  addXp (domain, amount) {
    if (!this.cfg.learn || !DOMAINS.includes(domain) || !Number.isFinite(amount)) return
    this.xp[domain] = (this.xp[domain] || 0) + amount * (this.cfg.learnRate ?? 1)
  }

  /** Numbers the combat loop uses. */
  combatProfile () {
    const s = this.skill('combat')
    const can = (a) => this.can(a, 'combat')
    return {
      skill: s,
      level: this.level('combat'),
      reactionMs: Math.round(420 - 360 * s), // how long before it reacts to a swing / low health
      aimErrorDeg: 14 * Math.pow(1 - s, 1.3), // bow / throw inaccuracy
      missChance: 0.25 * (1 - s), // flailing swings that don't connect
      cooldownDiscipline: 0.5 + 0.5 * s, // beginners spam-click before the cooldown is back
      critChance: can('crit') ? 0.3 + 0.7 * s : 0,
      maceQuality: can('maceGood') ? 0.9 + 0.1 * s : can('maceBasic') ? 0.45 : 0,
      can
    }
  }

  /** Noticing things: sounds, particles, entities at the edge of vision. */
  attention () {
    return 0.3 + 0.7 * this.skill('senses')
  }

  knowledgeTier () { return Math.floor(this.level('knowledge')) }

  mindset () { return MINDSETS[this.name] }

  describe () {
    const lv = (d) => this.level(d).toFixed(1)
    return `${this.label} (combat ${lv('combat')}, building ${lv('building')}, survival ${lv('survival')}, knowledge ${lv('knowledge')}, senses ${lv('senses')} on a 0-7 scale)`
  }

  toJSON () { return { xp: this.xp } }
}

module.exports = { Intelligence, LEVELS, LABELS, DOMAINS, UNLOCKS, MINDSETS, skillAt }
