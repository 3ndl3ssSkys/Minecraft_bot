'use strict'

/**
 * actions.js — the "hands" of the bot.
 *
 * Every function the LLM is allowed to call lives in the ACTIONS registry
 * below. Each entry declares:
 *   - description : shown to the LLM so it knows when to use the tool
 *   - params      : human-readable parameter docs (also shown to the LLM)
 *   - run(ctx, args) : the implementation. Returns a short string describing
 *                      what happened, or throws an ActionError.
 *
 * Actions never talk to the LLM themselves. They are executed one at a time by
 * the ActionExecutor (bottom of this file), which adds argument validation,
 * a hard timeout, cancellation (AbortSignal) and converts every outcome into a
 * plain `{ ok, code, message }` result that is fed back into the next prompt.
 */

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

// ---------------------------------------------------------------------------
// Errors & small utilities
// ---------------------------------------------------------------------------

/** An expected, explainable failure. `code` is machine-readable for the LLM. */
class ActionError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'ActionError'
    this.code = code
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Sleep that rejects as soon as the signal aborts. */
function abortableSleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort () {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError (signal) {
  const reason = typeof signal?.reason === 'string' ? signal.reason : 'cancelled'
  return new ActionError('ABORTED', `Action was interrupted (${reason}).`)
}

function throwIfAborted (signal) {
  if (signal?.aborted) throw abortError(signal)
}

/** "Oak Log" / "minecraft:oak_log" / "oak log" -> "oak_log" */
function normalizeName (name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_')
}

function round1 (n) {
  return Math.round(n * 10) / 10
}

function fmtPos (v) {
  return `(${Math.floor(v.x)}, ${Math.floor(v.y)}, ${Math.floor(v.z)})`
}

// ---------------------------------------------------------------------------
// Argument validation helpers (the LLM *will* send garbage sometimes)
// ---------------------------------------------------------------------------

function argNumber (args, key, { min = -Infinity, max = Infinity, def } = {}) {
  let v = args?.[key]
  if ((v === undefined || v === null || v === '') && def !== undefined) return def
  if (typeof v === 'string') v = Number(v.trim())
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ActionError('INVALID_ARGS', `"${key}" must be a number (got ${JSON.stringify(args?.[key])}).`)
  }
  return Math.min(max, Math.max(min, v))
}

function argString (args, key, { def, maxLength = 256 } = {}) {
  const v = args?.[key]
  if ((v === undefined || v === null || v === '') && def !== undefined) return def
  if (typeof v !== 'string' && typeof v !== 'number') {
    throw new ActionError('INVALID_ARGS', `"${key}" must be a string (got ${JSON.stringify(v)}).`)
  }
  const s = String(v).trim()
  if (!s) throw new ActionError('INVALID_ARGS', `"${key}" must not be empty.`)
  return s.slice(0, maxLength)
}

// ---------------------------------------------------------------------------
// Name resolution (blocks, items, players)
// ---------------------------------------------------------------------------

/**
 * Resolve a possibly fuzzy block name into a list of registry block ids.
 * "oak_log" -> [oak_log]; "log" -> every *_log; "iron" -> iron_ore, deepslate_iron_ore...
 */
function resolveBlockIds (bot, rawName) {
  const name = normalizeName(rawName)
  const byName = bot.registry.blocksByName
  if (byName[name]) {
    // Treat ore variants as the same request (iron_ore also matches deepslate_iron_ore).
    const ids = [byName[name].id]
    if (byName[`deepslate_${name}`]) ids.push(byName[`deepslate_${name}`].id)
    return ids
  }
  const matches = bot.registry.blocksArray.filter((b) =>
    b.name === name || b.name.endsWith(`_${name}`) || b.name.startsWith(`${name}_`) || b.name.includes(name)
  )
  return matches.slice(0, 32).map((b) => b.id)
}

/** Find an inventory item by (fuzzy) name. Prefers exact matches. */
function findInventoryItem (bot, rawName) {
  const name = normalizeName(rawName)
  const items = bot.inventory.items()
  return items.find((i) => i.name === name) ||
    items.find((i) => i.name.endsWith(`_${name}`) || i.name.startsWith(`${name}_`)) ||
    items.find((i) => i.name.includes(name)) ||
    null
}

function findPlayerEntity (bot, rawName) {
  const wanted = String(rawName ?? '').trim().toLowerCase()
  const player = Object.values(bot.players).find((p) => p.username.toLowerCase() === wanted)
  return player?.entity ?? null
}

function inventorySummary (bot) {
  const counts = {}
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] || 0) + item.count
  return counts
}

function durabilityLeft (item) {
  if (!item || !item.maxDurability) return null
  return item.maxDurability - (item.durabilityUsed || 0)
}

// ---------------------------------------------------------------------------
// Pathfinding wrapper — the single most failure-prone part of any bot.
// ---------------------------------------------------------------------------

/**
 * Drive the pathfinder toward `goal` with:
 *   - a hard timeout (pathfinder.goto can otherwise hang forever),
 *   - a stuck detector (no meaningful movement for `stuckMs`),
 *   - cancellation through `signal`,
 *   - translation of pathfinder error names into ActionError codes.
 */
