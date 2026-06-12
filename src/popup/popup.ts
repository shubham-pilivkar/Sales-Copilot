// Popup — auth gate + copilot controls.

import { CopilotState, MessageType, StorageKey } from '../constants.js';
import { sendMessage } from '../lib/messaging.js';
import type { Preferences } from '../types/api.js';
import type { CopilotStateSnapshot } from '../types/messages.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const els = {
  dot: $('status-dot'),
  authSection: $('auth-section'),
  copilotSection: $('copilot-section'),
  tabLogin: $('tab-login'),
  tabRegister: $('tab-register'),
  authEmail: $<HTMLInputElement>('auth-email'),
  authName: $<HTMLInputElement>('auth-name'),
  authPassword: $<HTMLInputElement>('auth-password'),
  authSubmit: $<HTMLButtonElement>('auth-submit'),
  authError: $('auth-error'),
  userEmail: $('user-email'),
  logoutLink: $('logout-link'),
  idlePanel: $('idle-panel'),
  activePanel: $('active-panel'),
  prospectEmail: $<HTMLInputElement>('prospect-email'),
  startBtn: $<HTMLButtonElement>('start-btn'),
  stopBtn: $<HTMLButtonElement>('stop-btn'),
  statusBar: $('status-bar'),
  prospectDisplay: $('prospect-display'),
  copilotError: $('copilot-error'),
  nudgePrefs: $('nudge-prefs'),
  storeTranscripts: $<HTMLInputElement>('store-transcripts'),
  storeNudges: $<HTMLInputElement>('store-nudges'),
  retentionDays: $<HTMLInputElement>('retention-days'),
  prefsStatus: $('prefs-status'),
  audioHealthLine: $('audio-health-line'),
};

// Render the audio-health line in the active panel. A dead mic or missing
// meeting audio is actionable (click to fix), not a silent failure.
function renderAudioHealth(s: { mic?: boolean; tab?: boolean; playback?: boolean; micReason?: string }): void {
  const parts: string[] = [];
  parts.push(s.mic ? '🎙 Mic ✓' : '🎙 Mic ✗');
  parts.push(s.tab ? '🔊 Meeting ✓' : '🔊 Meeting ✗');
  if (s.playback === false) parts.push('⚠ audio paused');
  els.audioHealthLine.textContent = parts.join('   ');
  els.audioHealthLine.style.color = (s.mic && s.tab && s.playback !== false) ? '#059669' : '#dc2626';
  els.audioHealthLine.style.cursor = s.mic ? 'default' : 'pointer';
  els.audioHealthLine.title = s.mic ? '' : 'Click to grant microphone access';
  els.audioHealthLine.onclick = s.mic ? null : () => {
    sendMessage({ type: MessageType.OPEN_CONSENT_PAGE });
  };
}

let isLoginMode = true;
let preferences: Preferences | null = null;
let prefsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let prefsSaveSeq = 0;

const PREF_LABELS: Record<string, string> = {
  objection_handling: 'Objections',
  discovery_question: 'Discovery',
  pain_point: 'Pain',
  pricing_concern: 'Pricing',
  competitor_mention: 'Competitors',
  next_best_question: 'Next question',
  personalized_pitch: 'Pitch',
  follow_up_reminder: 'Follow-up',
  talk_ratio_warning: 'Talk ratio',
  meeting_stage_update: 'Stage',
};

// --- Init ---
async function init(): Promise<void> {
  const got = await chrome.storage.local.get([StorageKey.AUTH_TOKEN, StorageKey.USER_EMAIL]);
  if (got[StorageKey.AUTH_TOKEN]) {
    showCopilotSection(got[StorageKey.USER_EMAIL]);
    await refreshState();
    await loadPreferences();
  } else {
    showAuthSection();
  }
}

// --- Auth ---
function showAuthSection(): void {
  els.authSection.classList.remove('hidden');
  els.copilotSection.classList.add('hidden');
}

