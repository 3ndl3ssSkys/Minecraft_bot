'use strict'

/**
 * building.js — designs buildings that are the bot's own, fitted to the land.
 *
 * Common building ideas (log frames, gable/hip/A-frame roofs, stilt huts,
 * hillside burrows, stone keeps with battlements, porches, chimneys, lookout
 * towers) are kept as reusable *pieces*. Each plan combines them differently:
 * a seeded generator picks proportions, roof, window rhythm, door side,
 * overhangs and extras from the bot's concept, its personality, the
 * materials it has and the terrain — so no two builds come out the same.
 *
 * The terrain is read first (a heightmap around the bot). The plan then
 * either flattens small bumps, cuts and fills a terrace with a stone skirt,
 * raises the build on stilts over slopes and water (with steps down), or
 * digs into a hillside and covers the roof with earth. A 1-block apron
 * around the footprint is smoothed so the building sits naturally.
 *
 * Output: an ordered list of block removals and placements (supports first),
 * plus a materials list. actions.js executes it a few dozen blocks at a time.
 */

const { Vec3 } = require('vec3')
const { seededRandom } = require('./util')

const CLASSES = {
  PLANKS: (n) => n.endsWith('_planks'),
  LOG: (n) => /_log$/.test(n) && !/stripped/.test(n),
  STONE: (n) => /^(cobblestone|stone|stone_bricks|cobbled_deepslate|deepslate_bricks|andesite|diorite|granite|polished_\w+|blackstone|mossy_cobblestone|sandstone)$/.test(n),
  FENCE: (n) => /_fence$/.test(n) && !/nether_brick/.test(n),
  GLASS: (n) => /^(glass|glass_pane|\w+_stained_glass(_pane)?)$/.test(n),
  DOOR: (n) => /_door$/.test(n) && n !== 'iron_door',
  EARTH: (n) => /^(dirt|grass_block|coarse_dirt|rooted_dirt|podzol|moss_block)$/.test(n)
}

const STYLES = {
  cabin: { noun: 'Cabin', frame: ['spruce_log', 'oak_log', 'dark_oak_log', 'LOG'], wall: ['spruce_planks', 'oak_planks', 'PLANKS'], roof: ['dark_oak_planks', 'spruce_planks', 'PLANKS', 'STONE'], floor: ['spruce_planks', 'oak_planks', 'PLANKS'], foundation: ['cobblestone', 'STONE', 'dirt'], window: ['glass_pane', 'glass', 'GLASS'], wallHeight: [3, 4], roofs: ['gable', 'gable', 'hip'], overhang: [0, 1, 1], porch: 0.6, chimney: 0.5 },
  cottage: { noun: 'Cottage', frame: ['oak_log', 'birch_log', 'LOG'], wall: ['birch_planks', 'oak_planks', 'PLANKS'], roof: ['spruce_planks', 'dark_oak_planks', 'PLANKS'], floor: ['oak_planks', 'PLANKS'], foundation: ['cobblestone', 'stone_bricks', 'STONE', 'dirt'], window: ['glass_pane', 'glass', 'GLASS'], wallHeight: [3, 3, 4], roofs: ['gable', 'hip'], overhang: [1], porch: 0.3, chimney: 0.8 },
  keep: { noun: 'Keep', frame: ['stone_bricks', 'cobblestone', 'STONE'], wall: ['cobblestone', 'stone_bricks', 'STONE'], roof: ['cobblestone', 'stone_bricks', 'STONE'], floor: ['stone_bricks', 'cobblestone', 'STONE', 'PLANKS'], foundation: ['cobblestone', 'STONE'], window: ['glass_pane', 'iron_bars', 'GLASS'], wallHeight: [4, 5], roofs: ['flat'], overhang: [0], battlement: true },
  stilt_hut: { noun: 'Hut', frame: ['LOG'], wall: ['PLANKS'], roof: ['spruce_planks', 'PLANKS'], floor: ['PLANKS'], foundation: ['LOG', 'PLANKS'], window: ['glass_pane', 'GLASS'], wallHeight: [3], roofs: ['aframe', 'gable'], overhang: [1], stilts: true },
  burrow: { noun: 'Burrow', frame: ['cobblestone', 'STONE'], wall: ['cobblestone', 'STONE', 'PLANKS'], roof: ['cobblestone', 'STONE', 'PLANKS'], floor: ['PLANKS', 'cobblestone'], foundation: ['cobblestone', 'STONE', 'dirt'], window: ['glass', 'GLASS'], wallHeight: [3], roofs: ['flat'], overhang: [0], earthCover: true },
  lookout: { noun: 'Lookout', frame: ['LOG', 'STONE'], wall: ['PLANKS', 'cobblestone', 'STONE'], roof: ['PLANKS', 'STONE'], floor: ['PLANKS'], foundation: ['cobblestone', 'STONE'], window: ['glass_pane', 'GLASS'], wallHeight: [7, 8, 10], roofs: ['flat'], overhang: [0], battlement: true, tower: true }
}

