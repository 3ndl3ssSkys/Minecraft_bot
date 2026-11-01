'use strict'

/**
 * doctor.js — checks that everything the bot needs is in place, on this machine.
 *
 *   npm run doctor                         # uses config.json
 *   node doctor.js --server friend1        # check a server profile
 *   node doctor.js --probe-login           # also try a quick offline login to learn if the server is online-mode
 *
 * It checks Node, the config, Ollama (reachable, model pulled), benchmarks the
 * model with a decision-sized prompt (how fast it really is on your GPU, and how
 * much of it fits in VRAM), and whether the Minecraft server (or ViaProxy) answers.
 */

const fs = require('fs')
const path = require('path')
const mc = require('minecraft-protocol')
const { loadConfig, loginFor, fallbackServer, serverMods, OllamaClient, errText, sampleDecisionPrompt, usesCompactPrompt } = require('./index.js')
const knowledge = require('./knowledge')

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`)
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)
const tip = (m) => console.log(`      ${m}`)
const quiet = { info: () => {}, warn: (m) => warn(m), error: (m) => bad(m), debug: () => {} }

async function main () {
  const probeLogin = process.argv.includes('--probe-login')
  console.log('\nMinecraft LLM bot — setup check\n')

  // --- Node
  console.log('Node.js')
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 22) ok(`Node ${process.versions.node}`)
  else bad(`Node ${process.versions.node} — Mineflayer needs Node 22 or newer (https://nodejs.org)`)

  // --- Config
  console.log('\nConfig')
  let config
  try {
    config = loadConfig(quiet)
    const s = config.server
    const login = loginFor(s)
    ok(`server: ${s.realm ? `realm "${s.realm}"` : `${s.host}:${s.port}`} · ${login.auth === 'microsoft' ? `Microsoft account ${login.username}` : `offline account "${login.username}"`} · platform ${s.platform} · intelligence ${config.intelligence.level} · chat ${config.chat.mode}`)
    if (!config.behavior.owners.length) warn('behavior.owners is empty — add your in-game name so you can use !commands')
    const preset = typeof config.personality === 'string' && path.join(__dirname, 'personalities', `${config.personality}.json`)
    if (preset && !fs.existsSync(preset)) warn(`personality preset "${config.personality}" not found in personalities/`)
    if (login.auth === 'microsoft') {
      const folder = path.isAbsolute(s.authFolder) ? s.authFolder : path.join(__dirname, s.authFolder)
      if (fs.existsSync(folder) && fs.readdirSync(folder).length) ok('Microsoft sign-in is cached')
      else warn('Microsoft sign-in not done yet — the first start prints a code to enter at microsoft.com/link (run it once by hand, not as a service)')
    }
  } catch (err) {
    bad(err.message)
    process.exit(1)
  }

  // --- LLM
  console.log('\nOllama / LLM')
  const fastOnOllama = (config.llm.fastProvider || config.llm.provider) !== 'openai' && !config.llm.fastUrl
  if (config.llm.provider === 'openai') await timeRequest(config, 'decision-sized', 'main')
  else await checkOllama(config, fastOnOllama)
  if (config.llm.fastModel && !(config.llm.provider !== 'openai' && fastOnOllama)) await timeRequest(config, 'chat reply', 'fast')

  // --- Minecraft server
  console.log('\nMinecraft server')
  const s = config.server
  if (s.realm) {
    warn('Realms can\'t be pinged; the bot joins through your Microsoft account\'s Realms list.')
  } else {
    try {
      const res = await mc.ping({ host: s.host, port: s.port, closeTimeout: 6000, noPongTimeout: 6000 })
      const motd = typeof res.description === 'string' ? res.description : (res.description?.text || '')
      ok(`${s.host}:${s.port} answers — ${res.version?.name} (protocol ${res.version?.protocol}), ${res.players?.online ?? '?'}/${res.players?.max ?? '?'} online${motd ? `, "${String(motd).replace(/§./g, '').slice(0, 60)}"` : ''}`)
      if (s.platform === 'bedrock') tip('That is ViaProxy answering for the Bedrock server — good.')
      const mods = serverMods(res)
      if (mods) {
        warn(`modded server: ${mods.loader} with ${mods.count} mods. The bot is a vanilla client, so it can only join if every mod is server-side.`)
        tip('Fabric/Paper servers with server-side mods or plugins are fine; Forge/NeoForge modpacks that need the mods on your side are not.')
      }
    } catch (err) {
      bad(`${s.host}:${s.port} doesn't answer (${errText(err)}).`)
      if (s.platform === 'bedrock') tip('Is ViaProxy started (default port 25568) and pointed at the Geyser port?')
      else tip('Check host/port, that the server is running, and firewalls.')
    }
    if (probeLogin && s.platform !== 'bedrock') await probe(s)
  }
  const backup = fallbackServer(s, config.servers)
  if (backup) {
    const b = backup.server
    try {
      await mc.ping({ host: b.host, port: b.port, closeTimeout: 6000, noPongTimeout: 6000 })
      ok(`backup route "${backup.name}" (${b.platform}) answers at ${b.host}:${b.port}`)
    } catch (err) {
      warn(`backup route "${backup.name}" doesn't answer at ${b.host}:${b.port} (${errText(err)}). That's fine unless the main route gets refused.`)
      if (b.platform === 'bedrock') tip('Start ViaProxy if you want the backup to be ready.')
    }
  }
  console.log('')
  process.exit(0)
}

