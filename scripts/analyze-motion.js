'use strict'
/**
 * npm run analyze-motion [-- data/training/motion/<file>.jsonl ...]
 *
 * Your aim and movement as numbers, from recordings made with npm run record (all of them if no file is given):
 *   - flicks: how long a turn of a given size takes you (Fitts' law: time = a + b * log2(1 + angle / 4)), how often you
 *     correct after the first movement, how often you overshoot;
 *   - fights: clicks per second while hitting, strafing while hitting;
 *   - moving: how much you sprint, jumps per minute.
 * Writes data/training/motion/profile.json. Point the bot at it to aim like you (look.js then uses your aim skill
 * instead of the one its level gives):  npm run set -- behavior.aimProfile data/training/motion/profile.json
 */
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'data', 'training', 'motion')
const wrap = (d) => ((d + 540) % 360) - 180

function load (files) {
  const rows = []
  for (const f of files) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l) try { rows.push(JSON.parse(l)) } catch {} }
  }
  return rows.sort((a, b) => a[0] - b[0])
}

/**
 * Look samples → flicks. A flick is a burst of turning between moments of holding still (under 8°/s for 4 samples,
 * longer than the lift between two swipes). Inside it, submovements are split at the dips of the turning speed: the
 * first one is the primary movement (its time is what Fitts' law describes), the rest are corrections.
 */
function flicks (looks) {
  const out = []
  let cur = null
  let still = 0
  const finish = () => {
    const sp = cur.speeds
    // Trim the still samples at the end.
    while (sp.length && sp.at(-1).v < 8) sp.pop()
    if (sp.length < 2) return
    const end = sp.at(-1)
    const amp = Math.hypot(wrap(end.y - cur.y0), end.p - cur.p0)
    if (amp < 5) return
    // Submovements: a dip under 35% of the speed reached so far in this submovement, then a rise again.
    const subs = [0]
    let peak = 0
    for (let k = 1; k < sp.length - 1; k++) {
      peak = Math.max(peak, sp[k - 1].v)
      const v = sp[k].v
      if (v <= sp[k - 1].v && v <= sp[k + 1].v && v < 0.35 * peak && sp[k + 1].v > Math.max(2 * v, 12)) { subs.push(k); peak = 0 }
    }
    const primaryEnd = subs.length > 1 ? sp[subs[1]] : end
    out.push({ amp, T: (end.t - cur.t0) / 1000, primary: (primaryEnd.t - cur.t0) / 1000, peak: Math.max(...sp.map((x) => x.v)), subs: subs.length })
  }
  for (let i = 1; i < looks.length; i++) {
    const [t0, y0, p0] = looks[i - 1]
    const [t1, y1, p1] = looks[i]
    const dt = (t1 - t0) / 1000
    if (dt <= 0 || dt > 0.3) { cur = null; continue }
    const v = Math.hypot(wrap(y1 - y0), p1 - p0) / dt
    if (!cur) {
      if (v >= 8) { cur = { t0, y0, p0, speeds: [{ t: t1, y: y1, p: p1, v }] }; still = 0 }
      continue
    }
    cur.speeds.push({ t: t1, y: y1, p: p1, v })
    still = v < 8 ? still + 1 : 0
    if (still >= 4) { finish(); cur = null }
  }
  return out
}

/** Least squares for the primary movement's time: T = a + b * log2(1 + amp / 4). */
function fitts (fl) {
  const xs = fl.map((f) => Math.log2(1 + f.amp / 4))
  const ys = fl.map((f) => f.primary)
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2 }
  const b = sxx ? sxy / sxx : 0.12
  return { a: my - b * mx, b }
}

