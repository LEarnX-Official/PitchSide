// renderer/wallet.js
// -----------------------------------------------------------------------------
// WDK-based self-custodial wallet for PitchSide betting (WDK / Wallets track).
//
// Uses Tether's Wallet Development Kit (@tetherto/wdk-wallet-evm): the user
// holds their own BIP-39 seed. On first run the app GENERATES a seed locally and
// stores it on-device; the user can also import an existing phrase. The wallet
// runs in the Electron RENDERER (full JS env), not the Bare worker — WDK is
// built on ethers and expects Node/browser primitives.
//
// The escrow lives on-chain (contracts/PitchSideBets.sol). This module calls its
// methods with WDK's account.sendTransaction({ to, data }), where `data` is
// calldata encoded by an ethers Interface. USDT approvals use WDK's native
// account.approve(). The target chain is chosen purely by the RPC we pass as the
// WDK `provider` (BSC testnet RPC -> chainId 97 automatically).
//
// ⚠️ SECURITY NOTE (hackathon scope): the seed is stored in localStorage in
// plaintext for the demo. That is NOT safe for real funds. Before mainnet the
// seed must be encrypted at rest (passphrase-derived key) and/or moved to OS
// secure storage. This is called out in BETTING-PLAN.md §6 hardening.
// -----------------------------------------------------------------------------

import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { SeedSignerEvm } from '@tetherto/wdk-wallet-evm/signers'
import { ethers } from 'ethers'
import * as bip39 from 'bip39'

import PitchSideBetsAbi from './contract/PitchSideBets.abi.js'

const SEED_KEY = 'pitchside.wdk.seed'

// Bet lifecycle status enum (mirrors PitchSideBets.Status).
export const BetStatus = ['Open', 'Proposed', 'Resolved', 'Cancelled']

// A short set of well-known endpoints, keyed by chainId lookup below. The app
// picks the network whose chainId matches the active deployment.
export const NETWORKS = {
  // Local Hardhat node for end-to-end testing (no real key / faucet needed).
  localhost: {
    name: 'Localhost (Hardhat)',
    chainId: 31337,
    rpc: 'http://127.0.0.1:8545',
    explorer: ''
  },
  bscTestnet: {
    name: 'BSC Testnet',
    chainId: 97,
    rpc: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    explorer: 'https://testnet.bscscan.com'
  },
  bscMainnet: {
    name: 'BSC Mainnet',
    chainId: 56,
    rpc: 'https://bsc-dataseed.bnbchain.org',
    explorer: 'https://bscscan.com'
  }
}

// ---------------------------------------------------------------------------
// Seed management (self-custodial, local)
// ---------------------------------------------------------------------------

export function hasStoredSeed() {
  return !!localStorage.getItem(SEED_KEY)
}

/** Generate a fresh BIP-39 seed phrase (128-bit -> 12 words) and store it. */
export function generateSeed() {
  const phrase = bip39.generateMnemonic(128)
  localStorage.setItem(SEED_KEY, phrase)
  return phrase
}

/** Import an existing phrase (validated), replacing any stored one. */
export function importSeed(phrase) {
  const clean = String(phrase).trim().toLowerCase().replace(/\s+/g, ' ')
  if (!bip39.validateMnemonic(clean)) throw new Error('Invalid seed phrase')
  localStorage.setItem(SEED_KEY, clean)
  return clean
}

export function loadStoredSeed() {
  return localStorage.getItem(SEED_KEY)
}

