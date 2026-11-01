'use strict'

/**
 * reflexes.js — the fast layer: what a player does without stopping to think.
 *
 * Runs on every physics tick (20 per second) and never waits for the LLM:
 *  - falls: predicts where it lands and how much it will hurt, then picks the
 *    best save it knows and has the items for (steering onto water, a block
 *    against the edge, hay/slime/cobweb, water or powder-snow bucket, pearl,
 *    elytra, slow falling, ladders and vines, boat, mace on a mob, jumping on
 *    a mount, crouch-clutches and wall pearls), with a totem as a last resort;
 *  - hazards: lava, fire, drowning, suffocation, lit TNT, knockback at edges;
 *  - getting hit: a flinch and a look toward the hit (straight at the attacker
 *    for sharp players), weapon and shield out when it's a real attack. The
 *    Brain then decides between fighting and running, and a player can talk
 *    it out of a fight (see Brain.considerTruce).
 *
 * Which tricks it knows comes from its survival level, or from what it has
 * figured out by getting hurt or being told (so a beginner can end up knowing
 * more than a master). How well it pulls them off comes from skill and
 * practice, after a human reaction delay. Afterwards the LLM hears about it
 * through memory, and it may say something ("that was close").
 */

const { Vec3 } = require('vec3')
const combat = require('./combat')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const safe = (fn) => { try { return fn() } catch { return undefined } }
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const sigmoid = (x) => 1 / (1 + Math.exp(-x))

const GRAVITY = 0.08
const DRAG = 0.98
const AIR_DRAG = 0.91
const EYE = 1.62
const PLACE_HEIGHT = 2.8 // feet this high above a block or lower: its top is within reach (4.5 from the eyes)

/**
 * Everything it can know. level: known from this survival level on (0 beginning … 7 impossible).
 * need: the skill at which it works half the time. learnHint: how it understands it after
 * discovering it. keywords: phrases that teach it from chat.
 */
const TRICKS = {
  steer: { level: 1, need: 0.3, desc: 'steered the fall onto a soft spot', learnHint: 'you can steer while falling, toward water or anything soft', keywords: /steer|aim for (the )?water|land in water/ },
  edgeCatch: { level: 2, need: 0.5, desc: 'caught itself on a block placed against the edge', learnHint: 'when you slip off an edge, place a block against it right away', keywords: /block clutch|place a block (under|below)|edge/ },
  softBlock: { level: 2, need: 0.45, desc: 'dropped a slime block / hay bale / cobweb and landed on it', learnHint: 'slime blocks and cobwebs cancel fall damage, hay bales take most of it', keywords: /hay ?bale|slime ?block|cobweb clutch/ },
  waterBucket: { level: 3, need: 0.62, desc: 'water-bucket clutched', learnHint: 'a water bucket placed just before you land cancels fall damage', keywords: /water ?bucket|mlg|water clutch/ },
  totem: { level: 3, need: 0.3, desc: 'got a totem into its off-hand', learnHint: 'a totem in your off-hand saves you from a deadly fall', keywords: /totem/ },
  lavaWater: { level: 2, need: 0.4, desc: 'poured water on the lava', learnHint: 'pour water when you fall into lava', keywords: /water.*lava|lava.*water/ },
  fireWater: { level: 2, need: 0.35, desc: 'put the fire out with water', learnHint: 'water puts you out when you are burning', keywords: /on fire|burning/ },
  pearl: { level: 4, need: 0.6, desc: 'pearled to the ground', residual: 5, learnHint: 'an ender pearl thrown at the ground teleports you down safely (it costs a bit of health)', keywords: /pearl/ },
  elytra: { level: 4, need: 0.62, desc: 'opened its elytra and glided down', learnHint: 'opening an elytra stops a fall if you glide', keywords: /elytra|glide/ },
  powderSnow: { level: 4, need: 0.62, desc: 'powder-snow clutched', learnHint: 'powder snow cancels fall damage like water does', keywords: /powder snow/ },
  slowFalling: { level: 4, need: 0.45, desc: 'drank slow falling', learnHint: 'slow falling potions stop fall damage', keywords: /slow fall/ },
  fireRes: { level: 4, need: 0.4, desc: 'drank fire resistance', learnHint: 'fire resistance lets you swim out of lava', keywords: /fire res/ },
  waterBreathing: { level: 4, need: 0.4, desc: 'drank water breathing', learnHint: 'water breathing potions stop you drowning', keywords: /water breathing/ },
  edgeSneak: { level: 5, need: 0.55, desc: "crouched at the edge so the knockback couldn't push it off", learnHint: 'crouching at an edge stops knockback from pushing you off', keywords: /crouch|sneak/ },
  airPocket: { level: 6, need: 0.6, desc: 'placed a door underwater for air', learnHint: 'a door placed underwater makes an air pocket', keywords: /door.*(air|underwater)|air pocket/ },
  climbable: { level: 6, need: 0.82, desc: 'placed a ladder / vine / scaffolding and caught it', learnHint: 'ladders, vines and scaffolding catch a fall', keywords: /ladder|vine|scaffold/ },
  boat: { level: 6, need: 0.84, desc: 'boat-clutched', learnHint: 'placing a boat and getting in just before you land cancels the fall', keywords: /boat/ },
  maceMob: { level: 6, need: 0.83, desc: 'smashed a mob with the mace on the way down', learnHint: 'hitting a mob with a mace while falling cancels your fall damage', keywords: /mace/ },
  mount: { level: 6, need: 0.8, desc: 'jumped onto a mount mid-fall', learnHint: 'mounting a horse or a cart mid-fall saves you', keywords: /horse|mount|minecart/ },
  crouchClutch: { level: 7, need: 0.88, desc: 'crouch-clutched a block under itself the instant it slipped', learnHint: 'you can clutch a block under your feet the instant you slip', keywords: /crouch.?clutch/ },
  wallPearl: { level: 7, need: 0.88, desc: 'pearled into the wall and glitched in', residual: 5, learnHint: 'pearling into a wall or ledge low down stops a fall even over lava', keywords: /pearl.*wall|wall.*pearl/ },
  lastTick: { level: 7, need: 0.9, desc: 'frame-perfect save', learnHint: 'with perfect timing you can clutch from any height', keywords: /frame.?perfect|last tick/ }
}

/** Blocks you can fall into without hurting yourself (you pass into them). */
const PASS_THROUGH = /^(water|bubble_column|lava|cobweb|powder_snow|sweet_berry_bush|ladder|vine|scaffolding|twisting_vines(_plant)?|weeping_vines(_plant)?|cave_vines(_plant)?|kelp(_plant)?|seagrass|tall_seagrass)$/
const WATERY = /^(water|bubble_column|kelp(_plant)?|seagrass|tall_seagrass)$/
const HOT = /lava|magma_block|^fire$|soul_fire|campfire/
const RIDEABLE = /^(horse|donkey|mule|camel|skeleton_horse|zombie_horse|llama|trader_llama|minecart|boat|chest_boat|.*_boat|.*_raft)$/
const CHEAP_BLOCKS = ['cobblestone', 'dirt', 'netherrack', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'blackstone', 'end_stone', 'sandstone', 'oak_planks', 'spruce_planks', 'birch_planks']
// Blocks a pathfinder should never walk through or onto.
const AVOID = ['tripwire', 'magma_block', 'sweet_berry_bush', 'powder_snow', 'campfire', 'soul_campfire', 'wither_rose', 'fire', 'soul_fire', 'cactus', 'pointed_dripstone']

