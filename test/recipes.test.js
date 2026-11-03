'use strict'
// Recipe knowledge by level, experimenting in the crafting grid (simulated window on real recipe data), and "get me X".
const assert = require('assert')
const { RecipeBook, matchGrid, realLayouts, chooseArrangement, tryLayout, key } = require('../recipes')
const { nextAcquireStep } = require('../acquire')
const { Intelligence } = require('../intelligence')
const mc = require('minecraft-data')('1.21.4')

const book = (level) => {
  const intel = new Intelligence(() => ({ level, learn: true, learnRate: 1 }))
  return { intel, book: new RecipeBook({ intelligence: intel, learning: { markDirty () {} }, memory: { addEvent () {} } }, {}) }
}

console.log('== what each level knows ==')
const kn = (lv, n) => book(lv).book.knows(n)
assert.ok(!kn('beginning', 'oak_planks') && !kn('beginning', 'stick') && !kn('beginning', 'crafting_table'), 'a beginner knows nothing')
assert.ok(kn('simple', 'oak_planks') && kn('simple', 'stick') && kn('simple', 'crafting_table') && !kn('simple', 'wooden_pickaxe'))
assert.ok(kn('mediocre', 'wooden_pickaxe') && kn('mediocre', 'stone_pickaxe') && kn('mediocre', 'furnace') && !kn('mediocre', 'iron_pickaxe') && !kn('mediocre', 'bucket') === false)
assert.ok(!kn('mediocre', 'diamond_sword') && !kn('mediocre', 'piston'))
for (const lv of ['complicated', 'advanced', 'hardcore', 'master', 'impossible']) assert.ok(kn(lv, 'piston') && kn(lv, 'diamond_sword'), `${lv} knows every recipe`)
const b0 = book('beginning')
assert.equal(b0.book.firstUnknown('wooden_pickaxe', { oak_log: 3 }, mc, (id) => require('prismarine-recipe')('1.21.4').Recipe.find(id, null)), 'oak_planks', 'planks come first for a beginner')
b0.book.learn('oak_planks', { oak_log: 1 }, 'test')
assert.ok(b0.book.knows('oak_planks') && b0.intel.level('knowledge') > 0, 'learning a recipe is saved and gives knowledge xp')
const saved = JSON.parse(JSON.stringify(b0.book.toJSON()))
assert.ok(new RecipeBook({ intelligence: b0.intel }, saved).knows('oak_planks'), 'and it is still known next session')
const asker = book('beginning').book
assert.ok(asker.canAsk('stick')); asker.noteAsked('stick'); assert.ok(!asker.canAsk('stick') && asker.listening.item === 'stick', 'asks once, then listens for an answer')

