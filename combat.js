'use strict'

/**
 * combat.js — how the bot actually fights.
 *
 * One loop (~20 updates/s) that picks, every tick, between:
 *
 *   sustain   totem to off-hand when low, splash/drink healing, golden apples
 *             (backing off to eat), regeneration, fire resistance / water when burning
 *   buffs     strength / swiftness / fire resistance before a serious fight
 *   mace      wind charge at your feet → launch → swap to mace → smash on the way down
 *             (also: drop onto a target from high ground)
 *   ranged    bow / crossbow with gravity + drag ballistics and target leading,
 *             switching to melee when they close in
 *   potions   splash harming / poison / weakness / slowness at the enemy
 *             (healing hurts undead and harming heals them — handled)
 *   melee     crits (hit while falling), sprint-reset w-taps, strafing, shield
 *             blocking between swings, axe to break a raised shield, axe→sword combos,
 *             respecting each weapon's attack cooldown (which item swaps reset)
 *   utility   cobweb at an approaching player's feet, ender pearl escapes
 *
 * plus per-mob tactics (creepers hit-and-run, slimes split and get chased down,
 * skeletons closed down behind a shield, breezes deflect arrows, wardens: run).
 */

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { ActionError, sleep, abortableSleep, throwIfAborted } = require('./util')

// ---------------------------------------------------------------------------
// Items & effects
// ---------------------------------------------------------------------------

/** Vanilla potion registry order (1.20.5+ sends potions as these ids). */
const POTION_IDS = ['water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision', 'invisibility', 'long_invisibility',
  'leaping', 'long_leaping', 'strong_leaping', 'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness',
  'slowness', 'long_slowness', 'strong_slowness', 'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing',
  'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration',
  'long_regeneration', 'strong_regeneration', 'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck',
  'slow_falling', 'long_slow_falling', 'wind_charged', 'weaving', 'oozing', 'infested']

/** Undead mobs: instant damage heals them, instant health hurts them, poison does nothing. */
const UNDEAD = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'wither_skeleton', 'bogged', 'phantom',
  'zombified_piglin', 'zoglin', 'wither', 'skeleton_horse', 'zombie_horse'])

/** Per-mob tactics. */
const MOB_TACTICS = {
  creeper: { style: 'hitAndRun', preferBow: true },
  skeleton: { ranged: true, shieldUp: true }, stray: { ranged: true, shieldUp: true }, bogged: { ranged: true, shieldUp: true },
  pillager: { ranged: true, shieldUp: true }, blaze: { ranged: true, preferBow: true, fire: true }, ghast: { ranged: true, preferBow: true, onlyRanged: true },
  witch: { rush: true }, evoker: { rush: true }, vindicator: { shieldUp: true },
  slime: { splits: true }, magma_cube: { splits: true, fire: true },
  breeze: { noProjectiles: true, shieldUp: true },
  enderman: { noProjectiles: true }, // arrows just teleport away
  warden: { flee: true }, ender_dragon: { onlyRanged: true }, wither: { preferBow: true },
  phantom: { waitForSwoop: true }, spider: {}, cave_spider: {}, zombie: {}, husk: {}, drowned: {}
}

const TIER = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 }
const tierOf = (name) => TIER[String(name).split('_')[0]] || 0

function durabilityLeft (item) {
  if (!item || !item.maxDurability) return Infinity
  return item.maxDurability - (item.durabilityUsed || 0)
}

/** Which potion is this? Works with 1.20.5+ item components and older NBT. */
function potionType (item) {
  if (!item) return null
  const comp = item.componentMap?.get?.('potion_contents')?.data
  if (comp) {
    if (comp.potionId !== undefined && comp.potionId !== null) return POTION_IDS[comp.potionId] || null
    if (comp.customEffects?.length) return `custom_${comp.customEffects[0].effect ?? comp.customEffects[0].id}`
  }
  const nbt = item.nbt?.value?.Potion?.value
  return nbt ? String(nbt).replace(/^minecraft:/, '') : null
}

const baseEffect = (type) => String(type || '').replace(/^(long|strong)_/, '')