/** Damage multiplier for landing in or on this block (null = a normal hard landing). */
function landingFactor (name) {
  if (!name) return null
  if (PASS_THROUGH.test(name) || name === 'slime_block') return 0
  if (name === 'hay_block' || name === 'honey_block') return 0.2
  if (/_bed$/.test(name)) return 0.5
  return null
}

function effectLevel (bot, name) {
  const e = bot.registry.effectsByName?.[name]
  const fx = e && bot.entity?.effects?.[e.id]
  return fx ? (fx.amplifier ?? 0) + 1 : 0
}

/** Feather falling and protection on the armor worn (enchantment protection factor, capped like the game). */
function fallArmorFactor (bot) {
  let epf = 0
  for (const slot of [5, 6, 7, 8]) {
    for (const e of safe(() => bot.inventory.slots[slot]?.enchants) || []) {
      if (e.name === 'feather_falling') epf += 3 * e.lvl
      else if (e.name === 'protection') epf += e.lvl
    }
  }
  return 1 - Math.min(20, epf) * 0.04
}

/** Fall damage for falling `distance` blocks onto a normal block. */
function fallDamage (bot, distance) {
  if (effectLevel(bot, 'slow_falling')) return 0
  const raw = Math.max(0, Math.ceil(distance - 3 - effectLevel(bot, 'jump_boost')))
  return raw * fallArmorFactor(bot)
}

/** First thing the body's feet hit while moving from `from` to `to` (corners of the hitbox + centre). */
function crossing (bot, from, to) {
  const offsets = [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]
  for (let y = Math.floor(from.y); y >= Math.floor(to.y) - 1; y--) {
    let hard = null
    for (const [ox, oz] of offsets) {
      const b = bot.blockAt(new Vec3(to.x + ox, y, to.z + oz))
      if (!b) return { surfaceY: y + 1, block: null, unknown: true }
      // Falling into a liquid or a web: only the centre column counts (that's where you'd be).
      if (PASS_THROUGH.test(b.name) && ox === 0 && to.y < y + 1 && from.y >= y) {
        return { surfaceY: y, block: b, pass: true, lava: b.name === 'lava' }
      }
      if (b.boundingBox === 'block' && to.y <= y + 1 && from.y >= y + 1 - 1e-6) {
        if (!hard || ox === 0) hard = b
      }
    }
    if (hard) return { surfaceY: y + 1, block: hard, lava: false, hot: HOT.test(hard.name) }
  }
  return null
}

/**
 * Simulate the fall tick by tick (move, then gravity and drag — like the game) until the feet
 * hit something. Returns { surfaceY, block, ticks, vy, x, z, pass, lava } or null if it can't tell yet.
 */
function predictLanding (bot, maxTicks = 120) {
  const e = bot.entity
  let p = e.position.clone()
  let v = e.velocity.clone()
  const minY = (bot.game?.minY ?? -64) - 8
  for (let t = 1; t <= maxTicks; t++) {
    const n = p.plus(v)
    const hit = crossing(bot, p, n)
    if (hit) return { ...hit, ticks: t, vy: v.y, x: n.x, z: n.z }
    p = n
    v = new Vec3(v.x * AIR_DRAG, (v.y - GRAVITY) * DRAG, v.z * AIR_DRAG)
    if (p.y < minY) return { void: true, surfaceY: -Infinity, ticks: t, vy: v.y, x: p.x, z: p.z }
  }
  return null
}

/** Blocks a pathfinder should steer around (call once per Movements). */
function avoidHazards (movements, registry) {
  for (const name of AVOID) {
    const id = registry.blocksByName[name]?.id
    if (id !== undefined) movements.blocksToAvoid?.add(id)
  }
}

class Reflexes {
  /**
   * @param {object} agent the Agent (bot, config, intelligence, executor, memory...)
   * @param {object} data persisted { known, practice }
   */
  constructor (agent, data = {}) {
    this.agent = agent
    this.known = data.known || {} // trick -> { how, at } learned beyond what the level gives
    this.practice = data.practice || {} // trick -> { tries, saves }
    this.busy = false // the body is doing a reflex: the Brain waits
    this.fall = null
    this.fallDistance = 0
    this.lastGround = null
    this.ticks = 0
    this.cooldowns = new Map()
  }

  get cfg () { return this.agent.config.reflexes }
  get bot () { return this.agent.bot }

  attach (bot) {
    this.fall = null
    this.fallDistance = 0
    this.busy = false
    bot.on('physicsTick', () => {
      try { this.tick() } catch (err) { this.agent.log.debug(`reflex tick failed: ${err.message}`) }
    })
    bot.on('forcedMove', () => { this.fallDistance = 0; this.prevY = bot.entity?.position.y })
    bot.on('death', () => { this.release(); this.fall = null; this.pending = null })
  }

  /** Hold the body (the Brain waits) — with a watchdog so a stuck reflex can't freeze the bot. */
  hold (ms = 10000) {
    this.busy = true
    clearTimeout(this.watchdog)
    this.watchdog = setTimeout(() => { this.busy = false }, ms)
  }

  release () {
    clearTimeout(this.watchdog)
    this.busy = false
  }

  // -------------------------------------------------------------------------
  // Knowledge and skill
  // -------------------------------------------------------------------------

  knows (trick) {
    const t = TRICKS[trick]
    if (!t) return false
    return Boolean(this.known[trick]) || this.agent.intelligence.level('survival') >= t.level
  }

  /**
   * Chance the trick works for us, now. window = ticks the chance stays open (fractional: a
   * 20-block fall leaves ~1.7 ticks with the ground in reach, which good players manage fine;
   * under one tick it takes frame-perfect timing).
   */
  chance (trick, window = 10) {
    const t = TRICKS[trick]
    const tries = this.practice[trick]?.tries || 0
    const skill = this.agent.intelligence.skill('survival') + Math.min(0.06, tries * 0.006)
    let p = sigmoid(14 * (skill - t.need))
    if (!this.knows('lastTick')) {
      if (window < 0.8) p *= 0.3
      else if (window < 1.2) p *= 0.65
    }
    return clamp(p, 0.02, 0.99)
  }

  /** Human reaction time: ~420 ms for a beginner, ~70 ms at the top. */
  reactionMs (factor = 1) {
    if (Number.isFinite(this.cfg.reactionMs)) return this.cfg.reactionMs * factor
    const s = this.agent.intelligence.skill('survival')
    return Math.round((450 - 380 * s) * (0.8 + Math.random() * 0.4) * factor)
  }

