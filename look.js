'use strict'

/**
 * look.js — turn the head like a person, not a turret.
 *
 * Mineflayer sets the new yaw/pitch in one tick, so every look is an instant snap (other players see the head
 * teleport, and the browser view jerks). This wraps bot.look so a big turn is spread over a few ticks: fast at the
 * start, easing in at the end, quicker for better players (`speed()` in degrees per tick at most).
 *
 * Left instant on purpose: `force` looks (aiming a block placement, a pearl, a water bucket: reflexes and skills
 * pass force = true), anything while `skip()` says so (walking a path, fighting, a reflex), and small corrections.
 * `adjust(yaw, pitch)` can change where it looks first (motion.js: not into an enderman's eyes).
 */

const TAU = Math.PI * 2
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
const MIN_STEP = 4 * Math.PI / 180 // the last few degrees take no longer than a tick

function installSmoothLook (bot, { speed = () => 40, enabled = () => true, skip = () => false, adjust = null } = {}) {
  if (bot._smoothLook) return bot._smoothLook
  const raw = bot.look
  let job = null

  const finish = () => {
    if (!job) return
    const j = job
    job = null
    j.resolve()
  }

  const step = () => {
    if (!job || !bot.entity) return finish()
    const max = Math.max(MIN_STEP, speed() * Math.PI / 180)
    const dy = wrap(job.yaw - bot.entity.yaw)
    const dp = job.pitch - bot.entity.pitch
    const left = Math.max(Math.abs(dy), Math.abs(dp))
    if (left <= MIN_STEP) {
      raw.call(bot, job.yaw, job.pitch, false).catch(() => {})
      return finish()
    }
    // Ease: cover about half of what is left each tick, never more than the skill allows.
    const f = Math.min(1, Math.max(MIN_STEP, Math.min(max, left * 0.55)) / left)
    raw.call(bot, bot.entity.yaw + dy * f, bot.entity.pitch + dp * f, false).catch(() => {})
  }

  bot.on('physicsTick', () => { if (job) step() })

  bot.look = function (yaw, pitch, force) {
    finish() // a new look replaces the one under way (as Mineflayer does)
    if (adjust) { try { [yaw, pitch] = adjust(yaw, pitch) } catch { /* keep it */ } } // e.g. never into an enderman's eyes
    if (!bot.entity || force || !enabled() || safe(skip)) return raw.call(bot, yaw, pitch, force)
    const left = Math.max(Math.abs(wrap(yaw - bot.entity.yaw)), Math.abs(pitch - bot.entity.pitch))
    if (left <= Math.max(MIN_STEP, speed() * Math.PI / 180)) return raw.call(bot, yaw, pitch, force)
    return new Promise((resolve) => {
      job = { yaw, pitch, resolve }
      setTimeout(() => { if (job?.resolve === resolve) finish() }, 1500).unref?.() // physics stops on death: never hang
    })
  }

  bot._smoothLook = { raw, busy: () => Boolean(job), cancel: finish }
  return bot._smoothLook
}

/** Degrees per tick at most, from the movement/survival skill (0..1): ~25°/tick for a beginner, ~70° for the best. */
function turnSpeed (skill) {
  return Math.round(25 + 45 * Math.max(0, Math.min(1, skill || 0)))
}

function safe (fn) { try { return fn() } catch { return false } }

module.exports = { installSmoothLook, turnSpeed, wrap }
