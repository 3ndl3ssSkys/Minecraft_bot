'use strict'

/**
 * viewer.js — optional: watch and talk to the bot in a browser. Off unless `viewer.enabled`, `--viewer` or `!viewer on`.
 *
 * http://localhost:3007 shows its first-person view (prismarine-viewer) next to a panel: coordinates, health, food,
 * game mode, what it's doing, its goal and last thought, its inventory, the chat log, and a box to give it !commands,
 * talk to it, or make it say something in game. Listens on 127.0.0.1 only, unless a host AND a password are set.
 *
 * prismarine-viewer knows Minecraft up to 1.21.4. Newer worlds (26.x) are translated block by block to the nearest
 * version it knows (same block names; unknown blocks become stone or air), so the view stays readable.
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const { Vec3 } = require('vec3')
const { resolvePointing, describePointing } = require('./pointing')

const MAX_FEED = 300

/** Map every block state of one version to the same block in another (by name; exact state when the properties match). */
function stateMap (srcData, dstData) {
  const max = Math.max(...srcData.blocksArray.map((b) => b.maxStateId ?? b.minStateId ?? 0))
  const map = new Int32Array(max + 1)
  const stone = dstData.blocksByName.stone.defaultState
  for (const b of srcData.blocksArray) {
    if (b.minStateId === undefined) continue
    const t = dstData.blocksByName[b.name]
    const same = t && JSON.stringify(b.states || []) === JSON.stringify(t.states || [])
    const fallback = t ? t.defaultState : (b.boundingBox === 'block' ? stone : 0)
    for (let s = b.minStateId; s <= b.maxStateId; s++) map[s] = same ? t.minStateId + (s - b.minStateId) : fallback
  }
  return map
}

/** Copy a chunk column into another version's format, translating block states (empty sections skipped). */
function convertColumn (column, DstChunk, map) {
  const minY = column.minY ?? 0
  const height = column.worldHeight ?? 256
  const dst = new DstChunk({ minY, worldHeight: height })
  const json = JSON.parse(column.toJson())
  const sections = json.sections || []
  const pos = new Vec3(0, 0, 0)
  for (let i = 0; i < sections.length; i++) {
    let empty = false
    try {
      const sec = typeof sections[i] === 'string' ? JSON.parse(sections[i]) : sections[i]
      const data = typeof sec?.data === 'string' ? JSON.parse(sec.data) : sec?.data
      empty = !sec || (data?.type === 'single' && data.value === 0) || sec.solidBlockCount === 0
    } catch { /* unknown layout: copy it */ }
    if (empty) continue
    const y0 = minY + i * 16
    for (let y = y0; y < y0 + 16; y++) {
      pos.y = y
      for (let x = 0; x < 16; x++) {
        pos.x = x
        for (let z = 0; z < 16; z++) {
          pos.z = z
          const id = column.getBlockStateId(pos)
          if (id) dst.setBlockStateId(pos, map[id] ?? 0)
        }
      }
    }
  }
  return dst
}

const CUBE_FACES = { up: ['up', 'top', 'end', 'all'], left: ['north', 'front', 'side', 'all'], right: ['east', 'side', 'all'] }
const TINTS = [[/grass_block_top|^short_grass|^tall_grass|^fern|large_fern/, '#91bd59'], [/birch_leaves/, '#80a755'], [/spruce_leaves/, '#619961'], [/_leaves|^vine/, '#77ab2f'], [/lily_pad/, '#208030']]

/**
 * Inventory icons from the textures prismarine-viewer ships (Minecraft's own item and block textures).
 * iconFor(name) → { flat: 'items/x.png' } for items, { cube: { up, left, right }, tint, half } for blocks (the page draws
 * the little 3D block like the game does), or null (the page writes the name instead: items newer than the textures).
 */
