'use strict'

/**
 * tech.js — redstone and game-mechanics actions for knowledgeable players (installed into ACTIONS like skills.js):
 *
 *   inspectRedstone  look at the redstone and contraptions nearby: what the circuit computes, its speed and cost, a
 *                    cheaper version that does the same (redstone.js), and what the farms around exploit (mechanics.js)
 *   designCircuit    pick the best design it knows for a job (AND, NOR, clock...) with its parts list and footprint
 *   buildCircuit     build a design (or a copy of the circuit it just inspected, improved if it can) on clear ground:
 *                    each part placed with the right facing (checked afterwards and fixed like a player would), then
 *                    tested by flipping the levers and comparing the real lamp with the simulation
 *
 * Knowledge level 4+ can inspect (5+ explains the mechanics); 6+ (master) designs, improves and builds.
 */

const { Vec3 } = require('vec3')
const redstone = require('./redstone')
const mechanics = require('./mechanics')

const DIRV = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0), up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0) }
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const ITEM = { redstone_wire: 'redstone', redstone_wall_torch: 'redstone_torch', redstone_torch: 'redstone_torch' }
const BUILDING = ['stone', 'cobblestone', 'smooth_stone', 'stone_bricks', 'oak_planks', 'spruce_planks', 'birch_planks', 'cobbled_deepslate', 'deepslate', 'andesite', 'diorite', 'granite', 'dirt', 'sandstone']
const yawOf = (v) => Math.atan2(-v.x, -v.z)

