'use strict'

/**
 * mechanics.js — recognising what other players built to make the game work for them, the way an experienced player
 * walks past a contraption and says "oh, a kelp farm feeding a smoker array".
 *
 * scan(bot, center) looks at the blocks and creatures around and matches known contraptions. Each one says:
 *   what it is, which game mechanic it uses, what it gives the player, a rough rate, and how a better player would
 *   improve or copy it. How much it understands depends on its knowledge level:
 *     3+ names the common ones (cobblestone generator, auto-smelter, crop farm)
 *     5+ explains the mechanic and the benefit
 *     6+ (master) adds efficiency notes and improvements; 7 (impossible) also spots exploits and their risks
 */

const RULES = [
  {
    id: 'cobble_generator', min: 2, name: 'cobblestone generator',
    test: (s) => s.has('lava') && s.has('water') && s.close('lava', 'water', 3) && (s.has('cobblestone') || s.has('stone')),
    mechanic: 'flowing lava meeting water turns into cobblestone (stone if lava flows onto still water), forever',
    benefit: 'endless cobblestone without mining',
    better: 'mine it with an Efficiency V pickaxe and a piston or a 3-wide row of generators; a basalt generator (lava, blue ice, soul soil) gives basalt the same way'
  },
  {
    id: 'infinite_water', min: 1, name: 'infinite water source',
    test: (s) => s.count('water') >= 3 && s.count('water') <= 12,
    mechanic: 'two water sources next to a gap make a new source block',
    benefit: 'bottomless water for buckets and farms',
    better: 'a 2x2 pool is enough; a 3x1 trough is cheaper to dig'
  },
  {
    id: 'observer_crop_farm', min: 3, name: 'observer-piston crop farm',
    test: (s) => s.has('observer') && (s.has('piston') || s.has('sticky_piston')) && ['sugar_cane', 'bamboo', 'kelp', 'kelp_plant', 'pumpkin', 'melon', 'cactus'].some((c) => s.has(c)),
    detail: (s) => ['sugar_cane', 'bamboo', 'kelp_plant', 'kelp', 'pumpkin', 'melon', 'cactus'].find((c) => s.has(c)).replace('_plant', '').replace(/_/g, ' '),
    mechanic: 'an observer notices the crop growing and fires a piston that breaks it; hoppers or a water stream collect the drops',
    benefit: 'crops harvested by themselves while you do something else',
    rate: 'a few items per plant per hour (sugar cane grows about every 15-20 minutes per block)',
    better: 'longer rows on one observer line, a hopper minecart under the floor to collect through solid blocks, and pointing it into a smoker array (kelp → dried kelp blocks = fuel)'
  },
  {
    id: 'auto_smelter', min: 3, name: 'auto-smelter',
    test: (s) => ['furnace', 'smoker', 'blast_furnace'].some((f) => s.has(f)) && s.count('hopper') >= 2 && s.closeAny(['furnace', 'smoker', 'blast_furnace'], 'hopper', 1),
    mechanic: 'hoppers feed items into the top of a furnace and fuel into its side, and pull the results out of the bottom',
    benefit: 'smelting stacks while away',
    rate: 'one furnace does 8 items per piece of coal, 10 seconds each; a row of 8 is 8x faster',
    better: 'a hopper chain over a row of furnaces splits stacks across them; blast furnaces and smokers run twice as fast for ores and food'
  },
  {
    id: 'item_sorter', min: 4, name: 'item sorter',
    test: (s) => s.has('comparator') && s.count('hopper') >= 3 && s.count('chest') + s.count('barrel') >= 2 && (s.has('repeater') || s.has('redstone_torch') || s.has('redstone_wall_torch')),
    mechanic: 'a filter hopper holding 41 of an item makes its comparator read just below the unlock level, so only one more matching item tips it and lets that kind through',
    benefit: 'every item lands in its own chest automatically',
    better: 'overflow-protected slices with a repeater lock; a hopper line on top so slices stack in a long wall'
  },
  {
    id: 'iron_farm', min: 4, name: 'iron farm',
    test: (s) => s.ent('villager') >= 3 && (s.ent('zombie') >= 1 || s.ent('zombie_villager') >= 1) && s.has(/_bed$/),
    mechanic: "villagers that have slept recently panic when they see a zombie and summon iron golems; the golems drop into lava or a drop and leave their iron",
    benefit: 'iron without mining',
    rate: 'about one golem every 30-60 seconds per group of 3 villagers (several hundred iron an hour)',
    better: 'several villager pods sharing one kill chamber, and a hopper line into a sorter; never kill the zombie or the villagers'
  },
  {
    id: 'trading_hall', min: 4, name: 'villager trading hall',
    test: (s) => s.ent('villager') >= 3 && ['lectern', 'composter', 'barrel', 'smoker', 'blast_furnace', 'cartography_table', 'brewing_stand', 'fletching_table', 'grindstone', 'loom', 'smithing_table', 'stonecutter', 'cauldron'].filter((w) => s.has(w)).length >= 2,
    mechanic: 'a workstation fixes a villager\'s job; locked in a cell it can\'t wander off, and its trades refresh when it works',
    benefit: 'cheap enchanted books, mending, diamond gear and emeralds',
    better: 'curing zombie villagers (weakness + golden apple) gives permanent discounts; reroll a librarian\'s trade by breaking and replacing its lectern before you trade'
  },
  {
    id: 'mob_farm', min: 4, name: 'mob farm',
    test: (s) => (s.has('spawner') && (s.has('hopper') || s.count('water') >= 4)) || (s.count('hopper') >= 4 && s.count('water') >= 6 && s.has('magma_block')),
    mechanic: 'mobs spawn in the dark (or from a spawner), water streams push them to one spot, and a drop or magma does the damage',
    benefit: 'mob drops and experience',
    better: 'kill them at half a heart so the last hit is yours (more XP, looting works); slabs or carpet on surfaces where nothing should spawn'
  },
  {
    id: 'chicken_cooker', min: 3, name: 'automatic chicken cooker',
    test: (s) => s.ent('chicken') >= 3 && s.has('hopper') && (s.has('lava') || s.has('campfire') || s.has('furnace') || s.has('smoker')),
    mechanic: 'chickens lay eggs into hoppers that hatch more chickens; grown ones get cooked by lava, a campfire or a smoker',
    benefit: 'free cooked chicken and feathers',
    better: 'adults only: baby chickens fit under a slab so only grown ones reach the cooker'
  },
  {
    id: 'bubble_elevator', min: 3, name: 'bubble column elevator',
    test: (s) => s.count('water') >= 4 && (s.has('soul_sand') || s.has('magma_block')) && s.close('water', s.has('soul_sand') ? 'soul_sand' : 'magma_block', 1),
    mechanic: 'soul sand under water makes an upward bubble column, magma a downward one',
    benefit: 'fast, safe vertical travel',
    better: 'kelp first to turn flowing water into sources, then the soul sand'
  },
  {
    id: 'ice_road', min: 4, name: 'ice boat road',
    test: (s) => s.count('packed_ice') + s.count('blue_ice') >= 15,
    mechanic: 'boats slide almost without friction on ice: about 40 blocks a second on packed ice, over 70 on blue ice',
    benefit: 'very fast travel, especially in the Nether (each block there is 8 in the Overworld)',
    better: 'blue ice, a one-wide lane with walls, and trapdoors or slabs on the edges'
  },
  {
    id: 'piston_door', min: 4, name: 'piston door',
    test: (s) => s.count('sticky_piston') >= 2 && (s.has('redstone_wire') || s.has('repeater')) && (s.has(/_button$/) || s.has(/_pressure_plate$/) || s.has('lever')),
    mechanic: 'sticky pistons pull the door blocks aside on a signal and push them back when it ends',
    benefit: 'a hidden or bigger entrance',
    better: 'a 2x2 door needs only 4 sticky pistons and a pulse extender; observers make it flush'
  },
  {
    id: 'flying_machine', min: 6, name: 'flying machine',
    test: (s) => (s.has('slime_block') || s.has('honey_block')) && s.has('observer') && (s.has('piston') || s.has('sticky_piston')),
    mechanic: 'observers and pistons push each other along through slime blocks, so the whole thing moves itself',
    benefit: 'moving platforms, tunnel bores and world-eaters',
    better: 'a two-way machine with a stopper block; carry slime blocks as the frame'
  },
  {
    id: 'tnt_duper', min: 7, name: 'TNT duplicator', exploit: true,
    test: (s) => s.has('tnt') && (s.has('slime_block') || s.has('honey_block')) && s.has('observer'),
    mechanic: 'a piston and coral fan (or slime) update bug that copies TNT',
    benefit: 'free TNT for world-eaters and quarries',
    better: 'check the server rules first: many servers ban duplication, and it can wreck builds'
  }
]

