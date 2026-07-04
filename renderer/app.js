// renderer/app.js
// -----------------------------------------------------------------------------
// PitchSide renderer (UI). Talks to the Bare worker (workers/pitchside.js) over
// the Pear v2 bridge using a small JSON protocol. The worker owns P2P + QVAC;
// this file owns the DOM and forwards user intent.
// -----------------------------------------------------------------------------

import { FeedView } from './ui/feed-view.js'
import { ChatView } from './ui/chat-view.js'
import { AiPanel } from './ui/ai-panel.js'
import { fetchTodaysMatches, fetchMatch, matchLabel, newGoalEvents, statusEvent, matchIntroEvent } from './live-data.js'
import { encodeJoinCode, decodeJoinCode } from './join-code.js'
import { BettingPanel, formatUsdt } from './ui/betting-panel.js'
import { BetCards } from './ui/bet-cards.js'
import {
  Wallet, hasStoredSeed, generateSeed, loadStoredSeed
} from './wallet.bundle.js' // bundled (WDK/ethers/bip39) for the sandboxed renderer
import DEPLOYMENT from './contract/deployment.js'

const bridge = window.bridge
const decoder = new TextDecoder('utf-8')
const WORKER = '/workers/pitchside.js'
const $ = (id) => document.getElementById(id)

// --- worker messaging --------------------------------------------------------
function toWorker (obj) {
  // Newline-delimit so the worker can split coalesced frames.
  bridge.writeWorkerIPC(WORKER, JSON.stringify(obj) + '\n')
}

let onMessage = () => {}
// Set by setupBetting so onMessage can apply host 'bet-hide' tombstones.
let _betCards = null
// Pending AI betting requests (odds/outcome), keyed by a correlation id, so the
// worker's async JSON replies resolve the right promise.
const _pendingAi = new Map()
let _aiReqId = 0
function askWorkerAi (cmd, payload) {
  const id = ++_aiReqId
  return new Promise((resolve, reject) => {
    _pendingAi.set(id, { resolve, reject })
    toWorker({ cmd, id, ...payload })
    // Safety timeout so a stuck request doesn't hang the UI forever.
    setTimeout(() => {
      if (_pendingAi.has(id)) { _pendingAi.delete(id); reject(new Error('AI timed out')) }
    }, 60000)
  })
}
let _rxBuf = ''
bridge.onWorkerIPC(WORKER, (data) => {
  _rxBuf += decoder.decode(data)
  let idx
  while ((idx = _rxBuf.indexOf('\n')) !== -1) {
    const line = _rxBuf.slice(0, idx)
    _rxBuf = _rxBuf.slice(idx + 1)
    if (!line.trim()) continue
    try { onMessage(JSON.parse(line)) } catch { /* skip malformed */ }
  }
})
bridge.onWorkerStderr(WORKER, (data) => console.error('[worker]', decoder.decode(data)))
bridge.onWorkerStdout(WORKER, (data) => console.log('[worker]', decoder.decode(data)))

// Start our backend worker.
bridge.startWorker(WORKER)

// --- connection mode UI ------------------------------------------------------
// The "host's local address" field only makes sense for a GUEST joining a LOCAL
// network — a local host generates the address; a guest needs to enter it.
function updateModeUI () {
  const local = $('mode').value === 'local'
  const guest = !$('isHost').checked
  $('bootstrapRow').classList.toggle('hidden', !(local && guest))
}
$('mode').addEventListener('change', updateModeUI)
$('isHost').addEventListener('change', updateModeUI)
updateModeUI()

// --- join code: a guest pastes a code to auto-fill room + mode + host ---------
$('applyCode').addEventListener('click', () => {
  const raw = $('joinCode').value.trim()
  if (!raw) return
  try {
    const info = decodeJoinCode(raw)
    $('roomName').value = info.room
    $('mode').value = info.mode
    $('isHost').checked = false // joining via a code = you're a guest
    if (info.mode === 'local' && info.host) $('bootstrap').value = info.host
    updateModeUI()
    $('fatal').textContent = '' // clear any prior error
    $('fatal').style.color = 'var(--accent)'
    $('fatal').textContent = `Code applied — joining "${info.room}" (${info.mode}). Set your nickname and Join.`
  } catch (err) {
    $('fatal').style.color = ''
    $('fatal').textContent = err.message
  }
})

// --- join flow ---------------------------------------------------------------
$('joinBtn').addEventListener('click', () => start())

