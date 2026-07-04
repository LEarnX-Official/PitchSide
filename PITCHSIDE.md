# PitchSide (Pear v2 build) 🏟️

Offline, P2P AI football watch-party — migrated to the **Pear v2** runtime model
(`pear-runtime` embedded in Electron, backend logic in a Bare worker).

This is the runnable v2 port of the original `../pitchside/` project, created because
Pear v2 removed the v1 HTML-entrypoint desktop model (`ERR_LEGACY`).

## Architecture (v2)

```
 renderer/ (UI, Chromium)                 workers/ (Bare runtime)
 ┌──────────────────────┐   window.bridge  ┌───────────────────────────┐
 │ index.html           │   (preload IPC)  │ pitchside.js              │
 │ app.js  ────────────▶│◀────────────────▶│  ├─ lib/room.js  (P2P)    │
 │ ui/feed|chat|ai-panel│   JSON messages  │  ├─ lib/feed.js  (Hypercore)
 └──────────────────────┘                  │  └─ lib/qvac.js  (@qvac/bare-sdk)
        electron/main.js  ── PearRuntime.run ──┘
```

- **Renderer** owns the DOM (our ported UI views) and sends/receives JSON over the
  Pear bridge.
- **Bare worker** owns the P2P mesh (Hyperswarm + shared-key Hypercore) and on-device
  AI (`@qvac/bare-sdk`). Same verified logic as the original, ported to CommonJS with
  injected deps so it runs under Bare.

### JSON protocol

Renderer → worker: `{cmd:'join'|'match'|'chat'|'react'|'ask', ...}`
Worker → renderer: `{type:'event'|'peers'|'ai'|'answer'|'error', ...}`

## Run

```bash
cd pitchside-v2
npm install
npm start            # launches the Electron + Pear v2 app
```

The `upgrade` key in package.json was generated with `pear touch` (required by
electron-forge). Regenerate your own with `pear touch` if forking.

## Verification status (what was actually run)

- ✅ **Boilerplate baseline** launches under Pear v2 (Electron window created).
- ✅ **Ported worker P2P** — two-peer host/guest sync **verified end-to-end under Node**:
  guest receives every host match event over the live DHT, no server. (Same result as
  the original project; the CommonJS port with injected deps behaves identically.)
- ✅ **Worker JSON protocol** — `join → match → event`, `ask → answer`, and AI status
  transitions all verified via a headless harness (`PROTOCOL_OK`).
- ✅ **`@qvac/bare-sdk` installs** and exposes `loadModel`/`completion`/`unloadModel`
  matching our AI layer.
- ⚠️ **Live QVAC inference** — runs only inside the Bare worker of the launched app;
  under plain Node the AI correctly reports `offline` (bare-sdk needs the Bare runtime).
  Exercising real inference requires interacting with the running GUI (DevTools console),
  which wasn't captured headlessly here.
- ⚠️ **Full GUI interaction** — the Electron app boots (processes spawn, no crash), but
  clicking through the live window (goal → commentary on screen) needs a human at the
  display; runtime renderer/worker logs go to DevTools, not the terminal.

## What to demo

Host machine: check "Host", Join, click ⚽ Goal → the event (and, with the model loaded,
AI commentary) appears. Second machine: uncheck "Host", same room name, Join → receives
the live feed. Turn off internet first for the money shot.
