'use strict'

/**
 * etiquette.js — being a decent member of a server, the way a sensible player is.
 *
 * Rules it was given
 *   "don't break stuff at spawn", "stop killing my cows", "no pvp", "always close the door": standing rules from chat
 *   (the chat analysis spots them), from signs ("no griefing", "keep out") and from the server's own messages.
 *   Whether it takes a rule on depends on who says it (owner > admin/server > trusted > anyone) and how law-abiding its
 *   personality is (`lawfulness`, 0 = anarchist .. 1 = by the book). Accepted rules are checked before every action,
 *   shown in the prompt, and stop what it's doing if that breaks one.
 *
 * Things it understands without being told (on any server that isn't anarchy, unless it's an anarchist itself)
 *   - a mob trapped in a player-made box or pen is part of a farm (the zombie in an iron farm, cows in a pen)
 *   - named mobs, pets, mobs riding boats or minecarts belong to someone
 *   - villagers, wandering traders and golems are part of the place
 *   - a built-up area (lots of player-made blocks) is someone's town or base: no digging, burning or looting there
 *   - signs that name a place (town hall, spawn, shop, museum...) mark it as public
 *
 * check(action, ctx) → null | { code, message }, for Brain.commonSense.
 */

const { Vec3 } = require('vec3')

const ACTS = ['break', 'place', 'kill', 'take', 'enter', 'pvp', 'burn', 'chat', 'use', 'other']
const BUILT = /planks$|glass|_bricks$|wool$|concrete|terracotta$|_door$|_bed$|lantern|bookshelf|carpet$|_sign$|_stairs$|_slab$|_fence$|_fence_gate$|_wall$|torch$|smooth_|chiseled_|quartz|_trapdoor$|iron_bars|chest|barrel|furnace|crafting_table|hopper|rail|bell|composter|lectern|anvil|campfire|glowstone|sea_lantern|polished_/
const FENCING = /_fence$|_wall$|glass|iron_bars|_trapdoor$|_slab$|_fence_gate$|_planks$|_bricks$|cobblestone$|hopper|chain$|_door$/
const COMMUNITY_MOBS = /^(villager|wandering_trader|iron_golem|snow_golem|allay|trader_llama)$/
const PUBLIC_SIGN = /town ?hall|spawn|shop|market|museum|community|public|library|church|tavern|bank|welcome|station|hub|hall of|portal/i
const SIGN_RULES = [
  [/no grief|don'?t grief|do not grief/i, { kind: 'forbid', acts: ['break', 'burn', 'take'], target: '', what: 'no griefing' }],
  [/do not break|don'?t break|no breaking/i, { kind: 'forbid', acts: ['break'], target: '', what: "don't break anything here" }],
  [/keep out|private|no entry|no trespass/i, { kind: 'forbid', acts: ['enter', 'take'], target: '', what: 'private: keep out' }],
  [/no pvp|pvp ?off|no killing players/i, { kind: 'forbid', acts: ['pvp'], target: '', what: 'no pvp' }],
  [/no killing|don'?t kill|protected animals|do not kill/i, { kind: 'forbid', acts: ['kill'], target: '', what: "don't kill the animals here" }],
  [/don'?t take|no stealing|do not take/i, { kind: 'forbid', acts: ['take'], target: '', what: "don't take things here" }]
]
// Words people use for groups of things.
const TARGET_WORDS = {
  tree: /_log$|_leaves$|_wood$/, trees: /_log$|_leaves$|_wood$/, wood: /_log$|_wood$|_planks$/,
  crop: /^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|farmland|nether_wart|cocoa|sweet_berry_bush)$/,
  farm: /^(wheat|carrots|potatoes|beetroots|melon|pumpkin|sugar_cane|farmland|nether_wart|cow|pig|sheep|chicken)$/,
  animal: /^(cow|pig|sheep|chicken|horse|donkey|rabbit|goat|llama|mooshroom|cat|wolf|parrot|fox|turtle|bee|camel|sniffer|armadillo)$/,
  build: BUILT, building: BUILT, house: BUILT, base: BUILT, stuff: BUILT, block: /./, blocks: /./, anything: /./, everything: /./,
  mob: /./, monster: /zombie|skeleton|creeper|spider|enderman|witch|slime|drowned|husk|stray|phantom|pillager/, villager: /villager|wandering_trader/
}

const norm = (s) => String(s || '').toLowerCase().trim().replace(/^minecraft:/, '')
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

/** Does a rule's target ("cows", "the trees", "my house", "") cover this thing (a block or mob name)? */
function matchTarget (target, name) {
  const t = norm(target).replace(/^(the|my|our|his|her|their|any|all|those|these|this|that)\s+/g, '').trim()
  if (!t) return true
  const n = norm(name)
  for (const w of t.split(/[\s,]+/)) {
    const word = w.replace(/(es|s)$/, '')
    const group = TARGET_WORDS[w] || TARGET_WORDS[word]
    if (group && group.test(n)) return true
    if (word.length >= 3 && n.includes(word)) return true
  }
  return false
}

/** Which acts an action is, and what it acts on (for matching rules). */
function actsOf (name, args, ctx) {
  const at = [args?.x, args?.y, args?.z].every(Number.isFinite) ? new Vec3(args.x, args.y, args.z) : null
  switch (name) {
    case 'mineBlock': case 'stripMine': return [{ act: 'break', target: norm(args?.blockType || args?.ore || 'stone'), at }]
    case 'placeBlock': return [{ act: /lava|fire|tnt/.test(norm(args?.blockType)) ? 'burn' : 'place', target: norm(args?.blockType), at }]
    case 'build': case 'planBuilding': case 'pillarUp': case 'bridge': case 'shelter': return [{ act: 'place', target: '', at }]
    case 'attackTarget': {
      const e = ctx.entity?.(args?.entityId)
      return e ? [{ act: e.type === 'player' ? 'pvp' : 'kill', target: e.username || e.name, at: e.position, entity: e }] : []
    }
    case 'takeItems': case 'inspectContainer': return [{ act: 'take', target: norm(args?.itemName || 'chest'), at }]
    case 'useItem': { const it = norm(args?.itemName); return /flint_and_steel|fire_charge|lava_bucket/.test(it) ? [{ act: 'burn', target: it, at }] : [{ act: 'use', target: it, at }] }
    case 'moveToBlock': return at ? [{ act: 'enter', target: '', at }] : []
    case 'chatMessage': return [{ act: 'chat', target: '', at: null }]
    default: return []
  }
}

class Etiquette {
  constructor (agent, data = {}) {
    this.agent = agent
    this.rules = data.rules || [] // { id, kind, acts, target, what, area, from, authority, at }
    this.seq = Math.max(0, ...this.rules.map((r) => r.id || 0))
    this.containCache = new Map()
  }

  get cfg () { return this.agent.config.etiquette || {} }

  /** 0 (anarchist) .. 1 (by the book). */
  lawfulness () {
    const c = this.cfg.lawfulness
    if (Number.isFinite(c)) return c
    return this.agent.personality?.lawfulness ?? 0.75
  }

  /** 'community' (towns, shared builds), 'smp', or 'anarchy' (no rules). */
  serverType () {
    const t = this.cfg.serverType || 'auto'
    if (t !== 'auto') return t
    const motd = String(this.agent.serverInfo?.motd || this.agent.config.server.host || '')
    return /anarch/i.test(motd) ? 'anarchy' : 'community'
  }

  /** Does it respect other people's things at all here? */
  decent () {
    if (this.cfg.enabled === false) return false
    if (this.lawfulness() < 0.2) return false // an anarchist does as it likes
    return this.serverType() !== 'anarchy' || this.lawfulness() >= 0.9
  }

  authority (name) {
    if (name === '@server' || name === '@sign') return name.slice(1)
    const { social, config } = this.agent
    const role = social.role(name)
    if (role === 'owner') return 'owner'
    if (role === 'admin') return 'admin'
    const p = social.profile(name)
    return p.trust >= config.trust.trustedAbove || p.affinity >= 70 ? 'trusted' : 'player'
  }

  /**
   * Someone (or a sign, or the server) sets a rule. Decide whether to keep it, like a person would.
   * raw: { kind: forbid|require, acts: [...], target, what, here }
   * @returns {{ accept: boolean, reason: string, rule?: object }}
   */
  consider (from, raw, where = null) {
    const kind = raw.kind === 'require' ? 'require' : 'forbid'
    const acts = (Array.isArray(raw.acts) ? raw.acts : []).map(norm).filter((a) => ACTS.includes(a))
    const what = String(raw.what || '').slice(0, 120)
    if (!what && !acts.length) return { accept: false, reason: 'not a rule' }
    const who = this.authority(from)
    const law = this.lawfulness()
    const anarchy = this.serverType() === 'anarchy'
    const social = this.agent.social
    let accept
    let reason
    if (who === 'owner') { accept = true; reason = 'your owner said so' } else if (social.isHostile?.(from)) { accept = false; reason = `${from} has been hostile to you` } else if (who === 'admin' || who === 'server' || who === 'sign') {
      accept = anarchy ? law >= 0.6 : law >= 0.2
      reason = accept ? (who === 'sign' ? 'the sign says so' : `${who === 'admin' ? 'staff' : 'the server'} rule`) : "you don't care about their rules"
    } else {
      // An ordinary player: protecting their own things or area is fair; telling you how to play is a favour.
      const fair = kind === 'forbid' && (raw.here || /my|our|mine/i.test(`${raw.target} ${what}`) || acts.every((a) => ['break', 'kill', 'take', 'burn', 'enter', 'pvp'].includes(a)))
      const like = (social.profile(from).affinity ?? 50) / 100
      accept = !anarchy && (fair ? law >= 0.35 : law >= 0.6 && like >= 0.45)
      reason = accept ? (fair ? 'fair enough: it is their stuff' : 'you like them and it is reasonable') : (anarchy ? "it's an anarchy server" : fair ? "you don't feel like it" : "they don't get to tell you how to play")
    }
    if (!accept) return { accept, reason }
    const area = raw.here && where ? { x: Math.round(where.x), y: Math.round(where.y), z: Math.round(where.z), r: raw.radius || 24, dim: String(this.agent.bot?.game?.dimension) } : null
    // The same rule again just refreshes it.
    const same = this.rules.find((r) => r.kind === kind && r.what.toLowerCase() === what.toLowerCase() && JSON.stringify(r.area) === JSON.stringify(area))
    if (same) { same.at = Date.now(); return { accept, reason, rule: same } }
    const rule = { id: ++this.seq, kind, acts: acts.length ? acts : ['other'], target: norm(raw.target), what: what || `${kind} ${acts.join('/')} ${raw.target || ''}`.trim(), area, from, authority: who, at: Date.now() }
    this.rules.push(rule)
    if (this.rules.length > 40) this.rules.splice(0, this.rules.length - 40)
    this.agent.memory?.addEvent('rule', `${from === '@sign' ? 'A sign' : from === '@server' ? 'The server' : from} set a rule: "${rule.what}". You agreed to keep it (${reason}).`)
    this.agent.learning?.markDirty()
    return { accept, reason, rule }
  }

  drop (id) { this.rules = this.rules.filter((r) => r.id !== Number(id)); this.agent.learning?.markDirty() }

  /** Rules that apply at a spot (area rules nearby, plus the general ones). */
  rulesAt (pos, dim) {
    return this.rules.filter((r) => !r.area || (r.area.dim === dim && pos && dist(r.area, pos) <= r.area.r))
  }

  /** Rule lines for the prompt. */
  forPrompt (pos, dim) {
    const here = this.rulesAt(pos, dim)
    const lines = here.slice(-8).map((r) => `${r.kind === 'require' ? 'Always' : 'Never'}: ${r.what}${r.area ? ' (around here)' : ''} — from ${r.from.replace(/^@/, 'the ')}`)
    if (this.decent()) lines.push('On a shared server: leave other people\'s builds, farms, pens, pets, named mobs and villagers alone; don\'t dig, burn or loot in someone\'s town or base; ask before taking.')
    else lines.push(this.serverType() === 'anarchy' ? 'Anarchy server: there are no rules here.' : 'You don\'t care much for other people\'s rules.')
    return lines
  }

  // ------------------------------------------------------------------------------------------------
  // Understanding the world: farms, pens, pets, towns
  // ------------------------------------------------------------------------------------------------

  /** Why this mob should be left alone, or null. */
  protectedMob (e) {
    if (!e || e.type === 'player' || !this.decent()) return null
    const bot = this.agent.bot
    const tag = safe(() => this.agent.senses.readTag(bot, e, 'close', 0))
    if (tag?.tag) return `it has a name (${tag.tag}): someone's`
    if (tag?.tamed) return "it's someone's pet"
    if (COMMUNITY_MOBS.test(e.name || '')) return `${e.name.replace(/_/g, ' ')}s are part of the place`
    if (e.vehicle) return 'someone put it in a boat or minecart'
    const c = this.contained(e)
    if (c) return /zombie|husk|drowned/.test(e.name) && c.villagers ? 'a zombie kept in a box next to villagers: an iron farm' : c.hostile ? 'trapped in a player-made box: part of a farm' : 'in someone\'s pen'
    return null
  }

  /**
   * Is the mob shut in by player-made blocks (a pen, a farm box)? Flood-fills where it could walk (up to 40 cells);
   * if that runs out and the walls include player-made blocks, it's kept there on purpose.
   */
  contained (e) {
    const bot = this.agent.bot
    const hit = this.containCache.get(e.id)
    if (hit && Date.now() - hit.at < 15000 && dist(hit.pos, e.position) < 2) return hit.v
    const start = e.position.floored()
    const seen = new Set()
    const queue = [start]
    let built = 0
    let open = false
    const tall = (e.height || 1) > 1.2
    while (queue.length && seen.size < 40) {
      const p = queue.shift()
      const k = `${p.x},${p.z}`
      if (seen.has(k)) continue
      seen.add(k)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const q = p.offset(dx, 0, dz)
        if (seen.has(`${q.x},${q.z}`)) continue
        const feet = bot.blockAt(q)
        const head = tall ? bot.blockAt(q.offset(0, 1, 0)) : null
        if (!feet) { open = true; continue } // unloaded: can't tell, assume it's open
        const blocked = feet.boundingBox !== 'empty' || (head && head.boundingBox !== 'empty')
        if (blocked) {
          if (FENCING.test(feet.name) || (head && FENCING.test(head.name))) built++
          // a one-block step up is not a wall for a mob
          const above = bot.blockAt(q.offset(0, 1, 0))
          const above2 = bot.blockAt(q.offset(0, 2, 0))
          if (feet.boundingBox === 'block' && !/_fence|_wall/.test(feet.name) && above?.boundingBox === 'empty' && (!tall || above2?.boundingBox === 'empty')) open = true
          continue
        }
        const floor = bot.blockAt(q.offset(0, -1, 0))
        if (floor && floor.boundingBox === 'empty' && !/water/.test(floor.name)) { open = true; continue } // it could drop down: not a box
        queue.push(q)
      }
      if (open) break
    }
    let v = null
    if (!open && seen.size < 40 && built >= 2) {
      const villagers = Object.values(bot.entities).some((m) => m.name === 'villager' && m.position.distanceTo(e.position) < 12)
      v = { cells: seen.size, hostile: e.kind === 'Hostile mobs' || /zombie|skeleton|creeper|spider|husk|drowned|witch/.test(e.name || ''), villagers }
    }
    this.containCache.set(e.id, { at: Date.now(), pos: e.position.clone(), v })
    if (this.containCache.size > 200) this.containCache.clear()
    return v
  }

  /** Is this spot inside someone's town or base (lots of player-made blocks around)? Its own home doesn't count. */
  builtUp (pos) {
    if (!this.decent() || !pos) return null
    const bot = this.agent.bot
    const places = this.agent.places
    const dim = String(bot.game?.dimension)
    if (places?.isHome(pos, dim)) return null
    if ([this.agent.builder?.current?.origin, ...(this.agent.builder?.history || []).map((h) => h.origin)].some((o) => o && dist(o, pos) < 24)) return null
    this.builtIds ||= bot.registry.blocksArray.filter((b) => BUILT.test(b.name)).map((b) => b.id)
    const point = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z)
    const found = safe(() => bot.findBlocks({ matching: this.builtIds, maxDistance: 10, count: 30, point })) || []
    if (found.length < 30) return null
    const sign = this.publicSign(pos)
    return sign ? `inside ${sign}` : "inside someone's town or base"
  }

  /** "the town hall" when a sign near this spot names a public place. */
  publicSign (pos) {
    const signs = safe(() => this.agent.containers.signsNear(this.agent.bot, pos, 12, 6)) || []
    const s = signs.find((x) => PUBLIC_SIGN.test(x.text))
    return s ? `the ${s.text.match(PUBLIC_SIGN)[0].toLowerCase()} ("${s.text.slice(0, 40)}")` : null
  }

  /** Signs nearby that state rules become rules for their area (once). */
  readSigns (pos) {
    if (!this.decent() && this.lawfulness() < 0.2) return
    const signs = safe(() => this.agent.containers.signsNear(this.agent.bot, pos, 10, 6)) || []
    for (const s of signs) {
      for (const [re, rule] of SIGN_RULES) {
        if (!re.test(s.text)) continue
        this.signSeen ||= new Set()
        const k = `${s.pos.x},${s.pos.y},${s.pos.z}:${rule.what}`
        if (this.signSeen.has(k)) continue
        this.signSeen.add(k)
        this.consider('@sign', { ...rule, what: `${rule.what} (sign: "${s.text.slice(0, 50)}")`, here: true, radius: 20 }, s.pos)
      }
    }
  }

  /** A server broadcast that states a rule ("Rule 3: no griefing"). */
  serverMessage (text) {
    if (!/\brules?\b|griefing|not allowed|forbidden|prohibited|banned for/i.test(text)) return
    for (const [re, rule] of SIGN_RULES) if (re.test(text)) this.consider('@server', { ...rule, what: `${rule.what} (server: "${text.slice(0, 60)}")` })
  }

  // ------------------------------------------------------------------------------------------------
  // Before an action
  // ------------------------------------------------------------------------------------------------

  /**
   * Would this action break a rule it agreed to, or be the kind of thing a decent player doesn't do here?
   * ctx: { entity(id), pos, dim, ownBlock(pos) }
   */
  check (decision, ctx) {
    if (decision.source === 'command' || ctx.byOwner) return null // its owner told it to, directly
    const { name, args = {} } = decision.action || {}
    const acts = actsOf(name, args, ctx)
    if (!acts.length) return null
    const pos = ctx.pos
    for (const a of acts) {
      const where = a.at || pos
      for (const r of this.rulesAt(where, ctx.dim)) {
        if (r.kind !== 'forbid' || !(r.acts.includes(a.act) || (a.act === 'pvp' && r.acts.includes('kill') && !r.target))) continue
        if (!matchTarget(r.target, a.target)) continue
        if (a.act === 'break' && ctx.ownBlock?.(where)) continue
        return { code: 'RULE', message: `That breaks a rule you agreed to keep: "${r.what}" (from ${r.from.replace(/^@/, 'a ')}). Do something else.` }
      }
      if (!this.decent()) continue
      if ((a.act === 'kill') && a.entity) {
        const why = this.protectedMob(a.entity)
        if (why && !ctx.provokedBy?.(a.entity)) return { code: 'NOT_YOURS', message: `Leave that ${a.entity.name.replace(/_/g, ' ')} alone: ${why}. Killing it would wreck someone's work.` }
      }
      if (['break', 'burn', 'take'].includes(a.act)) {
        const spot = this.builtUp(where)
        if (spot && !(a.act === 'break' && ctx.ownBlock?.(where)) && !(a.act === 'take' && ctx.mayTake?.(where))) {
          return { code: 'NOT_YOURS', message: `You're ${spot}. A decent player doesn't ${a.act === 'break' ? 'dig or break blocks' : a.act === 'burn' ? 'light fires' : 'take things'} in someone else's place. Go further out for that.` }
        }
      }
    }
    return null
  }

  toJSON () { return { rules: this.rules } }
}

function safe (fn) { try { return fn() } catch { return null } }

module.exports = { Etiquette, matchTarget, actsOf, ACTS, BUILT, SIGN_RULES }
