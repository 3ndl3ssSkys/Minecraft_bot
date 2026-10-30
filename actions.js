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

const { ActionError, sleep, abortError, throwIfAborted, abortableSleep, normalizeName, fmtPos } = require('./util')
const combat = require('./combat')
const knowledge = require('./knowledge')
const building = require('./building')
const { signText } = require('./containers')

function round1 (n) {
  return Math.round(n * 10) / 10
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
 *   - pausing: when the bot stops to type a chat message it stands still and
 *     then carries on (our own driver, because pathfinder.goto treats any goal
 *     change as a failure),
 *   - translation of pathfinder results into ActionError codes.
 */
async function gotoGoal (ctx, goal, { timeoutMs = 30000, stuckMs = 8000, label = 'destination', dynamic = false } = {}) {
  const { bot, signal } = ctx
  throwIfAborted(signal)

  let timer, stuckTimer, onAbort, offPause
  let lastPos = bot.entity.position.clone()
  let lastMoveAt = Date.now()
  let paused = false
  let pausedTotal = 0
  const listeners = []
  const on = (ev, fn) => { bot.on(ev, fn); listeners.push([ev, fn]) }

  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new ActionError('PATH_TIMEOUT', `Could not reach ${label} within ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs)

    stuckTimer = setInterval(() => {
      const pos = bot.entity?.position
      if (!pos || paused) { lastMoveAt = Date.now(); return }
      if (pos.distanceTo(lastPos) > 0.5) {
        lastPos = pos.clone()
        lastMoveAt = Date.now()
      } else if (Date.now() - lastMoveAt > stuckMs && !bot.pathfinder.isMining() && !bot.pathfinder.isBuilding()) {
        reject(new ActionError('STUCK', `Got stuck at ${fmtPos(pos)} while moving to ${label}.`))
      }
    }, 1000)

    onAbort = () => reject(abortError(signal))
    signal?.addEventListener('abort', onAbort, { once: true })

    on('goal_reached', () => { if (!paused) resolve() })
    on('path_update', (r) => {
      if (paused) return
      if (r.status === 'noPath') reject(new ActionError('NO_PATH', `There is no walkable path to ${label}.`))
      else if (r.status === 'timeout') reject(new ActionError('PATH_TIMEOUT', `Path calculation to ${label} took too long (probably too far or blocked).`))
      else if (r.path.length === 0 && goal.isEnd(bot.entity.position.floored())) resolve()
    })
    on('path_stop', () => { if (!paused) reject(new ActionError('PATH_INTERRUPTED', `Movement to ${label} was interrupted.`)) })

    // Stop to type, then carry on.
    offPause = ctx.onPause?.((ms) => {
      if (paused) return
      paused = true
      const t = Date.now()
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
      setTimeout(() => {
        paused = false
        pausedTotal += Date.now() - t
        if (!signal?.aborted) bot.pathfinder.setGoal(goal, dynamic)
      }, ms)
    })

    if (goal.isEnd(bot.entity.position.floored())) return resolve()
    bot.pathfinder.setGoal(goal, dynamic)
  })

  try {
    await done
  } finally {
    clearTimeout(timer)
    clearInterval(stuckTimer)
    signal?.removeEventListener('abort', onAbort)
    offPause?.()
    for (const [ev, fn] of listeners) bot.removeListener(ev, fn)
    // Always leave the pathfinder idle so the next action starts clean.
    if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
  }
  return pausedTotal
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

const BUILT = /planks$|glass|_bricks$|wool$|concrete|terracotta$|_door$|_bed$|lantern|bookshelf|carpet$|_sign$|_stairs$|_slab$|_fence$|_wall$|torch$|smooth_|chiseled_|quartz|crafting_table|furnace|chest|barrel/

/** A crafted-looking block with several other crafted-looking blocks around it: someone built this. */
function looksPlayerBuilt (bot, block) {
  if (!BUILT.test(block.name)) return false
  if (bot.entity && insideOwnBuild(bot, block.position)) return false
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const b = bot.blockAt(block.position.offset(dx, dy, dz))
    if (b && BUILT.test(b.name)) n++
  }
  return n >= 4
}
let ownBuilds = []
/** Is this inside one of the bot's own buildings? (set by the executor) */
function insideOwnBuild (bot, pos) {
  return ownBuilds.some((o) => Math.abs(o.x - pos.x) <= 14 && Math.abs(o.z - pos.z) <= 14 && Math.abs(o.y - pos.y) <= 16)
}

// Wall-mounted things: place them against the side of a block, not on the floor.
const WALL_MOUNTED = /^(torch|soul_torch|ladder|\w+_wall_sign|lever|\w+_button|tripwire_hook)$/
const REPLACEABLE = /^(air|cave_air|water|lava|short_grass|grass|tall_grass|fern|large_fern|snow|dead_bush|vine|seagrass|\w+_flower|dandelion|poppy)$/

/**
 * Place `item` at `pos`: find a solid neighbour to click (preferring a wall
 * for torches/ladders), walk into reach without standing in the cell, sneak
 * against interactable blocks, and verify the result.
 * @param {{ clearSoft?: boolean }} opts dig out grass/flowers in the way first
 */
async function placeAt (ctx, pos, item, { clearSoft = true } = {}) {
  const { bot } = ctx
  if (!bot.registry.blocksByName[item.name] && !/_seeds$|torch$|_sign$|bucket$|^ladder$|_door$|_bed$|^string$|redstone$/.test(item.name)) {
    throw new ActionError('NOT_PLACEABLE', `${item.name} is not a placeable block.`)
  }
  let target = bot.blockAt(pos)
  if (!target) throw new ActionError('NOT_LOADED', `Chunk at ${fmtPos(pos)} is not loaded.`)
  if (target.boundingBox !== 'empty' && !REPLACEABLE.test(target.name)) {
    throw new ActionError('OCCUPIED', `${fmtPos(pos)} is already occupied by ${target.name}.`)
  }
  if (clearSoft && target.boundingBox === 'empty' && !/^(air|cave_air|water|lava)$/.test(target.name) && target.diggable) {
    await goNextTo(ctx, target, target.name).catch(() => {})
    await digWithAbort(ctx, target).catch(() => {})
    target = bot.blockAt(pos)
  }

  const down = new Vec3(0, -1, 0)
  const sidesFirst = WALL_MOUNTED.test(item.name)
  const faces = sidesFirst
    ? [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), down, new Vec3(0, 1, 0)]
    : [down, new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]
  let reference = null
  let faceVector = null
  for (const dir of faces) {
    const b = bot.blockAt(pos.plus(dir))
    if (b && b.boundingBox === 'block') { reference = b; faceVector = dir.scaled(-1); break }
  }
  if (!reference) throw new ActionError('NO_SUPPORT', `Nothing solid next to ${fmtPos(pos)} to place against.`)

  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2 || bot.entity.position.floored().equals(pos) || bot.entity.position.offset(0, 1, 0).floored().equals(pos)) {
    try {
      await gotoGoal(ctx, new goals.GoalPlaceBlock(pos, bot.world, { range: 4 }), {
        timeoutMs: travelTimeout(ctx, bot.entity.position.distanceTo(pos)), label: `placement spot for ${fmtPos(pos)}`
      })
    } catch (err) {
      if (err.code === 'ABORTED') throw err
      if (bot.entity.position.distanceTo(pos) > 4.5) throw err // maybe already close enough
    }
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
  if (/^(chest|trapped_chest|barrel|\w*shulker_box)$/.test(item.name)) ctx.containers?.onPlaced(pos, item.name)
}

/** Look inside a container and remember what's in it. */
async function readContainer (ctx, block) {
  const { bot } = ctx
  await goNextTo(ctx, block, block.name)
  const container = await bot.openContainer(block)
  try {
    const contents = {}
    for (const i of container.containerItems()) contents[i.name] = (contents[i.name] || 0) + i.count
    const info = ctx.containers?.inspect(bot, block, contents)
    return { contents, info }
  } finally {
    container.close()
  }
}

/** "a community chest (sign: "free stuff") — missing since you last looked: 3 bread" */
function describeContainer (info) {
  if (!info) return ''
  return ` It looks like ${info.label}${info.reasons.length ? ` (${info.reasons.join('; ')})` : ''}.${info.changes ? ` ${info.changes[0].toUpperCase()}${info.changes.slice(1)}.` : ''}`
}

/** Ground-level spot within a few blocks, a bit higher or lower than us, for parkour hops. */
function hopTargets (bot, radius = 5) {
  const me = bot.entity.position.floored()
  const out = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const dist = Math.hypot(dx, dz)
      if (dist < 2 || dist > radius) continue
      for (let dy = 2; dy >= -2; dy--) {
        const feet = me.offset(dx, dy, dz)
        const below = bot.blockAt(feet.offset(0, -1, 0))
        const at = bot.blockAt(feet)
        const head = bot.blockAt(feet.offset(0, 1, 0))
        if (below?.boundingBox === 'block' && !/lava|magma|cactus|campfire/.test(below.name) && at?.boundingBox === 'empty' && head?.boundingBox === 'empty' && !/lava|water/.test(at.name)) {
          out.push({ pos: feet, interest: Math.abs(dy) + (dist >= 3 ? 1 : 0) })
          break
        }
      }
    }
  }
  return out.sort((a, b) => b.interest - a.interest)
}

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
      const goal = new goals.GoalFollow(entity, 2)
      bot.pathfinder.setGoal(goal, true)
      try {
        const end = Date.now() + duration * 1000
        while (Date.now() < end) {
          await abortableSleep(500, signal)
          if (!entity.isValid) return `Lost track of ${name}.`
          // Stopped to type: stand still, then catch up.
          if (ctx.isPaused?.()) {
            bot.pathfinder.setGoal(null)
            while (ctx.isPaused()) await abortableSleep(100, signal)
            bot.pathfinder.setGoal(goal, true)
          }
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
        // Good guest: leave other players' builds alone.
        if (ctx.config.behavior.noGrief && looksPlayerBuilt(bot, block)) {
          skip.add(pos.toString())
          failureNotes.push(`skipped ${block.name} at ${fmtPos(pos)}: it's part of someone's build`)
          continue
        }

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
      assertTravelDistance(ctx, bot.entity.position.distanceTo(pos))
      await placeAt(ctx, pos, item)
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
    description: 'Fight an entity by its id (from nearbyEntities) with real tactics: crits, w-taps, strafing, shield, axe vs shields, axe/sword combos, ' +
      'bow/crossbow at range, mace + wind-charge smashes, splash potions, golden apples, totems, cobwebs, pearl escapes, per-mob tactics. ' +
      'Uses whatever you carry and the style that has worked best before, unless you pass one.',
    params: {
      entityId: 'number',
      maxSeconds: 'number, optional (default 25)',
      style: 'optional: aggressive|balanced|cautious|hitAndRun|comboAxe|ranged|mace',
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
      const weaponBefore = bot.heldItem

      const key = entity.type === 'player' ? `player:${entity.username}` : entity.name
      const available = combat.availableStyles(bot, ctx.intel)
      const style = ctx.learning
        ? ctx.learning.combat.chooseStyle(key, { forced: args?.style, available })
        : { name: 'balanced', crit: true, wtap: true, strafe: true, shield: true, retreatHealth: 7 }
      ctx.log.info(`Fighting ${label} with style "${style.name}" (retreat at ${style.retreatHealth} hp) — kit: ${combat.describeKit(bot)}`)

      let result
      try {
        result = await combat.fight(ctx, entity, style, maxSeconds)
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
      const usedList = Object.entries(result.used || {}).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')
      const stats = `${result.hitsLanded} hits landed, ${result.hitsTaken} taken, style ${style.name}${usedList ? `, used ${usedList}` : ''}`

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
            if (bot.health <= 6 && entity.isValid && (ctx.intel?.can('pearlEscape') ?? true) && await combat.pearlEscape(ctx, entity)) note = ' Pearled away.'
            else await ACTIONS.retreat.run(ctx, { entityId: id, distance: 18 })
            await ACTIONS.eatFood.run(ctx, {})
            note += ' Retreated and ate to recover.'
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
        const after = {}
        for (const i of container.containerItems()) after[i.name] = (after[i.name] || 0) + i.count
        ctx.containers?.inspect(bot, block, after)
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
        const before = {}
        for (const i of items) before[i.name] = (before[i.name] || 0) + i.count
        const info = ctx.containers?.inspect(bot, block, before)
        // Someone else's private chest: that's stealing.
        const permission = ctx.containers?.mayTake(block.position, { forPlayer: ctx.tasks?.active()?.from })
        if (permission && !permission.ok) throw new ActionError('NOT_YOURS', permission.reason)
        const match = items.find((i) => i.name === itemName) || items.find((i) => i.name.includes(itemName))
        if (!match) {
          const contents = {}
          for (const i of items) contents[i.name] = (contents[i.name] || 0) + i.count
          throw new ActionError('NOT_FOUND', `No ${itemName} in the ${block.name}. It has: ${JSON.stringify(contents)}`)
        }
        const available = items.filter((i) => i.type === match.type).reduce((a, i) => a + i.count, 0)
        const n = Math.min(available, Math.floor(argNumber(args, 'count', { min: 1, max: 64 * 27, def: available })))
        await container.withdraw(match.type, null, n)
        const after = {}
        for (const i of container.containerItems()) after[i.name] = (after[i.name] || 0) + i.count
        ctx.containers?.noteSelfTook(block.position)
        ctx.containers?.inspect(bot, block, after)
        return `Took ${n} ${match.name} from ${info?.label || block.name}.`
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

  useItem: {
    description: 'Use an item the right way: drink/eat it, throw it (splash potions, ender pearls, wind charges, snowballs) at an entity, a spot or your own feet, ' +
      'place a bucket, or use it on a block/entity (bone meal on crops, flint and steel on a portal, shears on a sheep, name tag/lead on a mob).',
    params: { itemName: 'string', target: 'optional: "self" | "feet" | entity id | "x,y,z"' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const item = findInventoryItem(bot, argString(args, 'itemName'))
      if (!item) throw new ActionError('MISSING_ITEM', `No "${args.itemName}" in inventory.`)
      const raw = args?.target === undefined || args.target === null ? 'self' : String(args.target).trim()
      const entity = /^\d+$/.test(raw) ? bot.entities[Number(raw)] : null
      const coords = raw.match(/^(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)$/)
      const point = coords ? new Vec3(Number(coords[1]), Number(coords[2]), Number(coords[3])) : null
      const n = item.name
      const how = knowledge.USES[n] ? ` (${knowledge.USES[n]})` : ''

      if (bot.registry.foodsByName[n] || n === 'potion' || n === 'milk_bucket' || n === 'honey_bottle') {
        await combat.consume(bot, item, signal)
        return `Consumed ${n}.`
      }
      const throwable = { splash_potion: 'splash', lingering_potion: 'splash', ender_pearl: 'pearl', wind_charge: 'wind_charge', snowball: 'snowball', egg: 'snowball', ender_eye: 'pearl' }[n]
      if (throwable) {
        const to = entity || point || 'feet'
        if (!(await combat.throwItem(bot, item, to, throwable))) throw new ActionError('NO_SHOT', `Couldn't find an angle to throw ${n} there.`)
        return `Threw ${n} at ${entity ? entity.username || entity.name : point ? fmtPos(point) : 'your feet'}.${how}`
      }
      if (entity) {
        await combat.hold(bot, item)
        await bot.lookAt(entity.position.offset(0, (entity.height || 1) * 0.5, 0), true)
        bot.activateEntity(entity)
        return `Used ${n} on ${entity.username || entity.name}.${how}`
      }
      if (point) {
        const block = bot.blockAt(point)
        if (!block) throw new ActionError('NOT_LOADED', `${fmtPos(point)} isn't loaded.`)
        await goNextTo(ctx, block, block.name)
        await combat.hold(bot, item)
        await bot.lookAt(point.offset(0.5, 0.5, 0.5), true)
        if (/bucket$/.test(n)) bot.activateItem()
        else await bot.activateBlock(block)
        return `Used ${n} on ${block.name} at ${fmtPos(point)}.${how}`
      }
      if (n === 'water_bucket') { await combat.douse(bot, item); return 'Splashed water at your feet and picked it back up.' }
      if (n === 'totem_of_undying' || n === 'shield') { await bot.equip(item, 'off-hand'); return `Put the ${n} in your off-hand.${how}` }
      await combat.hold(bot, item)
      bot.activateItem()
      await sleep(300)
      bot.deactivateItem()
      return `Used ${n}.${how}`
    }
  },

  knowledge: {
    description: 'Recall what you know about an item, block, mob or topic: what it is for, how to get or craft it, tips. Instant — use it when unsure.',
    params: { topic: 'string, e.g. "bucket", "how to find diamonds", "brewing", "mace"' },
    async run (ctx, args) {
      return knowledge.lookup(ctx.bot.registry, argString(args, 'topic'), ctx.knowledgeOpts?.() || {})
    }
  },

  readSigns: {
    description: 'Read the signs around you (up to 12 blocks) — names, rules, directions, shop info, "keep out"...',
    params: { radius: 'number, optional (default 12)' },
    async run (ctx, args) {
      const { bot } = ctx
      const radius = argNumber(args, 'radius', { min: 2, max: 24, def: 12 })
      const ids = bot.registry.blocksArray.filter((b) => /_sign$|_hanging_sign$/.test(b.name)).map((b) => b.id)
      const signs = bot.findBlocks({ matching: ids, maxDistance: radius, count: 12 })
        .map((p) => ({ p, text: signText(bot.blockAt(p)) }))
        .filter((x) => x.text)
      if (!signs.length) throw new ActionError('NOT_FOUND', `No readable signs within ${radius} blocks.`)
      return signs.map((x) => `sign at ${fmtPos(x.p)}: "${x.text}"`).join('\n')
    }
  },

  inspectContainer: {
    description: 'Open a nearby chest/barrel and remember what is inside (no args = nearest one you haven\'t checked recently).',
    params: { x: 'number, optional', y: 'number, optional', z: 'number, optional' },
    async run (ctx, args) {
      const { bot } = ctx
      let block
      if (args?.x !== undefined) block = bot.blockAt(new Vec3(argNumber(args, 'x'), argNumber(args, 'y'), argNumber(args, 'z')).floored())
      else {
        const ids = CONTAINERS.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
        const seen = (p) => ctx.containers?.seenRecently(p)
        const pos = bot.findBlocks({ matching: ids, maxDistance: 16, count: 12 }).find((p) => !seen(p))
        block = pos && bot.blockAt(pos)
      }
      if (!block || !CONTAINERS.includes(block.name)) throw new ActionError('NOT_FOUND', 'No unchecked chest or barrel nearby.')
      const { contents, info } = await readContainer(ctx, block)
      const list = Object.entries(contents).map(([k, v]) => `${v} ${k}`).join(', ')
      return `${block.name} at ${fmtPos(block.position)}: ${list || 'empty'}.${describeContainer(info)}`
    }
  },

  parkour: {
    description: 'Hop and sprint-jump around nearby blocks for a bit, like a player fidgeting while thinking.',
    params: { seconds: 'number, optional (default 8)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const end = Date.now() + argNumber(args, 'seconds', { min: 2, max: 30, def: 8 }) * 1000
      const home = bot.entity.position.clone() // fidget around here, don't wander off
      let hops = 0
      while (Date.now() < end) {
        throwIfAborted(signal)
        const options = hopTargets(bot).filter((o) => o.pos.distanceTo(home) <= 4.5).slice(0, 8)
        if (!options.length) break
        const t = options[Math.floor(Math.random() * options.length)].pos
        bot.setControlState('sprint', true)
        try {
          await gotoGoal(ctx, new goals.GoalBlock(t.x, t.y, t.z), { timeoutMs: 4000, stuckMs: 2500, label: 'hop' })
          hops++
        } catch (err) {
          if (err.code === 'ABORTED') throw err
        } finally {
          bot.setControlState('sprint', false)
        }
        if (Math.random() < 0.3) await performGesture(bot, Math.random() < 0.5 ? 'jump' : 'look_around', signal).catch(() => {})
      }
      return `Hopped around (${hops} jumps).`
    }
  },

  planBuilding: {
    description: 'Design a building of your own near you, fitted to the terrain (flattened, terraced, on stilts, or dug into a hill). ' +
      'Describe your idea in "concept" (style, mood, what it is for). Returns the plan and the materials it needs. Then use build to construct it.',
    params: { purpose: 'house|shelter|storage|workshop|lookout|hut', concept: 'string — your idea, e.g. "cozy spruce cabin with a porch by the lake"', size: 'optional: small|medium|large' },
    async run (ctx, args) {
      const { bot } = ctx
      if (!ctx.builder) throw new ActionError('UNAVAILABLE', 'Building is not available.')
      const res = building.planBuilding(bot, {
        purpose: normalizeName(args?.purpose || 'house'),
        concept: String(args?.concept || '').slice(0, 200),
        size: args?.size ? normalizeName(args.size) : undefined,
        owner: ctx.builder.owner,
        complexity: ctx.intel ? ctx.intel.level('building') : 7
      }, { dangerCost: (x, y, z) => ctx.learning?.movement.costAt({ x, y, z }) || 0 })
      if (!res.ok) throw new ActionError('NO_SITE', res.reason)
      ctx.builder.current = res.plan
      ctx.learning?.markDirty()
      const need = Object.entries(res.plan.materials).map(([k, v]) => `${v} ${k}`).join(', ')
      const missing = Object.entries(res.plan.missing).map(([k, v]) => `${v} ${k}`).join(', ')
      return `Planned ${building.describePlan(res.plan)} Needs: ${need}.${missing ? ` Still missing: ${missing}.` : ' You have everything.'}`
    }
  },

  build: {
    description: 'Keep building your current plan (a few dozen blocks per call: clearing, foundation, walls, roof, details). ' +
      'If materials run out it tells you exactly what to gather.',
    params: { maxBlocks: 'number, optional (default 40)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const plan = ctx.builder?.current
      if (!plan) throw new ActionError('NO_PLAN', 'You have no building plan. Use planBuilding first.')
      const maxBlocks = Math.floor(argNumber(args, 'maxBlocks', { min: 5, max: 120, def: 40 }))
      const started = Date.now()
      let work = 0
      while (plan.cursor < plan.steps.length && work < maxBlocks && Date.now() - started < 100000) {
        throwIfAborted(signal)
        const step = plan.steps[plan.cursor]
        const pos = new Vec3(step.x, step.y, step.z)
        const cur = bot.blockAt(pos)
        if (!cur || bot.entity.position.distanceTo(pos) > 48) {
          // Walk back to the site first.
          const o = plan.origin
          const dist = bot.entity.position.distanceTo(new Vec3(o.x, o.y, o.z))
          if (dist > ctx.config.behavior.maxTravelDistance) throw new ActionError('TOO_FAR', `You're ${Math.round(dist)} blocks from ${plan.name}; travel back first.`)
          await gotoGoal(ctx, new goals.GoalNear(o.x, o.y, o.z, 4), { timeoutMs: travelTimeout(ctx, dist), label: plan.name })
          continue
        }
        try {
          if (step.remove) {
            if (cur.boundingBox === 'empty' && !/water|lava/.test(cur.name)) { plan.cursor++; continue }
            if (!cur.diggable || /chest|barrel|furnace|bed|shulker/.test(cur.name)) { plan.cursor++; continue }
            if (/water|lava/.test(cur.name)) { plan.cursor++; continue }
            if (!bot.canDigBlock(cur)) await gotoGoal(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { timeoutMs: 20000, label: 'block to clear' })
            const fresh = bot.blockAt(pos)
            if (fresh && fresh.boundingBox !== 'empty') { await equipToolFor(ctx, fresh).catch(() => {}); await digWithAbort(ctx, fresh) }
            plan.cursor++; work++
            continue
          }
          // Furniture and fixtures ("bed", "torch", "chest") match any variant we carry; skipped if we have none.
          const fixedItem = step.fixed && bot.inventory.items().find((i) => i.name === step.fixed || i.name.endsWith(`_${step.fixed}`))
          if (step.fixed && !fixedItem) { plan.cursor++; continue }
          const material = fixedItem ? fixedItem.name : building.materialFor(plan, step, bot)
          if (cur.name === material) { plan.cursor++; continue }
          if (!material) {
            if (step.optional) { plan.cursor++; continue }
            const { missing } = building.remaining(plan, bot)
            const list = Object.entries(missing).map(([k, v]) => `${v} ${k}`).join(', ')
            const tips = Object.keys(missing).slice(0, 2).map((m) => knowledge.howToObtain(bot.registry, m, ctx.knowledgeOpts?.() || {})[0]).filter(Boolean).join('; ')
            const options = (plan.candidates[step.role] || []).join('/')
            throw new ActionError('MISSING_MATERIALS', `${plan.name} is ${Math.round(plan.cursor / plan.steps.length * 100)}% built and you're out of ${step.role} material (${options}). Still needed: ${list}.${tips ? ` (${tips})` : ''}`)
          }
          // Something solid but wrong in the way (dirt where the floor goes, etc.): dig it out.
          if (cur.boundingBox === 'block' && cur.name !== material) {
            if (!cur.diggable || /chest|barrel|furnace|bed|shulker/.test(cur.name)) { plan.cursor++; plan.failed++; continue }
            if (!bot.canDigBlock(cur)) await gotoGoal(ctx, new goals.GoalLookAtBlock(pos, bot.world, { reach: 4 }), { timeoutMs: 20000, label: 'block in the way' })
            await equipToolFor(ctx, cur).catch(() => {})
            await digWithAbort(ctx, bot.blockAt(pos))
          }
          const item = bot.inventory.items().find((i) => i.name === material)
          await placeAt(ctx, pos, item)
          plan.placed++
          plan.cursor++
          work++
        } catch (err) {
          if (err.code === 'ABORTED' || err.code === 'MISSING_MATERIALS' || err.code === 'TOO_FAR') throw err
          step.attempts = (step.attempts || 0) + 1
          if (step.attempts >= 2) { plan.cursor++; plan.failed++ }
          ctx.log.debug(`build step at ${fmtPos(pos)} failed: ${err.message}`)
        }
      }
      ctx.learning?.markDirty()
      if (plan.cursor >= plan.steps.length) {
        ctx.builder.history.push({ name: plan.name, origin: plan.origin, style: plan.style, finishedAt: Date.now(), placed: plan.placed })
        ctx.builder.current = null
        ctx.notify?.('buildDone', { name: plan.name, placed: plan.placed })
        return `Finished ${plan.name}! (${plan.placed} blocks placed${plan.failed ? `, ${plan.failed} spots skipped` : ''})`
      }
      return `Worked on ${plan.name}: ${work} blocks this round. ${building.describePlan(plan)}`
    }
  },

  cancelBuilding: {
    description: 'Give up on the current building plan.',
    params: {},
    async run (ctx) {
      const plan = ctx.builder?.current
      if (!plan) throw new ActionError('NO_PLAN', 'No building plan to cancel.')
      ctx.builder.current = null
      return `Dropped the plan for ${plan.name} (${Math.round(plan.cursor / plan.steps.length * 100)}% done).`
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
  constructor ({ bot, config, chat, log, notify, social, learning, memory, tasks, builder, intel, containers, knowledgeOpts }) {
    Object.assign(this, { bot, config, chat, log, notify, social, learning, memory, tasks, builder, intel, containers, knowledgeOpts })
    this.current = null // { name, args, startedAt, controller }
    this.pauseUntil = 0
    this.pauseListeners = new Set()
  }

  /**
   * Stand still for `ms` (the player has the chat box open). Running actions
   * that move (pathfinding, fighting) stop and carry on afterwards.
   */
  async pauseFor (ms) {
    if (ms <= 0) return
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + ms)
    for (const fn of this.pauseListeners) { try { fn(ms) } catch { /* ignore */ } }
    if (!this.current) {
      try { this.bot.pathfinder?.setGoal(null); this.bot.clearControlStates() } catch { /* ignore */ }
    }
    await sleep(ms)
  }

  get paused () { return Date.now() < this.pauseUntil }

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
    ownBuilds = [this.builder?.current?.origin, ...(this.builder?.history || []).map((h) => h.origin)].filter(Boolean)
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
      builder: this.builder,
      intel: this.intel,
      containers: this.containers,
      knowledgeOpts: this.knowledgeOpts,
      isPaused: () => this.paused,
      onPause: (fn) => { this.pauseListeners.add(fn); return () => this.pauseListeners.delete(fn) },
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
  abort (reason = 'interrupted', { quiet = false } = {}) {
    if (!this.current) return false
    if (quiet) this.log.debug(`Aborting ${this.current.name}: ${reason}`)
    else this.log.info(`Aborting ${this.current.name}: ${reason}`)
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
