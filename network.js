'use strict'

/**
 * network.js — playing on a public server network (minigame hubs, lobbies, parties) the way a regular there does.
 *
 * What it reads (state.server in the prompt):
 *   the sidebar scoreboard (game name, map, kills, time left...), the tab list header/footer, boss bars, the last
 *   title/subtitle and action-bar text, the named items in its hotbar ("Game Selector (Right Click)"), whether it's in
 *   a lobby, the commands the server offers (tab completion), and the menu that is open, item by item.
 *
 * What it does:
 *   - useHotbarItem / readMenu / clickMenu: open the game selector, read the menu, click the right entry
 *   - serverCommand: /play, /hub, /party, /friend, /tpa... (safe commands only; never admin ones)
 *   - accepts party, friend and teleport invites from its owners by itself (the clickable [ACCEPT] in chat, or the
 *     command the message names), so when you invite it, it follows you into your game
 *   - joinOwner: walk to you if you're here, else ask you (by voice when connected) to invite it
 *   - keeps quiet in public chat on networks (chat.publicChat), talking to its owner privately or by voice
 */

const SAFE_COMMAND = /^\/(hub|lobby|l|spawn|play|join|leave|queue|q|requeue|party|p|friend|f|msg|tell|w|r|reply|server|warp|home|tpa|tpaccept|tpahere|tpdeny|back|rules|help|list|games|menu|stats|kit|ready|vote|rejoin|ping|g|guild|pa|pc|pchat|ac|achat)\b/i
const DANGEROUS = /^\/(op|deop|stop|restart|ban|ban-ip|pardon|kick|gamemode|gm|give|i|item|kill|clear|fill|setblock|clone|tp|teleport|execute|reload|rl|whitelist|difficulty|time|weather|summon|effect|enchant|xp|experience|plugins|pl|lp|luckperms|perm|pex|sudo|eco|money|pay|bal|worldedit|we|\/\w+|data|function|scoreboard|team|tag|attribute|forceload|save-all|save-off|seed|debug|ver|version)\b/i
const LOBBY_WORDS = /lobby|hub|spawn|main|games|select|compass|navigator|play|server selector|game menu|queue/i
const INVITE = /invit|party|friend|request|teleport|tpa|wants to|join/i
const ACCEPT_CMD = /\/(party|p|friend|f|tpaccept|tpyes|duel|team)(\s+(accept|join|yes))?/i

