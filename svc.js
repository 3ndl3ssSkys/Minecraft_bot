'use strict'

/**
 * svc.js — the bot in Simple Voice Chat (the proximity voice mod/plugin by henkelmax): it talks out loud next to
 * players and hears what they say, like any player with a microphone.
 *
 * How the mod works (from its source, compatibility version 21, mod 2.6/2.7):
 *   1. Over the Minecraft connection (plugin channels): the client sends voicechat:request_secret (its compatibility
 *      version); the server answers voicechat:secret with a 16-byte AES key, a connection id, the UDP port and host,
 *      the codec and the MTU. The client also tells voicechat:client_state that it isn't muted or disabled.
 *   2. Over UDP: every packet is 0xFF + (to the server) the connection id + a length-prefixed payload encrypted with
 *      AES-128-GCM (12-byte IV first, 16-byte tag). Inside: a packet id and its fields.
 *      Authenticate (5) → AuthenticateAck (6) with a nonce → ConnectionCheck (9) with that nonce → ConnectionCheckAck (10).
 *      KeepAlive (8) is echoed. Mic (1): Opus frames (48 kHz mono, 20 ms) with a sequence number.
 *      Players' voices arrive as PlayerSound (2), Group (3) or Location (4) packets.
 *
 * Speaking needs a TTS server (voice.tts "server": Kokoro); hearing needs a Whisper server (voice.stt "server").
 * Opus comes from opusscript (WebAssembly, no native build).
 */

const dgram = require('dgram')
const crypto = require('crypto')
const { EventEmitter } = require('events')

const MAGIC = 0xff
const RATE = 48000
const FRAME = 960 // 20 ms
const ID = { mic: 1, playerSound: 2, groupSound: 3, locationSound: 4, auth: 5, authAck: 6, ping: 7, keepAlive: 8, check: 9, checkAck: 10 }

