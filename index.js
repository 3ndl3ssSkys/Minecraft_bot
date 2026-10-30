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
const mc = require('minecraft-protocol')
const minecraftData = require('minecraft-data')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const { ActionExecutor, performGesture, inventorySummary, durabilityLeft } = require('./actions')
const { EmotionEngine, LABEL_TO_CORE } = require('./emotions')
const { SocialModel, WEAPON, PROMISE_KINDS } = require('./social')
const { Learning, COMBAT_STYLES } = require('./learning')
const { TaskManager, KINDS: TASK_KINDS, EFFORTS, RISKS } = require('./tasks')
const combat = require('./combat')
const knowledge = require('./knowledge')
const building = require('./building')
const { Intelligence, LEVELS: IQ_LEVELS, LABELS: IQ_LABELS } = require('./intelligence')
const { Senses } = require('./senses')
const { ContainerIntel, signText } = require('./containers')

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
    version: false, // false = auto-detect, or e.g. "26.1"
    // If the server is newer than Mineflayer supports (e.g. 26.3), connect as the newest supported
    // version instead. The server then needs ViaBackwards, or the bot must go through ViaProxy.
    viaFallback: true,
    password: '', // for server login plugins (AuthMe & co.): "/register" and "/login" are answered automatically
    loginCommand: '/login {password}', // how to log in on that server
    registerCommand: '/register {password} {password}',
    realm: '', // join a Realm by name instead of host/port (needs auth "microsoft" and an invite)
    resourcePack: 'accept', // 'accept' | 'decline' server resource packs
    chatPatterns: [], // extra regexes (named groups "user" and "msg") for plugin chat formats
    authFolder: 'data/auth', // cached Microsoft sign-in tokens
    platform: 'java', // 'bedrock' when joining through ViaProxy → Geyser: disables what ViaBedrock can't translate yet
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
  // Named server profiles: `node index.js --server friend1` merges servers.friend1 into "server".
  servers: {},
  personality: 'friendly', // preset name from ./personalities, or an inline object
  // How good a player it is: beginning | simple | mediocre | complicated | advanced | hardcore | master | impossible
  intelligence: {
    level: 'mediocre',
    learn: true, // improve with experience (beginners improve a lot, masters barely)
    learnRate: 1, // multiplier on experience gained
    maxLearnedLevels: null, // override how many levels it can grow through learning
    allowXray: false // impossible only: use block data in loaded chunks to find ores/chests through walls (counts as cheating on most servers)
  },
  // How it thinks and what it cares about, on top of personality.
  mind: {
    thinkLike: '', // e.g. "a careful speedrunner", "a medieval knight", "a cheerful farmer"
    playstyle: 'balanced', // balanced | survivalist | builder | explorer | fighter | helper | trader | miner
    priorities: { survival: 1, social: 1, building: 1, exploring: 1, combat: 1, gathering: 1 }, // 0 = ignore, 2 = very important
    riskTolerance: 0.5, // 0 = very careful, 1 = reckless
    curiosity: 0.5, // how eager it is to investigate odd things and explore
    instructions: [], // standing instructions, e.g. "never go into the Nether without fire resistance"
    decisionTemperature: null // override llm.temperature for decisions
  },
  // What it can perceive.
  senses: {
    realisticSight: true, // only see what's in line of sight (invisibility works); off = see everything nearby
    hearing: true, // notice sounds: mobs, footsteps, chests, doors, mining, combat
    particles: true, // notice particles close by in front of it
    particleRange: 10,
    suspicionThreshold: 1.0, // how much unexplained noise before it investigates
    investigate: true
  },
  chat: {
    mode: 'both', // 'silent' | 'respond' | 'unprompted' | 'both'
    respondTo: 'mentions', // 'mentions' | 'everyone' | 'whitelist'
    whitelist: [],
    ignore: [],
    unaddressedReplyChance: 0.15, // respondTo=everyone: chance to chime in on chatter not aimed at us
    conversationWindowSec: 45, // after we talk to someone, their follow-ups count as addressed
    replyDelayMs: [1000, 2500], // human "reading" delay; also batches rapid messages
    typingCharsPerSecond: 9, // simulated typing speed; 0 = instant
    stopToType: true, // stand still while typing, like a player with the chat box open
    danger: {
      maxChars: 24, // in a fight / low health, replies are cut to a few words
      postponeChance: 0.6 // ...or put off until it's safe ("sorry, was fighting")
    },
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
      playerJoined: { enabled: true, chance: 0.7, cooldownSec: 15, perTarget: true, style: 'template', templates: ['hey {player}!', 'welcome back {player}', 'o/ {player}'], templatesWary: ['oh. {player}.', 'great, {player} is back'] },
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
      itemPickup: { enabled: false, chance: 0.1, cooldownSec: 120, style: 'template', templates: ['ooh, {item}'] },
      attackedByPlayer: { enabled: true, chance: 0.8, cooldownSec: 12, perTarget: true, style: 'llm', templates: ['hey! {player} stop', 'dude what', 'why are you hitting me'] },
      killedByPlayer: { enabled: true, chance: 1, cooldownSec: 10, style: 'llm', templates: ['really {player}?', 'wow. thanks {player}'] },
      gift: { enabled: true, chance: 0.9, cooldownSec: 20, perTarget: true, style: 'llm', gesture: 'nod', templates: ['thanks {player}!', 'ty {player}'] },
      promiseKept: { enabled: true, chance: 0.8, cooldownSec: 30, style: 'template', templates: ['appreciate it {player}', 'knew i could count on you {player}'] },
      promiseBroken: { enabled: true, chance: 0.7, cooldownSec: 120, style: 'llm', templates: ['guess {player} forgot...', "{player} you said you'd {promise}"] },
      harmNearby: { enabled: true, chance: 0.6, cooldownSec: 30, perTarget: true, style: 'llm', templates: ['{player} leave the {victim} alone', 'hey, stop that'] },
      crouchGreeting: { enabled: true, chance: 0.9, cooldownSec: 60, perTarget: true, style: 'gesture', gesture: 'crouch', templates: ['o/ {player}'] },
      wonFight: { enabled: true, chance: 0.5, cooldownSec: 60, style: 'llm', templates: ['gg', 'ez'] },
      lostFight: { enabled: true, chance: 0.5, cooldownSec: 60, style: 'template', templates: ['nope, not today', 'gotta heal'] },
      taskDone: { enabled: true, chance: 1, cooldownSec: 0, style: 'llm', templates: ['there you go {player}', 'done!'] },
      taskPartial: { enabled: true, chance: 1, cooldownSec: 0, style: 'llm', templates: ["that's all i got time for {player}", 'got you some, not all of it'] },
      taskAbandoned: { enabled: true, chance: 0.8, cooldownSec: 0, style: 'llm', templates: ["sorry {player}, couldn't do it", 'gonna pass on that one after all'] },
      buildDone: { enabled: true, chance: 1, cooldownSec: 0, style: 'llm', templates: ['finally finished my {name}', 'done building!'] }
    }
  },
  behavior: {
    owners: [], // full control over !commands. Their chat requests are still judged, with judgment.ownerLoyalty on top.
    admins: [], // most !commands (owners can add more with !admin add). Their *requests* are judged like anyone's.
    commandPrefix: '!',
    startingGoal: '',
    protectedPlayers: [], // never attacked, no matter what
    respectPrivateChests: true, // never take from someone else's private chest
    noGrief: true, // don't mine or dig through blocks that are part of other players' builds
    selfDefense: true,
    autoEat: true,
    autoEatBelow: 14,
    fleeHealthBelow: 6,
    interruptOnDamage: true,
    autoEquipWeapon: true,
    autoCollectDrops: true,
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
  // How the bot judges requests. There is no obey-chance dial: it decides per request, based on
  // the task (effort, risk, what it is), how much it likes / trusts the person, its mood and its own needs.
  judgment: {
    ownerLoyalty: 0.3, // extra willingness for owners — they're who it plays with most
    randomness: 0.12, // people aren't perfectly predictable
    maxQueuedTasks: 4, // more than this and older "later" promises start slipping
    forgetting: true, // queued tasks can be forgotten (and remembered when brought up)
    requestedFights: true // consider "go kill X" requests at all (still its own call, and pvp.mode applies)
  },
  // Obedience on top of the bot's own judgment (owners/admins set these with !obey).
  // chance = own willingness + (1 - own willingness) × level. 0 = purely its own call, 1 = does whatever it can.
  obedience: {
    levels: { owner: 0.5, admin: 0.3, trusted: 0.15, player: 0 },
    players: {}, // per-player levels, e.g. { "steve": 0.8 }
    whoCanInstruct: 'everyone', // 'everyone' | 'trusted' | 'admins' | 'owners' | 'nobody' — others only get favours
    overrideConscience: false // if true, obedience ≥ 0.9 can make it attack friends or break its own promises
  },
  // Useful little things to do while the LLM is thinking (checking chests, grabbing drops, mining a visible ore, parkour).
  busyWork: { enabled: true },
  // How much the bot likes each player — chemistry, not politeness. Drives favours.
  affinity: {
    initial: 50, // strangers: no strong feelings
    ownerInitial: 75, // owners start as friends
    perMinuteTogether: 0.15 // hanging out nearby without trouble slowly builds a bond
  },
  trust: {
    enabled: true,
    initial: 75, // everyone starts fairly trusted
    hostileBelow: 20,
    waryBelow: 45,
    trustedAbove: 80, // above the starting trust, so it's earned
    recoveryPerHour: 6, // forgiveness over time (scaled by personality.forgiveness)
    hostileMemoryMinutes: 5, // how long an attacker stays "hostile" after an incident
    lowHealthThreshold: 8, // hitting the bot at or below this health counts as extra malicious
    protectRadius: 12, // harm to players/pets/villagers within this range counts against the attacker
    ignoreHostileChance: 0.4, // chance to just ignore chat from someone hostile
    penalties: { weaponHit: 4, fistHit: 1.5, repeatedHits: 8, hitWhileLow: 6, killedMe: 35, harmedPlayerNearby: 4, harmedPet: 6, harmedVillager: 3, harmedAnimal: 0, killedPlayerNearby: 10, brokenPromise: 10 },
    rewards: { gift: 3, keptPromise: 6, helpedFight: 2, apology: 6, crouchGreeting: 0.5 }
  },
  emotions: {
    enabled: true,
    volatility: 1.0, // how strongly events move feelings (0 = stoic, 2 = dramatic)
    decayPerMinute: 0.2, // how fast feelings return to the personality's temperament
    lock: null, // force one emotion label (set with !emotion lock <label>)
    lockIntensity: 6
  },
  pvp: {
    mode: 'defensive', // 'never' | 'defensive' (fight players who attack it) | 'always'
    allowSparring: true, // accept friendly duels when a player asks ("1v1 me")
    neverAttackOwners: true
  },
  learning: {
    enabled: true,
    file: 'data/brain.json', // relationships, combat stats, lessons, danger zones, in-game settings
    epsilon: 0.2, // how often to try a non-best fighting style (exploration)
    reflect: true, // ask the LLM for a lesson after notable experiences
    maxLessons: 25
  },
  commands: {
    // Minimum role per !command. 'admin' commands also work for owners.
    permissions: {
      help: 'admin', status: 'admin', stop: 'admin', pause: 'admin', resume: 'admin', come: 'admin', follow: 'admin',
      goal: 'admin', mode: 'admin', emotion: 'admin', trust: 'admin', tasks: 'admin', settings: 'admin', get: 'admin', set: 'admin',
      reactions: 'admin', lessons: 'admin', obey: 'admin', build: 'admin', admin: 'owner', persona: 'owner', forget: 'owner', save: 'owner',
      iq: 'owner', intelligence: 'owner', mind: 'owner', chests: 'admin', senses: 'admin'
    },
    // Settings under these prefixes can only be changed by owners, even with !set / !obey.
    ownerOnlySettings: ['trust.', 'pvp.', 'learning.', 'intelligence.', 'mind.', 'obedience.levels.owner', 'obedience.levels.admin', 'obedience.overrideConscience', 'obedience.whoCanInstruct']
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
  // Resting feelings (0..1) and how strongly each kind of event moves them.
  temperament: { joy: 0.35, anger: 0.05, fear: 0.1, sadness: 0.05, boredom: 0.15, surprise: 0 },
  sensitivity: {}, // e.g. { "anger": 1.5, "fear": 0.7 }
  forgiveness: 0.5, // 0 = holds grudges forever, 1 = forgives fast
  trustSensitivity: 1, // multiplier on trust lost from bad behaviour
  fightOrFlight: 0.5, // 0 = always runs from attackers, 1 = always fights back
  helpfulness: 0.6, // how inclined it is to do favours at all
  patience: 1, // how long it sticks with a job before calling it (multiplier)
  forgetfulness: 0.3, // 0 = never forgets a request, 1 = scatterbrained
  violence: 0.35, // appetite for fighting people when someone asks it to
  generosity: 0.5, // willingness to give away valuable things
  restlessness: 0.5, // how much it fidgets (parkour, hopping around) while thinking
  refusalStyle: 'casual — a quick excuse, a joke, or a plain "nah" depending on mood',
  fallbackRefusals: ['nah', 'maybe later', 'not rn', "i'm good"],
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
/** CLI: node index.js [config.json] [--server <profile>] */
function parseArgs () {
  const args = process.argv.slice(2)
  const out = { file: null, server: process.env.BOT_SERVER || null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--server') out.server = args[++i]
    else if (!args[i].startsWith('--') && !out.file) out.file = args[i]
  }
  return out
}

function loadConfig (log) {
  const cli = parseArgs()
  const file = cli.file || process.env.BOT_CONFIG || path.join(__dirname, 'config.json')
  let user = {}
  if (fs.existsSync(file)) {
    user = readJson(file)
    log.info(`Loaded config from ${file}`)
  } else {
    log.warn(`No config file at ${file}; using defaults.`)
  }
  const config = deepMerge(DEFAULT_CONFIG, user)
  // A named server profile overrides the default server settings.
  if (cli.server) {
    const profile = config.servers?.[cli.server]
    if (!profile) throw new Error(`No server profile "${cli.server}" in config.servers (have: ${Object.keys(config.servers || {}).join(', ') || 'none'})`)
    config.server = deepMerge(config.server, profile)
    log.info(`Using server profile "${cli.server}" (${profile.realm ? `realm ${profile.realm}` : `${config.server.host}:${config.server.port}`})`)
  }

  const env = process.env
  if (env.MC_HOST) config.server.host = env.MC_HOST
  if (env.MC_PORT) config.server.port = Number(env.MC_PORT)
  if (env.MC_USERNAME) config.server.username = env.MC_USERNAME
  if (env.MC_AUTH) config.server.auth = env.MC_AUTH
  if (env.MC_VERSION) config.server.version = env.MC_VERSION
  if (env.MC_PASSWORD) config.server.password = env.MC_PASSWORD
  if (env.BOT_INTELLIGENCE) config.intelligence.level = env.BOT_INTELLIGENCE
  if (env.OLLAMA_URL) config.llm.url = env.OLLAMA_URL
  if (env.OLLAMA_MODEL) config.llm.model = env.OLLAMA_MODEL
  if (env.BOT_PERSONALITY) config.personality = env.BOT_PERSONALITY
  if (env.BOT_CHAT_MODE) config.chat.mode = env.BOT_CHAT_MODE

  // Backwards compatibility with older config files.
  if (user.behavior?.allowPvp === true && !user.pvp?.mode) config.pvp.mode = 'always'
  if (user.behavior?.obeyPlayers && !user.obedience?.whoCanInstruct) {
    config.obedience.whoCanInstruct = { everyone: 'everyone', owners: 'owners', nobody: 'nobody' }[user.behavior.obeyPlayers] || 'everyone'
  }

  if (!IQ_LEVELS.includes(config.intelligence.level)) {
    log.warn(`Unknown intelligence.level "${config.intelligence.level}" (use ${IQ_LEVELS.join(', ')}); using mediocre.`)
    config.intelligence.level = 'mediocre'
  }
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
  constructor (agent) {
    this.agent = agent
    const { bot, config } = agent
    this.bot = bot
    this.config = config
    const reg = bot.registry
    const names = config.perception.interestingBlocks
    this.interestingIds = names.map((n) => reg.blocksByName[n]?.id).filter((id) => id !== undefined)
    this.liquidIds = ['water', 'lava'].map((n) => reg.blocksByName[n]?.id).filter((id) => id !== undefined)
    this.latest = null
  }

  /** Only what the bot can actually perceive (sight, hearing, memory) — see senses.js. */
  nearbyEntities () {
    const { bot } = this
    const { entityRadius, maxEntities } = this.config.perception
    const me = bot.entity.position
    const radius = this.agent.intelligence.can('seeThroughWalls', 'senses') ? Math.max(entityRadius, 48) : entityRadius
    return this.agent.senses.perceive(bot, radius)
      .map((p) => ({ ...p, e: p.entity, kind: classifyEntity(p.entity), d: (p.lastPos || p.entity.position).distanceTo(me) }))
      .filter((x) => x.kind !== 'other')
      .sort((a, b) => a.d - b.d)
      .slice(0, maxEntities)
      .map(({ e, kind, d, how, lastPos, lastAt, invisible, tag, identified }) => {
        const pos = lastPos || e.position
        // Players are only known by name if their name tag could be read (or was a moment ago).
        const name = kind === 'player' && !identified ? 'unknown player' : e.username || e.name
        const out = { id: e.id, kind, name, distance: Math.round(d * 10) / 10, position: pos3(pos) }
        if (how !== 'sight') out.perceived = how === 'memory' ? `last seen ${ago(lastAt)}` : how
        if (invisible) out.invisible = true
        if (tag?.tag) out.nameTag = tag.tag
        if (tag?.tamed) out.tamed = true
        if (tag?.owner) out.owner = tag.owner
        if (kind === 'item') out.item = safe(() => e.getDroppedItem()?.name)
        if (kind === 'player') {
          if (how !== 'name tag through wall' && how !== 'memory') {
            out.holding = e.heldItem?.name || null
            if (out.holding && WEAPON.test(out.holding)) out.armed = true
            if (e.crouching) out.crouching = true
          }
          if (identified) Object.assign(out, this.agent.social.annotate(e.username))
          else out.note = "can't see their name tag"
        }
        return out
      })
  }

  /**
   * Notable blocks. Realistically only ones it can see (or saw recently, or is
   * standing next to); impossible + allowXray reads every loaded block.
   */
  nearbyBlocks () {
    const { bot } = this
    const intel = this.agent.intelligence
    const xray = intel.can('seeThroughWalls', 'senses') && this.config.intelligence.allowXray
    const realistic = this.config.senses.realisticSight && !xray
    const radius = xray ? Math.max(32, this.config.perception.blockSearchRadius) : this.config.perception.blockSearchRadius
    this.blockMemory ||= new Map() // "x,y,z" -> { name, at }
    const found = {}
    const record = (pos) => {
      const block = bot.blockAt(pos)
      if (!block) return
      const dist = bot.entity.position.distanceTo(pos)
      const k = `${pos.x},${pos.y},${pos.z}`
      let visible = dist <= 3 || this.agent.senses.canSee(bot, pos.offset(0.5, 0.5, 0.5))
      if (visible) this.blockMemory.set(k, { name: block.name, at: Date.now() })
      else if (realistic) {
        const m = this.blockMemory.get(k)
        if (!m || m.name !== block.name || Date.now() - m.at > 10 * 60000) return // never seen it: doesn't know it's there
        visible = false
      }
      const entry = found[block.name]
      if (entry) { entry.count++; return }
      found[block.name] = { count: 1, nearest: pos3(pos), distance: Math.round(dist), visible }
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

  /** Signs it can see and read. */
  visibleSigns () {
    const { bot } = this
    if (!this.signCache || Date.now() - this.signCache.at > 6000) {
      const list = this.agent.containers.signsNear(bot, bot.entity.position.floored(), 10, 8)
        .filter((sg) => this.agent.senses.canSee(bot, sg.pos.offset(0.5, 0.5, 0.5)))
        .slice(0, 5)
        .map((sg) => `(${sg.pos.x}, ${sg.pos.y}, ${sg.pos.z}): "${sg.text}"`)
      this.signCache = { at: Date.now(), list }
    }
    return this.signCache.list
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
    const enemy = state.nearbyEntities.find((e) => e.kind === 'player' && e.hostile && e.distance < 16)
    if (enemy) h.push(`${enemy.name} has been hostile to you and is ${enemy.distance} blocks away${enemy.armed ? ', armed' : ''}.`)
    if (state.status.task) h.push(`You're doing something for ${state.status.task.for}: ${state.status.task.what}.`)
    return h
  }

  snapshot () {
    const { bot, config } = this
    const { memory, executor, emotions, learning } = this.agent
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
        feelings: emotions.describe(),
        ...this.agent.tasks.statusForPrompt(),
        danger: this.agent.dangerLevel(),
        combatKit: combat.describeKit(bot),
        building: this.agent.builder.current ? building.describePlan(this.agent.builder.current) : null,
        knownContainers: this.agent.containers.nearest(e.position),
        skill: this.agent.intelligence.describe(),
        dangerZonesNearby: learning.movement.nearbyDangers(e.position)
      },
      senses: this.agent.senses.summary(),
      signs: this.visibleSigns(),
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

const PRIORITY = { reply: 0, reaction: 1, decision: 2, smalltalk: 3, reflect: 4 }

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
      },
      taskUpdate: {
        type: 'object',
        description: 'How the task you are doing for another player (status.task) is going.',
        properties: { status: { type: 'string', enum: ['none', 'working', 'done', 'gave_up'] }, note: { type: 'string' } },
        required: ['status', 'note']
      }
    },
    required: ['thought', 'emotion', 'emotionIntensity', 'goal', 'action', 'taskUpdate']
  }
}

const PLAYER_EMOTIONS = ['happy', 'friendly', 'excited', 'neutral', 'bored', 'sad', 'annoyed', 'angry', 'scared', 'joking', 'sarcastic', 'unknown']
const PLAYER_INTENTS = ['friendly', 'joking', 'neutral', 'asking_for_help', 'request', 'trading', 'rude', 'threatening', 'apologetic', 'manipulative']

/**
 * First pass over an incoming message: understand it (and reply directly when it isn't a request).
 * Requests get a second pass after the bot has made up its mind — see ChatResponder.flush.
 */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your chat reply if this is NOT a request (or "" to stay silent).' },
    emotion: { type: 'string', enum: EMOTIONS },
    emotionIntensity: { type: 'integer', minimum: 1, maximum: 10 },
    playerEmotion: { type: 'string', enum: PLAYER_EMOTIONS },
    playerIntent: { type: 'string', enum: PLAYER_INTENTS },
    trustImpact: { type: 'integer', minimum: -10, maximum: 4 },
    likeImpact: { type: 'integer', minimum: -5, maximum: 5 },
    remindsOfTask: { type: 'boolean', description: 'They are reminding you of / asking about something they asked you before.' },
    isRequest: { type: 'boolean', description: 'They are asking you to do something in the game.' },
    request: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: TASK_KINDS },
        description: { type: 'string' },
        item: { type: 'string' },
        count: { type: 'integer' },
        target: { type: 'string' },
        effort: { type: 'string', enum: EFFORTS },
        risk: { type: 'string', enum: RISKS }
      },
      required: ['kind', 'description', 'item', 'count', 'target', 'effort', 'risk']
    },
    promise: {
      type: 'object',
      description: 'Did THEY promise you something?',
      properties: {
        made: { type: 'boolean' },
        kind: { type: 'string', enum: PROMISE_KINDS },
        description: { type: 'string' },
        item: { type: 'string' },
        count: { type: 'integer' },
        withinMinutes: { type: 'integer' }
      },
      required: ['made', 'kind', 'description', 'item', 'count', 'withinMinutes']
    }
  },
  required: ['reply', 'emotion', 'emotionIntensity', 'playerEmotion', 'playerIntent', 'trustImpact', 'likeImpact', 'remindsOfTask', 'isRequest', 'request', 'promise']
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
  lines.push(HUMAN_VOICE)
  return lines.join('\n')
}

