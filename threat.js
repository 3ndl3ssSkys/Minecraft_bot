'use strict'

/**
 * threat.js — sizing up the creatures around, like a player glancing at them: how dangerous each one is with the
 * gear and health it has right now, and whether a fight is worth it.
 *
 *   danger (0..1+): the share of its health it would expect to lose killing that creature (all of them, for the total).
 *                   From the creature's damage, attack rate and health against its own weapon, armour, shield and skill.
 *   worth  (-1..1): what a fight gets it: drops it wants, food when hungry, ending a threat that will chase it anyway,
 *                   protecting people or home, getting back at what hurt it. Negative for neutral mobs it would only
 *                   provoke, animals it doesn't need, babies, and anything protected (pets, farms: worth -1).
 *   verdict:        fight | avoid (keep away, go around) | flee (get out now) | leave (protected) | ignore
 *
 * assess(mobs, me, ctx) is pure (unit-tested); Agent.threat() feeds it what the bot actually perceives.
 */

// hp; dmg per hit (Normal difficulty); hits per second; kind: melee | ranged | explode | swarm; speed vs a walking player;
// aggro: hostile | night (spiders: calm in daylight) | neutral | passive | never (don't fight it at all)
const M = (hp, dmg, rate, kind, speed, aggro, drops = [], note = '') => ({ hp, dmg, rate, kind, speed, aggro, drops, note })
const MOBS = {
  zombie: M(20, 3, 1, 'melee', 0.8, 'hostile', ['rotten_flesh'], 'slow; groups get dangerous'),
  husk: M(20, 3, 1, 'melee', 0.8, 'hostile', ['rotten_flesh'], 'hits cause hunger'),
  drowned: M(20, 3, 1, 'melee', 0.8, 'hostile', ['rotten_flesh', 'copper_ingot'], 'tridents ones throw from range'),
  zombie_villager: M(20, 3, 1, 'melee', 0.8, 'hostile', ['rotten_flesh']),
  skeleton: M(20, 3, 0.5, 'ranged', 0.9, 'hostile', ['bone', 'arrow'], 'shoots from range: close in fast or use cover'),
  stray: M(20, 3, 0.5, 'ranged', 0.9, 'hostile', ['bone', 'arrow'], 'arrows slow you'),
  bogged: M(16, 3, 0.4, 'ranged', 0.9, 'hostile', ['bone', 'arrow'], 'poison arrows'),
  spider: M(16, 2, 1, 'melee', 1.15, 'night', ['string', 'spider_eye'], 'fast, climbs walls; calm in daylight'),
  cave_spider: M(12, 2.5, 1, 'melee', 1.15, 'hostile', ['string'], 'poisons; usually a spawner nearby'),
  creeper: M(20, 0, 0, 'explode', 0.8, 'hostile', ['gunpowder'], 'explodes next to you: hit and back off, or shoot it'),
  witch: M(26, 6, 0.4, 'ranged', 0.8, 'hostile', ['redstone', 'glowstone_dust', 'gunpowder', 'sugar'], 'throws poison and harming potions, heals itself'),
  enderman: M(40, 7, 1, 'melee', 1.5, 'neutral', ['ender_pearl'], 'only attacks if you look at its face or hit it; teleports'),
  silverfish: M(8, 1, 1, 'swarm', 0.9, 'hostile', [], 'calls others out of the stone'),
  endermite: M(8, 2, 1, 'melee', 0.9, 'hostile', []),
  slime: M(16, 4, 1, 'melee', 0.7, 'hostile', ['slime_ball'], 'splits into smaller ones'),
  magma_cube: M(16, 6, 1, 'melee', 0.7, 'hostile', ['magma_cream'], 'splits; fire-proof'),
  phantom: M(20, 6, 0.5, 'melee', 1.6, 'hostile', ['phantom_membrane'], 'dives from the sky when you haven\'t slept'),
  pillager: M(24, 4, 0.5, 'ranged', 0.9, 'hostile', ['arrow'], 'crossbow; patrols come in groups'),
  vindicator: M(24, 13, 0.8, 'melee', 1.0, 'hostile', ['emerald'], 'hits very hard with an axe'),
  evoker: M(24, 6, 0.4, 'ranged', 0.9, 'hostile', ['totem_of_undying', 'emerald'], 'fangs and vexes: rush it'),
  vex: M(14, 9, 1, 'melee', 1.6, 'hostile', [], 'flies through walls'),
  ravager: M(100, 12, 0.7, 'melee', 0.9, 'hostile', ['saddle'], 'a tank: only with good gear'),
  guardian: M(30, 6, 0.4, 'ranged', 0.7, 'hostile', ['prismarine_shard', 'cod'], 'laser from range under water'),
  elder_guardian: M(80, 8, 0.4, 'ranged', 0.5, 'hostile', ['wet_sponge'], 'mining fatigue'),
  blaze: M(20, 6, 0.6, 'ranged', 0.9, 'hostile', ['blaze_rod'], 'fireballs; fire resistance helps'),
  ghast: M(10, 9, 0.3, 'ranged', 0.8, 'hostile', ['ghast_tear', 'gunpowder'], 'explosive fireballs: hit them back, or shoot it'),
  wither_skeleton: M(20, 8, 1, 'melee', 1.0, 'hostile', ['coal', 'bone', 'wither_skeleton_skull'], 'withering hits'),
  piglin: M(16, 5, 0.8, 'melee', 1.0, 'neutral', ['gold_ingot'], 'leaves you alone if you wear gold'),
  piglin_brute: M(50, 13, 0.8, 'melee', 1.0, 'hostile', [], 'hits very hard'),
  zombified_piglin: M(20, 8, 1, 'melee', 1.0, 'neutral', ['gold_nugget', 'rotten_flesh'], 'the whole group attacks if you hit one'),
  hoglin: M(40, 6, 0.8, 'melee', 1.0, 'hostile', ['porkchop', 'leather'], 'throws you around'),
  zoglin: M(40, 6, 0.8, 'melee', 1.0, 'hostile', ['rotten_flesh']),
  shulker: M(30, 4, 0.3, 'ranged', 0, 'hostile', ['shulker_shell'], 'bullets make you float up'),
  breeze: M(30, 1, 0.5, 'ranged', 1.2, 'hostile', ['breeze_rod'], 'wind charges knock you off edges'),
  iron_golem: M(100, 15, 0.7, 'melee', 0.8, 'neutral', ['iron_ingot'], 'protects villagers; hits extremely hard'),
  wolf: M(8, 4, 1, 'melee', 1.2, 'neutral', [], 'the whole pack comes'),
  polar_bear: M(30, 6, 1, 'melee', 1.1, 'neutral', ['cod'], 'angry near its cubs'),
  bee: M(10, 2, 1, 'swarm', 1.1, 'neutral', [], 'the hive swarms and poisons'),
  llama: M(15, 1, 0.5, 'ranged', 0.9, 'neutral', ['leather']),
  goat: M(10, 2, 0.3, 'melee', 1.0, 'neutral', [], 'rams you off cliffs'),
  warden: M(500, 30, 0.6, 'melee', 1.2, 'never', [], 'never fight it: sneak away, it hunts by sound'),
  creaking: M(1, 3, 1, 'melee', 1.0, 'never', [], "can't be hurt except through its heart block"),
  wither: M(300, 12, 1, 'ranged', 1.0, 'never', ['nether_star'], 'a boss: only fully prepared'),
  ender_dragon: M(200, 10, 1, 'melee', 1.5, 'never', [], 'the boss'),
  cow: M(10, 0, 0, 'melee', 0.6, 'passive', ['beef', 'leather']),
  mooshroom: M(10, 0, 0, 'melee', 0.6, 'passive', ['beef', 'leather']),
  pig: M(10, 0, 0, 'melee', 0.6, 'passive', ['porkchop']),
  sheep: M(8, 0, 0, 'melee', 0.6, 'passive', ['mutton', 'white_wool']),
  chicken: M(4, 0, 0, 'melee', 0.6, 'passive', ['chicken', 'feather']),
  rabbit: M(3, 0, 0, 'melee', 1.2, 'passive', ['rabbit', 'rabbit_hide']),
  cod: M(3, 0, 0, 'melee', 0.6, 'passive', ['cod']),
  salmon: M(3, 0, 0, 'melee', 0.6, 'passive', ['salmon'])
}
const FOOD = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const WEAPON_DMG = { wooden: 4, golden: 4, stone: 5, iron: 6, diamond: 7, netherite: 8 }
const AXE_DMG = { wooden: 7, golden: 7, stone: 9, iron: 9, diamond: 9, netherite: 10 }

