'use strict'

/**
 * redstone.js — understanding redstone the way a technical player does: what a circuit computes, how fast, what it
 * costs, and whether a smaller or cheaper circuit would do the same job.
 *
 * A circuit is a list of parts with Minecraft block names and block-state properties, so the same list can be read
 * from the world, simulated, improved and placed:
 *   { x, y, z, block: 'redstone_wire'|'redstone_torch'|'redstone_wall_torch'|'repeater'|'comparator'|'observer'|
 *     'lever'|'stone_button'|'redstone_block'|'redstone_lamp'|'piston'|'sticky_piston'|<any solid block>,
 *     facing?, delay?, mode?, face?, name? ('A', 'B'... for inputs, 'Q'... for outputs) }
 *
 * The simulator works in redstone ticks (0.1 s) with the vanilla rules that matter for logic:
 *   - dust carries 15 and loses 1 per block, goes up and down steps, is cut by a solid block above a step;
 *     a dust line powers the blocks it points into and the block under it (weakly);
 *   - solid blocks are strongly powered by a torch under them, a repeater/comparator/observer facing into them, or a
 *     lever/button on them; strongly powered blocks power dust around them, weakly powered ones only components;
 *   - a torch is off while the block it hangs on is powered (1 tick to switch) and powers the block above it;
 *   - repeaters: 1–4 ticks, read their back, output 15 forward; comparators: compare or subtract (rear vs sides);
 *   - observers pulse for 1 tick when the block they watch changes; buttons give a 10-tick pulse.
 * Not modelled: quasi-connectivity, update order, container signal strength, piston block movement. It is a
 * logic-level model: good for gates, clocks, latches and timing, not for flying machines.
 */

const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const HORIZ = ['north', 'south', 'east', 'west']
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const key = (x, y, z) => `${x},${y},${z}`
const add = (p, d) => ({ x: p.x + DIRS[d][0], y: p.y + DIRS[d][1], z: p.z + DIRS[d][2] })

const OUTPUT = /redstone_lamp|piston|_door$|_trapdoor$|dispenser|dropper|note_block|powered_rail|activator_rail|^tnt$|bell|_fence_gate$/
const SOURCE = /^(lever|redstone_block)$|_button$|_pressure_plate$/
const NON_CONDUCTOR = /glass|leaves|_slab$|_stairs$|ice|redstone|repeater|comparator|observer|piston|lever|_button$|torch|lamp|hopper|_pressure_plate$|air|water|lava|_fence|_wall$|_door$|_trapdoor$|carpet|rail/

/** Materials and footprint, to say which of two circuits that do the same job is better. */
const COST = { redstone_wire: 1, redstone_torch: 2, redstone_wall_torch: 2, repeater: 6, comparator: 9, observer: 9, redstone_block: 9, piston: 6, sticky_piston: 8, block: 0.25 }
const isDiode = (b) => b === 'repeater' || b === 'comparator'
const isTorch = (b) => b === 'redstone_torch' || b === 'redstone_wall_torch'
const isConductor = (b) => !NON_CONDUCTOR.test(b) && !OUTPUT.test(b)

/** Which block a torch, lever or button hangs on. */
function attachedTo (p) {
  if (p.block === 'redstone_torch') return add(p, 'down')
  if (p.block === 'redstone_wall_torch') return add(p, OPP[p.facing])
  if (p.block === 'lever' || /_button$/.test(p.block)) {
    if (p.face === 'ceiling') return add(p, 'up')
    if (p.face === 'wall') return add(p, OPP[p.facing])
    return add(p, 'down')
  }
  return null
}

class Circuit {
  constructor (parts) {
    this.parts = parts.map((p) => ({ ...p }))
    this.at = new Map(this.parts.map((p) => [key(p.x, p.y, p.z), p]))
    for (const p of this.parts) {
      if (isTorch(p.block)) p.lit = p.lit ?? true
      if (isDiode(p.block)) p.out = p.out ?? 0
      if (p.block === 'observer') p.out = 0
      if (SOURCE.test(p.block) && p.block !== 'redstone_block') p.on = p.on ?? false
    }
    this.time = 0
    this.pending = [] // { part, field, value, at }
  }

