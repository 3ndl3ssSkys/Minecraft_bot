'use strict'
/**
 * npm run record [-- --server localhost:25565] [--port 25566] [--level advanced] [--goal "get iron gear"]
 *
 * Records you playing, as training examples for the bot. Start it, then in Minecraft join "localhost:25566" instead
 * of your server: you play normally (it passes everything through untouched), and it writes down
 *   - each thing you decide to do, in the bot's own actions: mining 12 stone, crafting a pickaxe, eating, fighting a
 *     zombie, storing things in a chest, saying something... each with the moment you decided it, described the way the
 *     bot sees a moment (observe.js). → data/training/demos/<time>.jsonl, which npm run training-set -- --short uses;
 *   - how you move: every look and move packet, your keys, swings and hits, 20 times a second.
 *     → data/training/motion/<time>.jsonl, for npm run analyze-motion (your aim and movement as numbers).
 *
 * Only for servers in offline mode (your local test server, online-mode=false): an online-mode connection is
 * encrypted, so it can't be read (and we don't try to get around that). It reads the connection; it never changes it.
 *
 * Say "goal: <what you're doing>" in chat now and then (e.g. "goal: get a full set of iron armor"): it's stored as the
 * goal of the examples that follow, so the model learns why, not only what.
 */
const net = require('net')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { EventEmitter } = require('events')
const { Duplex } = require('stream')
const mc = require('minecraft-protocol')
const mineflayer = require('mineflayer')
const mcData = require('minecraft-data')
const { createDeserializer } = require('minecraft-protocol/src/transforms/serializer')
const observe = require('../observe')

const LEVELS = ['beginner', 'mediocre', 'advanced', 'hardcore', 'expert', 'master', 'impossible', 'complicated']

function args (argv) {
  const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def }
  const [host, port] = String(opt('--server', 'localhost:25565')).split(':')
  return {
    host,
    port: Number(port) || 25565,
    listen: Number(opt('--port', 25566)),
    level: String(opt('--level', 'advanced')).toLowerCase(),
    goal: opt('--goal', ''),
    out: opt('--out', path.join(__dirname, '..', 'data', 'training')),
    debug: argv.includes('--debug')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the stream: Minecraft packets are length-prefixed (varint), compressed above a threshold, never encrypted
// in offline mode.
// ---------------------------------------------------------------------------------------------------------------

function readVarInt (buf, at) {
  let n = 0
  let shift = 0
  for (let i = at; i < buf.length && i < at + 5; i++) {
    n |= (buf[i] & 0x7f) << shift
    if (!(buf[i] & 0x80)) return { value: n, size: i - at + 1 }
    shift += 7
  }
  return null
}

/** Splits a byte stream into packet payloads (decompressed). threshold() says whether compression is on. */
class Frames {
  constructor (threshold, onPayload) {
    this.buf = Buffer.alloc(0)
    this.threshold = threshold
    this.onPayload = onPayload
  }

  feed (chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      const len = readVarInt(this.buf, 0)
      if (!len || this.buf.length < len.size + len.value) return
      let frame = this.buf.subarray(len.size, len.size + len.value)
      this.buf = this.buf.subarray(len.size + len.value)
      if (this.threshold() >= 0) {
        const dl = readVarInt(frame, 0)
        if (!dl) continue
        frame = dl.value === 0 ? frame.subarray(dl.size) : safe(() => zlib.inflateSync(frame.subarray(dl.size)))
        if (!frame) continue
      }
      this.onPayload(frame)
    }
  }
}

function safe (fn) { try { return fn() } catch { return undefined } }

/** The version name for a protocol number, preferring one minecraft-data has full data for. */
function versionFor (protocol) {
  const names = mcData.postNettyVersionsByProtocolVersion.pc[protocol] || []
  return names.map((v) => v.minecraftVersion).find((v) => safe(() => mcData(v)?.blocksArray?.length)) || null
}