/** Shared rule: sound like a person, especially when saying no. */
const HUMAN_VOICE = 'You talk like a real person in game chat, never like an assistant or a bot: no "I cannot", "I am unable to", ' +
  '"I\'m not allowed", "as an AI", "my instructions". When you don\'t want to do something you say it the way people do — an excuse, a joke, ' +
  'a counter-offer, a blunt "nah", or calling someone out — coloured by your mood and how you feel about that person.'

function chatPolicy (mode) {
  switch (mode) {
    case 'silent': return 'You cannot use chat at all right now.'
    case 'respond': return 'Replies to other players are handled for you automatically. Focus on playing; do not start conversations.'
    default: return 'You may occasionally use chatMessage to say something natural, but mostly play the game. Never spam or repeat yourself.'
  }
}

/** The "how you think" block: skill level + configurable mind. */
function mindBlock (agent) {
  const m = agent.config.mind
  const intel = agent.intelligence
  const lines = [`## How you think\nSkill: ${intel.label}. ${intel.mindset()}`]
  if (intel.cfg.learn && intel.baseIndex < 7) lines.push('You get better with experience; "What you\'ve learned" is knowledge you picked up yourself.')
  if (m.thinkLike) lines.push(`Think and play like ${m.thinkLike}.`)
  const styles = {
    survivalist: 'You focus on staying alive and self-sufficient: food, shelter, safety first.',
    builder: 'You love building: you spend your time gathering materials and constructing things.',
    explorer: 'You love exploring: new biomes, caves and structures pull you along.',
    fighter: 'You seek out fights and gear up for combat.',
    helper: 'You like helping other players and working together.',
    trader: 'You care about trading and collecting valuables (emeralds, diamonds, villagers).',
    miner: 'You love mining: caves, ores and big tunnels.'
  }
  if (styles[m.playstyle]) lines.push(styles[m.playstyle])
  const pr = Object.entries(m.priorities || {}).filter(([, v]) => v !== 1).map(([k, v]) => `${k} ${v > 1 ? 'matters a lot' : v <= 0 ? "doesn't matter to you" : 'matters less'}`)
  if (pr.length) lines.push(`Priorities: ${pr.join(', ')}.`)
  if (m.riskTolerance <= 0.25) lines.push('You are very careful and avoid unnecessary risks.')
  else if (m.riskTolerance >= 0.75) lines.push('You take big risks for big rewards.')
  if (m.curiosity >= 0.75) lines.push('You are very curious: odd noises and unexplored places draw you in.')
  else if (m.curiosity <= 0.25) lines.push("You don't go poking around things that don't concern you.")
  if (m.instructions?.length) lines.push(`Always: ${m.instructions.map((x) => `\n- ${x}`).join('')}`)
  return lines.join('\n')
}