const PURPOSES = {
  house: { styles: ['cabin', 'cottage', 'cabin', 'keep'], size: 'medium', furniture: ['crafting_table', 'furnace', 'chest', 'bed', 'torch', 'torch'] },
  shelter: { styles: ['burrow', 'cabin'], size: 'small', furniture: ['torch', 'crafting_table'] },
  storage: { styles: ['cabin', 'keep'], size: 'small', furniture: ['chest', 'chest', 'chest', 'chest', 'torch'] },
  workshop: { styles: ['cabin', 'keep'], size: 'medium', furniture: ['crafting_table', 'furnace', 'furnace', 'chest', 'torch', 'torch'] },
  lookout: { styles: ['lookout'], size: 'small', furniture: ['torch'] },
  hut: { styles: ['stilt_hut', 'cabin'], size: 'small', furniture: ['crafting_table', 'torch'] }
}

const SIZES = { small: [[5, 6], [5, 6]], medium: [[7, 9], [6, 8]], large: [[9, 12], [8, 10]] }
const PHASES = ['clear', 'foundation', 'floor', 'frame', 'walls', 'roof', 'details']
const PLAYER_MADE = /planks|glass|bricks|wool|concrete|terracotta|chest|furnace|crafting_table|_door|fence|torch|_bed|_slab|_stairs|lantern|barrel|bookshelf|carpet|sign/
const SOFT = /^(air|cave_air|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|\w+_flower|dandelion|poppy|azure_bluet|oxeye_daisy|cornflower|allium|\w+_tulip|lily_of_the_valley|sweet_berry_bush|sugar_cane|seagrass|tall_seagrass|kelp|kelp_plant|water)$/

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** Ground height and features for every column in a square around (cx, cz). */
function readTerrain (bot, cx, cy, cz, radius) {
  const map = new Map()
  for (let x = cx - radius; x <= cx + radius; x++) {
    for (let z = cz - radius; z <= cz + radius; z++) {
      let ground = null; let tree = false; let water = false; let made = false
      for (let y = cy + 14; y >= cy - 20; y--) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b) continue
        if (/_log$|_leaves$|mushroom_block/.test(b.name)) { tree = true; continue }
        if (/water|lava/.test(b.name)) { water = true; continue }
        if (PLAYER_MADE.test(b.name)) made = true
        if (b.boundingBox === 'block') { ground = y; break }
      }
      if (ground !== null) map.set(`${x},${z}`, { ground, tree, water, made })
    }
  }
  return map
}

function stats (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
  return { min: sorted[0], max: sorted[sorted.length - 1], median: sorted[Math.floor(sorted.length / 2)], low: sorted[Math.floor(sorted.length / 4)], mean, sd }
}