/** The first packet a client sends: protocol version, address, and what it wants (1 status, 2 login, 3 transfer). */
function readHandshake (payload) {
  const id = readVarInt(payload, 0)
  if (!id || id.value !== 0) return null
  const pv = readVarInt(payload, id.size)
  if (!pv) return null
  const hl = readVarInt(payload, id.size + pv.size)
  if (!hl) return null
  const at = id.size + pv.size + hl.size + hl.value + 2
  const next = readVarInt(payload, at)
  return next ? { protocol: pv.value, nextState: next.value } : null
}

// ---------------------------------------------------------------------------------------------------------------
// One recorded session: a player's connection through the proxy.
// ---------------------------------------------------------------------------------------------------------------

class Session extends EventEmitter {
  constructor (opts, log) {
    super()
    this.opts = opts
    this.log = log
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.goal = opts.goal || ''
    this.snaps = [] // { at, snap } once a second, to find the moment a decision was made
    this.examples = 0
    this.recent = { actions: [], chat: [], events: [] }
    this.seg = null
    this.lastActAt = Date.now()
    this.travel = { at: Date.now(), from: null, dist: 0 }
    this.pendingDemos = [] // written once we know they didn't end in death
  }

  /** Called with the handshake: sets up the readers for both directions. */
  start (protocol) {
    this.version = versionFor(protocol)
    if (!this.version) { this.log(`This Minecraft version (protocol ${protocol}) isn't known to minecraft-data: just passing it through, nothing recorded.`); return false }
    this.reg = mcData(this.version)
    this.hasConfig = this.reg.version['>=']('1.20.2')
    this.state = 'login'
    this.parsers = {}
    // The server's side goes into a real (silent) client and a mineflayer bot: the world, inventory, health, entities.
    this.feedObserver = []
    this.toServer = new Frames(() => this.obs?.compressionThreshold ?? -1, (p) => this.serverbound(p))
    const dir = path.join(this.opts.out)
    this.demoFile = path.join(dir, 'demos', `${this.stamp}.jsonl`)
    this.motionFile = path.join(dir, 'motion', `${this.stamp}.jsonl`)
    fs.mkdirSync(path.dirname(this.demoFile), { recursive: true })
    fs.mkdirSync(path.dirname(this.motionFile), { recursive: true })
    this.motion = fs.createWriteStream(this.motionFile, { flags: 'a' })
    return true
  }

  /** The player's name is known (login_start): now the observer can be made. */
  makeObserver (username) {
    this.username = username
    const sink = new Duplex({ read () {}, write (chunk, enc, cb) { cb() } }) // its own packets go nowhere
    this.sink = sink
    this.obs = mc.createClient({ stream: sink, username, version: this.version, auth: 'offline', keepAlive: false, hideErrors: true })
    // With a stream and an offline account, minecraft-protocol emits "connect" before its login handler is attached:
    // emit it again so the observer moves to the login state like the real client did.
    this.obs.emit('connect')
    this.obs.on('error', (err) => { if (this.opts.debug) this.log(`observer: ${err.message}`) })
    if (this.opts.debug) this.obs.on('packet', (d, meta) => { if (!/chunk|light|entity|move|sound|position|time|head/.test(meta.name)) this.log(`← ${meta.state} ${meta.name}`) })
    this.obs.on('encryption_begin', () => this.log('This server is in online mode: the connection is encrypted and can\'t be recorded. Use your local test server with online-mode=false.'))
    const bot = mineflayer.createBot({ client: this.obs, username, version: this.version, physicsEnabled: false, hideErrors: true, logErrors: false })
    bot.on('error', () => {})
    this.bot = bot
    for (const c of this.feedObserver.splice(0)) sink.push(c)
    bot.once('spawn', () => {
      this.log(`Watching ${username} (Minecraft ${this.version}). Play normally; say "goal: ..." in chat to say what you're working on.`)
      this.tick = setInterval(() => this.everySecond(), 1000)
    })
    bot.on('health', () => this.onHealth())
    bot.on('death', () => this.onDeath())
    bot.on('messagestr', (text, position) => {
      if (position === 'game_info' || /\bgoal\s*:/i.test(text)) return // notes for the recording aren't chat
      this.recent.chat.push(text.replace(/[§&][0-9a-fk-or]/gi, '').slice(0, 160)); this.recent.chat = this.recent.chat.slice(-6)
    })
  }

