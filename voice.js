'use strict'

/**
 * voice.js — talking with the bot out loud, through the browser page (works on any server, public or not, since
 * nothing goes through game chat).
 *
 * Open http(s)://<bot pc>:3007/voice on the PC you play on (or a phone with earbuds) and leave it open:
 *   - you speak → it hears you (the browser's own speech recognition, or a local Whisper server: voice.stt) →
 *     what you said reaches it as a private message from its owner
 *   - what it says to you is spoken on that page (the browser's voices, or a local TTS server: voice.tts), not typed
 *   - hands-free while you play: it answers when you say its name (voice.wakeWords); after that, for a short while,
 *     no name is needed, like a conversation. Push-to-talk on the page works without a name.
 *   - "show me / explain / how do I ..." → explainAndShow: it explains step by step out loud and does each step in
 *     the game as it says it, looking at and highlighting what it talks about
 *
 * Server engines are OpenAI-compatible endpoints (voice.sttUrl → /v1/audio/transcriptions, e.g. faster-whisper-server
 * or whisper.cpp's server; voice.ttsUrl → /v1/audio/speech, e.g. Kokoro-FastAPI or openedai-speech with Piper).
 * Browsers only allow the microphone on localhost or https: set viewer.https for other PCs on your network.
 */

const SHOW_ME = /\b(show me|explain|teach me|walk me through|how (do|does|did|would|can|should) (i|you|we|it|this|that)|how to)\b/i

class Voice {
  constructor (agent) {
    this.agent = agent
    this.clients = new Map() // id → { at, mode }
    this.queue = Promise.resolve()
    this.pending = new Map() // speech id → resolve
    this.audio = new Map() // speech id → { buf, type, at }
    this.seq = 0
    this.openUntil = 0 // a conversation is going: no wake word needed
  }

  get cfg () { return this.agent.config.voice || {} }

  /** A voice page is open and listening (it checks in every few seconds). */
  active () {
    if (this.cfg.enabled === false) return false
    const now = Date.now()
    for (const [id, c] of this.clients) if (now - c.at > 15000) this.clients.delete(id)
    return this.clients.size > 0
  }

  hello (id, mode) { this.clients.set(String(id || 'page'), { at: Date.now(), mode }) }

  /**
   * Say something out loud on the voice page. Resolves when it has been spoken (the page reports it), or after
   * about as long as saying it takes. One line at a time, in order.
   */
  say (text) {
    const line = String(text || '').trim()
    if (!line) return Promise.resolve(null)
    const job = this.queue.then(() => this.speakNow(line))
    this.queue = job.catch(() => {})
    return job
  }

