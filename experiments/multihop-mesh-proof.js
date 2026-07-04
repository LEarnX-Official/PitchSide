// Multi-hop mesh proof (desktop, no internet, explicit topology via TCP loopback).
//
// Topology — A and C are "out of radio range" of each other (NO direct link):
//
//     A <--tcp--> B <--tcp--> C
//
// A appends "GOAL" to the shared feed. A only connects to B. C only connects to B.
// If C receives the GOAL, it PROVES the data multi-hopped A->B->C via B relaying —
// exactly how a stadium mesh spans devices that can't directly reach each other.
//
// TCP loopback sockets stand in for the real radio links (Nearby-Connections /
// WiFi-Direct). Hypercore's store.replicate() is identical over any duplex stream,
// so this validates the DATA layer that will run over the eventual radio transport.

const net = require('net')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

// Shared deterministic key -> all three peers open the SAME feed.
const seed = crypto.hash(b4a.from('pitchside:stadium-mesh'))
const keyPair = crypto.keyPair(seed)

// A is the writer (has the keypair). B and C are read-only replicas that open the
// SAME core by its public key — exactly how the app's host/guest model works.
function makePeer(name, writable) {
  const store = new Corestore('./.mesh-store-' + name)
  // Pass BOTH key and keyPair for the writer so core.key === keyPair.publicKey,
  // matching what read-only replicas open by. (store.get({keyPair}) alone derives
  // a DIFFERENT key and breaks replication.)
  const feed = writable
    ? store.get({ key: keyPair.publicKey, keyPair, valueEncoding: 'json' })
    : store.get({ key: keyPair.publicKey, valueEncoding: 'json' })
  return { name, store, feed }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// Replicate a store over a raw socket. isInitiator must differ on each end.
// Corestore.replicate(isInitiator, { stream }) creates the protocol stream and
// pipes it through the given raw socket.
function replicateOver(store, socket, isInitiator) {
  const proto = store.replicate(isInitiator)
  proto.pipe(socket).pipe(proto)
}
function listen(relay, port) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      replicateOver(relay.store, socket, false) // inbound = responder
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
function dial(peer, port, label) {
  const socket = net.connect(port, '127.0.0.1', () => console.log(`  🔗 ${label}`))
  replicateOver(peer.store, socket, true) // outbound = initiator
}

async function main() {
  console.log('=== Multi-hop stadium mesh test ===\n')
  const A = makePeer('A', true) // writer (the fan who posts the GOAL)
  const B = makePeer('B', false) // relay (read-only replica)
  const C = makePeer('C', false) // recipient (read-only replica)
  await A.feed.ready()
  await B.feed.ready()
  await C.feed.ready()

  console.log('Topology:  A <-> B <-> C     (A and C are NOT linked)\n')

  // B accepts two inbound links (from A and from C) on two ports.
  await listen(B, 49801)
  await listen(B, 49802)

  // A dials B; C dials B. A and C never learn about each other.
  dial(A, 49801, 'A connected to B')
  dial(C, 49802, 'C connected to B')

  // The relay B must actually DOWNLOAD the data so it can forward it to C.
  B.feed.download({ start: 0, end: -1 })
  B.feed.on('append', async () => {
    console.log(`  ↻ [B] relayed block (len=${B.feed.length}) — now available to C`)
  })
  const pollB = setInterval(() => B.feed.update().catch(() => {}), 300)

  // C watches for arriving data (can ONLY come via B relaying).
  let got = null
  C.feed.download({ start: 0, end: -1 })
  C.feed.on('append', async () => {
    const last = await C.feed.get(C.feed.length - 1)
    got = last
    console.log(`  ⇐ [C] received: ${JSON.stringify(last)}   <-- hopped A->B->C!`)
  })
  const poll = setInterval(() => C.feed.update().catch(() => {}), 300)

  await sleep(1000) // let handshakes settle
  console.log('\n[A] appending GOAL to the shared feed...')
  await A.feed.append({ type: 'goal', minute: 90, text: 'GOAL! (A posted this)' })

  await sleep(4000) // propagate across two hops
  clearInterval(poll)
  clearInterval(pollB)

  console.log('\n=== RESULT ===')
  if (got && got.text && got.text.includes('A posted')) {
    console.log("✅ MULTI-HOP WORKS: C received A's event without ever connecting to A.")
    console.log('   Data relayed A -> B -> C. This is the stadium-mesh concept, proven.')
  } else {
    console.log('❌ C did not receive it. C.feed.length =', C.feed.length)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack)
  process.exit(1)
})