/** Plain text of a chat component, an NBT/JSON item name, or a string. */
function textOf (registry, v) {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v === 'string' && !/^[{["]/.test(v)) return v.replace(/§./g, '')
  try {
    const ChatMessage = require('prismarine-chat')(registry)
    if (typeof v === 'string') return new ChatMessage(JSON.parse(v)).toString()
    if (v.toString && v.constructor?.name === 'ChatMessage') return v.toString()
    return ChatMessage.fromNotch(v).toString()
  } catch { return String(v?.text ?? v).replace(/§./g, '') }
}

/** Every run_command click action inside a chat component tree. */
function clickCommands (json, out = []) {
  if (!json || typeof json !== 'object') return out
  const c = json.clickEvent || json.click_event
  if (c && /run_command|suggest_command/.test(c.action)) out.push(String(c.value ?? c.command ?? ''))
  for (const k of ['extra', 'with']) if (Array.isArray(json[k])) for (const e of json[k]) clickCommands(e, out)
  return out
}

class Network {
  constructor (agent) {
    this.agent = agent
    this.title = null // { text, sub, at }
    this.actionbar = null // { text, at }
    this.commands = null // discovered command names
    this.lastInviteAt = 0
    this.window = null // the open menu
  }

  get cfg () { return this.agent.config.network || {} }
  get bot () { return this.agent.bot }

  attach (bot) {
    const reg = () => bot.registry
    bot.on('title', (t, type) => {
      const text = textOf(reg(), t)
      if (type === 'subtitle') this.title = { ...(this.title || {}), sub: text, at: Date.now() }
      else this.title = { text, sub: '', at: Date.now() }
    })
    bot.on('actionBar', (m) => { this.actionbar = { text: textOf(reg(), m), at: Date.now() } })
    bot.on('windowOpen', (w) => { this.window = w })
    bot.on('windowClose', () => { this.window = null })
    bot.on('message', (msg, position) => { try { this.onMessage(msg, position) } catch { /* not an invite */ } })
    bot.on('login', () => { this.commands = null; this.window = null }) // a new server on the network: learn its commands again
    bot.once('spawn', () => setTimeout(() => this.discoverCommands().catch(() => {}), 4000))
  }

  // --------------------------------------------------------------------------------------------------------------
  // Reading the server
  // --------------------------------------------------------------------------------------------------------------

  sidebar () {
    const sb = this.bot?.scoreboard?.sidebar
    if (!sb) return null
    const lines = sb.items.map((i) => textOf(this.bot.registry, i.displayName)).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && !/^[-=_ ]+$/.test(l))
    return { title: textOf(this.bot.registry, sb.title), lines: lines.slice(0, 15) }
  }

  hotbarItems () {
    const bot = this.bot
    const out = []
    for (let i = 0; i < 9; i++) {
      const it = bot.inventory.slots[36 + i]
      if (!it) continue
      const name = textOf(bot.registry, it.customName)
      if (name) out.push({ slot: i, item: it.name, name })
    }
    return out
  }

  /** A minigame network, rather than a plain survival server? */
  isNetwork () {
    if (this.cfg.public === true) return true
    if (this.cfg.public === false) return false
    const bot = this.bot
    if (!bot?.entity) return false
    const sb = this.sidebar()
    const named = this.hotbarItems()
    const tab = `${textOf(bot.registry, bot.tablist?.header)} ${textOf(bot.registry, bot.tablist?.footer)}`
    const players = Object.keys(bot.players || {}).length
    let score = 0
    if (sb?.lines.length >= 3) score++
    if (named.length >= 2) score++
    if (/\.(net|com|gg|org|co|io)\b|store\.|discord|www\./i.test(tab)) score++
    if (players >= 30) score++
    if (bot.game?.gameMode === 'adventure') score++
    return score >= 2
  }

  inLobby () {
    const sb = this.sidebar()
    const named = this.hotbarItems()
    return this.isNetwork() && (LOBBY_WORDS.test(`${sb?.title} ${sb?.lines.join(' ')}`) || named.some((n) => LOBBY_WORDS.test(n.name))) && this.bot.game?.gameMode === 'adventure'
  }

  /** What the prompt sees about the server (only things worth knowing). */
  context () {
    const bot = this.bot
    if (!bot?.entity) return undefined
    const net = this.isNetwork()
    if (!net && !this.window) return undefined
    const out = { kind: this.inLobby() ? 'network lobby' : 'network game' }
    const sb = this.sidebar()
    if (sb) out.sidebar = `${sb.title}: ${sb.lines.join(' | ')}`.slice(0, 300)
    const bars = Object.values(bot.bossBars || {}).map((b) => textOf(bot.registry, b.title)).filter(Boolean)
    if (bars.length) out.bossBars = bars.slice(0, 3)
    if (this.title && Date.now() - this.title.at < 15000) out.title = [this.title.text, this.title.sub].filter(Boolean).join(' — ')
    if (this.actionbar && Date.now() - this.actionbar.at < 8000) out.actionBar = this.actionbar.text
    const named = this.hotbarItems()
    if (named.length) out.hotbar = named.map((n) => `${n.slot + 1}: ${n.name}`)
    if (this.window) out.openMenu = this.describeWindow()
    if (this.commands?.length) out.commands = this.commands.filter((c) => SAFE_COMMAND.test(`/${c}`)).slice(0, 25).map((c) => `/${c}`)
    out.note = 'A public server: be polite, follow its rules, don\'t spam public chat; menus and hotbar items take you to games; your owner invites you to their party to bring you along.'
    return out
  }

  // --------------------------------------------------------------------------------------------------------------
  // Menus and commands
  // --------------------------------------------------------------------------------------------------------------

  /** The open menu, entry by entry: "12: Bed Wars (2,345 playing)". */
  describeWindow (w = this.window) {
    if (!w) return null
    const reg = this.bot.registry
    const items = []
    const end = w.inventoryStart ?? w.slots.length
    for (let i = 0; i < end; i++) {
      const it = w.slots[i]
      if (!it || /glass_pane$/.test(it.name) && !it.customName) continue
      const name = textOf(reg, it.customName) || it.name.replace(/_/g, ' ')
      if (/^\s*$/.test(name)) continue
      const lore = (Array.isArray(it.customLore) ? it.customLore : []).map((l) => textOf(reg, l)).filter(Boolean).slice(0, 2).join(' / ')
      items.push(`${i}: ${name}${lore ? ` (${lore.slice(0, 60)})` : ''}`)
    }
    return { title: textOf(reg, w.title), items: items.slice(0, 40) }
  }

  /** Find a menu slot by what it says (fuzzy: "bedwars" matches "Bed Wars"). */
  findSlot (wanted, w = this.window) {
    if (!w) return null
    const want = String(wanted).toLowerCase().replace(/[^a-z0-9]/g, '')
    const end = w.inventoryStart ?? w.slots.length
    let best = null
    for (let i = 0; i < end; i++) {
      const it = w.slots[i]
      if (!it) continue
      const name = (textOf(this.bot.registry, it.customName) || it.name).toLowerCase().replace(/[^a-z0-9]/g, '')
      if (!name) continue
      if (name === want) return i
      if (name.includes(want) || want.includes(name)) best = best ?? i
    }
    return best
  }

  async discoverCommands () {
    const bot = this.bot
    if (!bot?.tabComplete) return []
    const raw = await bot.tabComplete('/', true, false, 4000).catch(() => [])
    this.commands = [...new Set((raw || []).map((m) => String(m.match ?? m).replace(/^\//, '').split(/\s/)[0]).filter((c) => c && !c.includes(':')))].slice(0, 200)
    return this.commands
  }

  /** May it run this command? Safe ones, or ones the server offers that aren't admin tools. */
  allowed (cmd) {
    const c = `/${String(cmd).trim().replace(/^\/+/, '')}`
    if (DANGEROUS.test(c)) return false
    if (SAFE_COMMAND.test(c)) return true
    const name = c.slice(1).split(/\s/)[0].toLowerCase()
    return Boolean(this.commands?.includes(name))
  }

  // --------------------------------------------------------------------------------------------------------------
  // Invites from its owner: follow them
  // --------------------------------------------------------------------------------------------------------------

  onMessage (msg, position) {
    if (this.cfg.acceptInvites === false || position === 'chat') return // invites are server notices, not player chat
    const text = msg.toString()
    if (!INVITE.test(text) || Date.now() - this.lastInviteAt < 4000) return
    const owners = this.agent.config.behavior.owners || []
    const who = owners.find((o) => new RegExp(`(^|[^A-Za-z0-9_])\\.?${o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text))
    if (!who) return
    const esc = who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`^\\s*(\\[[^\\]]*\\]\\s*)*(<\\.?${esc}>|\\.?${esc}\\s*[:»>|])`, 'i').test(text)) return // their own chat line, not a server notice
    const json = safe(() => msg.json) || msg
    let cmd = clickCommands(json).find((c) => /accept|join|yes/i.test(c)) || clickCommands(json).find((c) => c.startsWith('/'))
    if (!cmd) {
      const m = text.match(ACCEPT_CMD)
      if (m) {
        cmd = m[0]
        const after = text.slice(m.index + m[0].length)
        if (new RegExp(`^\\s+\\.?${who}\\b`, 'i').test(after)) cmd += ` ${who}` // "/party accept EndlessSkys"
      }
      else if (/tpa|teleport/i.test(text)) cmd = '/tpaccept'
      else if (/party/i.test(text)) cmd = `/party accept ${who}`
      else if (/friend/i.test(text)) cmd = `/friend accept ${who}`
    }
    if (!cmd || DANGEROUS.test(cmd)) return
    this.lastInviteAt = Date.now()
    this.agent.log.info(`${who} invited it (${text.slice(0, 80)}): ${cmd}`)
    this.agent.memory?.addEvent('invite', `${who} invited you, and you accepted (${cmd}).`)
    setTimeout(() => { try { this.bot.chat(cmd) } catch { /* gone */ } }, 600 + Math.random() * 900) // a moment to read it
  }
}

function safe (fn) { try { return fn() } catch { return null } }

/** Actions for playing on networks, installed into ACTIONS. */
function install (ACTIONS, h, SHORT = {}) {
  const { argString, ActionError, sleep, gotoGoal, goals } = h
  const net = (ctx) => ctx.network
  const waitWindow = (bot, ms) => new Promise((resolve) => {
    const t = setTimeout(() => { bot.removeListener('windowOpen', on); resolve(null) }, ms)
    const on = (w) => { clearTimeout(t); resolve(w) }
    bot.once('windowOpen', on)
  })

  ACTIONS.useHotbarItem = {
    description: 'Right-click a named item in your hotbar, like the "Game Selector" compass in a server lobby, and see what opens.',
    params: { itemName: 'string, part of the item\'s name (e.g. "game selector", "compass", "profile")' },
    async run (ctx, args) {
      const { bot } = ctx
      const want = argString(args, 'itemName').toLowerCase()
      const n = net(ctx)
      const named = n.hotbarItems()
      const pick = named.find((x) => x.name.toLowerCase().includes(want)) || named.find((x) => x.item.includes(want.replace(/\s+/g, '_')))
      const slot = pick ? pick.slot : [...Array(9).keys()].find((i) => bot.inventory.slots[36 + i]?.name.includes(want.replace(/\s+/g, '_')))
      if (slot === undefined || slot === null) throw new ActionError('NOT_FOUND', `No "${want}" in your hotbar. Hotbar: ${named.map((x) => x.name).join(', ') || 'nothing named'}.`)
      bot.setQuickBarSlot(slot)
      await sleep(250)
      const opened = waitWindow(bot, 2500)
      bot.activateItem()
      await sleep(80)
      bot.deactivateItem()
      const w = await opened
      if (!w) return `Used ${pick?.name || 'it'}; no menu opened (maybe it did something else: look around).`
      const d = n.describeWindow(w)
      return `Opened "${d.title}": ${d.items.join('; ').slice(0, 700)}`
    }
  }

  ACTIONS.readMenu = {
    description: 'Read the menu (chest-style GUI) that is open: every entry and its slot number.',
    params: {},
    async run (ctx) {
      const d = net(ctx).describeWindow()
      if (!d) throw new ActionError('NO_MENU', 'No menu is open.')
      return `"${d.title}": ${d.items.join('; ').slice(0, 800)}`
    }
  }

  ACTIONS.clickMenu = {
    description: 'Click an entry in the open menu, by what it says ("Bed Wars", "Solo", "Join") or by slot number.',
    params: { entry: 'string, optional: what the entry says', slot: 'number, optional', rightClick: 'optional boolean' },
    async run (ctx, args) {
      const { bot } = ctx
      const n = net(ctx)
      if (!n.window) throw new ActionError('NO_MENU', 'No menu is open: open one first (useHotbarItem or a command).')
      const slot = Number.isFinite(Number(args.slot)) ? Number(args.slot) : n.findSlot(argString(args, 'entry'))
      if (slot === null || slot === undefined) throw new ActionError('NOT_FOUND', `No "${args.entry}" in the menu. It has: ${n.describeWindow().items.join('; ').slice(0, 500)}`)
      const before = n.window
      await sleep(250 + Math.random() * 400) // finding it in the grid
      const next = waitWindow(bot, 2000)
      await bot.clickWindow(slot, args.rightClick ? 1 : 0, 0).catch(() => {})
      const w = await next
      if (w && w !== before) { const d = n.describeWindow(w); return `Clicked; a new menu opened: "${d.title}": ${d.items.join('; ').slice(0, 600)}` }
      await sleep(800)
      if (!n.window) return 'Clicked; the menu closed (you may be on your way to a game: watch the title and chat).'
      return 'Clicked.'
    }
  }

  ACTIONS.serverCommand = {
    description: 'Run a server command a player would use: /play <game>, /hub, /party accept <name>, /friend add <name>, /tpa <name>, /rules, /help. Never admin commands.',
    params: { command: 'string, e.g. "/play bedwars"' },
    async run (ctx, args) {
      const { bot } = ctx
      const cmd = `/${argString(args, 'command').trim().replace(/^\/+/, '')}`
      if (!net(ctx).allowed(cmd)) throw new ActionError('NOT_ALLOWED', `${cmd.split(' ')[0]} isn't something you'd use here (admin tool, or this server doesn't have it).`)
      const heard = []
      const on = (m, pos) => { if (pos !== 'game_info') heard.push(String(m)) }
      bot.on('messagestr', on)
      bot.chat(cmd)
      await sleep(1500)
      bot.removeListener('messagestr', on)
      return `Sent ${cmd}.${heard.length ? ` The server said: ${heard.slice(0, 4).join(' | ').slice(0, 400)}` : ''}`
    }
  }

  ACTIONS.joinOwner = {
    description: 'Go to your owner: walk over if they are here, otherwise ask them to invite you to their party (you accept invites from them by yourself).',
    params: {},
    async run (ctx) {
      const { bot } = ctx
      const owner = (ctx.config.behavior.owners || [])[0]
      if (!owner) throw new ActionError('NO_OWNER', 'You have no owner to join.')
      const e = bot.players[owner]?.entity
      if (e) {
        if (e.position.distanceTo(bot.entity.position) > 3) await gotoGoal(ctx, new goals.GoalFollow(e, 2), { timeoutMs: 60000, label: owner })
        return `With ${owner}.`
      }
      const text = `I can't see you from here. Invite me to your party and I'll come along.`
      const sent = ctx.voice?.active() ? await ctx.voice.say(text) : await ctx.chat.send(text, 'reply', { whisperTo: bot.players[owner] ? owner : undefined })
      return sent ? `Asked ${owner} to send a party invite (you accept it by yourself).` : `${owner} isn't on this server part; wait for their invite.`
    }
  }

  Object.assign(SHORT, {
    useHotbarItem: 'right-click a named hotbar item (game selector...) and see the menu',
    readMenu: 'read the open menu',
    clickMenu: 'click a menu entry',
    serverCommand: 'run a player command (/play, /hub, /party...)',
    joinOwner: 'go to your owner, or ask for a party invite'
  })
}

module.exports = { Network, install, textOf, clickCommands, SAFE_COMMAND, DANGEROUS }
