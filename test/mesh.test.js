// test/mesh.test.js — multi-hop mesh relay + pluggable transport.
// Run: node --test
//
// Locks in the stadium-mesh guarantees: data relays A->B->C where A and C never
// directly connect, and the app Room works over MeshTransport identically to swarm.

const { test } = require('node:test')
const assert = require('node:assert')
const net = require('node:net')

const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { Room } = require('../workers/lib/room.js')
const { MeshTransport } = require('../workers/lib/mesh-transport.js')

const tmp = () => __dirname + '/.test-tmp/' + Math.random().toString(16).slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let PORT = 45000

// A TCP-loopback "link layer" — the interface a native radio module implements.
function makeLink () {
  let onNeighbor = () => {}
  const servers = []; const sockets = []
  return {
    onNeighbor (fn) { onNeighbor = fn },
    async start () {},
    async accept (port) {
      const server = net.createServer((s) => { s.on('error', () => {}); onNeighbor(s, false) })
      servers.push(server)
      await new Promise((r) => server.listen(port, '127.0.0.1', r))
    },
    dial (port) {
      const s = net.connect(port, '127.0.0.1'); s.on('error', () => {})
      sockets.push(s); onNeighbor(s, true)
    },
    async stop () {
      for (const s of servers) { try { s.close() } catch {} }
      for (const s of sockets) { try { s.destroy() } catch {} }
    }
  }
}

function room (name, host, link) {
  return new Room({
    name: 'stadium', nickname: name, host,
    Corestore, crypto, b4a, transport: new MeshTransport({ link }), storageDir: tmp()
  })
}

test('multi-hop: A->B->C relay (A and C never directly connect)', async () => {
  const lA = makeLink(); const lB = makeLink(); const lC = makeLink()
  const A = room('A', true, lA)   // writer
  const B = room('B', false, lB)  // relay
  const C = room('C', false, lC)  // recipient

  const p1 = PORT++; const p2 = PORT++
  await lB.accept(p1); await lB.accept(p2)
  await A.open(); await B.open(); await C.open()
  lA.dial(p1); lC.dial(p2)  // A<->B and C<->B only; never A<->C

  let got = null
  C.onEvent((e) => { if (e.kind === 'match') got = e })

  await sleep(1500)
  await A.postMatchEvent({ type: 'goal', minute: 90, text: 'RELAYED' })
  await sleep(4000)

  assert.ok(got, 'C received A\'s event')
  assert.strictEqual(got.data.text, 'RELAYED', 'event relayed A->B->C intact')

  await A.close().catch(() => {}); await B.close().catch(() => {}); await C.close().catch(() => {})
})
