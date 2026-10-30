'use strict'
/**
 * A stand-in for Ollama, so the bot can be tested without a GPU or model.
 *
 *   node test/tools/mock-ollama.js [script.json]      (PORT env, default 11499)
 *
 * It answers /api/tags, /api/ps and /api/chat like Ollama does (including the
 * timing fields `npm run doctor` reads). For decisions it replays the actions
 * in script.json in order (an array of { name, args }), then waits. Chat
 * analysis, replies, reactions and lessons get simple canned answers.
 * Every request is appended to mock-ollama.log so you can inspect prompts.
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const port = Number(process.env.PORT || 11499)
const script = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : []
const log = fs.createWriteStream(path.join(process.cwd(), 'mock-ollama.log'), { flags: 'a' })
let turn = 0

const none = { kind: 'other', description: '', item: '', count: 0, target: '', effort: 'trivial', risk: 'none' }
const noPromise = { made: false, kind: 'other', description: '', item: '', count: 0, withinMinutes: 0 }

http.createServer((req, res) => {
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: process.env.MODEL || 'qwen2.5:7b' }] }))
  if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: process.env.MODEL || 'qwen2.5:7b', size: 5.2e9, size_vram: 5.2e9 }] }))
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const data = JSON.parse(body || '{}')
    const props = Object.keys(data.format?.properties || {})
    const user = data.messages?.[1]?.content || ''
    log.write(`--- ${new Date().toISOString()} [${props.join(',') || 'json'}]\nSYSTEM:\n${data.messages?.[0]?.content}\nUSER:\n${user}\n`)
    let out
    if (props.includes('action')) {
      const action = script[turn++] || { name: 'wait', args: { seconds: 3 } }
      out = { thought: `scripted turn ${turn}`, emotion: 'calm', emotionIntensity: 4, goal: 'testing', action, taskUpdate: { status: 'none', note: '' } }
    } else if (props.includes('isRequest')) {
      const last = user.slice(user.lastIndexOf('latest message'))
      const req = /get me|bring|gather/i.test(last) ? { ...none, kind: 'gather', description: 'get some dirt', item: 'dirt', count: 5, effort: 'small' }
        : /come here/i.test(last) ? { ...none, kind: 'come', description: 'come over', effort: 'trivial' } : null
      out = { reply: req ? '' : 'hey!', emotion: 'happy', emotionIntensity: 5, playerEmotion: 'friendly', playerIntent: req ? 'request' : 'friendly', trustImpact: 0, likeImpact: 1, remindsOfTask: false, isRequest: Boolean(req), request: req || none, promise: noPromise }
    } else if (props.includes('lesson')) {
      out = { lesson: '' }
    } else {
      const decision = user.match(/Your decision: (.*)/)
      out = { message: decision ? `[${decision[1].split(/[.(]/)[0].slice(0, 40)}]` : '', emotion: 'calm', emotionIntensity: 3 }
    }
    const reply = { message: { role: 'assistant', content: JSON.stringify(out) }, prompt_eval_count: Math.round(body.length / 3.5), prompt_eval_duration: 4e9, eval_count: 80, eval_duration: 2e9, load_duration: 1e8 }
    setTimeout(() => res.end(JSON.stringify(reply)), Number(process.env.DELAY_MS || 300))
  })
}).listen(port, () => console.log(`mock Ollama on http://localhost:${port} (${script.length} scripted actions)`))
