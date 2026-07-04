// scripts/fund.js
// Fund one or more addresses on the local Hardhat node so the app's WDK wallet
// can pay gas and stake USDT. Reads the USDT address from deployments/<net>.json.
//
//   npx hardhat run scripts/fund.js --network localhost
//     FUND=0xYourAppAddress[,0xAnother] npx hardhat run scripts/fund.js --network localhost
//
// Defaults: sends 100 native (gas) + mints 10,000 USDT to each target. With no
// FUND set, it funds a couple of demo addresses AND prints a reminder to pass
// the address your app shows after "Create new wallet".
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')
const { ethers, network } = hre

async function main() {
  const depFile = path.join(__dirname, '..', 'deployments', `${network.name}.json`)
  if (!fs.existsSync(depFile)) {
    throw new Error(`no deployment for ${network.name} — run scripts/deploy.js first`)
  }
  const dep = JSON.parse(fs.readFileSync(depFile, 'utf8'))
  const [funder] = await ethers.getSigners()
  const usdt = await ethers.getContractAt('MockUSDT', dep.usdt)
  const decimals = Number(await usdt.decimals())

  const targets = (process.env.FUND || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (targets.length === 0) {
    console.log('No FUND=<address> provided.')
    console.log('In the app, click "Create new wallet", copy the address it shows, then run:')
    console.log('  FUND=0xYourAppAddress npx hardhat run scripts/fund.js --network localhost')
    return
  }

  const nativeAmt = ethers.parseEther('100')
  const usdtAmt = ethers.parseUnits('10000', decimals)

  for (const to of targets) {
    if (!ethers.isAddress(to)) {
      console.log(`skip invalid address: ${to}`)
      continue
    }
    await (await funder.sendTransaction({ to, value: nativeAmt })).wait()
    await (await usdt.mint(to, usdtAmt)).wait()
    const nat = await ethers.provider.getBalance(to)
    const bal = await usdt.balanceOf(to)
    console.log(
      `Funded ${to}: ${ethers.formatEther(nat)} native, ${ethers.formatUnits(bal, decimals)} USDT`
    )
  }
  console.log('\nUSDT token address:', dep.usdt)
  console.log('Bets  contract   :', dep.bets)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