function buildDecisionPrompt (agent, toolDocs) {
  const { personality, config } = agent
  return `${personaBlock(personality, agent.bot.username)}

${mindBlock(agent)}

## How you play
- Each turn you get your current state as JSON and choose exactly ONE action. You'll see its result next turn.
- Play like a thoughtful human survival player: punch trees → craft planks, sticks, a crafting table and tools → mine stone and ores → get food, armor and shelter. Pursue your goal and ambitions, but stay flexible.
- Use exact coordinates, block names and entity ids from the state. Never invent ids or coordinates you have not seen.
- Read recentActions: if an action failed, understand the error code and try something different instead of repeating it.
- If a player asked you for something and you agreed (see status.goal / recentChat), prioritise it.
- Survive: eat when hungry, avoid lava, deep falls and status.dangerZonesNearby, fight or flee from hostile mobs, be careful at night.
- Use the game's systems: smelt ores and cook food (smeltItem), store loot in chests (status.knownContainers remembers what's where), sleep in a bed at night, open doors, fish, and useItem for potions, pearls, buckets, bone meal and the like. If you're unsure how something works or how to get an item, use knowledge — but you only know what a player of your skill knows; otherwise experiment or ask.
- Your senses are realistic: nearbyEntities is what you can see or hear ("perceived" says how; "last seen" means it went out of sight). status.senses lists sounds and particles; "source unseen" means you can't see what made it. If something sounds wrong (footsteps, a chest opening, mining, with nobody visible), be cautious and check it out — less so if you know other players are around.
- Name tags: you know who a player is only from their name tag ("unknown player" = you can't read it — they're invisible, too far, or their tag is hidden). Tags show through walls unless the player sneaks, so "name tag through wall" means you know they're there. A nameTag field shows ranks or prefixes like [Admin] and the names of named mobs and pets; "tamed" means it has a collar (someone's pet).
- Read signs (status.signs, readSigns): they tell you whose place it is, rules, and directions. Chests: inspectContainer tells you whose chest it is (yours, community, someone's private chest, unlooted or looted loot chest). Never take from other players' private chests; loot chests and community chests are fine (take fairly from community ones).
- On other people's servers be a good guest: don't break or dig through other players' builds, don't take their things, and follow any rules you see in chat or on signs.
- Fights: attackTarget already uses your whole kit (status.combatKit) — bows at range, axe vs shields, mace + wind charges, potions, golden apples, totems. Carry good stuff before risky trips.
- Building: when you want a home, base or lookout, use planBuilding with your own concept (what YOU would like, fitting the place), then build repeatedly; gather what it says is missing. status.building shows progress.
- People: each player in nearbyEntities has your trust in them and how they seem. Be generous with friends (giveItem, help them), polite but guarded with strangers, and keep your distance from people who hurt you. You may fight players who attack you; never attack someone just because you dislike them. Accept a duel only when a player asks for one (attackTarget with sparring: true).
- Your feelings (status.feelings) should colour how you play: scared → careful, angry → blunt and aggressive, happy → social and generous, bored → go do something new.
- status.task is something you agreed to do for another player. Work on it (gather/craft: mineBlock, craftItem, smeltItem…; the hand-over happens automatically when you have enough). Take care of urgent needs first. If it's done (for non-item tasks) set taskUpdate.status "done"; if you honestly don't want to keep going — it's dragging on, or you have something you need or want to do — set "gave_up" with a short note. Otherwise "working" (or "none" if you have no task).
- status.queuedTasks are things you said you'd do later.
- ${chatPolicy(config.chat.mode)}${config.server.platform === 'bedrock' ? "\n- You joined through a Bedrock bridge: you can't break blocks or use inventories or chests here. Explore, socialise, follow, fight, use items and place blocks instead." : ''}
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
    `Goal: ${state.status.goal || 'none'}.${state.status.task ? ` Doing for ${state.status.task.for}: ${state.status.task.what}${state.status.task.progress ? ` (${state.status.task.progress})` : ''}.` : ''} Inventory: ${inv}. Nearby: ${near}.`
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

  async deliver (text, category, { whisperTo, fallback } = {}) {
    const { bot, log, memory } = this.agent
    if (!this.allows(category)) { log.debug(`chat (${category}) blocked by mode "${this.cfg.mode}": ${text}`); return null }
    if (!bot?.entity) return null

    let msg = this.sanitize(text)
    if (!msg) return null
    if (category !== 'system' && ROBOTIC.test(msg)) {
      // Small models slip into assistant-speak when refusing; swap in a human line instead.
      const lines = fallback || this.agent.personality.fallbackRefusals || []
      log.debug(`robotic phrasing replaced: ${msg}`)
      if (!lines.length || category !== 'reply') return null
      msg = this.sanitize(pick(lines))
    }

    // In a fight nobody types paragraphs.
    const danger = this.agent.dangerLevel()
    if (danger === 'high' && category !== 'system') {
      if (category === 'unprompted') return null
      msg = shortenForDanger(msg, this.cfg.danger.maxChars)
      if (!msg) return null
    }

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
      // The chat box is open: the bot stands still while it types (quickly, if it's in danger).
      const ms = Math.min(danger === 'high' ? 700 : 6000, (msg.length / this.cfg.typingCharsPerSecond) * 1000)
      if (this.cfg.stopToType && this.agent.executor) await this.agent.executor.pauseFor(ms)
      else await sleep(ms)
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

/** Cut a message down to what you'd type mid-fight: the first few words. */
function shortenForDanger (msg, maxChars) {
  if (msg.length <= maxChars) return msg
  // Keep the first natural chunk ("hey whats up"), else the first few words.
  const first = msg.split(/[,.;:!?]| - /)[0].trim()
  if (first && first.length <= maxChars) return first
  return msg.split(' ').slice(0, 3).join(' ').slice(0, maxChars)
}

/** Assistant-style phrasing that no real player would type. */
const ROBOTIC = /\b(as an ai|language model|i('m| am) (unable|not able|not permitted|not allowed) to|i (cannot|can't) (comply|assist|fulfill|help with that)|i must (decline|refuse)|my (programming|instructions|guidelines)|i apologi[sz]e,? but)\b/i

function escapeRegex (s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const randomBetween = (min, max) => min + Math.random() * (max - min)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

// ===========================================================================
// ChatResponder — incoming chat, replies, task requests and owner commands
// ===========================================================================

/** Common plugin chat/whisper formats. Returns { user, msg, whisper } or null. */
function parsePluginChat (text, extra = []) {
  const t = String(text).replace(/§./g, '').trim()
  for (const re of extra) {
    const m = t.match(re)
    if (m?.groups?.user && m.groups.msg) return { user: m.groups.user, msg: m.groups.msg, whisper: Boolean(m.groups.whisper) }
  }
  const N = '([.*]?[A-Za-z0-9_]{2,16})' // Floodgate (Bedrock) players get a "." or "*" prefix
  let m = t.match(new RegExp(`^\\[?${N}\\s*(?:->|→|»)\\s*(?:me|you)\\]?\\s*:?\\s+(.+)$`, 'i')) || t.match(new RegExp(`^${N} whispers(?: to you)?:\\s+(.+)$`, 'i')) || t.match(new RegExp(`^From ${N}:\\s+(.+)$`, 'i'))
  if (m) return { user: m[1], msg: m[2], whisper: true }
  m = t.match(new RegExp(`^(?:\\[[^\\]]{1,24}\\]\\s*)*<${N}>\\s+(.+)$`)) ||
    t.match(new RegExp(`^(?:\\[[^\\]]{1,24}\\]\\s*)*(?:[^\\s:]{1,16}\\s)?${N}\\s*(?:»|>>|:|\\|)\\s+(.+)$`))
  return m ? { user: m[1], msg: m[2], whisper: false } : null
}

const URGENT = /\b(help|run|behind you|watch out|look out|creeper|danger|stop|wait|duck)\b/i

class ChatResponder {
  constructor (agent) {
    this.agent = agent
    this.pending = []
    this.timer = null
    this.postponed = [] // messages we couldn't answer mid-fight
    this.postponeTimer = null
  }

  /** Answer later, once it's safe (or after a minute and a half regardless). */
  postpone (batch) {
    this.postponed.push(...batch)
    if (this.postponeTimer) return
    const since = Date.now()
    this.postponeTimer = setInterval(() => {
      if (this.agent.dangerLevel() === 'high' && Date.now() - since < 90000) return
      clearInterval(this.postponeTimer)
      this.postponeTimer = null
      const later = this.postponed.splice(0)
      this.pending.unshift(...later)
      this.delayed = true
      this.flush().catch((err) => this.agent.log.warn(`Reply failed: ${err.message}`))
    }, 2000)
  }

  /** Prompt line about being in danger (or about answering late). */
  dangerNote () {
    const { level, reason } = this.agent.dangerInfo()
    if (level === 'high') return `You're in danger right now (${reason}). You can only type 1-3 words — like "busy", "not now", "help!", "one sec" — or "".`
    if (this.delayed) return 'You couldn\'t answer right away because you were in danger. It\'s safe now; you can mention that briefly if it fits.'
    return ''
  }

  get cfg () { return this.agent.config.chat }

  /** owner > admin > player, with the console counting as an owner. */
  roleRank (username) {
    return { player: 0, admin: 1, owner: 2 }[this.agent.social.role(username)]
  }

  canUseCommand (username, cmd) {
    const needed = this.agent.config.commands.permissions[cmd] || 'owner'
    return this.roleRank(username) >= { admin: 1, owner: 2 }[needed]
  }

  isAddressed (username, message, whisper) {
    if (whisper) return true
    const { bot, personality, memory } = this.agent
    // Bedrock players via Floodgate get a prefix (".Gamertag"): match the name with or without it.
    const words = [bot.username, bot.username?.replace(/^[^A-Za-z0-9_]+/, ''), personality.name, ...(personality.nicknames || [])].filter(Boolean)
    if (words.some((w) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(w)}($|[^A-Za-z0-9_])`, 'i').test(message))) return true
    const last = memory.lastTalkedWith.get(username)
    return Boolean(last && Date.now() - last < this.cfg.conversationWindowSec * 1000)
  }

  onMessage (username, message, { whisper = false } = {}) {
    const { bot, memory, log, config } = this.agent
    if (!username || username === bot.username) return
    log.chat(`${whisper ? '(whisper) ' : ''}<${username}> ${message}`)
    if (this.cfg.ignore.map((i) => i.toLowerCase()).includes(username.toLowerCase())) return
    memory.addChat(username, message, { whisper })

    // !commands from people allowed to use them. Everyone else's "!stop" is just chat.
    const prefix = config.behavior.commandPrefix
    if (prefix && message.startsWith(prefix)) {
      const cmd = message.slice(prefix.length).trim().split(/\s+/)[0]?.toLowerCase() || 'help'
      if (this.roleRank(username) > 0 && this.canUseCommand(username, cmd)) {
        this.handleCommand(username, message.slice(prefix.length).trim(), whisper).catch((err) => log.warn(`Command failed: ${err.message}`))
        return
      }
    }

    // Players can teach it things ("you need an iron pickaxe for diamonds").
    if (!this.agent.social.isHostile(username)) this.agent.learnFacts(message, username, 0.35)

    if (!this.agent.chat.allows('reply')) return
    const addressed = this.isAddressed(username, message, whisper)
    let respond = false
    switch (this.cfg.respondTo) {
      case 'everyone': respond = addressed || Math.random() < this.cfg.unaddressedReplyChance * this.agent.emotions.modifiers().talkativeness; break
      case 'whitelist': respond = addressed && this.cfg.whitelist.map((w) => w.toLowerCase()).includes(username.toLowerCase()); break
      default: respond = addressed
    }
    if (!respond) return

    // A real person sometimes just ignores someone who's been attacking them.
    const social = this.agent.social
    if (social.isHostile(username) && social.role(username) !== 'owner' && Math.random() < config.trust.ignoreHostileChance) {
      memory.addEvent('ignored', `You ignored ${username}'s message.`)
      return
    }

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
    const { bot, memory, personality, social, emotions, tasks } = agent
    // Mid-fight: either a couple of words now, or answer once it's safe.
    if (!this.delayed && agent.dangerLevel() === 'high' && !batch.some((b) => URGENT.test(b.message)) && Math.random() < this.cfg.danger.postponeChance) {
      return this.postpone(batch)
    }
    const dangerNote = this.dangerNote()
    this.delayed = false
    const speaker = batch[batch.length - 1].username
    const whisper = batch.every((b) => b.whisper)
    const said = batch.filter((b) => b.username === speaker).map((b) => b.message)
    const mods = emotions.modifiers()

    const others = Object.keys(bot.players).filter((n) => n !== bot.username && n !== speaker).slice(0, 4)
    const history = memory.chat.slice(-12).map((c) => `${c.self ? `${bot.username} (you)` : c.from}${c.whisper ? ' (whisper)' : ''}: ${c.text}`).join('\n')
    const about = tasks.aboutPlayer(speaker)
    const system = `${personaBlock(personality, bot.username)}

You are reading Minecraft chat as yourself. Write like a real player typing in game chat: short (usually under 15 words), casual, in character. No emojis, no markdown, no quotation marks, don't prefix your name.
${dangerNote ? `${dangerNote}\n` : ''}${mods.talkativeness < 0.6 ? "You're not in a chatty mood: keep it very short.\n" : ''}Let your feelings and your history with this person show in your tone: warm with people you like, cool or curt with people you don't, angry with people who hurt you.

First: are they asking you to DO something in the game (gather or craft something, give them items, come, follow, fight or kill someone/something, protect someone, build, explore...)?
- If yes: isRequest=true and fill "request" (kind; description in a few words; item as an exact Minecraft id like oak_log or iron_ingot; count; target = the player or mob name if any; effort = how much work it honestly is; risk = how dangerous). Leave reply "" — you'll answer once you've thought about whether you want to.
- If not: isRequest=false, request kind "other" with empty strings and 0, and write your reply (or "" if it doesn't need one).
remindsOfTask: true if they're asking about or reminding you of something they asked before.

Then read the other player:
- playerEmotion / playerIntent: how they seem (banter between friends is "joking", not "rude").
- trustImpact: does this make them seem more or less SAFE and reliable? -10 serious threat, -3 rude, 0 normal, +2 kind, +4 very kind. Ordinary chat is 0.
- likeImpact: did YOU, with your personality and interests, enjoy this? This is chemistry, not politeness: funny, interesting, shares your interests, good banter → positive; boring, needy, bossy, annoying, try-hard → negative. Ordinary small talk is 0. Range -5..5.
- promise: if THEY promise to do something for you (${PROMISE_KINDS.join('|')}), made=true with details; otherwise made=false, kind "other", empty strings and 0s.
Respond with ONLY the JSON object.`

    const user = `Your status: ${briefStatus(agent.perception?.latest)}
How you feel: ${emotions.describe()}
How you feel about ${speaker}: ${social.relationshipLine(speaker)}
${about ? `Things between you and ${speaker}:\n${about}\n` : ''}${others.length ? `Others online:\n${social.peopleSummary(others)}\n` : ''}Recent chat:
${history}

${speaker}'s latest message${said.length > 1 ? 's' : ''}: ${said.map((m) => `"${m}"`).join(' ')}`

    const out = await agent.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
      { schema: ANALYSIS_SCHEMA, priority: PRIORITY.reply, label: 'reply' })

    emotions.fromLabel(out.emotion, out.emotionIntensity)
    social.onChatAnalysis(speaker, out)
    memory.lastTalkedWith.set(speaker, Date.now())
    const recalled = out.remindsOfTask ? tasks.recall(speaker) : null

    if (out.isRequest && out.request) return this.handleRequest(speaker, out.request, { whisper, message: said.join(' '), dangerNote })
    if (recalled && !out.reply) {
      return this.sayNaturally(speaker, `${speaker} reminded you about "${recalled.description}" — you had completely forgotten. You'll get on it.`, whisper)
    }
    if (out.reply) await agent.chat.send(out.reply, 'reply', { whisperTo: whisper && this.cfg.whisperReplies ? speaker : undefined })
  }

  /**
   * Someone asked for something: make up our mind (tasks.appraise — task-specific,
   * not a fixed obey chance), then say it like a person.
   */
  async handleRequest (speaker, rawReq, { whisper = false, message = '', dangerNote = '' } = {}) {
    const agent = this.agent
    const { tasks, personality, bot, emotions, social, log } = agent
    const decision = tasks.appraise(speaker, rawReq)
    const req = decision.req
    log.info(`Request from ${speaker}: ${req.kind} "${req.description}" (effort ${req.effort}, risk ${req.risk}) → ${decision.outcome} (chance ${decision.chance}${decision.reason ? `, ${decision.reason}` : ''})`)
    tasks.accept(speaker, decision)

    const what = `${req.description}${req.count > 1 ? ` (${req.count} ${req.item})` : ''}`
    const directive = {
      comply: "You'll do it. Agree casually — no need to repeat the details.",
      partial: `You'll only do part of it: ${decision.commitCount} of the ${req.count} ${req.item} (${decision.reason}). Say it naturally, like "i can grab you ${decision.commitCount} or so".`,
      defer: `You'll do it, but later, not now (${decision.reason}). Say so naturally.`,
      refuse: `You're NOT doing it (${decision.reason}). Turn it down the way a real person would, given your mood and how you feel about them — ${personality.refusalStyle}. Don't mention rules, settings or chances.`
    }[decision.outcome]
    const fallback = {
      comply: ['sure', 'ok', 'yeah one sec'],
      partial: ['i can get you some', 'ill grab a few'],
      defer: ['maybe later', 'after this'],
      refuse: personality.fallbackRefusals
    }[decision.outcome]

    const out = await agent.llm.chat([
      { role: 'system', content: `${personaBlock(personality, bot.username)}\n\nReply to a request in Minecraft chat: ONE short message (under 15 words), in character. No emojis, no quotes.${dangerNote ? `\n${dangerNote}` : ''}\nRespond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}` },
      {
        role: 'user',
        content: `${speaker} said: "${message || req.description}"\nWhat they want: ${what}\nHow you feel: ${emotions.describe()}\n` +
          `How you feel about ${speaker}: ${social.relationshipLine(speaker, { notes: 3 })}\nYour status: ${briefStatus(agent.perception?.latest)}\n\nYour decision: ${directive}`
      }
    ], { schema: MESSAGE_SCHEMA, priority: PRIORITY.reply, label: 'request-reply' }).catch(() => ({ message: pick(fallback) }))
    emotions.fromLabel(out.emotion, out.emotionIntensity)
    if (out.message) await agent.chat.send(out.message, 'reply', { whisperTo: whisper && this.cfg.whisperReplies ? speaker : undefined, fallback })
    return decision
  }

  /** Say something about a situation in character (used for refused commands, etc.). */
  async sayNaturally (to, situation, whisper) {
    const agent = this.agent
    const out = await agent.llm.chat([
      { role: 'system', content: `${personaBlock(agent.personality, agent.bot.username)}\n\nWrite ONE short in-character chat message (under 12 words). Respond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}` },
      { role: 'user', content: `${situation}\nHow you feel: ${agent.emotions.describe()}\nHow you feel about ${to}: ${agent.social.relationshipLine(to)}` }
    ], { schema: MESSAGE_SCHEMA, priority: PRIORITY.reply, label: 'say' }).catch(() => ({ message: pick(agent.personality.fallbackRefusals || ['nah']) }))
    if (out.message) await agent.chat.send(out.message, 'reply', { whisperTo: whisper ? to : undefined })
  }

  /** Owner/admin commands, e.g. "!mode silent". Also used by the console. */
  async handleCommand (username, text, whisper) {
    const agent = this.agent
    const { memory, config, executor, brain, bot, social, emotions } = agent
    const [rawCmd, ...rest] = text.split(/\s+/)
    const cmd = (rawCmd || 'help').toLowerCase()
    const arg = rest.join(' ')
    const reply = (msg) => {
      if (username === '@console') agent.log.info(msg)
      else agent.chat.send(msg, 'system', { whisperTo: whisper ? username : undefined })
    }
    if (!this.canUseCommand(username, cmd)) return reply(`only ${config.commands.permissions[cmd] || 'owner'}s can use ${cmd}.`)

    // Only owners have direct control. When an admin uses !come/!follow/!goal, it's a request like any other.
    const isOwner = social.role(username) === 'owner'

    switch (cmd) {
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
        agent.applySetting('chat.mode', arg)
        return reply(`chat mode set to ${arg}.`)
      case 'goal':
        if (!arg) return reply(`goal: ${memory.goal || 'none'}`)
        if (arg !== 'clear' && !isOwner) return this.handleRequest(username, { kind: 'other', description: arg, effort: 'medium', risk: 'low' }, { whisper, message: arg })
        memory.setGoal(arg === 'clear' ? '' : arg, username)
        brain.onNewGoal()
        return reply(arg === 'clear' ? 'goal cleared.' : `new goal: ${arg}`)
      case 'come':
      case 'follow': {
        if (username === '@console') return reply('the console has no position; use !goal instead.')
        if (!isOwner) return this.handleRequest(username, { kind: cmd, description: `${cmd} to ${username}`, target: username, effort: 'small', risk: 'none' }, { whisper, message: `${cmd} here` })
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
        agent.applySetting('reactions.enabled', arg !== 'off')
        return reply(`reactions ${config.reactions.enabled ? 'on' : 'off'}.`)
      case 'status': {
        const s = agent.perception?.latest
        return reply(`hp ${Math.round(bot.health)} food ${bot.food} | doing ${executor.current?.name || 'nothing'} | goal: ${memory.goal || 'none'} | feeling ${emotions.dominant().label}${s ? ` | at ${Math.floor(s.self.position.x)} ${Math.floor(s.self.position.y)} ${Math.floor(s.self.position.z)}` : ''}`)
      }

      case 'emotion': {
        // !emotion | !emotion <label> [1-10] | !emotion lock <label> [1-10] | !emotion unlock | !emotion volatility <0-3>
        const [sub, a1, a2] = rest
        if (!sub) return reply(`feeling ${emotions.describe()}${config.emotions.lock ? ' (locked)' : ''}`)
        if (sub === 'unlock') { agent.applySetting('emotions.lock', null); return reply('emotions unlocked.') }
        if (sub === 'volatility' || sub === 'decay') {
          const key = sub === 'volatility' ? 'emotions.volatility' : 'emotions.decayPerMinute'
          const r = agent.applySetting(key, a1, username)
          return reply(r.ok ? `${key} = ${r.value}` : r.error)
        }
        const lock = sub === 'lock'
        const label = (lock ? a1 : sub)?.toLowerCase()
        const intensity = clampInt(lock ? a2 : a1, 1, 10, 7)
        if (!LABEL_TO_CORE[label]) return reply(`emotions: ${Object.keys(LABEL_TO_CORE).join(', ')}`)
        if (lock) {
          agent.applySetting('emotions.lock', label)
          agent.applySetting('emotions.lockIntensity', intensity)
          return reply(`emotion locked to ${label} (${intensity}/10).`)
        }
        emotions.setTo(label, intensity)
        return reply(`now feeling ${label}.`)
      }

      case 'trust': {
        // !trust | !trust <player> | !trust <player> <0-100> | !trust <player> reset
        const [who, value] = rest
        if (!who) {
          const known = Object.values(social.players).sort((a, b) => a.trust - b.trust).slice(0, 6)
          return reply(known.length ? known.map((p) => `${p.name}:${Math.round(p.trust)}`).join(' ') : 'no one known yet.')
        }
        if (value === undefined) return reply(social.relationshipLine(who, { notes: 3 }).slice(0, 240))
        if (value === 'reset') { social.setTrust(who, config.trust.initial); return reply(`${who}'s trust reset to ${config.trust.initial}.`) }
        if (!Number.isFinite(Number(value))) return reply('usage: trust <player> <0-100|reset>')
        social.setTrust(who, Number(value))
        return reply(`${who}'s trust set to ${Math.round(social.profile(who).trust)}.`)
      }
      case 'forget':
        if (!arg) return reply('usage: forget <player>')
        social.forget(arg)
        return reply(`forgot everything about ${arg}.`)

      case 'obey': {
        // !obey | !obey <owner|admin|trusted|player> <0-1> | !obey <player> <0-1|reset> | !obey who <...> | !obey conscience on|off
        const [what, value] = rest
        const o = config.obedience
        if (!what) {
          const per = Object.entries(o.players || {}).map(([k, v]) => `${k}:${v}`).join(' ')
          return reply(`levels owner ${o.levels.owner} admin ${o.levels.admin} trusted ${o.levels.trusted} player ${o.levels.player} | who: ${o.whoCanInstruct} | conscience override: ${o.overrideConscience ? 'on' : 'off'}${per ? ` | players: ${per}` : ''}`)
        }
        if (what === 'who') { const r = agent.applySetting('obedience.whoCanInstruct', value, username); return reply(r.ok ? `requests now from: ${r.value}` : r.error) }
        if (what === 'conscience') { const r = agent.applySetting('obedience.overrideConscience', value, username); return reply(r.ok ? `conscience override ${r.value ? 'on' : 'off'}` : r.error) }
        if (['owner', 'admin', 'trusted', 'player'].includes(what)) {
          const r = agent.applySetting(`obedience.levels.${what}`, value, username)
          return reply(r.ok ? `${what} obedience = ${r.value}` : r.error)
        }
        // A specific player.
        const target = social.role(what)
        if (target !== 'player' && social.role(username) !== 'owner') return reply(`only owners can set obedience for ${target}s.`)
        if (value === 'reset') { delete o.players[what.toLowerCase()]; agent.learning.markDirty(); return reply(`${what} uses their role's level again.`) }
        const n = Number(String(value).replace('%', '')) / (String(value).endsWith('%') ? 100 : 1)
        if (!Number.isFinite(n)) return reply('usage: obey <owner|admin|trusted|player|name> <0-1>  ·  obey who <everyone|trusted|admins|owners|nobody>')
        o.players[what.toLowerCase()] = Math.min(1, Math.max(0, n))
        agent.learning.markDirty()
        return reply(`${what} obedience = ${o.players[what.toLowerCase()]}`)
      }

      case 'iq':
      case 'intelligence': {
        const level = (rest[0] || '').toLowerCase()
        const intel = agent.intelligence
        if (!level) return reply(`intelligence: ${intel.describe()}${config.intelligence.learn ? ' (learning)' : ''}. levels: ${IQ_LEVELS.join(', ')}`)
        if (level === 'learn') { const r = agent.applySetting('intelligence.learn', rest[1] ?? 'on', username); return reply(r.ok ? `learning ${r.value ? 'on' : 'off'}.` : r.error) }
        const r = agent.applySetting('intelligence.level', level, username)
        return reply(r.ok ? `intelligence set to ${IQ_LABELS[r.value]}.` : r.error)
      }

      case 'mind': {
        // !mind | !mind like <text> | !mind style <playstyle> | !mind risk <0-1> | !mind curious <0-1> | !mind add <instruction> | !mind clear
        const m = config.mind
        const [sub, ...words] = rest
        const text = words.join(' ')
        if (!sub) return reply(`thinks like: ${m.thinkLike || '(itself)'} | style: ${m.playstyle} | risk ${m.riskTolerance} | curiosity ${m.curiosity} | rules: ${m.instructions.length ? m.instructions.join('; ') : 'none'}`.slice(0, 250))
        const map = { like: 'mind.thinkLike', style: 'mind.playstyle', risk: 'mind.riskTolerance', curious: 'mind.curiosity', curiosity: 'mind.curiosity' }
        if (map[sub]) { const r = agent.applySetting(map[sub], text, username); return reply(r.ok ? `${map[sub]} = ${JSON.stringify(r.value)}` : r.error) }
        if (sub === 'add' && text) { m.instructions.push(text.slice(0, 160)); agent.settingOverrides['mind.instructions'] = m.instructions; agent.learning.markDirty(); return reply(`ok, I'll remember: ${text}`) }
        if (sub === 'clear') { m.instructions = []; agent.settingOverrides['mind.instructions'] = []; agent.learning.markDirty(); return reply('standing instructions cleared.') }
        return reply('usage: mind [like <text> | style <balanced|survivalist|builder|explorer|fighter|helper|trader|miner> | risk <0-1> | curious <0-1> | add <rule> | clear]')
      }

      case 'chests': {
        const near = agent.containers.nearest(bot.entity.position, 3)
        return reply(near.length ? near.join(' | ').slice(0, 250) : "haven't looked in any chests around here.")
      }

      case 'senses': {
        const sm = agent.senses.summary()
        return reply(`suspicion: ${sm.suspicion} | heard: ${sm.heard.slice(-3).join('; ') || 'nothing'} | noticed: ${sm.noticed.slice(-2).join('; ') || 'nothing'}`.slice(0, 250))
      }

      case 'build': {
        const plan = agent.builder.current
        if (rest[0] === 'cancel') { agent.builder.current = null; agent.learning.markDirty(); return reply(plan ? `dropped ${plan.name}.` : 'no plan.') }
        if (!plan) return reply(`no building plan. built so far: ${agent.builder.history.map((h) => h.name).join(', ') || 'nothing'}`)
        const { missing } = building.remaining(plan, bot)
        const miss = Object.entries(missing).map(([k, v]) => `${v} ${k}`).join(', ')
        return reply(`${building.describePlan(plan)}${miss ? ` missing: ${miss}` : ''}`.slice(0, 250))
      }

      case 'tasks': {
        if (rest[0] === 'clear') {
          for (const t of [...agent.tasks.tasks]) agent.tasks.forget(t, `cleared by ${username}`)
          return reply('cleared all tasks.')
        }
        const t = agent.tasks
        const a = t.active()
        const parts = []
        if (a) parts.push(`doing: ${a.description} for ${a.from}${['gather', 'craft'].includes(a.kind) ? ` (${t.progress(a)}/${a.commitCount})` : ''}`)
        const q = t.queued()
        if (q.length) parts.push(`later: ${q.map((x) => `${x.description} (${x.from})`).join(', ')}`)
        const forgot = t.history.filter((x) => x.status === 'forgotten').slice(-2)
        if (forgot.length) parts.push(`forgot: ${forgot.map((x) => `${x.description} (${x.from})`).join(', ')}`)
        return reply(parts.join(' | ').slice(0, 250) || 'not doing anything for anyone.')
      }

      case 'admin': {
        const [sub, who] = rest
        if (sub === 'add' && who) { agent.setAdmin(who, true); return reply(`${who} is now an admin.`) }
        if (sub === 'remove' && who) { agent.setAdmin(who, false); return reply(`${who} is no longer an admin.`) }
        const all = [...config.behavior.admins, ...agent.runtimeAdmins]
        return reply(`admins: ${all.join(', ') || 'none'} | usage: admin add|remove <player>`)
      }

      case 'set': {
        const [key, ...v] = rest
        if (!key) return reply(`usage: set <key> <value>. keys: ${Object.keys(SETTABLE).join(', ')}`.slice(0, 250))
        if (v[0] === 'reset') { const r = agent.resetSetting(key, username); return reply(r.ok ? `${key} reset to ${JSON.stringify(r.value)}` : r.error) }
        const r = agent.applySetting(key, v.join(' '), username)
        return reply(r.ok ? `${key} = ${JSON.stringify(r.value)}` : r.error)
      }
      case 'get': {
        if (!SETTABLE[arg]) return reply(`unknown key. keys: ${Object.keys(SETTABLE).join(', ')}`.slice(0, 250))
        return reply(`${arg} = ${JSON.stringify(getPath(config, arg))}`)
      }
      case 'settings': {
        if (rest[0] === 'reset') {
          for (const k of Object.keys(agent.settingOverrides)) agent.resetSetting(k, username)
          return reply('all in-game settings reset to config.json values.')
        }
        const o = agent.settingOverrides
        return reply(Object.keys(o).length ? `changed in game: ${Object.entries(o).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`.slice(0, 250) : 'no in-game changes; using config.json.')
      }
      case 'lessons': {
        const l = agent.learning.lessons.top(5)
        const combat = agent.learning.combat.summary(3)
        return reply([...l, ...combat].join(' | ').slice(0, 250) || 'nothing learned yet.')
      }
      case 'save':
        agent.learning.save()
        return reply('saved.')

      case 'help':
      default:
        return reply('commands: status stop pause resume come follow goal mode emotion trust obey tasks build chests senses iq mind admin set get settings persona reactions lessons forget save')
    }
  }
}

