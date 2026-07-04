// test/room.test.js — Room lifecycle + transport-agnostic behavior + edge cases.
const { test } = require('node:test')
const assert = require('node:assert')

const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { Room } = require('../workers/lib/room.js')
const { SwarmTransport } = require('../workers/lib/transport.js')

const tmp = () => __dirname + '/.test-tmp/' + Math.random().toString(16).slice(2)

test('Room defaults to SwarmTransport when none is injected', () => {
  const room = new Room({
    name: 'r',
    nickname: 'n',
    host: true,
    Hyperswarm,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp()
  })
  assert.ok(room.transport instanceof SwarmTransport, 'defaults to swarm transport')
})

test('Room accepts an injected transport', () => {
  const fakeTransport = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const room = new Room({
    name: 'r',
    nickname: 'n',
    host: true,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: fakeTransport
  })
  assert.strictEqual(room.transport, fakeTransport, 'uses the injected transport')
})

test('host can post events; guest post is a no-op (feed enforces host-only)', async () => {
  const injected = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const host = new Room({
    name: 'r',
    nickname: 'h',
    host: true,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: injected
  })
  const guestT = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const guest = new Room({
    name: 'r',
    nickname: 'g',
    host: false,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: guestT
  })
  await host.open()
  await guest.open()

  await host.postMatchEvent({ type: 'goal', minute: 1, text: 'g' })
  const ok = await guest.postMatchEvent({ type: 'goal', minute: 2, text: 'nope' })
  assert.strictEqual(ok, false, 'guest write rejected')

  // host feed has: system(join) + match
  const kinds = host.events().map((e) => e.kind)
  assert.ok(kinds.includes('match'), 'host event recorded')

  await host.close()
  await guest.close()
})

test('events carry a seq, and host delete emits a tombstone targeting it', async () => {
  const injected = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const host = new Room({
    name: 'r',
    nickname: 'h',
    host: true,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: injected
  })

  const seen = []
  host.onEvent((e) => seen.push(e))
  await host.open() // appends a system(join) event at seq 0

  await host.postChat('hello') // seq 1
  await host.postChat('delete me') // seq 2

  const chats = host.events().filter((e) => e.kind === 'chat')
  assert.strictEqual(chats.length, 2)
  // Every emitted event has a stable seq (its Hypercore position).
  assert.ok(
    chats.every((e) => Number.isInteger(e.seq)),
    'events carry seq'
  )
  const target = chats[1].seq

  // Host deletes the second chat by its seq.
  const ok = await host.postDelete(target)
  assert.strictEqual(ok, true, 'host delete accepted')

  // A delete tombstone was emitted, referencing the right seq.
  const del = seen.find((e) => e.kind === 'delete')
  assert.ok(del, 'delete event emitted')
  assert.strictEqual(del.data.targetSeq, target, 'tombstone targets the deleted seq')

  await host.close()
})

test('guest cannot delete (host-only feed write rejected)', async () => {
  const t = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const guest = new Room({
    name: 'r',
    nickname: 'g',
    host: false,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: t
  })
  await guest.open()
  const ok = await guest.postDelete(0)
  assert.strictEqual(ok, false, 'guest delete rejected by host-only feed')
  const ok2 = await guest.postBetHide(3)
  assert.strictEqual(ok2, false, 'guest bet-hide rejected by host-only feed')
  await guest.close()
})

test('host bet-hide emits a bet-hide tombstone keyed by betId', async () => {
  const injected = { onConnection() {}, onPeers() {}, async join() {}, async destroy() {} }
  const host = new Room({
    name: 'r',
    nickname: 'h',
    host: true,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: injected
  })
  const seen = []
  host.onEvent((e) => seen.push(e))
  await host.open()

  const ok = await host.postBetHide(7)
  assert.strictEqual(ok, true, 'host bet-hide accepted')
  const hide = seen.find((e) => e.kind === 'bet-hide')
  assert.ok(hide, 'bet-hide event emitted')
  assert.strictEqual(hide.data.betId, 7, 'tombstone carries the betId')

  await host.close()
})

test('peer count callback fires through the transport', async () => {
  let emitPeers
  const t = {
    onConnection() {},
    onPeers(fn) {
      emitPeers = fn
    },
    async join() {},
    async destroy() {}
  }
  const room = new Room({
    name: 'r',
    nickname: 'n',
    host: true,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp(),
    transport: t
  })
  let count = -1
  room.onPeerCount((n) => {
    count = n
  })
  await room.open()
  emitPeers(3)
  assert.strictEqual(count, 3, 'peer count propagated to listeners')
  await room.close()
})
