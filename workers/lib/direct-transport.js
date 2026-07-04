// workers/lib/direct-transport.js
// -----------------------------------------------------------------------------
// LOCAL-NETWORK transport: no DHT, no internet — a plain TCP connection on the LAN.
//
//   - Host: binds a TCP server on a port (reachable on the local network) and
//     reports its address. Every guest that connects becomes a peer.
//   - Guest: dials the host's IP:port directly.
//
// This is the reliable "same WiFi, offline" mode. Isolated HyperDHT was tried but
// a lone bootstrap can't route lookups (PEER_NOT_FOUND) without a populated
// routing table, so a direct TCP link is the pragmatic, instant, truly-offline
// choice. It yields the same duplex streams Room replicates over, via the
// { initiator, stream } contract (like MeshTransport).
//
// `net` is injected so this file stays runtime-agnostic (bare-tcp under Pear,
// node:net under Node tests).
// -----------------------------------------------------------------------------

class DirectTransport {
  /**
   * @param {object} opts
   * @param {object} opts.net   - a `net`-like module: createServer(fn)->{listen,address,close}, connect(port,host)
   * @param {boolean} opts.host - true = bind a server; false = dial `remote`
   * @param {number}  [opts.port=49737] - port to bind (host) or dial (guest)
   * @param {string}  [opts.remoteHost] - host IP to dial (guest only)
   */
  constructor({ net, host, port = 49737, remoteHost }) {
    if (!net) throw new Error('DirectTransport requires a `net` module')
    this._net = net
    this._isHost = !!host
    this._port = port
    this._remoteHost = remoteHost
    this._server = null
    this._conns = new Set()
    this._onConnection = () => {}
    this._onPeers = () => {}
    this.localBootstrapAddress = null // { host, port } once the host is listening
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

  _track(socket, initiator) {
    this._conns.add(socket)
    this._onPeers(this._conns.size)
    socket.on('error', () => {})
    socket.on('close', () => {
      this._conns.delete(socket)
      this._onPeers(this._conns.size)
    })
    this._onConnection({ initiator, stream: socket })
  }

  async join(/* topicName unused — the port identifies the room on the LAN */) {
    if (this._isHost) {
      this._server = this._net.createServer((socket) => this._track(socket, false))
      await new Promise((resolve, reject) => {
        this._server.on('error', reject)
        // Bind to 0.0.0.0 so it's reachable across the LAN.
        this._server.listen(this._port, '0.0.0.0', resolve)
      })
      this.localBootstrapAddress = { host: '0.0.0.0', port: this._port }
    } else {
      const socket = this._net.connect(this._port, this._remoteHost || '127.0.0.1')
      this._track(socket, true)
    }
  }

  async destroy() {
    for (const s of this._conns) {
      try {
        s.destroy()
      } catch {}
    }
    this._conns.clear()
    if (this._server) {
      try {
        this._server.close()
      } catch {}
      this._server = null
    }
  }
}

module.exports = { DirectTransport }
