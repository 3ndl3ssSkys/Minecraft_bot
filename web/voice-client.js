/* Voice for the bot's pages (voice.html and the panel): listening, push-to-talk and speaking.
 * Speech recognition: the browser's own (Chrome/Edge) or the bot's Whisper server (voice.stt = 'server').
 * Speaking: the browser's voices, or audio from the bot's TTS server (voice.tts = 'server').
 * Usage: const v = new BotVoice({ q, log, state }); v.start('hands-free' | 'push-to-talk'); v.pttDown(); v.pttUp(); v.stop()
 */
(function () {
  'use strict'
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition

  class BotVoice {
    constructor ({ q = '', log = () => {}, state = () => {} } = {}) {
      this.q = q
      this.log = log
      this.state = state
      this.id = Math.random().toString(36).slice(2)
      this.mode = 'off'
      this.speaking = false
      this.settings = null
      this.voices = []
      if (window.speechSynthesis) {
        const load = () => { this.voices = window.speechSynthesis.getVoices() }
        load()
        window.speechSynthesis.onvoiceschanged = load
      }
    }

    url (p) { return p + (this.q ? (p.includes('?') ? '&' : '?') + this.q.slice(1) : '') }
    post (p, body) { return fetch(this.url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({})) }

    async start (mode) {
      this.settings = await fetch(this.url('/voice/settings')).then((r) => r.json()).catch(() => ({ stt: 'browser', tts: 'browser', language: 'en-US' }))
      if (!window.isSecureContext) {
        this.state('blocked', 'The browser only allows the microphone on https or on the bot\'s own PC. Set "viewer": { "https": true } in config.local.json, restart the bot, and open this page with https://')
        return false
      }
      if (this.settings.stt === 'browser' && !Rec) {
        this.state('blocked', 'This browser has no speech recognition: use Chrome or Edge, or set up a Whisper server (voice.stt "server").')
        return false
      }
      this.mode = mode
      this.hello()
      clearInterval(this.beat)
      this.beat = setInterval(() => this.hello(), 5000)
      if (this.settings.stt === 'server') await this.openMic()
      if (mode === 'hands-free') this.listen()
      this.state('on', mode === 'hands-free' ? `Listening. Say "${this.settings.name}" to talk to it.` : 'Hold the button (or V) to talk.')
      return true
    }

    stop () {
      this.mode = 'off'
      clearInterval(this.beat)
      try { this.rec?.abort() } catch {}
      this.rec = null
      this.stopVad()
      this.state('off', 'Voice is off.')
    }

    hello () { this.post('/voice/hello', { id: this.id, mode: this.mode }) }

    // ---------------------------------------------------------------- browser recognition
    listen (ptt = false) {
      if (this.settings.stt !== 'browser' || this.speaking) return
      try { this.rec?.abort() } catch {}
      const rec = new Rec()
      rec.lang = this.settings.language || 'en-US'
      rec.continuous = !ptt
      rec.interimResults = false
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (!e.results[i].isFinal) continue
          const text = e.results[i][0].transcript.trim()
          if (text) this.send(text, ptt)
        }
      }
      rec.onerror = (e) => { if (e.error === 'not-allowed') this.state('blocked', 'Microphone permission was refused.') }
      rec.onend = () => { if (this.rec === rec) { this.rec = null; if (this.mode === 'hands-free' && !this.speaking) setTimeout(() => this.listen(), 250) } }
      this.rec = rec
      try { rec.start() } catch {}
    }

    async send (text, ptt) {
      this.log('you', text)
      const r = await this.post('/voice/heard', { text, ptt })
      if (r && r.ok === false && r.why) this.log('info', `(${r.why})`)
    }

    // ---------------------------------------------------------------- server recognition (Whisper)
    // The microphone is captured as raw samples and sent as 16 kHz WAV: every Whisper server reads that (no ffmpeg).
    async openMic () {
      if (this.stream) return
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(this.stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      src.connect(proc)
      proc.connect(ctx.destination)
      this.audioCtx = ctx
      this.capture = null // Float32Array chunks while recording
      let talking = false
      let quietSince = 0
      proc.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0)
        if (this.capture) this.capture.push(new Float32Array(data))
        if (this.mode !== 'hands-free' || this.pttHeld || this.speaking) return
        // Hands-free: start when the voice level rises, send after ~0.9 s of quiet.
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        const level = Math.sqrt(sum / data.length)
        if (level > 0.03) { quietSince = 0; if (!talking) { talking = true; this.record() } } else if (talking) {
          quietSince ||= Date.now()
          if (Date.now() - quietSince > 900) { talking = false; this.finish(false) }
        }
      }
    }

    stopVad () {
      try { this.audioCtx?.close() } catch {}
      this.audioCtx = null
      try { this.stream?.getTracks().forEach((t) => t.stop()) } catch {}
      this.stream = null
      this.capture = null
    }

    record () { this.capture = []; this.recStarted = Date.now() }

    async finish (ptt) {
      const chunks = this.capture
      this.capture = null
      if (!chunks || Date.now() - this.recStarted < 400) return // a click or a cough
      const wav = toWav(chunks, this.audioCtx?.sampleRate || 48000)
      const res = await fetch(this.url(`/voice/listen?ptt=${ptt ? 1 : 0}`), { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav }).then((x) => x.json()).catch(() => ({}))
      if (res.text) this.log('you', res.text)
      if (res.ok === false && res.why) this.log('info', `(${res.why})`)
    }

    // ---------------------------------------------------------------- push-to-talk
    async pttDown () {
      if (this.mode === 'off' || this.pttHeld) return
      this.pttHeld = true
      if (this.settings.stt === 'server') { await this.openMic(); this.record() } else this.listen(true)
      this.state('talking', 'Listening…')
    }

    pttUp () {
      if (!this.pttHeld) return
      this.pttHeld = false
      if (this.settings.stt === 'server') this.finish(true)
      else { try { this.rec?.stop() } catch {} }
      this.state('on', this.mode === 'hands-free' ? 'Listening.' : 'Hold the button (or V) to talk.')
    }

    // ---------------------------------------------------------------- speaking
    /** Lines are played one after another, in the order they arrive. */
    speak (msg) {
      if (this.mode === 'off') return
      this.playing = (this.playing || Promise.resolve()).then(() => this.playOne(msg))
    }

    playOne (msg) {
      return new Promise((resolve) => {
        this.speaking = true
        try { this.rec?.abort() } catch {} // don't hear ourselves
        const done = () => {
          this.speaking = false
          this.post('/voice/done', { id: msg.id })
          if (this.mode === 'hands-free' && this.settings.stt === 'browser') setTimeout(() => this.listen(), 200)
          resolve()
        }
        this.log('bot', msg.text)
        if (msg.audio) {
          const a = new Audio(this.url(msg.audio))
          a.onended = done
          a.onerror = done
          a.play().catch(done)
          return
        }
        if (!window.speechSynthesis) return done()
        const u = new SpeechSynthesisUtterance(msg.text)
        u.rate = msg.rate || 1
        u.lang = this.settings.language || 'en-US'
        const want = (msg.voiceName || localStorage.getItem('botvoice.voice') || '').toLowerCase()
        const v = this.voices.find((x) => want && x.name.toLowerCase().includes(want)) || this.voices.find((x) => x.lang === u.lang && /natural|neural|online/i.test(x.name)) || this.voices.find((x) => x.lang === u.lang)
        if (v) u.voice = v
        u.onend = done
        u.onerror = done
        window.speechSynthesis.speak(u)
      })
    }
  }

  /** Float32 chunks at `rate` → a 16 kHz mono 16-bit WAV blob. */
  function toWav (chunks, rate) {
    const len = chunks.reduce((a, c) => a + c.length, 0)
    const all = new Float32Array(len)
    let o = 0
    for (const c of chunks) { all.set(c, o); o += c.length }
    const ratio = rate / 16000
    const n = Math.floor(len / ratio)
    const pcm = new Int16Array(n)
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)]))
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2)
    const dv = new DataView(buf)
    const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true)
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true)
    new Int16Array(buf, 44).set(pcm)
    return new Blob([buf], { type: 'audio/wav' })
  }
  window.botVoiceToWav = toWav

  window.BotVoice = BotVoice
})()