function start () {
  const nickname = $('nickname').value.trim() || 'guest'
  const roomName = $('roomName').value.trim() || 'worldcup-final'
  const persona = $('persona').value
  const isHost = $('isHost').checked
  const mode = $('mode').value
  const bootstrap = $('bootstrap').value.trim()

  $('lobby').classList.add('hidden')
  $('stage').classList.remove('hidden')
  const modeTag = mode === 'local' ? ' · local' : ' · internet'
  $('roomLabel').textContent = `#${roomName}${isHost ? ' · host' : ' · guest'}${modeTag}`

  // Build + show the invite code guests can use to join this exact room.
  // - internet: room + mode is enough (DHT discovery).
  // - local: include the host's LAN IP:port so guests connect directly.
  let hostAddr = null
  if (mode === 'local' && isHost) {
    const ip = (window.bridge.lanIp && window.bridge.lanIp()) || null
    hostAddr = ip ? `${ip}:49737` : null
  } else if (mode === 'local' && !isHost) {
    hostAddr = bootstrap // guest already knows the host address
  }
  const joinCode = encodeJoinCode({ room: roomName, mode, host: hostAddr })
  $('shareCode').textContent = joinCode
  $('shareBar').classList.remove('hidden')
  if (mode === 'local' && isHost && !hostAddr) {
    $('copyMsg').textContent = '(could not detect LAN IP — guests must enter it manually)'
  }
  $('copyCode').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(joinCode); $('copyMsg').textContent = 'copied!' }
    catch { $('copyMsg').textContent = 'copy failed — select the code manually' }
    setTimeout(() => { $('copyMsg').textContent = '' }, 2000)
  })

  // Host can delete any feed/chat item: sends a 'delete' tombstone the worker
  // appends to the (host-only) feed, which every peer applies to hide the item.
  const deleteItem = (seq) => toWorker({ cmd: 'delete', targetSeq: seq })
  const feedView = new FeedView($('feed'), { isHost, onDelete: deleteItem })
  const chatView = new ChatView($('chatList'), $('chatInput'), $('chatSend'), { isHost, onDelete: deleteItem })
  const aiPanel = new AiPanel({
    input: $('aiInput'), ask: $('aiAsk'), answer: $('aiAnswer'), status: $('aiStatus')
  })

  // Worker -> UI
  onMessage = (msg) => {
    switch (msg.type) {
      case 'event':
        // Host 'bet-hide' tombstone: drop the bet card for every peer.
        if (msg.event && msg.event.kind === 'bet-hide') {
          const id = msg.event.data && msg.event.data.betId
          if (id != null && _betCards) _betCards.hide(id)
          break
        }
        feedView.render(msg.event)
        chatView.render(msg.event)
        // Keep a short rolling feed so betting AI can ground odds/outcome on
        // the real match (match events only; skip chat/reactions).
        if (msg.event && msg.event.kind === 'match') {
          if (!window.__pitchsideFeed) window.__pitchsideFeed = []
          window.__pitchsideFeed.push({ type: msg.event.data?.type, data: msg.event.data })
          if (window.__pitchsideFeed.length > 20) window.__pitchsideFeed.shift()
        }
        break
      case 'peers':
        $('peerCount').textContent = `${msg.count} peer${msg.count === 1 ? '' : 's'}`
        break
      case 'ai':
        aiPanel.setStatus(msg.status)
        updateAiUi(msg.status, msg.reason)
        break
      case 'ai-progress':
        updateAiProgress(msg.pct)
        break
      case 'answer':
        aiPanel.showAnswer(msg.text)
        break
      case 'bet-odds':
      case 'bet-outcome': {
        const p = _pendingAi.get(msg.id)
        if (p) {
          _pendingAi.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error))
          else p.resolve(msg)
        }
        break
      }
      case 'local-address':
        // Local-network host: show the address guests must enter to join offline.
        showLocalAddress(msg.address)
        break
      case 'commentary-skip':
        // Why the AI didn't commentate a match event (e.g. model not downloaded).
        feedView.render({ kind: 'system', author: 'ai', at: Date.now(), data: { text: '🎙 AI skipped: ' + msg.reason } })
        break
      case 'error':
        console.error('worker error:', msg.message)
        break
    }
  }

  // Show the local-network host the info guests need to connect over the LAN.
  function showLocalAddress (address) {
    const port = address.split(':')[1]
    feedView.render({
      kind: 'system', author: 'net', at: Date.now(),
      data: { text: `📶 Local network ready on port ${port}. Guests on the same WiFi: choose "Local network", uncheck Host, and enter  <your-LAN-IP>:${port}  (find your IP in system/WiFi settings).` }
    })
  }

  // AI download button + progress UI
  const dlBtn = $('aiDownload')
  const track = $('aiProgressTrack')
  const fill = $('aiProgressFill')
  dlBtn.addEventListener('click', () => {
    dlBtn.disabled = true
    dlBtn.textContent = 'starting download…'
    toWorker({ cmd: 'download-model' })
  })

  function updateAiProgress (pct) {
    track.classList.remove('hidden')
    if (pct != null) {
      fill.style.width = pct + '%'
      dlBtn.textContent = `downloading… ${pct}%`
    } else {
      dlBtn.textContent = 'downloading…'
    }
  }

  function updateAiUi (status, reason) {
    if (status === 'ready') {
      $('aiDownloadRow').classList.add('hidden')
      $('aiInput').disabled = false
      $('aiInput').placeholder = 'was that offside?'
      $('aiAsk').disabled = false
      $('aiAnswer').textContent = 'model ready — ask anything, answered on this device.'
    } else if (status === 'downloading') {
      dlBtn.disabled = true
      track.classList.remove('hidden')
    } else if (status === 'loading') {
      // Model is cached — loading it from disk (no download).
      dlBtn.disabled = true
      dlBtn.textContent = 'loading cached model…'
    } else { // offline
      dlBtn.disabled = false
      dlBtn.textContent = '⬇ download on-device AI model (~773MB)'
      if (reason) $('aiAnswer').textContent = 'last attempt failed: ' + reason
    }
  }

  // UI -> worker
  aiPanel.onAsk((question) => { aiPanel.showThinking(); toWorker({ cmd: 'ask', question }) })

  if (isHost) {
    chatView.onSend((text) => toWorker({ cmd: 'chat', text }))
    $('reactHype').addEventListener('click', () => toWorker({ cmd: 'react', emoji: '🔥' }))
    $('reactShock').addEventListener('click', () => toWorker({ cmd: 'react', emoji: '😱' }))
    bindMatchButtons()
    setupLiveData()
  } else {
    // Guests can't post events, so the live-data panel + controls are host-only.
    $('livePanel')?.remove()
    for (const id of ['chatInput', 'chatSend', 'reactHype', 'reactShock',
      'evtGoal', 'evtCard', 'evtKick', 'evtCustom', 'minuteInput', 'customEvent']) {
      const node = $(id); if (node) node.disabled = true
    }
  }

  // --- on-chain betting (WDK / Wallets track) --------------------------------
  // Online-only: it needs a live chain. In local/offline mode we hide the panel
  // entirely so the offline watch-party stays bet-free (per BETTING-PLAN.md).
  setupBetting({ isHost, online: mode !== 'local' })

  // --- live real-match data (host only) --------------------------------------
  // Fetch real matches from football-data.org, then "follow" one: poll it and
  // auto-post new goals/kickoff/full-time as events. The on-device LLM
  // commentates the REAL match. Internet is used only for the DATA, not the AI.
  function setupLiveData () {
    const seenGoals = new Set()
    let followTimer = null
    let followId = null
    let prevStatus = null
    const setLiveStatus = (t) => { $('liveStatus').textContent = t }

    $('liveFetch').addEventListener('click', async () => {
      const key = $('apiKey').value.trim()
      setLiveStatus('loading today\'s matches…')
      try {
        const matches = await fetchTodaysMatches(key)
        const sel = $('liveMatches')
        sel.innerHTML = '<option value="">— select a match —</option>'
        for (const m of matches) {
          const opt = document.createElement('option')
          opt.value = m.id
          opt.textContent = matchLabel(m)
          sel.appendChild(opt)
        }
        setLiveStatus(matches.length ? `${matches.length} matches today. Pick one, then Follow.` : 'no matches today.')
      } catch (err) { setLiveStatus('error: ' + err.message) }
    })

    $('liveMatches').addEventListener('change', () => {
      $('liveFollow').disabled = !$('liveMatches').value
    })

    $('liveFollow').addEventListener('click', () => {
      const key = $('apiKey').value.trim()
      followId = Number($('liveMatches').value)
      if (!followId) return
      $('liveFollow').classList.add('hidden')
      $('liveStop').classList.remove('hidden')

      let firstPoll = true
      const tick = async () => {
        try {
          const m = await fetchMatch(key, followId)
          if (firstPoll) {
            firstPoll = false
            // IMMEDIATE intro so the AI comments the moment you follow — sets the
            // scene from the current state, not waiting for the next goal.
            prevStatus = m.status // don't also fire a duplicate kickoff for the same state
            toWorker({ cmd: 'match', event: matchIntroEvent(m) })
            // Seed already-happened goals so we don't re-post them, but the intro
            // above already summarized them for the AI.
            newGoalEvents(m, seenGoals)
          } else {
            const se = statusEvent(m, prevStatus); prevStatus = m.status
            if (se) toWorker({ cmd: 'match', event: se })
            for (const ev of newGoalEvents(m, seenGoals)) toWorker({ cmd: 'match', event: ev })
          }
          setLiveStatus(`following: ${matchLabel(m)}`)
          if (m.status === 'FINISHED') stopFollow()
        } catch (err) { setLiveStatus('poll error: ' + err.message) }
      }
      tick()
      followTimer = setInterval(tick, 30000) // football-data free tier: be gentle
    })

    function stopFollow () {
      if (followTimer) clearInterval(followTimer); followTimer = null
      $('liveStop').classList.add('hidden')
      $('liveFollow').classList.remove('hidden')
    }
    $('liveStop').addEventListener('click', stopFollow)
  }

  // Exit back to the lobby: tell the worker to leave the room (closes the P2P
  // swarm/feed), then reload the renderer for a clean state — avoids stale views
  // and stacked event listeners from a previous session.
  $('exitBtn').addEventListener('click', () => {
    toWorker({ cmd: 'leave' })
    setTimeout(() => window.location.reload(), 150)
  })

  // Tell the worker to join.
  toWorker({ cmd: 'join', room: roomName, nickname, host: isHost, persona, mode, bootstrap })
}

