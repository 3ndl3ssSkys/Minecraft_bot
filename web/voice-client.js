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
    async openMic () {
      if (this.stream) return
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      if (this.mode === 'hands-free') this.startVad()
    }

    /** Hands-free with Whisper: record while the voice level is up, send after a short silence. */
    startVad () {
      const ctx = new AudioContext()
      const src = ctx.createMediaStreamSource(this.stream)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      src.connect(an)
      const buf = new Float32Array(an.fftSize)
      let talking = false
      let quietSince = 0
      this.vad = setInterval(() => {
        if (this.speaking) return
        an.getFloatTimeDomainData(buf)
        const level = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length)
        if (level > 0.03) { quietSince = 0; if (!talking) { talking = true; this.record() } } else if (talking) {
          quietSince ||= Date.now()
          if (Date.now() - quietSince > 900) { talking = false; this.finish(false) }
        }
      }, 60)
      this.vadCtx = ctx
    }

    stopVad () { clearInterval(this.vad); try { this.vadCtx?.close() } catch {} this.vadCtx = null; try { this.stream?.getTracks().forEach((t) => t.stop()) } catch {} this.stream = null }

    record () {
      if (!this.stream) return
      this.chunks = []
      this.recorder = new MediaRecorder(this.stream)
      this.recorder.ondataavailable = (e) => this.chunks.push(e.data)
      this.recorder.start()
      this.recStarted = Date.now()
    }

    finish (ptt) {
      const r = this.recorder
      if (!r || r.state === 'inactive') return
      r.onstop = async () => {
        if (Date.now() - this.recStarted < 400) return // a click or a cough
        const blob = new Blob(this.chunks, { type: r.mimeType || 'audio/webm' })
        const res = await fetch(this.url(`/voice/listen?ptt=${ptt ? 1 : 0}`), { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob }).then((x) => x.json()).catch(() => ({}))
        if (res.text) this.log('you', res.text)
        if (res.ok === false && res.why) this.log('info', `(${res.why})`)
      }
      r.stop()
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
    speak (msg) {
      if (this.mode === 'off') return
      this.speaking = true
      try { this.rec?.abort() } catch {} // don't hear ourselves
      const done = () => {
        this.speaking = false
        this.post('/voice/done', { id: msg.id })
        if (this.mode === 'hands-free' && this.settings.stt === 'browser') setTimeout(() => this.listen(), 200)
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
    }
  }

  window.BotVoice = BotVoice
})()
