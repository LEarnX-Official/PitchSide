// workers/lib/prompts.js  (port of src/prompts/commentary.js)

const PERSONAS = {
  hype: 'You are an ecstatic, high-energy football commentator. React to match ' +
        'events with vivid, punchy, crowd-thrilling one-liners. Max 2 sentences.',
  analyst: 'You are a calm tactical football analyst. Explain the significance ' +
           'of match events in clear, insightful terms. Max 2 sentences.',
  banter: 'You are a witty football pundit with dry humor. Add playful banter to ' +
          'match events. Keep it light and short. Max 2 sentences.'
}
const DEFAULT_PERSONA = 'hype'

function commentaryPrompt ({ persona = DEFAULT_PERSONA, event }) {
  const system = PERSONAS[persona] || PERSONAS[DEFAULT_PERSONA]
  const { type, minute, text } = event
  const desc = text || (type + ' at minute ' + (minute != null ? minute : '?'))
  return [
    { role: 'system', content: system },
    { role: 'user', content: 'Commentate on this live match event: ' + desc }
  ]
}

function questionPrompt ({ question, recentEvents = [] }) {
  const context = recentEvents.slice(-6)
    .map((e) => '- ' + (e.data && (e.data.text || e.data.type) || e.kind))
    .join('\n')
  return [
    { role: 'system', content: 'You are a knowledgeable, concise football expert answering a fan during a live watch-party. Answer in 1-3 sentences.' },
    { role: 'user', content: 'Recent match events:\n' + (context || '(none yet)') + '\n\nFan question: ' + question }
  ]
}

// --- betting prompts ---------------------------------------------------------
// The on-device LLM (QVAC) produces betting *odds* and a *suggested outcome*.
// Both are informational: the pool is pari-mutuel (winners split the pot
// pro-rata), and the on-chain host still confirms any result. We ask the model
// to return strict JSON so the UI can parse it deterministically.

function oddsPrompt ({ question, outcomes, context = '' }) {
  const list = outcomes.map((o, i) => `${i}: ${o}`).join('\n')
  return [
    { role: 'system', content:
      'You are a football betting analyst. Given a question and its possible ' +
      'outcomes, estimate the implied probability of each outcome. Respond with ' +
      'ONLY a JSON object of the form {"probabilities":[<numbers that sum to 1>],' +
      '"rationale":"<one short sentence>"}. The probabilities array must have ' +
      'exactly one entry per outcome, in order. No prose outside the JSON.' },
    { role: 'user', content:
      `Question: ${question}\nOutcomes:\n${list}\n` +
      (context ? `\nContext (real match data):\n${context}\n` : '') +
      `\nReturn the JSON now.` }
  ]
}

function outcomePrompt ({ question, outcomes, context = '' }) {
  const list = outcomes.map((o, i) => `${i}: ${o}`).join('\n')
  return [
    { role: 'system', content:
      'You decide the winning outcome of a settled football bet. Prefer the ' +
      'REAL match result in the provided context over any guess. Respond with ' +
      'ONLY a JSON object {"outcome":<index>,"reason":"<one short sentence ' +
      'citing the result>"}. The outcome must be one of the listed indices.' },
    { role: 'user', content:
      `Question: ${question}\nOutcomes:\n${list}\n` +
      (context ? `\nReal match data:\n${context}\n` : '\n(no match data provided)\n') +
      `\nReturn the JSON now.` }
  ]
}

module.exports = {
  PERSONAS, DEFAULT_PERSONA,
  commentaryPrompt, questionPrompt,
  oddsPrompt, outcomePrompt
}