  get (pos) { return this.at.get(key(pos.x, pos.y, pos.z)) || null }
  solid (pos) { const p = this.get(pos); return Boolean(p && isConductor(p.block)) }
  inputs () { return this.parts.filter((p) => SOURCE.test(p.block) && p.block !== 'redstone_block').sort((a, b) => (a.name || '').localeCompare(b.name || '')) }
  outputs () { return this.parts.filter((p) => OUTPUT.test(p.block)).sort((a, b) => (a.name || '').localeCompare(b.name || '')) }

  // --- what dust connects to, and which way a dust line points ---------------------------------------------------
  dustLinks (p) {
    const out = []
    for (const d of HORIZ) {
      const n = this.get(add(p, d))
      if (n) {
        if (n.block === 'redstone_wire') { out.push({ d, n }); continue }
        if (isTorch(n.block) || SOURCE.test(n.block) || n.block === 'redstone_block') { out.push({ d, n }); continue }
        if (isDiode(n.block) && (n.facing === OPP[d] || n.facing === d)) { out.push({ d, n }); continue } // its front or back
        if (n.block === 'observer' && n.facing === d) { out.push({ d, n }); continue } // its back faces the dust
      }
      // step up: dust one up and over, if nothing solid sits above this dust
      const up = this.get(add(add(p, d), 'up'))
      if (up?.block === 'redstone_wire' && !this.solid(add(p, 'up'))) { out.push({ d, n: up }); continue }
      // step down: dust one down and over, if the block beside is not solid
      const down = this.get(add(add(p, d), 'down'))
      if (down?.block === 'redstone_wire' && !this.solid(add(p, d))) out.push({ d, n: down })
    }
    return out
  }

  /** Directions a dust spot pushes power into (besides down). */
  dustPoints (p) {
    const links = this.dustLinks(p).map((l) => l.d)
    if (!links.length) return HORIZ
    if (links.length === 1) return [links[0], OPP[links[0]]]
    return links
  }

  // --- one consistent power state for the current torch/diode/lever states ---------------------------------------
  settle () {
    const dust = new Map()
    const strong = new Set()
    const weak = new Set()
    // Strong power into blocks from torches below, diodes/observers facing in, levers and buttons on them.
    const strongInto = (pos) => {
      const below = this.get(add(pos, 'down'))
      if (below && isTorch(below.block) && below.lit) return true
      for (const d of Object.keys(DIRS)) {
        const n = this.get(add(pos, d))
        if (!n) continue
        if ((isDiode(n.block) || n.block === 'observer') && n.out > 0 && n.facing === d) return true // facing points back at its input: d from pos to n equals n.facing means n outputs toward pos
        if ((n.block === 'lever' || /_button$|_pressure_plate$/.test(n.block)) && n.on) { const a = attachedTo(n); if (a.x === pos.x && a.y === pos.y && a.z === pos.z) return true }
      }
      return false
    }
    for (const p of this.parts) if (isConductor(p.block) && strongInto(p)) strong.add(p)
    // Dust: direct sources first, then spread with decay.
    const direct = (p) => {
      let lvl = 0
      for (const d of Object.keys(DIRS)) {
        const n = this.get(add(p, d))
        if (!n) continue
        if (isTorch(n.block) && n.lit && !(d === 'down' && false)) lvl = 15
        if ((n.block === 'lever' || /_button$|_pressure_plate$/.test(n.block)) && n.on) lvl = 15
        if (n.block === 'redstone_block') lvl = 15
        if ((isDiode(n.block) || n.block === 'observer') && n.facing === d && n.out > 0) lvl = Math.max(lvl, n.out)
        if (isConductor(n.block) && strong.has(n)) lvl = 15
      }
      return lvl
    }
    const wires = this.parts.filter((p) => p.block === 'redstone_wire')
    for (const w of wires) dust.set(w, direct(w))
    let changed = true
    let guard = 0
    while (changed && guard++ < 64) {
      changed = false
      for (const w of wires) {
        let lvl = dust.get(w)
        for (const { n } of this.dustLinks(w)) if (n.block === 'redstone_wire') lvl = Math.max(lvl, (dust.get(n) || 0) - 1)
        if (lvl !== dust.get(w)) { dust.set(w, lvl); changed = true }
      }
    }
    // Weak power: dust on top of a block, or a dust line pointing into it.
    for (const w of wires) {
      if (!dust.get(w)) continue
      const below = this.get(add(w, 'down'))
      if (below && isConductor(below.block)) weak.add(below)
      for (const d of this.dustPoints(w)) { const n = this.get(add(w, d)); if (n && isConductor(n.block)) weak.add(n) }
    }
    this.state = { dust, strong, weak }
    return this.state
  }