/** One real request through the bot's own client: how long a decision or a reply takes. */
async function timeRequest (config, what, lane) {
  const client = new OllamaClient(config, quiet)
  const model = lane === 'fast' ? config.llm.fastModel : config.llm.model
  const big = lane === 'main' ? knowledge.FACTS.map((f) => f[1]).join('\n').slice(0, 9000) : ''
  const messages = [
    { role: 'system', content: `You are a Minecraft player in game chat. ${big}\nReply with ONLY JSON: {"message": "..."}` },
    { role: 'user', content: 'Steve: hey, got any spare iron?' }
  ]
  const priority = lane === 'fast' ? 0 : 2
  try {
    let t = Date.now()
    await client.chat(messages, { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, priority, label: 'doctor' })
    const first = Date.now() - t
    t = Date.now()
    const out = await client.chat(messages, { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }, priority, label: 'doctor' })
    const second = Date.now() - t
    const msg = `${what} with ${model}: ${(second / 1000).toFixed(1)}s (first call ${(first / 1000).toFixed(1)}s) — "${String(out.message || '').slice(0, 50)}"`
    if (second <= (lane === 'fast' ? 2500 : 8000)) ok(msg)
    else warn(`${msg} — slow; a smaller model or llm.think: false helps`)
  } catch (err) {
    bad(`${what} with ${model} failed: ${errText(err)}`)
  }
}

async function checkOllama (config, withFast) {
  const base = new URL(config.llm.url).origin
  let models = []
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) })
    models = ((await res.json()).models || []).map((m) => m.name)
    ok(`Ollama is running at ${base}`)
  } catch {
    bad(`Can't reach Ollama at ${base}. Install it from https://ollama.com and make sure it's running.`)
  }
  const wanted = config.llm.model.includes(':') ? config.llm.model : `${config.llm.model}:latest`
  if (models.length && !models.includes(wanted) && !models.includes(config.llm.model) && !/cloud$/.test(config.llm.model)) {
    bad(`Model "${config.llm.model}" isn't downloaded. Run: ollama pull ${config.llm.model}`)
  } else if (models.length) {
    ok(`model ${config.llm.model} is downloaded`)
    tip('Timing four requests with the bot\'s real decision prompt — up to a minute or two, longer if part of it runs on the CPU. Please wait...')
    await benchmark(config, base)
  }
  const fast = config.llm.fastModel
  if (fast && withFast && models.length) {
    const fastWanted = fast.includes(':') ? fast : `${fast}:latest`
    if (!models.includes(fastWanted) && !models.includes(fast) && !/cloud$/.test(fast)) bad(`Fast model "${fast}" isn't downloaded. Run: ollama pull ${fast}`)
    else await timeRequest(config, 'chat reply', 'fast')
  }
}

