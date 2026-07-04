// contracts/test/wallet-e2e.test.js
// End-to-end integration: drives the REAL bundled WDK wallet
// (renderer/wallet.bundle.js) through the full bet lifecycle against a live
// chain (Hardhat's in-process JSON-RPC node), asserting on-chain payout math.
//
// This is the automated form of the "connect -> create -> join -> resolve ->
// claim" GUI walkthrough. It exercises wallet.js exactly as the renderer loads
// it (the esbuild bundle), so it also guards the nonce-management + wait-for-
// receipt logic that a naive WDK integration gets wrong.
//
// Requires the bundle to exist: run `npm run build:wallet` in the app root
// first (the test skips with a clear message if it's missing).

const { expect } = require('chai')
const { ethers, network } = require('hardhat')
const path = require('path')
const fs = require('fs')
const os = require('os')

const BUNDLE = path.join(__dirname, '..', '..', 'renderer', 'wallet.bundle.js')

// The bundle is browser ESM, but the contracts package is CommonJS, so a direct
// import of the `.js` is parsed as CJS and fails on `export`. Copy it to a
// `.mjs` in the temp dir and import that to force ESM.
function esmCopy() {
  const dst = path.join(os.tmpdir(), `pitchside-wallet-${process.pid}.mjs`)
  fs.copyFileSync(BUNDLE, dst)
  return dst
}
const U = (n) => ethers.parseUnits(String(n), 6)

// Per-wallet localStorage shim (the wallet reads/writes the seed here).
function makeStore(seed) {
  const m = new Map()
  if (seed) m.set('pitchside.wdk.seed', seed)
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  }
}

describe('WDK wallet end-to-end (bundled)', function () {
  this.timeout(60000)

  let W, deployment, funder, usdt, rpcUrl

  before(async function () {
    if (!fs.existsSync(BUNDLE)) {
      this.skip() // run `npm run build:wallet` in the app root to enable
    }
    // The wallet bundle is a browser ESM module; import an .mjs copy.
    W = await import('file://' + esmCopy())

    // A JSON-RPC endpoint the wallet's ethers provider can reach. Hardhat's
    // in-process node is exposed at the standard localhost port during `npx
    // hardhat test` only if `--network localhost`; otherwise we start it here.
    rpcUrl = 'http://127.0.0.1:8545'

    ;[funder] = await ethers.getSigners()

    const MockUSDT = await ethers.getContractFactory('MockUSDT')
    const usdtC = await MockUSDT.deploy()
    await usdtC.waitForDeployment()
    usdt = usdtC

    const Bets = await ethers.getContractFactory('PitchSideBets')
    const bets = await Bets.deploy(await usdt.getAddress(), funder.address)
    await bets.waitForDeployment()

    deployment = {
      chainId: Number((await ethers.provider.getNetwork()).chainId),
      usdt: await usdt.getAddress(),
      bets: await bets.getAddress()
    }
  })

  it('runs create -> join -> propose -> confirm -> claim with correct payout', async function () {
    // This test needs an HTTP RPC the wallet's ethers provider can dial. It is
    // meaningful only against `--network localhost` (a running `hardhat node`).
    // Detect and skip otherwise so the default `hardhat test` stays green.
    if (network.name !== 'localhost') {
      this.skip()
    }

    // Two wallets (host + bettor), each with its own seed store.
    globalThis.localStorage = makeStore()
    W.generateSeed()
    const host = new W.Wallet({ deployment, rpc: rpcUrl })
    const hostAddr = await host.connect()

    globalThis.localStorage = makeStore()
    W.generateSeed()
    const bettor = new W.Wallet({ deployment, rpc: rpcUrl })
    const bettorAddr = await bettor.connect()

    // Fund both from the Hardhat funder (native gas + USDT).
    for (const to of [hostAddr, bettorAddr]) {
      await (await funder.sendTransaction({ to, value: ethers.parseEther('10') })).wait()
      await (await usdt.mint(to, U(1000))).wait()
    }

    // create
    const closesAt = Math.floor(Date.now() / 1000) + 3600
    const { betId } = await host.createBet({
      matchRef: 'ARS-CHE', question: 'Will Arsenal win?', outcomes: ['Yes', 'No'], closesAt
    })
    expect(betId).to.be.a('number')

    // join: bettor 100 on outcome 0, host 50 on outcome 1
    await bettor.approveUsdt(U(100))
    await bettor.joinBet({ betId, outcome: 0, amount: U(100) })
    await host.approveUsdt(U(50))
    await host.joinBet({ betId, outcome: 1, amount: U(50) })

    let b = await host.getBet(betId)
    expect(b.totalPool).to.equal(U(150))
    expect(b.status).to.equal('Open')

    // propose + confirm (winner: outcome 0)
    await host.proposeResult({ betId, outcome: 0, disputeWindow: 0 })
    await host.confirmResult(betId)
    b = await host.getBet(betId)
    expect(b.status).to.equal('Resolved')
    expect(b.winningOutcome).to.equal(0)

    // claim: sole winner takes 93% of the 150 pool = 139.5
    const before = await bettor.getUsdtBalance()
    await bettor.claim(betId)
    const gained = (await bettor.getUsdtBalance()) - before
    expect(gained).to.equal(U('139.5'))
  })
})
