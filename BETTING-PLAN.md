# PitchSide — On-Chain Betting Plan 🎲

A plan for adding wallet login + peer-to-peer match betting with USDT on BSC
(EVM), using Tether's **WDK (Wallet Development Kit)** for the self-custodial
wallet. This adds the **WDK track** on top of the existing Pears + QVAC build,
so the project spans all three Tether tracks.

> **Status:** design + build. The escrow contract and its tests are being built
> first (Phase 1); wallet/UI wiring follows.

> **Wallet layer decision:** use **`@tetherto/wdk-wallet-evm`** (BIP-39
> seed-phrase, BIP-44, self-custodial) instead of raw ethers.js + WalletConnect.
> The app **generates and stores the seed locally on first run** (user holds
> their keys — the whole point of WDK / the Wallets track). WDK is built on
> ethers under the hood and exposes `getAccount`, `getAddress`,
> `getTokenBalance`, `approve`, `transfer`, and `sendTransaction({to,data,value})`
> — the last is how we call our escrow's custom methods with encoded calldata.
> The target chain is chosen purely by the RPC `provider` we pass (BSC testnet
> RPC → chainId 97 automatically).

---

## 1. The flow (as specified)

1. Users **log in with their BSC EVM wallet**.
2. In the chat, **anyone creates a bet** about the match.
3. **Anyone can join** a bet, staking **any USDT amount** — their USDT is locked
   as collateral.
4. **AI calculates the odds** for each bet.
5. **AI decides the winner** when the bet resolves.
6. **The host must confirm** the AI's decision before any payout (the release gate).
7. On confirmation, the **winner is paid automatically**, with:
   - **2%** to the **host**,
   - **5%** to the **DAO wallet** (always),
   - remainder to the winner(s).

---

## 2. Key decisions (recommended defaults — override if you want)

| Decision    | Recommended default                                            | Why                                                                                                                                                              |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network** | **BSC testnet + test USDT first**, then mainnet after audit    | Real USDT with unaudited contracts = high risk of loss. Same code, safe environment to prove it.                                                                 |
| **Custody** | **Non-custodial escrow smart contract**                        | USDT locked in a contract; payouts + the 2%/5% splits enforced on-chain, transparently. No wallet can move funds off-rules. Avoids you holding everyone's money. |
| **Chain**   | BNB Smart Chain (BSC), USDT (BEP-20)                           | Matches "BSC EVM wallet"; low gas; USDT widely held.                                                                                                             |
| **Wallet**  | **WDK (`@tetherto/wdk-wallet-evm`), app-generated local seed** | Self-custodial, lights up the WDK/Wallets track, no external wallet app needed for the demo.                                                                     |

> ⚠️ **Money-handling reality checks** (must acknowledge before mainnet):
>
> - "USDT auto-becomes collateral" requires the user to **approve** the token and
>   **sign** a lock transaction (+ pay gas). There is no silent auto-transfer — no
>   dApp can move a user's funds without their signature. The UX can be smooth
>   (one approve + one join tx), but it is always user-signed.
> - **AI-decides + host-confirms is a trust model**: whoever controls the AI _and_
>   the host key can influence outcomes. Mitigations in §6.
> - Custodying funds, taking cuts, and settling bets may be **regulated** (gambling
>   / money transmission) depending on jurisdiction. Legal review needed before
>   real money.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ PitchSide app (existing: P2P watch-party + AI + live data)         │
│                                                                    │
│  renderer/                                                         │
│   ├─ wallet.js        WDK: generate/load local seed, get account,   │
│   │                   read USDT balance, approve + sendTransaction   │
│   │                   (encoded joinBet/confirm/claim calldata)       │
│   ├─ betting-ui.js    create-bet form, bet list, join, odds, status │
│   └─ odds.js          AI odds request/formatting                    │
│                                                                    │
│  workers/ (Bare)                                                   │
│   ├─ bets.js          bet objects synced over the P2P feed          │
│   │                   (bet metadata is P2P; MONEY is on-chain)      │
│   └─ qvac.js          AI: odds calc + outcome suggestion (existing) │
│                                                                    │
│  contracts/ (Solidity, NEW)                                        │
│   └─ PitchSideBets.sol  escrow: createBet, joinBet(stake),          │
│                         resolve(winner) [host-gated], claim,        │
│                         fee splits (2% host, 5% DAO)                │
└──────────────────────────────────────────────────────────────────┘
                        │                         │
                  P2P feed (bet UX)         BSC chain (the money)
```

**Design principle: bet _coordination_ is P2P (fast, offline-capable for the UI);
the _money_ is on-chain (the source of truth for stakes and payouts).** The chat
shows a bet card; the actual stake/lock/payout is a contract call. The two are
linked by an on-chain `betId`.

---

## 4. The smart contract (`PitchSideBets.sol`)

A non-custodial escrow. Sketch of the interface (not final code):

```solidity
// Roles
address public dao;          // fixed DAO fee wallet (5%)
uint16 public constant DAO_BPS  = 500;  // 5.00%
uint16 public constant HOST_BPS = 200;  // 2.00%
IERC20 public usdt;          // BEP-20 USDT

