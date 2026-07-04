// workers/lib/mesh-transport.js
// -----------------------------------------------------------------------------
// Stadium mesh transport — the phone-to-phone multi-hop model, proven in
// experiments/mesh-chain-selfheal.js.
//
// It implements the SAME interface as SwarmTransport (join/onConnection/
// onPeers/connectionCount/destroy), so Room + Hypercore are unchanged. The only
// difference is WHERE the duplex streams come from:
//
//   SwarmTransport: streams come from Hyperswarm (internet DHT / LAN mDNS).
//   MeshTransport:  streams come from a `link` layer — each stream is a direct
//                   radio link to a NEARBY phone. Hypercore then replicates the
//                   feed hop-by-hop across overlapping links, spanning the whole
//                   stadium and self-healing around peers that leave.
//
// The `link` layer is injected so this stays transport-agnostic:
//   - on desktop tests: TCP loopback sockets
//   - on Android: a native Nearby-Connections / WiFi-Direct module that surfaces
//     each accepted/dialed neighbor as a duplex stream via `onNeighbor(stream)`.
//
// This file contains NO radio code — it's the glue that turns "a stream of nearby
// neighbor connections" into the transport Room expects. The native module only
// has to emit neighbor streams; Hypercore's replication does the multi-hop relay.
// -----------------------------------------------------------------------------

class MeshTransport {
  /**
   * @param {object} opts
   * @param {object} opts.link - the neighbor-link layer. Must provide:
   *     start(topic)              begin advertising/scanning for nearby peers on this topic
   *     onNeighbor(fn)            fn(duplexStream) called for each connected nearby peer
   *     stop()                    stop and close all neighbor links
   */
  constructor({ link }) {
    if (!link) throw new Error('MeshTransport requires a `link` layer (radio or test)')
    this._link = link
    this._conns = new Set()
    this._onConnection = () => {}
    this._onPeers = () => {}
  }

  onConnection(fn) {
    this._onConnection = fn
  }
  onPeers(fn) {
    this._onPeers = fn
  }
  connectionCount() {
    return this._conns.size
  }

  async join(topicName) {
    // The link layer emits (stream, initiator) for each nearby-peer connection.
    // `initiator` must differ on the two ends of a link (Hypercore requirement):
    // the dialer is the initiator, the accepter is not.
    this._link.onNeighbor((stream, initiator) => {
      this._conns.add(stream)
      this._onPeers(this._conns.size)
      stream.on('error', () => {})
      stream.on('close', () => {
        this._conns.delete(stream)
        this._onPeers(this._conns.size)
      })
      // Hand Room a raw stream + its initiator role; Room builds the replication.
      this._onConnection({ initiator: !!initiator, stream })
    })
    await this._link.start(topicName)
  }

  async destroy() {
    try {
      await this._link.stop()
    } catch {}
    for (const s of this._conns) {
      try {
        s.destroy()
      } catch {}
    }
    this._conns.clear()
  }
}

module.exports = { MeshTransport }
