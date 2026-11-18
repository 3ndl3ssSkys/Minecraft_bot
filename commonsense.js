'use strict'

/**
 * commonsense.js — the things any Minecraft player knows without thinking, checked before an action runs.
 *
 * A small model forgets what it carries and copies what it did a moment ago: it crafted a fourth crafting table,
 * made a wooden pickaxe while holding an iron one, tried to eat on a full stomach, kept chopping trees with 40 logs
 * in its pockets. `review()` catches those in code (no model call), and says why in words the model reads next turn.
 *
 * review(decision, view) → null (fine) | { code, message, soft? }
 *   soft: nothing needs doing (already holding it): recorded as done, not as a failure.
 * view: { inv: name → count, items: [{ name, count, maxDurability, durabilityUsed }], equipped: { hand, head, torso,
 *   legs, feet, offHand }, recent: memory.actions, wants: (item) → bool, building, food, health, time, thundering,
 *   nearBlocks: name → { distance } }
 */

// One is plenty: stations and gadgets you reuse forever (beds: one to sleep in).
const KEEP_ONE = /^(crafting_table|furnace|smoker|blast_furnace|stonecutter|loom|cartography_table|smithing_table|grindstone|anvil|enchanting_table|brewing_stand|fishing_rod|shears|flint_and_steel|bow|crossbow|shield|compass|clock|spyglass|brush|lead|saddle|\w+_bed)$/
const TOOL = /^(wooden|stone|golden|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe|sword)$/
const ARMOR = /^(leather|chainmail|golden|iron|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/
const TIER = { wooden: 0, leather: 0, golden: 1, stone: 1, chainmail: 2, turtle: 2, iron: 3, diamond: 4, netherite: 5 }
const SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }
const WOOD = /_(log|wood|stem|hyphae)$|^log$|^wood$/
const STATIONS = /^(crafting_table|furnace|smoker|blast_furnace)$/
// Plenty of a common block, unless a build, task or goal needs more.
const PLENTY = [[WOOD, 24, (inv) => sum(inv, /_log$|_stem$/) + sum(inv, /_planks$/) / 4], [/^(stone|cobblestone|cobbled_deepslate|deepslate)$/, 192, (inv) => sum(inv, /^(cobblestone|cobbled_deepslate|stone)$/)], [/^(dirt|grass_block|sand|gravel|netherrack)$/, 128, (inv, b) => inv[b === 'grass_block' ? 'dirt' : b] || 0]]
const VALUABLE = /diamond|netherite|emerald|totem|elytra|enchanted|golden_apple|beacon|nether_star|shulker|trident|heart_of_the_sea|ancient_debris/

const GUARD_CODES = new Set(['TRIED_TWICE', 'ALREADY_HAVE', 'ENOUGH', 'NOT_HUNGRY', 'NOT_NIGHT', 'ALREADY_DONE', 'ALREADY_HERE', 'VALUABLE', 'RULE', 'NOT_YOURS'])
const sum = (inv, re) => Object.entries(inv).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + (Number(c) || 0), 0)
const nice = (n) => String(n).replace(/_/g, ' ')
const norm = (s) => String(s || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_')
const sameArgs = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {})

/** What it wants to make or get, if the action is "make/get item X". */
function wantedItem (name, args) {
  if (name === 'craftItem' || name === 'obtainItem') return norm(args?.itemName)
  return null
}

/** Its best tool of a kind, with how worn it is (0..1 left). */
function bestOf (items, kind) {
  let best = null
  for (const it of items) {
    const m = it.name.match(TOOL)
    if (!m || m[2] !== kind) continue
    const left = it.maxDurability ? (it.maxDurability - (it.durabilityUsed || 0)) / it.maxDurability : 1
    const t = TIER[m[1]]
    if (!best || t > best.tier || (t === best.tier && left > best.left)) best = { name: it.name, tier: t, left }
  }
  return best
}

