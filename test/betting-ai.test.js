// test/betting-ai.test.js — betting prompt building + AI JSON parsing/normalize.
// Pure logic: no model, no network. (loadSdk() in qvac.js is lazy, so requiring
// the module does not touch @qvac/bare-sdk.)
const { test } = require('node:test')
const assert = require('node:assert')
const { oddsPrompt, outcomePrompt } = require('../workers/lib/prompts.js')
const { extractJson } = require('../workers/lib/qvac.js')

test('oddsPrompt lists each outcome with its index and asks for JSON', () => {
  const h = oddsPrompt({ question: 'Will Arsenal win?', outcomes: ['Yes', 'No'] })
  assert.strictEqual(h.length, 2)
  assert.strictEqual(h[0].role, 'system')
  assert.ok(/probabilities/i.test(h[0].content), 'system turn asks for probabilities JSON')
  assert.ok(h[1].content.includes('0: Yes'), 'outcome 0 indexed')
  assert.ok(h[1].content.includes('1: No'), 'outcome 1 indexed')
})

test('oddsPrompt includes real-match context when provided', () => {
  const h = oddsPrompt({ question: 'q?', outcomes: ['a', 'b'], context: "Arsenal 2-0 up at 70'" })
  assert.ok(h[1].content.includes("Arsenal 2-0 up at 70'"), 'context injected')
})

test('outcomePrompt tells the model to prefer the real result and return an index', () => {
  const h = outcomePrompt({
    question: 'q?',
    outcomes: ['Home', 'Draw', 'Away'],
    context: 'Full time 3-1'
  })
  assert.ok(/real match result/i.test(h[0].content))
  assert.ok(/\"outcome\"/.test(h[0].content), 'asks for {"outcome":...}')
  assert.ok(h[1].content.includes('Full time 3-1'))
})

// --- extractJson --------------------------------------------------------------

test('extractJson parses a bare JSON object', () => {
  const o = extractJson('{"probabilities":[0.6,0.4],"rationale":"x"}')
  assert.deepStrictEqual(o.probabilities, [0.6, 0.4])
})

test('extractJson strips surrounding prose', () => {
  const o = extractJson('Sure! Here you go: {"outcome":1,"reason":"they won"} hope that helps')
  assert.strictEqual(o.outcome, 1)
})

test('extractJson handles fenced code blocks', () => {
  const o = extractJson('```json\n{"probabilities":[1]}\n```')
  assert.deepStrictEqual(o.probabilities, [1])
})

test('extractJson returns null for unparseable text', () => {
  assert.strictEqual(extractJson('no json here at all'), null)
  assert.strictEqual(extractJson(''), null)
  assert.strictEqual(extractJson('{ not valid'), null)
})
