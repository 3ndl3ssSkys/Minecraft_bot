'use strict'
// Run with: npm test   (or node test/viewer.test.js)
// Covers: translating a newer world (26.1) into a version the viewer knows (1.21.4), block by block
const path = require('path')
const assert = require('assert')
const { Vec3 } = require('vec3')
const { stateMap, convertColumn } = require(path.join(__dirname, '..', 'viewer.js'))

const SRC = '26.1'
const DST = '1.21.4'
const src = require('minecraft-data')(SRC)
const dst = require('minecraft-data')(DST)
const map = stateMap(src, dst)
const Chunk = require('prismarine-chunk')(SRC)
const DstChunk = require('prismarine-chunk')(DST)
const col = new Chunk({ minY: -64, worldHeight: 384 })
const blocks = { stone: [1, 64, 1], oak_log: [2, 64, 1], grass_block: [3, 63, 3], water: [4, 62, 4], diamond_ore: [5, -50, 5], torch: [6, 64, 6] }
for (const [name, [x, y, z]] of Object.entries(blocks)) col.setBlockStateId(new Vec3(x, y, z), src.blocksByName[name].defaultState)
// a block with properties: an oak log lying east-west keeps its axis
const axisX = src.blocksByName.oak_log.minStateId // axis=x is the first state
col.setBlockStateId(new Vec3(7, 64, 7), axisX)

const out = convertColumn(col, DstChunk, map)
const nameAt = (c, data, x, y, z) => data.blocks[data.blocksByState?.[c.getBlockStateId(new Vec3(x, y, z))]?.id]?.name || data.blocksByStateId[c.getBlockStateId(new Vec3(x, y, z))]?.name
for (const [name, [x, y, z]] of Object.entries(blocks)) {
  const got = nameAt(out, dst, x, y, z)
  console.log(`${name.padEnd(12)} → ${got}`)
  assert.equal(got, name)
}
assert.equal(out.getBlockStateId(new Vec3(7, 64, 7)), dst.blocksByName.oak_log.minStateId, 'block properties survive (log axis)')
assert.equal(out.getBlockStateId(new Vec3(0, 100, 0)), 0, 'air stays air')
console.log('\nAll viewer checks passed')
