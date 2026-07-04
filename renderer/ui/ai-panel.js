// src/ui/ai-panel.js
// -----------------------------------------------------------------------------
// The "Ask the AI" panel + engine status indicator. Pure view: it forwards
// questions via onAsk and displays answers; app.js owns the actual inference.
// -----------------------------------------------------------------------------

import { el } from './dom.js'

export class AiPanel {
  /**
   * @param {object} refs
   * @param {HTMLInputElement} refs.input
   * @param {HTMLButtonElement} refs.ask
   * @param {HTMLElement} refs.answer
   * @param {HTMLElement} refs.status
   */
  constructor ({ input, ask, answer, status }) {
    this.input = input
    this.ask = ask
    this.answer = answer
    this.status = status
    this._onAsk = () => {}

    const submit = () => {
      const q = this.input.value.trim()
      if (!q) return
      this._onAsk(q)
      this.input.value = ''
    }
    this.ask.addEventListener('click', submit)
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  }

  onAsk (fn) { this._onAsk = fn }

  /** Reflect engine state: 'loading' | 'ready' | 'offline'. */
  setStatus (state) {
    const map = {
      loading: { text: '● loading model…', cls: 'status loading' },
      ready: { text: '● on-device AI ready', cls: 'status ready' },
      offline: { text: '● AI offline (SDK missing)', cls: 'status offline' }
    }
    const s = map[state] || map.offline
    this.status.textContent = s.text
    this.status.className = s.cls
  }

  showThinking () {
    this.answer.replaceChildren(el('span', { cls: 'thinking', text: 'Thinking on-device…' }))
  }

  showAnswer (text) {
    this.answer.replaceChildren(el('span', { cls: 'answer-text', text }))
  }

  showError (message) {
    this.answer.replaceChildren(el('span', { cls: 'answer-error', text: message }))
  }
}