/** Best spot near the bot for a w×d footprint. */
function findSite (bot, terrain, w, d, style, center, dangerCost) {
  let best = null
  for (let ox = center.x - 18; ox <= center.x + 18 - w; ox += 2) {
    for (let oz = center.z - 18; oz <= center.z + 18 - d; oz += 2) {
      const heights = []; let water = 0; let trees = 0; let made = 0; let missing = 0
      for (let x = ox - 1; x <= ox + w; x++) {
        for (let z = oz - 1; z <= oz + d; z++) {
          const c = terrain.get(`${x},${z}`)
          if (!c) { missing++; continue }
          const inside = x >= ox && x < ox + w && z >= oz && z < oz + d
          if (c.made) made++
          if (inside) { heights.push(c.ground); if (c.water) water++; if (c.tree) trees++ }
        }
      }
      if (made || missing > 2 || heights.length < w * d * 0.8) continue // never build over someone else's stuff
      const st = stats(heights)
      const range = st.max - st.min
      const distance = Math.hypot(ox + w / 2 - center.x, oz + d / 2 - center.z)
      let score = range * 2 + st.sd * 3 + trees * 0.4 + distance * 0.08 + (dangerCost?.(ox, st.median, oz) || 0)
      score += style.stilts ? -Math.min(range, 6) * 0.5 : water * 3
      if (style.earthCover) score += range >= 3 ? -4 : 6 // burrows want a hillside
      if (!best || score < best.score) best = { ox, oz, score, st, range, water, trees }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function inventoryCounts (bot) {
  const counts = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
  return counts
}

function expand (candidate, registry) {
  if (!CLASSES[candidate]) return registry.blocksByName[candidate] ? [candidate] : []
  return registry.blocksArray.map((b) => b.name).filter(CLASSES[candidate])
}

/** Choose the material for a role: what we have enough of, else what we have most of, else the first idea. */
function chooseMaterial (candidates, inv, registry, need) {
  const options = [...new Set(candidates.flatMap((c) => expand(c, registry)))]
  const have = options.filter((n) => inv[n] > 0).sort((a, b) => inv[b] - inv[a])
  return have.find((n) => inv[n] >= need) || have[0] || options[0]
}

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

function styleFromConcept (concept, purpose, rng) {
  const c = String(concept || '').toLowerCase()
  if (/tower|lookout|watch/.test(c)) return 'lookout'
  if (/stone|castle|keep|fort/.test(c)) return 'keep'
  if (/stilt|water|lake|river|swamp|tree ?house/.test(c)) return 'stilt_hut'
  if (/bunker|burrow|hill|cave|hobbit|underground/.test(c)) return 'burrow'
  if (/cottage|cozy|cute/.test(c)) return 'cottage'
  if (/cabin|log|wood/.test(c)) return 'cabin'
  const opts = (PURPOSES[purpose] || PURPOSES.house).styles
  return opts[Math.floor(rng() * opts.length)]
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)]
const between = (rng, [a, b]) => a + Math.floor(rng() * (b - a + 1))

/**
 * Plan a building near the bot.
 * @param bot mineflayer bot
 * @param opts { purpose, concept, size, owner }
 * @param helpers { dangerCost(x,y,z) }
 */
function planBuilding (bot, opts = {}, helpers = {}) {
  const purpose = PURPOSES[opts.purpose] ? opts.purpose : 'house'
  const p = bot.entity.position.floored()
  const seedText = `${bot.username}|${opts.concept || ''}|${p.x},${p.z}|${Date.now() >> 16}`
  const rng = seededRandom(seedText)
  const styleName = styleFromConcept(opts.concept, purpose, rng)
  // Skill shapes ambition: a beginner builds a box; a master adds every touch.
  const cx = Number.isFinite(opts.complexity) ? opts.complexity : 7
  const style = { ...STYLES[styleName] }
  if (cx < 1) Object.assign(style, { roofs: ['flat'], overhang: [0], porch: 0, chimney: 0, battlement: false, wallHeight: [3] })
  else if (cx < 2) Object.assign(style, { roofs: style.roofs.includes('gable') ? ['flat', 'gable'] : style.roofs, overhang: [0], porch: 0, chimney: 0 })
  else if (cx < 3) Object.assign(style, { roofs: style.roofs.filter((r) => r !== 'hip').length ? style.roofs.filter((r) => r !== 'hip') : ['gable'], porch: (style.porch || 0) / 2, chimney: 0 })
  else if (cx >= 6) Object.assign(style, { porch: style.porch ? 0.9 : 0, chimney: style.chimney ? 0.9 : 0 })
  let sizeName = SIZES[opts.size] ? opts.size : PURPOSES[purpose].size
  if (cx < 2) sizeName = 'small'
  else if (cx < 4 && sizeName === 'large') sizeName = 'medium'
  let w = style.tower ? 5 : between(rng, SIZES[sizeName][0])
  let d = style.tower ? 5 : between(rng, SIZES[sizeName][1])
  if (rng() < 0.5) [w, d] = [d, w]

  const terrain = readTerrain(bot, p.x, p.y, p.z, 20)
  const site = findSite(bot, terrain, w, d, style, p, helpers.dangerCost)
  if (!site) return { ok: false, reason: 'No buildable spot nearby (too steep, too much water, or someone else\'s builds in the way).' }

  // --- How to meet the ground.
  let mode
  let floorY
  if (style.stilts || site.water > 0 || site.range > 4) {
    mode = style.earthCover && site.range > 2 && site.water === 0 ? 'dig-in' : 'stilts'
  } else if (style.earthCover && site.range >= 2) {
    mode = 'dig-in'
  } else {
    mode = site.range <= 1 ? 'flat' : 'terrace'
  }
  if (mode === 'stilts') floorY = site.st.max + (site.water ? 2 : 1)
  else if (mode === 'dig-in') floorY = site.st.low
  else floorY = site.st.median

  const h = style.tower ? between(rng, [style.wallHeight[0], style.wallHeight[style.wallHeight.length - 1]]) : pick(rng, style.wallHeight)
  const roof = pick(rng, style.roofs)
  const ov = roof === 'flat' ? 0 : pick(rng, style.overhang)
  const x0 = site.ox; const z0 = site.oz; const x1 = site.ox + w - 1; const z1 = site.oz + d - 1
  const yTop = floorY + (roof === 'aframe' ? 1 : h)

  // Door faces the lowest, most open side (or towards where the bot is).
  const sides = [
    { name: 'north', dz: -1, coord: z0 - 1, along: 'x' }, { name: 'south', dz: 1, coord: z1 + 1, along: 'x' },
    { name: 'west', dx: -1, coord: x0 - 1, along: 'z' }, { name: 'east', dx: 1, coord: x1 + 1, along: 'z' }
  ].map((s) => {
    const cells = s.along === 'x' ? range(x0, x1).map((x) => terrain.get(`${x},${s.coord}`)) : range(z0, z1).map((z) => terrain.get(`${s.coord},${z}`))
    const g = cells.filter(Boolean).map((c) => Math.abs(c.ground - floorY))
    const toBot = s.along === 'x' ? Math.sign(p.z - (z0 + z1) / 2) === (s.dz || 0) : Math.sign(p.x - (x0 + x1) / 2) === (s.dx || 0)
    return { ...s, score: (g.length ? g.reduce((a, b) => a + b, 0) / g.length : 9) - (toBot ? 0.8 : 0) + rng() * 0.3 }
  }).sort((a, b) => a.score - b.score)
  const front = sides[0]
  const back = sides.find((s) => (s.dz && s.dz === -front.dz) || (s.dx && s.dx === -front.dx))

  // --- Pieces → cells.
  const cells = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const put = (x, y, z, role, phase, extra = {}) => cells.set(key(x, y, z), { x, y, z, role, phase, ...extra })
  const air = (x, y, z, phase = 'clear') => cells.set(key(x, y, z), { x, y, z, remove: true, phase })
  const groundAt = (x, z) => terrain.get(`${x},${z}`)?.ground ?? floorY - 1

  // Clear the volume (trees, hill) and smooth a 1-block apron.
  const roofHeight = roof === 'flat' ? 2 : Math.ceil(Math.min(w, d) / 2) + 2
  for (let x = x0 - 1 - ov; x <= x1 + 1 + ov; x++) {
    for (let z = z0 - 1 - ov; z <= z1 + 1 + ov; z++) {
      const inside = x >= x0 && x <= x1 && z >= z0 && z <= z1
      const apron = !inside && x >= x0 - 1 && x <= x1 + 1 && z >= z0 - 1 && z <= z1 + 1
      const top = Math.max(groundAt(x, z) + 6, yTop + roofHeight)
      for (let y = floorY + 1; y <= top; y++) if (inside || apron || y >= yTop) air(x, y, z)
      if (mode !== 'stilts' && mode !== 'dig-in' && apron) {
        // Terrain reformation: fill shallow dips around the build up to floor level.
        const g = groundAt(x, z)
        if (g < floorY && floorY - g <= 2) for (let y = g + 1; y <= floorY; y++) put(x, y, z, 'foundation', 'foundation')
      }
    }
  }

  // Foundation / stilts.
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const g = groundAt(x, z)
      if (mode === 'stilts') {
        const edge = x === x0 || x === x1 || z === z0 || z === z1
        const post = (x === x0 || x === x1 || (x - x0) % 3 === 0) && (z === z0 || z === z1 || (z - z0) % 3 === 0)
        if (edge && post) for (let y = g + 1; y < floorY; y++) put(x, y, z, 'frame', 'foundation')
      } else {
        for (let y = g + 1; y < floorY; y++) put(x, y, z, 'foundation', 'foundation')
      }
      put(x, floorY, z, 'floor', 'floor')
    }
  }

  // Frame (corner posts) and walls with window rhythm.
  const wallTop = roof === 'aframe' ? floorY + 1 : yTop
  const rhythm = cx < 1 ? 99 : cx < 2 ? 3 : pick(rng, [2, 3]) // no windows at all for a first box
  const offset = Math.floor(rng() * rhythm)
  const tallWindows = h >= 4 && rng() < 0.5
  const doorAlong = front.along === 'x' ? Math.round((x0 + x1) / 2 + (rng() < 0.5 ? 0 : (rng() < 0.5 ? -1 : 1))) : Math.round((z0 + z1) / 2 + (rng() < 0.5 ? 0 : (rng() < 0.5 ? -1 : 1)))
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const edgeX = x === x0 || x === x1
      const edgeZ = z === z0 || z === z1
      if (!edgeX && !edgeZ) continue
      const corner = edgeX && edgeZ
      for (let y = floorY + 1; y <= wallTop; y++) {
        if (corner) { put(x, y, z, 'frame', 'frame'); continue }
        const along = edgeZ ? x : z
        const onFront = (front.along === 'x' && z === (front.dz < 0 ? z0 : z1) && edgeZ) || (front.along === 'z' && x === (front.dx < 0 ? x0 : x1) && edgeX)
        if (onFront && along === doorAlong && y <= floorY + 2) { air(x, y, z, 'walls'); continue }
        const windowRow = y === floorY + 2 || (tallWindows && y === floorY + 3)
        const nearDoor = onFront && Math.abs(along - doorAlong) <= 1
        const sideLen = edgeZ ? x1 - x0 : z1 - z0
        if (windowRow && !nearDoor && (along - (edgeZ ? x0 : z0) + offset) % rhythm === 0 && along !== (edgeZ ? x0 : z0) && along !== (edgeZ ? x1 : z1) && sideLen >= 3 && roof !== 'aframe') {
          put(x, y, z, 'window', 'walls')
        } else {
          put(x, y, z, 'wall', 'walls')
        }
      }
    }
  }
  // Keep the interior empty.
  for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) for (let y = floorY + 1; y <= wallTop; y++) air(x, y, z, 'clear')

  // Roof.
  const ridgeAlongX = w >= d
  if (roof === 'flat') {
    for (let x = x0 - ov; x <= x1 + ov; x++) for (let z = z0 - ov; z <= z1 + ov; z++) put(x, yTop + 1, z, 'roof', 'roof')
    if (style.battlement) {
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        if ((x === x0 || x === x1 || z === z0 || z === z1) && (x + z) % 2 === 0) put(x, yTop + 2, z, 'frame', 'roof')
      }
    }
    if (style.earthCover) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) put(x, yTop + 2, z, 'earth', 'roof')
  } else if (roof === 'hip') {
    for (let i = 0; ; i++) {
      const ax = x0 - ov + i; const bx = x1 + ov - i; const az = z0 - ov + i; const bz = z1 + ov - i
      if (ax > bx || az > bz) break
      for (let x = ax; x <= bx; x++) {
        for (let z = az; z <= bz; z++) {
          const ring = x === ax || x === bx || z === az || z === bz
          const inner = x === ax + 1 || x === bx - 1 || z === az + 1 || z === bz - 1
          if (ring || inner || bx - ax <= 2 || bz - az <= 2) put(x, yTop + 1 + i, z, 'roof', 'roof')
        }
      }
    }
  } else {
    // Gable / A-frame: two-thick stepped slopes so every step is supported.
    const [a0, a1, b0, b1] = ridgeAlongX ? [x0, x1, z0, z1] : [z0, z1, x0, x1]
    for (let i = 0; ; i++) {
      const lo = b0 - ov + i; const hi = b1 + ov - i
      if (lo > hi) break
      const y = yTop + 1 + i
      for (let a = a0 - ov; a <= a1 + ov; a++) {
        const slope = hi - lo <= 2 ? range(lo, hi) : [lo, lo + 1, hi - 1, hi]
        for (const b of slope) {
          const [x, z] = ridgeAlongX ? [a, b] : [b, a]
          put(x, y, z, 'roof', 'roof')
        }
        // Gable end triangles.
        if (a === a0 || a === a1) {
          for (let b = lo + 2; b <= hi - 2; b++) {
            const [x, z] = ridgeAlongX ? [a, b] : [b, a]
            put(x, y, z, 'wall', 'roof')
          }
        }
      }
    }
  }

  // Extras.
  const extras = []
  const frontCells = front.along === 'x' ? { z: front.dz < 0 ? z0 - 1 : z1 + 1, x: doorAlong } : { x: front.dx < 0 ? x0 - 1 : x1 + 1, z: doorAlong }
  if (mode === 'stilts' || floorY - groundAt(frontCells.x, frontCells.z) > 1) {
    // Steps down from the door to the ground.
    let k = 1
    for (let y = floorY - 1; y > groundAt(frontCells.x + (front.dx || 0) * k, frontCells.z + (front.dz || 0) * k) && k < 8; y--, k++) {
      const sx = frontCells.x + (front.dx || 0) * (k - 1)
      const sz = frontCells.z + (front.dz || 0) * (k - 1)
      put(sx, y + 1, sz, 'foundation', 'details')
      for (let fy = groundAt(sx, sz) + 1; fy <= y; fy++) put(sx, fy, sz, 'foundation', 'details')
    }
    extras.push('steps down to the ground')
  } else {
    put(frontCells.x, floorY, frontCells.z, 'floor', 'details')
  }
  if (style.porch && rng() < style.porch && mode !== 'stilts') {
    const half = 1 + Math.floor(rng() * 2)
    for (let s = -half; s <= half; s++) {
      for (let depth = 1; depth <= 2; depth++) {
        const x = front.along === 'x' ? doorAlong + s : (front.dx < 0 ? x0 - depth : x1 + depth)
        const z = front.along === 'x' ? (front.dz < 0 ? z0 - depth : z1 + depth) : doorAlong + s
        put(x, floorY, z, 'floor', 'details')
        if (Math.abs(s) === half && depth === 2) { put(x, floorY + 1, z, 'fence', 'details', { optional: true }); put(x, floorY + 2, z, 'fence', 'details', { optional: true }) }
      }
    }
    extras.push('porch')
  }
  if (style.chimney && rng() < style.chimney && roof !== 'flat') {
    const cx = back.along === 'x' ? (rng() < 0.5 ? x0 + 1 : x1 - 1) : (back.dx < 0 ? x0 - 1 : x1 + 1)
    const cz = back.along === 'x' ? (back.dz < 0 ? z0 - 1 : z1 + 1) : (rng() < 0.5 ? z0 + 1 : z1 - 1)
    for (let y = groundAt(cx, cz) + 1; y <= yTop + roofHeight + 1; y++) put(cx, y, cz, 'accent', 'details')
    extras.push('chimney')
  }
  // Lookout: ladder up the inside of the back wall and a hatch in the roof.
  if (style.tower) {
    const lx = back.along === 'x' ? Math.round((x0 + x1) / 2) : (back.dx < 0 ? x0 + 1 : x1 - 1)
    const lz = back.along === 'x' ? (back.dz < 0 ? z0 + 1 : z1 - 1) : Math.round((z0 + z1) / 2)
    for (let y = floorY + 1; y <= yTop + 1; y++) put(lx, y, lz, 'ladder', 'details')
    extras.push('ladder to a battlemented top')
  }

  // Furniture along the back wall.
  const furniture = (PURPOSES[purpose].furniture || []).slice(0, cx < 1 ? 1 : Math.max(1, Math.min(w, d) - 1))
  const inside = []
  for (let x = x0 + 1; x < x1; x++) for (let z = z0 + 1; z < z1; z++) inside.push({ x, z })
  const backCells = inside.filter((c) => back.along === 'x' ? c.z === (back.dz < 0 ? z0 + 1 : z1 - 1) : c.x === (back.dx < 0 ? x0 + 1 : x1 - 1))
  furniture.forEach((f, i) => {
    const c = f === 'torch' ? inside[Math.floor(rng() * inside.length)] : backCells[i % Math.max(1, backCells.length)]
    if (c && !cells.get(key(c.x, floorY + 1, c.z))?.role) put(c.x, floorY + 1, c.z, f, 'details', { optional: true, fixed: f })
  })

  // --- Materials (now that we know how much of each role we need).
  const registry = bot.registry
  const inv = inventoryCounts(bot)
  const roleNeeds = {}
  for (const c of cells.values()) if (!c.remove && !c.fixed) roleNeeds[c.role] = (roleNeeds[c.role] || 0) + 1
  const candidates = {
    frame: style.frame, wall: style.wall, roof: style.roof, floor: style.floor, foundation: style.foundation,
    window: style.window, accent: ['cobblestone', 'STONE', 'bricks'], earth: ['dirt', 'EARTH'], fence: ['oak_fence', 'FENCE'], ladder: ['ladder']
  }
  const palette = {}
  for (const role of Object.keys(roleNeeds)) palette[role] = chooseMaterial(candidates[role] || [role], inv, registry, roleNeeds[role])
  // A little personality: sometimes an accent frame of a different wood.
  if (rng() < (cx >= 6 ? 0.6 : cx >= 3 ? 0.3 : 0) && /_log$/.test(palette.frame || '')) {
    const alt = expand('LOG', registry).filter((n) => n !== palette.frame && inv[n] > 4)[0]
    if (alt) palette.frame = alt
  }

  // --- Order: phases in sequence, supports before what hangs off them.
  const steps = orderSteps(bot, [...cells.values()])
  const materials = {}
  for (const s of steps) if (!s.remove && !s.optional) { const m = s.fixed || palette[s.role]; materials[m] = (materials[m] || 0) + 1 }
  const missing = {}
  for (const [m, n] of Object.entries(materials)) if ((inv[m] || 0) < n) missing[m] = n - (inv[m] || 0)

  const biome = safe(() => bot.blockAt(new Vec3(x0, floorY, z0))?.biome?.name) || ''
  const adjective = site.water ? pick(rng, ['Lakeside', 'Riverside', 'Marsh']) : site.range > 3 ? pick(rng, ['Hillside', 'Cliffside', 'Ridge']) :
    site.trees > 4 ? pick(rng, ['Forest', 'Woodland', 'Grove']) : /snow|ice|frozen/.test(biome) ? 'Snowy' : /desert|badlands/.test(biome) ? 'Dune' : pick(rng, ['Meadow', 'Quiet', 'Sunny', 'Old'])
  const name = opts.name || `${bot.username}'s ${adjective} ${style.noun}`

  return {
    ok: true,
    plan: {
      id: `${Date.now().toString(36)}`,
      name,
      purpose,
      concept: opts.concept || '',
      owner: opts.owner || bot.username,
      style: styleName,
      origin: { x: x0, y: floorY, z: z0 },
      size: { w, d, h },
      roof,
      overhang: ov,
      mode,
      front: front.name,
      extras,
      palette,
      candidates,
      steps,
      cursor: 0,
      placed: 0,
      failed: 0,
      materials,
      missing,
      createdAt: Date.now()
    }
  }
}