  fromServer (chunk) {
    if (this.sink) this.sink.push(chunk)
    else this.feedObserver.push(chunk)
  }

  fromClient (chunk) { this.toServer?.feed(chunk) }

  parser () {
    const name = this.state === 'configuration' ? 'configuration' : this.state
    this.parsers[name] ||= createDeserializer({ state: name, isServer: true, version: this.version, noErrorLogging: true })
    return this.parsers[name]
  }

  serverbound (payload) {
    if (!this.hasConfig && this.state !== 'play' && this.obs?.state === 'play') this.state = 'play'
    const p = safe(() => this.parser().parsePacketBuffer(payload))
    const name = p?.data?.name
    if (this.opts.debug) this.log(`→ ${this.state} ${name || `? (${payload.length} bytes)`} | observer ${this.obs?.state}`)
    if (!name) return
    const d = p.data.params
    if (this.state === 'login') {
      if (name === 'login_start' && !this.obs) this.makeObserver(d.username)
      if (name === 'login_acknowledged') this.state = 'configuration'
      return
    }
    if (this.state === 'configuration') { if (name === 'finish_configuration') this.state = 'play'; return }
    if (name === 'configuration_acknowledged') { this.state = 'configuration'; return }
    safe(() => this.onPlayPacket(name, d))
  }

  // ---- What the player does (their packets) --------------------------------------------------------------------

  onPlayPacket (name, d) {
    const bot = this.bot
    if (!bot?.entity) return
    const t = Date.now()
    const m = (row) => this.motion.write(JSON.stringify([t, ...row]) + '\n')
    switch (name) {
      case 'position': case 'position_look': case 'look': case 'flying': {
        const e = bot.entity
        if (d.x !== undefined) {
          const before = e.position.clone()
          e.position.set(d.x, d.y, d.z)
          this.onMoved(before, e.position)
        }
        if (d.yaw !== undefined) { e.yaw = Math.PI - (d.yaw * Math.PI) / 180; e.pitch = -(d.pitch * Math.PI) / 180 }
        const ground = typeof d.onGround === 'boolean' ? d.onGround : Boolean((d.flags ?? 0) & 1)
        e.onGround = ground
        m(['m', round2(e.position.x), round2(e.position.y), round2(e.position.z), round2(d.yaw ?? this.lastYaw ?? 0), round2(d.pitch ?? this.lastPitch ?? 0), ground ? 1 : 0])
        if (d.yaw !== undefined) { this.lastYaw = d.yaw; this.lastPitch = d.pitch }
        break
      }
      case 'player_input': { // 1.21.2+: the movement keys themselves
        const k = d.inputs || d
        const keys = ['forward', 'backward', 'left', 'right', 'jump', 'shift', 'sprint'].filter((x) => k[x]).map((x) => x[0]).join('')
        m(['k', keys])
        this.sneaking = Boolean(k.shift)
        break
      }
      case 'entity_action': m(['a', d.actionId]); if (d.actionId === 0 || d.actionId === 1) this.sneaking = d.actionId === 0; break // sprint / sneak (older versions), elytra
      case 'arm_animation': m(['s']); break
      case 'held_item_slot': bot.quickBarSlot = d.slotId; safe(() => bot.updateHeldItem()); break
      case 'use_entity': {
        const target = bot.entities[d.target]
        const attack = d.mouse === 1 || d.type === 1 || d.mouse === 'attack'
        if (target) m(['h', d.target, attack ? 1 : 0, round2(target.position.x), round2(target.position.y + (target.height || 1.8) * 0.85), round2(target.position.z), target.name || ''])
        if (attack && target) this.act('attackTarget', { entityId: target.id }, `fight:${target.id}`, `fighting the ${target.username || target.name}`)
        break
      }
      case 'block_dig': case 'player_action': this.onDig(d); break
      case 'block_place': case 'use_item_on': this.onUseOn(d); break
      case 'use_item': this.onUse(); break
      case 'window_click': case 'container_click': this.onClick(d); break
      case 'close_window': case 'container_close': this.onClose(); break
      case 'chat_message': case 'chat': this.onChat(String(d.message || '')); break
    }
  }

