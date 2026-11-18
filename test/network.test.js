'use strict'
// Run with: npm test   (or node test/network.test.js)
// Covers: public server networks — reading menus, which commands are safe, following its owner's party invites,
// telling a minigame network from a plain server.
const path = require('path')
const assert = require('assert')
const { Network, textOf, clickCommands } = require(path.join(__dirname, '..', 'network.js'))

const reg = require('minecraft-data')('1.21.4')
const sent = []
const named = (name, custom, lore) => ({ name, count: 1, customName: custom ? JSON.stringify({ text: custom }) : null, customLore: lore ? [JSON.stringify({ text: lore })] : null })
const bot = {
  registry: reg,
  entity: { position: { x: 0, y: 64, z: 0 } },
  game: { gameMode: 'adventure' },
  players: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`P${i}`, {}])),
  tablist: { header: 'Welcome to Example Network', footer: 'store.example.net' },
  scoreboard: { sidebar: { title: 'EXAMPLE', items: ['Lobby #3', 'Rank: Default', 'Coins: 120', '-----', 'play.example.net'].map((t) => ({ displayName: t })) } },
  inventory: { slots: Object.assign(new Array(46).fill(null), { 36: named('compass', 'Game Selector (Right Click)'), 37: named('player_head', 'Profile') }) },
  chat: (m) => sent.push(m)
}
const agent = { bot, config: { network: { public: 'auto', acceptInvites: true }, behavior: { owners: ['EndlessSkys'] } }, log: { info () {} }, memory: { addEvent () {} } }
const n = new Network(agent)

// --- reading things ---
assert.equal(textOf(reg, JSON.stringify({ text: '', extra: [{ text: 'Bed ', color: 'red' }, { text: 'Wars' }] })), 'Bed Wars')
assert.equal(textOf(reg, '§aGame §lSelector'), 'Game Selector')
assert.ok(n.isNetwork(), 'scoreboard + named hotbar items + store link + lots of players = a network')
assert.ok(n.inLobby())
assert.deepEqual(n.hotbarItems().map((h) => h.name), ['Game Selector (Right Click)', 'Profile'])
const ctx = n.context()
assert.equal(ctx.kind, 'network lobby')
assert.match(ctx.sidebar, /Lobby #3/)

// --- menus ---
const win = { title: JSON.stringify({ text: 'Game Menu' }), inventoryStart: 27, slots: new Array(63).fill(null) }
win.slots[10] = named('red_bed', 'Bed Wars', '2,345 playing')
win.slots[12] = named('grass_block', 'SkyWars', '812 playing')
win.slots[0] = { name: 'black_stained_glass_pane', count: 1 }
n.window = win
const d = n.describeWindow()
assert.equal(d.title, 'Game Menu')
assert.deepEqual(d.items, ['10: Bed Wars (2,345 playing)', '12: SkyWars (812 playing)'])
assert.equal(n.findSlot('bedwars'), 10)
assert.equal(n.findSlot('sky wars'), 12)
assert.equal(n.findSlot('murder mystery'), null)

// --- commands ---
assert.ok(n.allowed('/play bedwars'))
assert.ok(n.allowed('party accept EndlessSkys'))
assert.ok(!n.allowed('/op TheBestWanderer'))
assert.ok(!n.allowed('/gamemode creative'))
assert.ok(!n.allowed('//wand'))
assert.ok(!n.allowed('/somethingodd'))
n.commands = ['somethingodd']
assert.ok(n.allowed('/somethingodd'), 'the server offers it')

// --- invites from its owner ---
const clickable = { text: '', extra: [{ text: 'EndlessSkys has invited you to join their party! ' }, { text: '[ACCEPT]', clickEvent: { action: 'run_command', value: '/party accept EndlessSkys' } }] }
assert.deepEqual(clickCommands(clickable), ['/party accept EndlessSkys'])
const msg = (json) => ({ json, toString: () => textOf(reg, JSON.stringify(json)) })
const realSetTimeout = global.setTimeout
global.setTimeout = (fn) => fn() // no waiting in the test
n.onMessage(msg(clickable))
assert.deepEqual(sent, ['/party accept EndlessSkys'])
n.lastInviteAt = 0
n.onMessage(msg({ text: 'Stranger has invited you to join their party! Type /party accept Stranger' }))
assert.equal(sent.length, 1, 'not from strangers')
n.onMessage(msg({ text: 'EndlessSkys has sent you a teleport request. Type /tpaccept to accept.' }))
assert.equal(sent.at(-1), '/tpaccept')
n.lastInviteAt = 0
n.onMessage(msg({ text: '<EndlessSkys> lol i invited the whole party to my friend list' }))
assert.equal(sent.length, 2, 'its owner chatting is not an invite')
global.setTimeout = realSetTimeout

// --- a plain survival server isn't a network ---
const plain = new Network({ ...agent, bot: { ...bot, game: { gameMode: 'survival' }, players: { A: {}, B: {} }, tablist: {}, scoreboard: {}, inventory: { slots: new Array(46).fill(null) } } })
assert.ok(!plain.isNetwork())
assert.equal(plain.context(), undefined)
console.log('All network checks passed')
