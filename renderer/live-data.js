// renderer/live-data.js
// -----------------------------------------------------------------------------
// OPTIONAL live-data source: fetch today's real football matches from
// football-data.org (over HTTPS, in the Electron renderer) and turn them into
// match events the app already understands. The on-device LLM then commentates
// REAL current matches — data comes from the internet, but inference stays 100%
// on-device (no cloud AI).
//
// This is separate from the offline watch-party: it needs internet + a free API
// key (https://www.football-data.org/client/register). The app works fully
// offline without it.
// -----------------------------------------------------------------------------

const API_BASE = 'https://api.football-data.org/v4'

function todayISO () {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}

// Fetch today's matches. Returns a normalized list, or throws with a clear msg.
export async function fetchTodaysMatches (apiKey) {
  if (!apiKey) throw new Error('a football-data.org API key is required')
  const res = await fetch(`${API_BASE}/matches?date=${todayISO()}`, {
    headers: { 'X-Auth-Token': apiKey }
  })
  if (res.status === 403 || res.status === 401) throw new Error('invalid API key')
  if (res.status === 429) throw new Error('rate limited — try again in a minute')
  if (!res.ok) throw new Error(`API error ${res.status}`)
  const data = await res.json()
  return (data.matches || []).map(normalizeMatch)
}

// Fetch a single match's current state (for polling a followed match).
export async function fetchMatch (apiKey, id) {
  const res = await fetch(`${API_BASE}/matches/${id}`, { headers: { 'X-Auth-Token': apiKey } })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return normalizeMatch(await res.json())
}

function normalizeMatch (m) {
  return {
    id: m.id,
    status: m.status,                                   // SCHEDULED | IN_PLAY | PAUSED | FINISHED | ...
    minute: m.minute ?? null,
    home: m.homeTeam?.name || m.homeTeam?.shortName || 'Home',
    away: m.awayTeam?.name || m.awayTeam?.shortName || 'Away',
    scoreHome: m.score?.fullTime?.home ?? 0,
    scoreAway: m.score?.fullTime?.away ?? 0,
    utcDate: m.utcDate,
    goals: Array.isArray(m.goals) ? m.goals.map((g) => ({
      minute: g.minute,
      type: g.type,                                     // REGULAR | PENALTY | OWN | ...
      team: g.team?.name,
      scorer: g.scorer?.name,
      home: g.score?.home, away: g.score?.away
    })) : []
  }
}

// A short label for a match, e.g. "Arsenal 2 - 1 Chelsea (IN_PLAY 67')".
export function matchLabel (m) {
  const min = m.minute != null ? ` ${m.minute}'` : ''
  const live = m.status === 'IN_PLAY' || m.status === 'PAUSED' ? ` · LIVE${min}` : ` · ${m.status}`
  return `${m.home} ${m.scoreHome}–${m.scoreAway} ${m.away}${live}`
}

// Turn a match's goals into feed match-events. Given the set of goal keys we've
// already posted, returns only the NEW ones (so polling doesn't duplicate).
export function newGoalEvents (m, seenKeys) {
  const events = []
  for (const g of m.goals) {
    const key = `${m.id}:${g.minute}:${g.scorer || ''}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const pen = g.type === 'PENALTY' ? ' (pen)' : g.type === 'OWN' ? ' (o.g.)' : ''
    events.push({
      type: 'goal',
      minute: g.minute,
      text: `⚽ GOAL — ${g.scorer || 'unknown'}${pen} for ${g.team}. ${m.home} ${g.home}–${g.away} ${m.away} (${m.minute ?? g.minute}')`
    })
  }
  return events
}

// Kickoff / final-whistle status transitions -> events.
export function statusEvent (m, prevStatus) {
  if (prevStatus === m.status) return null
  if (m.status === 'IN_PLAY' && prevStatus !== 'PAUSED') {
    return { type: 'kickoff', minute: 0, text: `Kick-off! ${m.home} vs ${m.away} is underway.` }
  }
  if (m.status === 'FINISHED') {
    return { type: 'fulltime', minute: 90, text: `Full time: ${m.home} ${m.scoreHome}–${m.scoreAway} ${m.away}.` }
  }
  return null
}

// An opening "set the scene" event fired the moment a match is followed, so the
// AI immediately says something about it — describing the current state instead
// of waiting for the next goal. Includes score, minute, status, and any goals
// so far so the commentary is grounded in what's actually happening.
export function matchIntroEvent (m) {
  const goalsSummary = m.goals && m.goals.length
    ? ' Goals so far: ' + m.goals.map((g) => `${g.scorer || '?'} ${g.minute}'`).join(', ') + '.'
    : ''
  let situation
  if (m.status === 'IN_PLAY' || m.status === 'PAUSED') {
    situation = `LIVE at ${m.minute ?? '?'}': ${m.home} ${m.scoreHome}–${m.scoreAway} ${m.away}.`
  } else if (m.status === 'FINISHED') {
    situation = `Just finished: ${m.home} ${m.scoreHome}–${m.scoreAway} ${m.away}.`
  } else {
    const kickoff = m.utcDate ? new Date(m.utcDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    situation = `Upcoming (${m.status}${kickoff ? ', kickoff ' + kickoff : ''}): ${m.home} vs ${m.away}.`
  }
  return {
    type: 'intro',
    minute: m.minute ?? 0,
    text: `Now following: ${m.home} vs ${m.away}. ${situation}${goalsSummary} Set the scene and tell us what's happening.`
  }
}
