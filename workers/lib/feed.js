// workers/lib/feed.js  (Bare/CommonJS port of the verified src/p2p/feed.js)
// Shared-key Hypercore feed: all peers derive the same core from the room name;
// host writes, guests read. Verified cross-peer sync under Node.

class MatchFeed {
  constructor (store, roomName, { host = false, crypto, b4a } = {}) {
    this._events = []
    this._listeners = new Set()
    this._applied = 0
    this._syncing = null
    this.isHost = host

    const seed = crypto.hash(b4a.from('pitchside:feed:' + roomName))
    const keyPair = crypto.keyPair(seed)
    this.core = store.get({ keyPair, valueEncoding: 'json' })
  }

  async ready () {
    await this.core.ready()
    this.core.on('append', () => { this._sync().catch(() => {}) })
    await this._sync()
  }

  async append (event) {
    if (!this.isHost) return false
    await this.core.append(event)
    await this._sync()
    return true
  }

  events () { return this._events.slice() }

  onEvent (fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  refresh () { return this.core.update() }

  _sync () {
    if (this._syncing) return this._syncing
    this._syncing = this._drain().finally(() => { this._syncing = null })
    return this._syncing
  }

  async _drain () {
    while (this._applied < this.core.length) {
      const i = this._applied
      const event = await this.core.get(i)
      this._applied = i + 1
      // Tag with the Hypercore seq (its append position) so it can be
      // referenced later — e.g. a host 'delete' tombstone targets this seq.
      event.seq = i
      this._events.push(event)
      this._emit(event)
    }
  }

  _emit (event) {
    for (const fn of this._listeners) {
      try { fn(event) } catch {}
    }
  }

  async close () {
    this._listeners.clear()
    await this.core.close()
  }
}

module.exports = { MatchFeed }
