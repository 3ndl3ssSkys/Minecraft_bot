'use strict'

/**
 * mindcraft.js — reading answers from models trained for Mindcraft (the Andy models, and others tuned on Mindcraft
 * logs). Those answer in Mindcraft's command language, a sentence and then a command:
 *     "I need wood first. !collectBlocks("oak_log", 10)"
 * and keep doing it even when asked for this bot's JSON. So when an answer has no JSON but a Mindcraft command, the
 * command is turned into the matching action here and the sentence becomes the thought.
 *
 *   find(text)               → { thought, name, args: [...] } for the first "!command(...)" in the text, or null
 *   toAction(cmd, near)      → { name, args } in this bot's actions, or null (commands with no counterpart, like
 *                              !newAction, which writes JavaScript)
 *     near: { entity(type) → id, player(name) → id, block(type) → {x,y,z}, here() → {x,y,z} }
 */

const CMD = /!([a-zA-Z]+)\s*(?:\(([^)]*)\))?/

/** Mindcraft-style arguments: "oak_log", 10, true, 'name'. */
function splitArgs (s) {
  const out = []
  const re = /\s*("([^"]*)"|'([^']*)'|[^,]+)\s*(?:,|$)/g
  let m
  while ((m = re.exec(s || '')) && m[0]) {
    const raw = m[2] ?? m[3] ?? m[1].trim()
    out.push(m[2] !== undefined || m[3] !== undefined ? raw : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw)
  }
  return out
}

function find (text) {
  const t = String(text || '').replace(/^[\s\S]*<\/think>/, '')
  const m = t.match(CMD)
  if (!m) return null
  return { thought: t.slice(0, m.index).trim().replace(/\s+/g, ' ').slice(0, 300), name: m[1], args: splitArgs(m[2]) }
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)

function toAction (cmd, near = {}) {
  if (!cmd) return null
  const [a, b, c, d] = cmd.args
  switch (cmd.name.toLowerCase()) {
    case 'collectblocks': return { name: 'mineBlock', args: { blockType: String(a), count: Math.min(16, num(b, 1)) } }
    case 'craftrecipe': return { name: 'craftItem', args: { itemName: String(a), count: num(b, 1) } }
    case 'smeltitem': return { name: 'smeltItem', args: { itemName: String(a), count: num(b, 8) } }
    case 'gotoplayer': return { name: 'moveToPlayer', args: { playerName: String(a), range: num(b, 2) } }
    case 'followplayer': return { name: 'followPlayer', args: { playerName: String(a) } }
    case 'gotocoordinates': return { name: 'moveToBlock', args: { x: num(a, 0), y: num(b, 64), z: num(c, 0), range: num(d, 1) } }
    case 'searchforblock': {
      const at = near.block?.(String(a))
      return at ? { name: 'moveToBlock', args: { ...at, range: 2 } } : { name: 'explore', args: { distance: Math.min(64, num(b, 32)) } }
    }
    case 'searchforentity': case 'moveaway': return { name: 'explore', args: { distance: Math.min(64, num(cmd.name === 'moveAway' ? a : b, 32)) } }
    case 'attack': case 'attackplayer': {
      const id = cmd.name.toLowerCase() === 'attack' ? near.entity?.(String(a)) : near.player?.(String(a))
      return id !== undefined && id !== null ? { name: 'attackTarget', args: { entityId: id } } : null
    }
    case 'equip': return { name: 'equipItem', args: { itemName: String(a) } }
    case 'consume': case 'eat': return { name: 'eatFood', args: a ? { foodName: String(a) } : {} }
    case 'giveplayer': return { name: 'giveItem', args: { playerName: String(a), itemName: String(b), count: num(c, 1) } }
    case 'discard': return { name: 'dropItems', args: { itemNames: String(a) } }
    case 'putinchest': return { name: 'storeItems', args: { itemNames: String(a) } }
    case 'takefromchest': return { name: 'takeItems', args: { itemName: String(a), ...(b !== undefined ? { count: num(b, 1) } : {}) } }
    case 'placehere': {
      const at = near.here?.()
      return at ? { name: 'placeBlock', args: { blockType: String(a), ...at } } : null
    }
    case 'gotobed': return { name: 'sleepInBed', args: {} }
    case 'activate': {
      const at = near.block?.(String(a))
      return at ? { name: 'activateBlock', args: at } : null
    }
    case 'stay': case 'stop': return { name: 'wait', args: { seconds: Math.min(30, Math.max(1, num(a, 5))) } }
    case 'startconversation': return b ? { name: 'chatMessage', args: { text: String(b) } } : null
    default: return null // !newAction (writes code), !goal, !rememberHere, !viewChest...: no counterpart
  }
}

module.exports = { find, toAction, splitArgs }