  /** Signal level a component at `pos` receives from direction d (the neighbour at pos+d). */
  levelFrom (pos, d, { sidesOnly = false } = {}) {
    const n = this.get(add(pos, d))
    if (!n) return 0
    const { dust, strong, weak } = this.state
    if (n.block === 'redstone_wire') return this.dustPoints(n).includes(OPP[d]) || this.dustLinks(n).some((l) => l.d === OPP[d]) ? dust.get(n) || 0 : 0
    if (n.block === 'redstone_block') return 15
    if (isDiode(n.block) || n.block === 'observer') return n.facing === d ? n.out : 0 // only its front feeds us
    if (sidesOnly) return 0
    if (isTorch(n.block) && n.lit) { const a = attachedTo(n); return a.x === pos.x && a.y === pos.y && a.z === pos.z ? 0 : 15 }
    if ((n.block === 'lever' || /_button$|_pressure_plate$/.test(n.block)) && n.on) return 15
    if (isConductor(n.block) && (strong.has(n) || weak.has(n))) return 15
    return 0
  }

  /** Is a block (a torch's support) powered at all? */
  blockPowered (b) { return Boolean(b && (this.state.strong.has(b) || this.state.weak.has(b))) }

  /** Does an output (lamp, piston, door...) receive power? */
  outputOn (p) { return Object.keys(DIRS).some((d) => this.levelFrom(p, d) > 0) }

  /** What each delayed part wants to become, given the settled state. */
  targets () {
    const out = []
    for (const p of this.parts) {
      if (isTorch(p.block)) {
        const a = this.get(attachedTo(p))
        out.push({ p, field: 'lit', value: !this.blockPowered(a), delay: 1 })
      } else if (p.block === 'repeater') {
        out.push({ p, field: 'out', value: this.levelFrom(p, p.facing) > 0 ? 15 : 0, delay: p.delay || 1 })
      } else if (p.block === 'comparator') {
        const rear = this.levelFrom(p, p.facing)
        const sides = HORIZ.filter((d) => d !== p.facing && d !== OPP[p.facing]).map((d) => this.levelFrom(p, d, { sidesOnly: true }))
        const side = Math.max(0, ...sides)
        const v = p.mode === 'subtract' ? Math.max(0, rear - side) : rear >= side ? rear : 0
        out.push({ p, field: 'out', value: v, delay: 1 })
      }
    }
    return out
  }

  /** Advance one redstone tick. */
  tick () {
    this.settle()
    // observers: a change in what they watch → a 1-tick pulse out of their back
    for (const p of this.parts.filter((x) => x.block === 'observer')) {
      const w = this.get(add(p, p.facing))
      const sig = w ? JSON.stringify([w.block, w.lit, w.out, w.on, this.state.dust.get(w), w.block === 'redstone_lamp' ? this.outputOn(w) : null]) : 'air'
      if (p.lastSig !== undefined && p.lastSig !== sig) this.pending.push({ part: p, field: 'out', value: 15, at: this.time + 1, pulse: true })
      p.lastSig = sig
    }
    for (const t of this.targets()) {
      if (t.p[t.field] === t.value) { this.pending = this.pending.filter((q) => q.part !== t.p || q.field !== t.field || q.pulse); continue }
      if (!this.pending.some((q) => q.part === t.p && q.field === t.field && q.value === t.value)) {
        this.pending = this.pending.filter((q) => q.part !== t.p || q.field !== t.field || q.pulse)
        this.pending.push({ part: t.p, field: t.field, value: t.value, at: this.time + t.delay })
      }
    }
    this.time++
    const due = this.pending.filter((q) => q.at <= this.time)
    this.pending = this.pending.filter((q) => q.at > this.time)
    for (const q of due) {
      q.part[q.field] = q.value
      if (q.pulse) this.pending.push({ part: q.part, field: 'out', value: 0, at: this.time + 1 })
    }
    for (const b of this.parts.filter((x) => /_button$/.test(x.block) && x.on && x.offAt !== undefined && x.offAt <= this.time)) b.on = false
    this.settle()
  }

  /** Run until nothing is pending (stable) or `max` ticks pass. Returns ticks taken, or -1 if it never settled. */
  run (max = 60) {
    for (let i = 0; i < max; i++) {
      this.tick()
      if (!this.pending.length && this.targets().every((t) => t.p[t.field] === t.value)) return i + 1
    }
    return -1
  }

