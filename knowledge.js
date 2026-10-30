'use strict'

/**
 * knowledge.js — what an experienced player knows about Minecraft.
 *
 * Two sources:
 *   1. Hand-written know-how (progression, ore levels, combat items, brewing,
 *      the Nether/End, farming, dangers...). Relevant facts are picked by
 *      keyword for each decision prompt.
 *   2. The game's own data (minecraft-data for the server's version): recipes,
 *      block and mob loot, food values, durability, harvest tools — used to
 *      answer "how do I get X?" and "what is X good for?" precisely.
 */

const FACTS = [
  // Progression & tools
  ['progress start wood tools early', 'Early game: punch logs → planks (1 log = 4) → sticks → crafting table → wooden pickaxe → mine stone → stone tools → furnace (8 cobblestone).', 0],
  ['tools tier pickaxe harvest', 'Tool tiers: wood < stone < iron < diamond < netherite. Iron ore needs a stone pickaxe; diamond, gold, redstone and emerald ore need iron; obsidian and ancient debris need diamond.', 1],
  ['netherite upgrade smithing', 'Netherite: 4 ancient debris → smelt to netherite scrap; 4 scrap + 4 gold ingots = 1 netherite ingot. Upgrade diamond gear at a smithing table with a netherite upgrade template (found in bastions).', 5],
  ['durability repair mending anvil', 'Repair tools by combining two of the same in a crafting grid, or with an anvil and materials. Mending (librarian villager trade or fishing/loot) repairs with XP.', 3],
  // Ores (1.18+)
  ['diamond ore y level mining', 'Diamonds: most common deep, around y -58 to -54 (deepslate layer). Branch-mine there, 2 blocks between tunnels. Never dig straight down.', 2],
  ['iron ore y level', 'Iron: very common around y 15 and in mountains (high up, y 80+). Also in caves; raw iron smelts into iron ingots.', 2],
  ['gold ore y level badlands', 'Gold: around y -16, and plentiful at any height in badlands. Nether gold ore drops nuggets. Piglins barter for gold and don\'t attack if you wear gold armor.', 3],
  ['coal ore copper lapis redstone emerald', 'Coal: common high up (y 95). Copper: around y 48. Lapis: around y 0. Redstone: deep, y -58. Emerald: only in mountains.', 3],
  ['ancient debris nether netherite', 'Ancient debris: Nether, y 8–22 (best y 15). Blast-resistant; mining with beds/TNT is common (beds explode in the Nether).', 5],
  // Food & farming
  ['food hunger best', 'Good food: golden carrots (best saturation), steak and cooked porkchop, bread (3 wheat), baked potatoes. Cook raw meat in a furnace or smoker. Rotten flesh can give hunger.', 1],
  ['farm farming wheat crops seeds water', 'Farming: till dirt/grass with a hoe within 4 blocks of water, plant seeds (from breaking grass), bone meal speeds growth. Light keeps it growing at night.', 2],
  ['animals breeding cows sheep chickens pigs', 'Breed cows/sheep with wheat, pigs with carrots/potatoes/beetroot, chickens with seeds. Sheep give wool (shears keep the sheep alive). Cows give leather and milk.', 2],
  // Crafting essentials
  ['bed sleep night', 'Bed: 3 wool + 3 planks. Sleeping skips the night and sets your spawn. Beds explode in the Nether and the End.', 1],
  ['torch light mobs spawn', 'Torches: coal/charcoal + stick (4 torches). Hostile mobs spawn at light level 0, so lighting an area stops spawns. Charcoal comes from smelting logs.', 1],
  ['chest storage barrel shulker', 'Storage: chest (8 planks), barrel (6 planks + 2 slabs). Shulker boxes (2 shulker shells from End cities + chest) keep items when broken.', 1],
  ['glass sand smelt window', 'Glass: smelt sand. 6 glass → 16 glass panes. Use glass for windows; panes are cheaper.', 2],
  ['bucket water lava iron', 'Bucket: 3 iron ingots. Water buckets put out fire, make infinite water (2 sources), and break falls if placed just before landing (MLG). Lava is fuel for 100 items.', 2],
  ['furnace smelting fuel', 'Fuel: coal or charcoal = 8 items, a log or planks = 1.5, stick = 0.5, blaze rod = 12, lava bucket = 100. Smokers cook food 2× faster, blast furnaces smelt ores 2× faster.', 2],
  ['brewing potions stand nether wart', 'Brewing: brewing stand (blaze rod + 3 cobblestone), fuel with blaze powder. Water bottle + nether wart = awkward potion, then add an ingredient. Redstone extends, glowstone strengthens, gunpowder makes it splash, dragon\'s breath lingering.', 4],
  ['potion ingredients healing strength regeneration', 'Potion ingredients: glistering melon → healing, ghast tear → regeneration, blaze powder → strength, sugar → swiftness, magma cream → fire resistance, golden carrot → night vision, pufferfish → water breathing, spider eye → poison, phantom membrane → slow falling. Fermented spider eye corrupts (healing→harming, swiftness→slowness).', 4],
  ['enchanting table bookshelves lapis', 'Enchanting table: book + 2 diamonds + 4 obsidian. Place 15 bookshelves one block away for level-30 enchants. Costs lapis and XP levels.', 3],
  ['villager trading emerald', 'Villagers trade for emeralds. Librarians can sell Mending and other enchanted books; farmers buy crops. Protect villages from raids and zombies.', 4],
  // Nether & End
  ['nether portal obsidian flint', 'Nether portal: obsidian frame 4×5 (corners optional, so 10 obsidian), light it with flint and steel. Obsidian forms when water touches a lava source.', 3],
  ['nether dangers ghast fortress blaze', 'Nether: no water, beds explode, ghasts shoot fireballs (hit them back), lava everywhere. Fortresses have blazes (blaze rods) and wither skeletons (skulls). Bring fire resistance.', 3],
  ['end eye ender stronghold dragon', 'The End: eye of ender = ender pearl + blaze powder. Throw eyes to find the stronghold, fill the portal frame. Fight the dragon: destroy end crystals first, bring a bow, blocks, water bucket, slow falling.', 4],
  // Combat items
  ['combat crit critical sword axe cooldown', 'Combat (1.9+): wait for the attack cooldown — swords ~0.6s, axes ~1s. Hitting while falling (jump-hit) is a critical: 1.5× damage. Sprint-hitting knocks back further; releasing W briefly resets sprint.', 3],
  ['shield block axe disable', 'Shields block most melee and arrows from the front. An axe hit disables a raised shield for 5 seconds — swap to an axe when an enemy blocks, then back to the sword.', 3],
  ['mace wind charge smash breeze', 'Mace: damage grows with fall distance (smash attack) and the hit cancels your fall damage. Throw a wind charge at your feet to launch yourself, swap to the mace and hit on the way down. Wind charges come from breezes in trial chambers; the mace from a heavy core + breeze rod.', 5],
  ['bow crossbow arrows aim', 'Bow: full draw takes 1 second; arrows drop over distance, so aim higher for far targets and lead moving ones. Crossbows load slowly but hit harder and can fire fireworks. Endermen dodge arrows, breezes deflect them.', 2],
  ['totem undying offhand', 'Totem of undying (from evokers in woodland mansions/raids): hold it in a hand (usually off-hand) and it saves you from death once, with regeneration and absorption.', 4],
  ['golden apple gapple absorption', 'Golden apple (8 gold ingots + apple): absorption and regeneration — eat mid-fight after backing off. Enchanted golden apples (loot only) are much stronger.', 3],
  ['ender pearl teleport escape', 'Ender pearls (from endermen) teleport you where they land, costing a little health. Great for escaping a fight or crossing gaps.', 3],
  ['potion combat splash undead', 'Splash potions: throw at your feet to heal, or at enemies (harming, poison, weakness, slowness). Undead mobs are healed by harming and hurt by healing; poison does not affect them.', 4],
  ['cobweb trap slow', 'Cobwebs slow anything inside to a crawl — placing one at an attacker\'s feet buys time. Swords and shears break them fast.', 5],
  // Mobs
  ['creeper explode', 'Creepers hiss and explode about 1.5s after getting close. Hit them and back off; shields block the blast. Cats scare them away.', 0],
  ['skeleton ranged mobs', 'Skeletons and pillagers shoot: close the distance behind a shield, zig-zag, or use cover.', 1],
  ['enderman look eyes', 'Endermen get angry if you look at their eyes. Fight them under a 2-block-high ceiling or near water; they teleport away from arrows.', 1],
  ['slime split magma', 'Slimes and magma cubes split into smaller ones when killed — keep fighting until they are all gone. Slimes drop slimeballs (slime blocks, sticky pistons, leads).', 2],
  ['warden deep dark sculk', 'Wardens (deep dark, ancient cities) are nearly unbeatable: stay quiet, crouch, avoid sculk shriekers, and run if one appears.', 3],
  ['phantom insomnia sleep', 'Phantoms spawn if you haven\'t slept for 3+ nights. Sleep regularly; their membranes make slow falling potions and repair elytra.', 3],
  // Survival & dangers
  ['danger lava gravel falling', 'Dangers: never dig straight down or up into gravel/sand; lava hides under blocks deep down; carry a water bucket. Falling more than 3 blocks hurts.', 1],
  ['night shelter first', 'First night: build a small shelter or dig into a hill and block the entrance, light it up, or sleep in a bed.', 0],
  ['nether gold piglin barter', 'Piglins attack unless you wear a piece of gold armor; drop gold ingots near them to barter for pearls, fire resistance potions and more.', 4],
  // Building
  ['building materials house', 'Building: logs make good frames, planks/stone bricks good walls, glass windows, full blocks or stairs for roofs. Light the inside. Stone and deepslate resist creeper blasts better than wood.', 1],
  ['terrain flatten foundation', 'Building on uneven ground: flatten small bumps, fill gaps under the floor with a stone foundation, or put the build on log stilts over steep slopes and water. Digging into a hillside makes a strong, hidden base.', 3],
  // Travel
  ['travel boat horse elytra', 'Travel: boats are fast on water and very fast on ice; horses need a saddle; elytra (End cities) + firework rockets let you fly.', 2],
  ['redstone basics', 'Redstone: dust carries power 15 blocks, repeaters extend and delay, levers/buttons/pressure plates are inputs, pistons push blocks, hoppers move items.', 3],
  // Master: everything the game teaches normal players
  ['spawn slab glass light mobs', 'Mobs can\'t spawn on slabs, glass, leaves, carpet or in any block light (1.18+). Spawners still work in light level 11 or less.', 6],
  ['fall damage water slime hay powder', 'Fall damage is cancelled by landing in water, on slime blocks, powder snow, cobwebs, scaffolding or in a boat; hay bales cut it by 80%.', 6],
  ['speed travel sprint jump ice', 'Fastest travel on foot is sprint-jumping; boats on packed/blue ice are faster than anything except elytra.', 6],
  ['respawn anchor nether glowstone', 'Respawn anchors (crying obsidian + glowstone) set your spawn in the Nether; using one in the Overworld explodes.', 6],
  ['loot structures chest dungeon mineshaft', 'Loot chests: dungeons (with a spawner), mineshafts (minecart chests), desert/jungle temples, shipwrecks, buried treasure, strongholds, bastions, end cities, trial chambers (vaults need trial keys).', 6],
  // Impossible: niche mechanics
  ['sound hear footsteps wall invisible', 'Sounds reach you from about 16 blocks, even through walls, with exact positions: footsteps, mining and chests opening give away hidden or invisible players.', 7],
  ['invisible armor particles arrows', 'Invisible players still show armor and held items, potion swirls, arrows stuck in them, and step/sprint particles; they make normal footstep sounds.', 7],
  ['tracking entity wall render', 'The server sends you players and mobs within about 48 blocks even behind walls — you know where they are before you can see them.', 7],
  ['triangulate eye ender stronghold', 'Stronghold triangulation: throw an eye of ender, note its direction, move 100+ blocks sideways and throw again; the stronghold is where the two lines cross.', 7],
  ['pearl stasis chamber', 'Ender pearl stasis: a pearl held in a bubble column stays in flight; breaking the column later teleports you there from far away.', 7],
  ['slime chunk spawn', 'Slime chunks: 1 in 10 chunks spawns slimes below y 40 in any light; swamps also spawn them at night.', 7],
  ['nether roof bedrock travel', 'The Nether roof above the bedrock ceiling is flat and mob-free — fast and safe for long trips (1 Nether block = 8 Overworld blocks).', 7],
]

