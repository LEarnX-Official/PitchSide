// test/prompts.test.js — pure prompt-building logic (fast, no I/O).
const { test } = require('node:test')
const assert = require('node:assert')
const {
  PERSONAS,
  DEFAULT_PERSONA,
  commentaryPrompt,
  questionPrompt
} = require('../workers/lib/prompts.js')

test('personas exist and default is valid', () => {
  assert.ok(PERSONAS[DEFAULT_PERSONA], 'default persona is defined')
  assert.ok(Object.keys(PERSONAS).length >= 3, 'at least 3 personas')
})

test('commentaryPrompt builds system+user turns from an event', () => {
  const h = commentaryPrompt({
    persona: 'hype',
    event: { type: 'goal', minute: 67, text: 'GOAL!' }
  })
  assert.strictEqual(h.length, 2)
  assert.strictEqual(h[0].role, 'system')
  assert.strictEqual(h[1].role, 'user')
  assert.ok(h[1].content.includes('GOAL!'), 'event text is in the prompt')
})

test('unknown persona falls back to default (no crash)', () => {
  const h = commentaryPrompt({ persona: 'nonexistent', event: { type: 'card', minute: 30 } })
  assert.strictEqual(h[0].content, PERSONAS[DEFAULT_PERSONA], 'falls back to default persona')
})

test('questionPrompt injects recent-event context', () => {
  const h = questionPrompt({
    question: 'offside?',
    recentEvents: [{ kind: 'match', data: { text: 'GOAL 67' } }]
  })
  assert.ok(h[1].content.includes('GOAL 67'), 'recent context included')
  assert.ok(h[1].content.includes('offside?'), 'question included')
})

test('questionPrompt handles empty context', () => {
  const h = questionPrompt({ question: 'who won?', recentEvents: [] })
  assert.ok(h[1].content.includes('(none yet)'), 'empty context marker present')
})
