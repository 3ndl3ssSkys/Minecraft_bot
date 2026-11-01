'use strict'

/**
 * goals.js — what the bot is working toward, on four levels:
 *
 *   overarching goal   the whole point ("become the best builder on the server")
 *   long-term goals    a few big things that serve it ("build a castle on the hill")
 *   current goal       what it's doing now ("get 64 stone bricks")
 *   steps (subgoals)   how ("craft a stone pickaxe", "mine stone", "smelt it")
 *
 * Any level can be set (config.json, owners in chat) or made up by the bot.
 * Set goals stay until they're done or an owner changes them; the bot's own
 * goals change whenever it changes its mind. Every decision reports progress
 * (step done, goal done, blocked), and something urgent becomes a detour that
 * the set goal waits through. Now and then — or when a goal finishes or gets
 * stuck — a low-priority planner call steps back and revises the whole plan,
 * aiming each level at the one above.
 */

const STATUSES = ['working', 'subgoal_done', 'goal_done', 'blocked', 'new_goal']
const MAX_LONG_TERM = 4
const DETOUR_TAKEOVER_MS = 3 * 60000 // a "detour" this long means it really changed its mind (own goals only)

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160)

/** Do two goal texts mean the same thing? (shared words, ignoring filler) */
function similar (a, b) {
  const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9_]{3,}/g)?.filter((w) => !FILLER.has(w)) || [])
  const A = words(a)
  const B = words(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.min(A.size, B.size) >= 0.5
}
const FILLER = new Set(['the', 'and', 'for', 'some', 'get', 'more', 'with', 'from', 'that', 'this', 'into', 'make', 'go', 'my', 'your'])

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    overarching: { type: 'string' },
    longTerm: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['active', 'done', 'dropped'] } }, required: ['text', 'status'] } },
    current: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    why: { type: 'string' }
  },
  required: ['overarching', 'longTerm', 'current', 'steps', 'why']
}

class Goals {
  /**
   * @param {object} agent the Agent (config, memory, log, llm, personality...)
   * @param {object} data persisted { life, longTerm, current, history, lastConfig }
   */
  constructor (agent, data = {}) {
    this.agent = agent
    this.life = data.life || null // { text, source, fixed }
    this.longTerm = data.longTerm || [] // { id, text, source, fixed, status, at }
    this.current = data.current || null // { text, source, fixed, parent, steps: [{ text, done }], now, detour, blocked, at }
    this.history = data.history || [] // { text, status, at }
    this.nextId = Math.max(0, ...this.longTerm.map((g) => g.id)) + 1
    this.lastPlanAt = 0
    this.planning = false
    this.planWanted = null
    this.applyConfig(data.lastConfig)
  }

  get cfg () { return this.agent.config.goals }

  /** Goals written in config.json. They win over saved ones when the config changes. */
  applyConfig (last = null) {
    const c = this.cfg
    const now = JSON.stringify({ o: c.overarching, l: c.longTerm, c: c.current })
    this.lastConfig = now
    if (now === last) return // unchanged since last run: keep how the plan has evolved
    if (clean(c.overarching)) this.life = { text: clean(c.overarching), source: 'config', fixed: true }
    for (const text of c.longTerm || []) {
      if (!this.longTerm.some((g) => similar(g.text, text))) this.addLongTerm(text, 'config')
    }
    if (clean(c.current)) this.setCurrent(c.current, 'config')
  }

  // -------------------------------------------------------------------------
  // Changing goals
  // -------------------------------------------------------------------------

  isFixed (source) { return this.cfg.keepSetGoals && source !== 'self' }

  setOverarching (text, source = 'self') {
    const t = clean(text)
    this.life = t ? { text: t, source, fixed: this.isFixed(source) } : null
    this.dirty()
  }

