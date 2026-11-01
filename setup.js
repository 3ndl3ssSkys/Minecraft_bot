'use strict'

/**
 * setup.js — `npm run setup`: a few questions, then your settings go into
 * config.local.json (your file, not part of git, so updates never clash with
 * it). Run it again any time to change the answers; anything else can be
 * added to that file by hand (see CONFIGURING.md).
 */

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { execFileSync, spawnSync } = require('child_process')
const { DEFAULT_CONFIG } = require('./index.js')
const { LEVELS, LABELS } = require('./intelligence')

const FILE = path.join(__dirname, 'config.local.json')

async function main () {
  const rl = readline.createInterface({ input: process.stdin })
  // Answers are queued, so typing ahead (or piping them in) works too.
  const lines = []
  let waiting = null
  let closed = false
  rl.on('line', (line) => { if (waiting) { const w = waiting; waiting = null; w(line) } else lines.push(line) })
  rl.on('close', () => { closed = true; if (waiting) waiting('') })
  const next = () => lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('') : new Promise((resolve) => { waiting = resolve })
  const old = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {}
  const ask = async (question, def) => {
    process.stdout.write(`${question}${def !== undefined && def !== '' ? ` [${def}]` : ''}: `)
    const raw = (await next()).trim()
    if (!process.stdin.isTTY) process.stdout.write(`${raw}\n`)
    const answer = raw.replace(/^[\s[("'`]+|[\s\])"'`]+$/g, '') // "[complicated]" → "complicated"
    return answer || (def ?? '')
  }
  console.log('\nMinecraft LLM bot setup — press Enter to keep the value in [brackets].\n')

  // Who you are, so the bot takes !commands from you.
  const owner = await ask('Your Minecraft name (so the bot obeys your !commands)', old.behavior?.owners?.[0])

  // Where it plays.
  console.log('\nThe server the bot joins. For a server on this same PC use localhost.')
  const oldAddr = old.server ? `${old.server.host || 'localhost'}:${old.server.port || 25565}` : 'localhost:25565'
  const addr = await ask('Server address (host or host:port)', oldAddr)
  const [host, port] = addr.replace(/^.*:\/\//, '').split(':')
  const username = await ask('The bot\'s name in game (or a Microsoft account email if it has its own Java account)', old.server?.username || 'Wanderer')

  // Who it is.
  const presets = fs.readdirSync(path.join(__dirname, 'personalities')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  console.log(`\nPersonalities: ${presets.join(', ')}`)
  console.log('Pick one, or describe your own in a few words (e.g. "friendly, a bit cautious, loves exploring").')
  const oldCustom = typeof old.personality === 'object' && old.personality
  const answer = await ask('Personality', oldCustom ? oldCustom.setupDescription || 'custom' : (old.personality || 'friendly'))
  let personality
  let mind = {}
  if (presets.includes(answer.toLowerCase())) {
    personality = answer.toLowerCase()
  } else if (oldCustom && answer === (oldCustom.setupDescription || 'custom')) {
    personality = oldCustom
  } else {
    const base = presets.find((p) => answer.toLowerCase().includes(p)) || 'friendly'
    ;({ personality, mind } = customPersonality(answer, base))
    console.log(`  Made a custom personality from that, built on "${base}" (traits: ${personality.traits.join(', ')}).`)
  }
  console.log(`\nSkill levels: ${LEVELS.join(', ')}`)
  const levelAnswer = (await ask('How good a player', old.intelligence?.level || 'mediocre')).toLowerCase()
  let level = LEVELS.find((l) => l === levelAnswer) || LEVELS.find((l) => levelAnswer.startsWith(l.slice(0, 4)) || LABELS[l].toLowerCase() === levelAnswer)
  if (!level) { console.log(`  (unknown level "${levelAnswer}", using mediocre)`); level = 'mediocre' }

  // Which model.
  const llm = { ...DEFAULT_CONFIG.llm, ...(old.llm || {}) }
  let models = []
  try {
    const res = await fetch(`${new URL(llm.url).origin}/api/tags`, { signal: AbortSignal.timeout(4000) })
    models = ((await res.json()).models || []).map((m) => m.name)
  } catch { /* Ollama not running */ }
  if (models.length) {
    console.log(`\nModels you have in Ollama: ${models.join(', ')}`)
  } else {
    console.log('\n(Ollama isn\'t answering — is it running? You can still finish; the bot will wait for it.)')
  }
  // Prefer what was chosen before, then a non-thinking model that fits a 6 GB card entirely, then any Qwen.
  const preferred = (old.llm?.model && models.find((m) => m.startsWith(old.llm.model))) || models.find((m) => /^qwen3:4b-instruct/.test(m)) ||
    models.find((m) => m.startsWith(llm.model)) || models.find((m) => /qwen/.test(m)) || llm.model
  console.log('For a 6 GB card: qwen3:4b-instruct (fits entirely on the card). qwen2.5:7b is smarter but may not fit (check with: ollama ps).')
  let model = await ask('Model for decisions', preferred)
  const fastModel = await ask('Small model for chat replies (optional, Enter to skip)', old.llm?.fastModel || '')

  // Ollama's settings for a small card (Windows: setx; they only apply after Ollama restarts).
  const restart = await ollamaSettings(ask, Boolean(fastModel))

  // Make sure the model is there, and that it answers straight away instead of "thinking" out loud.
  const base = new URL(llm.url).origin
  for (let tries = 0; models.length && tries < 3; tries++) {
    if (!models.some((m) => m === model || m === `${model}:latest`)) {
      if (!yes(await ask(`${model} isn't downloaded yet. Download it now?`, 'Y'))) break
      spawnSync('ollama', ['pull', model], { stdio: 'inherit', shell: process.platform === 'win32' })
      models.push(model)
    }
    console.log(`Testing ${model}...`)
    const t = await testModel(base, model)
    if (t.error) { console.log(`  Couldn't test it: ${t.error}`); break }
    if (!t.thinks) { console.log(`  ✓ answers straight away (${(t.ms / 1000).toFixed(1)}s, including loading it).`); break }
    console.log(`  ✗ ${model} "thinks" out loud before every answer, even with thinking switched off. In the bot that means`)
    console.log('    slow decisions, and often broken ones. It\'s a thinking-only version of the model.')
    const other = /qwen3:4b/.test(model) ? 'qwen3:4b-instruct' : 'qwen2.5:3b'
    if (!yes(await ask(`Use ${other} instead (the normal version)?`, 'Y'))) break
    model = other
  }

  const config = {
    ...old,
    server: { ...(old.server || {}), host: host || 'localhost', port: Number(port) || 25565, username },
    personality,
    intelligence: { ...(old.intelligence || {}), level },
    mind: { ...(old.mind || {}), ...mind },
    llm: { ...(old.llm || {}), model, fastModel, ...(/qwen3|deepseek-r1|think/.test(model + fastModel) ? { think: false } : {}) },
    behavior: { ...(old.behavior || {}), owners: owner ? [owner] : (old.behavior?.owners || []) }
  }
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n')
  rl.close()
  console.log(`\nSaved to ${FILE}`)
  if (restart) console.log('Remember: restart Ollama now (llama icon by the clock → Quit Ollama, then start Ollama again), and open a new Command Prompt.')
  console.log('Next: npm run doctor   (checks everything)   then   npm start   (starts the bot)\n')
}

const yes = (a) => /^y(es)?$/i.test(String(a).trim())

const TUNING = [
  ['OLLAMA_FLASH_ATTENTION', '1', 'a faster way to run the model that also uses less memory'],
  ['OLLAMA_KV_CACHE_TYPE', 'q8_0', "keeps the model's working memory (what it's reading) in half the space, so more fits on the card"],
  ['OLLAMA_KEEP_ALIVE', '24h', 'keeps the model loaded, so the bot never waits for it to load again']
]

/** Offer Ollama's memory-saving settings. Returns true if Ollama needs a restart to use them. */
async function ollamaSettings (ask, twoModels) {
  const wanted = [...TUNING, ...(twoModels ? [['OLLAMA_MAX_LOADED_MODELS', '2', 'keeps the decision model and the chat model loaded together']] : [])]
  const current = (name) => process.env[name] || winUserEnv(name)
  const missing = wanted.filter(([name, value]) => current(name) !== value)
  console.log('\nOllama settings that help a 6 GB graphics card:')
  for (const [name, value, why] of wanted) console.log(`  ${current(name) === value ? '✓' : '·'} ${name}=${value} — ${why}`)
  if (!missing.length) { console.log('  All set already.'); return false }
  if (process.platform !== 'win32') {
    console.log('  On Linux, add them to the Ollama service (sudo systemctl edit ollama), see SETUP.md step 4.')
    return false
  }
  if (!yes(await ask('Set them now?', 'Y'))) return false
  for (const [name, value] of missing) {
    try {
      execFileSync('setx', [name, value], { stdio: 'ignore' })
      console.log(`  ✓ ${name}=${value}`)
    } catch (err) {
      console.log(`  ✗ couldn't set ${name} (${err.message}). Run by hand: setx ${name} ${value}`)
    }
  }
  console.log('  Ollama only reads these when it starts: quit it from the llama icon by the clock and start it again.')
  return true
}

/** A value saved with setx (it isn't in this window's environment until a new window opens). */
function winUserEnv (name) {
  if (process.platform !== 'win32') return undefined
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`))?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** One tiny request with thinking off: does it answer straight away? */
async function testModel (base, model) {
  const started = Date.now()
  const ask = (think) => fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, ...(think === undefined ? {} : { think }), options: { num_predict: 300 }, messages: [{ role: 'user', content: 'Reply with just the word: ok' }] }),
    signal: AbortSignal.timeout(180000)
  })
  try {
    let res = await ask(false)
    if (res.status === 400) res = await ask(undefined) // models without a thinking switch
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` }
    const d = await res.json()
    const content = d.message?.content || ''
    return { thinks: Boolean(d.message?.thinking) || /<\/think>/.test(content) || content.length > 80, ms: Date.now() - started }
  } catch (err) {
    return { error: err.message }
  }
}

/**
 * "friendly, slightly cautious, fun PvE, enjoys exploring" → a personality built on a preset
 * with those traits, plus a few matching mind settings.
 */
function customPersonality (text, base) {
  const preset = JSON.parse(fs.readFileSync(path.join(__dirname, 'personalities', `${base}.json`), 'utf8'))
  const words = text.split(/\s*[,;/]\s*|\s+and\s+/).map((w) => w.replace(/[-_]/g, ' ').trim()).filter((w) => w && w.toLowerCase() !== base)
  const t = text.toLowerCase()
  const mind = {}
  if (/cautious|careful|safe|wary/.test(t)) mind.riskTolerance = /slight|bit|little|somewhat/.test(t) ? 0.4 : 0.25
  if (/reckless|brave|daring|risk/.test(t)) mind.riskTolerance = 0.75
  if (/curious|explor/.test(t)) mind.curiosity = 0.75
  const style = [[/explor/, 'explorer'], [/build/, 'builder'], [/mine|mining/, 'miner'], [/pvp|fight/, 'fighter'], [/help/, 'helper'], [/trad/, 'trader'], [/surviv/, 'survivalist']].find(([re]) => re.test(t))
  if (style) mind.playstyle = style[1]
  const likes = []
  if (/pve|mobs/.test(t)) likes.push('fighting mobs')
  if (/explor/.test(t)) likes.push('exploring new places')
  return {
    personality: {
      base,
      setupDescription: text,
      traits: [...new Set([...(preset.traits || []), ...words])].slice(0, 10),
      description: `${preset.description} In a few words: ${text}.`,
      likes: [...new Set([...(preset.likes || []), ...likes])]
    },
    mind
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
