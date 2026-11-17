'use strict'

/**
 * acquire.js — "get me <item>": the next concrete step toward having exactly that item.
 *
 * Mines the block that drops it (the exact kind asked for: cherry logs means cherry logs), gets a pickaxe first when
 * the block needs one, crafts it (making/collecting the ingredients first, only recipes it knows), smelts it (input,
 * fuel and a furnace first), or hunts the animal that drops it. Anything else (trading, bosses...) returns null and
 * the model decides.
 */

const { SMELTING } = require('./knowledge')

/** Animal and monster drops it can hunt for (only mobs it would fight anyway: never pets or villagers). */
const MOB_DROPS = {
  beef: ['cow', 'mooshroom'], leather: ['cow', 'mooshroom'], porkchop: ['pig'], chicken: ['chicken'], feather: ['chicken'],
  mutton: ['sheep'], white_wool: ['sheep'], rabbit: ['rabbit'], rabbit_hide: ['rabbit'], cod: ['cod'], salmon: ['salmon'],
  string: ['spider', 'cave_spider'], spider_eye: ['spider'], bone: ['skeleton', 'stray'], arrow: ['skeleton', 'stray'],
  gunpowder: ['creeper'], rotten_flesh: ['zombie', 'husk', 'drowned'], ender_pearl: ['enderman'], slime_ball: ['slime']
}
const FUEL = /^(coal|charcoal|coal_block|.*_log|.*_planks|.*_wood|.*_stem|stick|blaze_rod|lava_bucket|dried_kelp_block)$/

const TIER_ORDER = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
const COMPRESSED = /_(block|nugget)$/

/**
 * @param {{ item: string, count: number, inv: object, near: object, registry: object, knows: (n: string) => boolean,
 *   mobs?: Array<{ id: number, name: string, distance?: number }>, depth?: number }} o
 * @returns {{ name: string, args: object, why: string }|{ unknown: string }|null}
 */
