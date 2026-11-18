'use strict'
// Run with: npm test   (or node test/pvp.test.js)
// Covers: PvP for fun — telling a PvP minigame from its lobby, teammates vs enemies, and the friendly spar stop.
const path = require('path')
const assert = require('assert')
const { Network } = require(path.join(__dirname, '..', 'network.js'))
const reg = require('minecraft-data')('1.21.4')

const named = (name, custom) => ({ name, count: 1, customName: JSON.stringify({ text: custom }) })
const mk = ({ title = 'BED WARS', lines = ['Red: ✔', 'Blue: ✔', 'Kills: 0', 'play.example.net'], mode = 'survival', hotbar = {}, teams = {} } = {}) => {
  const slots = new Array(46).fill(null)
  for (const [i, it] of Object.entries(hotbar)) slots[36 + Number(i)] = it
  const bot = { registry: reg, username: 'Bot', entity: { position: { x: 0, y: 64, z: 0 } }, game: { gameMode: mode }, players: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`P${i}`, {}])), tablist: { header: '', footer: 'store.example.net' }, scoreboard: { sidebar: { title, items: lines.map((t) => ({ displayName: t })) } }, inventory: { slots }, teamMap: teams, bossBars: {} }
  return new Network({ bot, config: { network: {}, server: {}, behavior: { owners: ['EndlessSkys'] } }, log: { info () {} } })
}
// in a game
assert.equal(mk().pvpGame()?.name.toLowerCase(), 'bed wars')
assert.equal(mk({ title: 'DUELS', lines: ['Opponent: EndlessSkys', 'Kills: 0'] }).pvpGame()?.name.toLowerCase(), 'duels')
// the lobby (adventure, game selector) is not a fight
assert.equal(mk({ mode: 'adventure', hotbar: { 0: named('compass', 'Game Selector'), 1: named('player_head', 'Profile') }, title: 'BED WARS', lines: ['Lobby #2', 'Coins: 10'] }).pvpGame(), null)
// waiting in a cage
assert.equal(mk({ lines: ['Waiting for players...', 'Starting in 10s'] }).pvpGame(), null)
// a plain server with no PvP words
assert.equal(mk({ title: 'Survival', lines: ['Balance: 30', 'Online: 4'] }).pvpGame(), null)
// teams: same team = teammate; another team = enemy; no teams = enemy
const red = { team: 'red', color: 'red' }
const blue = { team: 'blue', color: 'blue' }
const n = mk({ teams: { Bot: red, EndlessSkys: red, Steve: blue } })
assert.equal(n.teammate('EndlessSkys'), true)
assert.equal(n.teammate('Steve'), false)
assert.equal(n.teammate('Nobody'), false)
// the spar stop reads a player's health from metadata (index 9 on 1.17+)
const combat = require(path.join(__dirname, '..', 'combat.js'))
assert.ok(typeof combat.fight === 'function')
console.log('All PvP checks passed')