function review (decision, v) {
  const { name, args = {} } = decision.action || {}
  const inv = v.inv || {}
  const items = v.items || []
  const wants = v.wants || (() => false)

  // --- the same thing failing again and again -------------------------------------------------------------
  const recent = (v.recent || []).slice(-4)
  // Real failures only: its own "skipped" verdicts and interruptions don't count.
  const sameFails = recent.filter((a) => a.action === name && sameArgs(a.args, args) && !a.ok && !GUARD_CODES.has(a.code) && a.code !== 'ABORTED' && a.code !== 'INTERRUPTED')
  if (sameFails.length >= 2) {
    const last = sameFails.at(-1)
    return { code: 'TRIED_TWICE', message: `${name} with these arguments already failed twice just now (${last.code}: ${String(last.message || '').slice(0, 120)}). Doing it a third time won't help: change the approach (another place, another item, get what's missing first, or ask someone).` }
  }

  // --- making or getting something it already has ---------------------------------------------------------
  const item = wantedItem(name, args)
  if (item && !wants(item)) {
    const have = inv[item] || 0
    if (KEEP_ONE.test(item) && have >= 1) {
      return {
        code: 'ALREADY_HAVE',
        message: STATIONS.test(item)
          ? `You already carry ${have} ${nice(item)}${have > 1 ? 's' : ''}, and one is all anyone needs: it is reused forever. craftItem and smeltItem place it by themselves when a recipe needs it. Make the thing you wanted it for instead.`
          : `You already have ${have} ${nice(item)}${have > 1 ? 's' : ''}; one is enough. Do something with it, or move on to the next step.`
      }
    }
    const tool = item.match(TOOL)
    if (tool) {
      const best = bestOf(items, tool[2])
      if (best && best.tier >= TIER[tool[1]] && best.left > 0.15) {
        return { code: 'ALREADY_HAVE', message: `You already have a ${nice(best.name)} (${Math.round(best.left * 100)}% left)${best.tier > TIER[tool[1]] ? `, which is better than a ${nice(item)}` : ''}. Make a new ${tool[2]} only when it's nearly worn out, or a better one.` }
      }
    }
    const armor = item.match(ARMOR)
    if (armor) {
      const slot = SLOT[armor[2]]
      const worn = [v.equipped?.[slot], ...Object.keys(inv)].map((n) => String(n || '').match(ARMOR)).filter((m) => m && m[2] === armor[2])
      const better = worn.find((m) => TIER[m[1]] >= TIER[armor[1]])
      if (better) return { code: 'ALREADY_HAVE', message: `You already have ${nice(better[0])}, as good as or better than ${nice(item)}. Wear it (equipItem) and go for the pieces you are missing.` }
    }
    // The same thing made over and over: three times in the last five actions.
    const made = (v.recent || []).slice(-5).filter((a) => a.ok && a.action === name && norm(a.args?.itemName) === item).length
    if (made >= 3 && have >= 1) return { code: 'ENOUGH', message: `You've made ${nice(item)} ${made} times in a row and now have ${have}. That's enough for now: do something with them or go on to the next step.` }
  }

  // --- gathering what it already has plenty of ---------------------------------------------------------------
  if (name === 'mineBlock' || name === 'collectBlock') {
    const block = norm(args.blockType || args.block || args.itemName)
    for (const [re, max, count] of PLENTY) {
      if (!re.test(block) && !(re === WOOD && /^(log|logs|wood|tree|trees)$/.test(block))) continue
      const n = count(inv, block)
      if (n >= max && !v.building && !wants(block)) {
        return { code: 'ENOUGH', message: `You already carry ${Math.floor(n)} ${re === WOOD ? 'logs (counting planks)' : nice(block)}, far more than you need. Stop gathering it: use it, or go on to stone, ores, food, a shelter or exploring.` }
      }
    }
  }

  // --- the body: eating, sleeping, equipping -----------------------------------------------------------------
  if (name === 'eatFood') {
    const food = norm(args.itemName || args.foodName || '')
    if ((v.food ?? 0) >= 20 && !/golden_apple|chorus|potion|milk|suspicious_stew/.test(food)) {
      return { code: 'NOT_HUNGRY', message: "You're full (hunger 20/20): Minecraft won't let you eat now. Eat when the hunger bar drops." }
    }
  }
  if (name === 'sleepInBed') {
    const t = v.time ?? 6000
    const night = t >= 12542 && t <= 23460
    if (!night && !v.thundering) return { code: 'NOT_NIGHT', message: 'Beds only work at night or in a thunderstorm. Do something useful until dusk.' }
  }
  if (name === 'equipItem') {
    const want = norm(args.itemName)
    const dest = norm(args.destination || 'hand')
    const slot = { hand: 'hand', 'off-hand': 'offHand', off_hand: 'offHand', offhand: 'offHand', head: 'head', torso: 'torso', legs: 'legs', feet: 'feet' }[dest] || 'hand'
    if (want && v.equipped?.[slot] && norm(v.equipped[slot]).startsWith(want)) return { soft: true, code: 'ALREADY_DONE', message: `You're already holding/wearing ${nice(want)}.` }
  }

  // --- placing a second station right next to the first ---------------------------------------------------------
  if (name === 'placeBlock') {
    const b = norm(args.blockType || args.itemName || args.block)
    if (STATIONS.test(b) && v.nearBlocks?.[b] && v.nearBlocks[b].distance <= 6 && !v.building) {
      return { code: 'ALREADY_HERE', message: `There's already a ${nice(b)} ${Math.round(v.nearBlocks[b].distance)} blocks away. Use that one.` }
    }
  }

  // --- throwing away treasure -------------------------------------------------------------------------------------
  if (name === 'dropItems' && decision.source !== 'command') {
    const what = String(args.itemNames || args.itemName || '').toLowerCase().split(/[,\s]+/).map(norm).find((n) => VALUABLE.test(n))
    if (what) return { code: 'VALUABLE', message: `${nice(what)} is valuable. Nobody throws that away; keep it (or give it to someone with giveItem).` }
  }
  return null
}

/** A line for status.hints about what it carries that it should not make again. */
function carryHints (inv, items) {
  const out = []
  const stations = Object.keys(inv).filter((n) => STATIONS.test(n))
  if (stations.length) out.push(`You carry ${stations.map((n) => `${inv[n]} ${nice(n)}`).join(' and ')}: never craft another; craftItem/smeltItem place it when needed.`)
  const best = ['pickaxe', 'axe', 'sword', 'shovel'].map((k) => bestOf(items, k)).filter(Boolean)
  if (best.length) out.push(`Your best tools: ${best.map((b) => `${nice(b.name)}${b.left < 0.15 ? ' (almost broken: make a new one)' : ''}`).join(', ')}. Don't craft worse ones.`)
  return out
}

module.exports = { review, carryHints, KEEP_ONE, TOOL, ARMOR, TIER, bestOf }