  onMoved (before, now) {
    const flat = Math.hypot(now.x - before.x, now.z - before.z)
    if (flat < 8) this.travel.dist += flat // teleports aren't walking
  }

  onDig (d) {
    const bot = this.bot
    const status = d.status
    const pos = d.location
    if (status === 3 || status === 4) { // dropping the held item (stack / one)
      const held = bot.heldItem?.name
      if (held) this.act('dropItems', { itemNames: held }, `drop:${held}`, `getting rid of ${held.replace(/_/g, ' ')}`)
      return
    }
    if (status === 5) return // finishing using an item (bow release, eating): handled with use_item
    const b = pos && bot.blockAt(new (require('vec3'))(pos.x, pos.y, pos.z))
    if (!b) return
    if (status === 0) { this.digging = { name: b.name, at: Date.now() }; if (bot.game?.gameMode === 'creative') this.dug(b.name) }
    if (status === 2) this.dug(b.name) // finished breaking it
  }

  dug (name) {
    if (/^(air|cave_air|short_grass|tall_grass|fern|large_fern|snow|dead_bush|seagrass|vine|fire)$/.test(name)) return // brushing past
    const kind = /_log$/.test(name) ? 'log' : name
    const seg = this.seg
    const count = seg?.name === 'mineBlock' && seg.key === `mine:${kind}` ? Math.min(16, (seg.args.count || 1) + 1) : 1
    this.act('mineBlock', { blockType: /_log$/.test(name) ? name : name, count }, `mine:${kind}`, `mining ${name.replace(/_/g, ' ')}`)
  }

