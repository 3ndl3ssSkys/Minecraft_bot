'use strict'

/**
 * index.js — the "brain" and nervous system of the bot.
 *
 *   ┌────────────┐  state JSON   ┌──────────────┐  {thought, emotion, action}  ┌───────────────┐
 *   │ Perception │ ────────────▶ │  Ollama LLM  │ ───────────────────────────▶ │ActionExecutor │
 *   └────────────┘               └──────────────┘                              └───────────────┘
 *         ▲                        ▲          ▲                                       │
 *         │                        │          │ replies / reactions / small talk      │ result
 *     Mineflayer ◀── ChatManager ◀─┘   ChatResponder · EventReactor · SmallTalk       ▼
 *                                                                                  Memory
 *
 * The Brain loop is strictly sequential: perceive → ask the LLM → run ONE action
 * → wait for it to finish or fail → record the result → repeat. A minimum
 * interval between LLM calls keeps Ollama from being spammed, and all LLM
 * requests (decisions, chat replies, reactions) share one priority queue so
 * only one request is ever in flight.
 *
 * Usage:  node index.js [path/to/config.json]
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { ActionExecutor, performGesture, inventorySummary, durabilityLeft } = require('./actions')

// ===========================================================================
// Logging
// ===========================================================================

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m', mind: '\x1b[35m', chat: '\x1b[32m' }
const RESET = '\x1b[0m'

function createLogger (level = 'info') {
  const threshold = LEVELS[process.env.BOT_DEBUG ? 'debug' : level] ?? LEVELS.info
  const write = (tag, color, msg) => {
    const ts = new Date().toISOString().slice(11, 19)
    const out = `${COLORS[color] || ''}[${ts}] ${tag.padEnd(5)}${RESET} ${msg}`
    if (tag === 'ERROR' || tag === 'WARN') console.error(out)
    else console.log(out)
  }
  return {
    debug: (m) => threshold <= LEVELS.debug && write('DEBUG', 'debug', m),
    info: (m) => threshold <= LEVELS.info && write('INFO', 'info', m),
    warn: (m) => threshold <= LEVELS.warn && write('WARN', 'warn', m),
    error: (m) => write('ERROR', 'error', m),
    mind: (m) => threshold <= LEVELS.info && write('MIND', 'mind', m),
    chat: (m) => threshold <= LEVELS.info && write('CHAT', 'chat', m)
  }
}

// ===========================================================================
// Configuration
// ===========================================================================

/** Every option has a default here; config.json only needs what you change. */
const DEFAULT_CONFIG = {
  server: {
    host: 'localhost',
    port: 25565,
    username: 'Wanderer',
    auth: 'offline', // 'offline' or 'microsoft'
    version: false, // false = auto-detect, or e.g. "1.21.4"
    reconnect: true,
    reconnectDelayMs: 10000,
    maxReconnectDelayMs: 120000
  },
  llm: {
    url: 'http://localhost:11434/api/chat',
    model: 'qwen2.5:7b',
    temperature: 0.7,
    numCtx: 8192,
    keepAlive: '15m',
    timeoutMs: 90000,
    maxRetries: 2,
    useJsonSchema: true // Ollama >= 0.5 structured outputs; false = plain JSON mode
  },
  personality: 'friendly', // preset name from ./personalities, or an inline object
  chat: {
    mode: 'both', // 'silent' | 'respond' | 'unprompted' | 'both'
    respondTo: 'mentions', // 'mentions' | 'everyone' | 'whitelist'
    whitelist: [],
    ignore: [],
    unaddressedReplyChance: 0.15, // respondTo=everyone: chance to chime in on chatter not aimed at us
    conversationWindowSec: 45, // after we talk to someone, their follow-ups count as addressed
    replyDelayMs: [1000, 2500], // human "reading" delay; also batches rapid messages
    typingCharsPerSecond: 14, // simulated typing time; 0 = instant
    maxMessageLength: 200,
    minSecondsBetweenMessages: 3,
    maxMessagesPerMinute: 8,
    reactionsInRespondMode: false, // allow event reactions while in 'respond' mode
    lookAtSpeaker: true,
    goalChangeInterrupts: true, // a player's accepted request interrupts the current action
    whisperReplies: true, // answer whispers with whispers
    unprompted: {
      intervalSeconds: 90,
      chance: 0.35,
      minSilenceSeconds: 60,
      requirePlayersOnline: true,
      requirePlayersNearby: false
    }
  },
  reactions: {
    enabled: true,
    gestures: true,
    globalCooldownSec: 6,
    events: {
      spawn: { enabled: true, chance: 1, cooldownSec: 0, style: 'llm', gesture: 'wave', templates: ['hey everyone!', 'hi all'] },
      playerJoined: { enabled: true, chance: 0.7, cooldownSec: 15, perTarget: true, style: 'template', templates: ['hey {player}!', 'welcome back {player}', 'o/ {player}'] },
      playerLeft: { enabled: true, chance: 0.4, cooldownSec: 30, style: 'template', templates: ['cya {player}', 'bye {player}!'] },
      playerNearby: { enabled: true, chance: 0.6, cooldownSec: 180, perTarget: true, style: 'gesture', gesture: 'wave', templates: ['oh hey {player}'] },
      death: { enabled: true, chance: 1, cooldownSec: 10, style: 'llm', templates: ['noooo', 'ugh. died.'] },
      hurt: { enabled: true, chance: 0.25, cooldownSec: 15, style: 'template', templates: ['ow!', 'hey!', 'ouch'] },
      lowHealth: { enabled: true, chance: 1, cooldownSec: 60, threshold: 8, style: 'llm', templates: ['need to heal up...'] },
      hungry: { enabled: true, chance: 0.6, cooldownSec: 120, threshold: 6, style: 'template', templates: ["i'm starving", 'need food...'] },
      playerDied: { enabled: true, chance: 0.8, cooldownSec: 20, style: 'llm', templates: ['rip {player}', 'F'] },
      killedMob: { enabled: true, chance: 0.3, cooldownSec: 30, style: 'template', templates: ['got it!', 'take that {mob}'] },
      hostileNearby: { enabled: true, chance: 0.4, cooldownSec: 90, style: 'template', templates: ['uh oh, {mob}', 'is that a {mob}?'] },
      toolBroke: { enabled: true, chance: 0.7, cooldownSec: 30, style: 'template', templates: ['aw my {item} broke'] },
      nightfall: { enabled: true, chance: 0.6, cooldownSec: 600, style: 'llm', templates: ["it's getting dark..."] },
      daybreak: { enabled: true, chance: 0.4, cooldownSec: 600, style: 'template', templates: ['morning!'] },
      rainStart: { enabled: true, chance: 0.3, cooldownSec: 600, style: 'template', templates: ['ugh, rain'] },
      levelUp: { enabled: true, chance: 0.5, cooldownSec: 60, style: 'template', templates: ['level {level}!'] },
      itemPickup: { enabled: false, chance: 0.1, cooldownSec: 120, style: 'template', templates: ['ooh, {item}'] }
    }
  },
  behavior: {
    owners: [], // usernames allowed to use !commands in-game (the console always can)
    commandPrefix: '!',
    obeyPlayers: 'everyone', // who may give the bot tasks via chat: 'everyone' | 'owners' | 'nobody'
    startingGoal: '',
    allowPvp: false,
    protectedPlayers: [],
    selfDefense: true,
    autoEat: true,
    autoEatBelow: 14,
    fleeHealthBelow: 6,
    interruptOnDamage: true,
    autoEquipWeapon: true,
    autoCollectDrops: true,
    attackCooldownMs: 650,
    minToolDurability: 3,
    maxTravelDistance: 128,
    enabledActions: [], // non-empty = whitelist of actions the LLM may use
    disabledActions: [],
    pathfinding: {
      canDig: true,
      allowParkour: true,
      allowSprinting: true,
      allow1by1towers: true,
      thinkTimeoutMs: 10000,
      baseTimeoutMs: 15000,
      msPerBlock: 1200,
      maxTimeoutMs: 180000
    }
  },
  perception: {
    intervalMs: 2000,
    entityRadius: 24,
    maxEntities: 12,
    blockSearchRadius: 24,
    blockScanRadius: 4,
    interestingBlocks: [
      'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
      'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore',
      'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
      'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
      'crafting_table', 'furnace', 'chest', 'white_bed', 'red_bed', 'wheat', 'sugar_cane', 'pumpkin', 'melon', 'sweet_berry_bush'
    ]
  },
  loop: {
    minLlmIntervalMs: 2500, // never call the LLM for decisions more often than this
    postActionDelayMs: 600,
    maxActionMs: 180000, // hard safety timeout for any single action
    errorBackoffMs: 3000,
    maxErrorBackoffMs: 60000,
    historySize: 8
  },
  logging: { level: 'info', logThoughts: true }
}

