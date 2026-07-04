// renderer/ui/betting-panel.js
// -----------------------------------------------------------------------------
// The on-chain betting panel (WDK / Wallets track). Pure-ish view: it renders
// the wallet state, a create-bet form, and a live bet list, and forwards user
// intent through callbacks. app.js wires those callbacks to renderer/wallet.js
// (WDK + escrow) and to the worker (QVAC odds/outcome).
//
// Money model: pari-mutuel USDT escrow. Stakes and payouts are on-chain; the AI
// odds are informational. See BETTING-PLAN.md.
// -----------------------------------------------------------------------------

import { el } from './dom.js'

// USDT here is 6-decimals (MockUSDT / common USDT). Format/parse base units.
const USDT_DECIMALS = 6
const UNIT = 10n ** BigInt(USDT_DECIMALS)

export function formatUsdt(base) {
  const b = BigInt(base)
  const whole = b / UNIT
  const frac = (b % UNIT).toString().padStart(USDT_DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export function parseUsdt(str) {
  const s = String(str).trim()
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('enter a number, e.g. 10 or 2.5')
  const [w, f = ''] = s.split('.')
  const frac = (f + '0'.repeat(USDT_DECIMALS)).slice(0, USDT_DECIMALS)
  return BigInt(w) * UNIT + BigInt(frac || '0')
}

export class BettingPanel {
  /**
   * @param {HTMLElement} root  container to render into
   * @param {object} opts
   * @param {boolean} opts.isHost  hosts can create bets, propose + confirm results
   */
  constructor(root, { isHost = false } = {}) {
    this.root = root
    this.isHost = isHost
    this.address = null

    // Callbacks (wired by app.js).
    this.cb = {
      connect: async () => {}, // -> { address }
      createWallet: async () => {}, // generate a new local seed then connect
      refreshBalance: async () => {}, // -> { usdt, native }
      createBet: async () => {}, // ({question,outcomes,closesInMin}) -> {betId}
      join: async () => {}, // ({betId,outcome,amount})
      odds: async () => {}, // ({betId,question,outcomes}) -> {probabilities,rationale}
      propose: async () => {}, // ({betId,question,outcomes}) proposes AI outcome on-chain
      confirm: async () => {}, // (betId)
      claim: async () => {}, // (betId)
      cancel: async () => {}, // (betId)
      refund: async () => {}, // (betId)
      refreshBet: async () => {}, // (betId) -> bet struct
      revealSeed: () => null, // () -> the stored seed phrase (for "Show seed")
      faucetGas: async () => {}, // () send test gas (local node only)
      faucetUsdt: async () => {}, // () mint test USDT
      isLocalTestnet: () => false // () -> bool: is the gas faucet usable?
    }
    this._build()
  }

  on(name, fn) {
    this.cb[name] = fn
    return this
  }

  // ---- structure ---------------------------------------------------------

  _build() {
    this.root.replaceChildren()

    // Wallet row
    this.walletBox = el('div', { cls: 'bet-wallet' })
    this.walletBox.append(
      el('span', { cls: 'bet-wallet-title', text: '💳 Wallet (WDK, self-custodial)' })
    )
    this.addrLine = el('div', { cls: 'bet-addr', text: 'not connected' })
    this.balLine = el('div', { cls: 'bet-bal hint', text: '' })
    this.connectBtn = el('button', { cls: 'evt', text: 'Connect wallet' })
    this.newWalletBtn = el('button', { cls: 'evt', text: 'Create new wallet' })
    this.showSeedBtn = el('button', { cls: 'evt hidden', text: 'Show seed' })
    this.connectBtn.addEventListener('click', () => this._connect(false))
    this.newWalletBtn.addEventListener('click', () => this._connect(true))
    this.showSeedBtn.addEventListener('click', () => this._toggleSeedReveal())
    const walletBtns = el('div', { cls: 'bet-row' })
    walletBtns.append(this.connectBtn, this.newWalletBtn, this.showSeedBtn)
    this.walletBox.append(this.addrLine, this.balLine, walletBtns)

    // Test faucet (shown when connected). Gas button is hidden off local node.
    this.faucetRow = el('div', { cls: 'bet-row bet-faucet hidden' })
    this.gasBtn = el('button', { cls: 'evt', text: '⛽ Get test gas' })
    this.usdtBtn = el('button', { cls: 'evt', text: '🪙 Get test USDT' })
    this.gasBtn.addEventListener('click', () => this._faucet('gas'))
    this.usdtBtn.addEventListener('click', () => this._faucet('usdt'))
    this.faucetRow.append(this.gasBtn, this.usdtBtn)
    this.walletBox.append(this.faucetRow)

    // One-time backup box (shown right after creating a wallet, then removed).
    this.seedBackup = el('div', { cls: 'bet-seed-backup hidden' })
    // Re-viewable seed box (revealed on demand via "Show seed").
    this.seedReveal = el('div', { cls: 'bet-seed-reveal hint hidden' })
    this.walletBox.append(this.seedBackup, this.seedReveal)
    this.root.append(this.walletBox)

    // Create-bet form (host only)
    if (this.isHost) {
      this.form = el('div', { cls: 'bet-create hidden' })
      this.qInput = el('input', { attrs: { placeholder: 'Bet question, e.g. Will Arsenal win?' } })
      this.outInput = el('input', { attrs: { placeholder: 'Outcomes, comma-separated: Yes, No' } })
      this.outInput.value = 'Yes, No'
      this.closeInput = el('input', {
        attrs: { type: 'number', min: '1', value: '90', placeholder: 'closes in (min)' },
        cls: 'minute'
      })
      this.createBtn = el('button', { cls: 'evt', text: '＋ Open bet' })
      this.createBtn.addEventListener('click', () => this._create())
      const r1 = el('div', { cls: 'bet-row' })
      r1.append(this.qInput)
      const r2 = el('div', { cls: 'bet-row' })
      r2.append(this.outInput)
      const r3 = el('div', { cls: 'bet-row' })
      r3.append(this.closeInput, this.createBtn)
      this.form.append(r1, r2, r3)
      this.root.append(this.form)
    }

    // Bets themselves render as cards in the fan-chat feed (see bet-cards.js);
    // this panel is just wallet + faucet + the host's create-bet form.
    if (this.isHost) {
      this.root.append(el('div', { cls: 'hint', text: 'Opened bets appear in the fan chat →' }))
    }

    this.status = el('p', { cls: 'bet-status hint' })
    this.root.append(this.status)
  }

  // ---- wallet ------------------------------------------------------------

  async _connect(isNew) {
    this._say(isNew ? 'creating a new wallet…' : 'connecting wallet…')
    try {
      const res = isNew ? await this.cb.createWallet() : await this.cb.connect()
      this.address = res.address
      this.addrLine.textContent = short(res.address)
      this.addrLine.title = res.address
      this.connectBtn.classList.add('hidden')
      this.newWalletBtn.classList.add('hidden')
      this.showSeedBtn.classList.remove('hidden') // can re-view the seed later
      if (this.form) this.form.classList.remove('hidden')
      // Test faucet: show it; the gas button only works on a local node.
      this.faucetRow.classList.remove('hidden')
      if (!this.cb.isLocalTestnet()) {
        this.gasBtn.disabled = true
        this.gasBtn.title = 'Local node only — use a public faucet on testnet'
        this.gasBtn.textContent = '⛽ gas: use testnet faucet'
      }
      if (isNew && res.seed) this._showBackupOnce(res.seed)
      await this.refreshBalance()
      this._say('wallet ready.')
    } catch (err) {
      this._say('wallet error: ' + err.message, true)
    }
  }

  // One-time "back this up now" box shown right after creating a wallet. It has
  // a Copy button and an "I saved it" button that removes the phrase from the UI.
  _showBackupOnce(seed) {
    this.seedBackup.replaceChildren()
    this.seedBackup.classList.remove('hidden')

    this.seedBackup.append(
      el('div', {
        cls: 'bet-seed-title',
        text: '⚠ Back up this seed phrase now — it is the ONLY way to recover this wallet.'
      })
    )
    const words = el('div', { cls: 'bet-seed-words', text: seed })
    this.seedBackup.append(words)

    const row = el('div', { cls: 'bet-row' })
    const copyBtn = el('button', { cls: 'evt', text: 'Copy' })
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(seed)
        copyBtn.textContent = 'copied!'
      } catch {
        copyBtn.textContent = 'copy failed'
      }
      setTimeout(() => {
        copyBtn.textContent = 'Copy'
      }, 1500)
    })
    const doneBtn = el('button', { cls: 'primary', text: 'I saved it' })
    doneBtn.addEventListener('click', () => {
      // Remove the phrase from the DOM entirely; re-viewable only via "Show seed".
      this.seedBackup.replaceChildren()
      this.seedBackup.classList.add('hidden')
    })
    row.append(copyBtn, doneBtn)
    this.seedBackup.append(
      el('div', {
        cls: 'hint',
        text: 'Demo note: stored locally in plaintext — not safe for real funds.'
      })
    )
    this.seedBackup.append(row)
  }

  // "Show seed" toggles an on-demand reveal of the stored phrase (hidden by
  // default; the seed is not left on screen).
  _toggleSeedReveal() {
    const showing = !this.seedReveal.classList.contains('hidden')
    if (showing) {
      this.seedReveal.replaceChildren()
      this.seedReveal.classList.add('hidden')
      this.showSeedBtn.textContent = 'Show seed'
      return
    }
    const seed = this.cb.revealSeed()
    if (!seed) {
      this._say('no seed available', true)
      return
    }
    this.seedReveal.replaceChildren()
    this.seedReveal.append(el('div', { cls: 'bet-seed-words', text: seed }))
    const copyBtn = el('button', { cls: 'evt', text: 'Copy' })
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(seed)
        copyBtn.textContent = 'copied!'
      } catch {
        copyBtn.textContent = 'copy failed'
      }
      setTimeout(() => {
        copyBtn.textContent = 'Copy'
      }, 1500)
    })
    this.seedReveal.append(copyBtn)
    this.seedReveal.classList.remove('hidden')
    this.showSeedBtn.textContent = 'Hide seed'
  }

  // Test faucet: top up gas (local node) or mint test USDT, then refresh balance.
  async _faucet(kind) {
    const btn = kind === 'gas' ? this.gasBtn : this.usdtBtn
    const label = btn.textContent
    btn.disabled = true
    this._say(kind === 'gas' ? 'requesting test gas…' : 'minting test USDT…')
    try {
      if (kind === 'gas') await this.cb.faucetGas()
      else await this.cb.faucetUsdt()
      await this.refreshBalance()
      this._say(kind === 'gas' ? 'gas topped up.' : 'test USDT minted.')
    } catch (err) {
      this._say(`${kind} faucet failed: ` + err.message, true)
    } finally {
      btn.disabled = false
      btn.textContent = label
    }
  }

  async refreshBalance() {
    try {
      const { usdt, native } = await this.cb.refreshBalance()
      this.balLine.textContent =
        `USDT: ${formatUsdt(usdt)}` + (native !== null ? ` · gas: ${trimNative(native)}` : '')
    } catch (err) {
      this.balLine.textContent = 'balance unavailable: ' + err.message
    }
  }

  // ---- create ------------------------------------------------------------

  async _create() {
    const question = this.qInput.value.trim()
    const outcomes = this.outInput.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const closesInMin = Number(this.closeInput.value) || 90
    if (!question) return this._say('enter a question', true)
    if (outcomes.length < 2) return this._say('need at least 2 outcomes', true)
    this._say('opening bet on-chain…')
    this.createBtn.disabled = true
    try {
      const { betId } = await this.cb.createBet({ question, outcomes, closesInMin })
      // The card is rendered in the chat feed by app.js (chain-sourced), not here.
      this.qInput.value = ''
      this._say(`bet #${betId} opened — see it in chat.`)
    } catch (err) {
      this._say('create failed: ' + err.message, true)
    } finally {
      this.createBtn.disabled = false
    }
  }

  // ---- status ------------------------------------------------------------

  _say(text, isError = false) {
    this.status.textContent = text
    this.status.style.color = isError ? '#e66' : ''
  }
}

function short(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
}
function trimNative(wei) {
  // Show a few significant digits of the native (gas) balance.
  const s = (Number(BigInt(wei) / 10n ** 12n) / 1e6).toFixed(4)
  return s
}