/** Sort steps: by phase; removals top-down; placements only after something solid is next to them. */
function orderSteps (bot, cells) {
  const out = []
  const solid = new Set()
  const k = (c) => `${c.x},${c.y},${c.z}`
  const removed = new Set(cells.filter((c) => c.remove).map(k))
  const isSolid = (x, y, z) => {
    const key = `${x},${y},${z}`
    if (solid.has(key)) return true
    if (removed.has(key)) return false
    const b = bot.blockAt(new Vec3(x, y, z))
    return Boolean(b && b.boundingBox === 'block')
  }
  for (const phase of PHASES) {
    const group = cells.filter((c) => c.phase === phase)
    // Only removals that actually have something to dig (most of the clearing volume is air already).
    const removals = group.filter((c) => {
      if (!c.remove) return false
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z))
      return b && !/^(air|cave_air|void_air)$/.test(b.name)
    }).sort((a, b) => b.y - a.y)
    out.push(...removals)
    let pending = group.filter((c) => !c.remove).sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z)
    while (pending.length) {
      const next = []
      for (const c of pending) {
        const supported = isSolid(c.x, c.y - 1, c.z) || isSolid(c.x + 1, c.y, c.z) || isSolid(c.x - 1, c.y, c.z) ||
          isSolid(c.x, c.y, c.z + 1) || isSolid(c.x, c.y, c.z - 1) || isSolid(c.x, c.y + 1, c.z)
        if (supported) { out.push(c); solid.add(k(c)) } else next.push(c)
      }
      if (next.length === pending.length) { out.push(...next); break } // floating bits: try anyway, last
      pending = next
    }
  }
  return out
}