const DEFAULT_PERSONALITY = {
  name: null, // display name used in prompts; defaults to the account username
  nicknames: [], // extra words that count as "talking to me"
  description: 'A friendly, laid-back survival player who enjoys exploring and helping others.',
  traits: ['friendly', 'curious', 'helpful'],
  speakingStyle: 'casual, short messages like a real gamer; occasional lowercase and slang',
  quirks: [],
  likes: ['exploring caves', 'building cozy houses'],
  dislikes: ['creepers', 'griefers'],
  ambitions: ['get a full set of iron tools', 'build a small base'],
  chatTopics: ['what you are doing right now', 'the surroundings', 'recent events'],
  catchphrases: [],
  language: 'English',
  lowercase: false,
  baselineMood: 'calm',
  admitsBeingBot: true, // if sincerely asked, be honest about being an AI
  reactions: {} // per-event overrides, e.g. { "death": { "templates": ["..."] } }
}

const CHAT_MODES = ['silent', 'respond', 'unprompted', 'both']

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Recursive merge where `override` wins; arrays are replaced, not concatenated. */
function deepMerge (base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override
  const out = { ...(isPlainObject(base) ? base : {}) }
  for (const [k, v] of Object.entries(override)) out[k] = isPlainObject(v) ? deepMerge(out[k], v) : v
  return out
}

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`)
  }
}

function loadPersonality (spec, log) {
  if (isPlainObject(spec)) return deepMerge(DEFAULT_PERSONALITY, spec)
  const name = String(spec || 'friendly').replace(/[^\w-]/g, '')
  const file = path.join(__dirname, 'personalities', `${name}.json`)
  if (!fs.existsSync(file)) {
    log?.warn(`Personality preset "${name}" not found at ${file}; using the default personality.`)
    return { ...DEFAULT_PERSONALITY }
  }
  return deepMerge(DEFAULT_PERSONALITY, readJson(file))
}

function listPersonalities () {
  try {
    return fs.readdirSync(path.join(__dirname, 'personalities')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

/** Load config: defaults ← config file ← environment variables. */
function loadConfig (log) {
  const file = process.argv[2] || process.env.BOT_CONFIG || path.join(__dirname, 'config.json')
  let user = {}
  if (fs.existsSync(file)) {
    user = readJson(file)
    log.info(`Loaded config from ${file}`)
  } else {
    log.warn(`No config file at ${file}; using defaults.`)
  }
  const config = deepMerge(DEFAULT_CONFIG, user)

  const env = process.env
  if (env.MC_HOST) config.server.host = env.MC_HOST
  if (env.MC_PORT) config.server.port = Number(env.MC_PORT)
  if (env.MC_USERNAME) config.server.username = env.MC_USERNAME
  if (env.MC_AUTH) config.server.auth = env.MC_AUTH
  if (env.MC_VERSION) config.server.version = env.MC_VERSION
  if (env.OLLAMA_URL) config.llm.url = env.OLLAMA_URL
  if (env.OLLAMA_MODEL) config.llm.model = env.OLLAMA_MODEL
  if (env.BOT_PERSONALITY) config.personality = env.BOT_PERSONALITY
  if (env.BOT_CHAT_MODE) config.chat.mode = env.BOT_CHAT_MODE

  if (!CHAT_MODES.includes(config.chat.mode)) {
    log.warn(`Unknown chat.mode "${config.chat.mode}", falling back to "respond".`)
    config.chat.mode = 'respond'
  }
  config.chat.maxMessageLength = Math.min(256, config.chat.maxMessageLength) // server hard limit
  return config
}

// ===========================================================================
// Memory — short-term recollection that is fed back into every prompt
// ===========================================================================

class Memory {
  constructor (config) {
    this.config = config
    this.events = [] // { at, type, text }
    this.chat = [] // { at, from, text, self, whisper }
    this.actions = [] // { at, source, action, args, ok, code, message, thought }
    this.goal = config.behavior.startingGoal || ''
    this.goalSource = this.goal ? 'config' : ''
    this.mood = { emotion: 'calm', intensity: 3, at: Date.now() }
    this.lastSelfChatAt = 0
    this.lastTalkedWith = new Map() // username -> timestamp
  }

  push (list, item, max) {
    list.push({ at: Date.now(), ...item })
    if (list.length > max) list.splice(0, list.length - max)
  }

  addEvent (type, text) { this.push(this.events, { type, text }, 20) }

  addChat (from, text, { self = false, whisper = false } = {}) {
    this.push(this.chat, { from, text, self, whisper }, 30)
    if (self) this.lastSelfChatAt = Date.now()
  }

  addAction (decision, result) {
    this.push(this.actions, {
      source: decision.source,
      action: result.action,
      args: result.args,
      ok: result.ok,
      code: result.code,
      message: result.message,
      thought: decision.thought
    }, 30)
  }

  setGoal (goal, source = 'self') {
    this.goal = String(goal || '').slice(0, 200)
    this.goalSource = this.goal ? source : ''
  }

  setMood (emotion, intensity = 5) {
    if (!emotion) return
    this.mood = { emotion: String(emotion).toLowerCase(), intensity: clampInt(intensity, 1, 10, 5), at: Date.now() }
  }

  /** Mood fades back to the personality baseline after a couple of minutes. */
  currentMood (baseline = 'calm') {
    const age = Date.now() - this.mood.at
    if (age > 180000) return { emotion: baseline, intensity: 3 }
    const fade = Math.floor(age / 60000)
    return { emotion: this.mood.emotion, intensity: Math.max(1, this.mood.intensity - fade) }
  }

  /** Number of consecutive failed actions (used to nudge the LLM to change approach). */
  failureStreak () {
    let n = 0
    for (let i = this.actions.length - 1; i >= 0 && !this.actions[i].ok; i--) n++
    return n
  }
}

function clampInt (v, min, max, def) {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

function ago (ts) {
  const s = Math.round((Date.now() - ts) / 1000)
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

// ===========================================================================
// Perception — turn the world into a compact JSON snapshot
// ===========================================================================

function classifyEntity (e) {
  if (e.type === 'player') return 'player'
  if (e.name === 'item') return 'item'
  if (e.kind === 'Hostile mobs') return 'hostile'
  if (e.kind === 'Passive mobs' || ['animal', 'passive', 'water_creature', 'ambient'].includes(e.type)) return 'passive'
  return 'other'
}

function timePhase (timeOfDay) {
  if (timeOfDay < 1000 || timeOfDay >= 23000) return 'dawn'
  if (timeOfDay < 12000) return 'day'
  if (timeOfDay < 13000) return 'dusk'
  return 'night'
}

const pos3 = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) })
const itemLabel = (item) => {
  if (!item) return null
  const left = durabilityLeft(item)
  return left === null ? `${item.name}${item.count > 1 ? ` x${item.count}` : ''}` : `${item.name} (${Math.round((left / item.maxDurability) * 100)}% durability)`
}

class Perception {
  constructor (bot, config) {
    this.bot = bot
    this.config = config
    const reg = bot.registry
    const names = config.perception.interestingBlocks
    this.interestingIds = names.map((n) => reg.blocksByName[n]?.id).filter((id) => id !== undefined)
    this.liquidIds = ['water', 'lava'].map((n) => reg.blocksByName[n]?.id).filter((id) => id !== undefined)
    this.latest = null
  }

  nearbyEntities () {
    const { bot } = this
    const { entityRadius, maxEntities } = this.config.perception
    const me = bot.entity.position
    return Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position && e.position.distanceTo(me) <= entityRadius)
      .map((e) => ({ e, kind: classifyEntity(e), d: e.position.distanceTo(me) }))
      .filter((x) => x.kind !== 'other')
      .sort((a, b) => a.d - b.d)
      .slice(0, maxEntities)
      .map(({ e, kind, d }) => {
        const out = { id: e.id, kind, name: e.username || e.name, distance: Math.round(d * 10) / 10, position: pos3(e.position) }
        if (kind === 'item') out.item = safe(() => e.getDroppedItem()?.name)
        if (kind === 'player') out.holding = e.heldItem?.name || null
        return out
      })
  }

  nearbyBlocks () {
    const { bot } = this
    const radius = this.config.perception.blockSearchRadius
    const found = {}
    const record = (pos) => {
      const block = bot.blockAt(pos)
      if (!block) return
      const entry = found[block.name]
      if (entry) { entry.count++; return }
      found[block.name] = {
        count: 1,
        nearest: pos3(pos),
        distance: Math.round(bot.entity.position.distanceTo(pos)),
        visible: safe(() => bot.canSeeBlock(block)) ?? false
      }
    }
    if (this.interestingIds.length) {
      for (const pos of bot.findBlocks({ matching: this.interestingIds, maxDistance: radius, count: 256 })) record(pos)
    }
    for (const id of this.liquidIds) {
      const b = bot.findBlock({ matching: id, maxDistance: Math.min(radius, 16) })
      if (b) record(b.position)
    }
    return found
  }

  /** Counts of block types in a small cube around the bot — "what does it look like here". */
  surroundings () {
    const { bot } = this
    const r = this.config.perception.blockScanRadius
    const base = bot.entity.position.floored()
    const counts = {}
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const b = bot.blockAt(base.offset(dx, dy, dz))
          if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue
          counts[b.name] = (counts[b.name] || 0) + 1
        }
      }
    }
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10))
  }

  equipment () {
    const { bot } = this
    const slot = (dest) => safe(() => itemLabel(bot.inventory.slots[bot.getEquipmentDestSlot(dest)]))
    return { hand: itemLabel(bot.heldItem), offHand: slot('off-hand'), head: slot('head'), torso: slot('torso'), legs: slot('legs'), feet: slot('feet') }
  }

  hints (state) {
    const h = []
    const inv = state.inventory.items
    const hasAny = (re) => Object.keys(inv).some((n) => re.test(n))
    if (state.world.phase === 'night' || state.world.phase === 'dusk') h.push('It is dark: hostile mobs spawn. Consider shelter, torches or staying near light.')
    if (!hasAny(/_pickaxe$/)) h.push('You have no pickaxe.')
    if (state.self.food <= 6) h.push('You are hungry; eat or find food soon.')
    if (state.self.health <= 8) h.push('Your health is low; avoid fights and eat to regenerate.')
    if (state.inventory.freeSlots <= 2) h.push('Your inventory is almost full.')
    if (state.nearbyEntities.some((e) => e.kind === 'hostile' && e.distance < 8)) h.push('A hostile mob is close!')
    return h
  }

  snapshot (memory, executor, personality) {
    const { bot, config } = this
    const e = bot.entity
    const cursor = safe(() => bot.blockAtCursor(5))
    const below = bot.blockAt(e.position.offset(0, -0.5, 0))
    const recent = config.loop.historySize

    const state = {
      self: {
        name: bot.username,
        position: { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 },
        health: Math.round(bot.health),
        food: bot.food,
        saturation: Number.isFinite(bot.foodSaturation) ? Math.round(bot.foodSaturation) : null,
        oxygen: bot.oxygenLevel,
        xpLevel: bot.experience?.level ?? 0,
        dimension: bot.game?.dimension,
        gameMode: bot.game?.gameMode,
        onGround: e.onGround,
        inWater: e.isInWater ?? false
      },
      world: {
        timeOfDay: bot.time.timeOfDay,
        phase: timePhase(bot.time.timeOfDay),
        raining: bot.isRaining,
        thundering: (bot.thunderState ?? 0) > 0,
        biome: safe(() => below?.biome?.name) || undefined
      },
      equipment: this.equipment(),
      inventory: { items: inventorySummary(bot), freeSlots: bot.inventory.emptySlotCount() },
      lookingAt: cursor ? { block: cursor.name, position: pos3(cursor.position) } : null,
      standingOn: below?.name ?? null,
      nearbyEntities: this.nearbyEntities(),
      nearbyBlocks: this.nearbyBlocks(),
      surroundings: this.surroundings(),
      onlinePlayers: Object.keys(bot.players).filter((n) => n !== bot.username),
      status: {
        currentAction: executor.current ? executor.current.name : null,
        goal: memory.goal || null,
        goalSetBy: memory.goalSource || null,
        mood: memory.currentMood(personality.baselineMood)
      },
      recentActions: memory.actions.slice(-recent).map((a) => ({
        when: ago(a.at), action: a.action, args: a.args, ok: a.ok, ...(a.code ? { code: a.code } : {}), result: a.message
      })),
      recentEvents: memory.events.slice(-recent).map((ev) => `${ago(ev.at)}: ${ev.text}`),
      recentChat: memory.chat.slice(-recent).map((c) => `${ago(c.at)} ${c.self ? '(you) ' : ''}${c.from}${c.whisper ? ' (whisper)' : ''}: ${c.text}`)
    }
    state.hints = this.hints(state)
    this.latest = state
    return state
  }
}

function safe (fn) {
  try { return fn() } catch { return undefined }
}

// ===========================================================================
// Ollama client — one request at a time, priority ordered, with retries
// ===========================================================================

const PRIORITY = { reply: 0, reaction: 1, decision: 2, smalltalk: 3 }

class OllamaClient {
  constructor (config, log) {
    this.cfg = config.llm
    this.log = log
    this.queue = []
    this.busy = false
    this.jsonSchemaSupported = this.cfg.useJsonSchema
  }

  /** Queue a chat request. Resolves to the parsed JSON object the model produced. */
  chat (messages, { schema, priority = PRIORITY.decision, temperature, label = 'llm' } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ messages, schema, priority, temperature, label, resolve, reject, at: Date.now() })
      this.queue.sort((a, b) => a.priority - b.priority || a.at - b.at)
      this.pump()
    })
  }

  /** Drop queued (not yet sent) requests, e.g. on disconnect. */
  clear (reason = 'cleared') {
    for (const job of this.queue.splice(0)) job.reject(new Error(reason))
  }

  async pump () {
    if (this.busy) return
    const job = this.queue.shift()
    if (!job) return
    this.busy = true
    try {
      job.resolve(await this.request(job))
    } catch (err) {
      job.reject(err)
    } finally {
      this.busy = false
      setImmediate(() => this.pump())
    }
  }

  async request ({ messages, schema, temperature, label }) {
    let lastErr
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      const started = Date.now()
      try {
        const body = {
          model: this.cfg.model,
          messages,
          stream: false,
          format: schema && this.jsonSchemaSupported ? schema : 'json',
          keep_alive: this.cfg.keepAlive,
          options: { temperature: temperature ?? this.cfg.temperature, num_ctx: this.cfg.numCtx }
        }
        const res = await fetch(this.cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.cfg.timeoutMs)
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          // Old Ollama versions reject schema objects in `format`; fall back to JSON mode.
          if (res.status === 400 && this.jsonSchemaSupported && /format/i.test(text)) {
            this.log.warn('Ollama rejected the JSON schema; falling back to plain JSON mode (upgrade Ollama for structured outputs).')
            this.jsonSchemaSupported = false
            continue
          }
          const err = new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`)
          err.retryable = res.status >= 500 || res.status === 429
          throw err
        }
        const data = await res.json()
        const content = data?.message?.content
        if (!content) throw Object.assign(new Error('Ollama returned an empty message.'), { retryable: true })
        const parsed = parseJsonLoose(content)
        this.log.debug(`${label}: ${Date.now() - started}ms, ${data.eval_count ?? '?'} tokens`)
        return parsed
      } catch (err) {
        lastErr = err
        const retryable = err.retryable !== false || err.name === 'TimeoutError' || err.cause?.code === 'ECONNREFUSED'
        if (!retryable || attempt === this.cfg.maxRetries) break
        const wait = 1000 * 2 ** attempt
        this.log.warn(`${label} request failed (${err.message}); retrying in ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
    if (lastErr?.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Cannot reach Ollama at ${this.cfg.url}. Is "ollama serve" running?`)
    }
    throw lastErr
  }

  async healthCheck () {
    const base = new URL(this.cfg.url).origin
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })
      const data = await res.json()
      const models = (data.models || []).map((m) => m.name)
      const wanted = this.cfg.model.includes(':') ? this.cfg.model : `${this.cfg.model}:latest`
      if (!models.includes(wanted) && !models.includes(this.cfg.model)) {
        this.log.warn(`Model "${this.cfg.model}" is not pulled in Ollama. Run: ollama pull ${this.cfg.model}  (available: ${models.join(', ') || 'none'})`)
      } else {
        this.log.info(`Ollama OK at ${base}, model ${this.cfg.model}`)
      }
    } catch (err) {
      this.log.warn(`Ollama health check failed (${err.message}). The bot will keep retrying.`)
    }
  }
}