  onUseOn (d) {
    const bot = this.bot
    const pos = d.location
    if (!pos) return
    const target = bot.blockAt(new (require('vec3'))(pos.x, pos.y, pos.z))
    const held = bot.heldItem
    const faces = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
    const f = faces[typeof d.direction === 'number' ? d.direction : 1] || [0, 1, 0]
    if (target && /_bed$/.test(target.name)) return this.act('sleepInBed', {}, 'sleep', 'going to bed')
    if (target && /(_door|_trapdoor|_fence_gate|lever|_button)$/.test(target.name) && !this.sneaking) return this.act('activateBlock', { x: pos.x, y: pos.y, z: pos.z }, `use:${pos.x},${pos.y},${pos.z}`, `using the ${target.name.replace(/_/g, ' ')}`)
    if (target && /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|ender_chest|shulker_box|.*_shulker_box|anvil|enchanting_table|brewing_stand)$/.test(target.name)) { this.station = target.name; return } // what happens inside is recorded on close
    if (!held) return
    if (this.reg.blocksByName[held.name] || held.name === 'torch') {
      const at = { x: pos.x + f[0], y: pos.y + f[1], z: pos.z + f[2] }
      const key = `place:${held.name}`
      if (this.seg?.key === key) { this.seg.count++; this.seg.last = Date.now(); return } // a row of the same block: one decision
      this.act('placeBlock', { blockType: held.name, ...at }, key, `placing ${held.name.replace(/_/g, ' ')}`)
    } else if (/bucket|flint_and_steel|bone_meal|_hoe$|shears/.test(held.name)) this.act('useItem', { itemName: held.name, target: `${pos.x},${pos.y},${pos.z}` }, `useon:${held.name}`, `using the ${held.name.replace(/_/g, ' ')}`)
  }

  onUse () {
    const bot = this.bot
    const held = bot.heldItem
    if (!held) return
    if (this.reg.foodsByName?.[held.name] && bot.food < 20) { this.eating = { food: held.name, level: bot.food, at: Date.now() }; return }
    if (held.name === 'fishing_rod') return this.act('fish', {}, 'fish', 'fishing')
    if (/_(helmet|chestplate|leggings|boots)$|^elytra$/.test(held.name)) return this.act('equipItem', { itemName: held.name, destination: /helmet/.test(held.name) ? 'head' : /chestplate|elytra/.test(held.name) ? 'torso' : /leggings/.test(held.name) ? 'legs' : 'feet' }, `equip:${held.name}`, `putting on the ${held.name.replace(/_/g, ' ')}`)
    if (/^(bow|crossbow|trident|shield)$/.test(held.name)) return // part of a fight
    this.act('useItem', { itemName: held.name }, `use:${held.name}`, `using the ${held.name.replace(/_/g, ' ')}`)
  }

  onHealth () {
    const e = this.eating
    if (e && Date.now() - e.at < 5000 && this.bot.food > e.level) {
      this.eating = null
      this.act('eatFood', { foodName: e.food }, `eat:${e.food}`, `eating ${e.food.replace(/_/g, ' ')}`)
    }
  }

  onDeath () {
    // Whatever was decided in the last 15 s led to dying: not an example to learn from.
    const cut = Date.now() - 15000
    for (const d of this.pendingDemos) if (d.decidedAt > cut) d.bad = 'died soon after'
    if (this.seg && this.seg.startedAt > cut) this.seg.bad = 'died soon after'
    this.recent.events.push('You died.')
    this.flush(true)
  }

  /** Inventory clicks: the player's own inventory (window 0) or an open one. 1.17+ packets carry the changed slots. */
  onClick (d) {
    const bot = this.bot
    const win = d.windowId === 0 ? bot.inventory : bot.currentWindow || bot.inventory
    const asItem = (it) => {
      const id = it?.itemId ?? it?.blockId
      const count = it?.itemCount ?? it?.count
      if (!id || id < 0 || !count) return null
      const Item = require('prismarine-item')(this.version)
      return new Item(id, count)
    }
    // A craft: taking the result (slot 0) of the 2x2 grid or a crafting table.
    if (d.slot === 0 && (d.windowId === 0 || /crafting/.test(String(win?.type || win?.title || '')))) {
      const result = win.slots[0]
      if (result) {
        const name = result.name
        const before = this.count(name)
        const per = result.count || 1
        setTimeout(() => {
          const gained = Math.max(per, this.count(name) - before)
          const seg = this.seg
          const crafts = Math.ceil(gained / per) + (seg?.key === `craft:${name}` ? seg.args.count : 0)
          this.act('craftItem', { itemName: name, count: crafts }, `craft:${name}`, `crafting ${name.replace(/_/g, ' ')}`)
        }, 700)
      }
    }
    // A furnace's output (slot 2).
    if (d.slot === 2 && /furnace|smoker/.test(String(win?.type || ''))) {
      const input = win.slots[0]?.name || this.furnaceInput
      if (input) this.act('smeltItem', { itemName: input, count: win.slots[2]?.count || 8 }, `smelt:${input}`, `smelting ${input.replace(/_/g, ' ')}`)
    }
    if (/furnace|smoker/.test(String(win?.type || '')) && win.slots[0]) this.furnaceInput = win.slots[0].name
    for (const c of d.changedSlots || []) {
      const it = asItem(c.item)
      safe(() => win.updateSlot(c.location, it))
      if (d.windowId === 0 && c.location >= 5 && c.location <= 8 && it) this.act('equipItem', { itemName: it.name, destination: ['head', 'torso', 'legs', 'feet'][c.location - 5] }, `equip:${it.name}`, `putting on the ${it.name.replace(/_/g, ' ')}`)
    }
    safe(() => { win.selectedItem = asItem(d.cursorItem) })
    if (bot.currentWindow && !this.openInv) this.openInv = { counts: this.counts(), station: this.station, type: String(bot.currentWindow.type || '') }
  }

  onClose () {
    const o = this.openInv
    this.openInv = null
    if (!o || !/chest|barrel|shulker|generic/.test(o.type + (o.station || ''))) return
    const now = this.counts()
    const gains = Object.entries(now).map(([n, c]) => [n, c - (o.counts[n] || 0)]).filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])
    const losses = Object.entries(o.counts).map(([n, c]) => [n, c - (now[n] || 0)]).filter(([, l]) => l > 0).sort((a, b) => b[1] - a[1])
    if (losses.length) this.act('storeItems', { itemNames: losses.slice(0, 6).map(([n]) => n).join(', ') }, 'store', 'putting things away in the chest')
    if (gains.length) this.act('takeItems', { itemName: gains[0][0], count: gains[0][1] }, `take:${gains[0][0]}`, `taking ${gains[0][0].replace(/_/g, ' ')} from the chest`)
  }

  onChat (text) {
    const g = text.match(/^\s*goal\s*:\s*(.+)$/i)
    if (g) { this.goal = g[1].trim().slice(0, 120); this.log(`Goal noted: ${this.goal}`); return }
    if (text.startsWith('/')) return
    this.act('chatMessage', { text: text.slice(0, 200) }, `chat:${Date.now()}`, 'saying something')
  }

  count (name) { return this.counts()[name] || 0 }
  counts () {
    const c = {}
    for (const it of this.bot.inventory.items()) c[it.name] = (c[it.name] || 0) + it.count
    const cur = this.bot.inventory.selectedItem
    if (cur) c[cur.name] = (c[cur.name] || 0) + cur.count
    return c
  }

  // ---- Turning acts into decisions ------------------------------------------------------------------------------

  /**
   * One act in the bot's own action words. The same act again (more of the same block, the same mob) continues the
   * current decision; anything else closes it and starts a new one, dated back to when the player moved on from the
   * last thing (that's when they decided).
   */
  act (name, args, key, thought) {
    const now = Date.now()
    if (this.seg && this.seg.key === key && now - this.seg.last < 25000) {
      this.seg.args = { ...this.seg.args, ...args }
      this.seg.last = now
      this.seg.count++
      return
    }
    this.close()
    // A long walk with nothing else first: that was its own decision (going exploring).
    if (this.travel.dist > 40 && now - this.lastActAt > 25000) {
      const dist = Math.min(64, Math.round(this.travel.dist))
      this.pushSeg({ name: 'explore', args: { distance: dist }, key: 'explore', thought: 'having a look around', startedAt: this.lastActAt + 1500, last: now - 1000, count: 1 })
      this.close()
    }
    this.pushSeg({ name, args, key, thought, startedAt: Math.max(this.lastActAt + 500, now - 15000), last: now, count: 1 })
  }

  pushSeg (seg) {
    seg.snap = this.snapAt(seg.startedAt)
    seg.recentActions = this.recent.actions.slice(-3)
    seg.recentEvents = this.recent.events.slice(-3)
    seg.goal = this.goal
    this.seg = seg
    this.travel = { at: Date.now(), dist: 0 }
  }

  close () {
    const s = this.seg
    if (!s) return
    this.seg = null
    this.lastActAt = s.last
    this.recent.actions.push({ action: s.name, args: s.args, ok: true }); this.recent.actions = this.recent.actions.slice(-6)
    if (!s.snap) return
    const snap = { ...s.snap, status: { goal: s.goal || null }, recentActions: s.recentActions, recentEvents: s.recentEvents }
    this.pendingDemos.push({
      decidedAt: s.startedAt,
      bad: s.bad,
      line: {
        at: new Date(s.startedAt).toISOString(),
        model: 'human',
        level: this.opts.level,
        short: shortPrompt(this.username, this.opts.level),
        compact: observe.compact(snap, { coords: true }),
        answer: { thought: thoughtFor(s), goal: s.goal || '', subgoal: '', goalStatus: 'working', action: { name: s.name, args: s.args }, next: [] },
        ok: true
      }
    })
    this.flush(false)
  }

  /** Writes the decisions old enough that we know they didn't end in dying. */
  flush (all) {
    const cut = Date.now() - 15000
    const keep = []
    for (const d of this.pendingDemos) {
      if (!all && d.decidedAt > cut) { keep.push(d); continue }
      if (d.bad) d.line.ok = false
      fs.appendFileSync(this.demoFile, JSON.stringify(d.line) + '\n')
      if (!d.bad) this.examples++
    }
    this.pendingDemos = keep
  }

  /** The snapshot closest to a moment (taken once a second). */
  snapAt (t) {
    let best = null
    for (const s of this.snaps) if (!best || Math.abs(s.at - t) < Math.abs(best.at - t)) best = s
    return best?.snap || safe(() => observe.miniSnapshot(this.bot, {}))
  }

  everySecond () {
    const bot = this.bot
    if (!bot?.entity) return
    const snap = safe(() => observe.miniSnapshot(bot, { recentChat: this.recent.chat.slice(-3) }))
    if (snap) { this.snaps.push({ at: Date.now(), snap }); if (this.snaps.length > 40) this.snaps.shift() }
    if (this.seg && Date.now() - this.seg.last > 20000) this.close() // nothing more of it for a while: done
    this.flush(false)
    // Who's around and where, for the aim analysis (reaction to things appearing, tracking).
    const me = bot.entity.position
    const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && (e.type === 'player' || e.kind === 'Hostile mobs') && e.position.distanceTo(me) < 24)
      .map((e) => [e.id, e.name || e.username, round2(e.position.x), round2(e.position.y + (e.height || 1.8) * 0.85), round2(e.position.z)])
    if (near.length) this.motion.write(JSON.stringify([Date.now(), 't', near]) + '\n')
  }

  end () {
    clearInterval(this.tick)
    this.close()
    this.flush(true)
    this.motion?.end()
    safe(() => this.obs?.end())
    if (this.username) this.log(`${this.username} left: ${this.examples} decisions recorded in ${this.demoFile}`)
  }
}

