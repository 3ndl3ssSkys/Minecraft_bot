'use strict'

/**
 * observe.js — one short description of the moment, the same wherever it comes from.
 *
 * A fine-tuned model only works on what it was trained on. Its training examples come from three places: the bot's
 * own model decisions, the code's own good decisions, and recordings of a person playing (scripts/record.js). If each
 * described the moment differently, the model would learn three formats and use none of them well. So all three, and
 * the trained model at run time (llm.trained), use this one compact text (~250-500 tokens instead of ~2-4k):
 *
 *   compact(s, opt)        a perception snapshot (Perception.snapshot, or record.js's miniSnapshot) → text
 *   miniSnapshot(bot, x)   the parts of a snapshot compact() reads, from a bare mineflayer bot (no Agent)
 */

const HOSTILE = /^(zombie|husk|drowned|skeleton|stray|bogged|creeper|spider|cave_spider|enderman|witch|slime|magma_cube|phantom|blaze|ghast|wither_skeleton|piglin_brute|hoglin|zoglin|pillager|vindicator|evoker|ravager|vex|guardian|elder_guardian|shulker|silverfish|endermite|warden|breeze|creaking|zombie_villager|zombified_piglin)$/
// Blocks worth naming (everything else is ground and walls).
const NOTABLE = /_log$|_ore$|^(ancient_debris|crafting_table|furnace|blast_furnace|smoker|chest|barrel|trapped_chest|ender_chest|anvil|enchanting_table|brewing_stand|water|lava|sand|gravel|clay|obsidian|bell|spawner|.*_bed|sugar_cane|pumpkin|melon|wheat|carrots|potatoes|beetroots|hay_block|bee_nest|beehive|nether_portal|end_portal_frame|cobweb|amethyst_cluster|budding_amethyst|composter|smithing_table|stonecutter|grindstone|loom|cartography_table|fletching_table|lectern|torch|wall_torch|lantern|campfire)$/

const round = (v) => Math.round(v)
// The same words the bot's perception uses (index.js timePhase / itemLabel), so recordings match run time.
const phaseOf = (t) => (t < 1000 || t >= 23000 ? 'dawn' : t < 12000 ? 'day' : t < 13000 ? 'dusk' : 'night')
const label = (item) => {
  if (!item) return null
  if (!item.maxDurability) return `${item.name}${item.count > 1 ? ` x${item.count}` : ''}`
  return `${item.name} (${Math.round(((item.maxDurability - (item.durabilityUsed || 0)) / item.maxDurability) * 100)}% durability)`
}

/**
 * @param s   snapshot: self, world, equipment, inventory.items, nearbyEntities, nearbyBlocks, layout, status
 *            (goal, goals, task, threats), recentActions, recentChat, recentEvents
 * @param opt coords (false: positions relative to it), options (strategy.js describe() lines), goal/step overrides
 */