/** Parse model output that should be JSON but may be wrapped in fences or prose. */
function parseJsonLoose (text) {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* fall through */ } }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) { try { return JSON.parse(text.slice(start, end + 1)) } catch { /* fall through */ } }
  throw Object.assign(new Error(`Model did not return valid JSON: ${text.slice(0, 120)}`), { retryable: true })
}

// ===========================================================================
// Prompts & response schemas
// ===========================================================================

const EMOTIONS = ['happy', 'excited', 'calm', 'curious', 'bored', 'focused', 'proud', 'amused', 'annoyed',
  'frustrated', 'angry', 'scared', 'nervous', 'sad', 'tired', 'surprised', 'confused', 'determined']

function decisionSchema (toolNames) {
  return {
    type: 'object',
    properties: {
      thought: { type: 'string', description: 'Brief reasoning about the situation and why this action.' },
      emotion: { type: 'string', enum: EMOTIONS },
      emotionIntensity: { type: 'integer', minimum: 1, maximum: 10 },
      goal: { type: 'string', description: 'Your current short-term goal (keep it while still pursuing it).' },
      action: {
        type: 'object',
        properties: { name: { type: 'string', enum: toolNames }, args: { type: 'object' } },
        required: ['name', 'args']
      }
    },
    required: ['thought', 'emotion', 'emotionIntensity', 'goal', 'action']
  }
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your chat reply, or "" to stay silent.' },
    emotion: { type: 'string', enum: EMOTIONS },
    emotionIntensity: { type: 'integer', minimum: 1, maximum: 10 },
    acceptTask: { type: 'boolean', description: 'true if the player asked you to do something and you agree to do it.' },
    newGoal: { type: 'string', description: 'If acceptTask, the concrete goal, e.g. "collect 10 oak logs for Steve". Otherwise "".' }
  },
  required: ['reply', 'emotion', 'emotionIntensity', 'acceptTask', 'newGoal']
}

const MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'One short chat message, or "" to stay quiet.' },
    emotion: { type: 'string', enum: EMOTIONS },
    emotionIntensity: { type: 'integer', minimum: 1, maximum: 10 }
  },
  required: ['message', 'emotion', 'emotionIntensity']
}

function personaBlock (p, botName) {
  const list = (arr) => (arr && arr.length ? arr.join(', ') : 'none')
  const lines = [
    `You are ${p.name || botName} (username "${botName}"), a player on a Minecraft Java Edition survival server.`,
    p.description,
    `Personality traits: ${list(p.traits)}.`,
    `Speaking style: ${p.speakingStyle}. Write in ${p.language}.${p.lowercase ? ' Always type in lowercase.' : ''}`,
    `Likes: ${list(p.likes)}. Dislikes: ${list(p.dislikes)}.`
  ]
  if (p.quirks?.length) lines.push(`Quirks: ${list(p.quirks)}.`)
  if (p.catchphrases?.length) lines.push(`Catchphrases you sometimes use (sparingly): ${p.catchphrases.map((c) => `"${c}"`).join(', ')}.`)
  if (p.ambitions?.length) lines.push(`Long-term ambitions: ${list(p.ambitions)}.`)
  lines.push(p.admitsBeingBot
    ? 'Stay in character as a player. If someone sincerely asks whether you are a bot or an AI, be honest about it (casually, in character).'
    : 'Stay in character as a player and do not bring up being an AI.')
  return lines.join('\n')
}

function chatPolicy (mode) {
  switch (mode) {
    case 'silent': return 'You cannot use chat at all right now.'
    case 'respond': return 'Replies to other players are handled for you automatically. Focus on playing; do not start conversations.'
    default: return 'You may occasionally use chatMessage to say something natural, but mostly play the game. Never spam or repeat yourself.'
  }
}

function buildDecisionPrompt (agent, toolDocs) {
  const { personality, config } = agent
  return `${personaBlock(personality, agent.bot.username)}

## How you play
- Each turn you get your current state as JSON and choose exactly ONE action. You'll see its result next turn.
- Play like a thoughtful human survival player: punch trees → craft planks, sticks, a crafting table and tools → mine stone and ores → get food, armor and shelter. Pursue your goal and ambitions, but stay flexible.
- Use exact coordinates, block names and entity ids from the state. Never invent ids or coordinates you have not seen.
- Read recentActions: if an action failed, understand the error code and try something different instead of repeating it.
- If a player asked you for something and you agreed (see status.goal / recentChat), prioritise it.
- Survive: eat when hungry, avoid lava and deep falls, fight or flee from hostile mobs, be careful at night.
- ${chatPolicy(config.chat.mode)}
- Keep "thought" to one or two sentences. "emotion" is how you genuinely feel right now as this character.

## Available actions
${toolDocs}

## Response format
Reply with ONLY a JSON object, no other text:
{"thought": "...", "emotion": "<one of: ${EMOTIONS.join(', ')}>", "emotionIntensity": 1-10, "goal": "current short-term goal", "action": {"name": "<action name>", "args": { ... }}}`
}

/** Compact one-line status used by the chat-oriented prompts. */
function briefStatus (state) {
  if (!state) return 'unknown'
  const s = state.self
  const inv = Object.entries(state.inventory.items).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(', ') || 'empty'
  const near = state.nearbyEntities.filter((e) => e.kind !== 'item').slice(0, 5).map((e) => `${e.name} (${e.distance}m)`).join(', ') || 'nobody'
  return `At ${s.position.x}, ${s.position.y}, ${s.position.z} (${state.world.phase}${state.world.raining ? ', raining' : ''}${state.world.biome ? `, ${state.world.biome}` : ''}). ` +
    `Health ${s.health}/20, food ${s.food}/20. Holding ${state.equipment.hand || 'nothing'}. Doing: ${state.status.currentAction || 'nothing'}. ` +
    `Goal: ${state.status.goal || 'none'}. Inventory: ${inv}. Nearby: ${near}.`
}

// ===========================================================================
// ChatManager — the single gate every outgoing message passes through
// ===========================================================================

/** Which message categories each chat mode allows. 'system' (owner command acks) is always allowed. */
const CHAT_PERMISSIONS = {
  silent: [],
  respond: ['reply'],
  unprompted: ['unprompted', 'reaction', 'tool'],
  both: ['reply', 'unprompted', 'reaction', 'tool']
}

class ChatManager {
  constructor (agent) {
    this.agent = agent
    this.sentTimes = []
    this.lastSentAt = 0
    this.recentSelf = []
    this.queue = Promise.resolve()
  }

  get cfg () { return this.agent.config.chat }

  allows (category) {
    if (category === 'system') return true
    const mode = this.cfg.mode
    if (category === 'reaction' && mode === 'respond' && this.cfg.reactionsInRespondMode) return true
    return (CHAT_PERMISSIONS[mode] || []).includes(category)
  }

  /** Queue a message. Resolves to the text actually sent, or null if it was blocked. */
  send (text, category = 'tool', opts = {}) {
    const job = this.queue.then(() => this.deliver(text, category, opts))
    this.queue = job.catch(() => {})
    return job
  }

  sanitize (text) {
    const p = this.agent.personality
    let msg = String(text ?? '')
      .replace(/[\u0000-\u001f\u007f§]/g, ' ') // control chars & formatting codes get you kicked
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '') // models love to wrap messages in quotes
      .trim()
    const names = [this.agent.bot.username, p.name].filter(Boolean)
    for (const n of names) msg = msg.replace(new RegExp(`^<?${escapeRegex(n)}>?:\\s*`, 'i'), '')
    msg = msg.replace(/^\/+/, '') // never let the LLM run server commands
    if (p.lowercase) msg = msg.toLowerCase()
    const max = this.cfg.maxMessageLength
    if (msg.length > max) {
      const cut = msg.slice(0, max)
      msg = (cut.lastIndexOf(' ') > max * 0.6 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim()
    }
    return msg
  }

  async deliver (text, category, { whisperTo } = {}) {
    const { bot, log, memory } = this.agent
    if (!this.allows(category)) { log.debug(`chat (${category}) blocked by mode "${this.cfg.mode}": ${text}`); return null }
    if (!bot?.entity) return null

    const msg = this.sanitize(text)
    if (!msg) return null

    const now = Date.now()
    this.sentTimes = this.sentTimes.filter((t) => now - t < 60000)
    if (category !== 'system' && this.sentTimes.length >= this.cfg.maxMessagesPerMinute) {
      log.debug(`chat rate limit hit, dropped: ${msg}`)
      return null
    }
    if (this.recentSelf.some((r) => r.text === msg.toLowerCase() && now - r.at < 120000)) {
      log.debug(`chat duplicate dropped: ${msg}`)
      return null
    }

    const gap = this.cfg.minSecondsBetweenMessages * 1000 - (now - this.lastSentAt)
    if (gap > 0) {
      // Spontaneous chatter is optional — drop it rather than queueing a backlog.
      if (category === 'unprompted') return null
      await sleep(gap)
    }
    if (this.cfg.typingCharsPerSecond > 0 && category !== 'system') {
      await sleep(Math.min(5000, (msg.length / this.cfg.typingCharsPerSecond) * 1000))
    }
    if (!bot.entity) return null // disconnected while "typing"

    try {
      if (whisperTo) bot.whisper(whisperTo, msg)
      else bot.chat(msg)
    } catch (err) {
      log.warn(`Failed to send chat: ${err.message}`)
      return null
    }
    this.lastSentAt = Date.now()
    this.sentTimes.push(this.lastSentAt)
    this.recentSelf.push({ text: msg.toLowerCase(), at: this.lastSentAt })
    if (this.recentSelf.length > 10) this.recentSelf.shift()
    memory.addChat(bot.username, msg, { self: true, whisper: Boolean(whisperTo) })
    if (whisperTo) memory.lastTalkedWith.set(whisperTo, this.lastSentAt)
    log.chat(`${whisperTo ? `(to ${whisperTo}) ` : ''}<${bot.username}> ${msg}  [${category}]`)
    return msg
  }
}

