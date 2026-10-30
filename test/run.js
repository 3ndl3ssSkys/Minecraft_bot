'use strict'
// Runs every *.test.js in this folder and fails if any of them fails.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
let failed = 0
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js')).sort()) {
  process.stdout.write(`\n=== ${f} ===\n`)
  try {
    execFileSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' })
  } catch {
    failed++
  }
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll tests passed')
process.exit(failed ? 1 : 0)
