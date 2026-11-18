'use strict'
/**
 * npm run training-set [-- path/to/decisions.jsonl] [--short]
 *
 * Turns the decisions the bot recorded while playing (logging.trainingData) into a fine-tuning file: only the ones
 * that worked, no failures or repeats, no broken or emoji answers. Output: train.jsonl next to the input, one chat per
 * line ({"messages": [system, user, assistant]}), the format Unsloth's notebooks and most trainers read.
 */
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
// --short: train with the short system prompt (llm.trained), so the model learns to need only that (much faster).
const short = args.includes('--short')
const input = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'training', 'decisions.jsonl')
if (!fs.existsSync(input)) {
  console.log(`No recorded decisions at ${input}.\nTurn on "logging": { "trainingData": true } in config.local.json and let the bot play for a while first.`)
  process.exit(1)
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
const seen = new Set()
const why = { kept: 0, failed: 0, broken: 0, repeat: 0, emoji: 0, waiting: 0 }
const out = []
let last = ''
for (const l of lines) {
  let d
  try { d = JSON.parse(l) } catch { why.broken++; continue }
  const a = d.answer
  if (!d.ok) { why.failed++; continue }
  if (!a?.action?.name || !Array.isArray(d.messages) || d.messages.length < 2) { why.broken++; continue }
  const text = JSON.stringify(a)
  if (EMOJI.test(text)) { why.emoji++; continue }
  if (a.action.name === 'wait') { why.waiting++; continue } // standing around teaches nothing
  const act = `${a.action.name}${JSON.stringify(a.action.args || {})}`
  const key = `${act}|${String(d.messages[1].content).slice(-400)}`
  if (act === last || seen.has(key)) { why.repeat++; continue }
  last = act
  seen.add(key)
  const msgs = d.messages.map((m) => ({ role: m.role, content: m.content }))
  if (short) { if (!d.short) { why.broken++; continue } msgs[0] = { role: 'system', content: d.short } }
  out.push(JSON.stringify({ messages: [...msgs, { role: 'assistant', content: text }] }))
  why.kept++
}
const file = path.join(path.dirname(input), short ? 'train-short.jsonl' : 'train.jsonl')
fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''))
console.log(`${lines.length} recorded decisions → ${why.kept} examples in ${file}`)
console.log(`left out: ${why.failed} failed, ${why.repeat} repeats, ${why.waiting} waits, ${why.broken} broken, ${why.emoji} with emojis`)
if (why.kept < 1000) console.log('A useful fine-tune wants a few thousand examples: let it play more (with people around, if you can).')
