// test/live-data.test.js — live real-match data transforms (pure, no network).
const { test } = require('node:test')
const assert = require('node:assert')
const { readFileSync } = require('node:fs')

// live-data.js is an ESM renderer module; load its pure exports via data: URL.
const src = readFileSync(__dirname + '/../renderer/live-data.js', 'utf8')
let mod
test('load live-data module', async () => {
  mod = await import('data:text/javascript,' + encodeURIComponent(src))
  assert.ok(mod.matchLabel && mod.newGoalEvents && mod.statusEvent)
})

const norm = {
  id: 1, status: 'IN_PLAY', minute: 67, home: 'Arsenal', away: 'Chelsea',
  scoreHome: 2, scoreAway: 1,
  goals: [
    { minute: 12, type: 'REGULAR', team: 'Arsenal', scorer: 'Saka', home: 1, away: 0 },
    { minute: 34, type: 'PENALTY', team: 'Chelsea', scorer: 'Palmer', home: 1, away: 1 }
  ]
}

test('matchLabel formats a live match', () => {
  assert.strictEqual(mod.matchLabel(norm), "Arsenal 2–1 Chelsea · LIVE 67'")
})

test('newGoalEvents produces one event per goal, with penalty tag', () => {
  const seen = new Set()
  const evs = mod.newGoalEvents(norm, seen)
  assert.strictEqual(evs.length, 2)
  assert.ok(evs[0].text.includes('Saka'))
  assert.ok(evs[1].text.includes('(pen)'), 'penalty tagged')
})

test('newGoalEvents dedups across polls (no repeats)', () => {
  const seen = new Set()
  mod.newGoalEvents(norm, seen)          // first poll
  const again = mod.newGoalEvents(norm, seen) // second poll, same data
  assert.strictEqual(again.length, 0, 'no duplicate events on re-poll')
})

test('statusEvent emits kickoff and full-time on transitions', () => {
  const ko = mod.statusEvent({ ...norm, status: 'IN_PLAY' }, 'SCHEDULED')
  assert.strictEqual(ko.type, 'kickoff')
  const ft = mod.statusEvent({ ...norm, status: 'FINISHED' }, 'IN_PLAY')
  assert.strictEqual(ft.type, 'fulltime')
  const none = mod.statusEvent({ ...norm, status: 'IN_PLAY' }, 'IN_PLAY')
  assert.strictEqual(none, null, 'no event when status unchanged')
})

test('matchIntroEvent sets the scene for a live match (immediate AI context)', () => {
  const ev = mod.matchIntroEvent({ status: 'IN_PLAY', minute: 67, home: 'Arsenal', away: 'Chelsea', scoreHome: 2, scoreAway: 1, goals: [{ minute: 12, scorer: 'Saka' }] })
  assert.strictEqual(ev.type, 'intro')
  assert.ok(ev.text.includes('Arsenal') && ev.text.includes('Chelsea'), 'teams in intro')
  assert.ok(ev.text.includes("2–1"), 'current score in intro')
  assert.ok(ev.text.includes('Saka'), 'goals so far summarized')
  assert.ok(ev.text.toLowerCase().includes('live'), 'live status noted')
})

test('matchIntroEvent handles upcoming and finished matches', () => {
  const up = mod.matchIntroEvent({ status: 'SCHEDULED', home: 'A', away: 'B', scoreHome: 0, scoreAway: 0, goals: [] })
  assert.ok(up.text.toLowerCase().includes('upcoming'))
  const done = mod.matchIntroEvent({ status: 'FINISHED', minute: 90, home: 'A', away: 'B', scoreHome: 3, scoreAway: 2, goals: [] })
  assert.ok(done.text.toLowerCase().includes('finished') && done.text.includes('3–2'))
})