/** Smelting results players care about. */
const SMELTING = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'], gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore'], glass: ['sand', 'red_sand'], stone: ['cobblestone'], smooth_stone: ['stone'],
  charcoal: ['any log'], brick: ['clay_ball'], netherite_scrap: ['ancient_debris'], cooked_beef: ['beef'], cooked_porkchop: ['porkchop'],
  cooked_chicken: ['chicken'], cooked_mutton: ['mutton'], cooked_cod: ['cod'], cooked_salmon: ['salmon'], baked_potato: ['potato'],
  dried_kelp: ['kelp'], terracotta: ['clay'], green_dye: ['cactus'], deepslate: ['cobbled_deepslate'], sponge: ['wet_sponge'], lime_dye: ['sea_pickle']
}

/** How to use an item, for the useItem action and for prompts. */
const USES = {
  ender_pearl: 'throw it where you want to teleport', wind_charge: 'throw at your feet to launch up (mace smash), or at enemies to knock them back',
  water_bucket: 'place to put out fire, break a fall, or make water', lava_bucket: 'fuel (100 items) or a dangerous trap', bucket: 'pick up water, lava or milk',
  milk_bucket: 'drink to clear all potion effects', flint_and_steel: 'light a nether portal or set fire', fire_charge: 'light a portal or throw fire',
  bone_meal: 'use on crops, saplings or grass to make them grow', shears: 'shear sheep for wool, collect leaves, break cobwebs fast',
  name_tag: 'rename a mob so it never despawns', lead: 'lead animals around', saddle: 'ride horses, pigs or striders',
  totem_of_undying: 'hold in the off-hand: saves you from one death', shield: 'hold in the off-hand and block', golden_apple: 'eat for absorption + regeneration',
  enchanted_golden_apple: 'eat for strong absorption, regeneration, resistance and fire resistance', firework_rocket: 'boost elytra flight or fire from a crossbow',
  potion: 'drink', splash_potion: 'throw — at your feet to buff/heal yourself, at enemies to harm them', lingering_potion: 'throw to leave a lingering cloud',
  snowball: 'throw to knock back', egg: 'throw (can hatch a chicken)', ender_eye: 'throw to find a stronghold, or fill an end portal frame', trident: 'melee or throw it',
  compass: 'points to world spawn (or a lodestone)', clock: 'shows the time of day', map: 'maps the area', spyglass: 'zoom in', fishing_rod: 'fish, or pull mobs',
  cobweb: 'place to trap/slow enemies', hay_block: 'feed horses or break falls', slime_block: 'bouncy blocks: cancel fall damage'
}

