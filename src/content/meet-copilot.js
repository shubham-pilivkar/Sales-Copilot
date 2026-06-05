// Content script for Google Meet — meeting detection + copilot overlay + speaker detection.
// Patterns from chrome_extension/src/content/meet.js + src/transcribe/overlay.js

import { MessageType } from '../constants.js';
import { sendMessage, onMessage } from '../lib/messaging.js';

// --- Meeting Detection (from meet.js) ---

let meetingDetected = false;
let copilotActive = false;

function isInMeeting() {
  if (!/^\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}/.test(location.pathname)) return false;
  const leaveBtn = document.querySelector("[aria-label*='Leave call' i],[aria-label*='Leave the call' i]");
  const muteBtn = document.querySelector("button[data-is-muted]");
  return !!(leaveBtn || muteBtn);
}

function checkMeeting() {
  const inMeeting = isInMeeting();
  if (inMeeting && !meetingDetected) {
    meetingDetected = true;
    sendMessage({ type: MessageType.MEETING_DETECTED, tabId: null });
  } else if (!inMeeting && meetingDetected) {
    meetingDetected = false;
    sendMessage({ type: MessageType.MEETING_ENDED, reason: 'meet_left' });
    removeOverlay();
  }
}

setInterval(checkMeeting, 2000);
checkMeeting();

// --- Meeting End Detection ---

const END_PATTERNS = [
  /\byou left the (call|meeting)\b/i,
  /\breturn to home screen\b/i,
  /\brejoin\b/i,
];

const endObserver = new MutationObserver(() => {
  if (!meetingDetected) return;
  const text = document.body.innerText || '';
  for (const re of END_PATTERNS) {
    if (re.test(text)) {
      meetingDetected = false;
      sendMessage({ type: MessageType.MEETING_ENDED, reason: 'meet_ui_ended' });
      removeOverlay();
      return;
    }
  }
});
endObserver.observe(document.body, { childList: true, subtree: true });

// --- Mic Mute Detection (from chrome_extension/src/lib/meet-mic-state.js) ---

let lastMicState = null;

function detectMicMuted() {
  // Meet mic toggle has data-is-muted attribute
  const btns = document.querySelectorAll('button[data-is-muted]');
  for (const btn of btns) {
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('microphone') || label.includes('mic')) {
      return btn.getAttribute('data-is-muted') === 'true';
    }
  }
  return null;
}

function pollMicState() {
  if (!copilotActive) return;
  const muted = detectMicMuted();
  if (muted !== null && muted !== lastMicState) {
    lastMicState = muted;
    sendMessage({ type: MessageType.MIC_MUTE_STATE, muted });
  }
}

setInterval(pollMicState, 1000);

// --- Speaker Detection (from chrome_extension/src/lib/speaker-detector.js) ---
// Detect who is speaking from Meet's participant tile indicators

let currentSpeaker = null;

function detectActiveSpeaker() {
  if (!copilotActive) return;
  // Meet highlights the speaking participant's tile border
  // The active speaker has a blue/colored border or a speaking indicator
  const tiles = document.querySelectorAll('[data-participant-id]');
  for (const tile of tiles) {
    // Check for speaking indicator (animated border or icon)
    const speaking = tile.querySelector('[data-is-speaking="true"]') ||
      tile.classList.contains('speaking') ||
      tile.querySelector('.IisKdb'); // Meet's "speaking now" indicator class
    if (speaking) {
      const nameEl = tile.querySelector('[data-self-name]') || tile.querySelector('[aria-label]');
      const name = nameEl?.getAttribute('data-self-name') || nameEl?.getAttribute('aria-label') || '';
      if (name && name !== currentSpeaker) {
        currentSpeaker = name;
        sendMessage({ type: MessageType.SPEAKER_CHANGE, speaker: name, wall_clock_ms: Date.now() });
      }
      return;
    }
  }
}

setInterval(detectActiveSpeaker, 500);

// --- Overlay UI (Shadow DOM) ---
// G1: Minimize/expand, G2: Dismiss/copy, G3: Active indicator,
// G4: Scroll history, G5: Prospect brief card

const OVERLAY_ID = 'sales-copilot-overlay';
let shadowHost = null;
let shadowRoot = null;
let nudgeContainer = null;
let minimized = false;
let prospectData = null;
let nudgeCount = 0;

