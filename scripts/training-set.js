'use strict'
/**
 * npm run training-set [-- path/to/decisions.jsonl] [--short] [--max-code 0.5] [--level master]
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
// --max-code 0.5: at most this share of examples from the code's own decisions (the early-game routine and friends),
// so the model doesn't only learn to chop trees. --level master: only examples from bots at that level.
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const maxCode = Number(opt('--max-code', 0.5))
const onlyLevel = opt('--level', null)
const input = args.find((a, i) => !a.startsWith('--') && !['--max-code', '--level'].includes(args[i - 1])) || path.join(__dirname, '..', 'data', 'training', 'decisions.jsonl')
if (!fs.existsSync(input)) {
  console.log(`No recorded decisions at ${input}.\nTurn on "logging": { "trainingData": true } in config.local.json and let the bot play for a while first.`)
  process.exit(1)
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u
const lines = fs.readFileSync(input, 'utf8').split('\n').filter(Boolean)
const seen = new Set()
const why = { kept: 0, failed: 0, broken: 0, repeat: 0, emoji: 0, waiting: 0, level: 0, code: 0 }
const byLevel = {}
const bySource = { model: 0, code: 0 }
const code = []
const out = []
let last = ''
for (const l of lines) {
  let d
  try { d = JSON.parse(l) } catch { why.broken++; continue }
  const a = d.answer
  if (!d.ok) { why.failed++; continue }
  if (onlyLevel && d.level !== onlyLevel) { why.level++; continue }
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
  const line = JSON.stringify({ messages: [...msgs, { role: 'assistant', content: text }] })
  if (d.model === 'code') { code.push({ line, level: d.level }); continue }
  out.push(line)
  bySource.model++
  byLevel[d.level || '?'] = (byLevel[d.level || '?'] || 0) + 1
  why.kept++
}
// The code's examples: no more than maxCode of the whole (spread evenly through the recording).
const room = maxCode >= 1 ? code.length : Math.floor((maxCode * out.length) / Math.max(0.01, 1 - maxCode))
const step = code.length > room && room > 0 ? code.length / room : 1
for (let i = 0; i < code.length && bySource.code < room; i += step) {
  const c = code[Math.floor(i)]
  out.push(c.line); bySource.code++; why.kept++
  byLevel[c.level || '?'] = (byLevel[c.level || '?'] || 0) + 1
}
why.code = code.length - bySource.code
// Shuffle (fixed seed), so training doesn't see one session after another.
let seed = 7
for (let i = out.length - 1; i > 0; i--) { seed = (seed * 16807) % 2147483647; const j = seed % (i + 1); [out[i], out[j]] = [out[j], out[i]] }
const file = path.join(path.dirname(input), short ? 'train-short.jsonl' : 'train.jsonl')
// 5% held back to test the trained model on decisions it never saw (npm run eval-model).
const nTest = out.length >= 40 ? Math.max(20, Math.round(out.length * 0.05)) : 0
const test = out.splice(0, nTest)
fs.writeFileSync(file, out.join('\n') + (out.length ? '\n' : ''))
if (test.length) fs.writeFileSync(file.replace(/train(-short)?\.jsonl$/, 'test$1.jsonl'), test.join('\n') + '\n')
console.log(`${lines.length} recorded decisions → ${out.length} examples in ${file}${test.length ? ` (+ ${test.length} held back for npm run eval-model)` : ''}`)
console.log(`from the model: ${bySource.model}, from the code: ${bySource.code} | by level: ${Object.entries(byLevel).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}`)
console.log(`left out: ${why.failed} failed, ${why.repeat} repeats, ${why.waiting} waits, ${why.broken} broken, ${why.emoji} with emojis${why.code ? `, ${why.code} extra code examples (--max-code)` : ''}${why.level ? `, ${why.level} other levels` : ''}`)
if (why.kept < 1000) console.log('A useful fine-tune wants a few thousand examples: let it play more (with people around, if you can).')