function install (ACTIONS, h, SHORT = {}) {
  const { argString, argNumber, ActionError, sleep, gotoGoal, goals, placeAt, digWithAbort, findInventoryItem, throwIfAborted } = h

  const level = (ctx) => ctx.intel?.level?.('knowledge') ?? 3
  const facingOf = (bot) => { const y = bot.entity.yaw; const d = [['south', 0], ['west', Math.PI / 2], ['north', Math.PI], ['east', -Math.PI / 2]]; return d.reduce((b, c) => Math.abs(Math.atan2(Math.sin(y - c[1]), Math.cos(y - c[1]))) < Math.abs(Math.atan2(Math.sin(y - b[1]), Math.cos(y - b[1]))) ? c : b)[0] }

  /** Items a parts list needs (stone parts = any building block). */
  const bill = (parts) => {
    const need = {}
    for (const p of parts) {
      const item = ITEM[p.block] || (p.block === 'stone' ? 'building block' : p.block)
      need[item] = (need[item] || 0) + 1
    }
    return need
  }
  const missingFor = (bot, need) => {
    const inv = {}
    for (const i of bot.inventory.items()) inv[i.name] = (inv[i.name] || 0) + i.count
    const blocks = BUILDING.reduce((a, n) => a + (inv[n] || 0), 0)
    const miss = {}
    for (const [item, n] of Object.entries(need)) {
      const have = item === 'building block' ? blocks : inv[item] || 0
      if (have < n) miss[item] = n - have
    }
    return miss
  }
  const itemFor = (bot, block) => block === 'stone' ? bot.inventory.items().find((i) => BUILDING.includes(i.name)) : findInventoryItem(bot, ITEM[block] || block)

  /** Place one oriented part: aim the camera so the game gives it the right facing, then click the right face. */
  async function placePart (ctx, p) {
    const { bot } = ctx
    const pos = new Vec3(p.x, p.y, p.z)
    const existing = bot.blockAt(pos)
    if (existing && existing.name !== 'air' && existing.name !== 'cave_air' && !/^(short_grass|grass|tall_grass|fern|snow)$/.test(existing.name)) {
      if (existing.name === p.block || (p.block === 'stone' && existing.boundingBox === 'block')) return 'already there'
      throw new ActionError('OCCUPIED', `${existing.name} is in the way at ${p.x} ${p.y} ${p.z}.`)
    }
    const item = itemFor(bot, p.block)
    if (!item) throw new ActionError('MISSING_MATERIALS', `No ${ITEM[p.block] || p.block} left.`)
    const oriented = ['repeater', 'comparator', 'observer', 'piston', 'sticky_piston', 'redstone_wall_torch'].includes(p.block) || ((p.block === 'lever' || /_button$/.test(p.block)) && p.face === 'wall')
    if (!oriented) { await placeAt(ctx, pos, item, { clearSoft: true }); return 'placed' }
    // Where to click and which way to look.
    let ref = pos.offset(0, -1, 0)
    let face = new Vec3(0, 1, 0)
    let look = null
    if (p.block === 'repeater' || p.block === 'comparator') look = DIRV[OPP[p.facing]] // you look the way the signal flows
    else if (p.block === 'observer') look = DIRV[p.facing] // its face watches the way you look
    else if (/piston/.test(p.block)) look = DIRV[OPP[p.facing]] // a piston's head faces you
    else if (p.block === 'redstone_wall_torch' || ((p.block === 'lever' || /_button$/.test(p.block)) && p.face === 'wall')) {
      ref = pos.minus(DIRV[p.facing]); face = DIRV[p.facing]; look = DIRV[OPP[p.facing]]
    }
    const refBlock = bot.blockAt(ref)
    if (!refBlock || refBlock.boundingBox !== 'block') throw new ActionError('NO_SUPPORT', `Nothing to put the ${p.block.replace(/_/g, ' ')} on at ${p.x} ${p.y} ${p.z}.`)
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) {
      await gotoGoal(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeoutMs: 15000, label: 'circuit spot' })
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(ctx.signal)
      await bot.equip(item, 'hand')
      if (look) await bot.look(yawOf(look), look.y > 0 ? Math.PI / 2 : look.y < 0 ? -Math.PI / 2 : -0.35, true)
      await sleep(120) // the turn reaches the server before the click
      await bot._genericPlace(refBlock, face, { forceLook: 'ignore', swingArm: 'right' })
      let placed = null
      for (let i = 0; i < 10 && !placed; i++) { await sleep(100); const b = bot.blockAt(pos); if (b && b.name !== 'air') placed = b }
      if (!placed) continue
      const props = safe(() => placed.getProperties()) || {}
      if (!p.facing || !props.facing || props.facing === p.facing || p.block === 'lever') {
        if (p.delay && props.delay && Number(props.delay) !== p.delay) await setDelay(ctx, placed, Number(props.delay), p.delay)
        if (p.mode === 'subtract' && props.mode !== 'subtract') { await bot.activateBlock(placed).catch(() => {}); await sleep(150) }
        return attempt ? 'placed (second try)' : 'placed'
      }
      await digWithAbort(ctx, placed) // wrong way round: take it back and try again, like anyone would
      await sleep(250)
    }
    throw new ActionError('PLACE_FAILED', `Couldn't get the ${p.block.replace(/_/g, ' ')} at ${p.x} ${p.y} ${p.z} to face ${p.facing}.`)
  }

  /** Right-click a repeater until it has the delay we want (each click adds a tick, 4 wraps to 1). */
  async function setDelay (ctx, block, now, want) {
    const clicks = (want - now + 4) % 4
    for (let i = 0; i < clicks; i++) { await ctx.bot.activateBlock(block).catch(() => {}); await sleep(120) }
  }

  /** What the lamp/piston/door says right now. */
  const outputState = (bot, p) => {
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    const props = safe(() => b.getProperties()) || {}
    return [props.lit, props.extended, props.powered, props.open].some((v) => v === true || v === 'true')
  }

  ACTIONS.inspectRedstone = {
    description: 'Look closely at the redstone and contraptions around you: what the circuit does, how fast and how big it is, a cheaper version that would do the same, and what the farms nearby use and give.',
    params: { x: 'number, optional', y: 'number, optional', z: 'number, optional' },
    minKnowledge: 4,
    async run (ctx, args) {
      const { bot } = ctx
      const lvl = level(ctx)
      const around = [args.x, args.y, args.z].every((n) => Number.isFinite(Number(n))) ? new Vec3(Number(args.x), Number(args.y), Number(args.z)) : bot.entity.position.floored()
      const ids = bot.registry.blocksArray.filter((b) => /redstone|repeater|comparator|observer|lever/.test(b.name)).map((b) => b.id)
      const start = bot.findBlock({ point: around, matching: ids, maxDistance: 10 })
      const out = []
      if (start) {
        const parts = redstone.readFromWorld((p) => bot.blockAt(new Vec3(p.x, p.y, p.z)), start.position, 8)
        const d = redstone.describe(parts, { level: lvl })
        ctx.executorMemory.lastCircuit = { parts, analysis: d.analysis, at: Date.now() }
        out.push(`The redstone here is ${d.text}.`)
      }
      const found = mechanics.scan(bot, around, lvl)
      for (const m of found) out.push(`${m.text[0].toUpperCase()}${m.text.slice(1)}.`)
      if (!out.length) throw new ActionError('NOT_FOUND', 'No redstone or contraptions around here.')
      ctx.memory?.addEvent?.('tech', out.join(' ').slice(0, 300))
      return out.join(' ').slice(0, 900)
    }
  }

  ACTIONS.designCircuit = {
    description: 'Work out the best circuit you know for a job: not, or, nor, and, nand, or clock. Says its parts, size and speed.',
    params: { job: 'string: not | or | nor | and | nand | clock' },
    minKnowledge: 6,
    async run (ctx, args) {
      const d = redstone.design(argString(args, 'job'))
      if (!d) throw new ActionError('UNKNOWN_DESIGN', `You don't know a design for "${args.job}" yet. You know: ${Object.keys(redstone.DESIGNS).join(', ')}.`)
      const a = redstone.analyze(d.parts)
      const need = Object.entries(bill(d.parts)).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')
      const missing = missingFor(ctx.bot, bill(d.parts))
      const miss = Object.keys(missing).length ? ` You're missing ${Object.entries(missing).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}.` : ' You have everything for it.'
      return `${d.label}: ${a.kind === 'clock' ? `blinks every ${a.period / 10}s` : `${a.name}, settles in ${a.delay} ticks`}, ${a.size.x}x${a.size.y}x${a.size.z}. Parts: ${need}.${miss} buildCircuit builds it.`
    }
  }

  ACTIONS.buildCircuit = {
    description: 'Build a redstone circuit on clear flat ground and test it: a design (not, or, nor, and, nand, clock), or "copy" to rebuild the circuit you just inspected (improve: true builds the cheaper version you worked out).',
    params: { design: 'string: not|or|nor|and|nand|clock|copy', x: 'number, optional', y: 'number, optional', z: 'number, optional', facing: 'optional: north|south|east|west (default: the way you look)', improve: 'optional boolean (with copy)' },
    minKnowledge: 6,
    async run (ctx, args) {
      const { bot } = ctx
      const name = argString(args, 'design').toLowerCase()
      let src
      let label
      if (name === 'copy') {
        const last = ctx.executorMemory.lastCircuit
        if (!last) throw new ActionError('NOTHING_TO_COPY', 'Inspect a circuit first (inspectRedstone).')
        if (!['logic', 'clock', 'latch'].includes(last.analysis?.kind) || last.analysis.name === 'always off') throw new ActionError('NOTHING_TO_COPY', `The last thing you inspected isn't a working circuit (${last.analysis?.name || last.analysis?.kind}). Nothing worth copying.`)
        src = args.improve ? redstone.optimize(last.parts, { budgetMs: 400 }).parts : last.parts
        const minX = Math.min(...src.map((p) => p.x)); const minY = Math.min(...src.map((p) => p.y)); const minZ = Math.min(...src.map((p) => p.z))
        src = src.map((p) => ({ ...p, x: p.x - minX, y: p.y - minY, z: p.z - minZ, on: false }))
        label = `copy of the ${last.analysis?.name || 'circuit'}${args.improve ? ', improved' : ''}`
      } else {
        const d = redstone.design(name)
        if (!d) throw new ActionError('UNKNOWN_DESIGN', `No design called "${name}". You know: ${Object.keys(redstone.DESIGNS).join(', ')}.`)
        src = d.parts; label = d.label
      }
      const facing = ['north', 'south', 'east', 'west'].includes(args.facing) ? args.facing : name === 'copy' ? 'east' : facingOf(bot)
      // Origin: given, or 3 blocks ahead at ground level.
      let origin = [args.x, args.y, args.z].every((n) => Number.isFinite(Number(n))) ? new Vec3(Number(args.x), Number(args.y), Number(args.z)) : bot.entity.position.floored().plus(DIRV[facing].scaled(3))
      if (![args.x, args.y, args.z].every((n) => Number.isFinite(Number(n)))) { // settle onto the ground there
        for (let i = 0; i < 4 && bot.blockAt(origin.offset(0, -1, 0))?.boundingBox !== 'block'; i++) origin = origin.offset(0, -1, 0)
        for (let i = 0; i < 4 && bot.blockAt(origin)?.boundingBox === 'block'; i++) origin = origin.offset(0, 1, 0)
      }
      const parts = redstone.place(src, origin, name === 'copy' ? 'east' : facing)
      const missing = missingFor(bot, bill(parts))
      if (Object.keys(missing).length) throw new ActionError('MISSING_MATERIALS', `For the ${label} you still need ${Object.entries(missing).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')} (obtainItem).`)
      // Ground under the bottom layer.
      const bottom = Math.min(...parts.map((p) => p.y))
      for (const p of parts.filter((q) => q.y === bottom)) {
        const under = bot.blockAt(new Vec3(p.x, p.y - 1, p.z))
        if (under && under.boundingBox !== 'block') throw new ActionError('NOT_FLAT', `The ground isn't flat and solid at ${p.x} ${p.y - 1} ${p.z}. Pick a flat spot.`)
      }
      // Blocks first, then what sits on them, then the oriented parts, then inputs and outputs.
      const order = (p) => p.block === 'stone' ? 0 : /lamp|piston|_door$|note_block|dispenser/.test(p.block) ? 1 : p.block === 'redstone_torch' ? 2 : p.block === 'redstone_wall_torch' ? 3 : p.block === 'redstone_wire' ? 4 : /repeater|comparator|observer/.test(p.block) ? 5 : 6
      const sorted = [...parts].sort((a, b) => a.y - b.y || order(a) - order(b))
      let placed = 0
      for (const p of sorted) {
        throwIfAborted(ctx.signal)
        const r = await placePart(ctx, p)
        if (r !== 'already there') placed++
      }
      // Test it in the real game against the simulation.
      const expect = redstone.analyze(parts)
      const ins = parts.filter((p) => p.block === 'lever')
      const outs = parts.filter((p) => /lamp|piston|_door$/.test(p.block))
      let verdict = ''
      if (expect.kind === 'clock' && outs.length) {
        const seen = new Set()
        for (let i = 0; i < 20; i++) { await sleep(100); seen.add(outputState(bot, outs[0])) }
        verdict = seen.size === 2 ? 'Tested: it blinks.' : 'Tested: the lamp is not blinking yet (it may need a block update, or a part sits wrong).'
      } else if (expect.kind === 'logic' && ins.length && outs.length && ins.length <= 2) {
        let ok = 0
        const state = ins.map(() => false) // levers are placed off
        for (const row of expect.table) {
          for (let i = 0; i < ins.length; i++) {
            if (state[i] !== row.in[i]) {
              const lv = bot.blockAt(new Vec3(ins[i].x, ins[i].y, ins[i].z))
              if (bot.entity.position.distanceTo(lv.position) > 4.2) await gotoGoal(ctx, new goals.GoalNear(lv.position.x, lv.position.y, lv.position.z, 2), { timeoutMs: 10000, label: 'lever' })
              await bot.activateBlock(lv).catch(() => {})
              state[i] = row.in[i]
            }
          }
          await sleep(500)
          if (outputState(bot, outs[0]) === row.out[0]) ok++
        }
        verdict = ok === expect.table.length ? `Tested every input: it works as a ${expect.name}.` : `Tested: ${ok} of ${expect.table.length} input cases right. Something is placed wrong; inspectRedstone to see what it does.`
      }
      return `Built the ${label} at ${origin.x} ${origin.y} ${origin.z} facing ${facing} (${placed} parts). ${verdict}`.trim()
    }
  }

  Object.assign(SHORT, {
    inspectRedstone: 'understand the redstone and farms around you (and how to do them better)',
    designCircuit: 'work out the best circuit for a job (and/or/nor/nand/not/clock)',
    buildCircuit: 'build and test a circuit, or a copy (improved) of one you inspected'
  })
}

function safe (fn) { try { return fn() } catch { return null } }

module.exports = { install }
