'use strict'

/**
 * learning.js — what the bot learns from playing, kept across restarts.
 *
 *  - CombatLearner : tries different fighting styles and keeps score of which
 *                    ones win against each kind of opponent (a multi-armed
 *                    bandit, epsilon-greedy). It also tunes when to retreat.
 *  - MovementLearner: remembers where it died or got stuck ("danger zones"),
 *                    steers the pathfinder away from them, and turns risky
 *                    parkour off for a while if it keeps hurting itself.
 *  - LessonBook    : short, LLM-written lessons from notable experiences
 *                    ("creepers explode if you stand still near them"),
 *                    shown in every decision prompt.
 *  - Store         : JSON persistence (data/brain.json by default) for all of
 *                    the above plus player relationships and runtime settings.
 */

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

class Store {
  constructor (file, log) {
    this.file = path.isAbsolute(file) ? file : path.join(__dirname, file)
    this.log = log
    this.data = {}
    try {
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      // Keep the broken file for inspection rather than overwriting it silently.
      const backup = `${this.file}.corrupt-${Date.now()}`
      try { fs.renameSync(this.file, backup) } catch { /* ignore */ }
      log.warn(`Could not read ${this.file} (${err.message}); starting fresh. Old file kept as ${backup}`)
      this.data = {}
    }
  }

