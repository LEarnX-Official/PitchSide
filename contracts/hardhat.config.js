require('@nomicfoundation/hardhat-toolbox')

// Optional: for testnet deploys, put a funded key + RPC in contracts/.env
// (never commit it). Tests run entirely on the in-process Hardhat network and
// need none of this.
try {
  require('dotenv').config()
} catch {
  /* dotenv is optional; tests don't need it */
}

const TESTNET_RPC =
  process.env.BSC_TESTNET_RPC || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: 'http://127.0.0.1:8545',
      chainId: 31337
    },
    bscTestnet: {
      url: TESTNET_RPC,
      chainId: 97,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
}