  outputsNow () { this.settle(); return this.outputs().map((o) => this.outputOn(o)) }
}

/**
 * What a circuit does: for every combination of its inputs, the outputs once it settles (and how long that takes).
 * A circuit that never settles with all inputs off is a clock (with its period).
 */
function analyze (parts) {
  const c = new Circuit(parts)
  const ins = c.inputs()
  const outs = c.outputs()
  if (!outs.length) return { kind: 'no outputs', inputs: ins.length, outputs: 0 }
  // Clock? (no inputs needed: it keeps toggling)
  const probe = new Circuit(parts)
  for (const i of probe.inputs()) i.on = false
  if (probe.run(80) === -1) {
    const trace = []
    for (let t = 0; t < 40; t++) { probe.tick(); trace.push(probe.outputsNow()[0] ? 1 : 0) }
    const edges = trace.map((v, i) => i && v !== trace[i - 1] ? i : -1).filter((i) => i >= 0)
    const period = edges.length >= 3 ? edges[2] - edges[0] : null
    return { kind: 'clock', period, inputs: ins.length, outputs: outs.length, cost: cost(parts), size: size(parts) }
  }
  const rows = []
  let worst = 0
  for (let m = 0; m < 1 << ins.length; m++) {
    const sim = new Circuit(parts)
    sim.run(40)
    sim.inputs().forEach((inp, i) => { inp.on = Boolean(m & (1 << i)) })
    const t = sim.run(60)
    if (t < 0) return { kind: 'unstable', inputs: ins.length, outputs: outs.length }
    worst = Math.max(worst, t)
    rows.push({ in: ins.map((_, i) => Boolean(m & (1 << i))), out: sim.outputsNow() })
  }
  // Memory? Same inputs, different outputs depending on what came before.
  let memory = false
  if (ins.length >= 2) {
    const sim = new Circuit(parts)
    sim.run(40)
    const seq = [[1, 0], [0, 0], [0, 1], [0, 0]]
    const seen = []
    for (const s of seq) { sim.inputs().forEach((inp, i) => { inp.on = Boolean(s[i]) }); sim.run(40); seen.push(sim.outputsNow()[0]) }
    memory = seen[1] !== seen[3] // both "all off", different results
  }
  return { kind: memory ? 'latch' : 'logic', table: rows, name: memory ? 'memory latch' : nameOf(rows), delay: worst, inputs: ins.length, outputs: outs.length, cost: cost(parts), size: size(parts) }
}

/** Plain name for a 1- or 2-input truth table (first output). */
function nameOf (rows) {
  const bits = rows.map((r) => r.out[0] ? 1 : 0).join('')
  const n = rows[0]?.in.length
  if (n === 0) return bits === '1' ? 'always on' : 'always off'
  if (n === 1) return { '01': 'repeater (buffer)', 10: 'NOT gate (inverter)', '00': 'always off', 11: 'always on' }[bits]
  if (n === 2) {
    return { '0001': 'AND gate', '0111': 'OR gate', '0110': 'XOR gate', 1110: 'NAND gate', 1000: 'NOR gate', 1001: 'XNOR gate', '0100': 'A AND NOT B', '0010': 'B AND NOT A', '0101': 'follows A', '0011': 'follows B', 1010: 'NOT A', 1100: 'NOT B', '0000': 'always off', 1111: 'always on', 1011: 'A or not B', 1101: 'B or not A' }[bits] || `truth table ${bits}`
  }
  return `${n}-input logic (${bits})`
}

function cost (parts) {
  return Math.round(parts.filter((p) => !SOURCE.test(p.block) || p.block === 'redstone_block').filter((p) => !OUTPUT.test(p.block))
    .reduce((a, p) => a + (COST[p.block] ?? COST.block), 0) * 100) / 100
}
function size (parts) {
  const span = (k) => Math.max(...parts.map((p) => p[k])) - Math.min(...parts.map((p) => p[k])) + 1
  return { x: span('x'), y: span('y'), z: span('z'), volume: span('x') * span('y') * span('z') }
}

/** Two analyses do the same job (same truth table, or same clock period). */
function sameJob (a, b) {
  if (a.kind !== b.kind) return false
  if (a.kind === 'clock') return a.period === b.period
  return JSON.stringify(a.table) === JSON.stringify(b.table)
}