function iconResolver (dir) {
  const list = (sub) => { try { return new Set(fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))) } catch { return new Set() } }
  const items = list('items')
  const blocks = list('blocks')
  let models = {}
  try { models = JSON.parse(fs.readFileSync(path.join(dir, 'blocks_models.json'), 'utf8')) } catch { /* no models: items only */ }
  const cache = new Map()
  const strip = (r) => String(r || '').replace(/^minecraft:/, '').replace(/^blocks?\//, '')
  const tintOf = (t) => (TINTS.find(([re]) => re.test(t)) || [])[1]

  /** Textures and lineage of a block model, children overriding parents ('#side' references resolved). */
  function model (name) {
    const textures = {}
    const chain = []
    let elements = null
    let m = models[name]
    let guard = 0
    while (m && guard++ < 12) {
      for (const [k, v] of Object.entries(m.textures || {})) if (!(k in textures)) textures[k] = v
      if (!elements && m.elements) elements = m.elements
      const parent = strip(m.parent)
      if (!parent) break
      chain.push(parent)
      m = models[parent]
    }
    const resolve = (v, depth = 0) => (typeof v === 'string' && v.startsWith('#') && depth < 8) ? resolve(textures[v.slice(1)], depth + 1) : v
    // A model with its own full-size box (grass_block, ...) counts as a cube: its faces name the textures.
    const box = elements?.[0]
    const faces = box && String(box.from) === '0,0,0' && String(box.to) === '16,16,16' ? box.faces : null
    if (faces && !chain.includes('cube')) {
      chain.push('cube')
      for (const [face, key] of [['up', 'up'], ['north', 'north'], ['east', 'east']]) if (faces[face]?.texture && !(key in textures)) textures[key] = faces[face].texture
    }
    return { chain, tex: (keys) => { for (const k of keys) { const v = strip(resolve(textures[k])); if (v && blocks.has(v)) return v } return null }, any: () => Object.values(textures).map((v) => strip(resolve(v))).find((v) => v && blocks.has(v)) }
  }

  function compute (name) {
    for (const n of [name, `${name}_00`, `${name}_standby`]) if (items.has(n)) return { flat: `items/${n}.png` }
    const m = model(name)
    const cube = m.chain.includes('cube') || m.chain.includes('leaves')
    const half = /_slab$/.test(name)
    if (cube || half || /_stairs$/.test(name)) {
      const up = m.tex(half || /_stairs$/.test(name) ? ['top', 'side'] : CUBE_FACES.up)
      const left = m.tex(half || /_stairs$/.test(name) ? ['side', 'top'] : CUBE_FACES.left) || up
      const right = m.tex(half || /_stairs$/.test(name) ? ['side', 'top'] : CUBE_FACES.right) || left
      if (up || left) {
        const t = up || left
        return { cube: { up: `blocks/${up || left}.png`, left: `blocks/${left || t}.png`, right: `blocks/${right || t}.png` }, tint: tintOf(up || ''), tintSides: /_leaves$/.test(name) ? tintOf(name) : undefined, half: half || undefined }
      }
    }
    const flat = m.any() || (blocks.has(name) ? name : null)
    if (flat) return { flat: `blocks/${flat}.png`, tint: tintOf(flat) }
    return null
  }

  return {
    iconFor (name) {
      if (!cache.has(name)) cache.set(name, compute(String(name)))
      return cache.get(name)
    }
  }
}

class BotViewer {
  constructor (agent) {
    this.agent = agent
    this.feed = [] // { at, kind, text }
    this.clients = new Set() // SSE responses
    this.server = null
  }

  get cfg () { return this.agent.config.viewer }

