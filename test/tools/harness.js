'use strict'
/**
 * Live scenario checks against a test server (drives the real Agent by hand).
 *
 *   node test/tools/harness.js <scenario> <config.json>
 *   scenarios: typing | sight | hearing | nametags
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
  }
}

agent.connect().then(() => agent.bot.once('spawn', async () => {
  const bot = agent.bot
  await wait(1500)
  agent.brain.paused = true
  agent.executor.abort('harness')
  while (agent.executor.busy) await wait(100) // let the brain's last action wind down
  if (!scenarios[which]) { console.log(`unknown scenario "${which}" (typing | sight | hearing | nametags)`); process.exit(1) }
  console.log(`--- scenario: ${which}`)
  await scenarios[which](bot)
  process.exit(0)
}))