/** Cached reverse loot tables per registry version. */
const cache = new WeakMap()

function index (registry) {
  if (cache.has(registry)) return cache.get(registry)
  const fromBlocks = {}
  const fromMobs = {}
  for (const [block, data] of Object.entries(registry.blockLoot || {})) {
    for (const drop of data.drops || []) {
      if (drop.silkTouch || drop.item === block) continue
      ;(fromBlocks[drop.item] ||= []).push(block)
    }
  }
  for (const [mob, data] of Object.entries(registry.entityLoot || {})) {
    for (const drop of data.drops || []) (fromMobs[drop.item] ||= []).push({ mob, chance: drop.dropChance })
  }
  const out = { fromBlocks, fromMobs }
  cache.set(registry, out)
  return out
}

/** Lowercase words with a crude plural strip, so "diamonds" matches "diamond". */
function words (s) {
  return new Set((String(s || '').toLowerCase().replace(/_/g, ' ').match(/[a-z]+/g) || []).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)))
}

const TOOL_TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
const genericName = (n) => n.endsWith('_planks') ? 'planks (any wood)' : /_log$|_stem$/.test(n) ? 'logs (any wood)' : n.endsWith('_wool') ? 'wool (any color)' : n

/** Pick the most relevant know-how for a context (goal, task, inventory, surroundings). */
/** Can the bot know this fact? (its tier, or it learned it) */
const knows = (opts, keys, tier) => opts.tier === undefined || tier <= opts.tier || Boolean(opts.known?.has(keys))

