// Service worker — copilot state machine and message router.
// Pattern from chrome_extension/src/background/service-worker.js

import { CopilotState, MessageType, StorageKey, API_BASE_URL, WSMessageType } from '../constants.js';
import { CopilotWSClient } from '../lib/copilot-ws-client.js';
import {
  startCopilotSession,
  stopCopilotSession,
  login,
  register,
  logout,
  refreshToken,
  checkAudioConsent,
  getPreferences,
  updatePreferences,
} from '../lib/api-client.js';
import { onMessage, sendToTab } from '../lib/messaging.js';

// --- State (persisted to chrome.storage.session for SW suspend survival) ---
let state = CopilotState.IDLE;
let sessionId = null;
let meetingTabId = null;
let prospectEmail = '';
let wsClient = new CopilotWSClient();

// Restore state on SW wake
(async () => {
  try {
    const got = await chrome.storage.session.get([
      StorageKey.COPILOT_STATE, StorageKey.SESSION_ID, 'sc_meeting_tab', 'sc_prospect_email',
    ]);
    if (got[StorageKey.COPILOT_STATE] && got[StorageKey.COPILOT_STATE] !== CopilotState.IDLE) {
      state = got[StorageKey.COPILOT_STATE];
      sessionId = got[StorageKey.SESSION_ID] || null;
      meetingTabId = got.sc_meeting_tab || null;
      prospectEmail = got.sc_prospect_email || '';
      // If was active, attempt reconnect
      if (state === CopilotState.ACTIVE || state === CopilotState.RECONNECTING) {
        await reconnectWS();
      }
    }
  } catch { /* fresh session */ }
})();

// --- State Machine ---

function setState(newState) {
  state = newState;
  chrome.storage.session.set({
    [StorageKey.COPILOT_STATE]: state,
    [StorageKey.SESSION_ID]: sessionId,
    sc_meeting_tab: meetingTabId,
    sc_prospect_email: prospectEmail,
  }).catch(() => {});
  // G3: Badge indicator
  if (state === CopilotState.ACTIVE) {
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
  } else if (state === CopilotState.IDLE) {
    chrome.action.setBadgeText({ text: '' });
  } else if (state === CopilotState.ERROR) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  }
  broadcastState();
}

function broadcastState() {
  const payload = {
    type: MessageType.STATE_UPDATE,
    state, sessionId, prospectEmail, meetingTabId,
  };
  chrome.runtime.sendMessage(payload).catch(() => {});
  if (meetingTabId) sendToTab(meetingTabId, payload);
}

// --- WS Client Events ---

wsClient.onStatusChange = (status) => {
  if (status === 'connected') setState(CopilotState.ACTIVE);
  else if (status === 'reconnecting') setState(CopilotState.RECONNECTING);
  else if (status === 'closed' && state !== CopilotState.IDLE && state !== CopilotState.STOPPING) setState(CopilotState.ERROR);
};

wsClient.onNudge = (nudge) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'NUDGE', nudge });
};

wsClient.onTranscript = (segment) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'TRANSCRIPT', ...segment });
};

wsClient.onStageUpdate = (stage) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'STAGE_UPDATE', stage });
};

wsClient.onTalkRatio = (data) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'TALK_RATIO', ...data });
};

wsClient.onProspectContext = (profile) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'PROSPECT_CONTEXT', profile });
};

wsClient.onMeetingSummary = (summary) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'MEETING_SUMMARY', summary });
};

wsClient.onError = (err) => {
  if (meetingTabId) sendToTab(meetingTabId, { type: 'WS_ERROR', ...err });
  // Try token refresh on auth failure
  if (err.code === 'auth_expired' || err.code === 4001) {
    refreshToken().then((newToken) => {
      if (newToken && sessionId) reconnectWS();
    }).catch(() => {});
  }
};

wsClient.onSessionReady = () => {
  wsClient.sendJSON({ type: WSMessageType.SESSION_START, prospect_email: prospectEmail });
  startAudioCapture();
  startHeartbeatMonitor(); // #5: begin monitoring offscreen
};

// --- WS Reconnect (after SW suspend/resume) ---

async function reconnectWS() {
  if (!sessionId) return;
  try {
    const token = (await chrome.storage.local.get(StorageKey.AUTH_TOKEN))[StorageKey.AUTH_TOKEN];
    const baseUrl = (await chrome.storage.local.get(StorageKey.API_BASE_URL))[StorageKey.API_BASE_URL] || API_BASE_URL;
    const wsBase = baseUrl.replace(/^http/, 'ws');
    wsClient.connect(`${wsBase}/ws/copilot/${sessionId}?token=${token}`);
  } catch {
    setState(CopilotState.ERROR);
  }
}