console.log('== the crafting grid (real recipe data) ==')
assert.deepEqual(matchGrid(mc, ['oak_log', null, null, null], 2, 2), { name: 'oak_planks', count: 4 })
assert.deepEqual(matchGrid(mc, [null, null, null, 'oak_log'], 2, 2), { name: 'oak_planks', count: 4 }, 'position does not matter for a single log')
assert.equal(matchGrid(mc, ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'], 2, 2).name, 'crafting_table')
assert.equal(matchGrid(mc, ['oak_planks', null, 'oak_planks', null], 2, 2).name, 'stick')
assert.equal(matchGrid(mc, ['oak_planks', 'stick', null, null], 2, 2), null, 'nonsense gives nothing')
assert.equal(matchGrid(mc, ['oak_planks', 'oak_planks', 'oak_planks', null, 'stick', null, null, 'stick', null], 3, 3).name, 'wooden_pickaxe')

console.log('== trying it through window clicks ==')
// A fake window that behaves like the game: cursor, left/right/shift clicks, and a result slot filled by the recipe.
function fakeBot (invItems) {
  const slots = new Array(46).fill(null)
  const invStart = 9; const invEnd = 45
  invItems.forEach(([name, count], i) => { slots[invStart + i] = { name, count } })
  const win = { slots, selectedItem: null, inventoryStart: invStart, inventoryEnd: invEnd }
  const recompute = () => {
    const grid = [1, 2, 3, 4].map((s) => (slots[s] ? slots[s].name : null))
    slots[0] = (() => { const m = matchGrid(mc, grid, 2, 2); return m ? { name: m.name, count: m.count } : null })()
  }
  const bot = {
    async clickWindow (slot, button, mode) {
      if (mode === 1) { // shift-click: move to the first free inventory slot
        const it = slots[slot]; if (!it) return
        slots[slot] = null
        for (let s = invStart; s < invEnd; s++) { if (slots[s] && slots[s].name === it.name) { slots[s].count += it.count; recompute(); return } }
        const free = slots.findIndex((x, i) => i >= invStart && i < invEnd && !x); slots[free] = it; recompute(); return
      }
      if (slot === 0) { // take the result: consumes one of each ingredient
        if (!slots[0] || win.selectedItem) return
        win.selectedItem = { ...slots[0] }
        for (let s = 1; s <= 4; s++) if (slots[s]) { slots[s].count--; if (slots[s].count <= 0) slots[s] = null }
        recompute(); return
      }
      if (button === 0) { const t = slots[slot]; slots[slot] = win.selectedItem; win.selectedItem = t } else if (win.selectedItem) { // right-click: put one
        if (!slots[slot]) slots[slot] = { name: win.selectedItem.name, count: 0 }
        if (slots[slot].name === win.selectedItem.name) { slots[slot].count++; win.selectedItem.count--; if (win.selectedItem.count <= 0) win.selectedItem = null }
      }
      recompute()
    },
    async putSelectedItemRange (start, end) {
      const it = win.selectedItem; if (!it) return
      for (let s = start; s < end; s++) { if (slots[s] && slots[s].name === it.name) { slots[s].count += it.count; win.selectedItem = null; return } }
      slots[slots.findIndex((x, i) => i >= start && i < end && !x)] = it; win.selectedItem = null
    }
  }
  return { bot, win, slots }
}
const count = (slots, name) => slots.filter(Boolean).filter((x) => x.name === name).reduce((a, x) => a + x.count, 0)
;(async () => {
  {
    const { bot, win, slots } = fakeBot([['oak_log', 2], ['stick', 3]])
    const w = { window: win, w: 2, h: 2, first: 1, result: 0, invStart: 9, invEnd: 45 }
    const out = await tryLayout(bot, w, ['oak_log', null, null, null], { wait: 0 })
    assert.deepEqual(out, { name: 'oak_planks', count: 4 })
    assert.equal(count(slots, 'oak_log'), 1, 'one log was used'); assert.equal(count(slots, 'oak_planks'), 4, 'the planks arrived in the inventory')
    assert.ok([1, 2, 3, 4].every((s) => !slots[s]) && !win.selectedItem, 'grid and cursor are empty afterwards')
    const none = await tryLayout(bot, w, ['stick', 'oak_log', null, null], { wait: 0 })
    assert.equal(none, null)
    assert.equal(count(slots, 'stick'), 3); assert.equal(count(slots, 'oak_log'), 1); assert.ok([1, 2, 3, 4].every((s) => !slots[s]), 'a failed try puts everything back')
  }
  console.log('ok')

  console.log('== discovering recipes ==')
  const discover = async (level, inv, target, maxTries) => {
    const { bot, win, slots } = fakeBot(inv)
    const w = { window: win, w: 2, h: 2, first: 1, result: 0, invStart: 9, invEnd: 45 }
    const tried = new Set()
    for (let i = 1; i <= maxTries; i++) {
      const items = {}; slots.slice(9, 45).filter(Boolean).forEach((x) => { items[x.name] = (items[x.name] || 0) + x.count })
      const cells = chooseArrangement({ registry: mc, inv: items, w: 2, h: 2, target, level, tried })
      if (!cells) return -1
      tried.add(key(cells))
      const out = await tryLayout(bot, w, cells, { wait: 0 })
      if (out && (!target || out.name === target)) return i
    }
    return -1
  }
  const trials = async (level, n, inv, target) => { const r = []; for (let i = 0; i < n; i++) r.push(await discover(level, inv, target, 80)); return r }
  const avg = (a) => a.filter((x) => x > 0).reduce((s, x) => s + x, 0) / Math.max(1, a.filter((x) => x > 0).length)
  const rate = (a) => a.filter((x) => x > 0).length / a.length
  const inv = [['oak_log', 8], ['oak_planks', 8], ['stick', 8]]
  const beginner = await trials(0, 30, inv, 'crafting_table')
  const skilled = await trials(2, 30, inv, 'crafting_table')
  console.log(`  crafting table from random tries: beginner found it ${Math.round(rate(beginner) * 100)}% of runs (avg ${avg(beginner).toFixed(1)} tries); mediocre ${Math.round(rate(skilled) * 100)}% (avg ${avg(skilled).toFixed(1)} tries)`)
  assert.ok(rate(beginner) > 0.5, 'even by guessing, a beginner finds the simple things')
  assert.ok(avg(skilled) < avg(beginner), 'educated guesses find it faster')
  const told = chooseArrangement({ registry: mc, inv: { oak_planks: 8, stick: 8 }, w: 3, h: 3, target: 'wooden_pickaxe', level: 0, tried: new Set(), told: ['oak_planks', 'stick'] })
  assert.equal(matchGrid(mc, told, 3, 3).name, 'wooden_pickaxe', 'told "planks and sticks" for a pickaxe: arranges the pickaxe, not the axe')
  assert.ok(realLayouts(mc, 'crafting_table', { oak_planks: 4 }, 2, 2).length > 0 && realLayouts(mc, 'wooden_pickaxe', { oak_planks: 4, stick: 4 }, 2, 2).length === 0, 'a pickaxe does not fit the 2x2 grid')

  console.log('== "get me X": the exact item ==')
  const reg = mc; reg.blocksArray = mc.blocksArray
  const near = (...n) => Object.fromEntries(n.map((x) => [x, { distance: 5 }]))
  const step = (item, count, inv = {}, nb = {}, knows = () => true) => nextAcquireStep({ item, count, inv, near: nb, registry: reg, knows })
  let s1 = step('cherry_log', 5)
  assert.equal(s1.name, 'mineBlock'); assert.equal(s1.args.blockType, 'cherry_log'); assert.equal(s1.args.exact, true, 'cherry logs means cherry logs')
  assert.equal(step('oak_log', 3, { oak_log: 3 }), null, 'already has them')
  s1 = step('cobblestone', 8, {}, near('stone'))
  assert.equal(s1.name, 'mineBlock', 'cobblestone needs a pickaxe first: gets wood for one'); assert.equal(s1.args.blockType, 'log')
  s1 = step('cobblestone', 8, { wooden_pickaxe: 1 }, near('stone'))
  assert.equal(s1.name, 'mineBlock'); assert.equal(s1.args.blockType, 'stone')
  s1 = step('stone_pickaxe', 1, { wooden_pickaxe: 1, stick: 2 }, near('stone'))
  assert.equal(s1.args.blockType, 'stone', 'a stone pickaxe starts with cobblestone')
  s1 = step('stone_pickaxe', 1, { cobblestone: 3, stick: 2 })
  assert.deepEqual([s1.name, s1.args.itemName], ['craftItem', 'stone_pickaxe'])
  s1 = step('oak_planks', 8, { oak_log: 2 })
  assert.deepEqual([s1.name, s1.args.itemName], ['craftItem', 'oak_planks'])
  assert.deepEqual(step('wooden_pickaxe', 1, { oak_planks: 5 }, {}, (n) => n !== 'wooden_pickaxe'), { unknown: 'wooden_pickaxe' }, 'an unknown recipe is reported, not guessed')
  s1 = step('coal', 4, {}, near('coal_ore'))
  assert.equal(s1.name, 'mineBlock', 'coal needs a pickaxe, so wood first')
  s1 = step('coal', 4, { wooden_pickaxe: 1 }, near('coal_ore'))
  assert.equal(s1.args.blockType, 'coal_ore')
  assert.equal(step('iron_ingot', 3, { wooden_pickaxe: 1, stone_pickaxe: 1 }), null, 'smelting is left to the model')
  console.log('ok')
  console.log('\nALL RECIPE CHECKS PASSED')
})().catch((e) => { console.error(e); process.exit(1) })