function analyze (rows) {
  const looks = []
  const hits = []
  let keyRows = 0
  let sprintRows = 0
  let jumps = 0
  let lastKeys = ''
  let strafeHits = 0
  for (const r of rows) {
    if (r[1] === 'm') looks.push([r[0], r[5], r[6]])
    if (r[1] === 'k') {
      keyRows++
      if (r[2].includes('s') && !r[2].includes('sh')) sprintRows++
      if (r[2].includes('j') && !lastKeys.includes('j')) jumps++
      lastKeys = r[2]
    }
    if (r[1] === 'h' && r[3] === 1) { hits.push(r[0]); if (/[lr]/.test(lastKeys)) strafeHits++ }
  }
  // De-duplicate repeated look samples (position packets carry the last look).
  const uniq = looks.filter((l, i) => i === 0 || l[0] !== looks[i - 1][0])
  const fl = flicks(uniq)
  const minutes = rows.length ? (rows.at(-1)[0] - rows[0][0]) / 60000 : 0
  // Clicks per second inside bursts of hitting (gaps under 1.5 s).
  let burst = []
  const cps = []
  for (const t of hits) {
    if (burst.length && t - burst.at(-1) > 1500) { if (burst.length >= 3) cps.push((burst.length - 1) / ((burst.at(-1) - burst[0]) / 1000)); burst = [] }
    burst.push(t)
  }
  if (burst.length >= 3) cps.push((burst.length - 1) / ((burst.at(-1) - burst[0]) / 1000))
  const out = { minutes: round(minutes, 1), flicks: fl.length, hits: hits.length }
  if (fl.length >= 15) {
    const { a, b } = fitts(fl)
    const subs = fl.reduce((s, f) => s + f.subs, 0) / fl.length
    const t60 = a + b * Math.log2(1 + 60 / 4)
    Object.assign(out, { a: round(a, 3), b: round(b, 3), t60: round(t60, 3), submovements: round(subs, 2), aimSkill: skillFor(t60), peakSpeed: round(median(fl.map((f) => f.peak)), 0) })
  }
  if (cps.length) out.cps = round(median(cps), 1)
  if (hits.length >= 10) out.strafeWhileHitting = round(strafeHits / hits.length, 2)
  if (keyRows) { out.sprintShare = round(sprintRows / keyRows, 2); out.jumpsPerMinute = minutes ? round(jumps / minutes, 1) : null }
  return out
}

/**
 * Measured turning time → the bot's aim skill. The analysis is run on flicks made by the bot's own mouse model
 * (look.js) at skills 0 … 1, so the same measuring (with its 20-samples-a-second blur) is compared like for like:
 * the time a 60° turn takes, which grows steadily as skill drops.
 */
let CAL = null
function calibration () {
  if (CAL) return CAL
  const { planFlick } = require('../look')
  CAL = []
  for (let k = 0; k <= 10; k++) {
    const skill = k / 10
    let seed = 11
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const orig = Math.random
    Math.random = rnd
    const looks = []
    let t = 0
    let yaw = 0
    let pitch = 0
    try {
      for (let i = 0; i < 100; i++) {
        const ty = yaw + (rnd() < 0.5 ? -1 : 1) * (15 + rnd() * 120) * Math.PI / 180
        const tp = Math.max(-1.2, Math.min(1.2, (rnd() - 0.5) * Math.PI / 3))
        for (const [y, p] of planFlick(yaw, pitch, ty, tp, skill, 1, { react: false })) { t += 50; looks.push([t, y * 180 / Math.PI, p * 180 / Math.PI]) }
        yaw = ty; pitch = tp
        for (let j = 0; j < 8; j++) { t += 50; looks.push([t, yaw * 180 / Math.PI, pitch * 180 / Math.PI]) }
      }
    } finally { Math.random = orig }
    const { a, b } = fitts(flicks(looks))
    CAL.push([skill, a + b * Math.log2(1 + 60 / 4)])
  }
  return CAL
}

function skillFor (t60) {
  const cal = calibration() // t60 falls as skill rises
  if (t60 >= cal[0][1]) return 0
  if (t60 <= cal.at(-1)[1]) return 1
  for (let i = 1; i < cal.length; i++) {
    const [s0, t0] = cal[i - 1]
    const [s1, t1] = cal[i]
    if (t60 <= t0 && t60 >= t1) return round(s0 + (s1 - s0) * (t0 - t60) / (t0 - t1 || 1), 2)
  }
  return 0.5
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

function main () {
  const given = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const files = given.length ? given : fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(DIR, f)) : []
  if (!files.length) { console.log('No recordings yet: play through npm run record first.'); process.exit(1) }
  const p = analyze(load(files))
  console.log(`${p.minutes} minutes, ${p.flicks} flicks, ${p.hits} hits`)
  if (p.a !== undefined) {
    console.log(`Turning: a 60° turn takes you about ${Math.round(p.t60 * 1000)} ms (first movement), ${p.submovements} movements per turn, peak ${p.peakSpeed}°/s.`)
    console.log(`That aims like a bot with skill ${p.aimSkill} (0 beginner … 1 the best).`)
  } else console.log('Not enough turns yet to measure your aim (it needs ~15): play a bit longer, ideally some fighting.')
  if (p.cps) console.log(`Hitting: ${p.cps} clicks per second${p.strafeWhileHitting !== undefined ? `, strafing on ${Math.round(p.strafeWhileHitting * 100)}% of hits` : ''}.`)
  if (p.sprintShare !== undefined) console.log(`Moving: sprinting ${Math.round(p.sprintShare * 100)}% of the time, ${p.jumpsPerMinute} jumps a minute.`)
  const file = path.join(DIR, 'profile.json')
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(p, null, 2) + '\n')
  console.log(`Saved ${file}`)
  if (p.a !== undefined) console.log('To make the bot aim like you:  npm run set -- behavior.aimProfile data/training/motion/profile.json')
}

if (require.main === module) main()

module.exports = { analyze, flicks, fitts, skillFor }