// --- Offscreen Management ---

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture meeting audio for AI sales copilot',
  });
}

async function closeOffscreen() {
  try { await chrome.offscreen.closeDocument(); } catch { /* already closed */ }
}

async function startAudioCapture() {
  if (!meetingTabId) return;
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: meetingTabId });
  chrome.runtime.sendMessage({
    type: MessageType.OFFSCREEN_START_CAPTURE,
    streamId,
    tabId: meetingTabId,
  }).catch(() => {});
}

async function stopAudioCapture() {
  chrome.runtime.sendMessage({ type: MessageType.OFFSCREEN_STOP_CAPTURE }).catch(() => {});
  await closeOffscreen();
}

// --- Copilot Start/Stop ---

async function startCopilot(tabId, email) {
  if (state !== CopilotState.IDLE && state !== CopilotState.ERROR) return;

  // Check local + server-side audio consent before opening a session or capture.
  const consent = await chrome.storage.local.get(StorageKey.AUDIO_CONSENT);
  const hasLocalConsent = consent[StorageKey.AUDIO_CONSENT] === true;
  const hasServerConsent = hasLocalConsent ? await checkAudioConsent().catch(() => false) : false;
  if (!hasLocalConsent || !hasServerConsent) {
    if (!hasServerConsent) {
      await chrome.storage.local.remove(StorageKey.AUDIO_CONSENT);
    }
    // Open consent page — user must allow before we capture
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/permission/consent.html'),
      type: 'popup',
      width: 480,
      height: 520,
      focused: true,
    });
    return; // User needs to retry after granting consent
  }

  setState(CopilotState.CONNECTING);
  meetingTabId = tabId;
  prospectEmail = email;

  try {
    const { session_id, ws_url } = await startCopilotSession(email);
    sessionId = session_id;

    const token = (await chrome.storage.local.get(StorageKey.AUTH_TOKEN))[StorageKey.AUTH_TOKEN];
    const baseUrl = (await chrome.storage.local.get(StorageKey.API_BASE_URL))[StorageKey.API_BASE_URL] || API_BASE_URL;
    const wsBase = baseUrl.replace(/^http/, 'ws');
    const serverWsUrl = ws_url || '';
    const baseWsUrl = serverWsUrl.includes('localhost')
      ? `${wsBase}/ws/copilot/${sessionId}`
      : serverWsUrl || `${wsBase}/ws/copilot/${sessionId}`;
    wsClient.connect(`${baseWsUrl}?token=${token}`);

    sendToTab(meetingTabId, { type: MessageType.COPILOT_LIFECYCLE, phase: 'started', sessionId });
  } catch (err) {
    console.error('[SW] startCopilot failed:', err);
    setState(CopilotState.ERROR);
  }
}

async function stopCopilot() {
  if (state === CopilotState.IDLE) return;
  setState(CopilotState.STOPPING);
  startForceStopAlarm(); // #7: timeout safety net

  wsClient.sendJSON({ type: WSMessageType.SESSION_STOP });
  wsClient.close();
  await stopAudioCapture();
  stopHeartbeatMonitor(); // #5: stop monitoring

  if (sessionId) {
    stopCopilotSession(sessionId).catch(() => {});
  }
  if (meetingTabId) {
    sendToTab(meetingTabId, { type: MessageType.COPILOT_LIFECYCLE, phase: 'stopped' });
  }

  sessionId = null;
  meetingTabId = null;
  prospectEmail = '';
  clearForceStopAlarm(); // #7: cleanup succeeded, cancel force-stop
  setState(CopilotState.IDLE);
}

// --- Message Router ---

