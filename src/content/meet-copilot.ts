// Content script for Google Meet — meeting detection + copilot overlay + speaker detection.

import { MessageType } from '../constants.js';
import { sendMessage, onMessage } from '../lib/messaging.js';
import type { Nudge, ProspectProfile, MeetingSummary } from '../types/ws.js';
import type { CopilotStateSnapshot } from '../types/messages.js';

// --- Build Stamp (#9) ---
const BUILD_STAMP = Date.now().toString(36);
try { document.documentElement.setAttribute('data-sc-build', BUILD_STAMP); } catch { /* ignore */ }

// --- State ---
let meetingDetected = false;
let copilotActive = false;
let meetingEndedFired = false;
let lastObservedPath = location.pathname;

// --- Meeting Detection ---

function isOnMeetingRoomPath(): boolean {
  return /^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}/.test(location.pathname);
}

function isInMeetCallDom(): boolean {
  try {
    if (document.querySelector("[aria-label*='Leave call' i],[aria-label*='Leave the call' i]")) return true;
    if (document.querySelector("button[data-is-muted],[data-is-muted][role='button']")) return true;
    return false;
  } catch { return false; }
}

function isInMeeting(): boolean {
  return isOnMeetingRoomPath() && isInMeetCallDom();
}

function checkMeeting(): void {
  const inMeeting = isInMeeting();
  if (inMeeting && !meetingDetected) {
    meetingDetected = true;
    meetingEndedFired = false;
    meetSawCallDom = true;
    meetLeaveTicks = 0;
    startEndDetection();
    sendMessage({ type: MessageType.MEETING_DETECTED, tabId: null });
    // A session may already be active for this tab — re-sync so the panel shows.
    syncCopilotState();
  } else if (!inMeeting && meetingDetected && !meetingEndedFired) {
    checkMeetEnded();
  }
}

setInterval(checkMeeting, 2000);
checkMeeting();

// On (re)load the content script has no overlay, but a session may already be
// running in the service worker (e.g. the Meet page was refreshed mid-call).
// Ask the SW for the current state and bring the panel back if so — otherwise
// we'd miss the already-fired lifecycle message and show nothing.
async function syncCopilotState(): Promise<void> {
  const res = await sendMessage<CopilotStateSnapshot>({ type: MessageType.GET_STATE });
  if (!res.ok || !res.data) return;
  const s = res.data.state;
  if (s === 'CONNECTING' || s === 'ACTIVE' || s === 'RECONNECTING') {
    copilotActive = true;
    createOverlay();
    updateStatus(s === 'ACTIVE' ? 'Active' : s === 'RECONNECTING' ? 'Reconnecting...' : 'Connecting...');
  }
}
syncCopilotState();

// --- Meeting End Detection (#1 URL + #2 Multi-locale + #3 DOM debounced) ---

// #2: Multi-locale end text patterns (en, es, fr, de, pt, hi, ja)
const MEET_END_PATTERNS = [
  /\byou left the (call|meeting)\b/i,
  /\breturn to home screen\b/i,
  /\brejoin\b/i,
  /\bhas salido de la (llamada|reuni[oó]n)\b/i,
  /\bvolver a la pantalla principal\b/i,
  /\bvous avez quitt[eé] (l['']appel|la r[eé]union)\b/i,
  /\bdu hast (den anruf|das meeting) verlassen\b/i,
  /\bvoc[eê] saiu da (chamada|reuni[aã]o)\b/i,
  /आपने मीटिंग छोड़ दी/,
  /会議から退出しました/,
];

// #3: DOM debounced fallback state
let meetSawCallDom = false;
let meetLeaveTicks = 0;
const MEET_LEAVE_CONFIRM_TICKS = 3;

