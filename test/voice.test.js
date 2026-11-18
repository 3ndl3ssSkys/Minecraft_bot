'use strict'
// Run with: npm test   (or node test/voice.test.js)
// Covers: talking to it out loud — wake words and conversations, "show me" turning into an explanation, speaking in
// order and waiting for the page, the Whisper and TTS server formats, and planned walkthrough steps.
const path = require('path')
const http = require('http')
const assert = require('assert')
const { Voice, SHOW_ME } = require(path.join(__dirname, '..', 'voice.js'))
const { cleanSteps } = require(path.join(__dirname, '..', 'explain.js'))

const events = []
const heardMsgs = []
const queued = []
const agent = {
  config: { voice: { enabled: true, requireWakeWord: true, conversationSeconds: 30 }, behavior: { owners: ['EndlessSkys'] } },
  personality: { name: 'Wanda', nicknames: ['wan'] },
  bot: { username: 'TheBestWanderer', entity: {} },
  log: { info () {}, warn () {} },
  viewer: { server: true, broadcast: (e, d) => events.push({ e, d }), push () {} },
  responder: { onMessage: (who, text, o) => heardMsgs.push({ who, text, o }) },
  executor: { availableTools: () => ['explainAndShow'], abort () {} },
  brain: { queueAction: (a) => queued.push(a) }
}

;(async () => {
  const v = new Voice(agent)
  assert.equal(v.active(), false, 'no page open yet')
  v.hello('p1', 'hands-free')
  assert.equal(v.active(), true)

  // --- hands-free: only when it hears its name, then a short conversation ---
  assert.equal(v.heard('i need more wood').ok, false, 'talking to someone else')
  assert.equal(heardMsgs.length, 0)
  assert.equal(v.heard('hey Wanda, come here').ok, true)
  assert.deepEqual(heardMsgs.at(-1), { who: 'EndlessSkys', text: 'come here', o: { whisper: true, voice: true } })
  assert.equal(v.heard('and bring the iron').ok, true, 'mid-conversation: no name needed')
  v.openUntil = 0
  assert.equal(v.heard('bring the iron').ok, false, 'conversation over')
  assert.equal(v.heard('bring the iron', { ptt: true }).ok, true, 'push-to-talk is always for it')

  // --- "show me how" → explain while doing it ---
  assert.ok(SHOW_ME.test('show me how to make a furnace'))
  assert.ok(SHOW_ME.test('how do i make a piston door'))
  assert.ok(!SHOW_ME.test('come here'))
  v.heard('TheBestWanderer show me how to make a furnace')
  assert.equal(queued.at(-1).name, 'explainAndShow')
  assert.match(queued.at(-1).args.topic, /furnace/)

  // --- speaking: one line at a time, waits for the page (or a time estimate) ---
  events.length = 0
  const a = v.say('first line')
  const b = v.say('second line')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(events.filter((x) => x.e === 'speak').length, 1, 'the second waits for the first')
  v.spoken(events[0].d.id)
  await a
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(events.filter((x) => x.e === 'speak').length, 2)
  v.spoken(events[1].d.id)
  assert.equal(await b, 'second line')

  // --- server engines (OpenAI-compatible formats) ---
  const seen = {}
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url === '/v1/audio/speech') { seen.tts = JSON.parse(body); res.setHeader('content-type', 'audio/mpeg'); return res.end(Buffer.from('ID3fakeaudio')) }
      if (req.url === '/v1/audio/transcriptions') { seen.stt = { type: req.headers['content-type'], hasFile: body.includes('filename="speech.webm"'), hasModel: body.includes('whisper-1') }; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ text: ' hello there ' })) }
      res.statusCode = 404; res.end()
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  agent.config.voice = { ...agent.config.voice, tts: 'server', ttsUrl: `http://127.0.0.1:${port}/v1/audio/speech`, ttsVoice: 'af_bella', sttUrl: `http://127.0.0.1:${port}/v1/audio/transcriptions` }
  events.length = 0
  const c = v.say('from the server')
  await new Promise((r) => setTimeout(r, 300))
  const sp = events.find((x) => x.e === 'speak')
  assert.equal(seen.tts.input, 'from the server')
  assert.equal(seen.tts.voice, 'af_bella')
  assert.match(sp.d.audio, /^\/voice\/audio\/s\d+$/)
  assert.ok(v.audio.get(sp.d.id).buf.toString().startsWith('ID3'))
  v.spoken(sp.d.id)
  await c
  assert.equal(await v.transcribe(Buffer.from('fake webm'), 'audio/webm'), 'hello there')
  assert.ok(seen.stt.type.startsWith('multipart/form-data') && seen.stt.hasFile && seen.stt.hasModel)
  srv.close()

  // --- walkthrough steps from the model are cleaned up ---
  const steps = cleanSteps({ steps: [
    { say: 'First, eight cobblestone.', action: { name: 'mineBlock', args: { blockType: 'stone', count: 8 } } },
    { say: 'Then the crafting table.', look: { x: 3, y: 64, z: -2 } },
    { say: 'And never this.', action: { name: 'attackTarget', args: { entityId: 4 } } },
    { say: '' }
  ] }, ['mineBlock', 'craftItem', 'attackTarget'])
  assert.equal(steps.length, 3)
  assert.equal(steps[0].action.name, 'mineBlock')
  assert.deepEqual(steps[1].look, { x: 3, y: 64, z: -2 })
  assert.equal(steps[2].action, null, 'no fighting in a demonstration')
  console.log('All voice checks passed')
})().catch((err) => { console.error(err); process.exit(1) })
