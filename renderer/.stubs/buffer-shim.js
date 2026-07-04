// Provides a browser Buffer for the sandboxed Electron renderer. Several deps
// (bip39, elliptic/ethers internals, sodium-universal fallbacks) expect the
// Node `Buffer` global, which Chromium does not have. esbuild injects this so
// `Buffer` resolves to the pure-JS `buffer` package.
import { Buffer } from 'buffer'
export { Buffer }
