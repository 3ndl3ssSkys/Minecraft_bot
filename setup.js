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
const { DEFAULT_CONFIG } = require('./index.js')
const { LEVELS } = require('./intelligence')

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
    const answer = (await next()).trim()
    if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`)
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
  let personality = await ask('Personality', typeof old.personality === 'string' ? old.personality : 'friendly')
  if (!presets.includes(personality)) { console.log(`  (no preset "${personality}", using friendly)`); personality = 'friendly' }
  console.log(`\nSkill levels: ${LEVELS.join(', ')}`)
  let level = await ask('How good a player', old.intelligence?.level || 'mediocre')
  if (!LEVELS.includes(level)) { console.log(`  (unknown level, using mediocre)`); level = 'mediocre' }

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
  const preferred = models.find((m) => m.startsWith(llm.model)) || models.find((m) => /qwen/.test(m)) || llm.model
  const model = await ask('Model for decisions', preferred)
  const fastModel = await ask('Small model for chat replies (optional, Enter to skip)', old.llm?.fastModel || '')

  const config = {
    ...old,
    server: { ...(old.server || {}), host: host || 'localhost', port: Number(port) || 25565, username },
    personality,
    intelligence: { ...(old.intelligence || {}), level },
    llm: { ...(old.llm || {}), model, fastModel, ...(/qwen3|deepseek-r1|think/.test(model + fastModel) ? { think: false } : {}) },
    behavior: { ...(old.behavior || {}), owners: owner ? [owner] : (old.behavior?.owners || []) }
  }
  fs.writeFileSync(FILE, JSON.stringify(config, null, 2) + '\n')
  rl.close()
  console.log(`\nSaved to ${FILE}`)
  console.log('Next: npm run doctor   (checks everything)   then   npm start   (starts the bot)\n')
}

main().catch((err) => { console.error(err.message); process.exit(1) })