const round2 = (v) => Math.round(Number(v) * 100) / 100

function thoughtFor (s) {
  const n = s.count > 1 && s.name === 'placeBlock' ? ` (${s.count} of them)` : ''
  return `${s.thought}${n}`.slice(0, 120)
}

/** The short system prompt (observe.trainedPrompt, as the bot's own), with every action a player could do. */
function shortPrompt (name, level) {
  let toolNames = ''
  try { const a = require('../actions'); toolNames = a.describeToolList(Object.keys(a.ACTIONS), 'names') } catch {}
  return observe.trainedPrompt({ name, level, toolNames })
}

// ---------------------------------------------------------------------------------------------------------------

function main () {
  const opts = args(process.argv.slice(2))
  if (!LEVELS.includes(opts.level)) { console.log(`--level should be one of: ${LEVELS.join(', ')}`); process.exit(1) }
  const log = (m) => console.log(`[record] ${m}`)
  const server = net.createServer((client) => {
    const up = net.connect(opts.port, opts.host)
    let session = null
    let first = true
    client.on('data', (chunk) => {
      up.write(chunk)
      if (first) {
        first = false
        const len = readVarInt(chunk, 0)
        const hs = len && readHandshake(chunk.subarray(len.size, len.size + len.value))
        if (hs && hs.nextState !== 1) {
          session = new Session(opts, log)
          if (!session.start(hs.protocol)) session = null
          else session.fromClient(chunk.subarray(len.size + len.value))
        }
        return
      }
      session?.fromClient(chunk)
    })
    up.on('data', (chunk) => { client.write(chunk); session?.fromServer(chunk) })
    const done = () => { client.destroy(); up.destroy(); if (session) { session.end(); session = null } }
    client.on('close', done); up.on('close', done)
    client.on('error', () => {}); up.on('error', (err) => { log(`Can't reach the server at ${opts.host}:${opts.port}: ${err.message || err.code}`); done() })
  })
  server.listen(opts.listen, () => {
    log(`Join "localhost:${opts.listen}" in Minecraft (Multiplayer → Direct Connection). It passes you through to ${opts.host}:${opts.port}.`)
    log(`Recording as a ${opts.level} player${opts.goal ? `, goal: ${opts.goal}` : ''}. Ctrl+C to stop.`)
  })
}

if (require.main === module) main()

module.exports = { Session, Frames, readVarInt, readHandshake, versionFor, shortPrompt, main }