/** Everything combat-relevant the bot is carrying. */
function readKit (bot) {
  const offSlot = safe(() => bot.getEquipmentDestSlot('off-hand'))
  const offhand = offSlot !== undefined ? bot.inventory.slots[offSlot] : null
  const all = offhand ? [...bot.inventory.items(), offhand] : bot.inventory.items()
  const usable = all.filter((i) => durabilityLeft(i) > 1)
  const best = (re) => usable.filter((i) => re.test(i.name)).sort((a, b) => tierOf(b.name) - tierOf(a.name))[0] || null
  const find = (name) => all.find((i) => i.name === name) || null
  const count = (re) => all.filter((i) => re.test(i.name)).reduce((a, i) => a + i.count, 0)
  const kit = {
    sword: best(/_sword$/),
    axe: best(/_axe$/),
    mace: find('mace'),
    trident: find('trident'),
    bow: find('bow'),
    crossbow: find('crossbow'),
    arrows: count(/^(arrow|spectral_arrow|tipped_arrow)$/),
    shield: find('shield'),
    offhand,
    totem: find('totem_of_undying'),
    gap: find('golden_apple'),
    egap: find('enchanted_golden_apple'),
    pearl: find('ender_pearl'),
    windCharge: find('wind_charge'),
    cobweb: find('cobweb'),
    waterBucket: find('water_bucket'),
    drink: {},
    splash: {},
    lingering: {}
  }
  for (const i of all) {
    if (!/potion$/.test(i.name)) continue
    const type = potionType(i)
    if (!type) continue
    const bucket = i.name === 'splash_potion' ? kit.splash : i.name === 'lingering_potion' ? kit.lingering : kit.drink
    const key = baseEffect(type)
    // Prefer the strong variant.
    if (!bucket[key] || /^strong_/.test(type)) bucket[key] = i
  }
  kit.melee = kit.sword || kit.axe || kit.trident || kit.mace || null
  return kit
}

function hasEffect (bot, name) {
  const e = bot.registry.effectsByName?.[name]
  return Boolean(e && bot.entity?.effects?.[e.id])
}

function isOnFire (entity) {
  return Boolean((entity?.metadata?.[0] ?? 0) & 0x01)
}

/** Is this entity holding up a shield right now? */
function isBlocking (bot, entity) {
  const keys = bot.registry.entitiesByName?.[entity.name]?.metadataKeys
  const idx = keys ? keys.indexOf('living_entity_flags') : -1
  if (idx < 0) return false
  const flags = entity.metadata?.[idx] ?? 0
  if (!(flags & 0x01)) return false
  const offhand = Boolean(flags & 0x02)
  const held = offhand ? entity.equipment?.[1] : entity.heldItem
  return held?.name === 'shield'
}

/** Attack cooldown (ms) for the held item on 1.9+ combat. Swapping items resets it. */
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

function safe (fn) { try { return fn() } catch { return undefined } }

/** Rough line of sight to an entity (checks the block at its head). */
function canSee (bot, entity) {
  const head = bot.blockAt(entity.position.offset(0, (entity.height || 1.8) * 0.8, 0))
  if (!head) return false
  return safe(() => bot.canSeeBlock(head)) ?? true
}

/** Hold an item in the main hand. Returns true if it actually swapped. */
async function hold (bot, item) {
  if (!item) return false
  if (bot.heldItem && bot.heldItem.type === item.type && bot.heldItem.name === item.name) return false
  await bot.equip(item, 'hand')
  return true
}

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

const PROJECTILES = {
  arrow: { speed: 3.0, gravity: 0.05, drag: 0.99 },
  crossbow: { speed: 3.15, gravity: 0.05, drag: 0.99 },
  splash: { speed: 0.5, gravity: 0.05, drag: 0.99 },
  pearl: { speed: 1.5, gravity: 0.03, drag: 0.99 },
  wind_charge: { speed: 1.5, gravity: 0, drag: 1 },
  snowball: { speed: 1.5, gravity: 0.03, drag: 0.99 }
}

/**
 * Yaw/pitch to hit `to` from `from` with a projectile (simulated per tick:
 * move, drag, gravity — like the game). Prefers the flattest arc.
 */
