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
const { loadConfig, loginFor, fallbackServer, serverMods } = require('./index.js')
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

  // --- Ollama
  console.log('\nOllama / LLM')
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
  if (models.length && !models.includes(wanted) && !models.includes(config.llm.model)) {
    bad(`Model "${config.llm.model}" isn't downloaded. Run: ollama pull ${config.llm.model}`)
  } else if (models.length) {
    ok(`model ${config.llm.model} is downloaded`)
    await benchmark(config, base)
  }

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
      bad(`${s.host}:${s.port} doesn't answer (${err.message}).`)
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
      warn(`backup route "${backup.name}" doesn't answer at ${b.host}:${b.port} (${err.message}). That's fine unless the main route gets refused.`)
      if (b.platform === 'bedrock') tip('Start ViaProxy if you want the backup to be ready.')
    }
  }
  console.log('')
  process.exit(0)
}

/** One decision-sized request: how fast is it on this machine, and does it fit in VRAM? */
async function benchmark (config, base) {
  // Roughly the size of a real decision prompt (~4-5k tokens).
  const filler = knowledge.FACTS.map((f) => f[1]).join('\n')
  const system = `You are a Minecraft player. Reference:\n${filler}\n${filler}`.slice(0, 13000)
  const user = `${JSON.stringify({ self: { health: 20, food: 18, position: { x: 10, y: 64, z: -3 } }, nearbyBlocks: { oak_log: { count: 12, distance: 5 } }, inventory: { items: { dirt: 12 } } })}\nChoose your next action as JSON: {"thought": "...", "action": "..."}`
  const started = Date.now()
  try {
    const res = await fetch(config.llm.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.llm.model, stream: false, format: 'json', keep_alive: config.llm.keepAlive, options: { num_ctx: config.llm.numCtx, num_predict: 120 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      signal: AbortSignal.timeout(180000)
    })
    const d = await res.json()
    if (!d.prompt_eval_count || !d.eval_duration) { warn('the model answered, but Ollama returned no timing info (very old Ollama?)'); return }
    const s = (ns) => ns / 1e9
    const promptTps = d.prompt_eval_count / Math.max(0.001, s(d.prompt_eval_duration || 1))
    const genTps = d.eval_count / Math.max(0.001, s(d.eval_duration || 1))
    ok(`benchmark: ${d.prompt_eval_count} prompt tokens at ${promptTps.toFixed(0)} tok/s, ${d.eval_count} reply tokens at ${genTps.toFixed(1)} tok/s (${((Date.now() - started) / 1000).toFixed(1)}s total, model load ${s(d.load_duration || 0).toFixed(1)}s)`)
    const perDecision = 2500 / promptTps + 150 / genTps // after the first call, the fixed part of the prompt is usually cached
    const msg = `≈ ${perDecision.toFixed(1)}s per decision once warmed up`
    if (perDecision <= 8) ok(msg)
    else warn(`${msg} — playable but slow. A smaller model (qwen2.5:3b) or a smaller llm.numCtx makes it snappier.`)
  } catch (err) {
    bad(`benchmark failed: ${err.message}`)
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
        warn(`only ${pct}% on the GPU (${gb(m.size_vram)} of ${gb(m.size)} GB) — the rest runs on the CPU, which is much slower.`)
        tip('Options: set OLLAMA_FLASH_ATTENTION=1 and OLLAMA_KV_CACHE_TYPE=q8_0 for Ollama, lower llm.numCtx to 6144,')
        tip('close other GPU programs (a Minecraft client uses 1-2 GB VRAM), or use qwen2.5:3b.')
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
    client.on('error', (err) => finish(() => explainKick(err.message)))
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