function nextAcquireStep (o) {
  const { item, count, inv, near, registry, knows } = o
  const depth = o.depth || 0
  const def = registry.itemsByName[item]
  if (!def || depth > 4) return null
  const have = inv[item] || 0
  if (have >= count) return null
  const need = count - have
  const recipes = registry.recipes[def.id] || []
  const blocks = registry.blocksArray.filter((b) => Array.isArray(b.drops) && b.drops.includes(def.id))
  const naturalBlocks = blocks.filter((b) => b.name !== item) // a block that drops it but is not just its placed form
  const preferCraft = recipes.length > 0 && blocks.every((b) => b.name === item)

  // 1. Mine it (when it is not simply a craftable block).
  const mineable = naturalBlocks.length ? naturalBlocks : (preferCraft ? [] : blocks)
  if (mineable.length) {
    const b = mineable.find((x) => near[x.name]) || mineable.find((x) => x.name === item) || mineable[0]
    if (b.harvestTools && Object.keys(b.harvestTools).length) {
      const ids = Object.keys(b.harvestTools).map(Number)
      const holds = Object.entries(inv).some(([n, c]) => c > 0 && ids.includes(registry.itemsByName[n]?.id))
      if (!holds) {
        const names = ids.map((i) => registry.items[i]?.name).filter(Boolean)
        const cheapest = TIER_ORDER.map((t) => names.find((n) => n.startsWith(`${t}_`))).find(Boolean) || names[0]
        const sub = nextAcquireStep({ ...o, item: cheapest, count: 1, depth: depth + 1 })
        return sub && !sub.unknown ? { ...sub, why: `${sub.why} (needed to get ${item})` } : sub
      }
    }
    return { name: 'mineBlock', args: { blockType: b.name, count: Math.min(16, need), maxDistance: 48, exact: true }, why: `mining ${b.name} for ${item}` }
  }

  // 2. Craft it (unless the only recipes go through blocks/nuggets of it and it can be smelted: iron ingots).
  const ingredientsOf = (r) => (r.ingredients || r.inShape.flat()).filter((x) => x != null && x !== -1).map((x) => registry.items[x]?.name)
  const viaCompressed = (r) => ingredientsOf(r).some((n) => COMPRESSED.test(n || '') && !(inv[n] > 0))
  const craftable = recipes.length && !(SMELTING[item] && recipes.every(viaCompressed))
  if (craftable) {
    if (!knows(item)) return { unknown: item }
    let best = null
    for (const r of recipes) {
      const ing = {}
      const flat = r.ingredients || r.inShape.flat().filter((x) => x != null && x !== -1)
      for (const x of flat) { const n = registry.items[x].name; ing[n] = (ing[n] || 0) + 1 }
      if (Object.keys(ing).some((n) => COMPRESSED.test(n) && !(inv[n] > 0))) continue // not via 9 ingots in a block and back
      const crafts = Math.ceil(need / r.result.count)
      const missing = Object.entries(ing).map(([n, q]) => [n, q * crafts - (inv[n] || 0)]).filter(([, m]) => m > 0)
      // Fewest missing items; among equals, the ordinary material (cobblestone) over the exotic variant (blackstone, deepslate...).
      const total = missing.reduce((a, [, m]) => a + m, 0) + (Object.keys(ing).some((n) => /deepslate|blackstone|crimson|warped|mangrove|cherry|bamboo|pale/.test(n)) ? 0.5 : 0)
      if (!best || total < best.total) best = { r, ing, crafts, missing, total }
    }
    if (!best) return null
    for (const [n, m] of best.missing) {
      if (/_planks$/.test(n) || n === 'stick') {
        // craftItem makes these from any wood: only wood is missing.
        const woodEq = Object.entries(inv).reduce((a, [k, c]) => a + (/_log$/.test(k) ? c * 4 : /_planks$/.test(k) ? c : 0), 0)
        if (woodEq < (n === 'stick' ? Math.ceil(m / 4) * 2 : m)) return { name: 'mineBlock', args: { blockType: 'log', count: Math.min(8, Math.ceil(m / 4) + 1), maxDistance: 48 }, why: `wood for ${item}` }
        continue
      }
      return nextAcquireStep({ ...o, item: n, count: (inv[n] || 0) + m, depth: depth + 1 })
    }
    return { name: 'craftItem', args: { itemName: item, count: best.crafts }, why: `crafting ${item}` }
  }

  // 3. Smelt it (ores → ingots, raw meat → cooked, logs → charcoal, sand → glass...).
  const sources = SMELTING[item]
  if (sources) {
    const inputs = sources.flatMap((x) => x === 'any log' ? Object.keys(inv).filter((n) => /_log$/.test(n)).concat(['oak_log']) : [x])
      .filter((n) => registry.itemsByName[n])
    const input = inputs.find((n) => (inv[n] || 0) >= need) || inputs.find((n) => inv[n] > 0) || inputs[0]
    if (!input) return null
    if ((inv[input] || 0) < need) {
      const sub = nextAcquireStep({ ...o, item: input, count: need, depth: depth + 1 })
      return sub && !sub.unknown ? { ...sub, why: `${sub.why} (to smelt into ${item})` } : sub
    }
    if (!near.furnace && !near.smoker && !near.blast_furnace && !(inv.furnace > 0)) {
      const sub = nextAcquireStep({ ...o, item: 'furnace', count: 1, depth: depth + 1 })
      return sub && !sub.unknown ? { ...sub, why: `${sub.why} (a furnace to make ${item})` } : sub
    }
    const fuel = Object.entries(inv).some(([n, c]) => c > (n === input ? need : 0) && FUEL.test(n))
    if (!fuel) return { name: 'mineBlock', args: { blockType: near.coal_ore ? 'coal_ore' : 'log', count: 3, maxDistance: 48 }, why: `fuel to smelt ${item}` }
    return { name: 'smeltItem', args: { itemName: input, count: need, waitSeconds: Math.min(60, 10 * need + 3) }, why: `smelting ${input} into ${item}` }
  }

  // 4. Hunt the animal that drops it.
  const kinds = MOB_DROPS[item]
  if (kinds) {
    const prey = (o.mobs || []).filter((m) => kinds.includes(m.name)).sort((a, b) => (a.distance ?? 99) - (b.distance ?? 99))[0]
    if (prey && /_wool$/.test(item) && inv.shears > 0) return { name: 'useItem', args: { itemName: 'shears', target: String(prey.id) }, why: `shearing a sheep for ${item}`, then: 'collectDrops' }
    if (prey) return { name: 'attackTarget', args: { entityId: prey.id, maxSeconds: 20 }, why: `hunting a ${prey.name} for ${item}`, then: 'collectDrops' }
    return { name: 'explore', args: { distance: 40 }, why: `looking for a ${kinds[0]} (for ${item})` }
  }
  return null
}

/** Food it could cook from what animals are around (best first), for "get food". */
function foodTarget (mobs = []) {
  const order = [['cooked_beef', 'cow'], ['cooked_porkchop', 'pig'], ['cooked_mutton', 'sheep'], ['cooked_chicken', 'chicken'], ['cooked_rabbit', 'rabbit']]
  const seen = new Set(mobs.map((m) => m.name))
  return (order.find(([, mob]) => seen.has(mob)) || order[0])[0]
}

module.exports = { nextAcquireStep, foodTarget, MOB_DROPS }