/**
 * Look for a cheaper circuit that does exactly the same job: try removing each part, swapping repeaters for dust,
 * shortening repeater delays, and keep every change that still passes the full test. Greedy, within a time budget.
 * @returns {{ parts, before, after, steps: string[] }}
 */
function optimize (parts, { budgetMs = 300, keepTiming = false } = {}) {
  const goal = analyze(parts)
  let best = parts.map((p) => ({ ...p }))
  let bestA = goal
  const steps = []
  const end = Date.now() + budgetMs
  let improved = true
  while (improved && Date.now() < end) {
    improved = false
    const tries = []
    best.forEach((p, i) => {
      if (SOURCE.test(p.block) && p.block !== 'redstone_block') return // inputs stay
      if (OUTPUT.test(p.block)) return // outputs stay
      tries.push({ why: `removed a ${p.block.replace(/_/g, ' ')}`, parts: best.filter((_, j) => j !== i) })
      if (p.block === 'repeater') {
        tries.push({ why: 'swapped a repeater for dust', parts: best.map((q, j) => j === i ? { x: q.x, y: q.y, z: q.z, block: 'redstone_wire' } : q) })
        if ((p.delay || 1) > 1 && !keepTiming) tries.push({ why: 'shortened a repeater delay', parts: best.map((q, j) => j === i ? { ...q, delay: (q.delay || 1) - 1 } : q) })
      }
      if (p.block === 'comparator') tries.push({ why: 'swapped a comparator for a repeater', parts: best.map((q, j) => j === i ? { ...q, block: 'repeater', delay: 1, mode: undefined } : q) })
    })
    for (const t of tries) {
      if (Date.now() > end) break
      const a = safe(() => analyze(t.parts))
      if (!a || !sameJob(a, goal)) continue
      if (keepTiming && goal.delay !== undefined && a.delay > goal.delay) continue
      if (a.cost < bestA.cost || (a.cost === bestA.cost && a.size.volume < bestA.size.volume)) {
        best = t.parts; bestA = a; steps.push(t.why); improved = true
        break
      }
    }
  }
  return { parts: best, before: goal, after: bestA, steps }
}

