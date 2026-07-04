// src/ui/feed-view.js
// -----------------------------------------------------------------------------
// Renders the live match feed: match events, reactions, and AI commentary.
// Pure view — it receives events and renders them; it never touches P2P or AI.
//
// Host moderation: rows carry their Hypercore seq (data-seq) and, for a host,
// a × delete button that calls onDelete(seq). A 'delete' tombstone event hides
// the matching row for every peer (see removeBySeq).
// -----------------------------------------------------------------------------

import { el, clock } from './dom.js'

export class FeedView {
  /**
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {boolean} [opts.isHost]           show delete buttons
   * @param {(seq:number)=>void} [opts.onDelete]
   */
  constructor(container, { isHost = false, onDelete = () => {} } = {}) {
    this.container = container
    this.isHost = isHost
    this.onDelete = onDelete
  }

  /** Render a single feed event as a row and scroll into view. */
  render(event) {
    // A delete tombstone isn't shown — it removes its target instead.
    if (event.kind === 'delete') {
      if (event.data && event.data.targetSeq !== null) this.removeBySeq(event.data.targetSeq)
      return
    }
    const row = this._rowFor(event)
    if (!row) return
    if (event.seq !== null) row.setAttribute('data-seq', String(event.seq))
    if (this.isHost && event.seq !== null) row.appendChild(this._delBtn(event.seq))
    this.container.appendChild(row)
    this.container.scrollTop = this.container.scrollHeight
  }

  /** Remove any rendered row whose event seq matches (host delete synced). */
  removeBySeq(seq) {
    const node = this.container.querySelector(`[data-seq="${seq}"]`)
    if (node) node.remove()
  }

  _delBtn(seq) {
    const btn = el('button', { cls: 'row-del', text: '×', attrs: { title: 'Delete (host)' } })
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.onDelete(seq)
    })
    return btn
  }

  _rowFor(event) {
    const { kind, author, data } = event
    switch (kind) {
      case 'match': {
        const row = el('div', { cls: 'feed-row feed-match' })
        row.appendChild(el('span', { cls: 'badge', text: `${data.minute ?? '-'}'` }))
        row.appendChild(el('span', { cls: 'feed-text', text: data.text || data.type }))
        return row
      }
      case 'commentary': {
        const row = el('div', { cls: 'feed-row feed-commentary' })
        row.appendChild(el('span', { cls: 'ai-tag', text: '🎙 AI' }))
        row.appendChild(el('span', { cls: 'feed-text', text: data.text }))
        return row
      }
      case 'reaction': {
        const row = el('div', { cls: 'feed-row feed-reaction' })
        row.appendChild(el('span', { cls: 'feed-text', text: `${author} ${data.emoji}` }))
        return row
      }
      case 'system': {
        const row = el('div', { cls: 'feed-row feed-system' })
        row.appendChild(el('span', { cls: 'feed-text', text: data.text }))
        return row
      }
      default:
        return null // chat is rendered by ChatView, not here
    }
  }

  /** Render a full history array (used on join / replay). */
  renderAll(events) {
    for (const e of events) this.render(e)
  }
}