function escapeRegex (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const randomBetween = (min, max) => min + Math.random() * (max - min)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

// ===========================================================================
// ChatResponder — incoming chat, replies, task requests and owner commands
// ===========================================================================

class ChatResponder {
  constructor (agent) {
    this.agent = agent
    this.pending = []
    this.timer = null
  }

  get cfg () { return this.agent.config.chat }

  isOwner (username) {
    if (username === '@console') return true
    return this.agent.config.behavior.owners.map((o) => o.toLowerCase()).includes(String(username).toLowerCase())
  }

  isAddressed (username, message, whisper) {
    if (whisper) return true
    const { bot, personality, memory } = this.agent
    const words = [bot.username, personality.name, ...(personality.nicknames || [])].filter(Boolean)
    if (words.some((w) => new RegExp(`\\b${escapeRegex(w)}\\b`, 'i').test(message))) return true
    const last = memory.lastTalkedWith.get(username)
    return Boolean(last && Date.now() - last < this.cfg.conversationWindowSec * 1000)
  }

  onMessage (username, message, { whisper = false } = {}) {
    const { bot, memory, log, config } = this.agent
    if (!username || username === bot.username) return
    log.chat(`${whisper ? '(whisper) ' : ''}<${username}> ${message}`)
    if (this.cfg.ignore.map((i) => i.toLowerCase()).includes(username.toLowerCase())) return
    memory.addChat(username, message, { whisper })

    const prefix = config.behavior.commandPrefix
    if (prefix && message.startsWith(prefix) && this.isOwner(username)) {
      this.handleCommand(username, message.slice(prefix.length).trim(), whisper).catch((err) => log.warn(`Command failed: ${err.message}`))
      return
    }

    if (!this.agent.chat.allows('reply')) return
    const addressed = this.isAddressed(username, message, whisper)
    let respond = false
    switch (this.cfg.respondTo) {
      case 'everyone': respond = addressed || Math.random() < this.cfg.unaddressedReplyChance; break
      case 'whitelist': respond = addressed && this.cfg.whitelist.map((w) => w.toLowerCase()).includes(username.toLowerCase()); break
      default: respond = addressed
    }
    if (!respond) return

    this.lookAtSpeaker(username)
    this.pending.push({ username, message, whisper })
    // Debounce: wait a human-like moment, batching rapid-fire messages into one reply.
    clearTimeout(this.timer)
    const [min, max] = this.cfg.replyDelayMs
    this.timer = setTimeout(() => this.flush().catch((err) => log.warn(`Reply failed: ${err.message}`)), randomBetween(min, max))
  }

  lookAtSpeaker (username) {
    const { bot, executor } = this.agent
    if (!this.cfg.lookAtSpeaker || executor.busy) return
    const entity = bot.players[username]?.entity
    if (entity && entity.position.distanceTo(bot.entity.position) < 16) {
      bot.lookAt(entity.position.offset(0, entity.height, 0)).catch(() => {})
    }
  }

  async flush () {
    const batch = this.pending.splice(0)
    if (batch.length === 0) return
    const agent = this.agent
    const { bot, memory, personality, config, log } = agent
    const speaker = batch[batch.length - 1].username
    const whisper = batch.every((b) => b.whisper)
    const canObey = config.behavior.obeyPlayers === 'everyone' ||
      (config.behavior.obeyPlayers === 'owners' && this.isOwner(speaker))

    const history = memory.chat.slice(-12).map((c) => `${c.self ? `${bot.username} (you)` : c.from}${c.whisper ? ' (whisper)' : ''}: ${c.text}`).join('\n')
    const system = `${personaBlock(personality, bot.username)}

You are reading Minecraft chat and replying as yourself. Write like a real player typing in game chat: short (usually under 15 words), casual, in character. No emojis, no markdown, no quotation marks, don't prefix your name.
If the message doesn't need a reply (e.g. it's not really for you), set reply to "".
${canObey
    ? 'If the player asks you to do something in the game, decide in character whether to help. If you agree, set acceptTask=true and give a concrete newGoal.'
    : 'You do not take orders from this player: politely or playfully decline tasks (acceptTask=false).'}
Respond with ONLY JSON: {"reply": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10, "acceptTask": true|false, "newGoal": "..."}`

    const user = `Your status: ${briefStatus(agent.perception?.latest)}
Recent chat:
${history}

Reply to ${speaker}'s latest message${batch.length > 1 ? 's' : ''}: ${batch.filter((b) => b.username === speaker).map((b) => `"${b.message}"`).join(' ')}`

    const out = await agent.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
      { schema: REPLY_SCHEMA, priority: PRIORITY.reply, label: 'reply' })

    memory.setMood(out.emotion, out.emotionIntensity)
    memory.lastTalkedWith.set(speaker, Date.now())
    if (out.reply) await agent.chat.send(out.reply, 'reply', { whisperTo: whisper && this.cfg.whisperReplies ? speaker : undefined })

    if (out.acceptTask && canObey && out.newGoal) {
      log.info(`Accepted task from ${speaker}: ${out.newGoal}`)
      memory.setGoal(out.newGoal, speaker)
      memory.addEvent('task', `${speaker} asked you to: ${out.newGoal} (you agreed)`)
      agent.brain.onNewGoal()
    }
  }

  /** Owner-only commands, e.g. "!mode silent". Also used by the console. */
  async handleCommand (username, text, whisper) {
    const agent = this.agent
    const { memory, config, executor, brain, bot } = agent
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ')
    const reply = (msg) => {
      if (username === '@console') agent.log.info(msg)
      else agent.chat.send(msg, 'system', { whisperTo: whisper ? username : undefined })
    }

    switch ((cmd || '').toLowerCase()) {
      case 'stop':
        executor.abort(`stopped by ${username}`)
        brain.clearForced()
        return reply('ok, stopping.')
      case 'pause':
        brain.paused = true
        executor.abort(`paused by ${username}`)
        return reply('paused.')
      case 'resume':
        brain.paused = false
        brain.wake()
        return reply('resuming.')
      case 'mode':
        if (!CHAT_MODES.includes(arg)) return reply(`chat mode is "${config.chat.mode}". options: ${CHAT_MODES.join(', ')}`)
        config.chat.mode = arg
        return reply(`chat mode set to ${arg}.`)
      case 'goal':
        if (!arg) return reply(`goal: ${memory.goal || 'none'}`)
        memory.setGoal(arg === 'clear' ? '' : arg, username)
        brain.onNewGoal()
        return reply(arg === 'clear' ? 'goal cleared.' : `new goal: ${arg}`)
      case 'come':
      case 'follow': {
        if (username === '@console') return reply('the console has no position; use !goal instead.')
        const name = cmd === 'come' ? 'moveToPlayer' : 'followPlayer'
        executor.abort(`${cmd} requested by ${username}`)
        brain.queueAction({ name, args: { playerName: username, durationSeconds: 60 } }, `${username} told me to ${cmd}`)
        return reply(cmd === 'come' ? 'on my way!' : 'following you.')
      }
      case 'persona':
      case 'personality': {
        const presets = listPersonalities()
        if (!presets.includes(arg)) return reply(`presets: ${presets.join(', ')}`)
        agent.setPersonality(arg)
        return reply(`personality switched to ${arg}.`)
      }
      case 'reactions':
        config.reactions.enabled = arg !== 'off'
        return reply(`reactions ${config.reactions.enabled ? 'on' : 'off'}.`)
      case 'status': {
        const s = agent.perception?.latest
        return reply(`hp ${Math.round(bot.health)} food ${bot.food} | doing ${executor.current?.name || 'nothing'} | goal: ${memory.goal || 'none'} | mood ${memory.currentMood().emotion}${s ? ` | at ${Math.floor(s.self.position.x)} ${Math.floor(s.self.position.y)} ${Math.floor(s.self.position.z)}` : ''}`)
      }
      case 'help':
      default:
        return reply('commands: stop, pause, resume, mode <silent|respond|unprompted|both>, goal <text|clear>, come, follow, persona <name>, reactions <on|off>, status')
    }
  }
}