  /** One game tick — or 60 ms per tick if physics has stopped (death, a lag spike), so nothing hangs. */
  nextTick (n = 1) {
    return Promise.race([this.bot.waitForTicks(n), sleep(60 * n)])
  }

  ready (key, ms) {
    if (Date.now() - (this.cooldowns.get(key) || 0) < ms) return false
    this.cooldowns.set(key, Date.now())
    return true
  }

  item (re) {
    const bot = this.bot
    const offSlot = safe(() => bot.getEquipmentDestSlot('off-hand'))
    const off = offSlot !== undefined ? bot.inventory.slots[offSlot] : null
    return bot.inventory.items().find((i) => re.test(i.name)) || (off && re.test(off.name) ? off : null)
  }

  placeableBlock () {
    const items = this.bot.inventory.items()
    for (const name of CHEAP_BLOCKS) { const i = items.find((x) => x.name === name); if (i) return i }
    return items.find((i) => {
      const b = this.bot.registry.blocksByName[i.name]
      return b && b.boundingBox === 'block' && !/sand$|gravel|concrete_powder|tnt|chest|shulker|_ore$|diamond|emerald|gold_block|iron_block|netherite|anvil|bed$|furnace|table/.test(i.name)
    }) || null
  }

  /** Took a hit or a bad fall: maybe realise what would have helped (beginners learn this way). */
  discover (situation, tricks) {
    if (!this.cfg.learnSaves || !this.agent.config.intelligence.learn) return null
    const reach = this.agent.intelligence.level('survival') + 3 // you can only work out what's not far beyond you
    const options = tricks.filter((t) => !this.knows(t) && TRICKS[t].level <= reach)
    if (!options.length || Math.random() > 0.35 * (this.agent.config.intelligence.learnRate ?? 1)) return null
    const trick = options.sort((a, b) => TRICKS[a].level - TRICKS[b].level)[0]
    this.learn(trick, 'experience', `After ${situation}, you realise: ${TRICKS[trick].learnHint}.`)
    return trick
  }

  learn (trick, how, text) {
    if (this.knows(trick)) return false
    this.known[trick] = { how, at: Date.now() }
    this.agent.memory.addEvent('learned', text || `You learned: ${TRICKS[trick].learnHint}.`)
    this.agent.intelligence.addXp('survival', 2)
    this.agent.log.info(`Learned a save (${how}): ${trick}`)
    this.agent.learning?.markDirty()
    return true
  }

  /** "you can use a water bucket to stop fall damage" in chat or a lesson teaches the trick. */
  learnFromText (text, from) {
    if (!this.cfg.learnSaves || !this.agent.config.intelligence.learn) return
    const t = String(text || '').toLowerCase()
    if (!/fall|clutch|land|save|survive|drown|lava|fire|knock|edge|air/.test(t)) return
    const reach = this.agent.intelligence.level('survival') + 3
    for (const [trick, info] of Object.entries(TRICKS)) {
      if (info.keywords.test(t) && info.level <= reach) this.learn(trick, from || 'chat', `${from ? `${from} taught you` : 'You learned'}: ${info.learnHint}.`)
    }
  }

