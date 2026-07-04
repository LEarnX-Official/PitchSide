import { readFileSync } from 'node:fs'
import { ethers } from 'ethers'
const dep = JSON.parse(readFileSync('/home/devil/Desktop/hackathons/pitchside-v2/contracts/deployments/localhost.json','utf8'))
const store=new Map(); globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)}
const W = await import('./w.mjs')
W.generateSeed()
const wallet = new W.Wallet({ deployment: dep })
const addr = await wallet.connect()
await wallet.faucetGas()
console.log('wallet nonce (latest):', await new ethers.JsonRpcProvider('http://127.0.0.1:8545').getTransactionCount(addr,'latest'))
console.log('wallet._nonce internal:', wallet._nonce)
// Try the raw mint via WDK sendTransaction directly (bypass _serialTx) to see if IT hangs
const erc20 = new ethers.Interface(['function mint(address to, uint256 amount)'])
const data = erc20.encodeFunctionData('mint',[addr, ethers.parseUnits('100',6)])
console.log('sending raw mint via account.sendTransaction…')
const res = await wallet._account.sendTransaction({ to: dep.usdt, data, value:0n, nonce: wallet._nonce })
console.log('broadcast hash:', res.hash)
const r = await new ethers.JsonRpcProvider('http://127.0.0.1:8545').waitForTransaction(res.hash)
console.log('mined status:', r.status)
process.exit(0)
