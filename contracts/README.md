# PitchSide Bets — on-chain USDT escrow 🎲

Non-custodial, pari-mutuel USDT escrow for PitchSide peer-to-peer match betting
on BNB Smart Chain (BSC). This is **Phase 1** of the betting feature (see
[`../BETTING-PLAN.md`](../BETTING-PLAN.md)) — the money core, built and tested
before any wallet/UI wiring.

The app-side wallet uses Tether's **WDK** (`@tetherto/wdk-wallet-evm`,
self-custodial seed), which calls this contract's methods via
`account.sendTransaction({ to, data })` with encoded calldata, and stakes USDT
via `account.approve(...)`.

## Contract: `PitchSideBets.sol`

- **Non-custodial:** staked USDT lives in the contract, never an app wallet.
- **Pari-mutuel:** winners split the pool pro-rata by stake; AI odds are purely
  informational (computed off-chain / on-device by QVAC).
- **Host-gated resolution:** an off-chain AI proposal (`proposeResult`) can be
  relayed by anyone, but only the bet's **host** can `confirmResult`, and only
  after an optional **dispute window** elapses.
- **Hard-coded splits on payout:** **5% DAO + 2% host + 93% winners.**
- **Safety:** `SafeERC20`, `ReentrancyGuard`, checks-effects-interactions,
  pull-based `claim`/`refund`, and a `cancelBet` → `refund` path so funds are
  never stranded (including when nobody backed the winning outcome).

### Lifecycle

```
createBet ─▶ joinBet* ─▶ proposeResult ─▶ (dispute window) ─▶ confirmResult ─▶ claim*
                    └─────────────────────▶ cancelBet ─▶ refund*   (void / disputed)
```

## Run

```bash
cd contracts
npm install
npm run build      # hardhat compile
npm test           # 23 tests: lifecycle, fee math, host gate, dispute window,
                   #            cancel/refund, reentrancy
```

## End-to-end on a local chain (no key/faucet needed)

Drives the **real bundled WDK wallet** through create → join → propose → confirm
→ claim against a live Hardhat node, asserting the on-chain payout (139.5 USDT
of a 150 pool = 93% to the sole winner, after 5% DAO + 2% host).

```bash
# 1) build the browser wallet bundle (app root)
cd ..
npm run build:wallet

# 2) start a persistent local chain (separate terminal, in contracts/)
cd contracts
npx hardhat node                     # 127.0.0.1:8545, chainId 31337

# 3) deploy to it (writes deployments/localhost.json + renderer/contract/deployment.js)
npx hardhat run scripts/deploy.js --network localhost

# 4) run the end-to-end integration test against the running node
npx hardhat test test/wallet-e2e.test.js --network localhost
```

`test/wallet-e2e.test.js` deploys its own fresh contracts, funds two WDK wallets,
and runs the whole lifecycle. On the default network (no `--network localhost`)
it is skipped, so `npm test` stays fast (23 unit tests).

To fund the app's own wallet for a manual GUI run: click **Create new wallet**
in the app, copy the address, then
`FUND=0xThatAddress npx hardhat run scripts/fund.js --network localhost`.

## Deploy to BSC testnet (optional)

Create `contracts/.env` (git-ignored):

```
BSC_TESTNET_RPC=https://data-seed-prebsc-1-s1.bnbchain.org:8545
DEPLOYER_PRIVATE_KEY=0x...        # a funded testnet key
```

Then wire a `scripts/deploy.js` (passes `usdt` + `dao` addresses to the
constructor) and run `npm run deploy:testnet`. On testnet, deploy `MockUSDT`
first (or point at an existing test USDT) and use a placeholder DAO address.

> ⚠️ **Not audited.** Testnet + mock USDT only. A security audit is required
> before any mainnet USDT, per the plan.