  /** Start the web server (once). Returns the URL, or null if prismarine-viewer isn't installed. */
  start () {
    if (this.server) return this.url
    const agent = this.agent
    let pv
    try {
      pv = {
        WorldView: require('prismarine-viewer/viewer/lib/worldView').WorldView, // not the package index: that loads the offscreen renderer (native canvas)
        setupRoutes: require('prismarine-viewer/lib/common').setupRoutes,
        getVersion: require('prismarine-viewer/viewer/lib/version').getVersion,
        express: require(require.resolve('express', { paths: [path.dirname(require.resolve('prismarine-viewer/package.json'))] })),
        socketIo: require(require.resolve('socket.io', { paths: [path.dirname(require.resolve('prismarine-viewer/package.json'))] }))
      }
    } catch (err) {
      agent.log.warn(`The viewer needs prismarine-viewer: run "npm install" in the bot folder (it's an optional extra). (${err.message.split('\n')[0]})`)
      return null
    }
    const { host, port, password } = this.cfg
    if (host !== '127.0.0.1' && host !== 'localhost' && !password) {
      agent.log.warn('viewer.host opens the viewer to other computers: set viewer.password too. Using 127.0.0.1 for now.')
    }
    const bindHost = host !== '127.0.0.1' && host !== 'localhost' && !password ? '127.0.0.1' : host
    const app = pv.express()
    const server = http.createServer(app)
    const io = pv.socketIo(server, { path: '/view/socket.io' })
    const allowed = (req) => !password || req.query?.key === password || req.headers['x-key'] === password

    app.use((req, res, next) => (allowed(req) || req.path.startsWith('/view/')) ? next() : res.status(401).send('Wrong or missing key (add ?key=your-password to the address).'))
    app.use(pv.express.json())
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'web', 'panel.html')))
    // The 3D view: prismarine-viewer's page, with our script loaded first (field of view, smooth turning, the camera for pointing).
    const viewIndex = (req, res) => res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>view</title><style>html{overflow:hidden}html,body{height:100%;margin:0;padding:0;background:#000}canvas{height:100%;width:100%;display:block}</style></head><body><script src="addon.js"></script><script src="index.js"></script></body></html>')
    app.get('/view/', viewIndex)
    app.get('/view/index.html', viewIndex)
    app.get('/view/addon.js', (req, res) => res.sendFile(path.join(__dirname, 'web', 'view-addon.js')))
    app.get('/icons', (req, res) => {
      const icons = this.icons()
      const out = {}
      for (const n of String(req.query.names || '').split(',').filter(Boolean).slice(0, 200)) out[n] = icons ? icons.iconFor(n) : null
      res.json({ base: `/view/textures/${this.textureVersion()}/`, icons: out })
    })
    app.post('/control', (req, res) => {
      try { res.json(this.handleControl(req.body || {})) } catch (err) { res.json({ ok: false, error: err.message }) }
    })
    app.post('/point', (req, res) => {
      try { res.json(this.handlePoint(req.body || {})) } catch (err) { res.json({ ok: false, error: err.message }) }
    })
    app.get('/state', (req, res) => res.json(this.status()))
    app.get('/events', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' })
      res.write(`event: feed\ndata: ${JSON.stringify(this.feed.slice(-120))}\n\n`)
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
    })
    app.post('/send', (req, res) => {
      const { mode, text } = req.body || {}
      const r = this.handleInput(String(mode || ''), String(text || '').slice(0, 256))
      res.json(r)
    })

    pv.setupRoutes(app, '/view') // after our routes: its compression would buffer the live event stream
    io.use((socket, next) => (!password || socket.handshake.query?.key === password || socket.handshake.headers.referer?.includes(`key=${password}`)) ? next() : next(new Error('unauthorized')))
    io.on('connection', (socket) => this.onViewer(socket, pv))

    server.listen(port, bindHost, () => agent.log.info(`Viewer: http://${bindHost === '0.0.0.0' ? 'localhost' : bindHost}:${port}${password ? '/?key=…' : ''} (the bot's view, inventory, coordinates and chat)`))
    server.on('error', (err) => agent.log.warn(`Viewer could not start on port ${port}: ${err.message}`))
    this.server = server
    this.io = io
    this.url = `http://${bindHost}:${port}`
    this.tapLog()
    this.timer = setInterval(() => this.broadcast('state', this.status()), 1000)
    this.timer.unref?.()
    return this.url
  }

  stop () {
    clearInterval(this.timer)
    for (const res of this.clients) res.end()
    this.clients.clear()
    this.io?.close()
    this.server?.close()
    this.server = null
  }

  /** Which prismarine-viewer texture set to use (the nearest version it has). */
  textureVersion () {
    try {
      const { getVersion } = require('prismarine-viewer/viewer/lib/version')
      return getVersion(this.agent.bot?.version) || '1.21.4'
    } catch { return '1.21.4' }
  }

  icons () {
    const v = this.textureVersion()
    if (this._icons?.v === v) return this._icons.r
    let dir
    try { dir = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public', 'textures', v) } catch { return null }
    this._icons = { v, r: iconResolver(dir) }
    return this._icons.r
  }

  get owner () { return this.agent.config.behavior.owners[0] || 'Owner' }

  /**
   * The panel's controls: feelings, goals and tasks. The watcher acts as the first owner, so this is the same
   * power as owner !commands, just with buttons.
   */
  handleControl (b) {
    const agent = this.agent
    const who = this.owner
    const { goals, emotions, tasks, brain } = agent
    const text = String(b.text || '').trim().slice(0, 160)
    if (b.type === 'emotion') {
      if (b.unlock) { agent.applySetting('emotions.lock', null); this.push('you', '(feelings unlocked)'); return { ok: true } }
      const label = String(b.label || '').toLowerCase()
      const intensity = Math.max(1, Math.min(10, Math.round(Number(b.intensity) || 7)))
      if (b.lock) {
        agent.applySetting('emotions.lock', label)
        agent.applySetting('emotions.lockIntensity', intensity)
      } else if (!emotions.setTo(label, intensity)) return { ok: false, error: `unknown feeling "${label}"` }
      else agent.applySetting('emotions.lock', null)
      agent.memory.addEvent('feeling', `You suddenly feel ${label}.`)
      this.push('you', `(feeling set to ${label} ${intensity}/10${b.lock ? ', locked' : ''})`)
      return { ok: true }
    }
    if (b.type === 'goal') {
      const findLong = () => goals.longTerm.find((g) => g.id === Number(b.id) && g.status === 'active')
      switch (b.op) {
        case 'life': goals.setOverarching(text, who); break
        case 'addLong': if (!goals.addLongTerm(text, who)) return { ok: false, error: 'empty goal' }; break
        case 'dropLong': case 'doneLong': {
          const g = findLong()
          if (!g) return { ok: false, error: 'no such goal' }
          goals.closeLongTerm(g, b.op === 'doneLong' ? 'done' : 'dropped')
          break
        }
        case 'editLong': { const g = findLong(); if (!g || !text) return { ok: false, error: 'no such goal' }; g.text = text; g.source = who; goals.dirty(); break }
        case 'current': if (!text) return { ok: false, error: 'empty goal' }; goals.setCurrent(text, who); brain?.onNewGoal(); break
        case 'doneCurrent': case 'dropCurrent': case 'clearCurrent':
          if (!goals.current) return { ok: false, error: 'no current goal' }
          if (b.op === 'clearCurrent') goals.setCurrent('', who)
          else goals.finishCurrent(b.op === 'doneCurrent' ? 'done' : 'gave_up')
          brain?.onNewGoal()
          break
        case 'steps': if (!goals.current) return { ok: false, error: 'set a goal first' }; goals.setSteps((b.steps || []).map(String).slice(0, 8)); break
        case 'queue': if (!goals.enqueue(text, { priority: b.priority ?? 5, source: who })) return { ok: false, error: 'empty, or already on the list' }; break
        case 'unqueue': goals.backlog = goals.backlog.filter((g) => g.text !== text); goals.dirty(); break
        case 'replan': goals.want(`${who} asked you to rethink your plans`); goals.lastPlanAt = 0; goals.maybePlan(); break
        default: return { ok: false, error: `unknown goal change "${b.op}"` }
      }
      this.push('you', `(goals: ${b.op}${text ? ` "${text}"` : ''})`)
      return { ok: true }
    }
    if (b.type === 'task') {
      if (b.op === 'cancel') {
        const t = tasks.cancel(b.id, who)
        if (!t) return { ok: false, error: 'no such task' }
        this.push('you', `(called off: ${t.description})`)
        return { ok: true }
      }
      if (b.op === 'add') {
        if (!text) return { ok: false, error: 'empty' }
        // Asked like a person would ask: it decides (owners usually get a yes), and says so in chat.
        return this.handleInput('talk', text)
      }
    }
    return { ok: false, error: 'unknown control' }
  }

  /**
   * A click or a circle on the view: work out what is there (pointing.js), outline it in the view, and tell the bot.
   * body: { cam: { pos, yaw, pitch, fov, aspect }, point: {x, y} | outline: [{x, y}...], note }
   */
  handlePoint (b) {
    const agent = this.agent
    const bot = agent.bot
    if (!bot?.entity) return { ok: false, error: 'the bot is not in a world right now' }
    const c = b.cam || {}
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const cam = {
      pos: c.pos && [c.pos.x, c.pos.y, c.pos.z].every(Number.isFinite) && new Vec3(c.pos.x, c.pos.y, c.pos.z).distanceTo(eye) < 8 ? c.pos : eye,
      yaw: Number.isFinite(c.yaw) ? c.yaw : bot.entity.yaw,
      pitch: Number.isFinite(c.pitch) ? c.pitch : bot.entity.pitch,
      fov: Math.max(20, Math.min(130, Number(c.fov) || this.cfg.fov || 70)),
      aspect: Math.max(0.2, Math.min(5, Number(c.aspect) || 16 / 9))
    }
    const outline = Array.isArray(b.outline) ? b.outline.slice(0, 400).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : null
    const shape = outline && outline.length >= 3 ? { outline } : { point: { x: Number(b.point?.x) || 0, y: Number(b.point?.y) || 0 } }
    const r = resolvePointing(bot, cam, shape)
    if (!r.blocks.length && !r.entities.length) return { ok: false, error: 'nothing there (out of range or sky)' }
    const desc = describePointing(r, bot.entity.position, { coords: safe(() => agent.coordsKnown()) !== false })
    this.highlight(r)
    const note = String(b.note || '').trim().slice(0, 200)
    agent.onPointedAt(this.owner, desc, note)
    this.push('you', `(pointed at ${desc}${note ? `: "${note}"` : ''})`)
    return { ok: true, desc, result: { kind: r.kind, blocks: r.blocks.map((x) => ({ name: x.name, count: x.count })), entities: r.entities.map((e) => e.label) } }
  }

  /** Outline what was pointed at in every open view for 20 s. */
  highlight (r) {
    if (!this.io) return
    for (const id of this.marks || []) this.io.emit('primitive', { id })
    this.marks = []
    const add = (start, end, color) => {
      const id = `point-${this.marks.length}`
      this.marks.push(id)
      this.io.emit('primitive', { id, type: 'boxgrid', start, end, color })
    }
    for (const b of r.blocks.slice(0, 6)) add({ x: b.pos.x, y: b.pos.y, z: b.pos.z }, { x: b.pos.x + 1, y: b.pos.y + 1, z: b.pos.z + 1 }, 'yellow')
    for (const e of r.entities.slice(0, 6)) {
      const ent = this.agent.bot.entities[e.id]
      const w = (ent?.width || 0.6) / 2
      const h = ent?.height || 1.8
      add({ x: e.pos.x - w, y: e.pos.y, z: e.pos.z - w }, { x: e.pos.x + w, y: e.pos.y + h, z: e.pos.z + w }, 'red')
    }
    clearTimeout(this.markTimer)
    const ids = this.marks
    this.markTimer = setTimeout(() => { for (const id of ids) this.io?.emit('primitive', { id }) }, 20000)
    this.markTimer.unref?.()
  }

  /** Copy what the bot logs (chat, thoughts, actions) into the panel's feed. */
  tapLog () {
    const log = this.agent.log
    if (log._viewerTapped) return
    log._viewerTapped = true
    for (const kind of ['info', 'warn', 'mind', 'chat']) {
      const original = log[kind]?.bind(log)
      if (!original) continue
      log[kind] = (msg, ...rest) => {
        original(msg, ...rest)
        if (kind === 'mind') this.lastMind = String(msg).replace(/\x1b\[[0-9;]*m/g, '')
        this.push(kind, String(msg))
      }
    }
  }

  push (kind, text) {
    const item = { at: Date.now(), kind, text }
    this.feed.push(item)
    if (this.feed.length > MAX_FEED) this.feed.splice(0, this.feed.length - MAX_FEED)
    this.broadcast('line', item)
  }

  broadcast (event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of this.clients) res.write(msg)
  }

  /** The panel's input box: !commands (as an owner), talking to it (as the first owner), or saying something in game. */
  handleInput (mode, text) {
    const agent = this.agent
    if (!text.trim()) return { ok: false, error: 'empty' }
    if (!agent.bot?.entity) return { ok: false, error: 'the bot is not in a world right now' }
    const prefix = agent.config.behavior.commandPrefix
    if (mode === 'command' || text.startsWith(prefix)) {
      this.push('you', `${prefix}${text.replace(new RegExp(`^\\${prefix}`), '')}`)
      agent.responder.handleCommand('@console', text.replace(new RegExp(`^\\${prefix}`), ''), false).catch((err) => this.push('warn', err.message))
      return { ok: true }
    }
    if (mode === 'say') {
      this.push('you', `(say) ${text}`)
      agent.bot.chat(text)
      return { ok: true }
    }
    const me = agent.config.behavior.owners[0] || 'Owner'
    this.push('you', `${me}: ${text}`)
    agent.responder.onMessage(me, text, { whisper: true })
    return { ok: true }
  }

  /** What the panel shows (a person watching always sees the coordinates, whatever the bot knows). */
  status () {
    const agent = this.agent
    const bot = agent.bot
    if (!bot?.entity) return { online: false }
    const p = bot.entity.position
    const slot = (i) => {
      const it = bot.inventory.slots[i]
      if (!it) return null
      const max = it.maxDurability
      return { name: it.name, count: it.count, dur: max ? Math.max(0, (max - (it.durabilityUsed || 0)) / max) : undefined }
    }
    return {
      online: true,
      botId: bot.entity.id,
      name: bot.username,
      position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      facing: ['south', 'west', 'north', 'east'][Math.round(((-bot.entity.yaw * 180 / Math.PI) % 360 + 360) % 360 / 90) % 4],
      dimension: String(bot.game?.dimension || '').replace('minecraft:', ''),
      gameMode: bot.game?.gameMode,
      hardcore: Boolean(bot.game?.hardcore),
      health: Math.round(bot.health ?? 0),
      food: bot.food ?? 0,
      xp: bot.experience?.level ?? 0,
      xpProgress: bot.experience?.progress ?? 0,
      time: bot.time?.timeOfDay,
      day: bot.time?.day,
      action: agent.executor?.current?.name || null,
      goal: agent.memory?.goal || null,
      feeling: safe(() => agent.emotions.dominant().label),
      knowsCoords: safe(() => agent.coordsKnown()),
      layout: agent.perception?.latest?.layout || '',
      hotbar: Array.from({ length: 9 }, (_, i) => slot(36 + i)),
      selected: bot.quickBarSlot,
      main: Array.from({ length: 27 }, (_, i) => slot(9 + i)),
      armor: [5, 6, 7, 8].map(slot),
      offhand: slot(45),
      craft: [1, 2, 3, 4].map(slot),
      craftResult: slot(0),
      players: Object.keys(bot.players).filter((n) => n !== bot.username),
      fov: this.cfg.fov || 70,
      mind: safe(() => this.mind()),
      plans: safe(() => this.plans())
    }
  }

  /** Feelings for the panel: the label, every core feeling, and the labels it can be set to. */
  mind () {
    const { emotions, config } = this.agent
    const d = emotions.dominant()
    return {
      label: d.label,
      intensity: d.intensity,
      locked: Boolean(config.emotions.lock),
      describe: emotions.describe(),
      core: Object.fromEntries(Object.entries(emotions.values).map(([k, v]) => [k, Math.round(v * 100)])),
      labels: Object.keys(require('./emotions').LABEL_TO_CORE),
      thought: this.agent.memory?.actions?.at(-1)?.thought || this.lastMind || ''
    }
  }

  /** Goals and tasks for the panel. */
  plans () {
    const { goals: g, tasks: t } = this.agent
    const c = g.current
    return {
      life: g.life ? { text: g.life.text, source: g.life.source } : null,
      longTerm: g.longTerm.filter((x) => x.status === 'active').map((x) => ({ id: x.id, text: x.text, source: x.source })),
      current: c ? { text: c.text, source: c.source, detour: c.detour || null, steps: c.steps.map((s, i) => ({ text: s.text, done: s.done, now: i === c.now })) } : null,
      backlog: [...g.backlog].sort((a, b) => g.score(b) - g.score(a)).map((x) => ({ text: x.text, priority: x.priority, source: x.source })),
      tasks: t.tasks.map((x) => ({ id: x.id, description: x.description, from: x.from, status: x.status, progress: ['gather', 'craft'].includes(x.kind) ? `${t.progress(x)}/${x.commitCount}` : null }))
    }
  }

  /** One browser tab watching: the world (translated when the version is newer than the viewer knows) and the bot's eyes. */
  onViewer (socket, pv) {
    const bot = this.agent.bot
    if (!bot?.entity) { socket.disconnect(); return }
    const known = pv.getVersion(bot.version)
    const viewVersion = known || '1.21.4'
    socket.emit('version', viewVersion)
    let world = bot.world
    let mapId = (id) => id
    if (!known) {
      const map = stateMap(bot.registry, require('minecraft-data')(viewVersion))
      const DstChunk = require('prismarine-chunk')(viewVersion)
      mapId = (id) => map[id] ?? 0
      world = {
        getColumnAt: async (pos) => { const c = await bot.world.getColumnAt(pos); return c ? convertColumn(c, DstChunk, map) : null },
        raycast: (...a) => bot.world.raycast(...a)
      }
    }
    const view = new pv.WorldView(world, this.cfg.viewDistance, bot.entity.position, socket)
    view.init(bot.entity.position)
    const emitEntity = (e) => { if (e !== bot.entity) socket.emit('entity', { id: e.id, name: e.name, pos: e.position, width: e.width, height: e.height, username: e.username }) }
    const listeners = {
      entitySpawn: emitEntity,
      entityMoved: (e) => socket.emit('entity', { id: e.id, pos: e.position, pitch: e.pitch, yaw: e.yaw }),
      entityGone: (e) => socket.emit('entity', { id: e.id, delete: true }),
      chunkColumnLoad: (pos) => view.loadChunk(pos),
      blockUpdate: (oldBlock, newBlock) => socket.emit('blockUpdate', { pos: oldBlock.position, stateId: mapId(newBlock.stateId ?? 0) }),
      move: () => {
        socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, pitch: this.cfg.firstPerson ? bot.entity.pitch : undefined, addMesh: true })
        view.updatePosition(bot.entity.position)
      }
    }
    for (const [ev, fn] of Object.entries(listeners)) bot.on(ev, fn)
    for (const e of Object.values(bot.entities)) emitEntity(e)
    listeners.move()
    socket.on('disconnect', () => { for (const [ev, fn] of Object.entries(listeners)) bot.removeListener(ev, fn) })
  }
}

function safe (fn) { try { return fn() } catch { return undefined } }

module.exports = { BotViewer, stateMap, convertColumn, iconResolver }