/** Danger: forget the local seed (does not touch on-chain funds). */
export function forgetSeed() {
  localStorage.removeItem(SEED_KEY)
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export class Wallet {
  /**
   * @param {object} opts
   * @param {object} opts.deployment  { chainId, usdt, bets } from contracts/deployments
   * @param {string} [opts.rpc]       RPC URL (defaults to a network matching deployment.chainId, else BSC testnet)
   */
  constructor({ deployment, rpc } = {}) {
    if (!deployment || !deployment.bets || !deployment.usdt) {
      throw new Error('wallet needs a deployment with { usdt, bets } addresses')
    }
    this.deployment = deployment
    this.network =
      Object.values(NETWORKS).find((n) => n.chainId === deployment.chainId) ||
      NETWORKS.bscTestnet
    this.rpc = rpc || this.network.rpc

    this._manager = null
    this._account = null
    this.address = null

    // A single reused read provider (a fresh one per call caches nonces
    // inconsistently, which collides with WDK's own pending-nonce read).
    this._readProvider = new ethers.JsonRpcProvider(this.rpc)

    // Explicit monotonic nonce. WDK/ethers derive the nonce from the pending
    // tx count, which lags under instant automining and causes "nonce too low"
    // on rapid sequential sends. We seed from chain on connect and advance it
    // ourselves, passing an explicit nonce to every signed tx. A mutex chains
    // sends so two calls can't grab the same nonce.
    this._nonce = null
    this._txChain = Promise.resolve()

    // ethers Interfaces for encoding calldata / decoding events (no signing).
    this._betsIface = new ethers.Interface(PitchSideBetsAbi)
  }

  /** Initialise WDK from the stored seed and derive account 0. */
  async connect() {
    const seed = loadStoredSeed()
    if (!seed) throw new Error('no wallet seed — generate or import one first')

    const root = new SeedSignerEvm(seed)
    this._manager = new WalletManagerEvm(root, { provider: this.rpc })
    this._account = await this._manager.getAccount(0)
    this.address = await this._account.getAddress()
    // Seed the local nonce from the chain's current confirmed count.
    this._nonce = await this._readProvider.getTransactionCount(this.address, 'latest')
    return this.address
  }

  /**
   * Serialize a signed send and give it an explicit, monotonic nonce. Waits for
   * the receipt (so state + balances are current) and throws on revert.
   * @param {(nonce:number)=>Promise<{hash:string}>} sendFn
   */
  async _serialTx(sendFn) {
    const run = this._txChain.then(async () => {
      if (this._nonce == null) {
        this._nonce = await this._readProvider.getTransactionCount(this.address, 'latest')
      }
      const nonce = this._nonce
      let res
      try {
        res = await sendFn(nonce)
      } catch (err) {
        // On failure, resync the nonce from chain so the next call recovers.
        this._nonce = await this._readProvider.getTransactionCount(this.address, 'latest')
        throw this._decodeError(err)
      }
      this._nonce = nonce + 1
      await this._waitMined(res.hash)
      return res
    })
    // Keep the chain alive even if this link rejects.
    this._txChain = run.catch(() => {})
    return run
  }

  /**
   * Turn a raw revert (custom-error selector or hex blob) into a readable Error.
   * The escrow uses custom errors like CannotCancelNow / NotHost; ethers/WDK
   * surface these as opaque CALL_EXCEPTIONs, so we decode them ourselves.
   */
  _decodeError(err) {
    // Friendly messages for the escrow's custom errors.
    const friendly = {
      CannotCancelNow: 'not allowed in this state (e.g. bet not cancelled, or already resolved)',
      NothingToClaim: 'nothing to withdraw here',
      AlreadyWithdrawn: 'already withdrawn',
      NotWinner: 'you did not back the winning outcome',
      NotHost: 'only the bet host can do that',
      NotProposed: 'the result has not been proposed yet',
      NotOpen: 'the bet is no longer open',
      BettingClosed: 'betting has closed for this bet',
      DisputeWindowActive: 'the dispute window has not elapsed yet',
      InvalidOutcome: 'invalid outcome',
      ZeroAmount: 'amount must be greater than zero',
      UnknownBet: 'unknown bet id'
    }
    // Dig out revert data from the various shapes ethers/WDK produce.
    const data =
      err?.data?.data || err?.data || err?.info?.error?.data?.data ||
      err?.info?.error?.data || err?.error?.data || null
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
      try {
        const parsed = this._betsIface.parseError(data)
        if (parsed) {
          const msg = friendly[parsed.name] || parsed.name
          return new Error(msg)
        }
      } catch { /* not one of our errors */ }
    }
    // Fall back to a concise message rather than a giant JSON dump.
    return new Error(err?.shortMessage || err?.reason || err?.message || 'transaction failed')
  }

  get connected() {
    return !!this._account
  }

  // ---- balances ----------------------------------------------------------

  /** Native (tBNB) balance in wei. */
  async getNativeBalance() {
    this._need()
    return this._account.getBalance()
  }

  /** USDT balance in base units (BigInt). */
  async getUsdtBalance() {
    this._need()
    return this._account.getTokenBalance(this.deployment.usdt)
  }

  // ---- test faucet (local testing only) ---------------------------------

  /** True only where the in-app faucet can work (local Hardhat node). */
  get isLocalTestnet() {
    return this.deployment.chainId === 31337
  }

  /**
   * Send test GAS to this wallet from Hardhat's well-known dev account #0.
   * ONLY works on a local Hardhat node (chainId 31337) — that private key is a
   * public, documented test key with no value on any real network. Throws
   * elsewhere so it can't be misused.
   * @param {string|number} amountEth  native amount to send (default 10)
   */
  async faucetGas(amountEth = 10) {
    this._need()
    if (!this.isLocalTestnet) {
      throw new Error('gas faucet is local-node only — use a public faucet on testnet')
    }
    // Hardhat account #0 (deterministic dev key; safe on local node only).
    const HARDHAT_KEY =
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const funder = new ethers.Wallet(HARDHAT_KEY, this._readProvider)
    const tx = await funder.sendTransaction({
      to: this.address,
      value: ethers.parseEther(String(amountEth))
    })
    await tx.wait()
    return tx.hash
  }

  /**
   * Mint test USDT to this wallet. Our MockUSDT has an open `mint`, so the
   * connected wallet mints to itself (needs gas first). Amount is whole USDT.
   */
  async faucetUsdt(amount = 10000) {
    this._need()
    const erc20 = new ethers.Interface([
      'function mint(address to, uint256 amount)',
      'function decimals() view returns (uint8)'
    ])
    // Read the token's decimals so the amount is correct regardless of token.
    let decimals = 6
    try {
      const raw = await this._readProvider.call({
        to: this.deployment.usdt,
        data: erc20.encodeFunctionData('decimals', [])
      })
      decimals = Number(erc20.decodeFunctionResult('decimals', raw)[0])
    } catch { /* default 6 */ }
    const base = ethers.parseUnits(String(amount), decimals)
    const data = erc20.encodeFunctionData('mint', [this.address, base])
    return this._serialTx((nonce) =>
      this._account.sendTransaction({ to: this.deployment.usdt, data, value: 0n, nonce })
    )
  }

  // ---- escrow interactions ----------------------------------------------

  /**
   * Approve the escrow to pull `amount` USDT. WDK handles the USDT
   * reset-to-zero-before-nonzero quirk; if it surfaces that error we retry with
   * a 0 approval first, then the target amount.
   */
  async approveUsdt(amount) {
    this._need()
    // Encode ERC-20 approve ourselves and send via _serialTx so it shares the
    // explicit-nonce path (WDK's account.approve() picks its own nonce, which
    // collides under rapid sequential sends).
    const erc20 = new ethers.Interface([
      'function approve(address spender, uint256 amount) returns (bool)'
    ])
    const sendApprove = (amt) => {
      const data = erc20.encodeFunctionData('approve', [this.deployment.bets, amt])
      return this._serialTx((nonce) =>
        this._account.sendTransaction({ to: this.deployment.usdt, data, value: 0n, nonce })
      )
    }
    try {
      return await sendApprove(amount)
    } catch (err) {
      // Some USDT deployments require resetting a non-zero allowance to 0 first.
      if (/reset the current allowance to 0|allowance/i.test(err?.message || '')) {
        await sendApprove(0n)
        return sendApprove(amount)
      }
      throw err
    }
  }

  /** Read the current USDT allowance this wallet has granted the escrow. */
  async usdtAllowance() {
    this._need()
    const erc20 = new ethers.Interface([
      'function allowance(address owner, address spender) view returns (uint256)'
    ])
    const data = erc20.encodeFunctionData('allowance', [
      this.address,
      this.deployment.bets
    ])
    const raw = await this._provider().call({ to: this.deployment.usdt, data })
    return erc20.decodeFunctionResult('allowance', raw)[0]
  }

  /**
   * createBet -> { hash, betId }. Outcome labels are packed into `matchRef`
   * on-chain (as "<matchRef>␟<label0>|<label1>|…") so any peer discovering
   * this bet can render the same card without off-chain state.
   */
  async createBet({ matchRef, question, outcomes, closesAt }) {
    const packed = packLabels(matchRef || 'match', outcomes)
    const data = this._betsIface.encodeFunctionData('createBet', [
      packed,
      question,
      outcomes.length,
      BigInt(closesAt)
    ])
    const res = await this._send(data)
    const betId = await this._betIdFromReceipt(res.hash)
    return { hash: res.hash, betId }
  }

  /** joinBet: assumes USDT is already approved for >= amount. */
  async joinBet({ betId, outcome, amount }) {
    const data = this._betsIface.encodeFunctionData('joinBet', [
      BigInt(betId),
      outcome,
      amount
    ])
    return this._send(data)
  }

  /** proposeResult: relay the AI's proposed winning outcome + dispute window. */
  async proposeResult({ betId, outcome, disputeWindow = 0 }) {
    const data = this._betsIface.encodeFunctionData('proposeResult', [
      BigInt(betId),
      outcome,
      BigInt(disputeWindow)
    ])
    return this._send(data)
  }

  /** confirmResult: host-only release gate. */
  async confirmResult(betId) {
    const data = this._betsIface.encodeFunctionData('confirmResult', [
      BigInt(betId)
    ])
    return this._send(data)
  }

  /** claim winnings on a resolved bet. */
  async claim(betId) {
    const data = this._betsIface.encodeFunctionData('claim', [BigInt(betId)])
    return this._send(data)
  }

  /** cancelBet (host-only) -> refunds path. */
  async cancelBet(betId) {
    const data = this._betsIface.encodeFunctionData('cancelBet', [BigInt(betId)])
    return this._send(data)
  }

  /** refund a stake on a cancelled bet. */
  async refund(betId) {
    const data = this._betsIface.encodeFunctionData('refund', [BigInt(betId)])
    return this._send(data)
  }

  // ---- reads (via ethers provider; no signing) ---------------------------

  /** Read a bet struct from chain. */
  async getBet(betId) {
    const data = this._betsIface.encodeFunctionData('getBet', [BigInt(betId)])
    const raw = await this._provider().call({ to: this.deployment.bets, data })
    const [b] = this._betsIface.decodeFunctionResult('getBet', raw)
    return {
      host: b.host,
      matchRef: b.matchRef,
      question: b.question,
      outcomeCount: Number(b.outcomeCount),
      closesAt: Number(b.closesAt),
      disputeUntil: Number(b.disputeUntil),
      proposedOutcome: Number(b.proposedOutcome),
      winningOutcome: Number(b.winningOutcome),
      status: BetStatus[Number(b.status)] || 'Unknown',
      totalPool: b.totalPool
    }
  }

  async betCount() {
    const data = this._betsIface.encodeFunctionData('betCount', [])
    const raw = await this._provider().call({ to: this.deployment.bets, data })
    return this._betsIface.decodeFunctionResult('betCount', raw)[0]
  }

  async outcomePool(betId, outcome) {
    const data = this._betsIface.encodeFunctionData('outcomePool', [
      BigInt(betId),
      outcome
    ])
    const raw = await this._provider().call({ to: this.deployment.bets, data })
    return this._betsIface.decodeFunctionResult('outcomePool', raw)[0]
  }

  // ---- chain-sourced bet discovery --------------------------------------

  /**
   * Read a bet fully hydrated for the UI: its struct, per-outcome pools, and
   * outcome labels. Labels are stored on-chain packed into `matchRef` as
   * `"<matchRef> <label0>|<label1>|…"` so every peer can render the same
   * card without off-chain state.
   */
  async getBetCard(betId) {
    const b = await this.getBet(betId)
    const { matchRef, outcomes } = unpackLabels(b.matchRef, b.outcomeCount)
    const pools = []
    for (let i = 0; i < b.outcomeCount; i++) pools.push(await this.outcomePool(betId, i))
    return { betId: Number(betId), ...b, matchRef, outcomes, pools }
  }

  /** All bets currently on-chain, newest first, hydrated for the UI. */
  async getAllBets() {
    const n = Number(await this.betCount())
    const cards = []
    for (let i = n - 1; i >= 0; i--) cards.push(await this.getBetCard(i))
    return cards
  }

  /**
   * Poll the chain for bets and invoke onChange(cards) whenever the set or any
   * bet's state changes. Returns a stop() function. This is how a bet created by
   * ANY peer (createBet is permissionless) shows up for everyone — the chain is
   * the shared source of truth, no P2P feed write needed.
   */
  watchBets(onChange, { intervalMs = 4000 } = {}) {
    let stopped = false
    let lastSig = ''
    const tick = async () => {
      if (stopped) return
      try {
        const cards = await this.getAllBets()
        // Cheap change signature: ids + status + pool totals.
        const sig = cards.map((c) => `${c.betId}:${c.status}:${c.totalPool}`).join('|')
        if (sig !== lastSig) { lastSig = sig; onChange(cards) }
      } catch { /* transient RPC hiccup; try again next tick */ }
      if (!stopped) this._watchTimer = setTimeout(tick, intervalMs)
    }
    tick()
    return () => { stopped = true; clearTimeout(this._watchTimer) }
  }

  // ---- internals ---------------------------------------------------------

  _need() {
    if (!this._account) throw new Error('wallet not connected — call connect()')
  }

  _provider() {
    // Reuse a single provider for reads (a fresh one per call caused nonce
    // cache inconsistencies).
    return this._readProvider
  }

  async _send(data, value = 0n) {
    this._need()
    return this._serialTx((nonce) =>
      this._account.sendTransaction({ to: this.deployment.bets, data, value, nonce })
    )
  }

  /**
   * Wait for a tx to be mined; throws if it reverted on-chain. Polls
   * getTransactionReceipt rather than waitForTransaction — the latter relies on
   * a block-event subscription that can hang under instant automining (the tx
   * is already mined before the listener attaches, so the awaited confirmation
   * event never fires).
   */
  async _waitMined(hash, { timeoutMs = 60000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const receipt = await this._readProvider.getTransactionReceipt(hash)
      if (receipt) {
        if (receipt.status === 0) {
          throw new Error(`transaction reverted (${hash.slice(0, 10)}…)`)
        }
        return receipt
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for tx ${hash.slice(0, 10)}… to mine`)
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }

  /** Parse the BetCreated event from a tx receipt to learn the new betId. */
  async _betIdFromReceipt(hash) {
    const receipt = await this._waitMined(hash)
    for (const log of receipt.logs || []) {
      if (log.address.toLowerCase() !== this.deployment.bets.toLowerCase()) continue
      try {
        const parsed = this._betsIface.parseLog(log)
        if (parsed && parsed.name === 'BetCreated') return Number(parsed.args.betId)
      } catch {
        /* not our event */
      }
    }
    return null
  }
}

// --- outcome-label packing (stored on-chain in `matchRef`) -------------------
// The escrow stores a bet's outcome COUNT but not the labels. We pack the labels
// into the free-form `matchRef` string using a unit-separator (U+241F, a char
// users won't type) so any peer can render the same card from chain alone.
const LABEL_SEP = '␟' // separates matchRef from labels
const LABEL_DELIM = '|' // separates individual labels

export function packLabels(matchRef, outcomes) {
  return `${matchRef}${LABEL_SEP}${outcomes.map((o) => String(o).replace(/\|/g, '/')).join(LABEL_DELIM)}`
}

export function unpackLabels(packed, outcomeCount) {
  const idx = String(packed).indexOf(LABEL_SEP)
  if (idx === -1) {
    // Older/plain matchRef with no packed labels — fall back to generic labels.
    return {
      matchRef: packed,
      outcomes: Array.from({ length: outcomeCount }, (_, i) => `Outcome ${i}`)
    }
  }
  const matchRef = packed.slice(0, idx)
  const outcomes = packed.slice(idx + 1).split(LABEL_DELIM)
  // Pad/truncate to the on-chain count so the card is always consistent.
  while (outcomes.length < outcomeCount) outcomes.push(`Outcome ${outcomes.length}`)
  return { matchRef, outcomes: outcomes.slice(0, outcomeCount) }
}