function relevantFacts (context, limit = 5, opts = {}) {
  const ctx = words(context)
  if (!ctx.size) return []
  return FACTS
    .filter(([keys, , tier]) => knows(opts, keys, tier))
    .map(([keys, text]) => {
      let score = 0
      for (const k of words(keys)) if (ctx.has(k)) score += 2
      for (const w of words(text)) if (w.length > 4 && ctx.has(w)) score += 0.3
      return { text, score }
    })
    .filter((f) => f.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((f) => f.text)
}

/** Recipe ingredients as "3 oak_planks + 2 stick" (first known recipe). */
function recipeText (registry, itemName) {
  const item = registry.itemsByName[itemName]
  const recipes = item && registry.recipes?.[item.id]
  if (!recipes?.length) return null
  const r = recipes[0]
  const counts = {}
  const add = (id) => {
    if (id === null || id === undefined) return
    const iid = Array.isArray(id) ? id[0] : typeof id === 'object' ? id.id : id
    const name = registry.items[iid]?.name
    // "any planks" — unless the result is itself a wood type (oak_planks really needs oak logs).
    const label = name.split('_')[0] === itemName.split('_')[0] ? name : genericName(name)
    if (name) counts[label] = (counts[label] || 0) + 1
  }
  if (r.inShape) for (const row of r.inShape) for (const id of row) add(id)
  if (r.ingredients) for (const id of r.ingredients) add(id)
  const makes = r.result?.count || 1
  const needsTable = r.inShape ? (r.inShape.length > 2 || r.inShape.some((row) => row.length > 2)) : (r.ingredients?.length || 0) > 4
  return `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' + ')} → ${makes} ${itemName}${needsTable ? ' (crafting table)' : ''}`
}

/** Recipes even a beginner knows. */
const COMMON = /^(\w+_planks|stick|crafting_table|wooden_\w+|stone_(pickaxe|axe|shovel|sword|hoe)|torch|furnace|chest|\w+_bed|bread|ladder|\w+_door)$/

/**
 * "How do I get X?" from recipes, smelting, block drops and mob drops.
 * opts.tier limits detail to what a player of that level would know;
 * opts.learnedItems lets it know recipes it has worked out itself.
 */
function howToObtain (registry, rawName, opts = {}) {
  const name = String(rawName || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const { fromBlocks, fromMobs } = index(registry)
  const tier = opts.tier ?? 7
  const learned = opts.learnedItems?.has(name)
  const ways = []
  const recipe = (tier >= 2 || learned || COMMON.test(name)) ? recipeText(registry, name) : null
  if (recipe) ways.push(`craft: ${recipe}`)
  if (SMELTING[name] && (tier >= 2 || learned)) ways.push(`smelt: ${SMELTING[name].slice(0, 3).join(' / ')}`)
  const blocks = fromBlocks[name]
  if (blocks?.length && tier < 2) ways.push(`maybe from mining ${blocks.filter((x) => !/^(infested_|potted_)/.test(x))[0]}`)
  else if (blocks?.length) {
    const b = blocks.filter((x) => !/^(infested_|potted_)/.test(x)).slice(0, 4)
    const tool = (() => {
      const bl = registry.blocksByName[b[0]]
      if (!bl?.harvestTools) return ''
      const tools = Object.keys(bl.harvestTools).map((id) => registry.items[id]?.name).filter(Boolean)
      const lowest = tools.sort((a, b) => TOOL_TIER.indexOf(a.split('_')[0]) - TOOL_TIER.indexOf(b.split('_')[0]))[0]
      return lowest ? ` (needs ${/^[aeiou]/.test(lowest) ? 'an' : 'a'} ${lowest} or better)` : ''
    })()
    ways.push(`mine: ${b.join(', ')}${tool}`)
  }
  const mobs = fromMobs[name]
  if (mobs?.length && tier >= 3) {
    const list = mobs.sort((a, b) => b.chance - a.chance).slice(0, 4)
    ways.push(`kill: ${list.map((m) => tier >= 6 ? `${m.mob} (${Math.round(m.chance * 100)}%)` : m.mob).join(', ')}`)
  }
  if (registry.blocksByName[name] && !blocks && !recipe) ways.push(`mine it directly (${name})`)
  return ways
}

/** A short, practical description of an item or block. */
function describeItem (registry, rawName, opts = {}) {
  const name = String(rawName || '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const item = registry.itemsByName[name]
  const block = registry.blocksByName[name]
  if (!item && !block) return null
  const parts = []
  if (item) parts.push(`stacks to ${item.stackSize}`)
  if (item?.maxDurability) parts.push(`${item.maxDurability} durability`)
  const food = registry.foodsByName?.[name]
  if (food) parts.push(`food ${food.foodPoints} (saturation ${food.saturation})`)
  const tier = opts.tier ?? 7
  if (block && tier >= 6) parts.push(`block, hardness ${block.hardness ?? '?'}${block.resistance !== undefined ? `, blast resistance ${block.resistance}` : ''}`)
  if (USES[name] && tier >= 1) parts.push(`use: ${USES[name]}`)
  const ways = howToObtain(registry, name, opts)
  if (!ways.length && tier < 2) parts.push("you don't know how to get it yet")
  if (ways.length) parts.push(`get it — ${ways.join('; ')}`)
  return `${name} — ${parts.join(', ')}`
}

/** Answer a topic: item info if it names an item/block, plus relevant facts. */
function lookup (registry, topic, opts = {}) {
  const t = String(topic || '').toLowerCase()
  const out = []
  const direct = describeItem(registry, t, opts)
  if (direct) out.push(direct)
  else {
    // Find item names mentioned in the topic ("how do i make a bucket")
    for (const w of t.replace(/[^a-z_ ]/g, ' ').split(/\s+/)) {
      if (w.length < 3) continue
      const d = describeItem(registry, w, opts)
      if (d) { out.push(d); break }
    }
  }
  out.push(...relevantFacts(t, 3, opts))
  if (out.length) return out.join('\n')
  return opts.tier !== undefined && opts.tier < 6
    ? `You don't really know about "${topic}" yet. You could experiment, look around, or ask another player.`
    : `No specific knowledge about "${topic}".`
}

/**
 * Learning facts from experience or from being told. Returns the facts it
 * picked up (keys + text). `chance` is how likely each match sticks.
 */
function learnFrom (text, opts = {}, chance = 0.5) {
  const ctx = words(text)
  if (ctx.size < 2) return []
  const learned = []
  for (const [keys, factText, tier] of FACTS) {
    if (knows(opts, keys, tier)) continue
    let score = 0
    for (const k of words(keys)) if (ctx.has(k)) score += 2
    for (const w of words(factText)) if (w.length > 4 && ctx.has(w)) score += 0.5
    if (score >= 4 && Math.random() < chance) learned.push({ keys, text: factText, tier })
  }
  return learned.slice(0, 2)
}

module.exports = { FACTS, USES, SMELTING, relevantFacts, howToObtain, describeItem, recipeText, lookup, learnFrom }