function compact (s, opt = {}) {
  if (!s?.self) return ''
  const out = []
  const me = s.self.position || { x: 0, y: 0, z: 0 }
  const where = (p) => {
    if (!p) return ''
    if (opt.coords !== false) return ` at ${round(p.x)} ${round(p.y)} ${round(p.z)}`
    return ` (${round(p.x - me.x)} ${round(p.y - me.y)} ${round(p.z - me.z)} from you)`
  }
  const dim = String(s.self.dimension || 'overworld').replace('minecraft:', '').replace(/^the_/, '')
  const t = s.world?.timeOfDay ?? 6000
  out.push(`You: health ${round(s.self.health ?? 20)}/20, food ${s.self.food ?? 20}/20${opt.coords !== false ? `, at ${round(me.x)} ${round(me.y)} ${round(me.z)}` : ''} in the ${dim}, ${s.world?.phase || phaseOf(t)}${s.world?.raining ? ', raining' : ''}${s.self.gameMode && s.self.gameMode !== 'survival' ? `, ${s.self.gameMode} mode` : ''}. ${s.layout || ''}`.trim())
  const eq = s.equipment || {}
  const worn = ['head', 'torso', 'legs', 'feet'].map((k) => eq[k]).filter(Boolean)
  out.push(`Holding ${eq.hand || 'nothing'}${eq.offHand ? ` and ${eq.offHand}` : ''}; wearing ${worn.join(', ') || 'no armor'}.`)
  const inv = Object.entries(s.inventory?.items || {}).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([n, c]) => `${c} ${n}`)
  out.push(`Carrying: ${inv.join(', ') || 'nothing'}${s.inventory?.freeSlots !== undefined ? ` (${s.inventory.freeSlots} free slots)` : ''}.`)
  const blocks = Object.entries(s.nearbyBlocks || {}).filter(([n, b]) => b && b.visible !== false && (NOTABLE.test(n) || b.notable))
    .sort((a, b) => (a[1].distance ?? 99) - (b[1].distance ?? 99)).slice(0, 10).map(([n, b]) => `${n} ${round(b.distance ?? 0)}m`)
  if (blocks.length) out.push(`Blocks in sight: ${blocks.join(', ')}.`)
  const ents = (s.nearbyEntities || []).filter((e) => e.kind !== 'item' || e.distance < 8).slice(0, 8).map((e) => {
    const bits = [`${e.name}${e.count > 1 ? ` x${e.count}` : ''} #${e.id} ${round(e.distance)}m`]
    if (e.kind === 'item' && e.item) bits[0] = `dropped ${e.item}${e.count > 1 ? ` x${e.count}` : ''} #${e.id} ${round(e.distance)}m`
    if (e.holding) bits.push(`holding ${e.holding}`)
    if (e.kind === 'hostile' || HOSTILE.test(e.name)) bits.push('hostile')
    if (e.leaveAlone) bits.push('leave alone')
    if (e.perceived && /last seen/.test(e.perceived)) bits.push(e.perceived)
    return bits.join(', ')
  })
  if (ents.length) out.push(`Around you: ${ents.join('; ')}.`)
  const threats = s.status?.threats
  if (threats?.length) out.push(`Threats: ${threats.slice(0, 4).join('; ')}.`)
  const goal = opt.goal ?? s.status?.goal
  const step = opt.step ?? s.status?.goals?.current?.steps?.[s.status.goals.current.now]
  if (goal) out.push(`Goal: ${goal}${step ? ` (now: ${typeof step === 'string' ? step : step.text || ''})` : ''}.`)
  const task = s.status?.task
  if (task?.what) out.push(`Task: ${task.what}${task.from ? ` for ${task.from}` : ''}${task.progress ? ` (${task.progress})` : ''}.`)
  const chat = (s.recentChat || []).slice(-3)
  if (chat.length) out.push(`Chat:\n${chat.map((c) => `  ${c}`).join('\n')}`)
  const ev = (s.recentEvents || []).slice(-3)
  if (ev.length) out.push(`Lately: ${ev.join(' | ')}`)
  const acts = (s.recentActions || []).slice(-3).map((a) => `${a.action}(${JSON.stringify(a.args || {})}) ${a.ok ? 'ok' : `failed${a.code ? ` ${a.code}` : ''}`}`)
  if (acts.length) out.push(`Your last actions: ${acts.join('; ')}.`)
  if (opt.options?.length) out.push(`Good options:\n${opt.options.join('\n')}`)
  return out.join('\n')
}

/**
 * The parts of a snapshot compact() needs, from a bare mineflayer bot: what scripts/record.js has while watching a
 * person play (no Agent, no senses). Entities by distance (a person sees what's around them), notable blocks within
 * 16 blocks, a rough layout.
 *   x: { goal, recentActions, recentChat, recentEvents }
 */
