'use strict'
/** A tiny fake bot on the REAL physics engine (prismarine-physics) over a synthetic block world: no server needed. */
const { Physics, PlayerState } = require('prismarine-physics')
const { Vec3 } = require('vec3')
const VERSION = '1.21.4'
const mcData = require('minecraft-data')(VERSION)
const Block = require('prismarine-block')(VERSION)

function makeWorld (cells = {}) {
  const key = (x, y, z) => `${x},${y},${z}`
  const world = {
    cells,
    set (x, y, z, name) { cells[key(x, y, z)] = name },
    fill (x1, y1, z1, x2, y2, z2, name) { for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) cells[key(x, y, z)] = name },
    getBlock (pos) {
      const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
      const name = cells[key(x, y, z)] || 'air'
      const b = new Block(mcData.blocksByName[name].id, 0, 0)
      b.position = new Vec3(x, y, z)
      return b
    }
  }
  return world
}

function makeBot (world, pos, { yaw = 0 } = {}) {
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  const physics = Physics(mcData, world)
  const bot = {
    version: VERSION, food: 20, health: 20, controlState: controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    inventory: { slots: [] }, pathfinder: null, ticks: 0,
    entity: { position: new Vec3(pos.x, pos.y, pos.z), velocity: new Vec3(0, 0, 0), onGround: false, isInWater: false, isInLava: false, isInWeb: false, elytraFlying: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw, pitch: 0, effects: [], attributes: {} },
    blockAt: (p) => world.getBlock(p),
    setControlState (k, v) { controls[k] = v },
    clearControlStates () { for (const k of Object.keys(controls)) controls[k] = false },
    async look (yaw2, pitch) { bot.entity.yaw = yaw2; bot.entity.pitch = pitch },
    step () {
      const st = new PlayerState(bot, controls)
      physics.simulatePlayer(st, world).apply(bot)
      bot.ticks++
    },
    async waitForTicks (n) { for (let i = 0; i < n; i++) { bot.step(); bot.emit?.('physicsTick') } },
    settle () { for (let i = 0; i < 40; i++) bot.step() }
  }
  return bot
}
module.exports = { makeWorld, makeBot, mcData }
