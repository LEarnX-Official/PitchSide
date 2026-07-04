// renderer/ui/bet-cards.js
// -----------------------------------------------------------------------------
// Renders on-chain bet cards INSIDE the fan chat feed, keyed by betId. Bets are
// discovered from the chain (any peer can create one — createBet is
// permissionless), so cards appear in every peer's chat without a P2P feed
// write. Actions (join/odds/decide/confirm/claim/cancel/refund) call back into
// app.js, which routes them to the WDK wallet + on-device AI.
// -----------------------------------------------------------------------------

import { el } from './dom.js'
import { formatUsdt, parseUsdt } from './betting-panel.js'

export class BetCards {
  /**
   * @param {HTMLElement} container  the chat list element (cards render here)
   * @param {object} opts
   * @param {() => string|null} opts.address  current wallet address (or null)
   */
  constructor (container, { getAddress, isHost = false } = {}) {
    this.container = container
    this.getAddress = getAddress || (() => null)
    this.isHost = isHost // room host: can delete (cancel + hide) any bet card
    this.cards = new Map() // betId -> { data, node, banner }
    this.hidden = new Set() // betIds hidden by a host (stay hidden across re-sync)
    this.cb = {
      join: async () => {},
      odds: async () => {},
      propose: async () => {},
      confirm: async () => {},
      claim: async () => {},
      cancel: async () => {},
      refund: async () => {},
      refreshBet: async () => {},
      hostDelete: async () => {}, // (betId) cancel on-chain (if owned) + broadcast hide
      say: () => {}
    }
  }

  on (name, fn) { this.cb[name] = fn; return this }

  /** Sync the full set of bets from chain: add new cards, update existing. */
  sync (bets) {
    for (const b of bets) this.upsert(b)
  }

  upsert (bet) {
    if (this.hidden.has(bet.betId)) return // host-hidden; never re-render
    const existing = this.cards.get(bet.betId)
    const merged = existing ? { ...existing.data, ...bet } : bet
    const node = this._card(merged)
    if (existing) {
      existing.node.replaceWith(node)
      existing.node = node
      existing.data = merged
    } else {
      // New bet -> announce it in the chat as a system line, then the card.
      const banner = el('div', { cls: 'chat-row chat-bet-banner' })
      banner.append(el('span', { cls: 'chat-author', text: '🎲 bet' }))
      banner.append(el('div', { cls: 'chat-text', text:
        `New bet #${bet.betId}: ${bet.question}` }))
      this.container.append(banner)
      this.cards.set(bet.betId, { data: merged, node, banner })
      this.container.append(node)
    }
    this.container.scrollTop = this.container.scrollHeight
  }

  /** Hide a bet card (+ its banner) for good. Applied to all peers via the
   *  host's 'bet-hide' tombstone, and locally when the host clicks ×. */
  hide (betId) {
    this.hidden.add(betId)
    const c = this.cards.get(betId)
    if (c) {
      c.node.remove()
      if (c.banner) c.banner.remove()
      this.cards.delete(betId)
    }
  }

  _card (b) {
    const me = this.getAddress()
    const isHost = me && b.host && me.toLowerCase() === b.host.toLowerCase()
    const card = el('div', { cls: 'chat-bet-card', attrs: { 'data-bet': String(b.betId) } })

    const head = el('div', { cls: 'bet-head' })
    head.append(el('div', { cls: 'bet-q', text: `#${b.betId} · ${b.question}` }))
    // Room host can delete any bet card: cancels on-chain (if the host owns it)
    // and broadcasts a hide so it disappears for every peer.
    if (this.isHost) {
      const del = el('button', { cls: 'row-del', text: '×', attrs: { title: 'Delete bet (host)' } })
      del.addEventListener('click', (e) => { e.stopPropagation(); this._hostDelete(b.betId) })
      head.append(del)
    }
    card.append(head)
    card.append(el('div', { cls: 'bet-meta hint', text:
      `status: ${b.status} · pool: ${formatUsdt(b.totalPool || 0n)} USDT` }))
    if (b.oddsText) card.append(el('div', { cls: 'bet-odds hint', text: b.oddsText }))

    // Outcomes + join controls (only when Open and a wallet is connected).
    const outWrap = el('div', { cls: 'bet-outcomes' })
    b.outcomes.forEach((label, i) => {
      const row = el('div', { cls: 'bet-outcome-row' })
      const pool = (b.pools && b.pools[i]) || 0n
      const prob = b.probabilities && b.probabilities[i] != null
        ? ` · ${(b.probabilities[i] * 100).toFixed(0)}%` : ''
      row.append(el('span', { cls: 'bet-outcome-label', text: `${label} (${formatUsdt(pool)}${prob})` }))
      if (b.status === 'Open' && me) {
        const amt = el('input', { cls: 'minute', attrs: { placeholder: 'USDT' } })
        const joinBtn = el('button', { cls: 'evt', text: 'Join' })
        joinBtn.addEventListener('click', () => this._join(b.betId, i, amt.value))
        row.append(amt, joinBtn)
      }
      outWrap.append(row)
    })
    card.append(outWrap)

    // Actions
    const actions = el('div', { cls: 'bet-row bet-actions' })
    if (me) {
      const oddsBtn = el('button', { cls: 'evt', text: '🤖 AI odds' })
      oddsBtn.addEventListener('click', () => this._odds(b.betId))
      actions.append(oddsBtn)
    }
    if (isHost && b.status === 'Open') {
      const decideBtn = el('button', { cls: 'evt', text: '🤖 AI decide winner' })
      decideBtn.addEventListener('click', () => this._propose(b.betId))
      const cancelBtn = el('button', { cls: 'evt', text: 'Cancel' })
      cancelBtn.addEventListener('click', () => this._act('cancel', b.betId))
      actions.append(decideBtn, cancelBtn)
    } else if (isHost && b.status === 'Proposed') {
      const label = b.proposedOutcome != null && b.outcomes[b.proposedOutcome]
        ? `✔ Confirm: ${b.outcomes[b.proposedOutcome]}` : '✔ Confirm result'
      const confirmBtn = el('button', { cls: 'primary', text: label })
      confirmBtn.addEventListener('click', () => this._act('confirm', b.betId))
      const cancelBtn = el('button', { cls: 'evt', text: 'Reject' })
      cancelBtn.addEventListener('click', () => this._act('cancel', b.betId))
      actions.append(confirmBtn, cancelBtn)
    }
    if (b.status === 'Resolved' && me) {
      const claimBtn = el('button', { cls: 'primary', text: '💰 Claim' })
      claimBtn.addEventListener('click', () => this._act('claim', b.betId))
      actions.append(claimBtn)
    }
    if (b.status === 'Cancelled' && me) {
      const refundBtn = el('button', { cls: 'evt', text: '↩ Refund' })
      refundBtn.addEventListener('click', () => this._act('refund', b.betId))
      actions.append(refundBtn)
    }
    if (b.reason) card.append(el('div', { cls: 'bet-reason hint', text: '🤖 ' + b.reason }))
    if (actions.childNodes.length) card.append(actions)
    return card
  }

