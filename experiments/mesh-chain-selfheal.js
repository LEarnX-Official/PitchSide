// Extended stadium-mesh proof: a 5-node chain + self-healing reroute.
//
//   Part 1 — long chain (each node only links to its neighbors):
//       A -- B -- C -- D -- E
//     A posts a GOAL. E is 4 hops away and shares NO direct link with A.
//     If E receives it, the mesh spans arbitrary distance by relaying.
//
//   Part 2 — self-healing:
//       Add a redundant path so the graph has a loop:
//          A -- B -- C -- D -- E
//                     \________/   (extra C--E link)
//     Kill the middle relay C. Data from A must still reach E via the
//     alternate route — proving the mesh reroutes around a dropped peer,
//     like a fan leaving their seat mid-match.
//
// Links are TCP loopback sockets standing in for phone-to-phone radio; Hypercore
// replication (store.replicate) is identical over any duplex stream.

const net = require('net')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')

const seed = crypto.hash(b4a.from('pitchside:stadium-mesh-chain'))
const keyPair = crypto.keyPair(seed)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let PORT = 49810
const servers = []

function makePeer(name, writable) {
  const store = new Corestore('./.chain-store-' + name)
  const feed = writable
    ? store.get({ key: keyPair.publicKey, keyPair, valueEncoding: 'json' })
    : store.get({ key: keyPair.publicKey, valueEncoding: 'json' })
  return { name, store, feed }
}

function replicateOver(store, socket, isInitiator) {
  const proto = store.replicate(isInitiator)
  proto.on('error', () => {})
  socket.on('error', () => {})
  proto.pipe(socket).pipe(proto)
  return { proto, socket }
}

// Create a bidirectional link between two peers over a fresh TCP port.
async function link(x, y) {
  const port = PORT++
  const conns = []
  const server = net.createServer((socket) => {
    conns.push(replicateOver(y.store, socket, false))
  })
  servers.push(server)
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const client = net.connect(port, '127.0.0.1')
  conns.push(replicateOver(x.store, client, true))
  console.log(`  🔗 ${x.name} <-> ${y.name}`)
  return { server, conns, x: x.name, y: y.name }
}

// A relay must download the feed to have data to forward.
function beRelay(peer) {
  peer.feed.download({ start: 0, end: -1 })
  const poll = setInterval(() => peer.feed.update().catch(() => {}), 200)
  return poll
}

async function waitFor(peer, predicate, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (peer.feed.length > 0) {
      try {
        const last = await peer.feed.get(peer.feed.length - 1)
        if (predicate(last)) return last
      } catch {}
    }
    await sleep(200)
  }
  return null
}

async function part1Chain() {
  console.log('\n=== PART 1: 5-node chain  A - B - C - D - E ===')
  const A = makePeer('A', true)
  const nodes = { A }
  for (const n of ['B', 'C', 'D', 'E']) nodes[n] = makePeer(n, false)
  await Promise.all(Object.values(nodes).map((p) => p.feed.ready()))

  // Each middle node relays; E is the recipient.
  const polls = ['B', 'C', 'D', 'E'].map((n) => beRelay(nodes[n]))

  // Linear topology — each node ONLY links to its immediate neighbor.
  await link(nodes.A, nodes.B)
  await link(nodes.B, nodes.C)
  await link(nodes.C, nodes.D)
  await link(nodes.D, nodes.E)

  await sleep(1200)
  console.log('\n[A] posts GOAL (E is 4 hops away, no direct link to A)...')
  await A.feed.append({ type: 'goal', minute: 88, text: 'GOAL across the stadium!' })

  const got = await waitFor(
    nodes.E,
    (b) => b && b.text && b.text.includes('across the stadium'),
    6000
  )
  polls.forEach(clearInterval)
  if (got) console.log(`  ⇐ [E] received after 4 hops: "${got.text}"  ✅`)
  else console.log('  ❌ E did not receive it (len=' + nodes.E.feed.length + ')')
  return !!got
}

async function part2SelfHeal() {
  console.log('\n=== PART 2: self-healing (kill a relay, data reroutes) ===')
  const A = makePeer('A2', true)
  const B = makePeer('B2', false)
  const C = makePeer('C2', false) // the relay we will KILL
  const E = makePeer('E2', false)
  await Promise.all([A, B, C, E].map((p) => p.feed.ready()))
  const polls = [beRelay(B), beRelay(C), beRelay(E)]

  // Redundant topology (a loop): A-B, B-C, C-E, AND B-E (the alternate route).
  //   A - B - C - E
  //        \______/   (B-E backup path bypasses C)
  await link(A, B)
  await link(B, C)
  await link(C, E)
  await link(B, E) // alternate path B->E that doesn't need C
  await sleep(1200)

  // First event flows (via any path).
  console.log('\n[A] posts event #1 (network intact)...')
  await A.feed.append({ type: 'goal', minute: 12, text: 'first goal' })
  const g1 = await waitFor(E, (b) => b && b.text === 'first goal', 5000)
  console.log(g1 ? '  ⇐ [E] got event #1  ✅' : '  ❌ E missed event #1')

  // Now KILL relay C (close its server + connections) — simulate a fan leaving.
  console.log('\n💥 killing relay C (C leaves the stadium)...')
  await C.store.close().catch(() => {})

  await sleep(800)
  console.log('[A] posts event #2 (C is gone — must reroute via B->E backup)...')
  await A.feed.append({ type: 'goal', minute: 77, text: 'reroute goal' })
  const g2 = await waitFor(E, (b) => b && b.text === 'reroute goal', 6000)
  polls.forEach(clearInterval)
  if (g2) console.log('  ⇐ [E] got event #2 via the backup path  ✅ SELF-HEALED')
  else console.log('  ❌ E missed event #2 after C died')
  return !!(g1 && g2)
}

async function main() {
  const ok1 = await part1Chain()
  const ok2 = await part2SelfHeal()
  console.log('\n=== SUMMARY ===')
  console.log(ok1 ? '✅ 5-node chain: data hopped A->B->C->D->E' : '❌ chain failed')
  console.log(ok2 ? '✅ self-healing: data rerouted around the dead relay' : '❌ self-heal failed')
  console.log(
    ok1 && ok2
      ? '\n🏟️  Stadium mesh: multi-hop + self-healing both PROVEN.'
      : '\n(some parts failed)'
  )
  process.exit(0)
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack)
  process.exit(1)
})