async function gotoGoal (ctx, goal, { timeoutMs = 30000, stuckMs = 8000, label = 'destination' } = {}) {
  const { bot, signal } = ctx
  throwIfAborted(signal)

  let timer, stuckTimer, onAbort
  let lastPos = bot.entity.position.clone()
  let lastMoveAt = Date.now()

  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new ActionError('PATH_TIMEOUT', `Could not reach ${label} within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)

    stuckTimer = setInterval(() => {
      const pos = bot.entity?.position
      if (!pos) return
      if (pos.distanceTo(lastPos) > 0.5) {
        lastPos = pos.clone()
        lastMoveAt = Date.now()
      } else if (Date.now() - lastMoveAt > stuckMs && !bot.pathfinder.isMining() && !bot.pathfinder.isBuilding()) {
        reject(new ActionError('STUCK', `Got stuck at ${fmtPos(pos)} while moving to ${label}.`))
      }
    }, 1000)

    onAbort = () => reject(abortError(signal))
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([bot.pathfinder.goto(goal), guard])
  } catch (err) {
    if (err instanceof ActionError) throw err
    switch (err?.name) {
      case 'NoPath': throw new ActionError('NO_PATH', `There is no walkable path to ${label}.`)
      case 'Timeout': throw new ActionError('PATH_TIMEOUT', `Path calculation to ${label} took too long (probably too far or blocked).`)
      case 'GoalChanged':
      case 'PathStopped': throw new ActionError('PATH_INTERRUPTED', `Movement to ${label} was interrupted.`)
      default: throw new ActionError('PATH_ERROR', `Pathfinding to ${label} failed: ${err?.message || err}`)
    }
  } finally {
    clearTimeout(timer)
    clearInterval(stuckTimer)
    signal?.removeEventListener('abort', onAbort)
    // Always leave the pathfinder idle so the next action starts clean.
    if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
  }
}

/** Timeout budget that scales with distance: walking ~4 blocks/s plus slack for digging/bridging. */
function travelTimeout (ctx, distance) {
  const { baseTimeoutMs, msPerBlock, maxTimeoutMs } = ctx.config.behavior.pathfinding
  return Math.min(maxTimeoutMs, baseTimeoutMs + distance * msPerBlock)
}

function assertTravelDistance (ctx, distance) {
  const max = ctx.config.behavior.maxTravelDistance
  if (distance > max) {
    throw new ActionError('TOO_FAR', `Target is ${Math.round(distance)} blocks away; max travel distance per action is ${max}. Move in smaller steps.`)
  }
}

// ---------------------------------------------------------------------------
// Equipment helpers
// ---------------------------------------------------------------------------

/**
 * Equip the best tool for a block. Throws NO_SUITABLE_TOOL when the block
 * would drop nothing without a proper tool (e.g. stone without a pickaxe).
 */
async function equipToolFor (ctx, block) {
  const { bot } = ctx
  const minDurability = ctx.config.behavior.minToolDurability
  let best = bot.pathfinder.bestHarvestTool(block)

  // Don't use a tool that is about to break — keep it for later or let the LLM decide.
  if (best && durabilityLeft(best) !== null && durabilityLeft(best) <= minDurability) {
    const kind = best.name.split('_').pop() // pickaxe / axe / shovel / hoe / shears
    const alt = bot.inventory.items().find((i) =>
      i.slot !== best.slot && i.name.endsWith(kind) && block.canHarvest(i.type) &&
      (durabilityLeft(i) ?? Infinity) > minDurability)
    best = alt || best
  }

  if (block.harvestTools && !(best && block.canHarvest(best.type))) {
    const needed = Object.keys(block.harvestTools).map((id) => bot.registry.items[id]?.name).filter(Boolean)
    throw new ActionError('NO_SUITABLE_TOOL', `Mining ${block.name} by hand drops nothing. Needs one of: ${needed.slice(0, 4).join(', ')}.`)
  }

  if (best) {
    if (bot.heldItem?.type !== best.type) await bot.equip(best, 'hand')
  } else if (bot.heldItem && bot.heldItem.maxDurability) {
    // Holding a tool that doesn't help — put it away so it doesn't lose durability.
    await bot.unequip('hand').catch(() => {})
  }
  return best
}

/** Rank weapons by approximate attack damage. */
const WEAPON_SCORES = {
  netherite_sword: 8, diamond_sword: 7, netherite_axe: 10, diamond_axe: 9, iron_sword: 6, iron_axe: 9,
  stone_sword: 5, stone_axe: 9, golden_sword: 4, wooden_sword: 4, golden_axe: 7, wooden_axe: 7, mace: 6, trident: 9
}

async function equipBestWeapon (ctx) {
  const { bot } = ctx
  // Axes hit hard but swing slowly; prefer swords for sustained fights.
  const score = (i) => (WEAPON_SCORES[i.name] || 0) - (i.name.endsWith('_axe') ? 3 : 0)
  const weapon = bot.inventory.items()
    .filter((i) => WEAPON_SCORES[i.name] && (durabilityLeft(i) ?? Infinity) > 1)
    .sort((a, b) => score(b) - score(a))[0]
  if (weapon && bot.heldItem?.type !== weapon.type) await bot.equip(weapon, 'hand')
  return weapon || null
}

/** Put a shield in the off-hand if we have one and the slot is free. */
async function equipShield (ctx) {
  const { bot } = ctx
  const offhand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
  if (offhand?.name === 'shield') return true
  const shield = bot.inventory.items().find((i) => i.name === 'shield')
  if (shield && !offhand) { await bot.equip(shield, 'off-hand'); return true }
  return false
}

/**
 * Attack cooldown (ms) for the held item on 1.9+ combat. Waiting for a full
 * charge is what makes hits (and crits) actually do damage.
 */
function attackCooldown (bot) {
  if (bot.registry.version['<']('1.9')) return 120 // old combat: just click fast
  const n = bot.heldItem?.name || ''
  if (n.endsWith('_sword')) return 625
  if (n === 'trident') return 910
  if (n === 'mace') return 1670
  if (n.endsWith('_axe')) return /^(wooden|stone)_/.test(n) ? 1250 : n.startsWith('iron') ? 1110 : 1000
  if (n.endsWith('_pickaxe')) return 830
  if (n.endsWith('_shovel')) return 1000
  if (n.endsWith('_hoe')) return 500
  return 250
}

/** PvP permission rules (config.pvp + who the bot trusts). Throws NOT_ALLOWED. */
function assertMayFightPlayer (ctx, name, sparring) {
  const { config } = ctx
  const pvp = config.pvp
  const lower = String(name).toLowerCase()
  if (config.behavior.protectedPlayers.some((p) => p.toLowerCase() === lower)) {
    throw new ActionError('NOT_ALLOWED', `${name} is protected; you won't attack them.`)
  }
  if (pvp.neverAttackOwners && ctx.social?.role(name) === 'owner' && !sparring) {
    throw new ActionError('NOT_ALLOWED', `${name} is your owner; you won't fight them unless it's a friendly spar.`)
  }
  if (pvp.mode === 'never') throw new ActionError('NOT_ALLOWED', 'Fighting players is turned off (pvp.mode = never).')
  if (pvp.mode === 'always') return
  const provoked = ctx.social?.isHostile(name) || ctx.social?.isAttackingNow(name, 15000)
  if (provoked) return
  // A fight the bot itself agreed to (someone asked, and it judged it worth it), or defending someone it promised to protect.
  if (ctx.tasks?.mayFight(name)) return
  if (sparring && pvp.allowSparring) {
    const invited = (ctx.memory?.chat || []).some((c) => c.from?.toLowerCase() === lower && Date.now() - c.at < 180000 &&
      /\b(pvp|duel|spar|fight|1v1|battle)\b/i.test(c.text))
    if (invited) return
    throw new ActionError('NOT_ALLOWED', `${name} hasn't asked you for a duel.`)
  }
  throw new ActionError('NOT_ALLOWED', `${name} hasn't attacked you. You only fight players who attack you (or who ask for a spar).`)
}

/**
 * Melee combat loop, ~20 updates/second. Tactics are toggled by `style`:
 *  - crit   : jump, then hit while falling (1.5x damage)
 *  - wtap   : release forward right after a hit to reset sprint (extra knockback)
 *  - strafe : circle left/right while in range so the opponent misses
 *  - shield : raise an off-hand shield between swings while the opponent swings
 *  - backOff: hit once, then step back out of reach (good vs creepers)
 * Returns { outcome: 'win'|'fled'|'escaped'|'timeout', hitsLanded, hitsTaken, healthLost, durationMs }.
 */
