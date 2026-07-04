// test/direct-transport.test.js — local-network (offline TCP) mode.
const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')

const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { Room } = require('../workers/lib/room.js')

const tmp = () => __dirname + '/.test-tmp/' + Math.random().toString(16).slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let PORT = 49760

test('local mode: host binds TCP, guest connects, event syncs (offline, no DHT)', async () => {
  const port = PORT++
  const host = new Room({
    name: 'lan',
    nickname: 'h',
    host: true,
    mode: 'local',
    localPort: port,
    net,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp()
  })
  await host.open()
  assert.deepStrictEqual(
    host.transport.localBootstrapAddress,
    { host: '0.0.0.0', port },
    'host reports its listen address'
  )

  const guest = new Room({
    name: 'lan',
    nickname: 'g',
    host: false,
    mode: 'local',
    localPort: port,
    remoteHost: '127.0.0.1',
    net,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp()
  })
  let got = null
  guest.onEvent((e) => {
    if (e.kind === 'match') got = e
  })
  await guest.open()

  await sleep(1200)
  await host.postMatchEvent({ type: 'goal', minute: 1, text: 'LOCAL' })
  await sleep(2500)

  assert.ok(got, 'guest received the event over the local TCP link')
  assert.strictEqual(got.data.text, 'LOCAL')

  await host.close().catch(() => {})
  await guest.close().catch(() => {})
})

test('Room selects DirectTransport for local mode, SwarmTransport for internet', () => {
  const { DirectTransport } = require('../workers/lib/direct-transport.js')
  const { SwarmTransport } = require('../workers/lib/transport.js')
  const Hyperswarm = require('hyperswarm')

  const local = new Room({
    name: 'r',
    nickname: 'n',
    host: true,
    mode: 'local',
    net,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp()
  })
  assert.ok(local.transport instanceof DirectTransport, 'local -> DirectTransport')

  const inet = new Room({
    name: 'r',
    nickname: 'n',
    host: true,
    mode: 'internet',
    Hyperswarm,
    Corestore,
    crypto,
    b4a,
    storageDir: tmp()
  })
  assert.ok(inet.transport instanceof SwarmTransport, 'internet -> SwarmTransport')
})