/** A game state about the size of a real one (varied, so each decision reads it fresh). */
function sampleState (n) {
  return JSON.stringify({
    self: { health: 18 + (n % 3), food: 15, position: { x: 102 + n, y: 64, z: -37 }, dimension: 'overworld', xp: 3 },
    world: { phase: n % 2 ? 'day' : 'evening', raining: false, biome: 'forest' },
    inventory: { items: { oak_log: 6 + n, oak_planks: 12, stick: 4, stone_pickaxe: 1, cobblestone: 23, bread: 3 }, freeSlots: 28 },
    equipment: { hand: 'stone_pickaxe', armor: ['leather_chestplate'] },
    nearbyEntities: [
      { id: 41, name: 'Steve', kind: 'player', distance: 7 + n, perceived: 'seen', trust: 'friendly', seems: 'happy' },
      { id: 57, name: 'zombie', kind: 'hostile', distance: 18, perceived: 'heard' },
      { id: 60, name: 'cow', kind: 'passive', distance: 9 }
    ],
    nearbyBlocks: { oak_log: { count: 14, distance: 4, visible: true }, iron_ore: { count: 2, distance: 11, visible: false }, crafting_table: { count: 1, distance: 3 } },
    status: {
      currentAction: null, goal: 'gather 20 oak logs', feelings: 'calm (4/10)', danger: 'none',
      goals: { overarching: 'have a cozy base and good gear (your own idea)', workingToward: ['build a cozy base (your own idea)'], current: 'gather 20 oak logs (your own idea)', steps: ['[x] find trees', '[>] chop 20 oak logs'] }
    },
    recentEvents: ['30s ago: Steve came close to you.', '12s ago: You finished a step: find trees.'],
    recentActions: [{ action: 'mineBlock', ok: true, message: `Mined ${n + 2} oak_log.` }],
    recentChat: [{ from: 'Steve', text: 'nice trees here' }]
  })
}

/**
 * Time real decisions with the bot's own prompt: a cold one, the next one (Ollama reuses the
 * unchanged start of the prompt), and one right after a chat reply (which may push that out).
 */