  async speakNow (text) {
    const viewer = this.agent.viewer
    if (!this.active() || !viewer?.server) return null
    const id = `s${++this.seq}`
    let audio = null
    if (this.cfg.tts === 'server' && this.cfg.ttsUrl) {
      try {
        const res = await fetch(this.cfg.ttsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.cfg.ttsKey ? { Authorization: `Bearer ${this.cfg.ttsKey}` } : {}) },
          body: JSON.stringify({ model: this.cfg.ttsModel || 'tts-1', input: text, voice: this.cfg.ttsVoice || 'alloy', response_format: 'mp3', speed: this.cfg.rate || 1 }),
          signal: AbortSignal.timeout(20000)
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.audio.set(id, { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'audio/mpeg', at: Date.now() })
        audio = `/voice/audio/${id}`
      } catch (err) {
        this.agent.log.warn(`Text-to-speech server failed (${err.message}); using the browser's voice.`)
      }
    }
    for (const [k, v] of this.audio) if (Date.now() - v.at > 120000) this.audio.delete(k)
    const words = text.split(/\s+/).length
    const estimate = (words / 2.6 / (this.cfg.rate || 1)) * 1000 + 1200
    const done = new Promise((resolve) => {
      this.pending.set(id, resolve)
      setTimeout(() => { if (this.pending.delete(id)) resolve() }, estimate + 4000).unref?.()
    })
    viewer.broadcast('speak', { id, text, audio, rate: this.cfg.rate || 1, voiceName: this.cfg.browserVoice || '' })
    viewer.push('chat', `(says aloud) ${text}`)
    this.openUntil = Date.now() + (this.cfg.conversationSeconds ?? 30) * 1000
    await done
    return text
  }

  /** The page finished saying line `id`. */
  spoken (id) {
    const r = this.pending.get(id)
    if (r) { this.pending.delete(id); r() }
  }

  /** Names it answers to when you talk to it hands-free. */
  wakeWords () {
    const p = this.agent.personality || {}
    const extra = Array.isArray(this.cfg.wakeWords) ? this.cfg.wakeWords : []
    return [this.agent.bot?.username, p.name, ...(p.nicknames || []), ...extra].filter(Boolean).map((w) => String(w).toLowerCase())
  }

  /**
   * Something you said. ptt = push-to-talk (always for it). Returns what happened, for the page.
   */
  heard (raw, { ptt = false } = {}) {
    const agent = this.agent
    let text = String(raw || '').trim()
    if (!text) return { ok: false, why: 'nothing heard' }
    const lower = text.toLowerCase()
    const name = this.wakeWords().find((w) => w.length >= 2 && lower.includes(w))
    const open = Date.now() < this.openUntil
    if (!ptt && !open && !name && this.cfg.requireWakeWord !== false) return { ok: false, why: 'not for me (say my name)' }
    if (name) text = text.replace(new RegExp(`^(hey|hi|yo|ok|okay)?[\\s,]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s,!.?]*`, 'i'), '').trim() || text
    this.openUntil = Date.now() + (this.cfg.conversationSeconds ?? 30) * 1000
    const owner = agent.config.behavior.owners[0] || 'Owner'
    agent.viewer?.push('you', `(said) ${text}`)
    agent.log.info(`VOICE ${owner}: ${text}`)
    if (!agent.bot?.entity) return { ok: false, why: 'not in a world right now' }
    // "show me how..." → explain out loud while doing it
    if (SHOW_ME.test(text) && agent.executor?.availableTools().includes('explainAndShow')) {
      agent.brain.queueAction({ name: 'explainAndShow', args: { topic: text } }, `${owner} asked me to explain: ${text}`)
      agent.executor.abort('explaining something', { quiet: true })
      return { ok: true, what: 'explaining' }
    }
    agent.responder.onMessage(owner, text, { whisper: true, voice: true })
    return { ok: true, what: 'heard' }
  }

  /** Speech to text through a local Whisper server (OpenAI-compatible). */
  async transcribe (buf, type = 'audio/webm') {
    if (!this.cfg.sttUrl) throw new Error('voice.sttUrl is not set')
    const form = new FormData()
    form.append('file', new Blob([buf], { type }), type.includes('ogg') ? 'speech.ogg' : type.includes('wav') ? 'speech.wav' : 'speech.webm')
    form.append('model', this.cfg.sttModel || 'whisper-1')
    if (this.cfg.language) form.append('language', this.cfg.language)
    const res = await fetch(this.cfg.sttUrl, { method: 'POST', body: form, headers: this.cfg.sttKey ? { Authorization: `Bearer ${this.cfg.sttKey}` } : {}, signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const out = await res.json().catch(() => ({}))
    return String(out.text || '').trim()
  }

  /** What the page needs to know to set itself up. */
  settings () {
    return { stt: this.cfg.stt === 'server' && this.cfg.sttUrl ? 'server' : 'browser', tts: this.cfg.tts === 'server' && this.cfg.ttsUrl ? 'server' : 'browser', language: this.cfg.language || 'en-US', wakeWords: this.wakeWords(), rate: this.cfg.rate || 1, browserVoice: this.cfg.browserVoice || '', name: this.agent.bot?.username || 'the bot' }
  }
}

module.exports = { Voice, SHOW_ME }