  /** For the prompt: what the body does on its own. */
  summary () {
    const tricks = Object.keys(TRICKS).filter((t) => this.knows(t) && t !== 'lastTick')
    if (!tricks.length) return "You don't know any tricks for saving yourself from falls or lava yet."
    return `Your reflexes handle falls and danger on their own; tricks you know: ${tricks.join(', ')}.`
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  grounded () {
    const e = this.bot.entity
    if (!e) return true
    if (e.onGround || e.isInWater || e.isInLava || e.isInWeb || this.bot.vehicle) return true
    const at = this.bot.blockAt(e.position)
    return Boolean(at && /ladder|vine|scaffolding|powder_snow|sweet_berry_bush|cobweb/.test(at.name))
  }

  tick () {
    const { bot, agent } = this
    if (!this.cfg.enabled || !bot?.entity || agent.dead) return
    const e = bot.entity
    this.ticks++

    if (this.grounded() || e.elytraFlying) {
      if (e.onGround) this.lastGround = { pos: e.position.clone(), at: Date.now() }
      this.fallDistance = 0
      if (this.fall && !this.fall.executing) this.fall = null
    } else if (this.prevY !== undefined && e.position.y < this.prevY) {
      this.fallDistance += this.prevY - e.position.y
    }
    this.prevY = e.position.y

    if (this.cfg.falls && !this.grounded() && !e.elytraFlying && e.velocity.y < -0.15 && !this.busy) {
      if (!this.fall) {
        // Crouch-clutchers act the instant they slip; everyone else needs a moment to notice.
        const slipped = this.lastGround && Date.now() - this.lastGround.at < 250
        const delay = slipped && this.knows('crouchClutch') ? 0 : this.reactionMs()
        this.fall = { at: Date.now(), noticeAt: Date.now() + delay, executing: false, startY: e.position.y + this.fallDistance }
      }
      if (!this.fall.executing && Date.now() >= this.fall.noticeAt && this.ticks % 2 === 0) this.planFall()
    }

    if (this.cfg.hazards && this.ticks % 3 === 0 && !this.busy) this.checkHazards()
  }

  // -------------------------------------------------------------------------
  // Falls
  // -------------------------------------------------------------------------

  planFall () {
    const bot = this.bot
    const land = predictLanding(bot)
    if (!land) return // too far down to tell yet
    const height = bot.entity.position.y - land.surfaceY
    const distance = this.fallDistance + height
    let damage = land.void ? 1000 : fallDamage(bot, distance) * (landingFactor(land.block?.name) ?? 1)
    if (land.lava && !effectLevel(bot, 'fire_resistance')) damage += 14
    if (land.hot) damage += 2
    const hp = bot.health
    if (damage < 3 && damage < hp - 2) return // a normal drop: just take it

    const options = this.fallOptions(land, damage, height)
    let best = null
    for (const o of options) {
      const p = this.chance(o.trick, o.window)
      const expected = (1 - p) * damage + p * (o.residual ?? 0) + (o.cost ?? 0)
      if (!best || expected < best.expected) best = { ...o, p, expected }
    }
    const lethal = damage >= hp
    const info = { damage, distance, land, healthBefore: bot.health }
    const totem = lethal && (!best || best.p < 0.9 || best.expected >= hp)
    if (best && best.expected < damage - 1) {
      this.runFall(best, info, totem)
    } else {
      this.fall.executing = true // nothing better to do: brace for it (and learn from it)
      this.fall.info = info
      if (totem) this.prepareTotem()
      this.watchLanding(null, info)
    }
  }

  /** Every save we know and have the items for, with how much time it leaves us. */
  fallOptions (land, damage, height) {
    const bot = this.bot
    const out = []
    const add = (trick, run, extra = {}) => { if (this.knows(trick)) out.push({ trick, run, ...extra }) }
    const speed = Math.max(0.1, Math.abs(land.vy))
    const reachWindow = PLACE_HEIGHT / speed // ticks with the landing block in reach
    const blockWindow = (PLACE_HEIGHT - 1) / speed // ...and our body still above the cell
    const nether = /nether/.test(bot.game?.dimension || '')
    const solid = land.block && !land.pass && !land.unknown
    const armor = fallArmorFactor(bot)

    // Already landing somewhere soft: nothing to do.
    if (landingFactor(land.block?.name) === 0 && !land.lava) return out

    const soft = this.softTarget(land)
    if (soft) add('steer', (f) => this.steer(soft, f), { window: land.ticks, residual: soft.residual * damage })

    const water = this.item(/^water_bucket$/)
    if (water && solid && !nether) add('waterBucket', (f) => this.placeBelow(water, 'use', 0, f), { window: reachWindow, cost: 0.2 })
    const snow = this.item(/^powder_snow_bucket$/)
    if (snow && solid) add('powderSnow', (f) => this.placeBelow(snow, 'block', 0, f), { window: reachWindow, cost: 0.3 })
    const cushion = this.item(/^slime_block$/) || this.item(/^cobweb$/) || this.item(/^(hay_block|honey_block)$/)
    if (cushion && solid) add('softBlock', (f) => this.placeBelow(cushion, 'block', 1, f), { window: blockWindow, residual: landingFactor(cushion.name) * damage, cost: 0.2 })
    const climb = this.item(/^(scaffolding|twisting_vines)$/)
    if (climb && solid) add('climbable', (f) => this.placeBelow(climb, 'block', climb.name === 'scaffolding' ? 1 : 0, f), { window: climb.name === 'scaffolding' ? blockWindow : reachWindow, cost: 0.2 })
    const ladder = this.item(/^(ladder|vine)$/)
    const wall = ladder && solid && this.wallBeside(land)
    if (wall) add('climbable', (f) => this.placeOnWall(ladder, wall, land, f), { window: reachWindow, cost: 0.2 })
    const boat = this.item(/_(boat|raft)$/)
    if (boat && solid && !land.lava) add('boat', (f) => this.boatClutch(boat, f), { window: (PLACE_HEIGHT - 0.6) / speed, cost: 0.5 })

    const pearl = this.item(/^ender_pearl$/)
    if (pearl && land.ticks >= 4 && !land.lava && !land.void && !land.hot) add('pearl', (f) => this.pearlDown(pearl, f), { window: land.ticks - 2, residual: 5 * armor, cost: 0.5 })
    const ledge = pearl && this.knows('wallPearl') && this.ledgeTarget(land)
    if (ledge) add('wallPearl', (f) => this.pearlTo(pearl, ledge, f), { window: land.ticks - 2, residual: 5 * armor, cost: 0.5 })

    const elytra = this.item(/^elytra$/)
    if (elytra && land.ticks >= (bot.inventory.slots[6]?.name === 'elytra' ? 4 : 10)) add('elytra', (f) => this.glide(elytra, f), { window: land.ticks - 3 })
    const kit = combat.readKit(bot)
    if (kit.drink.slow_falling && land.ticks >= 40) add('slowFalling', (f) => this.drink(kit.drink.slow_falling, f), { window: land.ticks - 34 })

    const mace = this.item(/^mace$/)
    const victim = mace && this.maceTarget(land)
    if (victim) add('maceMob', (f) => this.maceSave(mace, victim, f), { window: 3 })
    const ride = this.mountTarget(land)
    if (ride) add('mount', (f) => this.mountSave(ride, f), { window: 3 })

    const edge = this.edgeSpot()
    const block = edge && this.placeableBlock()
    // A catch one block down needs the instant reaction of a crouch-clutcher; lower ones any edge-catcher can try.
    if (block) add(edge.close && this.knows('crouchClutch') ? 'crouchClutch' : 'edgeCatch', (f) => this.edgeClutch(block, edge, f), { window: edge.window, cost: 0.1 })
    return out
  }

  runFall (option, info, totemFirst) {
    const { agent } = this
    this.fall.executing = true
    this.fall.info = info
    this.hold(option.trick === 'elytra' ? 25000 : 10000) // a glide can take a while
    agent.executor?.abort(`reflex: ${option.trick}`, { quiet: true })
    const fumble = Math.random() >= option.p // decided up front; a miss gets acted out like a real fumble
    agent.log.debug(`fall: ${info.damage.toFixed(1)} damage ahead (${info.distance.toFixed(1)} blocks) → ${option.trick} (${Math.round(option.p * 100)}%)${fumble ? ', fumbling' : ''}`)
    const landed = this.watchLanding(option, info)
    ;(totemFirst ? this.prepareTotem() : Promise.resolve())
      .then(() => option.run(fumble))
      .catch((err) => agent.log.debug(`fall save ${option.trick} failed: ${err.message}`))
    return landed
  }

  /** Wait until we're down, then see how it went: practice, XP, memory, maybe a word in chat. */
  async watchLanding (option, info) {
    const { bot, agent } = this
    await this.nextTick(2) // the save starts first
    for (let i = 0; i < 160 && !this.grounded() && !agent.dead; i++) await this.nextTick()
    await sleep(250) // damage arrives a moment after landing
    const lost = Math.max(0, info.healthBefore - bot.health)
    const saved = !agent.dead && lost < Math.max(1.5, info.damage * 0.5)
    await this.cleanup(option).catch(() => {})
    if (option) this.release()
    this.fall = null
    if (!option) {
      if (lost >= 3 || agent.dead) this.discover(`falling ${Math.round(info.distance)} blocks`, this.couldHaveUsed(info.land))
      return
    }
    const pr = this.practice[option.trick] || (this.practice[option.trick] = { tries: 0, saves: 0 })
    pr.tries++
    if (saved) pr.saves++
    agent.intelligence.addXp('survival', saved ? 1.2 : 0.4)
    agent.learning?.markDirty()
    if (saved && info.damage >= 6 && agent.reactor) {
      // A real save: remembered through the event (and maybe a "that was close" in chat).
      agent.emotions?.stimulate({ joy: 0.2, fear: 0.1 }, 'you just saved yourself from a nasty fall')
      agent.reactor.trigger('clutch', { what: TRICKS[option.trick].desc, height: Math.round(info.distance) })
    } else if (saved) {
      agent.memory.addEvent('reflex', `You fell ${Math.round(info.distance)} blocks and ${TRICKS[option.trick].desc} — ${lost ? `only lost ${Math.round(lost)} health` : 'no damage'}.`)
    } else if (!agent.dead) {
      agent.memory.addEvent('reflex', `You fell ${Math.round(info.distance)} blocks and tried to save yourself (${option.trick}) but messed it up (lost ${Math.round(lost)} health).`)
      agent.emotions?.stimulate({ fear: 0.15, anger: 0.05 })
    }
  }

  /** Tricks that would have worked with what we had (for learning after a bad fall). */
  couldHaveUsed (land) {
    const has = (re) => Boolean(this.item(re))
    const out = []
    if (this.softTarget(land)) out.push('steer')
    if (has(/^water_bucket$/)) out.push('waterBucket')
    if (has(/^(slime_block|hay_block|cobweb)$/)) out.push('softBlock')
    if (this.placeableBlock()) out.push('edgeCatch')
    if (has(/^ender_pearl$/)) out.push('pearl')
    if (has(/^elytra$/)) out.push('elytra')
    if (has(/^powder_snow_bucket$/)) out.push('powderSnow')
    if (has(/^(ladder|vine|scaffolding)$/)) out.push('climbable')
    if (has(/_(boat|raft)$/)) out.push('boat')
    if (has(/^totem_of_undying$/)) out.push('totem')
    return out
  }

  async cleanup (option) {
    const bot = this.bot
    if (!option || this.agent.dead) return
    if (option.trick === 'waterBucket') {
      // Scoop the water back up.
      const empty = this.item(/^bucket$/)
      if (empty) { await combat.hold(bot, empty); await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem(); await sleep(150) }
    }
    if ((option.trick === 'boat' || option.trick === 'mount') && bot.vehicle) {
      await sleep(300)
      safe(() => bot.dismount())
      if (option.trick === 'boat') {
        await sleep(300)
        const boat = bot.nearestEntity((e) => /boat|raft/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 3)
        for (let i = 0; boat?.isValid && i < 4; i++) { safe(() => bot.attack(boat)); await sleep(250) }
      }
    }
  }

  /** Something soft we could steer onto before we land. */
  softTarget (land) {
    const bot = this.bot
    const me = bot.entity.position
    const reach = Math.min(5, 0.012 * land.ticks * land.ticks + 0.15 * land.ticks)
    if (reach < 0.8) return null
    const ids = ['water', 'slime_block', 'hay_block', 'cobweb', 'powder_snow', 'scaffolding'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
    const found = bot.findBlocks({ point: new Vec3(land.x, land.surfaceY, land.z), matching: ids, maxDistance: Math.ceil(reach) + 2, count: 30 })
    let best = null
    for (const pos of found) {
      if (pos.y >= me.y) continue
      const d = Math.hypot(pos.x + 0.5 - land.x, pos.z + 0.5 - land.z)
      if (d > reach) continue
      const above = bot.blockAt(pos.offset(0, 1, 0))
      if (above && above.boundingBox === 'block') continue // covered
      const block = bot.blockAt(pos)
      if (block.name === 'water' && me.y - pos.y > 20 && !this.isDeep(pos)) continue // shallow water from high up still hurts
      const residual = landingFactor(block.name) ?? 1
      if (!best || residual < best.residual || (residual === best.residual && d < best.d)) best = { pos, d, residual }
    }
    return best
  }

  isDeep (pos) {
    const below = this.bot.blockAt(pos.offset(0, -1, 0))
    return Boolean(below && WATERY.test(below.name))
  }

  /** Air-strafe toward a soft spot; a less skilled player aims a little off. */
  async steer (target, fumble) {
    const bot = this.bot
    const err = fumble ? 1.2 + Math.random() : (1 - this.agent.intelligence.skill('survival')) * 0.6
    const ang = Math.random() * Math.PI * 2
    const goal = new Vec3(target.pos.x + 0.5 + Math.cos(ang) * err, 0, target.pos.z + 0.5 + Math.sin(ang) * err)
    try {
      for (let i = 0; i < 100 && !this.grounded(); i++) {
        const p = bot.entity.position
        const dx = goal.x - p.x
        const dz = goal.z - p.z
        const d = Math.hypot(dx, dz)
        if (d > 0.25) {
          await bot.look(Math.atan2(-dx, -dz), bot.entity.pitch, true)
          bot.setControlState('forward', true)
          bot.setControlState('sprint', d > 1.2)
        } else {
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
        }
        await this.nextTick()
      }
    } finally {
      bot.clearControlStates()
    }
  }

  /**
   * The classic clutch: hold the item, look down, and use it while the landing block is in
   * reach. mode 'use' (buckets, boats) or 'block' (placing on the top face); minHeight: the
   * placed block needs our body to still be above its cell.
   */
  async placeBelow (item, mode, minHeight, fumble) {
    const bot = this.bot
    await combat.hold(bot, item)
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    if (fumble) await sleep(150 + Math.random() * 250) // too late on the click
    for (let i = 0; i < 120; i++) {
      if (this.grounded()) return false
      const land = predictLanding(bot, 40)
      if (land && !land.pass) {
        const p = bot.entity.position
        const h = p.y - land.surfaceY
        // Our click reaches the server with the next move, so act a tick early.
        const next = h + bot.entity.velocity.y
        if (h <= PLACE_HEIGHT + 0.4 && next >= minHeight - 0.4) {
          const target = bot.blockAt(new Vec3(p.x, land.surfaceY - 1, p.z)) || land.block
          if (mode === 'use') {
            bot.activateItem()
          } else if (target) {
            await bot.lookAt(target.position.offset(0.5, 1, 0.5), true)
            bot.activateBlock(target, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5)).catch(() => {})
          }
          return true
        }
      }
      await this.nextTick()
    }
    return false
  }

  /** A wall right next to where we'll land: a ladder or vine on it catches us. */
  wallBeside (land) {
    const bot = this.bot
    const x = Math.floor(land.x)
    const z = Math.floor(land.z)
    const cell = bot.blockAt(new Vec3(x, land.surfaceY, z))
    if (!cell || cell.boundingBox !== 'empty') return null
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w = bot.blockAt(new Vec3(x + dx, land.surfaceY, z + dz))
      if (w && w.boundingBox === 'block') return { block: w, face: new Vec3(-dx, 0, -dz) }
    }
    return null
  }