function checkMeetEnded(): void {
  if (!meetingDetected || meetingEndedFired) return;

  // #1: URL transition out of the meeting room
  if (location.pathname !== lastObservedPath) {
    lastObservedPath = location.pathname;
    if (!isOnMeetingRoomPath()) {
      fireMeetingEnded('meet_url_left_room');
      return;
    }
  }

  // While in-call controls are still present we are NOT on the end screen.
  // Reset the debounce and skip the text scan — otherwise chat/shared-content
  // text matching an end phrase (e.g. someone typing "rejoin") would falsely
  // end a live meeting.
  if (isInMeetCallDom()) { meetSawCallDom = true; meetLeaveTicks = 0; return; }

  // #2: Multi-locale end-screen text detection (only once controls are gone).
  const text = document.body.innerText || '';
  for (const re of MEET_END_PATTERNS) {
    if (re.test(text)) {
      fireMeetingEnded('meet_ui_left_call');
      return;
    }
  }

  // #3: DOM debounced — in-call controls disappeared (3-tick confirmation)
  if (!meetSawCallDom) return;
  meetLeaveTicks++;
  if (meetLeaveTicks >= MEET_LEAVE_CONFIRM_TICKS) {
    fireMeetingEnded('meet_dom_left_call');
  }
}

function fireMeetingEnded(reason: string): void {
  meetingEndedFired = true;
  meetingDetected = false;
  stopEndDetection();
  sendMessage({ type: MessageType.MEETING_ENDED, reason });
  removeOverlay();
}

// End-detection runs only while a meeting is active, so the subtree observer
// (which fires checkMeetEnded on every DOM mutation) and the poll aren't
// burning CPU on a left/idle page.
let endObserver: MutationObserver | null = null;
let endPollInterval: ReturnType<typeof setInterval> | null = null;

function startEndDetection(): void {
  if (!endObserver) {
    endObserver = new MutationObserver(checkMeetEnded);
    endObserver.observe(document.body, { childList: true, subtree: true });
  }
  if (!endPollInterval) endPollInterval = setInterval(checkMeetEnded, 1500);
}

function stopEndDetection(): void {
  if (endObserver) { endObserver.disconnect(); endObserver = null; }
  if (endPollInterval) { clearInterval(endPollInterval); endPollInterval = null; }
}

// #1: Listen for SPA navigation events
window.addEventListener('popstate', checkMeetEnded);
window.addEventListener('hashchange', checkMeetEnded);

// --- Mic Mute Detection (#4 — robust, multi-candidate, localization-aware) ---

let lastMicState: boolean | null = null;
let micConfirmCount = 0;
let pendingMicState: boolean | null = null;
const MIC_CONFIRM_TICKS = 2;

// Localized hints for the mic toggle and for camera/picker controls to exclude.
// The data-is-muted attribute itself is language-independent; labels are only
// used to pick the right button among several (mic vs camera vs device picker).
const MIC_LABEL_HINTS = ['microphone', 'mic', 'micro', 'mikrofon', 'micrófono', 'マイク', 'माइक', 'mute', 'unmute', 'turn off', 'turn on'];
const NOT_MIC_HINTS = ['camera', 'video', 'cámara', 'caméra', 'kamera', 'カメラ', 'options', 'opciones'];

function isCameraOrPicker(label: string): boolean {
  return NOT_MIC_HINTS.some((h) => label.includes(h));
}

function detectMicMuted(): boolean | null {
  // Meet renders multiple buttons with data-is-muted (mic toggle, camera
  // toggle, sometimes a device picker). Pick the mic one.
  const candidates = [...document.querySelectorAll('button[data-is-muted]')];
  let micBtn: Element | null = null;
  for (const btn of candidates) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (isCameraOrPicker(label)) continue;
    if (MIC_LABEL_HINTS.some((h) => label.includes(h))) { micBtn = btn; break; }
  }
  // Language-independent fallback: if exactly one data-is-muted button is left
  // after excluding camera/picker controls, it's the mic — works on any locale.
  if (!micBtn) {
    const nonCamera = candidates.filter((b) => !isCameraOrPicker((b.getAttribute('aria-label') || '').toLowerCase()));
    if (nonCamera.length === 1) micBtn = nonCamera[0];
  }
  if (micBtn) return micBtn.getAttribute('data-is-muted') === 'true';

  // Fallback: aria-pressed on any mic-like button
  const ariaBtn = document.querySelector('button[aria-pressed][aria-label*="mic" i],button[aria-pressed][aria-label*="Microphone" i]');
  if (ariaBtn) return ariaBtn.getAttribute('aria-pressed') === 'true';
  return null;
}