// ---------------------------------------------------------------------------
// In-game settings (!set / !emotion): what may change and how values parse
// ---------------------------------------------------------------------------

const num = (min, max) => ({ type: 'number', min, max })
const BOOL = { type: 'boolean' }
const oneOf = (...values) => ({ type: 'enum', values })

const SETTABLE = {
  'chat.mode': oneOf(...CHAT_MODES),
  'chat.respondTo': oneOf('mentions', 'everyone', 'whitelist'),
  'chat.unaddressedReplyChance': num(0, 1),
  'chat.unprompted.chance': num(0, 1),
  'chat.unprompted.intervalSeconds': num(10, 3600),
  'chat.reactionsInRespondMode': BOOL,
  'chat.goalChangeInterrupts': BOOL,
  'reactions.enabled': BOOL,
  'reactions.gestures': BOOL,
  'obedience.levels.owner': num(0, 1),
  'obedience.levels.admin': num(0, 1),
  'obedience.levels.trusted': num(0, 1),
  'obedience.levels.player': num(0, 1),
  'obedience.whoCanInstruct': oneOf('everyone', 'trusted', 'admins', 'owners', 'nobody'),
  'obedience.overrideConscience': BOOL,
  'chat.stopToType': BOOL,
  'intelligence.level': oneOf(...IQ_LEVELS),
  'intelligence.learn': BOOL,
  'intelligence.learnRate': num(0, 5),
  'intelligence.allowXray': BOOL,
  'mind.thinkLike': { type: 'string', max: 200 },
  'mind.playstyle': oneOf('balanced', 'survivalist', 'builder', 'explorer', 'fighter', 'helper', 'trader', 'miner'),
  'mind.riskTolerance': num(0, 1),
  'mind.curiosity': num(0, 1),
  'senses.realisticSight': BOOL,
  'senses.hearing': BOOL,
  'senses.particles': BOOL,
  'senses.investigate': BOOL,
  'senses.suspicionThreshold': num(0.2, 5),
  'behavior.respectPrivateChests': BOOL,
  'behavior.noGrief': BOOL,
  'busyWork.enabled': BOOL,
  'emotions.enabled': BOOL,
  'emotions.volatility': num(0, 3),
  'emotions.decayPerMinute': num(0, 1),
  'emotions.lock': { type: 'enum', values: [null, ...Object.keys(LABEL_TO_CORE)] },
  'emotions.lockIntensity': num(1, 10),
  'trust.enabled': BOOL,
  'trust.initial': num(0, 100),
  'trust.recoveryPerHour': num(0, 100),
  'trust.ignoreHostileChance': num(0, 1),
  'pvp.mode': oneOf('never', 'defensive', 'always'),
  'pvp.allowSparring': BOOL,
  'pvp.neverAttackOwners': BOOL,
  'learning.reflect': BOOL,
  'learning.epsilon': num(0, 1)
}

