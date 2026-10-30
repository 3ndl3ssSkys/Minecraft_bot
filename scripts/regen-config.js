'use strict'
/**
 * Rewrites config.json from DEFAULT_CONFIG in index.js (the single source of
 * truth for defaults), in a compact, readable layout. Run after adding or
 * changing a default:   node scripts/regen-config.js
 * Note: this replaces config.json — copy your own settings back afterwards,
 * or keep them in a separate file (node index.js my-config.json).
 */
const fs = require('fs')
const path = require('path')
const { DEFAULT_CONFIG } = require('../index.js')

const isLeaf = (v) => v === null || typeof v !== 'object'
function fmt (v, ind) {
  const pad = '  '.repeat(ind)
  if (isLeaf(v)) return JSON.stringify(v)
  if (Array.isArray(v)) {
    const one = JSON.stringify(v).replace(/","/g, '", "').replace(/,(?=\d)/g, ', ')
    if (v.every(isLeaf) && one.length <= 110) return one
    return '[\n' + v.map((x) => pad + '  ' + fmt(x, ind + 1)).join(',\n') + '\n' + pad + ']'
  }
  const ents = Object.entries(v)
  if (!ents.length) return '{}'
  const flat = ents.every(([, x]) => isLeaf(x) || (Array.isArray(x) && x.every(isLeaf)))
  if (flat) {
    const one = '{ ' + ents.map(([k, x]) => JSON.stringify(k) + ': ' + fmt(x, 0)).join(', ') + ' }'
    if (one.length <= 200 && (ents.some(([k]) => k === 'templates') || ind >= 2)) return one
  }
  return '{\n' + ents.map(([k, x]) => pad + '  ' + JSON.stringify(k) + ': ' + fmt(x, ind + 1)).join(',\n') + '\n' + pad + '}'
}

const text = fmt(DEFAULT_CONFIG, 0)
if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(DEFAULT_CONFIG)) throw new Error('formatter changed the data')
fs.writeFileSync(path.join(__dirname, '..', 'config.json'), text + '\n')
console.log('config.json regenerated from DEFAULT_CONFIG')