/** Damage per second it can deal with its best weapon, as a player of this skill actually lands it. */
function ownDps (me) {
  const w = String(me.weapon || '')
  const tier = w.split('_')[0]
  let dps = 3 // fists, spammed
  if (/_sword$/.test(w)) dps = (WEAPON_DMG[tier] || 4) * 1.6
  else if (/_axe$/.test(w)) dps = (AXE_DMG[tier] || 7) * (tier === 'wooden' || tier === 'stone' ? 0.8 : tier === 'golden' ? 1 : 0.9)
  else if (w === 'mace') dps = 6 * 0.6 * 2.5 // smashes when it can
  else if (w === 'trident') dps = 9 * 1.1
  return dps * (0.45 + 0.65 * (me.skill ?? 0.5)) // misses, crits, timing
}

/** Damage taken per second from one creature after armour (and a raised shield, for players who use one). */
function incoming (info, me) {
  const armor = Math.min(20, me.armor || 0)
  let dps = info.dmg * info.rate * (1 - armor / 25)
  if (me.shield && info.kind !== 'explode') dps *= 1 - 0.45 * (me.skill ?? 0.5)
  if (info.kind === 'ranged') dps *= 0.6 // not every shot lands, and cover helps
  if (info.kind === 'melee' && info.hp < 60) dps *= 0.5 // each hit knocks it back, so it can't swing all the time
  return dps
}