  // ---- actions -----------------------------------------------------------

  // Host delete: cancel the bet on-chain (if the host owns it, enabling refunds)
  // and broadcast a hide so the card vanishes for every peer. Hides locally
  // right away regardless.
  async _hostDelete (betId) {
    this.cb.say(`deleting bet #${betId}…`)
    try {
      await this.cb.hostDelete(betId) // app.js: cancel-if-owned + broadcast bet-hide
    } catch (err) {
      // Even if the on-chain cancel fails (e.g. host doesn't own the bet, or
      // it's already resolved), we still hide the card as a moderation action.
      this.cb.say('bet hidden (on-chain cancel skipped: ' + err.message + ')')
    }
    this.hide(betId)
  }

  async _join (betId, outcome, amountStr) {
    let amount
    try { amount = parseUsdt(amountStr) } catch (err) { return this.cb.say(err.message, true) }
    if (amount <= 0n) return this.cb.say('stake must be > 0', true)
    this.cb.say('approving + staking USDT…')
    try {
      await this.cb.join({ betId, outcome, amount })
      await this._refresh(betId)
      this.cb.say('stake placed.')
    } catch (err) { this.cb.say('join failed: ' + err.message, true) }
  }

  async _odds (betId) {
    const c = this.cards.get(betId); const b = c && c.data
    if (!b) return
    this.cb.say('computing on-device odds…')
    try {
      const { probabilities, rationale } = await this.cb.odds({
        betId, question: b.question, outcomes: b.outcomes
      })
      this.upsert({ ...b, probabilities, oddsText: '🤖 odds' + (rationale ? `: ${rationale}` : '') })
      this.cb.say('odds updated (informational).')
    } catch (err) { this.cb.say('odds failed: ' + err.message, true) }
  }

  async _propose (betId) {
    const c = this.cards.get(betId); const b = c && c.data
    if (!b) return
    this.cb.say('AI deciding winner on-device…')
    try {
      await this.cb.propose({ betId, question: b.question, outcomes: b.outcomes })
      await this._refresh(betId)
      this.cb.say('AI outcome proposed — confirm to pay out.')
    } catch (err) { this.cb.say('propose failed: ' + err.message, true) }
  }

  async _act (name, betId) {
    // Re-sync state first so we don't fire a tx that will revert.
    await this._refresh(betId)
    const c = this.cards.get(betId); const b = c && c.data
    if (b) {
      if (name === 'refund' && b.status !== 'Cancelled') return this.cb.say(`refund needs the bet cancelled first (status: ${b.status})`, true)
      if (name === 'claim' && b.status !== 'Resolved') return this.cb.say(`claim needs the bet resolved first (status: ${b.status})`, true)
      if (name === 'confirm' && b.status !== 'Proposed') return this.cb.say(`confirm needs an AI proposal first (status: ${b.status})`, true)
    }
    this.cb.say(name + '…')
    try {
      await this.cb[name](betId)
      await this._refresh(betId)
      this.cb.say(name + ' done.')
    } catch (err) { this.cb.say(`${name} failed: ` + err.message, true) }
  }

  async _refresh (betId) {
    try {
      const b = await this.cb.refreshBet(betId)
      if (b) this.upsert({ betId, ...b })
    } catch { /* keep current state */ }
  }
}