  async placeOnWall (item, wall, land, fumble) {
    const bot = this.bot
    await combat.hold(bot, item)
    if (fumble) await sleep(200 + Math.random() * 200)
    for (let i = 0; i < 120; i++) {
      if (this.grounded()) return false
      const h = bot.entity.position.y - land.surfaceY
      if (h <= PLACE_HEIGHT + 0.4) {
        await bot.lookAt(wall.block.position.offset(0.5 + wall.face.x * 0.5, 0.5, 0.5 + wall.face.z * 0.5), true)
        bot.activateBlock(wall.block, wall.face).catch(() => {})
        return true
      }
      await this.nextTick()
    }
    return false
  }

  /** Place a boat under us and get in before we hit the ground. */
  async boatClutch (boat, fumble) {
    const bot = this.bot
    const placed = await this.placeBelow(boat, 'use', 0.6, fumble)
    if (!placed) return false
    for (let i = 0; i < 6 && !bot.vehicle; i++) {
      const e = bot.nearestEntity((x) => /boat|raft/.test(x.name || '') && x.position.distanceTo(bot.entity.position) < 3.5)
      if (e) { safe(() => bot.mount(e)); return true }
      await this.nextTick()
    }
    return false
  }

  async pearlDown (pearl, fumble) {
    const bot = this.bot
    await combat.hold(bot, pearl)
    await bot.look(bot.entity.yaw + (fumble ? (Math.random() - 0.5) * 1.2 : 0), fumble ? -0.9 : -Math.PI / 2, true)
    bot.activateItem()
    for (let i = 0; i < 60 && !this.grounded(); i++) await this.nextTick()
    return true
  }