// ===========================================================================
// SmallTalk — unprompted messages on a randomised timer
// ===========================================================================

class SmallTalk {
  constructor (agent) {
    this.agent = agent
    this.timer = null
    this.running = false
  }

  start () {
    this.running = true
    this.schedule()
  }

  stop () {
    this.running = false
    clearTimeout(this.timer)
  }

  schedule () {
    if (!this.running) return
    const base = this.agent.config.chat.unprompted.intervalSeconds * 1000
    this.timer = setTimeout(() => {
      this.tick().catch((err) => this.agent.log.debug(`smalltalk skipped: ${err.message}`)).finally(() => this.schedule())
    }, randomBetween(base * 0.7, base * 1.3))
  }

  async tick () {
    const agent = this.agent
    const { bot, memory, personality, config } = agent
    const cfg = config.chat.unprompted
    if (!agent.chat.allows('unprompted') || !bot.entity || agent.dead) return
    if (Date.now() - memory.lastSelfChatAt < cfg.minSilenceSeconds * 1000) return
    const others = Object.keys(bot.players).filter((n) => n !== bot.username)
    if (cfg.requirePlayersOnline && others.length === 0) return
    if (cfg.requirePlayersNearby && !others.some((n) => bot.players[n]?.entity?.position.distanceTo(bot.entity.position) < 32)) return
    if (Math.random() > cfg.chance) return

    const mine = memory.chat.filter((c) => c.self).slice(-5).map((c) => `- ${c.text}`).join('\n') || '- (nothing yet)'
    const system = `${personaBlock(personality, bot.username)}

You feel like saying something in Minecraft chat on your own, unprompted — like a real player would while playing.
Good topics: ${(personality.chatTopics || []).join('; ')}. Keep it to one short, natural message (under 15 words). No emojis, no quotes.
Do not repeat or paraphrase what you said recently. If nothing natural comes to mind, return "".
Respond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}`
    const user = `Your status: ${briefStatus(agent.perception?.latest)}
Recent events: ${memory.events.slice(-5).map((e) => e.text).join('; ') || 'none'}
Online players: ${others.join(', ') || 'none'}
Things you said recently:
${mine}`

    const out = await agent.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
      { schema: MESSAGE_SCHEMA, priority: PRIORITY.smalltalk, label: 'smalltalk', temperature: 0.9 })
    if (out.message) {
      memory.setMood(out.emotion, out.emotionIntensity)
      await agent.chat.send(out.message, 'unprompted')
    }
  }
}

// ===========================================================================
// EventReactor — personalised reactions to in-game events
// ===========================================================================

class EventReactor {
  constructor (agent) {
    this.agent = agent
    this.cooldowns = new Map()
    this.lastReactionAt = 0
    this.spawnedAt = 0
    this.prev = { health: 20, food: 20, phase: null, raining: false, level: null }
    this.seenNearbyPlayers = new Map() // username -> last time seen nearby
    this.seenHostiles = new Set()
    this.pendingDeathCause = null
  }

  /** Event config = global config ← personality overrides. */
  eventConfig (type) {
    const base = this.agent.config.reactions.events[type]
    const override = this.agent.personality.reactions?.[type]
    return base || override ? deepMerge(base || {}, override || {}) : null
  }

  attach (bot) {
    bot.once('spawn', () => {
      this.spawnedAt = Date.now()
      this.prev.level = bot.experience?.level ?? null
      // Give the player list a moment to fill in before greeting.
      setTimeout(() => this.trigger('spawn', {}), 3000)
    })

    bot.on('playerJoined', (player) => {
      if (player.username === bot.username || Date.now() - this.spawnedAt < 10000) return
      this.trigger('playerJoined', { player: player.username })
    })
    bot.on('playerLeft', (player) => {
      if (player.username === bot.username) return
      this.trigger('playerLeft', { player: player.username })
    })

    bot.on('death', () => this.trigger('death', { cause: this.pendingDeathCause || 'unknown causes' }))

    // Death messages ("Steve was slain by Zombie") arrive as translated system chat.
    bot.on('message', (jsonMsg) => {
      const key = jsonMsg?.translate
      if (!key || !key.startsWith('death.')) return
      const victim = safe(() => jsonMsg.with?.[0]?.toString())
      const text = jsonMsg.toString()
      if (victim === bot.username) this.pendingDeathCause = text
      else if (victim) this.trigger('playerDied', { player: victim, cause: text })
    })

    bot.on('entityHurt', (entity) => {
      if (entity !== bot.entity) return
      const attacker = Object.values(bot.entities)
        .filter((e) => e !== bot.entity && (e.type === 'player' || e.kind === 'Hostile mobs') && e.position.distanceTo(bot.entity.position) < 6)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      this.agent.lastHurtAt = Date.now()
      this.trigger('hurt', { attacker: attacker ? attacker.username || attacker.name : 'something', health: Math.round(bot.health) })
      this.agent.brain?.onDamage()
    })

    bot.on('health', () => {
      const low = this.eventConfig('lowHealth')?.threshold ?? 8
      const hungry = this.eventConfig('hungry')?.threshold ?? 6
      if (bot.health > 0 && bot.health <= low && this.prev.health > low) this.trigger('lowHealth', { health: Math.round(bot.health) })
      if (bot.food <= hungry && this.prev.food > hungry) this.trigger('hungry', { food: bot.food })
      this.prev.health = bot.health
      this.prev.food = bot.food
    })

    bot.on('time', () => {
      const phase = timePhase(bot.time.timeOfDay)
      if (this.prev.phase && phase !== this.prev.phase) {
        if (phase === 'night') this.trigger('nightfall', {})
        if (phase === 'dawn') this.trigger('daybreak', {})
      }
      this.prev.phase = phase
    })

    bot.on('rain', () => {
      if (bot.isRaining && !this.prev.raining) this.trigger('rainStart', {})
      this.prev.raining = bot.isRaining
    })

    bot.on('experience', () => {
      const level = bot.experience?.level
      if (this.prev.level !== null && level > this.prev.level) this.trigger('levelUp', { level })
      this.prev.level = level
    })

    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return
      const item = safe(() => collected.getDroppedItem?.()?.name)
      if (item) this.trigger('itemPickup', { item })
    })
  }

  /** Called on every perception tick to detect proximity-based events. */
  observe (state) {
    const now = Date.now()
    for (const e of state.nearbyEntities) {
      if (e.kind === 'player' && e.distance < 8) {
        const last = this.seenNearbyPlayers.get(e.name)
        if (!last || now - last > 120000) this.trigger('playerNearby', { player: e.name, entityId: e.id })
        this.seenNearbyPlayers.set(e.name, now)
      }
      if (e.kind === 'hostile' && e.distance < 12 && !this.seenHostiles.has(e.id)) {
        this.seenHostiles.add(e.id)
        this.trigger('hostileNearby', { mob: e.name, entityId: e.id })
      }
    }
    if (this.seenHostiles.size > 500) this.seenHostiles.clear()
  }

  describe (type, d) {
    const name = this.agent.bot.username
    switch (type) {
      case 'spawn': return `You (${name}) just joined the server. Online: ${Object.keys(this.agent.bot.players).filter((n) => n !== name).join(', ') || 'nobody'}.`
      case 'playerJoined': return `${d.player} joined the game.`
      case 'playerLeft': return `${d.player} left the game.`
      case 'playerNearby': return `${d.player} came close to you.`
      case 'death': return `You died (${d.cause}). You respawned and lost your items where you died.`
      case 'hurt': return `You took damage from ${d.attacker} (health ${d.health}/20).`
      case 'lowHealth': return `Your health is low (${d.health}/20).`
      case 'hungry': return `You are getting hungry (food ${d.food}/20).`
      case 'playerDied': return `${d.player} died: "${d.cause}".`
      case 'killedMob': return `You killed a ${d.mob}.`
      case 'hostileNearby': return `A hostile ${d.mob} appeared nearby.`
      case 'toolBroke': return `Your ${d.item} broke.`
      case 'nightfall': return 'Night is falling.'
      case 'daybreak': return 'The sun is rising.'
      case 'rainStart': return 'It started raining.'
      case 'levelUp': return `You reached XP level ${d.level}.`
      case 'itemPickup': return `You picked up ${d.item}.`
      default: return `${type} happened.`
    }
  }

  fill (template, d) {
    const vars = { name: this.agent.personality.name || this.agent.bot.username, ...d }
    return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
  }

  trigger (type, data = {}) {
    const agent = this.agent
    const { memory, config, bot, log } = agent
    if (!bot?.entity && type !== 'death') return
    const text = this.describe(type, data)
    // Always remember the event so the decision loop can take it into account.
    if (type !== 'itemPickup') memory.addEvent(type, text)
    log.debug(`event ${type}: ${text}`)

    const cfg = this.eventConfig(type)
    if (!config.reactions.enabled || !cfg || !cfg.enabled) return

    const now = Date.now()
    const key = cfg.perTarget && data.player ? `${type}:${data.player}` : type
    if (now - (this.cooldowns.get(key) || 0) < (cfg.cooldownSec || 0) * 1000) return
    if (type !== 'spawn' && now - this.lastReactionAt < config.reactions.globalCooldownSec * 1000) return
    if (Math.random() > (cfg.chance ?? 1)) return
    this.cooldowns.set(key, now)
    this.lastReactionAt = now

    this.react(type, cfg, data, text).catch((err) => log.debug(`reaction ${type} failed: ${err.message}`))
  }

  async react (type, cfg, data, text) {
    const agent = this.agent
    const { bot, config, executor, memory, personality } = agent

    // Body language first — only when idle so we don't fight the current action for control.
    if (cfg.gesture && config.reactions.gestures && !executor.busy && !agent.dead) {
      const target = data.player ? bot.players[data.player]?.entity : data.entityId ? bot.entities[data.entityId] : null
      if (target) await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0)).catch(() => {})
      await performGesture(bot, cfg.gesture).catch(() => {})
    }

    const style = cfg.style || 'template'
    if (style === 'gesture' || style === 'silent' || !agent.chat.allows('reaction')) {
      // gesture-style events may still have a line of chat as a fallback when idle
      if (style === 'gesture' && cfg.templates?.length && agent.chat.allows('reaction') && Math.random() < 0.3) {
        await agent.chat.send(this.fill(pick(cfg.templates), data), 'reaction')
      }
      return
    }

    let message = null
    if (style === 'llm') {
      try {
        const system = `${personaBlock(personality, bot.username)}

Something just happened in the game. React the way your character genuinely would, with ONE very short chat message (under 12 words) — or "" if you'd honestly just stay quiet. No emojis, no quotes.
Respond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}`
        const out = await agent.llm.chat([
          { role: 'system', content: system },
          { role: 'user', content: `Event: ${text}\nYour status: ${briefStatus(agent.perception?.latest)}` }
        ], { schema: MESSAGE_SCHEMA, priority: PRIORITY.reaction, label: `reaction:${type}`, temperature: 0.9 })
        memory.setMood(out.emotion, out.emotionIntensity)
        message = out.message
      } catch (err) {
        agent.log.debug(`LLM reaction failed, using template: ${err.message}`)
      }
    }
    if (message === null && cfg.templates?.length) message = this.fill(pick(cfg.templates), data)
    if (message) await agent.chat.send(message, 'reaction')
  }
}

