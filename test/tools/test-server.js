'use strict'
/**
 * A throwaway local Minecraft server (flying-squid) for live tests.
 *
 *   npm install --no-save flying-squid@1.12.0
 *   node test/tools/test-server.js [version=1.16.5] [port=25599]
 *
 * Superflat world, everyone op (so /give and /tp work). Known quirks — see
 * test/tools/README.md: players only see players who join AFTER them, no PvP
 * damage, no item tossing, no sneak/invisibility metadata, no block-break
 * sound events, and on 1.21.4 broken inventories and no other-player entities.
 */
const mcServer = require('flying-squid')
const version = process.argv[2] || '1.16.5'
const port = Number(process.argv[3] || 25599)
mcServer.createMCServer({
  motd: 'bot test', port, 'max-players': 10, 'online-mode': false, logging: false,
  gameMode: 0, difficulty: 1, generation: { name: 'superflat', options: { worldHeight: 80 } },
  kickTimeout: 60000, plugins: {}, modpe: false, 'view-distance': 4, 'player-list-text': { header: '', footer: '' },
  'everybody-op': true, 'max-entities': 100, version
})
console.log(`test server ${version} on port ${port}`)
