'use strict'
// Run with: npm test   (or node test/research.test.js)
// Covers: reading up online — search results, the Minecraft Wiki API, page text, notes kept and used later, and that
// only Master/Impossible bots do it.
const path = require('path')
const http = require('http')
const assert = require('assert')
const { Research, htmlToText, parseDuckDuckGo } = require(path.join(__dirname, '..', 'research.js'))

;(async () => {
  assert.equal(htmlToText('<p>Beds <b>explode</b> in the &amp; Nether</p><script>x()</script>'), 'Beds explode in the & Nether')
  let port
  const ddg = () => `<html><body>
    <div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`http://127.0.0.1:${port}/guide`)}&amp;rut=x">Bed Wars <b>Guide</b></a>
    <a class="result__snippet" href="#">Protect your bed, rush diamonds.</a></div>
    <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
    <div class="result"><a class="result__a" href="http://127.0.0.1:${port}/tips">Tips</a><a class="result__snippet">Bridge fast.</a></div></body></html>`
  const seen = []
  const srv = http.createServer((req, res) => {
    seen.push(req.url)
    if (req.url.startsWith('/ddg')) return res.end(ddg())
    if (req.url.includes('list=search')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ query: { search: [{ title: 'Bed' }] } })) }
    if (req.url.includes('action=parse')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ parse: { text: '<p>Beds explode in the Nether and the End.</p>' } })) }
    if (req.url === '/guide') return res.end('<html><nav>Menu</nav><article><h1>Bed Wars</h1><p>Cover your bed with wool, then end stone, then obsidian.</p><p>Buy a sword first.</p></article></html>')
    if (req.url === '/tips') return res.end('<p>Use iron to buy blocks; bridge to the middle for diamonds.</p>')
    res.statusCode = 404; res.end()
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  port = srv.address().port
  assert.deepEqual(parseDuckDuckGo(ddg()).map((r) => r.url), [`http://127.0.0.1:${port}/guide`, `http://127.0.0.1:${port}/tips`], 'ads dropped, redirects decoded')

  let asked = null
  const agent = {
    config: { research: { enabled: true, minLevel: 6, duckduckgoUrl: `http://127.0.0.1:${port}/ddg`, wikiUrl: `http://127.0.0.1:${port}/api.php`, maxPages: 3 } },
    intelligence: { baseIndex: 6 },
    log: { info () {}, debug () {} },
    memory: { addEvent () {} },
    learning: { markDirty () {} },
    llm: { chat: async (msgs) => { asked = msgs[1].content; return { notes: ['Cover the bed with wool, then end stone, then obsidian.', 'Buy a sword first, then blocks with iron.', 'Bridge to the middle for diamonds.'] } } }
  }
  const r = new Research(agent)
  assert.ok(r.allowed())
  const entry = await r.research('bed wars on example.net', { kind: 'game' })
  assert.equal(entry.notes.length, 3)
  assert.match(asked, /Cover your bed with wool/, 'the pages reached the model')
  assert.ok(!/Menu/.test(asked.split('Page 1')[1].split('\n')[1] || ''), 'navigation stripped')
  assert.equal(entry.sources.length, 2)
  assert.ok(!seen.some((u) => u.includes('list=search')), 'a minigame goes to the web, not the wiki')
  // the wiki for game mechanics
  const mech = await r.research('bed explosions', { kind: 'mechanic' })
  assert.ok(mech.sources[0].includes('minecraft.wiki/w/Bed'))
  // later, in a Bed Wars game, the notes come back
  const lines = r.relevant('BED WARS: Red ✔ Blue ✔ Kills: 0')
  assert.ok(lines.some((l) => /obsidian/.test(l)), JSON.stringify(lines))
  assert.deepEqual(r.relevant('mining iron in a cave'), [])
  // asked again soon: no new lookup
  const before = seen.length
  await r.research('bed wars on example.net', { kind: 'game' })
  assert.equal(seen.length, before)
  // below Master: no research
  agent.intelligence.baseIndex = 5
  assert.ok(!r.allowed())
  srv.close()
  console.log('All research checks passed')
})().catch((err) => { console.error(err); process.exit(1) })