function getPath (obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function setPath (obj, key, value) {
  const parts = key.split('.')
  const last = parts.pop()
  const target = parts.reduce((o, k) => (o[k] = isPlainObject(o[k]) ? o[k] : {}), obj)
  target[last] = value
}

/** Parse a string from chat into a validated setting value. */
function parseSetting (key, raw) {
  const spec = SETTABLE[key]
  if (!spec) return { error: `"${key}" can't be changed in game.` }
  const v = typeof raw === 'string' ? raw.trim() : raw
  switch (spec.type) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(String(v).replace('%', '')) / (String(v).endsWith('%') ? 100 : 1)
      if (!Number.isFinite(n)) return { error: `${key} needs a number between ${spec.min} and ${spec.max}.` }
      return { value: Math.min(spec.max, Math.max(spec.min, n)) }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return { value: v }
      if (/^(on|true|yes|1)$/i.test(v)) return { value: true }
      if (/^(off|false|no|0)$/i.test(v)) return { value: false }
      return { error: `${key} needs on/off.` }
    }
    case 'string': {
      const text = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, spec.max || 200)
      return { value: /^(none|clear|off)$/i.test(text) ? '' : text }
    }
    case 'enum': {
      const val = v === null || /^(null|none|off)$/i.test(String(v)) ? null : String(v).toLowerCase()
      const match = spec.values.find((x) => (x === null ? val === null : x.toLowerCase() === val))
      if (match === undefined) return { error: `${key} must be one of: ${spec.values.filter(Boolean).join(', ')}` }
      return { value: match }
    }
  }
  return { error: 'unsupported setting' }
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
    if (!agent.chat.allows('unprompted') || !bot.entity || agent.dead || agent.dangerLevel() !== 'none') return
    if (Date.now() - memory.lastSelfChatAt < cfg.minSilenceSeconds * 1000) return
    const others = Object.keys(bot.players).filter((n) => n !== bot.username)
    if (cfg.requirePlayersOnline && others.length === 0) return
    if (cfg.requirePlayersNearby && !others.some((n) => bot.players[n]?.entity?.position.distanceTo(bot.entity.position) < 32)) return
    // Happy people chat more; sad or scared people go quiet.
    if (Math.random() > cfg.chance * agent.emotions.modifiers().talkativeness) return

    const mine = memory.chat.filter((c) => c.self).slice(-5).map((c) => `- ${c.text}`).join('\n') || '- (nothing yet)'
    const system = `${personaBlock(personality, bot.username)}

You feel like saying something in Minecraft chat on your own, unprompted — like a real player would while playing.
Good topics: ${(personality.chatTopics || []).join('; ')}. Keep it to one short, natural message (under 15 words). No emojis, no quotes.
Do not repeat or paraphrase what you said recently. If nothing natural comes to mind, return "".
Respond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}`
    const user = `Your status: ${briefStatus(agent.perception?.latest)}
How you feel: ${agent.emotions.describe()}
Recent events: ${memory.events.slice(-5).map((e) => e.text).join('; ') || 'none'}
People online:
${agent.social.peopleSummary(others.slice(0, 5)) || 'none'}
Things you said recently:
${mine}`

    const out = await agent.llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }],
      { schema: MESSAGE_SCHEMA, priority: PRIORITY.smalltalk, label: 'smalltalk', temperature: 0.9 })
    if (out.message) {
      agent.emotions.fromLabel(out.emotion, out.emotionIntensity)
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
    this.healthLog = [] // { at, h } — to know health *before* a hit
    this.seenNearbyPlayers = new Map() // username -> last time seen nearby
    this.seenHostiles = new Set()
    this.drops = new Map() // item entity id -> { player, at } (who tossed it)
    this.pendingDeathCause = null
    this.pendingKiller = null
  }

  /** Event config = global config ← personality overrides. */
  eventConfig (type) {
    const base = this.agent.config.reactions.events[type]
    const override = this.agent.personality.reactions?.[type]
    return base || override ? deepMerge(base || {}, override || {}) : null
  }

  healthBefore (bot) {
    const cutoff = Date.now() - 700
    const older = this.healthLog.filter((x) => x.at <= Date.now() - 150 && x.at >= cutoff)
    return Math.max(bot.health, ...older.map((x) => x.h), this.healthLog.length ? this.healthLog[this.healthLog.length - 1].h : bot.health)
  }

  attach (bot) {
    const agent = this.agent
    const { social, emotions, learning } = agent

    bot.once('spawn', () => {
      this.spawnedAt = Date.now()
      this.prev.level = bot.experience?.level ?? null
      // Give the player list a moment to fill in before greeting.
      setTimeout(() => this.trigger('spawn', {}), 3000)
    })

    bot.on('playerJoined', (player) => {
      if (player.username === bot.username || Date.now() - this.spawnedAt < 10000) return
      if (social.isHostile(player.username)) emotions.stimulate({ fear: 0.08, anger: 0.08 }, `${player.username} is back`)
      this.trigger('playerJoined', { player: player.username })
    })
    bot.on('playerLeft', (player) => {
      if (player.username === bot.username) return
      this.trigger('playerLeft', { player: player.username })
    })

    // Death messages ("Steve was slain by Alex") arrive as translated system chat.
    bot.on('message', (jsonMsg) => {
      const key = jsonMsg?.translate
      if (!key || !key.startsWith('death.')) return
      const victim = safe(() => jsonMsg.with?.[0]?.toString())
      const killerName = safe(() => jsonMsg.with?.[1]?.toString())
      const killer = killerName && bot.players[killerName] && killerName !== victim ? killerName : null
      const text = jsonMsg.toString()
      if (victim === bot.username) {
        this.pendingDeathCause = text
        this.pendingKiller = killer
      } else if (victim) {
        if (killer) social.onPlayerKilled(victim, killer)
        this.trigger('playerDied', { player: victim, cause: text })
      }
    })

    bot.on('death', () => {
      const cause = this.pendingDeathCause || 'unknown causes'
      const killer = this.pendingKiller
      learning.stats.deaths++
      learning.markDirty()
      agent.tasks.onDeath()
      if (killer) {
        social.onKilledBy(killer)
        this.trigger('killedByPlayer', { player: killer, cause })
      } else {
        emotions.stimulate({ sadness: 0.35, fear: 0.15 }, 'you died')
        // Environmental deaths teach the pathfinder to avoid that spot.
        if (/lava|fell|fall|drown|burn|fire|suffocat|void|magma|cactus|berry|blew up|explod|withered|froze/i.test(cause) && bot.entity) {
          learning.movement.addDanger(bot.entity.position, cause.replace(bot.username, 'you'), 3)
        }
        this.trigger('death', { cause })
      }
      learning.reflect(`You died: "${cause}". Just before: ${agent.memory.events.slice(-4).map((e) => e.text).join('; ')}`)
      agent.intelligence.addXp('survival', 2)
      agent.learnFacts(`${cause} ${agent.memory.events.slice(-3).map((e) => e.text).join(' ')}`, 'dying', 0.6)
      this.pendingDeathCause = null
      this.pendingKiller = null
    })

    // On 1.20+ the server tells us who caused the damage; older versions: guess from arm swings.
    bot.on('entityHurt', (entity, source) => {
      if (!entity) return
      if (entity === bot.entity) return this.onSelfHurt(bot, source)
      const attacker = source?.type === 'player' ? source : source ? null : this.guessAttackerOf(bot, entity)
      if (attacker) social.onEntityHarmed(entity, attacker)
    })
    bot.on('entitySwingArm', (entity) => social.onSwing(entity))
    bot.on('entityUncrouch', (entity) => social.onCrouch(entity))

    // Remember who tossed each dropped item, so picking it up counts as a gift from them.
    bot.on('entitySpawn', (entity) => {
      if (entity.name !== 'item') return
      const thrower = Object.values(bot.players)
        .map((p) => p.entity)
        .find((e) => e && e !== bot.entity && e.position.offset(0, 1.3, 0).distanceTo(entity.position) < 1.6)
      if (thrower) this.drops.set(entity.id, { player: thrower.username, at: Date.now() })
      if (this.drops.size > 200) for (const [id, d] of this.drops) if (Date.now() - d.at > 60000) this.drops.delete(id)
    })
    bot.on('playerCollect', (collector, collected) => {
      if (collector !== bot.entity) return
      const item = safe(() => collected.getDroppedItem?.())
      if (!item) return
      const from = this.drops.get(collected.id)
      this.drops.delete(collected.id)
      if (from && Date.now() - from.at < 60000) social.onGift(from.player, item.name, item.count)
      this.trigger('itemPickup', { item: item.name })
    })

    bot.on('health', () => {
      this.healthLog.push({ at: Date.now(), h: bot.health })
      if (this.healthLog.length > 20) this.healthLog.shift()
      const low = this.eventConfig('lowHealth')?.threshold ?? 8
      const hungry = this.eventConfig('hungry')?.threshold ?? 6
      if (bot.health > 0 && bot.health <= low && this.prev.health > low) {
        emotions.stimulate({ fear: 0.25 }, 'your health is low')
        this.trigger('lowHealth', { health: Math.round(bot.health) })
      }
      if (bot.food <= hungry && this.prev.food > hungry) {
        emotions.stimulate({ anger: 0.05, sadness: 0.05 }, "you're hungry")
        this.trigger('hungry', { food: bot.food })
      }
      this.prev.health = bot.health
      this.prev.food = bot.food
    })

    bot.on('time', () => {
      const phase = timePhase(bot.time.timeOfDay)
      if (this.prev.phase && phase !== this.prev.phase) {
        if (phase === 'night') { emotions.stimulate({ fear: 0.08 }, 'night is falling'); this.trigger('nightfall', {}) }
        if (phase === 'dawn') { emotions.stimulate({ joy: 0.06, fear: -0.1 }); this.trigger('daybreak', {}) }
      }
      this.prev.phase = phase
    })

    bot.on('rain', () => {
      if (bot.isRaining && !this.prev.raining) { emotions.stimulate({ sadness: 0.03 }); this.trigger('rainStart', {}) }
      this.prev.raining = bot.isRaining
    })

    bot.on('experience', () => {
      const level = bot.experience?.level
      if (this.prev.level !== null && level > this.prev.level) { emotions.stimulate({ joy: 0.15 }, `you reached level ${level}`); this.trigger('levelUp', { level }) }
      this.prev.level = level
    })
  }

  onSelfHurt (bot, source) {
    const agent = this.agent
    const { social, emotions, learning } = agent
    agent.lastHurtAt = Date.now()
    const before = this.healthBefore(bot)
    const attacker = source?.type === 'player' ? source : source ? null : social.guessAttacker(bot)

    if (attacker) {
      agent.lastAttacker = { name: attacker.username, id: attacker.id, at: Date.now() }
      social.onHurtBy(attacker, { botHealthBefore: before })
    } else {
      const mob = source || Object.values(bot.entities)
        .filter((e) => e !== bot.entity && e.kind === 'Hostile mobs' && e.position.distanceTo(bot.entity.position) < 6)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (mob) {
        emotions.stimulate({ fear: 0.1, anger: 0.05 }, `a ${mob.name} is attacking you`)
      } else if (agent.recentFallSpeed < -0.6) {
        // Fell while moving: probably bad parkour. Enough of these and parkour gets switched off for a while.
        if (learning.movement.recordFall()) agent.memory.addEvent('learning', 'You keep hurting yourself jumping around, so you stop doing risky parkour jumps for a while.')
      }
      this.trigger('hurt', { attacker: mob ? mob.name : 'something', health: Math.round(bot.health) })
    }
    agent.brain?.onDamage()
  }

  /** Pre-1.20: a player who just swung their arm right next to the victim. */
  guessAttackerOf (bot, victim) {
    return Object.values(bot.players)
      .map((p) => p.entity)
      .find((e) => e && e !== bot.entity && e !== victim && e.position.distanceTo(victim.position) < 4.5 &&
        Date.now() - this.agent.social.t(e.username).swingAt < 600) || null
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
      case 'killedByPlayer': return `${d.player} killed you (${d.cause}). You respawned and lost your items.`
      case 'hurt': return `You took damage from ${d.attacker} (health ${d.health}/20).`
      case 'attackedByPlayer': return `${d.player} hit you with ${d.item === 'fist' ? 'their fist' : `a ${d.item}`}${d.streak > 1 ? ` (${d.streak} hits in a row)` : ''}. Your trust in them: ${d.trust}/100.`
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
      case 'gift': return `${d.player} gave you ${d.count} ${d.item}.`
      case 'promiseKept': return `${d.player} kept their promise: ${d.promise}.`
      case 'promiseBroken': return `${d.player} broke their promise: ${d.promise}.`
      case 'harmNearby': return `${d.player} attacked ${d.victim} right next to you.`
      case 'crouchGreeting': return `${d.player} crouch-greeted you (a friendly hello).`
      case 'wonFight': return `You won a fight against ${d.label}.`
      case 'lostFight': return `You had to back off from a fight with ${d.label}.`
      case 'taskDone': return `You finished what ${d.player} asked: ${d.task}.`
      case 'buildDone': return `You finished building ${d.name}.`
      case 'taskPartial': return `You only partly did what ${d.player} asked (${d.task}): ${d.done} of ${d.count}${d.reason ? ` — ${d.reason}` : ''}.`
      case 'taskAbandoned': return `You gave up on what ${d.player} asked (${d.task})${d.reason ? ` — ${d.reason}` : ''}.`
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
    if (!bot?.entity && type !== 'death' && type !== 'killedByPlayer') return
    const text = this.describe(type, data)
    // Remember the event so the decision loop can take it into account (trust changes are logged by social.js).
    if (!REMEMBERED_BY_SOCIAL.has(type)) memory.addEvent(type, text)
    log.debug(`event ${type}: ${text}`)

    const cfg = this.eventConfig(type)
    if (!config.reactions.enabled || !cfg || !cfg.enabled) return

    const now = Date.now()
    const key = cfg.perTarget && data.player ? `${type}:${data.player}` : type
    if (now - (this.cooldowns.get(key) || 0) < (cfg.cooldownSec || 0) * 1000) return
    // Spawn greetings and task hand-overs ("here you go") always get through the global cooldown.
    if (!ALWAYS_REACT.has(type) && now - this.lastReactionAt < config.reactions.globalCooldownSec * 1000) return
    if (Math.random() > (cfg.chance ?? 1)) return
    this.cooldowns.set(key, now)
    this.lastReactionAt = now

    this.react(type, cfg, data, text).catch((err) => log.debug(`reaction ${type} failed: ${err.message}`))
  }

  async react (type, cfg, data, text) {
    const agent = this.agent
    const { bot, config, executor, personality, social, emotions } = agent
    const wary = data.player && social.profile(data.player).trust < config.trust.waryBelow

    // Body language first — only when idle so we don't fight the current action for control.
    // Nobody waves at someone who just stabbed them.
    const friendlyGesture = ['wave', 'crouch', 'nod', 'jump', 'spin'].includes(cfg.gesture)
    if (cfg.gesture && config.reactions.gestures && !executor.busy && !agent.dead && !(wary && friendlyGesture)) {
      const target = data.player ? bot.players[data.player]?.entity : data.entityId ? bot.entities[data.entityId] : null
      if (target) await bot.lookAt(target.position.offset(0, target.height ?? 1.6, 0)).catch(() => {})
      await performGesture(bot, cfg.gesture).catch(() => {})
    }

    const style = cfg.style || 'template'
    const templates = (wary && cfg.templatesWary?.length) ? cfg.templatesWary : cfg.templates
    if (style === 'gesture' || style === 'silent' || !agent.chat.allows('reaction')) {
      // gesture-style events may still have a line of chat as a fallback when idle
      if (style === 'gesture' && templates?.length && agent.chat.allows('reaction') && Math.random() < 0.3 && !wary) {
        await agent.chat.send(this.fill(pick(templates), data), 'reaction')
      }
      return
    }

    let message = null
    if (style === 'llm') {
      try {
        const system = `${personaBlock(personality, bot.username)}

Something just happened in the game. React the way your character genuinely would, with ONE very short chat message (under 12 words) — or "" if you'd honestly just stay quiet. No emojis, no quotes.
Respond with ONLY JSON: {"message": "...", "emotion": "<${EMOTIONS.join('|')}>", "emotionIntensity": 1-10}`
        const about = data.player ? `\nHow you feel about ${data.player}: ${social.relationshipLine(data.player, { notes: 3 })}` : ''
        const out = await agent.llm.chat([
          { role: 'system', content: system },
          { role: 'user', content: `Event: ${text}\nHow you feel: ${emotions.describe()}${about}\nYour status: ${briefStatus(agent.perception?.latest)}` }
        ], { schema: MESSAGE_SCHEMA, priority: PRIORITY.reaction, label: `reaction:${type}`, temperature: 0.9 })
        emotions.fromLabel(out.emotion, out.emotionIntensity)
        message = out.message
      } catch (err) {
        agent.log.debug(`LLM reaction failed, using template: ${err.message}`)
      }
    }
    if (message === null && templates?.length) message = this.fill(pick(templates), data)
    if (message) await agent.chat.send(message, 'reaction')
  }
}

