'use strict'

/**
 * routines.js — keeping at something without stopping to think after every block, the way a player does.
 *
 * A player who decides "chop 20 logs" chops until there are 20; one who goes looking for iron keeps tunnelling until
 * there's iron; one heading off to find a village keeps walking until a village shows up. Only then do they stop and
 * think about what's next. The model decides the intent; these turn it into a routine the code carries out, so the
 * model is asked again only when the routine is done, stuck, or something happens.
 *
 *   stepCount(text, registry)   "chop 20 oak logs" → { item: 'oak_log', count: 20, anyWood: false }
 *   seekTarget(text)            "find a village" → { label: 'a village', blocks: /^bell$/, entities: /^villager$/ }
 *   seen(target, state)         is it in sight now? → a short description or null
 */

const WOOD = /^(wood|woods|logs?|trees?|timber)$/
const STOP = new Set(['a', 'an', 'the', 'some', 'more', 'of', 'at', 'least', 'about', 'around', 'my', 'me', 'for', 'to', 'and', 'x'])

const singular = (w) => w.replace(/ies$/, 'y').replace(/(ches|shes|xes)$/, (m) => m.slice(0, -2)).replace(/([^s])s$/, '$1')

/**
 * The item and amount a step names ("mine 8 cobblestone", "get 3 iron ingots", "chop 20 logs"), or null.
 * Logs in general ("20 logs", "16 wood") mean any kind of log: anyWood.
 */
function stepCount (text, registry) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9 _-]/g, ' ')
  const m = t.match(/\b(\d{1,3})\s*x?\s+((?:[a-z_-]+\s*){1,3})/)
  if (!m) return null
  const count = Number(m[1])
  if (!count || count > 640) return null
  const words = m[2].trim().split(/\s+/).filter((w) => !STOP.has(w))
  if (!words.length) return null
  const names = registry.itemsByName
  // Longest match first: "iron ingots" before "iron", "oak logs" before "oak".
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const phrase = words.slice(0, n).map(singular)
    if (n === 1 && WOOD.test(words[0])) return { item: 'oak_log', count, anyWood: true }
    if (phrase.length === 2 && /^logs?$/.test(words[1])) {
      const kind = `${phrase[0]}_log`
      if (names[kind]) return { item: kind, count, anyWood: true } // a player chopping "oak logs" takes birch if that's what's there
    }
    const id = phrase.join('_')
    if (names[id]) return { item: id, count, anyWood: /_log$/.test(id) }
    if (n === 1 && /^(iron|gold|copper)$/.test(id)) {
      const smelt = /\b(smelt|cook|ingots?)\b/.test(t)
      return { item: smelt ? `${id}_ingot` : `raw_${id}`, count, anyWood: false }
    }
  }
  return null
}

// What "find X" means, in things it can perceive.
const SEEK = [
  [/\b(trees?|wood|logs?|forest)\b/, 'trees', /_log$/, null],
  [/\bvillag(e|er)s?\b/, 'a village', /^bell$/, /^villager$/],
  [/\b(cows?|cattle)\b/, 'cows', null, /^(cow|mooshroom)$/],
  [/\b(pigs?)\b/, 'pigs', null, /^pig$/],
  [/\b(sheep)\b/, 'sheep', null, /^sheep$/],
  [/\b(chickens?)\b/, 'chickens', null, /^chicken$/],
  [/\b(animals?|food|meat)\b/, 'animals', null, /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/],
  [/\bdiamonds?\b/, 'diamonds', /diamond_ore$/, null],
  [/\biron\b/, 'iron ore', /iron_ore$/, null],
  [/\bcoal\b/, 'coal', /coal_ore$/, null],
  [/\bgold\b/, 'gold ore', /gold_ore$/, null],
  [/\bredstone\b/, 'redstone', /redstone_ore$/, null],
  [/\blapis\b/, 'lapis', /lapis_ore$/, null],
  [/\bcopper\b/, 'copper ore', /copper_ore$/, null],
  [/\bsand\b/, 'sand', /^sand$/, null],
  [/\bclay\b/, 'clay', /^clay$/, null],
  [/\bwater\b/, 'water', /^water$/, null],
  [/\blava\b/, 'lava', /^lava$/, null],
  [/\bsugar ?cane\b/, 'sugar cane', /^sugar_cane$/, null],
  [/\bpumpkins?\b/, 'pumpkins', /^pumpkin$/, null],
  [/\bmelons?\b/, 'melons', /^melon$/, null],
  [/\b(caves?|ravine)\b/, 'a cave', /^cave_air$/, null]
]

/** What a "find …" / "look for …" / "search for …" text is after, or null. */
function seekTarget (text) {
  const t = String(text || '').toLowerCase()
  if (!/\b(find|look(ing)? for|search(ing)? for|locate|hunt(ing)? for|track down|explore for|go to)\b/.test(t)) return null
  const rest = t.replace(/^.*?\b(find|look(ing)? for|search(ing)? for|locate|hunt(ing)? for|track down|explore for|go to)\b/, '')
  for (const [re, label, blocks, entities] of SEEK) if (re.test(rest)) return { label, blocks, entities }
  return null
}

/** Is the target in sight in this perception state? Returns where, briefly, or null. */
function seen (target, state) {
  if (!target || !state) return null
  if (target.blocks) {
    for (const [name, b] of Object.entries(state.nearbyBlocks || {})) {
      if (target.blocks.test(name) && b.visible !== false) return `${name.replace(/_/g, ' ')} ${b.distance ?? '?'} blocks away`
    }
  }
  if (target.entities) {
    const e = (state.nearbyEntities || []).find((x) => target.entities.test(x.name || '') && x.perceived !== 'memory')
    if (e) return `${e.name} ${e.distance ?? '?'} blocks away`
  }
  return null
}

module.exports = { stepCount, seekTarget, seen, singular }