/**
 * @param {Array<{ id, name, distance, approaching?, baby?, angry?, protected?, hurtMe?, nearFriend?, health? }>} mobs
 * @param {{ health, armor, weapon, shield, bow, arrows, skill, food, foodCount, totem }} me
 * @param {{ wants?: Set<string>, risk?: number, fear?: number, aggression?: number, day?: boolean, wearingGold?: boolean }} ctx
 */
function assess (mobs, me, ctx = {}) {
  const health = Math.max(1, me.health ?? 20) + (me.totem ? 10 : 0)
  const dps = ownDps(me)
  const risk = ctx.risk ?? 0.5
  const fear = ctx.fear ?? 0
  const hungry = (me.food ?? 20) <= 14 || (me.foodCount ?? 0) < 3
  const ranged = me.bow && (me.arrows || 0) >= 4
  // How much of its health it's willing to bet on a fight it wants.
  const nerve = Math.max(0.15, Math.min(0.9, 0.35 + 0.4 * risk - 0.25 * fear + 0.1 * (ctx.aggression ?? 0)))
  const list = []
  for (const m of mobs) {
    const info = MOBS[m.name] || M(20, 4, 1, 'melee', 1, 'hostile')
    const d = m.distance ?? 8
    const angry = m.angry || m.hurtMe || (info.aggro === 'night' && !ctx.day) || info.aggro === 'hostile'
    const piglinCalm = m.name === 'piglin' && ctx.wearingGold
    const hostileNow = angry && !piglinCalm && info.aggro !== 'passive' && !m.protected // a zombie in an iron farm can't get out
    const hp = m.health ?? info.hp
    const ttk = hp / dps
    let taken = incoming(info, me) * ttk
    if (info.kind === 'explode') taken = 22 * (1 - Math.min(20, me.armor || 0) / 25) * (ranged ? 0.1 : d < 3 ? 0.65 : 0.35) * (1.2 - (me.skill ?? 0.5))
    if (info.kind === 'swarm') taken *= 2.5
    let danger = info.aggro === 'never' ? 1.5 : taken / health
    if (!hostileNow && info.aggro !== 'never') danger *= 0.3 // only if it gets provoked
    const why = []
    let worth = 0
    const wanted = info.drops.filter((x) => ctx.wants?.has(x))
    if (wanted.length) { worth += 0.5; why.push(`drops ${wanted.join(', ')} you want`) }
    if (info.drops.some((x) => FOOD.test(x)) && hungry) { worth += 0.5; why.push('food') }
    if (hostileNow && d < 12 && info.speed >= 0.8 && info.kind !== 'explode') { worth += 0.35; why.push('it will come for you anyway') }
    if (m.hurtMe) { worth += 0.3; why.push('it hurt you') }
    if (m.nearFriend) { worth += 0.4; why.push(`it's near ${m.nearFriend}`) }
    if (hostileNow) worth += 0.05 // xp
    if (info.aggro === 'neutral' && !angry) { worth -= 0.7; why.push('leave it be: it only fights back') }
    if (piglinCalm) why.push("you wear gold, it won't bother you")
    if (info.aggro === 'passive' && !why.includes('food') && !wanted.length) { worth -= 0.3; why.push("don't need it") }
    if (m.baby) { worth -= 0.4; why.push('a baby') }
    worth += 0.1 * (ctx.aggression ?? 0)

    let verdict
    if (m.protected) { verdict = 'leave'; worth = -1; why.length = 0; why.push(`protected: ${m.protected}`) } else if (info.aggro === 'never') { verdict = d < 16 ? 'flee' : 'avoid'; why.unshift(info.note) } else if (info.kind === 'explode') {
      // Creepers: shoot them, or a quick hit and back off when good at it; otherwise keep the distance.
      verdict = ranged || ((me.skill ?? 0.5) >= 0.6 && danger < nerve && d > 3) ? 'fight' : d < 5 ? 'flee' : 'avoid'
      why.unshift(info.note)
    } else if (!hostileNow) verdict = worth > 0.2 && danger < nerve ? 'fight' : 'ignore'
    else if (danger >= nerve * 1.6 || (danger >= nerve && worth < 0.6)) verdict = d < 7 ? 'flee' : 'avoid'
    else if (worth > 0.2) verdict = 'fight'
    else verdict = d < 6 ? 'fight' : 'avoid'
    list.push({ id: m.id, name: m.name, distance: Math.round(d), danger: round(danger), worth: round(worth), verdict, hostile: hostileNow, why: why.slice(0, 3).join('; '), note: info.note })
  }

  // Together: fighting several means all of them hit while you kill them one after another.
  const fighters = list.filter((x) => x.hostile && x.distance < 14).sort((a, b) => a.distance - b.distance)
  let total = 0
  let elapsed = 0
  for (const x of fighters) {
    const info = MOBS[x.name] || M(20, 4, 1, 'melee', 1, 'hostile')
    elapsed += (info.hp / dps)
    total += info.kind === 'explode' ? x.danger * health : incoming(info, me) * elapsed * (x.distance < 6 ? 1 : 0.5)
  }
  const together = round(total / health)
  let verdict = 'safe'
  if (list.some((x) => x.verdict === 'flee') || (fighters.length > 1 && together >= nerve * 1.8)) verdict = 'flee'
  else if (fighters.some((x) => x.verdict === 'fight')) verdict = 'fight'
  else if (list.some((x) => x.verdict === 'avoid' || x.hostile)) verdict = 'watch'
  return { list: list.sort((a, b) => b.danger - a.danger || a.distance - b.distance), danger: together, verdict, nerve: round(nerve) }
}

