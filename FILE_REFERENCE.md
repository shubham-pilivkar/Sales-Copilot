# File Reference

Per-file documentation for the Sales Copilot Chrome extension. For the high-level overview, architecture diagram, and setup, see [README.md](README.md).

Each entry lists the file's **purpose**, its **key exports / functions**, and **notes** (constraints, gotchas, cross-references).

## Contents

- [Root configuration](#root-configuration)
  - [manifest.json](#manifestjson)
  - [vite.config.js](#viteconfigjs)
  - [tsconfig.json](#tsconfigjson)
  - [package.json](#packagejson)
- [src/ — shared](#src--shared)
  - [src/constants.ts](#srcconstantsts)
  - [src/constants.test.ts](#srcconstantstestts)
- [src/background/](#srcbackground)
  - [src/background/service-worker.ts](#srcbackgroundservice-workerts)
- [src/offscreen/](#srcoffscreen)
  - [src/offscreen/offscreen.ts](#srcoffscreenoffscreents)
  - [src/offscreen/offscreen.html](#srcoffscreenoffscreenhtml)
- [src/content/](#srccontent)
  - [src/content/meet-copilot.ts](#srccontentmeet-copilotts)
- [src/popup/](#srcpopup)
  - [src/popup/popup.ts](#srcpopuppopupts)
  - [src/popup/popup.html](#srcpopuppopuphtml)
- [src/permission/](#srcpermission)
  - [src/permission/consent.ts](#srcpermissionconsentts)
  - [src/permission/consent.html](#srcpermissionconsenthtml)
- [src/lib/](#srclib)
  - [src/lib/api-client.ts](#srclibapi-clientts)
  - [src/lib/copilot-ws-client.ts](#srclibcopilot-ws-clientts)
  - [src/lib/messaging.ts](#srclibmessagingts)
  - [src/lib/error-messages.ts](#srcliberror-messagests)
  - [src/lib/error-messages.test.ts](#srcliberror-messagestestts)
- [src/types/](#srctypes)
  - [src/types/api.ts](#srctypesapits)
  - [src/types/messages.ts](#srctypesmessagests)
  - [src/types/ws.ts](#srctypeswsts)
- [public/](#public)
  - [public/audio-worklet.js](#publicaudio-workletjs)
- [scripts/](#scripts)
  - [scripts/generate-icons.js](#scriptsgenerate-iconsjs)

---

## Root configuration

### [manifest.json](manifest.json)

**Purpose** — Manifest V3 declaration for the extension.

**Key contents**
- `permissions`: `tabCapture`, `activeTab`, `storage`, `offscreen`, `tabs`, `scripting`, `alarms`.
- `host_permissions`: `meet.google.com`, `localhost`, and `test-api.meetminutes.in`.
- `background.service_worker`: module service worker (built to `service-worker-loader.js`).
- `action.default_popup`: the toolbar popup (`src/popup/popup.html`).
- `content_scripts`: injects the content script on `https://meet.google.com/*` at `document_idle`.
- `web_accessible_resources`: offscreen/consent pages, the audio worklet, and shared chunks, exposed to the Meet origin.
- `content_security_policy`: restricts `connect-src` to the API host (`https`/`wss`) and `localhost`.

**Notes** — crxjs rewrites HTML/asset paths during build; the version of this file in `dist/` differs from source.

### [vite.config.js](vite.config.js)

**Purpose** — Vite build config using `@crxjs/vite-plugin`.

**Key contents** — Registers the manifest with `crx()` and declares the HTML entry points that crxjs must compile: `offscreen.html` **and** `consent.html`.

**Notes** — `consent.html` **must** be listed here. crxjs auto-detects HTML referenced from the manifest (popup), but pages referenced only via `web_accessible_resources` / `getURL()` (the consent page) are not compiled unless added as explicit inputs.

### [tsconfig.json](tsconfig.json)

**Purpose** — TypeScript config, typecheck-only (`noEmit`).

**Key contents** — `strict: true`, `module: ESNext`, `moduleResolution: bundler`, `types: ["chrome"]`, `verbatimModuleSyntax`, `resolveJsonModule`.

**Notes** — esbuild (via Vite/crxjs) does the actual transpile; `tsc` is used only for type-checking.

### [package.json](package.json)

**Purpose** — npm metadata and scripts.

**Scripts** — `prebuild` (icons), `dev`, `build`, `typecheck`, `test`, `test:watch`. Dev deps: crxjs plugin, `@types/chrome`, TypeScript, Vite, Vitest.

---

## src/ — shared

### [src/constants.ts](src/constants.ts)

**Purpose** — Single source of truth for enums, the message/wire vocabulary, and defaults.

**Key exports**
- `CopilotState` — `IDLE | CONNECTING | ACTIVE | RECONNECTING | STOPPING | ERROR`.
- `NudgeType`, `NudgePriority`, `MeetingStage` — wire-value enums.
- `MessageType` — internal `chrome.runtime` message names (popup/SW/content/offscreen).
- `WSMessageType` — WebSocket frame types (upstream + downstream).
- `WS_RECONNECT_BACKOFFS_MS`, `WS_MAX_RECONNECT_ATTEMPTS`, `WS_PING_INTERVAL_MS`, `WS_PONG_TIMEOUT_MS` — WebSocket tuning.
- `StorageKey` — `chrome.storage` keys (auth token, consent, state, pending start, API base, etc.).
- `API_BASE_URL` — default backend (`https://test-api.meetminutes.in`).

**Notes** — Each enum is a frozen `as const` object plus a same-named exported type (value vs. type).

### [src/constants.test.ts](src/constants.test.ts)

**Purpose** — Vitest unit tests asserting enum values / wire-format stability.

---

## src/background/

### [src/background/service-worker.ts](src/background/service-worker.ts)

**Purpose** — The central coordinator: copilot state machine, REST calls, WebSocket client, audio routing, and lifecycle alarms.

**Responsibilities**
- **State machine** — `setState()` persists to `chrome.storage.session`, updates the toolbar badge (`ON`/`!`), and broadcasts `STATE_UPDATE`.
- **Start/stop** — `startCopilot()` checks consent (opens the consent window if missing), creates a backend session, and connects the WebSocket; `stopCopilot()` tears everything down with a force-stop alarm safety net.
- **Consent resume** — `AUDIO_CONSENT_GRANTED` records consent and resumes the pending start.
- **WS event wiring** — forwards `nudge`/`transcript`/`stage`/`talk_ratio`/`prospect_context`/`summary`/`error` to the meeting tab; refreshes the token on auth failure.
- **Offscreen management** — `ensureOffscreen()` / `closeOffscreen()`; `startAudioCapture()` obtains a `tabCapture` stream id and tells the offscreen doc to start.
- **Audio port** — receives base64 PCM from the offscreen doc, **decodes** it (`base64ToUint8Array`), prepends a 1-byte source tag (`SOURCE_MIC 0x01` / `SOURCE_TAB 0x02`), and sends binary to the backend.
- **Alarms** — offscreen heartbeat watchdog (restart on timeout) and force-stop timeout.
- **Auto-stop** — on meeting end or meeting-tab close.
- **State restore** — on SW wake, restores state from `chrome.storage.session` and reconnects the WebSocket if it was active.

**Notes** — Audio crosses the runtime port as **base64**, not a raw `ArrayBuffer` (see [audio-worklet.js](#publicaudio-workletjs) note and the README gotchas). Heartbeat interval is clamped to 1 min by `chrome.alarms` in packed builds.

---

## src/offscreen/

### [src/offscreen/offscreen.ts](src/offscreen/offscreen.ts)

**Purpose** — Captures tab + microphone audio and streams 16 kHz Int16 PCM to the service worker. An offscreen document is required because a service worker has no DOM/`getUserMedia`.

**Key functions**
- `startCapture(streamId)` — captures the tab (`chromeMediaSource: 'tab'`) and the mic (`getUserMedia({audio:true})`), builds the Web Audio graph, loads the worklet, opens the SW port, and wires both sources.
- `stopCapture()` — idempotent teardown of context, streams, and port.
- `arrayBufferToBase64()` — encodes PCM for the JSON-serialized runtime port.
- `trackLevel()` + heartbeat log — per-source chunk count and peak amplitude diagnostics.
- `startHeartbeat()` / `stopHeartbeat()` — 15 s `OFFSCREEN_READY` pings + heap watchdog + level log.

**Audio graph**
- **Tab**: one `MediaStreamSource` → `destination` (playback) **and** → worklet → silent gain (processing).
- **Mic**: `MediaStreamSource` → worklet → silent gain (processing only; no playback, to avoid echo).
- On a suspended `AudioContext`, attempts `resume()` and falls back to click-to-resume (`MONITOR_BLOCKED`).

**Notes** — Do **not** clone the tab stream into a separate `<audio>` element — that breaks the capture tap. The single-source dual-connect graph is deliberate (see README gotchas).

### [src/offscreen/offscreen.html](src/offscreen/offscreen.html)

**Purpose** — Host page for `offscreen.ts`. Contains an `<audio id="tab-monitor">` element (legacy; playback now goes through the Web Audio destination) and loads the compiled script. Declared as a Vite input so crxjs compiles it.

---

## src/content/

### [src/content/meet-copilot.ts](src/content/meet-copilot.ts)

**Purpose** — Runs inside `meet.google.com`: detects meetings, tracks mic/speaker state, and renders the nudge overlay.

**Meeting lifecycle**
- `isInMeeting()` / `checkMeeting()` — detect entering a call (URL + in-call DOM controls); polled every 2 s.
- Multi-locale, debounced end detection (`MEET_END_PATTERNS`, URL change, DOM-controls-gone) → `fireMeetingEnded()`.
- `syncCopilotState()` — queries `GET_STATE` on load and on meeting-detection so the overlay reappears if a session is already active (e.g. after a page refresh).

**Signals to the SW**
- `pollMicState()` — robust, localization-aware mic-mute detection → `MIC_MUTE_STATE`.
- `detectActiveSpeaker()` — caption-based with DOM-tile fallback → `SPEAKER_CHANGE`.

**Overlay (closed Shadow DOM)**
- `createOverlay()` / `removeOverlay()` / `ensureOverlay()` — build/tear-down; `ensureOverlay()` is the idempotent entry called from lifecycle/state/nudge/sync.
- `addNudge()`, `dismissNudge()`, `showProspectBrief()`, `updateTalkRatio()`, `updateStage()`, `updateStatus()`, `showOfflineBanner()` — render functions.
- `toggleMinimize()` — full panel ↔ pill with unread badge.
- `setupDrag()` / `setupResize()` — pointer-capture drag (header) and bottom-right resize; `pinTopLeft()` switches anchoring.
- `savePanelGeometry()` / `restorePanelGeometry()` — persist position/size to `chrome.storage.local` (`sc_panel_geometry`), clamped to the viewport on restore.

**Notes** — Content-script changes require reloading the open Meet tab. The overlay is created from several triggers so it appears reliably even if one message is missed.

---

## src/popup/

### [src/popup/popup.ts](src/popup/popup.ts)

**Purpose** — Toolbar popup: auth gate, copilot controls, and preferences.

**Key behavior**
- `init()` — shows auth or copilot section based on a stored token; refreshes state and preferences.
- Auth — login/register tabs → `LOGIN`/`REGISTER`.
- Controls — Start (validates prospect email + active Meet tab, sends `START_COPILOT` with `tab.id`), Stop (`STOP_COPILOT`), Logout.
- Preferences — renders per-nudge-type toggles + retention; debounced save (`UPDATE_PREFERENCES`) with last-write-wins sequencing.
- State — `renderState()` updates the status dot/bar; listens for `STATE_UPDATE` broadcasts.

### [src/popup/popup.html](src/popup/popup.html)

**Purpose** — Popup markup/styles. Element IDs map to the `els` lookup in `popup.ts` (auth fields, `start-btn`/`stop-btn`, `status-bar`, `nudge-prefs`, retention inputs). Auto-detected as a build entry via `action.default_popup`.

---

## src/permission/

### [src/permission/consent.ts](src/permission/consent.ts)

**Purpose** — Drives the audio-consent gate window.

**Key behavior**
- `requestMicPermission()` — calls `getUserMedia({audio:true})` to trigger Chrome's mic prompt from a visible page (the offscreen doc cannot prompt); releases tracks immediately.
- On **Allow**: requests mic, then sends `AUDIO_CONSENT_GRANTED`. If mic is denied, it pauses with an explanation and offers "Continue without microphone" (tab-only).
- `recordConsentAndStart()` — records consent in the SW and resumes the pending session start; closes the window on success.

**Notes** — Requesting the mic here is what makes the offscreen capture work later; the grant persists for the extension origin.

### [src/permission/consent.html](src/permission/consent.html)

**Purpose** — Consent UI (what's captured / what's not, Allow / Not Now buttons). Must be a Vite input ([vite.config.js](#viteconfigjs)) so its script is compiled and the buttons work.

---

## src/lib/

### [src/lib/api-client.ts](src/lib/api-client.ts)

**Purpose** — REST client for the backend.

**Key exports** — `login`, `register`, `logout`, `refreshToken`, `checkAudioConsent`, `recordAudioConsent`, `startCopilotSession`, `stopCopilotSession`, `enrichProspect`, `getPreferences`, `updatePreferences`, and the `AuthError` class.

**Internals** — `request()` injects `Authorization: Bearer` and, on `401`, performs **one** transparent `refreshToken()` + retry. `refreshToken()` is **single-flight** (shared promise) so concurrent REST/WS refreshes can't clobber each other. `requestWithTimeout()` aborts hung requests (default 10 s). Base URL resolves from `chrome.storage.local` (`sc_api_base`) → `API_BASE_URL`.

### [src/lib/copilot-ws-client.ts](src/lib/copilot-ws-client.ts)

**Purpose** — WebSocket client for the real-time channel.

**Key API** — `connect(url)`, `sendAudio(ArrayBuffer)` (binary upstream), `sendJSON(WSClientMessage)`, `close()`, `status`, and `on*` callbacks (`onNudge`, `onTranscript`, `onStageUpdate`, `onTalkRatio`, `onProspectContext`, `onQualification`, `onMeetingSummary`, `onError`, `onStatusChange`, `onSessionReady`).

**Internals** — ping/pong keepalive (`WS_PING_INTERVAL_MS` / `WS_PONG_TIMEOUT_MS`); reconnect with `WS_RECONNECT_BACKOFFS_MS` up to `WS_MAX_RECONNECT_ATTEMPTS`; auth rejection (`4001`) surfaces an error instead of reconnecting; `_routeMessage()` dispatches downstream frames to callbacks.

### [src/lib/messaging.ts](src/lib/messaging.ts)

**Purpose** — Typed wrapper over `chrome.runtime` messaging.

**Key exports**
- `sendMessage<T>(message)` — never throws; returns `{ ok, data?, error? }` (maps `no_receiver` / `channel_closed`).
- `onMessage(handlerMap)` — registers typed, discriminated-union handlers (keyed by `MessageType`); auto-wraps results in `{ ok, data }` and supports async responses; returns an unsubscribe fn.
- `sendToTab(tabId, message)` — `chrome.tabs.sendMessage`, never throws.

**Notes** — Filters out cross-extension senders. Underpins all popup/SW/content/offscreen communication.

### [src/lib/error-messages.ts](src/lib/error-messages.ts)

**Purpose** — Maps error codes to user-friendly text.

**Key exports** — `getErrorMessage(code)` and `renderError(error)` (prefers a mapped code, falls back to the raw message, then `unknown`). Covers auth, copilot lifecycle, audio, WebSocket, and STT errors.

### [src/lib/error-messages.test.ts](src/lib/error-messages.test.ts)

**Purpose** — Vitest tests for the error-message mapping / fallbacks.

---

## src/types/

### [src/types/api.ts](src/types/api.ts)

**Purpose** — REST request/response types.

**Key types** — `AuthUser`, `AuthResponse`, `LoginRequest`, `RegisterRequest`, `CreateSessionResponse` (`session_id`, `ws_url`), `NudgePreferences`, `Preferences` (`nudge_preferences`, `store_transcripts`, `store_nudges`, `retention_days`).

### [src/types/messages.ts](src/types/messages.ts)

**Purpose** — Discriminated union of every internal `chrome.runtime` message, keyed on `type`.

**Key types** — `CopilotStateSnapshot`; per-message variants (popup→SW commands, SW→popup/content broadcasts, SW→content render messages, content→SW events, offscreen↔SW); `ExtMessage` (the union), `ExtMessageType`, `MessageByType<K>` (narrowing helper), and `MessageResponse<T>` (the `{ ok, data?, error? }` envelope).

### [src/types/ws.ts](src/types/ws.ts)

**Purpose** — WebSocket protocol contract (mirrors the backend).

**Key types** — payloads `Nudge`, `TranscriptSegment`, `TalkRatio`, `ProspectProfile`, `MeetingSummary`, `QualificationScores`; `WSServerMessage` (downstream union) and `WSClientMessage` (upstream JSON union); `WSError`.

**Notes** — Audio is sent as **binary** (1-byte source tag + Int16 PCM), not via these JSON frames.

---

## public/

### [public/audio-worklet.js](public/audio-worklet.js)

**Purpose** — `AudioWorkletProcessor` (`copilot-audio-processor`) running on the audio thread.

**Behavior** — Streaming linear resampler from the context's actual rate to the target rate (16 kHz), accumulating fixed **100 ms** chunks, converting Float32 → Int16 PCM, and `postMessage`-ing each chunk's `ArrayBuffer` (transferred) to the offscreen document.

**Notes** — Web-accessible (loaded via `chrome.runtime.getURL('public/audio-worklet.js')`). Resampling lets the pipeline emit a stable 16 kHz regardless of the platform's actual `AudioContext` sample rate.

---

## scripts/

### [scripts/generate-icons.js](scripts/generate-icons.js)

**Purpose** — `prebuild` step that writes placeholder PNG icons (16/48/128 px) into `icons/` using only built-in Node APIs (manual PNG chunks + CRC32 + zlib).

**Notes** — These are solid-color placeholders; replace with designed icons before publishing. Also removes `icons/.gitkeep` if present.
