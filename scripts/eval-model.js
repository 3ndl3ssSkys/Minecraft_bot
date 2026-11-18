'use strict'
/**
 * npm run eval-model -- [model] [test file] [--n 40]
 *
 * How good is a (fine-tuned) model at the bot's decisions? It answers held-back examples (test-short.jsonl, written by
 * npm run training-set -- --short) through Ollama, and this compares its choice with the recorded one:
 *   valid JSON · same action · same action and the same main argument (block, item, player…) · seconds per decision.
 * Run it for the old and the new model and compare.
 */
const fs = require('fs')
const path = require('path')
const { loadConfig } = require('../index.js')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const plain = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--n')
const quiet = { info () {}, warn () {}, error: console.error, debug () {} }
process.argv = [process.argv[0], process.argv[1]]
const config = loadConfig(quiet)
const model = plain[0] || config.llm.model
const file = plain[1] || path.join(__dirname, '..', 'data', 'training', 'test-short.jsonl')
const n = Number(opt('--n', 40))
if (!fs.existsSync(file)) { console.log(`No test file at ${file}. Make one with: npm run training-set -- --short`); process.exit(1) }
const examples = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(0, n)
const MAIN = ['blockType', 'itemName', 'playerName', 'ore', 'entityId', 'topic', 'direction']
const main = (a) => { for (const k of MAIN) if (a?.[k] !== undefined) return `${k}=${String(a[k]).toLowerCase()}`; return '' }

;(async () => {
  console.log(`Testing ${model} on ${examples.length} decisions it hasn't seen (${path.basename(file)})...`)
  let valid = 0; let same = 0; let sameArgs = 0; let secs = 0; let done = 0
  for (const ex of examples) {
    const msgs = ex.messages.filter((m) => m.role !== 'assistant')
    const want = JSON.parse(ex.messages.find((m) => m.role === 'assistant').content)
    const started = Date.now()
    let got = null
    try {
      const res = await fetch(config.llm.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: msgs, stream: false, format: 'json', think: false, keep_alive: config.llm.keepAlive, options: { temperature: 0.2, num_ctx: config.llm.numCtx, num_predict: 300 } }), signal: AbortSignal.timeout(120000) })
      const data = await res.json()
      const text = String(data?.message?.content || '').replace(/^[\s\S]*<\/think>/, '')
      got = JSON.parse(text)
    } catch { /* not valid */ }
    secs += (Date.now() - started) / 1000
    done++
    if (got?.action?.name) valid++
    if (got?.action?.name === want.action?.name) {
      same++
      if (main(got.action.args) === main(want.action.args)) sameArgs++
    }
    process.stdout.write(`\r${done}/${examples.length}`)
  }
  const pct = (x) => `${Math.round((100 * x) / Math.max(1, done))}%`
  console.log(`\nvalid answers ${pct(valid)} · same action ${pct(same)} · same action and target ${pct(sameArgs)} · ${(secs / Math.max(1, done)).toFixed(1)} s per decision`)
  console.log('Same action means it chose what the recorded (good) decision chose; other good choices exist, so 60-80% is already a good model.')
})().catch((err) => { console.error(err.message); process.exit(1) })
