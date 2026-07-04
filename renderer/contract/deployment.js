// renderer/contract/deployment.js
// The active betting-contract deployment the app talks to. Overwritten by the
// deploy script (contracts/scripts/deploy.js). Defaults to null until a
// deployment exists, so the UI shows a clear "not deployed" message.
//
// Shape: { network, chainId, usdt, dao, bets } | null
export default null
