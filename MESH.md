# Stadium Mesh — offline multi-hop watch-party 🏟️

How PitchSide reaches "the whole stadium" with **no internet and no shared
network** — every fan's phone relays the watch-party to its neighbors, so a goal
ripples across overlapping short-range links, hop by hop.

## The idea

No single radio can cover a stadium (WiFi Direct ≈ 10–30m through a crowd, ~8
peers per group). So instead of one big network, we build a **multi-hop mesh**:

```
Section A                Section B                Section C
[fan]─[fan]─[fan]──────[fan]─[fan]─[fan]────────[fan]─[fan]
        │      the same data hops phone → phone → phone      │
        └────────────  across the whole stadium  ────────────┘
```

Each phone links only to a few nearby phones. A "GOAL" posted anywhere
**replicates neighbor-to-neighbor** until it has spanned the venue. No phone
needs to reach the whole stadium — the crowd's overlapping links _are_ the network.

## Why this actually works: Hypercore does the relay

The mesh "brain" is already solved by our data layer. **Hypercore replicates over
any duplex stream and gossips data across the whole connected peer graph.** A
relay peer that has the feed automatically forwards it to its neighbors. That's
multi-hop — no routing code required.

**Proven on desktop** (run these):

| Proof                           | File                                 | Result                      |
| ------------------------------- | ------------------------------------ | --------------------------- |
| A→B→C relay (A,C never linked)  | `experiments/multihop-mesh-proof.js` | ✅ C gets A's event via B   |
| 5-node chain A→B→C→D→E          | `experiments/mesh-chain-selfheal.js` | ✅ reaches E, 4 hops        |
| Self-healing (kill a relay)     | `experiments/mesh-chain-selfheal.js` | ✅ reroutes via backup path |
| App `Room` over `MeshTransport` | `experiments/room-over-mesh.js`      | ✅ real app code multi-hops |

## Architecture: pluggable transport

The networking is abstracted behind one interface, so the **same data layer**
runs over the internet swarm (dev) or the stadium mesh (offline):

```
        Room  +  Hypercore/Autobase   (data + multi-hop relay — UNCHANGED)
                       │
                 Transport interface   (join / onConnection / onPeers / destroy)
              ┌────────┴────────┐
     SwarmTransport         MeshTransport
     (Hyperswarm:           (phone-to-phone links via a `link` layer;
      internet DHT / LAN)    Hypercore relays hop-by-hop over them)
```

- `workers/lib/transport.js` — `SwarmTransport` (Hyperswarm, dev + LAN).
- `workers/lib/mesh-transport.js` — `MeshTransport`: turns a stream of nearby-peer
  connections into the transport Room expects. **Contains no radio code** — it
  consumes neighbor streams from an injected `link` layer.
- `workers/lib/room.js` — replicates the store over whatever connections the
  transport yields (Noise stream from swarm, or `{initiator, stream}` from mesh).

Swapping `SwarmTransport` → `MeshTransport` swaps the entire networking model
**without touching Room, the feed, or Hypercore.**

## What's built vs. what's left

| Layer                         | Status                                |
| ----------------------------- | ------------------------------------- |
| Multi-hop relay / gossip      | ✅ Hypercore (proven)                 |
| Self-healing reroute          | ✅ Hypercore (proven)                 |
| Pluggable transport interface | ✅ `SwarmTransport` + `MeshTransport` |
| App `Room` over mesh          | ✅ verified                           |
| Swarm path (no regression)    | ✅ verified                           |
| **Radio `link` layer**        | ⚠️ **to build** — native module       |

### The remaining piece: the `link` layer

`MeshTransport` needs a `link` object that emits nearby-phone connections:

```js
link = {
  start(topic)          // advertise + scan for nearby peers on this topic
  onNeighbor(fn)        // fn(duplexStream, isInitiator) per connected nearby peer
  stop()                // close all links
}
```

On desktop tests this is TCP loopback. On Android it's a **native module wrapping
Google Nearby Connections (`P2P_CLUSTER`)** — which auto-uses BLE + WiFi, fully
offline, M:N topology. It just has to surface each accepted/dialed neighbor as a
duplex stream; Hypercore's replication does the rest.

That native module is the only radio-specific work remaining. Everything above it
— the mesh relay, self-healing, transport abstraction, and app integration — is
built and verified.
