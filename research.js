'use strict'

/**
 * research.js — looking things up online, the way a dedicated player reads the wiki and guides: how a minigame works
 * on a server, a good redstone design, building ideas, strategies. Only for the best players (Master and Impossible
 * by configured level), and only with research.enabled.
 *
 *   search: DuckDuckGo's plain HTML page (no key), or a SearXNG instance (research.searxngUrl), or Brave Search
 *           (research.braveKey)
 *   the Minecraft Wiki's own API for game mechanics (research.wikiUrl)
 *   the top pages are fetched and turned into plain text; the model keeps what's useful as short notes, with sources
 *
 * Notes are saved (data/brain.json "research") and the relevant ones go into its decisions (knowhow) from then on.
 * Queries only contain the topic (and a public server's address for its minigames), never anything about the owner.
 */

const MAX_TEXT = 6000
const UA = 'Mozilla/5.0 (compatible; MinecraftBotResearch/1.0)'

/** Strip a web page down to readable text. */
function htmlToText (html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** Results from DuckDuckGo's HTML page: [{ title, url, snippet }]. */
function parseDuckDuckGo (html) {
  const out = []
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/gi
  let m
  while ((m = re.exec(html)) && out.length < 10) {
    let url = m[1].replace(/&amp;/g, '&')
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) url = decodeURIComponent(u[1])
    if (url.startsWith('//')) url = `https:${url}`
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js|\/\/duckduckgo\.com\/\?/.test(url)) continue // ads
    const snip = m[3].match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    out.push({ title: htmlToText(m[2]), url, snippet: snip ? htmlToText(snip[1]) : '' })
  }
  return out
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'how', 'and', 'is', 'do', 'i', 'minecraft', 'with', 'what', 'best', 'good', 'make', 'build'])
const words = (t) => String(t || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w))

class Research {
  constructor (agent, data = {}) {
    this.agent = agent
    this.notes = data.notes || [] // { topic, notes: [...], sources: [...], at }
    this.busy = new Set()
  }

  get cfg () { return this.agent.config.research || {} }

  /** Only the best players go read up on things (configured level, not practice). */
  allowed () {
    if (!this.cfg.enabled) return false
    const base = this.agent.intelligence?.baseIndex ?? 0
    return base >= (this.cfg.minLevel ?? 6)
  }

