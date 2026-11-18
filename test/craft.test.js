'use strict'
// Run with: npm test   (or node test/craft.test.js)
// Covers: crafting that is checked against what the server really did. Mineflayer's bot.craft can "succeed" while the
// server makes nothing and keeps the ingredients in the grid (seen on Paper 26.1): the leftovers go back and it
// crafts by hand, reading the result the server shows.
const path = require('path')
const assert = require('assert')
const { craftVerified, returnGrid } = require(path.join(__dirname, '..', 'actions.js'))
const registry = require('minecraft-data')('1.21.4')

const ID = (n) => registry.itemsByName[n].id
const item = (name, count) => ({ type: ID(name), name, count })

/** A player inventory window that behaves like a vanilla server: clicks move items, the server fills the result slot. */
function fakeBot () {
  const slots = new Array(46).fill(null)
  const inv = {
    slots, inventoryStart: 9, inventoryEnd: 45, selectedItem: null, id: 0,
    items: () => slots.slice(9, 45).map((it, i) => it && { ...it, slot: i + 9 }).filter(Boolean)
  }
  const RECIPES = [{ grid: ['birch_log', null, null, null], out: ['birch_planks', 4] }, { grid: ['birch_planks', null, 'birch_planks', null], out: ['stick', 4] }]
  const recompute = () => {
    const g = [1, 2, 3, 4].map((s) => slots[s]?.name || null)
    const r = RECIPES.find((x) => x.grid.every((n, i) => n === g[i]))
    slots[0] = r ? item(r.out[0], r.out[1]) : null
  }
  const store = (it) => {
    for (let s = 9; s < 45 && it.count; s++) if (slots[s]?.name === it.name) { slots[s].count += it.count; it.count = 0 }
    for (let s = 9; s < 45 && it.count; s++) if (!slots[s]) { slots[s] = { ...it }; it.count = 0 }
  }
  const craftOnce = () => { for (let s = 1; s <= 4; s++) if (slots[s] && --slots[s].count === 0) slots[s] = null }
  const bot = {
    registry,
    inventory: inv,
    clicks: 0,
    async clickWindow (slot, button, mode) {
      bot.clicks++
      if (mode === 1) { // shift-click: straight into the inventory
        if (slot === 0 && slots[0]) { const out = slots[0]; craftOnce(); store({ ...out }) } else if (slots[slot]) { const it = slots[slot]; slots[slot] = null; store({ ...it }) }
      } else if (slot === 0) { // take the result
        if (slots[0] && (!inv.selectedItem || inv.selectedItem.name === slots[0].name)) {
          const out = slots[0]; craftOnce()
          inv.selectedItem = inv.selectedItem ? { ...inv.selectedItem, count: inv.selectedItem.count + out.count } : { ...out }
        }
      } else if (button === 1 && inv.selectedItem) { // right click: one item
        if (!slots[slot] || slots[slot].name === inv.selectedItem.name) {
          slots[slot] = slots[slot] ? { ...slots[slot], count: slots[slot].count + 1 } : { ...inv.selectedItem, count: 1 }
          if (--inv.selectedItem.count === 0) inv.selectedItem = null
        }
      } else { // left click: pick up / put down / merge / swap
        const here = slots[slot]
        if (!inv.selectedItem) { inv.selectedItem = here; slots[slot] = null } else if (!here) { slots[slot] = inv.selectedItem; inv.selectedItem = null } else if (here.name === inv.selectedItem.name) { here.count += inv.selectedItem.count; inv.selectedItem = null } else { slots[slot] = inv.selectedItem; inv.selectedItem = here }
      }
      recompute()
    },
    async putSelectedItemRange () { if (inv.selectedItem) { store(inv.selectedItem); inv.selectedItem = null } },
    closeWindow () { for (let s = 1; s <= 4; s++) if (slots[s]) { store(slots[s]); slots[s] = null } recompute() }
  }
  return bot
}
const count = (bot, n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0)
const gridEmpty = (bot) => [1, 2, 3, 4].every((s) => !bot.inventory.slots[s])
const planks = { result: { id: ID('birch_planks'), count: 4 }, inShape: [[{ id: ID('birch_log') }]] }

;(async () => {
  // 1. bot.craft that fills the grid but never gets a result from the server: leftovers back, then crafted by hand.
  {
    const bot = fakeBot()
    bot.inventory.slots[20] = item('birch_log', 4)
    bot.craft = async () => { await bot.clickWindow(20, 0, 0); await bot.clickWindow(1, 1, 0); await bot.putSelectedItemRange() } // like the failed crafts
    const made = await craftVerified({ bot, log: { debug () {} } }, planks, 1, null)
    assert.equal(made, 4, 'it got its planks after all')
    assert.equal(count(bot, 'birch_planks'), 4)
    assert.equal(count(bot, 'birch_log'), 3, 'one log used, not lost')
    assert.ok(gridEmpty(bot), 'nothing left in the crafting grid')
  }
  // 2. A craft that works the normal way: no second craft by hand.
  {
    const bot = fakeBot()
    bot.inventory.slots[20] = item('birch_log', 4)
    bot.craft = async () => { await bot.clickWindow(20, 0, 0); await bot.clickWindow(1, 1, 0); await bot.putSelectedItemRange(); await bot.clickWindow(0, 0, 0); await bot.putSelectedItemRange() }
    const made = await craftVerified({ bot, log: { debug () {} } }, planks, 1, null)
    assert.equal(made, 4)
    assert.equal(count(bot, 'birch_log'), 3, 'crafted once, not twice')
  }
  // 3. Items stuck in the grid from before (the screenshot: 4 planks, 4 planks, 3 logs) go back into the inventory.
  {
    const bot = fakeBot()
    bot.inventory.slots[1] = item('birch_planks', 4); bot.inventory.slots[3] = item('birch_planks', 4); bot.inventory.slots[4] = item('birch_log', 3)
    await returnGrid({ bot, log: { debug () {} } })
    assert.ok(gridEmpty(bot))
    assert.equal(count(bot, 'birch_planks'), 8)
    assert.equal(count(bot, 'birch_log'), 3)
  }
  console.log('All craft checks passed')
})().catch((err) => { console.error(err); process.exit(1) })
