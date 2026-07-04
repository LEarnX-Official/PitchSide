const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')

// 6-decimal USDT units
const U = (n) => ethers.parseUnits(n.toString(), 6)
const DAO_BPS = 500n
const HOST_BPS = 200n
const BPS = 10_000n

async function future(seconds = 3600) {
  return (await time.latest()) + seconds
}

describe('PitchSideBets', function () {
  let usdt, bets
  let dao, host, alice, bob, carol, other

  beforeEach(async function () {
    ;[dao, host, alice, bob, carol, other] = await ethers.getSigners()

    const MockUSDT = await ethers.getContractFactory('MockUSDT')
    usdt = await MockUSDT.deploy()

    const Bets = await ethers.getContractFactory('PitchSideBets')
    bets = await Bets.deploy(await usdt.getAddress(), dao.address)

    // Fund the bettors and approve the escrow.
    for (const who of [alice, bob, carol, other]) {
      await usdt.mint(who.address, U(1_000))
      await usdt.connect(who).approve(await bets.getAddress(), ethers.MaxUint256)
    }
  })

  // ---- helpers -----------------------------------------------------------

  async function openBet(opts = {}) {
    const closesAt = opts.closesAt ?? (await future(3600))
    const tx = await bets
      .connect(opts.host ?? host)
      .createBet(
        opts.matchRef ?? 'ARS-vs-CHE',
        opts.question ?? 'Will Arsenal win?',
        opts.outcomeCount ?? 2,
        closesAt
      )
    const rc = await tx.wait()
    // betId is 0 for the first bet created in a fresh deployment.
    return 0n
  }

  // ---- construction ------------------------------------------------------

  describe('deployment', function () {
    it('stores usdt + dao and exposes the fee constants', async function () {
      expect(await bets.usdt()).to.equal(await usdt.getAddress())
      expect(await bets.dao()).to.equal(dao.address)
      expect(await bets.DAO_BPS()).to.equal(DAO_BPS)
      expect(await bets.HOST_BPS()).to.equal(HOST_BPS)
      expect(await bets.BPS_DENOMINATOR()).to.equal(BPS)
    })

    it('reverts on zero usdt or zero dao', async function () {
      const Bets = await ethers.getContractFactory('PitchSideBets')
      await expect(Bets.deploy(ethers.ZeroAddress, dao.address)).to.be.revertedWithCustomError(
        bets,
        'ZeroAddress'
      )
      await expect(
        Bets.deploy(await usdt.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(bets, 'ZeroAddress')
    })
  })

  // ---- createBet ---------------------------------------------------------

  describe('createBet', function () {
    it('opens a bet with the caller as host and increments betCount', async function () {
      const closesAt = await future()
      await expect(bets.connect(host).createBet('m', 'q?', 2, closesAt))
        .to.emit(bets, 'BetCreated')
        .withArgs(0, host.address, 'm', 'q?', 2, closesAt)

      const b = await bets.getBet(0)
      expect(b.host).to.equal(host.address)
      expect(b.status).to.equal(0) // Open
      expect(b.outcomeCount).to.equal(2)
      expect(await bets.betCount()).to.equal(1)
    })

    it('rejects < 2 outcomes and a close time in the past', async function () {
      await expect(bets.createBet('m', 'q', 1, await future())).to.be.revertedWithCustomError(
        bets,
        'BadOutcomeCount'
      )
      await expect(
        bets.createBet('m', 'q', 2, (await time.latest()) - 1)
      ).to.be.revertedWithCustomError(bets, 'CloseInPast')
    })

    it('getBet reverts for an unknown bet', async function () {
      await expect(bets.getBet(99)).to.be.revertedWithCustomError(bets, 'UnknownBet')
    })
  })

  // ---- joinBet -----------------------------------------------------------

  describe('joinBet', function () {
    let betId
    beforeEach(async function () {
      betId = await openBet()
    })

    it('pulls USDT into escrow and records stake/pools', async function () {
      await expect(bets.connect(alice).joinBet(betId, 0, U(100)))
        .to.emit(bets, 'BetJoined')
        .withArgs(betId, alice.address, 0, U(100))

      expect(await usdt.balanceOf(await bets.getAddress())).to.equal(U(100))
      expect(await bets.outcomePool(betId, 0)).to.equal(U(100))
      expect(await bets.stakeOf(betId, alice.address, 0)).to.equal(U(100))
      const b = await bets.getBet(betId)
      expect(b.totalPool).to.equal(U(100))
    })

    it('accumulates repeated joins and supports multiple outcomes/users', async function () {
      await bets.connect(alice).joinBet(betId, 0, U(50))
      await bets.connect(alice).joinBet(betId, 0, U(25))
      await bets.connect(bob).joinBet(betId, 1, U(40))

      expect(await bets.stakeOf(betId, alice.address, 0)).to.equal(U(75))
      expect(await bets.outcomePool(betId, 0)).to.equal(U(75))
      expect(await bets.outcomePool(betId, 1)).to.equal(U(40))
      expect((await bets.getBet(betId)).totalPool).to.equal(U(115))
    })

    it('rejects zero amount, invalid outcome, and unknown bet', async function () {
      await expect(bets.connect(alice).joinBet(betId, 0, 0)).to.be.revertedWithCustomError(
        bets,
        'ZeroAmount'
      )
      await expect(bets.connect(alice).joinBet(betId, 2, U(1))).to.be.revertedWithCustomError(
        bets,
        'InvalidOutcome'
      )
      await expect(bets.connect(alice).joinBet(123, 0, U(1))).to.be.revertedWithCustomError(
        bets,
        'UnknownBet'
      )
    })

    it('rejects joins after close time', async function () {
      const closesAt = await future(100)
      await bets.connect(host).createBet('m', 'q', 2, closesAt)
      const id = 1n
      await time.increaseTo(closesAt)
      await expect(bets.connect(alice).joinBet(id, 0, U(10))).to.be.revertedWithCustomError(
        bets,
        'BettingClosed'
      )
    })
  })

  // ---- proposeResult -----------------------------------------------------

  describe('proposeResult', function () {
    let betId
    beforeEach(async function () {
      betId = await openBet()
      await bets.connect(alice).joinBet(betId, 0, U(100))
      await bets.connect(bob).joinBet(betId, 1, U(100))
    })

    it('anyone may relay the AI proposal; sets dispute window + status', async function () {
      const t = await time.latest()
      await expect(bets.connect(other).proposeResult(betId, 0, 600))
        .to.emit(bets, 'ResultProposed')
        .withArgs(betId, 0, anyCloseTo(t + 600))

      const b = await bets.getBet(betId)
      expect(b.status).to.equal(1) // Proposed
      expect(b.proposedOutcome).to.equal(0)
    })

    it('rejects an out-of-range outcome and a non-open bet', async function () {
      await expect(bets.proposeResult(betId, 5, 0)).to.be.revertedWithCustomError(
        bets,
        'InvalidOutcome'
      )
      await bets.proposeResult(betId, 0, 0)
      await expect(bets.proposeResult(betId, 1, 0)).to.be.revertedWithCustomError(bets, 'NotOpen')
    })
  })

  // ---- confirmResult + fee math + claim ---------------------------------

  describe('confirmResult / claim (payout + fee splits)', function () {
    let betId
    beforeEach(async function () {
      betId = await openBet()
      // Winning outcome 0: alice 300, carol 100 (4:1). Losing outcome 1: bob 100.
      await bets.connect(alice).joinBet(betId, 0, U(300))
      await bets.connect(carol).joinBet(betId, 0, U(100))
      await bets.connect(bob).joinBet(betId, 1, U(100))
    })

    it('confirm pays 5% dao + 2% host and lets winners claim pro-rata', async function () {
      const pool = U(500)
      const daoCut = (pool * DAO_BPS) / BPS // 25
      const hostCut = (pool * HOST_BPS) / BPS // 10
      const winnersPool = pool - daoCut - hostCut // 465

      await bets.proposeResult(betId, 0, 0)

      const daoBefore = await usdt.balanceOf(dao.address)
      const hostBefore = await usdt.balanceOf(host.address)

      await expect(bets.connect(host).confirmResult(betId))
        .to.emit(bets, 'BetResolved')
        .withArgs(betId, 0, daoCut, hostCut, winnersPool)

      expect((await usdt.balanceOf(dao.address)) - daoBefore).to.equal(daoCut)
      expect((await usdt.balanceOf(host.address)) - hostBefore).to.equal(hostCut)

      // alice staked 300/400 of winners -> 465 * 3/4 = 348.75
      // carol staked 100/400 of winners -> 465 * 1/4 = 116.25
      const aliceShare = (winnersPool * U(300)) / U(400)
      const carolShare = (winnersPool * U(100)) / U(400)

      const aBefore = await usdt.balanceOf(alice.address)
      await expect(bets.connect(alice).claim(betId))
        .to.emit(bets, 'WinningsClaimed')
        .withArgs(betId, alice.address, aliceShare)
      expect((await usdt.balanceOf(alice.address)) - aBefore).to.equal(aliceShare)

      const cBefore = await usdt.balanceOf(carol.address)
      await bets.connect(carol).claim(betId)
      expect((await usdt.balanceOf(carol.address)) - cBefore).to.equal(carolShare)

      // Escrow should hold only rounding dust (here exactly 0).
      expect(await usdt.balanceOf(await bets.getAddress())).to.equal(0n)
    })

    it('only the host can confirm', async function () {
      await bets.proposeResult(betId, 0, 0)
      await expect(bets.connect(alice).confirmResult(betId)).to.be.revertedWithCustomError(
        bets,
        'NotHost'
      )
    })

    it('cannot confirm before the dispute window elapses, can after', async function () {
      await bets.proposeResult(betId, 0, 1000)
      await expect(bets.connect(host).confirmResult(betId)).to.be.revertedWithCustomError(
        bets,
        'DisputeWindowActive'
      )
      await time.increase(1001)
      await expect(bets.connect(host).confirmResult(betId)).to.emit(bets, 'BetResolved')
    })

    it('cannot confirm a bet that was never proposed', async function () {
      await expect(bets.connect(host).confirmResult(betId)).to.be.revertedWithCustomError(
        bets,
        'NotProposed'
      )
    })

    it('reverts confirm when nobody staked the winning outcome', async function () {
      // Propose outcome 1 as winner is fine (bob staked it). Instead build a
      // fresh bet where the winning outcome has zero stake.
      await bets.connect(host).createBet('m', 'q', 3, await future())
      const id = 1n
      await bets.connect(alice).joinBet(id, 0, U(10))
      await bets.proposeResult(id, 2, 0) // nobody staked outcome 2
      await expect(bets.connect(host).confirmResult(id)).to.be.revertedWithCustomError(
        bets,
        'CannotCancelNow'
      )
    })

    it('a loser cannot claim, and a winner cannot double-claim', async function () {
      await bets.proposeResult(betId, 0, 0)
      await bets.connect(host).confirmResult(betId)

      await expect(bets.connect(bob).claim(betId)).to.be.revertedWithCustomError(bets, 'NotWinner')

      await bets.connect(alice).claim(betId)
      await expect(bets.connect(alice).claim(betId)).to.be.revertedWithCustomError(
        bets,
        'AlreadyWithdrawn'
      )
    })

    it('cannot claim before the bet is resolved', async function () {
      await expect(bets.connect(alice).claim(betId)).to.be.revertedWithCustomError(
        bets,
        'NotProposed'
      )
    })
  })

  // ---- cancel / refund ---------------------------------------------------

  describe('cancelBet / refund', function () {
    let betId
    beforeEach(async function () {
      betId = await openBet()
      await bets.connect(alice).joinBet(betId, 0, U(100))
      await bets.connect(alice).joinBet(betId, 1, U(50))
      await bets.connect(bob).joinBet(betId, 1, U(200))
    })

    it('host can cancel an open bet and everyone refunds their full stake', async function () {
      await expect(bets.connect(host).cancelBet(betId))
        .to.emit(bets, 'BetCancelled')
        .withArgs(betId)

      const aBefore = await usdt.balanceOf(alice.address)
      await expect(bets.connect(alice).refund(betId))
        .to.emit(bets, 'StakeRefunded')
        .withArgs(betId, alice.address, U(150)) // 100 + 50 across outcomes
      expect((await usdt.balanceOf(alice.address)) - aBefore).to.equal(U(150))

      await bets.connect(bob).refund(betId)
      expect(await usdt.balanceOf(await bets.getAddress())).to.equal(0n)
    })

    it('host can cancel during the dispute window (wrong AI call)', async function () {
      await bets.proposeResult(betId, 0, 1000)
      await expect(bets.connect(host).cancelBet(betId)).to.emit(bets, 'BetCancelled')
      await bets.connect(bob).refund(betId)
      expect(await bets.withdrawn(betId, bob.address)).to.equal(true)
    })

    it('non-host cannot cancel; cannot cancel a resolved bet', async function () {
      await expect(bets.connect(alice).cancelBet(betId)).to.be.revertedWithCustomError(
        bets,
        'NotHost'
      )

      await bets.proposeResult(betId, 1, 0)
      await bets.connect(host).confirmResult(betId)
      await expect(bets.connect(host).cancelBet(betId)).to.be.revertedWithCustomError(
        bets,
        'CannotCancelNow'
      )
    })

    it('refund reverts when bet not cancelled, on double refund, and for non-stakers', async function () {
      await expect(bets.connect(alice).refund(betId)).to.be.revertedWithCustomError(
        bets,
        'CannotCancelNow'
      )

      await bets.connect(host).cancelBet(betId)
      await bets.connect(alice).refund(betId)
      await expect(bets.connect(alice).refund(betId)).to.be.revertedWithCustomError(
        bets,
        'AlreadyWithdrawn'
      )
      await expect(bets.connect(carol).refund(betId)).to.be.revertedWithCustomError(
        bets,
        'NothingToClaim'
      )
    })
  })

  // ---- reentrancy --------------------------------------------------------

  describe('reentrancy', function () {
    it('guards claim against a malicious re-entrant token', async function () {
      const RT = await ethers.getContractFactory('ReentrantToken')
      const rt = await RT.deploy()

      const Bets = await ethers.getContractFactory('PitchSideBets')
      const evilBets = await Bets.deploy(await rt.getAddress(), dao.address)

      await rt.mint(alice.address, U(1000))
      await rt.connect(alice).approve(await evilBets.getAddress(), ethers.MaxUint256)

      await evilBets.connect(host).createBet('m', 'q', 2, await future())
      const id = 0n
      await evilBets.connect(alice).joinBet(id, 0, U(100))
      await evilBets.proposeResult(id, 0, 0)
      await evilBets.connect(host).confirmResult(id)

      await rt.arm(await evilBets.getAddress(), id)

      // Claim triggers the token's re-entrant claim attempt, which the guard
      // must block. The outer claim still succeeds exactly once.
      const pool = U(100)
      const winnersPool = pool - (pool * DAO_BPS) / BPS - (pool * HOST_BPS) / BPS
      const before = await rt.balanceOf(alice.address)
      await evilBets.connect(alice).claim(id)
      expect((await rt.balanceOf(alice.address)) - before).to.equal(winnersPool)
      expect(await rt.reentered()).to.equal(true) // the attack was attempted
      expect(await evilBets.withdrawn(id, alice.address)).to.equal(true)
    })
  })
})

// Loose matcher for a block-time-dependent event arg (dispute window end).
function anyCloseTo(target, tol = 5) {
  return (v) => {
    const n = Number(v)
    return n >= target - tol && n <= target + tol
  }
}
