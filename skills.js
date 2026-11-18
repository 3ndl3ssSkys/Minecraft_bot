'use strict'

/**
 * skills.js — situational survival moves a good player just knows, done in code (fast, no model calls):
 *
 *   shelter     night without a bed: dig in two blocks, cover up, wait for morning, climb out (or sleep, with a bed)
 *   pillarUp    jump-place blocks under yourself (escape a crowd of zombies, reach something, get out of a hole)
 *   climbOut    out of a pit or hole: pillar up with blocks, or dig a staircase up without them
 *   bridge      walk across a gap placing blocks in front, crouched at the edge
 *   stripMine   staircase down to the right depth for an ore (version-aware), then a 2-high tunnel with lava checks,
 *               mining ores it uncovers and lighting the way
 *   placeTorch  light up where you are (also a habit underground: see Brain.torchHabit)
 *
 * install() adds them to the ACTIONS registry with the helpers from actions.js (avoids a require cycle).
 */

const { Vec3 } = require('vec3')

const solid = (b) => Boolean(b && b.boundingBox === 'block')
const open = (b) => Boolean(b && b.boundingBox === 'empty' && !/water|lava/.test(b.name))
const DANGER = /lava|water|bubble_column/
const CHEAP = ['cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'blackstone', 'sandstone', 'end_stone']
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
const ORES = /(_ore|ancient_debris)$/

/** Where each ore is most common: 1.18+ worlds (deepslate exists) vs older ones. */
const DEPTHS = {
  modern: { diamond: -54, redstone: -54, lapis: 0, gold: -16, iron: 16, copper: 48, coal: 96, emerald: 100 },
  legacy: { diamond: 11, redstone: 11, lapis: 14, gold: 12, iron: 40, copper: 40, coal: 50, emerald: 20 }
}
const NEEDS = { diamond: 'iron', redstone: 'iron', gold: 'iron', emerald: 'iron', lapis: 'stone', iron: 'stone', copper: 'stone', coal: 'wooden' }
const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']

function install (ACTIONS, h, SHORT = {}) {
  const { argNumber, argString, ActionError, sleep, gotoGoal, goals, placeAt, digWithAbort, equipToolFor, findInventoryItem, throwIfAborted } = h

  /** A cheap block to build with (cobble, dirt...), or null. */
  const buildingBlock = (bot) => {
    const items = bot.inventory.items()
    for (const n of CHEAP) { const i = items.find((x) => x.name === n); if (i) return i }
    return items.find((i) => { const b = bot.registry.blocksByName[i.name]; return b && b.boundingBox === 'block' && /stone|dirt|planks|deepslate|cobble/.test(i.name) }) || null
  }
  const blockCount = (bot) => bot.inventory.items().filter((i) => CHEAP.includes(i.name) || /_planks$/.test(i.name)).reduce((a, i) => a + i.count, 0)
  const pickTier = (bot) => Math.max(-1, ...bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name)).map((i) => TIERS.indexOf(i.name.split('_')[0])))

  /** Lava or water touching this cell (opening it would let it in). */
  const hazardAround = (bot, pos) => {
    for (const d of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(pos.offset(...d))
      if (b && DANGER.test(b.name)) return b.name
    }
    return null
  }

  /** Break the block at pos if there is one (best tool), refusing to open into lava or water. */
  const dig = async (ctx, pos, { check = true } = {}) => {
    const { bot } = ctx
    const b = bot.blockAt(pos)
    if (!b || b.boundingBox === 'empty') return true
    if (/bedrock|barrier|end_portal_frame|reinforced/.test(b.name)) return false
    if (check && hazardAround(bot, pos)) return false
    await equipToolFor(ctx, b).catch(() => {})
    await digWithAbort(ctx, b)
    return true
  }

  /** Walk a short straight line to the centre of a cell (no pathfinding: it's right there). */
  const stepTo = async (ctx, cell, { sneak = false, ms = 1500 } = {}) => {
    const { bot } = ctx
    const target = cell.offset(0.5, 0, 0.5)
    const end = Date.now() + ms
    try {
      bot.setControlState('sneak', sneak)
      while (Date.now() < end) {
        throwIfAborted(ctx.signal)
        const p = bot.entity.position
        if (Math.hypot(target.x - p.x, target.z - p.z) < 0.25) break
        await bot.lookAt(new Vec3(target.x, p.y + 1.6, target.z), true)
        bot.setControlState('forward', true)
        bot.setControlState('jump', cell.y > Math.floor(p.y) + 0.5 && bot.entity.onGround)
        await sleep(50)
      }
    } finally {
      bot.setControlState('forward', false)
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
    }
    await sleep(150)
  }

  /** One jump-and-place step. True if it got one block higher. */
  const pillarStep = async (ctx, item) => {
    const { bot } = ctx
    const base = bot.entity.position.floored()
    if (solid(bot.blockAt(base.offset(0, 2, 0)))) return false // ceiling
    await bot.equip(item, 'hand')
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.setControlState('jump', true)
    const t0 = Date.now()
    // Place near the top of the jump, when the feet are well clear of the cell.
    while ((bot.entity.position.y < base.y + 1.15 && bot.entity.velocity.y > 0) && Date.now() - t0 < 900) await sleep(20)
    await Promise.race([bot.placeBlock(bot.blockAt(base.offset(0, -1, 0)), new Vec3(0, 1, 0)).catch(() => {}), sleep(700)]) // don't wait 5 s for a slow confirmation
    bot.setControlState('jump', false)
    const t1 = Date.now()
    while (!bot.entity.onGround && Date.now() - t1 < 900) await sleep(20)
    return solid(bot.blockAt(base)) && bot.entity.position.y >= base.y + 0.9
  }

  ACTIONS.pillarUp = {
    description: 'Jump and place blocks under yourself to go straight up (escape a crowd of zombies, reach something high, get out of a hole). Needs cheap blocks (cobblestone, dirt...).',
    params: { height: 'number, optional (default 3)' },
    async run (ctx, args) {
      const { bot } = ctx
      const n = Math.floor(argNumber(args, 'height', { min: 1, max: 30, def: 3 }))
      let up = 0
      try {
        for (; up < n; up++) {
          throwIfAborted(ctx.signal)
          const item = buildingBlock(bot)
          if (!item) break
          if (!await pillarStep(ctx, item)) break
        }
      } finally { bot.clearControlStates() }
      if (!up) throw new ActionError(buildingBlock(bot) ? 'BLOCKED' : 'MISSING_BLOCKS', buildingBlock(bot) ? 'Something is right above your head.' : 'You have no blocks to pillar with (cobblestone, dirt...).')
      return `Pillared up ${up} block${up > 1 ? 's' : ''}${up < n ? ` (stopped: ${buildingBlock(bot) ? 'something above' : 'out of blocks'})` : ''}.`
    }
  }

  /** Is there a way out at feet level next to us (2 open cells and ground under, not a big drop)? */
  const exitDir = (bot) => {
    const p = bot.entity.position.floored()
    for (const [name, [dx, dz]] of Object.entries(DIRS)) {
      const feet = bot.blockAt(p.offset(dx, 0, dz)); const head = bot.blockAt(p.offset(dx, 1, dz))
      if (open(feet) && open(head) && solid(bot.blockAt(p.offset(dx, -1, dz)))) return { name, dx, dz }
    }
    return null
  }

  ACTIONS.climbOut = {
    description: 'Get out of a pit, hole or ravine you are stuck in: pillars up when you have blocks, otherwise digs a staircase up.',
    params: { maxHeight: 'number, optional (default 16)' },
    async run (ctx, args) {
      const { bot } = ctx
      const max = Math.floor(argNumber(args, 'maxHeight', { min: 2, max: 64, def: 16 }))
      const startY = bot.entity.position.y
      try {
        for (let i = 0; i < max + 4; i++) {
          throwIfAborted(ctx.signal)
          // Out once we can walk off at some side, or see the sky with ground around us.
          const out = exitDir(bot)
          if (out && i > 0) { await stepTo(ctx, bot.entity.position.floored().offset(out.dx, 0, out.dz)); break }
          const item = buildingBlock(bot)
          if (item && await pillarStep(ctx, item)) continue
          // No blocks (or a ceiling): dig a step up in the most open direction.
          const p = bot.entity.position.floored()
          const [, [dx, dz]] = Object.entries(DIRS).sort(([, a], [, b]) =>
            Number(solid(bot.blockAt(p.offset(a[0], 1, a[1])))) - Number(solid(bot.blockAt(p.offset(b[0], 1, b[1])))))[0]
          if (!await dig(ctx, p.offset(0, 2, 0))) break
          if (!await dig(ctx, p.offset(dx, 1, dz))) break
          if (!await dig(ctx, p.offset(dx, 2, dz))) break
          if (!solid(bot.blockAt(p.offset(dx, 0, dz)))) {
            const fill = buildingBlock(bot)
            if (fill) await placeAt(ctx, p.offset(dx, 0, dz), fill, { clearSoft: false }).catch(() => {})
          }
          await stepTo(ctx, p.offset(dx, 1, dz))
        }
      } finally { bot.clearControlStates() }
      const gained = Math.round(bot.entity.position.y - startY)
      if (gained <= 0 && !exitDir(bot)) throw new ActionError('STILL_STUCK', 'Could not climb out (no blocks to pillar with and the walls would not dig).')
      return `Climbed out (${gained} blocks up).`
    }
  }

  ACTIONS.bridge = {
    description: 'Cross a gap by walking forward crouched and placing blocks in front of you (ravines, water, the void). Needs cheap blocks.',
    params: { direction: 'north|south|east|west', length: 'number, optional (default 8, max 32)' },
    async run (ctx, args) {
      const { bot } = ctx
      const dirName = argString(args, 'direction').toLowerCase()
      const d = DIRS[dirName]
      if (!d) throw new ActionError('INVALID_ARGS', 'direction must be north, south, east or west.')
      const len = Math.floor(argNumber(args, 'length', { min: 1, max: 32, def: 8 }))
      let walked = 0
      let placed = 0
      try {
        for (; walked < len; walked++) {
          throwIfAborted(ctx.signal)
          const p = bot.entity.position.floored()
          const next = p.offset(d[0], 0, d[1])
          if (solid(bot.blockAt(next)) || solid(bot.blockAt(next.offset(0, 1, 0)))) break // a wall: the gap is crossed
          if (!solid(bot.blockAt(next.offset(0, -1, 0)))) {
            const item = buildingBlock(bot)
            if (!item) break
            await bot.equip(item, 'hand')
            // Crouch to the edge, look back down at the block we stand on, place against its far side.
            bot.setControlState('sneak', true)
            bot.setControlState('forward', true)
            await sleep(450)
            bot.setControlState('forward', false)
            const under = bot.blockAt(p.offset(0, -1, 0))
            await bot.lookAt(under.position.offset(0.5 + d[0] * 0.5, 0.5, 0.5 + d[1] * 0.5), true)
            await Promise.race([bot.placeBlock(under, new Vec3(d[0], 0, d[1])).catch(() => {}), sleep(700)]) // checked next
            if (!solid(bot.blockAt(next.offset(0, -1, 0)))) break
            placed++
          }
          await stepTo(ctx, next, { sneak: true })
        }
      } finally { bot.clearControlStates() }
      if (!walked) throw new ActionError(buildingBlock(bot) ? 'BLOCKED' : 'MISSING_BLOCKS', buildingBlock(bot) ? 'Could not start the bridge here.' : 'No blocks to bridge with.')
      return `Bridged ${walked} blocks ${dirName} (${placed} placed).`
    }
  }

  /** Put a torch next to us (floor or wall). */
  const torchHere = async (ctx) => {
    const { bot } = ctx
    const torch = findInventoryItem(bot, 'torch')
    if (!torch) return false
    const p = bot.entity.position.floored()
    for (const [dx, dz] of [[0, 0], ...Object.values(DIRS)]) {
      for (const dy of [0, 1]) {
        const cell = p.offset(dx, dy, dz)
        if (dx === 0 && dz === 0 && dy === 0) continue // not where our feet are
        if (!open(bot.blockAt(cell))) continue
        if (!solid(bot.blockAt(cell.offset(0, -1, 0))) && !Object.values(DIRS).some(([ax, az]) => solid(bot.blockAt(cell.offset(ax, 0, az))))) continue
        try { await placeAt(ctx, cell, torch, { clearSoft: false }); return true } catch { /* next spot */ }
      }
    }
    return false
  }

  ACTIONS.placeTorch = {
    description: 'Light up the spot you are in with a torch (stops monsters spawning here).',
    params: {},
    async run (ctx) {
      if (!findInventoryItem(ctx.bot, 'torch')) throw new ActionError('MISSING_ITEM', 'No torches. obtainItem torch (coal or charcoal + a stick).')
      if (!await torchHere(ctx)) throw new ActionError('NO_SPACE', 'Nowhere to put a torch right here.')
      return 'Placed a torch.'
    }
  }

  ACTIONS.shelter = {
    description: 'Get through the night safely without a bed: dig in two blocks, cover your head, wait for morning, then climb out. ' +
      'With a bed (carried or nearby) it sleeps instead.',
    params: { maxMinutes: 'number, optional (default 8)' },
    async run (ctx, args) {
      const { bot, signal } = ctx
      const maxMin = argNumber(args, 'maxMinutes', { min: 1, max: 12, def: 8 })
      const night = () => { const t = bot.time?.timeOfDay ?? 6000; return t > 12500 && t < 23300 }
      const hasBed = bot.inventory.items().some((i) => /_bed$/.test(i.name)) || bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 24 })
      if (hasBed && night()) return ACTIONS.sleepInBed.run(ctx, {})
      const cover = buildingBlock(bot)
      if (!cover) throw new ActionError('MISSING_BLOCKS', 'Need at least one block (dirt, cobblestone...) to cover the hole.')
      const p = bot.entity.position.floored()
      for (const dy of [-1, -2]) {
        const b = bot.blockAt(p.offset(0, dy, 0))
        if (!b || b.boundingBox !== 'block' || hazardAround(bot, p.offset(0, dy, 0))) throw new ActionError('BAD_SPOT', 'Can\'t dig in here (not solid ground, or water/lava close). Try another spot.')
      }
      if (!solid(bot.blockAt(p.offset(0, -3, 0)))) throw new ActionError('BAD_SPOT', 'There\'s a cave right below; dig in somewhere else.')
      await dig(ctx, p.offset(0, -1, 0))
      await sleep(400)
      await dig(ctx, p.offset(0, -2, 0))
      const t0 = Date.now()
      while (bot.entity.position.y > p.y - 1.9 && Date.now() - t0 < 2000) await sleep(50)
      await placeAt(ctx, p, buildingBlock(bot) || cover, { clearSoft: false }).catch(() => {})
      if (findInventoryItem(bot, 'torch')) await torchHere(ctx).catch(() => {})
      ctx.memory?.addEvent('shelter', 'You dug in for the night and covered your head.')
      // Wait for morning (eat when hungry; any interruption ends it).
      const end = Date.now() + maxMin * 60000
      while (night() && Date.now() < end) {
        throwIfAborted(signal)
        await sleep(2000)
      }
      // Morning: open up and climb out.
      await dig(ctx, p).catch(() => {})
      await ACTIONS.climbOut.run(ctx, { maxHeight: 4 }).catch(() => {})
      return night() ? 'Sheltered for a while (still night).' : 'Sheltered until morning and climbed back out.'
    }
  }

  ACTIONS.stripMine = {
    description: 'Mine for an ore the way good players do: staircase down to the best depth for it (this world version), then a 2-high tunnel, ' +
      'checking for lava, mining ores it uncovers and placing torches. Call again to keep going in the same direction.',
    params: { ore: 'diamond|iron|gold|redstone|lapis|copper|coal|emerald (default diamond)', minutes: 'number, optional (default 3)' },
    async run (ctx, args) {
      const { bot } = ctx
      const ore = (args.ore ? argString(args, 'ore') : 'diamond').toLowerCase().replace(/_ore$|^deepslate_/, '')
      if (!NEEDS[ore]) throw new ActionError('INVALID_ARGS', `Unknown ore "${ore}". Use one of: ${Object.keys(NEEDS).join(', ')}.`)
      const need = TIERS.indexOf(NEEDS[ore])
      if (pickTier(bot) < need) throw new ActionError('NO_SUITABLE_TOOL', `${ore} needs at least a ${NEEDS[ore]} pickaxe (obtainItem ${NEEDS[ore]}_pickaxe).`)
      const modern = Boolean(bot.registry.blocksByName.deepslate)
      const targetY = DEPTHS[modern ? 'modern' : 'legacy'][ore]
      const budget = argNumber(args, 'minutes', { min: 0.5, max: 10, def: 3 }) * 60000
      const end = Date.now() + budget
      // Keep the heading between calls.
      const memo = bot._stripMine || (bot._stripMine = { dir: Object.values(DIRS)[Math.floor(Math.random() * 4)] })
      let [dx, dz] = memo.dir
      let dug = 0; let torches = 0; let turns = 0
      const found = {}
      const turn = () => { [dx, dz] = [-dz, dx]; memo.dir = [dx, dz]; turns++ }
      try {
        while (Date.now() < end && turns < 6) {
          throwIfAborted(ctx.signal)
          const p = bot.entity.position.floored()
          const down = p.y > targetY + 1
          const up = p.y < targetY - 3
          const next = p.offset(dx, down ? -1 : up ? 1 : 0, dz)
          const cells = down ? [p.offset(dx, 1, dz), p.offset(dx, 0, dz), next] : up ? [p.offset(0, 2, 0), next.offset(0, 1, 0), next] : [next.offset(0, 1, 0), next]
          let ok = true
          for (const c of cells) { if (!await dig(ctx, c)) { ok = false; break } dug++ }
          if (!ok || !solid(bot.blockAt(next.offset(0, -1, 0))) || DANGER.test(bot.blockAt(next.offset(0, -1, 0))?.name || '')) {
            // Lava/water ahead, bedrock, or a hole: don't go there.
            turn(); continue
          }
          await stepTo(ctx, next)
          // Light the way every ~8 blocks when it's dark.
          const light = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))?.light
          if ((dug % 16 === 0 || (Number.isFinite(light) && light < 4)) && findInventoryItem(bot, 'torch') && !bot.findBlock({ matching: (b) => /torch/.test(b.name), maxDistance: 7 })) {
            if (await torchHere(ctx).catch(() => false)) torches++
          }
          // Ores showing in the walls: take them (with the pickaxe they need).
          const here = bot.entity.position.floored()
          const seen = bot.findBlocks({ matching: (b) => ORES.test(b.name), maxDistance: 4, count: 6 })
            .map((pos) => bot.blockAt(pos))
            .filter((b) => b && [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some((d) => open(bot.blockAt(b.position.offset(...d))))) // only ores it can see
          for (const b of seen) {
            if (b.position.distanceTo(here) > 4.5 || hazardAround(bot, b.position)) continue
            try {
              await dig(ctx, b.position)
              found[b.name] = (found[b.name] || 0) + 1
            } catch (err) { if (err.code === 'ABORTED') throw err }
          }
        }
      } finally { bot.clearControlStates() }
      if (h.collectNearbyDrops) await h.collectNearbyDrops(ctx, bot.entity.position, 6, 6000).catch(() => {})
      const oreText = Object.entries(found).map(([n, c]) => `${c} ${n}`).join(', ') || 'no ores yet'
      return `Strip-mined for ${ore} at y ${Math.floor(bot.entity.position.y)} (best around y ${targetY}): dug ${dug} blocks, ${oreText}${torches ? `, placed ${torches} torches` : ''}${turns >= 6 ? '; kept hitting lava or water, try somewhere else' : ''}.`
    }
  }

  ACTIONS.pickUpBlock = {
    description: 'Break a block you placed yourself (crafting table, furnace, bed...) and pick it up to take it with you. ' +
      'Without x,y,z: the nearest one of blockType you put down.',
    params: { blockType: 'string, optional, e.g. "crafting_table"', x: 'number, optional', y: 'number, optional', z: 'number, optional' },
    async run (ctx, args) {
      const { bot } = ctx
      let pos = [args.x, args.y, args.z].every((n) => Number.isFinite(Number(n))) ? new Vec3(Number(args.x), Number(args.y), Number(args.z)).floored() : null
      const want = args.blockType ? String(args.blockType).toLowerCase().replace(/\s+/g, '_') : null
      if (!pos) {
        const mine = (ctx.places?.placed || []).filter((p) => p.dim === ctx.dimension?.() && (!want || p.name === want))
          .map((p) => new Vec3(p.x, p.y, p.z)).filter((p) => bot.blockAt(p) && bot.blockAt(p).name !== 'air')
          .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
        pos = mine[0] || null
        if (!pos && want && bot.registry.blocksByName[want]) pos = bot.findBlock({ matching: bot.registry.blocksByName[want].id, maxDistance: 8 })?.position || null
      }
      if (!pos) throw new ActionError('NOT_FOUND', `No ${want ? want.replace(/_/g, ' ') : 'block'} of yours around to pick up.`)
      const block = bot.blockAt(pos)
      if (!block || block.boundingBox === 'empty' && !/_bed$|torch/.test(block.name)) { ctx.places?.forget(pos, ctx.dimension?.()); throw new ActionError('NOT_FOUND', 'It is not there any more.') }
      const name = block.name
      const before = bot.inventory.items().filter((i) => i.name === name || (/_bed$/.test(name) && i.name === name)).reduce((a, i) => a + i.count, 0)
      if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4) {
        await gotoGoal(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 2), { timeoutMs: 20000, label: name })
      }
      await equipToolFor(ctx, block).catch(() => {})
      await digWithAbort(ctx, bot.blockAt(pos))
      ctx.places?.forget(pos, ctx.dimension?.())
      if (h.collectNearbyDrops) await h.collectNearbyDrops(ctx, pos.offset(0.5, 0.5, 0.5), 5, 5000, (e) => { try { return e.getDroppedItem()?.name === name } catch { return true } }).catch(() => {})
      const after = bot.inventory.items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0)
      return after > before ? `Picked up your ${name.replace(/_/g, ' ')}.` : `Broke the ${name.replace(/_/g, ' ')}, but it didn't come back to you (wrong tool, or it's lying on the ground).`
    }
  }

  ACTIONS.organizeHotbar = {
    description: 'Tidy your hotbar the way you always keep it: sword, pickaxe, axe, shovel, blocks, torches, bucket, food.',
    params: {},
    async run (ctx) {
      const { bot } = ctx
      const moves = require('./habits').hotbarMoves(bot.inventory.slots)
      if (!moves.length) return 'Hotbar is already tidy.'
      let done = 0
      for (const m of moves) {
        throwIfAborted(ctx.signal)
        try { await bot.moveSlotItem(m.from, m.to); done++ } catch { break }
        await sleep(150 + Math.random() * 250) // dragging items around takes a moment
      }
      return `Tidied the hotbar (${done} moves).`
    }
  }

  Object.assign(SHORT, {
    organizeHotbar: 'tidy the hotbar (sword, pickaxe, axe, shovel, blocks, torches, bucket, food)',
    pickUpBlock: 'take back a block you placed (crafting table, furnace, bed) before leaving',
    shelter: 'get through the night: sleep in a bed, or dig in, cover up and wait for morning',
    pillarUp: 'jump-place blocks under yourself (escape mobs, reach up, get out of a hole)',
    climbOut: 'get out of a pit or hole (pillar up or dig stairs)',
    bridge: 'cross a gap placing blocks in front, crouched',
    stripMine: 'mine for an ore at the best depth (staircase down, tunnel, lava checks, torches)',
    placeTorch: 'light up this spot'
  })
}

module.exports = { install, DEPTHS, NEEDS }
