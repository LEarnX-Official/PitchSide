// Proves the ACTUAL app Room class works over the pluggable MeshTransport,
// relaying A -> B -> C where A and C never directly connect. Same multi-hop
// result as the raw prototype, but now through the real Room + feed + transport
// stack the app uses — validating the pluggable-transport refactor end to end.

const net = require('net')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const { Room } = require('../workers/lib/room.js')
const { MeshTransport } = require('../workers/lib/mesh-transport.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let PORT = 49850

// A minimal TCP-loopback "link layer" implementing the interface a native
// Nearby-Connections module would implement: start/onNeighbor/stop. We manually
// wire the topology so A and C only ever neighbor B.
function makeLink () {
  let onNeighbor = () => {}
  const servers = []
  const sockets = []
  return {
    _servers: servers,
    onNeighbor (fn) { onNeighbor = fn },
    async start () {},
    // test helper: accept an inbound neighbor on a port (accepter = NOT initiator)
    async accept (port) {
      const server = net.createServer((socket) => { socket.on('error', () => {}); onNeighbor(socket, false) })
      servers.push(server)
      await new Promise((r) => server.listen(port, '127.0.0.1', r))
    },
    // test helper: dial a neighbor (dialer = initiator)
    dial (port) {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('error', () => {})
      sockets.push(socket)
      onNeighbor(socket, true)
    },
    async stop () {
      for (const s of servers) { try { s.close() } catch {} }
      for (const s of sockets) { try { s.destroy() } catch {} }
    }
  }
}

async function makeRoom (name, host, link, storage) {
  const transport = new MeshTransport({ link })
  const room = new Room({
    name: 'stadium', nickname: name, host,
    Corestore, crypto, b4a, transport,
    storageDir: storage
  })
  return room
}

async function main () {
  console.log('=== App Room over MeshTransport: A -> B -> C multi-hop ===\n')

  const linkA = makeLink(); const linkB = makeLink(); const linkC = makeLink()
  const A = await makeRoom('A', true, linkA, './.rmesh-a')   // host/writer
  const B = await makeRoom('B', false, linkB, './.rmesh-b')  // relay
  const C = await makeRoom('C', false, linkC, './.rmesh-c')  // recipient

  // Topology: B accepts from A (port1) and from C (port2). A dials B, C dials B.
  const p1 = PORT++; const p2 = PORT++
  await linkB.accept(p1)
  await linkB.accept(p2)

  // Open rooms (starts transport + appends the join system event).
  await A.open(); await B.open(); await C.open()

  // Wire the neighbor links: A<->B and C<->B (never A<->C).
  linkA.dial(p1)
  linkC.dial(p2)

  // C watches its feed for A's match event.
  let got = null
  C.onEvent((e) => { if (e.kind === 'match') { got = e; console.log(`  ⇐ [C] received match: "${e.data.text}"  <-- relayed via B`) } })

  await sleep(1500)
  console.log('[A] posts a GOAL (A only neighbors B; C only neighbors B)...')
  await A.postMatchEvent({ type: 'goal', minute: 90, text: 'GOAL via app Room over mesh!' })

  await sleep(4000)

  console.log('\n=== RESULT ===')
  if (got && got.data.text.includes('over mesh')) {
    console.log('✅ App Room relayed A->B->C over MeshTransport. Pluggable transport works.')
  } else {
    console.log('❌ C did not receive it (C peers:', C.peerCount(), ')')
  }

  await A.close().catch(() => {}); await B.close().catch(() => {}); await C.close().catch(() => {})
  process.exit(0)
}

main().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1) })