  /** A ledge or a wall low down we can pearl onto (impossible players: works over lava or the void). */
  ledgeTarget (land) {
    const bot = this.bot
    const me = bot.entity.position
    const floor = Number.isFinite(land.surfaceY) ? land.surfaceY : me.y - 40
    let best = null
    for (let r = 2; r <= 8; r += 2) {
      for (let a = 0; a < 8; a++) {
        const x = me.x + Math.cos((a * Math.PI) / 4) * r
        const z = me.z + Math.sin((a * Math.PI) / 4) * r
        for (let y = Math.floor(me.y) - 1; y >= Math.max(floor, me.y - 24); y--) {
          const b = bot.blockAt(new Vec3(x, y, z))
          if (!b) break
          if (b.boundingBox !== 'block') continue
          const above = bot.blockAt(new Vec3(x, y + 1, z))
          const above2 = bot.blockAt(new Vec3(x, y + 2, z))
          if (above?.boundingBox === 'empty' && above2?.boundingBox === 'empty' && !HOT.test(b.name) && !/lava/.test(above.name)) {
            const score = (me.y - y) + r * 0.5 // high and close is best
            if (!best || score < best.score) best = { pos: new Vec3(Math.floor(x) + 0.5, y + 1, Math.floor(z) + 0.5), score }
          }
          break
        }
      }
    }
    return best
  }

  async pearlTo (pearl, target, fumble) {
    const ok = await combat.throwItem(this.bot, pearl, target.pos, 'pearl', fumble ? 12 : 1)
    for (let i = 0; i < 60 && !this.grounded(); i++) await this.nextTick()
    return ok
  }

  async glide (elytra, fumble) {
    const bot = this.bot
    const chestplate = bot.inventory.slots[6]?.name !== 'elytra' ? bot.inventory.slots[6] : null
    if (bot.inventory.slots[6]?.name !== 'elytra') await bot.equip(elytra, 'torso')
    if (fumble) await sleep(300 + Math.random() * 300)
    if (this.grounded()) return false
    await bot.elytraFly().catch(() => {})
    let yaw = this.openDirection()
    for (let i = 0; i < 400 && !this.grounded(); i++) {
      // Stay level enough that the game resets the fall (vertical speed above -0.5), turn away from walls.
      if (i % 10 === 0) yaw = this.openDirection(yaw)
      const vy = bot.entity.velocity.y
      await bot.look(yaw, vy < -0.4 ? 0.35 : vy < -0.2 ? 0.1 : -0.05, true)
      await this.nextTick()
    }
    // Armour back on.
    const back = chestplate && bot.inventory.items().find((i) => i.name === chestplate.name)
    if (back) await bot.equip(back, 'torso').catch(() => {})
    return true
  }

  /** The direction with the most open air ahead (for gliding). */
  openDirection (prefer = this.bot.entity.yaw) {
    const bot = this.bot
    const eye = bot.entity.position.offset(0, EYE, 0)
    let best = { yaw: prefer, free: -1 }
    for (let k = 0; k < 8; k++) {
      const yaw = prefer + (k * Math.PI) / 4
      let free = 0
      for (let d = 1; d <= 10; d++) {
        const b = bot.blockAt(eye.offset(-Math.sin(yaw) * d, -d * 0.3, -Math.cos(yaw) * d))
        if (!b || b.boundingBox === 'block') break
        free++
      }
      if (free > best.free + (k === 0 ? -1 : 0)) best = { yaw, free }
    }
    return best.yaw
  }

  async drink (potion, fumble) {
    if (fumble) await sleep(400)
    await combat.consume(this.bot, potion)
    return true
  }

  /** A mob right under us to smash with the mace (never a player or someone's pet). */
  maceTarget (land) {
    const bot = this.bot
    const me = bot.entity.position
    return bot.nearestEntity((e) => {
      if (!e.position || e === bot.entity || e.type === 'player' || e.name === 'item') return false
      if (!['hostile', 'animal', 'mob'].includes(e.type) && e.kind !== 'Hostile mobs' && e.kind !== 'Passive mobs') return false
      if (/villager|iron_golem|wandering_trader|wolf|cat|parrot|horse|donkey|mule|llama|camel/.test(e.name) || this.agent.senses?.metaValue?.(bot, e, 'owneruuid')) return false // not someone's pet
      const dy = me.y - (e.position.y + (e.height || 1))
      return dy > 0 && dy < me.y - land.surfaceY + 1 && Math.hypot(e.position.x - land.x, e.position.z - land.z) < 2
    })
  }

  async maceSave (mace, victim, fumble) {
    const bot = this.bot
    await combat.hold(bot, mace)
    for (let i = 0; i < 80 && !this.grounded(); i++) {
      if (!victim.isValid) return false
      const top = victim.position.offset(0, (victim.height || 1) * 0.8, 0)
      if (bot.entity.position.offset(0, EYE, 0).distanceTo(top) < 3) {
        if (fumble) await this.nextTick(2)
        await bot.lookAt(top, true)
        safe(() => bot.attack(victim))
        return true
      }
      await this.nextTick()
    }
    return false
  }

  /** Something to ride that we'll pass within reach of. */
  mountTarget (land) {
    const bot = this.bot
    return bot.nearestEntity((e) => e !== bot.entity && RIDEABLE.test(e.name || '') && !e.passengers?.length &&
      e.position.y < bot.entity.position.y && Math.hypot(e.position.x - land.x, e.position.z - land.z) < 2.5)
  }

  async mountSave (ride, fumble) {
    const bot = this.bot
    for (let i = 0; i < 80 && !this.grounded(); i++) {
      if (!ride.isValid) return false
      if (bot.entity.position.offset(0, EYE, 0).distanceTo(ride.position.offset(0, (ride.height || 1) / 2, 0)) < 3) {
        if (fumble) await this.nextTick(2)
        safe(() => bot.mount(ride))
        return true
      }
      await this.nextTick()
    }
    return false
  }

