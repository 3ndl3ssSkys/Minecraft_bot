'use strict'

/**
 * explain.js — explaining something while showing it, like a friend walking you through it in the game.
 *
 * explainAndShow { topic }: the model plans a few short steps, each with what to say and (optionally) what to do and
 * where to look. For every step it says the line (out loud on the voice page, or privately in chat) while it does the
 * thing, looks at what it's talking about and outlines it in the viewer, and waits for both before the next step, so
 * the words and the actions stay in time.
 */

const { Vec3 } = require('vec3')

// What it may do while demonstrating: showing, not fighting or throwing things away.
const DEMO = new Set(['craftItem', 'mineBlock', 'placeBlock', 'moveToBlock', 'moveToPlayer', 'equipItem', 'smeltItem', 'useItem', 'activateBlock',
  'inspectRedstone', 'buildCircuit', 'emote', 'placeTorch', 'pillarUp', 'bridge', 'collectDrops', 'eatFood', 'sleepInBed', 'useHotbarItem', 'clickMenu', 'readSigns', 'wait'])

const STEPS_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          say: { type: 'string' },
          action: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } } },
          look: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } }
        },
        required: ['say']
      }
    }
  },
  required: ['steps']
}

/** Clean up what the model planned: at most 7 steps, real actions only, short lines. */
function cleanSteps (raw, allowed) {
  const steps = Array.isArray(raw?.steps) ? raw.steps : []
  return steps.slice(0, 7).map((s) => {
    const say = String(s?.say || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    const a = s?.action && typeof s.action === 'object' && DEMO.has(s.action.name) && allowed.includes(s.action.name) ? { name: s.action.name, args: s.action.args && typeof s.action.args === 'object' ? s.action.args : {} } : null
    const l = s?.look && [s.look.x, s.look.y, s.look.z].every((n) => Number.isFinite(Number(n))) ? { x: Number(s.look.x), y: Number(s.look.y), z: Number(s.look.z) } : null
    return { say, action: a, look: l }
  }).filter((s) => s.say)
}

function install (ACTIONS, h, SHORT = {}) {
  const { argString, ActionError, sleep } = h

  ACTIONS.explainAndShow = {
    description: 'Explain something step by step while showing it in the game (say a line, do or point at that part, then the next), e.g. when someone asks "how do I make a furnace" or "show me how this farm works".',
    params: { topic: 'string: what to explain' },
    async run (ctx, args) {
      const { bot } = ctx
      const topic = argString(args, 'topic', { maxLength: 300 })
      if (!ctx.planExplanation) throw new ActionError('UNSUPPORTED', 'Not available.')
      const allowed = ctx.tools ? ctx.tools() : Object.keys(ACTIONS)
      const steps = cleanSteps(await ctx.planExplanation(topic, [...DEMO].filter((n) => allowed.includes(n))), allowed)
      if (!steps.length) throw new ActionError('NO_PLAN', `Couldn't work out how to explain "${topic}".`)
      const owner = (ctx.config.behavior.owners || [])[0]
      const say = async (line) => (await ctx.voice?.speakTo(owner, line)) ?? ctx.chat.send(line, 'reply', { whisperTo: owner && bot.players[owner] ? owner : undefined })
      let shown = 0
      const notes = []
      for (const [i, s] of steps.entries()) {
        if (ctx.signal?.aborted) break
        const speaking = say(s.say)
        let doing = Promise.resolve()
        if (s.look) {
          const p = new Vec3(s.look.x, s.look.y, s.look.z)
          ctx.highlight?.(p)
          doing = bot.lookAt(p.offset(0.5, 0.5, 0.5)).catch(() => {})
        }
        if (s.action) {
          doing = doing.then(() => ACTIONS[s.action.name].run(ctx, s.action.args)).then(() => { shown++ }).catch((err) => {
            if (err?.code === 'ABORTED') throw err
            notes.push(`step ${i + 1} (${s.action.name}) didn't work: ${String(err?.message || err).slice(0, 80)}`)
          })
        }
        await Promise.all([speaking, doing]) // the words and the doing stay in time
        await sleep(350)
      }
      return `Explained "${topic}" in ${steps.length} steps (showed ${shown} in the game).${notes.length ? ` ${notes.join('; ')}.` : ''}`
    }
  }

  Object.assign(SHORT, { explainAndShow: 'explain something step by step while showing it in the game' })
}

module.exports = { install, cleanSteps, DEMO, STEPS_SCHEMA }