function miniSnapshot (bot, x = {}) {
  const e = bot.entity
  if (!e?.position) return null
  const me = e.position
  const slot = (d) => { try { return label(bot.inventory.slots[bot.getEquipmentDestSlot(d)]) } catch { return null } }
  const items = {}
  for (const it of bot.inventory.items()) items[it.name] = (items[it.name] || 0) + it.count
  const entities = Object.values(bot.entities)
    .filter((o) => o !== e && o.position && o.position.distanceTo(me) < 24 && (o.type === 'player' || o.type === 'mob' || o.type === 'hostile' || o.type === 'animal' || o.type === 'passive' || o.name === 'item'))
    .map((o) => {
      const kind = o.name === 'item' ? 'item' : o.type === 'player' ? 'player' : HOSTILE.test(o.name || '') || o.kind === 'Hostile mobs' ? 'hostile' : 'passive'
      const out = { id: o.id, kind, name: o.username || o.name, distance: Math.round(o.position.distanceTo(me) * 10) / 10 }
      if (kind === 'item') { try { const it = o.getDroppedItem(); out.item = it?.name; if (it?.count > 1) out.count = it.count } catch {} }
      if (kind === 'player') out.holding = o.heldItem?.name || null
      return out
    })
    .sort((a, b) => a.distance - b.distance).slice(0, 10)
  const blocks = {}
  try {
    const ids = bot.registry.blocksArray.filter((b) => NOTABLE.test(b.name)).map((b) => b.id)
    for (const p of bot.findBlocks({ matching: ids, maxDistance: 16, count: 120 })) {
      const b = bot.blockAt(p)
      if (!b) continue
      const d = p.offset(0.5, 0.5, 0.5).distanceTo(me)
      if (!blocks[b.name] || d < blocks[b.name].distance) blocks[b.name] = { distance: Math.round(d * 10) / 10 }
    }
  } catch {}
  return {
    self: { position: { x: me.x, y: me.y, z: me.z }, health: bot.health, food: bot.food, dimension: bot.game?.dimension, gameMode: bot.game?.gameMode },
    world: { timeOfDay: bot.time?.timeOfDay ?? 6000, phase: phaseOf(bot.time?.timeOfDay ?? 6000), raining: bot.isRaining },
    equipment: { hand: label(bot.heldItem), offHand: slot('off-hand'), head: slot('head'), torso: slot('torso'), legs: slot('legs'), feet: slot('feet') },
    inventory: { items, freeSlots: bot.inventory.emptySlotCount() },
    nearbyEntities: entities,
    nearbyBlocks: blocks,
    layout: (() => { try { return layout(bot) } catch { return '' } })(),
    status: { goal: x.goal || null },
    recentActions: x.recentActions || [],
    recentChat: x.recentChat || [],
    recentEvents: x.recentEvents || []
  }
}

/**
 * Where it is, in a player's words: outdoors / underground / under a roof, blocked sides, drop-offs, a door, darkness.
 * The bot's perception and the recorder both use this, so recorded and live moments read the same.
 */
function layout (bot) {
  const p = bot.entity.position.floored()
  const solid = (b) => b && b.boundingBox === 'block'
  const out = []
  let roof = null
  for (let dy = 2; dy <= 24; dy++) if (solid(bot.blockAt(p.offset(0, dy, 0)))) { roof = dy; break }
  if (roof === null) out.push('outdoors')
  else if (p.y < 56 && roof > 0) out.push(`underground (y ${p.y}, rock ${roof} above)`)
  else out.push(`under a roof ${roof} blocks up`)
  const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  const blocked = []
  const drops = []
  for (const [name, [dx, dz]] of Object.entries(dirs)) {
    let free = 0
    for (let i = 1; i <= 6; i++) {
      if (solid(bot.blockAt(p.offset(dx * i, 0, dz * i))) || solid(bot.blockAt(p.offset(dx * i, 1, dz * i)))) break
      free++
    }
    if (free === 0) blocked.push(name)
    for (let i = 1; i <= Math.min(3, free); i++) {
      let depth = 0
      while (depth < 10 && !solid(bot.blockAt(p.offset(dx * i, -1 - depth, dz * i)))) depth++
      if (depth >= 4) { drops.push(`${name} (${depth >= 10 ? '10+' : depth} down)`); break }
    }
  }
  if (blocked.length === 4) out.push('walled in on all sides')
  else if (blocked.length) out.push(`blocked to the ${blocked.join(' and ')}`)
  if (drops.length) out.push(`drop-off to the ${drops.join(', ')}`)
  const doorIds = bot._doorIds || (bot._doorIds = bot.registry.blocksArray.filter((b) => /_door$/.test(b.name)).map((b) => b.id))
  const door = bot.findBlock({ matching: doorIds, maxDistance: 8 })
  if (door) {
    const d = door.position.minus(p)
    const side = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 'east' : 'west') : (d.z > 0 ? 'south' : 'north')
    out.push(`a door ${Math.round(door.position.distanceTo(p))} blocks ${side}`)
  }
  const light = bot.blockAt(p.offset(0, 1, 0))?.light
  if (roof !== null && Number.isFinite(light) && light < 8) out.push('dark here (monsters can spawn)')
  return out.join('; ')
}

/** The short system prompt of a fine-tuned model (llm.trained): the same words for the bot and for recordings. */
function trainedPrompt ({ name, level, description = '', toolNames = '' }) {
  return `You are ${name}, playing Minecraft${level ? ` (${level} player)` : ''}. ${String(description || '').slice(0, 240)}
Answer with one JSON decision: thought, choose (a good option's number, or 0), goal, subgoal, goalStatus, action {name, args}, next.
Actions: ${String(toolNames).split('\n').join(' ')}`
}

module.exports = { compact, miniSnapshot, layout, trainedPrompt, HOSTILE, NOTABLE }