// ===========================================================================
// Brain — the throttled perceive → decide → act loop
// ===========================================================================

// Classified as hostile by minecraft-data, but they leave you alone unless provoked.
const NEUTRAL_MOBS = new Set(['enderman', 'zombified_piglin', 'piglin', 'spider', 'bee', 'wolf', 'polar_bear', 'llama', 'goat', 'iron_golem'])

class Brain {
  constructor (agent) {
    this.agent = agent
    this.running = false
    this.paused = false
    this.forced = [] // actions queued by commands, run before asking the LLM
    this.lastLlmAt = 0
    this.backoff = agent.config.loop.errorBackoffMs
    this.reflexCooldowns = new Map()
    this.wakeFn = null
  }

  start () {
    if (this.running) return
    this.running = true
    this.loop().catch((err) => this.agent.log.error(`Brain loop crashed: ${err.stack || err}`))
  }

  stop () {
    this.running = false
    this.wake()
  }

  /** Sleep that can be cut short by wake(). */
  idle (ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.wakeFn = null; resolve() }
      const timer = setTimeout(done, Math.max(0, ms))
      this.wakeFn = done
    })
  }

  wake () { this.wakeFn?.() }

  queueAction (action, reason) {
    this.forced.push({ source: 'command', thought: reason, emotion: 'focused', action })
    this.wake()
  }

  clearForced () { this.forced = [] }

  /** A player gave us a new goal: optionally interrupt and re-plan right away. */
  onNewGoal () {
    const { executor, config } = this.agent
    const current = executor.current?.name
    if (config.chat.goalChangeInterrupts && current && !['attackTarget', 'retreat', 'eatFood'].includes(current)) {
      executor.abort('new goal from chat')
    }
    this.wake()
  }

  onDamage () {
    const { executor, config } = this.agent
    const current = executor.current?.name
    if (config.behavior.interruptOnDamage && current && !['attackTarget', 'retreat', 'eatFood'].includes(current)) {
      // Only interrupt if a reflex would actually do something about it.
      if (this.reflex(true)) executor.abort('took damage')
    }
  }

  async loop () {
    const { log, config } = this.agent
    log.info('Brain loop started.')
    while (this.running) {
      try {
        const agent = this.agent
        if (this.paused || !agent.bot?.entity || agent.dead) { await this.idle(1000); continue }

        let decision = this.forced.shift() || this.reflex()
        if (!decision) {
          // Throttle: never ask the LLM more often than minLlmIntervalMs.
          const wait = this.lastLlmAt + config.loop.minLlmIntervalMs - Date.now()
          if (wait > 0) await this.idle(wait)
          if (!this.running || this.paused || agent.dead) continue
          if (this.forced.length) continue // a command arrived while we waited
          this.lastLlmAt = Date.now()
          decision = await this.decide()
        }

        const { name, args } = decision.action
        log.info(`▶ ${name}(${JSON.stringify(args)})${decision.source !== 'llm' ? ` [${decision.source}]` : ''}`)
        const result = await agent.executor.execute(name, args)
        agent.memory.addAction(decision, result)
        if (result.ok) log.info(`✔ ${name}: ${result.message} (${(result.durationMs / 1000).toFixed(1)}s)`)
        else log.warn(`✘ ${name} [${result.code}]: ${result.message}`)
        if (!result.ok && decision.source === 'reflex') this.reflexCooldowns.set(decision.reflexKey, Date.now())

        this.backoff = config.loop.errorBackoffMs
        await this.idle(config.loop.postActionDelayMs)
      } catch (err) {
        log.error(`Brain loop error: ${err.message}`)
        await this.idle(this.backoff)
        this.backoff = Math.min(this.backoff * 2, config.loop.maxErrorBackoffMs)
      }
    }
    log.info('Brain loop stopped.')
  }

  /**
   * Instinctive, LLM-free behaviours: fight back, flee, eat.
   * Cheap, instant, and they save LLM calls for interesting decisions.
   * @param {boolean} dryRun only report whether a reflex applies
   */
  reflex (dryRun = false) {
    const { bot, config, memory } = this.agent
    const b = config.behavior
    if (!bot.entity) return null
    const ready = (key, ms = 30000) => Date.now() - (this.reflexCooldowns.get(key) || 0) > ms
    const me = bot.entity.position
    const hostiles = Object.values(bot.entities)
      .filter((e) => e.kind === 'Hostile mobs' && e.isValid && e.position.distanceTo(me) < 10)
      .sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
    const nearest = hostiles[0]
    const dist = nearest ? nearest.position.distanceTo(me) : Infinity
    const recentlyHurt = Date.now() - (this.agent.lastHurtAt || 0) < 5000
    const make = (reflexKey, thought, emotion, action) => dryRun ? true : { source: 'reflex', reflexKey, thought, emotion, action }

    if (nearest && (bot.health <= b.fleeHealthBelow || (nearest.name === 'creeper' && dist < 5)) && ready('flee', 5000)) {
      return make('flee', `Too dangerous — getting away from the ${nearest.name}.`, 'scared', { name: 'retreat', args: { entityId: nearest.id, distance: 16 } })
    }
    // Neutral mobs are only fought back against, never engaged just for being close.
    const provoked = recentlyHurt && dist < 5
    const tooClose = dist < 2.5 && !NEUTRAL_MOBS.has(nearest?.name)
    if (b.selfDefense && nearest && nearest.name !== 'creeper' && (provoked || tooClose) && ready('defend', 5000)) {
      return make('defend', `A ${nearest.name} is attacking me, fighting back!`, 'determined', { name: 'attackTarget', args: { entityId: nearest.id, maxSeconds: 15 } })
    }
    if (b.autoEat && bot.food <= b.autoEatBelow && dist > 6 && ready('eat')) {
      const foods = bot.registry.foodsByName
      const hasFood = bot.inventory.items().some((i) => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name))
      if (hasFood) return make('eat', 'Getting hungry, time for a snack.', memory.currentMood().emotion, { name: 'eatFood', args: {} })
    }
    return null
  }

  async decide () {
    const agent = this.agent
    const { log, memory, executor, personality, config } = agent
    const state = agent.perception.snapshot(memory, executor, personality)
    const tools = executor.availableTools()

    const nudges = []
    const streak = memory.failureStreak()
    if (streak >= 2) nudges.push(`Your last ${streak} actions failed. Change your approach (different action, target or location).`)
    if (!memory.goal) nudges.push('You have no current goal: pick a sensible one based on your ambitions and situation.')

    const messages = [
      { role: 'system', content: buildDecisionPrompt(agent, executor.describeTools()) },
      { role: 'user', content: `Current state:\n${JSON.stringify(state)}\n\n${nudges.join('\n')}\nChoose your next action.` }
    ]
    const out = await agent.llm.chat(messages, { schema: decisionSchema(tools), priority: PRIORITY.decision, label: 'decision' })

    const decision = {
      source: 'llm',
      thought: String(out.thought || '').slice(0, 300),
      emotion: EMOTIONS.includes(out.emotion) ? out.emotion : 'calm',
      emotionIntensity: clampInt(out.emotionIntensity, 1, 10, 5),
      action: { name: String(out.action?.name || ''), args: isPlainObject(out.action?.args) ? out.action.args : {} }
    }
    if (!tools.includes(decision.action.name)) {
      log.warn(`LLM chose invalid action "${decision.action.name}"; waiting instead.`)
      memory.addEvent('error', `You tried to use "${decision.action.name}", which is not an available action.`)
      decision.action = { name: 'wait', args: { seconds: 2 } }
    }
    if (typeof out.goal === 'string' && out.goal.trim() && out.goal.trim() !== memory.goal) {
      // Keep the player who assigned the goal as its source while the LLM refines the wording.
      memory.setGoal(out.goal.trim(), memory.goalSource && memory.goalSource !== 'self' ? memory.goalSource : 'self')
    }
    memory.setMood(decision.emotion, decision.emotionIntensity)
    if (config.logging.logThoughts) log.mind(`[${decision.emotion} ${decision.emotionIntensity}/10] ${decision.thought}`)
    return decision
  }
}

