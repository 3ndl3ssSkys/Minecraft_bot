'use strict'
/**
 * npm run set -- <setting> <value>     e.g.  npm run set -- llm.fastModel qwen3:1.7b
 * npm run set -- <setting>             shows the current value
 * npm run set -- <setting> --remove    back to the default
 *
 * Writes your own settings file (config.local.json) for you, so you don't have to edit JSON by hand: it creates the
 * sections that are missing, keeps everything else, and checks that the setting exists.
 */
const fs = require('fs')
const path = require('path')
const { DEFAULT_CONFIG, readJson, unknownSettings } = require('../index.js')

const FILE = path.join(__dirname, '..', 'config.local.json')
const [key, ...rest] = process.argv.slice(2)
if (!key) {
  console.log('Usage: npm run set -- <setting> <value>    e.g.  npm run set -- llm.fastModel qwen3:1.7b')
  process.exit(1)
}
const parts = key.split('.')
const def = parts.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), DEFAULT_CONFIG)
const local = fs.existsSync(FILE) ? readJson(FILE) : {}
const current = parts.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), local)

if (!rest.length) {
  console.log(`${key} = ${JSON.stringify(current !== undefined ? current : def)}${current === undefined ? ' (the default)' : ' (your setting)'}`)
  process.exit(0)
}

let value
if (rest[0] === '--remove') value = undefined
else {
  const raw = rest.join(' ')
  // true/false, numbers and JSON ([...], {...}) as such; everything else is text.
  try { value = /^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/.test(raw) ? JSON.parse(raw) : raw } catch { value = raw }
}

// Check the setting exists (or is inside a section where any name is fine).
const probe = {}
parts.reduce((o, k, i) => (o[k] = i === parts.length - 1 ? value ?? '' : {}), probe)
const problems = unknownSettings(probe)
if (problems.length && def === undefined) {
  console.log(`Not saved: ${problems[0]}`)
  process.exit(1)
}
if (def !== undefined && value !== undefined && typeof def !== typeof value && def !== null && !(typeof def === 'string' && typeof value !== 'object')) {
  console.log(`Note: ${key} is usually ${typeof def === 'object' ? (Array.isArray(def) ? 'a list' : 'a group of settings') : `a ${typeof def}`} (default ${JSON.stringify(def)}).`)
}

let node = local
for (const k of parts.slice(0, -1)) {
  if (!node[k] || typeof node[k] !== 'object') node[k] = {}
  node = node[k]
}
if (value === undefined) delete node[parts.at(-1)]
else node[parts.at(-1)] = value
fs.writeFileSync(FILE, JSON.stringify(local, null, 2) + '\n')
console.log(value === undefined ? `Removed ${key}: back to the default (${JSON.stringify(def)}).` : `Saved ${key} = ${JSON.stringify(value)} in ${FILE}`)
console.log('Restart the bot for it to take effect.')
