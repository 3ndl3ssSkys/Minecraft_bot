'use strict'

/**
 * strategy.js — what an experienced player would do next, worked out in code.
 *
 * A small model is good at choosing among a few sensible options and bad at inventing a good plan from scratch. So each
 * decision gets a short menu of the best concrete options, each a ready action:
 *   1. urgent needs: dusk with no bed or shelter, hunger, a full inventory, darkness underground, a fight that's
 *      worth it or one to get away from;
 *   2. the next steps of survival progression, like a player's mental checklist: tools, food, a bed, iron gear,
 *      torches, a shield, armor, a base, diamonds. Gated by what this player knows (knowledge tier), so a beginner
 *      doesn't "know" about shields yet, and only what isn't done yet;
 *   3. carrying on with its current goal.
 * The model answers with the number of one ("choose"), or does something else. When its own answer is unusable
 * (an unknown action, standing around for nothing), the best option is taken.
 *
 * options(view) is pure (unit-tested); Agent.strategyView() builds the view from what the bot perceives.
 */

const sum = (inv, re) => Object.entries(inv).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + (Number(c) || 0), 0)
const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
const tierOf = (inv, kind) => Math.max(-1, ...Object.keys(inv).filter((n) => n.endsWith(`_${kind}`) && inv[n] > 0).map((n) => TIERS.indexOf(n.split('_')[0])))
const FOOD = /^(cooked_\w+|bread|baked_potato|golden_carrot|apple|carrot|melon_slice|sweet_berries|pumpkin_pie|cookie|beetroot|mushroom_stew|rabbit_stew|beetroot_soup|steak|beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|dried_kelp)$/
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/

/**
 * @param {object} v
 *   inv {name: count}, equipped {head, torso, legs, feet, offHand}, health, food, time (ticks), dim, layout (text),
 *   tier (knowledge 0..7), freeSlots, bedKnown, homeKnown, chestKnown, threat {verdict, list}, task (bool),
 *   tools (Set of available action names), goalItem? ({ item, count, anyWood } from the current step)
 * @returns {Array<{ id, why, action: { name, args }, urgent?: boolean }>} best first, at most 5
 */
