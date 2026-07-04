// workers/pitchside.js
// -----------------------------------------------------------------------------
// PitchSide backend, running in the Bare worker. Owns the P2P mesh + on-device
// AI and speaks a small JSON protocol to the renderer over the IPC pipe.
//
// Renderer -> worker commands:
//   { cmd:'join', room, nickname, host, persona }
//   { cmd:'match', event:{type,minute,text} }   (host only)
//   { cmd:'chat', text }                          (host only)
//   { cmd:'react', emoji }                        (host only)
//   { cmd:'delete', targetSeq }                   (host only; hides an event)
//   { cmd:'bet-hide', betId }                     (host only; hides a bet card)
//   { cmd:'ask', question }
//   { cmd:'bet-odds', id, question, outcomes, context }     (AI betting odds)
//   { cmd:'bet-outcome', id, question, outcomes, context }  (AI winner proposal)
//
// Worker -> renderer messages:
//   { type:'event', event }        a feed event (match/chat/reaction/commentary/system)
//   { type:'peers', count }        live peer count
//   { type:'ai', status }          'loading' | 'ready' | 'offline'
//   { type:'answer', text }        answer to an 'ask'
//   { type:'bet-odds', id, probabilities, rationale }   (or { id, error })
//   { type:'bet-outcome', id, outcome, reason }         (or { id, error })
//   { type:'error', message }
// -----------------------------------------------------------------------------

const Hyperswarm = require('hyperswarm')
const DHT = require('hyperdht')
const net = require('bare-tcp')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const path = require('bare-path')
const os = require('bare-os')

const { Room } = require('./lib/room.js')
const { CommentaryEngine } = require('./lib/qvac.js')

// Bare.IPC framed pipe (same convention as the boilerplate's FramedStream use).
const FramedStream = require('framed-stream')
const pipe = new FramedStream(Bare.IPC)

const storageRoot = path.join(os.tmpdir(), 'pitchside')

let room = null
let engine = null

function send (obj) {
  // Newline-delimit frames so the renderer can split coalesced/partial chunks.
  pipe.write(b4a.from(JSON.stringify(obj) + '\n'))
}

// Framed-message reader: IPC data can arrive coalesced or split, so buffer on
// newlines and parse each complete line. Malformed lines are skipped, never crash.
let _buf = ''
pipe.on('data', (data) => {
  _buf += b4a.toString(data)
  let idx
  while ((idx = _buf.indexOf('\n')) !== -1) {
    const line = _buf.slice(0, idx)
    _buf = _buf.slice(idx + 1)
    if (line.trim()) dispatch(line)
  }
})

async function dispatch (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return } // ignore malformed frames
  if (!msg || typeof msg.cmd !== 'string') return
  try {
    await handle(msg)
  } catch (err) {
    send({ type: 'error', message: (err && err.message) || 'unknown error' })
  }
}

let currentPersona = 'hype'
let currentHost = false
let currentNick = 'guest'

async function handle (msg) {
  switch (msg.cmd) {
    case 'join': return join(msg)
    case 'leave': return leave()
    case 'match': return room && room.postMatchEvent(msg.event)
    case 'chat': return room && room.postChat(msg.text)
    case 'react': return room && room.postReaction(msg.emoji)
    case 'delete': return room && room.postDelete(msg.targetSeq)
    case 'bet-hide': return room && room.postBetHide(msg.betId)
    case 'ask': return ask(msg.question)
    case 'bet-odds': return betOdds(msg)
    case 'bet-outcome': return betOutcome(msg)
    case 'download-model': return downloadModel()
  }
}

// AI betting odds (informational, pari-mutuel). Runs on-device via QVAC.
// msg: { id, question, outcomes:[...], context } -> { type:'bet-odds', id, ... }
async function betOdds ({ id, question, outcomes, context }) {
  if (!engine || !engine.isReady) {
    return send({ type: 'bet-odds', id, error: 'AI offline — download the model first' })
  }
  try {
    const { probabilities, rationale } = await engine.odds({ question, outcomes, context })
    send({ type: 'bet-odds', id, probabilities, rationale })
  } catch (err) {
    send({ type: 'bet-odds', id, error: (err && err.message) || 'odds failed' })
  }
}

// AI suggested winning outcome, grounded in real match data when provided.
// msg: { id, question, outcomes:[...], context } -> { type:'bet-outcome', id, ... }
async function betOutcome ({ id, question, outcomes, context }) {
  if (!engine || !engine.isReady) {
    return send({ type: 'bet-outcome', id, error: 'AI offline — download the model first' })
  }
  try {
    const { outcome, reason } = await engine.proposeOutcome({ question, outcomes, context })
    send({ type: 'bet-outcome', id, outcome, reason })
  } catch (err) {
    send({ type: 'bet-outcome', id, error: (err && err.message) || 'outcome failed' })
  }
}

