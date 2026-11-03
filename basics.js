'use strict'

/**
 * basics.js — the early-game ladder, done by rules instead of by asking the model.
 *
 * A small model is slow and often vague about the first steps (it went to mine stone with its hands, or kept
 * looking for "wood"). Until the bot has a stone pickaxe, this picks the obvious next action: logs → (table, planks,
 * sticks are made by craftItem itself) → wooden pickaxe → cobblestone → stone pickaxe. Then the model takes over.
 * It never runs during danger, tasks, builds, chat or when hungry, and it gives up for a while if it keeps failing.
 */

const sum = (inv, re) => Object.entries(inv).filter(([n]) => re.test(n)).reduce((a, [, c]) => a + (Number(c) || 0), 0)

/**
 * @param {{ inventory: object, nearbyBlocks: object }} s  inventory = name → count; nearbyBlocks = name → { distance }
 * @param {{ lastFail?: { name: string, at: number }|null, now?: number }} ctx
 * @returns {{ name: string, args: object, why: string }|null}
 */
function nextBasicStep (s, ctx = {}) {
  const inv = s.inventory || {}
  const near = s.nearbyBlocks || {}
  const now = ctx.now ?? Date.now()
  const hasPick = (re) => sum(inv, re) > 0
  const logs = sum(inv, /_log$/)
  const planks = sum(inv, /_planks$/)
  const sticks = inv.stick || 0
  const tableNear = (inv.crafting_table || 0) > 0 || Boolean(near.crafting_table && near.crafting_table.distance <= 24)
  const woodEq = logs * 4 + planks // in planks
  const stoneNear = ['stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite'].some((n) => near[n])
  // A step that just failed means "not here": look somewhere else before trying again.
  const failedRecently = (name) => ctx.lastFail && ctx.lastFail.name === name && now - ctx.lastFail.at < 60000
  const explore = { name: 'explore', args: { distance: 32 }, why: 'nothing useful here, trying somewhere new' }

  if (hasPick(/^(stone|iron|diamond|netherite)_pickaxe$/)) return null

  if (!hasPick(/_pickaxe$/)) {
    const needPlanks = (tableNear ? 0 : 4) + 3 + 2 // table + pickaxe head + sticks
    if (woodEq < needPlanks) {
      if (failedRecently('mineBlock')) return explore
      return { name: 'mineBlock', args: { blockType: 'log', count: Math.min(8, Math.ceil((needPlanks - woodEq) / 4) + 1), maxDistance: 48 }, why: 'need wood for a table and a pickaxe' }
    }
    return { name: 'craftItem', args: { itemName: 'wooden_pickaxe', count: 1 }, why: 'wooden pickaxe (planks, sticks and a table are handled by itself)' }
  }

  // Has a wooden pickaxe, no stone one yet.
  const cobble = inv.cobblestone || 0
  if (cobble < 3) {
    if (!stoneNear || failedRecently('mineBlock')) return explore
    return { name: 'mineBlock', args: { blockType: 'stone', count: 6, maxDistance: 32 }, why: 'cobblestone for a stone pickaxe' }
  }
  if (sticks < 2 && planks < 2 && logs === 0) {
    if (failedRecently('mineBlock')) return explore
    return { name: 'mineBlock', args: { blockType: 'log', count: 2, maxDistance: 48 }, why: 'a little wood for the pickaxe handle' }
  }
  return { name: 'craftItem', args: { itemName: 'stone_pickaxe', count: 1 }, why: 'stone pickaxe' }
}

/** Per-brain tracker: when to use the ladder, and when to give up for a while. */
class Autopilot {
  constructor () { this.fails = 0; this.pausedUntil = 0; this.lastFail = null }
  onResult (decision, result, now = Date.now()) {
    if (decision.source !== 'auto') return
    if (result.ok) { this.fails = 0; this.lastFail = null; return }
    this.lastFail = { name: decision.action.name, at: now }
    if (++this.fails >= 5) { this.pausedUntil = now + 3 * 60000; this.fails = 0 } // hand it to the model for a while
  }
  step (state, now = Date.now()) {
    if (now < this.pausedUntil) return null
    return nextBasicStep(state, { lastFail: this.lastFail, now })
  }
}

module.exports = { nextBasicStep, Autopilot }