function showCopilotSection(email: string): void {
  els.authSection.classList.add('hidden');
  els.copilotSection.classList.remove('hidden');
  els.userEmail.textContent = email || '';
}

els.tabLogin.addEventListener('click', () => {
  isLoginMode = true;
  els.tabLogin.classList.add('active');
  els.tabRegister.classList.remove('active');
  els.authName.classList.add('hidden');
  els.authSubmit.textContent = 'Login';
});

els.tabRegister.addEventListener('click', () => {
  isLoginMode = false;
  els.tabRegister.classList.add('active');
  els.tabLogin.classList.remove('active');
  els.authName.classList.remove('hidden');
  els.authSubmit.textContent = 'Register';
});

els.authSubmit.addEventListener('click', async () => {
  els.authError.classList.add('hidden');
  els.authSubmit.disabled = true;

  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  const name = els.authName.value.trim();

  if (!email || !password || (!isLoginMode && !name)) {
    showAuthError('All fields required');
    els.authSubmit.disabled = false;
    return;
  }

  const msg = isLoginMode
    ? { type: MessageType.LOGIN, email, password }
    : { type: MessageType.REGISTER, email, name, password };

  const res = await sendMessage(msg);
  els.authSubmit.disabled = false;

  if (res.ok) {
    showCopilotSection(email);
    await loadPreferences();
  } else {
    showAuthError(res.error || 'Authentication failed');
  }
});

async function loadPreferences(): Promise<void> {
  const res = await sendMessage<Preferences>({ type: MessageType.GET_PREFERENCES });
  if (!res.ok || !res.data) return;
  preferences = res.data;
  renderPreferences();
}

function renderPreferences(): void {
  if (!preferences || !els.nudgePrefs) return;
  els.nudgePrefs.innerHTML = '';
  const prefs = (preferences.nudge_preferences || {}) as Record<string, boolean>;
  for (const [key, label] of Object.entries(PREF_LABELS)) {
    const row = document.createElement('label');
    const checked = prefs[key] !== false;
    row.innerHTML = `<input type="checkbox" data-pref="${key}" ${checked ? 'checked' : ''}> ${label}`;
    els.nudgePrefs.appendChild(row);
  }
  els.storeTranscripts.checked = preferences.store_transcripts !== false;
  els.storeNudges.checked = preferences.store_nudges !== false;
  els.retentionDays.value = String(preferences.retention_days ?? 90);
}

function schedulePreferenceSave(): void {
  if (prefsSaveTimer) clearTimeout(prefsSaveTimer);
  els.prefsStatus.textContent = 'Saving...';
  prefsSaveTimer = setTimeout(savePreferences, 250);
}

async function savePreferences(): Promise<void> {
  const seq = ++prefsSaveSeq;
  const nudgePreferences: Record<string, boolean> = {};
  for (const input of els.nudgePrefs.querySelectorAll<HTMLInputElement>('input[data-pref]')) {
    if (input.dataset.pref) nudgePreferences[input.dataset.pref] = input.checked;
  }
  const rd = parseInt(els.retentionDays.value, 10);
  const payload: Preferences = {
    nudge_preferences: nudgePreferences,
    store_transcripts: els.storeTranscripts.checked,
    store_nudges: els.storeNudges.checked,
    retention_days: Number.isFinite(rd) ? rd : 90,
  };
  const res = await sendMessage<Preferences>({ type: MessageType.UPDATE_PREFERENCES, preferences: payload });
  // Ignore a stale response if a newer save has since started (last-write-wins
  // on the DOM, not on whichever network response happens to land last).
  if (seq !== prefsSaveSeq) return;
  if (res.ok && res.data) {
    preferences = res.data;
    els.prefsStatus.textContent = 'Saved';
  } else {
    els.prefsStatus.textContent = 'Could not save';
  }
}

els.nudgePrefs.addEventListener('change', schedulePreferenceSave);
els.storeTranscripts.addEventListener('change', schedulePreferenceSave);
els.storeNudges.addEventListener('change', schedulePreferenceSave);
els.retentionDays.addEventListener('change', schedulePreferenceSave);

