'use strict'
/**
 * A second player for live tests.
 *
 *   node test/tools/test-player.js <port> <version> <mode> [delayMs]
 *   modes: idle | sneak | dig | chat
 *
 * On flying-squid it must join AFTER the bot, or the bot won't see it.
 */
const mineflayer = require('mineflayer')
const [port = '25599', version = '1.16.5', mode = 'idle', delay = '5000'] = process.argv.slice(2)
const bot = mineflayer.createBot({ host: 'localhost', port: Number(port), username: 'Tester', version })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
bot.on('chat', (u, m) => console.log(`[Tester sees] <${u}> ${m}`))
bot.once('spawn', async () => {
  await wait(Number(delay))
  if (mode === 'sneak') { bot.setControlState('sneak', true); console.log('sneaking') }
  if (mode === 'chat') {
    for (const m of ['hey bot', 'can you get me some dirt', 'come here']) { bot.chat(m); await wait(6000) }
  }
  if (mode === 'dig') {
    for (let i = 0; i < 5; i++) {
      const b = bot.blockAt(bot.entity.position.offset(1, -1, i - 2))
      try { await bot.dig(b, true); console.log('dug', b.name) } catch (e) { console.log('dig failed', e.message) }
      await wait(1200)
    }
  }
  await wait(60000)
  process.exit(0)
})
bot.on('error', (e) => console.log('error', e.message))