  addLongTerm (text, source = 'self') {
    const t = clean(text)
    if (!t) return null
    const existing = this.longTerm.find((g) => g.status === 'active' && similar(g.text, t))
    if (existing) return existing
    const g = { id: this.nextId++, text: t, source, fixed: this.isFixed(source), status: 'active', at: Date.now() }
    this.longTerm.push(g)
    // Too many: the oldest self-made one makes way.
    const active = this.longTerm.filter((x) => x.status === 'active')
    if (active.length > MAX_LONG_TERM) {
      const drop = active.find((x) => !x.fixed)
      if (drop) this.closeLongTerm(drop, 'dropped')
    }
    this.dirty()
    return g
  }

  closeLongTerm (g, status) {
    g.status = status
    this.history.push({ text: g.text, status, level: 'long-term', at: Date.now() })
    if (this.history.length > 30) this.history.splice(0, this.history.length - 30)
    if (this.current?.parent === g.id) this.current.parent = null
    this.longTerm = this.longTerm.filter((x) => x.status === 'active' || Date.now() - x.at < 3600000)
    this.dirty()
  }

  setCurrent (text, source = 'self', { steps = null, parent = null } = {}) {
    const t = clean(text)
    if (!t) { this.current = null; this.dirty(); return null }
    const keep = this.current && similar(this.current.text, t)
    const parentId = parent ?? (keep ? this.current.parent : this.parentFor(t))
    this.current = {
      text: t,
      source: keep && source === 'self' ? this.current.source : source,
      fixed: keep && source === 'self' ? this.current.fixed : this.isFixed(source),
      parent: parentId,
      steps: steps ? steps.map((s) => ({ text: clean(s), done: false })).filter((s) => s.text) : (keep ? this.current.steps : []),
      now: keep ? this.current.now : null,
      detour: null,
      blocked: 0,
      at: keep ? this.current.at : Date.now()
    }
    if (this.current.now === null && this.current.steps.length) this.current.now = 0
    this.dirty()
    return this.current
  }

  /** The long-term goal a current goal most likely serves. */
  parentFor (text) {
    const active = this.longTerm.filter((g) => g.status === 'active')
    return (active.find((g) => similar(g.text, text)) || active[0])?.id ?? null
  }

  finishCurrent (status = 'done') {
    const c = this.current
    if (!c) return
    this.history.push({ text: c.text, status, level: 'goal', at: Date.now() })
    if (this.history.length > 30) this.history.splice(0, this.history.length - 30)
    this.agent.memory.addEvent('goal', status === 'done' ? `You finished your goal: ${c.text}.` : `You gave up on your goal: ${c.text}.`)
    if (status === 'done') this.agent.emotions?.stimulate({ joy: 0.12, boredom: -0.1 }, `you finished ${c.text}`)
    this.current = null
    this.want(`just ${status === 'done' ? 'finished' : 'gave up on'} "${c.text}"`)
    this.dirty()
  }

  setSteps (steps) {
    if (!this.current) return
    this.current.steps = steps.map((s) => ({ text: clean(s), done: false })).filter((s) => s.text)
    this.current.now = this.current.steps.length ? 0 : null
    this.dirty()
  }

  /** The step it says it's on now: an existing step, or a new one slotted in before the rest. */
  setStepNow (text) {
    const c = this.current
    const t = clean(text)
    if (!c || !t || similar(t, c.text)) return
    let i = c.steps.findIndex((s) => !s.done && similar(s.text, t))
    if (i === -1) {
      const firstOpen = c.steps.findIndex((s) => !s.done)
      i = firstOpen === -1 ? c.steps.length : firstOpen
      c.steps.splice(i, 0, { text: t, done: false })
      if (c.steps.length > 8) c.steps.splice(c.steps.findIndex((s) => s.done), 1)
    }
    c.now = i
  }

  stepDone (text) {
    const c = this.current
    if (!c) return
    let i = text ? c.steps.findIndex((s) => !s.done && similar(s.text, text)) : -1
    if (i === -1) i = c.now ?? -1
    if (i === -1 && clean(text)) { c.steps.push({ text: clean(text), done: true }); return }
    if (c.steps[i]) c.steps[i].done = true
    const next = c.steps.findIndex((s) => !s.done)
    c.now = next === -1 ? null : next
    if (next === -1 && c.steps.length) this.want(`every step of "${c.text}" is done`)
  }