// These already write a (more detailed) memory event through social.js.
const ALWAYS_REACT = new Set(['spawn', 'taskDone', 'taskPartial', 'taskAbandoned', 'buildDone'])
const REMEMBERED_BY_SOCIAL = new Set(['attackedByPlayer', 'gift', 'promiseKept', 'promiseBroken', 'harmNearby', 'taskDone', 'taskPartial', 'taskAbandoned', 'buildDone'])

// ===========================================================================
// Brain — the throttled perceive → decide → act loop
// ===========================================================================

/** Which skill domain each action trains. */
const ACTION_DOMAINS = {
  attackTarget: 'combat', retreat: 'combat', mineBlock: 'survival', craftItem: 'survival', smeltItem: 'survival', eatFood: 'survival',
  fish: 'survival', sleepInBed: 'survival', parkour: 'survival', explore: 'survival', moveToBlock: 'survival', planBuilding: 'building',
  build: 'building', placeBlock: 'building', knowledge: 'knowledge', readSigns: 'senses', inspectContainer: 'senses', useItem: 'survival'
}

const MOVEMENT_ACTIONS = new Set(['moveToBlock', 'moveToPlayer', 'explore', 'mineBlock', 'collectDrops', 'followPlayer', 'retreat'])

const WEAPON_POWER = { wooden: 4, golden: 4, stone: 5, iron: 6, diamond: 7, netherite: 8 }
function weaponPower (name) {
  if (!name) return 1
  if (name === 'mace' || name === 'trident') return 8
  const m = name.match(/^(\w+?)_(sword|axe)$/)
  return m ? (WEAPON_POWER[m[1]] || 4) : 1
}
const ARMOR_TIER = { leather: 1, golden: 2, chainmail: 2, turtle: 2, iron: 3, diamond: 4, netherite: 5 }
function armorTier (name) {
  const m = name && name.match(/^(\w+?)_(helmet|chestplate|leggings|boots)$/)
  return m ? (ARMOR_TIER[m[1]] || 1) : 0
}