function options (v) {
  const inv = v.inv || {}
  const has = (n) => (inv[n] || 0) > 0
  const can = (name) => !v.tools || v.tools.has(name)
  const out = []
  const add = (id, why, name, args = {}, urgent = false) => { if (can(name) && !out.some((o) => o.id === id)) out.push({ id, why, action: { name, args }, urgent }) }
  const t = v.time ?? 6000
  const overworld = !v.dim || v.dim === 'overworld'
  const outdoors = /^outdoors/.test(v.layout || '')
  const underground = /underground/.test(v.layout || '')
  const dark = /dark/.test(v.layout || '')
  const pick = tierOf(inv, 'pickaxe')
  const sword = Math.max(tierOf(inv, 'sword'), tierOf(inv, 'axe') - 1)
  const foodCount = sum(inv, FOOD) - sum(inv, /^(rotten_flesh|spider_eye|pufferfish|poisonous_potato)$/)
  const cooked = foodCount - sum(inv, RAW)
  const bedHeld = sum(inv, /_bed$/) > 0
  const worn = (slot, re) => re.test(v.equipped?.[slot] || '')

  // ---- 1. Urgent ----------------------------------------------------------------------------------------------
  const th = v.threat
  if (th?.verdict === 'flee') {
    const worst = (th.list || []).filter((x) => x.hostile).sort((a, b) => b.danger - a.danger)[0]
    if (worst) add('flee', `${worst.name} is more than you can take right now`, 'retreat', { entityId: worst.id, distance: 16 }, true)
  } else {
    const foe = (th?.list || []).find((x) => x.hostile && x.verdict === 'fight' && x.distance < 12)
    if (foe) add('fight', `a ${foe.name} you can take is coming for you`, 'attackTarget', { entityId: foe.id, maxSeconds: 20 }, true)
  }
  if ((v.food ?? 20) <= 14 && foodCount > 0) add('eat', 'you are getting hungry', 'eatFood', {}, true)
  if ((v.food ?? 20) <= 16 && cooked <= 0 && sum(inv, RAW) > 0 && (v.tier ?? 0) >= 1) add('cook', 'cook the raw food you carry', 'obtainItem', { itemName: rawToCooked(inv), count: Math.min(8, sum(inv, RAW)) }, true)
  else if ((v.food ?? 20) <= 16 && foodCount <= 0) add('food', 'you have no food', 'obtainItem', { itemName: 'food', count: 4 }, true)
  if (overworld) {
    const dusk = t > 11500 && t < 13000
    const night = t >= 13000 && t < 23000
    if ((dusk || night) && outdoors) {
      if (bedHeld || v.bedKnown) add('sleep', night ? "it's night: sleep it off" : 'night is coming: get to a bed', 'sleepInBed', {}, night)
      else if (night || pick < 1) add('shelter', 'night is here and you have no bed: dig in till morning', 'shelter', {}, night)
    }
  }
  if (underground && dark && has('torch')) add('torch', "it's dark here: monsters spawn in the dark", 'placeTorch', {}, false)
  if ((v.freeSlots ?? 36) <= 2) {
    if (v.chestKnown) add('store', 'your inventory is almost full', 'storeItems', { itemNames: 'cobblestone, dirt, gravel, andesite, diorite, granite, cobbled_deepslate, tuff' }, true)
    else add('drop', 'your inventory is almost full', 'dropItems', { itemNames: 'junk' }, true)
  }

  // ---- 2. Progression: the next things a player of this knowledge gets ---------------------------------------
  const tier = v.tier ?? 0
  const steps = [
    [0, pick < 0, 'wooden_pickaxe', 'a wooden pickaxe: the first tool'],
    [0, pick < 1, 'stone_pickaxe', 'a stone pickaxe (mines iron)'],
    [0, sword < 1, 'stone_sword', 'a sword to defend yourself'],
    [0, foodCount < 6 && (v.food ?? 20) < 20, 'food', 'a stack of food before going far', 6],
    [1, !bedHeld && !v.bedKnown, 'bed', 'a bed: skip the nights and set your spawn'],
    [1, pick < 2, 'iron_pickaxe', 'an iron pickaxe (mines diamonds, gold, redstone)'],
    [1, sum(inv, /^torch$/) < 16 && pick >= 1, 'torch', 'torches for caves and the night', 16],
    [1, sword < 2, 'iron_sword', 'an iron sword'],
    [2, !has('shield') && !worn('offHand', /shield/), 'shield', 'a shield (blocks arrows and hits)'],
    [1, !worn('torso', /chestplate/) && !has('iron_chestplate') && !has('diamond_chestplate'), 'iron_chestplate', 'iron chestplate (the most armor per ingot)'],
    [1, !worn('legs', /leggings/) && !has('iron_leggings') && !has('diamond_leggings'), 'iron_leggings', 'iron leggings'],
    [1, !worn('head', /helmet/) && !has('iron_helmet') && !has('diamond_helmet'), 'iron_helmet', 'iron helmet'],
    [1, !worn('feet', /boots/) && !has('iron_boots') && !has('diamond_boots'), 'iron_boots', 'iron boots'],
    [2, !has('bucket') && !has('water_bucket'), 'bucket', 'a bucket (water saves you from falls and lava)'],
    [2, pick >= 2 && sum(inv, /^diamond$/) < 3 && pick < 4, 'diamonds', 'diamonds: deep down with the iron pickaxe'],
    [2, pick >= 2 && pick < 4 && sum(inv, /^diamond$/) >= 3, 'diamond_pickaxe', 'a diamond pickaxe']
  ]
  let added = 0
  for (const [need, missing, item, why, count] of steps) {
    if (added >= 2 || tier < need || !missing) continue
    if (item === 'diamonds') add('diamonds', why, 'stripMine', { ore: 'diamond', minutes: 4 })
    else add(item, why, 'obtainItem', { itemName: item, count: count || 1 })
    added++
  }
  // A base once the basics are covered.
  if (tier >= 1 && !v.homeKnown && pick >= 1 && sword >= 1) add('base', 'a home base to come back to', 'planBuilding', { purpose: 'house', concept: 'small cozy wooden house', size: 'small' })

  // ---- 3. Its current goal, if the step names something to get ---------------------------------------------------
  if (v.goalItem?.item) add('goal', `your current step: ${v.goalItem.count} ${v.goalItem.item.replace(/_/g, ' ')}`, 'obtainItem', { itemName: v.goalItem.item, count: v.goalItem.count })

  // Urgent first (in order found), then the rest in order; never more than 5.
  return [...out.filter((o) => o.urgent), ...out.filter((o) => !o.urgent)].slice(0, 5)
}

function rawToCooked (inv) {
  const raw = Object.keys(inv).find((n) => RAW.test(n) && inv[n] > 0) || 'beef'
  return raw === 'potato' ? 'baked_potato' : `cooked_${raw}`
}

/** The menu for the prompt: one line each, numbered. */
function describe (opts) {
  return opts.map((o, i) => `${i + 1}. ${o.action.name}(${JSON.stringify(o.action.args)}) — ${o.why}${o.urgent ? ' [urgent]' : ''}`)
}

module.exports = { options, describe }