async function benchmark (config, base) {
  const system = sampleDecisionPrompt(config)
  const chatSystem = `You are ${config.server.username || 'Wanderer'}, a Minecraft player reading chat. ${knowledge.FACTS.slice(0, 12).map((f) => f[1]).join(' ')}\nReply with ONLY JSON: {"reply": "..."}`
  const call = async (sys, user, predict = 150) => {
    const t = Date.now()
    const res = await fetch(config.llm.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.llm.model, stream: false, format: 'json', keep_alive: config.llm.keepAlive, ...(typeof config.llm.think === 'boolean' ? { think: config.llm.think } : {}), options: { num_ctx: config.llm.numCtx, num_predict: predict }, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(240000)
    })
    const d = await res.json()
    if (d.error) throw new Error(d.error)
    return { ...d, wall: (Date.now() - t) / 1000 }
  }
  try {
    const first = await call(system, sampleState(1))
    if (first.message?.thinking || /<\/think>/.test(first.message?.content || '')) {
      bad(`${config.llm.model} "thinks" out loud before answering${config.llm.think === false ? ', even with thinking switched off' : ''} — that makes every decision slow.`)
      tip(config.llm.think === false ? 'It\'s a thinking-only version. Use a normal one: ollama pull qwen3:4b-instruct (or qwen2.5:3b), then npm run setup.' : 'Set "think": false under "llm" in config.local.json (npm run setup does this for Qwen3).')
    }
    if (!first.prompt_eval_count || !first.eval_duration) { warn('the model answered, but Ollama returned no timing info (very old Ollama?)'); return }
    const sec = (ns) => ns / 1e9
    const readTps = first.prompt_eval_count / Math.max(0.001, sec(first.prompt_eval_duration || 1))
    const writeTps = first.eval_count / Math.max(0.001, sec(first.eval_duration || 1))
    ok(`reads ${readTps.toFixed(0)} tokens/s, writes ${writeTps.toFixed(1)} tokens/s (model load ${sec(first.load_duration || 0).toFixed(1)}s)`)
    tip(`decision prompt: ~${first.prompt_eval_count} tokens${usesCompactPrompt(config) ? ' (compact)' : ' (full — llm.compactPrompt: true makes it ~60% shorter)'}`)
    const next = await call(system, sampleState(2))
    const cached = next.prompt_eval_count < first.prompt_eval_count * 0.8
    const msg = `a decision takes ≈ ${next.wall.toFixed(1)}s once warmed up (read ${next.prompt_eval_count} new tokens${cached ? '; the rest was reused' : ''}, wrote ${next.eval_count})`
    if (next.wall <= 8) ok(msg)
    else warn(`${msg} — playable but slow; see README "Which model, and making it fast".`)
    await call(chatSystem, 'Steve: hey, got any spare iron?', 40)
    const after = await call(system, sampleState(3))
    if (after.wall > next.wall * 1.5 && after.wall - next.wall > 2) {
      warn(`right after a chat reply a decision takes ≈ ${after.wall.toFixed(1)}s: the chat pushed the decision prompt out of Ollama's memory, so it was read again.`)
      tip(config.llm.fastModel ? 'Your fastModel should prevent this; check it is downloaded.' : 'Fix: a small separate chat model keeps its own memory — npm run setup → "Small model for chat replies": qwen3:1.7b.')
    } else {
      ok(`a chat reply in between doesn't slow the next decision (≈ ${after.wall.toFixed(1)}s)`)
    }
  } catch (err) {
    bad(`benchmark failed: ${errText(err)}`)
    return
  }
  // How much of the model is on the GPU?
  try {
    const ps = await (await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()
    const m = (ps.models || []).find((x) => x.name.startsWith(config.llm.model.split(':')[0]))
    if (m) {
      const gb = (b) => (b / 1024 ** 3).toFixed(1)
      const pct = m.size ? Math.round((m.size_vram / m.size) * 100) : 0
      if (pct >= 99) ok(`fully on the GPU (${gb(m.size_vram)} GB VRAM used, with a ${config.llm.numCtx}-token context)`)
      else if (pct > 0) {
        warn(`only ${pct}% on the GPU (${gb(m.size_vram)} of ${gb(m.size)} GB) — the rest runs on the CPU, which is several times slower.`)
        tip('This model is a bit too big for this card (Windows also uses some of its memory for the screen).')
        tip('Easiest fix: a smaller model that fits entirely —  npm run setup  and choose qwen3:4b-instruct (it downloads and tests it).')
        tip('Or: the Ollama settings from npm run setup (restart Ollama after setting them), and llm.numCtx 6144.')
      } else warn('running entirely on the CPU — check the GPU driver / that Ollama sees your GPU.')
    }
  } catch { /* older Ollama without /api/ps */ }
}

/** Try an offline login with a throwaway name to learn how the server authenticates. */
async function probe (s) {
  const name = `Doctor${Math.floor(Math.random() * 9000 + 1000)}`
  await new Promise((resolve) => {
    let done = false
    const finish = (fn) => { if (!done) { done = true; fn(); try { client.end() } catch { /* ignore */ } resolve() } }
    const client = mc.createClient({ host: s.host, port: s.port, username: name, auth: 'offline', version: s.version || undefined, hideErrors: true })
    client.on('login', () => finish(() => {
      ok('offline login works: this is an offline-mode server. The bot can join with "auth": "offline" (set server.password if it uses a login plugin).')
    }))
    client.on('disconnect', (p) => finish(() => explainKick(JSON.stringify(p.reason))))
    client.on('kick_disconnect', (p) => finish(() => explainKick(JSON.stringify(p.reason))))
    client.on('error', (err) => finish(() => explainKick(errText(err))))
    setTimeout(() => finish(() => warn('login probe timed out')), 15000)
  })
}

function explainKick (text) {
  if (/verify username|invalid session|not authenticated|premium|authentication/i.test(text)) {
    warn('online-mode server: offline accounts are rejected.')
    tip('Use a Java account ("auth": "microsoft"), or a Bedrock account via ViaProxy if the server has Geyser + Floodgate.')
  } else if (/white-?list/i.test(text)) warn('whitelisted: the bot\'s name must be added to the whitelist.')
  else if (/ban/i.test(text)) warn('that name is banned.')
  else warn(`login probe was refused: ${text.slice(0, 160)}`)
}

main().catch((err) => { bad(err.stack || err.message); process.exit(1) })