  /** Atomic write: temp file + rename, so a crash never leaves half a file. */
  save (data) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1))
      fs.renameSync(tmp, this.file)
    } catch (err) {
      this.log.warn(`Could not save learned data: ${err.message}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** Fighting styles the bot can choose between. All tactics live in actions.js. */
const COMBAT_STYLES = {
  aggressive: { crit: true, wtap: true, strafe: false, shield: false, retreatHealth: 4, desc: 'rush in, jump-crit and sprint-reset every hit' },
  balanced: { crit: true, wtap: true, strafe: true, shield: true, retreatHealth: 7, desc: 'crit when possible, strafe, block with shield' },
  cautious: { crit: false, wtap: false, strafe: true, shield: true, retreatHealth: 10, desc: 'strafe and block, take safe hits only' },
  hitAndRun: { crit: false, wtap: true, strafe: true, shield: false, retreatHealth: 8, backOff: true, desc: 'hit once then back off out of reach' },
  comboAxe: { crit: true, wtap: true, strafe: true, shield: true, combo: true, retreatHealth: 7, desc: 'heavy axe crit, then quick sword hits; axe on raised shields' },
  ranged: { crit: true, wtap: false, strafe: true, shield: true, ranged: true, retreatHealth: 8, desc: 'bow/crossbow at range, sword when they close in' },
  mace: { crit: true, wtap: false, strafe: false, shield: false, mace: true, retreatHealth: 6, desc: 'wind charge launch and mace smash attacks' }
}

class CombatLearner {
  constructor (data = {}, getSettings) {
    this.stats = data.stats || {} // opponentKey -> style -> { n, reward, wins, losses }
    this.retreatAdjust = data.retreatAdjust || {} // opponentKey -> +/- health
    this.history = data.history || [] // last fights for prompts
    this.getSettings = getSettings
  }

  /** "player:Steve" for a specific player, else the mob type ("zombie"). */
  static keyFor (entity) {
    return entity.type === 'player' ? `player:${entity.username}` : entity.name
  }

  static groupFor (key) {
    return key.startsWith('player:') ? 'player' : key
  }

  /** Pick a style: mostly the best known one, sometimes explore another. */
  chooseStyle (key, { forced, available } = {}) {
    const usable = available?.length ? available : Object.keys(COMBAT_STYLES)
    if (forced && COMBAT_STYLES[forced] && usable.includes(forced)) return this.styleObject(forced, key)
    if (key === 'creeper') return this.styleObject(usable.includes('ranged') ? 'ranged' : 'hitAndRun', key)
    const epsilon = this.getSettings().epsilon
    const names = Object.keys(COMBAT_STYLES).filter((n) => usable.includes(n))
    // Use specific stats when we have them, else the group (all players / this mob type).
    const table = this.mergedStats(key)
    const untried = names.filter((n) => !table[n]?.n)
    let pick
    if (untried.length && Math.random() < Math.min(0.5, epsilon * 2)) pick = untried[Math.floor(Math.random() * untried.length)]
    else if (Math.random() < epsilon) pick = names[Math.floor(Math.random() * names.length)]
    else pick = names.reduce((best, n) => (this.avg(table[n]) > this.avg(table[best]) ? n : best), names.includes('balanced') ? 'balanced' : names[0])
    return this.styleObject(pick, key)
  }

  styleObject (name, key) {
    const base = COMBAT_STYLES[name]
    const adj = this.retreatAdjust[key] ?? this.retreatAdjust[CombatLearner.groupFor(key)] ?? 0
    return { name, ...base, retreatHealth: Math.max(3, Math.min(14, base.retreatHealth + adj)) }
  }

  avg (s) {
    // Optimistic prior so a style isn't abandoned after one unlucky fight.
    return s?.n ? (s.reward + 0.5) / (s.n + 1) : 0.5
  }

  mergedStats (key) {
    const specific = this.stats[key] || {}
    const group = this.stats[CombatLearner.groupFor(key)] || {}
    const out = {}
    for (const n of Object.keys(COMBAT_STYLES)) {
      const a = specific[n]; const b = group[n]
      if (a?.n >= 2) out[n] = a
      else if (a || b) out[n] = { n: (a?.n || 0) + (b?.n || 0), reward: (a?.reward || 0) + (b?.reward || 0) }
    }
    return out
  }

  /**
   * @param {string} key opponent key
   * @param {string} style style name used
   * @param {'win'|'loss'|'fled'|'timeout'|'escaped'} outcome
   * @param {{hitsLanded:number, hitsTaken:number, healthLost:number, durationMs:number}} m
   */
  record (key, style, outcome, m) {
    const base = { win: 1, fled: 0.35, escaped: 0.4, timeout: 0.25, loss: 0 }[outcome] ?? 0.2
    const exchange = Math.max(-1, Math.min(1, ((m.hitsLanded || 0) - (m.hitsTaken || 0)) / 6))
    const reward = Math.max(0, Math.min(1, base + 0.15 * exchange))
    for (const k of new Set([key, CombatLearner.groupFor(key)])) {
      this.stats[k] = this.stats[k] || {}
      const s = (this.stats[k][style] = this.stats[k][style] || { n: 0, reward: 0, wins: 0, losses: 0 })
      s.n++
      s.reward += reward
      if (outcome === 'win') s.wins++
      if (outcome === 'loss') s.losses++
      // Losing badly → retreat earlier next time; winning easily → stay in longer.
      if (outcome === 'loss' || (outcome === 'win' && m.healthLost >= 14)) this.retreatAdjust[k] = Math.min(5, (this.retreatAdjust[k] || 0) + 1)
      else if (outcome === 'win' && m.healthLost <= 4) this.retreatAdjust[k] = Math.max(-3, (this.retreatAdjust[k] || 0) - 0.5)
    }
    this.history.push({ at: Date.now(), key, style, outcome, ...m })
    if (this.history.length > 30) this.history.shift()
  }

  /** e.g. "vs zombie: aggressive works best (5W/1L). vs players: cautious (2W/3L)." */
  summary (limit = 6) {
    const lines = []
    for (const [key, styles] of Object.entries(this.stats)) {
      if (key.startsWith('player:')) continue
      const best = Object.entries(styles).filter(([, s]) => s.n >= 2).sort((a, b) => this.avg(b[1]) - this.avg(a[1]))[0]
      if (!best) continue
      const [name, s] = best
      lines.push(`vs ${key === 'player' ? 'players' : key}: "${name}" works best (${s.wins}W/${s.losses}L over ${s.n} fights)`)
    }
    return lines.slice(0, limit)
  }

  recordFor (key) {
    const s = this.stats[key]
    if (!s) return null
    const t = Object.values(s).reduce((a, x) => ({ wins: a.wins + x.wins, losses: a.losses + x.losses }), { wins: 0, losses: 0 })
    return t
  }

  toJSON () { return { stats: this.stats, retreatAdjust: this.retreatAdjust, history: this.history } }
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

class MovementLearner {
  constructor (data = {}) {
    this.dangerZones = data.dangerZones || [] // { x, y, z, radius, reason, at, count }
    this.outcomes = data.outcomes || {} // code -> count
    this.parkourFalls = []
    this.parkourDisabledUntil = 0
    this.movements = null
  }

  /** Hook into the pathfinder so it treats danger zones as very expensive. */
  attach (movements) {
    this.movements = movements
    movements.exclusionAreasStep.push((block) => this.costAt(block.position))
    movements.exclusionAreasBreak.push((block) => this.costAt(block.position) / 2)
  }

  costAt (pos) {
    for (const z of this.dangerZones) {
      const dx = pos.x - z.x; const dy = pos.y - z.y; const dz = pos.z - z.z
      if (dx * dx + dy * dy + dz * dz <= z.radius * z.radius) return 50 * Math.min(3, z.count)
    }
    return 0
  }

  addDanger (pos, reason, radius = 3) {
    const p = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
    const existing = this.dangerZones.find((z) => Math.abs(z.x - p.x) + Math.abs(z.y - p.y) + Math.abs(z.z - p.z) <= radius)
    if (existing) {
      existing.count++
      existing.at = Date.now()
      existing.reason = reason
    } else {
      this.dangerZones.push({ ...p, radius, reason, at: Date.now(), count: 1 })
      if (this.dangerZones.length > 60) this.dangerZones.shift()
    }
  }

  /** Called after every movement-type action. */
  recordResult (result, pos) {
    if (!result.code) return
    this.outcomes[result.code] = (this.outcomes[result.code] || 0) + 1
    if (result.code === 'STUCK' && pos) this.addDanger(pos, 'got stuck here', 2)
  }

  /** Fall damage while pathing (no attacker): parkour probably went wrong. */
  recordFall () {
    this.parkourFalls = this.parkourFalls.filter((t) => Date.now() - t < 10 * 60000)
    this.parkourFalls.push(Date.now())
    if (this.parkourFalls.length >= 3 && this.movements?.allowParkour) {
      this.movements.allowParkour = false
      this.parkourDisabledUntil = Date.now() + 20 * 60000
      this.parkourFalls = []
      return true
    }
    return false
  }

  /** Re-enable parkour after the cool-off. */
  tick (allowedByConfig) {
    if (this.parkourDisabledUntil && Date.now() > this.parkourDisabledUntil && this.movements) {
      this.movements.allowParkour = allowedByConfig
      this.parkourDisabledUntil = 0
    }
  }

  nearbyDangers (pos, radius = 48) {
    return this.dangerZones
      .filter((z) => Math.abs(z.x - pos.x) <= radius && Math.abs(z.z - pos.z) <= radius && Math.abs(z.y - pos.y) <= 24)
      .slice(-5)
      .map((z) => ({ x: z.x, y: z.y, z: z.z, reason: z.reason, times: z.count }))
  }

  toJSON () { return { dangerZones: this.dangerZones, outcomes: this.outcomes } }
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]+/g) || [])
function similarity (a, b) {
  const A = words(a); const B = words(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

class LessonBook {
  constructor (data = {}, getSettings) {
    this.lessons = data.lessons || [] // { text, at, times }
    this.getSettings = getSettings
  }

  add (text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (clean.length < 8) return false
    const dup = this.lessons.find((l) => similarity(l.text, clean) > 0.55)
    if (dup) { dup.times++; dup.at = Date.now(); return false }
    this.lessons.push({ text: clean, at: Date.now(), times: 1 })
    // Keep the most reinforced and most recent lessons.
    const max = this.getSettings().maxLessons
    if (this.lessons.length > max) {
      this.lessons.sort((a, b) => b.times - a.times || b.at - a.at)
      this.lessons.length = max
    }
    return true
  }

  top (n = 8) {
    return [...this.lessons].sort((a, b) => b.times - a.times || b.at - a.at).slice(0, n).map((l) => l.text)
  }

  toJSON () { return { lessons: this.lessons } }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

class Learning {
  /**
   * @param {object} agent Agent (config, log, llm, social, emotions...)
   */
  constructor (agent) {
    this.agent = agent
    const cfg = agent.config.learning
    this.store = new Store(cfg.file, agent.log)
    const d = this.store.data
    this.combat = new CombatLearner(d.combat, () => agent.config.learning)
    this.movement = new MovementLearner(d.movement)
    this.lessons = new LessonBook(d.lessons, () => agent.config.learning)
    this.stats = d.stats || { deaths: 0, kills: 0, playTimeMinutes: 0, sessions: 0 }
    this.stats.sessions++
    this.dirty = false
    this.lastReflectAt = 0
    this.timer = setInterval(() => { this.stats.playTimeMinutes += 0.5; if (this.dirty) this.save() }, 30000)
    this.timer.unref?.()
  }

  get data () { return this.store.data }

  markDirty () { this.dirty = true }

  save () {
    const a = this.agent
    this.store.save({
      version: 1,
      savedAt: new Date().toISOString(),
      social: a.social?.toJSON(),
      emotions: a.emotions?.toJSON(),
      tasks: a.tasks?.toJSON(),
      building: a.builder ? { current: a.builder.current, history: a.builder.history.slice(-20) } : undefined,
      containers: a.memory?.containersToJSON?.(),
      obeyPlayers: a.config.obedience?.players,
      combat: this.combat.toJSON(),
      movement: this.movement.toJSON(),
      lessons: this.lessons.toJSON(),
      stats: this.stats,
      admins: a.runtimeAdmins || [],
      settings: a.settingOverrides || {}
    })
    this.dirty = false
  }

  close () {
    clearInterval(this.timer)
    this.save()
  }

  /**
   * Ask the LLM to distil one lesson from an experience. Rate-limited and
   * low priority, so it never gets in the way of playing or chatting.
   */
  async reflect (experience) {
    const cfg = this.agent.config.learning
    if (!cfg.enabled || !cfg.reflect || Date.now() - this.lastReflectAt < 90000) return
    this.lastReflectAt = Date.now()
    const a = this.agent
    const existing = this.lessons.top(10).map((l) => `- ${l}`).join('\n') || '- (none yet)'
    try {
      const out = await a.llm.chat([
        {
          role: 'system',
          content: `You are ${a.personality.name || a.bot.username}, a Minecraft player reflecting on something that just happened.
Write ONE short, practical lesson (max 20 words) you would remember next time — about survival, combat, movement, or how to deal with a specific player.
If it teaches nothing new compared to what you already know, return "".
Respond with ONLY JSON: {"lesson": "..."}`
        },
        { role: 'user', content: `What happened: ${experience}\n\nWhat you already know:\n${existing}` }
      ], { schema: { type: 'object', properties: { lesson: { type: 'string' } }, required: ['lesson'] }, priority: 4, label: 'reflect', temperature: 0.5 })
      if (out.lesson && this.lessons.add(out.lesson)) {
        a.log.info(`Learned: ${out.lesson}`)
        this.markDirty()
      }
    } catch (err) {
      a.log.debug(`reflection failed: ${err.message}`)
    }
  }
}

module.exports = { Learning, CombatLearner, MovementLearner, LessonBook, COMBAT_STYLES }