  /**
   * Progress from a decision: { goal, subgoal, goalStatus }.
   * Another goal while one is under way is a detour (eat, flee, help someone) and the plan
   * waits. Its own goals it can drop by saying new_goal, or by staying on the detour for a
   * few minutes; a set goal only an owner or finishing it can end.
   */
  onDecision ({ goal, subgoal, goalStatus } = {}) {
    const g = clean(goal)
    const sub = clean(subgoal)
    const status = STATUSES.includes(goalStatus) ? goalStatus : 'working'
    let c = this.current

    if (status === 'goal_done' && c) {
      if (c.detour && !similar(g, c.text)) { c.detour = null; return } // done with the detour: back to the real goal
      this.finishCurrent('done')
      return
    }
    if (g && (!c || !similar(g, c.text))) {
      const underWay = c && (c.fixed || c.steps.some((s) => !s.done))
      const changedMind = !c?.fixed && (status === 'new_goal' || !underWay ||
        (c.detour && similar(c.detour, g) && Date.now() - c.detourAt > DETOUR_TAKEOVER_MS))
      if (changedMind) {
        if (c) this.history.push({ text: c.text, status: 'changed', level: 'goal', at: Date.now() })
        c = this.setCurrent(g, 'self')
      } else if (!c.detour || !similar(c.detour, g)) {
        c.detour = g // something comes first; the plan waits
        c.detourAt = Date.now()
      }
    } else if (c?.detour && g && similar(g, c.text)) {
      c.detour = null
    }
    if (!c) return
    if (status === 'subgoal_done') this.stepDone(sub)
    else if (sub && !c.detour) this.setStepNow(sub)
    if (status === 'blocked') {
      c.blocked = (c.blocked || 0) + 1
      if (c.blocked >= 2) this.want(`stuck on "${c.text}"${sub ? ` (at: ${sub})` : ''}`)
    } else if (status !== 'working') {
      c.blocked = 0
    }
  }

  want (reason) { this.planWanted = reason }

  dirty () { this.agent.learning?.markDirty() }

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  /** Why it should step back and plan now (or null). */
  needsPlan () {
    const c = this.cfg
    if (!c.plan || this.planning || Date.now() - this.lastPlanAt < 45000) return null
    if (this.planWanted) return this.planWanted
    if (c.selfDirected && !this.life) return "you don't have an overall goal yet"
    if (c.selfDirected && !this.longTerm.some((g) => g.status === 'active')) return 'you have nothing big to work toward'
    if (!this.current) return 'you have no current goal'
    if (this.current && !this.current.steps.length && c.selfDirected) return `you haven't worked out the steps for "${this.current.text}"`
    if (c.replanMinutes > 0 && Date.now() - this.lastPlanAt > c.replanMinutes * 60000) return 'time to check your plans still make sense'
    return null
  }

  /** Plan in the background if it's time; never blocks the caller. */
  maybePlan () {
    const reason = this.needsPlan()
    if (reason) this.plan(reason).catch((err) => this.agent.log.debug(`planning failed: ${err.message}`))
  }

