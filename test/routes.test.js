'use strict'
// Run with: npm test   (or node test/routes.test.js)
// Covers: choosing the login (auth auto), the backup route (server.fallback) and spotting modded servers
const path = require('path')
const R = path.join(__dirname, '..') + path.sep
const assert = require('assert')
const { loginFor, fallbackServer, serverMods, DEFAULT_CONFIG } = require(R + 'index.js')

console.log('== login (auth auto) ==')
assert.equal(DEFAULT_CONFIG.server.auth, 'auto')
assert.deepEqual(loginFor({ auth: 'auto', username: 'Wanderer' }), { auth: 'offline', username: 'Wanderer' })
assert.deepEqual(loginFor({ auth: 'auto', username: 'bot.account@example.com' }), { auth: 'microsoft', username: 'bot.account@example.com' })
// The Microsoft sign-in failed: play offline under a valid name.
assert.deepEqual(loginFor({ auth: 'auto', username: 'bot.account@example.com' }, true), { auth: 'offline', username: 'botaccount' })
assert.deepEqual(loginFor({ auth: 'auto', username: 'x@example.com', offlineName: 'Wanderer' }, true), { auth: 'offline', username: 'Wanderer' })
assert.equal(loginFor({ auth: 'auto', username: 'a-very-long-player-name-here' }).username.length, 16)
assert.equal(loginFor({ auth: 'auto', username: 'x@y.z' }, true).username, 'Wanderer') // too short → default
// Forced settings win.
assert.equal(loginFor({ auth: 'offline', username: 'bot@example.com' }).auth, 'offline')
assert.equal(loginFor({ auth: 'microsoft', username: 'bot@example.com' }).auth, 'microsoft')
console.log('ok')


console.log('== backup route ==')
const java = { ...DEFAULT_CONFIG.server, host: 'friend.example.net', auth: 'microsoft', username: 'bot@example.com', password: 'x', realm: '', fallback: 'bedrock' }
const servers = { bedrock: { host: '127.0.0.1', port: 25568, auth: 'offline', username: 'Wanderer', version: '1.21.4', platform: 'bedrock' } }
const next = fallbackServer(java, servers)
console.log(JSON.stringify(next))
assert.equal(next.name, 'bedrock')
assert.equal(next.server.host, '127.0.0.1')
assert.equal(next.server.port, 25568)
assert.equal(next.server.auth, 'offline')
assert.equal(next.server.platform, 'bedrock')
assert.equal(next.server.password, '') // the Java server's login-plugin password doesn't go to the other server
assert.equal(next.server.fallback, '') // no chains: the backup has no backup
assert.equal(next.server.reconnect, java.reconnect) // general settings are kept
assert.equal(fallbackServer(next.server, servers), null)
assert.equal(fallbackServer({ ...java, fallback: '' }, servers), null)
assert.equal(fallbackServer({ ...java, fallback: 'missing' }, servers), null)
// A Realm on the main route must not hide the backup's host.
assert.equal(fallbackServer({ ...java, realm: 'Our Realm' }, servers).server.realm, '')
// A Java backup keeps the Java platform even if the profile doesn't say so.
assert.equal(fallbackServer({ ...java, platform: 'bedrock', fallback: 'j' }, { j: { host: 'x' } }).server.platform, 'java')

console.log('\n== modded servers ==')
assert.equal(serverMods({ version: { name: 'Paper 1.21.4' } }), null)
assert.deepEqual(serverMods({ forgeData: { mods: [{ modId: 'forge' }, { modId: 'create' }] } }), { loader: 'Forge/NeoForge', count: 2 })
assert.deepEqual(serverMods({ modinfo: { type: 'FML', modList: [{ modid: 'mcp' }] } }), { loader: 'FML', count: 1 })
console.log('ok')

console.log('\nAll route checks passed')
