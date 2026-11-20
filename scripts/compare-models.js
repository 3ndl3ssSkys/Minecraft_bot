'use strict'
/**
 * npm run compare-models -- qwen3:4b-instruct sweaterdog/andy-4:micro-q8_0 [more models] [--n 30] [--version 1.21.4]
 *                            [--url http://localhost:11434/api/chat]
 *
 * Which model is better for this bot, measured the same way for each one on your own PC:
 *   knowledge   multiple-choice questions with answers checked against the game's own data (minecraft-data):
 *               the pickaxe a block needs, what goes into a recipe, which food fills you most, what a mob drops;
 *   judgment    situations described the way the bot sees them (observe.js) with numbered options, where one is
 *               clearly right (eat when starving, get away from a vindicator, shelter at night with no bed...);
 *   decisions   your held-back recorded decisions (test-short.jsonl), if you have made a training set;
 *   speed       seconds per answer, prompt tokens read per second, answer tokens written per second.
 *   format      how often it answered in the JSON asked for (an answer found in plain text still counts as right).
 * Same questions, same order, temperature 0.2 for every model. Models made for another bot (Mindcraft's Andy
 * models) get the same plain questions, so the comparison is fair to them; their Mindcraft commands are read too.
 */
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../index.js')
const strategy = require('../strategy')
const observe = require('../observe')
const mindcraft = require('../mindcraft')

const argv = process.argv.slice(2)
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def }
const models = argv.filter((a, i) => !a.startsWith('--') && !['--n', '--version', '--url'].includes(argv[i - 1]))
const N = Number(opt('--n', 30))
const VERSION = opt('--version', '1.21.4')

// ---- A fixed random sequence, so every model gets the same questions -------------------------------------------
function rng (seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const shuffle = (xs, r) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }
const nice = (n) => n.replace(/_/g, ' ')

/** Knowledge questions from the game's data. Each: { q, choices: [4], answer: index }. */
function knowledgeQuestions (n, version) {
  const data = require('minecraft-data')(version)
  const r = rng(42)
  const out = []
  const ask = (q, right, wrongs) => {
    const choices = shuffle([right, ...shuffle(wrongs.filter((w) => w !== right), r).slice(0, 3)], r)
    if (choices.length === 4) out.push({ q, choices, answer: choices.indexOf(right) })
  }
  // The weakest pickaxe that mines it so it drops.
  const TIERS = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']
  const tierOf = (b) => {
    const tools = Object.keys(b.harvestTools || {}).map((id) => data.items[id]?.name).filter((x) => TIERS.includes(x))
    return tools.length ? TIERS[Math.min(...tools.map((t) => TIERS.indexOf(t)))] : null
  }
  const ores = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore', 'obsidian', 'ancient_debris', 'deepslate_iron_ore', 'deepslate_diamond_ore', 'stone', 'nether_gold_ore', 'crying_obsidian', 'deepslate_gold_ore']
  for (const name of ores) {
    const b = data.blocksByName[name]
    const t = b && tierOf(b)
    if (t) ask(`What is the weakest pickaxe that mines ${nice(name)} so that it drops something?`, nice(t), TIERS.map(nice))
  }
  // What goes into a recipe.
  const common = ['oak_planks', 'stick', 'cobblestone', 'iron_ingot', 'gold_ingot', 'diamond', 'string', 'redstone', 'coal', 'leather', 'feather', 'flint', 'glass', 'paper', 'slime_ball', 'white_wool', 'oak_log', 'sand', 'gunpowder', 'quartz', 'book', 'chest', 'furnace', 'leather', 'blaze_powder', 'ender_pearl', 'clay_ball', 'brick']
  const targets = ['torch', 'furnace', 'chest', 'bucket', 'shield', 'bow', 'compass', 'clock', 'piston', 'sticky_piston', 'hopper', 'rail', 'iron_pickaxe', 'diamond_sword', 'crafting_table', 'ladder', 'tnt', 'bookshelf', 'shears', 'flint_and_steel', 'fishing_rod', 'white_bed', 'anvil', 'ender_eye', 'arrow', 'book', 'lead', 'dispenser', 'observer', 'redstone_torch']
  for (const name of targets) {
    const item = data.itemsByName[name]
    const recipes = item && data.recipes[item.id]
    if (!recipes?.length) continue
    const ids = new Set()
    for (const rc of recipes) {
      for (const row of rc.inShape || []) for (const c of row) if (c !== null && c !== undefined) ids.add(typeof c === 'object' ? c.id : c)
      for (const c of rc.ingredients || []) ids.add(typeof c === 'object' ? c.id : c)
    }
    const used = [...ids].map((id) => data.items[id]?.name).filter(Boolean)
    const usedSet = new Set(used.map((u) => (/_planks$/.test(u) ? 'oak_planks' : /_wool$/.test(u) ? 'white_wool' : /_log$/.test(u) ? 'oak_log' : u)))
    const right = shuffle([...usedSet].filter((u) => common.includes(u)), r)[0]
    if (!right) continue
    ask(`Which of these is an ingredient for crafting ${nice(name)}?`, nice(right), common.filter((c) => !usedSet.has(c)).map(nice))
  }
  // Which food fills the most hunger.
  const foods = data.foodsArray.filter((f) => !/suspicious|rotten|spider|poison|puffer|chorus|golden_apple|enchanted|honey|cake|stew|soup/.test(f.name))
  for (let i = 0; i < 8; i++) {
    const pick = shuffle(foods, r).slice(0, 4)
    const best = Math.max(...pick.map((f) => f.foodPoints))
    if (pick.filter((f) => f.foodPoints === best).length !== 1) continue
    const right = pick.find((f) => f.foodPoints === best)
    ask('Which of these fills the most hunger?', nice(right.name), pick.filter((f) => f !== right).map((f) => nice(f.name)))
  }
  // Which creature drops it (well-known drops).
  const DROPS = { string: 'spider', gunpowder: 'creeper', bone: 'skeleton', ender_pearl: 'enderman', leather: 'cow', white_wool: 'sheep', feather: 'chicken', blaze_rod: 'blaze', slime_ball: 'slime', rotten_flesh: 'zombie', ghast_tear: 'ghast', magma_cream: 'magma cube', ink_sac: 'squid', rabbit_hide: 'rabbit', phantom_membrane: 'phantom', shulker_shell: 'shulker' }
  const mobs = [...new Set(Object.values(DROPS))]
  for (const [item, mob] of Object.entries(DROPS)) ask(`Which creature drops ${nice(item)}?`, mob, mobs)
  return shuffle(out, rng(7)).slice(0, n)
}

