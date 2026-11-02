'use strict'

/**
 * memory.js — long-term memory and per-player chat history.
 *
 * Separate from `Memory` in index.js (the short, in-session log). This is what the bot keeps across
 * sessions in its save file (brain.json, one per profile): valuable memories with an importance, and
 * the last lines said with each player. Kept even when `intelligence.learn` is off (that only stops
 * skill growth); `memory.enabled: false` turns it off completely.
 */

const KINDS = ['event', 'person', 'place', 'fact', 'feeling']
// Which short-term events are worth keeping, and how much.
const EVENT_IMPORTANCE = { respawn: 9, promise: 7, gave: 6, stolen: 7, truce: 6, trust: 6, fight: 6, build: 5, task: 4, learned: 5, goal: 5, suspicious: 5, refused: 3, liking: 4 }
const STOP = new Set(['the', 'and', 'you', 'your', 'for', 'with', 'that', 'this', 'was', 'are', 'have', 'had', 'not', 'but', 'from', 'they', 'their', 'what', 'when', 'about', 'into', 'then', 'just', 'got', 'get'])
const words = (s) => (String(s).toLowerCase().match(/[a-z0-9_]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w))
const overlap = (a, b) => { const B = new Set(b); return a.filter((w) => B.has(w)).length }

class LongTermMemory {
  /** @param {{ memory?: object, config: object }} agent  @param {object} data persisted { items, chat } */
  constructor (agent, data = {}) {
    this.agent = agent
    this.items = Array.isArray(data.items) ? data.items : [] // { text, kind, importance, people, at, lastRecalled, count }
    this.chat = data.chat && typeof data.chat === 'object' ? data.chat : {} // lower-cased player -> [{ at, self, text }]
    this.lastConsolidateAt = 0
  }

  get cfg () { return this.agent.config.memory || {} }
  get enabled () { return this.cfg.enabled !== false }
  dirty () { this.agent.learning?.markDirty?.() }

  /** Keep a memory (merges with a near-identical one instead of piling up). */
  remember ({ text, kind = 'event', importance = 5, people = [] }) {
    if (!this.enabled) return null
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    if (text.length < 6) return null
    if (!KINDS.includes(kind)) kind = 'event'
    importance = Math.max(1, Math.min(10, Math.round(importance)))
    const w = words(text)
    const dup = this.items.find((m) => { const mw = words(m.text); return w.length && overlap(w, mw) / Math.max(w.length, mw.length) > 0.7 })
    if (dup) {
      dup.importance = Math.max(dup.importance, importance)
      dup.count = (dup.count || 1) + 1
      dup.at = Date.now()
      this.dirty()
      return dup
    }
    const m = { text, kind, importance, people: people.map(String).slice(0, 4), at: Date.now(), lastRecalled: 0, count: 1 }
    this.items.push(m)
    this.prune()
    this.dirty()
    return m
  }

  /** A short-term event that is worth remembering (deaths, gifts, promises, fights, truces...). */
  fromEvent (type, text) {
    const imp = EVENT_IMPORTANCE[type]
    if (!imp) return
    const people = []
    const named = String(text).match(/\b[A-Za-z0-9_]{3,16}\b/g) || []
    for (const n of named) if (this.agent.bot?.players?.[n]) people.push(n)
    this.remember({ text, kind: type === 'respawn' || type === 'fight' ? 'event' : people.length ? 'person' : 'event', importance: imp, people })
  }

  /** How much a memory is worth keeping now: importance, recency (slow decay), how often it came up. */
  score (m, now = Date.now()) {
    const days = (now - m.at) / 86400000
    return m.importance * Math.pow(0.5, days / (m.importance >= 8 ? 60 : 14)) + Math.min(2, (m.count || 1) * 0.3) + (m.lastRecalled && now - m.lastRecalled < 3600000 ? 0.5 : 0)
  }

  prune () {
    const max = this.cfg.max ?? 120
    if (this.items.length <= max) return
    const now = Date.now()
    this.items.sort((a, b) => this.score(b, now) - this.score(a, now))
    this.items.length = max
  }

  /** The few memories that matter for what is going on now (keyword overlap + importance + recency). */
  recall (query, n = 3) {
    if (!this.enabled || !this.items.length) return []
    const q = words(query)
    const now = Date.now()
    const ranked = this.items
      .map((m) => {
        const hits = overlap(q, words(m.text)) + (m.people || []).filter((p) => q.includes(p.toLowerCase())).length * 2
        return { m, hits, s: hits * 2 + this.score(m, now) * 0.25 }
      })
      .filter((x) => x.hits >= 1) // it has to actually relate to what is going on
      .sort((a, b) => b.s - a.s)
      .slice(0, n)
    for (const { m } of ranked) m.lastRecalled = now
    return ranked.map(({ m }) => m.text)
  }

  /** Chat lines per player, saved between sessions (the last ~40 each, 30 players). */
  noteChat (from, text, self = false, to = null) {
    if (!this.enabled) return
    const who = String(self ? to || '' : from).toLowerCase()
    if (!who) return
    const list = (this.chat[who] = this.chat[who] || [])
    list.push({ at: Date.now(), self, text: String(text).slice(0, 160) })
    if (list.length > (this.cfg.chatPerPlayer ?? 40)) list.splice(0, list.length - (this.cfg.chatPerPlayer ?? 40))
    const names = Object.keys(this.chat)
    if (names.length > 30) delete this.chat[names.sort((a, b) => (this.chat[a].at(-1)?.at || 0) - (this.chat[b].at(-1)?.at || 0))[0]]
    this.dirty()
  }

  /** Lines from earlier sessions with this player (older than the current session's log). */
  earlierWith (player, n = 4, sinceMs = 0) {
    const list = this.chat[String(player).toLowerCase()] || []
    return list.filter((l) => l.at < (sinceMs || Date.now())).slice(-n)
  }

  /** What to put in a prompt: memories for this situation. */
  forPrompt (query, n = 3) { return this.recall(query, n) }

  /**
   * Low-priority LLM pass: what from the last few minutes is worth remembering long-term?
   * Rate-limited, never blocks playing or chatting.
   */
  async consolidate (llm, priority) {
    const a = this.agent
    if (!this.enabled || this.cfg.consolidate === false || Date.now() - this.lastConsolidateAt < 8 * 60000) return 0
    const recent = (a.memory?.events || []).filter((e) => e.at > this.lastConsolidateAt).slice(-10)
    if (recent.length < 3) return 0
    this.lastConsolidateAt = Date.now()
    const out = await llm.chat([
      { role: 'system', content: 'You keep the long-term memory of a Minecraft player. From the recent events, pick up to 2 things worth remembering weeks from now (people, promises, places, lessons, big moments). Skip routine stuff. Respond ONLY with JSON: {"memories":[{"text":"short sentence","kind":"event|person|place|fact|feeling","importance":1-10,"people":["name"]}]}' },
      { role: 'user', content: `Recent events:\n${recent.map((e) => `- ${e.text}`).join('\n')}\nGoal: ${a.memory?.goal || 'none'}` }
    ], { priority, label: 'memory' }).catch(() => null)
    let n = 0
    for (const m of (Array.isArray(out?.memories) ? out.memories : []).slice(0, 2)) if (this.remember(m)) n++
    return n
  }

  toJSON () { return { items: this.items, chat: this.chat } }
}

module.exports = { LongTermMemory, EVENT_IMPORTANCE, KINDS }