function solveAim (from, to, { speed, gravity, drag }) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  const dy = to.y - from.y
  const d = Math.hypot(dx, dz)
  const yaw = Math.atan2(-dx, -dz)
  let best = null
  for (let deg = -85; deg <= 60; deg += 0.5) {
    const pitch = (deg * Math.PI) / 180
    let x = 0; let y = 0
    let vx = speed * Math.cos(pitch); let vy = speed * Math.sin(pitch)
    for (let t = 1; t <= 150; t++) {
      x += vx; y += vy
      vx *= drag; vy = vy * drag - gravity
      if (x >= d) {
        const err = Math.abs(y - dy)
        if (!best || err < best.err - 0.05) best = { yaw, pitch, ticks: t, err }
        break
      }
      if (vy < 0 && y < dy - 4) break
    }
    if (best && best.err < 0.3) break // flattest good-enough arc
  }
  return best
}

/** Aim at a (moving) entity, leading it by the projectile's flight time. */
function aimAtEntity (bot, entity, profile) {
  const from = bot.entity.position.offset(0, 1.52, 0)
  let target = entity.position.offset(0, (entity.height || 1.8) * 0.6, 0)
  let aim = solveAim(from, target, profile)
  for (let i = 0; i < 2 && aim && entity.velocity; i++) {
    const lead = Math.min(aim.ticks, 40)
    target = entity.position.offset(entity.velocity.x * lead, (entity.height || 1.8) * 0.6, entity.velocity.z * lead)
    aim = solveAim(from, target, profile)
  }
  return aim
}

/** Throw a throwable (splash potion, pearl, wind charge, snowball) at a point or entity, or at your own feet. */
async function throwItem (bot, item, target, profileName, aimErrorDeg = 0) {
  await hold(bot, item)
  if (target === 'feet') {
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
  } else {
    const profile = PROJECTILES[profileName]
    const aim = target.position && target.id !== undefined
      ? aimAtEntity(bot, target, profile)
      : solveAim(bot.entity.position.offset(0, 1.52, 0), target, profile)
    if (!aim) return false
    const [ey, ep] = aimNoise(aimErrorDeg)
    await bot.look(aim.yaw + ey, aim.pitch + ep, true)
  }
  bot.activateItem()
  await sleep(80)
  return true
}

/** Random aim error (radians) for less skilled players. */
function aimNoise (deg) {
  if (!deg) return [0, 0]
  const r = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 // roughly normal, -1..1
  return [r() * deg * Math.PI / 180, r() * deg * 0.7 * Math.PI / 180]
}

/** Full ability when no intelligence profile is given (tests, scripts). */
const FULL_PROFILE = { skill: 1, reactionMs: 60, aimErrorDeg: 0, missChance: 0, cooldownDiscipline: 1, critChance: 1, maceQuality: 1, can: () => true }

/** Drink or eat something (potion, golden apple...). */
async function consume (bot, item, signal) {
  await hold(bot, item)
  const done = bot.consume()
  done.catch(() => {})
  await Promise.race([done, abortableSleep(3500, signal)])
}

// ---------------------------------------------------------------------------
// The fight loop
// ---------------------------------------------------------------------------

/**
 * Fight `entity` with `style` (from learning.js). Returns
 * { outcome: 'win'|'fled'|'escaped'|'timeout', hitsLanded, hitsTaken, healthLost, durationMs, used }.
 */