const WATCH = new Set(RULES.length ? ['lava', 'water', 'cobblestone', 'stone', 'observer', 'piston', 'sticky_piston', 'sugar_cane', 'bamboo', 'kelp', 'kelp_plant', 'pumpkin', 'melon', 'cactus', 'furnace', 'smoker', 'blast_furnace', 'hopper', 'comparator', 'chest', 'barrel', 'repeater', 'redstone_torch', 'redstone_wall_torch', 'redstone_wire', 'lectern', 'composter', 'cartography_table', 'brewing_stand', 'fletching_table', 'grindstone', 'loom', 'smithing_table', 'stonecutter', 'cauldron', 'spawner', 'magma_block', 'campfire', 'soul_sand', 'packed_ice', 'blue_ice', 'slime_block', 'honey_block', 'tnt', 'lever'] : [])

/** Everything near `center` worth knowing about, with how close things are to each other. */
function survey (bot, center, radius = 12) {
  const byName = new Map()
  const ids = []
  for (const b of bot.registry.blocksArray) if (WATCH.has(b.name) || /_bed$|_button$|_pressure_plate$/.test(b.name)) ids.push(b.id)
  const found = safe(() => bot.findBlocks({ matching: ids, maxDistance: radius, count: 400, point: center })) || []
  for (const p of found) {
    const b = bot.blockAt(p)
    if (!b) continue
    if (!byName.has(b.name)) byName.set(b.name, [])
    byName.get(b.name).push(p)
  }
  const ents = {}
  for (const e of Object.values(bot.entities || {})) if (e.name && e.position && e.position.distanceTo(center) <= radius + 4) ents[e.name] = (ents[e.name] || 0) + 1
  const list = (n) => n instanceof RegExp ? [...byName.entries()].filter(([k]) => n.test(k)).flatMap(([, v]) => v) : byName.get(n) || []
  const s = {
    has: (n) => list(n).length > 0,
    count: (n) => list(n).length,
    ent: (n) => ents[n] || 0,
    close: (a, b, d) => list(a).some((p) => list(b).some((q) => p.distanceTo(q) <= d + 0.01)),
    closeAny: (as, b, d) => as.some((a) => s.close(a, b, d)),
    blocks: byName,
    entities: ents
  }
  return s
}

/**
 * What's around: [{ id, name, text }] with as much understanding as its knowledge level allows.
 * level: knowledge level 0..7.
 */
function scan (bot, center, level = 3, radius = 12) {
  const s = survey(bot, center, radius)
  const out = []
  for (const r of RULES) {
    if (level < r.min) continue
    if (!safe(() => r.test(s))) continue
    const what = r.detail ? `${safe(() => r.detail(s))} ${r.name.replace('observer-piston crop farm', 'farm (observer + piston)')}` : r.name
    let text = what
    if (level >= 5) text += `: ${r.mechanic}; gives ${r.benefit}`
    if (level >= 6 && r.rate) text += ` (${r.rate})`
    if (level >= 6 && r.better) text += `. Better: ${r.better}`
    if (r.exploit) text += '. This is an exploit: check the server rules before using or copying it'
    out.push({ id: r.id, name: what, text, exploit: Boolean(r.exploit) })
  }
  return out
}

function safe (fn) { try { return fn() } catch { return null } }

module.exports = { scan, survey, RULES }
