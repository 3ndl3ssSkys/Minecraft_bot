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
  chat: (m) => sent.push(m),
  on () {},
  removeListener () {}
}
const queued = []
const agent = { bot, config: { network: { public: 'auto', acceptInvites: true }, server: { platform: 'java' }, behavior: { owners: ['EndlessSkys'] } }, log: { info () {} }, memory: { addEvent () {} }, brain: { queueAction: (a) => queued.push(a) } }
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
// Bedrock: chat can't be clicked, so the invite is accepted through the menus
agent.config.server.platform = 'bedrock'
n.lastInviteAt = 0
n.onMessage(msg({ text: 'EndlessSkys invited you to their party!' }))
assert.equal(sent.length, 2, 'nothing typed on Bedrock')
assert.deepEqual(queued.at(-1), { name: 'navigateMenus', args: { goal: "accept EndlessSkys's party invite" } })
agent.config.server.platform = 'java'
// Java, no command in the text: the usual command first
n.lastInviteAt = 0
n.onMessage(msg({ text: 'EndlessSkys wants you to join their party' }))
assert.equal(sent.at(-1), '/party accept EndlessSkys')
// server notices are kept for the prompt
n.notice(msg({ text: 'The game starts in 10 seconds!' }), 'system')
n.notice(msg({ text: '<Steve> hi all' }), 'system')
assert.deepEqual(n.notices.map((x) => x.text).slice(-1), ['The game starts in 10 seconds!'])
global.setTimeout = realSetTimeout

// --- a plain survival server isn't a network ---
const plain = new Network({ ...agent, bot: { ...bot, game: { gameMode: 'survival' }, players: { A: {}, B: {} }, tablist: {}, scoreboard: {}, inventory: { slots: new Array(46).fill(null) } } })
assert.ok(!plain.isNetwork())
assert.equal(plain.context(), undefined)
console.log('All network checks passed')

// --- navigating menus toward a goal, on a fake Hive-style server (items open menus, menus open menus) ---
;(async () => {
  const { EventEmitter } = require('events')
  const { ACTIONS } = require(path.join(__dirname, '..', 'actions.js'))
  const { goalWords, scoreText } = require(path.join(__dirname, '..', 'network.js'))
  assert.ok(scoreText(goalWords('play treasure wars solo'), 'Treasure Wars') > scoreText(goalWords('play treasure wars solo'), 'Hide and Seek'))
  assert.ok(scoreText(goalWords("accept EndlessSkys's party invite"), 'Invites (1)') > 0)
  const item = (name, custom, lore) => ({ name, count: 1, customName: JSON.stringify({ text: custom }), customLore: lore ? [JSON.stringify({ text: lore })] : null })
  const MENUS = {
    games: { title: 'Games', entries: { 11: item('chest', 'Treasure Wars', 'Collect, defend, conquer'), 13: item('lantern', 'Hide and Seek'), 15: item('bow', 'Skywars') } },
    tw: { title: 'Treasure Wars', entries: { 10: item('iron_sword', 'Solo', '1,204 playing'), 12: item('iron_sword', 'Duos'), 14: item('iron_sword', 'Squads'), 26: item('arrow', 'Back') } },
    party: { title: 'Party & Friends', entries: { 10: item('cake', 'Create Party'), 12: item('paper', 'Invites (1)', 'People who invited you'), 14: item('player_head', 'Friends') } },
    invites: { title: 'Invites', entries: { 11: item('player_head', "EndlessSkys's party", 'Click to accept'), 26: item('arrow', 'Back') } }
  }
  const LINKS = { games: { 11: 'tw' }, tw: { 10: 'JOINED:tw-solo', 26: 'games' }, party: { 12: 'invites' }, invites: { 11: 'JOINED:party', 26: 'party' } }
  const bot = new EventEmitter()
  Object.assign(bot, { registry: reg, entity: { position: { x: 0, y: 64, z: 0 } }, game: { gameMode: 'adventure' }, players: {}, tablist: {}, scoreboard: {}, quickBarSlot: 0 })
  bot.inventory = { slots: Object.assign(new Array(46).fill(null), { 36: item('compass', 'Game Selector'), 38: item('player_head', 'Party & Friends') }) }
  let current = null
  const joined = []
  const open = (key) => { const m = MENUS[key]; const slots = new Array(63).fill(null); for (const [i, it] of Object.entries(m.entries)) slots[i] = it; const w = { key, title: JSON.stringify({ text: m.title }), inventoryStart: 27, slots }; current = w; setTimeout(() => bot.emit('windowOpen', w), 20) }
  bot.setQuickBarSlot = (i) => { bot.quickBarSlot = i }
  bot.activateItem = () => open(bot.quickBarSlot === 0 ? 'games' : 'party')
  bot.deactivateItem = () => {}
  bot.clickWindow = async (slot) => {
    const to = LINKS[current.key]?.[slot]
    if (!to) return
    if (to.startsWith('JOINED:')) { joined.push(to.slice(7)); current = null; setTimeout(() => bot.emit('windowClose'), 10); return }
    open(to)
  }
  bot.closeWindow = () => { current = null; setTimeout(() => bot.emit('windowClose'), 5) }
  const n = new Network({ bot, config: { network: {}, server: {}, behavior: { owners: ['EndlessSkys'] } }, log: { info () {} } })
  bot.on('windowOpen', (w) => { n.window = w })
  bot.on('windowClose', () => { n.window = null })
  const ctx = { bot, network: n, signal: null }
  const r1 = await ACTIONS.navigateMenus.run(ctx, { goal: 'play Treasure Wars solo' })
  assert.deepEqual(joined, ['tw-solo'], r1)
  assert.match(r1, /Game Selector → Treasure Wars → Solo/)
  const r2 = await ACTIONS.navigateMenus.run(ctx, { goal: "accept EndlessSkys's party invite" })
  assert.deepEqual(joined, ['tw-solo', 'party'], r2)
  assert.match(r2, /Party & Friends → Invites \(1\) → EndlessSkys's party/)
  await assert.rejects(ACTIONS.navigateMenus.run(ctx, { goal: 'buy a rank in the store' }), /Couldn't find a way/)
  console.log('menus:', r1, '|', r2)
  console.log('All menu navigation checks passed')
})().catch((err) => { console.error(err); process.exit(1) })