/** Situations with one clearly right option (by strategy.js), described as the bot sees them. */
function judgmentQuestions () {
  const base = { tier: 2, health: 20, food: 20, time: 6000, dim: 'overworld', layout: 'outdoors', freeSlots: 20 }
  const kit = { stone_pickaxe: 1, stone_sword: 1, bread: 6, oak_planks: 12, cobblestone: 30 }
  const cases = [
    ['eat', { ...base, food: 6, health: 12, inv: kit }, 'You are starving and hurt.'],
    ['shelter', { ...base, time: 15000, inv: { ...kit, bread: 8 } }, 'It is the middle of the night, you are outside, zombies are groaning nearby.'],
    ['sleep', { ...base, time: 12600, inv: { ...kit, white_bed: 1 } }, 'The sun is setting.'],
    ['flee', { ...base, inv: kit, health: 9, threat: { verdict: 'flee', list: [{ id: 12, name: 'vindicator', hostile: true, verdict: 'flee', distance: 5, danger: 1.4 }] } }, 'A vindicator with an axe is running at you and you have 4.5 hearts.'],
    ['fight', { ...base, inv: { ...kit, iron_sword: 1 }, threat: { verdict: 'fight', list: [{ id: 9, name: 'zombie', hostile: true, verdict: 'fight', distance: 6, danger: 0.1 }] } }, 'A single zombie is walking at you; you have full health and an iron sword.'],
    ['drop', { ...base, freeSlots: 0, inv: { ...kit, dirt: 320, gravel: 128, andesite: 200 } }, 'Your inventory is completely full of dirt, gravel and andesite.'],
    ['wooden_pickaxe', { ...base, tier: 0, inv: { oak_log: 4 } }, 'You just spawned in a forest and have 4 logs.'],
    ['diamond_pickaxe', { ...base, inv: { iron_pickaxe: 1, iron_sword: 1, shield: 1, diamond: 5, bread: 10, white_bed: 1, torch: 40, bucket: 1, iron_chestplate: 1, iron_leggings: 1, iron_helmet: 1, iron_boots: 1 }, homeKnown: true }, 'You have an iron pickaxe and just mined 5 diamonds.'],
    ['torch', { ...base, layout: 'underground (y 30, rock 20 above); dark here (monsters can spawn)', inv: { ...kit, torch: 20 } }, 'You are in a pitch-dark cave.'],
    ['cook', { ...base, food: 12, inv: { stone_pickaxe: 1, stone_sword: 1, beef: 6, coal: 8, cobblestone: 20 } }, 'You are getting hungry and only have raw beef.']
  ]
  const r = rng(99)
  const out = []
  for (const [want, view, story] of cases) {
    const opts = strategy.options(view)
    if (!opts.some((o) => o.id === want)) continue
    // Distractors: progression options it isn't time for, shuffled in.
    const extra = [
      { id: 'x1', why: 'go exploring for a village', action: { name: 'explore', args: { distance: 64 } } },
      { id: 'x2', why: 'build a nice house', action: { name: 'planBuilding', args: { purpose: 'house' } } },
      { id: 'x3', why: 'go fishing for a while', action: { name: 'fish', args: {} } }
    ]
    const list = shuffle([opts.find((o) => o.id === want), ...shuffle([...opts.filter((o) => o.id !== want), ...extra], r).slice(0, 3)], r)
    const snap = {
      self: { position: { x: 0, y: 64, z: 0 }, health: view.health, food: view.food, dimension: 'overworld' },
      world: { timeOfDay: view.time },
      equipment: {},
      inventory: { items: view.inv, freeSlots: view.freeSlots },
      layout: view.layout,
      nearbyEntities: (view.threat?.list || []).map((x) => ({ id: x.id, kind: 'hostile', name: x.name, distance: x.distance })),
      status: {}
    }
    const text = `${observe.compact(snap, { coords: false })}\n${story}\nOptions:\n${list.map((o, i) => `${i + 1}. ${o.why}`).join('\n')}`
    out.push({ q: text, answer: list.findIndex((o) => o.id === want), n: list.length })
  }
  return out
}

