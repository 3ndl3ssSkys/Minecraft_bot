'use strict'
// Run with: npm test   (or node test/svc.test.js)
// Covers: Simple Voice Chat — the secret handshake over plugin channels, the encrypted UDP protocol (authenticate,
// connection check with the nonce, keep-alive), hearing a player (Opus → an utterance as WAV) and speaking (WAV → Opus
// mic packets in real time), against a fake voice server written from the mod's source.
const path = require('path')
const dgram = require('dgram')
const crypto = require('crypto')
const assert = require('assert')
const { EventEmitter } = require('events')
const svc = require(path.join(__dirname, '..', 'svc.js'))
const { VoiceChat, Writer, Reader, encrypt, decrypt, parseSecret, ID } = svc
const OpusScript = require('opusscript')

;(async () => {
  // --- byte formats ---
  const uuid = '12345678-9abc-def0-1234-56789abcdef0'
  const r = new Reader(new Writer().uuid(uuid).varint(300).utf('héllo').long(7).int(-2).done())
  assert.equal(r.uuid(), uuid)
  assert.equal(r.varint(), 300)
  assert.equal(r.utf(), 'héllo')
  assert.equal(r.long(), 7n)
  assert.equal(r.int(), -2)
  const key = crypto.randomBytes(16)
  assert.deepEqual(decrypt(key, encrypt(key, Buffer.from('secret stuff'))), Buffer.from('secret stuff'))

  // --- a fake voice server ---
  const connectionId = crypto.randomUUID()
  const owner = crypto.randomUUID()
  const server = dgram.createSocket('udp4')
  await new Promise((res) => server.bind(0, '127.0.0.1', res))
  const port = server.address().port
  const nonce = crypto.randomBytes(16)
  const got = { auth: 0, check: 0, keepAlive: 0, mic: [] }
  let client = null
  const toClient = (type, body = Buffer.alloc(0)) => {
    const enc = encrypt(key, Buffer.concat([Buffer.from([type]), body]))
    server.send(new Writer().byte(0xff).byteArray(enc).done(), client.port, client.address)
  }
  server.on('message', (m, rinfo) => {
    const rd = new Reader(m)
    assert.equal(rd.byte(), 0xff)
    assert.equal(rd.uuid(), connectionId, 'the client names its connection')
    const plain = new Reader(decrypt(key, rd.byteArray()))
    const type = plain.byte()
    client = rinfo
    if (type === ID.auth) { got.auth++; toClient(ID.authAck, nonce) }
    if (type === ID.check) { got.check++; assert.deepEqual(Buffer.from(plain.bytes(16)), nonce, 'the nonce comes back'); toClient(ID.checkAck) }
    if (type === ID.keepAlive) got.keepAlive++
    if (type === ID.mic) got.mic.push({ data: Buffer.from(plain.byteArray()), seq: plain.long(), whisper: plain.bool(), at: Date.now() })
  })

  // --- the bot side, with a fake Minecraft connection ---
  const channelWrites = []
  const mc = new EventEmitter()
  // like minecraft-protocol: custom=true writes minecraft:register at once
  mc.registerChannel = (name, parser, custom) => { if (custom) mc.writeChannel('minecraft:register', [name]) }
  mc.writeChannel = (ch, data) => channelWrites.push({ ch, data })
  const bot = new EventEmitter()
  bot._client = mc
  bot.players = { EndlessSkys: { username: 'EndlessSkys', uuid: owner } }
  const logs = []
  const agent = { bot, config: { svc: { enabled: 'auto' }, server: { host: '127.0.0.1' } }, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } }
  const vc = new VoiceChat(agent)
  vc.attach(bot)
  // nothing may go out before login: a packet during the handshake makes real servers drop the connection
  assert.equal(channelWrites.length, 0, 'no packets before login')
  bot.emit('login')
  assert.deepEqual(channelWrites.shift(), { ch: 'minecraft:register', data: ['voicechat:secret'] }, 'channel announced after login')
  // the server announces the mod; the bot asks for its secret
  mc.emit('custom_payload', { channel: 'minecraft:register', data: Buffer.from('voicechat:secret\0voicechat:player_state') })
  await new Promise((res) => setTimeout(res, 1700))
  const ask = channelWrites.find((w) => w.ch === 'voicechat:request_secret')
  assert.ok(ask, 'asked for the secret')
  assert.equal(new Reader(ask.data).int(), 21, 'with its compatibility version')
  // the server's answer (SecretPacket layout)
  const secret = new Writer().bytes(key).uuid(connectionId).int(port).uuid(crypto.randomUUID()).byte(0).int(1024).double(48).int(1000).bool(true).utf('127.0.0.1').bool(false).done()
  assert.equal(parseSecret(secret).port, port)
  mc.emit('voicechat:secret', secret)
  await new Promise((res) => vc.once('connected', res))
  assert.ok(vc.connected())
  assert.ok(got.auth >= 1 && got.check === 1)
  assert.ok(channelWrites.some((w) => w.ch === 'voicechat:client_state'), 'told the server it is not muted')
  toClient(ID.keepAlive)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(got.keepAlive, 1, 'keep-alives are echoed')

  // --- hearing: the owner says something for a second, then pauses ---
  const enc = new OpusScript(48000, 1, OpusScript.Application.VOIP)
  const frame = (i) => { const b = Buffer.alloc(1920); for (let k = 0; k < 960; k++) b.writeInt16LE(Math.round(Math.sin((i * 960 + k) / 48000 * 2 * Math.PI * 300) * 9000), k * 2); return enc.encode(b, 960) }
  const heard = new Promise((res) => vc.once('utterance', res))
  for (let i = 0; i < 50; i++) {
    toClient(ID.playerSound, new Writer().uuid(owner).uuid(owner).byteArray(frame(i)).long(i).bytes(Buffer.alloc(4)).byte(0).done())
    await new Promise((res) => setTimeout(res, 5))
  }
  const u = await heard
  assert.equal(u.name, 'EndlessSkys')
  assert.ok(u.seconds > 0.9 && u.seconds < 1.1, `${u.seconds}s`)
  assert.equal(u.wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(u.wav.readUInt32LE(24), 16000, '16 kHz for Whisper')

  // --- speaking: a half-second WAV (24 kHz, like Kokoro) → 25 Opus frames, in real time, then an empty end packet ---
  const n = 12000
  const wav = Buffer.alloc(44 + n * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40)
  for (let k = 0; k < n; k++) wav.writeInt16LE(Math.round(Math.sin(k / 24000 * 2 * Math.PI * 220) * 8000), 44 + k * 2)
  const t0 = Date.now()
  await vc.play(wav)
  await new Promise((res) => setTimeout(res, 100))
  const took = Date.now() - t0
  const audio = got.mic.filter((m) => m.data.length)
  assert.equal(audio.length, 25, `${audio.length} frames`)
  assert.equal(got.mic.at(-1).data.length, 0, 'an empty packet ends the talking')
  assert.ok(took >= 450 && took < 900, `real time: ${took} ms for 0.5 s`)
  assert.deepEqual(audio.map((m) => Number(m.seq)), [...Array(25).keys()], 'numbered in order')
  const dec = new OpusScript(48000, 1)
  assert.equal(dec.decode(audio[5].data).length, 1920, 'a real 20 ms Opus frame')
  vc.detach()
  server.close()
  console.log(`connected, heard ${u.seconds.toFixed(2)}s from ${u.name}, spoke 0.5 s as ${audio.length} frames in ${took} ms`)
  console.log('All voice chat checks passed')
})().catch((err) => { console.error(err); process.exit(1) })