  async plan (reason) {
    const agent = this.agent
    const { personality, config, memory } = agent
    this.planning = true
    this.lastPlanAt = Date.now()
    this.planWanted = null
    try {
      const self = this.cfg.selfDirected
      const tag = (x) => x.fixed ? ` [set by ${x.source === 'config' ? 'your config' : x.source} — keep it]` : ''
      const tree = [
        `Overall goal: ${this.life ? this.life.text + tag(this.life) : '(none)'}`,
        `Long-term goals:${this.longTerm.filter((g) => g.status === 'active').map((g) => `\n- ${g.text}${tag(g)}`).join('') || ' (none)'}`,
        `Current goal: ${this.current ? this.current.text + tag(this.current) : '(none)'}`,
        this.current?.steps.length ? `Steps: ${this.current.steps.map((s) => `${s.done ? '[done]' : '[ ]'} ${s.text}`).join('; ')}` : null,
        this.history.length ? `Recently: ${this.history.slice(-5).map((h) => `${h.status} "${h.text}"`).join(', ')}` : null
      ].filter(Boolean).join('\n')
      const m = config.mind
      const system = `You are ${personality.name || agent.bot.username}, a Minecraft player (${agent.intelligence.label} skill) planning what you want to do. ${personality.description || ''}
Ambitions: ${(personality.ambitions || []).join(', ') || 'none in particular'}. Likes: ${(personality.likes || []).join(', ') || '-'}.${m.thinkLike ? ` You think like ${m.thinkLike}.` : ''}${m.playstyle && m.playstyle !== 'balanced' ? ` Playstyle: ${m.playstyle}.` : ''}${m.instructions?.length ? ` Always: ${m.instructions.join('; ')}.` : ''}

Plan on four levels, each serving the one above: one overall goal (the point of it all for you), up to ${MAX_LONG_TERM} long-term goals, one current goal you can start now, and 2-6 concrete steps for it (things you can actually do in the game, in order).
- Goals marked "keep it" were set for you: keep them exactly (you may mark one "done" only if it really is finished).${self ? '\n- Everything else is yours: keep what still makes sense, change what does not, add what you want. Be specific and realistic for your skill and what you have.' : '\n- Do not invent new long-term or overall goals; only plan the current goal and steps toward what you were given.'}
- Mark finished long-term goals "done" and ones you no longer want "dropped".
- If a current goal is marked "keep it" and is not finished, keep it as the current goal.
- "why": one short sentence, in your own voice, about your thinking.
Respond with ONLY JSON: {"overarching": "...", "longTerm": [{"text": "...", "status": "active|done|dropped"}], "current": "...", "steps": ["..."], "why": "..."}`
      const s = agent.perception?.latest
      const user = `Why you're planning now: ${reason}.
${tree}

Where you are: ${s ? `${s.self.dimension}, ${s.world.phase}, health ${s.self.health}/20, food ${s.self.food}/20. Inventory: ${Object.entries(s.inventory.items).slice(0, 14).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'}.` : 'unknown'}
${s?.status.task ? `You're doing something for ${s.status.task.for}: ${s.status.task.what}.\n` : ''}Recent events: ${memory.events.slice(-6).map((e) => e.text).join(' ') || 'none'}`
      const out = await agent.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
        { schema: PLAN_SCHEMA, priority: 4, label: 'plan', temperature: 0.6 })
      this.applyPlan(out)
    } finally {
      this.planning = false
    }
  }

  /** Merge a plan from the LLM, respecting goals that were set. */
  applyPlan (out) {
    const self = this.cfg.selfDirected
    if (self && clean(out.overarching) && !this.life?.fixed) {
      if (!this.life || !similar(this.life.text, out.overarching)) this.setOverarching(out.overarching, 'self')
    }
    const proposed = Array.isArray(out.longTerm) ? out.longTerm.filter((g) => clean(g?.text)) : []
    for (const g of this.longTerm.filter((x) => x.status === 'active')) {
      const match = proposed.find((p) => similar(p.text, g.text))
      if (match?.status === 'done') this.closeLongTerm(g, 'done')
      else if (!g.fixed && (match?.status === 'dropped' || (!match && self && proposed.length))) this.closeLongTerm(g, 'dropped')
    }
    if (self) {
      for (const p of proposed) {
        if (p.status === 'active' && !this.longTerm.some((g) => g.status === 'active' && similar(g.text, p.text))) this.addLongTerm(p.text, 'self')
      }
    }
    const steps = Array.isArray(out.steps) ? out.steps.map(clean).filter(Boolean).slice(0, 6) : []
    const cur = clean(out.current)
    if (this.current?.fixed && cur && !similar(cur, this.current.text)) {
      // Keep the set goal; its steps only if the plan was about it.
    } else if (cur && (!this.current || !similar(cur, this.current.text))) {
      this.setCurrent(cur, 'self', { steps })
    } else if (this.current && steps.length) {
      const done = this.current.steps.filter((s) => s.done)
      this.current.steps = [...done, ...steps.filter((t) => !done.some((d) => similar(d.text, t))).map((t) => ({ text: t, done: false }))]
      const next = this.current.steps.findIndex((s) => !s.done)
      this.current.now = next === -1 ? null : next
    }
    if (this.current && !this.longTerm.some((g) => g.id === this.current.parent && g.status === 'active')) this.current.parent = this.parentFor(this.current.text)
    if (clean(out.why)) this.agent.memory.addEvent('plan', `You thought about your plans: ${clean(out.why)}`)
    this.agent.log.info(`Plan: ${this.oneLine()}`)
    this.dirty()
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** What it's actually doing right now (a detour, or the goal). */
  currentText () { return this.current?.detour || this.current?.text || '' }

  currentSource () { return this.current ? (this.current.detour ? 'self' : this.current.source) : '' }

  /** For the decision prompt (status.goals). */
  forPrompt () {
    const who = (x) => x.source === 'self' ? 'your own idea' : x.source === 'config' ? 'set for you' : `set by ${x.source}`
    const c = this.current
    const out = {
      overarching: this.life ? `${this.life.text} (${who(this.life)})` : null,
      workingToward: this.longTerm.filter((g) => g.status === 'active').map((g) => `${g.text} (${who(g)})`),
      current: c ? `${c.text} (${who(c)})` : null
    }
    if (c?.detour) out.detour = `${c.detour} — first, then back to the current goal`
    if (c?.steps.length) out.steps = c.steps.map((s, i) => `${s.done ? '[x]' : i === c.now ? '[>]' : '[ ]'} ${s.text}`)
    const parent = c && this.longTerm.find((g) => g.id === c.parent)
    if (parent) out.currentGoalServes = parent.text
    if (this.history.length) out.recentlyFinished = this.history.filter((h) => h.status === 'done').slice(-3).map((h) => h.text)
    return out
  }

  oneLine () {
    const parts = []
    if (this.life) parts.push(`overall: ${this.life.text}`)
    const lt = this.longTerm.filter((g) => g.status === 'active')
    if (lt.length) parts.push(`toward: ${lt.map((g) => g.text).join(' / ')}`)
    if (this.current) parts.push(`now: ${this.current.text}${this.current.detour ? ` (detour: ${this.current.detour})` : ''}`)
    const step = this.current?.steps[this.current.now]
    if (step) parts.push(`step: ${step.text}`)
    return parts.join(' | ') || 'no goals'
  }

  /** Numbered list for !goals. */
  describe () {
    const lt = this.longTerm.filter((g) => g.status === 'active')
    const c = this.current
    const lines = [
      `overall: ${this.life?.text || 'none'}`,
      `long-term: ${lt.map((g, i) => `${i + 1}) ${g.text}`).join(' ') || 'none'}`,
      `now: ${c ? c.text : 'none'}${c?.detour ? ` (detour: ${c.detour})` : ''}`
    ]
    if (c?.steps.length) lines.push(`steps: ${c.steps.map((s, i) => `${s.done ? 'x' : i === c.now ? '>' : '-'} ${s.text}`).join(', ')}`)
    return lines
  }

  activeLongTerm (n) { return this.longTerm.filter((g) => g.status === 'active')[n - 1] || null }

  toJSON () {
    return { life: this.life, longTerm: this.longTerm, current: this.current, history: this.history, lastConfig: this.lastConfig }
  }
}

module.exports = { Goals, similar, STATUSES, PLAN_SCHEMA }