async function fight (ctx, entity, style, maxSeconds) {
  const { bot, signal } = ctx
  const started = Date.now()
  const startHealth = bot.health
  const end = started + maxSeconds * 1000
  const cooldown = attackCooldown(bot)
  let hitsLanded = 0
  let hitsTaken = 0
  let lastAttack = 0
  let targetSwingAt = 0
  let jumping = false
  let jumpAt = 0
  let wtapUntil = 0
  let backOffUntil = 0
  let strafeDir = Math.random() < 0.5 ? 'left' : 'right'
  let nextStrafeSwitch = 0
  let shieldUp = false
  let outcome = 'timeout'

  const onHurt = (e) => {
    if (e === entity && Date.now() - lastAttack < 400) hitsLanded++
    if (e === bot.entity) hitsTaken++
  }
  const onSwing = (e) => { if (e === entity) targetSwingAt = Date.now() }
  bot.on('entityHurt', onHurt)
  bot.on('entitySwingArm', onSwing)
  const hasShield = () => bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'shield'
  const lowerShield = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false } }
  const setStrafe = (dir) => {
    bot.setControlState('left', dir === 'left')
    bot.setControlState('right', dir === 'right')
  }

  try {
    while (Date.now() < end) {
      throwIfAborted(signal)
      if (!entity.isValid || !bot.entities[entity.id]) { outcome = 'win'; break }
      if (bot.health <= style.retreatHealth && bot.health < startHealth) { outcome = 'fled'; break }
      const dist = bot.entity.position.distanceTo(entity.position)
      if (dist > 24) { outcome = 'escaped'; break }

      const now = Date.now()
      const eye = entity.position.offset(0, (entity.height || 1.8) * 0.85, 0)
      const ready = now - lastAttack >= cooldown

      if (now < backOffUntil) {
        // Hit-and-run: step back while the cooldown recharges.
        lowerShield()
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
        await bot.lookAt(eye, true)
        setStrafe(null)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState('back', true)
      } else if (dist > 3.4) {
        // Close the distance with the pathfinder (handles terrain).
        lowerShield()
        setStrafe(null)
        bot.setControlState('back', false)
        if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
      } else {
        // In melee range: manual control.
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
        await bot.lookAt(eye, true)
        bot.setControlState('back', false)
        const wantForward = now >= wtapUntil && dist > 2.2
        bot.setControlState('forward', wantForward)
        bot.setControlState('sprint', wantForward)
        if (style.strafe) {
          if (now > nextStrafeSwitch) {
            strafeDir = strafeDir === 'left' ? 'right' : 'left'
            nextStrafeSwitch = now + 400 + Math.random() * 600
          }
          setStrafe(strafeDir)
        } else {
          setStrafe(null)
        }

        // Block between our swings while they're swinging at us.
        if (style.shield && hasShield() && !ready && now - targetSwingAt < 600 && !shieldUp) {
          bot.activateItem(true)
          shieldUp = true
        }

        if (ready) {
          // Start a jump for a critical hit; the hit lands on the way down.
          if (style.crit && !jumping && bot.entity.onGround && !bot.entity.isInWater && cooldown >= 500) {
            bot.setControlState('jump', true)
            jumping = true
            jumpAt = now
          }
          if (jumping && !bot.entity.onGround) bot.setControlState('jump', false)
          const falling = jumping && !bot.entity.onGround && bot.entity.velocity.y < -0.05
          if (!jumping || falling || now - jumpAt > 600) {
            jumping = false
            bot.setControlState('jump', false)
            lowerShield()
            if (dist <= 3.2) {
              bot.attack(entity)
              lastAttack = now
              if (style.wtap) wtapUntil = now + 90
              if (style.backOff) backOffUntil = now + Math.min(700, cooldown)
            }
          }
        }
      }
      await abortableSleep(50, signal)
    }
  } finally {
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entitySwingArm', onSwing)
    lowerShield()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
  }
  return { outcome, hitsLanded, hitsTaken, healthLost: Math.max(0, Math.round(startHealth - bot.health)), durationMs: Date.now() - started }
}

/** Find the nearest block matching any of `names` within range. */
function findNearestBlock (bot, names, maxDistance = 32) {
  const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined)
  return ids.length ? bot.findBlock({ matching: ids, maxDistance }) : null
}

/** Walk until a block is within interaction reach. */
async function goNextTo (ctx, block, label) {
  const { bot } = ctx
  if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4) return
  const dist = bot.entity.position.distanceTo(block.position)
  await gotoGoal(ctx, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), {
    timeoutMs: travelTimeout(ctx, dist), label
  })
}

const CONTAINERS = ['chest', 'trapped_chest', 'barrel']
const FUELS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'lava_bucket', 'dried_kelp_block']
const FUEL_ITEMS_PER_UNIT = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100, dried_kelp_block: 20 }
const KEEP_WHEN_STORING = /_sword$|_axe$|_pickaxe$|_shovel$|_hoe$|^shield$|^bow$|^crossbow$|^trident$|^mace$|_helmet$|_chestplate$|_leggings$|_boots$|^torch$|^fishing_rod$/

/** Report if the item we were holding broke during an action. */
function describeToolBreak (ctx, before) {
  if (!before || !before.maxDurability) return ''
  const stillHave = ctx.bot.inventory.items().some((i) => i.type === before.type)
  if (!stillHave) {
    ctx.notify?.('toolBroke', { item: before.name })
    return ` Your ${before.name} broke!`
  }
  return ''
}

const ARMOR_SLOTS = [
  [/_helmet$|^turtle_helmet$|_head$|carved_pumpkin/, 'head'],
  [/_chestplate$|^elytra$/, 'torso'],
  [/_leggings$/, 'legs'],
  [/_boots$/, 'feet']
]

// Foods that hurt you; only eaten when explicitly requested.
const BAD_FOODS = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew'])

// Blocks that open a GUI when right-clicked; we sneak while placing against them.
const INTERACTABLE = /chest|crafting_table|furnace|smoker|barrel|door|trapdoor|gate|button|lever|anvil|table|bed|shulker|hopper|dispenser|dropper|loom|stonecutter|grindstone|bell|note_block/

// ---------------------------------------------------------------------------
// The action registry
// ---------------------------------------------------------------------------