// ---- Asking a model ----------------------------------------------------------------------------------------------
async function ask (config, model, messages, maxTokens = 60) {
  const started = Date.now()
  const res = await fetch(config.llm.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, format: 'json', think: false, keep_alive: config.llm.keepAlive, options: { temperature: 0.2, num_ctx: 4096, num_predict: maxTokens } }),
    signal: AbortSignal.timeout(180000)
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const data = await res.json()
  const text = String(data?.message?.content || '').replace(/^[\s\S]*<\/think>/, '').trim()
  let json = null
  try { json = JSON.parse(text) } catch { const m = text.match(/\{[\s\S]*\}/); if (m) try { json = JSON.parse(m[0]) } catch {} }
  return {
    text,
    json,
    ms: Date.now() - started,
    read: data.prompt_eval_count && data.prompt_eval_duration ? data.prompt_eval_count / (data.prompt_eval_duration / 1e9) : null,
    write: data.eval_count && data.eval_duration ? data.eval_count / (data.eval_duration / 1e9) : null
  }
}

/** The letter or number it picked, from JSON if it gave JSON, else from the text. */
function picked (out, key, max) {
  let v = out.json?.[key] ?? out.json?.answer ?? out.json?.choose ?? out.json?.choice
  if (v === undefined) v = (out.text.match(key === 'answer' ? /\b([A-D])\b/ : /\b([1-9])\b/) || [])[1]
  if (key === 'answer') { const i = 'ABCD'.indexOf(String(v || '').trim().toUpperCase()[0]); return i >= 0 ? i : null }
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= max ? n - 1 : null
}