// --- betting wiring ----------------------------------------------------------
// Builds the BettingPanel and connects its callbacks to WDK (renderer/wallet.js)
// for on-chain escrow calls and to the worker for on-device AI odds/outcome.
function setupBetting ({ isHost, online }) {
  const panelEl = $('bettingPanel')
  const body = $('bettingBody')
  if (!panelEl || !body) return

  // The panel is ALWAYS shown (any mode, any phase). Betting still needs a
  // reachable chain to actually transact, so when there's no deployment we
  // render the panel with a clear banner instead of hiding it; the wallet
  // actions surface a helpful error rather than silently failing.
  const noChain = !DEPLOYMENT || !DEPLOYMENT.bets
  if (noChain) {
    const note = document.createElement('p')
    note.className = 'hint'
    note.innerHTML =
      '⚠ No betting contract configured yet. Start a chain + deploy ' +
      '(<code>npx hardhat run scripts/deploy.js --network localhost</code> in ' +
      '<code>contracts/</code>), then restart the app. The panel below is inactive until then.'
    body.appendChild(note)
  }
  if (!online) {
    const note = document.createElement('p')
    note.className = 'hint'
    note.textContent =
      'ℹ You are in offline/local P2P mode. Betting transactions need network access ' +
      'to the chain RPC; the watch-party itself stays fully offline.'
    body.appendChild(note)
  }

  // With no deployment we can't build a Wallet (it needs contract addresses).
  // Still render the panel so it's visible; wire a stub that explains why.
  if (noChain) {
    const panel = new BettingPanel(body, { isHost })
    const nope = async () => { throw new Error('no betting contract configured — deploy first, then restart') }
    panel
      .on('connect', nope).on('createWallet', nope).on('refreshBalance', nope)
      .on('createBet', nope).on('join', nope).on('odds', nope).on('propose', nope)
      .on('confirm', nope).on('claim', nope).on('cancel', nope).on('refund', nope)
      .on('refreshBet', nope).on('faucetGas', nope).on('faucetUsdt', nope)
      .on('revealSeed', () => null).on('isLocalTestnet', () => false)
    return
  }

  const wallet = new Wallet({ deployment: DEPLOYMENT })
  // Panel = wallet + faucet + (host) create-bet form. Bet CARDS render in chat.
  const panel = new BettingPanel(body, { isHost })
  // Bet cards live in the fan-chat feed, discovered from chain (any peer's bet).
  const betCards = new BetCards($('chatList'), { getAddress: () => wallet.address, isHost })
  _betCards = betCards // expose for onMessage's bet-hide handling

  // Helper: build grounding context for the AI from recent match feed events.
  const matchContext = () =>
    (window.__pitchsideFeed || []).slice(-8)
      .map((e) => '- ' + (e.data?.text || e.type || '')).join('\n')

  let stopWatch = null
  const startWatching = () => {
    if (stopWatch) return
    // Poll the chain; render/update bet cards in chat as bets appear/change.
    stopWatch = wallet.watchBets((cards) => betCards.sync(cards))
  }

  // Fetch a hydrated bet card straight from chain (labels packed on-chain).
  const refreshBet = (betId) => wallet.getBetCard(betId)

  // Wallet panel: connection, balance, faucet, seed, and the create form.
  panel
    .on('connect', async () => {
      if (!hasStoredSeed()) throw new Error('no wallet yet — use "Create new wallet"')
      const address = await wallet.connect()
      startWatching()
      return { address }
    })
    .on('createWallet', async () => {
      const seed = generateSeed()
      const address = await wallet.connect()
      startWatching()
      return { address, seed }
    })
    .on('refreshBalance', async () => ({
      usdt: await wallet.getUsdtBalance(),
      native: await wallet.getNativeBalance()
    }))
    .on('createBet', async ({ question, outcomes, closesInMin }) => {
      const closesAt = Math.floor(Date.now() / 1000) + closesInMin * 60
      // Labels are packed on-chain, so every peer's chat renders the same card.
      const { betId } = await wallet.createBet({
        matchRef: $('roomLabel').textContent || 'match',
        question, outcomes, closesAt
      })
      // Show it in chat immediately (don't wait for the next poll).
      betCards.upsert(await wallet.getBetCard(betId))
      return { betId }
    })
    .on('revealSeed', () => loadStoredSeed())
    .on('faucetGas', () => wallet.faucetGas())
    .on('faucetUsdt', () => wallet.faucetUsdt())
    .on('isLocalTestnet', () => wallet.isLocalTestnet)

  // Bet cards in chat: join / AI odds / host decide-confirm / claim / refund.
  betCards
    .on('join', async ({ betId, outcome, amount }) => {
      await wallet.approveUsdt(amount)
      await wallet.joinBet({ betId, outcome, amount })
      await panel.refreshBalance()
    })
    .on('odds', async ({ question, outcomes }) => {
      const res = await askWorkerAi('bet-odds', { question, outcomes, context: matchContext() })
      return { probabilities: res.probabilities, rationale: res.rationale }
    })
    .on('propose', async ({ betId, question, outcomes }) => {
      const res = await askWorkerAi('bet-outcome', { question, outcomes, context: matchContext() })
      if (res.outcome == null) throw new Error('AI could not decide — resolve manually')
      await wallet.proposeResult({ betId, outcome: res.outcome, disputeWindow: 0 })
    })
    .on('confirm', async (betId) => { await wallet.confirmResult(betId); await panel.refreshBalance() })
    .on('claim', async (betId) => { await wallet.claim(betId); await panel.refreshBalance() })
    .on('cancel', (betId) => wallet.cancelBet(betId))
    .on('refund', async (betId) => { await wallet.refund(betId); await panel.refreshBalance() })
    .on('refreshBet', refreshBet)
    .on('hostDelete', async (betId) => {
      // Try to cancel on-chain (only works if THIS wallet owns the bet and it's
      // not resolved). Then broadcast a hide so the card disappears for all peers.
      let cancelErr = null
      try {
        const b = await wallet.getBet(betId)
        const ownsIt = wallet.address && b.host &&
          wallet.address.toLowerCase() === b.host.toLowerCase()
        if (ownsIt && (b.status === 'Open' || b.status === 'Proposed')) {
          await wallet.cancelBet(betId)
          await panel.refreshBalance()
        } else if (!ownsIt) {
          cancelErr = new Error("you don't own this bet")
        } else {
          cancelErr = new Error(`bet is ${b.status}`)
        }
      } catch (err) { cancelErr = err }
      // Broadcast the hide regardless (moderation). Host-only feed enforces auth.
      toWorker({ cmd: 'bet-hide', betId })
      if (cancelErr) throw cancelErr // surfaced by the card as "hide, cancel skipped"
    })
    .on('say', (text, isError) => panel._say(text, isError))
}

// Outcome labels are client-side (the contract stores only the outcome count).
const betLabels = new Map()

function bindMatchButtons () {
  const minute = () => Number($('minuteInput').value) || undefined
  $('evtGoal').addEventListener('click', () =>
    toWorker({ cmd: 'match', event: { type: 'goal', minute: minute(), text: `GOAL! (${minute() ?? '?'}')` } }))
  $('evtCard').addEventListener('click', () =>
    toWorker({ cmd: 'match', event: { type: 'card', minute: minute(), text: `Yellow card (${minute() ?? '?'}')` } }))
  $('evtKick').addEventListener('click', () =>
    toWorker({ cmd: 'match', event: { type: 'kickoff', minute: 0, text: 'Kick-off! The match is underway.' } }))
  $('evtCustom').addEventListener('click', () => {
    const text = $('customEvent').value.trim()
    if (!text) return
    toWorker({ cmd: 'match', event: { type: 'custom', minute: minute(), text } })
    $('customEvent').value = ''
  })
}