const ACTIONS = {
  moveToBlock: {
    description: 'Walk/climb/swim to a coordinate. Use coordinates from the state JSON.',
    params: { x: 'number', y: 'number', z: 'number', range: 'number, optional — how close to get (default 1)' },
    async run (ctx, args) {
      const { bot } = ctx
      const target = new Vec3(argNumber(args, 'x'), argNumber(args, 'y', { min: -64, max: 320 }), argNumber(args, 'z'))
      const range = argNumber(args, 'range', { min: 0, max: 16, def: 1 })
      const distance = bot.entity.position.distanceTo(target)
      assertTravelDistance(ctx, distance)

      const goal = range < 1
        ? new goals.GoalBlock(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))
        : new goals.GoalNear(target.x, target.y, target.z, range)
      await gotoGoal(ctx, goal, { timeoutMs: travelTimeout(ctx, distance), label: fmtPos(target) })
      return `Arrived near ${fmtPos(target)}. Now at ${fmtPos(bot.entity.position)}.`
    }
  },

  moveToPlayer: {
    description: 'Walk to a player by username.',
    params: { playerName: 'string', range: 'number, optional (default 2)' },
    async run (ctx, args) {
      const { bot } = ctx
      const name = argString(args, 'playerName')
      const range = argNumber(args, 'range', { min: 1, max: 16, def: 2 })
      const entity = findPlayerEntity(bot, name)
      if (!entity) throw new ActionError('NOT_FOUND', `Player "${name}" is not within render distance.`)
      const distance = bot.entity.position.distanceTo(entity.position)
      assertTravelDistance(ctx, distance)
      await gotoGoal(ctx, new goals.GoalFollow(entity, range), { timeoutMs: travelTimeout(ctx, distance), label: name })
      return `Reached ${name}.`
    }
  },

  followPlayer: {
    description: 'Follow a player around for a while (e.g. when asked to "come with me").',
    params: { playerName: 'string', durationSeconds: 'number, optional (default 30, max 120)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const name = argString(args, 'playerName')
      const duration = argNumber(args, 'durationSeconds', { min: 3, max: 120, def: 30 })
      const entity = findPlayerEntity(bot, name)
      if (!entity) throw new ActionError('NOT_FOUND', `Player "${name}" is not within render distance.`)
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
      try {
        const end = Date.now() + duration * 1000
        while (Date.now() < end) {
          await abortableSleep(500, signal)
          if (!entity.isValid) return `Lost track of ${name}.`
        }
      } finally {
        bot.pathfinder.setGoal(null)
      }
      return `Followed ${name} for ${duration}s.`
    }
  },

  explore: {
    description: 'Wander in a random (or given) direction to discover new terrain and resources.',
    params: { distance: 'number, optional (default 24, max 64)', direction: 'optional: north|south|east|west' },
    async run (ctx, args) {
      const { bot } = ctx
      const distance = argNumber(args, 'distance', { min: 8, max: 64, def: 24 })
      const dirs = { north: -Math.PI / 2, south: Math.PI / 2, east: 0, west: Math.PI }
      const dirName = args?.direction ? normalizeName(args.direction) : null
      const angle = dirs[dirName] ?? Math.random() * Math.PI * 2
      const p = bot.entity.position
      const tx = Math.floor(p.x + Math.cos(angle) * distance)
      const tz = Math.floor(p.z + Math.sin(angle) * distance)
      try {
        await gotoGoal(ctx, new goals.GoalNearXZ(tx, tz, 3), { timeoutMs: travelTimeout(ctx, distance), label: `(${tx}, ~, ${tz})` })
      } catch (err) {
        // Partial progress still counts as exploring.
        if (err.code === 'PATH_TIMEOUT' || err.code === 'STUCK') {
          return `Explored part of the way (${err.code}). Now at ${fmtPos(bot.entity.position)}.`
        }
        throw err
      }
      return `Explored to ${fmtPos(bot.entity.position)}.`
    }
  },

  mineBlock: {
    description: 'Find the nearest block(s) of a type, walk to them and mine them. Auto-equips the best tool and picks up drops.',
    params: { blockType: 'string, e.g. "oak_log", "stone", "iron_ore"', count: 'number, optional (default 1, max 16)', maxDistance: 'number, optional search radius (default 32)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const blockType = argString(args, 'blockType')
      const count = Math.floor(argNumber(args, 'count', { min: 1, max: 16, def: 1 }))
      const maxDistance = argNumber(args, 'maxDistance', { min: 4, max: 64, def: 32 })

      const ids = resolveBlockIds(bot, blockType)
      if (ids.length === 0) throw new ActionError('UNKNOWN_BLOCK', `"${blockType}" is not a known block type.`)

      const skip = new Set() // positions we failed to reach/mine this action
      let mined = 0
      let failures = 0
      const failureNotes = []
      const maxFailures = 3

      while (mined < count && failures < maxFailures) {
        throwIfAborted(signal)
        const candidates = bot.findBlocks({ matching: ids, maxDistance, count: 64 })
          .filter((pos) => !skip.has(pos.toString()))
        if (candidates.length === 0) break
        const pos = candidates[0] // findBlocks returns nearest first
        const block = bot.blockAt(pos)
        if (!block || !ids.includes(block.type)) { skip.add(pos.toString()); continue }

        try {
          if (!block.diggable) throw new ActionError('UNBREAKABLE', `${block.name} cannot be mined.`)
          await equipToolFor(ctx, block)

          // Walk until a face of the block is visible and within reach.
          if (!bot.canDigBlock(block)) {
            const dist = bot.entity.position.distanceTo(pos)
            await gotoGoal(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), {
              timeoutMs: travelTimeout(ctx, dist), label: `${block.name} at ${fmtPos(pos)}`
            })
          }

          const fresh = bot.blockAt(pos)
          if (!fresh || !ids.includes(fresh.type)) { skip.add(pos.toString()); continue } // someone else mined it
          if (!bot.canDigBlock(fresh)) throw new ActionError('OUT_OF_REACH', `Could not get within reach of ${fresh.name} at ${fmtPos(pos)}.`)

          await equipToolFor(ctx, fresh) // inventory may have changed while walking
          const toolBefore = bot.heldItem
          throwIfAborted(signal)
          await digWithAbort(ctx, fresh)
          mined++
          const broke = describeToolBreak(ctx, toolBefore)
          if (broke) failureNotes.push(broke.trim())

          if (ctx.config.behavior.autoCollectDrops) await collectNearbyDrops(ctx, pos, 4, 4000).catch(() => {})
        } catch (err) {
          if (err.code === 'ABORTED' || err.code === 'NO_SUITABLE_TOOL') throw err
          skip.add(pos.toString())
          failures++
          failureNotes.push(err.message)
          ctx.log.debug(`mineBlock: skipping ${fmtPos(pos)}: ${err.message}`)
        }
      }

      const notes = failureNotes.length ? ` Notes: ${[...new Set(failureNotes)].slice(0, 3).join(' | ')}` : ''
      if (mined === 0) {
        throw new ActionError(failures ? 'MINING_FAILED' : 'NOT_FOUND',
          failures ? `Could not mine any ${blockType}.${notes}` : `No ${blockType} found within ${maxDistance} blocks.`)
      }
      return `Mined ${mined}/${count} ${blockType}.${notes}`
    }
  },

  placeBlock: {
    description: 'Place a block from your inventory at an exact coordinate (needs an adjacent solid block to place against).',
    params: { blockType: 'string (inventory item name)', x: 'number', y: 'number', z: 'number' },
    async run (ctx, args) {
      const { bot } = ctx
      const blockType = argString(args, 'blockType')
      const pos = new Vec3(argNumber(args, 'x'), argNumber(args, 'y', { min: -64, max: 319 }), argNumber(args, 'z')).floored()

      const item = findInventoryItem(bot, blockType)
      if (!item) throw new ActionError('MISSING_ITEM', `No "${blockType}" in inventory.`)
      if (!bot.registry.blocksByName[item.name] && !/_seeds$|^torch$|_sign$|bucket/.test(item.name)) {
        throw new ActionError('NOT_PLACEABLE', `${item.name} is not a placeable block.`)
      }

      const distance = bot.entity.position.distanceTo(pos)
      assertTravelDistance(ctx, distance)

      const target = bot.blockAt(pos)
      if (!target) throw new ActionError('NOT_LOADED', `Chunk at ${fmtPos(pos)} is not loaded.`)
      if (target.boundingBox !== 'empty' && !/water|lava|short_grass|tall_grass|fern|snow|dead_bush|vine/.test(target.name)) {
        throw new ActionError('OCCUPIED', `${fmtPos(pos)} is already occupied by ${target.name}.`)
      }

      // Find a solid neighbour to click on.
      const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
      let reference = null
      let faceVector = null
      for (const dir of faces) {
        const b = bot.blockAt(pos.plus(dir))
        if (b && b.boundingBox === 'block') { reference = b; faceVector = dir.scaled(-1); break }
      }
      if (!reference) throw new ActionError('NO_SUPPORT', `Nothing solid next to ${fmtPos(pos)} to place against.`)

      // Get within reach without standing inside the target cell.
      try {
        await gotoGoal(ctx, new goals.GoalPlaceBlock(pos, bot.world, { range: 4 }), {
          timeoutMs: travelTimeout(ctx, distance), label: `placement spot for ${fmtPos(pos)}`
        })
      } catch (err) {
        if (err.code === 'ABORTED') throw err
        // Fallback: maybe we're already close enough.
        if (bot.entity.position.distanceTo(pos) > 4.5) throw err
      }

      await bot.equip(item, 'hand')
      const sneak = INTERACTABLE.test(reference.name)
      if (sneak) bot.setControlState('sneak', true)
      try {
        await bot.lookAt(reference.position.offset(0.5, 0.5, 0.5).plus(faceVector.scaled(0.5)), true)
        await bot.placeBlock(reference, faceVector)
      } catch (err) {
        // placeBlock sometimes times out waiting for the server update even though it worked.
        const after = bot.blockAt(pos)
        if (!after || after.name === target.name) {
          throw new ActionError('PLACE_FAILED', `Could not place ${item.name} at ${fmtPos(pos)}: ${err.message}`)
        }
      } finally {
        if (sneak) bot.setControlState('sneak', false)
      }
      return `Placed ${item.name} at ${fmtPos(pos)}.`
    }
  },

  chatMessage: {
    description: 'Say something in public chat.',
    params: { text: 'string (short, natural, in character)' },
    async run (ctx, args) {
      const text = argString(args, 'text', { maxLength: 512 })
      const sent = await ctx.chat.send(text, 'tool')
      if (!sent) throw new ActionError('CHAT_BLOCKED', 'Chat is disabled or rate-limited right now; do something else.')
      return `Said: "${sent}"`
    }
  },

  equipItem: {
    description: 'Equip an item from inventory into your hand, off-hand or an armor slot (armor slot auto-detected).',
    params: { itemName: 'string', destination: 'optional: hand|off-hand|head|torso|legs|feet' },
    async run (ctx, args) {
      const { bot } = ctx
      const itemName = argString(args, 'itemName')
      const item = findInventoryItem(bot, itemName)
      if (!item) throw new ActionError('MISSING_ITEM', `No "${itemName}" in inventory. Inventory: ${JSON.stringify(inventorySummary(bot))}`)
      let dest = args?.destination ? normalizeName(args.destination).replace('offhand', 'off-hand').replace('off_hand', 'off-hand') : null
      if (!dest) dest = ARMOR_SLOTS.find(([re]) => re.test(item.name))?.[1] || 'hand'
      const valid = ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet']
      if (!valid.includes(dest)) throw new ActionError('INVALID_ARGS', `destination must be one of ${valid.join(', ')}.`)
      try {
        await bot.equip(item, dest)
      } catch (err) {
        throw new ActionError('EQUIP_FAILED', `Could not equip ${item.name} to ${dest}: ${err.message}`)
      }
      return `Equipped ${item.name} (${dest}).`
    }
  },

  attackTarget: {
    description: 'Fight an entity by its id (from nearbyEntities) using real combat tactics (crits, sprint-resets, strafing, shield). ' +
      'Picks the fighting style that has worked best before unless you pass one. Retreats and eats automatically if the fight goes badly.',
    params: {
      entityId: 'number',
      maxSeconds: 'number, optional (default 25)',
      style: 'optional: aggressive|balanced|cautious|hitAndRun',
      sparring: 'optional boolean — a friendly duel the player asked for'
    },
    async run (ctx, args) {
      const { bot, config } = ctx
      const id = Math.floor(argNumber(args, 'entityId'))
      const maxSeconds = argNumber(args, 'maxSeconds', { min: 2, max: 90, def: 25 })
      const entity = bot.entities[id]
      if (!entity || !entity.isValid) throw new ActionError('NOT_FOUND', `No entity with id ${id} nearby.`)
      if (entity === bot.entity) throw new ActionError('INVALID_TARGET', 'You cannot attack yourself.')
      if (entity.name === 'item' || entity.type === 'projectile' || entity.type === 'orb') {
        throw new ActionError('INVALID_TARGET', `${entity.name} cannot be attacked.`)
      }
      if (entity.type === 'player') assertMayFightPlayer(ctx, entity.username, Boolean(args?.sparring))
      const label = entity.username || entity.displayName || entity.name
      if (bot.entity.position.distanceTo(entity.position) > 32) throw new ActionError('TOO_FAR', `${label} is too far away to chase.`)

      if (config.behavior.autoEquipWeapon) await equipBestWeapon(ctx).catch(() => {})
      await equipShield(ctx).catch(() => {})
      const weaponBefore = bot.heldItem

      const key = entity.type === 'player' ? `player:${entity.username}` : entity.name
      const style = ctx.learning
        ? ctx.learning.combat.chooseStyle(key, { forced: args?.style })
        : { name: 'balanced', crit: true, wtap: true, strafe: true, shield: true, retreatHealth: 7 }
      ctx.log.info(`Fighting ${label} with style "${style.name}" (retreat at ${style.retreatHealth} hp)`)

      let result
      try {
        result = await fight(ctx, entity, style, maxSeconds)
      } catch (err) {
        // Died mid-fight: that's a loss worth learning from.
        if (err.code === 'ABORTED' && bot.health <= 0) {
          ctx.learning?.combat.record(key, style.name, 'loss', { hitsLanded: 0, hitsTaken: 0, healthLost: 20, durationMs: 0 })
          ctx.notify?.('fightEnded', { key, label, style: style.name, outcome: 'loss', isPlayer: entity.type === 'player' })
        }
        throw err
      }

      ctx.learning?.combat.record(key, style.name, result.outcome, result)
      ctx.learning?.markDirty()
      ctx.notify?.('fightEnded', { key, label, style: style.name, isPlayer: entity.type === 'player', ...result })
      const broke = describeToolBreak(ctx, weaponBefore)
      const stats = `${result.hitsLanded} hits landed, ${result.hitsTaken} taken, style ${style.name}`

      switch (result.outcome) {
        case 'win':
          if (entity.type !== 'player') ctx.notify?.('killedMob', { mob: label })
          return `Defeated ${label} (${stats}).${broke}`
        case 'escaped':
          return `${label} got away (${stats}).${broke}`
        case 'fled': {
          // Losing: get out, then try to heal.
          let note = ''
          try {
            await ACTIONS.retreat.run(ctx, { entityId: id, distance: 18 })
            await ACTIONS.eatFood.run(ctx, {})
            note = ' Retreated and ate to recover.'
          } catch (err) {
            if (err.code === 'ABORTED') throw err
            note = ` Retreated (${err.message})`
          }
          throw new ActionError('LOSING_FIGHT', `Health dropped to ${Math.round(bot.health)} fighting ${label}, so you backed off (${stats}).${note}${broke}`)
        }
        default:
          throw new ActionError('TIMEOUT', `Fought ${label} for ${maxSeconds}s without finishing it (${stats}).${broke}`)
      }
    }
  },

  retreat: {
    description: 'Run away from an entity (use when outmatched or low on health).',
    params: { entityId: 'number', distance: 'number, optional (default 16)' },
    async run (ctx, args) {
      const { bot } = ctx
      const id = Math.floor(argNumber(args, 'entityId'))
      const distance = argNumber(args, 'distance', { min: 6, max: 48, def: 16 })
      const entity = bot.entities[id]
      if (!entity) throw new ActionError('NOT_FOUND', `No entity with id ${id} nearby.`)
      bot.setControlState('sprint', true)
      try {
        await gotoGoal(ctx, new goals.GoalInvert(new goals.GoalFollow(entity, distance)), {
          timeoutMs: 15000, label: `${distance} blocks away from ${entity.name}`
        })
      } catch (err) {
        if (err.code !== 'PATH_TIMEOUT' && err.code !== 'STUCK') throw err
      } finally {
        bot.setControlState('sprint', false)
      }
      const now = entity.isValid ? round1(bot.entity.position.distanceTo(entity.position)) : '?'
      return `Retreated; now ${now} blocks from ${entity.name}.`
    }
  },

  eatFood: {
    description: 'Eat food from your inventory (picks the best food if foodName is omitted).',
    params: { foodName: 'string, optional' },
    async run (ctx, args) {
      const { bot } = ctx
      const foods = bot.registry.foodsByName
      let item
      if (args?.foodName) {
        item = findInventoryItem(bot, args.foodName)
        if (!item || !foods[item.name]) throw new ActionError('MISSING_ITEM', `No edible "${args.foodName}" in inventory.`)
      } else {
        item = bot.inventory.items()
          .filter((i) => foods[i.name] && !BAD_FOODS.has(i.name))
          .sort((a, b) => foods[b.name].effectiveQuality - foods[a.name].effectiveQuality)[0]
        if (!item) throw new ActionError('NO_FOOD', 'You have no safe food. Hunt animals, fish or harvest crops.')
      }
      if (bot.food >= 20 && !/golden_apple|chorus/.test(item.name)) throw new ActionError('NOT_HUNGRY', 'You are not hungry.')
      await bot.equip(item, 'hand')
      try {
        await bot.consume()
      } catch (err) {
        throw new ActionError('EAT_FAILED', `Could not eat ${item.name}: ${err.message}`)
      }
      return `Ate ${item.name}. Food is now ${bot.food}/20.`
    }
  },

  collectDrops: {
    description: 'Pick up dropped items lying on the ground nearby.',
    params: { radius: 'number, optional (default 12)' },
    async run (ctx, args) {
      const radius = argNumber(args, 'radius', { min: 2, max: 32, def: 12 })
      const n = await collectNearbyDrops(ctx, ctx.bot.entity.position, radius, 30000)
      if (n === 0) throw new ActionError('NOT_FOUND', `No dropped items within ${radius} blocks.`)
      return `Picked up ${n} item stack(s).`
    }
  },

  craftItem: {
    description: 'Craft an item. Uses a nearby crafting table automatically when the recipe needs one.',
    params: { itemName: 'string, e.g. "oak_planks", "stick", "wooden_pickaxe"', count: 'number of crafts, optional (default 1)' },
    async run (ctx, args) {
      const { bot } = ctx
      const name = normalizeName(argString(args, 'itemName'))
      const count = Math.floor(argNumber(args, 'count', { min: 1, max: 64, def: 1 }))
      const itemDef = bot.registry.itemsByName[name]
      if (!itemDef) throw new ActionError('UNKNOWN_ITEM', `"${name}" is not a known item.`)

      // Try without a table first (2x2 inventory grid), then with one.
      let recipe = bot.recipesFor(itemDef.id, null, 1, null)[0]
      let table = null
      if (!recipe) {
        const tableBlock = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 })
        const tableRecipes = bot.recipesFor(itemDef.id, null, 1, tableBlock || true)
        if (tableRecipes.length === 0) {
          const anyRecipe = bot.recipesAll(itemDef.id, null, true)[0]
          if (!anyRecipe) throw new ActionError('NO_RECIPE', `${name} cannot be crafted.`)
          const needs = {}
          for (const d of anyRecipe.delta) if (d.count < 0) needs[bot.registry.items[d.id]?.name] = -d.count
          throw new ActionError('MISSING_MATERIALS', `Not enough materials for ${name}. One recipe needs: ${JSON.stringify(needs)}${anyRecipe.requiresTable ? ' (plus a crafting table)' : ''}.`)
        }
        if (!tableBlock) throw new ActionError('NEED_CRAFTING_TABLE', `${name} needs a crafting table. Craft one (4 planks) and place it.`)
        recipe = tableRecipes[0]
        table = tableBlock
        if (bot.entity.position.distanceTo(table.position) > 3.5) {
          await gotoGoal(ctx, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), {
            timeoutMs: travelTimeout(ctx, bot.entity.position.distanceTo(table.position)), label: 'crafting table'
          })
        }
      }

      // Craft as many times as materials allow, up to `count`.
      const perCraft = recipe.result?.count || 1
      let crafts = count
      while (crafts > 1 && bot.recipesFor(itemDef.id, null, crafts * perCraft, table).length === 0) crafts--
      try {
        await bot.craft(recipe, crafts, table)
      } catch (err) {
        throw new ActionError('CRAFT_FAILED', `Crafting ${name} failed: ${err.message}`)
      }
      const have = inventorySummary(bot)[name] || 0
      return `Crafted ${name} x${crafts * perCraft}. You now have ${have}.`
    }
  },

  giveItem: {
    description: 'Walk to a player and toss them items from your inventory (gifts, trades, sharing food with friends).',
    params: { playerName: 'string', itemName: 'string', count: 'number, optional (default 1)' },
    async run (ctx, args) {
      const { bot } = ctx
      const name = argString(args, 'playerName')
      const itemName = argString(args, 'itemName')
      const count = Math.floor(argNumber(args, 'count', { min: 1, max: 64 * 9, def: 1 }))
      const entity = findPlayerEntity(bot, name)
      if (!entity) throw new ActionError('NOT_FOUND', `Player "${name}" is not within render distance.`)
      const item = findInventoryItem(bot, itemName)
      if (!item) throw new ActionError('MISSING_ITEM', `No "${itemName}" in inventory.`)
      const have = inventorySummary(bot)[item.name] || 0
      const distance = bot.entity.position.distanceTo(entity.position)
      assertTravelDistance(ctx, distance)
      if (distance > 3) await gotoGoal(ctx, new goals.GoalFollow(entity, 2), { timeoutMs: travelTimeout(ctx, distance), label: name })
      await bot.lookAt(entity.position.offset(0, 1.2, 0), true)
      const n = Math.min(count, have)
      try {
        await bot.toss(item.type, null, n)
      } catch (err) {
        throw new ActionError('TOSS_FAILED', `Could not give ${item.name}: ${err.message}`)
      }
      ctx.notify?.('gaveItem', { player: entity.username, item: item.name, count: n })
      return `Tossed ${n} ${item.name} to ${entity.username}.${n < count ? ` (you only had ${have})` : ''}`
    }
  },

  sleepInBed: {
    description: 'Sleep in a nearby bed (only works at night or during thunderstorms, with no monsters close).',
    params: {},
    async run (ctx) {
      const { bot, signal } = ctx
      if (bot.isSleeping) return 'Already in bed.'
      const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 })
      if (!bed) throw new ActionError('NO_BED', 'No bed within 32 blocks. Craft one (3 wool + 3 planks) and place it.')
      await goNextTo(ctx, bed, 'bed')
      try {
        await bot.sleep(bed)
      } catch (err) {
        throw new ActionError('CANT_SLEEP', `Can't sleep: ${err.message}`)
      }
      // Stay in bed until morning (or until interrupted).
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); bot.removeListener('wake', done); signal.removeEventListener('abort', onAbort); resolve() }
        const onAbort = () => { Promise.resolve().then(() => bot.wake()).catch(() => {}); done() }
        const timer = setTimeout(done, 30000)
        bot.once('wake', done)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      throwIfAborted(signal)
      return bot.isSleeping ? 'Lying in bed, waiting for the others to sleep.' : 'Slept through the night.'
    }
  },

  smeltItem: {
    description: 'Smelt/cook items in a nearby furnace (ores → ingots, raw meat → cooked). Adds fuel if needed and collects whatever finishes while you wait. Call again later to collect the rest.',
    params: { itemName: 'string, e.g. "raw_iron", "beef"', count: 'number, optional (default 8)', waitSeconds: 'number, optional (default 30)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const itemName = argString(args, 'itemName')
      const count = Math.floor(argNumber(args, 'count', { min: 1, max: 64, def: 8 }))
      const waitSeconds = argNumber(args, 'waitSeconds', { min: 0, max: 120, def: 30 })
      const block = findNearestBlock(bot, ['furnace', 'smoker', 'blast_furnace'])
      if (!block) throw new ActionError('NO_FURNACE', 'No furnace within 32 blocks. Craft one from 8 cobblestone and place it.')
      await goNextTo(ctx, block, block.name)

      const furnace = await bot.openFurnace(block)
      let collected = 0
      try {
        if (furnace.outputItem()) { collected += furnace.outputItem().count; await furnace.takeOutput() }
        const input = findInventoryItem(bot, itemName)
        if (input) {
          const n = Math.min(count, inventorySummary(bot)[input.name] || 0)
          if (!furnace.fuelItem() || furnace.fuel < 0.2) {
            const fuel = bot.inventory.items().find((i) => FUELS.includes(i.name)) ||
              bot.inventory.items().find((i) => /_planks$|_log$|^stick$/.test(i.name) && i.name !== input.name)
            if (!fuel) throw new ActionError('NO_FUEL', 'No fuel (coal, charcoal, planks or logs) in inventory.')
            const perUnit = FUEL_ITEMS_PER_UNIT[fuel.name] ?? (fuel.name === 'stick' ? 0.5 : 1.5)
            await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Math.max(1, Math.ceil(n / perUnit))))
          }
          await furnace.putInput(input.type, null, n)
        } else if (!collected && !furnace.inputItem()) {
          throw new ActionError('MISSING_ITEM', `No "${itemName}" in inventory to smelt.`)
        }
        // Each item takes ~10s; collect as they finish.
        const end = Date.now() + waitSeconds * 1000
        while (Date.now() < end && (furnace.inputItem() || furnace.outputItem())) {
          await abortableSleep(1000, signal)
          const out = furnace.outputItem()
          if (out) { collected += out.count; await furnace.takeOutput() }
        }
      } finally {
        furnace.close()
      }
      return `Collected ${collected} smelted item(s).${collected < count ? ' The furnace is still working on the rest.' : ''}`
    }
  },

  storeItems: {
    description: 'Put items into a nearby chest or barrel. itemNames is a comma-separated list, or "all" (keeps tools, weapons, armor, torches and some food).',
    params: { itemNames: 'string, e.g. "cobblestone, dirt" or "all"' },
    async run (ctx, args) {
      const { bot } = ctx
      const spec = argString(args, 'itemNames', { def: 'all' })
      const block = findNearestBlock(bot, CONTAINERS)
      if (!block) throw new ActionError('NO_CHEST', 'No chest or barrel within 32 blocks.')
      await goNextTo(ctx, block, block.name)
      const wanted = spec.toLowerCase() === 'all' ? null : spec.split(',').map(normalizeName).filter(Boolean)
      const foods = bot.registry.foodsByName
      let keptFood = false
      const toStore = bot.inventory.items().filter((i) => {
        if (wanted) return wanted.some((w) => i.name === w || i.name.includes(w))
        if (KEEP_WHEN_STORING.test(i.name)) return false
        if (foods[i.name] && !keptFood) { keptFood = true; return false }
        return true
      })
      if (!toStore.length) throw new ActionError('NOTHING_TO_STORE', 'Nothing matching to store.')
      const container = await bot.openContainer(block)
      const stored = {}
      try {
        for (const item of toStore) {
          try {
            await container.deposit(item.type, null, item.count)
            stored[item.name] = (stored[item.name] || 0) + item.count
          } catch (err) {
            if (/full/i.test(err.message)) break
          }
        }
      } finally {
        container.close()
      }
      if (!Object.keys(stored).length) throw new ActionError('CHEST_FULL', 'The container is full.')
      return `Stored ${Object.entries(stored).map(([k, v]) => `${v} ${k}`).join(', ')}.`
    }
  },

  takeItems: {
    description: 'Take items out of a nearby chest or barrel.',
    params: { itemName: 'string', count: 'number, optional (default: all of it)' },
    async run (ctx, args) {
      const { bot } = ctx
      const itemName = normalizeName(argString(args, 'itemName'))
      const block = findNearestBlock(bot, CONTAINERS)
      if (!block) throw new ActionError('NO_CHEST', 'No chest or barrel within 32 blocks.')
      await goNextTo(ctx, block, block.name)
      const container = await bot.openContainer(block)
      try {
        const items = container.containerItems()
        const match = items.find((i) => i.name === itemName) || items.find((i) => i.name.includes(itemName))
        if (!match) {
          const contents = {}
          for (const i of items) contents[i.name] = (contents[i.name] || 0) + i.count
          throw new ActionError('NOT_FOUND', `No ${itemName} in the ${block.name}. It has: ${JSON.stringify(contents)}`)
        }
        const available = items.filter((i) => i.type === match.type).reduce((a, i) => a + i.count, 0)
        const n = Math.min(available, Math.floor(argNumber(args, 'count', { min: 1, max: 64 * 27, def: available })))
        await container.withdraw(match.type, null, n)
        return `Took ${n} ${match.name}.`
      } finally {
        container.close()
      }
    }
  },

  activateBlock: {
    description: 'Right-click a block: open/close doors, gates and trapdoors, flip levers, press buttons, ring bells.',
    params: { x: 'number', y: 'number', z: 'number' },
    async run (ctx, args) {
      const { bot } = ctx
      const pos = new Vec3(argNumber(args, 'x'), argNumber(args, 'y'), argNumber(args, 'z')).floored()
      const block = bot.blockAt(pos)
      if (!block || block.name === 'air') throw new ActionError('NOT_FOUND', `Nothing to use at ${fmtPos(pos)}.`)
      if (!/door|gate|trapdoor|lever|button|bell|note_block|daylight_detector|repeater|comparator/.test(block.name)) {
        throw new ActionError('NOT_INTERACTABLE', `${block.name} isn't something you toggle. Use smeltItem/storeItems/sleepInBed/craftItem for workstations.`)
      }
      assertTravelDistance(ctx, bot.entity.position.distanceTo(pos))
      await goNextTo(ctx, block, block.name)
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
      try {
        await bot.activateBlock(block)
      } catch (err) {
        throw new ActionError('USE_FAILED', `Could not use ${block.name}: ${err.message}`)
      }
      return `Used ${block.name} at ${fmtPos(pos)}.`
    }
  },

  fish: {
    description: 'Fish in nearby water with a fishing rod for a while (food and loot).',
    params: { seconds: 'number, optional (default 45, max 120)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const seconds = argNumber(args, 'seconds', { min: 10, max: 120, def: 45 })
      const rod = bot.inventory.items().find((i) => i.name === 'fishing_rod')
      if (!rod) throw new ActionError('MISSING_ITEM', 'You need a fishing_rod (3 sticks + 2 string).')
      const water = findNearestBlock(bot, ['water'], 24)
      if (!water) throw new ActionError('NO_WATER', 'No water within 24 blocks.')
      const dist = bot.entity.position.distanceTo(water.position)
      if (dist > 5) {
        await gotoGoal(ctx, new goals.GoalNear(water.position.x, water.position.y + 1, water.position.z, 3), { timeoutMs: travelTimeout(ctx, dist), label: 'water' })
      }
      await bot.equip(rod, 'hand')
      const before = bot.inventory.items().length
      const counts = inventorySummary(bot)
      const end = Date.now() + seconds * 1000
      const onAbort = () => { try { bot.activateItem() } catch { /* reel in */ } }
      signal.addEventListener('abort', onAbort, { once: true })
      let catches = 0
      try {
        while (Date.now() < end) {
          throwIfAborted(signal)
          await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true)
          const cast = bot.fish()
          cast.catch(() => {}) // reeling in early rejects this; that's expected
          const timeout = abortableSleep(Math.max(1000, end - Date.now()), signal).then(() => 'timeout')
          const r = await Promise.race([cast.then(() => 'caught'), timeout]).catch((err) => { if (err.code === 'ABORTED') throw err; return 'failed' })
          if (r === 'caught') catches++
          else { onAbort(); break }
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      const after = inventorySummary(bot)
      const gained = Object.entries(after).filter(([k, v]) => v > (counts[k] || 0)).map(([k, v]) => `${v - (counts[k] || 0)} ${k}`)
      if (!catches && bot.inventory.items().length === before) throw new ActionError('NO_CATCH', 'Nothing bit.')
      return `Caught ${catches} time(s): ${gained.join(', ') || 'nothing new'}.`
    }
  },

  emote: {
    description: 'Make a body-language gesture (greeting, celebrating, showing emotion).',
    params: { gesture: 'wave|jump|nod|shake_head|crouch|spin|look_around' },
    async run (ctx, args) {
      const gesture = normalizeName(argString(args, 'gesture'))
      await performGesture(ctx.bot, gesture, ctx.signal)
      return `Did a ${gesture}.`
    }
  },

  wait: {
    description: 'Idle for a few seconds (look around, think). Use when there is nothing useful to do or while waiting for someone.',
    params: { seconds: 'number (1-30)' },
    async run (ctx, args) {
      const seconds = argNumber(args, 'seconds', { min: 1, max: 30, def: 5 })
      const end = Date.now() + seconds * 1000
      while (Date.now() < end) {
        if (Math.random() < 0.3) await performGesture(ctx.bot, 'look_around', ctx.signal).catch(() => {})
        await abortableSleep(Math.min(1500, Math.max(0, end - Date.now())), ctx.signal)
      }
      return `Waited ${seconds}s.`
    }
  }
}