function pollMicState(): void {
  if (!copilotActive) return;
  const muted = detectMicMuted();
  if (muted === null) return;

  // Require 2 consecutive reads before flipping (anti-flap)
  if (muted !== lastMicState) {
    if (muted === pendingMicState) {
      micConfirmCount++;
      if (micConfirmCount >= MIC_CONFIRM_TICKS) {
        lastMicState = muted;
        pendingMicState = null;
        micConfirmCount = 0;
        sendMessage({ type: MessageType.MIC_MUTE_STATE, muted });
      }
    } else {
      pendingMicState = muted;
      micConfirmCount = 1;
    }
  } else {
    pendingMicState = null;
    micConfirmCount = 0;
  }
}

setInterval(pollMicState, 1000);

// --- Speaker Detection (#12 — caption-based with DOM tile fallback) ---

let currentSpeaker: string | null = null;

// Primary: caption author detection (stable ARIA surface)
function detectSpeakerFromCaptions(): string | null {
  // Meet renders captions in a region with speaker name badges
  const region = document.querySelector('[role="region"][aria-label*="caption" i]');
  if (!region) return null;
  // Speaker badge: the name element inside the caption container
  const badges = region.querySelectorAll('[class*="name" i],[data-speaker-id]');
  if (badges.length > 0) {
    const name = badges[badges.length - 1].textContent?.trim();
    if (name) return name;
  }
  return null;
}

// Fallback: DOM tile speaking indicator
function detectSpeakerFromTiles(): string | null {
  const tiles = document.querySelectorAll('[data-participant-id]');
  for (const tile of tiles) {
    const speaking = tile.querySelector('[data-is-speaking="true"]') ||
      tile.classList.contains('speaking') ||
      tile.querySelector('.IisKdb');
    if (speaking) {
      const nameEl = tile.querySelector('[data-self-name]') || tile.querySelector('[aria-label]');
      return nameEl?.getAttribute('data-self-name') || nameEl?.getAttribute('aria-label') || null;
    }
  }
  return null;
}

function detectActiveSpeaker(): void {
  if (!copilotActive) return;
  // Hybrid: try captions first, fall back to tiles
  const name = detectSpeakerFromCaptions() || detectSpeakerFromTiles();
  if (name && name !== currentSpeaker) {
    currentSpeaker = name;
    sendMessage({ type: MessageType.SPEAKER_CHANGE, speaker: name, wall_clock_ms: Date.now() });
  }
}

setInterval(detectActiveSpeaker, 500);

// --- Overlay UI (Shadow DOM) ---
// G1: Minimize/expand, G2: Dismiss/copy, G3: Active indicator,
// G4: Scroll history, G5: Prospect brief card

const OVERLAY_ID = 'sales-copilot-overlay';
let shadowHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let nudgeContainer: HTMLElement | null = null;
let minimized = false;
let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
let prospectData: ProspectProfile | null = null;
let nudgeCount = 0;

