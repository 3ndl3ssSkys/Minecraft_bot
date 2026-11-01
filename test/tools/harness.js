'use strict'
/**
 * Live scenario checks against a test server (drives the real Agent by hand).
 *
 *   node test/tools/harness.js <scenario> <config.json>
 *   scenarios: typing | sight | hearing | nametags | fall | startle
 *   (fall: LEVEL=mediocre|complicated|... picks the intelligence level)
 *
 * Setup: start test/tools/test-server.js, then this harness, then
 * test/tools/test-player.js a few seconds later (flying-squid only shows
 * players who join after you). The config should point at the test server
 * and at any llm url (the brain loop is paused here). See test/tools/README.md.
 *
 * Where flying-squid doesn't send what a vanilla server sends (sneak and
 * invisibility metadata, block-break world events), the harness plays the
 * vanilla packet into the bot so the bot's own handling is exercised.
 */
const [which = 'sight', configPath] = process.argv.slice(2)
process.argv = [process.argv[0], process.argv[1], ...(configPath ? [configPath] : [])] // loadConfig reads the config path from argv
const { Agent, loadConfig } = require('../../index.js')
const { Vec3 } = require('vec3')
const quiet = { info: () => {}, warn: () => {}, error: console.error, debug: () => {}, mind: () => {}, chat: (m) => console.log('CHAT', m) }
const config = loadConfig(quiet)
config.busyWork.enabled = false
config.reactions.enabled = false
const agent = new Agent(config, quiet)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function showPlayers (label) {
  agent.senses.perceivedCache.at = 0
  const ents = agent.perception.nearbyEntities().filter((e) => e.kind === 'player')
  console.log(`${label}:`, ents.length ? JSON.stringify(ents.map(({ name, perceived, nameTag, note }) => ({ name, perceived, nameTag, note }))) : 'no players perceived')
}

async function waitForTester (bot) {
  for (let i = 0; i < 60 && !bot.players.Tester?.entity; i++) await wait(500)
  const t = bot.players.Tester?.entity
  if (!t) { console.log('Tester never appeared (start test-player.js after the harness)'); process.exit(1) }
  return t
}

/** A 3x3 dirt wall two blocks from the bot, towards `target`. */
async function buildWall (bot, target) {
  bot.chat(`/give ${bot.username} dirt 64`)
  await wait(1500)
  const me = bot.entity.position.floored()
  const dir = target.position.minus(bot.entity.position); dir.y = 0
  const n = dir.normalize()
  const step = Math.abs(n.x) > Math.abs(n.z) ? new Vec3(Math.sign(n.x), 0, 0) : new Vec3(0, 0, Math.sign(n.z))
  const side = new Vec3(step.z, 0, step.x)
  let placed = 0
  for (let h = 0; h < 3; h++) {
    for (const k of [-1, 0, 1]) {
      const p = me.plus(step.scaled(2)).plus(side.scaled(k)).offset(0, h, 0)
      if ((await agent.executor.execute('placeBlock', { blockType: 'dirt', x: p.x, y: p.y, z: p.z })).ok) placed++
    }
  }
  console.log(`wall: ${placed}/9 blocks`)
  return { me, step }
}

