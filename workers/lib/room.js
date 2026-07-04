// workers/lib/room.js  (Bare/CommonJS port of the verified src/p2p/room.js)
// Owns storage + feed + a pluggable transport as one unit. The transport (swarm
// or stadium mesh) yields duplex connections; Room replicates the store over each.

const { MatchFeed } = require('./feed.js')
const { SwarmTransport } = require('./transport.js')
const { DirectTransport } = require('./direct-transport.js')

class Room {
  // Transport is chosen by `mode`:
  //   'internet' -> SwarmTransport (Hyperswarm DHT; connect from anywhere)
  //   'local'    -> DirectTransport (plain TCP on the LAN; offline, same WiFi)
  // Or pass `transport` explicitly (e.g. MeshTransport) to override. Room is
  // otherwise unchanged — it just replicates over whatever connections it yields.
  constructor({
    name,
    nickname,
    storageDir,
    host = false,
    Hyperswarm,
    DHT,
    net,
    Corestore,
    crypto,
    b4a,
    transport,
    mode = 'internet',
    localPort,
    remoteHost
  }) {
    this.name = name
    this.nickname = nickname || 'guest'
    this.isHost = host
    this._crypto = crypto
    this._b4a = b4a

    this.store = new Corestore(storageDir)
    this.feed = new MatchFeed(this.store, name, { host, crypto, b4a })

    if (transport) {
      this.transport = transport
    } else if (mode === 'local') {
      this.transport = new DirectTransport({ net, host, port: localPort || 49737, remoteHost })
    } else {
      this.transport = new SwarmTransport({ Hyperswarm, DHT, crypto, b4a, mode: 'internet' })
    }
    this._refreshTimer = null
    this._peerCount = 0
    this._peerListeners = new Set()
  }

  // After open(), if hosting a local network, this is the address guests need.
  localBootstrapAddress() {
    return this.transport && this.transport.localBootstrapAddress
  }

  async open() {
    await this.feed.ready()

    // Replicate the store over EVERY connection the transport yields — this is
    // the seam that makes swarm and mesh interchangeable.
    //   - Hyperswarm yields a Noise duplex -> replicate directly.
    //   - Mesh/raw yields { initiator, stream } -> create the protocol stream and
    //     pipe it through the raw neighbor stream.
    this.transport.onConnection((conn) => {
      if (conn && typeof conn === 'object' && 'initiator' in conn && conn.stream) {
        const proto = this.store.replicate(conn.initiator)
        proto.on('error', () => {})
        conn.stream.on('error', () => {})
        proto.pipe(conn.stream).pipe(proto)
      } else {
        this.store.replicate(conn) // ready-to-replicate stream (Hyperswarm)
      }
    })
    if (this.transport.onPeers) this.transport.onPeers((n) => this._setPeers(n))

    await this.transport.join(this.name)

    await this.feed.append({
      kind: 'system',
      author: this.nickname,
      at: Date.now(),
      data: { text: this.nickname + ' joined the room' }
    })
    this._refreshTimer = setInterval(() => this.feed.refresh().catch(() => {}), 1500)
  }

  postMatchEvent({ type, minute, text }) {
    return this.feed.append({
      kind: 'match',
      author: this.nickname,
      at: Date.now(),
      data: { type, minute, text }
    })
  }
  postChat(text) {
    return this.feed.append({ kind: 'chat', author: this.nickname, at: Date.now(), data: { text } })
  }
  postReaction(emoji) {
    return this.feed.append({
      kind: 'reaction',
      author: this.nickname,
      at: Date.now(),
      data: { emoji }
    })
  }
  postCommentary(text, { persona } = {}) {
    return this.feed.append({
      kind: 'commentary',
      author: 'AI',
      at: Date.now(),
      data: { text, persona }
    })
  }
  // Host-only moderation: append a tombstone that hides the event at `targetSeq`
  // for every peer. The log is append-only (can't erase), so 'delete' is a
  // marker the renderer applies. Host-only write is enforced by the feed.
  postDelete(targetSeq) {
    return this.feed.append({
      kind: 'delete',
      author: this.nickname,
      at: Date.now(),
      data: { targetSeq }
    })
  }
  // Host-only: broadcast that a chain-sourced bet card should be hidden for
  // everyone. Keyed by on-chain betId (bets aren't feed events, so they have no
  // seq). Every peer applies this to drop the card even as bets re-sync.
  postBetHide(betId) {
    return this.feed.append({
      kind: 'bet-hide',
      author: this.nickname,
      at: Date.now(),
      data: { betId }
    })
  }

  onEvent(fn) {
    return this.feed.onEvent(fn)
  }
  events() {
    return this.feed.events()
  }
  peerCount() {
    return this._peerCount
  }

  onPeerCount(fn) {
    this._peerListeners.add(fn)
    return () => this._peerListeners.delete(fn)
  }

  _setPeers(n) {
    this._peerCount = n
    for (const fn of this._peerListeners) fn(n)
  }

  async close() {
    this._peerListeners.clear()
    if (this._refreshTimer) clearInterval(this._refreshTimer)
    if (this.transport) await this.transport.destroy()
    await this.feed.close()
    await this.store.close()
  }
}

module.exports = { Room }
