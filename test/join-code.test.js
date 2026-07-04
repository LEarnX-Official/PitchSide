// test/join-code.test.js — shareable join-code encode/decode.
const { test } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')

// join-code.js uses browser btoa/atob; shim them for node.
globalThis.btoa = (s) => Buffer.from(s, 'binary').toString('base64')
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')

const src = readFileSync(__dirname + '/../renderer/join-code.js', 'utf8')
let mod
test('load join-code module', async () => {
  mod = await import('data:text/javascript,' + encodeURIComponent(src))
  assert.ok(mod.encodeJoinCode && mod.decodeJoinCode)
})

test('internet code round-trips (room + mode, no host)', () => {
  const code = mod.encodeJoinCode({ room: 'worldcup-final', mode: 'internet' })
  assert.ok(code.startsWith('PS1-'), 'has versioned prefix')
  const d = mod.decodeJoinCode(code)
  assert.deepStrictEqual(d, { room: 'worldcup-final', mode: 'internet', host: null })
})

test('local code round-trips with host address', () => {
  const code = mod.encodeJoinCode({ room: 'my-room', mode: 'local', host: '192.168.1.20:49737' })
  const d = mod.decodeJoinCode(code)
  assert.deepStrictEqual(d, { room: 'my-room', mode: 'local', host: '192.168.1.20:49737' })
})

test('decode rejects non-codes and garbage', () => {
  assert.throws(() => mod.decodeJoinCode('garbage'), /not a PitchSide join code/)
  assert.throws(() => mod.decodeJoinCode('PS1-!!!notbase64!!!'), /invalid join code/)
})

test('room names with spaces/unicode survive the round-trip', () => {
  const code = mod.encodeJoinCode({ room: 'Café ⚽ final', mode: 'internet' })
  assert.strictEqual(mod.decodeJoinCode(code).room, 'Café ⚽ final')
})