const scenarios = {
  // Does the bot stand still while it types? Samples distance travelled.
  async typing (bot) {
    const start = bot.entity.position.clone()
    const samples = []
    const t0 = Date.now()
    const timer = setInterval(() => samples.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${bot.entity.position.distanceTo(start).toFixed(1)}`), 500)
    const move = agent.executor.execute('moveToBlock', { x: start.x + 40, y: start.y, z: start.z })
    await wait(2500)
    console.log('typing a long message at 2.5s...')
    agent.chat.send('ok so I was thinking we should build a big house over by the river later', 'tool')
    const r = await move
    clearInterval(timer)
    console.log('move:', r.ok, r.message)
    console.log('time:distance', samples.join('  '), '\n(a plateau = it stopped to type)')
  },

  // Line of sight: seen in the open, remembered behind a wall, then forgotten.
  async sight (bot) {
    const t = await waitForTester(bot)
    await bot.lookAt(t.position.offset(0, 1.6, 0), true)
    showPlayers('open field')
    await buildWall(bot, t)
    await bot.lookAt(t.position.offset(0, 1.6, 0), true)
    showPlayers('behind the wall')
    await wait(21000)
    showPlayers('21s later')
  },

  // Unexplained sounds raise suspicion and an investigation (after the Tester is forgotten).
  async hearing (bot) {
    const t = await waitForTester(bot)
    const { me, step } = await buildWall(bot, t)
    await wait(21000)
    showPlayers('Tester forgotten')
    const behind = me.plus(step.scaled(6)).offset(0.5, 0.5, 0.5)
    for (let i = 0; i < 3; i++) { bot.emit('soundEffectHeard', 'block.chest.open', behind, 0.5, 1); await wait(1500) }
    const sm = agent.senses.summary()
    console.log('heard:', sm.heard)
    console.log('suspicion:', sm.suspicion, '| investigation:', agent.investigation ? agent.investigation.reason : 'none')
  },

  // Name tags: readable in the open, through a wall, hidden when sneaking/invisible.
  async nametags (bot) {
    const t = await waitForTester(bot)
    await bot.lookAt(t.position.offset(0, 1.6, 0), true)
    showPlayers('open field')
    await buildWall(bot, t)
    await wait(1000)
    showPlayers('behind the wall, standing')
    bot._client.emit('entity_metadata', { entityId: t.id, metadata: [{ key: 0, type: 0, value: 0x02 }] }) // vanilla "sneaking" flag
    await wait(500)
    showPlayers('behind the wall, sneaking')
    await wait(21000)
    showPlayers('sneaking, 21s later')
    bot._client.emit('entity_metadata', { entityId: t.id, metadata: [{ key: 0, type: 0, value: 0x20 }] }) // vanilla "invisible" flag
    agent.senses.lastSeen.clear()
    showPlayers('invisible')
  },

  // Teleported 25 blocks up with slime blocks and cobblestone: does it see the fall coming and catch it?
  async fall (bot) {
    agent.config.intelligence.level = process.env.LEVEL || 'mediocre'
    quiet.debug = (m) => { if (/^(fall|reflex)/.test(m)) console.log('  ', m) }
    bot.chat(`/give ${bot.username} slime_block 4`)
    bot.chat(`/give ${bot.username} cobblestone 16`)
    await wait(2000)
    const p = bot.entity.position.floored()
    const ground = p.y - 1
    const before = bot.health
    bot.chat(`/tp ${bot.username} ${p.x + 0.5} ${p.y + 25} ${p.z + 0.5}`)
    let top = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 8000) {
      await wait(50)
      top = Math.max(top, bot.entity.position.y)
      if (top > p.y + 20 && bot.entity.onGround && !agent.reflexes.busy) break
    }
    for (let still = 0; still < 20 && Date.now() - t0 < 15000;) { await wait(100); still = bot.entity.onGround && Math.abs(bot.entity.velocity.y) < 0.1 ? still + 1 : 0 } // slime bounces
    const under = bot.blockAt(bot.entity.position.offset(0, -0.5, 0))
    const placed = bot.blockAt(new Vec3(p.x, ground + 1, p.z))
    console.log(`fell from y=${top.toFixed(1)}, settled at y=${bot.entity.position.y.toFixed(1)} on ${under?.name} (block at the landing spot: ${placed?.name}), health ${before} → ${bot.health}`)
    console.log('practice:', JSON.stringify(agent.reflexes.practice))
    console.log('memory:', agent.memory.events.slice(-2).map((e) => e.text).join(' | '))
  },

  // A punch from behind: does it flinch and turn toward the Tester? A real attack: weapon out?
  async startle (bot) {
    const t = await waitForTester(bot)
    bot.chat(`/give ${bot.username} iron_sword 1`)
    await wait(1500)
    const angleToTester = () => {
      const d = t.position.minus(bot.entity.position)
      const want = Math.atan2(-d.x, -d.z)
      let diff = Math.abs(((bot.entity.yaw - want) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
      return Math.round(diff * 180 / Math.PI)
    }
    for (const level of ['beginning', 'advanced', 'impossible']) {
      agent.config.intelligence.level = level
      const d = t.position.minus(bot.entity.position)
      await bot.look(Math.atan2(d.x, d.z), 0, true) // facing away from the Tester
      await wait(300)
      // A vanilla hit: knockback away from the attacker, then the hurt event.
      bot.entity.velocity = new Vec3(-d.x, 0, -d.z).normalize().scaled(0.4).offset(0, 0.36, 0)
      const t0 = Date.now()
      agent.reflexes.cooldowns.clear()
      agent.reflexes.onHurt({ attacker: t, serious: false })
      const samples = []
      for (let i = 0; i < 8; i++) { await wait(200); samples.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:${angleToTester()}°`) }
      console.log(`${level.padEnd(10)} angle to the Tester after a punch:`, samples.join(' '))
    }
    agent.config.intelligence.level = 'advanced'
    agent.reflexes.onHurt({ attacker: t, serious: true })
    await wait(1500)
    console.log('serious attack → holding', bot.heldItem?.name || 'nothing')
  }
}

agent.connect().then(() => agent.bot.once('spawn', async () => {
  const bot = agent.bot
  await wait(1500)
  agent.brain.paused = true
  agent.executor.abort('harness')
  while (agent.executor.busy) await wait(100) // let the brain's last action wind down
  if (!scenarios[which]) { console.log(`unknown scenario "${which}" (${Object.keys(scenarios).join(' | ')})`); process.exit(1) }
  console.log(`--- scenario: ${which}`)
  await scenarios[which](bot)
  process.exit(0)
}))
