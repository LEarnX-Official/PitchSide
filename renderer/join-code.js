// renderer/join-code.js
// -----------------------------------------------------------------------------
// A shareable "join code" that packs everything a guest needs to join a room:
//   - room name
//   - mode ('internet' | 'local')
//   - host address "ip:port" (local mode only — guests connect directly to it)
//
// Encoded as URL-safe base64 of a compact JSON, prefixed "PS1-" for versioning.
// The host generates it after creating a room; a guest pastes it to auto-join.
//
//   Internet room "worldcup-final"          -> PS1-eyJ2Ijox...
//   Local room on 192.168.1.20:49737        -> PS1-eyJ2IjoxLC...
// -----------------------------------------------------------------------------

const PREFIX = 'PS1-'

function b64urlEncode(str) {
  // btoa is available in the renderer (browser env).
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return decodeURIComponent(escape(atob(s)))
}

/**
 * Build a join code from room details.
 * @param {{room:string, mode:string, host?:string}} info
 *   host = "ip:port" (required for local mode)
 */
export function encodeJoinCode({ room, mode, host }) {
  const payload = { v: 1, r: room, m: mode === 'local' ? 'l' : 'i' }
  if (mode === 'local' && host) payload.h = host
  return PREFIX + b64urlEncode(JSON.stringify(payload))
}

/**
 * Decode a join code back into { room, mode, host }. Throws on bad codes.
 */
export function decodeJoinCode(code) {
  const c = String(code).trim()
  if (!c.startsWith(PREFIX)) throw new Error('not a PitchSide join code')
  let payload
  try {
    payload = JSON.parse(b64urlDecode(c.slice(PREFIX.length)))
  } catch {
    throw new Error('invalid join code')
  }
  if (!payload || !payload.r) throw new Error('invalid join code')
  const mode = payload.m === 'l' ? 'local' : 'internet'
  return {
    room: payload.r,
    mode,
    host: mode === 'local' ? payload.h || null : null
  }
}
