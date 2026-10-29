'use strict'

/**
 * emotions.js — a small dimensional emotion model.
 *
 * Instead of a single "mood" label, the bot keeps six core feelings (0..1)
 * that rise when things happen and slowly decay back to the personality's
 * resting temperament. The dominant feeling is turned into a label
 * ("annoyed", "scared", ...) for prompts, and into behaviour modifiers that
 * other systems use (how willing it is to follow instructions, how chatty
 * it is, whether it fights or flees).
 *
 * Stimuli come from everywhere: getting hurt, dying, gifts, insults, broken
 * promises, winning fights, boredom while idle, the LLM's own self-report...
 */

const CORE = ['joy', 'anger', 'fear', 'sadness', 'boredom', 'surprise']

/** Label for a dominant core emotion at a given strength. */
const LABELS = {
  joy: [[0.75, 'excited'], [0.35, 'happy'], [0, 'calm']],
  anger: [[0.6, 'angry'], [0.3, 'frustrated'], [0, 'annoyed']],
  fear: [[0.6, 'scared'], [0, 'nervous']],
  sadness: [[0.5, 'sad'], [0, 'tired']],
  boredom: [[0, 'bored']],
  surprise: [[0, 'surprised']]
}

/** How an LLM-reported label maps back onto the core dimensions. */
const LABEL_TO_CORE = {
  happy: { joy: 0.5 },
  excited: { joy: 0.8, surprise: 0.2 },
  calm: { joy: 0.25 },
  curious: { joy: 0.3, boredom: -0.3 },
  bored: { boredom: 0.6 },
  focused: { boredom: -0.4 },
  proud: { joy: 0.6 },
  amused: { joy: 0.5 },
  annoyed: { anger: 0.35 },
  frustrated: { anger: 0.4, sadness: 0.1 },
  angry: { anger: 0.75 },
  scared: { fear: 0.75 },
  nervous: { fear: 0.4 },
  sad: { sadness: 0.6 },
  tired: { sadness: 0.3, boredom: 0.2 },
  surprised: { surprise: 0.7 },
  confused: { surprise: 0.3, fear: 0.1 },
  determined: { anger: 0.15, fear: -0.2, boredom: -0.4 }
}

const DEFAULT_TEMPERAMENT = { joy: 0.35, anger: 0.05, fear: 0.1, sadness: 0.05, boredom: 0.15, surprise: 0 }

const clamp01 = (v) => Math.max(0, Math.min(1, v))

class EmotionEngine {
  /**
   * @param {() => object} getSettings returns config.emotions (read live so !set works)
   * @param {() => object} getPersonality returns the active personality
   */
  constructor (getSettings, getPersonality) {
    this.getSettings = getSettings
    this.getPersonality = getPersonality
    this.values = { ...this.baseline() }
    this.lastTick = Date.now()
    this.lastCause = null // { text, at } — the most recent thing that moved feelings
  }

  baseline () {
    return { ...DEFAULT_TEMPERAMENT, ...(this.getPersonality().temperament || {}) }
  }

  /** Reset to the resting temperament (e.g. after a personality switch). */
  reset () {
    this.values = { ...this.baseline() }
  }

  /**
   * Push feelings around. `deltas` like { anger: 0.3, fear: 0.1 }.
   * Scaled by global volatility and per-personality sensitivity.
   */
  stimulate (deltas, cause) {
    const s = this.getSettings()
    if (!s.enabled) return
    const sens = this.getPersonality().sensitivity || {}
    for (const [k, d] of Object.entries(deltas)) {
      if (!CORE.includes(k) || !Number.isFinite(d)) continue
      this.values[k] = clamp01(this.values[k] + d * s.volatility * (sens[k] ?? 1))
    }
    // Strong positive feelings push the negative ones down a little, and vice versa.
    if ((deltas.joy || 0) > 0) {
      this.values.sadness = clamp01(this.values.sadness - deltas.joy * 0.3)
      this.values.boredom = clamp01(this.values.boredom - deltas.joy * 0.3)
    }
    if ((deltas.anger || 0) > 0 || (deltas.fear || 0) > 0) {
      this.values.boredom = clamp01(this.values.boredom - 0.2)
      this.values.joy = clamp01(this.values.joy - ((deltas.anger || 0) + (deltas.fear || 0)) * 0.3)
    }
    if (cause) this.lastCause = { text: cause, at: Date.now() }
  }