async function fight (ctx, entity, style, maxSeconds) {
  const { bot, signal, log } = ctx
  const prof = ctx.intel?.combatProfile?.() || FULL_PROFILE
  const can = prof.can
  const started = Date.now()
  const startHealth = bot.health
  const end = started + maxSeconds * 1000
  // Mob-specific tactics need experience; anyone runs from a warden.
  const known = entity.type === 'player' ? { player: true } : (MOB_TACTICS[entity.name] || {})
  const tactics = can('mobTactics') ? { ...known, splits: known.splits && can('splitChase') } : { player: known.player, flee: known.flee }
  const used = { potions: 0, gaps: 0, totems: 0, pearls: 0, arrows: 0, smashes: 0, webs: 0, axeBreaks: 0 }
  if (tactics.flee) return { outcome: 'fled', hitsLanded: 0, hitsTaken: 0, healthLost: 0, durationMs: 0, used }

  let target = entity
  let kit = readKit(bot)
  let kitAt = Date.now()
  const s = {
    hitsLanded: 0, hitsTaken: 0, lastAttack: 0, lastSwap: 0, targetSwingAt: 0, comboStep: 0,
    jumping: false, jumpAt: 0, wtapUntil: 0, backOffUntil: 0, strafeDir: Math.random() < 0.5 ? 'left' : 'right',
    nextStrafeSwitch: 0, shieldUp: false, nextSustainAt: 0, nextGapAt: 0, nextOffensiveAt: 0, nextMaceAt: 0,
    nextBowAt: 0, buffed: false, splitKills: 0
  }
  let outcome = 'timeout'

  const onHurt = (e) => {
    if (e === target && Date.now() - s.lastAttack < 400) s.hitsLanded++
    if (e === bot.entity) s.hitsTaken++
  }
  const onSwing = (e) => { if (e === target) s.targetSwingAt = Date.now() }
  bot.on('entityHurt', onHurt)
  bot.on('entitySwingArm', onSwing)

  const offhandShield = () => bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'shield'
  const lowerShield = () => { if (s.shieldUp) { bot.deactivateItem(); s.shieldUp = false } }
  const setStrafe = (dir) => {
    bot.setControlState('left', dir === 'left')
    bot.setControlState('right', dir === 'right')
  }
  const stopMoving = () => { for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(c, false) }
  const dist = () => bot.entity.position.distanceTo(target.position)
  const eye = () => target.position.offset(0, (target.height || 1.8) * 0.85, 0)
  const swap = async (item) => { lowerShield(); if (await hold(bot, item)) s.lastSwap = Date.now() }

  try {
    if (style.shield !== false && kit.shield && !offhandShield() && !(kit.offhand?.name === 'totem_of_undying')) {
      await bot.equip(kit.shield, 'off-hand').catch(() => {})
    }

    while (Date.now() < end) {
      throwIfAborted(signal)
      if (Date.now() - kitAt > 2000) { kit = readKit(bot); kitAt = Date.now() }

      // --- Target gone?
      if (!target.isValid || !bot.entities[target.id]) {
        // Slimes and magma cubes split: finish off the little ones too.
        if (tactics.splits && s.splitKills < 8) {
          const next = Object.values(bot.entities)
            .filter((e) => e.name === entity.name && e.isValid && e.position.distanceTo(bot.entity.position) < 10)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
          if (next) { target = next; s.splitKills++; continue }
        }
        outcome = 'win'
        break
      }
      if (ctx.isPaused?.()) { stopMoving(); await abortableSleep(50, signal); continue } // typing
      if (bot.health <= style.retreatHealth && bot.health < startHealth && !kit.totem && !kit.gap && !kit.drink.healing && !kit.splash.healing) {
        outcome = 'fled'
        break
      }
      const d = dist()
      if (d > 32) { outcome = 'escaped'; break }
      const now = Date.now()

      // --- Sustain: stay alive first.
      if (now >= s.nextSustainAt) {
        const usedSomething = await sustain(ctx, kit, s, target, d, used, { stopMoving, lowerShield, can })
        s.nextSustainAt = Date.now() + prof.reactionMs // slower players notice low health later
        if (usedSomething) { kit = readKit(bot); kitAt = Date.now(); s.nextSustainAt += 400; continue }
      }
      if (bot.health <= style.retreatHealth && bot.health < startHealth) { outcome = 'fled'; break }

      // --- Buff up before a serious fight, while there's still distance.
      if (!s.buffed && can('preBuffs') && (tactics.player || tactics.fire || entity.name === 'warden') && d > 6) {
        s.buffed = true
        const wants = ['strength', 'swiftness', ...(tactics.fire ? ['fire_resistance'] : [])]
        for (const w of wants) {
          const effect = { strength: 'Strength', swiftness: 'Speed', fire_resistance: 'FireResistance' }[w]
          if (kit.drink[w] && !hasEffect(bot, effect)) { stopMoving(); await consume(bot, kit.drink[w], signal); used.potions++ }
        }
        kit = readKit(bot)
        continue
      }

      // --- Mace: wind-charge launch and smash, or drop on them from above.
      if (kit.mace && can('maceBasic') && (style.mace || !kit.melee || kit.melee === kit.mace) && now >= s.nextMaceAt && !tactics.onlyRanged) {
        const above = bot.entity.position.y - target.position.y
        const horiz = Math.hypot(target.position.x - bot.entity.position.x, target.position.z - bot.entity.position.z)
        if (kit.windCharge && bot.entity.onGround && horiz < 3.5 && now - s.lastAttack > 1200) {
          s.nextMaceAt = now + 3500
          if (await maceSmash(ctx, target, kit, s, prof.maceQuality)) used.smashes++
          kit = readKit(bot)
          continue
        }
        if (above >= 3 && horiz < 4 && bot.entity.velocity.y < -0.3) {
          await swap(kit.mace)
          await bot.lookAt(eye(), true)
          if (d <= 3.5) { bot.attack(target); s.lastAttack = Date.now(); used.smashes++; s.nextMaceAt = Date.now() + 1500 }
        }
      }

      // --- Ranged: bow/crossbow at distance (or when melee makes no sense).
      const launcher = (can('bow') && kit.bow) || (can('crossbow') && kit.crossbow)
      const wantsRange = launcher && kit.arrows > 0 && !tactics.noProjectiles &&
        (tactics.onlyRanged || ((style.ranged || tactics.preferBow) && d > 5) || d > 12) && d < 50
      if (wantsRange && now >= s.nextBowAt && canSee(bot, target)) {
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
        lowerShield()
        const shot = await shoot(ctx, target, kit, s, style, prof)
        if (shot) used.arrows++
        s.nextBowAt = Date.now() + 150
        kit = readKit(bot)
        continue
      }

      // --- Offensive splash potions (mind the undead).
      if (now >= s.nextOffensiveAt && can('throwPotions') && d >= 3 && d <= 9) {
        // Knowing that harming heals undead takes experience.
        const undead = UNDEAD.has(target.name) && can('undeadAware')
        const pick = undead
          ? kit.splash.healing
          : kit.splash.harming || (target.type === 'player' ? kit.splash.weakness || kit.splash.slowness : null) || kit.splash.poison
        if (pick) {
          s.nextOffensiveAt = now + 6000
          await throwItem(bot, pick, target, 'splash', prof.aimErrorDeg)
          used.potions++
          kit = readKit(bot)
          continue
        }
      }

      // --- Cobweb under an approaching player.
      if (kit.cobweb && can('cobweb') && tactics.player && used.webs < 2 && d <= 3.2 && now - s.lastAttack > 300) {
        if (await webTarget(bot, target, kit)) { used.webs++; kit = readKit(bot); continue }
      }

      // --- Movement.
      if (now < s.backOffUntil) {
        lowerShield()
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
        await bot.lookAt(eye(), true)
        setStrafe(null)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState('back', true)
      } else if (d > 3.4) {
        lowerShield()
        setStrafe(null)
        bot.setControlState('back', false)
        // Closing on archers: shield up and weave.
        if (tactics.ranged && can('shieldBlock') && offhandShield() && d < 16) {
          bot.activateItem(true); s.shieldUp = true
        }
        if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      } else {
        // --- Melee.
        if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
        await bot.lookAt(eye(), true)
        bot.setControlState('back', false)
        const wantForward = now >= s.wtapUntil && d > 2.2 && !tactics.waitForSwoop
        bot.setControlState('forward', Boolean(wantForward || tactics.rush))
        bot.setControlState('sprint', Boolean(wantForward || tactics.rush))
        if (style.strafe && can('strafe') && !tactics.rush) {
          if (now > s.nextStrafeSwitch) {
            s.strafeDir = s.strafeDir === 'left' ? 'right' : 'left'
            s.nextStrafeSwitch = now + 400 + Math.random() * 600
          }
          setStrafe(s.strafeDir)
        } else {
          setStrafe(null)
        }

        // Pick the weapon for the next hit.
        const blocking = isBlocking(bot, target)
        let weapon = kit.melee
        if (blocking && kit.axe && can('axeVsShield')) weapon = kit.axe // axes knock shields down for 5 seconds
        else if (style.combo && can('combo') && kit.axe && kit.sword) weapon = s.comboStep % 3 === 0 ? kit.axe : kit.sword // heavy axe crit, then quick sword hits
        else if (kit.sword) weapon = kit.sword
        if (weapon) await swap(weapon)

        const cooldown = attackCooldown(bot)
        // Beginners click before the cooldown is back (weak hits); good players wait for it.
        const ready = now - Math.max(s.lastAttack, s.lastSwap) >= cooldown * (blocking ? 0.9 : 1) * prof.cooldownDiscipline

        // Shield up between swings while they swing at us (after the player's reaction time).
        const sinceSwing = now - s.targetSwingAt
        if (style.shield && can('shieldBlock') && offhandShield() && !ready && sinceSwing >= prof.reactionMs * 0.5 && sinceSwing < 600 + prof.reactionMs && !s.shieldUp) {
          bot.activateItem(true)
          s.shieldUp = true
        }

        if (ready) {
          if (style.crit && !s.jumping && bot.entity.onGround && !bot.entity.isInWater && cooldown >= 500 && !blocking && Math.random() < prof.critChance) {
            bot.setControlState('jump', true)
            s.jumping = true
            s.jumpAt = now
          }
          if (s.jumping && !bot.entity.onGround) bot.setControlState('jump', false)
          const falling = s.jumping && !bot.entity.onGround && bot.entity.velocity.y < -0.05
          if (!s.jumping || falling || now - s.jumpAt > 600) {
            s.jumping = false
            bot.setControlState('jump', false)
            lowerShield()
            if (d <= 3.2) {
              if (Math.random() < prof.missChance) bot.swingArm('right') // a flailing miss
              else bot.attack(target)
              s.lastAttack = now
              s.comboStep++
              if (blocking && weapon === kit.axe) used.axeBreaks++
              if (style.wtap && can('wtap')) s.wtapUntil = now + 90
              if (style.backOff || tactics.style === 'hitAndRun') s.backOffUntil = now + Math.min(700, cooldown)
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
    if (kit.sword || kit.melee) await hold(bot, kit.sword || kit.melee).catch(() => {})
  }
  log?.debug?.(`fight used: ${JSON.stringify(used)}`)
  return { outcome, hitsLanded: s.hitsLanded, hitsTaken: s.hitsTaken, healthLost: Math.max(0, Math.round(startHealth - bot.health)), durationMs: Date.now() - started, used }
}

/** Healing, totems and golden apples. Returns true if it spent time using something. */
async function sustain (ctx, kit, s, target, d, used, { stopMoving, lowerShield, can = () => true }) {
  const { bot, signal } = ctx
  const hp = bot.health
  const offhand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]

  // A totem only works in a hand: when it's getting dangerous, it replaces the shield.
  if (hp <= 8 && kit.totem && can('totemSwap') && offhand?.name !== 'totem_of_undying') {
    lowerShield()
    await bot.equip(kit.totem, 'off-hand').catch(() => {})
    used.totems++
    return true
  }
  if (hp <= 8 && kit.splash.healing && can('throwPotions')) {
    await throwItem(bot, kit.splash.healing, 'feet')
    used.potions++
    return true
  }
  if (hp <= 8 && kit.drink.healing && can('drinkPotions') && d > 3) {
    lowerShield(); stopMoving()
    await consume(bot, kit.drink.healing, signal)
    used.potions++
    return true
  }
  // Golden apples take time to eat: back away while doing it.
  const apple = hp <= 6 && kit.egap ? kit.egap : kit.gap || (hp <= 8 ? kit.egap : null)
  if (hp <= 10 && apple && can('gaps') && Date.now() >= s.nextGapAt && !hasEffect(bot, 'Absorption')) {
    lowerShield()
    if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
    bot.setControlState('forward', false)
    bot.setControlState('back', d < 5)
    await consume(bot, apple, signal)
    bot.setControlState('back', false)
    s.nextGapAt = Date.now() + 6000
    used.gaps++
    return true
  }
  if (hp <= 12 && kit.drink.regeneration && can('drinkPotions') && !hasEffect(bot, 'Regeneration') && d > 5) {
    lowerShield(); stopMoving()
    await consume(bot, kit.drink.regeneration, signal)
    used.potions++
    return true
  }
  // Burning.
  if (isOnFire(bot.entity) && !hasEffect(bot, 'FireResistance')) {
    if (kit.drink.fire_resistance && can('drinkPotions')) { stopMoving(); await consume(bot, kit.drink.fire_resistance, signal); used.potions++; return true }
    if (kit.waterBucket && can('waterClutch') && await douse(bot, kit.waterBucket)) return true
  }
  return false
}

/** Wind charge at our feet → fly up → mace → smash on the way down. */
async function maceSmash (ctx, target, kit, s, quality = 1) {
  const { bot, signal } = ctx
  if (s.shieldUp) { bot.deactivateItem(); s.shieldUp = false }
  bot.pathfinder.setGoal(null)
  await hold(bot, kit.windCharge)
  // Sloppier players don't throw it perfectly straight down, so the launch drifts.
  const sloppy = (1 - quality) * 0.5
  await bot.look(bot.entity.yaw + (Math.random() - 0.5) * sloppy, -Math.PI / 2 + Math.random() * sloppy, true)
  bot.setControlState('jump', true)
  await sleep(60)
  bot.activateItem() // burst under us
  await sleep(60)
  bot.setControlState('jump', false)
  await hold(bot, kit.mace)
  s.lastSwap = Date.now()
  const start = Date.now()
  let hit = false
  while (Date.now() - start < 3500) {
    throwIfAborted(signal)
    if (!target.isValid) break
    const eye = target.position.offset(0, (target.height || 1.8) * 0.8, 0)
    await bot.lookAt(eye, true)
    const horiz = Math.hypot(target.position.x - bot.entity.position.x, target.position.z - bot.entity.position.z)
    // Good mace players steer onto the target all the way down; others drift.
    bot.setControlState('forward', quality >= 0.9 ? horiz > 1 : horiz > 2.5)
    // ...and wait for real falling speed before swinging (a bigger smash). Others swing early.
    const swingAt = quality >= 0.9 ? -0.45 : Math.random() < 1 - quality ? -0.1 : -0.3
    const falling = bot.entity.velocity.y < swingAt
    if (falling && bot.entity.position.y - target.position.y > 1.2 && bot.entity.position.distanceTo(eye) <= 3.4) {
      bot.attack(target)
      s.lastAttack = Date.now()
      hit = true
      break
    }
    if (bot.entity.onGround && Date.now() - start > 400) break
    await abortableSleep(50, signal)
  }
  bot.setControlState('forward', false)
  return hit
}

/** One bow or crossbow shot (draws, aims with lead, releases). */
async function shoot (ctx, target, kit, s, style, prof = FULL_PROFILE) {
  const { bot, signal } = ctx
  const crossbow = !(kit.bow && prof.can('bow')) && kit.crossbow
  const launcher = kit.bow || kit.crossbow
  await hold(bot, launcher)
  s.lastSwap = Date.now()
  const profile = PROJECTILES[crossbow ? 'crossbow' : 'arrow']
  const strafe = (on) => {
    bot.setControlState('left', on && s.strafeDir === 'left')
    bot.setControlState('right', on && s.strafeDir === 'right')
  }

  if (crossbow) {
    const loaded = bot.heldItem?.componentMap?.get?.('charged_projectiles')?.data?.projectiles?.length > 0
    if (!loaded) {
      bot.activateItem()
      await abortableSleep(1300, signal)
      bot.deactivateItem()
      await sleep(100)
    }
  } else {
    bot.activateItem() // start drawing
  }
  const drawStart = Date.now()
  const drawMs = crossbow ? 0 : 1050
  while (Date.now() - drawStart < drawMs) {
    throwIfAborted(signal)
    if (!target.isValid) { bot.deactivateItem(); return false }
    if (target.position.distanceTo(bot.entity.position) < 3.5 && !style.ranged) { bot.deactivateItem(); return false } // too close: switch to melee
    const aim = aimAtEntity(bot, target, profile)
    if (aim) await bot.look(aim.yaw, aim.pitch, true)
    if (Date.now() > s.nextStrafeSwitch) { s.strafeDir = s.strafeDir === 'left' ? 'right' : 'left'; s.nextStrafeSwitch = Date.now() + 700 }
    strafe(true)
    await abortableSleep(50, signal)
  }
  strafe(false)
  const aim = aimAtEntity(bot, target, profile)
  if (!aim) { if (!crossbow) bot.deactivateItem(); return false }
  const [ey, ep] = aimNoise(prof.aimErrorDeg)
  await bot.look(aim.yaw + ey, aim.pitch + ep, true)
  if (crossbow) bot.activateItem()
  else bot.deactivateItem() // release
  s.lastAttack = Date.now()
  await sleep(100)
  return true
}

/** Put a cobweb where the target stands (slows them to a crawl). */
async function webTarget (bot, target, kit) {
  const below = bot.blockAt(target.position.offset(0, -1, 0).floored())
  const at = bot.blockAt(target.position.floored())
  if (!below || below.boundingBox !== 'block' || !at || at.boundingBox !== 'empty') return false
  try {
    await hold(bot, kit.cobweb)
    await bot.lookAt(below.position.offset(0.5, 1, 0.5), true)
    await bot.placeBlock(below, new Vec3(0, 1, 0))
    return true
  } catch {
    return false
  }
}

/** Put out fire (or break a fall) with a water bucket, then pick the water back up. */
async function douse (bot, bucket) {
  try {
    await hold(bot, bucket)
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.activateItem()
    await sleep(350)
    const empty = bot.inventory.items().find((i) => i.name === 'bucket')
    if (empty) {
      await hold(bot, empty)
      bot.activateItem()
    }
    return true
  } catch {
    return false
  }
}

/**
 * Water-bucket clutch: called from a physics tick monitor. When falling fast
 * toward the ground with a water bucket, place water just before impact.
 */
async function fallClutch (bot) {
  const v = bot.entity?.velocity?.y ?? 0
  if (v > -0.75 || bot.entity.isInWater) return false
  const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket')
  if (!bucket) return false
  const pos = bot.entity.position
  let ground = null
  for (let dy = 1; dy <= 6; dy++) {
    const b = bot.blockAt(pos.offset(0, -dy, 0))
    if (b && b.boundingBox === 'block') { ground = dy; break }
    if (b && /water|slime_block|hay_block|cobweb/.test(b.name)) return false // soft landing anyway
  }
  if (!ground || ground > 3) return false
  return douse(bot, bucket)
}

/** Ender pearl away from a threat to a spot with solid ground. */
async function pearlEscape (ctx, from) {
  const { bot } = ctx
  const pearl = bot.inventory.items().find((i) => i.name === 'ender_pearl')
  if (!pearl) return false
  const me = bot.entity.position
  const away = me.minus(from.position)
  const len = Math.hypot(away.x, away.z) || 1
  for (const dist of [22, 16, 10]) {
    for (const turn of [0, 0.5, -0.5, 1, -1]) {
      const ang = Math.atan2(away.z / len, away.x / len) + turn
      const x = me.x + Math.cos(ang) * dist
      const z = me.z + Math.sin(ang) * dist
      for (let y = Math.floor(me.y) + 6; y > me.y - 10; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.boundingBox === 'block' && !/lava|magma|cactus/.test(b.name)) {
          const above = bot.blockAt(new Vec3(x, y + 1, z))
          if (above && above.boundingBox === 'empty' && !/lava|water/.test(above.name)) {
            return throwItem(bot, pearl, new Vec3(x, y + 1, z), 'pearl')
          }
          break
        }
      }
    }
  }
  return false
}

/** Which fighting styles make sense with what we're carrying. */
function availableStyles (bot, intel) {
  const kit = readKit(bot)
  const can = (a) => (intel ? intel.can(a, 'combat') : true)
  const out = ['aggressive', 'balanced', 'hitAndRun']
  if (can('shieldBlock')) out.push('cautious')
  if (kit.axe && kit.sword && can('combo')) out.push('comboAxe')
  if ((kit.bow || kit.crossbow) && kit.arrows > 0 && can('bow')) out.push('ranged')
  if (kit.mace && kit.windCharge && can('maceBasic')) out.push('mace') // hardcore players and up only
  return out
}

/** One-line description of the combat kit, for prompts. */
function describeKit (bot) {
  const k = readKit(bot)
  const parts = []
  if (k.sword) parts.push(k.sword.name)
  if (k.axe) parts.push(k.axe.name)
  if (k.mace) parts.push(`mace${k.windCharge ? ` + ${k.windCharge.count} wind charges` : ''}`)
  if (k.bow || k.crossbow) parts.push(`${(k.bow || k.crossbow).name} (${k.arrows} arrows)`)
  if (k.shield) parts.push('shield')
  if (k.totem) parts.push('totem')
  if (k.gap || k.egap) parts.push(`${(k.gap?.count || 0) + (k.egap?.count || 0)} golden apples`)
  if (k.pearl) parts.push(`${k.pearl.count} pearls`)
  const pots = [...Object.keys(k.drink).map((p) => `${p} potion`), ...Object.keys(k.splash).map((p) => `splash ${p}`)]
  if (pots.length) parts.push(pots.join(', '))
  return parts.join(', ') || 'nothing but fists'
}

module.exports = {
  fight, readKit, describeKit, availableStyles, attackCooldown, potionType, hasEffect, isBlocking, solveAim,
  throwItem, consume, douse, fallClutch, pearlEscape, hold, PROJECTILES, UNDEAD, MOB_TACTICS, ActionError
}