  async get (url, { json = false, headers = {} } = {}) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html,*/*', ...headers }, signal: AbortSignal.timeout(this.cfg.timeoutMs || 12000), redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`)
    if (json) return res.json()
    const text = await res.text()
    return text.slice(0, 1500000)
  }

  /** Web search → [{ title, url, snippet }]. */
  async search (query) {
    const q = encodeURIComponent(query)
    if (this.cfg.searxngUrl) {
      const r = await this.get(`${this.cfg.searxngUrl.replace(/\/$/, '')}/search?q=${q}&format=json`, { json: true })
      return (r.results || []).slice(0, 10).map((x) => ({ title: x.title, url: x.url, snippet: x.content || '' }))
    }
    if (this.cfg.braveKey) {
      const r = await this.get(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=8`, { json: true, headers: { 'X-Subscription-Token': this.cfg.braveKey } })
      return (r.web?.results || []).map((x) => ({ title: x.title, url: x.url, snippet: htmlToText(x.description || '') }))
    }
    const html = await this.get(`${this.cfg.duckduckgoUrl || 'https://html.duckduckgo.com/html/'}?q=${q}`)
    return parseDuckDuckGo(html)
  }

  /** The Minecraft Wiki's best page for a topic → { title, text } or null. */
  async wiki (query) {
    const base = this.cfg.wikiUrl || 'https://minecraft.wiki/api.php'
    const s = await this.get(`${base}?action=query&list=search&srlimit=1&format=json&srsearch=${encodeURIComponent(query)}`, { json: true })
    const title = s?.query?.search?.[0]?.title
    if (!title) return null
    const p = await this.get(`${base}?action=parse&prop=text&format=json&formatversion=2&page=${encodeURIComponent(title)}`, { json: true })
    const html = p?.parse?.text?.['*'] ?? p?.parse?.text
    return html ? { title, url: `https://minecraft.wiki/w/${encodeURIComponent(title.replace(/ /g, '_'))}`, text: htmlToText(html).slice(0, MAX_TEXT) } : null
  }

  /**
   * Look a topic up and keep notes. kind: 'game' (a server's minigame), 'mechanic' (wiki first), or 'general'.
   * Returns the stored entry { topic, notes, sources }.
   */
  async research (topic, { kind = 'general' } = {}) {
    const t = String(topic).trim().slice(0, 120)
    if (!t) throw new Error('no topic')
    const known = this.find(t)
    if (known && Date.now() - known.at < 3 * 86400000) return known // read it recently
    if (this.busy.has(t)) return null
    this.busy.add(t)
    try {
      const pages = []
      if (kind !== 'game') {
        const w = await this.wiki(t).catch(() => null)
        if (w) pages.push(w)
      }
      const results = await this.search(kind === 'game' ? `${t} how to play guide tips` : `minecraft ${t}`).catch((err) => { this.agent.log.debug?.(`search failed: ${err.message}`); return [] })
      for (const r of results.slice(0, this.cfg.maxPages ?? 3)) {
        if (pages.length >= (this.cfg.maxPages ?? 3) + 1) break
        if (pages.some((p) => p.url === r.url)) continue
        try { pages.push({ title: r.title, url: r.url, text: htmlToText(await this.get(r.url)).slice(0, MAX_TEXT) }) } catch { if (r.snippet) pages.push({ title: r.title, url: r.url, text: r.snippet }) }
      }
      if (!pages.length) throw new Error('nothing found online (no internet, or the search was blocked)')
      const notes = await this.summarize(t, pages)
      const entry = { topic: t, kind, notes, sources: pages.map((p) => p.url).slice(0, 5), at: Date.now() }
      this.notes = this.notes.filter((n) => n.topic.toLowerCase() !== t.toLowerCase())
      this.notes.push(entry)
      if (this.notes.length > 60) this.notes.splice(0, this.notes.length - 60)
      this.agent.memory?.addEvent?.('research', `You read up on ${t}: ${notes.slice(0, 2).join(' ')}`)
      this.agent.learning?.markDirty()
      this.agent.log.info(`Researched "${t}" (${pages.length} pages): ${notes.length} notes`)
      return entry
    } finally {
      this.busy.delete(t)
    }
  }

  /** The model keeps what a player needs from the pages: short practical notes. */
  async summarize (topic, pages) {
    const sys = 'You read web pages about Minecraft for yourself, to play better. Keep what a skilled player would remember: steps, numbers, block or item lists, layouts, strategies, rules of the game or server. 3 to 8 short notes, each one line. Only what the pages say; skip ads, menus and unrelated text. Respond with ONLY JSON: {"notes": ["...", "..."]}'
    const user = `Topic: ${topic}\n\n${pages.map((p, i) => `Page ${i + 1}: ${p.title}\n${p.text.slice(0, 2500)}`).join('\n\n')}`
    const out = await this.agent.llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { priority: 4, label: 'research' }).catch(() => null)
    const notes = (Array.isArray(out?.notes) ? out.notes : []).map((n) => String(n).replace(/\s+/g, ' ').trim().slice(0, 220)).filter(Boolean).slice(0, 8)
    if (notes.length) return notes
    // No model answer: keep the first lines of the best page.
    return pages[0].text.split('\n').map((l) => l.trim()).filter((l) => l.length > 40).slice(0, 4).map((l) => l.slice(0, 200))
  }

  find (topic) {
    const w = new Set(words(topic))
    return this.notes.find((n) => n.topic.toLowerCase() === String(topic).toLowerCase()) ||
      this.notes.find((n) => { const nw = words(n.topic); return nw.length && nw.every((x) => w.has(x)) }) || null
  }

  /** Notes that fit what it's doing right now (for the prompt). */
  relevant (context, max = 4) {
    const w = new Set(words(context))
    return this.notes
      .map((n) => ({ n, score: words(n.topic).filter((x) => w.has(x)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.n.at - a.n.at)
      .slice(0, 2)
      .flatMap(({ n }) => n.notes.slice(0, max).map((line) => `${n.topic}: ${line}`))
      .slice(0, max)
  }

  toJSON () { return { notes: this.notes } }
}

/** The research action, installed into ACTIONS. */
function install (ACTIONS, h, SHORT = {}) {
  const { argString, ActionError } = h
  ACTIONS.research = {
    description: 'Look something up online, like reading the wiki or a guide: how a minigame on this server works, a good redstone design, a build idea, a strategy. Takes a while; the notes stay with you.',
    params: { topic: 'string, e.g. "bed wars strategy", "compact sugar cane farm", "medieval house design"' },
    minBaseLevel: 6,
    async run (ctx, args) {
      const r = ctx.research
      if (!r?.allowed()) throw new ActionError('NOT_ALLOWED', 'You don\'t look things up online.')
      const topic = argString(args, 'topic', { maxLength: 120 })
      const game = /\b(wars?|duels?|bridge|sumo|ffa|hide and seek|murder|parkour|skyblock|prison|minigame|server)\b/i.test(topic)
      let entry
      try { entry = await r.research(topic, { kind: game ? 'game' : 'mechanic' }) } catch (err) { throw new ActionError('RESEARCH_FAILED', `Couldn't look up "${topic}": ${err.message}`) }
      if (!entry) return `Already looking up "${topic}".`
      return `Read up on ${entry.topic}: ${entry.notes.join(' | ')}`.slice(0, 900)
    }
  }
  Object.assign(SHORT, { research: 'look something up online (minigames, designs, strategies)' })
}

module.exports = { Research, install, htmlToText, parseDuckDuckGo }
