'use strict'
// Run with: npm test   (or node test/llm.test.js)
// Covers: the fast chat lane (replies don't wait behind a slow decision), OpenAI-compatible requests,
// the "think" switch, and the mixed setup (decisions on Ollama, chat on a hosted API)
const path = require('path')
const http = require('http')
const assert = require('assert')
const R = path.join(__dirname, '..') + path.sep
const { OllamaClient, DEFAULT_CONFIG, deepMerge } = require(R + 'index.js')

const seen = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    const b = JSON.parse(body)
    seen.push({ url: req.url, model: b.model, auth: req.headers.authorization, body: b, at: Date.now() })
    const delay = b.model === 'slow-big' ? 600 : 50
    setTimeout(() => {
      res.setHeader('Content-Type', 'application/json')
      let content = JSON.stringify({ message: `from ${b.model}` })
      if (b.model === 'thinker') content = `We need to answer. Let me think about it {not json}...\n</think>\n\n${content}` // thinking-only models
      res.end(JSON.stringify(req.url.includes('/v1/') ? { choices: [{ message: { content } }], usage: { completion_tokens: 5 } } : { message: { content }, eval_count: 5 }))
    }, delay)
  })
})
const log = { info: () => {}, debug: () => {}, warn: () => {} }
const schema = { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] }

server.listen(0, async () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  console.log('== fast lane ==')
  const cfg = deepMerge(DEFAULT_CONFIG, { llm: { url: `${base}/api/chat`, model: 'slow-big', fastModel: 'tiny', think: false } })
  const client = new OllamaClient(cfg, log)
  const t0 = Date.now()
  const decision = client.chat([{ role: 'user', content: 'decide' }], { schema, priority: 2 })
  await new Promise((r) => setTimeout(r, 20))
  const reply = await client.chat([{ role: 'user', content: 'hi' }], { schema, priority: 0 })
  const replyMs = Date.now() - t0
  assert.equal(reply.message, 'from tiny')
  assert((await decision).message === 'from slow-big')
  console.log(`reply came back after ${replyMs} ms while a 600 ms decision was still running`)
  assert(replyMs < 400)
  const ollamaBody = seen.find((s) => s.model === 'tiny').body
  assert.equal(ollamaBody.think, false)
  assert.equal(ollamaBody.options.num_predict, 400)
  console.log('ok')

  console.log('\n== one lane without a fast model ==')
  const single = new OllamaClient(deepMerge(DEFAULT_CONFIG, { llm: { url: `${base}/api/chat`, model: 'slow-big' } }), log)
  const t1 = Date.now()
  single.chat([{ role: 'user', content: 'decide' }], { schema, priority: 2 })
  await new Promise((r) => setTimeout(r, 20))
  await single.chat([{ role: 'user', content: 'hi' }], { schema, priority: 0 })
  console.log(`same reply took ${Date.now() - t1} ms (waited for the decision)`)
  assert(Date.now() - t1 >= 600)
  assert.equal(seen.at(-1).body.think, undefined) // think: null → not sent
  console.log('ok')

  console.log('\n== OpenAI-compatible, mixed ==')
  const mixed = new OllamaClient(deepMerge(DEFAULT_CONFIG, { llm: { url: `${base}/api/chat`, model: 'slow-big', fastModel: 'hosted-small', fastProvider: 'openai', fastUrl: `${base}/v1/chat/completions`, fastApiKey: 'sk-test' } }), log)
  const out = await mixed.chat([{ role: 'user', content: 'hi' }], { schema, priority: 0 })
  const req = seen.at(-1)
  assert.equal(out.message, 'from hosted-small')
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.auth, 'Bearer sk-test')
  assert.equal(req.body.response_format.type, 'json_schema')
  assert.equal(req.body.max_tokens, 400)
  assert.equal((await mixed.chat([{ role: 'user', content: 'decide' }], { schema, priority: 2 })).message, 'from slow-big')
  assert.equal(seen.at(-1).url, '/api/chat') // decisions stay on Ollama
  assert.equal(seen.at(-1).auth, undefined) // and the hosted key isn't sent there
  console.log('ok')

  console.log('\n== a model that thinks anyway ==')
  const warnings = []
  const thinker = new OllamaClient(deepMerge(DEFAULT_CONFIG, { llm: { url: `${base}/api/chat`, model: 'thinker', think: false } }), { ...log, warn: (m) => warnings.push(m) })
  assert.equal((await thinker.chat([{ role: 'user', content: 'hi' }], { schema, priority: 2 })).message, 'from thinker')
  assert(warnings.some((w) => /keeps "thinking"/.test(w)))
  console.log('reasoning stripped, answer parsed; warned:', warnings[0].slice(0, 70) + '...')
  console.log('ok')

  console.log('\nAll LLM checks passed')
  server.close()
})