function createOverlay(): void {
  if (shadowHost) return;

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  shadowHost = host;
  const root = host.attachShadow({ mode: 'closed' });
  shadowRoot = root;

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed; bottom: 80px; right: 16px; width: 360px; height: 480px;
        min-width: 280px; min-height: 220px;
        background: #fff; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; color: #1a1a2e; z-index: 2147483647;
        display: flex; flex-direction: column; overflow: hidden;
        border: 1px solid #e5e7eb;
      }
      /* Resize grip (bottom-right corner) */
      .resize-handle {
        position: absolute; right: 0; bottom: 0; width: 18px; height: 18px;
        cursor: nwse-resize; z-index: 2; touch-action: none;
        background:
          linear-gradient(135deg, transparent 0 50%, #9ca3af 50% 60%, transparent 60% 70%, #9ca3af 70% 80%, transparent 80%);
      }
      .panel.minimized { display: none; }
      /* G1: Minimized pill */
      .pill {
        position: fixed; bottom: 80px; right: 16px;
        background: #6366f1; color: #fff; border-radius: 20px;
        padding: 8px 14px; font-size: 12px; font-weight: 500;
        cursor: pointer; z-index: 2147483647;
        box-shadow: 0 4px 12px rgba(99,102,241,0.4);
        display: none; align-items: center; gap: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      .pill.visible { display: flex; }
      .pill .badge { background: #dc2626; border-radius: 10px; padding: 1px 6px; font-size: 10px; }
      /* G3: Active indicator */
      .rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; animation: pulse 1.5s infinite; }
      @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      .header {
        padding: 10px 14px; background: #6366f1; color: #fff;
        font-weight: 600; font-size: 12px;
        display: flex; justify-content: space-between; align-items: center;
        cursor: move; user-select: none; touch-action: none;
      }
      .header-left { display: flex; align-items: center; gap: 6px; }
      .header .status { font-weight: 400; opacity: 0.85; font-size: 11px; }
      .header-btns { display: flex; gap: 4px; }
      .header-btns button { background: none; border: none; color: #fff; cursor: pointer; font-size: 14px; opacity: 0.8; padding: 2px 4px; }
      .header-btns button:hover { opacity: 1; }
      /* G5: Prospect brief */
      .prospect-brief {
        padding: 8px 14px; background: #f0fdf4; border-bottom: 1px solid #e5e7eb;
        font-size: 11px; color: #374151; display: none;
      }
      .prospect-brief.visible { display: block; }
      .prospect-brief strong { color: #111827; }
      .prospect-brief .company { color: #6b7280; }
      /* G4: Scrollable nudge list */
      .nudges {
        flex: 1; overflow-y: auto; padding: 8px;
        display: flex; flex-direction: column; gap: 8px;
        scroll-behavior: smooth;
      }
      .nudge-card {
        padding: 10px 12px; border-radius: 8px;
        border-left: 3px solid #6366f1; background: #f9fafb;
        animation: slideIn 0.3s ease; position: relative;
      }
      .nudge-card.priority-critical { border-left-color: #dc2626; background: #fef2f2; }
      .nudge-card.priority-high { border-left-color: #f59e0b; background: #fffbeb; }
      .nudge-card.priority-medium { border-left-color: #6366f1; }
      .nudge-card.priority-low { border-left-color: #9ca3af; opacity: 0.85; }
      .nudge-card.old { opacity: 0.6; }
      .nudge-title { font-weight: 600; font-size: 12px; margin-bottom: 4px; padding-right: 20px; }
      .nudge-message { font-size: 12px; color: #374151; line-height: 1.4; }
      .nudge-suggestion { margin-top: 6px; padding: 6px 8px; background: #eef2ff; border-radius: 4px; font-size: 11px; color: #4338ca; cursor: pointer; }
      .nudge-suggestion:hover { background: #dbeafe; }
      /* G2: Dismiss button */
      .nudge-dismiss { position: absolute; top: 6px; right: 8px; background: none; border: none; color: #9ca3af; cursor: pointer; font-size: 14px; line-height: 1; }
      .nudge-dismiss:hover { color: #ef4444; }
      .empty { text-align: center; padding: 24px; color: #9ca3af; font-size: 12px; }
      .talk-ratio { padding: 8px 14px; border-top: 1px solid #f3f4f6; font-size: 11px; color: #6b7280; display: flex; justify-content: space-between; }
      .talk-ratio .warn { color: #dc2626; font-weight: 500; }
      /* Audio health bar — surfaces dead mic / muted playback instead of a
         silently broken session */
      .audio-health { padding: 6px 14px; border-top: 1px solid #f3f4f6; font-size: 11px;
        display: flex; align-items: center; gap: 10px; color: #6b7280; }
      .audio-health .ind { display: inline-flex; align-items: center; gap: 4px; }
      .audio-health .ok { color: #059669; }
      .audio-health .bad { color: #dc2626; cursor: pointer; text-decoration: underline; }
      .audio-banner { display: none; padding: 8px 14px; background: #fef3c7; color: #92400e;
        font-size: 12px; align-items: center; justify-content: space-between; gap: 8px; }
      .audio-banner.visible { display: flex; }
      .audio-banner button { background: #d97706; color: #fff; border: none; border-radius: 6px;
        padding: 5px 10px; font-size: 11px; cursor: pointer; white-space: nowrap; }
      .audio-banner button:hover { background: #b45309; }
      @keyframes slideIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    </style>
    <!-- G1: Minimized pill -->
    <div class="pill" id="copilot-pill">
      <span class="rec-dot"></span>
      <span>Sales Copilot</span>
      <span class="badge" id="pill-badge">0</span>
    </div>
    <!-- Full panel -->
    <div class="panel" id="copilot-panel">
      <div class="header">
        <div class="header-left">
          <span class="rec-dot"></span>
          <span>Sales Copilot</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="status" id="overlay-status">Listening...</span>
          <div class="header-btns">
            <button id="minimize-btn" title="Minimize">−</button>
          </div>
        </div>
      </div>
      <!-- G5: Prospect brief -->
      <div class="prospect-brief" id="prospect-brief"></div>
      <!-- Audio action banner (e.g. playback suspended → user click resumes) -->
      <div class="audio-banner" id="audio-banner">
        <span id="audio-banner-text">Meeting audio is paused.</span>
        <button id="audio-banner-btn">Enable audio</button>
      </div>
      <div class="nudges" id="nudge-list">
        <div class="empty">Analyzing conversation...</div>
      </div>
      <div class="talk-ratio" id="talk-ratio" style="display:none">
        <span id="ratio-text">Talk ratio: —</span>
        <span id="stage-text">Opening</span>
      </div>
      <!-- Audio health indicators -->
      <div class="audio-health" id="audio-health" style="display:none">
        <span class="ind" id="mic-ind">🎙 Mic: —</span>
        <span class="ind" id="tab-ind">🔊 Meeting: —</span>
      </div>
      <div class="resize-handle" id="resize-handle" title="Drag to resize"></div>
    </div>
  `;

  nudgeContainer = root.getElementById('nudge-list');
  document.body.appendChild(host);

  // Draggable (via header) + resizable (via corner grip), with persisted geometry
  const panel = root.getElementById('copilot-panel') as HTMLElement | null;
  const header = root.querySelector('.header') as HTMLElement | null;
  const resizeHandle = root.getElementById('resize-handle') as HTMLElement | null;
  if (panel) {
    restorePanelGeometry(panel);
    if (header) setupDrag(panel, header);
    if (resizeHandle) setupResize(panel, resizeHandle);
  }

  // G1: Minimize/expand handlers
  root.getElementById('minimize-btn')?.addEventListener('click', () => toggleMinimize(true));
  root.getElementById('copilot-pill')?.addEventListener('click', () => toggleMinimize(false));

  // Audio action banner: this click is the user gesture that the invisible
  // offscreen document can never receive — relay it to retry ctx.resume().
  root.getElementById('audio-banner-btn')?.addEventListener('click', () => {
    sendMessage({ type: MessageType.RESUME_AUDIO_PLAYBACK });
    const banner = root.getElementById('audio-banner');
    if (banner) banner.classList.remove('visible'); // hide; re-shown if still suspended
  });

  // G2: Keyboard shortcut — Esc to dismiss top nudge. Store the handler so
  // removeOverlay can detach it; otherwise each create/remove cycle stacks
  // another listener and a single Esc dismisses N nudges at once.
  if (keydownHandler) document.removeEventListener('keydown', keydownHandler);
  keydownHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && copilotActive && !minimized) {
      const first = nudgeContainer?.querySelector('.nudge-card');
      if (first) dismissNudge(first as HTMLElement);
    }
  };
  document.addEventListener('keydown', keydownHandler);
}

// --- Drag + Resize ---
const PANEL_MIN_W = 280;
const PANEL_MIN_H = 220;
const GEOMETRY_KEY = 'sc_panel_geometry';

// Switch the panel from its default bottom/right anchoring to explicit top/left
// so it can be moved and grown deterministically from the top-left corner.
function pinTopLeft(panel: HTMLElement): void {
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.top}px`;
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

function savePanelGeometry(panel: HTMLElement): void {
  const g = { left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height };
  chrome.storage.local.set({ [GEOMETRY_KEY]: g }).catch(() => {});
}

function restorePanelGeometry(panel: HTMLElement): void {
  chrome.storage.local.get(GEOMETRY_KEY).then((res) => {
    const g = res[GEOMETRY_KEY] as { left?: string; top?: string; width?: string; height?: string } | undefined;
    if (!g) return;
    if (g.width) panel.style.width = g.width;
    if (g.height) panel.style.height = g.height;
    if (g.left && g.top) {
      // Clamp into the current viewport in case the window is smaller now.
      const w = parseInt(g.width || '360', 10);
      const h = parseInt(g.height || '480', 10);
      const left = Math.max(0, Math.min(parseInt(g.left, 10) || 0, window.innerWidth - w));
      const top = Math.max(0, Math.min(parseInt(g.top, 10) || 0, window.innerHeight - h));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }).catch(() => {});
}

function setupDrag(panel: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // Let header buttons (minimize) keep working — don't start a drag on them.
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    pinTopLeft(panel);
    const rect = panel.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => {
      const left = Math.max(0, Math.min(ev.clientX - offsetX, window.innerWidth - panel.offsetWidth));
      const top = Math.max(0, Math.min(ev.clientY - offsetY, window.innerHeight - panel.offsetHeight));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    const onUp = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      savePanelGeometry(panel);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

function setupResize(panel: HTMLElement, handle: HTMLElement): void {
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    pinTopLeft(panel);
    const rect = panel.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startW = rect.width, startH = rect.height;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => {
      const w = Math.max(PANEL_MIN_W, Math.min(startW + (ev.clientX - startX), window.innerWidth - rect.left));
      const h = Math.max(PANEL_MIN_H, Math.min(startH + (ev.clientY - startY), window.innerHeight - rect.top));
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
    };
    const onUp = (ev: PointerEvent): void => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      savePanelGeometry(panel);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// G1: Toggle minimize
function toggleMinimize(min: boolean): void {
  const root = shadowRoot;
  if (!root) return;
  minimized = min;
  root.getElementById('copilot-panel')?.classList.toggle('minimized', min);
  root.getElementById('copilot-pill')?.classList.toggle('visible', min);
}

// Auto-expand on critical nudge
function autoExpandIfNeeded(priority?: string): void {
  if (minimized && (priority === 'critical' || priority === 'high')) {
    toggleMinimize(false);
  }
}

function removeOverlay(): void {
  if (keydownHandler) {
    document.removeEventListener('keydown', keydownHandler);
    keydownHandler = null;
  }
  if (shadowHost) {
    shadowHost.remove();
    shadowHost = null;
    shadowRoot = null;
    nudgeContainer = null;
    minimized = false;
    nudgeCount = 0;
  }
}

// G2 + G4: Add nudge with dismiss/copy and unlimited scroll
function addNudge(nudge: Nudge): void {
  const container = nudgeContainer;
  if (!container) return;
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();

  nudgeCount++;
  autoExpandIfNeeded(nudge.priority);

  // Mark older nudges
  const existing = container.querySelectorAll('.nudge-card:not(.old)');
  if (existing.length > 3) {
    existing[existing.length - 1]?.classList.add('old');
  }

  const card = document.createElement('div');
  card.className = `nudge-card priority-${nudge.priority || 'medium'}`;
  card.dataset.nudgeId = nudge.id || '';
  card.dataset.nudgeType = nudge.type || '';
  card.innerHTML = `
    <button class="nudge-dismiss" title="Dismiss (Esc)">×</button>
    <div class="nudge-title">${escapeHtml(nudge.title)}</div>
    <div class="nudge-message">${escapeHtml(nudge.message)}</div>
    ${nudge.suggested_response ? `<div class="nudge-suggestion" title="Click to copy">"${escapeHtml(nudge.suggested_response)}"</div>` : ''}
  `;

  // G2: Dismiss button
  card.querySelector('.nudge-dismiss')?.addEventListener('click', () => dismissNudge(card));

  // G2: Copy suggested response on click
  const suggestion = card.querySelector('.nudge-suggestion');
  if (suggestion) {
    suggestion.addEventListener('click', () => {
      navigator.clipboard.writeText(nudge.suggested_response || '').catch(() => {});
      suggestion.textContent = '✓ Copied!';
      setTimeout(() => { suggestion.textContent = `"${nudge.suggested_response}"`; }, 1500);
      sendMessage({ type: MessageType.NUDGE_ACTED, nudge_id: nudge.id, nudge_type: nudge.type });
    });
  }

  // G4: Prepend and auto-scroll to top
  container.prepend(card);
  container.scrollTop = 0;

  // Update pill badge
  const root = shadowRoot;
  if (minimized && root) {
    const badge = root.getElementById('pill-badge');
    if (badge) badge.textContent = String(nudgeCount);
  }
}

// G2: Dismiss nudge
function dismissNudge(card: HTMLElement): void {
  const id = card.dataset.nudgeId;
  const type = card.dataset.nudgeType;
  card.remove();
  if (id) sendMessage({ type: MessageType.NUDGE_DISMISS, nudge_id: id, nudge_type: type || '' });
}

// G5: Show prospect brief card
function showProspectBrief(profile: ProspectProfile): void {
  const root = shadowRoot;
  if (!root) return;
  prospectData = profile;
  const el = root.getElementById('prospect-brief');
  if (!el || !profile) return;

  const parts: string[] = [];
  if (profile.name) parts.push(`<strong>${escapeHtml(profile.name)}</strong>`);
  if (profile.title) parts.push(escapeHtml(profile.title));
  if (profile.company) parts.push(`<span class="company">${escapeHtml(profile.company)}</span>`);
  if (profile.industry) parts.push(escapeHtml(profile.industry));
  if (profile.company_size) parts.push(`${escapeHtml(profile.company_size)} employees`);

  el.innerHTML = parts.join(' · ');
  el.classList.add('visible');

  // Auto-collapse after 15s
  setTimeout(() => { el.classList.remove('visible'); }, 15000);
}

function updateTalkRatio(ratio: number, warning?: boolean): void {
  const root = shadowRoot;
  if (!root) return;
  const el = root.getElementById('talk-ratio');
  const text = root.getElementById('ratio-text');
  if (!el || !text) return;
  el.style.display = 'flex';
  const pct = Math.round(ratio * 100);
  text.textContent = `You: ${pct}% | Prospect: ${100 - pct}%`;
  text.className = warning ? 'warn' : '';
}

function updateStage(stage: string): void {
  const root = shadowRoot;
  if (!root || !stage) return;
  const el = root.getElementById('stage-text');
  const el2 = root.getElementById('talk-ratio');
  if (!el || !el2) return;
  el2.style.display = 'flex';
  el.textContent = stage.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function updateStatus(text: string): void {
  const root = shadowRoot;
  if (!root) return;
  const el = root.getElementById('overlay-status');
  if (el) el.textContent = text;
}

function showOfflineBanner(show: boolean): void {
  const root = shadowRoot;
  if (!root) return;
  const banner = root.getElementById('offline-banner');
  if (show && !banner) {
    const created = document.createElement('div');
    created.id = 'offline-banner';
    created.style.cssText = 'padding:6px 14px;background:#fef3c7;color:#92400e;font-size:11px;text-align:center;border-bottom:1px solid #fde68a;';
    created.textContent = '⚠ Connection lost — showing cached nudges. Reconnecting...';
    const panel = root.getElementById('copilot-panel');
    const nudges = root.getElementById('nudge-list');
    if (panel && nudges) panel.insertBefore(created, nudges);
  } else if (!show && banner) {
    banner.remove();
  }
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// Render the audio-health bar: dead mic / missing meeting audio / suspended
// playback must be visible and actionable, not a silently broken session.
function renderAudioStatus(s: { mic?: boolean; tab?: boolean; playback?: boolean; micReason?: string }): void {
  const root = shadowRoot;
  if (!root) return;
  const bar = root.getElementById('audio-health');
  const micInd = root.getElementById('mic-ind');
  const tabInd = root.getElementById('tab-ind');
  if (!bar || !micInd || !tabInd) return;
  bar.style.display = 'flex';

  if (s.mic) {
    micInd.textContent = '🎙 Mic: capturing';
    micInd.className = 'ind ok';
    micInd.onclick = null;
  } else {
    micInd.textContent = s.micReason === 'denied'
      ? '🎙 Mic blocked — click to fix'
      : '🎙 Mic off — click to enable';
    micInd.className = 'ind bad';
    micInd.onclick = () => sendMessage({ type: MessageType.OPEN_CONSENT_PAGE });
  }

  tabInd.textContent = s.tab ? '🔊 Meeting: capturing' : '🔊 Meeting: no audio';
  tabInd.className = 'ind ' + (s.tab ? 'ok' : 'bad');

  // Suspended playback → show the clickable enable-audio banner
  const banner = root.getElementById('audio-banner');
  if (banner) banner.classList.toggle('visible', s.playback === false);
}

// Render the end-of-meeting summary as a persistent card in the overlay so the
// backend's generated summary is actually surfaced to the rep.
function showMeetingSummary(summary: MeetingSummary): void {
  const container = nudgeContainer;
  if (!container) return;
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();

  const list = (items?: string[]) =>
    (items && items.length)
      ? `<ul>${items.slice(0, 5).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
      : '';

  const card = document.createElement('div');
  card.className = 'nudge-card priority-high meeting-summary-card';
  card.innerHTML = `
    <div class="nudge-title">Meeting summary</div>
    ${summary.key_points?.length ? `<div class="nudge-message"><strong>Key points</strong>${list(summary.key_points)}</div>` : ''}
    ${summary.objections?.length ? `<div class="nudge-message"><strong>Objections</strong>${list(summary.objections)}</div>` : ''}
    ${summary.action_items?.length ? `<div class="nudge-message"><strong>Action items</strong>${list(summary.action_items)}</div>` : ''}
    ${summary.next_steps ? `<div class="nudge-message"><strong>Next steps:</strong> ${escapeHtml(summary.next_steps)}</div>` : ''}
    ${typeof summary.qualification_score === 'number' ? `<div class="nudge-message"><strong>Qualification:</strong> ${Math.round(summary.qualification_score)}/100</div>` : ''}
  `;
  container.prepend(card);
  container.scrollTop = 0;
  updateStatus('Meeting summary ready');
}

// --- Message Handlers ---

onMessage({
  [MessageType.CONTENT_PING]: () => ({ ready: true }),
  [MessageType.COPILOT_LIFECYCLE]: (msg) => {
    if (msg.phase === 'started') {
      copilotActive = true;
      createOverlay();
      updateStatus('Connecting...');
    } else if (msg.phase === 'stopped') {
      copilotActive = false;
      currentSpeaker = null;
      removeOverlay();
    }
  },
  NUDGE: (msg) => {
    if (!msg.nudge) return;
    updateStatus('Active');
    addNudge(msg.nudge);
  },
  TRANSCRIPT: () => {
    updateStatus('Active');
  },
  STAGE_UPDATE: (msg) => {
    updateStage(msg.stage);
  },
  TALK_RATIO: (msg) => {
    updateTalkRatio(msg.ratio, msg.warning);
  },
  PROSPECT_CONTEXT: (msg) => {
    showProspectBrief(msg.profile);
  },
  WS_ERROR: (msg) => {
    // Terminal codes (gave up reconnecting, or auth rejected) shouldn't show a
    // perpetual "Reconnecting…" — the connection is dead.
    const terminal = msg.code === 'max_reconnect' || msg.code === 4001 || msg.code === 'auth';
    updateStatus(terminal ? 'Disconnected' : 'Reconnecting...');
    showOfflineBanner(true);
  },
  MEETING_SUMMARY: (msg) => {
    if (msg.summary) showMeetingSummary(msg.summary);
  },
  [MessageType.AUDIO_STATUS]: (msg) => {
    renderAudioStatus(msg);
  },
  [MessageType.COPILOT_NOTICE]: (msg) => {
    // Non-fatal user-facing notice (e.g. autoplay blocked, capture failed).
    if (msg.message) updateStatus(msg.message);
  },
  [MessageType.STATE_UPDATE]: (msg) => {
    // Bring the panel back if a broadcast arrives while we have no overlay
    // (e.g. the content script reloaded mid-session).
    if (!shadowHost && (msg.state === 'ACTIVE' || msg.state === 'CONNECTING' || msg.state === 'RECONNECTING')) {
      copilotActive = true;
      createOverlay();
    }
    if (msg.state === 'ACTIVE') {
      updateStatus('Active');
      showOfflineBanner(false);
    } else if (msg.state === 'CONNECTING') {
      updateStatus('Connecting...');
    } else if (msg.state === 'RECONNECTING') {
      updateStatus('Reconnecting...');
    } else if (msg.state === 'ERROR') {
      updateStatus('Error');
    }
  },
});
