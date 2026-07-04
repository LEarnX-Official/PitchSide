<div align="center">

<img src="assets/logo.svg" alt="PitchSide" width="640" />

# The football watch-party that survives the internet going down.

**Serverless. On-device AI. Self-custodial USDT betting.**
_No servers · no cloud AI · no custodians · no API keys leaving your machine._

<br/>

[![tracks](https://img.shields.io/badge/Tether_Cup-Pears_%C2%B7_QVAC_%C2%B7_WDK-2ee6a6?style=for-the-badge&labelColor=07090c)](https://dorahacks.io/hackathon/tether-developers-cup/detail)
[![tests](https://img.shields.io/badge/tests-40_app_%2B_23_contract-2ee6a6?style=for-the-badge&labelColor=07090c)](#-tests--proofs--verified-not-vibes)
[![license](https://img.shields.io/badge/license-MIT-7cc0ff?style=for-the-badge&labelColor=07090c)](LICENSE)
[![runtime](https://img.shields.io/badge/Pear_v2-Electron_+_Bare-ffcf5c?style=for-the-badge&labelColor=07090c)](#-architecture)

`▸ Pears (P2P)` · `▸ QVAC (Local AI)` · `▸ WDK (Wallets)`

</div>

---

```
 ┌─ pitchside ──────────────────────────────────── ● ● ● ─┐
 │                                                          │
 │   67'  ⚽ GOAL — Saka for Arsenal. ARS 2–1 CHE           │
 │   67'  🎙 AI  What a strike! The Emirates ERUPTS —       │
 │              Saka cuts inside and buries it far post!    │
 │                                                          │
 │   🎲 bet #3 · Will Arsenal hold on to win?               │
 │        Yes (120 USDT · 71%)   No (48 USDT · 29%)         │
 │        [ Join ]   🤖 AI odds   ✔ Confirm winner          │
 │                                                          │
 │   @sam  turn your wifi off and watch it still sync 👀    │
 └──────────────────────────────────────────────────────────┘
```

---

## 🎬 Picture this

It's the 89th minute of the final. The stadium is a wall of noise — and the cell
network has completely collapsed under 60,000 phones. Your group chat is frozen.
Every "live score" app is spinning.

**Except one corner of the stands.** A dozen phones running PitchSide have quietly
formed their own **peer-to-peer mesh over local WiFi** — no towers, no servers. A
goal goes in; someone taps it; it **syncs to everyone instantly**. An AI running
**entirely on one person's phone** fires off commentary. And the bet three of them
made at kickoff — _"Arsenal to hold the lead"_ — **settles in USDT** the moment the
whistle blows, from wallets where **each of them holds their own keys**.

No server saw any of it. No cloud AI. No middleman touched the money.

> **PitchSide is that corner of the stands.** It's the entire Tether open-source
> stack — Pears, QVAC, and WDK — pointed at the one moment that reliably breaks the
> internet: **everyone watching the same match at once.**

---

## 📑 Table of contents

- [Why all three tracks](#-why-this-fits-all-three-tracks)
- [Features](#-features)
- [Architecture](#-architecture)
- [A day in the life of a bet](#-a-day-in-the-life-of-a-bet)
- [Tech stack — what I used, and how](#-tech-stack--what-i-used-and-how)
- [Quick start](#-quick-start)
- [Tests & proofs](#-tests--proofs--verified-not-vibes)
- [The worker protocol](#-under-the-hood-the-worker-protocol)
- [Project layout](#-project-layout)
- [Security & honesty](#-security--honesty)
- [FAQ](#-faq)
- [The Cup](#-the-cup)

---

## 🎯 Why this fits _all three_ tracks

The Tether Developers Cup has three tracks — **Pears (P2P)**, **QVAC (Local AI)**,
and **WDK (Wallets)**. Most projects pick one. PitchSide uses **all three**, and the
trick is that each does something that's **genuinely hard to do any other way**:

| Track        | What it does in PitchSide                                                                                                     | Why it _has_ to be this stack                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🛰️ Pears** | Serverless watch-party rooms: peers sync a shared match feed + chat + reactions with **no server**.                           | A stadium's cell network dies at kickoff. P2P over Hyperswarm/Hypercore keeps the party alive on local WiFi with the internet off.                       |
| **🧠 QVAC**  | An on-device LLM generates **live commentary**, answers fan questions, and computes **betting odds** — no cloud, no API keys. | Commentary must be instant and private; the "money shot" is a private AI hyping a goal with the internet _physically disconnected_.                      |
| **💳 WDK**   | A **self-custodial** wallet + a non-custodial USDT escrow for peer-to-peer match betting. Users hold their own seed.          | Fans bet against _each other_, not the house. WDK gives every fan a real EVM wallet; the escrow enforces payouts on-chain — no one holds anyone's money. |

**The synthesis (this is the whole pitch):**

```
   ⚽ goal          🧠 on-device AI          🛰️ P2P sync            💳 on-chain
  happens   ──▶   commentates it   ──▶   to every peer    ──▶   USDT settles
                  (no cloud)             (no server)            (no custodian)
```

Three tracks, one moment. Take any one away and the moment breaks.

---

## ✨ Features

- **🛰️ Serverless watch-party** — type a room name, share a `PS1-…` invite code, and
  peers sync a live match feed. **Internet-P2P** (DHT discovery, join from anywhere)
  **or local-network mode** (same WiFi, fully offline — internet can be _off_).
- **🧠 On-device AI commentary & Q&A** — download a local GGUF model once
  (`Llama-3.2-1B-Instruct`, ~773 MB); it commentates match events in one of three
  personas — **Hype 🔥 / Analyst 🧠 / Banter 😏** — and answers "was that offside?",
  all on your own machine. No cloud, no key, nothing leaves the device.
- **📡 Real live matches (optional)** — plug a free [football-data.org](https://www.football-data.org)
  key and _follow_ a real match; goals/kickoff/full-time auto-post and the **local AI
  commentates the real game**. Internet is used only for the _data_ — inference stays
  100% on-device.
- **💳 Self-custodial betting** — a WDK wallet generated & held on your device. Open a
  bet and it appears as a **card in the fan chat** for every peer (chain-sourced, so
  **anyone** can create one). Stake USDT, get **AI-computed odds**, and settle
  **pari-mutuel** with the pool split **5% DAO · 2% host · 93% winners** — all enforced
  by a smart contract, not a promise.
- **🧪 In-app test faucet** — one click for test gas + test USDT on a local chain, so
  the entire betting flow is demoable in seconds without touching a terminal.
- **🛡️ Host moderation** — the room host can delete any **chat message**, **feed
  event**, or **bet card**; deletes broadcast to every peer (and a bet delete also
  **voids the escrow on-chain**, enabling refunds).
- **🎨 Framed-terminal UI** — a clean, modern, monospace, phosphor-green terminal
  aesthetic — traffic-light window chrome, `▸` prompts, a blinking cursor. It looks
  like the future as imagined in 1985, and we're not sorry.

---

## 🏗️ Architecture

PitchSide is a **Pear v2 desktop app** — `pear-runtime` embedded in Electron. The
design has a clean split: the **renderer** owns the DOM and the wallet; a **Bare
worker** owns the P2P mesh and the on-device AI. They talk over a tiny
newline-delimited JSON protocol across the Pear bridge.

```
┌──────────────────────────────── ELECTRON (renderer, Chromium) ───────────────────────────────┐
│                                                                                                │
│   renderer/                                                                                     │
│    ├─ app.js ............ orchestrates views + wallet + worker IPC                              │
│    ├─ ui/feed-view.js ... live match feed (host-deletable rows)                                │
│    ├─ ui/chat-view.js ... fan chat (host-deletable rows)                                        │
│    ├─ ui/bet-cards.js ... 🎲 BET CARDS render IN the chat, discovered from chain                │
│    ├─ ui/ai-panel.js .... "ask the AI" + model download UI                                      │
│    ├─ wallet.js ......... 💳 WDK self-custodial wallet + escrow calls  (bundled by esbuild)     │
│    └─ live-data.js ...... optional football-data.org → match events                            │
│                                                                                                │
│    window.bridge  (preload IPC)          │  ▲                        │ ethers reads/writes      │
│         │ JSON frames                     │  │                        ▼                          │
└─────────┼─────────────────────────────────┼──┼──────────────── BNB Smart Chain / local node ───┘
          ▼                                  │  │                  (PitchSideBets.sol escrow)
┌──────── BARE WORKER (workers/pitchside.js) │  │
│                                            │  │
│   lib/room.js ........ room lifecycle; host-only writes                                        │
│   lib/feed.js ........ shared-key Hypercore match feed (append-only, tombstone deletes)        │
│   lib/transport.js ... SwarmTransport  (Hyperswarm — internet P2P)                             │
│   lib/direct-transport.js  DirectTransport  (LAN, offline, same WiFi)                           │
│   lib/mesh-transport.js .. MeshTransport   (stadium mesh seam — see MESH.md)                    │
│   lib/qvac.js ........ 🧠 on-device AI (QVAC llama.cpp) — commentary, Q&A, bet odds/outcome     │
│   lib/prompts.js ..... persona + odds + outcome prompt templates                               │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Two golden rules keep the tracks honest

1. **P2P is the transport; the chain is the truth.** Chat, feed, and reactions live on
   the Hypercore feed (fast, offline-capable). _Money_ — stakes, pools, payouts — lives
   **on-chain**. Bet cards are **discovered from the contract**, so any peer can create
   a bet and it shows up in everyone's chat with **zero multi-writer P2P rewrite**. The
   blockchain _is_ the shared, permissionless database.
2. **AI never leaves the device.** The football _data_ may arrive over HTTPS, but every
   token of inference — commentary, Q&A, betting odds, outcome proposals — runs locally
   through QVAC. No cloud AI. No API keys.

---

## 🎟️ A day in the life of a bet

Here's the full journey of a single bet, touching **all three tracks** end to end:

```
  HOST (wallet A)                 ESCROW (PitchSideBets.sol)              BETTOR (wallet B)
  ──────────────                  ──────────────────────────              ────────────────
  createBet("Arsenal to win?",
    ["Yes","No"], closesIn)  ───────────▶  Bet #3 · status: Open
                                                    │
                                          (chain-sourced discovery)
                                                    ▼
                                          🎲 card appears in EVERY peer's chat
                                                                                  │
                                          approve(USDT) + joinBet(#3, Yes, 50) ◀──┘
                                          pool = 120 Yes / 48 No · status: Open
                                                    │
  🧠 QVAC computes odds on-device ─────────▶  (informational: 71% / 29%)
                                                    │
  match ends · 🧠 QVAC proposes the winner
  proposeResult(#3, Yes) ──────────────────▶  status: Proposed (dispute window)
                                                    │
  confirmResult(#3)  [host-only gate] ─────▶  status: Resolved
                                          split: 5% DAO · 2% host · 93% winners
                                                    │
                                          claim(#3) ◀───────────────────────────  pulls pro-rata
                                                                                   share of the pool
```

Notice what _isn't_ there: no server, no custodian, no cloud AI. The host can only
**confirm the AI's proposed outcome** — never invent a winner or redirect funds — and
if the AI is wrong, `cancelBet → refund` returns every stake. It's trust-minimized by
construction.

---

## 🧰 Tech stack — what I used, and how

### 🛰️ Pears (P2P) — `pear-runtime` + Hyperswarm + Hypercore

The watch-party is a **shared-key Hypercore** feed: every peer derives the _same_
core from the room name, the host writes match/chat/reaction events, and guests
replicate read-only. Discovery + connectivity is **Hyperswarm** (DHT) for internet
mode, or a **direct TCP** transport for offline same-WiFi mode — swapped behind one
interface without touching the data layer.

- `pear-runtime` embedded in Electron (the Pear v2 desktop model)
- `hyperswarm`, `hypercore`, `corestore`, `hypercore-crypto`, `b4a`, `framed-stream`
- **Invite codes** are `PS1-…` — URL-safe base64 of a compact JSON (room + mode +
  optional host LAN address), versioned so the format can evolve.
- **Deletes are append-only tombstones.** You can't erase a Hypercore, so the host
  appends a `delete` marker keyed by the event's `seq` (or `betId` for bet cards), and
  every peer hides the target on render. Host-only writes = moderation auth for free.
- **Multi-hop stadium mesh** is designed and _proven_ (see `experiments/`), with the
  native radio layer left as a clean seam (`MeshTransport`). See [`MESH.md`](MESH.md).

### 🧠 QVAC (Local AI) — `@qvac/bare-sdk` + `@qvac/llm-llamacpp`

On-device inference runs inside the Bare worker. QVAC's llama.cpp plugin loads a GGUF
model directly from Hugging Face over HTTPS (a one-time ~773 MB download), then runs
**100% locally** for four jobs:

| Job              | What it produces                                                       |
| ---------------- | ---------------------------------------------------------------------- |
| **Commentary**   | A punchy 1–2 line reaction to a match event, in the chosen persona     |
| **Fan Q&A**      | A concise answer grounded in the last few match events                 |
| **Betting odds** | Implied probabilities per outcome (strict JSON, normalized in-app)     |
| **Outcome**      | A proposed winning outcome, grounded in the real result when available |

- Model: `unsloth/Llama-3.2-1B-Instruct-GGUF` (`Q4_0`, `ctx_size: 2048`)
- The model output for odds/outcome is coaxed into **strict JSON** and parsed
  defensively (fences/prose stripped) so the UI never chokes on a chatty model.
- **QVAC-track rule honored to the letter:** _all_ AI — inference, odds, outcome — is
  on-device. The only network call the AI layer makes is the optional football feed.

### 💳 WDK (Wallets) — `@tetherto/wdk-wallet-evm` + a Solidity escrow

Every fan gets a **self-custodial** EVM wallet via WDK: a BIP-39 seed generated and
stored **on-device** — the user holds their keys, which is the entire point of the
Wallets track. The app drives a non-custodial escrow contract _entirely through WDK_:

- `WalletManagerEvm` + `SeedSignerEvm` → seed → account → address
- `account.getTokenBalance()` for USDT, `account.approve()` for staking
- `account.sendTransaction({ to, data })` with **ethers-encoded calldata** to call the
  escrow's custom methods (`createBet` / `joinBet` / `confirmResult` / `claim` / …)
- Target chain is chosen purely by the RPC we hand WDK — **BSC testnet → chainId 97**,
  **local Hardhat → 31337** — no hardcoded chain list.
- **Hardened for real EVM behavior.** WDK returns after _broadcast_, not mining — a
  naive integration hits "nonce too low" and hangs under instant automining. PitchSide
  adds **explicit monotonic nonce management + a send mutex + receipt polling**, and
  decodes custom contract errors into human-readable messages. _(This wasn't
  theoretical — the end-to-end test caught the hang, and the fix is in
  [`wallet.js`](renderer/wallet.js).)_

**The contract — [`PitchSideBets.sol`](contracts/contracts/PitchSideBets.sol)** — a
non-custodial, **pari-mutuel** USDT escrow:

- **Stakes live in the contract**, never an app wallet. Nobody custodies anyone's money.
- **Winners split the pool pro-rata** by stake; AI odds are purely informational.
- **Host-gated resolution:** anyone can relay the AI's proposal (`proposeResult`), but
  only the bet's host can `confirmResult`, and only after an optional **dispute
  window**. The host can confirm the proposed outcome — never substitute a different one.
- **Hard-coded fees on payout:** `DAO_BPS = 500` (5%), `HOST_BPS = 200` (2%), the rest
  (93%) to winners. No per-bet discretion.
- **Safety:** `SafeERC20`, `ReentrancyGuard`, checks-effects-interactions, pull-based
  `claim`/`refund`, fee-on-transfer-safe accounting, and a `cancelBet → refund` path so
  funds are **never stranded** (including when nobody backed the winning side).
- **Lifecycle:** `Open → Proposed → Resolved` (happy path) or `→ Cancelled → refund`.
- Tooling: **Hardhat 2** + **OpenZeppelin v5** + `ethers` v6.

### 🎨 Everything else

`electron` + `electron-forge` (packaging & cross-platform makers), **`esbuild`**
(bundles the WDK/ethers/bip39 wallet for the _sandboxed_ renderer, with a `Buffer`
polyfill injected — the renderer runs `nodeIntegration:false`, so bare Node imports
have to be bundled), vanilla JS + a hand-rolled `el()` DOM helper (no framework), and a
pure-CSS framed-terminal theme.

---

## 🚀 Quick start

### Prerequisites

- **Node.js 20+** and **npm**
- A display (it's an Electron desktop app)
- ~1 GB free for the optional AI model

### 1) Install & run the watch-party

```bash
git clone https://github.com/LEarnX-Official/PitchSide.git
cd PitchSide
npm install
npm start          # builds the wallet bundle (prestart) + launches the app
```

In the app: pick a nickname → **Join watch-party** → optionally **download the AI
model** in the AI panel → post match events / ask the AI. Run a **second instance**
with the same room name to see peer-to-peer sync.

> **💡 The money shot:** choose _Local network_ mode, then **turn your WiFi/internet
> off**, and watch two instances keep syncing the match over the LAN with zero
> connectivity. That's the demo that makes people lean in.

### 2) Enable betting (optional · ~2 min · no real money)

Betting talks to a chain. The easiest path is a **local Hardhat node** — no faucet, no
real key, no risk:

```bash
# terminal A — a persistent local chain
cd contracts && npm install
npx hardhat node                                   # 127.0.0.1:8545, chainId 31337

# terminal B — deploy the escrow + a mock USDT
cd contracts
npx hardhat run scripts/deploy.js --network localhost
#   → writes deployments/localhost.json + renderer/contract/deployment.js
```

Then (re)start the app. In the 🎲 **Match betting** panel:

```
Create new wallet ─▶ ⛽ Get test gas ─▶ 🪙 Get test USDT ─▶ Open bet (appears in chat)
   ─▶ Join with a stake ─▶ (host) 🤖 AI decide winner ─▶ ✔ Confirm ─▶ 💰 Claim
```

> Prefer BSC testnet? Put a funded key + RPC in `contracts/.env` and run
> `npm run deploy:testnet`. Full walkthrough in [`contracts/README.md`](contracts/README.md).

---

## 🧪 Tests & proofs — _verified, not vibes_

Everything load-bearing is tested, and the P2P + on-chain flows are proven end-to-end
against a real chain. This isn't a slideware demo.

```bash
npm test                 # 40 app tests: feed, room, transport, multi-hop mesh,
                         #                prompts, join-code, live-data, betting-AI,
                         #                host-delete tombstones (chat/feed/bet)

npm run test:contracts   # 23 contract tests: fee math, host gate, dispute window,
                         #                     cancel/refund, reentrancy attack
```

**End-to-end on a real chain** — drives the _actual bundled WDK wallet_ (the exact code
the renderer ships) through the full lifecycle against a live Hardhat node, asserting
the on-chain payout: **139.5 USDT of a 150 pool = 93% to the sole winner.**

```bash
cd contracts
npx hardhat node                                        # (separate terminal)
npx hardhat run scripts/deploy.js --network localhost
npx hardhat test test/wallet-e2e.test.js --network localhost
```

**Runnable P2P mesh proofs** (no app, no server, just Node):

```bash
node experiments/multihop-mesh-proof.js    # A→B→C relay (A & C never directly linked)
node experiments/mesh-chain-selfheal.js    # 5-node chain + self-healing reroute
node experiments/room-over-mesh.js         # the real Room running over a mesh transport
```

| Suite                         | Result         | Covers                                                                                            |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| App (`node --test`)           | **40 passing** | P2P feed/room/transport, multi-hop mesh, AI prompts/JSON, join codes, betting-AI, host moderation |
| Contracts (Hardhat)           | **23 passing** | escrow lifecycle, exact fee math, reentrancy attack, refunds                                      |
| Wallet E2E (Hardhat + bundle) | ✅ **passing** | create → join → propose → confirm → claim payout against a live chain                             |
| CI (`Integrate` workflow)     | ✅ **green**   | `prettier --check` + `lunte` on every push to `main`                                              |

---

## 🔌 Under the hood: the worker protocol

The renderer and the Bare worker speak newline-delimited JSON. It's small enough to
read in one sitting:

| Renderer → worker          | Worker → renderer          | Meaning                              |
| -------------------------- | -------------------------- | ------------------------------------ |
| `join` / `leave`           | `event` / `peers`          | room lifecycle + live feed & peers   |
| `match` / `chat` / `react` | `event`                    | host posts a feed/chat/reaction item |
| `delete` / `bet-hide`      | `event` (tombstone)        | host moderation (hide for all peers) |
| `ask`                      | `answer`                   | on-device AI Q&A                     |
| `bet-odds` / `bet-outcome` | `bet-odds` / `bet-outcome` | on-device AI odds + winner proposal  |
| `download-model`           | `ai` / `ai-progress`       | fetch + load the local LLM           |

The chain side is separate: the wallet reads bets and sends escrow transactions
directly via `ethers` + WDK — the worker never touches the money.

---

## 📂 Project layout

```
PitchSide/
├─ electron/               Electron shell + pear-runtime worker host + preload IPC
├─ renderer/               UI (framed-terminal), WDK wallet, bet cards, live-data
│  ├─ app.js               orchestrator: views ⇄ wallet ⇄ worker IPC
│  ├─ wallet.js            💳 WDK self-custodial wallet + escrow calls (→ esbuild bundle)
│  ├─ ui/                  feed-view, chat-view, bet-cards, ai-panel, betting-panel, dom
│  └─ contract/            deployment.js + exported ABIs (generated)
├─ workers/                Bare worker: P2P mesh + on-device AI
│  ├─ pitchside.js         worker entry: routes JSON IPC commands
│  └─ lib/                 room, feed, transports (swarm/direct/mesh), qvac, prompts
├─ contracts/              Solidity escrow (Hardhat)
│  ├─ contracts/           PitchSideBets.sol + test/{MockUSDT,ReentrantToken}.sol
│  ├─ scripts/             deploy.js · fund.js (faucet) · export-abi.js
│  └─ test/                unit tests + bundled-wallet end-to-end
├─ experiments/            runnable multi-hop mesh proofs
├─ assets/                 logo.svg · icon.svg
├─ BETTING-PLAN.md         the betting design doc + build log
└─ MESH.md                 stadium-mesh design + what's left to build
```

---

## 🔒 Security & honesty

This is a hackathon build, and some things are demo-grade **on purpose**. They're
called out here rather than swept under the rug — because pretending otherwise would be
the opposite of the trust-minimized values this project is about.

- **Seed at rest** — the WDK seed is stored in `localStorage` **in plaintext** for the
  demo, behind a one-time backup prompt + on-demand "Show seed". _Not safe for real
  funds._ Encrypting at rest (passphrase-derived key / OS keystore) is the first
  pre-mainnet hardening item.
- **Not audited** — `PitchSideBets.sol` is tested (including a live reentrancy attack in
  the suite) but **has not been audited**. Testnet / mock USDT only until it is.
- **Moderation is "hide," not "erase"** — the Hypercore feed is append-only, so a delete
  broadcasts a tombstone that every peer applies; the original bytes remain in history.
  A bet delete additionally **voids the escrow on-chain**, enabling refunds.
- **Stadium mesh radio layer** — the multi-hop _relay_ is proven; the phone-to-phone
  _radio_ transport (Nearby Connections / WiFi-Direct) is a native module still to
  build. `MeshTransport` is the clean seam waiting for it.

---

## ❓ FAQ

**Does the AI really run offline?**
Yes. The model downloads once over HTTPS, then all inference runs locally via QVAC's
llama.cpp plugin inside the Bare worker. You can pull the network cable after the
download and it keeps commentating.

**If the P2P feed is host-only-write, how can _anyone_ create a bet?**
Because bets don't live on the feed — they live **on-chain**. `createBet` is
permissionless, and every client _watches the contract_ and renders new bets as cards
in chat. The blockchain is the shared, multi-writer source of truth, so we get
"anyone can create a bet" without rewriting the P2P layer.

**Who holds the staked USDT?**
The **escrow contract** — never an app, never the host, never us. Payouts and the
2%/5% fee splits are executed in Solidity. It's non-custodial by construction.

**Can the host cheat and pay themselves?**
No. The host can only **confirm the AI's proposed outcome**; the contract won't let them
set an arbitrary winner or redirect funds. A wrong call routes to `cancelBet → refund`.

**Do I need real crypto to try it?**
No. Use the built-in **local Hardhat node** + the in-app **faucet** (test gas + test
USDT). Zero real money, full flow.

**Is this only for real matches?**
No — you can host a room and post match events manually (goal / card / kickoff /
custom) to drive the whole experience, or follow a real match with a free
football-data.org key.

---

## 🏆 The Cup

Built for the **[Tether Developers Cup](https://dorahacks.io/hackathon/tether-developers-cup/detail)**
— a knockout-tournament hackathon (8,000 USDt pool: 1,000 per track + 5,000 Cup
Champion). PitchSide goes after **all three tracks at once**, because the whole point is
the synthesis: _an offline, private, self-custodial way to watch — and bet on — the
match with your friends._

<div align="center">
<br/>

### No servers. No cloud AI. No custodians.

**Just you, your friends, the match — and the whole Tether stack.**

`▸ turn the wifi off and watch it still work`

<br/>

[![Pears](https://img.shields.io/badge/🛰️_Pears-P2P-2ee6a6?style=flat-square&labelColor=07090c)](https://docs.pears.com)
[![QVAC](https://img.shields.io/badge/🧠_QVAC-Local_AI-7cc0ff?style=flat-square&labelColor=07090c)](https://qvac.tether.io)
[![WDK](https://img.shields.io/badge/💳_WDK-Wallets-ffcf5c?style=flat-square&labelColor=07090c)](https://wdk.tether.io)

</div>

## 📜 License

[MIT](LICENSE) — a permissive open-source license, per the Cup's submission rules.
