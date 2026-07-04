// workers/lib/qvac.js  (Bare/CommonJS — desktop Pear v2)
// On-device AI via @qvac/bare-sdk. Registers the llama.cpp LLM plugin, then
// loads the model directly from a Hugging Face HTTPS URL (verified working on
// desktop: 773MB download + inference). QVAC's llamacpp engine fetches over
// plain HTTPS, streaming progress.

const {
  commentaryPrompt,
  questionPrompt,
  oddsPrompt,
  outcomePrompt,
  DEFAULT_PERSONA
} = require('./prompts.js')

// Extract the first JSON object from a model response that may wrap it in prose
// or code fences. Returns null if nothing parseable is found.
function extractJson(text) {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

// @qvac/bare-sdk ships NO built-in addons — register the LLM plugin explicitly.
let sdk = null
let base = null
function loadSdk() {
  if (sdk) return sdk
  let stage = 'require @qvac/bare-sdk'
  try {
    base = require('@qvac/bare-sdk')
    stage = 'require llamacpp-completion/plugin'
    const { llmPlugin } = require('@qvac/bare-sdk/llamacpp-completion/plugin')
    stage = 'plugins([llmPlugin])'
    sdk = base.plugins([llmPlugin])
  } catch (err) {
    throw new Error('QVAC LLM plugin failed at [' + stage + ']: ' + (err && err.message))
  }
  return sdk
}

class CommentaryEngine {
  // Direct Hugging Face GGUF (~773MB) over plain HTTPS.
  static MODEL_URL =
    'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'

  constructor({ modelName, persona = DEFAULT_PERSONA, onProgress } = {}) {
    this.modelName = modelName
    this.persona = persona
    this.onProgress = onProgress
    this._modelId = null
    this._ready = false
    this._initP = null
  }

  get isReady() {
    return this._ready
  }

  async init() {
    if (this._ready) return
    if (this._initP) return this._initP
    this._initP = this._doInit().finally(() => {
      this._initP = null
    })
    return this._initP
  }

  async _doInit() {
    const s = loadSdk()
    const modelSrc = this.modelName || CommentaryEngine.MODEL_URL
    const safeProgress = (p) => {
      try {
        if (this.onProgress) this.onProgress(p)
      } catch {
        /* never throw — QVAC aborts on a throwing progress cb */
      }
    }
    this._modelId = await s.loadModel({
      modelSrc,
      modelType: 'llamacpp-completion',
      modelConfig: { ctx_size: 2048 },
      onProgress: safeProgress
    })
    this._ready = true
  }

  async commentate(event, { persona = this.persona } = {}) {
    return this._complete(commentaryPrompt({ persona, event }))
  }

  async answer(question, recentEvents = []) {
    return this._complete(questionPrompt({ question, recentEvents }))
  }

  // Estimate implied probabilities for each outcome. Returns a normalized
  // { probabilities:[...], rationale } — informational odds for a pari-mutuel
  // pool. Falls back to a uniform split if the model output isn't parseable.
  async odds({ question, outcomes, context = '' }) {
    const raw = await this._complete(oddsPrompt({ question, outcomes, context }))
    const n = outcomes.length
    const uniform = () => Array(n).fill(1 / n)
    const parsed = extractJson(raw)
    let probs = parsed && Array.isArray(parsed.probabilities) ? parsed.probabilities : null
    if (!probs || probs.length !== n || probs.some((p) => typeof p !== 'number' || p < 0)) {
      probs = uniform()
    }
    const sum = probs.reduce((a, b) => a + b, 0)
    probs = sum > 0 ? probs.map((p) => p / sum) : uniform()
    return { probabilities: probs, rationale: (parsed && parsed.rationale) || '' }
  }

  // Suggest the winning outcome, grounded in real match data when provided.
  // Returns { outcome:<index>, reason } or { outcome:null } if unparseable.
  async proposeOutcome({ question, outcomes, context = '' }) {
    const raw = await this._complete(outcomePrompt({ question, outcomes, context }))
    const parsed = extractJson(raw)
    const idx = parsed && Number.isInteger(parsed.outcome) ? parsed.outcome : null
    const valid = idx !== null && idx >= 0 && idx < outcomes.length
    return { outcome: valid ? idx : null, reason: (parsed && parsed.reason) || '' }
  }

  async _complete(history) {
    if (!this._ready) await this.init()
    const s = loadSdk()
    const run = s.completion({ modelId: this._modelId, history, stream: false })
    const result = await run.final
    return result.contentText.trim()
  }

  async dispose() {
    if (!this._ready) return
    const s = loadSdk()
    await s.unloadModel({ modelId: this._modelId })
    this._modelId = null
    this._ready = false
  }
}

module.exports = { CommentaryEngine, extractJson }
