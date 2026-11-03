'use strict'

/**
 * recipes.js — which crafting recipes the bot knows, and how it finds out the ones it doesn't.
 *
 * Knowledge follows the `knowledge` skill level:
 *   beginning   nothing: it has to discover everything (planks, sticks, a table, tools...)
 *   simple      planks, sticks, a crafting table
 *   mediocre    + wooden and stone tools, furnace, torch, chest, door, ladder, fence, boat, bowl
 *   complicated and up: every recipe
 * Whatever else it learns is saved: by EXPERIMENTING (putting items into the 2x2 inventory grid or the 3x3 table
 * grid and seeing what comes out), or by ASKING for help (a player tells it, and it checks by trying).
 * Beginners experiment mostly at random; better players make educated guesses.
 */

const { Vec3 } = require('vec3') // eslint-disable-line no-unused-vars

const WOODS = 'oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped'
const SIMPLE = new RegExp(`^((${WOODS})_planks|stick|crafting_table)$`)
const MEDIOCRE = new RegExp(`^(${SIMPLE.source.slice(1, -1)}|(wooden|stone)_(pickaxe|axe|shovel|sword|hoe)|furnace|torch|chest|barrel|ladder|bowl|(${WOODS})_(door|fence|fence_gate|boat|slab|stairs|trapdoor|sign|button|pressure_plate)|cobblestone_(slab|stairs|wall)|white_bed|bucket)$`)

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
const key = (cells) => cells.map((c) => c || '-').join(',')

class RecipeBook {
  constructor (agent, data = {}) {
    this.agent = agent
    this.learned = data.learned && typeof data.learned === 'object' ? data.learned : {} // item -> { ingredients, how, at }
    this.asked = data.asked && typeof data.asked === 'object' ? data.asked : {} // item -> when it last asked
    this.awaiting = null // { item, at }: asked in chat, listening for an answer
  }

  get level () { return this.agent.intelligence.level('knowledge') }
  /** 'none' | 'basic' | 'tools' | 'all' */
  get policy () { const l = this.level; return l >= 3 ? 'all' : l >= 2 ? 'tools' : l >= 1 ? 'basic' : 'none' }
  get knowsEverything () { return this.policy === 'all' }

  knows (item) {
    if (this.knowsEverything) return true
    if (this.learned[item]) return true
    if (this.policy === 'tools') return MEDIOCRE.test(item)
    if (this.policy === 'basic') return SIMPLE.test(item)
    return false
  }

  learn (item, ingredients, how = 'experiment') {
    const fresh = !this.knows(item)
    this.learned[item] = { ingredients, how, at: Date.now() }
    if (fresh) this.agent.intelligence.addXp('knowledge', 0.8)
    this.agent.learning?.markDirty?.()
    this.agent.memory?.addEvent?.('learned', `You worked out how to make ${item.replace(/_/g, ' ')} (${how}).`)
    return fresh
  }

  describe () {
    const n = Object.keys(this.learned).length
    return { none: 'you have to discover every recipe yourself', basic: 'you know planks, sticks and a crafting table', tools: 'you know wooden/stone tools and common blocks', all: 'you know every recipe' }[this.policy] + (n && this.policy !== 'all' ? ` (+${n} you figured out)` : '')
  }

  /** Items that have to be crafted on the way to `item` that it does not know yet (first one first). */
  firstUnknown (item, inv, registry, recipesAll) {
    const chain = [item]
    const def = registry.itemsByName[item]
    if (def) {
      const rs = recipesAll(def.id)
      if (rs.length) {
        let planks = Infinity; let sticks = Infinity; let table = true
        for (const r of rs) {
          let p = 0; let s = 0
          for (const d of r.delta || []) if (d.count < 0) { const n = registry.items[d.id]?.name; if (/_planks$/.test(n)) p++; else if (n === 'stick') s++ }
          planks = Math.min(planks, p); sticks = Math.min(sticks, s); table = table && r.requiresTable
        }
        const heldPlanks = Object.entries(inv).filter(([n]) => /_planks$/.test(n)).reduce((a, [, c]) => a + c, 0)
        if (planks > 0 && heldPlanks === 0) chain.push('oak_planks')
        if (sticks > 0 && !(inv.stick > 0)) chain.push('stick')
        if (table && !inv.crafting_table) chain.push('crafting_table')
      }
    }
    // Deepest ingredient first: planks before sticks before table before the item.
    const order = ['oak_planks', 'stick', 'crafting_table', item]
    for (const n of order) if (chain.includes(n) && !(n === 'oak_planks' ? this.knowsAnyPlanks() : this.knows(n))) return n
    return null
  }

