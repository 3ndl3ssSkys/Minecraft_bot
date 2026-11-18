'use strict'

/**
 * habits.js — the housekeeping a player does without thinking about it, picked by rules (no model call):
 *
 *   armor      put on armor that's better than what it's wearing (or anything, over nothing)
 *   shield     a shield goes in the off-hand
 *   tools      a pickaxe, axe or sword about to break gets replaced before it does (not beginners: they let it break)
 *   inventory  full pockets: throw out the junk
 *   hotbar     good players keep the same hotbar layout (sword, pickaxe, axe, shovel ... food, blocks): see HOTBAR
 *
 * Each returns { name, args, why } or null. The Brain runs them between actions when nothing is going on.
 */

const { TIER, bestOf } = require('./commonsense')
const ARMOR = /^(leather|chainmail|golden|iron|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/
const SLOTS = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const JUNK = /^(rotten_flesh|poisonous_potato|spider_eye|dead_bush|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|stick|string|bone|feather|leather|flint|gravel|dirt|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|netherrack|sand)$/
const MAX_JUNK_KEEP = { dirt: 16, cobblestone: 64, cobbled_deepslate: 32, stick: 16, string: 8, bone: 8, feather: 8, leather: 16, flint: 8, sand: 16, gravel: 8 }

/** Hotbar layout of a tidy player: slot index → what goes there. */
const HOTBAR = [/_sword$|_axe$/, /_pickaxe$/, /_axe$/, /_shovel$/, /^(cobblestone|dirt|cobbled_deepslate|stone|oak_planks|spruce_planks|birch_planks)$/, null, /^torch$/, /^water_bucket$|^bucket$/, null]
const FOOD_SLOT = 8

const armorTier = (name) => TIER[name.split('_')[0]] ?? -1

/** Better armor in the pockets than on the body: wear it. equipped: { head, torso, legs, feet } item names or null. */
function armorStep (items, equipped) {
  for (const [piece, slot] of Object.entries(SLOTS)) {
    const worn = equipped[slot]
    if (slot === 'torso' && worn === 'elytra') continue // flying gear stays on
    const best = items.filter((i) => { const m = i.name.match(ARMOR); return m && m[2] === piece }).sort((a, b) => armorTier(b.name) - armorTier(a.name))[0]
    if (!best) continue
    if (!worn || armorTier(best.name) > armorTier(worn)) return { name: 'equipItem', args: { itemName: best.name, destination: slot }, why: `putting on the ${best.name.replace(/_/g, ' ')}` }
  }
  return null
}

function shieldStep (items, equipped, combatLevel) {
  if (combatLevel < 2 || equipped.offHand) return null
  return items.some((i) => i.name === 'shield') ? { name: 'equipItem', args: { itemName: 'shield', destination: 'off-hand' }, why: 'shield in my off-hand' } : null
}

/**
 * A tool about to break, with no spare: make another of the same kind (same material if it can, else stone).
 * canCraft(name) says whether the materials are there.
 */
function toolStep (items, canCraft, survivalLevel) {
  if (survivalLevel < 2) return null // beginners let their tools break
  for (const kind of ['pickaxe', 'sword', 'axe']) {
    const all = items.filter((i) => i.name.endsWith(`_${kind}`))
    const best = bestOf(items, kind)
    if (!best || best.left > 0.08) continue
    if (all.some((i) => i.name !== best.name || all.filter((x) => x.name === best.name).length > 1)) continue // has a spare
    const material = best.name.split('_')[0]
    for (const m of [material, 'iron', 'stone']) {
      const name = `${m}_${kind}`
      if (TIER[m] <= TIER[material] && canCraft(name)) return { name: 'craftItem', args: { itemName: name, count: 1 }, why: `my ${best.name.replace(/_/g, ' ')} is about to break, making a new one` }
    }
  }
  return null
}

/** Pockets (almost) full: throw out the junk it has too much of. */
function junkStep (items, freeSlots) {
  if (freeSlots > 1) return null
  const counts = {}
  for (const i of items) if (JUNK.test(i.name)) counts[i.name] = (counts[i.name] || 0) + i.count
  const extra = Object.entries(counts).filter(([n, c]) => c > (MAX_JUNK_KEEP[n] ?? 0)).sort((a, b) => b[1] - a[1])
  if (!extra.length) return null
  const names = extra.slice(0, 3).map(([n]) => n)
  return { name: 'dropItems', args: { itemNames: names.join(', '), keep: Math.max(...names.map((n) => MAX_JUNK_KEEP[n] ?? 0)) }, why: 'pockets are full, tossing junk' }
}

/**
 * Where things should go in the hotbar. slots: array of 46 items (or null) as in bot.inventory.slots.
 * Returns [{ from, to }] moves (at most 3), or [] when tidy enough.
 */
function hotbarMoves (slots) {
  const hotbar = (i) => slots[36 + i]
  const moves = []
  const used = new Set()
  const want = HOTBAR.map((re, i) => i === FOOD_SLOT ? /^(cooked_\w+|bread|baked_potato|golden_carrot|apple|carrot|steak|pumpkin_pie|mushroom_stew)$/ : re)
  for (let i = 0; i < 9 && moves.length < 3; i++) {
    const re = want[i]
    if (!re) continue
    if (hotbar(i) && re.test(hotbar(i).name)) { used.add(36 + i); continue }
    // the best fitting item anywhere (prefer better tools), not one already placed
    let pick = null
    for (let s = 9; s <= 44; s++) {
      const it = slots[s]
      if (!it || used.has(s) || !re.test(it.name)) continue
      if (s >= 36 && want[s - 36] && want[s - 36].test(it.name) && s - 36 < i) continue // sits in an earlier slot it belongs to
      if (!pick || (TIER[it.name.split('_')[0]] ?? 0) > (TIER[slots[pick].name.split('_')[0]] ?? 0)) pick = s
    }
    if (pick !== null && pick !== 36 + i) { moves.push({ from: pick, to: 36 + i }); used.add(36 + i) }
  }
  return moves
}

module.exports = { armorStep, shieldStep, toolStep, junkStep, hotbarMoves, HOTBAR }