/** One line per creature for the prompt: "zombie 5m: danger low, worth it (it will come for you anyway) → fight". */
function describe (a, max = 5) {
  const level = (d) => (d < 0.15 ? 'low' : d < 0.4 ? 'some' : d < 0.8 ? 'high' : 'deadly')
  const lines = a.list.filter((x) => x.verdict !== 'ignore' || x.distance < 8).slice(0, max).map((x) => {
    const passive = MOBS[x.name]?.aggro === 'passive'
    const worth = x.worth > 0.2 ? (passive ? ', worth hunting' : ', worth fighting') : x.worth < 0 && x.verdict !== 'leave' ? (passive ? '' : ', not worth fighting') : ''
    const verdict = passive && x.verdict === 'fight' ? 'hunt' : x.verdict
    return `${x.name} ${x.distance}m: ${passive ? '' : `danger ${level(x.danger)}`}${worth}${x.why ? ` (${x.why})` : ''} → ${verdict}`.replace(': ,', ':').replace(':  (', ': (')
  })
  if (a.verdict === 'flee' && a.list.filter((x) => x.hostile).length > 1) lines.unshift(`all together: too many for you right now (danger ${level(a.danger)}) → get away`)
  return lines
}

const round = (v) => Math.round(v * 100) / 100

module.exports = { assess, describe, ownDps, MOBS }
