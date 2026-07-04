// workers/lib/transport.js
// -----------------------------------------------------------------------------
// Pluggable P2P transport. A Room doesn't care HOW peers connect — it just needs
// a stream of "connections" (duplex streams) to replicate its Corestore over.
//
// Two implementations share one interface:
//
//   Transport {
//     join(topic)            // start discovering/connecting peers for this topic
//     onConnection(fn)       // fn(duplexStream) called for each new peer link
//     connectionCount()      // live peer count
//     destroy()              // tear down
//   }
//
//   - SwarmTransport: Hyperswarm over the internet DHT / local mDNS (dev + LAN).
//   - MeshTransport (see mesh-transport.js): phone-to-phone radio links that
//     relay hop-by-hop across a stadium (the proven multi-hop model). It yields
//     the exact same duplex streams, so Room + Hypercore are unchanged.
//
// Because Hypercore replicates over ANY duplex stream, swapping the transport
// swaps the whole networking model without touching the data layer.
// -----------------------------------------------------------------------------

class SwarmTransport {
  // Internet P2P via the Holepunch DHT — peers connect from anywhere (needs
  // internet). For the offline "same WiFi" mode, Room uses DirectTransport
  // instead (isolated DHT proved unreliable: a lone bootstrap can't route).
  constructor({ Hyperswarm, crypto, b4a }) {
    this._Hyperswarm = Hyperswarm
    this._crypto = crypto
    this._b4a = b4a
    this.swarm = null
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
    return this.swarm ? this.swarm.connections.size : 0
  }

  async join(topicName) {
    this.swarm = new this._Hyperswarm()
    this.swarm.on('connection', (conn) => {
      conn.on('error', () => {})
      this._onConnection(conn)
      this._onPeers(this.swarm.connections.size)
      conn.on('close', () => this._onPeers(this.swarm.connections.size))
    })
    const topic = this._crypto.hash(this._b4a.from('pitchside:room:' + topicName))
    const discovery = this.swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
  }

  async destroy() {
    if (this.swarm) await this.swarm.destroy()
    this.swarm = null
  }
}

module.exports = { SwarmTransport }