onMessage({
  [MessageType.START_COPILOT]: async (msg) => {
    await startCopilot(msg.tabId, msg.prospectEmail);
  },
  [MessageType.STOP_COPILOT]: async () => {
    await stopCopilot();
  },
  [MessageType.GET_STATE]: () => ({
    state, sessionId, prospectEmail, meetingTabId,
  }),
  [MessageType.LOGIN]: async (msg) => {
    return login(msg.email, msg.password);
  },
  [MessageType.REGISTER]: async (msg) => {
    return register(msg.email, msg.name, msg.password);
  },
  [MessageType.LOGOUT]: async () => {
    await stopCopilot();
    await logout();
  },
  [MessageType.GET_PREFERENCES]: async () => {
    return getPreferences();
  },
  [MessageType.UPDATE_PREFERENCES]: async (msg) => {
    return updatePreferences(msg.preferences || {});
  },
  [MessageType.MEETING_DETECTED]: (msg, sender) => {
    meetingTabId = sender?.tab?.id || msg.tabId;
  },
  [MessageType.MEETING_ENDED]: async () => {
    await stopCopilot();
  },
  [MessageType.MIC_MUTE_STATE]: (msg) => {
    // Forward mic mute to backend via WS
    wsClient.sendJSON({ type: WSMessageType.MIC_MUTE, muted: msg.muted });
  },
  [MessageType.SPEAKER_CHANGE]: (msg) => {
    // Forward speaker change to backend
    wsClient.sendJSON({ type: WSMessageType.SPEAKER_CHANGE, speaker: msg.speaker, timestamp: msg.wall_clock_ms });
  },
  [MessageType.NUDGE_DISMISS]: (msg) => {
    wsClient.sendJSON({
      type: WSMessageType.NUDGE_DISMISS,
      nudge_id: msg.nudge_id,
      nudge_type: msg.nudge_type,
    });
  },
  [MessageType.NUDGE_ACTED]: (msg) => {
    wsClient.sendJSON({
      type: WSMessageType.NUDGE_ACTED,
      nudge_id: msg.nudge_id,
      nudge_type: msg.nudge_type,
    });
  },
  [MessageType.OFFSCREEN_READY]: () => {
    lastHeartbeatAt = Date.now();
    console.info('[SW] Offscreen ready');
  },
});

// --- Audio Port (binary data from offscreen) ---

const SOURCE_MIC = 0x01;
const SOURCE_TAB = 0x02;

// #5: Offscreen heartbeat monitoring via chrome.alarms
const HEARTBEAT_ALARM = 'sc_heartbeat_check';
const HEARTBEAT_INTERVAL_MIN = 0.5; // Check every 30s
const HEARTBEAT_TIMEOUT_MS = 45_000; // 45s without heartbeat = dead
let lastHeartbeatAt = 0;

// #7: Force-stop alarm (timeout on stop)
const FORCE_STOP_ALARM = 'sc_force_stop';
const FORCE_STOP_TIMEOUT_MIN = 2; // 2 min max for stop

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    // #5: Check if offscreen is alive
    if (state === CopilotState.ACTIVE && lastHeartbeatAt > 0) {
      if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[SW] Offscreen heartbeat timeout — restarting capture');
        startAudioCapture().catch(() => {});
      }
    }
  } else if (alarm.name === FORCE_STOP_ALARM) {
    // #7: Force cleanup if stop is taking too long
    if (state === CopilotState.STOPPING) {
      console.warn('[SW] Force-stop alarm fired — forcing cleanup');
      sessionId = null; meetingTabId = null; prospectEmail = '';
      setState(CopilotState.IDLE);
    }
  }
});

function startHeartbeatMonitor() {
  lastHeartbeatAt = Date.now();
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MIN });
}

function stopHeartbeatMonitor() {
  chrome.alarms.clear(HEARTBEAT_ALARM);
}

function startForceStopAlarm() {
  chrome.alarms.create(FORCE_STOP_ALARM, { delayInMinutes: FORCE_STOP_TIMEOUT_MIN });
}

function clearForceStopAlarm() {
  chrome.alarms.clear(FORCE_STOP_ALARM);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'audio-stream') return;
  port.onMessage.addListener((msg) => {
    if (msg.type === 'audio_chunk' && msg.data) {
      // msg.data is an ArrayBuffer (transferred from offscreen)
      const sourceTag = msg.source === 'mic' ? SOURCE_MIC : SOURCE_TAB;
      const audio = new Uint8Array(msg.data);
      const tagged = new Uint8Array(1 + audio.length);
      tagged[0] = sourceTag;
      tagged.set(audio, 1);
      wsClient.sendAudio(tagged.buffer);
    }
  });
  port.onDisconnect.addListener(() => {
    if (state === CopilotState.ACTIVE) {
      console.warn('[SW] Audio port disconnected — restarting capture');
      startAudioCapture().catch(() => {});
    }
  });
});

// Tab close → auto-stop
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === meetingTabId) stopCopilot();
});

console.info('[Sales Copilot SW] loaded');
