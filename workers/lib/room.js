// workers/lib/room.js  (Bare/CommonJS port of the verified src/p2p/room.js)
// Owns storage + feed + a pluggable transport as one unit. The transport (swarm
// or stadium mesh) yields duplex connections; Room replicates the store over each.

const { MatchFeed } = require('./feed.js')
const { SwarmTransport } = require('./transport.js')
const { DirectTransport } = require('./direct-transport.js')
const c = require('compact-encoding')

// Guests can't write to the single-writer feed, so their chat is relayed to the
// host over a small protomux channel multiplexed on the SAME connection that
// carries Hypercore replication. The host appends it to the feed on their
// behalf (tagged with the guest's nickname). This keeps the proven single-writer
// data model while letting everyone chat — in both internet and offline modes.
const CHAT_RELAY_PROTOCOL = 'pitchside/chat-relay'
const chatRelayEncoding = c.json // { nickname, text }

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
    // Guest-side: chat-relay senders to the host (one per connection).
    this._relaySenders = new Set()
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
      let stream
      if (conn && typeof conn === 'object' && 'initiator' in conn && conn.stream) {
        const proto = this.store.replicate(conn.initiator)
        proto.on('error', () => {})
        conn.stream.on('error', () => {})
        proto.pipe(conn.stream).pipe(proto)
        stream = proto
      } else {
        stream = this.store.replicate(conn) // ready-to-replicate stream (Hyperswarm)
      }
      // Multiplex a chat-relay channel on the SAME connection's muxer, so guest
      // chat reaches the host without disturbing Hypercore replication.
      this._setupChatRelay(stream)
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

  // Open the chat-relay channel on a connection's shared protomux.
  //   - Host: receives {nickname,text} and appends it to the feed for everyone.
  //   - Guest: keeps the message handle so postChat can send to the host.
  _setupChatRelay(stream) {
    const mux = stream && stream.noiseStream && stream.noiseStream.userData
    if (!mux || typeof mux.createChannel !== 'function') return
    const channel = mux.createChannel({ protocol: CHAT_RELAY_PROTOCOL })
    if (!channel) return

    let sender = null
    const message = channel.addMessage({
      encoding: chatRelayEncoding,
      onmessage: (payload) => {
        // Only the host acts on relayed chat — it writes it to the feed.
        if (!this.isHost || !payload) return
        const text = String(payload.text || '')
          .slice(0, 500)
          .trim()
        if (!text) return
        const author = String(payload.nickname || 'guest').slice(0, 40)
        this.feed.append({ kind: 'chat', author, at: Date.now(), data: { text } }).catch(() => {})
      }
    })
    sender = message

    channel.onclose = () => this._relaySenders.delete(sender)
    channel.open()

    // Guests remember the sender to relay their chat to the host.
    if (!this.isHost) this._relaySenders.add(sender)
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
    const clean = String(text || '').trim()
    if (!clean) return false
    if (this.isHost) {
      // Host writes directly to the feed.
      return this.feed.append({
        kind: 'chat',
        author: this.nickname,
        at: Date.now(),
        data: { text: clean }
      })
    }
    // Guest: relay to the host over every open chat-relay channel (normally one:
    // the host). The host appends it to the feed, which syncs back to everyone.
    let sent = false
    for (const sender of this._relaySenders) {
      try {
        sender.send({ nickname: this.nickname, text: clean })
        sent = true
      } catch {
        /* channel closing; ignore */
      }
    }
    return sent
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
    this._relaySenders.clear()
    if (this._refreshTimer) clearInterval(this._refreshTimer)
    if (this.transport) await this.transport.destroy()
    await this.feed.close()
    await this.store.close()
  }
}

module.exports = { Room }
