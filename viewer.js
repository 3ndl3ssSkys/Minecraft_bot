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

const path = require('path')
const http = require('http')
const { Vec3 } = require('vec3')

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
    const slot = (i) => { const it = bot.inventory.slots[i]; return it ? { name: it.name, count: it.count } : null }
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
      time: bot.time?.timeOfDay,
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
      players: Object.keys(bot.players).filter((n) => n !== bot.username)
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

module.exports = { BotViewer, stateMap, convertColumn }