  /**
   * Just slipped off an edge: the cell we're falling past, one to three blocks down, can take a
   * block against the edge we left — we land on it after a short drop. (The cell at the old
   * ground level is never free in time: the feet are already in it a tick after slipping.)
   */
  edgeSpot () {
    const bot = this.bot
    const g = this.lastGround
    if (!g || Date.now() - g.at > 900 || this.fallDistance > 2.2) return null
    const p = bot.entity.position
    const groundY = Math.round(g.pos.y)
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    for (let k = 0; k <= 3; k++) {
      const cellY = groundY - 1 - k // the block would sit here; we land on top of it (k blocks down)
      if (p.y < cellY + 1 - 0.05) continue // already below it
      const cell = bot.blockAt(new Vec3(x, cellY, z))
      if (!cell || cell.boundingBox !== 'empty') continue
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ref = bot.blockAt(new Vec3(x + dx, cellY, z + dz))
        if (ref && ref.boundingBox === 'block') {
          // Ticks until our feet pass the top of that cell.
          let y = p.y; let vy = bot.entity.velocity.y; let window = 0
          while (y > cellY + 1 && window < 40) { y += vy; vy = (vy - GRAVITY) * DRAG; window++ }
          return { ref, face: new Vec3(-dx, 0, -dz), cellY, window, close: k <= 1 }
        }
      }
    }
    return null
  }

  async edgeClutch (block, spot, fumble) {
    const bot = this.bot
    bot.setControlState('sneak', true)
    try {
      await combat.hold(bot, block)
      if (fumble) await this.nextTick(2 + Math.floor(Math.random() * 3))
      if (bot.entity.position.y < spot.cellY + 1 - 0.05) return false
      await bot.lookAt(spot.ref.position.offset(0.5 + spot.face.x * 0.5, 0.5, 0.5 + spot.face.z * 0.5), true)
      bot.activateBlock(spot.ref, spot.face).catch(() => {})
      for (let i = 0; i < 20 && !this.grounded(); i++) await this.nextTick()
      return true
    } finally {
      bot.setControlState('sneak', false)
    }
  }

  /** Deadly fall and no sure way out: get a totem into the off-hand. */
  async prepareTotem () {
    const bot = this.bot
    if (!this.knows('totem')) return
    const offSlot = safe(() => bot.getEquipmentDestSlot('off-hand'))
    if (offSlot !== undefined && bot.inventory.slots[offSlot]?.name === 'totem_of_undying') return
    const totem = bot.inventory.items().find((i) => i.name === 'totem_of_undying')
    if (totem) await bot.equip(totem, 'off-hand').catch(() => {})
  }

  // -------------------------------------------------------------------------
  // Hazards: lava, fire, drowning, suffocation, TNT
  // -------------------------------------------------------------------------

  checkHazards () {
    const { bot, agent } = this
    const e = bot.entity
    const feet = bot.blockAt(e.position)
    const eyes = bot.blockAt(e.position.offset(0, EYE, 0))
    const now = Date.now()
    const notice = (key, run, ms = 2500) => {
      if (this.pending?.key === key) {
        if (now >= this.pending.at) { this.pending = null; if (this.ready(key, ms)) this.takeOver(key, run) }
        return
      }
      if (!this.pending) this.pending = { key, at: now + this.reactionMs() }
    }

    if (e.isInLava || feet?.name === 'lava') return notice('lava', () => this.escapeLava(), 1500)
    if (eyes && WATERY.test(eyes.name) && bot.oxygenLevel !== undefined) {
      // Sharper players react to the air bar sooner.
      const worry = 4 + Math.round(5 * agent.intelligence.skill('survival'))
      if (bot.oxygenLevel <= worry) return notice('drown', () => this.surface(), 4000)
    }
    if (eyes && eyes.boundingBox === 'block' && !/glass|leaves|ice/.test(eyes.name) && now - (agent.lastHurtAt || 0) < 1500) {
      return notice('suffocate', () => this.unstuck(eyes), 1500)
    }
    if (combat.isOnFire(e) && !e.isInWater) return notice('fire', () => this.putOut(), 4000)
    const tnt = bot.nearestEntity((x) => /^(tnt|tnt_minecart)$/.test(x.name || '') && x.position.distanceTo(e.position) < 7)
    if (tnt) return notice('tnt', () => this.runFrom(tnt.position, 30), 3000)
    if (this.pending && now - this.pending.at > 3000) this.pending = null // the danger went away by itself
  }

  /** Take the body for a moment: stop the current action and keep the Brain waiting. */
  takeOver (key, run) {
    const { agent } = this
    this.hold(15000)
    agent.executor?.abort(`reflex: ${key}`, { quiet: true })
    agent.log.debug(`reflex: ${key}`)
    run()
      .catch((err) => agent.log.debug(`reflex ${key} failed: ${err.message}`))
      .finally(() => { try { this.bot.clearControlStates() } catch { /* gone */ } this.release() })
  }

  async escapeLava () {
    const bot = this.bot
    const nether = /nether/.test(bot.game?.dimension || '')
    const water = this.item(/^water_bucket$/)
    if (water && !nether && this.knows('lavaWater') && Math.random() < this.chance('lavaWater')) {
      await combat.hold(bot, water)
      await bot.look(bot.entity.yaw, -Math.PI / 2, true)
      bot.activateItem()
      await this.nextTick(2)
    }
    const spot = this.safeSpot(5)
    if (spot) await this.moveTo(spot, 60, { jump: true })
    else await this.moveTo(null, 30, { jump: true })
    const fireRes = combat.readKit(bot).drink.fire_resistance
    if (bot.entity.isInLava && fireRes && this.knows('fireRes')) await combat.consume(bot, fireRes)
    if (!bot.entity.isInLava) this.agent.memory.addEvent('reflex', 'You fell into lava and scrambled out.')
    else this.discover('getting stuck in lava', ['lavaWater', 'fireRes'].filter((t) => t === 'lavaWater' ? water : fireRes))
    if (combat.isOnFire(bot.entity)) await this.putOut()
  }

  async putOut () {
    const bot = this.bot
    const nether = /nether/.test(bot.game?.dimension || '')
    const water = this.item(/^water_bucket$/)
    if (water && !nether && this.knows('fireWater')) return combat.douse(bot, water)
    const id = bot.registry.blocksByName.water?.id
    const near = id !== undefined && bot.findBlock({ matching: id, maxDistance: 6 })
    if (near) await this.moveTo(near.position.offset(0.5, 0, 0.5), 50, { jump: false })
  }

  async surface () {
    const bot = this.bot
    const eye = bot.entity.position.offset(0, EYE, 0)
    let up = false
    for (let dy = 1; dy <= 14; dy++) {
      const b = bot.blockAt(eye.offset(0, dy, 0))
      if (!b) break
      if (WATERY.test(b.name)) continue
      up = b.boundingBox === 'empty'
      break
    }
    const breathing = combat.readKit(bot).drink.water_breathing
    if (!up && breathing && this.knows('waterBreathing')) { await combat.consume(bot, breathing); return }
    const door = this.item(/_door$/)
    if (!up && door && this.knows('airPocket') && bot.oxygenLevel <= 3) {
      const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
      if (below?.boundingBox === 'block') {
        await combat.hold(bot, door)
        await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
        await bot.activateBlock(below, new Vec3(0, 1, 0)).catch(() => {})
        return
      }
    }
    const target = up ? null : this.airNear(8)
    if (target) await this.moveTo(target, 120, { jump: true, swim: true })
    else {
      bot.setControlState('jump', true)
      await bot.look(bot.entity.yaw, Math.PI / 2, true)
      for (let i = 0; i < 120; i++) {
        const head = bot.blockAt(bot.entity.position.offset(0, EYE, 0))
        if (head && !WATERY.test(head.name)) break
        await this.nextTick()
      }
    }
    const lost = bot.oxygenLevel <= 0
    if (lost) this.discover('nearly drowning', ['waterBreathing', 'airPocket'])
  }

  /** The nearest water surface with air above it. */
  airNear (radius) {
    const bot = this.bot
    const me = bot.entity.position
    let best = null
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        for (let dy = 0; dy <= 12; dy++) {
          const b = bot.blockAt(me.offset(dx, dy, dz))
          if (!b) break
          if (WATERY.test(b.name)) continue
          if (b.boundingBox === 'empty') {
            const d = Math.hypot(dx, dz) + dy
            if (!best || d < best.d) best = { pos: me.offset(dx, dy, dz).floored().offset(0.5, 0, 0.5), d }
          }
          break
        }
      }
    }
    return best?.pos || null
  }

  async unstuck (block) {
    const bot = this.bot
    const canDig = this.agent.config.server.platform !== 'bedrock' && block.diggable && block.hardness < 3
    if (canDig) { await bot.dig(block, true).catch(() => {}); return }
    const spot = this.safeSpot(2)
    await this.moveTo(spot, 30, { jump: true })
  }

  async runFrom (pos, ticks) {
    const bot = this.bot
    const me = bot.entity.position
    const away = new Vec3(me.x * 2 - pos.x, me.y, me.z * 2 - pos.z)
    await this.moveTo(away, ticks, { jump: true, sprint: true, stopNear: false })
  }

  /** A standable, cool spot close by (out of lava or a wall). */
  safeSpot (radius) {
    const bot = this.bot
    const me = bot.entity.position.floored()
    let best = null
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          const ground = bot.blockAt(me.offset(dx, dy - 1, dz))
          const feet = bot.blockAt(me.offset(dx, dy, dz))
          const head = bot.blockAt(me.offset(dx, dy + 1, dz))
          if (!ground || !feet || !head) continue
          if (ground.boundingBox !== 'block' || HOT.test(ground.name)) continue
          if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' || HOT.test(feet.name) || HOT.test(head.name)) continue
          const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
          if (!best || d < best.d) best = { pos: me.offset(dx + 0.5, dy, dz + 0.5), d }
        }
      }
    }
    return best?.pos || null
  }

  /** Steer the body straight at a point (no pathfinding: there's no time). */
  async moveTo (target, ticks, { jump = false, sprint = true, swim = false, stopNear = true } = {}) {
    const bot = this.bot
    try {
      for (let i = 0; i < ticks; i++) {
        if (target) {
          const p = bot.entity.position
          const dx = target.x - p.x
          const dz = target.z - p.z
          if (stopNear && Math.hypot(dx, dz) < 0.4 && Math.abs(target.y - p.y) < 1.2 && !bot.entity.isInLava) break
          await bot.look(Math.atan2(-dx, -dz), swim ? Math.max(-0.5, Math.min(0.8, (target.y - p.y) * 0.3)) : 0, true)
        }
        bot.setControlState('forward', true)
        bot.setControlState('sprint', sprint)
        bot.setControlState('jump', jump && (bot.entity.isInLava || bot.entity.isInWater || bot.entity.isCollidedHorizontally || i % 8 === 0))
        await this.nextTick()
      }
    } finally {
      bot.clearControlStates()
    }
  }

  // -------------------------------------------------------------------------
  // Getting hit
  // -------------------------------------------------------------------------

  /**
   * Called the moment we take damage from something.
   * @param {object} hit { attacker (entity or null), serious (a real attack, not one punch) }
   */
  onHurt ({ attacker, serious }) {
    const { bot, agent } = this
    if (!this.cfg.enabled || !this.cfg.hitReactions || !bot?.entity || this.busy || agent.dead) return
    const kb = bot.entity.velocity.clone()
    // Crouch at the edge before the knockback carries us off (PvP habit, so it's quicker than a normal reaction).
    if (this.knows('edgeSneak') && bot.entity.onGround) {
      setTimeout(() => this.edgeSneak(kb), this.knows('crouchClutch') ? 0 : this.reactionMs(0.5))
    }
    const current = agent.executor?.current?.name
    if (current === 'attackTarget' || current === 'retreat') return // already dealing with it
    if (!serious && !this.ready('startle', 1500)) return
    setTimeout(() => this.startle(attacker, kb, serious).catch(() => {}), this.reactionMs())
  }

  edgeSneak (kb) {
    const bot = this.bot
    if (!bot.entity || Math.hypot(kb.x, kb.z) < 0.15 || !bot.entity.onGround) return
    const dir = new Vec3(kb.x, 0, kb.z).normalize()
    const ahead = bot.entity.position.plus(dir.scaled(0.9))
    let drop = 0
    for (let dy = 1; dy <= 5; dy++) {
      const b = bot.blockAt(ahead.offset(0, -dy, 0))
      if (b && b.boundingBox === 'block') break
      drop = dy
    }
    if (drop < 3 || Math.random() > this.chance('edgeSneak', 4)) return
    bot.setControlState('sneak', true)
    setTimeout(() => { try { bot.setControlState('sneak', false) } catch { /* gone */ } }, 500)
  }

  /** Flinch, look toward the hit — sharper players look straight at whoever did it. */
  async startle (attacker, kb, serious) {
    const { bot, agent } = this
    if (!bot.entity || agent.dead || this.busy) return
    const senses = agent.intelligence.skill('senses')
    agent.executor?.pauseFor(serious ? 350 : 450 + Math.random() * 450)
    agent.emotions?.stimulate({ fear: serious ? 0.08 : 0.03 })
    const lookAtAttacker = () => attacker?.isValid ? bot.lookAt(attacker.position.offset(0, (attacker.height || 1.8) * 0.85, 0), true) : null
    if (attacker?.isValid && Math.random() < 0.25 + 0.75 * senses) {
      await lookAtAttacker()
    } else {
      // Knockback pushes us away from the hit, so turn the other way (more or less).
      const kbYaw = Math.hypot(kb.x, kb.z) > 0.03 ? Math.atan2(kb.x, kb.z) : bot.entity.yaw + Math.PI
      await bot.look(kbYaw + (Math.random() * 2 - 1) * (1 - senses) * 1.3, (Math.random() - 0.5) * 0.4, true)
      await sleep(250 + (1 - senses) * 650)
      if (attacker?.isValid && attacker.position.distanceTo(bot.entity.position) < 10) await lookAtAttacker()
      else await bot.look(bot.entity.yaw + (Math.random() - 0.5) * 2.4, 0, true) // where did that come from?
    }
    if (serious) await this.drawWeapon()
  }

  /** A real attack: weapon in hand, shield up if we know how. The Brain decides fight or flight. */
  async drawWeapon () {
    const { bot, agent } = this
    const current = agent.executor?.current?.name
    if (current === 'attackTarget' || this.busy) return
    const kit = combat.readKit(bot)
    if (kit.melee) await combat.hold(bot, kit.melee).catch(() => {})
    const offSlot = safe(() => bot.getEquipmentDestSlot('off-hand'))
    if (kit.shield && agent.intelligence.can('shieldBlock', 'combat') && offSlot !== undefined && bot.inventory.slots[offSlot]?.name !== 'shield') {
      await bot.equip(kit.shield, 'off-hand').catch(() => {})
    }
  }

  toJSON () { return { known: this.known, practice: this.practice } }
}

module.exports = { Reflexes, TRICKS, predictLanding, fallDamage, landingFactor, avoidHazards }