async function leave () {
  if (room) { try { await room.close() } catch {} ; room = null }
  send({ type: 'left' })
}

async function join ({ room: name, nickname, host, persona, mode, bootstrap }) {
  // Guard against a double-join leaking the previous room.
  if (room) { try { await room.close() } catch {} ; room = null }

  currentPersona = persona || 'hype'
  currentHost = !!host
  currentNick = nickname || 'guest'
  name = name || 'worldcup-final'

  // Local mode: a guest passes the host's "IP:port"; a host binds a fixed port.
  const LOCAL_PORT = 49737
  let remoteHost = null
  let localPort = LOCAL_PORT
  if (mode === 'local' && bootstrap) {
    const [h, p] = String(bootstrap).split(':')
    if (h) remoteHost = h
    if (p) localPort = Number(p)
  }

  room = new Room({
    name, nickname: currentNick, host: currentHost,
    Hyperswarm, DHT, net, Corestore, crypto, b4a,
    mode: mode || 'internet',
    localPort, remoteHost,
    storageDir: path.join(storageRoot, name + '-' + currentNick)
  })

  room.onEvent((event) => send({ type: 'event', event }))
  room.onPeerCount((count) => send({ type: 'peers', count }))

  await room.open()

  // Local host: report the port guests must connect to (with their own IP).
  const bs = room.transport && room.transport.localBootstrapAddress
  if (bs) send({ type: 'local-address', address: bs.host + ':' + bs.port })

  // AI: if the model is already downloaded (cached in ~/.qvac), auto-load it so
  // it's ready immediately (loadModel uses the cache, no re-download). Otherwise
  // stay offline until the user clicks download.
  engine = new CommentaryEngine({ persona })
  send({ type: 'ai', status: 'offline' })
  autoLoadIfCached()

  // Host auto-commentates its match events (once the model is ready).
  if (host) {
    room.onEvent(async (event) => {
      if (event.kind !== 'match') return
      // Diagnostics: report why commentary did/didn't fire (visible to the UI).
      const ready = !!(engine && engine.isReady)
      if (!ready) {
        send({ type: 'commentary-skip', reason: 'model not ready (download the AI model first)' })
        return
      }
      if (event.author !== nickname) return // only commentate our own posts
      try {
        const line = await engine.commentate(event.data, { persona: currentPersona })
        await room.postCommentary(line, { persona: currentPersona })
      } catch (err) {
        send({ type: 'commentary-skip', reason: 'commentate failed: ' + (err && err.message) })
      }
    })
  }
}

// If the model is already cached on disk, load it into the engine so the AI is
// ready immediately (no re-download). Called on join. Silent if not cached.
async function autoLoadIfCached () {
  try {
    const env = require('bare-env')
    const home = env.HOME || env.USERPROFILE || env.SNAP_USER_COMMON
    if (!home) return
    const modelsDir = path.join(home, '.qvac', 'models')

    let cached = false
    try {
      const fs = require('bare-fs')
      cached = fs.readdirSync(modelsDir).some((f) => String(f).endsWith('.gguf'))
    } catch { cached = false }
    if (!cached) return // not downloaded yet -> stay offline

    send({ type: 'ai', status: 'loading' })
    await engine.init() // loadModel uses the cached file (fast, no network)
    send({ type: 'ai', status: 'ready' })
  } catch {
    send({ type: 'ai', status: 'offline' }) // fall back to manual download
  }
}

// User-triggered: QVAC downloads the model from the HF URL, streaming progress.
async function downloadModel () {
  if (!engine) engine = new CommentaryEngine({ persona: currentPersona })
  if (engine.isReady) return send({ type: 'ai', status: 'ready' })

  send({ type: 'ai', status: 'downloading' })
  engine.onProgress = (p) => {
    let pct = null
    if (typeof p === 'number') pct = p
    else if (p && typeof p === 'object') {
      if (typeof p.percentage === 'number') pct = p.percentage
      else if (p.downloaded && p.total) pct = p.downloaded / p.total * 100
    }
    send({ type: 'ai-progress', pct: pct == null ? null : Math.round(pct) })
  }
  try {
    await engine.init()
    send({ type: 'ai', status: 'ready' })
  } catch (err) {
    send({ type: 'ai', status: 'offline', reason: err && err.message })
  }
}

async function ask (question) {
  if (!engine || !engine.isReady) {
    return send({ type: 'answer', text: '(AI offline — on-device model unavailable)' })
  }
  const text = await engine.answer(question, room ? room.events() : [])
  send({ type: 'answer', text })
}

send({ type: 'ready' })