// ---------------------------------------------------------------------------
// Shared building blocks used by several actions (and by reactions in index.js)
// ---------------------------------------------------------------------------

/** bot.dig that stops digging when the action is aborted. */
async function digWithAbort (ctx, block) {
  const { bot, signal } = ctx
  const onAbort = () => bot.stopDigging()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await bot.dig(block, true)
  } catch (err) {
    if (signal?.aborted) throw abortError(signal)
    throw new ActionError('DIG_FAILED', `Digging ${block.name} failed: ${err.message}`)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Walk over item entities near `center`. Returns how many we reached. */
async function collectNearbyDrops (ctx, center, radius, budgetMs) {
  const { bot, signal } = ctx
  const end = Date.now() + budgetMs
  const visited = new Set()
  let collected = 0
  await sleep(250) // let the drop entity spawn
  while (Date.now() < end) {
    throwIfAborted(signal)
    const drop = Object.values(bot.entities)
      .filter((e) => e.name === 'item' && !visited.has(e.id) && e.position.distanceTo(center) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (!drop) break
    visited.add(drop.id)
    try {
      await gotoGoal(ctx, new goals.GoalBlock(Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z)), {
        timeoutMs: Math.min(8000, Math.max(1000, end - Date.now())), stuckMs: 3000, label: 'dropped item'
      })
      collected++
    } catch (err) {
      if (err.code === 'ABORTED') throw err
    }
  }
  return collected
}

/** Small, safe body-language animations. */
async function performGesture (bot, gesture, signal) {
  const yaw = bot.entity.yaw
  const pitch = bot.entity.pitch
  switch (gesture) {
    case 'wave':
      for (let i = 0; i < 3; i++) { bot.swingArm('right'); await abortableSleep(250, signal) }
      break
    case 'jump':
      bot.setControlState('jump', true); await abortableSleep(300, signal).finally(() => bot.setControlState('jump', false))
      break
    case 'nod':
      for (let i = 0; i < 2; i++) {
        await bot.look(yaw, 0.6, true); await abortableSleep(200, signal)
        await bot.look(yaw, -0.3, true); await abortableSleep(200, signal)
      }
      await bot.look(yaw, pitch, true)
      break
    case 'shake_head':
      for (let i = 0; i < 2; i++) {
        await bot.look(yaw + 0.6, pitch, true); await abortableSleep(200, signal)
        await bot.look(yaw - 0.6, pitch, true); await abortableSleep(200, signal)
      }
      await bot.look(yaw, pitch, true)
      break
    case 'crouch':
      for (let i = 0; i < 3; i++) {
        bot.setControlState('sneak', true); await abortableSleep(200, signal).catch(() => {})
        bot.setControlState('sneak', false); await abortableSleep(200, signal)
      }
      break
    case 'spin':
      for (let i = 1; i <= 8; i++) { await bot.look(yaw + (i * Math.PI) / 4, pitch, true); await abortableSleep(80, signal) }
      break
    case 'look_around':
      // A smooth (unforced) look only resolves on physics ticks, which pause around death/respawn.
      await Promise.race([bot.look(yaw + (Math.random() - 0.5) * 2.5, (Math.random() - 0.5) * 0.8, false), sleep(1500)])
      break
    default:
      throw new ActionError('INVALID_ARGS', `Unknown gesture "${gesture}". Use wave, jump, nod, shake_head, crouch, spin or look_around.`)
  }
}

// ---------------------------------------------------------------------------
// ActionExecutor — runs exactly one action at a time, safely.
// ---------------------------------------------------------------------------

class ActionExecutor {
  /**
   * @param {object} deps
   * @param {import('mineflayer').Bot} deps.bot
   * @param {object} deps.config   full bot config
   * @param {object} deps.chat     ChatManager (used by chatMessage)
   * @param {object} deps.log      logger
   * @param {function} [deps.notify] (eventName, data) => void — lets actions trigger reactions
   * @param {object} [deps.social]   SocialModel (trust-aware PvP rules)
   * @param {object} [deps.learning] Learning (combat style selection & results)
   * @param {object} [deps.memory]   Memory (recent chat, e.g. duel invitations)
   * @param {object} [deps.tasks]    TaskManager (fights the bot agreed to)
   */
  constructor ({ bot, config, chat, log, notify, social, learning, memory, tasks }) {
    Object.assign(this, { bot, config, chat, log, notify, social, learning, memory, tasks })
    this.current = null // { name, args, startedAt, controller }
  }

  get busy () { return this.current !== null }

  /** Names of tools the LLM may call right now (config + chat mode aware). */
  availableTools () {
    const { enabledActions, disabledActions } = this.config.behavior
    return Object.keys(ACTIONS).filter((name) => {
      if (enabledActions?.length && !enabledActions.includes(name)) return false
      if (disabledActions?.includes(name)) return false
      if (name === 'chatMessage' && !this.chat.allows('tool')) return false
      return true
    })
  }

  /** Tool documentation for the system prompt. */
  describeTools () {
    return this.availableTools().map((name) => {
      const a = ACTIONS[name]
      const params = Object.entries(a.params).map(([k, v]) => `${k}: ${v}`).join(', ')
      return `- ${name}(${params}) — ${a.description}`
    }).join('\n')
  }

  /**
   * Execute an action. Never throws: always resolves to
   * { ok: boolean, action, args, code?, message, durationMs }.
   */
  async execute (name, args = {}) {
    const started = Date.now()
    const base = { action: name, args }
    const finish = (r) => ({ ...base, ...r, durationMs: Date.now() - started })

    if (this.current) return finish({ ok: false, code: 'BUSY', message: `Already running ${this.current.name}.` })
    const action = ACTIONS[name]
    if (!action || !this.availableTools().includes(name)) {
      return finish({ ok: false, code: 'UNKNOWN_ACTION', message: `"${name}" is not an available action. Use one of: ${this.availableTools().join(', ')}.` })
    }
    if (!this.bot.entity) return finish({ ok: false, code: 'NOT_SPAWNED', message: 'Bot is not spawned.' })

    const controller = new AbortController()
    this.current = { name, args, startedAt: started, controller }
    const ctx = {
      bot: this.bot,
      config: this.config,
      chat: this.chat,
      log: this.log,
      notify: this.notify,
      social: this.social,
      learning: this.learning,
      memory: this.memory,
      tasks: this.tasks,
      signal: controller.signal
    }

    // Global safety net on top of each action's own timeouts.
    const hardTimeout = setTimeout(() => controller.abort('hard timeout'), this.config.loop.maxActionMs)

    try {
      const message = await action.run(ctx, args && typeof args === 'object' ? args : {})
      return finish({ ok: true, message: String(message ?? 'Done.') })
    } catch (err) {
      if (err instanceof ActionError) return finish({ ok: false, code: err.code, message: err.message })
      // Unexpected error: log the stack for the developer, give the LLM a short version.
      this.log.warn(`Action ${name} crashed: ${err?.stack || err}`)
      return finish({ ok: false, code: 'INTERNAL_ERROR', message: `Unexpected error: ${err?.message || err}` })
    } finally {
      clearTimeout(hardTimeout)
      this.cleanupControls()
      this.current = null
    }
  }

  /** Interrupt whatever is running (death, owner command, damage, shutdown...). */
  abort (reason = 'interrupted') {
    if (!this.current) return false
    this.log.info(`Aborting ${this.current.name}: ${reason}`)
    this.current.controller.abort(reason)
    this.cleanupControls()
    return true
  }

  cleanupControls () {
    try {
      // setGoal(null) resets immediately. Don't use pathfinder.stop(): it sets a
      // sticky flag that cancels the *next* path instead of the current one.
      this.bot.pathfinder?.setGoal(null)
      this.bot.clearControlStates()
      if (this.bot.targetDigBlock) this.bot.stopDigging()
    } catch { /* bot may already be disconnected */ }
  }
}

module.exports = {
  ACTIONS,
  ActionExecutor,
  ActionError,
  performGesture,
  normalizeName,
  inventorySummary,
  durabilityLeft
}