function wordOverlap (a, b) {
  const A = new Set(String(a).toLowerCase().match(/[a-z]+/g) || [])
  const B = new Set(String(b).toLowerCase().match(/[a-z]+/g) || [])
  if (!A.size || !B.size) return 0
  let n = 0
  for (const w of A) if (B.has(w)) n++
  return n / Math.min(A.size, B.size)
}

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
        if (this.paused || !agent.bot?.entity || agent.dead || agent.bot.isSleeping) { await this.idle(1000); continue }

        let decision = this.forced.shift() || this.reflex() || agent.tasks.nextForcedAction()
        if (!decision) {
          // Throttle: never ask the LLM more often than minLlmIntervalMs.
          const wait = this.lastLlmAt + config.loop.minLlmIntervalMs - Date.now()
          if (wait > 0) await this.idle(wait)
          if (!this.running || this.paused || agent.dead) continue
          if (this.forced.length) continue // a command arrived while we waited
          this.lastLlmAt = Date.now()
          decision = await this.thinkWhileBusy()
        }

        const { name, args } = decision.action
        log.info(`▶ ${name}(${JSON.stringify(args)})${decision.source !== 'llm' ? ` [${decision.source}]` : ''}`)
        const result = await agent.executor.execute(name, args)
        agent.memory.addAction(decision, result)
        if (result.ok) log.info(`✔ ${name}: ${result.message} (${(result.durationMs / 1000).toFixed(1)}s)`)
        else log.warn(`✘ ${name} [${result.code}]: ${result.message}`)
        if (!result.ok && decision.source === 'reflex') this.reflexCooldowns.set(decision.reflexKey, Date.now())
        this.learnFrom(name, result)
        agent.tasks.onActionResult(name, args, result)

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
   * Ask the LLM, and meanwhile do something small and useful — like a player
   * who keeps playing while deciding what to do next. The busy work is
   * interrupted the moment the decision arrives.
   */
  async thinkWhileBusy () {
    const agent = this.agent
    const busy = agent.config.busyWork.enabled ? this.pickBusyWork() : null
    const work = busy ? agent.executor.execute(busy.name, busy.args) : null
    try {
      return await this.decide()
    } finally {
      if (work) {
        agent.executor.abort('done thinking', { quiet: true })
        const r = await work.catch(() => null)
        if (r?.ok && busy.name !== 'wait' && busy.name !== 'parkour') {
          agent.memory.addEvent('busy', `While thinking, you ${busy.label}: ${r.message}`)
          agent.log.debug(`busy work ${busy.name}: ${r.message}`)
        }
        if (r) agent.tasks.onActionResult(busy.name, busy.args, r)
      }
    }
  }

  /** Something small, safe and interruptible to do right now. */
  pickBusyWork () {
    const agent = this.agent
    const { bot, memory, personality, tasks } = agent
    if (!bot.entity || bot.isSleeping || agent.dead || agent.dangerLevel() !== 'none') return null
    const state = agent.perception?.latest
    const options = []
    const add = (w, name, args, label) => options.push({ w, name, args, label })
    const me = bot.entity.position

    if (Object.values(bot.entities).some((e) => e.name === 'item' && e.position.distanceTo(me) < 6)) add(3, 'collectDrops', { radius: 6 }, 'picked up items lying around')
    const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
    const chest = bot.findBlocks({ matching: ids, maxDistance: 12, count: 6 }).find((p) => !agent.containers.seenRecently(p))
    if (chest) add(2.5, 'inspectContainer', { x: chest.x, y: chest.y, z: chest.z }, 'checked a chest')
    const t = tasks.active()
    if (t && ['gather', 'craft'].includes(t.kind) && t.item && state?.nearbyBlocks) {
      const near = Object.entries(state.nearbyBlocks).find(([n, b]) => (n === t.item || n.includes(t.item)) && b.distance <= 8)
      if (near) add(4, 'mineBlock', { blockType: near[0], count: 2, maxDistance: 8 }, `grabbed some ${near[0]} for ${t.from}`)
    }
    if (agent.config.server.platform === 'bedrock') return options.filter((o) => o.name === 'collectDrops')[0] || { w: 1, name: 'parkour', args: { seconds: 6 }, label: 'hopped around' }
    if (state?.nearbyBlocks) {
      const ore = Object.entries(state.nearbyBlocks).find(([n, b]) => /_ore$/.test(n) && b.distance <= 6 && b.visible)
      if (ore) add(2, 'mineBlock', { blockType: ore[0], count: 1, maxDistance: 6 }, `mined a bit of ${ore[0]}`)
    }
    add(0.6 + (personality.restlessness ?? 0.5) * 2, 'parkour', { seconds: 8 }, 'hopped around')
    add(1, 'wait', { seconds: 6 }, 'looked around')

    let r = Math.random() * options.reduce((a, o) => a + o.w, 0)
    for (const o of options) { r -= o.w; if (r <= 0) return o }
    return options[options.length - 1]
  }

  /** Feelings and movement lessons from every action result. */
  learnFrom (name, result) {
    const { emotions, learning, memory, bot, intelligence } = this.agent
    if (MOVEMENT_ACTIONS.has(name)) learning.movement.recordResult(result, bot.entity?.position)
    // Practice makes better (with diminishing returns — see intelligence.js).
    const domain = ACTION_DOMAINS[name]
    if (domain && result.code !== 'ABORTED') intelligence.addXp(domain, result.ok ? 0.4 : 0.15)
    if (name === 'craftItem' && result.ok && result.args?.itemName) this.agent.learnedItems.add(String(result.args.itemName).toLowerCase())
    if (name === 'wait') emotions.stimulate({ boredom: 0.05 })
    else if (result.ok) emotions.stimulate({ joy: 0.03, boredom: -0.06 })
    else if (result.code !== 'ABORTED') emotions.stimulate({ anger: 0.04, boredom: -0.03 }, result.code === 'BUSY' ? null : 'things keep going wrong')
    if (!result.ok && memory.failureStreak() === 3) {
      const last = memory.actions.slice(-3).map((a) => `${a.action}(${JSON.stringify(a.args)}) → ${a.code}: ${a.message}`).join('; ')
      learning.reflect(`Three actions in a row failed: ${last}`)
    }
  }

  /** Weapon + armor comparison, personality, mood and health → 'fight' or 'flee'. */
  fightOrFlight (attacker) {
    const { bot, personality, emotions, config, social, learning } = this.agent
    const name = attacker.username
    if (config.pvp.mode === 'never' || (config.pvp.neverAttackOwners && social.role(name) === 'owner')) return 'flee'
    const myWeapon = Math.max(1, ...bot.inventory.items().map((i) => weaponPower(i.name)))
    const myArmor = ['head', 'torso', 'legs', 'feet'].reduce((a, d) => a + armorTier(safe(() => bot.inventory.slots[bot.getEquipmentDestSlot(d)]?.name)), 0)
    const theirWeapon = weaponPower(attacker.heldItem?.name)
    const theirArmor = (attacker.equipment || []).reduce((a, i) => a + armorTier(i?.name), 0)
    let score = (personality.fightOrFlight ?? 0.5) +
      emotions.modifiers().aggression * 0.4 +
      (bot.health - 10) / 20 +
      ((myWeapon + myArmor / 2) - (theirWeapon + theirArmor / 2)) / 12
    const record = learning.combat.recordFor(`player:${name}`)
    if (record && record.losses > record.wins) score -= 0.15
    return score >= 0.5 ? 'fight' : 'flee'
  }

  /**
   * Instinctive, LLM-free behaviours: fight back, flee, eat.
   * Cheap, instant, and they save LLM calls for interesting decisions.
   * @param {boolean} dryRun only report whether a reflex applies
   */
  reflex (dryRun = false) {
    const { bot, config } = this.agent
    const b = config.behavior
    if (!bot.entity || bot.isSleeping) return null
    const ready = (key, ms = 30000) => Date.now() - (this.reflexCooldowns.get(key) || 0) > ms
    const me = bot.entity.position
    const hostiles = Object.values(bot.entities)
      .filter((e) => e.kind === 'Hostile mobs' && e.isValid && e.position.distanceTo(me) < 10)
      .sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
    const nearest = hostiles[0]
    const dist = nearest ? nearest.position.distanceTo(me) : Infinity
    const recentlyHurt = Date.now() - (this.agent.lastHurtAt || 0) < 5000
    const make = (reflexKey, thought, emotion, action) => dryRun ? true : { source: 'reflex', reflexKey, thought, emotion, action }
    const social = this.agent.social

    // A creeper hissing right next to us — even if we can't see it.
    const ca = this.agent.creeperAlert
    if (ca && Date.now() - ca.at < 2500 && ready('creeper', 3000)) {
      const creeper = (ca.id && bot.entities[ca.id]) || Object.values(bot.entities).find((e) => e.name === 'creeper' && e.position.distanceTo(ca.pos) < 4)
      if (creeper) return make('creeper', 'I hear a creeper hissing — get away!', 'scared', { name: 'retreat', args: { entityId: creeper.id, distance: 10 } })
    }

    // Someone is attacking a player we promised to protect.
    const pa = this.agent.protectAlert
    if (pa && Date.now() - pa.at < 8000 && ready(`protect:${pa.attacker}`, 6000)) {
      const attacker = bot.entities[pa.id]
      if (attacker?.isValid && attacker.position.distanceTo(me) < 16 && this.fightOrFlight(attacker) === 'fight') {
        return make(`protect:${pa.attacker}`, `${pa.attacker} is attacking ${pa.victim}, and I said I'd protect them.`, 'angry', { name: 'attackTarget', args: { entityId: attacker.id, maxSeconds: 30 } })
      }
    }

    // A player is attacking us for real (not a single friendly punch): fight back or get away.
    const la = this.agent.lastAttacker
    if (la && Date.now() - la.at < 4000) {
      const attacker = bot.entities[la.id]
      const serious = social.isHostile(la.name) || social.t(la.name).hits.length >= 2
      if (attacker?.isValid && attacker.position.distanceTo(me) < 8 && serious && ready(`pvp:${la.name}`, 4000)) {
        if (this.fightOrFlight(attacker) === 'fight') {
          return make(`pvp:${la.name}`, `${la.name} keeps attacking me — fighting back.`, 'angry', { name: 'attackTarget', args: { entityId: attacker.id, maxSeconds: 30 } })
        }
        return make(`pvp:${la.name}`, `${la.name} is attacking me and I can't win this — getting out of here.`, 'scared', { name: 'retreat', args: { entityId: attacker.id, distance: 20 } })
      }
    }
    // Someone who's hurt us before is closing in with a weapon out: keep our distance unless we're confident.
    const threat = Object.values(bot.players).map((p) => p.entity).find((e) => e && e !== bot.entity &&
      e.position.distanceTo(me) < 5 && social.isHostile(e.username) && e.heldItem && WEAPON.test(e.heldItem.name))
    if (threat && ready('keepAway', 15000) && this.fightOrFlight(threat) === 'flee') {
      return make('keepAway', `${threat.username} is coming at me armed. Not sticking around.`, 'nervous', { name: 'retreat', args: { entityId: threat.id, distance: 14 } })
    }

    if (nearest && (bot.health <= b.fleeHealthBelow || (nearest.name === 'creeper' && dist < 5)) && ready('flee', 5000)) {
      return make('flee', `Too dangerous — getting away from the ${nearest.name}.`, 'scared', { name: 'retreat', args: { entityId: nearest.id, distance: 16 } })
    }
    // Neutral mobs are only fought back against, never engaged just for being close.
    const provoked = recentlyHurt && dist < 5
    const tooClose = dist < 2.5 && !NEUTRAL_MOBS.has(nearest?.name)
    if (b.selfDefense && nearest && nearest.name !== 'creeper' && (provoked || tooClose) && ready('defend', 5000)) {
      return make('defend', `A ${nearest.name} is attacking me, fighting back!`, 'determined', { name: 'attackTarget', args: { entityId: nearest.id, maxSeconds: 15 } })
    }
    // Something odd we heard or saw with nobody around: go have a careful look.
    const inv = this.agent.investigation
    if (inv && !inv.done && config.senses.investigate && Date.now() - inv.at < 60000 && !nearest && ready('investigate', 30000) &&
      !this.agent.tasks.active() && Math.random() < 0.5 + config.mind.curiosity * 0.5) {
      inv.done = true
      this.agent.emotions.stimulate({ fear: 0.05 })
      return make('investigate', `Heard ${inv.reason}. Going to check it out carefully.`, 'nervous', { name: 'moveToBlock', args: { x: inv.pos.x, y: inv.pos.y, z: inv.pos.z, range: 3 } })
    }

    if (b.autoEat && bot.food <= b.autoEatBelow && dist > 6 && ready('eat')) {
      const foods = bot.registry.foodsByName
      const hasFood = bot.inventory.items().some((i) => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name))
      if (hasFood) return make('eat', 'Getting hungry, time for a snack.', this.agent.emotions.dominant().label, { name: 'eatFood', args: {} })
    }
    return null
  }

  async decide () {
    const agent = this.agent
    const { log, memory, executor, config, social, learning, emotions } = agent

    // Requests we promised to do "later" become the goal once our own plans allow it.
    const state = agent.perception.snapshot()
    const tools = executor.availableTools()
    const learned = [...learning.lessons.top(8), ...learning.combat.summary(4)]
    const knowhow = knowledge.relevantFacts([
      memory.goal, state.status.task?.what, state.status.building, Object.keys(state.inventory.items).join(' '),
      Object.keys(state.nearbyBlocks).join(' '), state.nearbyEntities.map((e) => e.name).join(' '), state.world.phase, state.self.dimension,
      state.senses.heard.join(' ')
    ].filter(Boolean).join(' '), 4, agent.knowledgeOpts())

    const nudges = []
    const streak = memory.failureStreak()
    if (streak >= 2) nudges.push(`Your last ${streak} actions failed. Change your approach (different action, target or location).`)
    if (!memory.goal) nudges.push('You have no current goal: pick a sensible one based on your ambitions and situation.')

    const messages = [
      { role: 'system', content: buildDecisionPrompt(agent, executor.describeTools()) },
      {
        role: 'user',
        content: `Current state:\n${JSON.stringify(state)}\n\n` +
          `People you know (online):\n${social.peopleSummary(state.onlinePlayers.slice(0, 6)) || '- nobody else is online'}\n\n` +
          `What you've learned from experience:\n${learned.map((l) => `- ${l}`).join('\n') || '- nothing yet'}\n\n` +
          `Minecraft know-how that might matter now:\n${knowhow.map((l) => `- ${l}`).join('\n') || '- (nothing in particular)'}\n\n` +
          `${nudges.join('\n')}\nChoose your next action.`
      }
    ]
    const out = await agent.llm.chat(messages, { schema: decisionSchema(tools), priority: PRIORITY.decision, label: 'decision', temperature: config.mind.decisionTemperature ?? undefined })

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
      // Rewording a player's task keeps them as its source; a genuinely new goal is our own.
      const playerGoal = memory.goalSource && !['self', 'config'].includes(memory.goalSource)
      const sameTask = playerGoal && wordOverlap(out.goal, memory.goal) >= 0.3
      memory.setGoal(out.goal.trim(), sameTask ? memory.goalSource : 'self')
    }
    emotions.fromLabel(decision.emotion, decision.emotionIntensity)
    agent.tasks.onLlmUpdate(out.taskUpdate)
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
    this.baseConfig = JSON.parse(JSON.stringify(config)) // config.json values, for "!set <key> reset"
    this.log = log
    this.personality = loadPersonality(config.personality, log)
    this.memory = new Memory(config)
    this.llm = new OllamaClient(config, log)
    this.bot = null
    this.dead = false
    this.shuttingDown = false
    this.reconnectAttempts = 0
    this.intervals = []
    this.recentFallSpeed = 0
    this.lastAttacker = null

    // Long-term state survives restarts and reconnects.
    this.emotions = new EmotionEngine(() => this.config.emotions, () => this.personality)
    this.learning = new Learning(this)
    const saved = this.learning.data
    this.social = new SocialModel(this, saved.social)
    this.tasks = new TaskManager(this, saved.tasks)
    this.intelligence = new Intelligence(() => this.config.intelligence, saved.intelligence)
    this.senses = new Senses(this)
    // Chests remembered by older versions carry over.
    const legacy = !saved.chests && Array.isArray(saved.containers)
      ? { records: Object.fromEntries(saved.containers.map((c) => [`${c.x},${c.y},${c.z}`, { ...c, lastSeen: c.seenAt, openers: {}, history: [] }])) }
      : saved.chests
    this.containers = new ContainerIntel(this, legacy)
    this.knownFacts = new Set(saved.knownFacts || []) // facts above its level it has learned
    this.learnedItems = new Set(saved.learnedItems || []) // recipes it worked out itself
    this.builder = { current: saved.building?.current || null, history: saved.building?.history || [], owner: config.server.username }
    if (saved.obeyPlayers) this.config.obedience.players = { ...saved.obeyPlayers, ...this.config.obedience.players }
    this.emotions.load(saved.emotions)
    this.runtimeAdmins = saved.admins || []
    this.settingOverrides = {}
    for (const [key, value] of Object.entries(saved.settings || {})) {
      if (key === 'mind.instructions' && Array.isArray(value)) { this.config.mind.instructions = value; this.settingOverrides[key] = value; continue }
      const parsed = parseSetting(key, value)
      if (parsed.error) continue
      setPath(this.config, key, parsed.value)
      this.settingOverrides[key] = parsed.value
    }
    if (Object.keys(this.settingOverrides).length) log.info(`In-game settings restored: ${Object.keys(this.settingOverrides).join(', ')}`)
  }

  /** What the bot knows right now (for knowledge lookups and prompts). */
  knowledgeOpts () {
    return { tier: this.intelligence.knowledgeTier(), known: this.knownFacts, learnedItems: this.learnedItems }
  }

  /**
   * Learn from experience or from being told: facts above its level can stick.
   * @param {string} text what happened / what someone said
   * @param {string} from where it came from (for the memory note)
   */
  learnFacts (text, from, chance = 0.4) {
    if (!this.config.intelligence.learn) return
    for (const f of knowledge.learnFrom(text, this.knowledgeOpts(), chance)) {
      this.knownFacts.add(f.keys)
      this.intelligence.addXp('knowledge', 2)
      this.memory.addEvent('learned', `You learned something${from ? ` (from ${from})` : ''}: ${f.text}`)
      this.log.info(`Learned a fact${from ? ` from ${from}` : ''}: ${f.text.slice(0, 80)}...`)
      this.learning.markDirty()
    }
  }

  /**
   * How much danger the bot is in right now — drives how it types and whether it fidgets.
   * @returns {{ level: 'none'|'medium'|'high', reason: string }}
   */
  dangerInfo () {
    const bot = this.bot
    if (!bot?.entity || this.dead) return { level: 'none', reason: '' }
    const me = bot.entity.position
    const current = this.executor?.current?.name
    if (current === 'attackTarget' || current === 'retreat') return { level: 'high', reason: current === 'retreat' ? 'running away from something' : 'in the middle of a fight' }
    if (bot.health <= 6) return { level: 'high', reason: `almost dead (${Math.round(bot.health)}/20 health)` }
    if (Date.now() - (this.lastHurtAt || 0) < 3000) return { level: 'high', reason: 'just got hit' }
    const feet = bot.blockAt(me)
    if (feet && /lava|fire/.test(feet.name)) return { level: 'high', reason: 'burning' }
    let medium = null
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue
      const d = e.position.distanceTo(me)
      const hostile = e.kind === 'Hostile mobs' || (e.type === 'player' && this.social.isHostile(e.username))
      if (!hostile) continue
      if (d < 6) return { level: 'high', reason: `a ${e.username || e.name} is right next to you` }
      if (d < 14) medium = `a ${e.username || e.name} is nearby`
    }
    if (medium || bot.health <= 10) return { level: 'medium', reason: medium || 'low on health' }
    return { level: 'none', reason: '' }
  }

  dangerLevel () { return this.dangerInfo().level }

  /** Change a runtime setting (from !set, !emotion...). Persists across restarts. */
  applySetting (key, raw, by) {
    if (!SETTABLE[key]) return { ok: false, error: `"${key}" can't be changed in game.` }
    if (by && this.social.role(by) !== 'owner' && this.config.commands.ownerOnlySettings.some((p) => key.startsWith(p))) {
      return { ok: false, error: `only owners can change ${key}.` }
    }
    const parsed = parseSetting(key, raw)
    if (parsed.error) return { ok: false, error: parsed.error }
    setPath(this.config, key, parsed.value)
    this.settingOverrides[key] = parsed.value
    this.learning.markDirty()
    this.log.info(`Setting ${key} = ${JSON.stringify(parsed.value)}${by ? ` (by ${by})` : ''}`)
    if (key.startsWith('intelligence.')) this.refreshMovements()
    return { ok: true, value: parsed.value }
  }

  resetSetting (key, by) {
    if (!SETTABLE[key]) return { ok: false, error: `"${key}" can't be changed in game.` }
    if (by && this.social.role(by) !== 'owner' && this.config.commands.ownerOnlySettings.some((p) => key.startsWith(p))) {
      return { ok: false, error: `only owners can change ${key}.` }
    }
    const value = getPath(this.baseConfig, key)
    setPath(this.config, key, value)
    delete this.settingOverrides[key]
    this.learning.markDirty()
    return { ok: true, value }
  }

  setAdmin (name, on) {
    const lower = name.toLowerCase()
    this.runtimeAdmins = this.runtimeAdmins.filter((a) => a.toLowerCase() !== lower)
    if (on) this.runtimeAdmins.push(name)
    this.learning.markDirty()
  }

  setPersonality (spec) {
    this.personality = loadPersonality(spec, this.log)
    this.config.personality = spec
    this.emotions.reset()
    this.log.info(`Personality: ${this.personality.name || '(username)'} — ${this.personality.description}`)
  }

  async start () {
    this.log.info(`Personality: ${this.personality.name || '(username)'} — ${this.personality.description}`)
    this.log.info(`Chat mode: ${this.config.chat.mode} | pvp: ${this.config.pvp.mode}`)
    await this.llm.healthCheck()
    await this.connect()
  }

  /**
   * Pick the protocol version. Auto-detect normally; if the server is newer than
   * Mineflayer supports (e.g. 26.3 while Mineflayer tops out at 26.1), connect as
   * the newest supported version and rely on ViaBackwards / ViaProxy to translate.
   */
  async resolveVersion () {
    const s = this.config.server
    if (s.version) return s.version
    const latest = mineflayer.latestSupportedVersion
    try {
      const res = await mc.ping({ host: s.host, port: s.port, closeTimeout: 5000, noPongTimeout: 5000 })
      const protocol = res?.version?.protocol
      const latestProtocol = minecraftData.versionsByMinecraftVersion.pc[latest]?.version
      if (protocol && latestProtocol && protocol > latestProtocol) {
        this.log.warn(`Server runs "${res.version.name}" (protocol ${protocol}); Mineflayer supports up to ${latest} (protocol ${latestProtocol}).`)
        if (s.viaFallback) {
          this.log.warn(`Connecting as ${latest}. This works when the server has ViaVersion + ViaBackwards installed, or when you connect through ViaProxy (see README).`)
          return latest
        }
      }
    } catch (err) {
      this.log.debug(`Server ping failed (${err.message}); letting Mineflayer auto-detect.`)
    }
    return false
  }

  async connect () {
    const s = this.config.server
    const version = await this.resolveVersion()
    this.log.info(`Connecting to ${s.host}:${s.port} as ${s.username}${version ? ` (protocol ${version})` : ''}...`)
    const options = {
      host: s.host,
      port: s.port,
      username: s.username,
      auth: s.auth,
      version,
      checkTimeoutInterval: 60000,
      hideErrors: true,
      // Microsoft sign-in: tokens are cached so you only do this once.
      profilesFolder: path.isAbsolute(s.authFolder) ? s.authFolder : path.join(__dirname, s.authFolder),
      onMsaCode: (data) => this.log.warn(`Microsoft sign-in for the bot's account: go to ${data.verification_uri} and enter code ${data.user_code}`)
    }
    if (s.realm) {
      delete options.host
      options.realms = { pickRealm: (realms) => realms.find((r) => r.name.toLowerCase() === s.realm.toLowerCase()) || realms[0] }
    }
    const bot = mineflayer.createBot(options)
    this.stopReconnecting = false
    this.loginSentAt = 0
    this.bot = bot
    bot.loadPlugin(pathfinder)

    this.chat = new ChatManager(this)
    this.executor = new ActionExecutor({
      bot,
      config: this.config,
      chat: this.chat,
      log: this.log,
      social: this.social,
      learning: this.learning,
      memory: this.memory,
      tasks: this.tasks,
      builder: this.builder,
      intel: this.intelligence,
      containers: this.containers,
      knowledgeOpts: () => this.knowledgeOpts(),
      notify: (type, data) => this.onActionEvent(type, data)
    })
    this.reactor = new EventReactor(this)
    this.responder = new ChatResponder(this)
    this.brain = new Brain(this)
    this.smalltalk = new SmallTalk(this)
    this.reactor.attach(bot)
    this.senses.attach(bot)
    this.attachServerHelpers(bot)

    bot.once('spawn', () => this.onFirstSpawn())
    bot.on('spawn', () => { this.dead = false })
    bot.on('death', () => {
      this.dead = true
      this.executor.abort('died')
      this.brain.clearForced()
      this.log.warn('Died. Waiting for respawn...')
    })
    // Falling speed over the last second, to tell fall damage apart from attacks.
    bot.on('physicsTick', () => {
      const vy = bot.entity?.velocity?.y ?? 0
      this.recentFallSpeed = Math.min(vy, this.recentFallSpeed * 0.9)
      // Water-bucket clutch when falling hard toward the ground (a skill not everyone has).
      if (vy < -0.75 && !this.clutching && this.intelligence.can('waterClutch', 'survival') && Date.now() - (this.lastClutchAt || 0) > 3000) {
        this.clutching = true
        combat.fallClutch(bot).then((did) => { if (did) { this.lastClutchAt = Date.now(); this.log.info('Water-bucket clutch!') } })
          .catch(() => {}).finally(() => { this.clutching = false })
      }
    })
    bot.on('chat', (username, message) => this.responder.onMessage(username, message))
    bot.on('whisper', (username, message) => this.responder.onMessage(username, message, { whisper: true }))
    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.log.warn(`Kicked: ${text}`)
      if (/outdated|incompatible|version/i.test(text)) {
        this.log.warn('That looks like a version mismatch. Pin server.version, or install ViaVersion + ViaBackwards on the server / use ViaProxy (see README).')
      }
      // Never fight a real person for the same account, and don't hammer a server that doesn't want us.
      if (/logged in from another location|another location|duplicate (login|name)|already (connected|online|playing|logged in)/i.test(text)) {
        this.stopReconnecting = true
        this.log.warn('Someone else logged in with this account (maybe you). The bot will not reconnect and kick you off.')
      } else if (/white-?list|not allowed on this server|banned|ban\b/i.test(text)) {
        this.stopReconnecting = true
        this.log.warn('The server does not let this account in (whitelist/ban). Not retrying.')
      } else if (/spam|flying|too (fast|many)/i.test(text)) {
        this.reconnectAttempts += 2 // back off harder
      }
    })
    bot.on('error', (err) => this.log.error(`Connection error: ${err.message}`))
    bot.on('end', (reason) => this.onEnd(reason))
  }

  /** Events raised by actions (fights, gifts, kills...). */
  onActionEvent (type, data) {
    const { emotions, learning, memory } = this
    if (type === 'fightEnded') {
      this.intelligence.addXp('combat', data.outcome === 'win' ? 2.5 : 1.5)
      this.tasks.onFightEnded(data)
      this.tasks.distract(0.1)
      if (data.outcome === 'win') {
        learning.stats.kills++
        emotions.stimulate({ joy: 0.2, anger: -0.15, fear: -0.15 }, `you beat ${data.label}`)
        if (data.isPlayer) this.reactor.trigger('wonFight', data)
      } else if (data.outcome === 'fled' || data.outcome === 'loss') {
        emotions.stimulate({ fear: 0.15, sadness: 0.1 }, `you lost a fight to ${data.label}`)
        if (data.outcome === 'fled') this.reactor.trigger('lostFight', data)
      }
      learning.markDirty()
      if (data.isPlayer || data.outcome !== 'win') {
        learning.reflect(`Fight against ${data.label} using the "${data.style}" style (${COMBAT_STYLES[data.style]?.desc}): ${data.outcome}. ` +
          `${data.hitsLanded ?? '?'} hits landed, ${data.hitsTaken ?? '?'} taken, ${data.healthLost ?? '?'} health lost.`)
      }
      return
    }
    if (type === 'buildDone') {
      emotions.stimulate({ joy: 0.35 }, `you finished building your ${data.name}`)
      memory.addEvent('build', `You finished building ${data.name}.`)
      this.learning.reflect(`You finished building ${data.name} (${data.placed} blocks).`)
      this.reactor.trigger('buildDone', data)
      return
    }
    if (type === 'gaveItem') {
      this.tasks.onGave(data.player, data.item, data.count)
      emotions.stimulate({ joy: 0.08 })
      memory.addEvent('gave', `You gave ${data.count} ${data.item} to ${data.player}.`)
      return
    }
    this.reactor.trigger(type, data)
  }

  /** Re-apply skill-dependent movement (parkour, sprinting) after an intelligence change. */
  refreshMovements () {
    const m = this.bot?.pathfinder?.movements
    if (!m) return
    const pf = this.config.behavior.pathfinding
    m.allowParkour = pf.allowParkour && this.intelligence.can('parkour', 'survival')
    m.allowSprinting = pf.allowSprinting && this.intelligence.can('sprint', 'survival')
  }

  /** Things that make joining other people's servers just work. */
  attachServerHelpers (bot) {
    const s = this.config.server
    // Resource packs.
    bot.on('resourcePack', () => {
      try { if (s.resourcePack === 'decline') bot.denyResourcePack(); else bot.acceptResourcePack() } catch { /* older versions */ }
    })
    const recentChat = []
    bot.on('chat', (username, message) => { recentChat.push(`${username}|${message}`); if (recentChat.length > 20) recentChat.shift() })
    const userPatterns = (s.chatPatterns || []).map((p) => { try { return new RegExp(p) } catch { return null } }).filter(Boolean)

    bot.on('messagestr', (text, position) => {
      if (position === 'game_info') return
      // Login plugins (AuthMe, nLogin, ...): answer "/register" and "/login" prompts.
      if (s.password && Date.now() - this.loginSentAt > 8000) {
        const fill = (t) => t.replace(/\{password\}/g, s.password)
        if (/\/register\b|please register|register (with|using)/i.test(text)) { this.loginSentAt = Date.now(); bot.chat(fill(s.registerCommand)); this.log.info('Registered with the server login plugin.') }
        else if (/\/login\b|please log ?in|log ?in (with|using)/i.test(text)) { this.loginSentAt = Date.now(); bot.chat(fill(s.loginCommand)); this.log.info('Logged in with the server login plugin.') }
      }
      // Plugin chat formats ("[Member] Steve: hi", "Steve » hi", "Steve -> me: psst") that don't come through as normal chat.
      const parsed = parsePluginChat(text, userPatterns)
      if (!parsed || !bot.players[parsed.user] || parsed.user === bot.username) return
      if (recentChat.includes(`${parsed.user}|${parsed.msg}`)) return // already handled as normal chat
      recentChat.push(`${parsed.user}|${parsed.msg}`)
      this.responder.onMessage(parsed.user, parsed.msg, { whisper: parsed.whisper })
    })
  }

  onFirstSpawn () {
    const { bot, config, log } = this
    this.reconnectAttempts = 0
    log.info(`Spawned in ${bot.game.dimension} at ${bot.entity.position.floored()} (Minecraft ${bot.version}).`)

    const pf = config.behavior.pathfinding
    const movements = new Movements(bot)
    movements.canDig = pf.canDig && config.server.platform !== 'bedrock' // no block breaking through ViaBedrock
    // Parkour and sprinting are skills too.
    movements.allowParkour = pf.allowParkour && this.intelligence.can('parkour', 'survival')
    movements.allowSprinting = pf.allowSprinting && this.intelligence.can('sprint', 'survival')
    // Good guest: don't dig through other players' builds while pathfinding.
    if (config.behavior.noGrief) {
      for (const b of bot.registry.blocksArray) {
        if (/planks$|glass|_bricks$|wool$|concrete|terracotta$|_door$|_bed$|lantern|bookshelf|carpet$|_sign$|_stairs$|_slab$|_fence$|_fence_gate$|_wall$|torch$|smooth_|chiseled_|quartz|_trapdoor$/.test(b.name)) movements.blocksCantBreak.add(b.id)
      }
    }
    movements.allow1by1towers = pf.allow1by1towers
    // Never tunnel through containers or beds that other players placed.
    for (const name of ['chest', 'trapped_chest', 'barrel', 'furnace', 'crafting_table', 'ender_chest']) {
      const id = bot.registry.blocksByName[name]?.id
      if (id !== undefined) movements.blocksCantBreak.add(id)
    }
    this.learning.movement.attach(movements) // steer around places where we died or got stuck
    bot.pathfinder.setMovements(movements)
    bot.pathfinder.thinkTimeout = pf.thinkTimeoutMs

    this.perception = new Perception(this)

    // Periodic tick (every ~2s): fresh snapshot, body-language reading, feelings decay, forgiveness.
    this.intervals.push(setInterval(() => {
      if (!bot.entity || this.dead) return
      try {
        const state = this.perception.snapshot()
        this.reactor.observe(state)
        this.social.observe(state)
        this.social.tickRecovery()
        this.emotions.tick()
        this.tasks.tick()
        this.learning.movement.tick(pf.allowParkour)
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
    this.learning.save()
    for (const id of this.intervals.splice(0)) clearInterval(id)
    if (this.shuttingDown || !this.config.server.reconnect || this.stopReconnecting) return

    const s = this.config.server
    const delay = Math.min(s.maxReconnectDelayMs, s.reconnectDelayMs * 2 ** this.reconnectAttempts)
    this.reconnectAttempts++
    this.log.info(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`)
    setTimeout(() => {
      if (!this.shuttingDown) this.connect().catch((err) => this.log.error(`Reconnect failed: ${err.message}`))
    }, delay)
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
    this.learning.close()
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