// --- Minecraft's FriendlyByteBuf, the parts the mod uses -------------------------------------------------------------
class Writer {
  constructor () { this.parts = [] }
  byte (v) { this.parts.push(Buffer.from([v & 0xff])); return this }
  bool (v) { return this.byte(v ? 1 : 0) }
  int (v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.parts.push(b); return this }
  long (v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); this.parts.push(b); return this }
  float (v) { const b = Buffer.alloc(4); b.writeFloatBE(v); this.parts.push(b); return this }
  double (v) { const b = Buffer.alloc(8); b.writeDoubleBE(v); this.parts.push(b); return this }
  varint (v) { const out = []; let n = v >>> 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b) } while (n); this.parts.push(Buffer.from(out)); return this }
  bytes (buf) { this.parts.push(Buffer.from(buf)); return this }
  byteArray (buf) { return this.varint(buf.length).bytes(buf) }
  uuid (u) { this.parts.push(Buffer.from(u.replace(/-/g, ''), 'hex')); return this }
  utf (s) { return this.byteArray(Buffer.from(String(s), 'utf8')) }
  done () { return Buffer.concat(this.parts) }
}
class Reader {
  constructor (buf) { this.b = buf; this.o = 0 }
  byte () { return this.b.readUInt8(this.o++) }
  bool () { return this.byte() !== 0 }
  int () { const v = this.b.readInt32BE(this.o); this.o += 4; return v }
  long () { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v }
  float () { const v = this.b.readFloatBE(this.o); this.o += 4; return v }
  double () { const v = this.b.readDoubleBE(this.o); this.o += 8; return v }
  varint () { let n = 0; let s = 0; let b; do { b = this.byte(); n |= (b & 0x7f) << s; s += 7 } while (b & 0x80); return n >>> 0 }
  bytes (n) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v }
  byteArray () { return this.bytes(this.varint()) }
  uuid () { const h = this.bytes(16).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` }
  utf () { return this.byteArray().toString('utf8') }
}

function encrypt (key, data) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-128-gcm', key, iv)
  const enc = Buffer.concat([c.update(data), c.final()])
  return Buffer.concat([iv, enc, c.getAuthTag()])
}
function decrypt (key, payload) {
  const iv = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const d = crypto.createDecipheriv('aes-128-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(payload.subarray(12, payload.length - 16)), d.final()])
}

/** The SecretPacket (voicechat:secret). */
function parseSecret (buf) {
  const r = new Reader(buf)
  const secret = Buffer.from(r.bytes(16))
  const connectionId = r.uuid()
  const port = r.int()
  const playerUuid = r.uuid()
  const codec = r.byte()
  const mtu = r.int()
  const distance = r.double()
  const keepAlive = r.int()
  const groups = r.bool()
  const host = r.utf()
  const recording = r.bool()
  return { secret, connectionId, port, playerUuid, codec, mtu, distance, keepAlive, groups, host, recording }
}

/** A voice packet from the server: { type, ...fields } (sound packets carry Opus data and a sender UUID). */
function parseServerPacket (key, msg) {
  const r0 = new Reader(msg)
  if (r0.byte() !== MAGIC) return null
  const plain = decrypt(key, r0.byteArray())
  const r = new Reader(plain)
  const type = r.byte()
  switch (type) {
    case ID.authAck: return { type: 'authAck', nonce: Buffer.from(r.bytes(16)) }
    case ID.checkAck: return { type: 'checkAck' }
    case ID.keepAlive: return { type: 'keepAlive' }
    case ID.ping: return { type: 'ping', id: r.uuid(), timestamp: r.long() }
    case ID.playerSound: case ID.groupSound: {
      const channelId = r.uuid()
      const sender = r.uuid()
      const data = Buffer.from(r.byteArray())
      const seq = r.long()
      const distance = type === ID.playerSound ? r.float() : null
      return { type: type === ID.playerSound ? 'playerSound' : 'groupSound', channelId, sender, data, seq, distance }
    }
    case ID.locationSound: {
      const channelId = r.uuid()
      const sender = r.uuid()
      const location = { x: r.double(), y: r.double(), z: r.double() }
      const data = Buffer.from(r.byteArray())
      const seq = r.long()
      return { type: 'locationSound', channelId, sender, location, data, seq, distance: r.float() }
    }
    default: return { type: `unknown:${type}` }
  }
}

/** A client → server packet. */
function buildClientPacket (key, connectionId, type, body = Buffer.alloc(0)) {
  const enc = encrypt(key, Buffer.concat([Buffer.from([type]), body]))
  return new Writer().byte(MAGIC).uuid(connectionId).byteArray(enc).done()
}

/** Resample 16-bit mono PCM to 48 kHz (linear). */
function to48k (pcm, rate) {
  if (rate === RATE) return pcm
  const n = Math.floor(pcm.length * RATE / rate)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * rate / RATE
    const a = Math.floor(x)
    const f = x - a
    out[i] = (pcm[a] ?? 0) * (1 - f) + (pcm[Math.min(a + 1, pcm.length - 1)] ?? 0) * f
  }
  return out
}

/** Read a 16-bit PCM WAV (mono or stereo) → { pcm: Int16Array (mono), rate }. */
function readWav (buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV')
  let o = 12
  let fmt = null
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4)
    const size = buf.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) }
    if (id === 'data' && fmt) {
      const data = buf.subarray(o + 8, o + 8 + size)
      const frames = Math.floor(data.length / 2 / fmt.channels)
      const pcm = new Int16Array(frames)
      for (let i = 0; i < frames; i++) pcm[i] = data.readInt16LE(i * 2 * fmt.channels)
      return { pcm, rate: fmt.rate }
    }
    o += 8 + size + (size % 2)
  }
  throw new Error('no audio in the WAV')
}

/** 16-bit PCM at 48 kHz → a 16 kHz mono WAV (for Whisper). */
function toWav16k (pcm48) {
  const n = Math.floor(pcm48.length / 3)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24)
  buf.writeUInt32LE(32000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(pcm48[i * 3], 44 + i * 2)
  return buf
}

class VoiceChat extends EventEmitter {
  /**
   * @param {object} agent
   * opts: config (agent.config.svc) is read live
   */
  constructor (agent) {
    super()
    this.agent = agent
    this.state = 'off' // off | requesting | authenticating | checking | connected
    this.seq = 0n
    this.listeners = new Map() // sender uuid → { frames: [Int16Array], last, decoder }
    this.queue = Promise.resolve()
    this.speakingUntil = 0
  }

  get cfg () { return this.agent.config.svc || {} }
  get bot () { return this.agent.bot }
  connected () { return this.state === 'connected' }

  /** Hook into a new Minecraft connection: ask for the secret when the server has the mod. */
  attach (bot) {
    this.detach()
    if (this.cfg.enabled === false) return
    const client = bot._client
    for (const ch of ['voicechat:request_secret', 'voicechat:client_state']) client.registerChannel(ch, ['restBuffer', []], false)
    client.registerChannel('voicechat:secret', ['restBuffer', []], true)
    const onSecret = (data) => { try { this.onSecret(Buffer.from(data)) } catch (err) { this.agent.log.warn(`Voice chat: bad secret packet (${err.message})`) } }
    client.on('voicechat:secret', onSecret)
    // The server lists its channels in minecraft:register when the mod is installed.
    const onPayload = (p) => {
      if (/register/.test(p.channel) && Buffer.from(p.data || []).toString('utf8').includes('voicechat:secret')) this.requestSoon(1500)
    }
    client.on('custom_payload', onPayload)
    if (this.cfg.enabled === true) bot.once('spawn', () => this.requestSoon(4000)) // forced on: ask even if the server didn't announce it
    this.cleanup = () => { client.removeListener('voicechat:secret', onSecret); client.removeListener('custom_payload', onPayload) }
    bot.once('end', () => this.detach())
  }

  requestSoon (ms) {
    if (this.state !== 'off' || this.requestTimer) return
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null
      if (this.state !== 'off' || !this.bot?._client) return
      this.state = 'requesting'
      try {
        this.bot._client.writeChannel('voicechat:request_secret', new Writer().int(this.cfg.compatibilityVersion ?? 21).done())
        this.agent.log.info('Voice chat: the server has Simple Voice Chat, asking to join it.')
      } catch (err) { this.state = 'off'; this.agent.log.warn(`Voice chat: could not ask (${err.message})`) }
      setTimeout(() => { if (this.state === 'requesting') { this.state = 'off'; this.agent.log.warn('Voice chat: no answer (an incompatible version? set svc.compatibilityVersion)') } }, 8000).unref?.()
    }, ms)
  }

  detach () {
    clearTimeout(this.requestTimer); this.requestTimer = null
    clearInterval(this.authTimer); clearInterval(this.flushTimer)
    this.cleanup?.(); this.cleanup = null
    try { this.sock?.close() } catch {}
    this.sock = null
    for (const l of this.listeners.values()) try { l.decoder?.delete() } catch {}
    this.listeners.clear()
    try { this.encoder?.delete() } catch {}
    this.encoder = null
    if (this.state !== 'off') this.emit('disconnected')
    this.state = 'off'
  }

  /** The server sent the key and where to connect: open the UDP socket and authenticate. */
  onSecret (buf) {
    const s = parseSecret(buf)
    this.info = s
    const host = s.host && !/^0\.0\.0\.0$|^$/.test(s.host) ? s.host.replace(/:\d+$/, '') : this.agent.config.server.host
    const port = /:\d+$/.test(s.host || '') ? Number(s.host.split(':').pop()) : s.port
    this.target = { host, port }
    try { this.bot._client.writeChannel('voicechat:client_state', new Writer().bool(false).bool(false).done()) } catch {} // not muted, not disabled
    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (m) => this.onUdp(m))
    this.sock.on('error', (err) => this.agent.log.warn(`Voice chat UDP: ${err.message}`))
    this.state = 'authenticating'
    const auth = () => { if (this.state === 'authenticating') this.send(ID.auth) }
    auth()
    clearInterval(this.authTimer)
    this.authTimer = setInterval(() => { if (this.state === 'authenticating' || this.state === 'checking') auth() }, 1000)
    clearInterval(this.flushTimer)
    this.flushTimer = setInterval(() => this.flushListeners(), 150)
    this.agent.log.info(`Voice chat: connecting to ${host}:${port}`)
  }

  send (type, body) {
    if (!this.sock || !this.info) return
    const pkt = buildClientPacket(this.info.secret, this.info.connectionId, type, body)
    this.sock.send(pkt, this.target.port, this.target.host)
  }

  onUdp (msg) {
    let p
    try { p = parseServerPacket(this.info.secret, msg) } catch { return }
    if (!p) return
    if (p.type === 'authAck') {
      if (this.state === 'authenticating') this.state = 'checking'
      this.send(ID.check, p.nonce)
    } else if (p.type === 'checkAck') {
      if (this.state !== 'connected') {
        this.state = 'connected'
        clearInterval(this.authTimer)
        this.agent.log.info('Voice chat: connected. It can talk and listen in proximity voice now.')
        this.emit('connected')
      }
    } else if (p.type === 'keepAlive') {
      this.send(ID.keepAlive)
    } else if (p.type === 'ping') {
      this.send(ID.ping, new Writer().uuid(p.id).long(p.timestamp).done())
    } else if (/Sound$/.test(p.type)) {
      this.onSound(p)
    }
  }

  // --------------------------------------------------------------------------------------------------------------
  // Hearing: collect each speaker's audio until they pause, then turn it into text
  // --------------------------------------------------------------------------------------------------------------

  decoderFor (sender) {
    let l = this.listeners.get(sender)
    if (!l) {
      const Opus = loadOpus()
      l = { frames: [], last: 0, decoder: Opus ? new Opus(RATE, 1) : null, type: null, distance: null }
      this.listeners.set(sender, l)
    }
    return l
  }

  onSound (p) {
    if (Date.now() < this.speakingUntil + 300) return // its own voice coming back, or talking over itself
    const l = this.decoderFor(p.sender)
    l.type = p.type
    l.distance = p.distance
    if (!p.data.length) { this.finishUtterance(p.sender, l); return } // an empty packet: they stopped talking
    if (!l.decoder) return
    try {
      const pcm = l.decoder.decode(p.data)
      const f = new Int16Array(pcm.length >> 1)
      for (let i = 0; i < f.length; i++) f[i] = pcm.readInt16LE(i * 2)
      l.frames.push(f)
      l.last = Date.now()
    } catch { /* a bad frame */ }
  }

  flushListeners () {
    const now = Date.now()
    for (const [sender, l] of this.listeners) if (l.frames.length && now - l.last > (this.cfg.silenceMs ?? 700)) this.finishUtterance(sender, l)
  }

  finishUtterance (sender, l) {
    const frames = l.frames
    l.frames = []
    const samples = frames.reduce((a, f) => a + f.length, 0)
    if (samples < RATE * 0.4) return // a cough
    const pcm = new Int16Array(samples)
    let o = 0
    for (const f of frames) { pcm.set(f, o); o += f.length }
    const name = Object.values(this.bot?.players || {}).find((pl) => pl.uuid === sender)?.username || null
    this.emit('utterance', { sender, name, wav: toWav16k(pcm), seconds: samples / RATE, group: l.type === 'groupSound', distance: l.distance })
  }

  // --------------------------------------------------------------------------------------------------------------
  // Speaking: a WAV (from the TTS server) → 20 ms Opus frames, sent in real time
  // --------------------------------------------------------------------------------------------------------------

  /** Say a WAV in voice chat. Resolves when the last frame is out. */
  play (wavBuf) {
    const job = this.queue.then(() => this.playNow(wavBuf))
    this.queue = job.catch(() => {})
    return job
  }

  async playNow (wavBuf) {
    if (!this.connected()) return false
    const Opus = loadOpus()
    if (!Opus) { this.agent.log.warn('Voice chat: speaking needs opusscript (npm install).'); return false }
    const { pcm, rate } = readWav(wavBuf)
    const audio = to48k(pcm, rate)
    if (!this.encoder) this.encoder = new Opus(RATE, 1, this.info?.codec === 1 ? Opus.Application.AUDIO : Opus.Application.VOIP)
    const frames = Math.ceil(audio.length / FRAME)
    const start = Date.now()
    this.speakingUntil = start + frames * 20
    for (let i = 0; i < frames; i++) {
      if (!this.connected()) return false
      const chunk = new Int16Array(FRAME)
      chunk.set(audio.subarray(i * FRAME, (i + 1) * FRAME))
      const opus = this.encoder.encode(Buffer.from(chunk.buffer), FRAME)
      this.send(ID.mic, new Writer().byteArray(opus).long(this.seq++).bool(false).done())
      const due = start + (i + 1) * 20 - Date.now() // keep real time: a frame every 20 ms
      if (due > 0) await new Promise((r) => setTimeout(r, due))
    }
    this.send(ID.mic, new Writer().byteArray(Buffer.alloc(0)).long(this.seq++).bool(false).done()) // end of talking
    return true
  }
}

let OpusCache
function loadOpus () {
  if (OpusCache !== undefined) return OpusCache
  try { OpusCache = require('opusscript') } catch { OpusCache = null }
  return OpusCache
}

module.exports = { VoiceChat, Writer, Reader, encrypt, decrypt, parseSecret, parseServerPacket, buildClientPacket, readWav, to48k, toWav16k, ID, FRAME, RATE }