  knowsAnyPlanks () { return this.knowsEverything || this.policy !== 'none' || Object.keys(this.learned).some((n) => /_planks$/.test(n)) }

  /** Ask in chat at most every few minutes per item. */
  canAsk (item, now = Date.now()) { return !(this.asked[item] && now - this.asked[item] < 5 * 60000) }
  noteAsked (item, now = Date.now()) { this.asked[item] = now; this.awaiting = { item, at: now } }
  get listening () { return this.awaiting && Date.now() - this.awaiting.at < 3 * 60000 ? this.awaiting : null }

  toJSON () { return { learned: this.learned, asked: this.asked } }
}

/** What the crafting grid produces for a layout of item names (row-major, null = empty). `registry` = minecraft-data. */
function matchGrid (registry, cells, w, h) {
  const id = (n) => registry.itemsByName[n]?.id
  const ids = cells.map((n) => (n ? id(n) : null))
  const rows = []
  for (let y = 0; y < h; y++) rows.push(ids.slice(y * w, y * w + w))
  const used = ids.filter((x) => x != null)
  if (!used.length) return null
  for (const list of Object.values(registry.recipes)) {
    for (const r of list) {
      if (r.ingredients) { // shapeless
        const need = [...r.ingredients].sort()
        if (need.length === used.length && [...used].sort().every((v, i) => v === need[i])) return { name: registry.items[r.result.id].name, count: r.result.count }
      } else if (r.inShape) {
        const shape = r.inShape.map((row) => row.map((x) => (x == null || x === -1 ? null : x)))
        const crop = cropRows(rows)
        if (sameShape(crop, shape) || sameShape(crop, shape.map((row) => [...row].reverse()))) return { name: registry.items[r.result.id].name, count: r.result.count }
      }
    }
  }
  return null
}
function cropRows (rows) {
  const filled = rows.map((r) => r.some((x) => x != null))
  const top = filled.indexOf(true); const bottom = filled.lastIndexOf(true)
  if (top < 0) return []
  const kept = rows.slice(top, bottom + 1)
  const cols = kept[0].map((_, x) => kept.some((r) => r[x] != null))
  const left = cols.indexOf(true); const right = cols.lastIndexOf(true)
  return kept.map((r) => r.slice(left, right + 1))
}
const sameShape = (a, b) => a.length === b.length && a.every((row, y) => row.length === b[y].length && row.every((v, x) => v === b[y][x]))

/** The real recipes for an item that fit the grid and that we hold the ingredients for, as cell layouts (names). */
function realLayouts (registry, itemName, inv, w, h) {
  const def = registry.itemsByName[itemName]
  const out = []
  for (const r of (def && registry.recipes[def.id]) || []) {
    let cells = null
    if (r.inShape) {
      const rh = r.inShape.length; const rw = r.inShape[0].length
      if (rh > h || rw > w) continue
      cells = new Array(w * h).fill(null)
      r.inShape.forEach((row, y) => row.forEach((x, xi) => { if (x != null && x !== -1) cells[y * w + xi] = registry.items[x].name }))
    } else if (r.ingredients && r.ingredients.length <= w * h) {
      cells = new Array(w * h).fill(null)
      r.ingredients.forEach((x, i) => { cells[i] = registry.items[x].name })
    }
    if (!cells) continue
    const need = {}
    for (const n of cells) if (n) need[n] = (need[n] || 0) + 1
    if (Object.entries(need).every(([n, c]) => (inv[n] || 0) >= c)) out.push(cells)
  }
  return out
}

/**
 * Pick the next thing to try. Beginners: pure guessing. Better players: sometimes a real recipe they half remember.
 * @param {{ registry, inv: object, w: number, h: number, target?: string, level: number, tried: Set<string>, told?: string[] }} o
 */