// ------------------------------------------------------------------------------------------------------------------
// Known designs. Each is built facing east (signal flows +x), inputs named A, B, outputs Q.
// ------------------------------------------------------------------------------------------------------------------
const S = 'stone'
const DESIGNS = {
  not: {
    label: 'NOT gate (torch inverter)',
    parts: [
      { x: 0, y: 0, z: 0, block: 'lever', face: 'wall', facing: 'west', name: 'A' },
      { x: 1, y: 0, z: 0, block: S },
      { x: 2, y: 0, z: 0, block: 'redstone_wall_torch', facing: 'east' },
      { x: 3, y: 0, z: 0, block: 'redstone_lamp', name: 'Q' }
    ]
  },
  or: {
    label: 'OR gate (two lines merged)',
    parts: [
      { x: 0, y: 0, z: 0, block: 'lever', face: 'floor', facing: 'east', name: 'A' },
      { x: 0, y: 0, z: 2, block: 'lever', face: 'floor', facing: 'east', name: 'B' },
      { x: 1, y: 0, z: 0, block: 'redstone_wire' }, { x: 1, y: 0, z: 1, block: 'redstone_wire' }, { x: 1, y: 0, z: 2, block: 'redstone_wire' },
      { x: 2, y: 0, z: 1, block: 'redstone_wire' },
      { x: 3, y: 0, z: 1, block: 'redstone_lamp', name: 'Q' }
    ]
  },
  nor: {
    label: 'NOR gate (OR into a torch)',
    parts: [
      { x: 0, y: 0, z: 0, block: 'lever', face: 'floor', facing: 'east', name: 'A' },
      { x: 0, y: 0, z: 2, block: 'lever', face: 'floor', facing: 'east', name: 'B' },
      { x: 1, y: 0, z: 0, block: 'redstone_wire' }, { x: 1, y: 0, z: 1, block: 'redstone_wire' }, { x: 1, y: 0, z: 2, block: 'redstone_wire' },
      { x: 2, y: 0, z: 1, block: 'redstone_wire' },
      { x: 3, y: 0, z: 1, block: S },
      { x: 4, y: 0, z: 1, block: 'redstone_wall_torch', facing: 'east' },
      { x: 5, y: 0, z: 1, block: 'redstone_lamp', name: 'Q' }
    ]
  },
  and: {
    label: 'AND gate (classic three-torch)',
    parts: [
      { x: -1, y: 0, z: 0, block: 'lever', face: 'wall', facing: 'west', name: 'A' },
      { x: -1, y: 0, z: 2, block: 'lever', face: 'wall', facing: 'west', name: 'B' },
      { x: 0, y: 0, z: 0, block: S }, { x: 0, y: 0, z: 1, block: S }, { x: 0, y: 0, z: 2, block: S },
      { x: 0, y: 1, z: 0, block: 'redstone_torch' }, { x: 0, y: 1, z: 2, block: 'redstone_torch' },
      { x: 0, y: 1, z: 1, block: 'redstone_wire' },
      { x: 1, y: 0, z: 1, block: 'redstone_wall_torch', facing: 'east' },
      { x: 2, y: 0, z: 1, block: 'redstone_lamp', name: 'Q' }
    ]
  },
  nand: {
    label: 'NAND gate (AND without the last torch)',
    parts: [
      { x: -1, y: 0, z: 0, block: 'lever', face: 'wall', facing: 'west', name: 'A' },
      { x: -1, y: 0, z: 2, block: 'lever', face: 'wall', facing: 'west', name: 'B' },
      { x: 0, y: 0, z: 0, block: S }, { x: 0, y: 0, z: 1, block: S }, { x: 0, y: 0, z: 2, block: S },
      { x: 0, y: 1, z: 0, block: 'redstone_torch' }, { x: 0, y: 1, z: 2, block: 'redstone_torch' },
      { x: 0, y: 1, z: 1, block: 'redstone_wire' },
      { x: 1, y: 0, z: 1, block: 'redstone_lamp', name: 'Q' }
    ]
  },
  clock: {
    label: 'torch-repeater clock (blinks forever; period = 2 × (1 + repeater delay) ticks)',
    parts: [
      { x: 0, y: 0, z: 0, block: S },
      { x: 1, y: 0, z: 0, block: 'redstone_wall_torch', facing: 'east' },
      { x: 2, y: 0, z: 0, block: 'redstone_wire' }, { x: 2, y: 0, z: 1, block: 'redstone_wire' }, { x: 2, y: 0, z: 2, block: 'redstone_wire' },
      { x: 1, y: 0, z: 2, block: 'redstone_wire' }, { x: 0, y: 0, z: 2, block: 'redstone_wire' },
      { x: 0, y: 0, z: 1, block: 'repeater', facing: 'south', delay: 2 },
      { x: 0, y: 1, z: 0, block: 'redstone_lamp', name: 'Q' }
    ]
  }
}
// Gates people often ask for by other names.
const ALIASES = { inverter: 'not', 'not gate': 'not', 'or gate': 'or', 'and gate': 'and', 'nand gate': 'nand', 'nor gate': 'nor', blinker: 'clock', 'clock circuit': 'clock', pulser: 'clock' }

function design (name) {
  const k = ALIASES[String(name || '').toLowerCase()] || String(name || '').toLowerCase().replace(/\s*gate$/, '')
  return DESIGNS[k] ? { key: k, ...DESIGNS[k] } : null
}

/** Rotate a design (built facing east) to face another way, and move it to an origin. */
function place (parts, origin, facing = 'east') {
  const turns = { east: 0, south: 1, west: 2, north: 3 }[facing] ?? 0
  const rotDir = (d) => { if (!d || d === 'up' || d === 'down') return d; let i = ['east', 'south', 'west', 'north'].indexOf(d); i = (i + turns) % 4; return ['east', 'south', 'west', 'north'][i] }
  return parts.map((p) => {
    let x = p.x; let z = p.z
    for (let t = 0; t < turns; t++) [x, z] = [-z, x]
    return { ...p, x: origin.x + x, y: origin.y + p.y, z: origin.z + z, facing: rotDir(p.facing) }
  })
}

/**
 * Read the redstone around a spot in the world into a parts list: every redstone component connected to the start,
 * the blocks they sit on or power, and the inputs/outputs at the edges. blockAt(pos) → prismarine block.
 */