function range (a, b) {
  const out = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

function safe (fn) { try { return fn() } catch { return undefined } }

/** Material for a role right now, switching to something we actually have if needed. */
function materialFor (plan, step, bot) {
  if (step.fixed) return step.fixed
  const inv = inventoryCounts(bot)
  const current = plan.palette[step.role]
  if (inv[current] > 0) return current
  const options = (plan.candidates[step.role] || []).flatMap((c) => expand(c, bot.registry))
  const alt = options.find((n) => inv[n] > 0)
  if (alt) { plan.palette[step.role] = alt; return alt }
  return null
}

function remaining (plan, bot) {
  const counts = {}
  for (let i = plan.cursor; i < plan.steps.length; i++) {
    const s = plan.steps[i]
    if (s.remove || s.optional) continue
    const m = s.fixed || plan.palette[s.role]
    counts[m] = (counts[m] || 0) + 1
  }
  const inv = inventoryCounts(bot)
  const missing = {}
  for (const [m, n] of Object.entries(counts)) if ((inv[m] || 0) < n) missing[m] = n - (inv[m] || 0)
  return { counts, missing }
}

function describePlan (plan) {
  const { w, d, h } = plan.size
  const done = Math.round((plan.cursor / Math.max(1, plan.steps.length)) * 100)
  return `${plan.name} at (${plan.origin.x}, ${plan.origin.y}, ${plan.origin.z}): ${w}×${d}, ${h} high, ${plan.roof} roof, ` +
    `${plan.palette.frame || '?'} frame / ${plan.palette.wall || '?'} walls / ${plan.palette.roof || '?'} roof, ${plan.mode} foundation` +
    `${plan.extras.length ? `, ${plan.extras.join(', ')}` : ''}, door facing ${plan.front}. ${done}% built (${plan.cursor}/${plan.steps.length} steps).`
}

module.exports = { planBuilding, materialFor, remaining, describePlan, inventoryCounts, STYLES, PURPOSES, SOFT, CLASSES }
