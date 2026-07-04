// src/ui/chat-view.js
// -----------------------------------------------------------------------------
// Renders the fan chat column. Pure view: takes chat events in, renders them;
// forwards user-typed messages via an onSend callback provided by app.js.
//
// Host moderation: each chat row carries its Hypercore seq (data-seq) and, for
// a host, a × delete button. A 'delete' tombstone removes the matching row for
// every peer.
// -----------------------------------------------------------------------------

import { el, clock } from './dom.js'

export class ChatView {
  /**
   * @param {HTMLElement} listEl
   * @param {HTMLInputElement} inputEl
   * @param {HTMLButtonElement} sendEl
   * @param {object} [opts] { isHost, onDelete }
   */
  constructor (listEl, inputEl, sendEl, { isHost = false, onDelete = () => {} } = {}) {
    this.listEl = listEl
    this.inputEl = inputEl
    this.sendEl = sendEl
    this.isHost = isHost
    this.onDelete = onDelete
    this._onSend = () => {}

    const submit = () => {
      const text = this.inputEl.value.trim()
      if (!text) return
      this._onSend(text)
      this.inputEl.value = ''
    }
    this.sendEl.addEventListener('click', submit)
    this.inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
  }

  /** Register the callback fired when the user sends a message. */
  onSend (fn) { this._onSend = fn }

  /** Render one chat event. Delete tombstones remove their target; others ignored. */
  render (event) {
    if (event.kind === 'delete') {
      if (event.data && event.data.targetSeq != null) this.removeBySeq(event.data.targetSeq)
      return
    }
    if (event.kind !== 'chat') return
    const row = el('div', { cls: 'chat-row' })
    if (event.seq != null) row.setAttribute('data-seq', String(event.seq))
    row.appendChild(el('span', { cls: 'chat-author', text: event.author }))
    row.appendChild(el('span', { cls: 'chat-time', text: clock(event.at) }))
    if (this.isHost && event.seq != null) row.appendChild(this._delBtn(event.seq))
    row.appendChild(el('div', { cls: 'chat-text', text: event.data.text }))
    this.listEl.appendChild(row)
    this.listEl.scrollTop = this.listEl.scrollHeight
  }

  /** Remove a chat row by its event seq (host delete synced). */
  removeBySeq (seq) {
    const node = this.listEl.querySelector(`.chat-row[data-seq="${seq}"]`)
    if (node) node.remove()
  }

  _delBtn (seq) {
    const btn = el('button', { cls: 'row-del', text: '×', attrs: { title: 'Delete (host)' } })
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.onDelete(seq) })
    return btn
  }
}