async function run (config, model, sets) {
  const score = { model, knowledge: 0, kn: 0, judgment: 0, jn: 0, decisions: 0, dn: 0, json: 0, asked: 0, ms: [], read: [], write: [] }
  const note = (o) => { score.asked++; if (o.json) score.json++; score.ms.push(o.ms); if (o.read) score.read.push(o.read); if (o.write) score.write.push(o.write) }
  // Load the model first so the first answer isn't timed with the loading (and stop here if it isn't there).
  await ask(config, model, [{ role: 'user', content: 'Say {"ok": true}' }], 8).catch((err) => {
    throw new Error(/fetch failed|ECONNREFUSED/.test(String(err.message) + String(err.cause?.code)) ? `can't reach Ollama at ${config.llm.url}` : `${err.message} (is it pulled? ollama pull ${model})`)
  })
  const sys = 'You are an expert Minecraft (Java Edition) player. Answer the question.'
  for (const k of sets.knowledge) {
    const q = `${k.q}\n${k.choices.map((c, i) => `${'ABCD'[i]}) ${c}`).join('\n')}\nAnswer with JSON only: {"answer": "A|B|C|D"}`
    const o = await ask(config, model, [{ role: 'system', content: sys }, { role: 'user', content: q }]).catch((e) => ({ text: '', json: null, ms: 0, err: e }))
    note(o)
    score.kn++
    if (picked(o, 'answer') === k.answer) score.knowledge++
    process.stdout.write(`\r${model}: knowledge ${score.kn}/${sets.knowledge.length}   `)
  }
  for (const j of sets.judgment) {
    const q = `${j.q}\nWhat do you do? Answer with JSON only: {"choose": <option number>}`
    const o = await ask(config, model, [{ role: 'system', content: `${sys} You are playing right now.` }, { role: 'user', content: q }]).catch(() => ({ text: '', json: null, ms: 0 }))
    note(o)
    score.jn++
    if (picked(o, 'choose', j.n) === j.answer) score.judgment++
    process.stdout.write(`\r${model}: judgment ${score.jn}/${sets.judgment.length}      `)
  }
  for (const ex of sets.decisions) {
    const msgs = ex.messages.filter((m) => m.role !== 'assistant')
    const want = JSON.parse(ex.messages.find((m) => m.role === 'assistant').content)
    const o = await ask(config, model, msgs, 300).catch(() => ({ text: '', json: null, ms: 0 }))
    note(o)
    score.dn++
    let name = o.json?.action?.name
    if (!name) { const mc = mindcraft.find(o.text); name = mc && mindcraft.toAction(mc, {})?.name }
    if (name && name === want.action?.name) score.decisions++
    process.stdout.write(`\r${model}: decisions ${score.dn}/${sets.decisions.length}     `)
  }
  process.stdout.write('\n')
  return score
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-')

async function main () {
  if (!models.length) {
    console.log('Usage: npm run compare-models -- <model> <model> ...   e.g.  npm run compare-models -- qwen3:4b-instruct qwen3:1.7b sweaterdog/andy-4:micro-q8_0')
    process.exit(1)
  }
  const quiet = { info () {}, warn () {}, error: console.error, debug () {} }
  process.argv = [process.argv[0], process.argv[1]]
  const config = loadConfig(quiet)
  if (opt('--url')) config.llm.url = opt('--url')
  const testFile = path.join(__dirname, '..', 'data', 'training', 'test-short.jsonl')
  const sets = {
    knowledge: knowledgeQuestions(N, VERSION),
    judgment: judgmentQuestions(),
    decisions: fs.existsSync(testFile) ? fs.readFileSync(testFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(0, Math.min(N, 30)) : []
  }
  console.log(`${sets.knowledge.length} knowledge questions, ${sets.judgment.length} situations${sets.decisions.length ? `, ${sets.decisions.length} of your recorded decisions` : ' (no test-short.jsonl yet: npm run training-set -- --short)'}. One model at a time; this takes a few minutes per model.`)
  const results = []
  for (const m of models) {
    try { results.push(await run(config, m, sets)) } catch (err) { console.log(`\n${m}: ${err.message}`) }
  }
  if (!results.length) process.exit(1)
  console.log('\nmodel                              knowledge  judgment  decisions  JSON   s/answer  read tok/s  write tok/s')
  for (const s of results) {
    const row = [
      s.model.padEnd(34), pct(s.knowledge, s.kn).padStart(9), pct(s.judgment, s.jn).padStart(9), pct(s.decisions, s.dn).padStart(10),
      pct(s.json, s.asked).padStart(6), ((med(s.ms) || 0) / 1000).toFixed(2).padStart(9), String(Math.round(med(s.read) || 0)).padStart(11), String(Math.round(med(s.write) || 0)).padStart(12)
    ]
    console.log(row.join(' '))
  }
  console.log('Knowledge and judgment are graded against the game data and clear-cut situations; random guessing gets about 25%.')
  const file = path.join(__dirname, '..', 'data', 'training', `compare-${new Date().toISOString().slice(0, 10)}.json`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(results.map(({ ms, read, write, ...s }) => ({ ...s, secondsPerAnswer: (med(ms) || 0) / 1000, readTokS: med(read), writeTokS: med(write) })), null, 2))
  console.log(`Saved ${file}`)
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1) })

module.exports = { knowledgeQuestions, judgmentQuestions, picked }