  /** Blend in the LLM's self-reported emotion (it knows the story, we know the numbers). */
  fromLabel (label, intensity = 5) {
    const map = LABEL_TO_CORE[String(label || '').toLowerCase()]
    if (!map) return
    const weight = 0.25 * (Math.max(1, Math.min(10, intensity)) / 10)
    const deltas = {}
    for (const [k, target] of Object.entries(map)) {
      deltas[k] = target >= 0 ? (target - this.values[k]) * weight * 2 : target * weight
    }
    this.stimulate(deltas)
  }

  /** Set feelings directly to match a label (owner command "!emotion angry 8"). */
  setTo (label, intensity = 7) {
    const map = LABEL_TO_CORE[String(label || '').toLowerCase()]
    if (!map) return false
    const k = Math.max(1, Math.min(10, intensity)) / 10
    this.values = { ...this.baseline() }
    for (const [core, target] of Object.entries(map)) this.values[core] = clamp01(target >= 0 ? Math.max(target, k) : this.values[core] + target)
    this.lastCause = { text: 'you just feel that way', at: Date.now() }
    return true
  }

  /** Decay toward baseline. Call regularly (perception tick). */
  tick () {
    const now = Date.now()
    const minutes = (now - this.lastTick) / 60000
    this.lastTick = now
    const rate = 1 - Math.pow(1 - this.getSettings().decayPerMinute, minutes)
    const base = this.baseline()
    for (const k of CORE) this.values[k] += (base[k] - this.values[k]) * rate
  }

  /** { label, intensity 1..10, core } — honours a !emotion lock. */
  dominant () {
    const s = this.getSettings()
    if (s.lock) return { label: s.lock, intensity: s.lockIntensity || 6, core: { ...this.values }, locked: true }
    const base = this.baseline()
    // Dominance is measured relative to baseline, so a naturally grumpy bot isn't "angry" all day.
    let best = null
    for (const k of CORE) {
      const excess = this.values[k] - base[k] * 0.6
      if (!best || excess > best.excess) best = { k, excess }
    }
    const v = this.values[best.k]
    if (best.excess < 0.12) {
      return { label: this.getPersonality().baselineMood || 'calm', intensity: 3, core: { ...this.values } }
    }
    const label = LABELS[best.k].find(([min]) => v >= min)[1]
    return { label, intensity: Math.max(1, Math.min(10, Math.round(v * 10))), core: { ...this.values } }
  }

  /** Human-readable summary for prompts, e.g. "annoyed (6/10), also a bit scared — because Steve hit you". */
  describe () {
    const d = this.dominant()
    const extras = CORE
      .filter((k) => this.values[k] >= 0.35 && LABELS[k].find(([min]) => this.values[k] >= min)[1] !== d.label)
      .map((k) => `a bit ${LABELS[k].find(([min]) => this.values[k] >= min)[1]}`)
    const cause = this.lastCause && Date.now() - this.lastCause.at < 300000 ? ` — mostly because ${this.lastCause.text}` : ''
    return `${d.label} (${d.intensity}/10)${extras.length ? `, also ${extras.join(' and ')}` : ''}${cause}`
  }

  /** Behaviour modifiers derived from feelings. */
  modifiers () {
    const base = this.baseline()
    const v = this.getSettings().enabled ? this.values : base
    // Only feelings *above* the resting temperament change behaviour, so a calm bot complies at exactly the configured rate.
    const up = (k) => Math.max(0, v[k] - base[k])
    return {
      // multiplier on instruction-following chance (1 at rest)
      compliance: Math.max(0.25, Math.min(1.15, 1 - 0.7 * up('anger') - 0.3 * up('sadness') - 0.2 * up('fear') + 0.15 * up('joy'))),
      // multiplier on chattiness (unprompted messages, reply length)
      talkativeness: Math.max(0.2, Math.min(1.6, 1 + 0.5 * v.joy + 0.3 * v.surprise - 0.5 * v.sadness - 0.3 * v.fear - 0.2 * v.boredom)),
      // >0 means more willing to fight; <0 means prefers to run
      aggression: v.anger - 0.8 * v.fear,
      caution: v.fear
    }
  }

  toJSON () {
    return { values: this.values }
  }

  load (data) {
    if (!data?.values) return
    for (const k of CORE) if (Number.isFinite(data.values[k])) this.values[k] = clamp01(data.values[k])
  }
}

module.exports = { EmotionEngine, CORE, LABEL_TO_CORE }