struct Bet {
  address host;              // gets 2%; the only address that can confirm
  string  matchRef;          // e.g. match id / description
  string  question;          // "Will Arsenal win?"
  uint8   outcomeCount;      // e.g. 2 (yes/no) or N options
  uint64  closesAt;          // no joins after this
  uint8   winningOutcome;    // set on resolve
  Status  status;            // Open | Locked | Resolved | Paid | Cancelled
  uint256 totalPool;
}

// USER FLOW
function createBet(...) returns (uint256 betId);   // host opens a bet
function joinBet(uint256 betId, uint8 outcome, uint256 amount);
        // pulls `amount` USDT (requires prior approve); records the stake

// RESOLUTION (host-gated, as specified)
function proposeResult(uint256 betId, uint8 winningOutcome);
        // called with the AI's decision (off-chain AI -> this tx)
function confirmResult(uint256 betId);            // HOST confirms -> enables payout
        // splits: 5% dao, 2% host, 93% to winners pro-rata by stake

// CLAIM
function claim(uint256 betId);                    // winner withdraws their share

// SAFETY
function cancelBet(uint256 betId);                // if no winner / disputed -> refunds
```

Fee math on payout of `pool`:

```
daoCut  = pool * 5%      -> dao
hostCut = pool * 2%      -> bet.host
winners = pool * 93%     -> split pro-rata among winning-outcome stakers
```

**Non-custodial:** funds live in the contract, never in an app wallet. The 2%/5%
are hard-coded splits executed by the contract on `confirmResult`.

---

## 5. The AI's role (odds + outcome)

- **Odds** (step 4): the on-device LLM (existing QVAC) — optionally grounded by
  the real football data feed — produces suggested odds/implied probabilities for
  each outcome, shown in the bet card. **Odds are informational**: in a pari-mutuel
  pool (winners split the pot pro-rata), payouts come from actual stakes, so the
  AI odds guide bettors but don't need to be "trusted" with money.
- **Outcome** (step 5): the AI proposes the winning outcome. To keep this honest,
  **ground the decision in the real match result from the football API** wherever
  possible, and have the AI _explain_ it. The AI's proposal goes on-chain via
  `proposeResult`, then waits for the host.
- **Host confirm** (step 6): only `bet.host` can call `confirmResult`. This is the
  release gate you specified. Until then, no funds move.

---

## 6. Trust & safety (the parts that protect the money)

Because "AI decides + host confirms" concentrates power, add guardrails:

1. **Contract-enforced splits.** 2%/5% and pro-rata payouts are in code, not a
   wallet's discretion. Nobody can change them per-bet.
2. **Host can only _confirm_, not _redirect_.** `confirmResult` accepts the
   proposed outcome; the host can't set an arbitrary winner or address.
3. **Dispute window (recommended addition).** Between `proposeResult` and payout,
   a short timeout lets bettors flag a wrong result → routes to `cancelBet`
   (refunds) or a fallback. Protects against a wrong AI call + rubber-stamp host.
4. **Match-result grounding.** Prefer the football API's real FINISHED result as
   the outcome source; the LLM explains rather than invents.
5. **Reentrancy / checks-effects-interactions**, pull-based `claim` (not push),
   `SafeERC20`. Standard escrow hardening.
6. **Cancel path.** If a match is postponed/void, `cancelBet` refunds everyone
   (minus nothing) so funds are never stranded.

---

## 7. UX flow (per user)

**Host**

1. Connect wallet → create room (existing).
2. In chat: "Create bet" → question, outcomes, close time → signs `createBet` tx.
3. Bet card appears in chat for everyone (synced P2P, linked to on-chain `betId`).
4. After the match: AI proposes result → host reviews → **Confirm** (signs
   `confirmResult`) → contract pays out.

**Bettor (anyone)**

1. Connect wallet → join room (existing).
2. See a bet card + AI odds → pick an outcome, enter USDT amount.
3. **Approve USDT** (one-time per allowance) → **Join** (signs `joinBet`, USDT
   locked in escrow).
4. After resolution + host confirm → **Claim** winnings (or auto-claim on confirm).

---

## 8. Tech stack additions

| Piece                   | Choice                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wallet / chain calls    | **WDK `@tetherto/wdk-wallet-evm`** (self-custodial seed, `approve`/`transfer`/`sendTransaction`); ethers `Interface` only to encode escrow calldata |
| Contract lang / tooling | Solidity ^0.8.24, **Hardhat**, OpenZeppelin v5 (`IERC20`, `SafeERC20`, `ReentrancyGuard`, `Ownable`)                                                |
| Network                 | BSC testnet (chainId 97, set via WDK `provider` RPC) → mainnet (56) after audit                                                                     |
| USDT                    | BEP-20 USDT (a `MockUSDT` for tests/testnet first)                                                                                                  |
| Bet metadata transport  | existing P2P feed (a new `bet` event kind)                                                                                                          |

> **WDK USDT note:** WDK's own EVM module warns that USDT requires resetting an
> existing allowance to 0 before setting a new non-zero one. The bet UI must
> handle the approve→(reset if needed)→join sequence accordingly.

---

## 9. Build phases

1. ✅ **Contract + tests** — [`contracts/PitchSideBets.sol`](contracts/contracts/PitchSideBets.sol)
   (create/join/propose/confirm/claim/cancel/refund, fee math, dispute window,
   reentrancy). **23 Hardhat tests pass.** `scripts/deploy.js` deploys
   MockUSDT + escrow and writes `deployments/<network>.json` +
   `renderer/contract/deployment.js`.
2. ✅ **WDK wallet** — [`renderer/wallet.js`](renderer/wallet.js): local
   self-custodial seed (generate/import), account 0, USDT balance, and all escrow
   calls via `sendTransaction({to,data})` + native `approve`.
3. ✅ **Create + join bets** — bet **cards render in the fan chat**
   ([`renderer/ui/bet-cards.js`](renderer/ui/bet-cards.js)), not the wallet panel.
   Bets are **chain-sourced**: any peer's `createBet` is discovered by every
   client via `wallet.watchBets()` (polls the contract), so "anyone can create a
   bet, everyone sees it" needs no multi-writer P2P rewrite — the chain is the
   shared source of truth. Outcome labels are packed on-chain into `matchRef`
   (`packLabels`/`unpackLabels`) so remote peers render identical cards. The
   [`betting-panel.js`](renderer/ui/betting-panel.js) is now just wallet +
   faucet + the host's create-bet form. The panel is always shown (any mode/phase).
4. ✅ **AI odds + outcome** — QVAC `odds()` / `proposeOutcome()` in
   [`workers/lib/qvac.js`](workers/lib/qvac.js) + prompts, exposed as worker
   `bet-odds` / `bet-outcome` commands, grounded by the live match feed. **7 AI
   tests pass.** Odds are informational; the outcome proposal is relayed on-chain
   via `proposeResult`.
5. ✅ **Resolution** — `proposeResult` → host `confirmResult` → payout; dispute
   window supported (0 by default; set per bet).
6. ✅ **End-to-end proof** — the bundled WDK wallet
   ([`renderer/wallet.bundle.js`](renderer/wallet.bundle.js), esbuild) runs the
   whole lifecycle against a live Hardhat chain with the correct payout, via
   [`contracts/test/wallet-e2e.test.js`](contracts/test/wallet-e2e.test.js).
   This surfaced + fixed a real nonce bug (WDK returns after broadcast, not
   mining) — `wallet.js` now uses explicit monotonic nonces + a send mutex +
   wait-for-receipt.
7. ⏳ **Harden + audit** — encrypt the seed at rest (currently plaintext
   localStorage — demo only), deploy to BSC testnet, then a security audit before
   any mainnet USDT.

> **Renderer note:** the Electron renderer is sandboxed (`nodeIntegration:false`,
> no bundler), so `wallet.js` (which imports WDK/ethers/bip39) is bundled to
> `renderer/wallet.bundle.js` by `npm run build:wallet` (auto-run on `prestart`)
> and imported from there. Contract reads/writes go through a single reused
> ethers provider.

---

## 10. Decisions

**Resolved:**

- ✅ **Network:** BSC **testnet** (chainId 97) first, mock USDT — mainnet only after audit.
- ✅ **Custody:** **non-custodial escrow contract** (`PitchSideBets.sol`).
- ✅ **Wallet:** **WDK**, app-generated local self-custodial seed (see header note).
- ✅ **First build:** contract + Hardhat tests before any wallet/UI wiring.
- ✅ **Bet types:** simple **yes/no + N-outcome pari-mutuel** first (winners split
  the pool pro-rata by stake); fixed-odds can come later.

**Still open (don't block the contract build):**

- **DAO wallet address** for the 5% cut — set as a constructor arg; use a
  placeholder on testnet, finalize before mainnet.
- **Dispute window:** included in the contract as an optional timeout between
  `proposeResult` and `confirmResult` (host can't confirm before it elapses if a
  challenge is open). See §6.
- **Relationship to offline mode:** betting is an **online-only mode** (needs
  chain); the offline watch-party/mesh stays unchanged and bet-free.

---

_Nothing in this document is implemented. It's the plan to review and adjust
before any contract or wallet code is written. Given real money is involved, a
security audit is required before mainnet._
