// test/feed.test.js — critical data-layer behavior for the match feed.
// Run: node --test
//
// Locks in the bugs we fixed by hand during development so they can't silently
// regress: dedup/no-double-emit, host-only writes, deterministic keys, and
// host->guest replication.

const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')

const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { MatchFeed } = require('../workers/lib/feed.js')

const tmp = () => __dirname + '/.test-tmp/' + Math.random().toString(16).slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function replicate (store, socket, initiator) {
  const proto = store.replicate(initiator)
  proto.on('error', () => {})
  socket.on('error', () => {})
  proto.pipe(socket).pipe(proto)
}

test('local append emits each event exactly once (no dedup double-emit)', async () => {
  const store = new Corestore(tmp())
  const feed = new MatchFeed(store, 'r', { host: true, crypto, b4a })
  const seen = []
  feed.onEvent((e) => seen.push(e))
  await feed.ready()

  await feed.append({ kind: 'match', author: 'a', at: 1, data: { text: 'g1' } })
  await feed.append({ kind: 'chat', author: 'a', at: 2, data: { text: 'hi' } })
  await sleep(200)

  assert.strictEqual(seen.length, 2, 'exactly 2 events emitted (no duplicates)')
  assert.strictEqual(feed.events().length, 2, 'snapshot has 2 events')
  assert.deepStrictEqual(seen.map((e) => e.data.text), ['g1', 'hi'], 'correct order')
  await feed.close()
})

test('guests cannot write (host-only append)', async () => {
  const store = new Corestore(tmp())
  const guest = new MatchFeed(store, 'r', { host: false, crypto, b4a })
  await guest.ready()
  const ok = await guest.append({ kind: 'match', author: 'g', at: 1, data: {} })
  assert.strictEqual(ok, false, 'guest append returns false')
  assert.strictEqual(guest.events().length, 0, 'nothing written')
  await guest.close()
})

test('same room name -> same core key (deterministic, cross-peer sync works)', async () => {
  const host = new MatchFeed(new Corestore(tmp()), 'worldcup', { host: true, crypto, b4a })
  const guest = new MatchFeed(new Corestore(tmp()), 'worldcup', { host: false, crypto, b4a })
  await host.ready(); await guest.ready()
  assert.ok(b4a.equals(host.core.key, guest.core.key), 'host and guest derive the SAME core key')
  await host.close(); await guest.close()
})

test('different room names -> different keys (rooms are isolated)', async () => {
  const a = new MatchFeed(new Corestore(tmp()), 'roomA', { host: true, crypto, b4a })
  const b = new MatchFeed(new Corestore(tmp()), 'roomB', { host: true, crypto, b4a })
  await a.ready(); await b.ready()
  assert.ok(!b4a.equals(a.core.key, b.core.key), 'distinct rooms have distinct keys')
  await a.close(); await b.close()
})

test('host append replicates to guest over a stream', async () => {
  const hostStore = new Corestore(tmp())
  const guestStore = new Corestore(tmp())
  const host = new MatchFeed(hostStore, 'sync', { host: true, crypto, b4a })
  const guest = new MatchFeed(guestStore, 'sync', { host: false, crypto, b4a })
  await host.ready(); await guest.ready()

  const port = 40000 + Math.floor(Math.random() * 20000)
  const server = net.createServer((s) => replicate(guestStore, s, false))
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const client = net.connect(port, '127.0.0.1')
  replicate(hostStore, client, true)

  let got = null
  guest.onEvent((e) => { if (e.kind === 'match') got = e })
  const poll = setInterval(() => guest.refresh().catch(() => {}), 150)

  await sleep(800)
  await host.append({ kind: 'match', author: 'h', at: 1, data: { text: 'GOAL' } })
  await sleep(2000)
  clearInterval(poll)
  server.close()

  assert.ok(got, 'guest received the event')
  assert.strictEqual(got.data.text, 'GOAL')
  await host.close(); await guest.close()
})

test('listener error does not break the feed', async () => {
  const feed = new MatchFeed(new Corestore(tmp()), 'r', { host: true, crypto, b4a })
  const seen = []
  feed.onEvent(() => { throw new Error('boom') }) // bad listener
  feed.onEvent((e) => seen.push(e))               // good listener still fires
  await feed.ready()
  await feed.append({ kind: 'match', author: 'a', at: 1, data: { text: 'x' } })
  await sleep(200)
  assert.strictEqual(seen.length, 1, 'good listener still received the event')
  await feed.close()
})