function showAuthError(msg: string): void {
  els.authError.textContent = msg;
  els.authError.classList.remove('hidden');
}

els.logoutLink.addEventListener('click', async () => {
  await sendMessage({ type: MessageType.LOGOUT });
  showAuthSection();
});

// --- Copilot Controls ---

els.startBtn.addEventListener('click', async () => {
  const email = els.prospectEmail.value.trim();
  if (!email) {
    showCopilotError('Enter prospect email');
    return;
  }
  els.startBtn.disabled = true;
  els.copilotError.classList.add('hidden');

  // Get active tab (must be on meet.google.com)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url?.includes('meet.google.com') || tab.id === undefined) {
    showCopilotError('Open a Google Meet call first');
    els.startBtn.disabled = false;
    return;
  }

  const res = await sendMessage({
    type: MessageType.START_COPILOT,
    tabId: tab.id,
    prospectEmail: email,
  });

  els.startBtn.disabled = false;
  if (!res.ok) showCopilotError(res.error || 'Failed to start');
});

els.stopBtn.addEventListener('click', async () => {
  await sendMessage({ type: MessageType.STOP_COPILOT });
});

function showCopilotError(msg: string): void {
  els.copilotError.textContent = msg;
  els.copilotError.classList.remove('hidden');
}

// --- State Rendering ---

async function refreshState(): Promise<void> {
  const res = await sendMessage<CopilotStateSnapshot>({ type: MessageType.GET_STATE });
  if (res.ok && res.data) renderState(res.data);
}

function renderState(s: CopilotStateSnapshot): void {
  // Dot
  els.dot.className = 'dot';
  if (s.state === CopilotState.ACTIVE) els.dot.classList.add('dot-active');
  else if (s.state === CopilotState.CONNECTING || s.state === CopilotState.RECONNECTING) els.dot.classList.add('dot-connecting');
  else if (s.state === CopilotState.ERROR) els.dot.classList.add('dot-error');
  else els.dot.classList.add('dot-idle');

  // Panels
  if (s.state === CopilotState.IDLE || s.state === CopilotState.ERROR) {
    els.idlePanel.classList.remove('hidden');
    els.activePanel.classList.add('hidden');
  } else {
    els.idlePanel.classList.add('hidden');
    els.activePanel.classList.remove('hidden');
    els.prospectDisplay.textContent = `Assisting: ${s.prospectEmail || ''}`;
    // Pull the current audio-health snapshot for the indicators
    if (s.state === CopilotState.ACTIVE) {
      sendMessage({ type: MessageType.GET_AUDIO_STATUS }).then((res) => {
        const data = (res as { data?: { mic?: boolean; tab?: boolean; playback?: boolean } })?.data;
        if (data) renderAudioHealth(data);
      }).catch(() => {});
    }

    // Status bar
    els.statusBar.className = 'status-bar';
    if (s.state === CopilotState.ACTIVE) {
      els.statusBar.classList.add('status-active');
      els.statusBar.textContent = 'AI Assistant Active';
    } else if (s.state === CopilotState.CONNECTING || s.state === CopilotState.RECONNECTING) {
      els.statusBar.classList.add('status-connecting');
      els.statusBar.textContent = 'Connecting...';
    } else if (s.state === CopilotState.STOPPING) {
      els.statusBar.classList.add('status-connecting');
      els.statusBar.textContent = 'Stopping...';
    }
  }
}

// Listen for state broadcasts from SW
chrome.runtime.onMessage.addListener((msg: { type?: string } & CopilotStateSnapshot & {
  mic?: boolean; tab?: boolean; playback?: boolean; micReason?: string;
}) => {
  if (msg.type === MessageType.STATE_UPDATE) renderState(msg);
  else if (msg.type === MessageType.AUDIO_STATUS) renderAudioHealth(msg);
});

init();
