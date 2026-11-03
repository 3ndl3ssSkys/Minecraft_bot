'use strict'
// The early-game ladder, the "any wood" crafting fix and log aliases, on real recipe data.
const assert = require('assert')
const { nextBasicStep, Autopilot } = require('../basics')
const { craftIntermediates, describeMissing, resolveBlockIds } = require('../actions')
const mcData = require('minecraft-data')('1.21.4')
const { Recipe } = require('prismarine-recipe')('1.21.4')

console.log('== ladder ==')
const step = (inventory, nearbyBlocks = {}, ctx) => nextBasicStep({ inventory, nearbyBlocks }, ctx)
assert.deepEqual(step({}).name, 'mineBlock'); assert.equal(step({}).args.blockType, 'log')
assert.equal(step({ cherry_log: 2 }).name, 'mineBlock', '2 logs (8 planks) are not yet enough for table + pickaxe + sticks (9)')
assert.equal(step({ cherry_log: 2 }).args.blockType, 'log', 'asks for logs of any kind')
assert.equal(step({ cherry_log: 3 }).name, 'craftItem'); assert.equal(step({ cherry_log: 3 }).args.itemName, 'wooden_pickaxe')
assert.equal(step({ oak_planks: 9 }).name, 'craftItem')
assert.equal(step({ oak_planks: 5 }, { crafting_table: { distance: 5 } }).name, 'craftItem', 'a table nearby saves 4 planks')
assert.equal(step({ wooden_pickaxe: 1 }, { stone: { distance: 4 } }).args.blockType, 'stone')
assert.equal(step({ wooden_pickaxe: 1 }, {}).name, 'explore', 'no stone in sight: look around instead of searching in place')
assert.equal(step({ wooden_pickaxe: 1, cobblestone: 3, stick: 2 }).args.itemName, 'stone_pickaxe')
assert.equal(step({ wooden_pickaxe: 1, cobblestone: 3 }).args.blockType, 'log', 'needs a bit of wood for the handle')
assert.equal(step({ stone_pickaxe: 1 }), null, 'after the stone pickaxe the model takes over')
assert.equal(step({ iron_pickaxe: 1 }), null)
assert.equal(step({}, {}, { lastFail: { name: 'mineBlock', at: Date.now() }, now: Date.now() }).name, 'explore', 'a failed search moves on')
const ap = new Autopilot()
for (let i = 0; i < 5; i++) ap.onResult({ source: 'auto', action: { name: 'mineBlock' } }, { ok: false })
assert.equal(ap.step({ inventory: {}, nearbyBlocks: {} }), null, 'five failures hand control back to the model for a while')
console.log('ok')

const items = mcData.itemsByName
;(async () => {
console.log('== any wood works for crafting (real recipes, cherry logs only) ==')
function fakeBot (inv) {
  const bot = {
    registry: mcData,
    inv: { ...inv },
    recipesAll: (id) => Recipe.find(id, null),
    recipesFor (id) {
      return Recipe.find(id, null).filter((r) => !r.requiresTable && r.delta.filter((d) => d.count < 0).every((d) => (bot.inv[mcData.items[d.id].name] || 0) >= -d.count))
    },
    async craft (recipe, times) {
      for (let i = 0; i < times; i++) for (const d of recipe.delta) { const n = mcData.items[d.id].name; bot.inv[n] = (bot.inv[n] || 0) + d.count }
    }
  }
  return bot
}
const ctxOf = (inv) => { const bot = fakeBot(inv); bot.inventory = { items: () => Object.entries(bot.inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: items[name].id })) }; return { bot } }
{
  const ctx = ctxOf({ cherry_log: 3 })
  const crafted = ctx.bot.recipesAll(items.crafting_table.id)
  assert.equal(await craftIntermediates(ctx, items.crafting_table, 1), true)
  assert.ok((ctx.bot.inv.cherry_planks || 0) >= 4, 'made cherry planks from cherry logs')
  assert.ok(ctx.bot.recipesFor(items.crafting_table.id).length > 0, 'a crafting table is craftable now')
  assert.ok(crafted.length > 1, 'there are several wood variants of the recipe')
  const c2 = ctxOf({ oak_log: 3 })
  await craftIntermediates(c2, items.wooden_pickaxe, 1)
  assert.ok((c2.bot.inv.oak_planks || 0) >= 3 && (c2.bot.inv.stick || 0) >= 2, 'planks and sticks for a pickaxe')
  const c3 = ctxOf({ oak_planks: 2, oak_log: 1, spruce_log: 9 })
  await craftIntermediates(c3, items.crafting_table, 1)
  assert.ok((c3.bot.inv.oak_planks || 0) >= 4, 'keeps the plank type it already holds when that log is available')
  const c4 = ctxOf({ oak_planks: 2, spruce_log: 5 })
  await craftIntermediates(c4, items.crafting_table, 1)
  assert.ok(c4.bot.recipesFor(items.crafting_table.id).length > 0, 'with a different log it makes a full set of the other wood')
  const msg = describeMissing(ctxOf({ cherry_planks: 2 }).bot, items.crafting_table, 'crafting_table')
  console.log(' ', msg)
  assert.ok(/Missing: \{"cherry_planks":2\}/.test(msg), 'names the closest recipe and what is actually missing')
}
console.log('ok')

console.log('== wood aliases ==')
const reg = { registry: mcData }
reg.registry.blocksArray = mcData.blocksArray
const logIds = resolveBlockIds({ registry: mcData }, 'wood')
assert.ok(logIds.length >= 9 && logIds.includes(mcData.blocksByName.cherry_log.id) && logIds.includes(mcData.blocksByName.oak_log.id) && !logIds.includes(mcData.blocksByName.stripped_oak_log.id))
assert.equal(resolveBlockIds({ registry: mcData }, 'logs').length, logIds.length)
assert.deepEqual(resolveBlockIds({ registry: mcData }, 'oak_log'), [mcData.blocksByName.oak_log.id])
console.log('ok')
console.log('\nALL BASICS CHECKS PASSED')

})().catch((e) => { console.error(e); process.exit(1) })