// ===========================================================================
// Agent — connection lifecycle and wiring
// ===========================================================================

class Agent {
  constructor (config, log) {
    this.config = config
    this.log = log
    this.personality = loadPersonality(config.personality, log)
    this.memory = new Memory(config)
    this.llm = new OllamaClient(config, log)
    this.bot = null
    this.dead = false
    this.shuttingDown = false
    this.reconnectAttempts = 0
    this.intervals = []
  }

  setPersonality (spec) {
    this.personality = loadPersonality(spec, this.log)
    this.config.personality = spec
    this.memory.setMood(this.personality.baselineMood, 3)
    this.log.info(`Personality: ${this.personality.name || '(username)'} — ${this.personality.description}`)
  }

  async start () {
    this.log.info(`Personality: ${this.personality.name || '(username)'} — ${this.personality.description}`)
    this.log.info(`Chat mode: ${this.config.chat.mode}`)
    await this.llm.healthCheck()
    this.connect()
  }

  connect () {
    const s = this.config.server
    this.log.info(`Connecting to ${s.host}:${s.port} as ${s.username}...`)
    const bot = mineflayer.createBot({
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      version: s.version || false,
      checkTimeoutInterval: 60000,
      hideErrors: true
    })
    this.bot = bot
    bot.loadPlugin(pathfinder)

    this.chat = new ChatManager(this)
    this.executor = new ActionExecutor({
      bot,
      config: this.config,
      chat: this.chat,
      log: this.log,
      notify: (type, data) => this.reactor.trigger(type, data)
    })
    this.reactor = new EventReactor(this)
    this.responder = new ChatResponder(this)
    this.brain = new Brain(this)
    this.smalltalk = new SmallTalk(this)
    this.reactor.attach(bot)

    bot.once('spawn', () => this.onFirstSpawn())
    bot.on('spawn', () => { this.dead = false })
    bot.on('death', () => {
      this.dead = true
      this.executor.abort('died')
      this.brain.clearForced()
      this.log.warn('Died. Waiting for respawn...')
    })
    bot.on('chat', (username, message) => this.responder.onMessage(username, message))
    bot.on('whisper', (username, message) => this.responder.onMessage(username, message, { whisper: true }))
    bot.on('kicked', (reason) => this.log.warn(`Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
    bot.on('error', (err) => this.log.error(`Connection error: ${err.message}`))
    bot.on('end', (reason) => this.onEnd(reason))
  }

  onFirstSpawn () {
    const { bot, config, log } = this
    this.reconnectAttempts = 0
    log.info(`Spawned in ${bot.game.dimension} at ${bot.entity.position.floored()} (Minecraft ${bot.version}).`)

    const pf = config.behavior.pathfinding
    const movements = new Movements(bot)
    movements.canDig = pf.canDig
    movements.allowParkour = pf.allowParkour
    movements.allowSprinting = pf.allowSprinting
    movements.allow1by1towers = pf.allow1by1towers
    // Never tunnel through containers or beds that other players placed.
    for (const name of ['chest', 'trapped_chest', 'barrel', 'furnace', 'crafting_table', 'ender_chest']) {
      const id = bot.registry.blocksByName[name]?.id
      if (id !== undefined) movements.blocksCantBreak.add(id)
    }
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.thinkTimeout = pf.thinkTimeoutMs

    this.perception = new Perception(bot, config)
    this.memory.setMood(this.personality.baselineMood, 3)

    // Periodic perception tick (every ~2s) keeps a fresh snapshot for chat prompts and proximity events.
    this.intervals.push(setInterval(() => {
      if (!bot.entity || this.dead) return
      try {
        const state = this.perception.snapshot(this.memory, this.executor, this.personality)
        this.reactor.observe(state)
      } catch (err) {
        log.debug(`perception tick failed: ${err.message}`)
      }
    }, config.perception.intervalMs))

    this.brain.start()
    this.smalltalk.start()
  }

  onEnd (reason) {
    this.log.warn(`Disconnected: ${reason || 'unknown reason'}`)
    this.brain?.stop()
    this.smalltalk?.stop()
    this.executor?.abort('disconnected')
    this.llm.clear('disconnected')
    for (const id of this.intervals.splice(0)) clearInterval(id)
    if (this.shuttingDown || !this.config.server.reconnect) return

    const s = this.config.server
    const delay = Math.min(s.maxReconnectDelayMs, s.reconnectDelayMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`)
    setTimeout(() => { if (!this.shuttingDown) this.connect() }, delay)
  }

  /** Lines typed into the terminal: "!command" runs an owner command, anything else is said in chat. */
  attachConsole () {
    if (!process.stdin.isTTY) return
    const rl = readline.createInterface({ input: process.stdin })
    const prefix = this.config.behavior.commandPrefix
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      if (text.startsWith(prefix)) {
        this.responder?.handleCommand('@console', text.slice(prefix.length).trim(), false)
          .catch((err) => this.log.warn(err.message))
      } else if (this.bot?.entity) {
        this.bot.chat(text)
      }
    })
    this.log.info(`Console ready: type to chat, or ${prefix}help for commands.`)
  }

  shutdown () {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.log.info('Shutting down...')
    this.brain?.stop()
    this.smalltalk?.stop()
    this.executor?.abort('shutdown')
    this.llm.clear('shutdown')
    try { this.bot?.quit('Bye!') } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 1000).unref()
  }
}

// ===========================================================================
// Entry point
// ===========================================================================

function main () {
  const bootLog = createLogger('info')
  let config
  try {
    config = loadConfig(bootLog)
  } catch (err) {
    bootLog.error(err.message)
    process.exit(1)
  }
  const log = createLogger(config.logging.level)
  const agent = new Agent(config, log)

  process.on('SIGINT', () => agent.shutdown())
  process.on('SIGTERM', () => agent.shutdown())
  process.on('unhandledRejection', (err) => log.error(`Unhandled rejection: ${err?.stack || err}`))
  process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${err?.stack || err}`))

  agent.attachConsole()
  agent.start().catch((err) => {
    log.error(`Startup failed: ${err.message}`)
    process.exit(1)
  })
}

if (require.main === module) main()

module.exports = { Agent, Brain, Perception, ChatManager, EventReactor, OllamaClient, loadConfig, deepMerge, DEFAULT_CONFIG }