function createOverlay() {
  if (shadowHost) return;

  shadowHost = document.createElement('div');
  shadowHost.id = OVERLAY_ID;
  shadowRoot = shadowHost.attachShadow({ mode: 'closed' });

  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed; bottom: 80px; right: 16px; width: 360px; max-height: 480px;
        background: #fff; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.12);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px; color: #1a1a2e; z-index: 2147483647;
        display: flex; flex-direction: column; overflow: hidden;
        border: 1px solid #e5e7eb; transition: all 0.3s ease;
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
        max-height: 320px; scroll-behavior: smooth;
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
      <div class="nudges" id="nudge-list">
        <div class="empty">Analyzing conversation...</div>
      </div>
      <div class="talk-ratio" id="talk-ratio" style="display:none">
        <span id="ratio-text">Talk ratio: —</span>
        <span id="stage-text">Opening</span>
      </div>
    </div>
  `;

  nudgeContainer = shadowRoot.getElementById('nudge-list');
  document.body.appendChild(shadowHost);

  // G1: Minimize/expand handlers
  shadowRoot.getElementById('minimize-btn').addEventListener('click', () => toggleMinimize(true));
  shadowRoot.getElementById('copilot-pill').addEventListener('click', () => toggleMinimize(false));

  // G2: Keyboard shortcut — Esc to dismiss top nudge
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && copilotActive && !minimized) {
      const first = nudgeContainer?.querySelector('.nudge-card');
      if (first) dismissNudge(first);
    }
  });
}

// G1: Toggle minimize
function toggleMinimize(min) {
  if (!shadowRoot) return;
  minimized = min;
  shadowRoot.getElementById('copilot-panel').classList.toggle('minimized', min);
  shadowRoot.getElementById('copilot-pill').classList.toggle('visible', min);
}

// Auto-expand on critical nudge
function autoExpandIfNeeded(priority) {
  if (minimized && (priority === 'critical' || priority === 'high')) {
    toggleMinimize(false);
  }
}

function removeOverlay() {
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
function addNudge(nudge) {
  if (!nudgeContainer) return;
  const empty = nudgeContainer.querySelector('.empty');
  if (empty) empty.remove();

  nudgeCount++;
  autoExpandIfNeeded(nudge.priority);

  // Mark older nudges
  const existing = nudgeContainer.querySelectorAll('.nudge-card:not(.old)');
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
  card.querySelector('.nudge-dismiss').addEventListener('click', () => dismissNudge(card));

  // G2: Copy suggested response on click
  const suggestion = card.querySelector('.nudge-suggestion');
  if (suggestion) {
    suggestion.addEventListener('click', () => {
      navigator.clipboard.writeText(nudge.suggested_response).catch(() => {});
      suggestion.textContent = '✓ Copied!';
      setTimeout(() => { suggestion.textContent = `"${nudge.suggested_response}"`; }, 1500);
      sendMessage({ type: MessageType.NUDGE_ACTED, nudge_id: nudge.id, nudge_type: nudge.type });
    });
  }

  // G4: Prepend and auto-scroll to top
  nudgeContainer.prepend(card);
  nudgeContainer.scrollTop = 0;

  // Update pill badge
  if (minimized) {
    const badge = shadowRoot.getElementById('pill-badge');
    if (badge) badge.textContent = String(nudgeCount);
  }
}

// G2: Dismiss nudge
function dismissNudge(card) {
  const id = card.dataset.nudgeId;
  const type = card.dataset.nudgeType;
  card.remove();
  if (id) sendMessage({ type: MessageType.NUDGE_DISMISS, nudge_id: id, nudge_type: type });
}

// G5: Show prospect brief card
function showProspectBrief(profile) {
  if (!shadowRoot) return;
  prospectData = profile;
  const el = shadowRoot.getElementById('prospect-brief');
  if (!el || !profile) return;

  const parts = [];
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

function updateTalkRatio(ratio, warning) {
  if (!shadowRoot) return;
  const el = shadowRoot.getElementById('talk-ratio');
  const text = shadowRoot.getElementById('ratio-text');
  el.style.display = 'flex';
  const pct = Math.round(ratio * 100);
  text.textContent = `You: ${pct}% | Prospect: ${100 - pct}%`;
  text.className = warning ? 'warn' : '';
}

function updateStage(stage) {
  if (!shadowRoot) return;
  const el = shadowRoot.getElementById('stage-text');
  const el2 = shadowRoot.getElementById('talk-ratio');
  el2.style.display = 'flex';
  el.textContent = stage.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function updateStatus(text) {
  if (!shadowRoot) return;
  shadowRoot.getElementById('overlay-status').textContent = text;
}

function showOfflineBanner(show) {
  if (!shadowRoot) return;
  let banner = shadowRoot.getElementById('offline-banner');
  if (show && !banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.style.cssText = 'padding:6px 14px;background:#fef3c7;color:#92400e;font-size:11px;text-align:center;border-bottom:1px solid #fde68a;';
    banner.textContent = '⚠ Connection lost — showing cached nudges. Reconnecting...';
    const panel = shadowRoot.getElementById('copilot-panel');
    const nudges = shadowRoot.getElementById('nudge-list');
    if (panel && nudges) panel.insertBefore(banner, nudges);
  } else if (!show && banner) {
    banner.remove();
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// --- Message Handlers ---

onMessage({
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
    updateStatus(msg.code === 'max_reconnect' ? 'Disconnected' : 'Reconnecting...');
    showOfflineBanner(true);
  },
  [MessageType.STATE_UPDATE]: (msg) => {
    if (msg.state === 'ACTIVE') {
      updateStatus('Active');
      showOfflineBanner(false);
    }
    else if (msg.state === 'RECONNECTING') updateStatus('Reconnecting...');
    else if (msg.state === 'ERROR') updateStatus('Error');
  },
});
