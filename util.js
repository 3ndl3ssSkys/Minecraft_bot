'use strict'

/** Small helpers shared by actions.js, combat.js and building.js. */

/** An expected, explainable failure. `code` is machine-readable for the LLM. */
class ActionError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'ActionError'
    this.code = code
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function abortError (signal) {
  const reason = typeof signal?.reason === 'string' ? signal.reason : 'cancelled'
  return new ActionError('ABORTED', `Action was interrupted (${reason}).`)
}

function throwIfAborted (signal) {
  if (signal?.aborted) throw abortError(signal)
}

/** Sleep that rejects as soon as the signal aborts. */
function abortableSleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort () {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** "Oak Log" / "minecraft:oak_log" / "oak log" -> "oak_log" */
function normalizeName (name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_')
}

function fmtPos (v) {
  return `(${Math.floor(v.x)}, ${Math.floor(v.y)}, ${Math.floor(v.z)})`
}

/** Deterministic PRNG (mulberry32) so a building design can be regenerated from its seed. */
function seededRandom (seed) {
  let a = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 2654435761) >>> 0, 1779033703)
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

module.exports = { ActionError, sleep, abortError, throwIfAborted, abortableSleep, normalizeName, fmtPos, seededRandom }