function readFromWorld (blockAt, start, radius = 8) {
  const isRed = (b) => b && (/redstone|repeater|comparator|observer|lever|_button$|_pressure_plate$|piston|lamp/.test(b.name))
  const seen = new Set()
  const parts = []
  const queue = [{ pos: start, viaSolid: false }]
  while (queue.length && parts.length < 160) {
    const { pos, viaSolid } = queue.shift()
    const k = key(pos.x, pos.y, pos.z)
    if (seen.has(k)) continue
    if (Math.abs(pos.x - start.x) > radius || Math.abs(pos.y - start.y) > radius || Math.abs(pos.z - start.z) > radius) continue
    const b = blockAt(pos)
    if (!b || b.name === 'air' || b.name === 'cave_air') continue
    const red = isRed(b)
    const solid = !red && b.boundingBox === 'block'
    if (!red && !solid) continue
    if (viaSolid && !red) continue // through a block only to the torches and parts on it, not along the floor
    seen.add(k)
    const props = safe(() => b.getProperties()) || {}
    const part = { x: pos.x, y: pos.y, z: pos.z, block: solid && !OUTPUT.test(b.name) ? (isConductor(b.name) ? 'stone' : b.name) : b.name }
    if (props.facing) part.facing = props.facing
    if (props.delay) part.delay = Number(props.delay)
    if (props.mode) part.mode = props.mode
    if (props.face) part.face = props.face
    if (props.powered !== undefined && (part.block === 'lever' || /_button$/.test(part.block))) part.on = props.powered === true || props.powered === 'true'
    parts.push(part)
    for (const d of Object.keys(DIRS)) {
      const n = add(pos, d)
      queue.push({ pos: n, viaSolid: !red })
      if (red) for (const e of ['up', 'down']) queue.push({ pos: add(n, e), viaSolid: false }) // dust steps
    }
  }
  // drop solid blocks that touch no redstone part (the floor, mostly)
  const at = new Map(parts.map((p) => [key(p.x, p.y, p.z), p]))
  const touches = (p) => Object.keys(DIRS).some((d) => { const q = add(p, d); const n = at.get(key(q.x, q.y, q.z)); return n && n.block !== 'stone' })
  return parts.filter((p) => p.block !== 'stone' || touches(p)).map(nameIO())
}

function nameIO () {
  let a = 0; let q = 0
  return (p) => {
    if (SOURCE.test(p.block) && p.block !== 'redstone_block') p.name = p.name || String.fromCharCode(65 + a++)
    else if (OUTPUT.test(p.block)) p.name = p.name || (q++ ? `Q${q}` : 'Q')
    return p
  }
}

/** A sentence about a circuit: what it is, how fast, what it costs, and a cheaper version if there is one. */
function describe (parts, { level = 6 } = {}) {
  const a = analyze(parts)
  const working = parts.some((p) => /redstone_wire|torch|repeater|comparator|observer|redstone_block/.test(p.block))
  if (!working) return { analysis: { ...a, kind: 'nothing' }, text: 'not a working circuit (no dust, torches or repeaters, just loose parts)' }
  if (a.kind === 'no outputs') return { analysis: a, text: 'redstone wiring with nothing at the end of it (no lamp, piston or door)' }
  if (a.kind === 'unstable') return { analysis: a, text: 'a circuit that never settles for some inputs (it flickers): probably a mistake or a clock with inputs' }
  let text = a.kind === 'clock' ? `a clock that blinks every ${a.period ? a.period / 10 : '?'} s` : a.kind === 'latch' ? `a memory latch with ${a.inputs} inputs` : `a ${a.name} (${a.inputs} input${a.inputs === 1 ? '' : 's'}, settles in ${a.delay} redstone ticks)`
  text += `, ${a.cost} worth of parts in a ${a.size.x}x${a.size.y}x${a.size.z} space`
  if (level >= 6) {
    const better = optimize(parts, { budgetMs: 250 })
    if (better.steps.length) text += `. It could be cheaper: ${[...new Set(better.steps)].join(', ')} (cost ${a.cost} → ${better.after.cost}) and it would still do the same thing`
    const known = Object.entries(DESIGNS).map(([k, d]) => ({ k, d, a: safe(() => analyze(d.parts)) })).filter((x) => x.a && sameJob(x.a, a) && x.a.cost < (better.after?.cost ?? a.cost))
    if (known.length) text += `. A ${known[0].d.label} does the same for ${known[0].a.cost}`
  }
  return { analysis: a, text }
}

function safe (fn) { try { return fn() } catch { return null } }

module.exports = { Circuit, analyze, optimize, describe, design, place, readFromWorld, DESIGNS, nameOf, cost, size, sameJob, attachedTo }
