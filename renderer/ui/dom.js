// src/ui/dom.js
// -----------------------------------------------------------------------------
// Tiny DOM helpers shared by the view modules. Keeps views free of repetitive
// document.createElement boilerplate and centralizes escaping.
// -----------------------------------------------------------------------------

/** Create an element with optional class, text, and attributes. */
export function el(tag, { cls, text, attrs } = {}) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== null) node.textContent = text
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

/** Format an epoch-ms timestamp as HH:MM. */
export function clock(at) {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
