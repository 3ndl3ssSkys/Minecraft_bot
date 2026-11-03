'use strict'

/**
 * acquire.js — "get me <item>": the next concrete step toward having exactly that item.
 *
 * Mines the block that drops it (the exact kind asked for: cherry logs means cherry logs), gets a pickaxe first when
 * the block needs one, or crafts it (making/collecting the ingredients first), but only recipes it knows.
 * Anything it cannot plan (smelting, trading, mobs) returns null and the model decides.
 */

const TIER_ORDER = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
const COMPRESSED = /_(block|nugget)$/

/**
 * @param {{ item: string, count: number, inv: object, near: object, registry: object, knows: (n: string) => boolean, depth?: number }} o
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

  // 2. Craft it.
  if (recipes.length) {
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
  return null
}

module.exports = { nextAcquireStep }