function chooseArrangement (o) {
  const { registry, inv, w, h, target, level, tried } = o
  const names = Object.keys(inv).filter((n) => inv[n] > 0 && registry.itemsByName[n])
  if (!names.length) return null
  const insight = Math.min(0.6, 0.03 + 0.12 * Math.max(0, level)) // an educated guess gets likelier with knowledge
  if (o.told && o.told.length) {
    const want = [...o.told].sort().join(',')
    const targetId = target ? registry.itemsByName[target]?.id : null
    const entries = Object.entries(registry.recipes).sort(([a], [b]) => (Number(b) === targetId) - (Number(a) === targetId)) // the item it asked about first
    for (const [, list] of entries) {
      for (const r of list) {
        const ing = (r.ingredients || r.inShape.flat().filter((x) => x != null && x !== -1)).map((x) => registry.items[x].name)
        if ([...new Set(ing)].sort().join(',') !== want) continue
        const lay = realLayouts(registry, registry.items[r.result.id].name, inv, w, h)
        if (lay.length) return lay[0]
      }
    }
  }
  if (Math.random() < insight) {
    const targets = target ? [target] : [...new Set(names.flatMap((n) => Object.values(registry.recipes).flatMap((l) => l.filter((r) => (r.ingredients || r.inShape.flat()).includes(registry.itemsByName[n].id)).map((r) => registry.items[r.result.id].name))))]
    for (const t of targets.sort(() => Math.random() - 0.5)) {
      const lay = realLayouts(registry, t, inv, w, h).filter((c) => !tried.has(key(c)))
      if (lay.length) return pick(lay)
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const k = 1 + Math.floor(Math.random() * Math.min(4, names.length, w * h))
    const chosen = [...names].sort(() => Math.random() - 0.5).slice(0, k)
    const cells = new Array(w * h).fill(null)
    const used = {}
    const fill = 0.3 + Math.random() * 0.6
    for (let i = 0; i < cells.length; i++) {
      if (Math.random() > fill) continue
      const n = pick(chosen)
      if ((used[n] || 0) + 1 > inv[n]) continue
      cells[i] = n; used[n] = (used[n] || 0) + 1
    }
    if (!cells.some(Boolean) || tried.has(key(cells))) continue
    return cells
  }
  return null
}

/**
 * Do the experiment for real through the game's window clicks: put items in the grid, look at the result slot,
 * take it if there is one, and always put everything back.
 * `win` = { window, w, h, first (first grid slot), result (result slot), invStart, invEnd }.
 */
async function tryLayout (bot, win, cells, { wait = 220 } = {}) {
  const { window, w, h, first, result } = win
  const gridSlot = (i) => first + i // cells are row-major over the grid, and grid slots are contiguous
  const sourceSlot = (name) => { for (let s = win.invStart; s < win.invEnd; s++) { const it = window.slots[s]; if (it && it.name === name) return s } return -1 }
  const placed = []
  try {
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue
      const src = sourceSlot(cells[i])
      if (src < 0) throw new Error(`no ${cells[i]} to put in the grid`)
      await bot.clickWindow(src, 0, 0) // pick the stack up
      await bot.clickWindow(gridSlot(i), 1, 0) // put one in the cell
      await bot.clickWindow(src, 0, 0) // put the rest back
      placed.push(gridSlot(i))
    }
    await new Promise((resolve) => setTimeout(resolve, wait)) // the server tells us what comes out
    const out = window.slots[result]
    if (!out) return null
    const found = { name: out.name, count: out.count }
    await bot.clickWindow(result, 0, 0) // take one craft
    if (window.selectedItem) await bot.putSelectedItemRange(win.invStart, win.invEnd, window, null)
    return found
  } finally {
    for (const s of placed) { if (window.slots[s]) await bot.clickWindow(s, 0, 1).catch(() => {}) } // everything left in the grid goes back
  }
}

module.exports = { RecipeBook, matchGrid, realLayouts, chooseArrangement, tryLayout, SIMPLE, MEDIOCRE, key }
